// The HTTP API contract, shared by the Master and the dashboard (web/).
// Type declarations only: the dashboard imports this file, so it must not pull in Node modules.

import type { AgentEvent } from '../adapters/types.js';
import type {
  AgentConfig,
  AgentEntry,
  SourceFile,
  TemplateFile,
  WorkflowTemplate,
} from '../config/schema.js';
import type { RunTimes } from '../engine/times.js';
import type { Lang } from '../i18n.js';
import type {
  AgentAttemptTotals,
  AgentScoutTotals,
  Approval,
  Artifact,
  Attempt,
  BlockKind,
  CheckResult,
  FailedAttempt,
  HostPlatform,
  Iteration,
  IterationChild,
  Proposal,
  Repo,
  Run,
  RunStatus,
  StageRun,
  Task,
} from '../store/types.js';

/** A normalized agent event of one attempt, numbered so a viewer can merge history and live. */
export interface AgentEventRecord {
  /** 1, 2, 3… within the attempt. */
  seq: number;
  ts: string;
  event: AgentEvent;
}

/** `agent` events on GET /api/stream. */
export interface LiveAgentEvent extends AgentEventRecord {
  runId: string;
  attemptId: string;
}

/** 404 body of GET /api/attempts/:id/log when the raw log of an execution is not there. */
export interface RawLogMissing {
  error: string;
  /**
   * Deleted by the Master once its Run had ended over RAW_LOG_KEEP_DAYS ago
   * (`runRawLogsExpired` in src/config/flow.ts); the execution's events are still there. false:
   * missing for another reason.
   */
  pruned: boolean;
}

/**
 * Where POST /api/repos gets the repo at `path` from, when it is not there yet: cloned from `url`
 * by the Master (https://, ssh://, user@host:path or an absolute path on this machine), or a new
 * repo with an empty first commit on its target branch.
 */
export type RepoInputSource = { kind: 'clone'; url: string } | { kind: 'init' };

/**
 * Body of POST /api/repos. Without `source`, `path` is a git repo already there; with it, `path`
 * is missing or an empty directory, filled by the source. `targetBranch` left out: the branch
 * checked out (a clone's is the remote's default branch, a new repo's is main).
 */
export interface RepoInput {
  name: string;
  path: string;
  targetBranch?: string;
  verifyCommands: string[];
  setupCommands: string[];
  source?: RepoInputSource;
}

/** GET /api/runs items. */
export type RunSummary = Omit<Run, 'template'> & {
  templateName: string;
  /** Some attempts have no known cost, so `costUsd` is a lower bound. */
  costUnknown: boolean;
  currentStage: { id: string; name: string; round: number } | null;
  /** As on GET /api/runs/:id: the Run is queued because `concurrency.max_runs` Runs execute. */
  waitingForMaxRuns: boolean;
  /** As on GET /api/runs/:id: the Run waits for a Run expected to change the same paths. */
  waitingForConflict: ConflictWait | null;
};

/** GET /api/runs/:id */
export interface RunDetail {
  run: Run;
  repo: Repo;
  stageRuns: StageRun[];
  tasks: Task[];
  attempts: Attempt[];
  checks: CheckResult[];
  approvals: Approval[];
  artifacts: Artifact[];
  /**
   * The Run's time split into agent work, queueing and waiting for people, as the scout's digest
   * and the issue's closing comment split it. Only parts that ended count while the Run goes on.
   */
  times: RunTimes;
  /**
   * Where the Run's worktree and branch are: as recorded on the Run, or, before its setup commands
   * pass, where the Master creates them (`worktrees/<run-id>`, `ares1/<run-id>`). Those
   * exist unrecorded while the setup runs, and stay behind when it fails or is interrupted.
   */
  workspace: { path: string; branch: string };
  /**
   * Whether `workspace.path` is still on disk: removed after a merge, or by hand for a failed /
   * cancelled Run (POST /api/runs/:id/cleanup).
   */
  worktreeExists: boolean;
  /** Whether `workspace.branch` still exists; it goes together with the worktree. */
  branchExists: boolean;
  /**
   * The Run is queued because its agent was out of quota or rate-limited, and goes on at
   * `retryAt` (ISO; then also waiting for room if `concurrency.per_repo` other Runs of the repo
   * execute, or `concurrency.max_runs` in all). null when it is not waiting for a quota. The wait holds across a Master restart:
   * the new Master restores it from the Run's recorded `task.rate_limited` event.
   */
  rateLimited: RateLimitedWait | null;
  /**
   * The Run is queued and waits for room under config.yaml's `concurrency.max_runs`: that many
   * Runs execute across every repo (`waitsForMaxRuns` in src/config/flow.ts). false when no limit
   * is set, the total is not reached, or the Run waits for its agent's quota (`rateLimited`).
   */
  waitingForMaxRuns: boolean;
  /**
   * The Run is queued because another Run of its repo that executes (or waits for its pull
   * request) and has not merged yet expects to change these paths too, by both assessments'
   * touches: working on them at once would most likely conflict at the merge. It goes on once
   * that Run has merged or ended (`conflictBlocker` in src/config/flow.ts). null when it does not
   * wait for one.
   */
  waitingForConflict: ConflictWait | null;
  /**
   * The Run failed and its issue is redone as a new Run, at this time at the earliest (ISO;
   * `redoDueAt`): the wait after a failure doubles with each attempt. Later when today's
   * automatic spending reached its limit or the work switch is off. null when the issue is not
   * waiting for a redo.
   */
  redoAt: string | null;
}

