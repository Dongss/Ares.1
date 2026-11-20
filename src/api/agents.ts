import type { LoadedConfig } from '../config/load.js';
import type { Store } from '../store/store.js';
import type { AgentSummary } from './types.js';

const NO_RUNS: AgentSummary['runs'] = {
  attempts: 0,
  passed: 0,
  rework: 0,
  agentError: 0,
  stopped: 0,
  costUsd: 0,
  costUnknown: 0,
  lastAt: null,
  lastError: null,
};

const NO_SCOUTS: AgentSummary['scouts'] = { scouts: 0, costUsd: 0, costUnknown: 0, lastAt: null };

/**
 * GET /api/agents: the agents.yaml entries in use now (enabled, disabled and
 * invalid ones, as GET /api/config) with what each did, then agents that are not in agents.yaml
 * any more but have executions or scouts on record.
 */
export function agentSummaries(store: Store, config: LoadedConfig): AgentSummary[] {
  const runs = new Map(store.agentAttemptTotals().map(({ agentId, ...r }) => [agentId, r]));
  const scouts = new Map(store.agentScoutTotals().map(({ agentId, ...s }) => [agentId, s]));
  const summary = (id: string, entry: AgentSummary['entry']): AgentSummary => ({
    id,
    state: entry?.state ?? 'removed',
    entry,
    runs: runs.get(id) ?? NO_RUNS,
    scouts: scouts.get(id) ?? NO_SCOUTS,
  });
  const configured = config.agentEntries.map((entry) => summary(entry.id, entry));
  const known = new Set(config.agentEntries.map((e) => e.id));
  const removed = [...new Set([...runs.keys(), ...scouts.keys()])]
    .filter((id) => !known.has(id))
    .sort((a, b) => a.localeCompare(b))
    .map((id) => summary(id, null));
  return [...configured, ...removed];
}
