import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { LocalBacklog } from '../backlog/local.js';
import { RepoSourceInputSchema, SourceEditConflict, SourceEditInvalid } from '../config/edit.js';
import {
  PROPOSAL_SIZES,
  RAW_LOG_KEEP_DAYS,
  REPO_SERVE_DEFAULTS,
  REPO_SERVE_TIMEOUT_SECONDS,
  REQUIREMENT_ITEMS_MAX,
  REQUIREMENT_TEXT_MAX,
  REQUIREMENT_TITLE_MAX,
  RISKS,
  redoDueAt,
  requirementSource,
  runRawLogsExpired,
  SCOUT_GOAL_MAX,
  serveReadyPathValid,
  serveReadyTimeoutValid,
  sourcePollMinutes,
} from '../config/flow.js';
import type { LoadedConfig } from '../config/load.js';
import type { MasterConfig, ProposalSourceConfig } from '../config/schema.js';
import type { ConfigStatus } from '../config/watch.js';
import {
  type Engine,
  InvalidInputError,
  InvalidStateError,
  readAttemptEvents,
} from '../engine/engine.js';
import { storedRunTimes } from '../engine/times.js';
import type { IssueBridge } from '../github/bridge.js';
import { t } from '../i18n.js';
import { type ExecFile, systemNoticeSupported } from '../notify/system.js';
import { sendTestNotice } from '../notify/test-notice.js';
import type { WebhookNotifier } from '../notify/webhook.js';
import { ConflictError, NotFoundError, type Store } from '../store/store.js';
import {
  type EventRow,
  ITERATION_STATUSES,
  type Iteration,
  PROPOSAL_CATEGORIES,
  PROPOSAL_STATUSES,
  type Repo,
  type RepoServe,
  type RunStatus,
} from '../store/types.js';
import type { Upgrader } from '../upgrade/upgrader.js';
import { errorMessage, StoppableWork } from '../util.js';
import type { RepoTrials } from '../verify/trial.js';
import { DETECT_READ_FILES, detectProjectCommands } from '../workspace/detect.js';
import {
  branchExists,
  type CommittedRoot,
  cloneRepo,
  cloneUrlAllowed,
  committedRootFiles,
  currentBranch,
  GitError,
  initEmptyRepo,
  isGitRepo,
  validBranchName,
} from '../workspace/git.js';
import { agentSummaries } from './agents.js';
import { isCostUnknown } from './cost.js';
import { diffView, runDiffRange } from './diff.js';
import { iterationView } from './iterations.js';
import { proposalSettings, proposalView } from './proposals.js';
import { mountDashboard } from './static.js';
import { collectStats, STATS_RANGES } from './stats.js';
import type {
  AgentSummary,
  BacklogStatus,
  CliInfo,
  ConfigView,
  GitHubStatus,
  HealthView,
  IterationView,
  KeptWorkspace,
  LiveAgentEvent,
  LiveNotice,
  NotifyTestResult,
  ProposalAccepted,
  ProposalRestarted,
  ProposalView,
  ProposalWritten,
  RawLogMissing,
  RepoDetection,
  RepoInputSource,
  RepoPatchInput,
  RepoServeInput,
  RepoSourceInput,
  RepoSourceRejected,
  RepoSourceSettings,
  RepoSourceView,
  RepoTrial,
  RepoTrialInput,
  RunDetail,
  RunSummary,
  StatsView,
  UpgradeStatus,
} from './types.js';
import { keptWorkspaces } from './workspaces.js';

export interface ApiDeps {
  store: Store;
  engine: Engine;
  /** GitHub Issues as the backlog (github.repos). */
  issues: IssueBridge;
  /** GitLab Issues as the backlog (gitlab.repos). */
  gitlabIssues: IssueBridge;
  /** The local backlog of the repos on neither GitHub nor GitLab (backlog.repos). */
  backlog: LocalBacklog;
  /** The Master upgrading itself. */
  upgrader: Upgrader;
  /** Trial runs of the repos' setup and verify commands. */
  trials: RepoTrials;
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
  /**
   * Writes where the repo named `repo` takes its requirements from into config.yaml and loads
   * the configuration again (`saveRepoSource`): throws a SourceEditInvalid or a
   * SourceEditConflict with the file left as it was.
   */
  saveRepoSource: (repo: string, input: RepoSourceInput) => void;
  /**
   * The registrations cloning or making their repo (POST /api/repos with a source): stopping it
   * stops their clones and waits until what they made is removed. Omitted = never stopped.
   */
  newRepos?: StoppableWork;
}

