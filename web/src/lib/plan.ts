// How the Run page shows the tasks of a stage round its plan split into steps (`planning: llm`).

import { type PlanStep, planSteps } from '../../../src/engine/plan.js';
import { t } from '../../../src/i18n.js';
import type { Task } from '../../../src/store/types.js';

/** A task of a stage round as its block shows it. */
export interface RoundTask {
  task: Task;
  /** Its step when the round's plan split it into several; undefined otherwise. */
  step: PlanStep | undefined;
}

/**
 * The tasks of one stage round in the order the page lists them: the plan first, then the others
 * in the order they were created, each with its step when the plan split the round into several.
 */
export function roundTasks(tasks: readonly Task[]): RoundTask[] {
  const rank = (task: Task) => (task.kind === 'plan' ? 0 : 1);
  const ordered = [...tasks].sort((a, b) => rank(a) - rank(b) || a.seq - b.seq);
  const steps = planSteps(ordered);
  return ordered.map((task) => ({ task, step: steps.get(task.id) }));
}

/**
 * A task's title. The plan's title was written in the Master's language when it was created;
 * the page says it in its own.
 */
export function taskTitle(task: Pick<Task, 'kind' | 'title'>): string {
  return task.kind === 'plan' ? t({ zh: '拆分任务', en: 'Plan the tasks' }) : task.title;
}

/** 「第 2/3 步」, shown before the title of a step. */
export function stepLabel(step: PlanStep): string {
  return t({ zh: `第 ${step.index}/${step.total} 步`, en: `Step ${step.index}/${step.total}` });
}

/**
 * 「已完成 1/3 步」, how far the steps of a stage round got, beside the round's title; null when
 * the round was not split into steps.
 */
export function stepsDoneText(tasks: readonly RoundTask[]): string | null {
  const steps = tasks.filter((x) => x.step !== undefined);
  if (steps.length === 0) return null;
  const done = steps.filter((x) => x.task.status === 'passed').length;
  const total = steps.length;
  return t({ zh: `已完成 ${done}/${total} 步`, en: `${done} of ${total} steps done` });
}
