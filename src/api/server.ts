import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { RAW_LOG_KEEP_DAYS, redoDueAt, runRawLogsExpired } from '../config/flow.js';
import type { LoadedConfig } from '../config/load.js';
import type { ConfigStatus } from '../config/watch.js';
import { type Engine, InvalidStateError, readAttemptEvents } from '../engine/engine.js';
import { storedRunTimes } from '../engine/times.js';
import type { IssueBridge } from '../github/bridge.js';
import { t } from '../i18n.js';
import { type ExecFile, systemNoticeSupported } from '../notify/system.js';
import { sendTestNotice } from '../notify/test-notice.js';
import type { WebhookNotifier } from '../notify/webhook.js';
import { ConflictError, NotFoundError, type Store } from '../store/store.js';
import type { EventRow, RunStatus } from '../store/types.js';
import type { Upgrader } from '../upgrade/upgrader.js';
import { branchExists, currentBranch, isGitRepo } from '../workspace/git.js';
import { agentSummaries } from './agents.js';
import { isCostUnknown } from './cost.js';
import { diffView, runDiffRange } from './diff.js';
import { mountDashboard } from './static.js';
import { collectStats, STATS_RANGES } from './stats.js';
import type {
  AgentSummary,
  CliInfo,
  ConfigView,
  GitHubStatus,
  HealthView,
  KeptWorkspace,
  LiveAgentEvent,
  NotifyTestResult,
  RawLogMissing,
  RunDetail,
  RunSummary,
  StatsView,
  UpgradeStatus,
} from './types.js';
import { keptWorkspaces } from './workspaces.js';

export interface ApiDeps {
  store: Store;
  engine: Engine;
  /** GitHub Issues as the backlog. */
  issues: IssueBridge;
  /** The Master upgrading itself. */
  upgrader: Upgrader;
  /** Commit of the running Master's install directory. */
  version: string | null;
  config: () => LoadedConfig;
  /** Built dashboard to serve at `/`; see `defaultWebDir()`. */
  webDir?: string;
  /** Reload status of the configuration; omitted = loaded once at startup. */
  configStatus?: () => ConfigStatus;
  /** Platform the Master runs on, for whether it sends system notifications (tests change it). */
  platform?: NodeJS.Platform;
  /** The Master's webhook notifications, which also send the test notification. */
  webhook: WebhookNotifier;
  /** Runs the test notification's system notification command (tests replace it). */
  execFile?: ExecFile;
  /** The clock, in epoch milliseconds, e.g. for whether raw logs are past retention. */
  now?: () => number;
  /**
   * A repo was registered, changed (e.g. its target branch) or deleted: read the templates the
   * repos keep again (`RepoWorkflows.refresh`; never rejects). Answered once it is done.
   */
  reposChanged?: () => Promise<void>;
  /** The CLIs the Master has an adapter for; omitted = none told. */
  clis?: readonly CliInfo[];
}

class BadRequestError extends Error {}

function noBranch(branch: string): string {
  return t({ zh: `分支 ${branch} 不存在`, en: `Branch ${branch} does not exist` });
}

const RepoInput = z.strictObject({
  name: z.string().regex(/^[\w.-]+$/, {
    error: () =>
      t({
        zh: '名称只能包含字母、数字、. _ -',
        en: 'a name may only contain letters, digits, . _ -',
      }),
  }),
  path: z.string().min(1),
  targetBranch: z.string().min(1).optional(),
  verifyCommands: z.array(z.string()).default([]),
  setupCommands: z.array(z.string()).default([]),
});

const RepoPatch = z.strictObject({
  targetBranch: z.string().min(1).optional(),
  verifyCommands: z.array(z.string()).optional(),
  setupCommands: z.array(z.string()).optional(),
});

