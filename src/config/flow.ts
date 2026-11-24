// How a workflow template flows: effective stage settings, verify commands and rollback targets;
// also the overrides of Runs from issues, which proposals are accepted automatically, how long
// the automatic scout backs off and which Runs it waits for, how long a failed Run of an issue
// waits before it is redone, how long a Run or a scout waits for an agent that is out of
// quota or rate-limited, how long the raw output of agents is kept, and which worktrees of
// failed or cancelled Runs of issues are left over for the Master to remove.
// Pure logic (type imports, src/i18n.ts, src/store/types.ts and src/engine/discussion.ts only),
// so the dashboard shows the same rules the engine applies.

import { replyDeadline } from '../engine/discussion.js';
import { t } from '../i18n.js';
import {
  type Attempt,
  type EventRow,
  FINISHED_RUN_STATUSES,
  type Run,
  type Scout,
} from '../store/types.js';
import type { Escalate, RunOverrides, StageDef, WorkflowTemplate } from './schema.js';

/** Risk of a proposal, ordered; auto-accept takes everything up to a chosen level. */
export const RISKS = ['low', 'mid', 'high'] as const;
export type Risk = (typeof RISKS)[number];

/** Size of a proposal: S within an hour, M within half a day, L larger. */
export const PROPOSAL_SIZES = ['S', 'M', 'L'] as const;
export type ProposalSize = (typeof PROPOSAL_SIZES)[number];

/** What auto-accept looks at in a proposal. */
export interface ProposalKind {
  risk: Risk;
  size: ProposalSize;
}

/** Whether a kind of proposal is accepted without a human under `auto_accept.max_risk`. */
export type AutoAcceptRule = (p: ProposalKind, maxRisk: Risk | 'none') => boolean;

/** Auto-accept up to the configured risk, and only what fits one Run. */
export const isAutoAcceptable: AutoAcceptRule = (p, maxRisk) => {
  if (maxRisk === 'none' || p.size === 'L') return false;
  return RISKS.indexOf(p.risk) <= RISKS.indexOf(maxRisk);
};

/**
 * Every kind of proposal (risk × size), split into those the Master accepts by itself under
 * `maxRisk` and those left to a human. `rule` is the auto-accept rule; tests may pass another.
 */
export function acceptSplit(
  maxRisk: Risk | 'none',
  rule: AutoAcceptRule = isAutoAcceptable,
): { auto: ProposalKind[]; human: ProposalKind[] } {
  const auto: ProposalKind[] = [];
  const human: ProposalKind[] = [];
  for (const risk of RISKS) {
    for (const size of PROPOSAL_SIZES) {
      (rule({ risk, size }, maxRisk) ? auto : human).push({ risk, size });
    }
  }
  return { auto, human };
}

export const SYSTEM_DEFAULTS = {
  escalate: {
    max_retries: 2,
    // Nobody has to be there: retry, then another agent, then the Run ends as failed.
    on_agent_error: 'switch_agent',
    // Over budget: the Run ends as failed rather than waiting for a human to raise the budget, so
    // nothing stops while nobody is around. A Run from an issue is redone, within max_run_attempts
    // and daily_budget_usd, so spending stays bounded.
    on_budget_exceeded: 'abort',
    // Out of reworks or rollbacks: the Run ends as failed, so an issue is redone with the reason
    // and nothing waits for a human.
    on_exhausted: 'fail',
  } satisfies Required<Escalate>,
  max_loops: 3,
  /** How long an assess stage waits for a reply to its questions when it does not say. */
  reply_timeout_hours: 24,
};

export interface EffectiveStage {
  def: StageDef;
  gate: boolean;
  escalate: Required<Escalate>;
}

