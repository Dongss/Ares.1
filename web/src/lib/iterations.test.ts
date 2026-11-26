import { afterEach, describe, expect, it } from 'vitest';
import type { IterationChildView, IterationView } from '../../../src/api/types.js';
import { setLang } from '../../../src/i18n.js';
import { ITERATION_STATUSES } from '../../../src/store/types.js';
import {
  blockedHint,
  blockedText,
  blockingSteps,
  canRejectIteration,
  childBadge,
  criteriaText,
  criterionSteps,
  decisionLabel,
  dependencyText,
  elapsedText,
  githubHint,
  ITERATION_CHILD_STATUS,
  ITERATION_STATUS,
  isOpen,
  iterationActions,
  iterationCostText,
  iterationNote,
  iterationsOutdatedBy,
  mergeIterations,
  openIterations,
  overallKindText,
  pendingHint,
  progressPercent,
  progressText,
  replacedText,
  runCountText,
  runningText,
  sortIterations,
  stepAttemptsText,
  stepName,
  stepsName,
  wasAccepted,
} from './iterations.js';

afterEach(() => setLang('zh'));

const CHINESE = /[一-鿿]/;

const child = (position: number, over: Partial<IterationChildView> = {}): IterationChildView => ({
  title: `Step title ${position}`,
  category: 'feature',
  size: 'M',
  risk: 'low',
  why: 'why',
  evidence: [],
  what: 'what',
  acceptance: [],
  position,
  criteria: [1],
  dependsOn: [],
  closeout: false,
  status: 'waiting',
  runIds: [],
  waitingFor: [],
  runs: [],
  attempt: null,
  maxAttempts: null,
  redoAt: null,
  failures: [],
  restartable: false,
  ...over,
});

const iteration = (over: Partial<IterationView> = {}): IterationView => ({
  id: 'iteration-1',
  repoId: 'repo-1',
  scoutId: null,
  source: 'github',
  issuesRepo: 'me/demo',
  issue: { number: 12, url: 'https://github.com/me/demo/issues/12' },
  title: 'Iteration',
  goal: 'Goal',
  readmeGoal: 'Perpetual motion',
  criteria: ['Can be shown'],
  outOfScope: [],
  children: [],
  notes: [],
  status: 'active',
  auto: false,
  summaryPosted: false,
  summary: null,
  createdAt: '2026-11-20T00:00:00.000Z',
  decidedAt: '2026-11-20T01:00:00.000Z',
  endedAt: null,
  repo: 'demo',
  progress: { done: 0, total: 0 },
  totals: { runs: 0, costUsd: 0, costUnknown: false, elapsedMs: null, agentMs: 0 },
  ...over,
});

describe('status labels', () => {
  it('names every status of iterations and steps in the language in use', () => {
    expect(ITERATION_STATUSES.map((s) => ITERATION_STATUS[s].label)).toEqual([
      '待采纳',
      '进行中',
      '受阻',
      '已完成',
      '不做了',
    ]);
    expect(ITERATION_STATUS.blocked.tone).toBe('danger');
    expect(ITERATION_CHILD_STATUS.waiting.label).toBe('等依赖');
    expect(childBadge(child(1, { status: 'failed' }))).toEqual({ label: '失败', tone: 'danger' });
    // A step another took over from is shown as replaced, whatever became of it.
    expect(childBadge(child(1, { status: 'failed', replacedBy: 3 }))).toEqual({
      label: '已替换',
      tone: 'muted',
    });
    setLang('en');
    expect(ITERATION_STATUS.pending.label).toBe('Pending');
    expect(ITERATION_CHILD_STATUS.running.label).toBe('In progress');
    expect(childBadge(child(1, { replacedBy: 3 })).label).toBe('Replaced');
    for (const table of [ITERATION_STATUS, ITERATION_CHILD_STATUS]) {
      for (const badge of Object.values(table)) expect(badge.label).not.toMatch(CHINESE);
    }
  });
});

