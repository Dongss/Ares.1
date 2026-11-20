// Run budgets on the dashboard: a new one typed in USD after a Run ran out of its budget.

import { t } from '../../../src/i18n.js';

export type BudgetInput = { ok: true; value: number | undefined } | { ok: false; error: string };

/** A budget typed by the user: empty = not set; otherwise it must be a positive amount. */
export function parseBudget(text: string): BudgetInput {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: undefined };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    return {
      ok: false,
      error: t({
        zh: '预算要填大于 0 的金额（美元）',
        en: 'The budget must be an amount above 0 (USD)',
      }),
    };
  }
  return { ok: true, value };
}

/**
 * The new budget offered when a Run is blocked by its budget: twice what it has spent,
 * rounded up to the cent (so always above the spending).
 */
export function suggestedBudget(costUsd: number): string {
  // The small epsilon keeps float noise (2.4 * 100 = 240.00000000000003) from adding a cent.
  const cents = Math.max(1, Math.ceil(costUsd * 2 * 100 - 1e-6));
  return (cents / 100).toFixed(2);
}

/** What retrying with this budget text would do; an error when it would be refused. */
export function newBudget(text: string, costUsd: number): BudgetInput {
  const parsed = parseBudget(text);
  if (!parsed.ok) return parsed;
  if (parsed.value === undefined) {
    return { ok: false, error: t({ zh: '请填写新的预算', en: 'Enter a new budget' }) };
  }
  if (parsed.value <= costUsd) {
    return {
      ok: false,
      error: t({
        zh: '新的预算必须大于已花费的金额',
        en: 'The new budget must be above what has been spent',
      }),
    };
  }
  return parsed;
}
