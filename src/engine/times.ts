// How long a Run took, and how much of that the agents worked, the Run waited in the queue (for
// any Run ahead of it, or for one it overlaps), or it waited for a human. Used for the scout's
// digest, the issue's closing comment and the Run's page on the dashboard, so that time spent
// queued behind other Runs, with work switched off, paused, or waiting for an approval or a reply
// is not read as slow agents. Pure (type imports and src/i18n.ts only): the dashboard imports it.

import { t } from '../i18n.js';
import type { Approval, Attempt, EventRow, Run, RunStatus } from '../store/types.js';

export interface RunTimes {
  /** From creation to finish; null while the Run has not finished. */
  totalMs: number | null;
  /** Executions that ended, each from start to end; executions side by side each count in full. */
  agentMs: number;
  /**
   * Queued, from creation or each requeue until the Run's next status change: behind other Runs,
   * waiting for an upgrade or while the Master was not running. A stretch not over yet does not
   * count. The parts of the stretches told apart below are not in it.
   */
  queuedMs: number;
  /**
   * The part of those stretches in the queue spent waiting for a Run it overlaps
   * (`conflictWaitSpans`): the Run was assessed and expected to change the same place as a Run of
   * its execution slot not yet merged, so it waited for that one rather than conflict with it at
   * the merge.
   */
  conflictWaitMs: number;
  /**
   * The part of those stretches in the queue while work was switched off: the Run waited for a
   * human to switch it on, not for the queue. Comes first: none of it counts as waiting for a Run
   * it overlaps either.
   */
  stoppedMs: number;
  /** Approvals that were decided, each from asked to decided. */
  approvalMs: number;
  /**
   * Blocks until the Run's next status change (retried, answered or terminated), the
   * assessment's discussion included. A block not over yet does not count.
   */
  blockedMs: number;
  /** Paused, each time until the Run's next status change (resumed or terminated). */
  pausedMs: number;
}

/** What a Run's times are worked out from: its records as the store has them. */
export interface RunRecords {
  attempts: readonly Pick<Attempt, 'startedAt' | 'endedAt'>[];
  approvals: readonly Pick<Approval, 'createdAt' | 'decidedAt'>[];
  /** `run.status` events carry the new status in `data.status`. */
  events: readonly RunEvent[];
  /**
   * Every time the work switch was turned on or off (the global `master.working` events), in the
   * order they were recorded. None means it was always on.
   */
  workSwitches?: readonly WorkSwitch[];
}

/** The work switch turned on or off at `ts`. */
export interface WorkSwitch {
  ts: string;
  on: boolean;
}

/** A Run's event, as `runTimes` and `conflictWaitSpans` read it. */
type RunEvent = Pick<EventRow, 'id' | 'ts' | 'type' | 'data'>;

/**
 * A wait for another Run that a Run's events recorded: it went back to the queue after its
 * assessment, or was passed by in it, because it overlaps a Run of its execution slot not yet past
 * its merge.
 */
export interface ConflictWaitSpan {
  /** The Run waited for. */
  runId: string;
  /** The paths both expected to change, as the event recorded them. */
  paths: string[];
  /** The id and the time of the `run.waiting_conflict` event the wait began with. */
  fromId: number;
  from: string;
  /**
   * The id and the time of the event the wait ended with; Infinity and null while the Run is
   * still in it.
   */
  toId: number;
  to: string | null;
}

/**
 * The waits for other Runs that a Run's events recorded, oldest first. Each begins with its
 * `run.waiting_conflict` event and lasts until the Run leaves the queue (its next `run.status`
 * event other than `queued`; a Run going back to the queue after its assessment records the wait
 * just before it is queued) or waits for another Run (its next `run.waiting_conflict`). The engine
 * reads the same spans back after a restart, to tell which Runs a queued Run has outlasted, and
 * `runTimes` counts their time in the queue as `conflictWaitMs`: one rule for both.
 */
export function conflictWaitSpans(events: readonly RunEvent[]): ConflictWaitSpan[] {
  const waits: ConflictWaitSpan[] = [];
  let current: Omit<ConflictWaitSpan, 'toId' | 'to'> | null = null;
  for (const e of [...events].sort((a, b) => a.id - b.id)) {
    if (e.type === 'run.waiting_conflict') {
      if (current) waits.push({ ...current, toId: e.id, to: e.ts });
      const { blockedBy, paths } = e.data;
      current =
        typeof blockedBy === 'string'
          ? {
              runId: blockedBy,
              paths: Array.isArray(paths)
                ? paths.filter((p): p is string => typeof p === 'string')
                : [],
              fromId: e.id,
              from: e.ts,
            }
          : null;
    } else if (current && e.type === 'run.status' && e.data.status !== 'queued') {
      waits.push({ ...current, toId: e.id, to: e.ts });
      current = null;
    }
  }
  if (current) waits.push({ ...current, toId: Number.POSITIVE_INFINITY, to: null });
  return waits;
}