/** A Run waiting for its agent's quota: which agent hit the limit and when the Run goes on. */
export interface RateLimitedWait {
  agentId: string;
  retryAt: string;
}

/**
 * A queued Run waiting for another Run of its repo that expects to change the same places: that
 * Run's id, and the paths both expect to change (the more specific of each overlapping pair).
 */
export interface ConflictWait {
  runId: string;
  paths: string[];
}

/** Where a Run's worktree and branch are and whether they are still there. */
export type RunWorkspaceState = Pick<RunDetail, 'workspace' | 'worktreeExists' | 'branchExists'>;

/** Run statuses whose workspace GET /api/workspaces lists. */
export type FinishedRunStatus = Extract<
  RunStatus,
  'completed' | 'failed' | 'cancelled' | 'dropped'
>;

/**
 * GET /api/workspaces items: a finished Run whose worktree or branch is still there, most
 * recently finished first. Failed and cancelled Runs keep theirs on purpose; a completed or
 * dropped one only when its commits were not all in the target branch, so it was not removed.
 */
export interface KeptWorkspace extends RunWorkspaceState {
  run: {
    id: string;
    /** First line of the goal. */
    title: string;
    repoId: string;
    repoName: string;
    status: FinishedRunStatus;
    finishedAt: string | null;
  };
  /**
   * The workspace is recorded on the Run; false = created before the setup commands passed
   * and left behind by a failed or interrupted setup (`workspace` then follows the naming rule).
   */
  recorded: boolean;
  /** POST /api/runs/:id/cleanup accepts it: failed / cancelled Runs only, as that endpoint. */
  canCleanUp: boolean;
}

/** GET /api/runs/:id/diff (null before the Run has a workspace). */
export interface DiffView {
  base: string;
  head: string;
  stat: string;
  patch: string;
  truncated: boolean;
}

/** The templates a registered repo keeps in .ares1/workflows/, as committed on its target branch. */
export interface RepoTemplatesView {
  /** The repo's name as registered. */
  repo: string;
  /** The target branch the files were read from, and the commit it was at. */
  branch: string;
  sha: string;
  /**
   * The repo's valid templates, including earlier versions standing in for files that now fail
   * (`lastGood`), and those whose id the home directory also has (`shadowed`), although Runs get
   * the home directory's.
   */
  templates: WorkflowTemplate[];
  /** Every file with its source, including invalid ones, by file name. */
  files: TemplateFile[];
}

