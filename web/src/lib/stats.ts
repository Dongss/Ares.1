import type { StatsAgent, StatsRange, StatsView } from '../../../src/api/types.js';
import { t } from '../../../src/i18n.js';
import { RUN_STATUS_FILTERS, RUN_STATUS_GROUPS, type RunStatusFilter } from './filters.js';
import { BLOCK_KIND } from './format.js';
import { useLocationHash } from './router.js';

// The statistics page: filter in the hash, and tidying up what GET /api/stats sums.

/** A time range whose label is read in the language in use (a getter, not frozen at import). */
const range = (id: StatsRange, zh: string, en: string): { id: StatsRange; label: string } => ({
  id,
  get label() {
    return t({ zh, en });
  },
});

export const STATS_RANGES: readonly { id: StatsRange; label: string }[] = [
  range('today', '今天', 'Today'),
  range('7d', '最近 7 天', 'Last 7 days'),
  range('30d', '最近 30 天', 'Last 30 days'),
  range('all', '全部', 'All'),
];

export const DEFAULT_STATS_RANGE: StatsRange = '7d';

export interface StatsFilter {
  range: StatsRange;
  /** Null means every repository. */
  repoId: string | null;
}

/** `#/stats?range=30d&repo=<id>`; unknown values fall back to the defaults. */
export function parseStatsFilter(hash: string): StatsFilter {
  const queryAt = hash.indexOf('?');
  const params = new URLSearchParams(queryAt === -1 ? '' : hash.slice(queryAt + 1));
  const raw = params.get('range');
  const range = STATS_RANGES.find((r) => r.id === raw)?.id ?? DEFAULT_STATS_RANGE;
  return { range, repoId: params.get('repo') || null };
}

/** Hash URL that restores `filter` after a refresh. Defaults are omitted. */
export function statsHref(filter: StatsFilter): string {
  const params = new URLSearchParams();
  if (filter.range !== DEFAULT_STATS_RANGE) params.set('range', filter.range);
  if (filter.repoId) params.set('repo', filter.repoId);
  const query = params.toString();
  return query ? `#/stats?${query}` : '#/stats';
}

/** Query string of GET /api/stats for `filter`. */
export function statsQuery(filter: StatsFilter): string {
  const params = new URLSearchParams({ range: filter.range });
  if (filter.repoId) params.set('repo', filter.repoId);
  return params.toString();
}

/**
 * Drop a repository filter the page cannot show: a single registered repo (no repo choice is
 * shown then), or an id that is not registered.
 */
export function effectiveStatsFilter(filter: StatsFilter, repoIds: readonly string[]): StatsFilter {
  const repoId =
    repoIds.length > 1 && filter.repoId !== null && repoIds.includes(filter.repoId)
      ? filter.repoId
      : null;
  return { range: filter.range, repoId };
}

export function useStatsFilter(): StatsFilter {
  return parseStatsFilter(useLocationHash());
}

/** Runs per status group, the same groups as the home filters (in progress, waiting for me…). */
export function runGroups(
  byStatus: StatsView['runs']['byStatus'],
): { id: Exclude<RunStatusFilter, 'all'>; label: string; count: number }[] {
  return RUN_STATUS_FILTERS.filter((f) => f.id !== 'all').map((f) => {
    const id = f.id as Exclude<RunStatusFilter, 'all'>;
    const count = RUN_STATUS_GROUPS[id].reduce((n, s) => n + (byStatus[s] ?? 0), 0);
    return { id, label: f.label, count };
  });
}

// ---- days ------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar day ("YYYY-MM-DD") of an ISO time. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Calendar arithmetic on "YYYY-MM-DD" (UTC inside, so daylight saving cannot skip a day). */
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "11-19" */
export function shortDay(day: string): string {
  return day.slice(5);
}

/** One column of the cost trend: a day, or several when the range is long. */
export interface CostBar {
  /** First and last day, "YYYY-MM-DD". */
  from: string;
  to: string;
  /** "11-19", or "11-13 – 11-19". */
  label: string;
  runsUsd: number;
  scoutsUsd: number;
  totalUsd: number;
}

/** Days per column, from one day up; the first that keeps the chart within `maxBars` columns. */
const BUCKET_DAYS = [1, 7, 30, 365];

/**
 * The cost trend: every day of the range, days without cost included, oldest first. "All" starts
 * at the first day with any cost. Long ranges are summed per 7 / 30 / 365 days (the last column
 * ends today) to stay within `maxBars` columns.
 */