const CommentInput = z.strictObject({ comment: z.string().optional() });
const ScoutInput = z.strictObject({ repo: z.string().min(1) });
const WorkingInput = z.strictObject({ on: z.boolean() });
const StatsQuery = z.strictObject({
  range: z.enum(STATS_RANGES).default('7d'),
  repo: z.string().min(1).optional(),
});
/** Most global events one request returns. */
const GLOBAL_EVENTS_MAX = 500;
const GlobalEventsQuery = z.strictObject({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(GLOBAL_EVENTS_MAX).default(200),
});
const RetryInput = z.strictObject({
  agentId: z.string().optional(),
  note: z.string().optional(),
  budgetUsd: z.number().positive().optional(),
});

async function body<T>(
  c: { req: { json: () => Promise<unknown> } },
  schema: z.ZodType<T>,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    raw = {};
  }
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new BadRequestError(
      parsed.error.issues
        .map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`)
        .join(t({ zh: '；', en: '; ' })),
    );
  }
  return parsed.data;
}

/** A request's query string, validated; 400 when invalid. */
function query<T>(c: { req: { query: () => Record<string, string> } }, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    throw new BadRequestError(
      parsed.error.issues
        .map((i) => `${i.path.join('.') || '(query)'}: ${i.message}`)
        .join(t({ zh: '；', en: '; ' })),
    );
  }
  return parsed.data;
}

/**
 * HTTP API of the Master. The dashboard uses these endpoints; so can scripts and tests.
 * Listens on 127.0.0.1 only: there is no login.
 */
export function createApi(deps: ApiDeps): Hono {
  const { store, engine, issues, upgrader, version, config, configStatus, webDir } = deps;
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const startedAt = new Date().toISOString();
  const status =
    configStatus ?? (() => ({ loadedAt: startedAt, reloadError: null, restartNeeded: [] }));
  const app = new Hono();

  app.onError((err, c) => {
    const status =
      err instanceof NotFoundError
        ? 404
        : err instanceof ConflictError || err instanceof InvalidStateError
          ? 409
          : err instanceof BadRequestError
            ? 400
            : 500;
    return c.json({ error: err.message }, status);
  });

  const health = (): HealthView => {
    const activeRuns = engine.activeRunIds;
    return {
      ok: true,
      activeRun: activeRuns[0] ?? null,
      activeRuns,
      working: store.working,
      // Only where the Master can send them: elsewhere the dashboard keeps sending its own.
      systemNotify: config().master.notify.system && systemNoticeSupported(platform),
      // Only whether there is one: the address and headers may carry tokens.
      webhookNotify: config().master.notify.webhook !== undefined,
      version,
    };
  };

  app.get('/api/health', (c) => c.json(health()));

  // A test notification through each channel the Master notifies by, so that a human can check
  // them right after changing config.yaml; answers once every channel has ended.
  app.post('/api/notify/test', async (c) => {
    const result = await sendTestNotice({
      config: config(),
      platform,
      webhook: deps.webhook,
      execFile: deps.execFile,
    });
    return c.json(result satisfies NotifyTestResult);
  });

  // The work switch.
  app.put('/api/working', async (c) => {
    const { on } = await body(c, WorkingInput);
    engine.setWorking(on);
    return c.json(health());
  });

  // ---- configuration (read-only) --------------------------------------
  app.get('/api/config', (c) => {
    const cfg = config();
    return c.json({
      language: cfg.master.language,
      perRepo: cfg.master.concurrency.per_repo,
      maxRuns: cfg.master.concurrency.max_runs ?? null,
      agents: [...cfg.agents.values()],
      templates: [...cfg.templates.values()],
      errors: cfg.errors,
      warnings: cfg.warnings,
      dir: cfg.dir,
      configFile: cfg.configFile,
      agentsFile: cfg.agentsFile,
      agentEntries: cfg.agentEntries,
      clis: [...(deps.clis ?? [])],
      templateFiles: cfg.templateFiles,
      repoTemplates: [...cfg.repoTemplates.values()]
        .sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0))
        .map((r) => ({
          repo: r.repo,
          branch: r.branch,
          sha: r.sha,
          templates: [...r.templates.values()],
          files: r.files,
        })),
      ...status(),
    } satisfies ConfigView);
  });

  // Agents with what they did: executions, outcomes, cost, latest error.
  app.get('/api/agents', (c) => c.json(agentSummaries(store, config()) satisfies AgentSummary[]));

  // ---- repos ---------------------------------------------------------------
  app.get('/api/repos', (c) => c.json(store.listRepos()));

  app.post('/api/repos', async (c) => {
    const input = await body(c, RepoInput);
    const path = resolve(input.path);
    if (!isAbsolute(input.path)) {
      throw new BadRequestError(
        t({ zh: 'path 必须是绝对路径', en: 'path must be an absolute path' }),
      );
    }
    if (!existsSync(path) || !(await isGitRepo(path))) {
      throw new BadRequestError(
        t({ zh: `${path} 不是 git 仓库`, en: `${path} is not a git repository` }),
      );
    }
    if (store.findRepo(input.name)) {
      throw new ConflictError(
        t({
          zh: `仓库名 ${input.name} 已存在`,
          en: `A repo named ${input.name} already exists`,
        }),
      );
    }
    const targetBranch = input.targetBranch ?? (await currentBranch(path));
    if (!(await branchExists(path, targetBranch))) {
      throw new BadRequestError(noBranch(targetBranch));
    }
    const repo = store.createRepo({
      name: input.name,
      path,
      targetBranch,
      verifyCommands: input.verifyCommands,
      setupCommands: input.setupCommands,
      mergeMode: 'direct',
    });
    await deps.reposChanged?.();
    return c.json(repo, 201);
  });

  app.patch('/api/repos/:id', async (c) => {
    const repo = store.getRepo(c.req.param('id'));
    const input = await body(c, RepoPatch);
    if (input.targetBranch && !(await branchExists(repo.path, input.targetBranch))) {
      throw new BadRequestError(noBranch(input.targetBranch));
    }
    const updated = store.updateRepo(repo.id, input);
    await deps.reposChanged?.();
    return c.json(updated);
  });

  app.delete('/api/repos/:id', async (c) => {
    const repo = store.getRepo(c.req.param('id'));
    store.deleteRepo(repo.id);
    await deps.reposChanged?.();
    return c.body(null, 204);
  });

  // ---- runs ----------------------------------------------------------------
  // There is no endpoint for creating Runs: they only come from GitHub issues (IssueBridge).
  app.get('/api/runs', (c) => {
    const status = c.req.query('status') as RunStatus | undefined;
    const repo = c.req.query('repo');
    const repoId = repo ? store.getRepo(repo).id : undefined;
    return c.json(
      store.listRuns({ status, repoId }).map((run) => summarizeRun(store, engine, run)),
    );
  });

  app.get('/api/runs/:id', async (c) => {
    const id = c.req.param('id');
    const run = store.getRun(id);
    const redoAt = redoDueAt(run, config().master.github?.poll_minutes ?? 5);
    return c.json({
      run,
      repo: store.getRepo(run.repoId),
      stageRuns: store.listStageRuns(id),
      tasks: store.listRunTasks(id),
      attempts: store.listRunAttempts(id),
      checks: store.listChecks(id),
      approvals: store.listApprovals(id),
      artifacts: store.listArtifacts(id),
      times: storedRunTimes(store, run),
      ...(await engine.inspectWorkspace(run)),
      rateLimited: engine.rateLimited(run),
      waitingForMaxRuns: engine.waitingForMaxRuns(run),
      redoAt: redoAt === null ? null : new Date(redoAt).toISOString(),
    } satisfies RunDetail);
  });

  app.get('/api/runs/:id/events', (c) => {
    const after = Number(c.req.query('after') ?? 0);
    return c.json(store.listEvents(c.req.param('id'), after));
  });

  // Events of no Run (restarts, pruned logs, upgrades, GitHub errors...), newest first;
  // ?before=<id> pages back.
  app.get('/api/events', (c) => {
    const { before, limit } = query(c, GlobalEventsQuery);
    return c.json(store.listGlobalEvents({ beforeId: before, limit }) satisfies EventRow[]);
  });

  // What the Run changes on its target branch, or one task commit with ?commit=<sha>.
  app.get('/api/runs/:id/diff', async (c) => {
    const run = store.getRun(c.req.param('id'));
    const repo = store.getRepo(run.repoId);
    const commit = c.req.query('commit');
    if (commit) {
      if (!store.listRunTasks(run.id).some((task) => task.commitSha === commit)) {
        throw new NotFoundError(
          t({
            zh: `提交 ${commit} 不属于这个 Run`,
            en: `Commit ${commit} does not belong to this Run`,
          }),
        );
      }
      return c.json(await diffView(repo.path, `${commit}^`, commit));
    }
    const range = await runDiffRange(repo, run, store.listEvents(run.id));
    if (!range) return c.json(null);
    return c.json(await diffView(repo.path, range.base, range.head));
  });

  app.get('/api/runs/:id/artifacts/:artifactId', (c) => {
    const artifact = store
      .listArtifacts(c.req.param('id'))
      .find((a) => a.id === c.req.param('artifactId'));
    if (!artifact) {
      throw new NotFoundError(t({ zh: '产物不存在', en: 'No such artifact' }));
    }
    return c.text(readFileSync(artifact.path, 'utf8'));
  });

  app.post('/api/runs/:id/approve', async (c) => {
    const { comment } = await body(c, CommentInput);
    return c.json(engine.approve(c.req.param('id'), comment));
  });

  app.post('/api/runs/:id/reject', async (c) => {
    const { comment } = await body(c, CommentInput);
    return c.json(engine.reject(c.req.param('id'), comment ?? ''));
  });

  app.post('/api/runs/:id/retry', async (c) => {
    const input = await body(c, RetryInput);
    return c.json(await engine.retry(c.req.param('id'), input));
  });

  app.post('/api/runs/:id/pause', async (c) => c.json(await engine.pause(c.req.param('id'))));
  app.post('/api/runs/:id/resume', (c) => c.json(engine.resume(c.req.param('id'))));
  app.post('/api/runs/:id/cancel', async (c) => c.json(await engine.cancel(c.req.param('id'))));
  // Remove the worktree and branch a failed / cancelled Run kept.
  app.post('/api/runs/:id/cleanup', async (c) =>
    c.json(await engine.cleanupWorkspace(c.req.param('id'))),
  );

  // ---- workspaces kept by finished Runs --------------------------------
  app.get('/api/workspaces', async (c) =>
    c.json((await keptWorkspaces(store, engine)) satisfies KeptWorkspace[]),
  );

  // ---- statistics ------------------------------------------------------
  app.get('/api/stats', (c) => {
    const { range, repo } = query(c, StatsQuery);
    const repoId = repo ? store.getRepo(repo).id : null;
    return c.json(collectStats(store, { range, repoId }) satisfies StatsView);
  });

  // ---- the Master upgrading itself --------------------------------------
  app.get('/api/upgrade', (c) => c.json(upgrader.status() satisfies UpgradeStatus));

  app.post('/api/upgrade/check', async (c) => {
    await upgrader.check();
    return c.json(upgrader.status() satisfies UpgradeStatus);
  });

  // ---- GitHub issues and scouts --------------------------------------
  app.get('/api/github', (c) => c.json(issues.status() satisfies GitHubStatus));

  // Look for ready issues and catch issues up now instead of at the next poll.
  app.post('/api/github/poll', async (c) => {
    await issues.poll();
    return c.json(issues.status() satisfies GitHubStatus);
  });

  app.get('/api/scouts', (c) => {
    const repo = c.req.query('repo');
    const repoId = repo ? store.getRepo(repo).id : undefined;
    return c.json(store.listScouts({ repoId, limit: 30 }));
  });

  app.post('/api/scouts', async (c) => {
    const { repo } = await body(c, ScoutInput);
    return c.json(await issues.startScout(repo, 'manual'), 201);
  });

  // ---- logs ----------------------------------------------------------------
  app.get('/api/attempts/:id/log', (c) => {
    const attempt = store.getAttempt(c.req.param('id'));
    if (!existsSync(attempt.logPath)) {
      const pruned = runRawLogsExpired(store.getRun(attempt.runId), now());
      const missing: RawLogMissing = {
        error: pruned
          ? t({
              zh: `原始日志已超过保留期（Run 结束 ${RAW_LOG_KEEP_DAYS} 天后）被删除，Agent 输出仍可在 Run 详情页查看`,
              en: `The raw log was deleted once past retention (${RAW_LOG_KEEP_DAYS} days after the Run ended); the agent output is still on the Run page`,
            })
          : t({ zh: '日志文件不存在', en: 'The log file does not exist' }),
        pruned,
      };
      return c.json(missing, 404);
    }
    if (c.req.query('download') !== undefined) {
      c.header('content-disposition', `attachment; filename="${attempt.id}.jsonl"`);
    }
    return c.text(readFileSync(attempt.logPath, 'utf8'));
  });

  // Normalized agent events recorded so far; live ones follow on /api/stream.
  app.get('/api/attempts/:id/events', (c) => {
    const attempt = store.getAttempt(c.req.param('id'));
    return c.json(readAttemptEvents(attempt.logPath));
  });

  // ---- live stream (Server-Sent Events) --------------------------------------
  app.get('/api/stream', (c) => {
    const runId = c.req.query('run');
    return streamSSE(c, async (stream) => {
      const queue: { event: string; data: string }[] = [];
      let wake: (() => void) | undefined;
      const push = (event: string, data: unknown) => {
        queue.push({ event, data: JSON.stringify(data) });
        wake?.();
      };
      const onEvent = (e: EventRow) => {
        if (!runId || e.runId === runId) push('event', e);
      };
      const onAgent = (e: LiveAgentEvent) => {
        if (!runId || e.runId === runId) push('agent', e);
      };
      store.bus.on('event', onEvent);
      engine.live.on('agent', onAgent);
      let closed = false;
      stream.onAbort(() => {
        closed = true;
        wake?.();
      });
      try {
        while (!closed) {
          const next = queue.shift();
          if (next) {
            await stream.writeSSE(next);
            continue;
          }
          await new Promise<void>((r) => {
            wake = r;
            setTimeout(r, 15_000); // heartbeat
          });
          wake = undefined;
          if (queue.length === 0 && !closed) await stream.writeSSE({ event: 'ping', data: '{}' });
        }
      } finally {
        store.bus.off('event', onEvent);
        engine.live.off('agent', onAgent);
      }
    });
  });

  mountDashboard(app, webDir);
  return app;
}

function summarizeRun(store: Store, engine: Engine, run: ReturnType<Store['getRun']>): RunSummary {
  const { template, ...rest } = run;
  let currentStage: { id: string; name: string; round: number } | null = null;
  if (run.currentStageRunId) {
    const sr = store.getStageRun(run.currentStageRunId);
    const def = template.stages.find((s) => s.id === sr.stageId);
    currentStage = { id: sr.stageId, name: def?.name ?? sr.stageId, round: sr.round };
  }
  return {
    ...rest,
    templateName: template.name ?? template.id,
    currentStage,
    costUnknown: store.listRunAttempts(run.id).some(isCostUnknown),
    waitingForMaxRuns: engine.waitingForMaxRuns(run),
  };
}