const span = (from: string, to: string) => Math.max(0, Date.parse(to) - Date.parse(from));

/**
 * How much of the time from `from` to `to` work was switched off. Before the first switch it was
 * on; within the time, it is as the last switch before it left it.
 */
function switchedOffMs(from: string, to: string, switches: readonly WorkSwitch[]): number {
  const end = Date.parse(to);
  let mark = Date.parse(from);
  let on = true;
  let off = 0;
  for (const s of switches) {
    const at = Date.parse(s.ts);
    if (at >= end) break;
    // A switch at or before the start (or out of order) only sets what it is from then on.
    if (at > mark) {
      if (!on) off += at - mark;
      mark = at;
    }
    on = s.on;
  }
  if (!on && end > mark) off += end - mark;
  return off;
}

/**
 * How much of the time in the queue from `from` to `to` the Run waited for a Run it overlaps:
 * the part within its waits (`waits`), less what passed with work switched off, which counts as
 * stopped.
 */
function conflictWaitedMs(
  from: string,
  to: string,
  waits: readonly ConflictWaitSpan[],
  switches: readonly WorkSwitch[],
): number {
  let waited = 0;
  for (const w of waits) {
    // A wait recorded just before the Run went back to the queue counts from the requeue on.
    const start = Date.parse(w.from) > Date.parse(from) ? w.from : from;
    const end = w.to !== null && Date.parse(w.to) < Date.parse(to) ? w.to : to;
    const length = span(start, end);
    if (length > 0) waited += length - Math.min(length, switchedOffMs(start, end, switches));
  }
  return waited;
}

/**
 * Splits a Run's time. Executions, approvals and blocks go by the same rules as the waits on the
 * stats page (src/api/stats.ts).
 */
export function runTimes(
  run: Pick<Run, 'createdAt' | 'finishedAt'>,
  records: RunRecords,
): RunTimes {
  let agentMs = 0;
  for (const a of records.attempts) {
    if (a.endedAt) agentMs += span(a.startedAt, a.endedAt);
  }
  let approvalMs = 0;
  for (const ap of records.approvals) {
    if (ap.decidedAt) approvalMs += span(ap.createdAt, ap.decidedAt);
  }
  // A Run is created queued without a status event; from then on every status change records a
  // `run.status` event, which ends the status before it. A block is recorded right after the
  // status change into it, so the next status change (a retry, a reply to the discussion,
  // termination) ends it. Of each stretch in the queue, what passed with work switched off is told
  // apart first: a paused or running Run is not held up by the switch, so only queueing is. Of the
  // rest, what passed within a wait for a Run it overlaps (`conflictWaitSpans`) is told apart too.
  const switches = records.workSwitches ?? [];
  const events = [...records.events].sort((a, b) => a.id - b.id);
  const waits = conflictWaitSpans(events);
  let queuedMs = 0;
  let conflictWaitMs = 0;
  let stoppedMs = 0;
  let pausedMs = 0;
  let blockedMs = 0;
  let status: RunStatus | null = 'queued';
  let since = run.createdAt;
  let blockedSince: string[] = [];
  for (const e of events) {
    if (e.type === 'run.blocked') {
      blockedSince.push(e.ts);
    } else if (e.type === 'run.status') {
      for (const s of blockedSince) blockedMs += span(s, e.ts);
      blockedSince = [];
      if (status === 'queued') {
        const queued = span(since, e.ts);
        const stopped = Math.min(queued, switchedOffMs(since, e.ts, switches));
        const waited = Math.min(queued - stopped, conflictWaitedMs(since, e.ts, waits, switches));
        stoppedMs += stopped;
        conflictWaitMs += waited;
        queuedMs += queued - stopped - waited;
      } else if (status === 'paused') pausedMs += span(since, e.ts);
      const next = e.data.status;
      status = typeof next === 'string' ? (next as RunStatus) : null;
      since = e.ts;
    }
  }
  return {
    totalMs: run.finishedAt ? span(run.createdAt, run.finishedAt) : null,
    agentMs,
    queuedMs,
    conflictWaitMs,
    stoppedMs,
    approvalMs,
    blockedMs,
    pausedMs,
  };
}

/**
 * The store's reads `storedRunTimes` needs. Declared here rather than taking the store's type,
 * so that this file does not pull the store (and node:sqlite) into the dashboard.
 */
export interface RunRecordReader {
  listRunAttempts(runId: string): RunRecords['attempts'];
  listApprovals(runId: string): RunRecords['approvals'];
  listEvents(runId: string): RunRecords['events'];
  /** Global events of the type, in the order they were recorded. */
  listGlobalEventsOfType(type: string): readonly Pick<EventRow, 'ts' | 'data'>[];
}

/** Every time the work switch was turned on or off, from the store's global events. */
export function workSwitchesOf(
  store: Pick<RunRecordReader, 'listGlobalEventsOfType'>,
): WorkSwitch[] {
  // Recorded by the store's setWorking with whether work is now on.
  return store
    .listGlobalEventsOfType('master.working')
    .flatMap((e) => (typeof e.data.on === 'boolean' ? [{ ts: e.ts, on: e.data.on }] : []));
}

