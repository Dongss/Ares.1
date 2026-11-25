import { afterEach, describe, expect, it } from 'vitest';
import {
  conflictWaitSpans,
  groupedTimeParts,
  minutes,
  RUN_TIME_PART_GROUP,
  type RunRecords,
  type RunTimePart,
  runTimePartLabels,
  runTimeParts,
  runTimes,
  timeParts,
  workSwitchesOf,
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
      conflictWaitMs: 0,
      stoppedMs: 0,
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
      conflictWaitMs: 0,
      stoppedMs: 0,
      approvalMs: 0,
      blockedMs: 0,
      pausedMs: 0,
    });
  });

  describe('with work switched off', () => {
    const turned = (on: boolean, min: number) => ({ ts: at(min), on });
    const none = { attempts: [], approvals: [] };
    // Queued from 0 to 30, running to 40, paused to 60, queued again to 70, running to 80.
    const events = [
      status('running', 30),
      status('paused', 40),
      status('queued', 60),
      status('running', 70),
      status('completed', 80),
    ];
    const finished = { createdAt: at(0), finishedAt: at(80) };

    it('tells the time queued with work switched off apart from the queue', () => {
      // Off from 10 to 25, while queued.
      const times = runTimes(finished, {
        ...none,
        events,
        workSwitches: [turned(false, 10), turned(true, 25)],
      });
      expect(times).toMatchObject({
        queuedMs: (10 + 5 + 10) * MIN,
        stoppedMs: 15 * MIN,
        pausedMs: 20 * MIN,
      });
    });

    it('counts work switched off before the Run was created', () => {
      // Off since before the Run, on again at 20; off again from 65 to after the Run finished.
      const times = runTimes(finished, {
        ...none,
        events,
        workSwitches: [turned(true, -100), turned(false, -50), turned(true, 20), turned(false, 65)],
      });
      expect(times).toMatchObject({
        queuedMs: (10 + 5) * MIN,
        stoppedMs: (20 + 5) * MIN,
      });
      // Off all along: the Run's whole time in the queue was waiting for work to be switched on.
      expect(
        runTimes(finished, { ...none, events, workSwitches: [turned(false, -1)] }),
      ).toMatchObject({ queuedMs: 0, stoppedMs: 40 * MIN });
    });

    it('does not take the switch while the Run is running or paused', () => {
      // Off from 32 to 38 (running) and from 45 to 55 (paused): the queue keeps all its time.
      const times = runTimes(finished, {
        ...none,
        events,
        workSwitches: [turned(false, 32), turned(true, 38), turned(false, 45), turned(true, 55)],
      });
      expect(times).toEqual(runTimes(finished, { ...none, events }));
      expect(times).toMatchObject({ queuedMs: 40 * MIN, stoppedMs: 0, pausedMs: 20 * MIN });
      // Switched off while running and on while paused: the queue before and after is all queue.
      expect(
        runTimes(finished, {
          ...none,
          events,
          workSwitches: [turned(false, 35), turned(true, 50)],
        }),
      ).toMatchObject({ queuedMs: 40 * MIN, stoppedMs: 0 });
      // Switched off while paused: the Run is resumed into the queue with work off.
      expect(
        runTimes(finished, {
          ...none,
          events,
          workSwitches: [turned(false, 50), turned(true, 64)],
        }),
      ).toMatchObject({ queuedMs: (30 + 6) * MIN, stoppedMs: 4 * MIN, pausedMs: 20 * MIN });
    });

    it('is as without switches when work stayed on', () => {
      const without = runTimes(created, records);
      expect(runTimes(created, { ...records, workSwitches: [] })).toEqual(without);
      expect(
        runTimes(created, { ...records, workSwitches: [turned(true, -10), turned(true, 3)] }),
      ).toEqual(without);
    });

    it('does not count a stretch in the queue that is not over yet', () => {
      expect(
        runTimes(created, { ...none, events: [], workSwitches: [turned(false, 1)] }),
      ).toMatchObject({ queuedMs: 0, stoppedMs: 0 });
    });

    it('counts switches on and off within one stretch in the queue', () => {
      const times = runTimes(finished, {
        ...none,
        events,
        workSwitches: [
          turned(false, 2),
          turned(true, 4),
          // Switched off twice in a row: off from the first.
          turned(false, 10),
          turned(false, 12),
          turned(true, 20),
          // Switched on again just as the Run started running.
          turned(false, 28),
          turned(true, 30),
        ],
      });
      expect(times).toMatchObject({ queuedMs: (30 - 14) * MIN + 10 * MIN, stoppedMs: 14 * MIN });
    });
  });

  describe('waiting for an overlapping Run', () => {
    const none = { attempts: [], approvals: [] };
    const waiting = (min: number, blockedBy = 'run-a', paths = ['src/a.ts']) =>
      event('run.waiting_conflict', min, { stageId: 'assess', blockedBy, paths });
    const finished = { createdAt: at(0), finishedAt: at(50) };

    it('tells the wait after the assessment apart from the queue, until the Run starts again', () => {
      // Assessed from 0 to 5, then back in the queue for run-a (the wait is recorded just before
      // the requeue), and for run-b from 20 on: one wait, until the Run starts again at 40.
      const events = [
        status('running', 0),
        waiting(5),
        status('queued', 5),
        waiting(20, 'run-b'),
        status('running', 40),
        status('completed', 50),
      ];
      expect(runTimes(finished, { ...none, events })).toMatchObject({
        queuedMs: 0,
        conflictWaitMs: 35 * MIN,
      });
    });

    it('divides the time as before without such a wait', () => {
      const events = [
        status('running', 0),
        status('queued', 5),
        status('running', 40),
        status('completed', 50),
      ];
      expect(runTimes(finished, { ...none, events })).toMatchObject({
        queuedMs: 35 * MIN,
        conflictWaitMs: 0,
      });
    });

    it('counts a wait that began in the queue from when it was recorded', () => {
      // Passed by in the queue from 10 on; it waits on until it leaves the queue at 30.
      const events = [waiting(10), status('running', 30), status('completed', 50)];
      expect(runTimes(finished, { ...none, events })).toMatchObject({
        queuedMs: 10 * MIN,
        conflictWaitMs: 20 * MIN,
      });
    });

    it('ends the wait when the Run leaves the queue, and does not count a wait not over', () => {
      // Paused while waiting at 15, resumed into the queue at 25 waiting for nothing.
      const events = [
        status('running', 0),
        waiting(5),
        status('queued', 5),
        status('paused', 15),
        status('queued', 25),
        status('running', 30),
        status('completed', 50),
      ];
      expect(runTimes(finished, { ...none, events })).toMatchObject({
        queuedMs: 5 * MIN,
        conflictWaitMs: 10 * MIN,
        pausedMs: 10 * MIN,
      });
      const still = [status('running', 0), waiting(5), status('queued', 5)];
      expect(runTimes(created, { ...none, events: still })).toMatchObject({
        queuedMs: 0,
        conflictWaitMs: 0,
      });
    });

    it('counts the time work was switched off as stopped, not as waiting', () => {
      const events = [
        status('running', 0),
        waiting(5),
        status('queued', 5),
        status('running', 40),
        status('completed', 50),
      ];
      const times = runTimes(finished, {
        ...none,
        events,
        workSwitches: [
          { ts: at(10), on: false },
          { ts: at(20), on: true },
        ],
      });
      expect(times).toMatchObject({ queuedMs: 0, stoppedMs: 10 * MIN, conflictWaitMs: 25 * MIN });
      // Nothing is counted twice: the parts add up to the time not spent executing.
      expect(times.queuedMs + times.stoppedMs + times.conflictWaitMs).toBe(35 * MIN);
    });
  });
});