describe('lists of iterations', () => {
  it('merges lists, each iteration once as the first list has it', () => {
    const a = iteration({ id: 'a', title: 'first' });
    const b = iteration({ id: 'b' });
    expect(
      mergeIterations([a], [iteration({ id: 'a', title: 'second' }), b]).map((i) => i.title),
    ).toEqual(['first', 'Iteration']);
  });

  it('puts blocked ones first, then pending, then under way, then the most recently ended', () => {
    const at = (day: number) => `2026-11-${String(day).padStart(2, '0')}T00:00:00.000Z`;
    const list = [
      iteration({ id: 'done-old', status: 'done', createdAt: at(1), endedAt: at(5) }),
      iteration({ id: 'active-old', status: 'active', createdAt: at(2) }),
      iteration({ id: 'cancelled-new', status: 'cancelled', createdAt: at(3), endedAt: at(9) }),
      iteration({ id: 'pending', status: 'pending', createdAt: at(4), decidedAt: null }),
      iteration({ id: 'active-new', status: 'active', createdAt: at(6) }),
      iteration({ id: 'blocked', status: 'blocked', createdAt: at(1) }),
    ];
    expect(sortIterations(list).map((i) => i.id)).toEqual([
      'blocked',
      'pending',
      'active-new',
      'active-old',
      'cancelled-new',
      'done-old',
    ]);
    expect(openIterations(list, null).map((i) => i.id)).toEqual([
      'blocked',
      'pending',
      'active-new',
      'active-old',
    ]);
    expect(isOpen(iteration({ status: 'done' }))).toBe(false);
  });

  it('keeps the iterations not over of one repo when the Runs are filtered by it', () => {
    const list = [
      iteration({ id: 'a', repoId: 'repo-1' }),
      iteration({ id: 'b', repoId: 'repo-2', status: 'blocked' }),
      iteration({ id: 'c', repoId: 'repo-2', status: 'done' }),
    ];
    expect(openIterations(list, 'repo-2').map((i) => i.id)).toEqual(['b']);
    expect(openIterations(list, 'repo-3')).toEqual([]);
  });
});

describe('progress', () => {
  it('says how many steps are done of all, and how full the bar is', () => {
    const it2of5 = iteration({ progress: { done: 2, total: 5 } });
    expect(progressText(it2of5.progress)).toBe('完成 2/5');
    expect(progressPercent(it2of5)).toBe(40);
    expect(progressPercent(iteration({ progress: { done: 0, total: 0 } }))).toBe(0);
    expect(progressPercent(iteration({ status: 'done', progress: { done: 0, total: 0 } }))).toBe(
      100,
    );
    setLang('en');
    expect(progressText(it2of5.progress)).toBe('2 of 5 done');
  });

  it('counts Runs, cost and time', () => {
    expect(runCountText(3)).toBe('3 个 Run');
    expect(iterationCostText(iteration({ totals: { ...iteration().totals, costUsd: 1.5 } }))).toBe(
      '$1.50',
    );
    expect(
      iterationCostText(
        iteration({ totals: { ...iteration().totals, costUsd: 1.5, costUnknown: true } }),
      ),
    ).toBe('$1.50 + 未知');
    const took = iteration({ totals: { ...iteration().totals, elapsedMs: 125 * 60_000 } });
    expect(elapsedText(took)).toBe('用时 2 小时 5 分');
    expect(elapsedText(iteration({ status: 'pending', decidedAt: null }))).toBeNull();
    setLang('en');
    expect(runCountText(1)).toBe('1 Run');
    expect(runCountText(2)).toBe('2 Runs');
    expect(elapsedText(took)).toBe('took 2h 5m');
  });
});