export function costBars(stats: StatsView, maxBars = 62): CostBar[] {
  const last = localDay(stats.at);
  const first = stats.since
    ? localDay(stats.since)
    : [stats.cost.byDay[0]?.day ?? last, last].sort()[0];
  const byDay = new Map(stats.cost.byDay.map((d) => [d.day, d]));
  const days: string[] = [];
  for (let day = first ?? last; day <= last; day = addDays(day, 1)) days.push(day);
  const size =
    BUCKET_DAYS.find((n) => Math.ceil(days.length / n) <= maxBars) ??
    (BUCKET_DAYS.at(-1) as number);
  const bars: CostBar[] = [];
  // Buckets are counted back from the last day so the newest column is always whole.
  for (let end = days.length; end > 0; end -= size) {
    const chunk = days.slice(Math.max(0, end - size), end);
    const from = chunk[0] as string;
    const to = chunk.at(-1) as string;
    let runsUsd = 0;
    let scoutsUsd = 0;
    for (const day of chunk) {
      runsUsd += byDay.get(day)?.runsUsd ?? 0;
      scoutsUsd += byDay.get(day)?.scoutsUsd ?? 0;
    }
    bars.unshift({
      from,
      to,
      label: from === to ? shortDay(from) : `${shortDay(from)} – ${shortDay(to)}`,
      runsUsd,
      scoutsUsd,
      totalUsd: runsUsd + scoutsUsd,
    });
  }
  return bars;
}

/** Title of the cost trend: "每天的花费" (cost per day), or what one column covers on long ranges. */
export function costBarsTitle(bars: readonly CostBar[]): string {
  const daily = () => t({ zh: '每天的花费', en: 'Cost per day' });
  const last = bars.at(-1);
  if (!last) return daily();
  const days =
    (Date.parse(`${last.to}T00:00:00Z`) - Date.parse(`${last.from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days <= 1) return daily();
  if (days === 7) return t({ zh: '每周的花费', en: 'Cost per week' });
  return t({ zh: `每 ${days} 天的花费`, en: `Cost per ${days} days` });
}

/** The smallest 1 / 2 / 2.5 / 5 × 10ⁿ at or above `value`: the top of a value axis. */
export function niceCeil(value: number): number {
  if (!(value > 0)) return 0;
  const exp = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const nice = step * exp;
    // Rounding keeps 0.1 × 3 from becoming 0.30000000000000004.
    if (nice >= value * (1 - 1e-9)) return Number(nice.toPrecision(12));
  }
  return 10 * exp;
}

/** Which columns get a day label below them: about `max` evenly spaced, always the last. */
export function labeledBars(count: number, max = 8): Set<number> {
  const step = Math.max(1, Math.ceil(count / max));
  const shown = new Set<number>();
  for (let i = count - 1; i >= 0; i -= step) shown.add(i);
  return shown;
}

// ---- figures ---------------------------------------------------------------------

/** `total / count`, or null when there is nothing to divide by. */
export function average(total: number, count: number): number | null {
  return count > 0 ? total / count : null;
}

/** "1.5" per Run; "—" without Runs. */
export function formatPerRun(total: number, runs: number): string {
  const avg = average(total, runs);
  if (avg === null) return '—';
  return Number.isInteger(avg) ? String(avg) : avg.toFixed(1);
}

/** "另有 N 次执行费用未知" (N more executions of unknown cost), or null when every cost is known. */
export function unknownCostText(cost: StatsView['cost']): string | null {
  const n = cost.unknownAttempts + cost.unknownScouts;
  if (n === 0) return null;
  return t({
    zh: `另有 ${n} 次执行费用未知，未计入合计`,
    en: `${n} more ${n === 1 ? 'execution has' : 'executions have'} an unknown cost, not included in the total`,
  });
}

/** "42%" of a whole; "" when the whole is zero. */
export function share(part: number, whole: number): string {
  if (!(whole > 0)) return '';
  const p = (part / whole) * 100;
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`;
}

/** "claude-coder · claude-opus-5-5" */
export function agentLabel(agent: Pick<StatsAgent, 'agentId' | 'model'>): string {
  return agent.model ? `${agent.agentId} · ${agent.model}` : agent.agentId;
}

/** Waiting for a human after blocks: handled blocks and how long they waited in all. */
export function blockWait(blocks: StatsView['blocks']): { count: number; waitMs: number } {
  return blocks.reduce(
    (acc, b) => ({ count: acc.count + b.handled, waitMs: acc.waitMs + b.waitMs }),
    { count: 0, waitMs: 0 },
  );
}

/** Blocks with their reason in words, most frequent first (as the Master sorts them). */
export function blockRows(blocks: StatsView['blocks']) {
  return blocks.map((b) => ({ ...b, label: BLOCK_KIND[b.kind] ?? b.kind }));
}

/** Agents that ran something in Runs, for the token table, most tokens first. */
export function tokenRows(agents: readonly StatsAgent[]): StatsAgent[] {
  const total = (a: StatsAgent) => a.inputTokens + a.outputTokens + a.cachedTokens;
  return agents.filter((a) => a.attempts > 0).sort((a, b) => total(b) - total(a));
}
