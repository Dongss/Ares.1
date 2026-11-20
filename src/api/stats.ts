import type { SQLInputValue } from 'node:sqlite';
import type { Store } from '../store/store.js';
import type { BlockKind, RunStatus } from '../store/types.js';
import type { StatsAgent, StatsBlocks, StatsRange, StatsView } from './types.js';

export const STATS_RANGES = ['today', '7d', '30d', 'all'] as const satisfies readonly StatsRange[];

const RANGE_DAYS: Record<Exclude<StatsRange, 'all'>, number> = { today: 1, '7d': 7, '30d': 30 };

/** Local midnight that starts the range (today and the days before it); null for all. */
export function statsSince(range: StatsRange, now = new Date()): string | null {
  if (range === 'all') return null;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (RANGE_DAYS[range] - 1));
  return d.toISOString();
}

/** Whole milliseconds between two ISO columns, in SQL (ISO times have millisecond precision). */
const ms = (from: string, to: string) =>
  `ROUND((unixepoch(${to}, 'subsec') - unixepoch(${from}, 'subsec')) * 1000)`;

type Row = Record<string, number | string | null>;

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const round = (v: unknown): number => Math.round(num(v));
/** Sums of costs: floating point noise trimmed, well below what the dashboard shows. */
const usd = (v: unknown): number => Math.round(num(v) * 1e8) / 1e8;

/**
 * Totals for the statistics page, summed in SQL. Every record counts by when it happened
 * (see StatsView); `repoId` limits everything to one repo.
 */
