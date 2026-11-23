import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { prepareAgentEnv } from '../adapters/process.js';
import type { AgentAdapter, AgentExecution, AgentResult } from '../adapters/types.js';
import type { GitHubRepoStatus, GitHubStatus } from '../api/types.js';
import { brandName } from '../brand.js';
import {
  isAutoAcceptable,
  issueRunOverrides,
  redoDueAt,
  replyTimeoutHours,
  scoutBackoff,
  scoutFailureStreak,
  scoutLimitWait,
  splitUnfinishedRuns,
} from '../config/flow.js';
import { githubConfigKey, type HomePaths, type LoadedConfig } from '../config/load.js';
import type { GitHubRepoConfig } from '../config/schema.js';
import { type Engine, estimateCost, InvalidStateError } from '../engine/engine.js';
import { storedRunTimes } from '../engine/times.js';
import { t } from '../i18n.js';
import { NotFoundError, type Store } from '../store/store.js';
import {
  type DiscussionEntry,
  type EventRow,
  type FailedAttempt,
  FINISHED_RUN_STATUSES,
  type Repo,
  type Run,
  type RunIssue,
  type Scout,
  type ScoutProposal,
  type UntrustedAuthor,
} from '../store/types.js';
import { isMasterSource, type MasterOrigin } from '../upgrade/source.js';
import { lastUpgradeFailure, type UpgradeFailure } from '../upgrade/upgrader.js';
import { errorMessage, nowIso } from '../util.js';
import {
  addDetachedWorktree,
  commitTime,
  dropWorktree,
  pruneWorktrees,
  revParse,
  git as runGit,
} from '../workspace/git.js';
import { GhCli, type GhIssue, type GitHub } from './client.js';
import {
  autoAcceptedComment,
  discussionComment,
  type FailureOutcome,
  failedAttempt,
  goalChangedComment,
  goalFromIssue,
  issueUpdate,
  isTrusted,
  LABELS,
  labelDefs,
  markComment,
  proposalBody,
  redoStartedComment,
  repliesAfterMaster,
  untrustedAuthor,
  untrustedGoalMessage,
  withStatusLabel,
} from './issues.js';
import { redactForGitHub } from './redact.js';
import {
  filedProposal,
  issueDigest,
  parseScoutReport,
  proposalsHoldingScout,
  runDigest,
  scoutPrompt,
  scoutReportJsonSchema,
  untriaged,
} from './scout.js';

/** Error of a scout cut short by the Master stopping. */
const stoppedWhileScouting = () =>
  t({ zh: 'Master 在侦察过程中停止了', en: 'The Master stopped during the scout' });

/** How many of the latest closed issues the scout sees, done or not. */
const SCOUT_RECENT_CLOSED = 30;
/** How many issues closed as not planned the scout sees besides, with their reasons. */
const SCOUT_NOT_PLANNED = 300;

const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-11-23 14:05", in the Master's local time. */
function localTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Error of a scout whose agent ran out of quota or was rate-limited, with when the quota is
 * expected back if the CLI said, and what the CLI said.
 */
function scoutLimitedText(resetAt: number | undefined, cliError: string | undefined): string {
  const head =
    resetAt === undefined
      ? t({
          zh: '侦察的 Agent 额度用尽或被限流',
          en: "The scout's agent is out of quota or rate-limited",
        })
      : t({
          zh: `侦察的 Agent 额度用尽或被限流，预计 ${localTime(resetAt)} 恢复`,
          en: `The scout's agent is out of quota or rate-limited; the quota is expected back at ${localTime(resetAt)}`,
        });
  return cliError?.trim() ? t({ zh: `${head}：${cliError}`, en: `${head}: ${cliError}` }) : head;
}

/** Of two waits, the one that ends later. */
function laterWait(a: ScoutWait | null, b: (ScoutWait & { until: string }) | null) {
  if (!b) return a;
  return a?.until && Date.parse(a.until) >= Date.parse(b.until) ? a : b;
}

const notRegistered = (name: string) =>
  t({
    zh: `仓库 ${name} 没有在看板上登记`,
    en: `Repo ${name} is not registered on the dashboard`,
  });

/**
 * Why the automatic scout waits for a human: 「有 2 条提案、1 个卡住的 Run 等你处理」. A part
 * that is 0 is left out.
 */
function waitingForYouText(proposals: number, stuck: number): string {
  const p = `${proposals} proposal${proposals === 1 ? '' : 's'}`;
  const s = `${stuck} stuck Run${stuck === 1 ? '' : 's'}`;
  if (stuck === 0) return t({ zh: `有 ${proposals} 条提案等你处理`, en: `${p} waiting for you` });
  if (proposals === 0) {
    return t({ zh: `有 ${stuck} 个卡住的 Run 等你处理`, en: `${s} waiting for you` });
  }
  return t({
    zh: `有 ${proposals} 条提案、${stuck} 个卡住的 Run 等你处理`,
    en: `${p} and ${s} waiting for you`,
  });
}

/**
 * Why the automatic scout waits for work that goes on by itself: 「等 1 个未结束的 Run 做完，
 * 另外有 2 个 issue 在等重做」. A part that is 0 is left out; null when both are.
 */
function busyText(moving: number, redo: number): string | null {
  const runs = t({
    zh: `等 ${moving} 个未结束的 Run 做完`,
    en: `Waiting for ${moving} unfinished Run${moving === 1 ? '' : 's'} to finish`,
  });
  const issues = t({
    zh: `有 ${redo} 个 issue 在等重做`,
    en: `${redo} issue${redo === 1 ? '' : 's'} waiting to be redone`,
  });
  if (redo === 0) return moving === 0 ? null : runs;
  if (moving === 0) return issues;
  return t({ zh: `${runs}，另外${issues}`, en: `${runs}; ${issues}` });
}

/** A scout in progress: its agent once started, and the whole scout including the cleanup. */
interface ScoutEntry {
  scoutId: string;
  exec?: AgentExecution;
  done?: Promise<void>;
}

/** Why an automatic scout does not start now; `until`: it may start after that time. */
export interface ScoutWait {
  reason: string;
  until?: string;
}

export interface BridgeDeps {
  store: Store;
  engine: Engine;
  paths: HomePaths;
  config: () => LoadedConfig;
  adapters: Map<string, AgentAdapter>;
  /** Tests pass a fake; otherwise gh, as the configured account. */
  github?: GitHub;
  /**
   * The install directory the Master runs from and its origin, to tell which repo is the
   * Master's own source; null when it does not run from one (then no repo is).
   */
  masterOrigin?: MasterOrigin | null;
}

/** Start of the current day in the Master's local time, as ISO. */
export function startOfToday(now = new Date()): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * GitHub Issues as the backlog:
 * - intake: an open issue labeled ares1:ready becomes a Run;
 * - sync: the Run's progress shows on the issue (labels, comments, closed when merged);
 * - stop: a human closing the issue terminates its unfinished Run, and the issue is left alone;
 * - redo: a failed Run is redone as a new Run told why it failed, after a wait that doubles with
 *   each attempt (see redoDueAt), up to `max_run_attempts` Runs per issue and within the day's
 *   budget; then the issue is closed with every failure's reason;
 * - discussion: the requirement assessment's questions and conclusion are posted on the issue,
 *   and a human's replies there go back to the Run;
 * - scout: an AI reads the repo and its Run history and proposes issues, on demand or by itself
 *   whenever no Run of the repo goes on by itself (backing off while scouts find nothing or
 *   fail, waiting for the quota when its agent ran out of it, and capping the proposals and
 *   stuck Runs left for a human); proposals up to the configured risk are accepted without a
 *   human.
 * Intake, auto-accept and automatic scouts only happen while the work switch is on.
 * GitHub is only a mirror: failures are reported and retried on the next poll, never block Runs.
 */