function noBranch(branch: string): string {
  return t({ zh: `分支 ${branch} 不存在`, en: `Branch ${branch} does not exist` });
}

const urlUnsupported = () =>
  t({
    zh: '只支持 https://、ssh://、user@host:path 形式的地址和本机的绝对路径',
    en: 'only https://, ssh:// and user@host:path addresses and absolute paths on this machine are supported',
  });

const RepoInputSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('clone'),
    url: z.string().trim().refine(cloneUrlAllowed, { error: urlUnsupported }),
  }),
  z.strictObject({ kind: z.literal('init') }),
]) satisfies z.ZodType<RepoInputSource>;

const serveTimeoutInvalid = () => {
  const { min, max } = REPO_SERVE_TIMEOUT_SECONDS;
  return t({
    zh: `就绪超时必须是 ${min} 到 ${max} 之间的整数（秒）`,
    en: `the ready timeout must be a whole number of seconds from ${min} to ${max}`,
  });
};

/** A repo's service; what is left out takes the defaults of the repos table. */
const RepoServeSchema = z.strictObject({
  command: z
    .string()
    .trim()
    .min(1, { error: () => t({ zh: '启动命令不能为空', en: 'the start command is empty' }) }),
  readyPath: z
    .string()
    .refine(serveReadyPathValid, {
      error: () => t({ zh: '就绪路径必须以 / 开头', en: 'the ready path must start with /' }),
    })
    .default(REPO_SERVE_DEFAULTS.readyPath),
  readyTimeoutSeconds: z
    .number({ error: serveTimeoutInvalid })
    .refine(serveReadyTimeoutValid, { error: serveTimeoutInvalid })
    .default(REPO_SERVE_DEFAULTS.readyTimeoutSeconds),
}) satisfies z.ZodType<RepoServe, RepoServeInput>;

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
  serve: RepoServeSchema.nullable().optional(),
  source: RepoInputSourceSchema.optional(),
});

function nameTaken(name: string): ConflictError {
  return new ConflictError(
    t({ zh: `仓库名 ${name} 已存在`, en: `A repo named ${name} already exists` }),
  );
}

/**
 * Whether a repo can be cloned or made at `path`: it is missing, an empty directory, or
 * `taken` (anything else there).
 */
function newRepoPathState(path: string): 'missing' | 'empty' | 'taken' {
  if (!existsSync(path)) return 'missing';
  try {
    return statSync(path).isDirectory() && readdirSync(path).length === 0 ? 'empty' : 'taken';
  } catch {
    return 'taken';
  }
}

/**
 * Undo what was made at `path` for a registration that failed: `created` is the first directory
 * made for it (`path` or a missing parent), removed with all in it; undefined = `path` was an
 * empty directory already, which is emptied again and stays. Best effort.
 */
function removeNewRepo(path: string, created: string | undefined): void {
  try {
    if (created !== undefined) {
      rmSync(created, { recursive: true, force: true });
      return;
    }
    for (const entry of readdirSync(path))
      rmSync(join(path, entry), { recursive: true, force: true });
  } catch {
    // Nothing more to do: the error the registration failed with is what the human needs.
  }
}

const RepoPatch = z.strictObject({
  targetBranch: z.string().min(1).optional(),
  verifyCommands: z.array(z.string()).optional(),
  setupCommands: z.array(z.string()).optional(),
  serve: RepoServeSchema.nullable().optional(),
}) satisfies z.ZodType<unknown, RepoPatchInput>;

/** Commands to try instead of the registered ones; nothing is saved. */
const RepoTrialBody = z.strictObject({
  setupCommands: z.array(z.string()).optional(),
  verifyCommands: z.array(z.string()).optional(),
}) satisfies z.ZodType<RepoTrialInput>;