/** GET /api/config (read-only; reloaded when the files change). */
export interface ConfigView {
  /** config.yaml's `language`: what the Master writes in, and the dashboard's default. */
  language: Lang;
  /**
   * config.yaml's `concurrency.per_repo`: how many Runs of a repo execute at the same time (their
   * merges go one at a time).
   */
  perRepo: number;
  /**
   * config.yaml's `concurrency.max_runs`: how many Runs of all repos together execute at the same
   * time; null = no limit beyond `perRepo`.
   */
  maxRuns: number | null;
  /** Valid and enabled agents. */
  agents: AgentConfig[];
  /** Valid templates of the home directory. */
  templates: WorkflowTemplate[];
  /**
   * Problems keyed by "agents.yaml#<id>", "workflows/<file>" or a repo's
   * "<repo>:.ares1/workflows/<file>"; those items are not used.
   */
  errors: Record<string, string[]>;
  /** Problems that disable nothing, keyed by "config.yaml" or a template file's key. */
  warnings: Record<string, string[]>;
  /** The configuration directory (Master home). */
  dir: string;
  configFile: SourceFile;
  agentsFile: SourceFile;
  /** Every entry of agents.yaml, including disabled and invalid ones. */
  agentEntries: AgentEntry[];
  /** The CLIs the Master has an adapter for, which agents.yaml's `cli` may name. */
  clis: CliInfo[];
  /** Every file in workflows/ with its source, including invalid ones. */
  templateFiles: TemplateFile[];
  /**
   * The templates registered repos keep in their own .ares1/workflows/, in repo name order; repos
   * without such files are left out. Each repo's are seen by that repo only, after the home
   * directory's (`resolveTemplate`).
   */
  repoTemplates: RepoTemplatesView[];
  /**
   * Where each repo named under config.yaml's `github.repos`, `gitlab.repos` or `backlog.repos`
   * takes its requirements from, by repo name (`requirementSource`: a name in more than one is
   * the first's). A registered repo missing here has no source, so no Run is created for it.
   */
  repoSources: Record<string, RepoSourceView>;
  /** When the configuration in use was loaded (it reloads when the files change). */
  loadedAt: string;
  /** The last reload failed; the previous configuration is still in use. */
  reloadError: { message: string; at: string } | null;
  /** Changed settings that need a Master restart to take effect. */
  restartNeeded: string[];
}

/**
 * Where a repo's requirements come from (`requirementSource`): GitHub issues of `issuesRepo`
 * ("owner/name" as configured; null = resolved by gh from the repo's remotes), GitLab issues of the
 * project at `issuesRepo` ("group/subgroup/name") on `host`, or the local backlog.
 */
export type RepoSourceView =
  | { source: 'github'; issuesRepo: string | null }
  | { source: 'gitlab'; host: string; issuesRepo: string }
  | { source: 'backlog' };

/** A CLI the Master has an adapter for. */
export interface CliInfo {
  /** As agents.yaml's `cli` names it, e.g. "codex". */
  cli: string;
  /**
   * Whether its adapter can run an agent read-only, as assessments, plans of a stage's tasks and
   * scouts need.
   */
  readOnly: boolean;
}

/**
 * State of an agent on GET /api/agents: the state of its agents.yaml entry, or `removed` for an
 * agent that is not in agents.yaml any more but has executions or scouts on record.
 */
export type AgentState = AgentEntry['state'] | 'removed';

/**
 * GET /api/agents items: every entry of agents.yaml as on GET /api/config
 * (`agentEntries`, in file order), then the `removed` agents by id. Totals cover everything on
 * record, not a time range; agents without records have zeros.
 */
export interface AgentSummary {
  id: string;
  state: AgentState;
  /** The agents.yaml entry; null when removed. */
  entry: AgentEntry | null;
  /** Executions in Runs. */
  runs: Omit<AgentAttemptTotals, 'agentId'>;
  /** Scouts. */
  scouts: Omit<AgentScoutTotals, 'agentId'>;
}

/** GET /api/health */
export interface HealthView {
  ok: boolean;
  /** The first of `activeRuns`, null when none executes; kept for older clients. */
  activeRun: string | null;
  /**
   * The Runs executing now, at most `concurrency.per_repo` per repo and `concurrency.max_runs` in
   * all, in the order they started. Lowering a limit stops none of them, so there may be more for
   * a while.
   */
  activeRuns: string[];
  /** The work switch: off = nothing new starts. */
  working: boolean;
  /** The Master sends system notifications itself; the dashboard then stays quiet. */
  systemNotify: boolean;
  /**
   * The Master also POSTs notifications to a webhook (notify.webhook); the dashboard still sends
   * its own. Never the address or headers.
   */
  webhookNotify: boolean;
  /** Commit of the running Master's install directory; the dashboard reloads when it changes. */
  version: string | null;
}

/** How one channel of a test notification went (POST /api/notify/test). */
export interface NotifyTestChannel {
  /** The channel is set up, so the test was sent through it; false = nothing was sent. */
  enabled: boolean;
  /** It was sent: the command ended well, or the webhook answered with a 2xx status. */
  ok: boolean;
  /** Why it failed, in the Master's language; null when it did not or was not sent. */
  reason: string | null;
}

/**
 * The outcome of a test notification, sent through each channel the Master notifies by under
 * the configuration in use. Never the webhook's address or headers: they may carry tokens.
 */