describe('conflictWaitSpans', () => {
  let id = 0;
  const event = (type: string, min: number, data: Record<string, unknown> = {}) => ({
    id: ++id,
    type,
    ts: at(min),
    data,
  });

  it('gives each wait, its Run and paths, until the Run leaves the queue or waits for another', () => {
    const first = event('run.waiting_conflict', 5, { blockedBy: 'run-a', paths: ['src/a', 3] });
    const queued = event('run.status', 5, { status: 'queued' });
    const second = event('run.waiting_conflict', 9, { blockedBy: 'run-b', paths: ['docs'] });
    const running = event('run.status', 12, { status: 'running' });
    const third = event('run.waiting_conflict', 20, { blockedBy: 'run-a' });
    expect(conflictWaitSpans([third, running, second, queued, first])).toEqual([
      {
        runId: 'run-a',
        paths: ['src/a'],
        fromId: first.id,
        from: at(5),
        toId: second.id,
        to: at(9),
      },
      {
        runId: 'run-b',
        paths: ['docs'],
        fromId: second.id,
        from: at(9),
        toId: running.id,
        to: at(12),
      },
      // Still waiting.
      {
        runId: 'run-a',
        paths: [],
        fromId: third.id,
        from: at(20),
        toId: Number.POSITIVE_INFINITY,
        to: null,
      },
    ]);
  });

  it('starts no wait from an event without the Run waited for', () => {
    const events = [
      event('run.waiting_conflict', 1, { blockedBy: 'run-a' }),
      event('run.waiting_conflict', 2, {}),
      event('run.status', 3, { status: 'running' }),
    ];
    expect(conflictWaitSpans(events).map((w) => [w.runId, w.to])).toEqual([['run-a', at(2)]]);
  });
});

