// Iterations, wherever their children come from (GitHub issues, or proposals of the local
// backlog): where each child stands as its Runs go, when the iteration is blocked and when it
// goes on, a human turning it down, a scout's change to its plan, what it cost and how long it
// took, the summary once every child is done, and the review suggestions its closing step goes
// through. Reads and writes the store only: the sources (src/github/bridge.ts,
// src/backlog/local.ts) find out where each child's requirement is and publish the texts this
// gives them. No agent is asked: the summary is put together from the Runs' records.

import {
  ITERATION_OPEN_STATUSES,
  iterationStatusOf,
  MAX_ITERATION_CHILDREN,
  unmetDependencies,
} from '../config/flow.js';
import { minutes, storedRunTimes, workSwitchesOf } from '../engine/times.js';
import {
  type IterationUpdate,
  oneLine,
  passedReviews,
  statusText,
  trustedGoal,
} from '../github/scout.js';
import { join, t } from '../i18n.js';
import type { Store } from '../store/store.js';
import {
  FINISHED_RUN_STATUSES,
  type Iteration,
  type IterationChild,
  type IterationChildStatus,
  type Run,
  type RunStatus,
} from '../store/types.js';
import { nowIso } from '../util.js';

/**
 * The Runs that worked on a child, oldest first: on GitHub every Run created from its issue
 * (failed attempts, redos and Runs started over included); in the local backlog, the Runs its
 * proposal became: each failed attempt (`failures`) and the latest.
 */
export function childRuns(
  store: Store,
  iteration: Pick<Iteration, 'source' | 'issuesRepo'>,
  child: Pick<IterationChild, 'issue' | 'proposalId'>,
): Run[] {
  if (iteration.source === 'github') {
    return child.issue ? store.runsForIssue(iteration.issuesRepo, child.issue.number) : [];
  }
  if (!child.proposalId) return [];
  const p = store.getProposal(child.proposalId);
  // The latest failure is the latest Run itself until the redo replaces it.
  const ids = new Set([...p.failures.map((f) => f.runId), ...(p.runId ? [p.runId] : [])]);
  return [...ids].map((id) => store.getRun(id));
}

/**
 * Whether a Run works on the child: one has not finished, or the latest failed and waits to be
 * redone (a failed Run of an issue with attempts left).
 */
function worksOn(runs: readonly Run[]): boolean {
  const latest = runs.at(-1);
  return (
    runs.some((r) => !FINISHED_RUN_STATUSES.includes(r.status)) ||
    (latest?.status === 'failed' && latest.issue?.redo === 'pending')
  );
}

/**
 * Whether a child's Runs used up every attempt: its latest Run failed and was not to be redone
 * (`issue.redo` exhausted, recorded before its issue was closed, or its `issue.retries_exhausted`
 * event). Only the latest counts: a human may have started the child over since.
 */
export function ranOutOfAttempts(store: Store, runs: readonly Run[]): boolean {
  const latest = runs.at(-1);
  if (latest?.status !== 'failed') return false;
  if (latest.issue?.redo === 'exhausted') return true;
  return store.listEvents(latest.id).some((e) => e.type === 'issue.retries_exhausted');
}

/**
 * Where the source has a child's requirement: open, still to be done; redo, still to be done and
 * its latest Run failed, but a redo is coming (in the local backlog: its proposal has attempts
 * left, so it is running all along; on GitHub an open issue's Runs tell that by themselves); done
 * (on GitHub: its issue closed as completed; in the local backlog: its Run completed); closed
 * without being done (on GitHub: closed as not planned, or any other way but completed), which is
 * failed or dropped by its Runs; or failed outright (in the local backlog: its Runs failed until
 * its attempts were used up, its Run was terminated, or its assessment dropped the requirement).
 */
export type ChildOutcome = 'open' | 'redo' | 'done' | 'closed' | 'failed';

/**
 * What every event about an iteration starts with: its repo and id, its issue on GitHub, and
 * `backlog: true` for one of the local backlog, whose texts point to the dashboard instead.
 */
export function iterationEventData(
  iteration: Pick<Iteration, 'id' | 'issue' | 'source'>,
  repo: string,
): Record<string, unknown> {
  return {
    repo,
    iterationId: iteration.id,
    ...(iteration.issue ? { issue: iteration.issue.number } : {}),
    ...(iteration.source === 'local' ? { backlog: true } : {}),
  };
}

