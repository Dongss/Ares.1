import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isOurProcess, killProcessGroup, prepareAgentEnv } from '../adapters/process.js';
import type { AgentAdapter, AgentResult } from '../adapters/types.js';
import type {
  AgentEventRecord,
  LiveAgentEvent,
  RateLimitedWait,
  RunWorkspaceState,
} from '../api/types.js';
import type { HomePaths, LoadedConfig } from '../config/load.js';
import {
  type AgentConfig,
  agentEffort,
  type EffectiveStage,
  effectiveBudget,
  effectiveMaxLoops,
  effectiveStage,
  failTarget,
  type RunOverrides,
  RunOverridesSchema,
  replyTimeoutHours,
  rollbackTarget,
  stageVerifyCommands,
} from '../config/schema.js';
import { join as joinList, t } from '../i18n.js';
import { ConflictError, NotFoundError, type Store } from '../store/store.js';
import {
  type Attempt,
  type BlockInfo,
  type DiscussionEntry,
  FINISHED_RUN_STATUSES,
  type ReplyEntry,
  type ReplyTimeoutEntry,
  type Run,
  type RunIssue,
  type RunStatus,
  type StageRun,
  type Task,
} from '../store/types.js';
import { errorMessage, newId, nowIso } from '../util.js';
import { formatCommandFailure, runCommands } from '../verify/commands.js';
import {
  addExistingWorktree,
  addWorktree,
  branchExists,
  commitAll,
  currentBranch,
  diffStat,
  fastForwardBranch,
  hasChanges,
  isAncestor,
  listBranches,
  mergeOrAbort,
  removeWorktree,
  resetHard,
  revParse,
} from '../workspace/git.js';
import {
  ASSESS_REPORT_JSON_SCHEMA,
  AssessReportSchema,
  formatFeedback,
  formatReviewIssues,
  parseReport,
  REVIEW_REPORT_JSON_SCHEMA,
  ReviewReportSchema,
  resultProblem,
  TASK_REPORT_JSON_SCHEMA,
  TaskReportSchema,
} from './contracts.js';
import {
  assessmentProblem,
  formatAssessment,
  replyDeadline,
  takeAssessment,
  waitText,
} from './discussion.js';
import {
  assessmentArtifact,
  assessPrompt,
  type PreviousReview,
  type PromptContext,
  reviewPrompt,
  reworkPrompt,
  taskPrompt,
} from './prompts.js';

export interface EngineDeps {
  store: Store;
  paths: HomePaths;
  config: () => LoadedConfig;
  adapters: ReadonlyMap<string, AgentAdapter>;
  /** The current time in epoch milliseconds (tests move it on); default Date.now. */
  now?: () => number;
  /** How long to wait before retrying an agent that errored; default `AGENT_RETRY_BACKOFF`. */
  agentRetryBackoff?: Backoff;
  /** How long a Run waits for its rate-limited agent's quota; default `RATE_LIMIT_WAIT`. */
  rateLimitWait?: RateLimitWait;
}

/** An exponential backoff: the first wait, doubled on each further retry up to the longest. */
export interface Backoff {
  firstMs: number;
  maxMs: number;
}

/**
 * Waits before retrying an agent that errored: an error is often passing (a network hiccup, an
 * overloaded service), and retrying at once tends to hit it again.
 */
export const AGENT_RETRY_BACKOFF: Backoff = { firstMs: 30_000, maxMs: 600_000 };

/** The wait before the `retry`-th retry (1 = the first). */
export function backoffMs(backoff: Backoff, retry: number): number {
  return Math.min(backoff.firstMs * 2 ** Math.max(0, retry - 1), backoff.maxMs);
}

/**
 * How long a Run waits when its agent is out of quota or rate-limited: until the reset time the
 * CLI gave plus `marginMs` (clocks differ, and a quota may come back a little late); without
 * one, a backoff over the limits hit in a row.
 */
export interface RateLimitWait extends Backoff {
  marginMs: number;
}

/** 5, 10, 20, 40 minutes, then hourly; one more minute after a reset time the CLI gave. */
export const RATE_LIMIT_WAIT: RateLimitWait = {
  firstMs: 300_000,
  maxMs: 3_600_000,
  marginMs: 60_000,
};

/**
 * The wait of a Run whose agent hit a limit: until `resetAt` (epoch ms, from the CLI) plus the
 * margin when it is still ahead, else the backoff for the `inARow`-th limit in a row.
 */
export function rateLimitDelayMs(
  wait: RateLimitWait,
  now: number,
  resetAt: number | undefined,
  inARow: number,
): number {
  if (resetAt !== undefined && resetAt > now) return resetAt - now + wait.marginMs;
  return backoffMs(wait, inARow);
}

const LEVEL_RANK = { low: 0, mid: 1, high: 2 } as const;

/**
 * The agent to switch a task to after its agent kept erroring (`on_agent_error: switch_agent`):
 * one the task has not tried yet that can run the stage, those of the current agent's tier or
 * higher first, then the cheaper first; agents.yaml's order decides the rest. Undefined when
 * there is none. `agents` holds only enabled agents.
 */
export function switchCandidate(
  agents: Iterable<AgentConfig>,
  current: AgentConfig | undefined,
  tried: ReadonlySet<string>,
  usable: (agent: AgentConfig) => boolean,
): AgentConfig | undefined {
  const floor = current ? LEVEL_RANK[current.tier] : 0;
  const lower = (a: AgentConfig) => (LEVEL_RANK[a.tier] >= floor ? 0 : 1);
  const candidates = [...agents].filter((a) => !tried.has(a.id) && usable(a));
  // Array.prototype.sort is stable: equal ranks keep the file order.
  candidates.sort((a, b) => lower(a) - lower(b) || LEVEL_RANK[a.cost] - LEVEL_RANK[b.cost]);
  return candidates[0];
}

/**
 * The longest single wait of a timer for a time ahead (a reply timeout, the end of a wait for a
 * quota): a time days away is checked again on the way, so a sleeping machine or a changed clock
 * is caught up with soon after.
 */
const MAX_TIMER_MS = 3_600_000;

/** Where an attempt's normalized events are kept (one JSON record per line), next to its raw log. */
export function attemptEventsPath(logPath: string): string {
  return logPath.replace(/(\.jsonl)?$/, '.events.jsonl');
}

/** Read back the normalized events of an attempt; unreadable lines are skipped. */
export function readAttemptEvents(logPath: string): AgentEventRecord[] {
  const file = attemptEventsPath(logPath);
  if (!existsSync(file)) return [];
  const records: AgentEventRecord[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as AgentEventRecord);
    } catch {
      // a partially written last line
    }
  }
  return records;
}

export interface CreateRunInput {
  /** Repo id or name. */
  repo: string;
  template: string;
  goal: string;
  overrides?: unknown;
  /** The GitHub issue the Run is created from. */
  issue?: RunIssue;
  /**
   * The goal comes from someone the Master does not trust: the Run is created blocked
   * (`untrusted_issue`) with this message, and starts once a human confirms it with a retry.
   */
  confirmGoal?: string;
}

export interface RetryInput {
  /** Switch the task to another agent. */
  agentId?: string;
  /** Extra instructions for the agent. */
  note?: string;
  /**
   * New budget of the Run in USD, above what it has spent; required when it is blocked by its
   * budget. Written to `overrides.budget_usd`.
   */
  budgetUsd?: number;
}

interface Active {
  runId: string;
  controller: AbortController;
  done: Promise<void>;
}

/** A queued Run waiting for its agent's quota (`Engine.limitWaits`). */
interface RateLimitedRun {
  agentId: string;
  /** Not to start again before this, in epoch milliseconds. */
  until: number;
}

/** Thrown inside a drive loop when the Run is being paused / cancelled / shut down. */
class Aborted extends Error {}

export class InvalidStateError extends Error {}

const IN_FLIGHT_TASK = new Set<Task['status']>(['running', 'verifying']);

/**
 * The workflow engine: a deterministic state machine that executes one Run at a time
 * in the Run's own worktree, one task and one commit at a time.
 */
export class Engine {
  /** Live agent output for the dashboard; not persisted (raw logs are on disk). */
  readonly live = new EventEmitter<{ agent: [LiveAgentEvent] }>();
  private active: Active | undefined;
  private stopping = false;
  private holding = false;
  /** Workspace cleanups in progress, by Run id; a second request joins the first. */
  private readonly cleanups = new Map<string, Promise<Run>>();
  /** Wakes `checkReplyTimeouts` at the next discussion's deadline. */
  private replyTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Queued Runs whose agent was out of quota or rate-limited, by Run id: `kick` passes them by
   * until `until` (epoch ms). Kept in memory only: after a Master restart they just try again.
   */
  private readonly limitWaits = new Map<string, RateLimitedRun>();
  /** Wakes `kick` when the first wait in `limitWaits` ends. */
  private limitTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly store: Store;
  private readonly now: () => number;
  private readonly backoff: Backoff;
  private readonly limitWait: RateLimitWait;

  constructor(private readonly deps: EngineDeps) {
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
    this.backoff = deps.agentRetryBackoff ?? AGENT_RETRY_BACKOFF;
    this.limitWait = deps.rateLimitWait ?? RATE_LIMIT_WAIT;
  }