export interface NotifyTestResult {
  system: NotifyTestChannel & {
    /** The Master can send system notifications on its platform (macOS, Linux). */
    supported: boolean;
  };
  webhook: NotifyTestChannel & {
    /** The HTTP status the webhook answered with; null when it gave no answer or was not sent. */
    status: number | null;
  };
}

/**
 * What a repo whose requirements the Master works on shows alike, whichever source they come
 * from: GitHub issues (`GitHubRepoStatus`) or the local backlog (`BacklogRepoStatus`).
 */
export interface ProposalSourceStatus {
  /** Repo name as registered on the dashboard. */
  name: string;
  template: string;
  /** Why the Master cannot work on this repo's requirements; empty when fine. */
  problems: string[];
  scout: {
    agent: string;
    /** Scouts on its own when the repo is idle. */
    auto: boolean;
    /** At least this many minutes between automatic scouts; 0 = no minimum. */
    intervalMinutes: number;
    maxProposals: number;
    running: boolean;
    lastAt: string | null;
    /**
     * Why no automatic scout starts right now, as of the last poll (`until`: it may start after
     * that time); null = it may start at the next poll.
     */
    waiting: { reason: string; until?: string } | null;
    /**
     * The repo's iteration under way (pending, active or blocked), if any: until it is over a
     * scout plans no other, so a scout by hand takes no direction (POST /api/scouts refuses a
     * `goal` with 409).
     */
    openIteration: { id: string; title: string } | null;
  } | null;
  autoAccept: {
    maxRisk: 'none' | 'low' | 'mid' | 'high';
    /** Largest size accepted automatically, together with maxRisk. */
    maxSize: 'S' | 'M' | 'L';
    /** null = no daily limit. */
    maxPerDay: number | null;
    usedToday: number;
  };
  /** Runs from the repo's requirements merge without approval. */
  autoMerge: boolean;
  /**
   * Today's spend on scouts, auto-accepted Runs and automatic redos; dailyUsd null = no limit.
   */
  budget: { dailyUsd: number | null; spentToday: number; reached: boolean };
  /**
   * Runs a requirement (an issue, or a local proposal, a step of an iteration included) gets at
   * most, the first included (`max_run_attempts`); 1 = never redone.
   */
  maxRunAttempts: number;
}

/** One repo whose issues on a code host (GitHub or GitLab) the Master works on. */
export interface GitHubRepoStatus extends ProposalSourceStatus {
  /** "owner/name" (a GitLab project's path: "group/subgroup/name") once known. */
  issuesRepo: string | null;
  /** The target branch is pushed to the code host after merges. */
  push: boolean;
  /**
   * How Runs deliver (`deliver`): push = merged into the local target branch, which is pushed;
   * pr (GitHub) / mr (GitLab) = the Run's branch is pushed and a pull request (a merge request
   * on GitLab) opened, the Run completes once it merges.
   */
  deliver: 'push' | 'pr' | 'mr';
}

/** GET /api/github and GET /api/gitlab: a code host's section of config.yaml and its bridge. */
export interface GitHubStatus {
  /** Which code host it is. */
  platform: HostPlatform;
  /**
   * The GitLab's host name (`gitlab.host`: gitlab.com or a self-hosted one), for the links to its
   * issues; null for GitHub.
   */
  host: string | null;
  /** config.yaml has the platform's section (`github` / `gitlab`). */
  enabled: boolean;
  account: string | null;
  pollMinutes: number;
  lastPollAt: string | null;
  /** The last call to the code host that failed; cleared by a poll without errors. */
  lastError: { message: string; at: string } | null;
  repos: GitHubRepoStatus[];
}

/** One repo whose requirements come from the local backlog (backlog.repos). */
export interface BacklogRepoStatus extends ProposalSourceStatus {
  /**
   * Proposals waiting for a human or for the automatic acceptance; an iteration waiting counts
   * as one, accepted or rejected as a whole, and its steps not at all.
   */
  pendingProposals: number;
}

/** GET /api/backlog: the local backlog of the repos without GitHub. */
export interface BacklogStatus {
  /** config.yaml has a `backlog` section. */
  enabled: boolean;
  pollMinutes: number;
  lastPollAt: string | null;
  /** The last thing a poll could not do; cleared by a poll without errors. */
  lastError: { message: string; at: string } | null;
  repos: BacklogRepoStatus[];
}

/**
 * GET /api/proposals: a proposal of the local backlog, newest first. `author` says whether a
 * scout proposed it or a human wrote it (POST /api/proposals).
 */