/**
 * Record where the children of an accepted iteration stand now, each with the Runs that worked on
 * it (`childRuns`), and return the iteration as recorded then. `outcomes` tells, by position,
 * where the source has each child's requirement; a child it says nothing about (no issue yet, or
 * not read again) keeps its status. Done is done, failed is failed. Closed without being done is
 * failed when its Runs used up their attempts (`ranOutOfAttempts`), otherwise dropped: a human
 * turned it down.
 * Open ones are running while a Run works on them, else waiting while a child they depend on is
 * not done (`unmetDependencies`), else ready; ones a redo is coming for are running, so that
 * neither the iteration is blocked nor another Run started for them meanwhile. Each status change
 * records an
 * `iteration.child_status` event, and the iteration's own status follows (`settleStatus`), in the
 * same transaction. The children are not written when none changed.
 */
export function followChildren(
  store: Store,
  iterationId: string,
  repo: string,
  outcomes: ReadonlyMap<number, ChildOutcome>,
): Iteration {
  return store.tx(() => {
    const latest = store.getIteration(iterationId);
    const runs = new Map(latest.children.map((c) => [c.position, childRuns(store, latest, c)]));
    const settled = new Map<number, IterationChildStatus>();
    for (const child of latest.children) {
      const outcome = outcomes.get(child.position);
      const childRunsOf = runs.get(child.position) ?? [];
      if (outcome === 'done') settled.set(child.position, 'done');
      else if (outcome === 'failed') settled.set(child.position, 'failed');
      else if (outcome === 'closed') {
        settled.set(child.position, ranOutOfAttempts(store, childRunsOf) ? 'failed' : 'dropped');
      } else if (outcome === 'redo' || (outcome === 'open' && worksOn(childRunsOf))) {
        settled.set(child.position, 'running');
      }
    }
    // A child the source has open is not done, whatever it was before (a failed one reopened
    // included): the ones it holds back wait for it.
    const open = (c: IterationChild) =>
      outcomes.get(c.position) === 'open' && !settled.has(c.position);
    const placed = latest.children.map((c) =>
      open(c)
        ? { ...c, status: 'ready' as const }
        : { ...c, status: settled.get(c.position) ?? c.status },
    );
    const next: IterationChild[] = placed.map((c, i) => {
      const before = latest.children[i] as IterationChild;
      const runIds = (runs.get(c.position) ?? []).map((r) => r.id);
      const status = open(c)
        ? unmetDependencies(c, placed).length > 0
          ? 'waiting'
          : 'ready'
        : c.status;
      return {
        ...before,
        status,
        runIds: before.issue || before.proposalId ? runIds : before.runIds,
      };
    });
    const changed = next.filter((c, i) => {
      const before = latest.children[i] as IterationChild;
      return c.status !== before.status || c.runIds.join() !== before.runIds.join();
    });
    if (changed.length === 0) return settleStatus(store, latest, repo);
    const updated = store.updateIteration(iterationId, { children: next });
    for (const [i, child] of next.entries()) {
      const before = latest.children[i] as IterationChild;
      if (child.status === before.status) continue;
      store.event(null, 'iteration.child_status', {
        ...iterationEventData(latest, repo),
        position: child.position,
        ...(child.issue ? { child: child.issue.number } : {}),
        ...(child.proposalId ? { proposalId: child.proposalId } : {}),
        status: child.status,
        previous: before.status,
      });
    }
    return settleStatus(store, updated, repo);
  });
}

/**
 * An accepted iteration's status as its children have it now (`iterationStatusOf`), recorded with
 * its event; call it within a transaction. Active becomes blocked once a child failed or was
 * dropped and nothing replaced it, with an `iteration.blocked` event naming the first such child
 * and why (failed or dropped), once each time it gets blocked. Blocked becomes active again once
 * no child holds it back any more (reopened, or replaced), with `iteration.unblocked`. Done is
 * left to the source, which sums the iteration up first. Any other status is a human's decision
 * and stays.
 */