export function collectStats(
  store: Store,
  opts: { range: StatsRange; repoId: string | null; now?: Date },
): StatsView {
  const now = opts.now ?? new Date();
  const since = statsSince(opts.range, now);
  const db = store.db;
  // Every ISO time is >= '' so "all" needs no special case.
  const from = since ?? '';
  const repo = opts.repoId;
  /** Condition and parameters: `col` of a row is within the range and of the repo. */
  const where = (timeCol: string, repoCol: string): [string, SQLInputValue[]] =>
    repo ? [`${timeCol} >= ? AND ${repoCol} = ?`, [from, repo]] : [`${timeCol} >= ?`, [from]];
  const all = (sql: string, params: SQLInputValue[]) => db.prepare(sql).all(...params) as Row[];
  const get = (sql: string, params: SQLInputValue[]) =>
    (db.prepare(sql).get(...params) ?? {}) as Row;

  // ---- Runs created in the range -----------------------------------------------------------
  const [runWhere, runParams] = where('r.created_at', 'r.repo_id');
  const byStatus: Partial<Record<RunStatus, number>> = {};
  let totalRuns = 0;
  for (const row of all(
    `SELECT r.status AS status, COUNT(*) AS n FROM runs r WHERE ${runWhere} GROUP BY r.status`,
    runParams,
  )) {
    byStatus[row.status as RunStatus] = num(row.n);
    totalRuns += num(row.n);
  }
  const issues = get(
    `SELECT COUNT(*) AS n,
       SUM(json_extract(r.issue, '$.auto') = 1) AS auto,
       SUM(r.status = 'completed' AND r.issue_synced = 'completed') AS closed
     FROM runs r WHERE r.issue IS NOT NULL AND ${runWhere}`,
    runParams,
  );
  const completedWhere = `r.status = 'completed' AND r.finished_at IS NOT NULL AND ${runWhere}`;
  const completed = get(
    `SELECT COUNT(*) AS n, SUM(r.cost_usd) AS cost, AVG(${ms('r.created_at', 'r.finished_at')}) AS avg
     FROM runs r WHERE ${completedWhere}`,
    runParams,
  );
  // Median: the middle one, or the average of the middle two.
  const median = get(
    `WITH d AS (SELECT ${ms('r.created_at', 'r.finished_at')} AS ms FROM runs r WHERE ${completedWhere})
     SELECT AVG(ms) AS median FROM (
       SELECT ms FROM d ORDER BY ms
       LIMIT 2 - (SELECT COUNT(*) FROM d) % 2 OFFSET ((SELECT COUNT(*) FROM d) - 1) / 2
     )`,
    runParams,
  );
  const completedCount = num(completed.n);

  // Rounds and failures over the whole life of those Runs.
  const stages = get(
    `SELECT
       SUM(sr.fail_reason = 'review') AS review,
       SUM(sr.fail_reason = 'check') AS checks,
       SUM(sr.fail_reason = 'rejected') AS rejected,
       SUM(EXISTS (
         SELECT 1 FROM json_each(r.template, '$.stages') st
         WHERE json_extract(st.value, '$.id') = sr.stage_id
           AND COALESCE(json_extract(st.value, '$.kind'), 'agent') = 'agent'
       )) AS agent_rounds
     FROM stage_runs sr JOIN runs r ON r.id = sr.run_id WHERE ${runWhere}`,
    runParams,
  );
  const reworks = get(
    `SELECT COUNT(*) AS n FROM attempts a JOIN runs r ON r.id = a.run_id
     WHERE a.outcome = 'rework' AND ${runWhere}`,
    runParams,
  );

  // ---- Tasks, executions and scouts by when they happened -----------------------------------
  const [taskWhere, taskParams] = where('t.created_at', 'r.repo_id');
  const tasks = get(
    `SELECT COUNT(*) AS n FROM tasks t JOIN runs r ON r.id = t.run_id WHERE ${taskWhere}`,
    taskParams,
  );

  const [attemptWhere, attemptParams] = where('a.started_at', 'r.repo_id');
  const attemptJoin = `FROM attempts a JOIN runs r ON r.id = a.run_id WHERE ${attemptWhere}`;
  const [scoutWhere, scoutParams] = where('s.started_at', 's.repo_id');
  const scoutFrom = `FROM scouts s WHERE ${scoutWhere}`;

  const agents = new Map<string, StatsAgent>();
  const agentRow = (agentId: string, model: string | null): StatsAgent => {
    const key = JSON.stringify([agentId, model]);
    let row = agents.get(key);
    if (!row) {
      row = {
        agentId,
        model,
        attempts: 0,
        scouts: 0,
        costUsd: 0,
        costUnknown: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        durationMs: 0,
      };
      agents.set(key, row);
    }
    return row;
  };
  for (const row of all(
    `SELECT a.agent_id AS agent, COALESCE(a.actual_model, a.model) AS model, COUNT(*) AS n,
       SUM(a.cost_usd) AS cost, SUM(a.cost_usd IS NULL AND a.status != 'running') AS unknown,
       SUM(a.input_tokens) AS input, SUM(a.output_tokens) AS output, SUM(a.cached_tokens) AS cached,
       SUM(${ms('a.started_at', 'a.ended_at')}) AS ms
     ${attemptJoin} GROUP BY 1, 2`,
    attemptParams,
  )) {
    const agent = agentRow(String(row.agent), row.model === null ? null : String(row.model));
    agent.attempts = num(row.n);
    agent.costUsd += num(row.cost);
    agent.costUnknown += num(row.unknown);
    agent.inputTokens = num(row.input);
    agent.outputTokens = num(row.output);
    agent.cachedTokens = num(row.cached);
    agent.durationMs += num(row.ms);
  }
  // A scout's cost is unknown only once it is known to have run the agent to the end.
  for (const row of all(
    `SELECT s.agent_id AS agent, s.model AS model, COUNT(*) AS n, SUM(s.cost_usd) AS cost,
       SUM(s.cost_usd IS NULL AND s.status = 'completed') AS unknown,
       SUM(${ms('s.started_at', 's.ended_at')}) AS ms
     ${scoutFrom} GROUP BY 1, 2`,
    scoutParams,
  )) {
    const agent = agentRow(String(row.agent), row.model === null ? null : String(row.model));
    agent.scouts = num(row.n);
    agent.costUsd += num(row.cost);
    agent.costUnknown += num(row.unknown);
    agent.durationMs += num(row.ms);
  }
  const agentList = [...agents.values()]
    .map((a) => ({ ...a, costUsd: usd(a.costUsd), durationMs: round(a.durationMs) }))
    .sort(
      (a, b) =>
        b.costUsd - a.costUsd ||
        b.attempts + b.scouts - (a.attempts + a.scouts) ||
        a.agentId.localeCompare(b.agentId),
    );
  const sum = (pick: (a: StatsAgent) => number) => agentList.reduce((n, a) => n + pick(a), 0);

  const scouts = get(
    `SELECT COUNT(*) AS n, SUM(s.cost_usd) AS cost, SUM(json_array_length(s.proposals)) AS proposals,
       SUM(s.cost_usd IS NULL AND s.status = 'completed') AS unknown,
       SUM(${ms('s.started_at', 's.ended_at')}) AS ms
     ${scoutFrom}`,
    scoutParams,
  );
  const autoProposals = get(
    `SELECT COUNT(*) AS n FROM scouts s, json_each(s.proposals) p
     WHERE json_extract(p.value, '$.issue.auto') = 1 AND ${scoutWhere}`,
    scoutParams,
  );
  const attempts = get(
    `SELECT SUM(a.cost_usd) AS cost, SUM(a.cost_usd IS NULL AND a.status != 'running') AS unknown,
       SUM(${ms('a.started_at', 'a.ended_at')}) AS ms
     ${attemptJoin}`,
    attemptParams,
  );

  // ---- Cost by day (local) and by repo ------------------------------------------------------
  const days = new Map<string, { day: string; runsUsd: number; scoutsUsd: number }>();
  const dayRow = (day: string) => {
    let row = days.get(day);
    if (!row) {
      row = { day, runsUsd: 0, scoutsUsd: 0 };
      days.set(day, row);
    }
    return row;
  };
  for (const row of all(
    `SELECT date(a.started_at, 'localtime') AS day, SUM(a.cost_usd) AS cost ${attemptJoin} GROUP BY 1`,
    attemptParams,
  )) {
    dayRow(String(row.day)).runsUsd = usd(row.cost);
  }
  for (const row of all(
    `SELECT date(s.started_at, 'localtime') AS day, SUM(s.cost_usd) AS cost ${scoutFrom} GROUP BY 1`,
    scoutParams,
  )) {
    dayRow(String(row.day)).scoutsUsd = usd(row.cost);
  }

  const repos = new Map<string, StatsView['cost']['byRepo'][number]>();
  const repoRow = (repoId: string, name: string) => {
    let row = repos.get(repoId);
    if (!row) {
      row = { repoId, repo: name, runsUsd: 0, scoutsUsd: 0 };
      repos.set(repoId, row);
    }
    return row;
  };
  for (const row of all(
    `SELECT r.repo_id AS id, p.name AS name, SUM(a.cost_usd) AS cost
     FROM attempts a JOIN runs r ON r.id = a.run_id JOIN repos p ON p.id = r.repo_id
     WHERE ${attemptWhere} GROUP BY 1, 2`,
    attemptParams,
  )) {
    repoRow(String(row.id), String(row.name)).runsUsd = usd(row.cost);
  }
  for (const row of all(
    `SELECT s.repo_id AS id, p.name AS name, SUM(s.cost_usd) AS cost
     FROM scouts s JOIN repos p ON p.id = s.repo_id WHERE ${scoutWhere} GROUP BY 1, 2`,
    scoutParams,
  )) {
    repoRow(String(row.id), String(row.name)).scoutsUsd = usd(row.cost);
  }

  // ---- Waiting for a human ------------------------------------------------------------------
  const [approvalWhere, approvalParams] = where('ap.created_at', 'r.repo_id');
  const approvals = get(
    `SELECT COUNT(*) AS n, SUM(${ms('ap.created_at', 'ap.decided_at')}) AS ms
     FROM approvals ap JOIN runs r ON r.id = ap.run_id
     WHERE ap.decided_at IS NOT NULL AND ${approvalWhere}`,
    approvalParams,
  );
  // A block lasts until the Run's next status change: a retry requeues it, or it is terminated.
  const [blockWhere, blockParams] = where('b.ts', 'r.repo_id');
  const blocks: StatsBlocks[] = all(
    `SELECT json_extract(b.data, '$.kind') AS kind, COUNT(*) AS n, COUNT(e.id) AS handled,
       SUM(${ms('b.ts', 'e.ts')}) AS ms
     FROM events b JOIN runs r ON r.id = b.run_id
     LEFT JOIN events e ON e.id = (
       SELECT s.id FROM events s
       WHERE s.run_id = b.run_id AND s.type = 'run.status' AND s.id > b.id ORDER BY s.id LIMIT 1
     )
     WHERE b.type = 'run.blocked' AND ${blockWhere} GROUP BY 1`,
    blockParams,
  )
    .map((row) => ({
      kind: (row.kind ?? 'error') as BlockKind,
      count: num(row.n),
      handled: num(row.handled),
      waitMs: round(row.ms),
    }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));

  return {
    range: opts.range,
    repoId: repo,
    since,
    at: now.toISOString(),
    runs: {
      total: totalRuns,
      byStatus,
      fromIssues: num(issues.n),
      autoAccepted: num(issues.auto),
      issuesClosed: num(issues.closed),
      completed: {
        count: completedCount,
        costUsd: usd(completed.cost),
        avgMs: completedCount ? round(completed.avg) : null,
        medianMs: completedCount ? round(median.median) : null,
      },
    },
    tasks: num(tasks.n),
    attempts: sum((a) => a.attempts),
    scouts: {
      total: num(scouts.n),
      proposals: num(scouts.proposals),
      autoAccepted: num(autoProposals.n),
    },
    cost: {
      runsUsd: usd(attempts.cost),
      scoutsUsd: usd(scouts.cost),
      unknownAttempts: num(attempts.unknown),
      unknownScouts: num(scouts.unknown),
      byDay: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
      byRepo: [...repos.values()].sort((a, b) => a.repo.localeCompare(b.repo)),
    },
    agents: agentList,
    tokens: {
      input: sum((a) => a.inputTokens),
      output: sum((a) => a.outputTokens),
      cached: sum((a) => a.cachedTokens),
    },
    time: {
      attemptsMs: round(attempts.ms),
      scoutsMs: round(scouts.ms),
      approvals: { count: num(approvals.n), waitMs: round(approvals.ms) },
    },
    quality: {
      runs: totalRuns,
      agentRounds: num(stages.agent_rounds),
      reviewFails: num(stages.review),
      checkFails: num(stages.checks),
      rejections: num(stages.rejected),
      reworks: num(reworks.n),
    },
    blocks,
  };
}