/** Resolve a stage's effective settings: system default → template → stage → run override. */
export function effectiveStage(
  template: WorkflowTemplate,
  stageId: string,
  overrides: RunOverrides,
): EffectiveStage {
  const def = template.stages.find((s) => s.id === stageId);
  if (!def) {
    throw new Error(
      t({
        zh: `模板 ${template.id} 中没有阶段 ${stageId}`,
        en: `Template ${template.id} has no stage ${stageId}`,
      }),
    );
  }
  const o = overrides.stages?.[stageId];
  return {
    def,
    gate: o?.gate ?? def.gate,
    escalate: {
      ...SYSTEM_DEFAULTS.escalate,
      ...stripUndefined(template.defaults?.escalate),
      ...stripUndefined(def.escalate),
      ...stripUndefined(o?.escalate),
    },
  };
}

export function effectiveMaxLoops(template: WorkflowTemplate, overrides: RunOverrides): number {
  return overrides.max_loops ?? template.defaults?.max_loops ?? SYSTEM_DEFAULTS.max_loops;
}

/**
 * What happens when a Run rolls back past max_loops: the template's `defaults.escalate.
 * on_exhausted`, else the system default. A rollback belongs to no single stage, so stage
 * settings do not apply, just as max_loops itself is set for the whole Run.
 */
export function loopsExhausted(template: WorkflowTemplate): Required<Escalate>['on_exhausted'] {
  return template.defaults?.escalate?.on_exhausted ?? SYSTEM_DEFAULTS.escalate.on_exhausted;
}

/**
 * How many hours an assess stage waits for a human to reply to its questions before the
 * assessment decides on its own: the stage's `reply_timeout_hours`, else the system default.
 * 0 = it does not wait; null = it waits however long it takes.
 */
export function replyTimeoutHours(def: StageDef): number | null {
  return def.reply_timeout_hours === undefined
    ? SYSTEM_DEFAULTS.reply_timeout_hours
    : def.reply_timeout_hours;
}

/**
 * When a Run blocked on the assessment's questions stops waiting for a reply and the assessment
 * decides on its own: the latest round's questions plus the assess stage's `replyTimeoutHours`
 * (`replyDeadline`, epoch milliseconds). null when the Run does not wait for a reply, its stage
 * waits however long it takes, or the discussion no longer ends with the questions: then only a
 * human moves it on. `stageIdOf` gives the stage of one of the Run's stage runs.
 */
export function discussionReplyWait(
  run: Pick<Run, 'status' | 'blocked' | 'discussion' | 'template'>,
  stageIdOf: (stageRunId: string) => string | undefined,
): { deadline: number; hours: number } | null {
  const info = run.blocked;
  if (run.status !== 'blocked' || info?.kind !== 'discussion' || !info.stageRunId) return null;
  const stageId = stageIdOf(info.stageRunId);
  const def = run.template.stages.find((s) => s.id === stageId);
  const hours = def ? replyTimeoutHours(def) : null;
  const deadline = replyDeadline(run.discussion, hours);
  return hours === null || deadline === null ? null : { deadline, hours };
}

/** A repo's Runs that are not done with, by whether they go on without a human. */
export interface UnfinishedRuns<R> {
  /**
   * They go on by themselves: queued, running, waiting for a reply to the assessment's
   * questions that times out (`discussionReplyWait`), or waiting for uncommitted changes on the
   * target branch to go away (`target_dirty`): nobody has to decide anything for those, they
   * only pause while a human's changes are in the way, and the engine merges them once the
   * changes are committed or discarded.
   */
  moving: R[];
  /**
   * Failed Runs whose issue waits to be redone (`awaitingRedo`): they go on by themselves too,
   * as a new Run once the wait before the redo (`redoDueAt`) is over. Never stuck.
   */
  redo: R[];
  /**
   * Only a human moves them on: every other blocked Run, paused Runs, Runs waiting for approval.
   */
  stuck: R[];
}

/**
 * Split a repo's Runs that are not done with by whether they go on without a human. The
 * automatic scout waits for the moving ones and for the redos to come, as their results change
 * what is worth doing next. The stuck ones would hold it for good when nobody is there, so they
 * count toward `max_proposals` together with the proposals waiting for a human instead: work left
 * for a human is still capped, but no longer stops the repo. Other finished Runs are left out.
 */
