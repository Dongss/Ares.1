import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { prepareAgentEnv } from '../adapters/process.js';
import {
  type AgentAdapter,
  type AgentExecution,
  type AgentResult,
  readOnlyClis,
} from '../adapters/types.js';
import type { GitHubRepoStatus, GitHubStatus } from '../api/types.js';
import { brandName } from '../brand.js';
import {
  autoAcceptsL,
  isAutoAcceptable,
  issueRunOverrides,
  limitedScout,
  redoDueAt,
  replyTimeoutHours,
  scoutBackoff,
  scoutFailureStreak,
  scoutLimitWait,
  splitUnfinishedRuns,
  templateSplits,
} from '../config/flow.js';
import {
  findTemplate,
  githubConfigKey,
  type HomePaths,
  type LoadedConfig,
} from '../config/load.js';
import type { GitHubRepoConfig, WorkflowTemplate } from '../config/schema.js';
import { type Engine, estimateCost, InvalidStateError } from '../engine/engine.js';
import { storedRunTimes } from '../engine/times.js';
import { join as joinList, t } from '../i18n.js';
import { NotFoundError, type Store } from '../store/store.js';
import {
  type DiscussionEntry,
  type EventRow,
  type FailedAttempt,
  FINISHED_RUN_STATUSES,
  type Repo,
  type Run,
  type RunIssue,
  type Scout,
  type ScoutProposal,
  type UntrustedAuthor,
} from '../store/types.js';
import { isMasterSource, type MasterOrigin } from '../upgrade/source.js';
import { lastUpgradeFailure, type UpgradeFailure } from '../upgrade/upgrader.js';
import { errorMessage, nowIso, tail } from '../util.js';
import {
  type CommandResult,
  environmentProblem,
  firstMissingCommand,
  runCommands,
} from '../verify/commands.js';
import {
  addDetachedWorktree,
  commitTime,
  dropWorktree,
  fastForwardBranch,
  isAncestor,
  mergeOrAbort,
  pruneWorktrees,
  revParse,
  git as runGit,
} from '../workspace/git.js';
import {
  GhCli,
  type GhIssue,
  type GhPullRequest,
  type GhPullRequestStatus,
  type GitHub,
} from './client.js';
import {
  autoAcceptedComment,
  discussionComment,
  type FailureOutcome,
  failedAttempt,
  goalChangedComment,
  goalFromIssue,
  issueUpdate,
  isTrusted,
  LABELS,
  labelDefs,
  markComment,
  proposalBody,
  pullRequestComment,
  pullRequestReworkComment,
  pullRequestText,
  pullRequestUpdatedComment,
  redoStartedComment,
  repliesAfterMaster,
  untrustedAuthor,
  untrustedGoalMessage,
  withStatusLabel,
} from './issues.js';
import {
  type IgnoredReview,
  judgePullRequest,
  pullRequestPushPending,
  reworksDone,
} from './pr-rework.js';
import { redactForGitHub } from './redact.js';
import {
  filedProposal,
  issueDigest,
  parseScoutReport,
  proposalsHoldingScout,
  runDigest,
  scoutPrompt,
  scoutReportJsonSchema,
  untriaged,
} from './scout.js';

/** Error of a scout cut short by the Master stopping. */
const stoppedWhileScouting = () =>
  t({ zh: 'Master 在侦察过程中停止了', en: 'The Master stopped during the scout' });

/** How many of the latest closed issues the scout sees, done or not. */
const SCOUT_RECENT_CLOSED = 30;
/** How many issues closed as not planned the scout sees besides, with their reasons. */
const SCOUT_NOT_PLANNED = 300;
/**
 * How many different GitHub errors one streak of failures records (and notifies). Error messages
 * may carry what changes on every call, such as a request id; without a cap such a streak would
 * keep growing the set and keep notifying. Past it, the streak records no new github.error.
 */
const MAX_REPORTED_ERRORS = 20;

const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-11-23 14:05", in the Master's local time. */
function localTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Error of a scout whose agent ran out of quota or was rate-limited, with when the quota is
 * expected back if the CLI said, and what the CLI said.
 */
function scoutLimitedText(resetAt: number | undefined, cliError: string | undefined): string {
  const head =
    resetAt === undefined
      ? t({
          zh: '侦察的 Agent 额度用尽或被限流',
          en: "The scout's agent is out of quota or rate-limited",
        })
      : t({
          zh: `侦察的 Agent 额度用尽或被限流，预计 ${localTime(resetAt)} 恢复`,
          en: `The scout's agent is out of quota or rate-limited; the quota is expected back at ${localTime(resetAt)}`,
        });
  return cliError?.trim() ? t({ zh: `${head}：${cliError}`, en: `${head}: ${cliError}` }) : head;
}

/** Of two waits, the one that ends later. */
function laterWait(a: ScoutWait | null, b: (ScoutWait & { until: string }) | null) {
  if (!b) return a;
  return a?.until && Date.parse(a.until) >= Date.parse(b.until) ? a : b;
}

const notRegistered = (name: string) =>
  t({
    zh: `仓库 ${name} 没有在看板上登记`,
    en: `Repo ${name} is not registered on the dashboard`,
  });

/**
 * Why the automatic scout waits for a human: 「有 2 条提案、1 个卡住的 Run 等你处理」. A part
 * that is 0 is left out.
 */
function waitingForYouText(proposals: number, stuck: number): string {
  const p = `${proposals} proposal${proposals === 1 ? '' : 's'}`;
  const s = `${stuck} stuck Run${stuck === 1 ? '' : 's'}`;
  if (stuck === 0) return t({ zh: `有 ${proposals} 条提案等你处理`, en: `${p} waiting for you` });
  if (proposals === 0) {
    return t({ zh: `有 ${stuck} 个卡住的 Run 等你处理`, en: `${s} waiting for you` });
  }
  return t({
    zh: `有 ${proposals} 条提案、${stuck} 个卡住的 Run 等你处理`,
    en: `${p} and ${s} waiting for you`,
  });
}

/**
 * Why the automatic scout waits for work that goes on by itself: 「等 1 个未结束的 Run 做完，
 * 另外有 2 个 issue 在等重做」. A part that is 0 is left out; null when both are.
 */
function busyText(moving: number, redo: number): string | null {
  const runs = t({
    zh: `等 ${moving} 个未结束的 Run 做完`,
    en: `Waiting for ${moving} unfinished Run${moving === 1 ? '' : 's'} to finish`,
  });
  const issues = t({
    zh: `有 ${redo} 个 issue 在等重做`,
    en: `${redo} issue${redo === 1 ? '' : 's'} waiting to be redone`,
  });
  if (redo === 0) return moving === 0 ? null : runs;
  if (moving === 0) return issues;
  return t({ zh: `${runs}，另外${issues}`, en: `${runs}; ${issues}` });
}

/**
 * Start of the names of the temporary worktrees, in the system's temp directory, where GitHub's
 * new commits are merged into a diverged target branch and checked.
 */
const MERGE_DIR_PREFIX = 'ares1-merge-';

/** Message of the commit that merges GitHub's new commits into the local target branch. */
export function mergeRemoteMessage(branch: string): string {
  return redactForGitHub(
    t({
      zh: `合并 GitHub 上 ${branch} 的新提交`,
      en: `Merge new commits from ${branch} on GitHub`,
    }),
  );
}

/** A check that failed on the Master's merge of GitHub's commits, as github.diverged gives it. */
export interface FailedCheck {
  command: string;
  kind: 'setup' | 'verify';
  exitCode: number | null;
  timedOut: boolean;
  /** The program it could not find, when that is why it failed. */
  missing?: string;
  /** End of its output. */
  output: string;
}

/**
 * Why the Master's merge of GitHub's commits into the target branch needs an agent
 * (`mergeRemote`): it conflicted in `files`, or a check failed on it (`failed`, its output in
 * `log`). The data of the github.diverged event, as it is.
 */
export type RemoteMergeFailure =
  | { conflict: true; files: string[] }
  | { failed: FailedCheck; log: string };

/** How much of a failed check's output the goal of a Run that merges GitHub's commit quotes. */
const GOAL_OUTPUT_CHARS = 2000;

/** What the Master's merge ran into, as a list for the goal of the Run that takes it over. */
function mergeFailureLines(why: RemoteMergeFailure): string {
  if (!('failed' in why)) {
    return `- ${t({ zh: '冲突的文件：', en: 'Conflicted files: ' })}${joinList(why.files)}`;
  }
  const { failed } = why;
  const command =
    failed.kind === 'setup'
      ? t({ zh: '没通过的准备命令', en: 'Failed setup command' })
      : t({ zh: '没通过的检查命令', en: 'Failed verify command' });
  const how = failed.timedOut
    ? t({ zh: '（超时）', en: ' (timed out)' })
    : failed.exitCode !== null
      ? t({ zh: `（退出码 ${failed.exitCode}）`, en: ` (exit code ${failed.exitCode})` })
      : '';
  const lines = [
    `- ${command}${t({ zh: '：', en: ': ' })}\`${failed.command}\`${how}`,
    `- ${t({ zh: '日志：', en: 'Log: ' })}${why.log}`,
  ];
  const output = failed.output.trim();
  if (output) {
    const end = tail(output, GOAL_OUTPUT_CHARS);
    lines.push(
      `- ${t({ zh: '输出的最后部分：', en: 'End of its output:' })}\n\n\`\`\`\n${end}\n\`\`\``,
    );
  }
  return lines.join('\n');
}

/**
 * The goal of the Run the Master creates for an agent to merge commit `remote` of the target
 * branch `branch` on GitHub into the local one, at `local`, when its own merge of the two did not
 * go through (`why`). Written in the Master's language and complete, so that the requirement
 * assessment goes ahead without asking: what to merge, what to keep, that the checks must pass
 * afterwards, and what the Master's merge ran into.
 */
export function mergeRemoteGoal(input: {
  branch: string;
  local: string;
  remote: string;
  why: RemoteMergeFailure;
}): string {
  const { branch, local, remote, why } = input;
  const r = remote.slice(0, 7);
  const l = local.slice(0, 7);
  const title = t({
    zh: `合并 GitHub 上 ${branch} 的提交 ${r}`,
    en: `Merge commit ${r} from ${branch} on GitHub`,
  });
  const trouble =
    'failed' in why
      ? t({ zh: '合并后检查没通过', en: 'failed the checks' })
      : t({ zh: '有冲突', en: 'conflicted' });
  const intro = t({
    zh: `这是 Master 自动建的合并任务，不来自 issue。本地目标分支 ${branch} 和 GitHub 上的 ${branch} 已经分叉，各有对方没有的提交；Master 自己合并两边时${trouble}，所以交给这个 Run 处理。合并进来之前，Master 不会把 ${branch} 推送到 GitHub。`,
    en: `The Master created this merge task by itself; it comes from no issue. The local target branch ${branch} and ${branch} on GitHub have diverged, each with commits the other lacks, and the Master's own merge of the two ${trouble}, so this Run takes it over. Until it is merged in, the Master pushes nothing of ${branch} to GitHub.`,
  });
  const task = t({
    zh: `要做的：把 GitHub 上 ${branch} 的提交 ${r}（完整的是 ${remote}）合并进本地目标分支 ${branch}（Master 合并时在 ${l}，完整的是 ${local}）。编码阶段开始时，Master 会在工作目录里执行 git merge --no-ff --no-commit ${remote}，把冲突留在文件里交给编码 Agent；合并提交由 Master 完成。`,
    en: `What to do: merge commit ${r} (in full, ${remote}) from ${branch} on GitHub into the local target branch ${branch} (at ${l} when the Master merged, in full ${local}). When the coding stage starts, the Master runs git merge --no-ff --no-commit ${remote} in the working directory and leaves the conflicts in the files for the coding agent; the Master makes the merge commit.`,
  });
  const rules = t({
    zh: `要求：
- 冲突时两边的改动都要保留：本地 ${branch} 上的和 GitHub 上的都不能丢，把两边的意图合在一起，删掉所有冲突标记。
- 合并后仓库的检查命令要能通过。
- 只做这次合并需要的改动，不做别的需求。`,
    en: `Requirements:
- Where the two conflict, keep the changes of both sides: nothing of the local ${branch} or of GitHub's may be lost; bring together what each side meant, and remove every conflict marker.
- After the merge, the repo's check commands must pass.
- Make only the changes this merge needs, nothing else.`,
  });
  const found = mergeFailureLines(why);
  const seen = t({
    zh: `Master 自己合并时的情况：\n${found}`,
    en: `What the Master's merge ran into:\n${found}`,
  });
  return [title, intro, task, rules, seen].join('\n\n');
}

/**
 * The target branch and GitHub's, each with commits the other lacks, as last seen, and what came
 * of merging the two.
 */
interface Divergence {
  local: string;
  remote: string;
  /**
   * What github.diverged has told since the two began to diverge: 'failed' once a hand merge was
   * asked for, 'run' once the merge was handed to the Run `reportedRun`, 'environment' once a
   * missing program was. Later records of what was told already do not notify again.
   */
  reported?: 'failed' | 'environment' | 'run';
  /** The Run told about when `reported` is 'run'. */
  reportedRun?: string;
  /**
   * What came of merging this pair:
   * - failed: the merge conflicted or a check failed on it, recorded; not tried again;
   * - environment: a program the checks start is missing, recorded; tried again each round, so
   *   that it goes on by itself once the program is installed.
   * Undefined: not tried yet, or put off.
   */
  outcome?: 'failed' | 'environment';
  /**
   * Why the merge of this pair failed, while the Run `handedTo` goes on with it: once the Run
   * ends without merging, a human is asked to merge, for this reason.
   */
  handed?: RemoteMergeFailure;
  /**
   * The Run the merge of this pair was handed to: the one created for `remote`, or the repo's
   * merge Run that was going on already, created for an earlier commit of GitHub.
   */
  handedTo?: string;
  /**
   * The merge commit, checked, when fast-forwarding the target branch to it had to wait: the
   * next round tries the fast-forward again without merging and checking once more.
   */
  merge?: string;
}