function settleStatus(store: Store, iteration: Iteration, repo: string): Iteration {
  const was = iteration.status;
  if (was !== 'active' && was !== 'blocked') return iteration;
  const now = iterationStatusOf(iteration.children);
  const where = iterationEventData(iteration, repo);
  if (now === 'blocked' && was === 'active') {
    const updated = store.updateIteration(iteration.id, { status: 'blocked' });
    const cause = iteration.children.find(
      (c) => c.replacedBy === undefined && (c.status === 'failed' || c.status === 'dropped'),
    );
    store.event(null, 'iteration.blocked', {
      ...where,
      ...(cause
        ? {
            position: cause.position,
            ...(cause.issue ? { child: cause.issue.number } : {}),
            ...(cause.proposalId ? { proposalId: cause.proposalId } : {}),
            reason: cause.status,
          }
        : {}),
    });
    return updated;
  }
  if (now !== 'blocked' && was === 'blocked') {
    const updated = store.updateIteration(iteration.id, { status: 'active' });
    store.event(null, 'iteration.unblocked', where);
    return updated;
  }
  return iteration;
}

/**
 * Accept a pending iteration as a whole, by a human or without one (`auto`): active, decided now,
 * each child planned so far waiting for the children it depends on or ready, and an
 * `iteration.accepted` or `iteration.auto_accepted` event (which counts once toward today's
 * auto-accepts), in one transaction. The source starts its children in the order of their
 * dependencies. Returns the iteration as recorded then, or null when it was no longer pending.
 */
export function recordAccepted(
  store: Store,
  iterationId: string,
  repo: string,
  auto: boolean,
): Iteration | null {
  return store.tx(() => {
    const latest = store.getIteration(iterationId);
    if (latest.status !== 'pending') return null;
    const updated = store.updateIteration(iterationId, {
      status: 'active',
      auto,
      decidedAt: nowIso(),
      children: latest.children.map((c) =>
        c.status === 'planned'
          ? {
              ...c,
              status: unmetDependencies(c, latest.children).length > 0 ? 'waiting' : 'ready',
            }
          : c,
      ),
    });
    store.event(
      null,
      auto ? 'iteration.auto_accepted' : 'iteration.accepted',
      iterationEventData(latest, repo),
    );
    return updated;
  });
}

/**
 * Record that an accepted iteration is done, once its source summed it up: done, ended now, and
 * an `iteration.completed` event with what it cost over how many Runs (`iterationTotals`), in one
 * transaction. An iteration no longer active is returned as it is.
 */
export function recordDone(store: Store, iterationId: string, repo: string): Iteration {
  return store.tx(() => {
    const latest = store.getIteration(iterationId);
    if (latest.status !== 'active') return latest;
    const ended = store.updateIteration(iterationId, { status: 'done', endedAt: nowIso() });
    const totals = iterationTotals(store, ended);
    store.event(null, 'iteration.completed', {
      ...iterationEventData(latest, repo),
      costUsd: totals.costUsd,
      runs: totals.runs,
    });
    return ended;
  });
}

/**
 * Record that a human turned the iteration down (on GitHub: closed its issue before it was done;
 * in the local backlog: rejected it, or cancelled it once accepted): cancelled, ended now (and
 * decided now if it was still pending), each child that was neither done nor failed nor replaced
 * dropped with it, and an `iteration.cancelled` event with the positions of those dropped,
 * whether it was still pending and `extra` (the reason a human gave), in one transaction. The
 * source stops their Runs and closes their requirements. An iteration that is over already is
 * returned as it is.
 */
export function recordCancelled(
  store: Store,
  iterationId: string,
  repo: string,
  extra: Record<string, unknown> = {},
): Iteration {
  return store.tx(() => {
    const latest = store.getIteration(iterationId);
    if (!ITERATION_OPEN_STATUSES.includes(latest.status)) return latest;
    const dropped = latest.children.filter(
      (c) => c.replacedBy === undefined && !['done', 'failed', 'dropped'].includes(c.status),
    );
    const at = nowIso();
    const updated = store.updateIteration(iterationId, {
      status: 'cancelled',
      endedAt: at,
      decidedAt: latest.decidedAt ?? at,
      children: latest.children.map((c) =>
        dropped.includes(c) ? { ...c, status: 'dropped' as const } : c,
      ),
    });
    store.event(null, 'iteration.cancelled', {
      ...iterationEventData(latest, repo),
      dropped: dropped.map((c) => c.position),
      pending: latest.status === 'pending',
      ...extra,
    });
    return updated;
  });
}

/** A step a scout's change to the plan could not add, and why. */
export interface LeftOutStep {
  title: string;
  /**
   * limit: the plan would have more than MAX_ITERATION_CHILDREN steps; stale: the step it was to
   * replace no longer needs replacing (it was replaced, or neither failed nor was dropped any
   * more, since the scout saw the plan).
   */
  reason: 'limit' | 'stale';
}