export function splitUnfinishedRuns<
  R extends Pick<Run, 'status' | 'blocked' | 'discussion' | 'template' | 'issue'>,
>(runs: readonly R[], stageIdOf: (stageRunId: string) => string | undefined): UnfinishedRuns<R> {
  const split: UnfinishedRuns<R> = { moving: [], redo: [], stuck: [] };
  for (const run of runs) {
    if (awaitingRedo(run)) {
      split.redo.push(run);
      continue;
    }
    if (FINISHED_RUN_STATUSES.includes(run.status)) continue;
    const moving =
      run.status === 'queued' ||
      run.status === 'running' ||
      (run.status === 'blocked' && run.blocked?.kind === 'target_dirty') ||
      discussionReplyWait(run, stageIdOf) !== null;
    (moving ? split.moving : split.stuck).push(run);
  }
  return split;
}

/** The Run's budget in USD: run override → template default; undefined = no budget. */
export function effectiveBudget(
  template: WorkflowTemplate,
  overrides: RunOverrides,
): number | undefined {
  return overrides.budget_usd ?? template.defaults?.budget_usd;
}

/**
 * Whether a Run over its budget waits for a human to raise it (`on_budget_exceeded: pause`) in
 * some stage, rather than ending as failed. Only stages that run an agent count: the budget is
 * checked before an agent runs.
 */
export function budgetPauses(template: WorkflowTemplate, overrides: RunOverrides): boolean {
  return template.stages.some(
    (s) =>
      runsAgent(s.kind) &&
      effectiveStage(template, s.id, overrides).escalate.on_budget_exceeded === 'pause',
  );
}

/**
 * Stage kinds an agent runs in. In merge, placeholder and command stages the Master does the work
 * itself, so nothing there errors, is reworked or checks the budget.
 */
export function runsAgent(kind: StageDef['kind']): boolean {
  return kind === 'agent' || kind === 'review' || kind === 'assess';
}

/**
 * Overrides of a Run created from a GitHub issue: with `auto_merge` the approvals
 * of the merge stages are off; other approval points of the template stay. The dashboard's guide
 * shows the same rule.
 */
export function issueRunOverrides(
  template: WorkflowTemplate | undefined,
  autoMerge: boolean,
): RunOverrides | undefined {
  const merges = (template?.stages ?? []).filter((st) => st.kind === 'merge');
  if (!autoMerge || merges.length === 0) return undefined;
  return { stages: Object.fromEntries(merges.map((st) => [st.id, { gate: false }])) };
}

/** An exponential backoff: the first wait, doubled on each further retry up to the longest. */
export interface Backoff {
  firstMs: number;
  maxMs: number;
}

/** The wait before the `retry`-th retry (1 = the first). */
export function backoffMs(backoff: Backoff, retry: number): number {
  return Math.min(backoff.firstMs * 2 ** Math.max(0, retry - 1), backoff.maxMs);
}

/** The longest a failed Run of an issue waits before it is redone. */
export const REDO_BACKOFF_MAX_HOURS = 2;

/**
 * How long the issue waits after its `attempt`-th Run (1 = the first) failed before the next
 * attempt starts: poll_minutes × 2^(attempt-1), at most REDO_BACKOFF_MAX_HOURS. A passing outage
 * of the agents' API or of the network fails every agent at once, retries and switching agents
 * included; without a wait the attempts would be used up within minutes and the issue closed.
 * A failure the code itself brings about every time only ends a little later: the attempts and
 * their cost stay the same.
 */
export function redoDelayMs(attempt: number, pollMinutes: number): number {
  return backoffMs(
    { firstMs: pollMinutes * 60_000, maxMs: REDO_BACKOFF_MAX_HOURS * 3_600_000 },
    attempt,
  );
}

/**
 * Whether the Run failed and its issue waits for it to be redone (the issue has attempts left,
 * nobody closed it or started it over yet). Such a Run goes on by itself: the bridge redoes it
 * once `redoDueAt` has passed, the day's budget allows and the work switch is on.
 */
