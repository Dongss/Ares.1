// Shared by the Master and the dashboard: no runtime imports.
import type { Attempt } from '../store/types.js';

/**
 * An attempt's cost is unknown when it ended without one: the CLI reports no cost and the agent
 * has no configured price (e.g. cursor-agent), or it was stopped before the CLI reported it.
 */
export function isCostUnknown(attempt: Pick<Attempt, 'costUsd' | 'status'>): boolean {
  return attempt.costUsd === null && attempt.status !== 'running';
}
