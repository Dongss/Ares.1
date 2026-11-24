import { afterEach, describe, expect, it } from 'vitest';
import { setLang } from '../../../src/i18n.js';
import type { AssessmentEntry, RequirementSize, Task } from '../../../src/store/types.js';
import { autoPlanText, roundTasks, stepLabel, stepsDoneText, taskTitle } from './plan.js';

afterEach(() => setLang('zh'));

function task(seq: number, extra: Partial<Task> = {}): Task {
  return {
    id: `task-${seq}`,
    runId: 'run-1',
    stageRunId: 'sr-1',
    seq,
    kind: 'work',
    title: `t${seq}`,
    instructions: '',
    agentId: 'coder',
    status: 'pending',
    retries: 0,
    baseCommit: null,
    commitSha: null,
    sessionId: null,
    sessionAgentId: null,
    pendingFeedback: null,
    createdAt: '2026-11-24T00:00:00.000Z',
    updatedAt: '2026-11-24T00:00:00.000Z',
    ...extra,
  };
}

const plan = (extra: Partial<Task> = {}) =>
  task(1, { id: 'plan', kind: 'plan', title: '拆分任务', status: 'passed', ...extra });

const view = (tasks: Task[]) =>
  roundTasks(tasks).map(({ task, step }) => [task.id, step && stepLabel(step)]);

describe('roundTasks', () => {
  it('lists the plan first, then the steps in the order they were created, numbered', () => {
    const tasks = [task(3), task(4), plan(), task(2)];
    expect(view(tasks)).toEqual([
      ['plan', undefined],
      ['task-2', '第 1/3 步'],
      ['task-3', '第 2/3 步'],
      ['task-4', '第 3/3 步'],
    ]);
  });

  it('numbers nothing in a round without a plan, or whose plan gave a single step', () => {
    expect(view([task(1)])).toEqual([['task-1', undefined]]);
    expect(view([plan(), task(2)])).toEqual([
      ['plan', undefined],
      ['task-2', undefined],
    ]);
    // The plan has not passed yet.
    expect(view([plan({ status: 'running' })])).toEqual([['plan', undefined]]);
  });
});

describe('stepsDoneText', () => {
  it('counts the steps that passed, and nothing in a round not split into steps', () => {
    const tasks = [plan(), task(2, { status: 'passed' }), task(3, { status: 'running' }), task(4)];
    expect(stepsDoneText(roundTasks(tasks))).toBe('已完成 1/3 步');
    expect(stepsDoneText(roundTasks([plan(), task(2, { status: 'passed' })]))).toBeNull();
    expect(stepsDoneText(roundTasks([task(1, { status: 'passed' })]))).toBeNull();
  });
});

describe('taskTitle', () => {
  it('names the plan in the language of the page, other tasks by their own titles', () => {
    expect(taskTitle(plan())).toBe('拆分任务');
    expect(taskTitle(task(2, { title: '加上接口' }))).toBe('加上接口');
    setLang('en');
    expect(taskTitle(plan())).toBe('Plan the tasks');
  });
});

describe('autoPlanText', () => {
  const at = (hour: number) => `2026-11-24T${String(hour).padStart(2, '0')}:00:00.000Z`;
  const assessed = (
    verdict: AssessmentEntry['verdict'],
    size: RequirementSize | undefined,
    hour = 1,
  ): AssessmentEntry => ({
    role: 'assessor',
    verdict,
    summary: 's',
    questions: [],
    suggestions: [],
    revisedGoal: null,
    ...(size ? { size } : {}),
    proposedDrop: false,
    stageRunId: 'sr-assess',
    at: at(hour),
  });
  const auto = { kind: 'agent', planning: 'auto' } as const;

  it('says the round was split for a requirement sized L', () => {
    expect(autoPlanText(auto, [assessed('go', 'L')], at(2))).toBe(
      '按需求规模拆分：需求评估给出的规模是 L，这一轮先拆分任务，再一步一步做。',
    );
  });

  it('says the round was done in one go for S, M or no size', () => {
    expect(autoPlanText(auto, [assessed('go', 'M')], at(2))).toBe(
      '按需求规模拆分：需求评估给出的规模是 M，只有 L 才拆分，这一轮整个阶段一次做完。',
    );
    expect(autoPlanText(auto, [assessed('go', 'S')], at(2))).toContain('规模是 S');
    const none = '按需求规模拆分：没有需求评估给出的规模，这一轮不拆分，整个阶段一次做完。';
    expect(autoPlanText(auto, [assessed('go', undefined)], at(2))).toBe(none);
    // Without an assessment, or with only one that did not go ahead.
    expect(autoPlanText(auto, [], at(2))).toBe(none);
    expect(autoPlanText(auto, [assessed('ask', 'L')], at(2))).toBe(none);
  });

  it('goes by the assessments before the round started', () => {
    const discussion = [assessed('go', 'M', 1), assessed('go', 'L', 3)];
    expect(autoPlanText(auto, discussion, at(2))).toContain('规模是 M');
    expect(autoPlanText(auto, discussion, at(3))).toContain('规模是 L，这一轮先拆分');
  });

  it('says nothing for stages that do not plan by size', () => {
    const discussion = [assessed('go', 'L')];
    expect(autoPlanText({ kind: 'agent', planning: 'single' }, discussion, at(2))).toBeNull();
    expect(autoPlanText({ kind: 'agent', planning: 'llm' }, discussion, at(2))).toBeNull();
    expect(autoPlanText({ kind: 'review', planning: 'auto' }, discussion, at(2))).toBeNull();
  });
});

describe('in English', () => {
  it('has no Chinese characters left', () => {
    setLang('en');
    const tasks = roundTasks([plan(), task(2, { status: 'passed' }), task(3)]);
    const texts = [
      ...tasks.flatMap(({ step }) => (step ? [stepLabel(step)] : [])),
      stepsDoneText(tasks),
      taskTitle(plan()),
    ];
    expect(texts).toEqual(['Step 1/2', 'Step 2/2', '1 of 2 steps done', 'Plan the tasks']);
    for (const text of texts) expect(text).not.toMatch(/\p{Script=Han}/u);
  });

  it('says whether a round planning by size was split, without Chinese characters', () => {
    setLang('en');
    const auto = { kind: 'agent', planning: 'auto' } as const;
    const go = (size?: RequirementSize): AssessmentEntry => ({
      role: 'assessor',
      verdict: 'go',
      summary: '需求清楚',
      questions: [],
      suggestions: [],
      revisedGoal: null,
      ...(size ? { size } : {}),
      proposedDrop: false,
      stageRunId: 'sr-assess',
      at: '2026-11-24T01:00:00.000Z',
    });
    const started = '2026-11-24T02:00:00.000Z';
    const texts = [
      autoPlanText(auto, [go('L')], started),
      autoPlanText(auto, [go('M')], started),
      autoPlanText(auto, [go()], started),
    ];
    expect(texts).toEqual([
      "Split by the requirement's size: the assessment sized it L, so this round is planned first and done step by step.",
      "Split by the requirement's size: the assessment sized it M, and only an L is split, so this round does the whole stage in one go.",
      "Split by the requirement's size: no assessment gave a size, so this round is not split and does the whole stage in one go.",
    ]);
    for (const text of texts) expect(text).not.toMatch(/\p{Script=Han}/u);
  });
});