describe('decisions', () => {
  it('tells an iteration turned down while pending from one cancelled once accepted', () => {
    const at = '2026-11-20T02:00:00.000Z';
    const rejected = iteration({ status: 'cancelled', decidedAt: at, endedAt: at });
    const cancelled = iteration({ status: 'cancelled', endedAt: at });
    const totals = { ...iteration().totals, elapsedMs: 0 };
    expect(wasAccepted(iteration({ status: 'pending', decidedAt: null }))).toBe(false);
    expect(wasAccepted(rejected)).toBe(false);
    expect(wasAccepted(cancelled)).toBe(true);
    expect(wasAccepted(iteration({ status: 'done', endedAt: at }))).toBe(true);
    expect(decisionLabel(rejected)).toBe('拒绝');
    expect(decisionLabel(cancelled)).toBe('采纳');
    expect(decisionLabel(iteration({ status: 'pending', decidedAt: null }))).toBeNull();
    // Never accepted: no time to tell.
    expect(elapsedText({ ...rejected, totals })).toBeNull();
    expect(elapsedText({ ...cancelled, totals: { ...totals, elapsedMs: 60_000 } })).toBe(
      '用时 1 分 0 秒',
    );
    setLang('en');
    expect(decisionLabel(rejected)).toBe('Rejected');
    expect(decisionLabel(cancelled)).toBe('Accepted');
  });

  it('decides iterations of the local backlog on the dashboard, those of GitHub on GitHub', () => {
    const local = (status: IterationView['status']) => iteration({ source: 'local', status });
    expect(iterationActions(local('pending'))).toEqual({ decide: true, cancel: false });
    expect(iterationActions(local('active'))).toEqual({ decide: false, cancel: true });
    expect(iterationActions(local('blocked'))).toEqual({ decide: false, cancel: true });
    expect(iterationActions(local('done'))).toEqual({ decide: false, cancel: false });
    expect(iterationActions(local('cancelled'))).toEqual({ decide: false, cancel: false });
    for (const status of ITERATION_STATUSES) {
      expect(iterationActions(iteration({ status }))).toEqual({ decide: false, cancel: false });
    }
    expect(canRejectIteration(local('pending'), ' 不做 ')).toBe(true);
    expect(canRejectIteration(local('pending'), ' \n ')).toBe(false);
    expect(canRejectIteration(local('active'), '不做')).toBe(false);
    expect(canRejectIteration(iteration({ status: 'pending' }), '不做')).toBe(false);

    expect(githubHint(iteration({ status: 'pending' }))).toContain('ares1:ready');
    expect(githubHint(iteration({ status: 'done' }))).toBeNull();
    expect(githubHint(local('pending'))).toBeNull();
    expect(pendingHint(iteration({ status: 'pending' }))).toContain('GitHub');
    expect(pendingHint(local('pending'))).toBe('等采纳：在迭代页整体采纳，或者填上理由拒绝');
    expect(pendingHint(local('active'))).toBeNull();
  });
});

describe('steps', () => {
  it('names steps by their place in the plan', () => {
    expect(stepName(2)).toBe('第 2 步');
    expect(stepsName([1, 3])).toBe('第 1、3 步');
    setLang('en');
    expect(stepName(2)).toBe('step 2');
    expect(stepsName([1])).toBe('step 1');
    expect(stepsName([1, 3])).toBe('steps 1, 3');
  });

  it('says what a step waits for, depends on, or who took over from it', () => {
    expect(dependencyText(child(3, { dependsOn: [1, 2], waitingFor: [2] }))).toEqual({
      text: '在等第 2 步完成',
      waiting: true,
    });
    expect(dependencyText(child(3, { status: 'done', dependsOn: [1, 2] }))).toEqual({
      text: '依赖第 1、2 步',
      waiting: false,
    });
    // Planned: what it will wait for once accepted.
    expect(
      dependencyText(child(2, { status: 'planned', dependsOn: [1], waitingFor: [1] })),
    ).toEqual({ text: '依赖第 1 步', waiting: false });
    expect(dependencyText(child(1))).toBeNull();
    expect(dependencyText(child(2, { dependsOn: [1], replacedBy: 4 }))).toBeNull();
    expect(replacedText(child(2, { replacedBy: 4 }))).toBe('已由第 4 步换个做法接替');
    expect(replacedText(child(2))).toBeNull();
    setLang('en');
    expect(dependencyText(child(3, { waitingFor: [1, 2], dependsOn: [1, 2] }))?.text).toBe(
      'Waiting for steps 1, 2 to be done',
    );
    expect(dependencyText(child(3, { status: 'running', dependsOn: [1] }))?.text).toBe(
      'Depends on step 1',
    );
    expect(replacedText(child(2, { replacedBy: 4 }))).toBe(
      'Taken over by step 4 with another approach',
    );
  });

  it('links completion criteria and the steps that move them forward', () => {
    const it = iteration({
      children: [
        child(1, { criteria: [1] }),
        child(2, { criteria: [1, 2] }),
        child(3, { criteria: [2], replacedBy: 4 }),
        child(4, { criteria: [2] }),
      ],
    });
    expect(criterionSteps(it, 1)).toBe('第 1、2 步');
    expect(criterionSteps(it, 2)).toBe('第 2、4 步');
    expect(criterionSteps(it, 3)).toBeNull();
    expect(criteriaText([1, 3])).toBe('推进完成标准第 1、3 条');
    expect(criteriaText([])).toBeNull();
    setLang('en');
    expect(criteriaText([2])).toBe('Moves completion criterion 2 forward');
    expect(criteriaText([1, 3])).toBe('Moves completion criteria 1, 3 forward');
  });

  it('judges the iteration as a whole by its riskiest and largest step', () => {
    const it = iteration({
      children: [child(1, { risk: 'mid', size: 'S' }), child(2, { risk: 'low', size: 'L' })],
    });
    expect(overallKindText(it)).toBe('整体：风险中 · L');
    setLang('en');
    expect(overallKindText(it)).toBe('As a whole: medium risk · L');
  });
});

