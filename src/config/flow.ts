// How a workflow template flows: effective stage settings, verify commands and rollback targets;
// also the overrides of Runs from issues, which proposals are accepted automatically and how long
// the automatic scout backs off.
// Pure logic (type imports and src/i18n.ts only), so the dashboard shows the same rules the engine
// applies.

import { t } from '../i18n.js';
import type { Scout } from '../store/types.js';
import type { Escalate, RunOverrides, StageDef, WorkflowTemplate } from './schema.js';

/** Risk of a proposal, ordered; auto-accept takes everything up to a chosen level. */
export const RISKS = ['low', 'mid', 'high'] as const;
export type Risk = (typeof RISKS)[number];

/** Size of a proposal: S within an hour, M within half a day, L larger. */
export const PROPOSAL_SIZES = ['S', 'M', 'L'] as const;
export type ProposalSize = (typeof PROPOSAL_SIZES)[number];

/** What auto-accept looks at in a proposal. */
export interface ProposalKind {
  risk: Risk;
  size: ProposalSize;
}

/** Whether a kind of proposal is accepted without a human under `auto_accept.max_risk`. */
export type AutoAcceptRule = (p: ProposalKind, maxRisk: Risk | 'none') => boolean;

/** Auto-accept up to the configured risk, and only what fits one Run. */
export const isAutoAcceptable: AutoAcceptRule = (p, maxRisk) => {
  if (maxRisk === 'none' || p.size === 'L') return false;
  return RISKS.indexOf(p.risk) <= RISKS.indexOf(maxRisk);
};

/**
 * Every kind of proposal (risk × size), split into those the Master accepts by itself under
 * `maxRisk` and those left to a human. `rule` is the auto-accept rule; tests may pass another.
 */
export function acceptSplit(
  maxRisk: Risk | 'none',
  rule: AutoAcceptRule = isAutoAcceptable,
): { auto: ProposalKind[]; human: ProposalKind[] } {
  const auto: ProposalKind[] = [];
  const human: ProposalKind[] = [];
  for (const risk of RISKS) {
    for (const size of PROPOSAL_SIZES) {
      (rule({ risk, size }, maxRisk) ? auto : human).push({ risk, size });
    }
  }
  return { auto, human };
}

export const SYSTEM_DEFAULTS = {
  escalate: {
    max_retries: 2,
    // Nobody has to be there: retry, then another agent, then the Run ends as failed.
    on_agent_error: 'switch_agent',
    on_budget_exceeded: 'pause',
  } satisfies Required<Escalate>,
  max_loops: 3,
  /** How long an assess stage waits for a reply to its questions when it does not say. */
  reply_timeout_hours: 24,
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

/**
 * How many hours an assess stage waits for a human to reply to its questions before the
 * assessment decides on its own: the stage's `reply_timeout_hours`, else the system default.
 * 0 = it does not wait; null = it waits however long it takes.
 */
export function replyTimeoutHours(def: StageDef): number | null {
  return def.reply_timeout_hours === undefined
    ? SYSTEM_DEFAULTS.reply_timeout_hours
    : def.reply_timeout_hours;
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

/** The longest the automatic scout backs off after scouts that found nothing or failed. */
export const MAX_SCOUT_BACKOFF_HOURS = 6;

export interface ScoutBackoff {
  /** Scouts in a row, counting back from the newest, that found nothing or failed. */
  count: number;
  /** When the next automatic scout may start. */
  until: string;
}

/**
 * How long the automatic scout backs off: scouting an unchanged repo again most likely finds
 * nothing again, at the price of a full read of the repo every poll. Counting back from the newest
 * scout (started by hand or not), k is the number of scouts in a row that failed or filed no
 * issue (proposals that were all duplicates or could not be filed find nothing). The next one may
 * start poll_minutes × 2^(k-1) after the newest of them ended, at most MAX_SCOUT_BACKOFF_HOURS.
 * - A scout that filed an issue ends the streak.
 * - So does a scout started before `changedAt` (the target branch's latest commit): it did not
 *   see the repo as it is now.
 * - A scout cut short by the Master stopping, or still running, neither counts nor ends it.
 * `scouts` are newest first. null: no streak, no back-off.
 */
export function scoutBackoff(
  scouts: Pick<Scout, 'status' | 'proposals' | 'startedAt' | 'endedAt'>[],
  pollMinutes: number,
  changedAt = Number.NEGATIVE_INFINITY,
): ScoutBackoff | null {
  let count = 0;
  let newest: (typeof scouts)[number] | undefined;
  for (const s of scouts) {
    if (s.status === 'interrupted' || s.status === 'running') continue;
    if (Date.parse(s.startedAt) < changedAt) break;
    if (s.status === 'completed' && s.proposals.some((p) => p.issue)) break;
    count++;
    newest ??= s;
  }
  if (!newest) return null;
  // 2^(k-1) stops mattering long before it could overflow: the wait is capped.
  const delay = Math.min(
    pollMinutes * 60_000 * 2 ** Math.min(count - 1, 30),
    MAX_SCOUT_BACKOFF_HOURS * 3_600_000,
  );
  const from = Date.parse(newest.endedAt ?? newest.startedAt);
  return { count, until: new Date(from + delay).toISOString() };
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
