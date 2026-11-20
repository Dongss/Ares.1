import { afterEach, describe, expect, it } from 'vitest';
import {
  groupedTimeParts,
  minutes,
  RUN_TIME_PART_GROUP,
  type RunRecords,
  type RunTimePart,
  runTimePartLabels,
  runTimeParts,
  runTimes,
  timeParts,
} from '../src/engine/times.js';
import { setLang } from '../src/i18n.js';

const T0 = Date.parse('2026-11-19T00:00:00.000Z');
/** Time `min` minutes (and `ms` milliseconds) after T0, as ISO. */
const at = (min: number, ms = 0) => new Date(T0 + min * 60_000 + ms).toISOString();
const MIN = 60_000;

describe('runTimes', () => {
  let id = 0;
  const event = (type: string, min: number, data: Record<string, unknown> = {}) => ({
    id: ++id,
    type,
    ts: at(min),
    data,
  });
  const status = (to: string, min: number) => event('run.status', min, { status: to });
  const blocked = (min: number) => event('run.blocked', min);
  const created = { createdAt: at(0), finishedAt: null };

  // Created at 0, queued until a status event says otherwise.
  const records: RunRecords = {
    attempts: [
      { startedAt: at(5), endedAt: at(15) },
      // Redone after a failed check: counts too.
      { startedAt: at(16), endedAt: at(21, 30_500) },
      { startedAt: at(60), endedAt: at(64) },
      // Still running: not counted.
      { startedAt: at(150), endedAt: null },
    ],
    approvals: [
      { createdAt: at(70), decidedAt: at(130) },
      // Not decided yet: not counted.
      { createdAt: at(140), decidedAt: null },
    ],
    events: [
      event('run.created', 0),
      // Queued behind another Run for 5 minutes.
      status('running', 5),
      event('task.started', 5),
      // Blocked: the status change comes first, then the block.
      status('blocked', 25),
      blocked(25),
      event('run.note', 30),
      // Retried: the block lasted until here, and the Run is requeued for 3 minutes.
      status('queued', 45),
      status('running', 48),
      // The assessment's discussion counts as waiting for a human too; answering requeues.
      status('blocked', 50),
      blocked(50),
      status('queued', 53),
      status('running', 54),
      status('waiting_approval', 70),
      // Approved: requeued for a moment.
      status('queued', 130),
      status('running', 130),
      // Paused for 10 minutes, resumed into the queue for 2.
      status('paused', 135),
      status('queued', 145),
      status('running', 147),
      // Blocked again and not over yet: not counted.
      status('blocked', 160),
      blocked(160),
    ],
  };

  it('sums the executions, the queueing, the decided approvals, the blocks and the pauses', () => {
    expect(runTimes(created, records)).toEqual({
      totalMs: null,
      agentMs: 10 * MIN + 5 * MIN + 30_500 + 4 * MIN,
      queuedMs: (5 + 3 + 1 + 2) * MIN,
      approvalMs: 60 * MIN,
      blockedMs: 20 * MIN + 3 * MIN,
      pausedMs: 10 * MIN,
    });
  });

  it('gives the total once the Run has finished', () => {
    expect(runTimes({ createdAt: at(0), finishedAt: at(957) }, records).totalMs).toBe(957 * MIN);
  });

  it('goes by the order the events were recorded in', () => {
    const shuffled = { ...records, events: [...records.events].reverse() };
    expect(runTimes(created, shuffled)).toMatchObject({
      queuedMs: 11 * MIN,
      blockedMs: 23 * MIN,
      pausedMs: 10 * MIN,
    });
  });

  it('counts a Run that waited most of its time in the queue', () => {
    const times = runTimes(
      { createdAt: at(0), finishedAt: at(35) },
      {
        attempts: [{ startedAt: at(30), endedAt: at(35) }],
        approvals: [],
        events: [status('running', 30), status('completed', 35)],
      },
    );
    expect(times).toMatchObject({ totalMs: 35 * MIN, agentMs: 5 * MIN, queuedMs: 30 * MIN });
  });

  it('does not count a queue or a pause that is not over yet', () => {
    const empty = { attempts: [], approvals: [] };
    // Still waiting for its first start.
    expect(runTimes(created, { ...empty, events: [] }).queuedMs).toBe(0);
    // Still paused, and queued again after being paused.
    const paused = [status('running', 2), status('paused', 4)];
    expect(runTimes(created, { ...empty, events: paused })).toMatchObject({
      queuedMs: 2 * MIN,
      pausedMs: 0,
    });
    const resumed = [...paused, status('queued', 9)];
    expect(runTimes(created, { ...empty, events: resumed })).toMatchObject({
      queuedMs: 2 * MIN,
      pausedMs: 5 * MIN,
    });
  });

  it('counts a pause that ended the Run, until it was terminated', () => {
    const times = runTimes(
      { createdAt: at(0), finishedAt: at(30) },
      {
        attempts: [],
        approvals: [],
        events: [status('running', 0), status('paused', 10), status('cancelled', 30)],
      },
    );
    expect(times).toMatchObject({ queuedMs: 0, pausedMs: 20 * MIN });
  });

  it('is all zero for a Run without records', () => {
    expect(
      runTimes(
        { createdAt: at(0), finishedAt: at(1) },
        { attempts: [], approvals: [], events: [] },
      ),
    ).toEqual({
      totalMs: MIN,
      agentMs: 0,
      queuedMs: 0,
      approvalMs: 0,
      blockedMs: 0,
      pausedMs: 0,
    });
  });
});

