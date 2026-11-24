// Where the work tasks of a stage round stand in the round's plan (`planning: llm`). One rule
// for the engine (each step's prompt and commit), the scout's run digest and the dashboard.
// Pure logic and type imports only: the dashboard imports this file.

import type { Task } from '../store/types.js';

/** A work task's step in the plan of its stage round. */
export interface PlanStep {
  /** Position among the plan's steps, from 1. */
  index: number;
  /** How many steps the plan has. */
  total: number;
}

/**
 * The step of each work task of one stage round, by task id. `tasks` are the round's tasks in the
 * order they were created (`listTasks`); the plan task itself is no step. Empty when the round
 * was not split: it has no plan task (`planning: single`), its plan has not passed yet, or the
 * plan gave a single step, which is the whole stage just as without a plan.
 */
export function planSteps(tasks: readonly Pick<Task, 'id' | 'kind'>[]): Map<string, PlanStep> {
  const steps = new Map<string, PlanStep>();
  if (!tasks.some((task) => task.kind === 'plan')) return steps;
  const work = tasks.filter((task) => task.kind === 'work');
  if (work.length < 2) return steps;
  for (const [i, task] of work.entries()) {
    steps.set(task.id, { index: i + 1, total: work.length });
  }
  return steps;
}