describe('where an iteration stands', () => {
  const blocked = iteration({
    status: 'blocked',
    children: [
      child(1, { status: 'done' }),
      child(2, { status: 'failed', title: '接入 GitLab' }),
      child(3, { status: 'failed', replacedBy: 5 }),
      child(4, { status: 'waiting', dependsOn: [2], waitingFor: [2] }),
      child(5, { status: 'running' }),
    ],
  });

  it('tells what blocks it: the steps failed or dropped that nothing replaced', () => {
    expect(blockingSteps(blocked).map((c) => c.position)).toEqual([2]);
    expect(blockedText(blocked)).toBe('第 2 步「接入 GitLab」失败了，依赖它的步骤不能开工');
    const two = iteration({
      status: 'blocked',
      children: [child(1, { status: 'failed' }), child(2, { status: 'dropped' })],
    });
    expect(blockedText(two)).toBe(
      '第 1 步「Step title 1」失败了、第 2 步「Step title 2」不做了，依赖它们的步骤不能开工',
    );
    expect(blockedText({ ...blocked, status: 'active' })).toBeNull();
    expect(blockedHint(blocked)).toContain('ares1:ready');
    expect(blockedHint(iteration({ source: 'local' }))).toContain('终止这个迭代');
    expect(blockedHint(iteration({ source: 'local' }))).not.toContain('重新开始');
    // A step of the local backlog whose attempts were used up may be started over.
    const restartable = iteration({
      source: 'local',
      status: 'blocked',
      children: [child(1, { status: 'failed', restartable: true })],
    });
    expect(blockedHint(restartable)).toBe(
      '下次侦察会换个做法补一步替换它，替换后迭代接着做；也可以修好原因后在下面的计划里点那一步的「重新开始」，次数从头算；不想做剩下的，就终止这个迭代',
    );
    setLang('en');
    expect(blockedText(two)).toBe(
      'Step 1 “Step title 1” failed, step 2 “Step title 2” was dropped, so the steps depending on them cannot start',
    );
    expect(blockedHint(restartable)).toContain('use "Start over" on that step');
  });

  it('tells which attempt a step of the local backlog is at, of how many it gets', () => {
    const failure = { runId: 'run-1', attempt: 1, stage: null, error: 'x' };
    // On GitHub, and before its first Run failed: nothing to tell.
    expect(stepAttemptsText(child(1, { status: 'running' }))).toBeNull();
    expect(
      stepAttemptsText(child(1, { status: 'running', attempt: 1, maxAttempts: 3 })),
    ).toBeNull();
    const redoing = child(1, {
      status: 'running',
      attempt: 2,
      maxAttempts: 3,
      failures: [failure],
    });
    expect(stepAttemptsText(redoing)).toBe('第 2/3 次尝试');
    // Its first Run failed and waits to be redone.
    expect(stepAttemptsText({ ...redoing, attempt: 1 })).toBe('第 1/3 次尝试');
    expect(stepAttemptsText({ ...redoing, status: 'failed', attempt: 3 })).toBe('第 3/3 次尝试');
    expect(stepAttemptsText({ ...redoing, maxAttempts: null })).toBe('第 2 次尝试');
    // Done, dropped or not started: its Runs show for themselves.
    for (const status of ['done', 'dropped', 'waiting'] as const) {
      expect(stepAttemptsText({ ...redoing, status }), status).toBeNull();
    }
    setLang('en');
    expect(stepAttemptsText(redoing)).toBe('Attempt 2 of 3');
  });

  it('says on a card what blocks it, who accepts it, or what is under way', () => {
    expect(iterationNote(blocked)).toEqual({
      text: '第 2 步「接入 GitLab」失败了，依赖它的步骤不能开工',
      tone: 'danger',
    });
    expect(iterationNote(iteration({ status: 'pending', source: 'local' }))).toEqual({
      text: '等采纳：在迭代页整体采纳，或者填上理由拒绝',
      tone: 'attention',
    });
    const active = iteration({
      children: [child(1, { status: 'running' }), child(2, { status: 'running', replacedBy: 3 })],
    });
    expect(runningText(active)).toBe('正在做：第 1 步「Step title 1」');
    expect(iterationNote(active)).toEqual({
      text: '正在做：第 1 步「Step title 1」',
      tone: 'active',
    });
    expect(iterationNote(iteration({ children: [child(1)] }))).toBeNull();
    expect(iterationNote(iteration({ status: 'done' }))).toBeNull();
    setLang('en');
    expect(runningText(active)).toBe('Working on step 1 “Step title 1”');
  });

  it('leaves no Chinese in English texts', () => {
    setLang('en');
    const local = iteration({ source: 'local', status: 'pending' });
    const texts = [
      blockedText(iteration({ status: 'blocked', children: [child(1, { status: 'failed' })] })),
      blockedHint(blocked),
      blockedHint(local),
      blockedHint({
        source: 'local',
        children: [child(1, { status: 'failed', restartable: true })],
      }),
      stepAttemptsText(child(1, { status: 'running', attempt: 2, maxAttempts: 3 })),
      pendingHint(local),
      pendingHint(iteration({ status: 'pending' })),
      githubHint(iteration({ status: 'pending' })),
      iterationNote(local)?.text,
      dependencyText(child(2, { waitingFor: [1], dependsOn: [1] }))?.text,
      replacedText(child(2, { replacedBy: 3 })),
      criteriaText([1]),
      criterionSteps(iteration({ children: [child(1)] }), 1),
      overallKindText(iteration({ children: [child(1)] })),
      progressText({ done: 1, total: 2 }),
      runCountText(2),
      iterationCostText(iteration({ totals: { ...iteration().totals, costUnknown: true } })),
      elapsedText(iteration({ totals: { ...iteration().totals, elapsedMs: 3_600_000 } })),
      decisionLabel(iteration()),
    ];
    for (const text of texts) {
      expect(text).toEqual(expect.any(String));
      expect(text).not.toMatch(CHINESE);
    }
  });
});

describe('iterationsOutdatedBy', () => {
  it('reloads iterations on their events, scouts and Runs created or changing status', () => {
    for (const type of [
      'iteration.accepted',
      'iteration.child_status',
      'iteration.blocked',
      'iteration.completed',
      'scout.completed',
      'run.created',
      'run.status',
      // What a step of the local backlog shows of its attempts.
      'proposal.redo_scheduled',
      'proposal.redone',
      'proposal.failed',
      'proposal.restarted',
    ]) {
      expect(iterationsOutdatedBy(type), type).toBe(true);
    }
    for (const type of ['attempt.started', 'proposal.rejected', 'github.error', 'run.blocked']) {
      expect(iterationsOutdatedBy(type), type).toBe(false);
    }
  });
});