/** What a scout's change made of an iteration's plan (`adjustedPlan`). */
export interface AdjustedPlan {
  /** The whole plan afterwards, in order of position. */
  children: IterationChild[];
  /** The positions of the steps added, in order. */
  added: number[];
  /** The steps replaced: `position` by the step added at `by`. */
  replaced: { position: number; by: number }[];
  leftOut: LeftOutStep[];
}

/** Statuses of a child that has not started: its dependencies may still change. */
const NOT_STARTED: readonly IterationChildStatus[] = ['planned', 'waiting', 'ready'];

/**
 * The plan of `iteration` with a scout's change applied (checked against the plan the scout saw
 * by `updateProblems`). Steps are added after the last position, in order, keeping the numbers the
 * scout gave them for the dependencies between them; a step that replaces one marks it
 * `replacedBy`. A step is left out when the plan would have more than MAX_ITERATION_CHILDREN steps
 * not replaced, or when the one it was to replace no longer needs it; its number is then given to
 * the next step added, and dependencies on it are dropped. The closing step, unless it started
 * already, waits for the steps added too. The steps added are planned while the iteration is
 * pending, otherwise waiting or ready by their dependencies. Pure.
 */
export function adjustedPlan(
  iteration: Pick<Iteration, 'status' | 'children'>,
  update: IterationUpdate,
): AdjustedPlan {
  const children = iteration.children.map((c) => ({ ...c, dependsOn: [...c.dependsOn] }));
  const byPosition = new Map(children.map((c) => [c.position, c]));
  const last = Math.max(0, ...children.map((c) => c.position));
  // The scout's number of each step added that was kept, and its position.
  const kept = new Map<number, number>();
  let count = children.filter((c) => c.replacedBy === undefined).length;
  const added: number[] = [];
  const replaced: AdjustedPlan['replaced'] = [];
  const leftOut: LeftOutStep[] = [];
  for (const [i, step] of update.add.entries()) {
    const old = step.replaces === undefined ? undefined : byPosition.get(step.replaces);
    if (step.replaces !== undefined) {
      const replaceable =
        old !== undefined &&
        !old.closeout &&
        old.replacedBy === undefined &&
        (old.status === 'failed' || old.status === 'dropped');
      if (!replaceable) {
        leftOut.push({ title: step.title, reason: 'stale' });
        continue;
      }
    } else if (count >= MAX_ITERATION_CHILDREN) {
      leftOut.push({ title: step.title, reason: 'limit' });
      continue;
    }
    const position = last + added.length + 1;
    kept.set(last + i + 1, position);
    const child: IterationChild = {
      title: step.title,
      category: step.category,
      size: step.size,
      risk: step.risk,
      why: step.why,
      evidence: [...step.evidence],
      what: step.what,
      acceptance: [...step.acceptance],
      position,
      criteria: [...step.criteria],
      dependsOn: step.dependsOn.flatMap((n) => {
        if (n <= last) return [n];
        const at = kept.get(n);
        return at === undefined ? [] : [at];
      }),
      closeout: false,
      status: 'planned',
      runIds: [],
    };
    children.push(child);
    byPosition.set(position, child);
    added.push(position);
    if (old) {
      old.replacedBy = position;
      replaced.push({ position: old.position, by: position });
    } else {
      count++;
    }
  }
  const closing = children.find((c) => c.closeout && c.replacedBy === undefined);
  if (closing && NOT_STARTED.includes(closing.status)) {
    for (const position of added) {
      if (!closing.dependsOn.includes(position)) closing.dependsOn.push(position);
    }
  }
  if (iteration.status !== 'pending') {
    for (const child of children) {
      if (!added.includes(child.position) && child !== closing) continue;
      if (child.status !== 'planned' && child.status !== 'waiting' && child.status !== 'ready') {
        continue;
      }
      child.status = unmetDependencies(child, children).length > 0 ? 'waiting' : 'ready';
    }
  }
  return { children, added, replaced, leftOut };
}

/**
 * Apply a scout's change to the plan of an iteration under way (`adjustedPlan`) and record it:
 * the plan, the scout's note with it, an `iteration.adjusted` event (the positions added, those
 * replaced and how many were left out), and the iteration's status as its children have it now
 * (`settleStatus`: replacing the step that blocked it lets it go on), in one transaction. The
 * source writes the steps added out afterwards. Returns the iteration as recorded then, and what
 * the change made of its plan.
 */
