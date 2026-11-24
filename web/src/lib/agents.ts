import type { AgentState, AgentSummary } from '../../../src/api/types.js';
import { t } from '../../../src/i18n.js';
import type { AgentLastError, EventRow } from '../../../src/store/types.js';
import { AGENT_STATE, agentRow } from './config.js';
import { formatRunCost, type Tone } from './format.js';
import { share } from './stats.js';

// The 「Agent」 page: every agent with what it did, from GET /api/agents.

/** Label and tone of an agent's state, in the language in use. */
export function agentStatus(state: AgentState): { label: string; tone: Tone } {
  if (state === 'removed') {
    return { label: t({ zh: '已不在配置中', en: 'No longer configured' }), tone: 'muted' };
  }
  return AGENT_STATE[state];
}

export interface AgentPageRow {
  id: string;
  state: AgentState;
  /** From agents.yaml; null when not given there, or when the agent is not there any more. */
  cli: string | null;
  model: string | null;
  /** null: the CLI default for a valid entry; unknown for an invalid or removed one. */
  effort: string | null;
  /** The effort is the CLI default (the entry is valid and sets none). */
  defaultEffort: boolean;
  /** Why the agent is not in use; null when it is. */
  reason: string | null;
  /** What to know about a valid agent, e.g. a setting its CLI cannot honor exactly. */
  warnings: string[];
  /** Executions in Runs, running ones included. */
  attempts: number;
  /** Passed / rework / error counts as "9 / 2 / 1"; null without executions. */
  outcomes: string | null;
  /** "Rework 17%, error 8%", of the executions that got an outcome; null if none did. */
  rates: string | null;
  /** "1 more stopped or interrupted"; null when there were none. */
  stopped: string | null;
  /** Cost of the executions in Runs (marked when some are unknown); null without any. */
  runCost: string | null;
  /** Cost of the scouts, likewise; null when the agent never scouted. */
  scoutCost: string | null;
  scouts: number;
  /** Both together. */
  totalCost: string;
  lastAt: string | null;
  lastError: (AgentLastError & { text: string }) | null;
}

/** Cost with unknown ones marked, as on Run cards (formatRunCost). */
const cost = (usd: number, unknown: number) => formatRunCost(usd, unknown > 0);

/** The latest of two ISO times, either possibly missing. */
const latest = (a: string | null, b: string | null): string | null =>
  a === null ? b : b === null ? a : a > b ? a : b;

/** An error excerpt on one line: blank space runs collapsed, "…" when it was cut. */
export function errorText(error: Pick<AgentLastError, 'message' | 'truncated'>): string {
  const text = error.message.replace(/\s+/g, ' ').trim();
  return error.truncated ? `${text}…` : text;
}

/**
 * "Rework 17%, error 8%": shares of the executions that got an outcome (passed, rework or agent
 * error); stopped and running ones have none and are left out. Null when none got one.
 */
export function outcomeRates(runs: AgentSummary['runs']): string | null {
  const decided = runs.passed + runs.rework + runs.agentError;
  if (decided === 0) return null;
  const rework = share(runs.rework, decided);
  const error = share(runs.agentError, decided);
  return t({ zh: `返工 ${rework}、出错 ${error}`, en: `Rework ${rework}, error ${error}` });
}

export function agentPageRow(agent: AgentSummary): AgentPageRow {
  const config = agent.entry ? agentRow(agent.entry) : null;
  const { runs, scouts } = agent;
  return {
    id: agent.id,
    state: agent.state,
    cli: config?.cli ?? null,
    model: config?.model ?? null,
    effort: config?.effort ?? null,
    defaultEffort: config !== null && config.state !== 'invalid' && config.effort === null,
    reason: config
      ? config.reason
      : t({
          zh: 'agents.yaml 中已经没有这一项，这里是它留下的记录',
          en: 'No longer in agents.yaml; this is the record it left behind',
        }),
    warnings: config?.warnings ?? [],
    attempts: runs.attempts,
    outcomes: runs.attempts > 0 ? `${runs.passed} / ${runs.rework} / ${runs.agentError}` : null,
    rates: outcomeRates(runs),
    stopped: runs.stopped > 0 ? stoppedText(runs.stopped) : null,
    runCost: runs.attempts > 0 ? cost(runs.costUsd, runs.costUnknown) : null,
    scoutCost: scouts.scouts > 0 ? cost(scouts.costUsd, scouts.costUnknown) : null,
    scouts: scouts.scouts,
    totalCost: cost(runs.costUsd + scouts.costUsd, runs.costUnknown + scouts.costUnknown),
    lastAt: latest(runs.lastAt, scouts.lastAt),
    lastError: runs.lastError ? { ...runs.lastError, text: errorText(runs.lastError) } : null,
  };
}

/** "1 more stopped or interrupted". */
function stoppedText(n: number): string {
  return t({
    zh: `另有 ${n} 次被停止或中断`,
    en: `${n} more ${n === 1 ? 'was' : 'were'} stopped or interrupted`,
  });
}

/** The totals row: every agent together. */
export function agentTotals(agents: AgentSummary[]): {
  attempts: number;
  scouts: number;
  runCost: string;
  scoutCost: string;
  totalCost: string;
} {
  let attempts = 0;
  let scouts = 0;
  let runsUsd = 0;
  let scoutsUsd = 0;
  let runsUnknown = 0;
  let scoutsUnknown = 0;
  for (const a of agents) {
    attempts += a.runs.attempts;
    scouts += a.scouts.scouts;
    runsUsd += a.runs.costUsd;
    scoutsUsd += a.scouts.costUsd;
    runsUnknown += a.runs.costUnknown;
    scoutsUnknown += a.scouts.costUnknown;
  }
  return {
    attempts,
    scouts,
    runCost: cost(runsUsd, runsUnknown),
    scoutCost: cost(scoutsUsd, scoutsUnknown),
    totalCost: cost(runsUsd + scoutsUsd, runsUnknown + scoutsUnknown),
  };
}

/**
 * Events after which the page reloads: an execution finished or got its outcome (outcomes are
 * recorded after the checks, with task / stage / block events), a scout ended, or agents.yaml
 * was reloaded.
 */
export function isAgentPageEvent(e: Pick<EventRow, 'type'>): boolean {
  return (
    /^(attempt|task|stage)\./.test(e.type) ||
    [
      'run.blocked',
      'run.status',
      'scout.completed',
      'scout.failed',
      'scout.rate_limited',
      'config.reloaded',
    ].includes(e.type)
  );
}