export function awaitingRedo(run: Pick<Run, 'status' | 'issue'>): boolean {
  return run.status === 'failed' && run.issue?.redo === 'pending';
}

/**
 * When the failed Run's issue is redone, epoch ms: `redoDelayMs` for its attempt after it ended.
 * Over the day's budget or with the work switch off it waits longer. Counted from the Run alone,
 * so it holds across Master restarts. null when it does not wait for a redo (`awaitingRedo`).
 */
export function redoDueAt(
  run: Pick<Run, 'status' | 'issue' | 'finishedAt' | 'updatedAt'>,
  pollMinutes: number,
): number | null {
  if (!awaitingRedo(run)) return null;
  const ended = Date.parse(run.finishedAt ?? run.updatedAt);
  return ended + redoDelayMs(run.issue?.attempt ?? 1, pollMinutes);
}

/**
 * How long a Run or a scout waits when its agent is out of quota or rate-limited: until the reset
 * time the CLI gave plus `marginMs` (clocks differ, and a quota may come back a little late);
 * without one, a backoff over the limits hit in a row.
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
 * The wait after an agent hit a limit at `now`: until `resetAt` (epoch ms, from the CLI) plus the
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

/** A queued Run waiting for its agent's quota: the agent, and when the Run goes on (epoch ms). */
export interface RunLimitWait {
  agentId: string;
  until: number;
}

/**
 * The wait for its agent's quota a queued Run is in, as its events record it: read back when the
 * Master starts, so that a restart does not try the agent again before the quota is back. The
 * Run's latest `task.rate_limited` holds while
 * - the Run is still queued, and the only `run.status` after that event is the `queued` written
 *   with it: whatever lifts the wait (a pause and resume, a cancel, a retry, the Run starting
 *   again, its recovery after a restart while it ran) changes the Run's status;
 * - the latest attempt of the event's task still hit the limit;
 * - its `retryAt` (the CLI's reset time plus the margin, or the backoff) is still ahead of `now`.
 * `events`: the Run's, oldest first; `attempts`: the Run's, oldest first. null: no wait.
 */
export function recordedLimitWait(
  run: Pick<Run, 'status'>,
  events: readonly Pick<EventRow, 'type' | 'data'>[],
  attempts: readonly Pick<Attempt, 'taskId' | 'outcome'>[],
  now: number,
): RunLimitWait | null {
  if (run.status !== 'queued') return null;
  const at = events.findLastIndex((e) => e.type === 'task.rate_limited');
  const limited = events[at];
  if (!limited) return null;
  const statuses = events.slice(at + 1).filter((e) => e.type === 'run.status');
  if (statuses.length !== 1 || statuses[0]?.data.status !== 'queued') return null;
  const { taskId, agentId, retryAt } = limited.data;
  if (typeof taskId !== 'string' || typeof agentId !== 'string' || typeof retryAt !== 'string') {
    return null;
  }
  if (attempts.findLast((a) => a.taskId === taskId)?.outcome !== 'rate_limited') return null;
  const until = Date.parse(retryAt);
  if (Number.isNaN(until) || until <= now) return null;
  return { agentId, until };
}

export interface ScoutLimitWait {
  /** Scouts in a row, counting back from the newest, whose agent hit a limit. */
  count: number;
  /** When the next automatic scout may start. */
  until: string;
}

/**
 * The scout the automatic scout's wait for the quota counts from (see scoutLimitWait): the newest
 * scout that was not cut short by the Master stopping (nor is still running), when its agent hit
 * a limit. `scouts` are newest first. undefined: no wait.
 */
export function limitedScout<S extends Pick<Scout, 'status'>>(scouts: readonly S[]): S | undefined {
  for (const s of scouts) {
    if (s.status === 'interrupted' || s.status === 'running') continue;
    return s.status === 'rate_limited' ? s : undefined;
  }
  return undefined;
}