export class IssueBridge {
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  /** Syncs when the earliest wait before redoing a failed Run ends. */
  private redoTimer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private client: { key: string; gh: GitHub } | undefined;
  /** gh's active account, for the client it was asked with. */
  private viewer: { gh: GitHub; login: string } | undefined;
  private readonly labelsReady = new Set<string>();
  private readonly resolved = new Map<string, string>();
  private readonly scouting = new Map<string, ScoutEntry>();
  /** Why no automatic scout started at the last poll, per repo name. */
  private readonly scoutWaiting = new Map<string, ScoutWait | null>();
  /**
   * When the quota of the agent of the repo's latest rate-limited scout comes back (epoch ms), if
   * the CLI said; per repo id. Kept in memory only, like the engine's waits for a Run's quota:
   * after a restart the wait goes by the scouts in a row that hit a limit (see scoutLimitWait).
   */
  private readonly scoutLimitResets = new Map<string, number>();
  private lastPollAt: string | null = null;
  /** Target branch commit last pushed, per repo path. */
  private readonly pushed = new Map<string, string>();
  private lastError: { message: string; at: string } | null = null;
  private stopping = false;
  private readonly onEvent = (e: EventRow) => {
    // An assessment's result changes the discussion, not always the Run status (go keeps running).
    if (
      e.type === 'run.status' ||
      e.type === 'assess.result' ||
      e.type === 'discussion.replied' ||
      e.type === 'discussion.timed_out'
    ) {
      this.scheduleSync();
    }
    if (e.type === 'master.working' && e.data.on === true) void this.poll();
  };

  constructor(private readonly deps: BridgeDeps) {}

  private get cfg() {
    return this.deps.config();
  }

  /** How often the Master looks at GitHub (`poll_minutes`). */
  private get pollMinutes(): number {
    return this.cfg.master.github?.poll_minutes ?? 5;
  }

  private gh(): GitHub {
    if (this.deps.github) return this.deps.github;
    const bin = this.cfg.master.bins.gh ?? 'gh';
    const account = this.cfg.master.github?.account;
    const key = `${bin}|${account ?? ''}`;
    if (this.client?.key !== key) this.client = { key, gh: new GhCli(bin, account) };
    return this.client.gh;
  }

  /**
   * Login of the account the Master acts as, which it trusts like a member of the repo:
   * `github.account`, else gh's active account, asked once per client.
   */
  private async masterLogin(): Promise<string> {
    const account = this.cfg.master.github?.account;
    if (account) return account;
    const gh = this.gh();
    if (this.viewer?.gh !== gh) this.viewer = { gh, login: await gh.viewer() };
    return this.viewer.login;
  }

  // ---- lifecycle -------------------------------------------------------------

  async start(opts: { poll: boolean } = { poll: true }): Promise<void> {
    for (const s of this.deps.store.listScouts({ limit: 1000 })) {
      if (s.status === 'running') {
        this.deps.store.updateScout(s.id, {
          status: 'interrupted',
          error: stoppedWhileScouting(),
          endedAt: nowIso(),
        });
      }
    }
    await this.removeLeftoverScoutDirs();
    this.deps.store.bus.on('event', this.onEvent);
    if (opts.poll) this.schedulePoll(2_000);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.deps.store.bus.off('event', this.onEvent);
    clearTimeout(this.pollTimer);
    clearTimeout(this.syncTimer);
    clearTimeout(this.redoTimer);
    // Wait for the scouts to record the interruption and delete their temporary worktrees.
    await Promise.all(
      [...this.scouting.values()].map(async (s) => {
        await s.exec?.stop();
        await s.done;
      }),
    );
    await this.chain;
  }

  /** Where a scout reads the repo: a temporary worktree, deleted when the scout ends. */
  private scoutDir(scoutId: string): string {
    return join(this.deps.paths.worktreesDir, 'scouts', scoutId);
  }

  /** Temporary worktrees of scouts that a previous Master did not get to delete. */
  private async removeLeftoverScoutDirs(): Promise<void> {
    let ids: string[];
    try {
      ids = readdirSync(join(this.deps.paths.worktreesDir, 'scouts'));
    } catch {
      return; // no scout has run yet
    }
    const repos = new Set<string>();
    for (const id of ids) {
      try {
        rmSync(this.scoutDir(id), { recursive: true, force: true });
      } catch {
        continue; // tried again at the next start
      }
      const repo = this.scoutRepo(id);
      // Without the scout's record the worktree may belong to any repo.
      const paths = repo ? [repo.path] : this.deps.store.listRepos().map((r) => r.path);
      for (const p of paths) repos.add(p);
    }
    // Git forgets the worktrees whose directory is gone.
    for (const repo of repos) await pruneWorktrees(repo);
  }

  private scoutRepo(scoutId: string): Repo | undefined {
    try {
      return this.deps.store.findRepo(this.deps.store.getScout(scoutId).repoId);
    } catch (err) {
      if (err instanceof NotFoundError) return undefined;
      throw err;
    }
  }

  private schedulePoll(delayMs: number): void {
    clearTimeout(this.pollTimer);
    if (this.stopping) return;
    this.pollTimer = setTimeout(() => {
      void this.poll().finally(() => this.schedulePoll(this.pollMinutes * 60_000));
    }, delayMs);
  }

  private scheduleSync(): void {
    clearTimeout(this.syncTimer);
    if (this.stopping) return;
    this.syncTimer = setTimeout(() => void this.sync(), 1_000);
  }

  /**
   * Sync once the earliest wait before redoing a failed Run ends (see redoDueAt), so the redo
   * does not also wait for the next poll. Waits held by the day's budget or the work switch are
   * left to the polls. Set again after every sync and poll.
   */
  private scheduleRedo(): void {
    clearTimeout(this.redoTimer);
    this.redoTimer = undefined;
    const github = this.cfg.master.github;
    if (!github || this.stopping || !this.deps.store.working) return;
    const now = Date.now();
    let next: number | undefined;
    for (const name of Object.keys(github.repos)) {
      const repo = this.deps.store.findRepo(name);
      if (!repo) continue;
      for (const run of this.deps.store.runsAwaitingRedo(repo.id)) {
        const due = redoDueAt(run, this.pollMinutes);
        if (due !== null && due > now && (next === undefined || due < next)) next = due;
      }
    }
    if (next === undefined) return;
    // A second late, so the wait is surely over when the sync looks.
    this.redoTimer = setTimeout(() => void this.sync(), next - now + 1_000);
    this.redoTimer.unref();
  }