/** What merging GitHub's commits into the target branch came to (`mergeRemote`). */
type RemoteMerge =
  | { kind: 'merged'; merge: string }
  /** Conflicts or failed checks; `data` goes into the github.diverged event. */
  | { kind: 'failed'; data: RemoteMergeFailure }
  /** A program the checks start is missing; `data` as for failed. */
  | { kind: 'environment'; data: Record<string, unknown> }
  /** Not tried, or cut short, for no fault of the commits (node gone, the Master stopping). */
  | { kind: 'later' };

/** A check that failed on the merge, as the github.diverged event gives it. */
function failedCheck(
  result: CommandResult,
  kind: 'setup' | 'verify',
  missing?: string,
): FailedCheck {
  return {
    command: result.command,
    kind,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    ...(missing ? { missing } : {}),
    output: result.outputTail,
  };
}

/** A Run waiting for its pull request (deliver: pr), and the pull request, merged on GitHub. */
interface MergedPullRequest {
  run: Run;
  pr: GhPullRequest;
}

/** The pull request a Run's work was merged through, as recorded (`github.pr_merged`). */
interface MergedPullRequestRecord {
  number: number;
  url: string;
  mergeCommit: string | null;
}

/** What the Run recorded of its pull request's merge; undefined while it recorded none. */
function mergedPullRequestOf(store: Store, runId: string): MergedPullRequestRecord | undefined {
  const data = store.listEvents(runId).findLast((e) => e.type === 'github.pr_merged')?.data;
  if (!data || typeof data.number !== 'number' || typeof data.url !== 'string') return undefined;
  const mergeCommit = typeof data.mergeCommit === 'string' ? data.mergeCommit : null;
  return { number: data.number, url: data.url, mergeCommit };
}

/** A scout in progress: its agent once started, and the whole scout including the cleanup. */
interface ScoutEntry {
  scoutId: string;
  exec?: AgentExecution;
  done?: Promise<void>;
}

/** Why an automatic scout does not start now; `until`: it may start after that time. */
export interface ScoutWait {
  reason: string;
  until?: string;
}

export interface BridgeDeps {
  store: Store;
  engine: Engine;
  paths: HomePaths;
  config: () => LoadedConfig;
  adapters: Map<string, AgentAdapter>;
  /** Tests pass a fake; otherwise gh, as the configured account. */
  github?: GitHub;
  /**
   * The install directory the Master runs from and its origin, to tell which repo is the
   * Master's own source; null when it does not run from one (then no repo is).
   */
  masterOrigin?: MasterOrigin | null;
  /**
   * Whether the node the Master runs on is gone: the checks of a merge of GitHub's commits then
   * wait, as they would fail for the environment, not for the code.
   */
  nodeMissing?: () => boolean;
  /**
   * Read the templates the repos keep in .ares1/workflows/ again where their target branch
   * moved (`RepoWorkflows.refresh`); never rejects. Each poll does it before it creates Runs.
   */
  refreshTemplates?: () => Promise<void>;
}

/** Start of the current day in the Master's local time, as ISO. */
export function startOfToday(now = new Date()): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * GitHub Issues as the backlog:
 * - intake: an open issue labeled ares1:ready becomes a Run;
 * - sync: the Run's progress shows on the issue (labels, comments, closed when merged);
 * - stop: a human closing the issue terminates its unfinished Run, and the issue is left alone;
 * - redo: a failed Run is redone as a new Run told why it failed, after a wait that doubles with
 *   each attempt (see redoDueAt), up to `max_run_attempts` Runs per issue and within the day's
 *   budget; then the issue is closed with every failure's reason;
 * - discussion: the requirement assessment's questions and conclusion are posted on the issue,
 *   and a human's replies there go back to the Run;
 * - pull requests (deliver: pr): a Run whose checks passed pushes its branch and opens a pull
 *   request into the target branch; once it is merged on GitHub the target branch is pulled and
 *   the Run completes, once it is closed unmerged the Run fails;
 * - scout: an AI reads the repo and its Run history and proposes issues, on demand or by itself
 *   whenever no Run of the repo goes on by itself (backing off while scouts find nothing or
 *   fail, waiting for the quota when its agent ran out of it, and capping the proposals and
 *   stuck Runs left for a human); proposals up to the configured risk are accepted without a
 *   human.
 * Intake, auto-accept and automatic scouts only happen while the work switch is on.
 * GitHub is only a mirror: failures are reported and retried on the next poll, never block Runs.
 */
export class IssueBridge {
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  /** Syncs when the earliest wait before redoing a failed Run ends. */
  private redoTimer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private client: { key: string; gh: GitHub } | undefined;
  /** gh's active account, for the client it was asked with. */
  private viewer: { gh: GitHub; login: string } | undefined;
  private readonly labelsReady = new Set<string>();
  private readonly resolved = new Map<string, string>();
  private readonly scouting = new Map<string, ScoutEntry>();
  /** Why no automatic scout started at the last poll, per repo name. */
  private readonly scoutWaiting = new Map<string, ScoutWait | null>();
  private lastPollAt: string | null = null;
  /** Target branch commit last pushed, per repo path. */
  private readonly pushed = new Map<string, string>();
  /**
   * Repos (by id) whose target branch and the one on GitHub each have commits the other lacks,
   * as last seen. Nothing is pushed while it lasts; cleared once the divergence is gone, merged
   * by the Master (see syncTarget) or by a human.
   */
  private readonly diverged = new Map<string, Divergence>();
  /** Aborted when the Master stops: ends the checks of a merge of GitHub's commits. */
  private readonly stopped = new AbortController();
  /**
   * Why fast-forwarding the target branch to GitHub's was refused, per repo id, as recorded:
   * each reason once per streak, which ends with a round the pull is no longer refused in.
   */
  private readonly pullBlocked = new Map<string, string>();
  private lastError: { message: string; at: string } | null = null;
  /**
   * The messages recorded as github.error since the last poll whose GitHub calls all went through.
   * A round calls GitHub for every step and repo, so two failures at once (one repo answering 404,
   * another 502) take turns: comparing with the last error only would record and notify each turn.
   */
  private readonly reportedErrors = new Set<string>();
  private stopping = false;
  private readonly onEvent = (e: EventRow) => {
    // An assessment's result changes the discussion, not always the Run status (go keeps running).
    if (
      e.type === 'run.status' ||
      e.type === 'assess.result' ||
      e.type === 'discussion.replied' ||
      e.type === 'discussion.timed_out'
    ) {
      this.scheduleSync();
    }
    if (e.type === 'master.working' && e.data.on === true) void this.poll();
  };

  constructor(private readonly deps: BridgeDeps) {}

  private get cfg() {
    return this.deps.config();
  }

  /** How often the Master looks at GitHub (`poll_minutes`). */
  private get pollMinutes(): number {
    return this.cfg.master.github?.poll_minutes ?? 5;
  }

  private gh(): GitHub {
    if (this.deps.github) return this.deps.github;
    const bin = this.cfg.master.bins.gh ?? 'gh';
    const account = this.cfg.master.github?.account;
    const key = `${bin}|${account ?? ''}`;
    if (this.client?.key !== key) this.client = { key, gh: new GhCli(bin, account) };
    return this.client.gh;
  }

  /**
   * Login of the account the Master acts as, which it trusts like a member of the repo:
   * `github.account`, else gh's active account, asked once per client.
   */
  private async masterLogin(): Promise<string> {
    const account = this.cfg.master.github?.account;
    if (account) return account;
    const gh = this.gh();
    if (this.viewer?.gh !== gh) this.viewer = { gh, login: await gh.viewer() };
    return this.viewer.login;
  }

  // ---- lifecycle -------------------------------------------------------------

  async start(opts: { poll: boolean } = { poll: true }): Promise<void> {
    for (const s of this.deps.store.listScouts({ limit: 1000 })) {
      if (s.status === 'running') {
        this.deps.store.updateScout(s.id, {
          status: 'interrupted',
          error: stoppedWhileScouting(),
          endedAt: nowIso(),
        });
      }
    }
    await this.removeLeftoverScoutDirs();
    await this.removeLeftoverMergeDirs();
    this.deps.store.bus.on('event', this.onEvent);
    if (opts.poll) this.schedulePoll(2_000);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stopped.abort();
    this.deps.store.bus.off('event', this.onEvent);
    clearTimeout(this.pollTimer);
    clearTimeout(this.syncTimer);
    clearTimeout(this.redoTimer);
    // Wait for the scouts to record the interruption and delete their temporary worktrees.
    await Promise.all(
      [...this.scouting.values()].map(async (s) => {
        await s.exec?.stop();
        await s.done;
      }),
    );
    await this.chain;
  }

  /** Where a scout reads the repo: a temporary worktree, deleted when the scout ends. */
  private scoutDir(scoutId: string): string {
    return join(this.deps.paths.worktreesDir, 'scouts', scoutId);
  }

  /** Temporary worktrees of scouts that a previous Master did not get to delete. */
  private async removeLeftoverScoutDirs(): Promise<void> {
    let ids: string[];
    try {
      ids = readdirSync(join(this.deps.paths.worktreesDir, 'scouts'));
    } catch {
      return; // no scout has run yet
    }
    const repos = new Set<string>();
    for (const id of ids) {
      try {
        rmSync(this.scoutDir(id), { recursive: true, force: true });
      } catch {
        continue; // tried again at the next start
      }
      const repo = this.scoutRepo(id);
      // Without the scout's record the worktree may belong to any repo.
      const paths = repo ? [repo.path] : this.deps.store.listRepos().map((r) => r.path);
      for (const p of paths) repos.add(p);
    }
    // Git forgets the worktrees whose directory is gone.
    for (const repo of repos) await pruneWorktrees(repo);
  }

  /**
   * Temporary worktrees of merges of GitHub's commits (`mergeRemote`) that a previous Master did
   * not get to delete, having stopped in the middle of the checks: the registered repos'
   * worktrees named like them in the system's temp directory.
   */
  private async removeLeftoverMergeDirs(): Promise<void> {
    const tmp = tmpdir();
    // git may give the path with the temp directory's symlinks resolved (macOS: /private/var).
    const parents = new Set([tmp, realpathSync(tmp)]);
    for (const repo of this.deps.store.listRepos()) {
      let list: string;
      try {
        list = await runGit(repo.path, ['worktree', 'list', '--porcelain']);
      } catch {
        continue; // not a repo any more: nothing of ours in it
      }
      for (const line of list.split('\n')) {
        if (!line.startsWith('worktree ')) continue;
        const path = line.slice('worktree '.length);
        if (basename(path).startsWith(MERGE_DIR_PREFIX) && parents.has(dirname(path))) {
          await dropWorktree(repo.path, path);
        }
      }
    }
  }

  private scoutRepo(scoutId: string): Repo | undefined {
    try {
      return this.deps.store.findRepo(this.deps.store.getScout(scoutId).repoId);
    } catch (err) {
      if (err instanceof NotFoundError) return undefined;
      throw err;
    }
  }

  private schedulePoll(delayMs: number): void {
    clearTimeout(this.pollTimer);
    if (this.stopping) return;
    this.pollTimer = setTimeout(() => {
      void this.poll().finally(() => this.schedulePoll(this.pollMinutes * 60_000));
    }, delayMs);
  }

  private scheduleSync(): void {
    clearTimeout(this.syncTimer);
    if (this.stopping) return;
    this.syncTimer = setTimeout(() => void this.sync(), 1_000);
  }

  /**
   * Sync once the earliest wait before redoing a failed Run ends (see redoDueAt), so the redo
   * does not also wait for the next poll. Waits held by the day's budget or the work switch are
   * left to the polls. Set again after every sync and poll.
   */
  private scheduleRedo(): void {
    clearTimeout(this.redoTimer);
    this.redoTimer = undefined;
    const github = this.cfg.master.github;
    if (!github || this.stopping || !this.deps.store.working) return;
    const now = Date.now();
    let next: number | undefined;
    for (const name of Object.keys(github.repos)) {
      const repo = this.deps.store.findRepo(name);
      if (!repo) continue;
      for (const run of this.deps.store.runsAwaitingRedo(repo.id)) {
        const due = redoDueAt(run, this.pollMinutes);
        if (due !== null && due > now && (next === undefined || due < next)) next = due;
      }
    }
    if (next === undefined) return;
    // A second late, so the wait is surely over when the sync looks.
    this.redoTimer = setTimeout(() => void this.sync(), next - now + 1_000);
    this.redoTimer.unref();
  }