/**
 * How long the automatic scout waits after its agent ran out of quota or was rate-limited: the
 * same rule as a Run's (`rateLimitDelayMs`), counted from when the newest such scout
 * (`limitedScout`) ended. Until `resetAt` (epoch ms, the reset time the CLI gave for that scout,
 * which its `scout.rate_limited` event records) plus the margin; without one, 5, 10, 20, 40
 * minutes, then hourly over the scouts in a row that hit a limit. Only while the newest scout
 * that was not cut short by the Master stopping (nor is still running) hit a limit; a scout that
 * ends any other way ends the wait. `scouts` are newest first. null: no wait.
 */
export function scoutLimitWait(
  scouts: Pick<Scout, 'status' | 'startedAt' | 'endedAt'>[],
  resetAt?: number,
  wait: RateLimitWait = RATE_LIMIT_WAIT,
): ScoutLimitWait | null {
  const newest = limitedScout(scouts);
  if (!newest) return null;
  let count = 0;
  for (const s of scouts) {
    if (s.status === 'interrupted' || s.status === 'running') continue;
    if (s.status !== 'rate_limited') break;
    count++;
  }
  const from = Date.parse(newest.endedAt ?? newest.startedAt);
  const until = from + rateLimitDelayMs(wait, from, resetAt, count);
  return { count, until: new Date(until).toISOString() };
}

/** The longest the automatic scout backs off after scouts that found nothing or failed. */
export const MAX_SCOUT_BACKOFF_HOURS = 6;

export interface ScoutBackoff {
  /** Scouts in a row, counting back from the newest, that found nothing or failed. */
  count: number;
  /** When the next automatic scout may start. */
  until: string;
}

/**
 * How long the automatic scout backs off: scouting an unchanged repo again most likely finds
 * nothing again, at the price of a full read of the repo every poll. Counting back from the newest
 * scout (started by hand or not), k is the number of scouts in a row that failed or filed no
 * issue (proposals that were all duplicates or could not be filed find nothing). The next one may
 * start poll_minutes × 2^(k-1) after the newest of them ended, at most MAX_SCOUT_BACKOFF_HOURS.
 * - A scout that filed an issue ends the streak.
 * - So does a scout started before `changedAt` (the target branch's latest commit): it did not
 *   see the repo as it is now.
 * - A scout cut short by the Master stopping, or still running, neither counts nor ends it.
 * - Nor does a scout whose agent ran out of quota or was rate-limited: it says nothing about the
 *   repo, and waits for the quota apart (see scoutLimitWait).
 * `scouts` are newest first. null: no streak, no back-off.
 */
export function scoutBackoff(
  scouts: Pick<Scout, 'status' | 'proposals' | 'startedAt' | 'endedAt'>[],
  pollMinutes: number,
  changedAt = Number.NEGATIVE_INFINITY,
): ScoutBackoff | null {
  let count = 0;
  let newest: (typeof scouts)[number] | undefined;
  for (const s of scouts) {
    if (s.status === 'interrupted' || s.status === 'running' || s.status === 'rate_limited') {
      continue;
    }
    if (Date.parse(s.startedAt) < changedAt) break;
    if (s.status === 'completed' && s.proposals.some((p) => p.issue)) break;
    count++;
    newest ??= s;
  }
  if (!newest) return null;
  // 2^(k-1) stops mattering long before it could overflow: the wait is capped.
  const delay = Math.min(
    pollMinutes * 60_000 * 2 ** Math.min(count - 1, 30),
    MAX_SCOUT_BACKOFF_HOURS * 3_600_000,
  );
  const from = Date.parse(newest.endedAt ?? newest.startedAt);
  return { count, until: new Date(from + delay).toISOString() };
}

/**
 * Scouts failed in a row at which a human is notified: once per streak, when it reaches this many.
 * A single failure only backs off (see scoutBackoff); a scout that keeps failing (its agent's
 * config broken, its output not matching the format) would otherwise dry up the repo's new
 * requirements without anybody knowing.
 */