describe('workSwitchesOf', () => {
  it('reads the switches from the master.working events, leaving out those without on/off', () => {
    const types: string[] = [];
    const switches = workSwitchesOf({
      listGlobalEventsOfType: (type) => {
        types.push(type);
        return [
          { ts: at(1), data: { on: false } },
          { ts: at(2), data: {} },
          { ts: at(3), data: { on: 'true' } },
          { ts: at(4), data: { on: true } },
        ];
      },
    });
    expect(types).toEqual(['master.working']);
    expect(switches).toEqual([
      { ts: at(1), on: false },
      { ts: at(4), on: true },
    ]);
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
      stoppedMs: 6,
      conflictWaitMs: 7,
      queuedMs: 2,
      agentMs: 1,
      totalMs: 100,
    };
    expect(runTimeParts(times)).toEqual([
      ['Agent 执行', 1],
      ['排队', 2],
      ['错开等待', 7],
      ['停工', 6],
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
    conflictWaitMs: 7000000,
    stoppedMs: 600000,
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
    // Waiting for an overlapping Run is waiting in the queue, for another Run.
    expect(groupedTimeParts(times)).toEqual([
      ['Agent 执行', 1],
      ['排队', 20 + 7000000],
      ['等人', 600000 + 300 + 4000 + 50000],
    ]);
  });

  it('names the agents and the queue as their parts are named', () => {
    const labels = groupedTimeParts(times).map(([label]) => label);
    expect(labels.slice(0, 2)).toEqual([runTimePartLabels().agentMs, runTimePartLabels().queuedMs]);
  });

  it('adds up to the parts of the time', () => {
    const sum = (list: [string, number][]) => list.reduce((s, [, ms]) => s + ms, 0);
    expect(sum(groupedTimeParts(times))).toBe(sum(runTimeParts(times)));
    // A human group is waiting for work to be switched on, approvals, replies to a block and
    // resumes.
    const human = groupedTimeParts(times).find(([label]) => label === '等人')?.[1];
    expect(human).toBe(times.stoppedMs + times.approvalMs + times.blockedMs + times.pausedMs);
  });
});

describe('time texts in English', () => {
  afterEach(() => setLang('zh'));

  it("names the parts and groups of a Run's time in English", () => {
    setLang('en');
    const times = {
      totalMs: 100 * MIN,
      agentMs: 40 * MIN,
      queuedMs: 3 * MIN,
      conflictWaitMs: 4 * MIN,
      stoppedMs: 50 * MIN,
      approvalMs: 2 * MIN,
      blockedMs: 0,
      pausedMs: 0,
    };
    expect(timeParts(runTimeParts(times))).toEqual([
      'Agent work 40 min',
      'Queued 3 min',
      'Waiting for an overlapping Run 4 min',
      'Work switched off 50 min',
      'Awaiting approval 2 min',
    ]);
    expect(timeParts(groupedTimeParts(times))).toEqual([
      'Agent work 40 min',
      'Queued 7 min',
      'Waiting for a human 52 min',
    ]);
    expect(groupedTimeParts(times).map(([label]) => label)).toEqual([
      'Agent work',
      'Queued',
      'Waiting for a human',
    ]);
  });

  it('names every part of the time in English, without Chinese left', () => {
    setLang('en');
    const labels = Object.values(runTimePartLabels());
    expect(labels).toContain('Work switched off');
    for (const label of labels) expect(label).not.toMatch(/[一-鿿]/);
  });
});