  /** Run `fn` after everything queued before it; GitHub calls never overlap. */
  private serial(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  /**
   * Every comment of the Master carries the marker that tells it from a human's, and leaves out
   * the user's home directory: it quotes error output and agents' words, which carry local paths.
   */
  private comment(repo: string, number: number, body: string): Promise<void> {
    return this.gh().comment(repo, number, markComment(redactForGitHub(body)));
  }

  /**
   * Record a GitHub failure: each message once per streak of failures (a github.error notifies),
   * the latest one always (the dashboard shows it). The streak ends with a poll that had no error.
   */
  private report(err: unknown): void {
    const message = errorMessage(err);
    if (!this.reportedErrors.has(message) && this.reportedErrors.size < MAX_REPORTED_ERRORS) {
      this.reportedErrors.add(message);
      this.deps.store.event(null, 'github.error', { message });
    }
    this.lastError = { message, at: nowIso() };
  }

  // ---- poll: intake, sync, scheduled scouts ----------------------------------

  /**
   * One round: catch the target branches up with GitHub (`syncTarget`), open the pull requests
   * of Runs done but for one (deliver: pr) and follow those opened, accept proposals the
   * settings allow, start Runs for ready issues, terminate Runs whose issue a human closed and
   * start over those whose issue a human changed, catch issues up, pass on replies to the
   * assessments' questions, start a scout where the repo is idle. With the work switch off only
   * the pulling, the pull requests, the terminating and the catching up happen: none of them
   * starts new work.
   */
  poll(): Promise<void> {
    return this.serial(async () => {
      const github = this.cfg.master.github;
      if (!github || this.stopping) return;
      const working = this.deps.store.working;
      let failed = false;
      const each = async (step: (name: string) => Promise<void>) => {
        for (const name of Object.keys(github.repos)) {
          try {
            await step(name);
          } catch (err) {
            failed = true;
            this.report(err);
          }
        }
      };
      // The templates of commits a human made on a target branch, and of repos registered since.
      await this.deps.refreshTemplates?.();
      // First, so that the Runs taken this round start from GitHub's latest commits and the
      // issues closed this round see whether the branch can be pushed.
      await each(async (name) => {
        await this.syncTarget(name);
      });
      // And of GitHub's commits just pulled, for the Runs taken this round.
      await this.deps.refreshTemplates?.();
      await each(async (name) => {
        if (!(await this.openPullRequests(name))) failed = true;
      });
      // Before followIssues: the issue of a Run whose pull request was merged is closed by its
      // `Closes #N`, and the Run is to complete, not to be terminated for that.
      await each(async (name) => {
        if (!(await this.followPullRequests(name))) failed = true;
      });
      if (working) {
        await each((name) => this.acceptBacklog(name));
        await each((name) => this.intake(name));
      }
      if (!(await this.followIssues())) failed = true;
      if (!(await this.syncRuns())) failed = true;
      if (working) {
        await each((name) => this.collectReplies(name));
        await each((name) => this.redoFailedRuns(name));
      }
      await each(async (name) => {
        await this.pushTarget(name);
      });
      if (working) await each((name) => this.maybeAutoScout(name));
      else {
        for (const name of Object.keys(github.repos)) {
          this.scoutWaiting.set(name, {
            reason: t({ zh: '工作开关已关闭', en: 'The work switch is off' }),
          });
        }
      }
      this.scheduleRedo();
      this.lastPollAt = nowIso();
      if (!failed) {
        this.lastError = null;
        this.reportedErrors.clear();
      }
    });
  }

  /**
   * Open the pull requests of Runs that just got to wait for one (deliver: pr) and follow those
   * opened, catch issues up with their Runs now, and redo the failed Runs whose wait before the
   * redo is over (see redoDueAt): a Run that just failed is not redone right away.
   */
  sync(): Promise<void> {
    return this.serial(async () => {
      const github = this.cfg.master.github;
      if (!github || this.stopping) return;
      // Before the issues are caught up, so the pull request's link is posted before the label
      // says the issue waits for a human.
      for (const name of Object.keys(github.repos)) {
        try {
          await this.openPullRequests(name);
        } catch (err) {
          this.report(err);
        }
        try {
          await this.followPullRequests(name);
        } catch (err) {
          this.report(err);
        }
      }
      await this.syncRuns();
      if (this.deps.store.working) {
        for (const name of Object.keys(github.repos)) {
          try {
            await this.redoFailedRuns(name);
          } catch (err) {
            this.report(err);
          }
        }
      }
      this.scheduleRedo();
    });
  }

  private repoSetup(name: string): { repo: Repo; cfg: GitHubRepoConfig } {
    const cfg = this.cfg.master.github?.repos[name];
    if (!cfg) {
      throw new NotFoundError(
        t({
          zh: `config.yaml 的 github.repos 里没有 ${name}`,
          en: `${name} is not in github.repos of config.yaml`,
        }),
      );
    }
    const problems = this.cfg.errors[githubConfigKey(name)];
    if (problems) {
      throw new InvalidStateError(
        t({
          zh: `github.repos.${name} 配置有误：${problems.join('；')}`,
          en: `github.repos.${name} is misconfigured: ${problems.join('; ')}`,
        }),
      );
    }
    const repo = this.deps.store.findRepo(name);
    if (!repo) throw new NotFoundError(notRegistered(name));
    return { repo, cfg };
  }

  private async issuesRepo(repo: Repo, cfg: GitHubRepoConfig): Promise<string> {
    if (cfg.issues_repo) return cfg.issues_repo;
    let full = this.resolved.get(repo.path);
    if (!full) {
      full = await this.gh().resolveRepo(repo.path);
      this.resolved.set(repo.path, full);
    }
    return full;
  }

  private async ensureLabels(full: string): Promise<void> {
    if (this.labelsReady.has(full)) return;
    await this.gh().ensureLabels(full, labelDefs());
    this.labelsReady.add(full);
  }

  private async intake(name: string): Promise<void> {
    const { repo, cfg } = this.repoSetup(name);
    const full = await this.issuesRepo(repo, cfg);
    await this.ensureLabels(full);
    const gh = this.gh();
    const ready = await gh.listIssues(full, { state: 'open', label: LABELS.ready, limit: 50 });
    for (const issue of ready.sort((a, b) => a.number - b.number)) {
      if (this.stopping) return;
      let run = this.deps.store.unfinishedRunForIssue(full, issue.number);
      if (!run) {
        // Only people allowed to triage can add ares1:ready, but anybody may have written the
        // issue, and may edit it after the label was added.
        const untrusted = isTrusted(issue, await this.masterLogin())
          ? undefined
          : untrustedAuthor(issue, null);
        run = this.createIssueRun(
          repo,
          cfg,
          goalFromIssue(issue),
          // ares1:ready (again) starts the count of attempts over.
          {
            repo: full,
            number: issue.number,
            url: issue.url,
            auto: issue.labels.includes(LABELS.auto),
            attempt: 1,
            ...(untrusted ? { untrusted } : {}),
          },
          untrusted ? untrustedGoalMessage(issue) : undefined,
        );
        const templateName = this.templateName(name, cfg);
        const runUrl = `${this.dashboardUrl()}/#/runs/${run.id}`;
        await this.comment(
          full,
          issue.number,
          t({
            zh: `${brandName()}开始处理：Run \`${run.id}\`（模板「${templateName}」）。\n\n看板：${runUrl}`,
            en: `${brandName()} started on it: Run \`${run.id}\` (template "${templateName}").\n\nDashboard: ${runUrl}`,
          }),
        );
      }
      // The Run may have moved on already; the next sync reports where it is.
      await gh.setLabels(full, issue.number, withStatusLabel(issue.labels, LABELS.running));
      this.deps.store.setIssueSynced(run.id, 'queued');
    }
  }

  /**
   * A Run of an issue: with the repo's template, and without approval before merging when
   * `auto_merge` is on (the other gates of the template stay). Every Run from an issue is created
   * here, whether a human added ares1:ready, a failed one is redone, or the issue was changed.
   */
  private createIssueRun(
    repo: Repo,
    cfg: GitHubRepoConfig,
    goal: string,
    issue: RunIssue,
    confirmGoal?: string,
  ): Run {
    return this.deps.engine.createRun({
      repo: repo.name,
      template: cfg.template,
      goal,
      overrides: issueRunOverrides(this.template(repo.name, cfg), cfg.auto_merge),
      issue,
      confirmGoal,
    });
  }

  /**
   * The template the repo's Runs get (`findTemplate`): the home directory's, else the one the
   * repo keeps; undefined when neither has it.
   */
  private template(name: string, cfg: GitHubRepoConfig): WorkflowTemplate | undefined {
    return findTemplate(this.cfg, name, cfg.template)?.template;
  }

  /** Name of the repo's template, as the comments on its issues give it. */
  private templateName(name: string, cfg: GitHubRepoConfig): string {
    return this.template(name, cfg)?.name ?? cfg.template;
  }

  /**
   * Accept proposals still waiting for a human that the auto-accept settings now allow, e.g. after
   * the settings were loosened. Uses the risk and size the scout gave them.
   */
  private async acceptBacklog(name: string): Promise<void> {
    const { repo, cfg } = this.repoSetup(name);
    if (cfg.auto_accept.max_risk === 'none') return;
    const full = await this.issuesRepo(repo, cfg);
    const open = await this.gh().listIssues(full, {
      state: 'open',
      label: LABELS.proposal,
      limit: 100,
    });
    const scouts = this.deps.store.listScouts({ repoId: repo.id, limit: 200 });
    for (const issue of untriaged(open).sort((a, b) => a.number - b.number)) {
      if (!this.mayAutoAccept(repo, cfg)) return;
      const filed = filedProposal(scouts, issue.number);
      const proposal = filed?.proposal;
      if (!filed || !proposal?.issue || !isAutoAcceptable(proposal, cfg.auto_accept)) {
        continue;
      }
      const { scout } = filed;
      await this.gh().setLabels(full, issue.number, [
        ...withStatusLabel(issue.labels, LABELS.ready),
        LABELS.auto,
      ]);
      await this.comment(full, issue.number, autoAcceptedComment());
      proposal.issue.auto = true;
      this.deps.store.tx(() => {
        this.deps.store.updateScout(scout.id, { proposals: scout.proposals });
        this.deps.store.event(null, 'issue.auto_accepted', { repo: name, issue: issue.number });
      });
    }
  }

  /**
   * Push the target branch to GitHub when it moved since the last push. Returns whether GitHub
   * has it: false only while the two have diverged and are not merged yet (see syncTarget), when
   * nothing is pushed, since GitHub would refuse it every round.
   */
  private async pushTarget(name: string): Promise<boolean> {
    const { repo, cfg } = this.repoSetup(name);
    if (!cfg.push) return true;
    // The work reaches GitHub through pull requests (openPullRequests); the target branch there
    // only takes them, and the local one moves only by pulling GitHub's (syncTarget).
    if (cfg.deliver === 'pr') return true;
    if (this.diverged.has(repo.id)) return false;
    const head = await revParse(repo.path, repo.targetBranch);
    if (this.pushed.get(repo.path) === head) return true;
    const full = await this.issuesRepo(repo, cfg);
    await this.gh().push(repo.path, full, repo.targetBranch);
    this.pushed.set(repo.path, head);
    this.deps.store.event(null, 'github.pushed', { repo: name, branch: repo.targetBranch, head });
    await this.trackOrigin(repo, full, head);
    return true;
  }

  /**
   * Deliver the repo's Runs that wait for a pull request (`pr_open`, deliver: pr) and have none
   * yet, or have one but not the commits made since a rework sent them back
   * (`pullRequestPushPending`): push each one's branch to the GitHub repo the target branch is
   * pushed to, and open a pull request from it into the target branch, or update the one it has
   * (`openPullRequest`). Also for Runs that got to wait before the repo was switched back to
   * deliver: push: nothing else delivers them, and they cannot be retried. A GitHub call that
   * fails is reported and leaves the Run as it was, to be tried again the next round; the other
   * Runs go on. Returns false when some call failed.
   */
  private async openPullRequests(name: string): Promise<boolean> {
    const store = this.deps.store;
    const repo = store.findRepo(name);
    if (!repo) return true;
    const waiting = store
      .listRuns({ status: 'blocked', repoId: repo.id })
      .filter(
        (run) =>
          run.blocked?.kind === 'pr_open' &&
          run.branch &&
          (run.pr === null || pullRequestPushPending(store.listEvents(run.id))),
      );
    if (waiting.length === 0) return true;
    // Throws while the repo is misconfigured, e.g. deliver: pr without push: the Runs wait.
    const { cfg } = this.repoSetup(name);
    // Without push nothing of the repo goes to GitHub: the Runs wait until it is on again.
    if (!cfg.push) return true;
    const full = await this.issuesRepo(repo, cfg);
    let ok = true;
    for (const run of waiting) {
      if (this.stopping) break;
      try {
        await this.openPullRequest(repo, full, run);
      } catch (err) {
        ok = false;
        this.report(err);
      }
    }
    return ok;
  }

  /**
   * Push the branch of `run`, waiting in `pr_open` as read, to `full` and open its pull request
   * into the target branch, or take the one already open from that branch (opened before a
   * restart, or in a round whose later steps failed), so a Run never gets two. The push is
   * forced: the branch is the Run's own, and its history may have been rewritten (by a rollback)
   * since an earlier push. The Run records the pull request (`github.pr_opened`), unless it no
   * longer waits for one (cancelled meanwhile); then its issue gets the link. The comment comes
   * last, so that a failed one does not hold the Run up: the pull request's `Closes #N` shows it
   * on the issue anyway. A Run that has its pull request already goes to `updatePullRequest`.
   */
  private async openPullRequest(repo: Repo, full: string, run: Run): Promise<void> {
    const branch = run.branch;
    if (!branch) return;
    if (run.pr) {
      await this.updatePullRequest(repo, full, run, run.pr, branch);
      return;
    }
    const gh = this.gh();
    const target = repo.targetBranch;
    await gh.push(repo.path, full, branch, { force: true });
    const open = await gh.findOpenPullRequest(full, branch);
    let pr: { number: number; url: string };
    // One a human opened from it into another branch is not how the Run delivers.
    if (open && open.baseRefName === target) pr = open;
    else {
      const text = pullRequestText(run, { repo: full, dashboardUrl: this.dashboardUrl() });
      pr = await gh.createPullRequest(full, {
        head: branch,
        base: target,
        title: redactForGitHub(text.title),
        body: redactForGitHub(text.body),
      });
    }
    const recorded = this.deps.engine.recordPullRequest(run, { number: pr.number, url: pr.url });
    if (recorded !== 'opened') return;
    const issue = run.issue;
    if (!issue) return;
    await this.comment(
      issue.repo,
      issue.number,
      pullRequestComment({
        number: pr.number,
        url: pr.url,
        targetBranch: target,
        runId: run.id,
        dashboardUrl: this.dashboardUrl(),
      }),
    );
  }

  /**
   * Push the commits `run`, waiting in `pr_open` as read, made since a rework sent it back to the
   * pull request `pr` it already has, rather than opening a second one. Only while `pr` is still
   * open on GitHub: once merged or closed, nothing is pushed or opened, and followPullRequests
   * completes or fails the Run by what became of it, so that a pull request a human closed is not
   * followed by a new one. The push is forced, as in `openPullRequest`. The Run records the update
   * (`github.pr_updated`), which ends the pending push, so a later round or a restarted Master
   * pushes and comments no more; then its issue hears of it, the comment last as there.
   */
  private async updatePullRequest(
    repo: Repo,
    full: string,
    run: Run,
    pr: { number: number; url: string },
    branch: string,
  ): Promise<void> {
    const gh = this.gh();
    const latest = await gh.getPullRequest(full, pr.number);
    if (latest.state !== 'open') return;
    await gh.push(repo.path, full, branch, { force: true });
    if (this.deps.engine.recordPullRequest(run, pr) !== 'updated') return;
    const issue = run.issue;
    if (!issue) return;
    await this.comment(
      issue.repo,
      issue.number,
      pullRequestUpdatedComment({
        number: pr.number,
        url: pr.url,
        runId: run.id,
        dashboardUrl: this.dashboardUrl(),
      }),
    );
  }

  /**
   * Follow the pull requests of the repo's Runs that wait for theirs to be merged (`pr_open`,
   * with the pull request recorded), by what GitHub says of each now, whichever way it was merged
   * (a merge, a squash or a rebase):
   * - merged: the local target branch catches up with GitHub's first, then the Run goes on and
   *   completes (`completeMerged`);
   * - closed without being merged: the Run fails (`pullRequestClosed`), and is redone or waits
   *   for a human by the usual rules for failed Runs;
   * - open: sent back for more work when it needs it (`reworkPullRequest`): a trusted reviewer
   *   asked for changes, its checks failed, or it conflicts with the target branch; otherwise
   *   left as it is.
   * Without push the target branch cannot be pulled: the Runs wait until it is on again. A GitHub
   * call that fails is reported and leaves the Run as it was, to be tried again the next round;
   * the other Runs go on. Returns false when some call failed.
   */
  private async followPullRequests(name: string): Promise<boolean> {
    const store = this.deps.store;
    const repo = store.findRepo(name);
    if (!repo) return true;
    const waiting = store
      .listRuns({ status: 'blocked', repoId: repo.id })
      .filter((run) => run.blocked?.kind === 'pr_open' && run.pr !== null);
    if (waiting.length === 0) return true;
    // Throws while the repo is misconfigured: the Runs wait.
    const { cfg } = this.repoSetup(name);
    if (!cfg.push) return true;
    const full = await this.issuesRepo(repo, cfg);
    let ok = true;
    const merged: MergedPullRequest[] = [];
    for (const run of waiting) {
      if (this.stopping) return ok;
      const number = run.pr?.number;
      if (number === undefined) continue;
      try {
        const pr = await this.gh().getPullRequest(full, number);
        if (pr.state === 'merged') merged.push({ run, pr });
        else if (pr.state === 'closed') {
          this.deps.engine.pullRequestClosed(run, { number: pr.number, url: pr.url });
        } else await this.reworkPullRequest(run, pr);
      } catch (err) {
        ok = false;
        this.report(err);
      }
    }
    if (merged.length === 0) return ok;
    try {
      await this.completeMerged(name, repo, merged);
    } catch (err) {
      ok = false;
      this.report(err);
    }
    return ok;
  }

  /**
   * The open pull request `pr` of `run`, waiting in `pr_open` as read, as GitHub has it now:
   * judged on its head, the commit the Run delivered (`judgePullRequest`), and when a reviewer
   * the Master trusts asked for changes there, its checks all finished with some failed, or it
   * conflicts with the target branch, the Run goes back for more work
   * (`pullRequestNeedsRework`) and its issue hears why. The label goes from needs-you back to
   * running as the issue catches up with the Run (`syncRun`). Each kind counts once per head
   * commit, by the Run's `github.pr_rework` events, so neither a later round nor a restarted
   * Master reworks the same thing twice; a review approved over or dismissed since counts no
   * more. Nothing is judged while the commits of the Run's latest round are still to be pushed
   * (`pullRequestPushPending`): GitHub shows its earlier work. Reviews by people the Master does
   * not trust trigger nothing and reach no prompt: only who wrote them is recorded
   * (`recordIgnoredReviews`). The comment comes last, as in `openPullRequest`.
   */
  private async reworkPullRequest(run: Run, pr: GhPullRequestStatus): Promise<void> {
    const master = await this.masterLogin();
    // Read after the last await, so that what the engine did meanwhile counts.
    const events = this.deps.store.listEvents(run.id);
    if (pullRequestPushPending(events)) return;
    const { rework, ignored } = judgePullRequest(pr, {
      head: run.headCommit,
      master,
      done: reworksDone(events),
    });
    this.recordIgnoredReviews(run, pr, ignored);
    if (!rework) return;
    const ref = { number: pr.number, url: pr.url };
    if (!this.deps.engine.pullRequestNeedsRework(run, ref, rework)) return;
    const issue = run.issue;
    if (!issue) return;
    await this.comment(
      issue.repo,
      issue.number,
      pullRequestReworkComment({
        ...ref,
        reason: rework.reason,
        runId: run.id,
        dashboardUrl: this.dashboardUrl(),
      }),
    );
  }

  /**
   * Record on the Run each review in `ignored`, which asks for changes on the head of its pull
   * request `pr` but was written by someone the Master does not trust
   * (`github.pr_review_ignored`), once per head commit and reviewer: who wrote it and their
   * relation to the repo, so that a human can see why it changed nothing; never its text.
   */
  private recordIgnoredReviews(
    run: Run,
    pr: GhPullRequestStatus,
    ignored: readonly IgnoredReview[],
  ): void {
    if (ignored.length === 0) return;
    const store = this.deps.store;
    const head = pr.headRefOid;
    const key = (reviewer: unknown) =>
      JSON.stringify([head, typeof reviewer === 'string' ? reviewer.toLowerCase() : null]);
    store.tx(() => {
      const seen = new Set(
        store
          .listEvents(run.id)
          .filter((e) => e.type === 'github.pr_review_ignored' && e.data.head === head)
          .map((e) => key(e.data.reviewer)),
      );
      for (const review of ignored) {
        if (seen.has(key(review.author))) continue;
        seen.add(key(review.author));
        store.event(run.id, 'github.pr_review_ignored', {
          number: pr.number,
          url: pr.url,
          head,
          reviewer: review.author,
          association: review.association,
        });
      }
    });
  }

  /**
   * Pull requests of the repo's Runs that GitHub merged: the local target branch is caught up
   * with GitHub's (`syncTarget`) unless it has each merge already, and then each Run whose merge
   * it has goes on (`pullRequestMerged`), which completes it, with the work in the local target
   * branch too. A Run whose merge the local branch does not have yet waits for the next round,
   * its pull request still merged on GitHub: the fast-forward was refused (syncTarget records
   * why, `github.pull_blocked`), the two diverged (merged as syncTarget does), or a Run of the
   * repo merges meanwhile. A fetch that fails is thrown.
   */
  private async completeMerged(
    name: string,
    repo: Repo,
    merged: readonly MergedPullRequest[],
  ): Promise<void> {
    let pulled = false;
    let remote: string | null | undefined;
    for (const { run, pr } of merged) {
      if (this.stopping) return;
      if (!(pr.mergeCommit && (await this.targetHas(repo, pr.mergeCommit)))) {
        if (!pulled) {
          remote = await this.syncTarget(name);
          pulled = true;
        }
        // GitHub gives the merge commit of every merged pull request; without it, all that is
        // known is that its branch has the merge.
        const commit = pr.mergeCommit ?? remote;
        if (!commit || !(await this.targetHas(repo, commit))) continue;
      }
      this.deps.engine.pullRequestMerged(run, {
        number: pr.number,
        url: pr.url,
        mergeCommit: pr.mergeCommit,
      });
    }
  }

  /** Whether the repo's local target branch has `commit`, which may not be in the clone. */
  private async targetHas(repo: Repo, commit: string): Promise<boolean> {
    return isAncestor(repo.path, commit, repo.targetBranch);
  }

  /**
   * Whether the Run, whose issue was found closed, delivers its work through a pull request that
   * was merged: its `Closes #N` closed the issue, or a human did along with merging it, and the
   * Run is to complete rather than be terminated. A Run that recorded the merge already goes on
   * by itself. One still waiting has its pull request asked about, and once it is merged, the Run
   * is moved on as followPullRequests does, or keeps waiting while the local target branch cannot
   * catch up yet. GitHub errors are thrown, and the Run stays as it is.
   */
  private async mergedThroughPullRequest(run: Run): Promise<boolean> {
    const pr = run.pr;
    if (!pr) return false;
    if (mergedPullRequestOf(this.deps.store, run.id)) return true;
    if (run.status !== 'blocked' || run.blocked?.kind !== 'pr_open') return false;
    const repo = this.deps.store.getRepo(run.repoId);
    const cfg = this.cfg.master.github?.repos[repo.name];
    // Nothing to ask GitHub with: the issue closed by a human ends the Run as before.
    if (!cfg) return false;
    const latest = await this.gh().getPullRequest(await this.issuesRepo(repo, cfg), pr.number);
    if (latest.state !== 'merged') return false;
    await this.completeMerged(repo.name, repo, [{ run, pr: latest }]);
    return true;
  }

  /**
   * Keep `git status` in the clone honest when its origin is the GitHub repo `full`: its
   * remote-tracking branch of the target branch is set to `head`, which GitHub has.
   */
  private async trackOrigin(repo: Repo, full: string, head: string): Promise<void> {
    try {
      const url = (await runGit(repo.path, ['remote', 'get-url', 'origin'])).replace(/\.git$/, '');
      if (url.endsWith(`github.com:${full}`) || url.endsWith(`github.com/${full}`)) {
        await runGit(repo.path, ['update-ref', `refs/remotes/origin/${repo.targetBranch}`, head]);
      }
    } catch {
      // no origin: nothing to keep in step
    }
  }

  /**
   * Bring commits others pushed to the target branch on GitHub into the local one, so that later
   * Runs build on them and the pushes keep fast-forwarding. Only for repos that push (without
   * `push` the code need not be on GitHub at all), and only while no Run of the repo merges, so
   * as not to race the engine for the branch (a merge that starts meanwhile is guarded by
   * fastForwardBranch's compare-and-swap). Runs going on merge the new commits as usual when
   * they merge. By GitHub's commit (remote) and the local one (local):
   * - GitHub has no such branch yet (a new, empty repo, or the branch was deleted): as local
   *   ahead, the push later in the round creates it;
   * - the same, or local ahead (not pushed yet): nothing to do, the push follows;
   * - local behind: fast-forwarded (`github.pulled`). GitHub has it, so it is not pushed back,
   *   nor is the old commit while the fast-forward is refused because the branch is checked
   *   out with uncommitted changes (`github.pull_blocked`, each reason once per streak);
   * - diverged: GitHub's commits are merged in by the Master when they merge without conflicts
   *   and the repo's checks pass on the result (`mergeDiverged`); the push later in the round
   *   takes the merge to GitHub. Otherwise a Run's agent merges them, or a human does when no
   *   Run can, and nothing is pushed until then (pushTarget).
   * A fetch that fails is thrown, to be reported like every GitHub error.
   * Returns GitHub's commit of the target branch as fetched: null when GitHub has no such branch,
   * undefined when nothing was fetched (no push, or a Run merges).
   */
  private async syncTarget(name: string): Promise<string | null | undefined> {
    const { repo, cfg } = this.repoSetup(name);
    if (!cfg.push || this.repoMerging(repo)) return undefined;
    const store = this.deps.store;
    const branch = repo.targetBranch;
    const full = await this.issuesRepo(repo, cfg);
    const remote = await this.gh().fetch(repo.path, full, branch);
    if (remote === null) {
      this.diverged.delete(repo.id);
      this.pullBlocked.delete(repo.id);
      // What was pushed is gone (or never was): the push later in the round creates it again.
      this.pushed.delete(repo.path);
      return null;
    }
    await this.trackOrigin(repo, full, remote);
    const local = await revParse(repo.path, branch);
    if (remote === local || (await isAncestor(repo.path, remote, local))) {
      this.diverged.delete(repo.id);
      this.pullBlocked.delete(repo.id);
      return remote;
    }
    if (!(await isAncestor(repo.path, local, remote))) {
      await this.mergeDiverged(repo, name, local, remote);
      return remote;
    }
    this.diverged.delete(repo.id);
    // GitHub has the local commit: pushing it would only be refused, as not a fast-forward.
    this.pushed.set(repo.path, local);
    // Looked at again: a Run may have started merging while GitHub answered.
    if (this.repoMerging(repo)) return remote;
    if (await this.fastForwardTarget(repo, name, remote)) {
      this.pushed.set(repo.path, remote);
      store.event(null, 'github.pulled', { repo: name, branch, from: local, to: remote });
    }
    return remote;
  }

  /**
   * Fast-forward the target branch to `head` (fastForwardBranch); returns whether it moved. When
   * the branch moved on meanwhile it is left to the next round; when it is checked out with
   * uncommitted changes that is recorded (`github.pull_blocked`), each reason once per streak.
   */
  private async fastForwardTarget(repo: Repo, name: string, head: string): Promise<boolean> {
    const ff = await fastForwardBranch(repo.path, repo.targetBranch, head);
    if (ff.ok) {
      this.pullBlocked.delete(repo.id);
      return true;
    }
    if (ff.reason === 'diverged') return false;
    if (this.pullBlocked.get(repo.id) === ff.reason) return false;
    this.pullBlocked.set(repo.id, ff.reason);
    this.deps.store.event(null, 'github.pull_blocked', {
      repo: name,
      branch: repo.targetBranch,
      reason: ff.reason,
      worktree: ff.worktree,
      status: ff.status,
    });
    return false;
  }

  /**
   * The target branch (`local`) and GitHub's (`remote`) have diverged. Nothing is pushed until
   * they are merged (pushTarget). The Master merges GitHub's commits in by itself (`mergeRemote`)
   * and fast-forwards the target branch to the merge (`github.merged_remote`, not notified); the
   * push later in the round takes it to GitHub. Not while a Run of the repo merges, looked at
   * again after the checks; a fast-forward that has to wait is tried again next round with the
   * same merge commit. When the merge conflicts or a check fails on it, the branch stays as it
   * is and the merge is not tried again for the same pair of commits. It is handed to a Run that
   * merges GitHub's commits (`handToRun`): the repo's one that goes on already, whichever commit
   * it was created for, so that a repo has one merging at a time; else one created for `remote`
   * (`github.diverged_run`). The Run's coding agent finishes the merge, and once the Run is merged
   * the target branch has moved: the next round finds it ahead and pushes, or tries the new pair
   * (GitHub's newer commit, when the Run merged an earlier one) like any. Without a Run going on
   * (none could be created, or the one it was handed to, found by its id, was terminated or
   * failed, at the time or later) a human merges. Either way it is recorded (`github.diverged`,
   * with the conflicted files or the failed command, and `runId` while a Run has it). A check that
   * cannot start for a missing program is recorded too, with no Run, but tried again each round,
   * to go on once it is installed. Each kind of record notifies once while the divergence lasts
   * (`repeated` on the others): handing it to a Run (once per Run), asking for a hand merge, a
   * missing program. A merge Run going on when the Master's own merge goes through is left to the
   * engine: once it finds the target branch has the Run's commit, it completes the Run without
   * starting another agent (`run.merge_remote_obsolete`).
   */
  private async mergeDiverged(
    repo: Repo,
    name: string,
    local: string,
    remote: string,
  ): Promise<void> {
    const seen = this.diverged.get(repo.id);
    const same = seen?.local === local && seen.remote === remote ? seen : undefined;
    if (same?.outcome === 'failed') {
      // The Run it was handed to ended without merging it: a human merges now.
      if (same.handed && !this.mergeRunGoesOn(same.handedTo)) {
        const why = same.handed;
        same.handed = undefined;
        same.handedTo = undefined;
        this.recordDiverged(repo, name, same, 'failed', why);
      }
      return;
    }
    const divergence: Divergence = same ?? {
      local,
      remote,
      reported: seen?.reported,
      reportedRun: seen?.reportedRun,
    };
    this.diverged.set(repo.id, divergence);
    let merge = divergence.merge;
    // A merge commit kept for long may have been garbage-collected meanwhile.
    if (merge && !(await revParse(repo.path, merge).catch(() => null))) merge = undefined;
    if (!merge) {
      const result = await this.mergeRemote(repo, local, remote);
      if (result.kind === 'later') return;
      if (result.kind !== 'merged') {
        this.pullBlocked.delete(repo.id);
        const before = divergence.outcome;
        divergence.outcome = result.kind;
        if (result.kind === 'environment') {
          // The same pair still missing the same program: recorded already.
          if (before !== 'environment') {
            this.recordDiverged(repo, name, divergence, 'environment', result.data);
          }
          return;
        }
        const run = await this.handToRun(repo, name, local, remote, result.data);
        if (run) {
          divergence.handed = result.data;
          divergence.handedTo = run.id;
        }
        this.recordDiverged(repo, name, divergence, 'failed', result.data, run ?? undefined);
        return;
      }
      merge = result.merge;
      divergence.merge = merge;
    }
    // Looked at again: a Run may have started merging while the checks ran.
    if (this.stopping || this.repoMerging(repo)) return;
    if (!(await this.fastForwardTarget(repo, name, merge))) return;
    this.diverged.delete(repo.id);
    this.deps.store.event(null, 'github.merged_remote', {
      repo: name,
      branch: repo.targetBranch,
      local,
      remote,
      merge,
    });
  }

  /**
   * The Run that merges GitHub's commit `remote` into the repo's target branch, at `local`, after
   * the Master's own merge failed (`why`). At most one such Run of a repo merges at a time, so
   * that two agents never merge GitHub's commits side by side, the later one running into
   * conflicts with the earlier: while the repo has one that has not finished
   * (`unfinishedMergeRemoteRuns`), whichever commit it was created for, the pair is handed to it,
   * and no Run is created. It merges its own commit; once it is merged the target branch has
   * moved, so the next round tries the new pair, by the Master's merge first, and hands it to a
   * new Run when that fails again. A Run whose commit the target branch has already does not
   * count: it has nothing left to merge, and completes without an agent when it next goes on
   * (`run.merge_remote_obsolete`), maybe only after a human, if it waits for one. Else a new one,
   * with `mergeRemoteGoal` and the repo's template, without approval before merging when
   * `auto_merge` is on, like the Runs of its issues. One Run per commit, found again after a
   * restart (`runMergingRemote`). Null when a human merges instead: the repo's Run for `remote`
   * was terminated or failed, the repo no longer pushes, its template is missing or has no agent
   * stage to merge in, or the Run could not be created.
   */
  private async handToRun(
    repo: Repo,
    name: string,
    local: string,
    remote: string,
    why: RemoteMergeFailure,
  ): Promise<{ id: string; created: boolean } | null> {
    const store = this.deps.store;
    for (const going of store.unfinishedMergeRemoteRuns(repo.id)) {
      const merged = going.mergeRemote && (await isAncestor(repo.path, going.mergeRemote, local));
      if (!merged) return { id: going.id, created: false };
    }
    // Only finished ones are left for `remote`: it ended without merging, a human merges now.
    if (store.runMergingRemote(repo.id, remote)) return null;
    // Looked at again: the config may have changed while the merge was checked.
    const cfg = this.cfg.master.github?.repos[name];
    if (!cfg?.push) return null;
    const template = this.template(name, cfg);
    if (!template?.stages.some((s) => s.kind === 'agent')) return null;
    try {
      const run = this.deps.engine.createRun({
        repo: repo.name,
        template: cfg.template,
        goal: mergeRemoteGoal({ branch: repo.targetBranch, local, remote, why }),
        overrides: issueRunOverrides(template, cfg.auto_merge),
        mergeRemote: remote,
      });
      return { id: run.id, created: true };
    } catch {
      // The template turned out unusable: a human merges, as the github.diverged event asks.
      return null;
    }
  }

  /**
   * Whether the Run a pair was handed to (`handedTo`) goes on: by its id, since it may have been
   * created for another commit of GitHub than the pair's.
   */
  private mergeRunGoesOn(runId: string | undefined): boolean {
    if (!runId) return false;
    return !FINISHED_RUN_STATUSES.includes(this.deps.store.getRun(runId).status);
  }

  /**
   * Record that the pair of `divergence` does not merge by itself (`github.diverged`, with
   * `data`): handed to the Run `run`, also recorded as created for it (`github.diverged_run`)
   * when it is new; else for a human to merge (`failed`), or until a missing program is installed
   * (`environment`). `repeated`, not notified, when the same was told while the divergence lasts:
   * the same Run, a hand merge, or a missing program after any of them.
   */
  private recordDiverged(
    repo: Repo,
    name: string,
    divergence: Divergence,
    kind: 'failed' | 'environment',
    data: RemoteMergeFailure | Record<string, unknown>,
    run?: { id: string; created: boolean },
  ): void {
    const reported = divergence.reported;
    let repeated: boolean;
    if (run) {
      repeated = reported === 'run' && divergence.reportedRun === run.id;
      divergence.reported = 'run';
      divergence.reportedRun = run.id;
    } else if (kind === 'failed') {
      repeated = reported === 'failed';
      divergence.reported = 'failed';
      divergence.reportedRun = undefined;
    } else {
      // Nothing to add while a hand merge was asked for, or a Run has the merge.
      repeated = reported !== undefined;
      divergence.reported ??= 'environment';
    }
    const { local, remote } = divergence;
    const branch = repo.targetBranch;
    this.deps.store.tx(() => {
      this.deps.store.event(null, 'github.diverged', {
        repo: name,
        branch,
        local,
        remote,
        ...data,
        ...(run ? { runId: run.id } : {}),
        ...(repeated ? { repeated: true } : {}),
      });
      if (run?.created) {
        this.deps.store.event(null, 'github.diverged_run', {
          repo: name,
          branch,
          local,
          remote,
          runId: run.id,
        });
      }
    });
  }

  /**
   * Merge GitHub's commit `remote` into the target branch's `local` (`git merge --no-ff`, with
   * `mergeRemoteMessage`) in a temporary worktree in the system's temp directory, and run the
   * repo's setup and verify commands there on the result, as the Run's checks would: with the
   * environment agents get (no GitHub credentials), their output in `github-merge-<repo>.log`
   * under the logs directory, ended when the Master stops. The worktree is deleted whatever
   * comes of it; the merge commit stays in the repo, to fast-forward the branch to. A merge git
   * cannot even start is thrown, to be reported like other failures and tried again next round.
   */
  private async mergeRemote(repo: Repo, local: string, remote: string): Promise<RemoteMerge> {
    const commands = [...repo.setupCommands, ...repo.verifyCommands];
    // The checks would fail for the environment: tried again once node is back.
    if (commands.length > 0 && this.deps.nodeMissing?.()) return { kind: 'later' };
    const kindOf = (command: string) =>
      repo.setupCommands.includes(command) ? ('setup' as const) : ('verify' as const);
    const env = prepareAgentEnv(this.deps.paths.agentGhConfigDir);
    const missing = firstMissingCommand(commands, env);
    if (missing) {
      const failed = { command: missing.command, kind: kindOf(missing.command) };
      return { kind: 'environment', data: { failed: { ...failed, missing: missing.missing } } };
    }
    const dir = mkdtempSync(join(tmpdir(), MERGE_DIR_PREFIX));
    try {
      await addDetachedWorktree(repo.path, dir, local);
      const merged = await mergeOrAbort(dir, remote, mergeRemoteMessage(repo.targetBranch));
      if (!merged.ok) {
        if (merged.files.length === 0) throw new Error(merged.error);
        return { kind: 'failed', data: { conflict: true, files: merged.files } };
      }
      const merge = await revParse(dir, 'HEAD');
      if (commands.length === 0) return { kind: 'merged', merge };
      const logPath = join(this.deps.paths.logsDir, `github-merge-${repo.name}.log`);
      mkdirSync(this.deps.paths.logsDir, { recursive: true });
      writeFileSync(logPath, `# ${local} + ${remote} -> ${merge}\n`);
      const opts = {
        timeoutMs: this.cfg.master.defaults.command_timeout_minutes * 60_000,
        logPath,
        env,
        signal: this.stopped.signal,
      };
      const setup = await runCommands(repo.setupCommands, dir, opts);
      const failedSetup = setup.find((r) => !r.passed);
      const verify = failedSetup ? [] : await runCommands(repo.verifyCommands, dir, opts);
      if (this.stopped.signal.aborted) return { kind: 'later' };
      const failed = failedSetup ?? verify.find((r) => !r.passed);
      if (!failed) return { kind: 'merged', merge };
      const program = environmentProblem(failed, env) ?? undefined;
      const check = failedCheck(failed, failedSetup ? 'setup' : 'verify', program);
      const data = { failed: check, log: logPath };
      return program ? { kind: 'environment', data } : { kind: 'failed', data };
    } finally {
      await dropWorktree(repo.path, dir);
    }
  }

  /** Some Run of the repo is merging into its target branch now. */
  private repoMerging(repo: Repo): boolean {
    return this.deps.store.listRuns({ status: 'running', repoId: repo.id }).some((run) => {
      if (!run.currentStageRunId) return false;
      const sr = this.deps.store.getStageRun(run.currentStageRunId);
      return sr.status === 'executing' && this.merging(run);
    });
  }

  private dashboardUrl(): string {
    return `http://127.0.0.1:${this.cfg.master.port}`;
  }

  /**
   * Follow what humans do to the issues of unfinished Runs. A human closed the issue (completed or
   * not planned): nobody wants the work any more, so its Run is terminated; unless the Run's pull
   * request was merged (deliver: pr), whose `Closes #N` closed it: that Run completes
   * (`mergedThroughPullRequest`). A human changed its title or body: the Run is started over on
   * the new text (`restartForChangedIssue`). Returns false when some issue could not be read or
   * its Run not terminated (retried on the next poll); the Run stays as it is then.
   */
  private async followIssues(): Promise<boolean> {
    let ok = true;
    const unfinished = this.deps.store
      .listRuns()
      .filter((r) => r.issue && !FINISHED_RUN_STATUSES.includes(r.status));
    for (const run of unfinished) {
      if (this.stopping) break;
      const issue = run.issue;
      if (!issue) continue;
      try {
        const latest = await this.gh().getIssue(issue.repo, issue.number);
        if (latest.state === 'closed') {
          if (await this.mergedThroughPullRequest(run)) continue;
          await this.cancelForClosedIssue(run.id, issue, latest.stateReason);
        } else {
          await this.restartForChangedIssue(run, latest);
        }
      } catch (err) {
        ok = false;
        this.report(err);
      }
    }
    return ok;
  }

  /**
   * A human changed the title or body of the issue after its Run was created. The goal was read
   * once, when the Run was created, so the Run would do the old requirement through to the merge
   * while nobody is around. It is terminated instead, and a new Run does the changed one from the
   * start, as the same attempt: a change is no failure, so it uses up none of
   * `max_run_attempts`. The old Run's worktree and branch are removed, nobody needs them.
   *
   * Left alone, as before: Runs of issues by people the Master does not trust (their goal stays as
   * it was when the Run was created, and a human confirms it), Runs that merge or wait for the
   * approval to merge (too late to start over; the change does not go into them either), and
   * everything while the work switch is off (nothing new starts then; the first poll after it is
   * on does it).
   */
  private async restartForChangedIssue(stale: Run, latest: GhIssue): Promise<void> {
    const prev = stale.issue;
    if (!prev || prev.untrusted || !this.deps.store.working) return;
    const goal = goalFromIssue(latest);
    // The engine keeps the goal trimmed.
    if (goal.trim() === stale.goal) return;
    const store = this.deps.store;
    const repo = store.getRepo(stale.repoId);
    const cfg = this.cfg.master.github?.repos[repo.name];
    // The new Run could not be created: the old one goes on rather than leave the issue without.
    if (!cfg || this.cfg.errors[githubConfigKey(repo.name)] || !this.template(repo.name, cfg)) {
      return;
    }
    if (!isTrusted(latest, await this.masterLogin()) || this.stopping) return;
    // Read again right before terminating it: the Run may have moved on while GitHub answered.
    // Nothing is awaited between this check and the engine stopping it.
    const run = store.getRun(stale.id);
    if (FINISHED_RUN_STATUSES.includes(run.status) || this.merging(run)) return;
    try {
      await this.deps.engine.cancel(run.id);
    } catch (err) {
      // It finished meanwhile; it is caught up on the issue as usual.
      if (err instanceof InvalidStateError) return;
      throw err;
    }
    // Created before the old Run is marked caught up, so a crash in between leaves the issue
    // with an unfinished Run rather than none.
    const next = this.createIssueRun(repo, cfg, goal, {
      repo: prev.repo,
      number: prev.number,
      url: prev.url,
      auto: prev.auto,
      attempt: prev.attempt ?? 1,
      ...(prev.earlier ? { earlier: prev.earlier } : {}),
    });
    store.tx(() => {
      // Terminated on purpose: no ares1:failed, no comment saying it was terminated.
      const old = store.getRun(run.id);
      store.setIssueSynced(old.id, old.status);
      store.setIssueDiscussionSynced(old.id, old.discussion.length);
      store.event(old.id, 'run.goal_changed', {
        repo: prev.repo,
        issue: prev.number,
        newRun: next.id,
      });
    });
    // The label and the comment are each tried even when the other fails: a lost comment must not
    // leave the old Run's label on the issue (ares1:needs-you on an issue whose Run only waits in
    // the queue), and a lost label must not cost the comment. The first error is reported.
    const errors: unknown[] = [];
    const attempt = async (step: () => Promise<void>) => {
      try {
        await step();
      } catch (err) {
        errors.push(err);
      }
    };
    try {
      await attempt(async () => {
        // The Run may have moved on already; the next sync reports where it is.
        await this.gh().setLabels(
          prev.repo,
          prev.number,
          withStatusLabel(latest.labels, LABELS.running),
        );
        // Marked caught up only once the label is set: until then the next sync sets the label
        // the new Run's status wants. A crash in between only sets the same label again.
        store.setIssueSynced(next.id, 'queued');
      });
      await attempt(() =>
        this.comment(
          prev.repo,
          prev.number,
          goalChangedComment({
            oldRunId: run.id,
            runId: next.id,
            templateName: this.templateName(repo.name, cfg),
            dashboardUrl: this.dashboardUrl(),
          }),
        ),
      );
    } finally {
      // A removal that fails is recorded on the old Run by the engine.
      await this.deps.engine.removeGoalChangedWorkspace(run.id, next.id);
    }
    if (errors.length > 0) throw errors[0];
  }

  /** The Run merges, or waits for the approval to merge: too late to start it over. */
  private merging(run: Run): boolean {
    if (!run.currentStageRunId) return false;
    const sr = this.deps.store.getStageRun(run.currentStageRunId);
    return run.template.stages.find((s) => s.id === sr.stageId)?.kind === 'merge';
  }

  /**
   * The issue stays as the human left it: no label change, no comment, not closed again, so their
   * closing comment is still the last one (the scout reads it as the reason not to do it).
   */
  private async cancelForClosedIssue(
    runId: string,
    issue: RunIssue,
    stateReason: string | null,
  ): Promise<void> {
    try {
      await this.deps.engine.cancel(runId);
    } catch (err) {
      // It finished meanwhile; it is caught up on the issue as usual.
      if (err instanceof InvalidStateError) return;
      throw err;
    }
    const store = this.deps.store;
    store.tx(() => {
      const run = store.getRun(runId);
      store.setIssueSynced(runId, run.status);
      store.setIssueDiscussionSynced(runId, run.discussion.length);
      store.event(runId, 'run.issue_closed', {
        repo: issue.repo,
        issue: issue.number,
        stateReason,
      });
    });
  }

  /** Returns false when some issue could not be updated (retried on the next poll). */
  private async syncRuns(): Promise<boolean> {
    let ok = true;
    for (const run of this.deps.store.runsWithIssueBehind()) {
      if (this.stopping) break;
      try {
        await this.syncRun(run);
      } catch (err) {
        ok = false;
        this.report(err);
      }
    }
    return ok;
  }

  private async syncRun(run: Run): Promise<void> {
    const issue = run.issue;
    if (!issue) return;
    // The discussion first, so a conclusion is on the issue before it closes.
    await this.syncDiscussion(run, issue);
    if (run.issueSynced === run.status) return;
    const repo = this.deps.store.getRepo(run.repoId);
    const stageName = this.stageNameOf(run);
    // The issue closes once the code is on GitHub; a failed push is retried on the next poll.
    // While the target branch has diverged from GitHub's, the issue waits as it is, open, until
    // the two are merged (by the Master, or by a human when that failed) and the push goes through.
    // A Run merged through its pull request (deliver: pr) is on GitHub already.
    let pushed = false;
    const merged =
      run.status === 'completed' && run.pr
        ? mergedPullRequestOf(this.deps.store, run.id)
        : undefined;
    if (run.status === 'completed' && !merged) {
      const name = repo.name;
      const cfg = this.cfg.master.github?.repos[name];
      // With deliver: pr the target branch is never pushed: a Run merged locally (before the
      // repo was switched to it) is not on GitHub.
      if (cfg?.push && cfg.deliver !== 'pr') {
        if (!(await this.pushTarget(name))) return;
        pushed = true;
      }
    }
    const failure =
      run.status === 'failed' ? this.failureOutcome(run, repo, stageName ?? null) : undefined;
    const update = issueUpdate(run, {
      dashboardUrl: this.dashboardUrl(),
      targetBranch: repo.targetBranch,
      stageName,
      pushed,
      pr: merged,
      times: run.status === 'completed' ? storedRunTimes(this.deps.store, run) : undefined,
      failure,
    });
    const gh = this.gh();
    const current = await gh.getLabels(issue.repo, issue.number);
    const wanted = withStatusLabel(current, update.label);
    if (wanted.length !== current.length || wanted.some((l) => !current.includes(l))) {
      await gh.setLabels(issue.repo, issue.number, wanted);
    }
    if (update.comment) await this.comment(issue.repo, issue.number, update.comment);
    let close = update.close;
    // The pull request's `Closes #N` has most likely closed the issue already: not closed again.
    if (close && merged && (await gh.getIssue(issue.repo, issue.number)).state === 'closed') {
      close = null;
    }
    if (close) await gh.close(issue.repo, issue.number, close);
    const store = this.deps.store;
    store.tx(() => {
      store.setIssueSynced(run.id, run.status);
      if (failure?.kind === 'redo') {
        // The failed Run's page learns when the next attempt starts.
        store.event(run.id, 'issue.redo_scheduled', {
          repo: repo.name,
          issue: issue.number,
          attempt: failure.attempt + 1,
          maxAttempts: failure.max,
          redoAt: new Date(failure.redoAt).toISOString(),
        });
      }
      if (failure?.kind === 'exhausted') {
        store.event(run.id, 'issue.retries_exhausted', {
          repo: repo.name,
          issue: issue.number,
          attempts: failure.attempt,
          maxAttempts: failure.max,
          runIds: failure.failures.map((f) => f.runId),
        });
      }
    });
    if (failure?.kind === 'exhausted') await this.removeExhaustedAttempts(run, failure.failures);
  }

  /**
   * The issue is closed after its last attempt: only that Run keeps its worktree and branch.
   * After the issue is caught up, so a removal that goes wrong costs no second comment; each
   * failed removal is recorded on its Run by the engine.
   */
  private async removeExhaustedAttempts(run: Run, failures: FailedAttempt[]): Promise<void> {
    const earlier = failures.map((f) => f.runId).filter((id) => id !== run.id);
    if (earlier.length === 0) return;
    try {
      await this.deps.engine.removeExhaustedAttempts(run.id, earlier);
    } catch (err) {
      console.warn(
        t({
          zh: `没能删除 Run ${run.id} 之前几次失败尝试的工作目录：${errorMessage(err)}`,
          en: `Could not remove the working directories of the failed attempts before Run ${run.id}: ${errorMessage(err)}`,
        }),
      );
    }
  }

  /** Name of the stage the Run is in, or ended in. */
  private stageNameOf(run: Run): string | undefined {
    if (!run.currentStageRunId) return undefined;
    const sr = this.deps.store.getStageRun(run.currentStageRunId);
    return run.template.stages.find((s) => s.id === sr.stageId)?.name ?? sr.stageId;
  }

  /**
   * What follows a failed Run of an issue: redone while the issue has attempts left
   * (`max_run_attempts`), otherwise the issue is closed. Decided once and kept with the Run, so
   * catching the issue up again after a GitHub error says the same. undefined when the repo is no
   * longer configured for GitHub: the issue waits for a human then.
   */
  private failureOutcome(run: Run, repo: Repo, stage: string | null): FailureOutcome | undefined {
    const issue = run.issue;
    const cfg = this.cfg.master.github?.repos[repo.name];
    if (!issue || !cfg) return undefined;
    const attempt = issue.attempt ?? 1;
    let redo = issue.redo;
    if (!redo) {
      redo = attempt < cfg.max_run_attempts ? 'pending' : 'exhausted';
      this.deps.store.setIssueRedo(run.id, redo);
    }
    const max = Math.max(cfg.max_run_attempts, attempt);
    if (redo === 'exhausted') {
      const failures = [...(issue.earlier ?? []), failedAttempt(run, stage)];
      return { kind: 'exhausted', attempt, max, failures };
    }
    const redoAt = redoDueAt({ ...run, issue: { ...issue, redo } }, this.pollMinutes);
    return {
      kind: 'redo',
      attempt,
      max,
      budgetReached: this.overBudget(repo, cfg),
      redoAt: redoAt ?? Date.now(),
    };
  }

  /**
   * Redo the repo's failed Runs whose issue is still open: a new Run, the next attempt, told why
   * the earlier ones failed. Only once the failure is on the issue, so the comments come in
   * order, and once the wait after the failure is over (see redoDueAt), so a passing outage does
   * not use up the attempts. Over today's budget the redos wait for the next day. Neither wait
   * costs an attempt.
   */
  private async redoFailedRuns(name: string): Promise<void> {
    const { repo, cfg } = this.repoSetup(name);
    const store = this.deps.store;
    for (const failed of store.runsAwaitingRedo(repo.id)) {
      if (this.stopping) return;
      const prev = failed.issue;
      if (!prev || failed.issueSynced !== 'failed') continue;
      if (store.latestRunForIssue(prev.repo, prev.number)?.id !== failed.id) {
        // A human started the issue over with ares1:ready meanwhile.
        this.abandonRedo(name, failed, prev, 'restarted');
        continue;
      }
      // Still waiting; the other issues' redos go on. A sync is set for when it ends.
      if ((redoDueAt(failed, this.pollMinutes) ?? 0) > Date.now()) continue;
      if (this.overBudget(repo, cfg)) return;
      const gh = this.gh();
      const issue = await gh.getIssue(prev.repo, prev.number);
      if (issue.state === 'closed') {
        // Nobody wants it any more; the issue stays as the human left it.
        this.abandonRedo(name, failed, prev, 'closed');
        continue;
      }
      const attempt = (prev.attempt ?? 1) + 1;
      const max = Math.max(cfg.max_run_attempts, attempt);
      // The goal is read from the issue again: a human may have made it clearer meanwhile.
      const goal = goalFromIssue(issue);
      let untrusted: UntrustedAuthor | undefined;
      if (!isTrusted(issue, await this.masterLogin())) {
        // What a human confirmed for the failed Run goes on; a changed text is asked about again.
        const confirmed = prev.untrusted?.confirmedAt;
        untrusted = untrustedAuthor(
          issue,
          confirmed && goal.trim() === failed.goal ? confirmed : null,
        );
      }
      const next = this.createIssueRun(
        repo,
        cfg,
        goal,
        {
          repo: prev.repo,
          number: prev.number,
          url: issue.url,
          auto: prev.auto,
          attempt,
          earlier: [
            ...(prev.earlier ?? []),
            failedAttempt(failed, this.stageNameOf(failed) ?? null),
          ],
          ...(untrusted ? { untrusted } : {}),
        },
        untrusted && untrusted.confirmedAt === null ? untrustedGoalMessage(issue) : undefined,
      );
      store.tx(() => {
        store.setIssueRedo(failed.id, 'redone');
        store.event(next.id, 'issue.redone', {
          repo: name,
          issue: prev.number,
          attempt,
          maxAttempts: max,
          failedRunId: failed.id,
        });
      });
      await this.comment(
        prev.repo,
        prev.number,
        redoStartedComment({
          runId: next.id,
          attempt,
          max,
          templateName: this.templateName(name, cfg),
          dashboardUrl: this.dashboardUrl(),
        }),
      );
      // The Run may have moved on already; the next sync reports where it is.
      await gh.setLabels(prev.repo, prev.number, withStatusLabel(issue.labels, LABELS.running));
      store.setIssueSynced(next.id, 'queued');
    }
  }

  private abandonRedo(
    name: string,
    run: Run,
    issue: RunIssue,
    reason: 'closed' | 'restarted',
  ): void {
    const store = this.deps.store;
    store.tx(() => {
      store.setIssueRedo(run.id, 'abandoned');
      store.event(run.id, 'issue.redo_abandoned', { repo: name, issue: issue.number, reason });
    });
  }

  /** Post the discussion entries the issue does not have yet, one comment each, in order. */
  private async syncDiscussion(run: Run, issue: RunIssue): Promise<void> {
    if (run.issueDiscussionSynced >= run.discussion.length) return;
    const stageOf = new Map(
      this.deps.store.listStageRuns(run.id).map((sr) => [sr.id, sr.stageId] as const),
    );
    // How long the round's assess stage waits for a reply, as the engine reads it.
    const waitOf = (entry: DiscussionEntry): number | null => {
      if (entry.role !== 'assessor') return null;
      const def = run.template.stages.find((s) => s.id === stageOf.get(entry.stageRunId));
      return def ? replyTimeoutHours(def) : null;
    };
    const ctx = {
      dashboardUrl: this.dashboardUrl(),
      runId: run.id,
      pollMinutes: this.pollMinutes,
    };
    for (let i = run.issueDiscussionSynced; i < run.discussion.length; i++) {
      if (this.stopping) return;
      const entry = run.discussion[i];
      const body = entry
        ? discussionComment(entry, { ...ctx, replyTimeoutHours: waitOf(entry) })
        : null;
      if (body) await this.comment(issue.repo, issue.number, body);
      this.deps.store.setIssueDiscussionSynced(run.id, i + 1);
    }
  }

  /**
   * Replies on the issue to the assessment's questions: comments without the Master's marker
   * after its last comment, written by people it trusts (`isTrusted`); the others are only
   * counted on the questions. Only once the latest questions are on the issue, so earlier
   * comments are never taken for answers to them. The Run is assessed again with the replies.
   */
  private async collectReplies(name: string): Promise<void> {
    const { repo } = this.repoSetup(name);
    const waiting = this.deps.store
      .listRuns({ status: 'blocked', repoId: repo.id })
      .filter((r) => r.issue && r.blocked?.kind === 'discussion');
    for (const run of waiting) {
      if (this.stopping) return;
      const issue = run.issue;
      if (!issue || run.issueDiscussionSynced < run.discussion.length) continue;
      const master = await this.masterLogin();
      const comments = await this.gh().listComments(issue.repo, issue.number);
      const { replies, ignored } = repliesAfterMaster(comments, master);
      // Someone may have replied on the dashboard meanwhile; the next questions come first then.
      const now = this.deps.store.getRun(run.id);
      const still =
        now.blocked?.kind === 'discussion' && now.discussion.length === run.discussion.length;
      if (now.status !== 'blocked' || !still) continue;
      this.recordIgnored(now, issue, ignored);
      if (replies.length === 0) continue;
      const replied = this.deps.engine.reply(run.id, replies, 'issue');
      // The replies came from the issue: nothing to post for them.
      this.deps.store.setIssueDiscussionSynced(run.id, replied.discussion.length);
    }
  }

  /**
   * Count, on the questions the Run waits on, the comments after them that were not taken as
   * replies because the Master does not trust their authors, so the dashboard can show them.
   */
  private recordIgnored(run: Run, issue: RunIssue, ignored: number): void {
    const last = run.discussion.at(-1);
    if (last?.role !== 'assessor' || (last.ignoredComments ?? 0) === ignored) return;
    // Stored as JSON, where an undefined count is left out.
    const entry: DiscussionEntry = { ...last, ignoredComments: ignored > 0 ? ignored : undefined };
    const store = this.deps.store;
    store.tx(() => {
      store.updateRun(run.id, { discussion: [...run.discussion.slice(0, -1), entry] });
      store.event(run.id, 'discussion.comments_ignored', {
        repo: issue.repo,
        issue: issue.number,
        count: ignored,
      });
    });
  }

  // ---- guardrails --------------------------------------------------------

  /**
   * Spend of today on what this repo did without a human: scouts, auto-accepted Runs and
   * automatic redos of failed Runs.
   */
  spentToday(repoId: string): number {
    const since = startOfToday();
    const scouts = this.deps.store
      .listScouts({ repoId, since, limit: 1000 })
      .reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
    const runs = this.deps.store
      .issueRunsSince(since)
      .filter((r) => r.repoId === repoId && (r.issue?.auto || (r.issue?.attempt ?? 1) > 1))
      .reduce((sum, r) => sum + r.costUsd, 0);
    return scouts + runs;
  }

  autoAcceptedToday(repoName: string): number {
    return this.deps.store
      .listEventsOfType('issue.auto_accepted', startOfToday())
      .filter((e) => e.data.repo === repoName).length;
  }

  /** Today's spend reached the configured limit (none = never). */
  private overBudget(repo: Repo, cfg: GitHubRepoConfig): boolean {
    return cfg.daily_budget_usd !== undefined && this.spentToday(repo.id) >= cfg.daily_budget_usd;
  }

  /** Within today's auto-accept count and spend. */
  private mayAutoAccept(repo: Repo, cfg: GitHubRepoConfig): boolean {
    const max = cfg.auto_accept.max_per_day;
    if (max !== undefined && this.autoAcceptedToday(repo.name) >= max) return false;
    return !this.overBudget(repo, cfg);
  }

  /**
   * Scout by itself when there is nothing to do: the repo has no Run that goes on by itself and
   * no issue waiting to be redone (see splitUnfinishedRuns), the proposals that hold it back (see proposalsHoldingScout) and
   * the Runs stuck waiting for a human are fewer than max_proposals together, the day's budget is
   * not spent, the configured interval since the last scout has passed, it is not backing off
   * after scouts that found nothing or failed (see scoutBackoff: the wait doubles with each such
   * scout in a row, and ends once a scout files an issue or the target branch gets a new commit),
   * and it is not waiting for the quota of an agent that ran out of it (see scoutLimitWait).
   * Records why it waits, for the dashboard.
   */
  private async maybeAutoScout(name: string): Promise<void> {
    const { repo, cfg } = this.repoSetup(name);
    const waiting = await this.autoScoutWaiting(repo, cfg);
    this.scoutWaiting.set(name, waiting);
    if (waiting === null) await this.startScout(name, 'auto');
  }

  private async autoScoutWaiting(repo: Repo, cfg: GitHubRepoConfig): Promise<ScoutWait | null> {
    const scout = cfg.scout;
    if (!scout?.auto) {
      return {
        reason: t({ zh: '只在看板上手动触发', en: 'Only started from the dashboard' }),
      };
    }
    if (this.scouting.has(repo.id)) return { reason: t({ zh: '正在侦察', en: 'Scouting' }) };
    const store = this.deps.store;
    const runs = splitUnfinishedRuns(
      store.listRuns({ repoId: repo.id }),
      (id) => store.getStageRun(id).stageId,
    );
    const busy = busyText(runs.moving.length, runs.redo.length);
    if (busy) return { reason: busy };
    if (this.deps.engine.held) {
      return { reason: t({ zh: '等 Master 升级', en: 'Waiting for the Master to upgrade' }) };
    }
    if (this.overBudget(repo, cfg)) {
      return {
        reason: t({
          zh: '今天的自动花费已达上限',
          en: "Today's automatic spending reached its limit",
        }),
      };
    }
    // The set interval, the back-off and the wait for the agent's quota all hold it; it waits for
    // the latest of them.
    const scouts = store.listScouts({ repoId: repo.id, limit: 200 });
    let wait: ScoutWait | null = null;
    // A scout whose agent hit a limit did nothing, so it takes up no interval.
    const last = scouts.find((s) => s.status !== 'rate_limited');
    if (last && scout.interval_minutes > 0) {
      const next = Date.parse(last.startedAt) + scout.interval_minutes * 60_000;
      if (next > Date.now()) {
        wait = {
          reason: t({
            zh: '离上次侦察不到设定的间隔',
            en: 'Less than the set interval since the last scout',
          }),
          until: new Date(next).toISOString(),
        };
      }
    }
    wait = laterWait(wait, await this.scoutBackoffWait(repo, scouts));
    wait = laterWait(wait, this.scoutQuotaWait(scouts));
    if (wait) return wait;
    // Do not pile up work nobody has looked at: proposals and Runs stuck waiting for a human.
    const full = await this.issuesRepo(repo, cfg);
    const open = await this.gh().listIssues(full, {
      state: 'open',
      label: LABELS.proposal,
      limit: 100,
    });
    const pending = proposalsHoldingScout(open, scouts, cfg.auto_accept).length;
    const stuck = runs.stuck.length;
    if (pending + stuck >= scout.max_proposals) {
      return { reason: waitingForYouText(pending, stuck) };
    }
    return null;
  }

  /**
   * The wait for the quota after the scout's agent ran out of it or was rate-limited, if it holds
   * the scout now (see scoutLimitWait). `scouts`: the repo's, newest first.
   */
  private scoutQuotaWait(scouts: Scout[]): (ScoutWait & { until: string }) | null {
    const limited = limitedScout(scouts);
    if (!limited) return null;
    const limit = scoutLimitWait(scouts, this.scoutResetAt(limited));
    if (!limit || Date.parse(limit.until) <= Date.now()) return null;
    return {
      reason: t({
        zh: '侦察遇到额度用尽或限流，等额度恢复',
        en: 'The scout ran out of quota or was rate-limited; waiting for the quota to come back',
      }),
      until: limit.until,
    };
  }

  /**
   * When the quota of the rate-limited scout's agent comes back (epoch ms), if the CLI said: from
   * the scout's `scout.rate_limited` event, so that the wait holds across Master restarts.
   */
  private scoutResetAt(scout: Scout): number | undefined {
    const event = this.deps.store
      .listEventsOfType('scout.rate_limited', scout.startedAt)
      .find((e) => e.data.scoutId === scout.id);
    const retryAt = event?.data.retryAt;
    const resetAt = typeof retryAt === 'string' ? Date.parse(retryAt) : Number.NaN;
    return Number.isNaN(resetAt) ? undefined : resetAt;
  }

  /**
   * The back-off after scouts that found nothing or failed, if it holds the scout now.
   * `scouts`: the repo's, newest first.
   */
  private async scoutBackoffWait(
    repo: Repo,
    scouts: Scout[],
  ): Promise<(ScoutWait & { until: string }) | null> {
    const pollMinutes = this.pollMinutes;
    let backoff = scoutBackoff(scouts, pollMinutes);
    if (!backoff || Date.parse(backoff.until) <= Date.now()) return null;
    // Scouts that ran before the target branch's latest commit do not count: they did not see it.
    // When git cannot tell, the back-off stays as counted.
    const changedAt = await commitTime(repo.path, repo.targetBranch).catch(() => undefined);
    if (changedAt !== undefined) backoff = scoutBackoff(scouts, pollMinutes, changedAt);
    if (!backoff || Date.parse(backoff.until) <= Date.now()) return null;
    const k = backoff.count;
    return {
      reason: t({
        zh: `最近 ${k} 次侦察没有找到需求或失败，退避中`,
        en:
          k === 1
            ? 'The last scout found nothing or failed; backing off'
            : `The last ${k} scouts found nothing or failed; backing off`,
      }),
      until: backoff.until,
    };
  }

  // ---- scouting ------------------------------------------------------------

  /** Some repo is being scouted (an upgrade waits for it). */
  get scoutRunning(): boolean {
    return this.scouting.size > 0;
  }

  /** Start a scout; it runs in the background. */
  async startScout(name: string, trigger: Scout['trigger']): Promise<Scout> {
    const { repo, cfg } = this.repoSetup(name);
    const scoutCfg = cfg.scout;
    if (!scoutCfg) {
      throw new InvalidStateError(
        t({
          zh: `仓库 ${name} 没有配置侦察（github.repos.${name}.scout）`,
          en: `Repo ${name} has no scout configured (github.repos.${name}.scout)`,
        }),
      );
    }
    if (this.scouting.has(repo.id)) {
      throw new InvalidStateError(
        t({ zh: `仓库 ${name} 正在侦察`, en: `Repo ${name} is being scouted already` }),
      );
    }
    const agent = this.cfg.agents.get(scoutCfg.agent);
    if (!agent) {
      throw new InvalidStateError(
        t({
          zh: `侦察用的 Agent ${scoutCfg.agent} 不存在或未启用`,
          en: `The scout's agent ${scoutCfg.agent} does not exist or is disabled`,
        }),
      );
    }
    const adapter = this.deps.adapters.get(agent.cli);
    if (!adapter?.supportsReadOnly) {
      const readOnly = joinList(readOnlyClis(this.deps.adapters.values()));
      throw new InvalidStateError(
        readOnly
          ? t({
              zh: `侦察要以只读方式运行，${agent.cli} 不支持，请换用 ${readOnly} 的 Agent`,
              en: `The scout runs read-only, which ${agent.cli} does not support; use an agent of ${readOnly}`,
            })
          : t({
              zh: `侦察要以只读方式运行，${agent.cli} 不支持，请换用支持只读的 CLI 的 Agent`,
              en: `The scout runs read-only, which ${agent.cli} does not support; use an agent of a CLI that supports read-only`,
            }),
      );
    }
    this.scouting.set(repo.id, { scoutId: '' });
    try {
      const full = await this.issuesRepo(repo, cfg);
      await this.ensureLabels(full);
      const scout = this.deps.store.tx(() => {
        const s = this.deps.store.createScout({
          repoId: repo.id,
          issuesRepo: full,
          trigger,
          agentId: agent.id,
          model: agent.model,
          logPath: '',
        });
        const logPath = join(this.deps.paths.logsDir, 'scouts', `${s.id}.jsonl`);
        this.deps.store.event(null, 'scout.started', { scoutId: s.id, repo: name, trigger });
        return this.deps.store.updateScout(s.id, { logPath });
      });
      const entry: ScoutEntry = { scoutId: scout.id };
      this.scouting.set(repo.id, entry);
      entry.done = this.runScout(scout, repo, cfg, adapter, entry).finally(() => {
        this.scouting.delete(repo.id);
      });
      return scout;
    } catch (err) {
      this.scouting.delete(repo.id);
      throw err;
    }
  }

  /**
   * The Master's last failed upgrade if `repo` is the Master's own source, so that its scout
   * proposes fixing what the stable copy cannot build or start; null for every other repo.
   */
  private upgradeFailureFor(repo: Repo, github: string): UpgradeFailure | null {
    const failure = lastUpgradeFailure(this.deps.store);
    if (!failure) return null;
    const origin = this.deps.masterOrigin ?? null;
    return isMasterSource(origin, { path: repo.path, github }) ? failure : null;
  }

  private async runScout(
    scout: Scout,
    repo: Repo,
    cfg: GitHubRepoConfig,
    adapter: AgentAdapter,
    entry: ScoutEntry,
  ): Promise<void> {
    const store = this.deps.store;
    const scoutCfg = cfg.scout;
    const agent = scoutCfg ? this.cfg.agents.get(scoutCfg.agent) : undefined;
    let cost: number | null = null;
    let workdir: string | undefined;
    try {
      if (!scoutCfg || !agent) {
        throw new Error(
          t({
            zh: '侦察配置在启动后被移除了',
            en: 'The scout configuration was removed after the scout started',
          }),
        );
      }
      const gh = this.gh();
      // Rejections stay counterexamples however long ago they were made. Only extra ones: the
      // latest closed issues hold the recent rejections already, so when the search fails (it
      // has rate limits and an index of its own) the scout goes on without them, not fails.
      // Sent along with the two lists but settled into a value, so that its failure is reported
      // only once both lists came back: when they fail too the scout fails, the note that it goes
      // on with the recently closed issues would be false, and as a github.error it would notify
      // people at once, past the rule that only scouts failing several times in a row do.
      const searched = gh.listNotPlannedIssues(scout.issuesRepo, { limit: SCOUT_NOT_PLANNED }).then(
        (issues) => ({ ok: true as const, issues }),
        (err: unknown) => ({ ok: false as const, err }),
      );
      const [open, closed] = await Promise.all([
        gh.listIssues(scout.issuesRepo, { state: 'open', limit: 100 }),
        gh.listIssues(scout.issuesRepo, {
          state: 'closed',
          limit: SCOUT_RECENT_CLOSED,
          comments: true,
        }),
      ]);
      const search = await searched;
      const notPlanned = search.ok ? search.issues : null;
      if (!search.ok) {
        this.report(
          new Error(
            t({
              zh: `侦察 ${repo.name} 时搜索被关闭为不做的 issue 失败，这次只用最近关闭的 issue：${errorMessage(search.err)}`,
              en: `Searching the issues closed as not planned for the scout of ${repo.name} failed; this scout uses only the recently closed issues: ${errorMessage(search.err)}`,
            }),
          ),
        );
      }
      // A repo whose template is gone gets no Runs anyway; such a scout is told nothing splits.
      const template = this.template(repo.name, cfg);
      const prompt = scoutPrompt({
        repoName: repo.name,
        max: scoutCfg.max_proposals,
        runs: runDigest(store, repo.id),
        issues: issueDigest(open, closed, await this.masterLogin(), notPlanned),
        splits: template ? templateSplits(template) : false,
        autoAcceptsL: autoAcceptsL(cfg.auto_accept),
        upgrade: this.upgradeFailureFor(repo, scout.issuesRepo),
      });
      // Read the target branch as committed, like a Run does, not whatever the main worktree has
      // checked out or left uncommitted. A detached worktree creates no branch.
      workdir = this.scoutDir(scout.id);
      try {
        const base = await revParse(repo.path, repo.targetBranch);
        await addDetachedWorktree(repo.path, workdir, base);
      } catch (err) {
        throw new Error(
          t({
            zh: `在目标分支 ${repo.targetBranch} 上建侦察的临时工作目录失败：${errorMessage(err)}`,
            en: `Creating the scout's temporary workspace on the target branch ${repo.targetBranch} failed: ${errorMessage(err)}`,
          }),
        );
      }
      if (this.stopping) throw new Interrupted();
      const exec = adapter.start({
        workdir,
        prompt,
        model: agent.model,
        effort: agent.effort,
        permission: 'safe',
        readOnly: true,
        outputSchema: scoutReportJsonSchema(),
        timeoutMs: (agent.timeout_minutes ?? this.cfg.master.defaults.timeout_minutes) * 60_000,
        extraArgs: agent.args,
        // Read-only, but it still must not get to what untrusted people wrote on GitHub.
        env: prepareAgentEnv(this.deps.paths.agentGhConfigDir),
        logPath: scout.logPath,
      });
      entry.exec = exec;
      const result = await exec.result;
      cost = result.costUsd ?? estimateCost(agent, result.usage) ?? null;
      store.updateScout(scout.id, { costUsd: cost });
      if (this.stopping) throw new Interrupted();
      if (result.status !== 'completed' && result.errorKind === 'rate_limited') {
        this.scoutRateLimited(scout, repo, result, cost);
        return;
      }
      if (result.status !== 'completed') {
        throw new Error(
          result.error ??
            t({
              zh: `侦察没有正常结束（${result.status}）`,
              en: `The scout did not end normally (${result.status})`,
            }),
        );
      }
      const report = parseScoutReport(result.structured, result.finalMessage);
      const proposals = report.proposals.slice(0, scoutCfg.max_proposals);
      // Kept before the issues are filed, so that a scout cut short there still shows them.
      store.updateScout(scout.id, { gaps: report.gaps });
      const created = await this.fileProposals(scout, repo, cfg, proposals);
      store.tx(() => {
        store.updateScout(scout.id, { status: 'completed', proposals, endedAt: nowIso() });
        store.event(null, 'scout.completed', {
          scoutId: scout.id,
          repo: repo.name,
          created: created.filter((p) => p.issue).length,
          auto: created.filter((p) => p.issue?.auto).length,
          /** Issues that wait for a human. */
          pending: created.filter((p) => p.issue && !p.issue.auto).length,
        });
      });
      if (created.some((p) => p.issue?.auto)) void this.poll();
    } catch (err) {
      const interrupted = err instanceof Interrupted || this.stopping;
      store.tx(() => {
        store.updateScout(scout.id, {
          status: interrupted ? 'interrupted' : 'failed',
          error: interrupted ? stoppedWhileScouting() : errorMessage(err),
          costUsd: cost,
          endedAt: nowIso(),
        });
        store.event(null, 'scout.failed', {
          scoutId: scout.id,
          repo: repo.name,
          message: errorMessage(err),
          // The failures in a row so far, this one included, so that a scout that keeps failing
          // is notified (see noticeFor). A scout the Master cut short did not fail: no streak,
          // or it would repeat the count of the failures before it.
          ...(interrupted
            ? {}
            : {
                streak: scoutFailureStreak(store.listScouts({ repoId: repo.id, limit: 200 })),
              }),
        });
      });
    } finally {
      if (workdir) await dropWorktree(repo.path, workdir);
    }
  }

  /**
   * The scout's agent ran out of quota or was rate-limited. That passes on its own and says
   * nothing about the repo, so the scout has not failed and does not count toward the back-off;
   * the automatic scout waits for the quota instead (see scoutLimitWait). The CLI's reset time is
   * in the `scout.rate_limited` event, which the wait reads it from (`scoutResetAt`).
   */
  private scoutRateLimited(
    scout: Scout,
    repo: Repo,
    result: AgentResult,
    cost: number | null,
  ): void {
    const parsed = result.retryAt ? Date.parse(result.retryAt) : Number.NaN;
    const resetAt = Number.isNaN(parsed) ? undefined : parsed;
    const store = this.deps.store;
    store.tx(() => {
      store.updateScout(scout.id, {
        status: 'rate_limited',
        error: scoutLimitedText(resetAt, result.error),
        costUsd: cost,
        endedAt: nowIso(),
      });
      store.event(null, 'scout.rate_limited', {
        scoutId: scout.id,
        repo: repo.name,
        // When the quota is expected back, if the CLI said.
        ...(resetAt === undefined ? {} : { retryAt: new Date(resetAt).toISOString() }),
      });
    });
  }

  /** Create an issue per proposal; low-risk ones are auto-accepted within today's limits. */
  private async fileProposals(
    scout: Scout,
    repo: Repo,
    cfg: GitHubRepoConfig,
    proposals: ScoutProposal[],
  ): Promise<ScoutProposal[]> {
    for (const p of proposals) {
      const auto = isAutoAcceptable(p, cfg.auto_accept) && this.mayAutoAccept(repo, cfg);
      const labels: string[] = [LABELS.proposal];
      if (auto) labels.push(LABELS.ready, LABELS.auto);
      try {
        // The scout wrote them in a worktree under the user's home directory.
        const issue = await this.gh().createIssue(scout.issuesRepo, {
          title: redactForGitHub(p.title),
          body: redactForGitHub(proposalBody(p, scout.id, auto)),
          labels,
        });
        p.issue = { ...issue, auto };
        if (auto) {
          this.deps.store.event(null, 'issue.auto_accepted', {
            repo: repo.name,
            issue: issue.number,
          });
        }
      } catch (err) {
        p.error = errorMessage(err);
        this.report(err);
      }
      // Keep what was created so far even if the Master stops halfway.
      this.deps.store.updateScout(scout.id, { proposals });
    }
    return proposals;
  }

  // ---- status ----------------------------------------------------------------------

  status(): GitHubStatus {
    const github = this.cfg.master.github;
    const repos: GitHubRepoStatus[] = Object.entries(github?.repos ?? {}).map(([name, cfg]) => {
      const repo = this.deps.store.findRepo(name);
      const problems = [...(this.cfg.errors[githubConfigKey(name)] ?? [])];
      if (!repo) problems.push(notRegistered(name));
      const last = repo ? this.deps.store.listScouts({ repoId: repo.id, limit: 1 })[0] : undefined;
      const spent = repo ? this.spentToday(repo.id) : 0;
      const running = repo ? this.scouting.has(repo.id) : false;
      return {
        name,
        issuesRepo: cfg.issues_repo ?? (repo ? (this.resolved.get(repo.path) ?? null) : null),
        template: cfg.template,
        problems,
        scout: cfg.scout
          ? {
              agent: cfg.scout.agent,
              auto: cfg.scout.auto,
              intervalMinutes: cfg.scout.interval_minutes,
              maxProposals: cfg.scout.max_proposals,
              running,
              lastAt: last?.startedAt ?? null,
              waiting: running ? null : (this.scoutWaiting.get(name) ?? null),
            }
          : null,
        autoAccept: {
          maxRisk: cfg.auto_accept.max_risk,
          maxSize: cfg.auto_accept.max_size,
          maxPerDay: cfg.auto_accept.max_per_day ?? null,
          usedToday: this.autoAcceptedToday(name),
        },
        autoMerge: cfg.auto_merge,
        budget: {
          dailyUsd: cfg.daily_budget_usd ?? null,
          spentToday: spent,
          reached: cfg.daily_budget_usd !== undefined && spent >= cfg.daily_budget_usd,
        },
        push: cfg.push,
        deliver: cfg.deliver,
        maxRunAttempts: cfg.max_run_attempts,
      };
    });
    return {
      enabled: github !== undefined,
      account: github?.account ?? null,
      pollMinutes: github?.poll_minutes ?? 5,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      repos,
    };
  }
}

class Interrupted extends Error {}