export interface ProposalView extends Proposal {
  /** Name of its repo as registered on the dashboard. */
  repo: string;
  /**
   * Status of the latest Run it became once accepted; null before, or when there is no such Run.
   */
  runStatus: RunStatus | null;
  /**
   * Its latest Run failed and it is redone as a new Run, at this time at the earliest (ISO;
   * `proposalRedoDueAt`): the wait after a failure doubles with each attempt. Later when today's
   * automatic spending reached its limit or the work switch is off. null when it does not wait
   * to be redone, a step whose iteration no longer wants it included.
   */
  redoAt: string | null;
  /**
   * How many Runs it gets in all, `attempt` among them: its repo's `max_run_attempts`, or
   * `attempt` when past that (`attemptsAllowed`). null once its repo left backlog.repos.
   */
  maxAttempts: number | null;
  /**
   * A human may start it over (`proposalRestartable`, POST /api/proposals/:id/restart): it failed,
   * and the iteration it is a step of, if any, still wants it.
   */
  restartable: boolean;
}

/** POST /api/proposals/:id/accept: the proposal, accepted, and the Run created from it. */
export interface ProposalAccepted {
  proposal: ProposalView;
  run: RunSummary;
}

/**
 * POST /api/proposals/:id/restart: the proposal, started over (accepted again, attempt 1), and
 * the Run created for it.
 */
export type ProposalRestarted = ProposalAccepted;

/**
 * POST /api/proposals: the requirement a human wrote, as a proposal of author human. Started
 * (`start` true, the default): accepted, with the Run created from it; otherwise pending, without
 * `run`.
 */
export interface ProposalWritten {
  proposal: ProposalView;
  run?: RunSummary;
}

/** One Run that worked on a step of an iteration. */
export interface IterationRunView {
  id: string;
  status: RunStatus;
  costUsd: number;
  /** Some of its attempts have no known cost, so `costUsd` is a lower bound. */
  costUnknown: boolean;
}

/** One step of an iteration's plan, with where it stands. */
export interface IterationChildView extends IterationChild {
  /**
   * The steps it still waits for, by position (`unmetDependencies` in src/config/flow.ts), while
   * it has not started (planned, waiting or ready); empty once it has, or with nothing to wait for.
   */
  waitingFor: number[];
  /** Every Run that worked on it, oldest first: failed attempts and redos included. */
  runs: IterationRunView[];
  /**
   * The rest is read from its proposal, in the local backlog only, as GET /api/proposals gives
   * it; null, empty or false on GitHub and before it has a proposal. Which attempt its latest Run
   * is (`Proposal.attempt`).
   */
  attempt: number | null;
  /** How many Runs it gets in all (`ProposalView.maxAttempts`). */
  maxAttempts: number | null;
  /** When its failed Run is redone, while it waits to be (`ProposalView.redoAt`). */
  redoAt: string | null;
  /** Its Runs that failed and why, oldest first (`Proposal.failures`). */
  failures: FailedAttempt[];
  /** A human may start it over (`ProposalView.restartable`). */
  restartable: boolean;
}

/**
 * GET /api/iterations items (newest first) and GET /api/iterations/:id: an iteration with its
 * repo's name, each step with its Runs, and what it got done and used so far.
 */
export interface IterationView extends Omit<Iteration, 'children'> {
  /** Name of its repo as registered on the dashboard. */
  repo: string;
  children: IterationChildView[];
  /** Its steps that are done, of all of them; replaced ones not counted (`iterationProgress`). */
  progress: { done: number; total: number };
  /** Over every Run of every step, failed attempts and replaced steps included. */
  totals: {
    runs: number;
    costUsd: number;
    /** Some attempts have no known cost, so `costUsd` is a lower bound. */
    costUnknown: boolean;
    /** From its acceptance to its end, or to when it was read; null while not accepted. */
    elapsedMs: number | null;
    /** The agents' executions in all of its Runs. */
    agentMs: number;
  };
}

/** GET /api/upgrade: the Master upgrading itself. */
export interface UpgradeStatus {
  /** `upgrade.auto` in config.yaml. */
  auto: boolean;
  /** The git checkout the Master runs from; null = not from a build, cannot upgrade itself. */
  installDir: string | null;
  /** Commit running now and the latest one of its origin, as of the last check. */
  current: string | null;
  latest: string | null;
  /**
   * idle: not checked yet; off: auto upgrade off; unavailable: no install dir; up_to_date;
   * waiting: behind, waits for running work or the work switch; upgrading: handed over to the
   * script; skipped: this commit failed before; blocked: needs a human (see message).
   */
  state:
    | 'idle'
    | 'off'
    | 'unavailable'
    | 'up_to_date'
    | 'waiting'
    | 'upgrading'
    | 'skipped'
    | 'blocked';
  message: string | null;
  checkedAt: string | null;
}