const CommentInput = z.strictObject({ comment: z.string().optional() });
/** Most proposals one request returns. */
const PROPOSALS_MAX = 500;
const ProposalsQuery = z.strictObject({
  repo: z.string().min(1).optional(),
  status: z.enum(PROPOSAL_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(PROPOSALS_MAX).optional(),
});
const tooLong = (max: number) => () =>
  t({ zh: `最多 ${max} 个字`, en: `at most ${max} characters` });
const titleNeeded = () => t({ zh: '需求的标题不能为空', en: 'A requirement needs a title' });
const whatNeeded = () => t({ zh: '需求要写清楚要做什么', en: 'A requirement needs what to do' });
const requirementText = () =>
  z
    .string()
    .trim()
    .max(REQUIREMENT_TEXT_MAX, { error: tooLong(REQUIREMENT_TEXT_MAX) });
const WriteProposalInput = z.strictObject({
  repo: z.string().trim().min(1),
  title: z
    .string({ error: titleNeeded })
    .trim()
    .min(1, { error: titleNeeded })
    .max(REQUIREMENT_TITLE_MAX, { error: tooLong(REQUIREMENT_TITLE_MAX) }),
  what: z
    .string({ error: whatNeeded })
    .trim()
    .min(1, { error: whatNeeded })
    .max(REQUIREMENT_TEXT_MAX, { error: tooLong(REQUIREMENT_TEXT_MAX) }),
  why: requirementText().optional(),
  evidence: z.array(requirementText()).max(REQUIREMENT_ITEMS_MAX).optional(),
  acceptance: z.array(requirementText()).max(REQUIREMENT_ITEMS_MAX).optional(),
  category: z.enum(PROPOSAL_CATEGORIES).optional(),
  size: z.enum(PROPOSAL_SIZES).optional(),
  risk: z.enum(RISKS).optional(),
  start: z.boolean().optional(),
});
const nothingToEdit = () =>
  t({
    zh: '至少要改一项：title、what、why、evidence、acceptance、category、size、risk',
    en: 'Change at least one of title, what, why, evidence, acceptance, category, size, risk',
  });
/**
 * An edit of a pending proposal (PATCH /api/proposals/:id): the fields of a requirement a human
 * writes, each optional and checked by the same rules (a title or what to do given must not be
 * blank), at least one of them.
 */
const EditProposalInput = WriteProposalInput.omit({ repo: true, start: true })
  .partial()
  .refine((edit) => Object.values(edit).some((v) => v !== undefined), { error: nothingToEdit });
const goalBlank = () =>
  t({
    zh: '侦察的方向不能是空白；不想给方向就不传 goal',
    en: "A scout's direction cannot be blank; leave goal out to give none",
  });
/**
 * A scout by hand; `goal`: a direction from the human on the dashboard, one sentence the scout
 * plans its iteration around. It comes from the person at this machine, so no trust check of the
 * code host applies to it.
 */
const ScoutInput = z.strictObject({
  repo: z.string().min(1),
  goal: z
    .string()
    .trim()
    .min(1, { error: goalBlank })
    .max(SCOUT_GOAL_MAX, { error: tooLong(SCOUT_GOAL_MAX) })
    .optional(),
});
const reasonNeeded = () =>
  t({ zh: '拒绝提案时必须填写理由', en: 'Rejecting a proposal needs a reason' });
const RejectProposalInput = z.strictObject({
  reason: z.string({ error: reasonNeeded }).trim().min(1, { error: reasonNeeded }),
});
/** Most iterations one request returns. */
const ITERATIONS_MAX = 500;
const IterationsQuery = z.strictObject({
  repo: z.string().min(1).optional(),
  /** One status, or several separated by commas: `pending,active,blocked` for those not over. */
  status: z
    .string()
    .transform((s) => s.split(','))
    .pipe(z.array(z.enum(ITERATION_STATUSES)))
    .optional(),
  limit: z.coerce.number().int().min(1).max(ITERATIONS_MAX).optional(),
});
const iterationReasonNeeded = () =>
  t({ zh: '拒绝迭代时必须填写理由', en: 'Rejecting an iteration needs a reason' });
const RejectIterationInput = z.strictObject({
  reason: z
    .string({ error: iterationReasonNeeded })
    .trim()
    .min(1, { error: iterationReasonNeeded }),
});
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

/** The issues of a failed validation one by one, "path: message"; `whole` when there is no path. */
function issueLines(error: z.ZodError, whole: string): string[] {
  return error.issues.map((i) => `${i.path.join('.') || whole}: ${i.message}`);
}

const joinProblems = (problems: readonly string[]) => problems.join(t({ zh: '；', en: '; ' }));

/** A request's JSON body; an empty object when it has none or it is not JSON. */
async function rawBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return (await c.req.json()) ?? {};
  } catch {
    return {};
  }
}

async function body<T>(
  c: { req: { json: () => Promise<unknown> } },
  schema: z.ZodType<T>,
): Promise<T> {
  const parsed = schema.safeParse(await rawBody(c));
  if (!parsed.success) {
    throw new InvalidInputError(joinProblems(issueLines(parsed.error, '(body)')));
  }
  return parsed.data;
}