export const SCOUT_FAILURE_NOTIFY_AFTER = 3;

/**
 * How many scouts in a row failed, counting back from the newest (started by hand or not). A
 * completed scout ends the streak, whether it filed an issue or not: finding nothing is not
 * failing. Scouts cut short by the Master stopping, still running, or whose agent ran out of quota
 * or was rate-limited neither count nor end it, as in scoutBackoff. `scouts` are newest first.
 */
export function scoutFailureStreak(scouts: Pick<Scout, 'status'>[]): number {
  let count = 0;
  for (const s of scouts) {
    if (s.status === 'interrupted' || s.status === 'running' || s.status === 'rate_limited') {
      continue;
    }
    if (s.status !== 'failed') break;
    count++;
  }
  return count;
}

/**
 * Days the raw output of agents (the CLI's stream: `<attempt>.jsonl` and its `.stderr` for a
 * Run's executions, `scouts/<scout>.jsonl` for a scout) is kept after the Run or scout ended. It
 * holds whole tool results (files read, test output) and grows without end on a Master that never
 * stops, while the dashboard shows agent output from the normalized events kept next to it.
 */
export const RAW_LOG_KEEP_DAYS = 30;

/** Whether something that ended at `endedAt` (ISO time) did so over RAW_LOG_KEEP_DAYS before `now`. */
function endedBeforeRawLogKeep(endedAt: string | null, now: number): boolean {
  if (!endedAt) return false;
  const ended = Date.parse(endedAt);
  return Number.isFinite(ended) && ended < now - RAW_LOG_KEEP_DAYS * 86_400_000;
}

/**
 * Whether the raw logs of a Run's executions are past retention at `now` (epoch ms), so the Master
 * deletes them: the Run finished (completed, failed, cancelled or dropped) over RAW_LOG_KEEP_DAYS
 * ago. Never while it may still go on: queued, running, waiting for approval, blocked, paused, or
 * failed and waiting for its issue to be redone (`awaitingRedo`), however old.
 */
export function runRawLogsExpired(
  run: Pick<Run, 'status' | 'issue' | 'finishedAt'>,
  now: number,
): boolean {
  if (!FINISHED_RUN_STATUSES.includes(run.status) || awaitingRedo(run)) return false;
  return endedBeforeRawLogKeep(run.finishedAt, now);
}

/** Whether a scout's raw log is past retention at `now`: it ended over RAW_LOG_KEEP_DAYS ago. */
export function scoutRawLogExpired(scout: Pick<Scout, 'status' | 'endedAt'>, now: number): boolean {
  return scout.status !== 'running' && endedBeforeRawLogKeep(scout.endedAt, now);
}

/**
 * Why the Master removes the worktree and branch a failed or cancelled Run of an issue kept, as
 * its `workspace.removed` event records it: a later Run of the issue completed (`supersededBy`),
 * the issue used up its attempts and only its last attempt (`keptRun`) keeps them, or a human
 * changed the issue and a new Run (`newRun`) does the changed requirement instead.
 */
export type LeftoverWorkspaceReason =
  | { reason: 'superseded'; supersededBy: string }
  | { reason: 'retries_exhausted'; keptRun: string }
  | { reason: 'goal_changed'; newRun: string };

/** The events `leftoverWorkspaces` reads; other types are passed by. */
export const LEFTOVER_WORKSPACE_EVENTS = [
  'workspace.removed',
  'issue.retries_exhausted',
  'run.goal_changed',
] as const;