export function recordAdjustment(
  store: Store,
  iterationId: string,
  repo: string,
  update: IterationUpdate,
  scoutId: string | null,
): { iteration: Iteration; adjusted: AdjustedPlan } {
  return store.tx(() => {
    const latest = store.getIteration(iterationId);
    const adjusted = adjustedPlan(latest, update);
    const updated = store.updateIteration(iterationId, {
      children: adjusted.children,
      notes: [...latest.notes, { at: nowIso(), scoutId, text: update.note }],
    });
    store.event(null, 'iteration.adjusted', {
      ...iterationEventData(latest, repo),
      ...(scoutId ? { scoutId } : {}),
      added: adjusted.added,
      replaced: adjusted.replaced,
      leftOut: adjusted.leftOut.length,
    });
    return { iteration: settleStatus(store, updated, repo), adjusted };
  });
}

/** What an iteration used, over every Run of its children. */
export interface IterationTotals {
  /** How many Runs worked on its children, failed attempts included. */
  runs: number;
  /** What all of them cost. */
  costUsd: number;
  /** From its acceptance to its end, or to now while it goes on; null while not accepted. */
  elapsedMs: number | null;
  /** The agents' executions in all of them, each from start to end (`storedRunTimes`). */
  agentMs: number;
}

/**
 * What an iteration used: every Run of every child (`childRuns`), failed attempts and those of
 * replaced children included, as each of them cost money and time. `now` (epoch ms) ends the
 * time of an iteration that has not ended.
 */
export function iterationTotals(
  store: Store,
  iteration: Iteration,
  now = Date.now(),
): IterationTotals {
  const runs = iteration.children.flatMap((c) => childRuns(store, iteration, c));
  const switches = workSwitchesOf(store);
  const end = iteration.endedAt ? Date.parse(iteration.endedAt) : now;
  return {
    runs: runs.length,
    costUsd: runs.reduce((sum, r) => sum + r.costUsd, 0),
    elapsedMs: iteration.decidedAt ? Math.max(0, end - Date.parse(iteration.decidedAt)) : null,
    agentMs: runs.reduce((sum, r) => sum + storedRunTimes(store, r, switches).agentMs, 0),
  };
}

/** One Run of a child, as the summary lists it. */
export interface SummaryRun {
  id: string;
  status: RunStatus;
  costUsd: number;
}

/** One child, as the summary tells it. */
export interface SummaryChild {
  child: Pick<IterationChild, 'position' | 'title' | 'issue' | 'criteria' | 'replacedBy'>;
  /** Every Run that worked on it, oldest first. */
  runs: SummaryRun[];
  /**
   * The Run that got it done and what its reviews concluded (the latest round of each review
   * stage that passed); null when no Run completed it (closed as completed by a human).
   */
  doneBy: { runId: string; reviews: { stageName: string; summary: string }[] } | null;
}

export interface SummaryInput {
  goal: string;
  criteria: readonly string[];
  children: readonly SummaryChild[];
  totals: IterationTotals;
}

/** 「#12 标题」 on GitHub, the title alone in the local backlog. */
const childRef = (child: Pick<IterationChild, 'title' | 'issue'>) =>
  `${child.issue ? `#${child.issue.number} ` : ''}${oneLine(child.title, 120)}`;

/** 「3 小时 5 分钟」 / "3 h 5 min": a duration in whole minutes, at least one. */
export function durationText(ms: number): string {
  const total = minutes(ms);
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  const parts: [number, string, string][] = [
    [days, '天', 'd'],
    [hours, '小时', 'h'],
    [mins, '分钟', 'min'],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, zh, en]) => t({ zh: `${n} ${zh}`, en: `${n} ${en}` }))
    .join(' ');
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** 「评审结论：没问题」, what the reviews of the Run that got a child done concluded. */
function reviewText(reviews: readonly { stageName: string; summary: string }[]): string {
  if (reviews.length === 0) return t({ zh: '没有评审', en: 'not reviewed' });
  // The stage is named only when there are several to tell apart.
  const each = reviews.map((r) => {
    const summary = oneLine(r.summary, 300);
    if (reviews.length === 1) return summary;
    return t({ zh: `${r.stageName}：${summary}`, en: `${r.stageName}: ${summary}` });
  });
  return t({ zh: `评审结论：${each.join('；')}`, en: `review: ${each.join('; ')}` });
}

