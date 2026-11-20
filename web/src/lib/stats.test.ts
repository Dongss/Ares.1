import { afterEach, describe, expect, it } from 'vitest';
import type { StatsAgent, StatsView } from '../../../src/api/types.js';
import { setLang } from '../../../src/i18n.js';
import {
  agentLabel,
  average,
  blockRows,
  blockWait,
  costBars,
  costBarsTitle,
  effectiveStatsFilter,
  formatPerRun,
  labeledBars,
  localDay,
  niceCeil,
  parseStatsFilter,
  runGroups,
  STATS_RANGES,
  share,
  statsHref,
  statsQuery,
  tokenRows,
  unknownCostText,
} from './stats.js';

/** Local midnight of a "YYYY-MM-DD" day, as ISO. */
const midnight = (day: string) => new Date(`${day}T00:00:00`).toISOString();
const at = (day: string, time = '15:30:00') => new Date(`${day}T${time}`).toISOString();

function stats(extra: Partial<StatsView> & { byDay?: StatsView['cost']['byDay'] } = {}): StatsView {
  const { byDay = [], ...rest } = extra;
  return {
    range: '7d',
    repoId: null,
    since: midnight('2026-11-13'),
    at: at('2026-11-19'),
    runs: {
      total: 0,
      byStatus: {},
      fromIssues: 0,
      autoAccepted: 0,
      issuesClosed: 0,
      completed: { count: 0, costUsd: 0, avgMs: null, medianMs: null },
    },
    tasks: 0,
    attempts: 0,
    scouts: { total: 0, proposals: 0, autoAccepted: 0 },
    cost: {
      runsUsd: 0,
      scoutsUsd: 0,
      unknownAttempts: 0,
      unknownScouts: 0,
      byDay,
      byRepo: [],
    },
    agents: [],
    tokens: { input: 0, output: 0, cached: 0 },
    time: { attemptsMs: 0, scoutsMs: 0, approvals: { count: 0, waitMs: 0 } },
    quality: { runs: 0, agentRounds: 0, reviewFails: 0, checkFails: 0, rejections: 0, reworks: 0 },
    blocks: [],
    ...rest,
  };
}

function agent(agentId: string, extra: Partial<StatsAgent> = {}): StatsAgent {
  return {
    agentId,
    model: null,
    attempts: 0,
    scouts: 0,
    costUsd: 0,
    costUnknown: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    durationMs: 0,
    ...extra,
  };
}

describe('stats filter', () => {
  it('reads the range and repo from the hash, 7 days by default', () => {
    expect(parseStatsFilter('#/stats')).toEqual({ range: '7d', repoId: null });
    expect(parseStatsFilter('#/stats?range=30d&repo=repo-1')).toEqual({
      range: '30d',
      repoId: 'repo-1',
    });
    expect(parseStatsFilter('#/stats?range=year&repo=')).toEqual({ range: '7d', repoId: null });
  });

  it('round-trips through the hash and leaves the defaults out', () => {
    expect(statsHref({ range: '7d', repoId: null })).toBe('#/stats');
    expect(statsHref({ range: 'all', repoId: null })).toBe('#/stats?range=all');
    const href = statsHref({ range: 'today', repoId: 'repo 1' });
    expect(href).toBe('#/stats?range=today&repo=repo+1');
    expect(parseStatsFilter(href)).toEqual({ range: 'today', repoId: 'repo 1' });
  });

  it('always names the range in the API query', () => {
    expect(statsQuery({ range: '7d', repoId: null })).toBe('range=7d');
    expect(statsQuery({ range: 'all', repoId: 'r1' })).toBe('range=all&repo=r1');
  });

  it('drops a repo filter for a single repo or an unknown id', () => {
    const f = { range: '30d' as const, repoId: 'r2' };
    expect(effectiveStatsFilter(f, ['r1', 'r2'])).toEqual(f);
    expect(effectiveStatsFilter(f, ['r2'])).toEqual({ range: '30d', repoId: null });
    expect(effectiveStatsFilter(f, ['r1', 'r3'])).toEqual({ range: '30d', repoId: null });
  });
});