/**
 * `runTimes` of a Run, from its records in the store. A caller working out the times of several
 * Runs passes the work switches (`workSwitchesOf`) read once for all of them; otherwise they are
 * read here.
 */
export function storedRunTimes(
  store: RunRecordReader,
  run: Run,
  switches?: readonly WorkSwitch[],
): RunTimes {
  return runTimes(run, {
    attempts: store.listRunAttempts(run.id),
    approvals: store.listApprovals(run.id),
    events: store.listEvents(run.id),
    workSwitches: switches ?? workSwitchesOf(store),
  });
}

/** A part of a Run's time: every field of `RunTimes` but the total. */
export type RunTimePart = Exclude<keyof RunTimes, 'totalMs'>;

/**
 * What each part of a Run's time is called in the language in use, in the order the parts are
 * listed. A Record, so that a part added to `RunTimes` has to be named here (in every language),
 * and then the scout's digest and the dashboard list it without another rule.
 */
export function runTimePartLabels(): Record<RunTimePart, string> {
  return t({
    zh: {
      agentMs: 'Agent 执行',
      queuedMs: '排队',
      conflictWaitMs: '错开等待',
      stoppedMs: '停工',
      approvalMs: '等审批',
      blockedMs: '卡住等人',
      pausedMs: '暂停',
    },
    en: {
      agentMs: 'Agent work',
      queuedMs: 'Queued',
      conflictWaitMs: 'Waiting for an overlapping Run',
      stoppedMs: 'Work switched off',
      approvalMs: 'Awaiting approval',
      blockedMs: 'Stuck, waiting for a human',
      pausedMs: 'Paused',
    },
  });
}

/** [label, ms] for every part of a Run's time, in the order of `runTimePartLabels`. */
export function runTimeParts(times: RunTimes): [label: string, ms: number][] {
  const labels = runTimePartLabels();
  return (Object.keys(labels) as RunTimePart[]).map((part) => [labels[part], times[part]]);
}

/**
 * The coarser groups a Run's time is told in on the issue's closing comment: the agents' work,
 * the queue (waiting for other Runs, whether any ahead of it or one it overlaps), and everything
 * spent waiting for a human.
 */
export type RunTimeGroup = 'agent' | 'queue' | 'human';

/**
 * Which group each part of a Run's time falls in. A Record, so that a part added to `RunTimes`
 * has to be put in a group here, and the issue's closing comment counts it without another rule.
 */
export const RUN_TIME_PART_GROUP: Record<RunTimePart, RunTimeGroup> = {
  agentMs: 'agent',
  queuedMs: 'queue',
  // Queued too, behind a Run it overlaps rather than any Run.
  conflictWaitMs: 'queue',
  // Waiting for a human to switch work on again.
  stoppedMs: 'human',
  approvalMs: 'human',
  blockedMs: 'human',
  pausedMs: 'human',
};

/**
 * What each group is called, in the order the groups are listed. The agents' work and the queue
 * are called what their parts are called, so the issue's closing comment, the scout's digest and
 * the dashboard name them alike; a Run waiting for one it overlaps is in the queue as well.
 */
function runTimeGroupLabels(): Record<RunTimeGroup, string> {
  const parts = runTimePartLabels();
  return {
    agent: parts.agentMs,
    queue: parts.queuedMs,
    human: t({ zh: '等人', en: 'Waiting for a human' }),
  };
}

/**
 * [label, ms] for every group of a Run's time, in the order of `runTimeGroupLabels`; each group
 * is the sum of its parts.
 */
export function groupedTimeParts(times: RunTimes): [label: string, ms: number][] {
  const parts = Object.keys(RUN_TIME_PART_GROUP) as RunTimePart[];
  const labels = runTimeGroupLabels();
  return (Object.keys(labels) as RunTimeGroup[]).map((group) => [
    labels[group],
    parts
      .filter((part) => RUN_TIME_PART_GROUP[part] === group)
      .reduce((sum, part) => sum + times[part], 0),
  ]);
}

/** Whole minutes as shown to people; at least 1, so a short time does not read as none. */
export function minutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

/** Parts of a Run's time shorter than this are left out: they would round to no minutes. */
export const SHOWN_PART_MS = 30_000;

/**
 * 「Agent 执行 40 分钟」 for each part of a Run's time. Parts under half a minute are left out:
 * nearly every Run is queued for a few milliseconds whenever it is created or requeued, and
 * 「排队 1 分钟」 for that would be noise.
 */
export function timeParts(parts: readonly (readonly [label: string, ms: number])[]): string[] {
  return parts
    .filter(([, ms]) => ms >= SHOWN_PART_MS)
    .map(([label, ms]) =>
      t({ zh: `${label} ${minutes(ms)} 分钟`, en: `${label} ${minutes(ms)} min` }),
    );
}