/** A request's query string, validated; 400 when invalid. */
function query<T>(c: { req: { query: () => Record<string, string> } }, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    throw new InvalidInputError(joinProblems(issueLines(parsed.error, '(query)')));
  }
  return parsed.data;
}

/** The 400 of PUT /api/repos/:id/source, with its problems one by one. */
function sourceRejected(problems: readonly string[]): RepoSourceRejected {
  return {
    error: t({
      zh: `设置有问题，config.yaml 没有改动：${joinProblems(problems)}`,
      en: `The settings have problems; config.yaml was left as it was: ${joinProblems(problems)}`,
    }),
    problems: [...problems],
  };
}

/**
 * HTTP API of the Master. The dashboard uses these endpoints; so can scripts and tests.
 * Listens on 127.0.0.1 only: there is no login.
 */
export function createApi(deps: ApiDeps): Hono {
  const { store, engine, issues, gitlabIssues, backlog, upgrader, version, config } = deps;
  const { configStatus, webDir } = deps;
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
          : err instanceof InvalidInputError
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

  // ---- configuration (read-only; requirements sources are set on the repos) ----
  const configView = (): ConfigView => {
    const cfg = config();
    return {
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
      repoSources: repoSourceViews(cfg.master),
      ...status(),
    };
  };

  app.get('/api/config', (c) => c.json(configView()));

  // Agents with what they did: executions, outcomes, cost, latest error.
  app.get('/api/agents', (c) => c.json(agentSummaries(store, config()) satisfies AgentSummary[]));

  // ---- repos ---------------------------------------------------------------
  app.get('/api/repos', (c) => c.json(store.listRepos()));

  // Names and paths of the registrations cloning or making their repo now: a second one with the
  // same name or path would clone in vain or into the same directory.
  const newReposPending = new Set<string>();
  const newRepos = deps.newRepos ?? new StoppableWork();

  /**
   * Registers (`register`) a repo first made at `path` by `source`: cloned (`targetBranch`
   * checked out, else the remote's default branch) or new (an empty first commit on
   * `targetBranch`, else main). Everything is checked before the disk is touched; when anything
   * fails afterwards, what was made goes. A clone stops when `signal` aborts (the Master
   * stopping), and what it cloned goes too.
   */
  const makeNewRepo = async (
    input: z.infer<typeof RepoInput>,
    path: string,
    source: RepoInputSource,
    register: (targetBranch: string) => Repo,
    signal: AbortSignal,
  ): Promise<Repo> => {
    if (store.findRepo(input.name)) throw nameTaken(input.name);
    const branch = input.targetBranch;
    if (branch !== undefined && !(await validBranchName(branch))) {
      throw new InvalidInputError(
        t({ zh: `${branch} 不是合法的分支名`, en: `${branch} is not a valid branch name` }),
      );
    }
    const state = newRepoPathState(path);
    if (state === 'taken') {
      throw new InvalidInputError(
        t({
          zh: `${path} 已经存在而且不是空目录；克隆或新建仓库要用一个不存在的路径或空目录`,
          en: `${path} already exists and is not an empty directory; cloning or making a repo needs a path that does not exist or an empty directory`,
        }),
      );
    }
    const keys = [`name:${input.name}`, `path:${path}`];
    if (keys.some((key) => newReposPending.has(key))) {
      throw new ConflictError(
        t({
          zh: `另一次登记正在用仓库名 ${input.name} 或路径 ${path} 克隆或新建仓库`,
          en: `Another registration is cloning or making a repo named ${input.name} or at ${path}`,
        }),
      );
    }
    for (const key of keys) newReposPending.add(key);
    let created: string | undefined;
    try {
      try {
        created = mkdirSync(path, { recursive: true });
      } catch (err) {
        throw new InvalidInputError(
          t({
            zh: `建不了目录 ${path}：${(err as Error).message}`,
            en: `Could not create the directory ${path}: ${(err as Error).message}`,
          }),
        );
      }
      let targetBranch: string;
      if (source.kind === 'clone') {
        const timeoutMs = config().master.defaults.command_timeout_minutes * 60_000;
        await cloneRepo(source.url, path, { branch, timeoutMs, signal });
        targetBranch = branch ?? (await currentBranch(path));
      } else {
        targetBranch = branch ?? 'main';
        await initEmptyRepo(path, targetBranch);
      }
      if (!(await branchExists(path, targetBranch))) {
        throw new InvalidInputError(noBranch(targetBranch));
      }
      // A registration without a source may have taken the name while this one cloned.
      if (store.findRepo(input.name)) throw nameTaken(input.name);
      return register(targetBranch);
    } catch (err) {
      removeNewRepo(path, state === 'missing' ? (created ?? path) : undefined);
      // Stopped with the Master: nothing wrong with what the human gave.
      if (err instanceof GitError && signal.aborted) throw new ConflictError(err.message);
      // git's failures here come from what the human gave: the address, the branch, the path.
      if (err instanceof GitError) throw new InvalidInputError(err.message);
      throw err;
    } finally {
      for (const key of keys) newReposPending.delete(key);
    }
  };

  // A repo already on this machine; or, with `source`, one the Master clones or makes first.
  app.post('/api/repos', async (c) => {
    const input = await body(c, RepoInput);
    const path = resolve(input.path);
    if (!isAbsolute(input.path)) {
      throw new InvalidInputError(
        t({ zh: 'path 必须是绝对路径', en: 'path must be an absolute path' }),
      );
    }
    const register = (targetBranch: string): Repo =>
      store.createRepo({
        name: input.name,
        path,
        targetBranch,
        verifyCommands: input.verifyCommands,
        setupCommands: input.setupCommands,
        mergeMode: 'direct',
        serve: input.serve ?? null,
      });
    let repo: Repo;
    if (input.source) {
      const source = input.source;
      repo = await newRepos.run((signal) => makeNewRepo(input, path, source, register, signal));
    } else {
      if (!existsSync(path) || !(await isGitRepo(path))) {
        throw new InvalidInputError(
          t({ zh: `${path} 不是 git 仓库`, en: `${path} is not a git repository` }),
        );
      }
      if (store.findRepo(input.name)) throw nameTaken(input.name);
      const targetBranch = input.targetBranch ?? (await currentBranch(path));
      if (!(await branchExists(path, targetBranch))) {
        throw new InvalidInputError(noBranch(targetBranch));
      }
      repo = register(targetBranch);
    }
    await deps.reposChanged?.();
    return c.json(repo, 201);
  });

  app.patch('/api/repos/:id', async (c) => {
    const repo = store.getRepo(c.req.param('id'));
    const input = await body(c, RepoPatch);
    if (input.targetBranch && !(await branchExists(repo.path, input.targetBranch))) {
      throw new InvalidInputError(noBranch(input.targetBranch));
    }
    const updated = store.updateRepo(repo.id, input);
    await deps.reposChanged?.();
    return c.json(updated);
  });

  // Where the repo takes its requirements from: its entry under config.yaml's github.repos,
  // gitlab.repos or backlog.repos, written by the Master with the rest of the file and its
  // comments left as they are, and put in use at once (`saveRepoSource`). Answers the new
  // GET /api/config; 400 with the problems one by one when the body or the settings it asks for
  // are wrong, 409 when the configuration does not load as it is; config.yaml unchanged in both.
  app.put('/api/repos/:id/source', async (c) => {
    const repo = store.getRepo(c.req.param('id'));
    const parsed = RepoSourceInputSchema.safeParse(await rawBody(c));
    if (!parsed.success) return c.json(sourceRejected(issueLines(parsed.error, '(body)')), 400);
    try {
      deps.saveRepoSource(repo.name, parsed.data);
    } catch (err) {
      if (err instanceof SourceEditInvalid) return c.json(sourceRejected(err.problems), 400);
      if (err instanceof SourceEditConflict) return c.json({ error: err.message }, 409);
      throw err;
    }
    return c.json(configView());
  });

  // Setup and verify commands suggested by the files at the root of the repo's target branch, as
  // committed: a worktree's uncommitted changes play no part. Saves nothing.
  app.get('/api/repos/:id/detect', async (c) => {
    const repo = store.getRepo(c.req.param('id'));
    let root: CommittedRoot;
    try {
      root = await committedRootFiles(repo.path, repo.targetBranch, DETECT_READ_FILES);
    } catch (err) {
      throw new InvalidStateError(
        t({
          zh: `读不到仓库 ${repo.name} 目标分支 ${repo.targetBranch} 上的文件：${errorMessage(err)}`,
          en: `Could not read the files on the target branch ${repo.targetBranch} of repo ${repo.name}: ${errorMessage(err)}`,
        }),
      );
    }
    return c.json({
      branch: repo.targetBranch,
      commit: root.commit,
      ...detectProjectCommands(root),
    } satisfies RepoDetection);
  });

  // Runs the setup commands, then the verify commands, on the commit the target branch is at, in
  // a temporary worktree deleted afterwards (`RepoTrials.start`): the body's commands, else the
  // registered ones. In the background: 202 at once, 409 while the repo is trying already.
  app.post('/api/repos/:id/trial', async (c) => {
    const repo = store.getRepo(c.req.param('id'));
    const input = await body(c, RepoTrialBody);
    return c.json(deps.trials.start(repo, input) satisfies RepoTrial, 202);
  });

  // The latest trial of the repo, under way or over; 404 when it has not been tried since the
  // Master started.
  app.get('/api/repos/:id/trial', (c) => {
    const repo = store.getRepo(c.req.param('id'));
    const trial = deps.trials.get(repo.id);
    if (!trial) {
      throw new NotFoundError(
        t({
          zh: `仓库 ${repo.name} 自 Master 启动以来还没有试运行过`,
          en: `Repo ${repo.name} has not been tried since the Master started`,
        }),
      );
    }
    return c.json(trial satisfies RepoTrial);
  });

  app.delete('/api/repos/:id', async (c) => {
    const repo = store.getRepo(c.req.param('id'));
    store.deleteRepo(repo.id);
    deps.trials.forget(repo.id);
    await deps.reposChanged?.();
    return c.body(null, 204);
  });

  // ---- runs ----------------------------------------------------------------
  // There is no endpoint for creating a Run from an arbitrary goal: Runs come from requirements,
  // either GitHub or GitLab issues (IssueBridge) or proposals of the local backlog accepted on the
  // dashboard (POST /api/proposals/:id/accept), written by a human and started at once
  // (POST /api/proposals) or accepted by auto-accept (LocalBacklog); besides those, the Master
  // only creates the Runs that merge the code host's commits it could not merge itself.
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
    const repo = store.getRepo(run.repoId);
    const redoAt = redoDueAt(run, sourcePollMinutes(config().master, repo.name));
    return c.json({
      run,
      repo,
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
      waitingForConflict: engine.waitingForConflict(run),
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
    return c.json(engine.approve(c.req.param('id'), comment, { source: 'dashboard' }));
  });

  app.post('/api/runs/:id/reject', async (c) => {
    const { comment } = await body(c, CommentInput);
    return c.json(engine.reject(c.req.param('id'), comment ?? '', { source: 'dashboard' }));
  });

  app.post('/api/runs/:id/retry', async (c) => {
    const input = await body(c, RetryInput);
    return c.json(await engine.retry(c.req.param('id'), input, { source: 'dashboard' }));
  });

  app.post('/api/runs/:id/pause', async (c) => c.json(await engine.pause(c.req.param('id'))));
  app.post('/api/runs/:id/resume', (c) =>
    c.json(engine.resume(c.req.param('id'), { source: 'dashboard' })),
  );
  app.post('/api/runs/:id/cancel', async (c) =>
    c.json(await engine.cancel(c.req.param('id'), { source: 'dashboard' })),
  );
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

  // ---- GitLab issues ----------------------------------------------------
  app.get('/api/gitlab', (c) => c.json(gitlabIssues.status() satisfies GitHubStatus));

  // As /api/github/poll, for the repos of gitlab.repos.
  app.post('/api/gitlab/poll', async (c) => {
    await gitlabIssues.poll();
    return c.json(gitlabIssues.status() satisfies GitHubStatus);
  });

  app.get('/api/scouts', (c) => {
    const repo = c.req.query('repo');
    const repoId = repo ? store.getRepo(repo).id : undefined;
    return c.json(store.listScouts({ repoId, limit: 30 }));
  });

  // A scout started by hand, by whichever source the repo's requirements come from; with a goal,
  // a direction it plans its iteration around (409 while the repo has an iteration under way).
  app.post('/api/scouts', async (c) => {
    const { repo, goal } = await body(c, ScoutInput);
    switch (requirementSource(config().master, repo)) {
      case 'github':
        return c.json(await issues.startScout(repo, 'manual', goal), 201);
      case 'gitlab':
        return c.json(await gitlabIssues.startScout(repo, 'manual', goal), 201);
      case 'backlog':
        return c.json(await backlog.startScout(repo, 'manual', goal), 201);
      default:
        throw new NotFoundError(
          t({
            zh: `config.yaml 的 github.repos、gitlab.repos 和 backlog.repos 里都没有 ${repo}`,
            en: `${repo} is in none of github.repos, gitlab.repos and backlog.repos of config.yaml`,
          }),
        );
    }
  });

  // ---- the local backlog of the repos without GitHub -----------------------
  app.get('/api/backlog', (c) => c.json(backlog.status() satisfies BacklogStatus));

  // Accept the proposals auto-accept takes and start the scouts that may start, now instead of
  // at the next poll.
  app.post('/api/backlog/poll', async (c) => {
    await backlog.poll();
    return c.json(backlog.status() satisfies BacklogStatus);
  });

  /** What the views of proposals go by: the redo wait and each repo's max_run_attempts. */
  const settings = () => proposalSettings(config());

  // Proposals of the local backlog, newest first; ?repo= and ?status= filter, ?limit= caps.
  app.get('/api/proposals', (c) => {
    const { repo, status, limit } = query(c, ProposalsQuery);
    const repoId = repo ? store.getRepo(repo).id : undefined;
    const names = new Map(store.listRepos().map((r) => [r.id, r.name]));
    const using = settings();
    return c.json(
      store
        .listProposals({ repoId, status, limit })
        .map((p) => proposalView(store, p, using, names)) satisfies ProposalView[],
    );
  });

  // A requirement a human writes into the local backlog of a repo of backlog.repos, as a proposal
  // of author human: started at once (`start`, the default) as accepting one does, the Run in the
  // answer; or kept pending until accepted, never auto-accepted. A repo of GitHub or GitLab is
  // refused saying where to write it (409); one of no source or not registered, 404; one with
  // problems, 409. When the Run cannot be created, the proposal stays pending and the error says
  // so.
  app.post('/api/proposals', async (c) => {
    const { repo, ...requirement } = await body(c, WriteProposalInput);
    const proposal = backlog.write(repo, requirement);
    const run = proposal.runId ? store.getRun(proposal.runId) : null;
    return c.json(
      {
        proposal: proposalView(store, proposal, settings()),
        ...(run ? { run: summarizeRun(store, engine, run) } : {}),
      } satisfies ProposalWritten,
      201,
    );
  });

  // A human edits a pending proposal of its own before deciding it: any of title, what, why,
  // evidence, acceptance, category, size and risk, by the rules of writing one (400 otherwise).
  // A decided proposal or a step of an iteration, 409. A scout's proposal edited into auto_accept
  // may come back accepted already, as a poll would have accepted it.
  app.patch('/api/proposals/:id', async (c) => {
    const edit = await body(c, EditProposalInput);
    const edited = backlog.edit(c.req.param('id'), edit);
    return c.json(proposalView(store, edited, settings()) satisfies ProposalView);
  });

  // Accepting creates a Run whose goal is the proposal's text. A step of an iteration is decided
  // with its iteration (409).
  app.post('/api/proposals/:id/accept', (c) => {
    const proposal = backlog.accept(c.req.param('id'));
    const run = store.getRun(proposal.runId ?? '');
    return c.json({
      proposal: proposalView(store, proposal, settings()),
      run: summarizeRun(store, engine, run),
    } satisfies ProposalAccepted);
  });

  // Rejecting needs a reason, which the repo's next scouts are shown. A step of an iteration is
  // decided with its iteration (409).
  app.post('/api/proposals/:id/reject', async (c) => {
    const { reason } = await body(c, RejectProposalInput);
    const rejected = backlog.reject(c.req.param('id'), reason);
    return c.json(proposalView(store, rejected, settings()) satisfies ProposalView);
  });

  // Starting a failed proposal over, a step of an iteration that still wants it included: its
  // attempts count from 1 again and a Run is created at once. Any other proposal, 409.
  app.post('/api/proposals/:id/restart', async (c) => {
    const proposal = await backlog.restart(c.req.param('id'));
    const run = store.getRun(proposal.runId ?? '');
    return c.json({
      proposal: proposalView(store, proposal, settings()),
      run: summarizeRun(store, engine, run),
    } satisfies ProposalRestarted);
  });

  // Iterations of both sources, newest first; ?repo= and ?status= (one, or several separated by
  // commas) filter, ?limit= caps. Each with its steps' Runs, its progress and what it used.
  app.get('/api/iterations', (c) => {
    const { repo, status, limit } = query(c, IterationsQuery);
    const repoId = repo ? store.getRepo(repo).id : undefined;
    const names = new Map(store.listRepos().map((r) => [r.id, r.name]));
    const at = now();
    const using = settings();
    return c.json(
      store
        .listIterations({ repoId, status, limit })
        .map((it) => iterationView(store, it, at, using, names)) satisfies IterationView[],
    );
  });

  app.get('/api/iterations/:id', (c) =>
    c.json(
      iterationView(
        store,
        store.getIteration(c.req.param('id')),
        now(),
        settings(),
      ) satisfies IterationView,
    ),
  );

  // Iterations of the local backlog are decided as a whole here; those of a code host on its
  // iteration issue (409).
  // Accepting accepts every step, and the steps whose dependencies are done become Runs.
  app.post('/api/iterations/:id/accept', (c) =>
    c.json(backlog.acceptIteration(c.req.param('id')) satisfies Iteration),
  );

  // Rejecting a pending one needs a reason, which the repo's next scouts are shown.
  app.post('/api/iterations/:id/reject', async (c) => {
    const { reason } = await body(c, RejectIterationInput);
    return c.json(backlog.rejectIteration(c.req.param('id'), reason) satisfies Iteration);
  });

  // Cancelling an accepted one terminates the Runs of its steps not done.
  app.post('/api/iterations/:id/cancel', async (c) =>
    c.json((await backlog.cancelIteration(c.req.param('id'))) satisfies Iteration),
  );

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
      // Of no Run.
      const onNotice = (n: LiveNotice) => {
        if (!runId) push('notice', n);
      };
      store.bus.on('event', onEvent);
      engine.live.on('agent', onAgent);
      deps.trials.live.on('notice', onNotice);
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
        deps.trials.live.off('notice', onNotice);
      }
    });
  });

  mountDashboard(app, webDir);
  return app;
}

