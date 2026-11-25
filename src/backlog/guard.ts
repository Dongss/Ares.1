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
 * Events of a proposal accepted without a human: an issue labeled ares1:ready by the Master, a
 * local proposal turned into a Run (backlog.repos), or an iteration accepted as a whole, which
 * counts once however many children it has.
 */
const AUTO_ACCEPTED_EVENTS = [
  'issue.auto_accepted',
  'proposal.auto_accepted',
  'iteration.auto_accepted',
] as const;

/**
 * Spend of today on what this repo did without a human: scouts, auto-accepted Runs (from issues
 * or local proposals) and automatic redos of failed Runs.
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
  const local = store.autoProposalRunsSince(repoId, since).reduce((sum, r) => sum + r.costUsd, 0);
  return scouts + runs + local;
}

/** Proposals of the repo accepted without a human today. */
export function autoAcceptedToday(store: Store, repoName: string): number {
  const since = startOfToday();
  return AUTO_ACCEPTED_EVENTS.reduce(
    (n, type) =>
      n + store.listEventsOfType(type, since).filter((e) => e.data.repo === repoName).length,
    0,
  );
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