/** Time ranges of GET /api/stats: today, the last 7 / 30 days (whole local days), everything. */
export type StatsRange = 'today' | '7d' | '30d' | 'all';

/** One agent and model in GET /api/stats. */
export interface StatsAgent {
  agentId: string;
  /**
   * The model the CLI reported, else the configured one (scouts: the configured one); null for
   * attempts recorded before models were tracked.
   */
  model: string | null;
  /** Agent executions in Runs. */
  attempts: number;
  /** Scouts run by this agent. */
  scouts: number;
  /** Known costs of both; unknown ones are left out and counted in `costUnknown`. */
  costUsd: number;
  costUnknown: number;
  /** Tokens of the executions in Runs (scouts do not record tokens). */
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Start to end of every finished execution and scout. */
  durationMs: number;
}

/** Times Runs got blocked for one reason (BlockKind), from the `run.blocked` events. */
export interface StatsBlocks {
  kind: BlockKind;
  count: number;
  /** Blocks a human has handled already (retried or terminated). */
  handled: number;
  /** Blocked to handled, summed over the handled ones. */
  waitMs: number;
}

/**
 * GET /api/stats?range=today|7d|30d|all&repo=<id or name>: totals summed by the Master for
 * the Stats page. Each record counts by when it happened: Runs and Tasks by creation, executions and
 * scouts by start, approvals by request, blocks by when the Run got blocked. Per-Run figures
 * (rounds, durations, average cost) cover the whole life of the Runs created in the range.
 */
export interface StatsView {
  range: StatsRange;
  /** The repo filtered on; null = every repo. */
  repoId: string | null;
  /** Start of the range (local midnight, ISO); null = from the beginning. */
  since: string | null;
  /** When the figures were taken (ISO). */
  at: string;
  runs: {
    total: number;
    /** Current status of the Runs created in the range; statuses without Runs are left out. */
    byStatus: Partial<Record<RunStatus, number>>;
    /** Created from GitHub issues. */
    fromIssues: number;
    /** Of those, accepted by the Master without a human. */
    autoAccepted: number;
    /** Of those, completed with the issue closed. */
    issuesClosed: number;
    /** Completed ones, with their total cost (known part) and created → finished times. */
    completed: {
      count: number;
      costUsd: number;
      avgMs: number | null;
      medianMs: number | null;
    };
  };
  tasks: number;
  /** Agent executions in Runs. */
  attempts: number;
  scouts: {
    total: number;
    /** Issues proposed. */
    proposals: number;
    /** Proposals accepted without a human. */
    autoAccepted: number;
  };
  cost: {
    /** Known cost of the agent executions in Runs. */
    runsUsd: number;
    scoutsUsd: number;
    /** Finished executions in Runs without a known cost (e.g. cursor-agent without a configured price). */
    unknownAttempts: number;
    /** Completed scouts without a known cost. */
    unknownScouts: number;
    /** Local days ("YYYY-MM-DD") that had any execution or scout, oldest first. */
    byDay: { day: string; runsUsd: number; scoutsUsd: number }[];
    /** Repos with any execution or scout, by name. */
    byRepo: { repoId: string; repo: string; runsUsd: number; scoutsUsd: number }[];
  };
  /** Per agent and model, most expensive first. */
  agents: StatsAgent[];
  /** Tokens of the executions in Runs. */
  tokens: { input: number; output: number; cached: number };
  time: {
    /** Start to end of the finished executions in Runs. */
    attemptsMs: number;
    scoutsMs: number;
    /** Approvals decided by a human: requested → decided. */
    approvals: { count: number; waitMs: number };
  };
  quality: {
    /** Runs created in the range; the per-Run averages divide by it. */
    runs: number;
    /** Rounds of agent stages (StageRuns of stages of kind agent, e.g. Coding). */
    agentRounds: number;
    /** Rounds sent back by the review (StageRun failReason review). */
    reviewFails: number;
    /** Rounds whose check commands failed (failReason check). */
    checkFails: number;
    /** Approvals rejected (failReason rejected). */
    rejections: number;
    /** Executions whose result was sent back to the agent for rework. */
    reworks: number;
  };
  /** By reason, most frequent first. */
  blocks: StatsBlocks[];
}
