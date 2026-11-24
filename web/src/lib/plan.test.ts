import { afterEach, describe, expect, it } from 'vitest';
import { setLang } from '../../../src/i18n.js';
import type { Task } from '../../../src/store/types.js';
import { roundTasks, stepLabel, stepsDoneText, taskTitle } from './plan.js';

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
});