/**
 * The summary of an iteration once every child is done, in the language in use: what it
 * achieved (its goal, and the children done), each completion criterion with the children that
 * advanced it (by `criteria`), the Run that got each done and what its reviews concluded, every
 * Run used, and what it all cost and took. Pure: `iterationSummary` gathers the input.
 */
export function iterationSummaryText(input: SummaryInput): string {
  const counted = input.children.filter((c) => c.child.replacedBy === undefined);
  const lines: string[] = [
    t({ zh: '## 迭代完成', en: '## Iteration done' }),
    '',
    t({ zh: '### 做成了什么', en: '### What it achieved' }),
    '',
    input.goal.trim(),
    '',
    t({
      zh: `完成了全部 ${counted.length} 个子项：`,
      en: `All ${counted.length} step${counted.length === 1 ? '' : 's'} done:`,
    }),
    '',
    ...counted.map((c) => `- ${childRef(c.child)}`),
    '',
    t({ zh: '### 对照完成标准', en: '### Against the completion criteria' }),
    '',
  ];
  for (const [i, criterion] of input.criteria.entries()) {
    lines.push(`${i + 1}. ${oneLine(criterion, 500)}`);
    const advancing = counted.filter((c) => c.child.criteria.includes(i + 1));
    if (advancing.length === 0) {
      lines.push(
        `   - ${t({ zh: '没有子项写明推进这一条', en: 'No step was planned to advance it' })}`,
      );
    }
    for (const c of advancing) {
      const how = c.doneBy
        ? t({
            zh: `${c.doneBy.runId}，${reviewText(c.doneBy.reviews)}`,
            en: `${c.doneBy.runId}, ${reviewText(c.doneBy.reviews)}`,
          })
        : t({ zh: '没有 Run 完成它', en: 'no Run completed it' });
      lines.push(
        t({
          zh: `   - ${childRef(c.child)}：${how}`,
          en: `   - ${childRef(c.child)}: ${how}`,
        }),
      );
    }
  }
  lines.push('', t({ zh: '### 用到的 Run', en: '### Runs used' }), '');
  for (const c of input.children) {
    const runs =
      c.runs.length > 0
        ? join(
            c.runs.map((r) =>
              t({
                zh: `${r.id}（${statusText(r.status)}，${usd(r.costUsd)}）`,
                en: `${r.id} (${statusText(r.status)}, ${usd(r.costUsd)})`,
              }),
            ),
          )
        : t({ zh: '没有', en: 'none' });
    const replaced =
      c.child.replacedBy === undefined
        ? ''
        : t({
            zh: `（已被第 ${c.child.replacedBy} 步替换）`,
            en: ` (replaced by step ${c.child.replacedBy})`,
          });
    lines.push(
      t({
        zh: `- ${childRef(c.child)}${replaced}：${runs}`,
        en: `- ${childRef(c.child)}${replaced}: ${runs}`,
      }),
    );
  }
  const { totals } = input;
  const took =
    totals.elapsedMs === null
      ? t({
          zh: `- 用时：Agent 执行 ${durationText(totals.agentMs)}`,
          en: `- Time: agents worked ${durationText(totals.agentMs)}`,
        })
      : t({
          zh: `- 用时：从采纳到完成 ${durationText(totals.elapsedMs)}，其中 Agent 执行 ${durationText(totals.agentMs)}`,
          en: `- Time: ${durationText(totals.elapsedMs)} from acceptance to done, of which agents worked ${durationText(totals.agentMs)}`,
        });
  lines.push(
    '',
    t({ zh: '### 费用和用时', en: '### Cost and time' }),
    '',
    t({
      zh: `- 总费用：${usd(totals.costUsd)}，共 ${totals.runs} 个 Run（失败的尝试也算在内）`,
      en: `- Total cost: ${usd(totals.costUsd)} over ${totals.runs} Run${totals.runs === 1 ? '' : 's'} (failed attempts included)`,
    }),
    took,
  );
  return lines.join('\n');
}

/**
 * The latest round of each review stage of the Run that passed (`passedReviews`): an earlier one
 * was about work redone since.
 */