  /** Run `fn` after everything queued before it; GitHub calls never overlap. */
  private serial(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  /**
   * Every comment of the Master carries the marker that tells it from a human's, and leaves out
   * the user's home directory: it quotes error output and agents' words, which carry local paths.
   */
  private comment(repo: string, number: number, body: string): Promise<void> {
    return this.gh().comment(repo, number, markComment(redactForGitHub(body)));
  }

  private report(err: unknown): void {
    const message = errorMessage(err);
    if (this.lastError?.message !== message) {
      this.deps.store.event(null, 'github.error', { message });
    }
    this.lastError = { message, at: nowIso() };
  }

  // ---- poll: intake, sync, scheduled scouts ----------------------------------

  /**
   * One round: accept proposals the settings allow, start Runs for ready issues, terminate Runs
   * whose issue a human closed and start over those whose issue a human changed, catch issues up,
   * pass on replies to the assessments' questions, start a scout where the repo is idle. With the
   * work switch off only the terminating and the catching up happen: neither starts new work.
   */
  poll(): Promise<void> {
    return this.serial(async () => {
      const github = this.cfg.master.github;
      if (!github || this.stopping) return;
      const working = this.deps.store.working;
      let failed = false;
      const each = async (step: (name: string) => Promise<void>) => {
        for (const name of Object.keys(github.repos)) {
          try {
            await step(name);
          } catch (err) {
            failed = true;
            this.report(err);
          }
        }
      };
      if (working) {
        await each((name) => this.acceptBacklog(name));
        await each((name) => this.intake(name));
      }
      if (!(await this.followIssues())) failed = true;
      if (!(await this.syncRuns())) failed = true;
      if (working) {
        await each((name) => this.collectReplies(name));
        await each((name) => this.redoFailedRuns(name));
      }
      await each((name) => this.pushTarget(name));
      if (working) await each((name) => this.maybeAutoScout(name));
      else {
        for (const name of Object.keys(github.repos)) {
          this.scoutWaiting.set(name, {
            reason: t({ zh: '工作开关已关闭', en: 'The work switch is off' }),
          });
        }
      }
      this.scheduleRedo();
      this.lastPollAt = nowIso();
      if (!failed) this.lastError = null;
    });
  }

  /**
   * Catch issues up with their Runs now, and redo the failed Runs whose wait before the redo is
   * over (see redoDueAt): a Run that just failed is not redone right away.
   */
  sync(): Promise<void> {
    return this.serial(async () => {
      const github = this.cfg.master.github;
      if (!github || this.stopping) return;
      await this.syncRuns();
      if (this.deps.store.working) {
        for (const name of Object.keys(github.repos)) {
          try {
            await this.redoFailedRuns(name);
          } catch (err) {
            this.report(err);
          }
        }
      }
      this.scheduleRedo();
    });
  }

  private repoSetup(name: string): { repo: Repo; cfg: GitHubRepoConfig } {
    const cfg = this.cfg.master.github?.repos[name];
    if (!cfg) {
      throw new NotFoundError(
        t({
          zh: `config.yaml 的 github.repos 里没有 ${name}`,
          en: `${name} is not in github.repos of config.yaml`,
        }),
      );
    }
    const problems = this.cfg.errors[githubConfigKey(name)];
    if (problems) {
      throw new InvalidStateError(
        t({
          zh: `github.repos.${name} 配置有误：${problems.join('；')}`,
          en: `github.repos.${name} is misconfigured: ${problems.join('; ')}`,
        }),
      );
    }
    const repo = this.deps.store.findRepo(name);
    if (!repo) throw new NotFoundError(notRegistered(name));
    return { repo, cfg };
  }

  private async issuesRepo(repo: Repo, cfg: GitHubRepoConfig): Promise<string> {
    if (cfg.issues_repo) return cfg.issues_repo;
    let full = this.resolved.get(repo.path);
    if (!full) {
      full = await this.gh().resolveRepo(repo.path);
      this.resolved.set(repo.path, full);
    }
    return full;
  }

  private async ensureLabels(full: string): Promise<void> {
    if (this.labelsReady.has(full)) return;
    await this.gh().ensureLabels(full, labelDefs());
    this.labelsReady.add(full);
  }

  private async intake(name: string): Promise<void> {
    const { repo, cfg } = this.repoSetup(name);
    const full = await this.issuesRepo(repo, cfg);
    await this.ensureLabels(full);
    const gh = this.gh();
    const ready = await gh.listIssues(full, { state: 'open', label: LABELS.ready, limit: 50 });
    for (const issue of ready.sort((a, b) => a.number - b.number)) {
      if (this.stopping) return;
      let run = this.deps.store.unfinishedRunForIssue(full, issue.number);
      if (!run) {
        // Only people allowed to triage can add ares1:ready, but anybody may have written the
        // issue, and may edit it after the label was added.
        const untrusted = isTrusted(issue, await this.masterLogin())
          ? undefined
          : untrustedAuthor(issue, null);
        run = this.createIssueRun(
          repo,
          cfg,
          goalFromIssue(issue),
          // ares1:ready (again) starts the count of attempts over.
          {
            repo: full,
            number: issue.number,
            url: issue.url,
            auto: issue.labels.includes(LABELS.auto),
            attempt: 1,
            ...(untrusted ? { untrusted } : {}),
          },
          untrusted ? untrustedGoalMessage(issue) : undefined,
        );
        const templateName = this.templateName(cfg);
        const runUrl = `${this.dashboardUrl()}/#/runs/${run.id}`;
        await this.comment(
          full,
          issue.number,
          t({
            zh: `${brandName()}开始处理：Run \`${run.id}\`（模板「${templateName}」）。\n\n看板：${runUrl}`,
            en: `${brandName()} started on it: Run \`${run.id}\` (template "${templateName}").\n\nDashboard: ${runUrl}`,
          }),
        );
      }
      // The Run may have moved on already; the next sync reports where it is.
      await gh.setLabels(full, issue.number, withStatusLabel(issue.labels, LABELS.running));
      this.deps.store.setIssueSynced(run.id, 'queued');
    }
  }

  /**
   * A Run of an issue: with the repo's template, and without approval before merging when
   * `auto_merge` is on (the other gates of the template stay). Every Run from an issue is created
   * here, whether a human added ares1:ready, a failed one is redone, or the issue was changed.
   */
  private createIssueRun(
    repo: Repo,
    cfg: GitHubRepoConfig,
    goal: string,
    issue: RunIssue,
    confirmGoal?: string,
  ): Run {
    return this.deps.engine.createRun({
      repo: repo.name,
      template: cfg.template,
      goal,
      overrides: issueRunOverrides(this.cfg.templates.get(cfg.template), cfg.auto_merge),
      issue,
      confirmGoal,
    });
  }

  /** Name of the repo's template, as the comments on its issues give it. */
  private templateName(cfg: GitHubRepoConfig): string {
    return this.cfg.templates.get(cfg.template)?.name ?? cfg.template;
  }

  /**
   * Accept proposals still waiting for a human that the auto-accept settings now allow, e.g. after
   * the settings were loosened. Uses the risk and size the scout gave them.
   */
  private async acceptBacklog(name: string): Promise<void> {
    const { repo, cfg } = this.repoSetup(name);
    if (cfg.auto_accept.max_risk === 'none') return;
    const full = await this.issuesRepo(repo, cfg);
    const open = await this.gh().listIssues(full, {
      state: 'open',
      label: LABELS.proposal,
      limit: 100,
    });
    const scouts = this.deps.store.listScouts({ repoId: repo.id, limit: 200 });
    for (const issue of untriaged(open).sort((a, b) => a.number - b.number)) {
      if (!this.mayAutoAccept(repo, cfg)) return;
      const filed = filedProposal(scouts, issue.number);
      const proposal = filed?.proposal;
      if (!filed || !proposal?.issue || !isAutoAcceptable(proposal, cfg.auto_accept.max_risk)) {
        continue;
      }
      const { scout } = filed;
      await this.gh().setLabels(full, issue.number, [
        ...withStatusLabel(issue.labels, LABELS.ready),
        LABELS.auto,
      ]);
      await this.comment(full, issue.number, autoAcceptedComment());
      proposal.issue.auto = true;
      this.deps.store.tx(() => {
        this.deps.store.updateScout(scout.id, { proposals: scout.proposals });
        this.deps.store.event(null, 'issue.auto_accepted', { repo: name, issue: issue.number });
      });
    }
  }

  /** Push the target branch to GitHub when it moved since the last push. */
  private async pushTarget(name: string): Promise<void> {
    const { repo, cfg } = this.repoSetup(name);
    if (!cfg.push) return;
    const head = await revParse(repo.path, repo.targetBranch);
    if (this.pushed.get(repo.path) === head) return;
    const full = await this.issuesRepo(repo, cfg);
    await this.gh().push(repo.path, full, repo.targetBranch);
    this.pushed.set(repo.path, head);
    this.deps.store.event(null, 'github.pushed', { repo: name, branch: repo.targetBranch, head });
    // Keep `git status` in the clone honest when its origin is that GitHub repo.
    try {
      const url = (await runGit(repo.path, ['remote', 'get-url', 'origin'])).replace(/\.git$/, '');
      if (url.endsWith(`github.com:${full}`) || url.endsWith(`github.com/${full}`)) {
        await runGit(repo.path, ['update-ref', `refs/remotes/origin/${repo.targetBranch}`, head]);
      }
    } catch {
      // no origin: nothing to keep in step
    }
  }

  private dashboardUrl(): string {
    return `http://127.0.0.1:${this.cfg.master.port}`;
  }

  /**
   * Follow what humans do to the issues of unfinished Runs. A human closed the issue (completed or
   * not planned): nobody wants the work any more, so its Run is terminated. A human changed its
   * title or body: the Run is started over on the new text (`restartForChangedIssue`). Returns
   * false when some issue could not be read or its Run not terminated (retried on the next poll);
   * the Run stays as it is then.
   */
  private async followIssues(): Promise<boolean> {
    let ok = true;
    const unfinished = this.deps.store
      .listRuns()
      .filter((r) => r.issue && !FINISHED_RUN_STATUSES.includes(r.status));
    for (const run of unfinished) {
      if (this.stopping) break;
      const issue = run.issue;
      if (!issue) continue;
      try {
        const latest = await this.gh().getIssue(issue.repo, issue.number);
        if (latest.state === 'closed') {
          await this.cancelForClosedIssue(run.id, issue, latest.stateReason);
        } else {
          await this.restartForChangedIssue(run, latest);
        }
      } catch (err) {
        ok = false;
        this.report(err);
      }
    }
    return ok;
  }

  /**
   * A human changed the title or body of the issue after its Run was created. The goal was read
   * once, when the Run was created, so the Run would do the old requirement through to the merge
   * while nobody is around. It is terminated instead, and a new Run does the changed one from the
   * start, as the same attempt: a change is no failure, so it uses up none of
   * `max_run_attempts`. The old Run's worktree and branch are removed, nobody needs them.
   *
   * Left alone, as before: Runs of issues by people the Master does not trust (their goal stays as
   * it was when the Run was created, and a human confirms it), Runs that merge or wait for the
   * approval to merge (too late to start over; the change does not go into them either), and
   * everything while the work switch is off (nothing new starts then; the first poll after it is
   * on does it).
   */
  private async restartForChangedIssue(stale: Run, latest: GhIssue): Promise<void> {
    const prev = stale.issue;
    if (!prev || prev.untrusted || !this.deps.store.working) return;
    const goal = goalFromIssue(latest);
    // The engine keeps the goal trimmed.
    if (goal.trim() === stale.goal) return;
    const store = this.deps.store;
    const repo = store.getRepo(stale.repoId);
    const cfg = this.cfg.master.github?.repos[repo.name];
    // The new Run could not be created: the old one goes on rather than leave the issue without.
    if (
      !cfg ||
      this.cfg.errors[githubConfigKey(repo.name)] ||
      !this.cfg.templates.has(cfg.template)
    ) {
      return;
    }
    if (!isTrusted(latest, await this.masterLogin()) || this.stopping) return;
    // Read again right before terminating it: the Run may have moved on while GitHub answered.
    // Nothing is awaited between this check and the engine stopping it.
    const run = store.getRun(stale.id);
    if (FINISHED_RUN_STATUSES.includes(run.status) || this.merging(run)) return;
    try {
      await this.deps.engine.cancel(run.id);
    } catch (err) {
      // It finished meanwhile; it is caught up on the issue as usual.
      if (err instanceof InvalidStateError) return;
      throw err;
    }
    // Created before the old Run is marked caught up, so a crash in between leaves the issue
    // with an unfinished Run rather than none.
    const next = this.createIssueRun(repo, cfg, goal, {
      repo: prev.repo,
      number: prev.number,
      url: prev.url,
      auto: prev.auto,
      attempt: prev.attempt ?? 1,
      ...(prev.earlier ? { earlier: prev.earlier } : {}),
    });
    store.tx(() => {
      // Terminated on purpose: no ares1:failed, no comment saying it was terminated.
      const old = store.getRun(run.id);
      store.setIssueSynced(old.id, old.status);
      store.setIssueDiscussionSynced(old.id, old.discussion.length);
      store.event(old.id, 'run.goal_changed', {
        repo: prev.repo,
        issue: prev.number,
        newRun: next.id,
      });
      store.setIssueSynced(next.id, 'queued');
    });
    try {
      await this.comment(
        prev.repo,
        prev.number,
        goalChangedComment({
          oldRunId: run.id,
          runId: next.id,
          templateName: this.templateName(cfg),
          dashboardUrl: this.dashboardUrl(),
        }),
      );
      // The Run may have moved on already; the next sync reports where it is.
      await this.gh().setLabels(
        prev.repo,
        prev.number,
        withStatusLabel(latest.labels, LABELS.running),
      );
    } finally {
      // A removal that fails is recorded on the old Run by the engine.
      await this.deps.engine.removeGoalChangedWorkspace(run.id, next.id);
    }
  }

  /** The Run merges, or waits for the approval to merge: too late to start it over. */
  private merging(run: Run): boolean {
    if (!run.currentStageRunId) return false;
    const sr = this.deps.store.getStageRun(run.currentStageRunId);
    return run.template.stages.find((s) => s.id === sr.stageId)?.kind === 'merge';
  }

  /**
   * The issue stays as the human left it: no label change, no comment, not closed again, so their
   * closing comment is still the last one (the scout reads it as the reason not to do it).
   */
  private async cancelForClosedIssue(
    runId: string,
    issue: RunIssue,
    stateReason: string | null,
  ): Promise<void> {
    try {
      await this.deps.engine.cancel(runId);
    } catch (err) {
      // It finished meanwhile; it is caught up on the issue as usual.
      if (err instanceof InvalidStateError) return;
      throw err;
    }
    const store = this.deps.store;
    store.tx(() => {
      const run = store.getRun(runId);
      store.setIssueSynced(runId, run.status);
      store.setIssueDiscussionSynced(runId, run.discussion.length);
      store.event(runId, 'run.issue_closed', {
        repo: issue.repo,
        issue: issue.number,
        stateReason,
      });
    });
  }

  /** Returns false when some issue could not be updated (retried on the next poll). */
  private async syncRuns(): Promise<boolean> {
    let ok = true;
    for (const run of this.deps.store.runsWithIssueBehind()) {
      if (this.stopping) break;
      try {
        await this.syncRun(run);
      } catch (err) {
        ok = false;
        this.report(err);
      }
    }
    return ok;
  }

  private async syncRun(run: Run): Promise<void> {
    const issue = run.issue;
    if (!issue) return;
    // The discussion first, so a conclusion is on the issue before it closes.
    await this.syncDiscussion(run, issue);
    if (run.issueSynced === run.status) return;
    const repo = this.deps.store.getRepo(run.repoId);
    const stageName = this.stageNameOf(run);
    // The issue closes once the code is on GitHub; a failed push is retried on the next poll.
    let pushed = false;
    if (run.status === 'completed') {
      const name = repo.name;
      if (this.cfg.master.github?.repos[name]?.push) {
        await this.pushTarget(name);
        pushed = true;
      }
    }
    const failure =
      run.status === 'failed' ? this.failureOutcome(run, repo, stageName ?? null) : undefined;
    const update = issueUpdate(run, {
      dashboardUrl: this.dashboardUrl(),
      targetBranch: repo.targetBranch,
      stageName,
      pushed,
      times: run.status === 'completed' ? storedRunTimes(this.deps.store, run) : undefined,
      failure,
    });
    const gh = this.gh();
    const current = await gh.getLabels(issue.repo, issue.number);
    const wanted = withStatusLabel(current, update.label);
    if (wanted.length !== current.length || wanted.some((l) => !current.includes(l))) {
      await gh.setLabels(issue.repo, issue.number, wanted);
    }
    if (update.comment) await this.comment(issue.repo, issue.number, update.comment);
    if (update.close) await gh.close(issue.repo, issue.number, update.close);
    const store = this.deps.store;
    store.tx(() => {
      store.setIssueSynced(run.id, run.status);
      if (failure?.kind === 'redo') {
        // The failed Run's page learns when the next attempt starts.
        store.event(run.id, 'issue.redo_scheduled', {
          repo: repo.name,
          issue: issue.number,
          attempt: failure.attempt + 1,
          maxAttempts: failure.max,
          redoAt: new Date(failure.redoAt).toISOString(),
        });
      }
      if (failure?.kind === 'exhausted') {
        store.event(run.id, 'issue.retries_exhausted', {
          repo: repo.name,
          issue: issue.number,
          attempts: failure.attempt,
          maxAttempts: failure.max,
          runIds: failure.failures.map((f) => f.runId),
        });
      }
    });
    if (failure?.kind === 'exhausted') await this.removeExhaustedAttempts(run, failure.failures);
  }

  /**
   * The issue is closed after its last attempt: only that Run keeps its worktree and branch.
   * After the issue is caught up, so a removal that goes wrong costs no second comment; each
   * failed removal is recorded on its Run by the engine.
   */
  private async removeExhaustedAttempts(run: Run, failures: FailedAttempt[]): Promise<void> {
    const earlier = failures.map((f) => f.runId).filter((id) => id !== run.id);
    if (earlier.length === 0) return;
    try {
      await this.deps.engine.removeExhaustedAttempts(run.id, earlier);
    } catch (err) {
      console.warn(
        t({
          zh: `没能删除 Run ${run.id} 之前几次失败尝试的工作目录：${errorMessage(err)}`,
          en: `Could not remove the working directories of the failed attempts before Run ${run.id}: ${errorMessage(err)}`,
        }),
      );
    }
  }

  /** Name of the stage the Run is in, or ended in. */
  private stageNameOf(run: Run): string | undefined {
    if (!run.currentStageRunId) return undefined;
    const sr = this.deps.store.getStageRun(run.currentStageRunId);
    return run.template.stages.find((s) => s.id === sr.stageId)?.name ?? sr.stageId;
  }

  /**
   * What follows a failed Run of an issue: redone while the issue has attempts left
   * (`max_run_attempts`), otherwise the issue is closed. Decided once and kept with the Run, so
   * catching the issue up again after a GitHub error says the same. undefined when the repo is no
   * longer configured for GitHub: the issue waits for a human then.
   */
  private failureOutcome(run: Run, repo: Repo, stage: string | null): FailureOutcome | undefined {
    const issue = run.issue;
    const cfg = this.cfg.master.github?.repos[repo.name];
    if (!issue || !cfg) return undefined;
    const attempt = issue.attempt ?? 1;
    let redo = issue.redo;
    if (!redo) {
      redo = attempt < cfg.max_run_attempts ? 'pending' : 'exhausted';
      this.deps.store.setIssueRedo(run.id, redo);
    }
    const max = Math.max(cfg.max_run_attempts, attempt);
    if (redo === 'exhausted') {
      const failures = [...(issue.earlier ?? []), failedAttempt(run, stage)];
      return { kind: 'exhausted', attempt, max, failures };
    }
    const redoAt = redoDueAt({ ...run, issue: { ...issue, redo } }, this.pollMinutes);
    return {
      kind: 'redo',
      attempt,
      max,
      budgetReached: this.overBudget(repo, cfg),
      redoAt: redoAt ?? Date.now(),
    };
  }

  /**
   * Redo the repo's failed Runs whose issue is still open: a new Run, the next attempt, told why
   * the earlier ones failed. Only once the failure is on the issue, so the comments come in
   * order, and once the wait after the failure is over (see redoDueAt), so a passing outage does
   * not use up the attempts. Over today's budget the redos wait for the next day. Neither wait
   * costs an attempt.
   */
  private async redoFailedRuns(name: string): Promise<void> {
    const { repo, cfg } = this.repoSetup(name);
    const store = this.deps.store;
    for (const failed of store.runsAwaitingRedo(repo.id)) {
      if (this.stopping) return;
      const prev = failed.issue;
      if (!prev || failed.issueSynced !== 'failed') continue;
      if (store.latestRunForIssue(prev.repo, prev.number)?.id !== failed.id) {
        // A human started the issue over with ares1:ready meanwhile.
        this.abandonRedo(name, failed, prev, 'restarted');
        continue;
      }
      // Still waiting; the other issues' redos go on. A sync is set for when it ends.
      if ((redoDueAt(failed, this.pollMinutes) ?? 0) > Date.now()) continue;
      if (this.overBudget(repo, cfg)) return;
      const gh = this.gh();
      const issue = await gh.getIssue(prev.repo, prev.number);
      if (issue.state === 'closed') {
        // Nobody wants it any more; the issue stays as the human left it.
        this.abandonRedo(name, failed, prev, 'closed');
        continue;
      }
      const attempt = (prev.attempt ?? 1) + 1;
      const max = Math.max(cfg.max_run_attempts, attempt);
      // The goal is read from the issue again: a human may have made it clearer meanwhile.
      const goal = goalFromIssue(issue);
      let untrusted: UntrustedAuthor | undefined;
      if (!isTrusted(issue, await this.masterLogin())) {
        // What a human confirmed for the failed Run goes on; a changed text is asked about again.
        const confirmed = prev.untrusted?.confirmedAt;
        untrusted = untrustedAuthor(
          issue,
          confirmed && goal.trim() === failed.goal ? confirmed : null,
        );
      }
      const next = this.createIssueRun(
        repo,
        cfg,
        goal,
        {
          repo: prev.repo,
          number: prev.number,
          url: issue.url,
          auto: prev.auto,
          attempt,
          earlier: [
            ...(prev.earlier ?? []),
            failedAttempt(failed, this.stageNameOf(failed) ?? null),
          ],
          ...(untrusted ? { untrusted } : {}),
        },
        untrusted && untrusted.confirmedAt === null ? untrustedGoalMessage(issue) : undefined,
      );
      store.tx(() => {
        store.setIssueRedo(failed.id, 'redone');
        store.event(next.id, 'issue.redone', {
          repo: name,
          issue: prev.number,
          attempt,
          maxAttempts: max,
          failedRunId: failed.id,
        });
      });
      await this.comment(
        prev.repo,
        prev.number,
        redoStartedComment({
          runId: next.id,
          attempt,
          max,
          templateName: this.templateName(cfg),
          dashboardUrl: this.dashboardUrl(),
        }),
      );
      // The Run may have moved on already; the next sync reports where it is.
      await gh.setLabels(prev.repo, prev.number, withStatusLabel(issue.labels, LABELS.running));
      store.setIssueSynced(next.id, 'queued');
    }
  }

  private abandonRedo(
    name: string,
    run: Run,
    issue: RunIssue,
    reason: 'closed' | 'restarted',
  ): void {
    const store = this.deps.store;
    store.tx(() => {
      store.setIssueRedo(run.id, 'abandoned');
      store.event(run.id, 'issue.redo_abandoned', { repo: name, issue: issue.number, reason });
    });
  }

  /** Post the discussion entries the issue does not have yet, one comment each, in order. */
  private async syncDiscussion(run: Run, issue: RunIssue): Promise<void> {
    if (run.issueDiscussionSynced >= run.discussion.length) return;
    const stageOf = new Map(
      this.deps.store.listStageRuns(run.id).map((sr) => [sr.id, sr.stageId] as const),
    );
    // How long the round's assess stage waits for a reply, as the engine reads it.
    const waitOf = (entry: DiscussionEntry): number | null => {
      if (entry.role !== 'assessor') return null;
      const def = run.template.stages.find((s) => s.id === stageOf.get(entry.stageRunId));
      return def ? replyTimeoutHours(def) : null;
    };
    const ctx = {
      dashboardUrl: this.dashboardUrl(),
      runId: run.id,
      pollMinutes: this.pollMinutes,
    };
    for (let i = run.issueDiscussionSynced; i < run.discussion.length; i++) {
      if (this.stopping) return;
      const entry = run.discussion[i];
      const body = entry
        ? discussionComment(entry, { ...ctx, replyTimeoutHours: waitOf(entry) })
        : null;
      if (body) await this.comment(issue.repo, issue.number, body);
      this.deps.store.setIssueDiscussionSynced(run.id, i + 1);
    }
  }

  /**
   * Replies on the issue to the assessment's questions: comments without the Master's marker
   * after its last comment, written by people it trusts (`isTrusted`); the others are only
   * counted on the questions. Only once the latest questions are on the issue, so earlier
   * comments are never taken for answers to them. The Run is assessed again with the replies.
   */
  private async collectReplies(name: string): Promise<void> {
    const { repo } = this.repoSetup(name);
    const waiting = this.deps.store
      .listRuns({ status: 'blocked', repoId: repo.id })
      .filter((r) => r.issue && r.blocked?.kind === 'discussion');
    for (const run of waiting) {
      if (this.stopping) return;
      const issue = run.issue;
      if (!issue || run.issueDiscussionSynced < run.discussion.length) continue;
      const master = await this.masterLogin();
      const comments = await this.gh().listComments(issue.repo, issue.number);
      const { replies, ignored } = repliesAfterMaster(comments, master);
      // Someone may have replied on the dashboard meanwhile; the next questions come first then.
      const now = this.deps.store.getRun(run.id);
      const still =
        now.blocked?.kind === 'discussion' && now.discussion.length === run.discussion.length;
      if (now.status !== 'blocked' || !still) continue;
      this.recordIgnored(now, issue, ignored);
      if (replies.length === 0) continue;
      const replied = this.deps.engine.reply(run.id, replies, 'issue');
      // The replies came from the issue: nothing to post for them.
      this.deps.store.setIssueDiscussionSynced(run.id, replied.discussion.length);
    }
  }

  /**
   * Count, on the questions the Run waits on, the comments after them that were not taken as
   * replies because the Master does not trust their authors, so the dashboard can show them.
   */
  private recordIgnored(run: Run, issue: RunIssue, ignored: number): void {
    const last = run.discussion.at(-1);
    if (last?.role !== 'assessor' || (last.ignoredComments ?? 0) === ignored) return;
    // Stored as JSON, where an undefined count is left out.
    const entry: DiscussionEntry = { ...last, ignoredComments: ignored > 0 ? ignored : undefined };
    const store = this.deps.store;
    store.tx(() => {
      store.updateRun(run.id, { discussion: [...run.discussion.slice(0, -1), entry] });
      store.event(run.id, 'discussion.comments_ignored', {
        repo: issue.repo,
        issue: issue.number,
        count: ignored,
      });
    });
  }

  // ---- guardrails --------------------------------------------------------

  /**
   * Spend of today on what this repo did without a human: scouts, auto-accepted Runs and
   * automatic redos of failed Runs.
   */
  spentToday(repoId: string): number {
    const since = startOfToday();
    const scouts = this.deps.store
      .listScouts({ repoId, since, limit: 1000 })
      .reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
    const runs = this.deps.store
      .issueRunsSince(since)
      .filter((r) => r.repoId === repoId && (r.issue?.auto || (r.issue?.attempt ?? 1) > 1))
      .reduce((sum, r) => sum + r.costUsd, 0);
    return scouts + runs;
  }

  autoAcceptedToday(repoName: string): number {
    return this.deps.store
      .listEventsOfType('issue.auto_accepted', startOfToday())
      .filter((e) => e.data.repo === repoName).length;
  }

  /** Today's spend reached the configured limit (none = never). */
  private overBudget(repo: Repo, cfg: GitHubRepoConfig): boolean {
    return cfg.daily_budget_usd !== undefined && this.spentToday(repo.id) >= cfg.daily_budget_usd;
  }

  /** Within today's auto-accept count and spend. */
  private mayAutoAccept(repo: Repo, cfg: GitHubRepoConfig): boolean {
    const max = cfg.auto_accept.max_per_day;
    if (max !== undefined && this.autoAcceptedToday(repo.name) >= max) return false;
    return !this.overBudget(repo, cfg);
  }

  /**
   * Scout by itself when there is nothing to do: the repo has no Run that goes on by itself and
   * no issue waiting to be redone (see splitUnfinishedRuns), the proposals that hold it back (see proposalsHoldingScout) and
   * the Runs stuck waiting for a human are fewer than max_proposals together, the day's budget is
   * not spent, the configured interval since the last scout has passed, it is not backing off
   * after scouts that found nothing or failed (see scoutBackoff: the wait doubles with each such
   * scout in a row, and ends once a scout files an issue or the target branch gets a new commit),
   * and it is not waiting for the quota of an agent that ran out of it (see scoutLimitWait).
   * Records why it waits, for the dashboard.
   */
  private async maybeAutoScout(name: string): Promise<void> {
    const { repo, cfg } = this.repoSetup(name);
    const waiting = await this.autoScoutWaiting(repo, cfg);
    this.scoutWaiting.set(name, waiting);
    if (waiting === null) await this.startScout(name, 'auto');
  }

  private async autoScoutWaiting(repo: Repo, cfg: GitHubRepoConfig): Promise<ScoutWait | null> {
    const scout = cfg.scout;
    if (!scout?.auto) {
      return {
        reason: t({ zh: '只在看板上手动触发', en: 'Only started from the dashboard' }),
      };
    }
    if (this.scouting.has(repo.id)) return { reason: t({ zh: '正在侦察', en: 'Scouting' }) };
    const store = this.deps.store;
    const runs = splitUnfinishedRuns(
      store.listRuns({ repoId: repo.id }),
      (id) => store.getStageRun(id).stageId,
    );
    const busy = busyText(runs.moving.length, runs.redo.length);
    if (busy) return { reason: busy };
    if (this.deps.engine.held) {
      return { reason: t({ zh: '等 Master 升级', en: 'Waiting for the Master to upgrade' }) };
    }
    if (this.overBudget(repo, cfg)) {
      return {
        reason: t({
          zh: '今天的自动花费已达上限',
          en: "Today's automatic spending reached its limit",
        }),
      };
    }
    // The set interval, the back-off and the wait for the agent's quota all hold it; it waits for
    // the latest of them.
    const scouts = store.listScouts({ repoId: repo.id, limit: 200 });
    let wait: ScoutWait | null = null;
    // A scout whose agent hit a limit did nothing, so it takes up no interval.
    const last = scouts.find((s) => s.status !== 'rate_limited');
    if (last && scout.interval_minutes > 0) {
      const next = Date.parse(last.startedAt) + scout.interval_minutes * 60_000;
      if (next > Date.now()) {
        wait = {
          reason: t({
            zh: '离上次侦察不到设定的间隔',
            en: 'Less than the set interval since the last scout',
          }),
          until: new Date(next).toISOString(),
        };
      }
    }
    wait = laterWait(wait, await this.scoutBackoffWait(repo, scouts));
    wait = laterWait(wait, this.scoutQuotaWait(repo, scouts));
    if (wait) return wait;
    // Do not pile up work nobody has looked at: proposals and Runs stuck waiting for a human.
    const full = await this.issuesRepo(repo, cfg);
    const open = await this.gh().listIssues(full, {
      state: 'open',
      label: LABELS.proposal,
      limit: 100,
    });
    const pending = proposalsHoldingScout(open, scouts, cfg.auto_accept.max_risk).length;
    const stuck = runs.stuck.length;
    if (pending + stuck >= scout.max_proposals) {
      return { reason: waitingForYouText(pending, stuck) };
    }
    return null;
  }

  /**
   * The wait for the quota after the scout's agent ran out of it or was rate-limited, if it holds
   * the scout now (see scoutLimitWait). `scouts`: the repo's, newest first.
   */
  private scoutQuotaWait(repo: Repo, scouts: Scout[]): (ScoutWait & { until: string }) | null {
    const limit = scoutLimitWait(scouts, this.scoutLimitResets.get(repo.id));
    if (!limit || Date.parse(limit.until) <= Date.now()) return null;
    return {
      reason: t({
        zh: '侦察遇到额度用尽或限流，等额度恢复',
        en: 'The scout ran out of quota or was rate-limited; waiting for the quota to come back',
      }),
      until: limit.until,
    };
  }

  /**
   * The back-off after scouts that found nothing or failed, if it holds the scout now.
   * `scouts`: the repo's, newest first.
   */
  private async scoutBackoffWait(
    repo: Repo,
    scouts: Scout[],
  ): Promise<(ScoutWait & { until: string }) | null> {
    const pollMinutes = this.pollMinutes;
    let backoff = scoutBackoff(scouts, pollMinutes);
    if (!backoff || Date.parse(backoff.until) <= Date.now()) return null;
    // Scouts that ran before the target branch's latest commit do not count: they did not see it.
    // When git cannot tell, the back-off stays as counted.
    const changedAt = await commitTime(repo.path, repo.targetBranch).catch(() => undefined);
    if (changedAt !== undefined) backoff = scoutBackoff(scouts, pollMinutes, changedAt);
    if (!backoff || Date.parse(backoff.until) <= Date.now()) return null;
    const k = backoff.count;
    return {
      reason: t({
        zh: `最近 ${k} 次侦察没有找到需求或失败，退避中`,
        en:
          k === 1
            ? 'The last scout found nothing or failed; backing off'
            : `The last ${k} scouts found nothing or failed; backing off`,
      }),
      until: backoff.until,
    };
  }

  // ---- scouting ------------------------------------------------------------

  /** Some repo is being scouted (an upgrade waits for it). */
  get scoutRunning(): boolean {
    return this.scouting.size > 0;
  }

  /** Start a scout; it runs in the background. */
  async startScout(name: string, trigger: Scout['trigger']): Promise<Scout> {
    const { repo, cfg } = this.repoSetup(name);
    const scoutCfg = cfg.scout;
    if (!scoutCfg) {
      throw new InvalidStateError(
        t({
          zh: `仓库 ${name} 没有配置侦察（github.repos.${name}.scout）`,
          en: `Repo ${name} has no scout configured (github.repos.${name}.scout)`,
        }),
      );
    }
    if (this.scouting.has(repo.id)) {
      throw new InvalidStateError(
        t({ zh: `仓库 ${name} 正在侦察`, en: `Repo ${name} is being scouted already` }),
      );
    }
    const agent = this.cfg.agents.get(scoutCfg.agent);
    if (!agent) {
      throw new InvalidStateError(
        t({
          zh: `侦察用的 Agent ${scoutCfg.agent} 不存在或未启用`,
          en: `The scout's agent ${scoutCfg.agent} does not exist or is disabled`,
        }),
      );
    }
    const adapter = this.deps.adapters.get(agent.cli);
    if (!adapter?.supportsReadOnly) {
      throw new InvalidStateError(
        t({
          zh: `侦察要以只读方式运行，${agent.cli} 不支持，请换用 claude-code 的 Agent`,
          en: `The scout runs read-only, which ${agent.cli} does not support; use a claude-code agent`,
        }),
      );
    }
    this.scouting.set(repo.id, { scoutId: '' });
    try {
      const full = await this.issuesRepo(repo, cfg);
      await this.ensureLabels(full);
      const scout = this.deps.store.tx(() => {
        const s = this.deps.store.createScout({
          repoId: repo.id,
          issuesRepo: full,
          trigger,
          agentId: agent.id,
          model: agent.model,
          logPath: '',
        });
        const logPath = join(this.deps.paths.logsDir, 'scouts', `${s.id}.jsonl`);
        this.deps.store.event(null, 'scout.started', { scoutId: s.id, repo: name, trigger });
        return this.deps.store.updateScout(s.id, { logPath });
      });
      const entry: ScoutEntry = { scoutId: scout.id };
      this.scouting.set(repo.id, entry);
      entry.done = this.runScout(scout, repo, cfg, adapter, entry).finally(() => {
        this.scouting.delete(repo.id);
      });
      return scout;
    } catch (err) {
      this.scouting.delete(repo.id);
      throw err;
    }
  }

  /**
   * The Master's last failed upgrade if `repo` is the Master's own source, so that its scout
   * proposes fixing what the stable copy cannot build or start; null for every other repo.
   */
  private upgradeFailureFor(repo: Repo, github: string): UpgradeFailure | null {
    const failure = lastUpgradeFailure(this.deps.store);
    if (!failure) return null;
    const origin = this.deps.masterOrigin ?? null;
    return isMasterSource(origin, { path: repo.path, github }) ? failure : null;
  }

  private async runScout(
    scout: Scout,
    repo: Repo,
    cfg: GitHubRepoConfig,
    adapter: AgentAdapter,
    entry: ScoutEntry,
  ): Promise<void> {
    const store = this.deps.store;
    const scoutCfg = cfg.scout;
    const agent = scoutCfg ? this.cfg.agents.get(scoutCfg.agent) : undefined;
    let cost: number | null = null;
    let workdir: string | undefined;
    try {
      if (!scoutCfg || !agent) {
        throw new Error(
          t({
            zh: '侦察配置在启动后被移除了',
            en: 'The scout configuration was removed after the scout started',
          }),
        );
      }
      const gh = this.gh();
      const [open, closed, notPlanned] = await Promise.all([
        gh.listIssues(scout.issuesRepo, { state: 'open', limit: 100 }),
        gh.listIssues(scout.issuesRepo, {
          state: 'closed',
          limit: SCOUT_RECENT_CLOSED,
          comments: true,
        }),
        // Rejections stay counterexamples however long ago they were made.
        gh.listNotPlannedIssues(scout.issuesRepo, { limit: SCOUT_NOT_PLANNED }),
      ]);
      const prompt = scoutPrompt({
        repoName: repo.name,
        max: scoutCfg.max_proposals,
        runs: runDigest(store, repo.id),
        issues: issueDigest(open, closed, await this.masterLogin(), notPlanned),
        upgrade: this.upgradeFailureFor(repo, scout.issuesRepo),
      });
      // Read the target branch as committed, like a Run does, not whatever the main worktree has
      // checked out or left uncommitted. A detached worktree creates no branch.
      workdir = this.scoutDir(scout.id);
      try {
        const base = await revParse(repo.path, repo.targetBranch);
        await addDetachedWorktree(repo.path, workdir, base);
      } catch (err) {
        throw new Error(
          t({
            zh: `在目标分支 ${repo.targetBranch} 上建侦察的临时工作目录失败：${errorMessage(err)}`,
            en: `Creating the scout's temporary workspace on the target branch ${repo.targetBranch} failed: ${errorMessage(err)}`,
          }),
        );
      }
      if (this.stopping) throw new Interrupted();
      const exec = adapter.start({
        workdir,
        prompt,
        model: agent.model,
        effort: agent.effort,
        permission: 'safe',
        readOnly: true,
        outputSchema: scoutReportJsonSchema(),
        timeoutMs: (agent.timeout_minutes ?? this.cfg.master.defaults.timeout_minutes) * 60_000,
        extraArgs: agent.args,
        // Read-only, but it still must not get to what untrusted people wrote on GitHub.
        env: prepareAgentEnv(this.deps.paths.agentGhConfigDir),
        logPath: scout.logPath,
      });
      entry.exec = exec;
      const result = await exec.result;
      cost = result.costUsd ?? estimateCost(agent, result.usage) ?? null;
      store.updateScout(scout.id, { costUsd: cost });
      if (this.stopping) throw new Interrupted();
      if (result.status !== 'completed' && result.errorKind === 'rate_limited') {
        this.scoutRateLimited(scout, repo, result, cost);
        return;
      }
      if (result.status !== 'completed') {
        throw new Error(
          result.error ??
            t({
              zh: `侦察没有正常结束（${result.status}）`,
              en: `The scout did not end normally (${result.status})`,
            }),
        );
      }
      const proposals = parseScoutReport(result.structured, result.finalMessage).slice(
        0,
        scoutCfg.max_proposals,
      );
      const created = await this.fileProposals(scout, repo, cfg, proposals);
      this.scoutLimitResets.delete(repo.id);
      store.tx(() => {
        store.updateScout(scout.id, { status: 'completed', proposals, endedAt: nowIso() });
        store.event(null, 'scout.completed', {
          scoutId: scout.id,
          repo: repo.name,
          created: created.filter((p) => p.issue).length,
          auto: created.filter((p) => p.issue?.auto).length,
          /** Issues that wait for a human. */
          pending: created.filter((p) => p.issue && !p.issue.auto).length,
        });
      });
      if (created.some((p) => p.issue?.auto)) void this.poll();
    } catch (err) {
      const interrupted = err instanceof Interrupted || this.stopping;
      if (!interrupted) this.scoutLimitResets.delete(repo.id);
      store.tx(() => {
        store.updateScout(scout.id, {
          status: interrupted ? 'interrupted' : 'failed',
          error: interrupted ? stoppedWhileScouting() : errorMessage(err),
          costUsd: cost,
          endedAt: nowIso(),
        });
        store.event(null, 'scout.failed', {
          scoutId: scout.id,
          repo: repo.name,
          message: errorMessage(err),
          // The failures in a row so far, this one included, so that a scout that keeps failing
          // is notified (see noticeFor). A scout the Master cut short did not fail: no streak,
          // or it would repeat the count of the failures before it.
          ...(interrupted
            ? {}
            : {
                streak: scoutFailureStreak(store.listScouts({ repoId: repo.id, limit: 200 })),
              }),
        });
      });
    } finally {
      if (workdir) await dropWorktree(repo.path, workdir);
    }
  }

  /**
   * The scout's agent ran out of quota or was rate-limited. That passes on its own and says
   * nothing about the repo, so the scout has not failed and does not count toward the back-off;
   * the automatic scout waits for the quota instead (see scoutLimitWait). The CLI's reset time is
   * kept in memory only.
   */
  private scoutRateLimited(
    scout: Scout,
    repo: Repo,
    result: AgentResult,
    cost: number | null,
  ): void {
    const parsed = result.retryAt ? Date.parse(result.retryAt) : Number.NaN;
    const resetAt = Number.isNaN(parsed) ? undefined : parsed;
    if (resetAt === undefined) this.scoutLimitResets.delete(repo.id);
    else this.scoutLimitResets.set(repo.id, resetAt);
    const store = this.deps.store;
    store.tx(() => {
      store.updateScout(scout.id, {
        status: 'rate_limited',
        error: scoutLimitedText(resetAt, result.error),
        costUsd: cost,
        endedAt: nowIso(),
      });
      store.event(null, 'scout.rate_limited', {
        scoutId: scout.id,
        repo: repo.name,
        // When the quota is expected back, if the CLI said.
        ...(resetAt === undefined ? {} : { retryAt: new Date(resetAt).toISOString() }),
      });
    });
  }

  /** Create an issue per proposal; low-risk ones are auto-accepted within today's limits. */
  private async fileProposals(
    scout: Scout,
    repo: Repo,
    cfg: GitHubRepoConfig,
    proposals: ScoutProposal[],
  ): Promise<ScoutProposal[]> {
    for (const p of proposals) {
      const auto = isAutoAcceptable(p, cfg.auto_accept.max_risk) && this.mayAutoAccept(repo, cfg);
      const labels: string[] = [LABELS.proposal];
      if (auto) labels.push(LABELS.ready, LABELS.auto);
      try {
        // The scout wrote them in a worktree under the user's home directory.
        const issue = await this.gh().createIssue(scout.issuesRepo, {
          title: redactForGitHub(p.title),
          body: redactForGitHub(proposalBody(p, scout.id, auto)),
          labels,
        });
        p.issue = { ...issue, auto };
        if (auto) {
          this.deps.store.event(null, 'issue.auto_accepted', {
            repo: repo.name,
            issue: issue.number,
          });
        }
      } catch (err) {
        p.error = errorMessage(err);
        this.report(err);
      }
      // Keep what was created so far even if the Master stops halfway.
      this.deps.store.updateScout(scout.id, { proposals });
    }
    return proposals;
  }

  // ---- status ----------------------------------------------------------------------

  status(): GitHubStatus {
    const github = this.cfg.master.github;
    const repos: GitHubRepoStatus[] = Object.entries(github?.repos ?? {}).map(([name, cfg]) => {
      const repo = this.deps.store.findRepo(name);
      const problems = [...(this.cfg.errors[githubConfigKey(name)] ?? [])];
      if (!repo) problems.push(notRegistered(name));
      const last = repo ? this.deps.store.listScouts({ repoId: repo.id, limit: 1 })[0] : undefined;
      const spent = repo ? this.spentToday(repo.id) : 0;
      const running = repo ? this.scouting.has(repo.id) : false;
      return {
        name,
        issuesRepo: cfg.issues_repo ?? (repo ? (this.resolved.get(repo.path) ?? null) : null),
        template: cfg.template,
        problems,
        scout: cfg.scout
          ? {
              agent: cfg.scout.agent,
              auto: cfg.scout.auto,
              intervalMinutes: cfg.scout.interval_minutes,
              maxProposals: cfg.scout.max_proposals,
              running,
              lastAt: last?.startedAt ?? null,
              waiting: running ? null : (this.scoutWaiting.get(name) ?? null),
            }
          : null,
        autoAccept: {
          maxRisk: cfg.auto_accept.max_risk,
          maxPerDay: cfg.auto_accept.max_per_day ?? null,
          usedToday: this.autoAcceptedToday(name),
        },
        autoMerge: cfg.auto_merge,
        budget: {
          dailyUsd: cfg.daily_budget_usd ?? null,
          spentToday: spent,
          reached: cfg.daily_budget_usd !== undefined && spent >= cfg.daily_budget_usd,
        },
        push: cfg.push,
        maxRunAttempts: cfg.max_run_attempts,
      };
    });
    return {
      enabled: github !== undefined,
      account: github?.account ?? null,
      pollMinutes: github?.poll_minutes ?? 5,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      repos,
    };
  }
}

class Interrupted extends Error {}
