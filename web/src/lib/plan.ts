// How the Run page shows the tasks of a stage round its plan split into steps (`planning: llm`),
// and whether a round of a stage planning by size (`planning: auto`) was split.

import { plansStage } from '../../../src/config/flow.js';
import type { StageDef } from '../../../src/config/schema.js';
import { assessedSize } from '../../../src/engine/discussion.js';
import { type PlanStep, planSteps } from '../../../src/engine/plan.js';
import { t } from '../../../src/i18n.js';
import type { DiscussionEntry, Task } from '../../../src/store/types.js';

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
 * Whether a round of a stage with `planning: auto` was split into steps, and why: the size the
 * Run's latest go assessment before the round started gave (`plansStage`, as the engine decided
 * when the round began). null for stages that do not plan by size.
 */
export function autoPlanText(
  def: Pick<StageDef, 'kind' | 'planning'>,
  discussion: readonly DiscussionEntry[],
  /** When the round started; assessments after it decided nothing about it. */
  startedAt: string,
): string | null {
  if (def.kind !== 'agent' || def.planning !== 'auto') return null;
  const size = assessedSize(discussion.filter((e) => e.at <= startedAt));
  // A neutral opening: the text says whether the round was split only after it, so that it is not
  // read as split at first glance.
  if (plansStage(def, size)) {
    return t({
      zh: `按需求规模决定是否拆分：需求评估给出的规模是 ${size}，这一轮先拆分任务，再一步一步做。`,
      en: `By the requirement's size: the assessment sized it ${size}, so this round is planned first and done step by step.`,
    });
  }
  if (size) {
    return t({
      zh: `按需求规模决定是否拆分：需求评估给出的规模是 ${size}，只有 L 才拆分，这一轮整个阶段一次做完。`,
      en: `By the requirement's size: the assessment sized it ${size}, and only an L is split, so this round does the whole stage in one go.`,
    });
  }
  return t({
    zh: '按需求规模决定是否拆分：没有需求评估给出的规模，这一轮不拆分，整个阶段一次做完。',
    en: "By the requirement's size: no assessment gave a size, so this round is not split and does the whole stage in one go.",
  });
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
