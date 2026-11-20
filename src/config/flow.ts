// How a workflow template flows: effective stage settings, verify commands and rollback targets.
// Pure logic (type imports and src/i18n.ts only), so the dashboard shows the same rules the engine
// applies.

import { t } from '../i18n.js';
import type { Escalate, RunOverrides, StageDef, WorkflowTemplate } from './schema.js';

export const SYSTEM_DEFAULTS = {
  escalate: {
    max_retries: 2,
    on_agent_error: 'retry',
    on_budget_exceeded: 'pause',
  } satisfies Required<Escalate>,
  max_loops: 3,
};

export interface EffectiveStage {
  def: StageDef;
  gate: boolean;
  escalate: Required<Escalate>;
}

/** Resolve a stage's effective settings: system default → template → stage → run override. */
export function effectiveStage(
  template: WorkflowTemplate,
  stageId: string,
  overrides: RunOverrides,
): EffectiveStage {
  const def = template.stages.find((s) => s.id === stageId);
  if (!def) {
    throw new Error(
      t({
        zh: `模板 ${template.id} 中没有阶段 ${stageId}`,
        en: `Template ${template.id} has no stage ${stageId}`,
      }),
    );
  }
  const o = overrides.stages?.[stageId];
  return {
    def,
    gate: o?.gate ?? def.gate,
    escalate: {
      ...SYSTEM_DEFAULTS.escalate,
      ...stripUndefined(template.defaults?.escalate),
      ...stripUndefined(def.escalate),
      ...stripUndefined(o?.escalate),
    },
  };
}

export function effectiveMaxLoops(template: WorkflowTemplate, overrides: RunOverrides): number {
  return overrides.max_loops ?? template.defaults?.max_loops ?? SYSTEM_DEFAULTS.max_loops;
}

/** The Run's budget in USD: run override → template default; undefined = no budget. */
export function effectiveBudget(
  template: WorkflowTemplate,
  overrides: RunOverrides,
): number | undefined {
  return overrides.budget_usd ?? template.defaults?.budget_usd;
}

/**
 * Overrides of a Run created from a GitHub issue: with `auto_merge` the approvals
 * of the merge stages are off; other approval points of the template stay. The dashboard's guide
 * shows the same rule.
 */
export function issueRunOverrides(
  template: WorkflowTemplate | undefined,
  autoMerge: boolean,
): RunOverrides | undefined {
  const merges = (template?.stages ?? []).filter((st) => st.kind === 'merge');
  if (!autoMerge || merges.length === 0) return undefined;
  return { stages: Object.fromEntries(merges.map((st) => [st.id, { gate: false }])) };
}

function stripUndefined<T extends object>(obj: T | undefined): Partial<T> {
  if (!obj) return {};
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Stage kinds that change no code, so they run no verify commands. */
export function runsNoCommands(kind: StageDef['kind']): boolean {
  return kind === 'review' || kind === 'placeholder' || kind === 'assess';
}

/**
 * Verify commands a stage runs: its own `verify.commands`, otherwise the repo default.
 * Review, assess and placeholder stages run none (they change no code; the reviewer's verdict is
 * the review's check); merge stages run them only after bringing in new commits from the target
 * branch.
 */
export function stageVerifyCommands(def: StageDef, repoDefault: string[]): string[] {
  if (runsNoCommands(def.kind)) return [];
  return def.verify?.commands ?? repoDefault;
}

/**
 * Where a failed / rejected stage rolls back to when the template does not say.
 * agent stage → itself; review / merge stage → the nearest earlier agent stage.
 */
export function defaultRollbackTarget(template: WorkflowTemplate, stageId: string): string {
  const idx = template.stages.findIndex((s) => s.id === stageId);
  const stage = template.stages[idx];
  if (!stage || stage.kind === 'agent') return stageId;
  for (let i = idx - 1; i >= 0; i--) {
    const s = template.stages[i];
    if (s?.kind === 'agent') return s.id;
  }
  return stageId;
}

/**
 * Where a stage rolls back to: `on_reject` after a rejected approval, `on_fail` after failing
 * its checks or review; the default rule when the template does not say.
 */
export function rollbackTarget(
  template: WorkflowTemplate,
  stageId: string,
  reason: 'fail' | 'reject',
): string {
  const def = template.stages.find((s) => s.id === stageId);
  const explicit = reason === 'reject' ? def?.on_reject : def?.on_fail;
  return explicit ?? defaultRollbackTarget(template, stageId);
}

/**
 * Where a stage goes back to when it does not pass its checks or review; null when it stays.
 *
 * Mirrors the engine (src/engine/engine.ts):
 * - placeholder stage → null: it does nothing and always passes.
 * - assess stage → null: doubts about the requirement are discussed with a human and the stage
 *   assesses again with the replies; it ends with going ahead or dropping the Run, never fails.
 * - agent stage → null: a task that fails its checks is reworked within the stage
 *   (`rework`, up to `max_retries`, then a human is needed); the stage itself never fails.
 * - review / merge stage → the stage is marked failed and `rollback` goes to
 *   `rollbackTarget(…, 'fail')`, i.e. `on_fail` or the nearest earlier agent stage.
 *   (A merge stage only fails when its verify commands fail after syncing the target branch.)
 */
export function failTarget(template: WorkflowTemplate, stageId: string): string | null {
  const def = template.stages.find((s) => s.id === stageId);
  // A placeholder does nothing and an assessment discusses instead, so neither can fail (only
  // their approval can be rejected).
  if (!def || def.kind === 'agent' || def.kind === 'placeholder' || def.kind === 'assess') {
    return null;
  }
  return rollbackTarget(template, stageId, 'fail');
}