/**
 * Where each repo named in config.yaml's sources of requirements takes them from, by name: the
 * source `requirementSource` picks, with what the dashboard needs to show and link to it, and the
 * repo's entry there for the dashboard's form to start from.
 */
function repoSourceViews(master: MasterConfig): Record<string, RepoSourceView> {
  const names = new Set([
    ...Object.keys(master.github?.repos ?? {}),
    ...Object.keys(master.gitlab?.repos ?? {}),
    ...Object.keys(master.backlog?.repos ?? {}),
  ]);
  const view = (name: string): RepoSourceView | null => {
    switch (requirementSource(master, name)) {
      case 'github': {
        const repo = master.github?.repos[name];
        if (!repo) return null;
        return {
          source: 'github',
          issuesRepo: repo.issues_repo ?? null,
          settings: { ...sourceSettings(repo), push: repo.push, deliver: repo.deliver },
        };
      }
      case 'gitlab': {
        const repo = master.gitlab?.repos[name];
        if (!master.gitlab || !repo) return null;
        return {
          source: 'gitlab',
          host: master.gitlab.host,
          issuesRepo: repo.issues_repo,
          settings: { ...sourceSettings(repo), push: repo.push, deliver: repo.deliver },
        };
      }
      case 'backlog': {
        const repo = master.backlog?.repos[name];
        return repo ? { source: 'backlog', settings: sourceSettings(repo) } : null;
      }
      default:
        return null;
    }
  };
  // Built as entries, so that any repo name becomes a key of its own.
  return Object.fromEntries(
    [...names]
      .sort()
      .map((name) => [name, view(name)] as const)
      .filter((entry): entry is readonly [string, RepoSourceView] => entry[1] !== null),
  );
}

/** The fields every source's entry has, as loaded; those left out are null. */
function sourceSettings(repo: ProposalSourceConfig): RepoSourceSettings {
  const { scout, auto_accept } = repo;
  return {
    template: repo.template,
    scout: scout
      ? {
          agent: scout.agent,
          auto: scout.auto,
          interval_minutes: scout.interval_minutes,
          max_proposals: scout.max_proposals,
        }
      : null,
    auto_accept: {
      max_risk: auto_accept.max_risk,
      max_size: auto_accept.max_size,
      max_per_day: auto_accept.max_per_day ?? null,
    },
    auto_merge: repo.auto_merge,
    max_run_attempts: repo.max_run_attempts,
    daily_budget_usd: repo.daily_budget_usd ?? null,
  };
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
    waitingForConflict: engine.waitingForConflict(run),
  };
}