describe('runGroups', () => {
  it('groups statuses like the home filters', () => {
    expect(
      runGroups({
        queued: 1,
        running: 1,
        waiting_approval: 2,
        blocked: 1,
        paused: 1,
        completed: 5,
        failed: 1,
        cancelled: 2,
      }),
    ).toEqual([
      { id: 'active', label: '进行中', count: 2 },
      { id: 'attention', label: '等我处理', count: 4 },
      { id: 'completed', label: '已完成', count: 5 },
      { id: 'dropped', label: '不做', count: 0 },
      { id: 'failed', label: '失败或已终止', count: 3 },
    ]);
    expect(runGroups({}).map((g) => g.count)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('costBars', () => {
  it('fills every day of the range, days without cost included', () => {
    const bars = costBars(
      stats({
        byDay: [
          { day: '2026-11-14', runsUsd: 1.5, scoutsUsd: 0.25 },
          { day: '2026-11-19', runsUsd: 2, scoutsUsd: 0 },
        ],
      }),
    );
    expect(bars.map((b) => b.label)).toEqual([
      '11-13',
      '11-14',
      '11-15',
      '11-16',
      '11-17',
      '11-18',
      '11-19',
    ]);
    expect(bars[1]).toEqual({
      from: '2026-11-14',
      to: '2026-11-14',
      label: '11-14',
      runsUsd: 1.5,
      scoutsUsd: 0.25,
      totalUsd: 1.75,
    });
    expect(bars[0]?.totalUsd).toBe(0);
    expect(bars[6]?.totalUsd).toBe(2);
  });

  it('shows just today for today', () => {
    const today = stats({ range: 'today', since: midnight('2026-11-19') });
    expect(costBars(today).map((b) => b.from)).toEqual(['2026-11-19']);
  });

  it('starts "all" at the first day with cost, or today without any', () => {
    const all = stats({
      range: 'all',
      since: null,
      byDay: [{ day: '2026-11-17', runsUsd: 1, scoutsUsd: 0 }],
    });
    expect(costBars(all).map((b) => b.label)).toEqual(['11-17', '11-18', '11-19']);
    expect(costBars(stats({ range: 'all', since: null })).map((b) => b.label)).toEqual(['11-19']);
  });

  it('crosses month and year ends', () => {
    const s = stats({ since: midnight('2026-12-30'), at: at('2027-01-02') });
    expect(costBars(s).map((b) => b.from)).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
  });

  it('sums long ranges per week, the newest week ending today', () => {
    const s = stats({
      range: 'all',
      since: null,
      byDay: [
        { day: '2026-09-01', runsUsd: 1, scoutsUsd: 0 },
        { day: '2026-11-13', runsUsd: 2, scoutsUsd: 0.5 },
        { day: '2026-11-19', runsUsd: 3, scoutsUsd: 0 },
      ],
    });
    const bars = costBars(s);
    // 2026-09-01 .. 2026-11-19 is 80 days: 12 weeks, the oldest only 3 days long.
    expect(bars).toHaveLength(12);
    expect(bars[0]).toMatchObject({ from: '2026-09-01', to: '2026-09-03', runsUsd: 1 });
    expect(bars.at(-1)).toEqual({
      from: '2026-11-13',
      to: '2026-11-19',
      label: '11-13 – 11-19',
      runsUsd: 5,
      scoutsUsd: 0.5,
      totalUsd: 5.5,
    });
    expect(bars.reduce((n, b) => n + b.totalUsd, 0)).toBe(6.5);
    expect(costBarsTitle(bars)).toBe('每周的花费');
    expect(costBarsTitle(costBars(stats()))).toBe('每天的花费');
    expect(costBarsTitle([])).toBe('每天的花费');
  });

  it('sums per 30 days beyond about a year of weeks', () => {
    const s = stats({
      range: 'all',
      since: null,
      byDay: [{ day: '2025-01-01', runsUsd: 1, scoutsUsd: 0 }],
    });
    const bars = costBars(s);
    expect(bars.length).toBeLessThanOrEqual(62);
    expect(bars.at(-1)).toMatchObject({ from: '2026-10-21', to: '2026-11-19' });
    expect(costBarsTitle(bars)).toBe('每 30 天的花费');
    expect(bars.reduce((n, b) => n + b.totalUsd, 0)).toBe(1);
  });
});

describe('chart scale', () => {
  it('rounds the top of the axis up to 1 / 2 / 2.5 / 5 × 10ⁿ', () => {
    expect(niceCeil(0)).toBe(0);
    expect(niceCeil(0.3)).toBe(0.5);
    expect(niceCeil(0.25)).toBe(0.25);
    expect(niceCeil(1)).toBe(1);
    expect(niceCeil(1.2)).toBe(2);
    expect(niceCeil(2.1)).toBe(2.5);
    expect(niceCeil(3.5)).toBe(5);
    expect(niceCeil(7)).toBe(10);
    expect(niceCeil(42)).toBe(50);
    expect(niceCeil(0.003)).toBe(0.005);
  });

  it('labels about eight columns, always the newest', () => {
    expect([...labeledBars(7)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect([...labeledBars(30)].sort((a, b) => a - b)).toEqual([1, 5, 9, 13, 17, 21, 25, 29]);
    expect([...labeledBars(1)]).toEqual([0]);
    expect(labeledBars(0).size).toBe(0);
  });
});

describe('figures', () => {
  it('averages per Run', () => {
    expect(average(3, 2)).toBe(1.5);
    expect(average(3, 0)).toBeNull();
    expect(formatPerRun(5, 4)).toBe('1.3');
    expect(formatPerRun(4, 4)).toBe('1');
    expect(formatPerRun(0, 4)).toBe('0');
    expect(formatPerRun(1, 0)).toBe('—');
  });

  it('notes executions without a known cost', () => {
    const cost = stats().cost;
    expect(unknownCostText(cost)).toBeNull();
    expect(unknownCostText({ ...cost, unknownAttempts: 2, unknownScouts: 1 })).toBe(
      '另有 3 次执行费用未知，未计入合计',
    );
  });

  it('shows shares of the total', () => {
    expect(share(1, 4)).toBe('25%');
    expect(share(0.001, 4)).toBe('<1%');
    expect(share(0, 4)).toBe('0%');
    expect(share(1, 0)).toBe('');
  });

  it('labels agents with their model', () => {
    expect(agentLabel({ agentId: 'claude-coder', model: 'claude-opus-5-5' })).toBe(
      'claude-coder · claude-opus-5-5',
    );
    expect(agentLabel({ agentId: 'old', model: null })).toBe('old');
  });

  it('lists agents of Runs by tokens and leaves scout-only agents out', () => {
    const rows = tokenRows([
      agent('a', { attempts: 1, inputTokens: 10 }),
      agent('scout', { scouts: 2 }),
      agent('b', { attempts: 1, inputTokens: 5, cachedTokens: 100 }),
    ]);
    expect(rows.map((r) => r.agentId)).toEqual(['b', 'a']);
  });

  it('sums the waits after blocks and names the reasons', () => {
    const blocks: StatsView['blocks'] = [
      { kind: 'agent_error', count: 3, handled: 2, waitMs: 60_000 },
      { kind: 'budget', count: 1, handled: 1, waitMs: 5_000 },
    ];
    expect(blockWait(blocks)).toEqual({ count: 3, waitMs: 65_000 });
    expect(blockWait([])).toEqual({ count: 0, waitMs: 0 });
    expect(blockRows(blocks).map((b) => [b.label, b.count])).toEqual([
      ['Agent 执行出错', 3],
      ['超出预算', 1],
    ]);
  });

  it('takes local days of ISO times', () => {
    expect(localDay(at('2026-11-19', '00:10:00'))).toBe('2026-11-19');
    expect(localDay(at('2026-11-19', '23:50:00'))).toBe('2026-11-19');
  });
});

describe('stats labels in English', () => {
  afterEach(() => setLang('zh'));

  it('titles the cost trend and ranges in English', () => {
    setLang('en');
    expect(costBarsTitle([])).toBe('Cost per day');
    const week = {
      from: '2026-11-13',
      to: '2026-11-19',
      label: '',
      runsUsd: 0,
      scoutsUsd: 0,
      totalUsd: 0,
    };
    expect(costBarsTitle([week])).toBe('Cost per week');
    expect(costBarsTitle([{ ...week, from: '2026-10-21' }])).toBe('Cost per 30 days');
    expect(STATS_RANGES.map((r) => r.label)).toEqual([
      'Today',
      'Last 7 days',
      'Last 30 days',
      'All',
    ]);
  });

  it('counts unknown costs with English plurals', () => {
    setLang('en');
    const cost = stats().cost;
    expect(unknownCostText({ ...cost, unknownAttempts: 1, unknownScouts: 0 })).toBe(
      '1 more execution has an unknown cost, not included in the total',
    );
    expect(unknownCostText({ ...cost, unknownAttempts: 2, unknownScouts: 1 })).toBe(
      '3 more executions have an unknown cost, not included in the total',
    );
  });
});