/**
 * The worktrees and branches of failed or cancelled Runs of issues that nobody needs any more,
 * oldest Run first. They are removed once, right when it is decided (a redo completed, the issue
 * used up its attempts, the issue was changed), and kept when the Master stopped before that or the
 * removal failed: so the Master looks for them again at start and daily, as nothing else would
 * while nobody is around, and every one keeps its dependencies.
 *
 * `runs` are oldest first (creation order); `events` are those of LEFTOVER_WORKSPACE_EVENTS. A Run
 * is listed when it is not recorded as removed and:
 * - failed, and a later Run of its issue completed: `superseded` by the first of those;
 * - failed, and the newest Run of its issue failed with its attempts used up (its redo is
 *   `exhausted`, or it recorded `issue.retries_exhausted`): `retries_exhausted`, kept by that one;
 * - failed, and named in the `runIds` of another Run's `issue.retries_exhausted`:
 *   `retries_exhausted`, kept by that Run (what removing them right then would have done);
 * - cancelled because a human changed its issue (`run.goal_changed`): `goal_changed`, the new Run
 *   from the event.
 *
 * Never: a Run a human cancelled (they may still want to look), Runs that may go on (any other
 * status), the last failed attempt of an issue, or Runs not from an issue. Whether the worktree
 * or branch is still there is for the caller to find out.
 */
export function leftoverWorkspaces(
  runs: readonly Pick<Run, 'id' | 'status' | 'issue'>[],
  events: readonly Pick<EventRow, 'runId' | 'type' | 'data'>[],
): { runId: string; why: LeftoverWorkspaceReason }[] {
  const removed = new Set<string>();
  /** Earlier attempt → the Run that recorded `issue.retries_exhausted` naming it. */
  const exhaustedBy = new Map<string, string>();
  const exhausted = new Set<string>();
  const goalChanged = new Map<string, string>();
  for (const e of events) {
    if (!e.runId) continue;
    if (e.type === 'workspace.removed') removed.add(e.runId);
    if (e.type === 'issue.retries_exhausted') {
      exhausted.add(e.runId);
      const ids = Array.isArray(e.data.runIds) ? e.data.runIds : [];
      for (const id of ids) {
        if (typeof id === 'string' && id !== e.runId) exhaustedBy.set(id, e.runId);
      }
    }
    if (e.type === 'run.goal_changed' && typeof e.data.newRun === 'string') {
      goalChanged.set(e.runId, e.data.newRun);
    }
  }
  const byIssue = new Map<string, Pick<Run, 'id' | 'status' | 'issue'>[]>();
  for (const run of runs) {
    if (!run.issue) continue;
    const key = `${run.issue.repo}#${run.issue.number}`;
    const list = byIssue.get(key);
    if (list) list.push(run);
    else byIssue.set(key, [run]);
  }
  const leftovers: { runId: string; why: LeftoverWorkspaceReason }[] = [];
  for (const issueRuns of byIssue.values()) {
    const newest = issueRuns[issueRuns.length - 1];
    const kept =
      newest?.status === 'failed' &&
      (newest.issue?.redo === 'exhausted' || exhausted.has(newest.id))
        ? newest.id
        : undefined;
    const found: { runId: string; why: LeftoverWorkspaceReason }[] = [];
    // Newest first, so the first completed Run after each one is known when it is reached.
    let completedAfter: string | undefined;
    for (let i = issueRuns.length - 1; i >= 0; i--) {
      const run = issueRuns[i] as Pick<Run, 'id' | 'status' | 'issue'>;
      if (run.status === 'completed') {
        completedAfter = run.id;
        continue;
      }
      if (removed.has(run.id)) continue;
      let why: LeftoverWorkspaceReason | undefined;
      if (run.status === 'failed') {
        const keptBy = exhaustedBy.get(run.id);
        if (completedAfter) why = { reason: 'superseded', supersededBy: completedAfter };
        else if (kept && kept !== run.id) why = { reason: 'retries_exhausted', keptRun: kept };
        else if (keptBy) why = { reason: 'retries_exhausted', keptRun: keptBy };
      } else if (run.status === 'cancelled') {
        const newRun = goalChanged.get(run.id);
        if (newRun) why = { reason: 'goal_changed', newRun };
      }
      if (why) found.push({ runId: run.id, why });
    }
    leftovers.push(...found.reverse());
  }
  return leftovers;
}