  private get cfg(): LoadedConfig {
    return this.deps.config();
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /** Recover Runs that were executing when the Master stopped, then start scheduling. */
  async start(): Promise<void> {
    for (const run of this.store.listRuns({ status: 'running' })) {
      for (const attempt of this.store.listRunAttempts(run.id, 'running')) {
        await this.killOrphan(attempt);
        this.store.updateAttempt(attempt.id, {
          status: 'interrupted',
          error: t({
            zh: 'Master 重启，执行被中断',
            en: 'The Master restarted and the execution was interrupted',
          }),
          endedAt: nowIso(),
        });
      }
      await this.discardInFlight(this.store.getRun(run.id));
      this.requeueHead(run.id, 'run.recovered');
    }
    // Discussions may have timed out while the Master was not running.
    this.checkReplyTimeouts();
    this.kick();
  }

  /** Graceful shutdown: stop the active agent like a manual pause and requeue its Run. */
  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.replyTimer);
    this.replyTimer = undefined;
    clearTimeout(this.limitTimer);
    this.limitTimer = undefined;
    this.limitWaits.clear();
    const active = this.active;
    if (!active) return;
    await this.interrupt();
    await this.discardInFlight(this.store.getRun(active.runId));
    this.requeueHead(active.runId, 'run.interrupted');
  }

  /** The Run currently executing, if any. */
  get activeRunId(): string | undefined {
    return this.active?.runId;
  }

  private async killOrphan(attempt: Attempt): Promise<void> {
    if (!attempt.pid || !attempt.command) return;
    const marker = attempt.sessionId ?? attempt.command.split(' ')[0] ?? '';
    if (marker && (await isOurProcess(attempt.pid, marker))) {
      await killProcessGroup(attempt.pid);
      this.store.event(attempt.runId, 'process.killed', {
        pid: attempt.pid,
        attemptId: attempt.id,
      });
    }
  }

  /**
   * Hold the queue: the executing Run finishes, no next one starts. Used while an upgrade of the
   * Master waits for the current Run.
   */
  hold(on: boolean): void {
    this.holding = on;
    if (!on) this.kick();
  }

  get held(): boolean {
    return this.holding;
  }

  /**
   * Start the next queued Run if nothing is executing and the work switch is on. Runs waiting for
   * their agent's quota are passed by until their wait ends.
   */
  kick(): void {
    clearTimeout(this.limitTimer);
    this.limitTimer = undefined;
    // Whatever ends the early returns (a Run finishing, the switch turned on, the hold lifted)
    // kicks again.
    if (this.active || this.stopping || this.holding || !this.store.working) return;
    const next = this.nextDueRun();
    if (!next) return;
    this.limitWaits.delete(next.id);
    this.setStatus(next.id, 'running', { queuePos: null });
    const controller = new AbortController();
    const active: Active = { runId: next.id, controller, done: Promise.resolve() };
    this.active = active;
    active.done = this.drive(next.id, controller.signal).finally(() => {
      if (this.active === active) this.active = undefined;
      setImmediate(() => this.kick());
    });
  }

  /**
   * The first queued Run that is not waiting for its agent's quota. When every queued Run is
   * waiting, `kick` is woken up when the first wait ends.
   */
  private nextDueRun(): Run | undefined {
    const queued = this.store.queuedRuns();
    // A Run that left the queue meanwhile (paused, cancelled) waits no more.
    const ids = new Set(queued.map((r) => r.id));
    for (const id of this.limitWaits.keys()) if (!ids.has(id)) this.limitWaits.delete(id);
    const now = this.now();
    let wake: number | undefined;
    for (const run of queued) {
      const until = this.limitWaits.get(run.id)?.until;
      if (until === undefined || until <= now) return run;
      wake = Math.min(wake ?? until, until);
    }
    if (wake !== undefined) {
      const timer = setTimeout(() => this.kick(), Math.min(wake - now, MAX_TIMER_MS));
      timer.unref();
      this.limitTimer = timer;
    }
    return undefined;
  }

  /**
   * A queued Run waiting for its agent's quota to come back: the agent and when the Run goes on
   * (then also waiting for the execution slot if another Run has it). null when it does not
   * wait (any more).
   */
  rateLimited(run: Run): RateLimitedWait | null {
    const wait = this.limitWaits.get(run.id);
    if (!wait || wait.until <= this.now() || run.status !== 'queued') return null;
    return { agentId: wait.agentId, retryAt: new Date(wait.until).toISOString() };
  }

  private async interrupt(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.controller.abort();
    await active.done;
  }

  // =========================================================================
  // Commands (called by the API)
  // =========================================================================

  /**
   * The work switch. Off: queued Runs wait and nothing new starts; the executing Run
   * finishes (pause it to stop it now). On: the queue moves again.
   */
  setWorking(on: boolean): boolean {
    if (this.store.working !== on) this.store.setWorking(on);
    if (on) {
      this.checkReplyTimeouts();
      this.kick();
    }
    return this.store.working;
  }

  createRun(input: CreateRunInput): Run {
    const repo = this.store.findRepo(input.repo);
    if (!repo) {
      throw new NotFoundError(
        t({ zh: `仓库 ${input.repo} 不存在`, en: `Repo ${input.repo} not found` }),
      );
    }
    const template = this.cfg.templates.get(input.template);
    if (!template) {
      const problems = Object.entries(this.cfg.errors)
        .filter(([key]) => key.startsWith('workflows/'))
        .map(([key, errs]) => `${key}: ${errs.join(t({ zh: '；', en: '; ' }))}`);
      const why = problems.length ? problems.join(' | ') : '';
      throw new NotFoundError(
        t({
          zh: `模板 ${input.template} 不存在或无效${why ? `（${why}）` : ''}`,
          en: `Template ${input.template} does not exist or is invalid${why ? ` (${why})` : ''}`,
        }),
      );
    }
    const goal = input.goal.trim();
    if (!goal)
      throw new InvalidStateError(t({ zh: '目标不能为空', en: 'The goal cannot be empty' }));
    const parsed = RunOverridesSchema.safeParse(input.overrides ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join(t({ zh: '；', en: '; ' }));
      throw new InvalidStateError(
        t({ zh: `覆盖配置无效：${issues}`, en: `Invalid overrides: ${issues}` }),
      );
    }
    const overrides: RunOverrides = parsed.data;
    for (const stageId of Object.keys(overrides.stages ?? {})) {
      if (!template.stages.some((s) => s.id === stageId)) {
        throw new InvalidStateError(
          t({
            zh: `覆盖配置中的阶段 ${stageId} 不在模板中`,
            en: `Stage ${stageId} in the overrides is not in the template`,
          }),
        );
      }
    }
    const run = this.store.tx(() => {
      const r = this.store.createRun({
        repoId: repo.id,
        templateId: template.id,
        template: structuredClone(template),
        goal,
        overrides,
        issue: input.issue ?? null,
      });
      this.store.event(r.id, 'run.created', {
        repo: repo.name,
        template: template.id,
        ...(input.issue ? { issue: input.issue.number } : {}),
      });
      if (input.confirmGoal !== undefined) {
        // Blocked before it ever runs: no agent reads the goal until a human confirmed it.
        this.block(r.id, { kind: 'untrusted_issue', message: input.confirmGoal });
        return this.store.getRun(r.id);
      }
      return r;
    });
    this.kick();
    return run;
  }

  approve(runId: string, comment?: string): Run {
    return this.decide(runId, 'approved', comment);
  }

  reject(runId: string, comment: string): Run {
    if (!comment.trim()) {
      throw new InvalidStateError(
        t({ zh: '驳回时必须填写意见', en: 'A rejection needs a comment' }),
      );
    }
    return this.decide(runId, 'rejected', comment);
  }

  private decide(runId: string, status: 'approved' | 'rejected', comment?: string): Run {
    const run = this.store.getRun(runId);
    if (run.status !== 'waiting_approval') {
      throw new InvalidStateError(
        t({
          zh: `Run 当前状态是 ${run.status}，没有待审批的事项`,
          en: `The Run is ${run.status} and has nothing awaiting approval`,
        }),
      );
    }
    const approval = this.store.pendingApproval(runId);
    if (!approval) {
      throw new InvalidStateError(
        t({ zh: '没有待审批的事项', en: 'Nothing is awaiting approval' }),
      );
    }
    this.store.tx(() => {
      this.store.updateApproval(approval.id, {
        status,
        comment: comment?.trim() || null,
        decidedAt: nowIso(),
      });
      this.store.event(runId, `approval.${status}`, { approvalId: approval.id, comment });
      this.requeueHead(runId, 'run.resumed');
    });
    this.kick();
    return this.store.getRun(runId);
  }

  /** Human handling of a blocked Run: redo what failed, optionally with another agent. */
  async retry(runId: string, input: RetryInput = {}): Promise<Run> {
    const run = this.store.getRun(runId);
    if (run.status !== 'blocked' || !run.blocked) {
      throw new InvalidStateError(
        t({
          zh: `只有卡住（blocked）的 Run 可以重试，当前状态是 ${run.status}`,
          en: `Only a blocked Run can be retried; this one is ${run.status}`,
        }),
      );
    }
    if (input.agentId && !this.cfg.agents.has(input.agentId)) {
      throw new InvalidStateError(unknownAgent(input.agentId));
    }
    if (!run.blocked.taskId && input.agentId) {
      throw new InvalidStateError(
        t({
          zh: '这次卡住与具体 Task 无关，不能换 Agent',
          en: 'This block is not about a task, so the agent cannot be switched',
        }),
      );
    }
    const info = run.blocked;
    if (info.kind === 'discussion') {
      // Retrying a discussion means replying to the assessment's questions.
      if (!input.note?.trim()) {
        throw new InvalidStateError(
          t({
            zh: '需求待讨论：请填写回复，回复会交给评估阶段重新评估',
            en: 'The requirement is under discussion: write a reply, and the assessment runs again with it',
          }),
        );
      }
      return this.reply(runId, [input.note], 'dashboard', input.agentId);
    }
    const budgetUsd = input.budgetUsd;
    if (info.kind === 'budget' && budgetUsd === undefined) {
      throw new InvalidStateError(
        t({
          zh: 'Run 因超出预算卡住，重试时需要提供新的预算',
          en: 'The Run is blocked over its budget; a retry needs a new budget',
        }),
      );
    }
    if (budgetUsd !== undefined && !(budgetUsd > run.costUsd)) {
      throw new InvalidStateError(
        t({
          zh: `新的预算 ${formatUsd(budgetUsd)} 必须大于已花费的 ${formatUsd(run.costUsd)}`,
          en: `The new budget ${formatUsd(budgetUsd)} must be more than the ${formatUsd(run.costUsd)} already spent`,
        }),
      );
    }
    let resetTo: string | null = null;
    if (info.kind === 'error' && info.taskId && run.worktreePath) {
      // An internal error may have left the task half done; start it over from its base.
      const task = this.store.getTask(info.taskId);
      if (task.baseCommit) {
        await resetHard(run.worktreePath, task.baseCommit);
        resetTo = task.baseCommit;
      }
    }
    // The human decided to continue with what is in the worktree now.
    const acceptedHead = info.kind === 'workspace' ? await this.restoreWorkspace(run) : null;
    this.store.tx(() => {
      // While the git operations above ran, the Run may have been cancelled (on the dashboard,
      // or because its issue was closed) or retried by another request; then this retry is stale
      // and must change nothing. A restored worktree can stay: finished Runs keep theirs.
      const current = this.store.getRun(runId);
      if (current.status !== 'blocked' || !sameBlock(current.blocked, info)) {
        throw new InvalidStateError(
          t({
            zh: `Run 的状态已经变了（现在是 ${current.status}），这次重试没有生效`,
            en: `The Run's status has changed (it is now ${current.status}); this retry had no effect`,
          }),
        );
      }
      if (resetTo) this.store.updateRun(runId, { headCommit: resetTo });
      if (acceptedHead) this.store.updateRun(runId, { headCommit: acceptedHead });
      if (info.taskId) {
        const task = this.store.getTask(info.taskId);
        const agentId = input.agentId ?? task.agentId;
        const note = input.note?.trim();
        const noted = note
          ? t({ zh: `人工补充说明：${note}`, en: `Note from a human: ${note}` })
          : '';
        const feedback = [noted, task.pendingFeedback ?? ''].filter(Boolean).join('\n\n');
        this.store.updateTask(task.id, {
          status: 'pending',
          retries: 0,
          agentId,
          // The work was rolled back, so the old session no longer matches the code.
          sessionId: null,
          sessionAgentId: null,
          pendingFeedback: feedback || null,
        });
      }
      if (info.kind === 'max_loops') {
        this.store.updateRun(runId, { extraLoops: current.extraLoops + 1 });
      }
      if (budgetUsd !== undefined) {
        this.store.updateRun(runId, {
          overrides: { ...current.overrides, budget_usd: budgetUsd },
        });
        this.store.event(runId, 'run.budget_changed', {
          from: effectiveBudget(current.template, current.overrides) ?? null,
          to: budgetUsd,
          costUsd: current.costUsd,
        });
      }
      if (info.kind === 'setup_failed') {
        this.store.updateRun(runId, {
          worktreePath: null,
          branch: null,
          baseCommit: null,
          headCommit: null,
        });
      }
      if (info.kind === 'untrusted_issue' && current.issue?.untrusted) {
        // A human read the goal written by someone untrusted and let it go to the agents.
        const untrusted = { ...current.issue.untrusted, confirmedAt: nowIso() };
        this.store.updateRun(runId, { issue: { ...current.issue, untrusted } });
      }
      this.store.event(runId, 'run.retry', { kind: info.kind, ...input });
      this.requeueHead(runId, 'run.resumed');
    });
    this.kick();
    return this.store.getRun(runId);
  }

  /**
   * A human's reply to the requirement assessment's questions, from the dashboard (retry with a
   * note) or the issue: added to the discussion, and the assessment runs again with it.
   */
  reply(runId: string, texts: string[], source: ReplyEntry['source'], agentId?: string): Run {
    const run = this.store.getRun(runId);
    if (run.status !== 'blocked' || run.blocked?.kind !== 'discussion') {
      throw new InvalidStateError(
        t({
          zh: `Run 没有在等需求讨论的回复，当前状态是 ${run.status}`,
          en: `The Run is not waiting for a reply to a discussion; it is ${run.status}`,
        }),
      );
    }
    const replies = texts.map((text) => text.trim()).filter(Boolean);
    if (replies.length === 0) {
      throw new InvalidStateError(t({ zh: '回复不能为空', en: 'The reply cannot be empty' }));
    }
    if (agentId && !this.cfg.agents.has(agentId)) {
      throw new InvalidStateError(unknownAgent(agentId));
    }
    const { taskId } = run.blocked;
    const at = nowIso();
    const added: DiscussionEntry[] = replies.map((text) => ({ role: 'human', text, source, at }));
    this.store.tx(() => {
      this.store.updateRun(runId, { discussion: [...run.discussion, ...added] });
      if (taskId) {
        const task = this.store.getTask(taskId);
        this.store.updateTask(task.id, {
          status: 'pending',
          retries: 0,
          agentId: agentId ?? task.agentId,
          sessionId: null,
          sessionAgentId: null,
          // The reply is in the discussion the assessment reads; nothing else to pass on.
          pendingFeedback: null,
        });
      }
      this.store.event(runId, 'discussion.replied', { source, replies: replies.length, agentId });
      this.requeueHead(runId, 'run.resumed');
    });
    this.kick();
    return this.store.getRun(runId);
  }

  /**
   * Discussions nobody replied to within their assess stage's `reply_timeout_hours`: each goes
   * back to the assessment, which then decides on its own. Not while the work switch is off (the
   * Run could not go on anyway, and a human may still reply); switching it on checks again.
   * Schedules itself for the next deadline. Returns the Runs that timed out.
   */
  checkReplyTimeouts(): string[] {
    clearTimeout(this.replyTimer);
    this.replyTimer = undefined;
    if (this.stopping) return [];
    const now = this.now();
    const timedOut: string[] = [];
    let next: number | undefined;
    for (const run of this.store.listRuns({ status: 'blocked' })) {
      const wait = this.replyWait(run);
      if (!wait) continue;
      if (wait.deadline > now) next = Math.min(next ?? wait.deadline, wait.deadline);
      else if (this.store.working && this.timeOutDiscussion(run.id, now)) timedOut.push(run.id);
    }
    if (next !== undefined) {
      const timer = setTimeout(() => this.checkReplyTimeouts(), Math.min(next - now, MAX_TIMER_MS));
      timer.unref();
      this.replyTimer = timer;
    }
    if (timedOut.length > 0) this.kick();
    return timedOut;
  }

  /** When a Run blocked on a discussion stops waiting for a reply; null = it waits for one. */
  private replyWait(run: Run): { deadline: number; hours: number } | null {
    const info = run.blocked;
    if (run.status !== 'blocked' || info?.kind !== 'discussion' || !info.stageRunId) return null;
    const { stageId } = this.store.getStageRun(info.stageRunId);
    const def = run.template.stages.find((s) => s.id === stageId);
    const hours = def ? replyTimeoutHours(def) : null;
    const deadline = replyDeadline(run.discussion, hours);
    return hours === null || deadline === null ? null : { deadline, hours };
  }

  /**
   * Nobody replied in time: record it in the discussion and run the assessment again, in one
   * transaction. Nothing changes when the Run was replied to, retried or cancelled meanwhile.
   */
  private timeOutDiscussion(runId: string, now: number): boolean {
    return this.store.tx(() => {
      const run = this.store.getRun(runId);
      const wait = this.replyWait(run);
      if (!wait || wait.deadline > now) return false;
      this.resumeAlone(run, wait.hours, run.blocked?.taskId);
      this.requeueHead(runId, 'run.resumed');
      return true;
    });
  }

  /**
   * Add a timeout to the discussion and make the assessment task run again: the next round
   * decides on its own. Part of the caller's transaction.
   */
  private resumeAlone(run: Run, hours: number, taskId: string | undefined): void {
    const entry: ReplyTimeoutEntry = { role: 'timeout', hours, at: nowIso() };
    this.store.updateRun(run.id, { discussion: [...run.discussion, entry] });
    if (taskId) {
      this.store.updateTask(taskId, {
        status: 'pending',
        retries: 0,
        sessionId: null,
        sessionAgentId: null,
        pendingFeedback: null,
      });
    }
    this.store.event(run.id, 'discussion.timed_out', { hours });
  }

  /**
   * Retry after a failed consistency check: bring back a deleted worktree from the Run's branch
   * and return the commit to continue from (whatever the worktree has now).
   */
  private async restoreWorkspace(run: Run): Promise<string> {
    const { worktreePath: path, branch } = run;
    if (!path || !branch) {
      throw new InvalidStateError(
        t({
          zh: '这个 Run 没有工作目录，无法继续',
          en: 'This Run has no working directory and cannot continue',
        }),
      );
    }
    const repo = this.store.getRepo(run.repoId);
    if (!existsSync(path)) {
      if (!(await branchExists(repo.path, branch))) {
        throw new InvalidStateError(
          t({
            zh: `工作目录和分支 ${branch} 都不存在了，无法继续，只能终止这个 Run`,
            en: `Both the working directory and branch ${branch} are gone; the Run cannot continue and can only be cancelled`,
          }),
        );
      }
      await addExistingWorktree(repo.path, path, branch);
    }
    const current = await currentBranch(path).catch(() => null);
    if (current !== branch) {
      throw new InvalidStateError(
        t({
          zh: `工作目录 ${path} 当前不在分支 ${branch} 上，请先切回这个分支再重试`,
          en: `The working directory ${path} is not on branch ${branch}; switch back to it and retry`,
        }),
      );
    }
    return revParse(path, 'HEAD');
  }

  /**
   * Why a Run cannot continue in its worktree, or null when it can: the worktree
   * is gone, is on another branch, or no longer contains the last accepted commit (e.g. reset
   * by hand). Commits added on top are fine; the next checks cover them.
   */
  private async workspaceProblem(run: Run): Promise<string | null> {
    const { worktreePath: path, headCommit } = run;
    if (!path || !headCommit) return null;
    if (!existsSync(path)) {
      return t({
        zh: `工作目录 ${path} 不存在了`,
        en: `The working directory ${path} is gone`,
      });
    }
    const branch = await currentBranch(path).catch(() => null);
    if (branch !== run.branch) {
      return t({
        zh: `工作目录当前不在 Run 的分支 ${run.branch} 上（现在是 ${branch ?? '游离的 HEAD'}）`,
        en: `The working directory is not on the Run's branch ${run.branch} (it is on ${branch ?? 'a detached HEAD'})`,
      });
    }
    const head = await revParse(path, 'HEAD').catch(() => null);
    if (!head || !(await isAncestor(path, headCommit, head))) {
      return t({
        zh: `工作目录的提交历史和记录不一致：Master 记录的最新提交 ${headCommit.slice(0, 8)} 已不在当前分支上（可能被手动重置或改写过）`,
        en: `The working directory's history does not match the records: the latest commit the Master recorded, ${headCommit.slice(0, 8)}, is no longer on the branch (it may have been reset or rewritten by hand)`,
      });
    }
    return null;
  }

  /** Manual pause: stop the agent now, drop uncommitted changes, redo the task on resume. */
  async pause(runId: string): Promise<Run> {
    const run = this.store.getRun(runId);
    if (!['running', 'queued', 'waiting_approval'].includes(run.status)) {
      throw new InvalidStateError(
        t({
          zh: `状态为 ${run.status} 的 Run 不能暂停`,
          en: `A Run that is ${run.status} cannot be paused`,
        }),
      );
    }
    if (this.active?.runId === runId) {
      await this.interrupt();
      this.assertNotFinished(runId);
      await this.discardInFlight(this.store.getRun(runId));
    }
    this.setStatus(runId, 'paused', { queuePos: null });
    // Resuming runs it again at once, also when it was waiting for a quota.
    this.limitWaits.delete(runId);
    return this.store.getRun(runId);
  }

  /** The Run may have finished while its last step was being stopped; it stays finished then. */
  private assertNotFinished(runId: string): void {
    const { status } = this.store.getRun(runId);
    if (FINISHED_RUN_STATUSES.includes(status)) {
      throw new InvalidStateError(alreadyFinished(status));
    }
  }

  resume(runId: string): Run {
    const run = this.store.getRun(runId);
    if (run.status !== 'paused')
      throw new InvalidStateError(
        t({
          zh: `Run 当前状态是 ${run.status}，不是暂停`,
          en: `The Run is ${run.status}, not paused`,
        }),
      );
    this.requeueHead(runId, 'run.resumed');
    this.kick();
    return this.store.getRun(runId);
  }

  /** Terminate a Run. Its worktree and branch are kept for inspection. */
  async cancel(runId: string): Promise<Run> {
    const run = this.store.getRun(runId);
    if (FINISHED_RUN_STATUSES.includes(run.status)) {
      throw new InvalidStateError(alreadyFinished(run.status));
    }
    if (this.active?.runId === runId) {
      await this.interrupt();
      this.assertNotFinished(runId);
      await this.discardInFlight(this.store.getRun(runId));
    }
    this.store.tx(() => {
      for (const task of this.store.listRunTasks(runId)) {
        if (task.status !== 'passed' && task.status !== 'failed') {
          this.store.updateTask(task.id, { status: 'cancelled' });
        }
      }
      this.setStatus(runId, 'cancelled', { queuePos: null, finishedAt: nowIso() });
    });
    this.limitWaits.delete(runId);
    return this.store.getRun(runId);
  }

  /**
   * Remove the worktree and branch a failed / cancelled Run kept for inspection, on a
   * human's request. The Run's records, logs and artifacts stay. Nothing left to remove is fine.
   * Concurrent requests for the same Run share one removal (and one `workspace.removed` event).
   */
  cleanupWorkspace(runId: string): Promise<Run> {
    let pending = this.cleanups.get(runId);
    if (!pending) {
      pending = this.removeKeptWorkspace(runId).finally(() => this.cleanups.delete(runId));
      this.cleanups.set(runId, pending);
    }
    return pending;
  }

  private async removeKeptWorkspace(runId: string): Promise<Run> {
    const run = this.store.getRun(runId);
    if (run.status !== 'failed' && run.status !== 'cancelled') {
      throw new InvalidStateError(
        t({
          zh: `只有失败或已终止的 Run 可以清理工作目录和分支，当前状态是 ${run.status}`,
          en: `Only a failed or cancelled Run's working directory and branch can be cleaned up; this one is ${run.status}`,
        }),
      );
    }
    // A Run that has just failed (budget abort) may still be leaving its drive loop.
    if (this.active?.runId === runId) await this.active.done;
    const before = await this.inspectWorkspace(run);
    if (!before.worktreeExists && !before.branchExists) return run;
    const { path, branch } = before.workspace;
    await removeWorktree(this.store.getRepo(run.repoId).path, path, branch);
    const after = await this.inspectWorkspace(run);
    const left = [
      after.worktreeExists
        ? t({ zh: `工作目录 ${path}`, en: `the working directory ${path}` })
        : null,
      after.branchExists ? t({ zh: `分支 ${branch}`, en: `branch ${branch}` }) : null,
    ].filter((x) => x !== null);
    if (left.length > 0) {
      throw new Error(
        t({
          zh: `没能删除${left.join('和')}（可能被其他程序占用或在别处检出），请手动处理`,
          en: `Could not remove ${left.join(' and ')} (it may be in use by another program or checked out elsewhere); please handle it by hand`,
        }),
      );
    }
    this.store.tx(() => {
      this.store.event(runId, 'workspace.removed', { path, branch, manual: true });
    });
    return this.store.getRun(runId);
  }

  /**
   * Where a Run's worktree and branch are and whether they are still there. Until its setup
   * commands pass they exist without being recorded on the Run (an interrupted or failed setup
   * leaves them behind), hence the fallback to where `prepareWorkspace` creates them.
   */
  async inspectWorkspace(run: Run): Promise<RunWorkspaceState> {
    const workspace = this.workspaceOf(run);
    return {
      workspace,
      worktreeExists: existsSync(workspace.path),
      branchExists: await branchExists(this.store.getRepo(run.repoId).path, workspace.branch),
    };
  }

  /**
   * `inspectWorkspace` for many Runs at once (the dashboard's 「工作区」 page): one git call per
   * repo instead of one per Run. Keyed by Run id.
   */
  async inspectWorkspaces(runs: Run[]): Promise<Map<string, RunWorkspaceState>> {
    const branchesByRepo = new Map<string, Promise<Set<string>>>();
    const branchesOf = (repoId: string) => {
      let branches = branchesByRepo.get(repoId);
      if (!branches) {
        branches = listBranches(this.store.getRepo(repoId).path);
        branchesByRepo.set(repoId, branches);
      }
      return branches;
    };
    const states = new Map<string, RunWorkspaceState>();
    for (const run of runs) {
      const workspace = this.workspaceOf(run);
      states.set(run.id, {
        workspace,
        worktreeExists: existsSync(workspace.path),
        branchExists: (await branchesOf(run.repoId)).has(workspace.branch),
      });
    }
    return states;
  }

  /** The Run's worktree and branch: as recorded, else where `prepareWorkspace` creates them. */
  private workspaceOf(run: Run): { path: string; branch: string } {
    const fresh = this.newWorkspace(run.id);
    return { path: run.worktreePath ?? fresh.path, branch: run.branch ?? fresh.branch };
  }

  /** The worktree and branch `prepareWorkspace` creates for a Run. */
  private newWorkspace(runId: string): { path: string; branch: string } {
    return { path: join(this.deps.paths.worktreesDir, runId), branch: `ares1/${runId}` };
  }

  // =========================================================================
  // Drive loop
  // =========================================================================

  private async drive(runId: string, signal: AbortSignal): Promise<void> {
    try {
      // Every time a Run gets the execution slot (also after a Master restart), make sure its
      // worktree is still what the Master left there.
      const problem = await this.workspaceProblem(this.store.getRun(runId));
      this.checkAbort(signal);
      if (problem) {
        this.block(runId, {
          kind: 'workspace',
          message: t({
            zh: `${problem}。重试会以工作目录当前的提交为准继续；也可以终止这个 Run。`,
            en: `${problem}. A retry continues from the working directory's current commit; or cancel the Run.`,
          }),
        });
        return;
      }
      while (!signal.aborted) {
        const run = this.store.getRun(runId);
        if (run.status !== 'running') return;
        await this.step(run, signal);
      }
    } catch (err) {
      if (signal.aborted || err instanceof Aborted) return;
      const current = this.store.getRun(runId);
      if (current.status !== 'running') return;
      const inFlight = this.store.listRunTasks(runId).find((t) => IN_FLIGHT_TASK.has(t.status));
      this.block(runId, {
        kind: 'error',
        message: t({
          zh: `Master 内部错误：${errorMessage(err)}`,
          en: `Master internal error: ${errorMessage(err)}`,
        }),
        taskId: inFlight?.id,
      });
    }
  }

  private checkAbort(signal: AbortSignal): void {
    if (signal.aborted) throw new Aborted();
  }

  private async step(run: Run, signal: AbortSignal): Promise<void> {
    if (!run.worktreePath) return this.prepareWorkspace(run, signal);
    if (!run.currentStageRunId) {
      const first = run.template.stages[0];
      if (!first) throw new Error(t({ zh: '模板没有阶段', en: 'The template has no stages' }));
      this.startStage(run, first.id, null);
      return;
    }
    const sr = this.store.getStageRun(run.currentStageRunId);
    const eff = effectiveStage(run.template, sr.stageId, run.overrides);
    switch (sr.status) {
      case 'pending':
        return this.beginStage(run, sr, eff);
      case 'executing':
        return eff.def.kind === 'merge'
          ? this.executeMerge(run, sr, eff, signal)
          : this.executeTasks(run, sr, eff, signal);
      case 'waiting_approval':
        return this.afterApproval(run, sr, eff);
      case 'passed':
        return this.advance(run, sr);
      case 'failed':
        return this.rollback(run, sr);
    }
  }

  /** Create the Run's worktree + branch from the target branch and run setup commands. */
  private async prepareWorkspace(run: Run, signal: AbortSignal): Promise<void> {
    const repo = this.store.getRepo(run.repoId);
    const { path, branch } = this.newWorkspace(run.id);
    await removeWorktree(repo.path, path, branch); // leftovers of an interrupted attempt
    const base = await revParse(repo.path, repo.targetBranch);
    await addWorktree(repo.path, path, branch, base);
    this.checkAbort(signal);
    this.store.event(run.id, 'workspace.created', { path, branch, base });

    if (repo.setupCommands.length > 0) {
      const results = await runCommands(repo.setupCommands, path, {
        timeoutMs: this.commandTimeoutMs(),
        logPath: join(this.runLogDir(run.id), 'setup.log'),
        env: this.agentEnv(),
        signal,
      });
      this.checkAbort(signal);
      for (const r of results) {
        this.store.addCheck({
          runId: run.id,
          stageRunId: null,
          attemptId: null,
          kind: 'command',
          name: t({ zh: `准备：${r.command}`, en: `Setup: ${r.command}` }),
          passed: r.passed,
          detail: r.outputTail,
        });
      }
      const failed = results.find((r) => !r.passed);
      if (failed) {
        this.block(run.id, { kind: 'setup_failed', message: formatCommandFailure(failed) });
        return;
      }
    }
    this.store.updateRun(run.id, {
      branch,
      worktreePath: path,
      baseCommit: base,
      headCommit: base,
    });
  }

  private startStage(run: Run, stageId: string, feedback: string | null): StageRun {
    return this.store.tx(() => {
      const sr = this.store.createStageRun(run.id, stageId, feedback);
      this.store.updateRun(run.id, { currentStageRunId: sr.id });
      this.store.event(run.id, 'stage.started', { stageId, round: sr.round, stageRunId: sr.id });
      return sr;
    });
  }

  private beginStage(run: Run, sr: StageRun, eff: EffectiveStage): void {
    if (eff.def.kind === 'placeholder') {
      // Not implemented yet: part of the flow, but passes without doing anything.
      this.store.event(run.id, 'stage.placeholder', { stageId: sr.stageId });
      if (eff.gate) this.requestApproval(run, sr);
      else this.passStage(run, sr);
      return;
    }
    if (eff.def.kind === 'merge') {
      // The merge gate is the approval *before* merging.
      if (eff.gate) this.requestApproval(run, sr);
      else this.store.updateStageRun(sr.id, { status: 'executing' });
      return;
    }
    const agentId = eff.def.agent;
    if (!agentId) {
      throw new Error(
        t({
          zh: `阶段 ${eff.def.id} 没有指定 agent`,
          en: `Stage ${eff.def.id} names no agent`,
        }),
      );
    }
    this.store.tx(() => {
      // planning: single — the whole stage is one task.
      this.store.createTask({
        runId: run.id,
        stageRunId: sr.id,
        title: eff.def.name ?? eff.def.id,
        instructions: eff.def.instructions ?? '',
        agentId,
      });
      this.store.updateStageRun(sr.id, { status: 'executing' });
    });
  }

  private async executeTasks(
    run: Run,
    sr: StageRun,
    eff: EffectiveStage,
    signal: AbortSignal,
  ): Promise<void> {
    const task = this.store.listTasks(sr.id).find((t) => t.status !== 'passed');
    if (!task) {
      if (eff.gate) this.requestApproval(run, sr);
      else this.passStage(run, sr);
      return;
    }
    if (task.status === 'failed' || task.status === 'cancelled') {
      this.block(run.id, {
        kind: 'task_failed',
        message: t({
          zh: `Task「${task.title}」已失败，需要人工处理`,
          en: `Task "${task.title}" has failed and needs a human`,
        }),
        taskId: task.id,
      });
      return;
    }
    const agent = this.cfg.agents.get(task.agentId);
    const adapter = agent && this.deps.adapters.get(agent.cli);
    if (!agent || !adapter) {
      this.block(run.id, {
        kind: 'agent_unavailable',
        message: t({
          zh: `Agent ${task.agentId} 不存在、未启用或没有对应的 Adapter`,
          en: `Agent ${task.agentId} does not exist, is disabled or has no adapter`,
        }),
        taskId: task.id,
      });
      return;
    }
    // Soft budget: checked before each new agent execution, so the one that crossed the
    // budget still gets its checks and commit.
    const budget = effectiveBudget(run.template, run.overrides);
    if (budget !== undefined && run.costUsd >= budget) {
      return this.budgetExceeded(run, sr, eff, budget);
    }
    if (eff.def.kind === 'review')
      return this.runReviewTask(run, sr, eff, task, agent, adapter, signal);
    if (eff.def.kind === 'assess') {
      if (!adapter.supportsReadOnly) {
        this.block(run.id, {
          kind: 'agent_unavailable',
          message: t({
            zh: `需求评估要以只读方式运行，Agent ${agent.id} 的 CLI ${agent.cli} 不支持，请换用支持只读的 Agent（如 claude-code）`,
            en: `The requirement assessment runs read-only, which the CLI ${agent.cli} of agent ${agent.id} does not support; use an agent that supports read-only (such as claude-code)`,
          }),
          taskId: task.id,
        });
        return;
      }
      return this.runAssessTask(run, sr, eff, task, agent, adapter, signal);
    }
    return this.runAgentTask(run, sr, eff, task, agent, adapter, signal);
  }

  /** The Run has spent its budget: wait for a human, or end it (`on_budget_exceeded`). */
  private budgetExceeded(run: Run, sr: StageRun, eff: EffectiveStage, budget: number): void {
    const over = run.costUsd > budget;
    const spent = t({
      zh: `已花费 ${formatUsd(run.costUsd)}，${over ? '超过' : '达到'}预算 ${formatUsd(budget)}`,
      en: `Spent ${formatUsd(run.costUsd)}, ${over ? 'over' : 'reaching'} the budget of ${formatUsd(budget)}`,
    });
    const action = eff.escalate.on_budget_exceeded;
    this.store.tx(() => {
      this.store.event(run.id, 'run.budget_exceeded', {
        costUsd: run.costUsd,
        budgetUsd: budget,
        action,
      });
      if (action === 'pause') {
        this.block(run.id, {
          kind: 'budget',
          message: t({
            zh: `${spent}。调高预算后重试会接着执行；也可以终止这个 Run。`,
            en: `${spent}. Raise the budget and retry to continue; or cancel the Run.`,
          }),
          stageRunId: sr.id,
        });
        return;
      }
      this.failRun(
        run.id,
        t({
          zh: `${spent}，按配置（on_budget_exceeded: abort）终止。工作目录和分支已保留。`,
          en: `${spent}; ended as configured (on_budget_exceeded: abort). The working directory and branch are kept.`,
        }),
      );
    });
  }

  /**
   * End the Run as failed, without waiting for a human: like a cancel, unfinished tasks are
   * cancelled and the worktree and branch are kept for inspection. The issue it came from is
   * released (marked failed), so the system moves on.
   */
  private failRun(runId: string, error: string): void {
    this.store.tx(() => {
      for (const task of this.store.listRunTasks(runId)) {
        if (task.status !== 'passed' && task.status !== 'failed') {
          this.store.updateTask(task.id, { status: 'cancelled' });
        }
      }
      this.setStatus(runId, 'failed', { queuePos: null, error, finishedAt: nowIso() });
    });
  }

  // =========================================================================
  // Tasks
  // =========================================================================

  private promptContext(
    run: Run,
    sr: StageRun,
    eff: EffectiveStage,
    verify: string[],
  ): PromptContext {
    const inputs: PromptContext['inputs'] = [];
    for (const name of eff.def.inputs) {
      if (name === 'diff') continue; // the agent reads the diff from git itself
      const artifact = this.store.latestArtifact(run.id, name);
      if (artifact) inputs.push({ name, content: readFileSync(artifact.path, 'utf8') });
    }
    return {
      goal: run.goal,
      stage: eff.def,
      inputs,
      stageFeedback: sr.feedback,
      verifyCommands: verify,
      earlierAttempts: run.issue?.earlier ?? [],
    };
  }

  private async runAgentTask(
    run: Run,
    sr: StageRun,
    eff: EffectiveStage,
    initial: Task,
    agent: AgentConfig,
    adapter: AgentAdapter,
    signal: AbortSignal,
  ): Promise<void> {
    const workdir = this.workdir(run);
    const repo = this.store.getRepo(run.repoId);
    let task = initial;
    if (!task.baseCommit) {
      task = this.store.updateTask(task.id, { baseCommit: await revParse(workdir, 'HEAD') });
      this.checkAbort(signal);
    }
    const verify = stageVerifyCommands(eff.def, repo.verifyCommands);
    const ctx = this.promptContext(run, sr, eff, verify);
    const resume =
      task.pendingFeedback && task.sessionId && task.sessionAgentId === agent.id
        ? task.sessionId
        : undefined;
    const prompt = resume
      ? reworkPrompt(task.pendingFeedback ?? '')
      : taskPrompt(ctx, task.pendingFeedback, agent.permission);

    const { attempt, result } = await this.execute(run, task, agent, adapter, {
      prompt,
      resume,
      outputSchema: TASK_REPORT_JSON_SCHEMA,
      timeoutMs: this.agentTimeoutMs(eff, agent),
      signal,
    });

    // Layer 1: did the agent run properly and report completion?
    if (result.status !== 'completed') {
      return this.agentError(run, eff, task, attempt, result, signal);
    }
    const report = parseReport(TaskReportSchema, result.structured, result.finalMessage);
    const problem = resultProblem(report, result.permissionDenials);
    this.store.addCheck({
      runId: run.id,
      stageRunId: sr.id,
      attemptId: attempt.id,
      kind: 'result',
      name: t({ zh: '执行结果', en: 'Result' }),
      passed: problem === null,
      detail: problem?.message ?? (report.ok ? report.value.summary : ''),
    });
    if (problem !== null || !report.ok) {
      return this.rework(run, eff, task, attempt, problem?.message ?? '');
    }

    // Layer 2: verify commands, after every task.
    this.store.updateTask(task.id, { status: 'verifying' });
    const results = await runCommands(verify, workdir, {
      timeoutMs: this.commandTimeoutMs(),
      logPath: attempt.logPath.replace(/\.jsonl$/, '.verify.log'),
      env: this.agentEnv(),
      signal,
    });
    this.checkAbort(signal);
    for (const r of results) {
      this.store.addCheck({
        runId: run.id,
        stageRunId: sr.id,
        attemptId: attempt.id,
        kind: 'command',
        name: r.command,
        passed: r.passed,
        detail: r.outputTail,
      });
    }
    const failed = results.find((r) => !r.passed);
    if (failed) return this.rework(run, eff, task, attempt, formatCommandFailure(failed));

    // Passed: one commit per task.
    const sha = await commitAll(
      workdir,
      commitMessage({
        stageName: eff.def.name ?? eff.def.id,
        round: sr.round,
        goal: run.goal,
        summary: report.value.summary,
        runId: run.id,
        agent,
        attempt: this.store.getAttempt(attempt.id),
      }),
    );
    this.checkAbort(signal);
    this.store.tx(() => {
      this.store.updateAttempt(attempt.id, { outcome: 'passed' });
      this.store.updateTask(task.id, { status: 'passed', commitSha: sha, pendingFeedback: null });
      if (sha) this.store.updateRun(run.id, { headCommit: sha });
      for (const name of eff.def.outputs) {
        this.saveArtifact(run, sr, name, 'output', result.finalMessage);
      }
      this.store.event(run.id, 'task.passed', { taskId: task.id, commit: sha });
    });
  }

  private async runReviewTask(
    run: Run,
    sr: StageRun,
    eff: EffectiveStage,
    task: Task,
    agent: AgentConfig,
    adapter: AgentAdapter,
    signal: AbortSignal,
  ): Promise<void> {
    const workdir = this.workdir(run);
    const base = run.baseCommit ?? (await revParse(workdir, 'HEAD'));
    const stat = await diffStat(workdir, base);
    this.checkAbort(signal);
    const ctx = this.promptContext(run, sr, eff, []);
    const head = await revParse(workdir, 'HEAD');
    this.checkAbort(signal);
    let prompt = reviewPrompt(
      ctx,
      base,
      stat,
      this.passedCommandsAt(run.id, head),
      this.previousReview(run, sr),
    );
    // Not the previous round's review: what went wrong with this round's last attempt (e.g. the
    // output format), or a human's note when retrying.
    if (task.pendingFeedback) {
      prompt += t({
        zh: `\n## 上一次评审没有完成\n\n下面是上一次评审输出的问题，或人工重试时的补充说明：\n\n${task.pendingFeedback}\n`,
        en: `\n## The previous review did not complete\n\nBelow are the problems with the previous review's output, or a human's note from the retry:\n\n${task.pendingFeedback}\n`,
      });
    }

    const { attempt, result } = await this.execute(run, task, agent, adapter, {
      prompt,
      outputSchema: REVIEW_REPORT_JSON_SCHEMA,
      timeoutMs: this.agentTimeoutMs(eff, agent),
      signal,
    });

    // A reviewer must not change code; drop anything it left behind.
    if (await hasChanges(workdir)) {
      await resetHard(workdir, 'HEAD');
      this.store.event(run.id, 'review.changes_discarded', { attemptId: attempt.id });
    }
    this.checkAbort(signal);

    if (result.status !== 'completed')
      return this.agentError(run, eff, task, attempt, result, signal);
    const report = parseReport(ReviewReportSchema, result.structured, result.finalMessage);
    if (!report.ok) {
      return this.rework(run, eff, task, attempt, formatFeedback(report.error));
    }
    const text = formatReviewIssues(report.value);
    const mustFix = report.value.issues.filter((i) => i.severity === 'must');
    this.store.tx(() => {
      this.saveArtifact(run, sr, 'review', 'review', text);
      this.store.addCheck({
        runId: run.id,
        stageRunId: sr.id,
        attemptId: attempt.id,
        kind: 'review',
        name: t({ zh: '代码评审', en: 'Code review' }),
        passed: mustFix.length === 0,
        detail: text,
      });
      this.store.updateAttempt(attempt.id, { outcome: 'passed' });
      this.store.updateTask(task.id, { status: 'passed', pendingFeedback: null });
      if (mustFix.length > 0) {
        this.store.updateStageRun(sr.id, {
          status: 'failed',
          failReason: 'review',
          failFeedback: text,
          endedAt: nowIso(),
        });
        this.store.event(run.id, 'stage.failed', { stageId: sr.stageId, reason: 'review' });
      }
    });
  }

  /**
   * Requirement assessment: a read-only agent judges the goal and answers go / ask / drop.
   * go: the task passes, the stage passes (or waits for its approval). ask: the Run blocks until a
   * human replies (`reply`), then the task runs again with the discussion; when nobody replies
   * within the stage's `reply_timeout_hours` (`checkReplyTimeouts`; right away for 0) the task
   * runs again to decide on its own, go or drop. drop (only after a human reply or a timeout):
   * the Run ends as dropped.
   */
  private async runAssessTask(
    run: Run,
    sr: StageRun,
    eff: EffectiveStage,
    task: Task,
    agent: AgentConfig,
    adapter: AgentAdapter,
    signal: AbortSignal,
  ): Promise<void> {
    const workdir = this.workdir(run);
    const ctx = this.promptContext(run, sr, eff, []);
    const { attempt, result } = await this.execute(run, task, agent, adapter, {
      prompt: assessPrompt(ctx, run.discussion, task.pendingFeedback),
      outputSchema: ASSESS_REPORT_JSON_SCHEMA,
      timeoutMs: this.agentTimeoutMs(eff, agent),
      readOnly: true,
      signal,
    });

    // Read-only by the CLI; still, nothing an assessment leaves behind is kept.
    if (await hasChanges(workdir)) {
      await resetHard(workdir, 'HEAD');
      this.store.event(run.id, 'assess.changes_discarded', { attemptId: attempt.id });
    }
    this.checkAbort(signal);

    if (result.status !== 'completed')
      return this.agentError(run, eff, task, attempt, result, signal);
    const report = parseReport(AssessReportSchema, result.structured, result.finalMessage);
    if (!report.ok) {
      return this.rework(run, eff, task, attempt, formatFeedback(report.error));
    }
    const problem = assessmentProblem(report.value, run.discussion);
    if (problem) return this.rework(run, eff, task, attempt, problem);
    const entry = takeAssessment(report.value, run.discussion, { stageRunId: sr.id, at: nowIso() });
    const detail = formatAssessment(entry);
    const waitHours = replyTimeoutHours(eff.def);
    this.store.tx(() => {
      this.saveArtifact(
        run,
        sr,
        'assessment',
        'assessment',
        assessmentArtifact(entry, run.discussion),
      );
      this.store.updateRun(run.id, { discussion: [...run.discussion, entry] });
      this.store.addCheck({
        runId: run.id,
        stageRunId: sr.id,
        attemptId: attempt.id,
        kind: 'assess',
        name: t({ zh: '需求评估', en: 'Requirement assessment' }),
        passed: entry.verdict !== 'ask',
        detail,
      });
      this.store.updateAttempt(attempt.id, { outcome: 'passed' });
      this.store.event(run.id, 'assess.result', {
        verdict: entry.verdict,
        proposedDrop: entry.proposedDrop,
        revised: entry.revisedGoal !== null,
        ...(entry.decidedAlone ? { decidedAlone: true } : {}),
      });
      if (entry.verdict === 'ask' && waitHours === 0) {
        // The stage does not wait for replies: the next round decides on its own right away,
        // without blocking (nobody is asked to reply).
        this.resumeAlone(this.store.getRun(run.id), 0, task.id);
        return;
      }
      if (entry.verdict === 'ask') {
        // Runs again once a human replied, or nobody did in time; the discussion carries
        // everything it needs.
        this.store.updateTask(task.id, {
          status: 'pending',
          retries: 0,
          sessionId: null,
          sessionAgentId: null,
          pendingFeedback: null,
        });
        const timeout =
          waitHours === null
            ? ''
            : t({
                zh: `\n\n${waitText(waitHours)}内没有人回复的话，评估会自己决定：写明做了哪些假设后开工，或者给出不做的结论。`,
                en: `\n\nIf nobody replies within ${waitText(waitHours)}, the assessment decides on its own: it goes ahead with its assumptions written down, or concludes not to do it.`,
              });
        const message = entry.proposedDrop
          ? t({
              zh: `需求评估认为不该做，请确认：\n\n${detail}\n\n回复后 Master 会带着讨论重新评估；同意不做也请回复说明。${timeout}`,
              en: `The requirement assessment thinks this should not be done; please confirm:\n\n${detail}\n\nAfter your reply the Master assesses again with the discussion; if you agree to drop it, reply saying so as well.${timeout}`,
            })
          : t({
              zh: `需求评估有疑问，等你回复：\n\n${detail}\n\n回复后 Master 会带着讨论重新评估；同意不做也请回复说明。${timeout}`,
              en: `The requirement assessment has questions and waits for your reply:\n\n${detail}\n\nAfter your reply the Master assesses again with the discussion; if you agree to drop it, reply saying so as well.${timeout}`,
            });
        this.block(run.id, {
          kind: 'discussion',
          message,
          taskId: task.id,
          stageRunId: sr.id,
        });
        return;
      }
      this.store.updateTask(task.id, { status: 'passed', pendingFeedback: null });
      // go: the next step passes the stage or asks for its approval.
      if (entry.verdict === 'drop') {
        // A human agreed not to do it, or nobody replied in time and the assessment decided so:
        // no approval of this stage, the Run ends here, in the same transaction, so nothing can
        // resume it into the next stage.
        this.passStage(run, sr);
        this.setStatus(run.id, 'dropped', { queuePos: null, finishedAt: nowIso() });
      }
    });
    // Wake up at the new discussion's deadline.
    if (entry.verdict === 'ask' && waitHours) this.checkReplyTimeouts();
    // Nothing was done in the workspace.
    if (entry.verdict === 'drop') await this.removeMergedWorkspace(run);
  }

  /** From round 2 on: the latest review saved by an earlier round of this review stage. */
  private previousReview(run: Run, sr: StageRun): PreviousReview | undefined {
    if (sr.round <= 1) return undefined;
    const rounds = new Map(
      this.store
        .listStageRuns(run.id)
        .filter((s) => s.stageId === sr.stageId && s.id !== sr.id)
        .map((s) => [s.id, s.round]),
    );
    const artifact = this.store
      .listArtifacts(run.id)
      .findLast((a) => a.name === 'review' && a.stageRunId !== null && rounds.has(a.stageRunId));
    if (!artifact?.stageRunId) return undefined;
    return {
      round: rounds.get(artifact.stageRunId) ?? sr.round - 1,
      text: readFileSync(artifact.path, 'utf8'),
    };
  }

  /** Start the agent, stream its events, and persist the attempt. */
  private async execute(
    run: Run,
    task: Task,
    agent: AgentConfig,
    adapter: AgentAdapter,
    opts: {
      prompt: string;
      resume?: string;
      outputSchema: object;
      timeoutMs: number;
      /** Only read and search the worktree (the adapter must support it). */
      readOnly?: boolean;
      signal: AbortSignal;
    },
  ): Promise<{ attempt: Attempt; result: AgentResult }> {
    this.checkAbort(opts.signal);
    // Before the attempt is recorded, so that a failure here leaves no attempt running.
    const env = this.agentEnv();
    const attemptId = newId('att');
    const logPath = join(this.runLogDir(run.id), `${attemptId}.jsonl`);
    const effort = agentEffort(agent) ?? null;
    this.store.tx(() => {
      this.store.createAttempt({
        id: attemptId,
        taskId: task.id,
        runId: run.id,
        agentId: agent.id,
        model: agent.model,
        effort,
        prompt: opts.prompt,
        logPath,
        sessionId: opts.resume ?? null,
      });
      this.store.updateTask(task.id, { status: 'running' });
      this.store.event(run.id, 'attempt.started', {
        attemptId,
        taskId: task.id,
        agentId: agent.id,
        model: agent.model,
        effort,
        resume: Boolean(opts.resume),
      });
    });

    // Keep the normalized events so the dashboard can show history before live output.
    const eventsPath = attemptEventsPath(logPath);
    mkdirSync(this.runLogDir(run.id), { recursive: true });
    let seq = 0;
    const execution = adapter.start({
      workdir: this.workdir(run),
      prompt: opts.prompt,
      model: agent.model,
      effort: agent.effort,
      resumeSessionId: opts.resume,
      permission: opts.readOnly ? 'safe' : agent.permission,
      readOnly: opts.readOnly,
      outputSchema: opts.outputSchema,
      timeoutMs: opts.timeoutMs,
      extraArgs: agent.args,
      env,
      logPath,
      onEvent: (event) => {
        if (event.type === 'session')
          this.store.updateAttempt(attemptId, { sessionId: event.sessionId });
        if (event.type === 'model') {
          this.store.tx(() => {
            this.store.updateAttempt(attemptId, { actualModel: event.model });
            this.store.event(run.id, 'attempt.model', { attemptId, model: event.model });
          });
        }
        const record: AgentEventRecord = { seq: ++seq, ts: nowIso(), event };
        try {
          appendFileSync(eventsPath, `${JSON.stringify(record)}\n`);
        } catch {
          // the live view still gets it; the raw log has everything anyway
        }
        this.live.emit('agent', { runId: run.id, attemptId, ...record });
      },
    });
    const onAbort = () => void execution.stop();
    opts.signal.addEventListener('abort', onAbort, { once: true });
    this.store.updateAttempt(attemptId, { pid: execution.pid ?? null, command: execution.command });

    let result: AgentResult;
    try {
      result = await execution.result;
    } finally {
      opts.signal.removeEventListener('abort', onAbort);
    }

    const cost = result.costUsd ?? estimateCost(agent, result.usage);
    const attempt = this.store.tx(() => {
      const a = this.store.updateAttempt(attemptId, {
        status: opts.signal.aborted ? 'stopped' : result.status,
        sessionId: result.sessionId ?? null,
        finalMessage: result.finalMessage,
        structured: result.structured ?? null,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cachedTokens: result.usage.cachedTokens,
        costUsd: cost ?? null,
        error: result.error ?? null,
        endedAt: nowIso(),
      });
      this.store.updateTask(task.id, {
        sessionId: result.sessionId ?? null,
        sessionAgentId: agent.id,
      });
      if (cost) {
        const current = this.store.getRun(run.id);
        this.store.updateRun(run.id, { costUsd: current.costUsd + cost });
      }
      this.store.event(run.id, 'attempt.finished', {
        attemptId,
        status: a.status,
        costUsd: cost,
        error: result.error,
      });
      return a;
    });
    this.checkAbort(opts.signal);
    return { attempt, result };
  }

  /** The attempt did not pass: rework with feedback, or give up after max_retries. */
  private async rework(
    run: Run,
    eff: EffectiveStage,
    task: Task,
    attempt: Attempt,
    feedback: string,
  ): Promise<void> {
    const retries = task.retries + 1;
    this.store.updateAttempt(attempt.id, { outcome: 'rework' });
    if (retries > eff.escalate.max_retries) {
      await this.failTask(run, task, retries, feedback);
      this.block(run.id, {
        kind: 'task_failed',
        message: t({
          zh: `Task「${task.title}」返工 ${eff.escalate.max_retries} 次后仍未通过验收。最后一次的问题：\n${feedback}`,
          en: `Task "${task.title}" still does not pass after ${eff.escalate.max_retries} reworks. The last problems:\n${feedback}`,
        }),
        taskId: task.id,
      });
      return;
    }
    this.store.updateTask(task.id, { status: 'pending', retries, pendingFeedback: feedback });
    this.store.event(run.id, 'task.rework', { taskId: task.id, retries, feedback });
  }

  /**
   * The agent errored (failed, timed out): retry it after a backoff, up to `max_retries` times in
   * a row (counted apart from reworks). Then, by `on_agent_error`: `switch_agent` hands the task
   * to another agent, which gets as many retries; `human` blocks the Run for a human; when
   * nothing is left to try (`retry` and `switch_agent`), the Run ends as failed instead of
   * waiting for a human. An agent out of quota or rate-limited is none of these: see
   * `waitForQuota`.
   */
  private async agentError(
    run: Run,
    eff: EffectiveStage,
    task: Task,
    attempt: Attempt,
    result: AgentResult,
    signal: AbortSignal,
  ): Promise<void> {
    if (result.errorKind === 'rate_limited') return this.waitForQuota(run, task, attempt, result);
    const error =
      result.error ?? t({ zh: `执行状态：${result.status}`, en: `Status: ${result.status}` });
    this.store.updateAttempt(attempt.id, { outcome: 'agent_error' });
    const { max_retries: maxRetries, on_agent_error: mode } = eff.escalate;

    const errors = this.errorsInARow(run, task);
    if (errors <= maxRetries) {
      const delayMs = backoffMs(this.backoff, errors);
      this.store.tx(() => {
        this.store.updateTask(task.id, { status: 'pending' });
        this.store.event(run.id, 'task.retry_after_error', {
          taskId: task.id,
          agentId: task.agentId,
          error,
          attempt: errors,
          delayMs,
        });
      });
      // Holds the execution slot meanwhile; a pause, cancel or shutdown ends the wait at once.
      if (delayMs > 0) await delay(delayMs, undefined, { signal }).catch(() => {});
      this.checkAbort(signal);
      return;
    }

    const tried = this.triedAgents(task);
    if (mode === 'switch_agent') {
      const next = this.switchTarget(eff, task, tried);
      if (next) {
        this.store.tx(() => {
          this.store.updateTask(task.id, {
            status: 'pending',
            agentId: next.id,
            // Another agent cannot resume this one's session.
            sessionId: null,
            sessionAgentId: null,
          });
          this.store.event(run.id, 'task.agent_switched', {
            taskId: task.id,
            from: task.agentId,
            to: next.id,
            error,
          });
        });
        return;
      }
    }

    await this.failTask(run, task, task.retries, task.pendingFeedback);
    const failed = t({
      zh: `Agent ${task.agentId} 运行出错：${error}`,
      en: `Agent ${task.agentId} failed: ${error}`,
    });
    if (mode === 'human') {
      const note =
        maxRetries > 0
          ? t({
              zh: `\n\n已自动重试 ${maxRetries} 次，仍然出错。`,
              en: `\n\nIt still failed after ${retryTimes(maxRetries)}.`,
            })
          : '';
      this.block(run.id, {
        kind: 'agent_error',
        message: `${failed}${note}`,
        taskId: task.id,
      });
      return;
    }
    const retried = maxRetries > 0;
    const ended =
      mode === 'switch_agent'
        ? t({
            zh: `Task「${task.title}」执行出错：试过的 Agent（${joinList(tried)}）都出错了${retried ? `，每个都自动重试了 ${maxRetries} 次` : ''}，没有别的可用 Agent 了，Run 结束（on_agent_error: switch_agent）。`,
            en: `Task "${task.title}" kept failing: every agent tried (${joinList(tried)}) failed${retried ? `, each after ${retryTimes(maxRetries)}` : ''}, and no other agent can take over, so the Run ended (on_agent_error: switch_agent).`,
          })
        : t({
            zh: `Task「${task.title}」执行出错${retried ? `，自动重试 ${maxRetries} 次后仍然出错` : ''}，Run 结束（on_agent_error: retry）。`,
            en: `Task "${task.title}" failed${retried ? ` again after ${retryTimes(maxRetries)}` : ''}, so the Run ended (on_agent_error: retry).`,
          });
    this.failRun(
      run.id,
      t({
        zh: `${ended}\n最后一次：${failed}\n工作目录和分支已保留。`,
        en: `${ended}\nThe last one: ${failed}\nThe working directory and branch are kept.`,
      }),
    );
  }

  /**
   * The agent is out of quota or rate-limited. That passes on its own: no retry is used up, no
   * other agent takes over, nobody is asked. The task goes back to pending with the same agent
   * and feedback (a rework resumes the session of the attempt that hit the limit, which knows
   * what it did so far; the worktree keeps its changes, as after an agent error), and the Run
   * goes back to the head of the queue, giving up the execution slot until the quota is expected
   * back (`rateLimitDelayMs`); other Runs go on meanwhile. The wait is kept in memory only
   * (`limitWaits`).
   */
  private waitForQuota(run: Run, task: Task, attempt: Attempt, result: AgentResult): void {
    this.store.updateAttempt(attempt.id, { outcome: 'rate_limited' });
    const now = this.now();
    const resetAt = result.retryAt ? Date.parse(result.retryAt) : Number.NaN;
    const delayMs = rateLimitDelayMs(
      this.limitWait,
      now,
      Number.isNaN(resetAt) ? undefined : resetAt,
      this.limitsInARow(task),
    );
    const until = now + delayMs;
    this.store.tx(() => {
      this.store.updateTask(task.id, { status: 'pending' });
      this.store.event(run.id, 'task.rate_limited', {
        taskId: task.id,
        agentId: attempt.agentId,
        // When the Run goes on; the CLI's own reset time, when it gave one, is `resetAt`.
        retryAt: new Date(until).toISOString(),
        delayMs,
        resetAt: result.retryAt ?? null,
        error: result.error ?? null,
      });
      this.setStatus(run.id, 'queued', { queuePos: this.store.queueHead() });
    });
    this.limitWaits.set(run.id, { agentId: attempt.agentId, until });
  }

  /**
   * How many times in a row the task's agent hit a limit, counting the attempt just made: its
   * attempts from the latest back while they were rate-limited.
   */
  private limitsInARow(task: Task): number {
    let limits = 0;
    for (const a of this.store.listAttempts(task.id).reverse()) {
      if (a.outcome !== 'rate_limited') break;
      limits++;
    }
    return limits;
  }

  /**
   * How many times in a row the task's agent has errored, counting the attempt just made: its
   * attempts from the latest back while they are errors of this agent since a human last retried
   * the Run. An attempt that ran to the end (passed or sent back for rework), was stopped, or was
   * made by another agent starts the count again. Attempts that hit a quota or rate limit are
   * passed over: they neither count nor start the count again.
   */
  private errorsInARow(run: Run, task: Task): number {
    const events = this.store.listEvents(run.id);
    const retried = events.findLast((e) => e.type === 'run.retry')?.id ?? 0;
    const since = new Set(
      events
        .filter((e) => e.id > retried && e.type === 'attempt.started')
        .map((e) => e.data.attemptId),
    );
    let errors = 0;
    for (const a of this.store.listAttempts(task.id).reverse()) {
      if (a.outcome === 'rate_limited') continue;
      if (a.outcome !== 'agent_error' || a.agentId !== task.agentId || !since.has(a.id)) break;
      errors++;
    }
    return errors;
  }

  /** The agents a task has run with, in the order it first did, its current one included. */
  private triedAgents(task: Task): string[] {
    return [...new Set([...this.store.listAttempts(task.id).map((a) => a.agentId), task.agentId])];
  }

  /** Who takes over a task whose agent kept erroring; undefined when nobody is left. */
  private switchTarget(
    eff: EffectiveStage,
    task: Task,
    tried: readonly string[],
  ): AgentConfig | undefined {
    const readOnly = eff.def.kind === 'assess';
    return switchCandidate(
      this.cfg.agents.values(),
      this.cfg.agents.get(task.agentId),
      new Set(tried),
      (agent) => {
        const adapter = this.deps.adapters.get(agent.cli);
        return adapter !== undefined && (!readOnly || adapter.supportsReadOnly === true);
      },
    );
  }

  /** Final failure: roll the worktree back to before the task. */
  private async failTask(run: Run, task: Task, retries: number, feedback: string | null) {
    if (task.baseCommit) {
      await resetHard(this.workdir(run), task.baseCommit);
      this.store.updateRun(run.id, { headCommit: task.baseCommit });
    }
    this.store.updateTask(task.id, { status: 'failed', retries, pendingFeedback: feedback });
    this.store.event(run.id, 'task.failed', { taskId: task.id });
  }

  // =========================================================================
  // Stage transitions
  // =========================================================================

  private requestApproval(run: Run, sr: StageRun): void {
    this.store.tx(() => {
      const approval = this.store.createApproval(run.id, sr.id);
      this.store.updateStageRun(sr.id, { status: 'waiting_approval' });
      this.store.event(run.id, 'approval.requested', {
        approvalId: approval.id,
        stageId: sr.stageId,
      });
      // Waiting for a human releases the execution slot.
      this.setStatus(run.id, 'waiting_approval');
    });
  }

  private afterApproval(run: Run, sr: StageRun, eff: EffectiveStage): void {
    const approval = this.store.latestApproval(sr.id);
    if (!approval || approval.status === 'pending') {
      this.setStatus(run.id, 'waiting_approval');
      return;
    }
    if (approval.status === 'approved') {
      if (eff.def.kind === 'merge') this.store.updateStageRun(sr.id, { status: 'executing' });
      else this.passStage(run, sr);
      return;
    }
    this.store.updateStageRun(sr.id, {
      status: 'failed',
      failReason: 'rejected',
      failFeedback: approval.comment,
      endedAt: nowIso(),
    });
    this.store.event(run.id, 'stage.failed', { stageId: sr.stageId, reason: 'rejected' });
  }

  private passStage(run: Run, sr: StageRun): void {
    this.store.updateStageRun(sr.id, { status: 'passed', endedAt: nowIso() });
    this.store.event(run.id, 'stage.passed', { stageId: sr.stageId, round: sr.round });
  }

  private async advance(run: Run, sr: StageRun): Promise<void> {
    const stages = run.template.stages;
    const idx = stages.findIndex((s) => s.id === sr.stageId);
    const next = stages[idx + 1];
    if (next) {
      this.startStage(run, next.id, null);
      return;
    }
    await this.complete(run);
  }

  /** Go back to on_fail / on_reject, carrying the reason as feedback. */
  private rollback(run: Run, sr: StageRun): void {
    const def = run.template.stages.find((s) => s.id === sr.stageId);
    const reason = sr.failReason === 'rejected' ? 'reject' : 'fail';
    // Only review / merge stages fail their checks (failTarget); agent stages rework instead and
    // reach here only after a rejected approval. The fallback keeps rollbackTarget's rule.
    const target =
      (reason === 'fail' ? failTarget(run.template, sr.stageId) : null) ??
      rollbackTarget(run.template, sr.stageId, reason);
    const maxLoops = effectiveMaxLoops(run.template, run.overrides) + run.extraLoops;
    const rounds = this.store.countStageRounds(run.id, target);
    if (rounds > maxLoops) {
      this.block(run.id, {
        kind: 'max_loops',
        message: t({
          zh: `阶段 ${target} 已执行 ${rounds} 轮，超过回退上限 ${maxLoops}。最后一次的原因：\n${sr.failFeedback ?? ''}`,
          en: `Stage ${target} has run ${rounds} rounds, over the rollback limit of ${maxLoops}. The last reason:\n${sr.failFeedback ?? ''}`,
        }),
        stageRunId: sr.id,
      });
      return;
    }
    const stageName = def?.name ?? sr.stageId;
    const rejected = reason === 'reject';
    const why = sr.failFeedback ?? t({ zh: '（没有说明）', en: '(no explanation)' });
    const feedback = t({
      zh: `「${stageName}」${rejected ? '审批被驳回' : '没有通过'}：\n${why}`,
      en: `"${stageName}" ${rejected ? 'was rejected at approval' : 'did not pass'}:\n${why}`,
    });
    this.store.event(run.id, 'stage.rollback', { from: sr.stageId, to: target });
    this.startStage(run, target, feedback);
  }

  /**
   * Merge stage: bring in the latest target branch, re-run checks if it moved,
   * then fast-forward the target branch.
   */
  private async executeMerge(
    run: Run,
    sr: StageRun,
    eff: EffectiveStage,
    signal: AbortSignal,
  ): Promise<void> {
    const repo = this.store.getRepo(run.repoId);
    const workdir = this.workdir(run);
    const target = repo.targetBranch;
    if (await hasChanges(workdir)) {
      await resetHard(workdir, 'HEAD');
      this.store.event(run.id, 'merge.discarded_changes', {});
    }
    const targetHead = await revParse(repo.path, target);
    const head = await revParse(workdir, 'HEAD');
    this.checkAbort(signal);

    let synced = false;
    if (!(await isAncestor(workdir, targetHead, head))) {
      const merged = await mergeOrAbort(workdir, targetHead, `Merge ${target} into ${run.branch}`);
      this.checkAbort(signal);
      if (!merged) {
        this.store.addCheck({
          runId: run.id,
          stageRunId: sr.id,
          attemptId: null,
          kind: 'merge',
          name: t({ zh: `同步 ${target}`, en: `Sync ${target}` }),
          passed: false,
          detail: t({
            zh: `合并 ${target} 的最新代码时有冲突，已放弃这次合并，工作目录保持原样`,
            en: `Merging the latest ${target} ran into conflicts; the merge was abandoned and the working directory is unchanged`,
          }),
        });
        // The merge was aborted, so there is nothing to resolve in the worktree yet: tell the
        // human to redo the merge themselves and commit it, since a retry discards anything
        // uncommitted before merging again.
        this.block(run.id, {
          kind: 'merge_conflict',
          message: t({
            zh:
              `合并 ${target} 的最新代码时有冲突，Master 已放弃这次合并，工作目录保持原样。` +
              `要自己解决：在 ${workdir} 里运行 \`git merge ${target}\`，解决冲突后 \`git add\` 并 \`git commit\`，再重试（重试时没提交的改动会被丢弃）；` +
              '不想要这个 Run 了就终止。',
            en:
              `Merging the latest ${target} ran into conflicts; the Master abandoned the merge and the working directory is unchanged. ` +
              `To resolve it yourself: run \`git merge ${target}\` in ${workdir}, resolve the conflicts, \`git add\` and \`git commit\`, then retry (a retry discards uncommitted changes); ` +
              'cancel the Run if you no longer want it.',
          }),
          stageRunId: sr.id,
        });
        return;
      }
      synced = true;
      this.store.event(run.id, 'merge.synced', { target, targetHead });
    }

    // Check what has not been checked yet: the target's new commits just merged in, or commits
    // made outside an agent task (e.g. a conflict resolved by hand). Until the checks finish the
    // merge commit is not accepted, so an interruption resets to before it and syncs again.
    const head2 = await revParse(workdir, 'HEAD');
    if (synced || (run.headCommit !== null && head2 !== run.headCommit)) {
      const commands = stageVerifyCommands(eff.def, repo.verifyCommands);
      const results = await runCommands(commands, workdir, {
        timeoutMs: this.commandTimeoutMs(),
        logPath: join(this.runLogDir(run.id), `merge-${sr.id}.log`),
        env: this.agentEnv(),
        signal,
      });
      this.checkAbort(signal);
      const failed = results.find((r) => !r.passed);
      this.store.tx(() => {
        for (const r of results) {
          this.store.addCheck({
            runId: run.id,
            stageRunId: sr.id,
            attemptId: null,
            kind: 'command',
            name: r.command,
            passed: r.passed,
            detail: r.outputTail,
          });
        }
        // Checked (passed or not): later work builds on this commit.
        this.store.updateRun(run.id, { headCommit: head2 });
        if (failed) {
          this.store.updateStageRun(sr.id, {
            status: 'failed',
            failReason: 'check',
            failFeedback: synced
              ? t({
                  zh: `合并 ${target} 的最新代码后，${formatCommandFailure(failed)}`,
                  en: `After merging the latest ${target}: ${formatCommandFailure(failed)}`,
                })
              : t({
                  zh: `工作目录里有未经检查的提交，${formatCommandFailure(failed)}`,
                  en: `The working directory has unchecked commits: ${formatCommandFailure(failed)}`,
                }),
            endedAt: nowIso(),
          });
        }
      });
      if (failed) return;
    }

    const newHead = await revParse(workdir, 'HEAD');
    const ff = await fastForwardBranch(repo.path, target, newHead);
    this.checkAbort(signal);
    if (!ff.ok) {
      if (ff.reason === 'diverged') return; // target moved meanwhile; the next step syncs again
      this.store.addCheck({
        runId: run.id,
        stageRunId: sr.id,
        attemptId: null,
        kind: 'merge',
        name: t({ zh: `合并到 ${target}`, en: `Merge into ${target}` }),
        passed: false,
        detail: ff.detail,
      });
      this.block(run.id, { kind: 'target_dirty', message: ff.detail, stageRunId: sr.id });
      return;
    }
    this.store.addCheck({
      runId: run.id,
      stageRunId: sr.id,
      attemptId: null,
      kind: 'merge',
      name: t({ zh: `合并到 ${target}`, en: `Merge into ${target}` }),
      passed: true,
      detail: newHead,
    });
    this.store.event(run.id, 'merge.done', { target, head: newHead });
    this.passStage(run, sr);
  }

  private async complete(run: Run): Promise<void> {
    await this.removeMergedWorkspace(run);
    this.setStatus(run.id, 'completed', { finishedAt: nowIso() });
  }

  /** Remove the Run's worktree and branch once nothing on them is missing from the target. */
  private async removeMergedWorkspace(run: Run): Promise<void> {
    const repo = this.store.getRepo(run.repoId);
    if (run.worktreePath && run.branch) {
      const head = await revParse(run.worktreePath, 'HEAD');
      const target = await revParse(repo.path, repo.targetBranch);
      // Only clean up once the work is safely in the target branch.
      if (await isAncestor(repo.path, head, target)) {
        await removeWorktree(repo.path, run.worktreePath, run.branch);
        this.store.event(run.id, 'workspace.removed', {});
      }
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  /** Undo whatever was in progress (pause / shutdown / crash recovery). */
  private async discardInFlight(run: Run): Promise<void> {
    for (const task of this.store.listRunTasks(run.id)) {
      if (!IN_FLIGHT_TASK.has(task.status)) continue;
      if (run.worktreePath && task.baseCommit) await resetHard(run.worktreePath, task.baseCommit);
      this.store.updateTask(task.id, {
        status: 'pending',
        retries: 0,
        sessionId: null,
        sessionAgentId: null,
        pendingFeedback: null,
      });
      this.store.event(run.id, 'task.discarded', { taskId: task.id });
    }
    if (run.worktreePath && (await hasChanges(run.worktreePath).catch(() => false))) {
      await resetHard(run.worktreePath, 'HEAD');
    }
    // A merge stage may have merged the target branch in without finishing its checks:
    // go back to the last accepted commit; the merge is redone.
    const sr = run.currentStageRunId ? this.store.getStageRun(run.currentStageRunId) : undefined;
    const kind = sr && run.template.stages.find((s) => s.id === sr.stageId)?.kind;
    if (kind === 'merge' && sr?.status === 'executing' && run.worktreePath && run.headCommit) {
      const head = await revParse(run.worktreePath, 'HEAD').catch(() => null);
      if (head && head !== run.headCommit) {
        await resetHard(run.worktreePath, run.headCommit);
        this.store.event(run.id, 'merge.unchecked_discarded', { head, to: run.headCommit });
      }
    }
  }

  private setStatus(runId: string, status: RunStatus, patch: Partial<Run> = {}): Run {
    const run = this.store.updateRun(runId, { ...patch, status });
    this.store.event(runId, 'run.status', { status });
    return run;
  }

  /** Put the Run first in the queue, to go on as soon as the execution slot is free. */
  private requeueHead(runId: string, eventType: string): void {
    this.store.tx(() => {
      this.setStatus(runId, 'queued', { queuePos: this.store.queueHead(), blocked: null });
      this.store.event(runId, eventType, {});
    });
    this.limitWaits.delete(runId);
  }

  private block(runId: string, info: BlockInfo): void {
    this.store.tx(() => {
      this.setStatus(runId, 'blocked', { blocked: info });
      this.store.event(runId, 'run.blocked', { ...info });
    });
  }

  private saveArtifact(run: Run, sr: StageRun, name: string, kind: string, content: string): void {
    const dir = join(this.deps.paths.artifactsDir, run.id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${name}-${sr.stageId}-r${sr.round}-${newId('a')}.md`);
    writeFileSync(path, content);
    this.store.addArtifact({ runId: run.id, stageRunId: sr.id, name, kind, path });
  }

  /**
   * Verify commands that passed on `head`: those of the last agent task whose accepted
   * result is exactly this commit (a task without changes leaves HEAD at its base).
   */
  private passedCommandsAt(runId: string, head: string): string[] {
    const tasks = this.store.listRunTasks(runId);
    for (let i = tasks.length - 1; i >= 0; i--) {
      const task = tasks[i] as Task;
      if (task.status !== 'passed' || !task.baseCommit) continue;
      if ((task.commitSha ?? task.baseCommit) !== head) continue;
      const attempt = this.store.listAttempts(task.id).findLast((a) => a.outcome === 'passed');
      if (!attempt) return [];
      return this.store
        .listChecks(runId)
        .filter((c) => c.attemptId === attempt.id && c.kind === 'command' && c.passed)
        .map((c) => c.name);
    }
    return [];
  }

  private workdir(run: Run): string {
    if (!run.worktreePath) {
      throw new Error(
        t({ zh: 'Run 的工作区还没有创建', en: "The Run's workspace has not been created yet" }),
      );
    }
    return run.worktreePath;
  }

  private runLogDir(runId: string): string {
    return join(this.deps.paths.logsDir, runId);
  }

  private agentTimeoutMs(eff: EffectiveStage, agent: AgentConfig): number {
    const minutes =
      eff.def.timeout_minutes ?? agent.timeout_minutes ?? this.cfg.master.defaults.timeout_minutes;
    return minutes * 60_000;
  }

  private commandTimeoutMs(): number {
    return this.cfg.master.defaults.command_timeout_minutes * 60_000;
  }

  /** Environment of agents and of the commands run on their work: no GitHub credentials. */
  private agentEnv(): NodeJS.ProcessEnv {
    return prepareAgentEnv(this.deps.paths.agentGhConfigDir);
  }
}

/** Whether a Run is still blocked on the same thing a retry started from. */
function sameBlock(now: BlockInfo | null, before: BlockInfo): boolean {
  return (
    now !== null &&
    now.kind === before.kind &&
    now.taskId === before.taskId &&
    now.stageRunId === before.stageRunId
  );
}

/** USD for messages, e.g. "$1.60"; amounts under a cent keep more digits. */
export function formatUsd(usd: number): string {
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** Estimate cost from configured unit prices when the CLI does not report it. */
export function estimateCost(agent: AgentConfig, usage: AgentResult['usage']): number | undefined {
  if (!agent.price) return undefined;
  return (
    (usage.inputTokens * agent.price.input + usage.outputTokens * agent.price.output) / 1_000_000
  );
}

/**
 * Commit message for an accepted task: rounds after the first are marked in the title so
 * repeated rounds of one stage can be told apart; the Agent line records model and effort.
 */
export function commitMessage(input: {
  stageName: string;
  round: number;
  goal: string;
  summary: string;
  runId: string;
  agent: Pick<AgentConfig, 'id' | 'cli'>;
  attempt: Pick<Attempt, 'model' | 'actualModel' | 'effort'>;
}): string {
  const goalLine = input.goal.split('\n')[0]?.slice(0, 60) ?? '';
  const stage =
    input.round > 1
      ? t({
          zh: `${input.stageName}（第 ${input.round} 轮）`,
          en: `${input.stageName} (round ${input.round})`,
        })
      : input.stageName;
  const { agent, attempt } = input;
  const model = attempt.actualModel ?? attempt.model ?? t({ zh: '未知', en: 'unknown' });
  const effort = attempt.effort ?? t({ zh: '默认', en: 'default' });
  return `${stage}: ${goalLine}\n\n${input.summary}\n\nRun: ${input.runId}\nAgent: ${agent.id} (${agent.cli}, model: ${model}, effort: ${effort})\n`;
}

export { ConflictError, NotFoundError };

/** "1 retry", "2 retries": English only, Chinese writes 「n 次」 in place. */
function retryTimes(n: number): string {
  return n === 1 ? '1 retry' : `${n} retries`;
}

function unknownAgent(agentId: string): string {
  return t({
    zh: `Agent ${agentId} 不存在或未启用`,
    en: `Agent ${agentId} does not exist or is disabled`,
  });
}

function alreadyFinished(status: string): string {
  return t({ zh: `Run 已经结束（${status}）`, en: `The Run has already finished (${status})` });
}