describe('time texts', () => {
  it('rounds to whole minutes, at least one', () => {
    expect(minutes(0)).toBe(1);
    expect(minutes(20_000)).toBe(1);
    expect(minutes(90_000)).toBe(2);
    expect(minutes(957 * MIN + 10_000)).toBe(957);
  });

  it('leaves out the parts under half a minute', () => {
    expect(
      timeParts([
        ['Agent 执行', 40 * MIN],
        ['排队', 20],
        ['等审批', 0],
        ['卡住等人', 29_999],
        ['暂停', 30_000],
      ]),
    ).toEqual(['Agent 执行 40 分钟', '暂停 1 分钟']);
  });

  it('lists every part of the time but the total, named, in a fixed order', () => {
    const times = {
      pausedMs: 5,
      blockedMs: 4,
      approvalMs: 3,
      queuedMs: 2,
      agentMs: 1,
      totalMs: 100,
    };
    expect(runTimeParts(times)).toEqual([
      ['Agent 执行', 1],
      ['排队', 2],
      ['等审批', 3],
      ['卡住等人', 4],
      ['暂停', 5],
    ]);
  });
});

describe('grouped time parts', () => {
  const times = {
    totalMs: 1000,
    agentMs: 1,
    queuedMs: 20,
    approvalMs: 300,
    blockedMs: 4000,
    pausedMs: 50000,
  };
  const parts = Object.keys(runTimePartLabels()) as RunTimePart[];

  it('puts every part of the time but the total in exactly one group', () => {
    expect(Object.keys(RUN_TIME_PART_GROUP).sort()).toEqual([...parts].sort());
    for (const part of parts) {
      expect(['agent', 'queue', 'human']).toContain(RUN_TIME_PART_GROUP[part]);
    }
  });

  it('lists the agents, the queue and the waiting for a human, in that order', () => {
    expect(groupedTimeParts(times)).toEqual([
      ['Agent 执行', 1],
      ['排队', 20],
      ['等人', 300 + 4000 + 50000],
    ]);
  });

  it('names the agents and the queue as their parts are named', () => {
    const labels = groupedTimeParts(times).map(([label]) => label);
    expect(labels.slice(0, 2)).toEqual([runTimePartLabels().agentMs, runTimePartLabels().queuedMs]);
  });

  it('adds up to the parts of the time', () => {
    const sum = (list: [string, number][]) => list.reduce((s, [, ms]) => s + ms, 0);
    expect(sum(groupedTimeParts(times))).toBe(sum(runTimeParts(times)));
    // A human group is waiting for approvals, replies to a block and resumes.
    const human = groupedTimeParts(times).find(([label]) => label === '等人')?.[1];
    expect(human).toBe(times.approvalMs + times.blockedMs + times.pausedMs);
  });
});

describe('time texts in English', () => {
  afterEach(() => setLang('zh'));

  it("names the parts and groups of a Run's time in English", () => {
    setLang('en');
    const times = {
      totalMs: 100 * MIN,
      agentMs: 40 * MIN,
      queuedMs: 0,
      approvalMs: 2 * MIN,
      blockedMs: 0,
      pausedMs: 0,
    };
    expect(timeParts(runTimeParts(times))).toEqual([
      'Agent work 40 min',
      'Awaiting approval 2 min',
    ]);
    expect(groupedTimeParts(times).map(([label]) => label)).toEqual([
      'Agent work',
      'Queued',
      'Waiting for a human',
    ]);
  });
});
