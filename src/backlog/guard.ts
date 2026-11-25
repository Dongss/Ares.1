// Limits on what the Master does by itself for a repo's requirements, wherever they come from:
// the day's spend and the proposals accepted without a human.

import type { ProposalSourceConfig } from '../config/schema.js';
import type { Store } from '../store/store.js';
import type { Repo } from '../store/types.js';

/** Start of the current day in the Master's local time, as ISO. */
export function startOfToday(now = new Date()): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * Spend of today on what this repo did without a human: scouts, auto-accepted Runs and
 * automatic redos of failed Runs.
 */
export function spentToday(store: Store, repoId: string): number {
  const since = startOfToday();
  const scouts = store
    .listScouts({ repoId, since, limit: 1000 })
    .reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
  const runs = store
    .issueRunsSince(since)
    .filter((r) => r.repoId === repoId && (r.issue?.auto || (r.issue?.attempt ?? 1) > 1))
    .reduce((sum, r) => sum + r.costUsd, 0);
  return scouts + runs;
}

/** Proposals of the repo accepted without a human today. */
export function autoAcceptedToday(store: Store, repoName: string): number {
  return store
    .listEventsOfType('issue.auto_accepted', startOfToday())
    .filter((e) => e.data.repo === repoName).length;
}

/** Today's spend reached the configured limit (none = never). */
export function overBudget(store: Store, repo: Repo, cfg: ProposalSourceConfig): boolean {
  return cfg.daily_budget_usd !== undefined && spentToday(store, repo.id) >= cfg.daily_budget_usd;
}

/** Within today's auto-accept count and spend. */
export function mayAutoAccept(store: Store, repo: Repo, cfg: ProposalSourceConfig): boolean {
  const max = cfg.auto_accept.max_per_day;
  if (max !== undefined && autoAcceptedToday(store, repo.name) >= max) return false;
  return !overBudget(store, repo, cfg);
}