function stripUndefined<T extends object>(obj: T | undefined): Partial<T> {
  if (!obj) return {};
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Stage kinds that change no code, so they run no verify commands. */
export function runsNoCommands(kind: StageDef['kind']): boolean {
  return kind === 'review' || kind === 'placeholder' || kind === 'assess';
}

/**
 * Verify commands a stage runs: its own `verify.commands`, otherwise the repo default.
 * Review, assess and placeholder stages run none (they change no code; the reviewer's verdict is
 * the review's check); merge stages run them only after bringing in new commits from the target
 * branch; command stages run them and nothing else.
 */
export function stageVerifyCommands(def: StageDef, repoDefault: string[]): string[] {
  if (runsNoCommands(def.kind)) return [];
  return def.verify?.commands ?? repoDefault;
}

/**
 * Where a failed / rejected stage rolls back to when the template does not say.
 * agent stage → itself; any other stage (review, merge, command, placeholder, assess) → the
 * nearest earlier agent stage, or itself when there is none.
 */
export function defaultRollbackTarget(template: WorkflowTemplate, stageId: string): string {
  const idx = template.stages.findIndex((s) => s.id === stageId);
  const stage = template.stages[idx];
  if (!stage || stage.kind === 'agent') return stageId;
  for (let i = idx - 1; i >= 0; i--) {
    const s = template.stages[i];
    if (s?.kind === 'agent') return s.id;
  }
  return stageId;
}

/**
 * Where a stage rolls back to: `on_reject` after a rejected approval, `on_fail` after failing
 * its checks or review; the default rule when the template does not say.
 */
export function rollbackTarget(
  template: WorkflowTemplate,
  stageId: string,
  reason: 'fail' | 'reject',
): string {
  const def = template.stages.find((s) => s.id === stageId);
  const explicit = reason === 'reject' ? def?.on_reject : def?.on_fail;
  return explicit ?? defaultRollbackTarget(template, stageId);
}

/**
 * Where a stage goes back to when it does not pass its checks or review; null when it stays.
 *
 * Mirrors the engine (src/engine/engine.ts):
 * - placeholder stage → null: it does nothing and always passes.
 * - assess stage → null: doubts about the requirement are discussed with a human and the stage
 *   assesses again with the replies; it ends with going ahead or dropping the Run, never fails.
 * - agent stage → null: a task that fails its checks is reworked within the stage
 *   (`rework`, up to `max_retries`, then the Run fails or waits for a human by `on_exhausted`);
 *   the stage itself never fails.
 * - review / merge / command stage → the stage is marked failed and `rollback` goes to
 *   `rollbackTarget(…, 'fail')`, i.e. `on_fail` or the nearest earlier agent stage.
 *   (A merge stage fails when its verify commands fail after syncing the target branch, or when
 *   syncing it conflicts and `conflictTarget` has an agent stage to resolve that; a command stage
 *   fails when one of its commands fails.)
 */
export function failTarget(template: WorkflowTemplate, stageId: string): string | null {
  const def = template.stages.find((s) => s.id === stageId);
  // A placeholder does nothing and an assessment discusses instead, so neither can fail (only
  // their approval can be rejected).
  if (!def || def.kind === 'agent' || def.kind === 'placeholder' || def.kind === 'assess') {
    return null;
  }
  return rollbackTarget(template, stageId, 'fail');
}

/**
 * Where a merge stage goes when merging the target branch's latest code conflicts: its
 * `failTarget`, whose agent merges the target branch again and resolves the conflicts (rounds
 * count toward max_loops like any rollback). Only an agent stage can change files; for anything
 * else null: the Run ends as failed, and a Run from an issue is redone on the latest target
 * branch, where the conflicts are gone.
 */
export function conflictTarget(template: WorkflowTemplate, stageId: string): string | null {
  if (template.stages.find((s) => s.id === stageId)?.kind !== 'merge') return null;
  const target = failTarget(template, stageId);
  const def = template.stages.find((s) => s.id === target);
  return def?.kind === 'agent' ? def.id : null;
}
