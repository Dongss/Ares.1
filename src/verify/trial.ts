// Trial runs of a repo's setup and verify commands from the dashboard (POST /api/repos/:id/trial):
// run the way a Run's checks run them, on the commit the target branch is at, so that a human
// registering a repo finds out whether its checks work before any Run spends money on them. No
// Run is created and nothing is saved; only the latest trial of each repo is kept, in memory.

import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareAgentEnv } from '../adapters/process.js';
import type {
  LiveNotice,
  RepoTrial,
  RepoTrialInput,
  RepoTrialResult,
  RepoTrialStatus,
} from '../api/types.js';
import { leftoverTrialWorktrees, trialWorktreeName, trialWorktreeRepo } from '../config/flow.js';
import type { HomePaths, LoadedConfig } from '../config/load.js';
import { t } from '../i18n.js';
import { ConflictError, type Store } from '../store/store.js';
import type { Repo } from '../store/types.js';
import { errorMessage, nowIso } from '../util.js';
import { addDetachedWorktree, dropWorktree, pruneWorktrees, revParse } from '../workspace/git.js';
import {
  type CommandResult,
  environmentProblem,
  firstMissingCommand,
  runCommands,
} from './commands.js';

export interface RepoTrialsDeps {
  store: Store;
  paths: HomePaths;
  config: () => LoadedConfig;
}

type Kind = RepoTrialResult['kind'];

/**
 * The trials of the registered repos' commands. One repo tries one set of commands at a time;
 * different repos try at once.
 */
export class RepoTrials {
  /** A trial started, ran a command or ended: for the dashboard, over GET /api/stream. */
  readonly live = new EventEmitter<{ notice: [LiveNotice] }>();
  /** The latest trial of each repo, by repo id; changed in place while it runs. */
  private readonly latest = new Map<string, RepoTrial>();
  /** The trials under way, by repo id; each is over once its worktree is deleted. */
  private readonly running = new Map<string, Promise<void>>();
  /** Aborted when the Master stops: the commands running are killed. */
  private readonly stopped = new AbortController();
  /** The `sweepLeftovers` in progress; a second call joins it, `stop` waits for it. */
  private sweeping: Promise<void> | undefined;

  constructor(private readonly deps: RepoTrialsDeps) {}

  /**
   * Starts trying `repo`'s commands in the background: `input`'s instead of the registered ones,
   * each group it leaves out the registered one; nothing is saved. Returns the trial as it starts.
   * Throws ConflictError while the repo is trying already, or the Master is stopping.
   *
   * In order: the commit the target branch is at is read; when the program some command starts
   * first is not found in the commands' environment (`firstMissingCommand`), no command runs and
   * that command's result names it. Otherwise, with commands to run, a worktree of that commit
   * with a detached HEAD is made under worktrees/ (`trialWorktreeName`), the setup commands run
   * in it and then, when they all passed, the verify commands, each stopping at the first
   * failure. They run as a Run's do: with the environment agents get (`prepareAgentEnv`: no
   * GitHub or GitLab credentials), `defaults.command_timeout_minutes` each, their output in
   * `trial-<repo>.log` under the logs directory (overwritten each time), killed when the Master
   * stops. The worktree is deleted whatever comes of it, before the trial counts as over.
   */
  start(repo: Repo, input: RepoTrialInput = {}): RepoTrial {
    if (this.stopped.signal.aborted) {
      throw new ConflictError(
        t({
          zh: 'Master 正在停止，不能试运行',
          en: 'The Master is stopping; nothing can be tried',
        }),
      );
    }
    if (this.running.has(repo.id)) {
      throw new ConflictError(
        t({
          zh: `仓库 ${repo.name} 正在试运行，等这次跑完再试`,
          en: `Repo ${repo.name} is being tried now; try again once this trial is over`,
        }),
      );
    }
    const trial: RepoTrial = {
      repoId: repo.id,
      status: 'running',
      branch: repo.targetBranch,
      sha: null,
      startedAt: nowIso(),
      endedAt: null,
      setupCommands: [...(input.setupCommands ?? repo.setupCommands)],
      verifyCommands: [...(input.verifyCommands ?? repo.verifyCommands)],
      results: [],
      error: null,
      log: null,
    };
    this.latest.set(repo.id, trial);
    // Started after it is on record as running, so that its end always finds it there.
    this.running.set(
      repo.id,
      Promise.resolve().then(() => this.execute(repo, trial)),
    );
    this.notify(trial);
    return structuredClone(trial);
  }

  /** The latest trial of the repo with id `repoId`; undefined when it has not been tried. */
  get(repoId: string): RepoTrial | undefined {
    const trial = this.latest.get(repoId);
    return trial && structuredClone(trial);
  }

  /** Ids of the repos trying their commands now. */
  trying(): Set<string> {
    return new Set(this.running.keys());
  }

  /**
   * Forgets the latest trial of the repo with id `repoId`, when the repo is removed. A trial
   * under way runs to its end and deletes its worktree, but is not kept.
   */
  forget(repoId: string): void {
    this.latest.delete(repoId);
  }

  /**
   * Deletes the trial worktrees a previous Master left under worktrees/, having stopped before it
   * got to (`leftoverTrialWorktrees`), and has git forget them. Called with the other leftover
   * worktrees: at start and then daily. The worktrees of trials under way stay. A call while one
   * is in progress joins it. A directory that cannot be removed does not stop the others: once
   * each has been tried, the call rejects naming those left, which the next sweep tries again.
   */
  sweepLeftovers(): Promise<void> {
    this.sweeping ??= this.sweepNow().finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }

  /**
   * Kills the commands running, and waits until every trial and sweep is over. Never rejects, so
   * that the Master goes on stopping: a sweep leaving directories behind is reported to whoever
   * started it, and the next Master's sweep tries them again.
   */
  async stop(): Promise<void> {
    this.stopped.abort();
    await Promise.allSettled([...this.running.values(), this.sweeping]);
  }

  private async execute(repo: Repo, trial: RepoTrial): Promise<void> {
    const { paths } = this.deps;
    const signal = this.stopped.signal;
    let dir: string | undefined;
    try {
      try {
        trial.sha = await revParse(repo.path, repo.targetBranch);
      } catch (err) {
        trial.error = t({
          zh: `读不到目标分支 ${repo.targetBranch} 所在的提交：${errorMessage(err)}`,
          en: `Could not read the commit the target branch ${repo.targetBranch} is at: ${errorMessage(err)}`,
        });
        return;
      }
      const env = prepareAgentEnv(paths.agentGhConfigDir);
      const missing = firstMissing(trial, env);
      if (missing) {
        trial.results.push({
          kind: missing.kind,
          command: missing.command,
          ok: false,
          exitCode: null,
          timedOut: false,
          durationMs: 0,
          outputTail: '',
          missingProgram: missing.missing,
        });
        return;
      }
      if (trial.setupCommands.length === 0 && trial.verifyCommands.length === 0) return;
      dir = join(paths.worktreesDir, trialWorktreeName(repo.id, randomBytes(4).toString('hex')));
      try {
        await addDetachedWorktree(repo.path, dir, trial.sha);
      } catch (err) {
        trial.error = t({
          zh: `建不了试运行的工作目录 ${dir}：${errorMessage(err)}`,
          en: `Could not make the trial's working directory ${dir}: ${errorMessage(err)}`,
        });
        return;
      }
      const log = join(paths.logsDir, `trial-${repo.name}.log`);
      mkdirSync(paths.logsDir, { recursive: true });
      writeFileSync(log, `# ${repo.targetBranch} ${trial.sha}\n`);
      trial.log = log;
      const opts = {
        timeoutMs: this.deps.config().master.defaults.command_timeout_minutes * 60_000,
        logPath: log,
        env,
        signal,
      };
      const record = (kind: Kind) => (result: CommandResult) => {
        trial.results.push(trialResult(kind, result, env));
        this.notify(trial);
      };
      const setup = await runCommands(trial.setupCommands, dir, opts, record('setup'));
      if (setup.every((r) => r.passed) && !signal.aborted) {
        await runCommands(trial.verifyCommands, dir, opts, record('verify'));
      }
      if (signal.aborted) {
        trial.error = t({
          zh: 'Master 停止了，试运行没有跑完',
          en: 'The Master stopped before the trial was over',
        });
      }
    } catch (err) {
      trial.error = errorMessage(err);
    } finally {
      // Never rejects; were it to, the sweep would delete the worktree later.
      if (dir) await dropWorktree(repo.path, dir).catch(() => {});
      trial.status = outcome(trial);
      trial.endedAt = nowIso();
      this.running.delete(repo.id);
      this.notify(trial);
    }
  }

  private async sweepNow(): Promise<void> {
    const { worktreesDir } = this.deps.paths;
    let names: string[];
    try {
      names = readdirSync(worktreesDir);
    } catch {
      return; // no worktree made yet
    }
    // Each directory on its own: one that fails is tried again next time, and the others go now.
    const failed: string[] = [];
    let unknown = false;
    for (const name of leftoverTrialWorktrees(names, this.trying())) {
      if (this.stopped.signal.aborted) return;
      const dir = join(worktreesDir, name);
      try {
        const repoId = trialWorktreeRepo(name);
        const repo = repoId === null ? undefined : this.deps.store.findRepo(repoId);
        if (repo) {
          await dropWorktree(repo.path, dir);
          continue;
        }
        rmSync(dir, { recursive: true, force: true });
        unknown = true;
      } catch (err) {
        failed.push(`${dir}: ${errorMessage(err)}`);
      }
    }
    // Of a repo removed since, or not told by the name: any registered repo may still list it.
    if (unknown) {
      for (const repo of this.deps.store.listRepos()) await pruneWorktrees(repo.path);
    }
    if (failed.length > 0) {
      throw new Error(
        t({
          zh: `${failed.length} 个目录没删掉，下次再试：\n${failed.join('\n')}`,
          en: `${failed.length === 1 ? '1 directory was' : `${failed.length} directories were`} not removed and will be tried again next time:\n${failed.join('\n')}`,
        }),
      );
    }
  }

  private notify(trial: RepoTrial): void {
    this.live.emit('notice', { type: 'repo.trial', repoId: trial.repoId, status: trial.status });
  }
}

/** The first command of the trial that could not find its program, setup commands first. */
function firstMissing(
  trial: RepoTrial,
  env: NodeJS.ProcessEnv,
): { kind: Kind; command: string; missing: string } | null {
  const setup = firstMissingCommand(trial.setupCommands, env);
  if (setup) return { kind: 'setup', ...setup };
  const verify = firstMissingCommand(trial.verifyCommands, env);
  return verify ? { kind: 'verify', ...verify } : null;
}

function trialResult(kind: Kind, result: CommandResult, env: NodeJS.ProcessEnv): RepoTrialResult {
  return {
    kind,
    command: result.command,
    ok: result.passed,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    outputTail: result.outputTail,
    missingProgram: environmentProblem(result, env),
  };
}

/** Passed when nothing went wrong and every command run passed: none to run passes too. */
function outcome(trial: RepoTrial): RepoTrialStatus {
  return trial.error === null && trial.results.every((r) => r.ok) ? 'passed' : 'failed';
}