function latestPassedReviews(store: Store, run: Run) {
  const byStage = new Map<string, ReturnType<typeof passedReviews>[number]>();
  for (const review of passedReviews(store, run)) byStage.set(review.stageId, review);
  return [...byStage.values()];
}

/**
 * The summary of an iteration whose children are all done (`iterationSummaryText`), from the
 * store: each child's Runs (`childRuns`), the last of them that completed with its reviews, and
 * the totals as of `now` (epoch ms).
 */
export function iterationSummary(store: Store, iteration: Iteration, now = Date.now()): string {
  const children = iteration.children.map((child): SummaryChild => {
    const runs = childRuns(store, iteration, child);
    const completed = runs.findLast((r) => r.status === 'completed');
    return {
      child,
      runs: runs.map((r) => ({ id: r.id, status: r.status, costUsd: r.costUsd })),
      doneBy: completed
        ? {
            runId: completed.id,
            reviews: latestPassedReviews(store, completed).map((r) => ({
              stageName: r.stageName,
              summary: r.summary,
            })),
          }
        : null,
    };
  });
  return iterationSummaryText({
    goal: iteration.goal,
    criteria: iteration.criteria,
    children,
    totals: iterationTotals(store, iteration, now),
  });
}

/** Suggestions listed in the closing step's requirement; more are only counted. */
const MAX_CLOSEOUT_SUGGESTIONS = 40;

/**
 * Characters kept of each suggestion listed. The closing step works from them, and reviewers
 * usually describe what they saw first and how to fix it last: more is kept than in the scout's
 * digest, where they are only leads.
 */
const CLOSEOUT_SUGGESTION_CHARS = 800;

/**
 * The review suggestions an iteration's closing step goes through, as a Markdown section added to
 * its requirement before its Run is created: what reviewers left as suggestions when the Runs of
 * the iteration's other children passed review, instead of issues of their own. Only Runs that
 * completed count (a failed one's work never reached the target branch, so its suggestions are
 * about code that is not there), each by the latest passed round of each review stage. Runs
 * whose goal is not trusted are left out (`trustedGoal`): reviewers read the goal, and their
 * suggestions may carry its text into this Run's prompt. Says so when none were left.
 */
export function closeoutSuggestions(
  store: Store,
  iteration: Iteration,
  closeout: Pick<IterationChild, 'position'>,
): string {
  const lines: string[] = [];
  let listed = 0;
  let more = 0;
  for (const child of iteration.children) {
    if (child.position === closeout.position || child.closeout) continue;
    for (const run of childRuns(store, iteration, child)) {
      if (run.status !== 'completed' || !trustedGoal(run)) continue;
      for (const review of latestPassedReviews(store, run)) {
        if (review.suggestions.length === 0) continue;
        const round = t({
          zh: `${run.id}，${review.stageName}第 ${review.round} 轮`,
          en: `${run.id}, ${review.stageName} round ${review.round}`,
        });
        lines.push(
          t({
            zh: `- ${childRef(child)}（${round}）`,
            en: `- ${childRef(child)} (${round})`,
          }),
        );
        for (const s of review.suggestions) {
          if (listed >= MAX_CLOSEOUT_SUGGESTIONS) {
            more++;
            continue;
          }
          listed++;
          const where = s.file ? `[${s.file}] ` : '';
          lines.push(`  - ${oneLine(`${where}${s.description}`, CLOSEOUT_SUGGESTION_CHARS)}`);
        }
      }
    }
  }
  const head = [
    t({ zh: '### 本迭代评审留下的建议', en: '### Review suggestions of this iteration' }),
    '',
  ];
  if (listed === 0 && more === 0) {
    return [
      ...head,
      t({
        zh: '本迭代其他子项的 Run 评审通过时没有留下建议。',
        en: "The reviews of this iteration's other steps left no suggestions when they passed.",
      }),
    ].join('\n');
  }
  if (more > 0) {
    lines.push(
      t({
        zh: `- …另有 ${more} 条没有列出`,
        en: `- …and ${more} more not listed`,
      }),
    );
  }
  return [
    ...head,
    t({
      zh: '本迭代其他子项的 Run 评审通过时留下了下面这些建议。逐条判断：值得做的就做；不值得做或已经不适用的，在结果里说明理由。',
      en: "The reviews of this iteration's other steps left these suggestions when they passed. Judge each one: do those worth doing, and for those that are not, or no longer apply, say why in your result.",
    }),
    '',
    ...lines,
  ].join('\n');
}
