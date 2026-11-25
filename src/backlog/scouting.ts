// The AI scout of a repo, whatever source its requirements come from: starting and running the
// scout's agent read-only, recording how it went, and when the automatic scout waits. Without an
// iteration under way the scout plans one; with one, it follows it (see keptReport). Where the
// proposals and iterations go, and what the prompt says of the requirements there are already,
// is up to the source (`ProposalSource`): GitHub issues (IssueBridge) or the local backlog.

import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { prepareAgentEnv } from '../adapters/process.js';
import {
  type AgentAdapter,
  type AgentExecution,
  type AgentResult,
  readOnlyClis,
} from '../adapters/types.js';
import type { ProposalSourceStatus } from '../api/types.js';
import {
  autoAcceptsL,
  ITERATION_OPEN_STATUSES,
  limitedScout,
  scoutBackoff,
  scoutFailureStreak,
  scoutLimitWait,
  splitUnfinishedRuns,
  templateSplits,
} from '../config/flow.js';
import { findTemplate, type HomePaths, type LoadedConfig } from '../config/load.js';
import type { ProposalSourceConfig } from '../config/schema.js';
import { type Engine, estimateCost, InvalidStateError } from '../engine/engine.js';
import {
  type IterationUpdate,
  iterationDigest,
  keptReport,
  type PlannedIteration,
  type ProposalRun,
  parseScoutReport,
  runDigest,
  type ScoutSource,
  scoutPrompt,
  scoutReportJsonSchema,
} from '../github/scout.js';
import { join as joinList, t } from '../i18n.js';
import { NotFoundError, type Store } from '../store/store.js';
import type { Iteration, Repo, Scout, ScoutProposal } from '../store/types.js';
import { isMasterSource, type MasterOrigin } from '../upgrade/source.js';
import { lastUpgradeFailure, type UpgradeFailure } from '../upgrade/upgrader.js';
import { errorMessage, nowIso } from '../util.js';
import {
  addDetachedWorktree,
  commitTime,
  dropWorktree,
  pruneWorktrees,
  revParse,
} from '../workspace/git.js';
import { autoAcceptedToday, overBudget, spentToday } from './guard.js';

/** Error of a scout cut short by the Master stopping. */
export const stoppedWhileScouting = () =>
  t({ zh: 'Master 在侦察过程中停止了', en: 'The Master stopped during the scout' });

/** Why a repo of config.yaml gets no requirements worked on: it is not on the dashboard. */
export const notRegistered = (name: string) =>
  t({
    zh: `仓库 ${name} 没有在看板上登记`,
    en: `Repo ${name} is not registered on the dashboard`,
  });

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
export function scoutLimitedText(
  resetAt: number | undefined,
  cliError: string | undefined,
): string {
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

/** Why an automatic scout does not start now; `until`: it may start after that time. */
export interface ScoutWait {
  reason: string;
  until?: string;
}

/** Of two waits, the one that ends later. */
export function laterWait(a: ScoutWait | null, b: (ScoutWait & { until: string }) | null) {
  if (!b) return a;
  return a?.until && Date.parse(a.until) >= Date.parse(b.until) ? a : b;
}

/**
 * Why the automatic scout waits for a human: 「有 2 条提案、1 个卡住的 Run 等你处理」. A part
 * that is 0 is left out.
 */
export function waitingForYouText(proposals: number, stuck: number): string {
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
export function busyText(moving: number, redo: number): string | null {
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

/** What a source tells the scout's prompt of the requirements the repo has already. */
export interface KnownRequirements {
  /**
   * The requirements there are, so the scout does not propose them again, and the rejected
   * ones with their reasons as counterexamples (`issueDigest`, `localProposalDigest`).
   */
  issues: string;
  /**
   * "owner/name" of the repo on GitHub, which tells whether the repo is the Master's own source
   * (`isMasterSource`); null when it has none.
   */
  github: string | null;
}

/** What came of filing a scout's proposals. */
export interface FiledProposals {
  /** Proposals written out. */
  created: number;
  /** Of them, accepted without a human. */
  auto: number;
  /**
   * Of them, waiting for a human; an iteration the scout planned that waits for a human counts
   * as one more, accepted or turned down as a whole.
   */
  pending: number;
  /** The iteration the scout planned, once written out: `auto` when accepted without a human. */
  iteration?: FiledIteration;
}

/** An iteration a scout planned, written out by its source. */
export interface FiledIteration {
  /** `Iteration.id`. */
  id: string;
  /** Accepted without a human, within the repo's auto_accept as a whole (`iterationKind`). */
  auto: boolean;
}

/**
 * Where a repo's requirements come from, as the scout sees it: GitHub issues or the local
 * backlog. `C` is the repo's settings there.
 */
export interface ProposalSource<C extends ProposalSourceConfig> {
  /** Which source it is, for what the scout's prompt says of proposals and requirements. */
  readonly kind: ScoutSource;
  /** Where the repo's settings are in config.yaml, for messages: `github.repos.<name>`. */
  configPath(name: string): string;
  /**
   * Minutes between the source's polls: the back-off after scouts that found nothing or failed
   * counts in them.
   */
  pollMinutes(): number;
  /**
   * Make the repo ready for a scout, before its record is created; returns the record's
   * `issuesRepo` ('' where the repo has none).
   */
  prepareScout(repo: Repo, cfg: C): Promise<string>;
  /** The requirements the repo has already, for the scout's prompt. */
  known(scout: Scout, repo: Repo, cfg: C): Promise<KnownRequirements>;
  /**
   * Write the scout's proposals out, accepting those the settings allow without a human, and
   * mark each one with where it went (`issue` or `local`) or why it could not (`error`). The
   * scout keeps them as they are once this returns.
   */
  file(scout: Scout, repo: Repo, cfg: C, proposals: ScoutProposal[]): Promise<FiledProposals>;
  /**
   * Write out the iteration the scout planned while the repo had none under way, with its steps,
   * accepting it as a whole if the settings allow; null when nothing was written out. A source
   * without it leaves planned iterations aside.
   */
  fileIteration?(
    scout: Scout,
    repo: Repo,
    cfg: C,
    iteration: PlannedIteration,
  ): Promise<FiledIteration | null>;
  /**
   * Change the plan of the repo's iteration under way (`iteration`, as it is once the scout
   * ended) as the scout says, the change checked against the plan the scout was shown
   * (`updateProblems`). Called only while it is still under way. A source without it leaves the
   * changes aside.
   */
  adjustIteration?(
    scout: Scout,
    repo: Repo,
    cfg: C,
    iteration: Iteration,
    update: IterationUpdate,
  ): Promise<void>;
  /** Called once the scout completed with its proposals filed. */
  completed?(repo: Repo, filed: FiledProposals): void;
  /**
   * How many proposals waiting for a human hold the automatic scout back (see
   * proposalsHoldingScout). `scouts`: the repo's, newest first.
   */
  holdingProposals(repo: Repo, cfg: C, scouts: Scout[]): Promise<number>;
}

/** A scout in progress: its agent once started, and the whole scout including the cleanup. */
interface ScoutEntry {
  scoutId: string;
  exec?: AgentExecution;
  done?: Promise<void>;
}

export interface ScoutingDeps {
  store: Store;
  engine: Engine;
  paths: HomePaths;
  config: () => LoadedConfig;
  adapters: Map<string, AgentAdapter>;
  /**
   * The install directory the Master runs from and its origin, to tell which repo is the
   * Master's own source; null when it does not run from one (then no repo is).
   */
  masterOrigin?: MasterOrigin | null;
}

/**
 * The scouts of every repo: at most one per repo at a time, each reading the repo's target
 * branch in a temporary worktree with its agent read-only. The automatic scout waits while the
 * repo has work that goes on by itself, while the Master waits to upgrade, past the day's
 * budget, within the set interval, while it backs off after scouts that found nothing or failed,
 * while its agent's quota is out, and while enough proposals and stuck Runs wait for a human.
 */
export class Scouting {
  private readonly scouting = new Map<string, ScoutEntry>();
  private stopping = false;

  constructor(private readonly deps: ScoutingDeps) {}

  private get cfg() {
    return this.deps.config();
  }

  // ---- lifecycle -------------------------------------------------------------

  /**
   * Record the scouts a previous Master left running as interrupted, and delete the temporary
   * worktrees it did not get to.
   */
  async start(): Promise<void> {
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
  }

  /** Stop the scouts in progress; resolves once they recorded it and deleted their worktrees. */
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all(
      [...this.scouting.values()].map(async (s) => {
        await s.exec?.stop();
        await s.done;
      }),
    );
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

  private scoutRepo(scoutId: string): Repo | undefined {
    try {
      return this.deps.store.findRepo(this.deps.store.getScout(scoutId).repoId);
    } catch (err) {
      if (err instanceof NotFoundError) return undefined;
      throw err;
    }
  }

  // ---- state -----------------------------------------------------------------

  /** Some repo is being scouted (an upgrade waits for it). */
  get running(): boolean {
    return this.scouting.size > 0;
  }

  /** The repo is being scouted. */
  isScouting(repoId: string): boolean {
    return this.scouting.has(repoId);
  }

  /**
   * What the dashboard shows of a repo alike whatever its source: the template and `problems`,
   * the scout (`waiting`: why the automatic one did not start at the source's last poll), the
   * auto-accept settings with today's count, and today's spend against the budget. `repo`:
   * undefined when it is not registered on the dashboard.
   */
  sourceStatus(
    name: string,
    cfg: ProposalSourceConfig,
    repo: Repo | undefined,
    problems: string[],
    waiting: ScoutWait | null | undefined,
  ): ProposalSourceStatus {
    const store = this.deps.store;
    const last = repo ? store.listScouts({ repoId: repo.id, limit: 1 })[0] : undefined;
    const spent = repo ? spentToday(store, repo.id) : 0;
    const running = repo ? this.isScouting(repo.id) : false;
    return {
      name,
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
            waiting: running ? null : (waiting ?? null),
          }
        : null,
      autoAccept: {
        maxRisk: cfg.auto_accept.max_risk,
        maxSize: cfg.auto_accept.max_size,
        maxPerDay: cfg.auto_accept.max_per_day ?? null,
        usedToday: autoAcceptedToday(store, name),
      },
      autoMerge: cfg.auto_merge,
      budget: {
        dailyUsd: cfg.daily_budget_usd ?? null,
        spentToday: spent,
        reached: cfg.daily_budget_usd !== undefined && spent >= cfg.daily_budget_usd,
      },
    };
  }

  // ---- the automatic scout -----------------------------------------------------

  /**
   * Why the automatic scout of the repo does not start now; null when it may. It scouts by
   * itself when there is nothing to do: the repo has no Run that goes on by itself and no
   * requirement waiting to be redone (see splitUnfinishedRuns), the proposals that hold it back
   * (`holdingProposals`) and the Runs stuck waiting for a human are fewer than max_proposals
   * together, the day's budget is not spent, the configured interval since the last scout has
   * passed, it is not backing off after scouts that found nothing or failed (see scoutBackoff:
   * the wait doubles with each such scout in a row, and ends once a scout files a proposal or the
   * target branch gets a new commit), and it is not waiting for the quota of an agent that ran
   * out of it (see scoutLimitWait).
   */
  async autoScoutWaiting<C extends ProposalSourceConfig>(
    source: ProposalSource<C>,
    repo: Repo,
    cfg: C,
  ): Promise<ScoutWait | null> {
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
    if (overBudget(store, repo, cfg)) {
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
    wait = laterWait(wait, await this.scoutBackoffWait(repo, scouts, source.pollMinutes()));
    wait = laterWait(wait, this.scoutQuotaWait(scouts));
    if (wait) return wait;
    // Do not pile up work nobody has looked at: proposals and Runs stuck waiting for a human.
    const pending = await source.holdingProposals(repo, cfg, scouts);
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
    pollMinutes: number,
  ): Promise<(ScoutWait & { until: string }) | null> {
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

  /** Start a scout of the repo; it runs in the background. */
  async startScout<C extends ProposalSourceConfig>(
    source: ProposalSource<C>,
    repo: Repo,
    cfg: C,
    trigger: Scout['trigger'],
  ): Promise<Scout> {
    const name = repo.name;
    const scoutCfg = cfg.scout;
    if (!scoutCfg) {
      const path = `${source.configPath(name)}.scout`;
      throw new InvalidStateError(
        t({
          zh: `仓库 ${name} 没有配置侦察（${path}）`,
          en: `Repo ${name} has no scout configured (${path})`,
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
      const issuesRepo = await source.prepareScout(repo, cfg);
      const scout = this.deps.store.tx(() => {
        const s = this.deps.store.createScout({
          repoId: repo.id,
          issuesRepo,
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
      entry.done = this.runScout(source, scout, repo, cfg, adapter, entry).finally(() => {
        this.scouting.delete(repo.id);
      });
      return scout;
    } catch (err) {
      this.scouting.delete(repo.id);
      throw err;
    }
  }

  /**
   * The repo's iteration under way (pending, active or blocked), if any; a repo has at most one.
   */
  private openIteration(repoId: string): Iteration | null {
    const open = this.deps.store.listIterations({
      repoId,
      status: ITERATION_OPEN_STATUSES,
      limit: 1,
    });
    return open[0] ?? null;
  }

  /** What the iteration's digest reads of a Run of its steps; undefined once it is gone. */
  private runOf(runId: string): ProposalRun | undefined {
    try {
      return this.deps.store.getRun(runId);
    } catch (err) {
      if (err instanceof NotFoundError) return undefined;
      throw err;
    }
  }

  /**
   * The Master's last failed upgrade if `repo` is the Master's own source, so that its scout
   * proposes fixing what the stable copy cannot build or start; null for every other repo.
   */
  private upgradeFailureFor(repo: Repo, github: string | null): UpgradeFailure | null {
    const failure = lastUpgradeFailure(this.deps.store);
    if (!failure) return null;
    const origin = this.deps.masterOrigin ?? null;
    return isMasterSource(origin, { path: repo.path, github }) ? failure : null;
  }

  private async runScout<C extends ProposalSourceConfig>(
    source: ProposalSource<C>,
    scout: Scout,
    repo: Repo,
    cfg: C,
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
      const known = await source.known(scout, repo, cfg);
      // With an iteration under way the scout follows it rather than planning another.
      const open = this.openIteration(repo.id);
      // A repo whose template is gone gets no Runs anyway; such a scout is told nothing splits.
      const template = findTemplate(this.cfg, repo.name, cfg.template)?.template;
      const prompt = scoutPrompt({
        repoName: repo.name,
        source: source.kind,
        max: scoutCfg.max_proposals,
        runs: runDigest(store, repo.id, this.cfg.master.concurrency.per_repo),
        issues: known.issues,
        splits: template ? templateSplits(template) : false,
        autoAcceptsL: autoAcceptsL(cfg.auto_accept),
        upgrade: this.upgradeFailureFor(repo, known.github),
        iteration: open ? iterationDigest(open, (id) => this.runOf(id)) : null,
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
      // Taken by the rules of what the scout was shown: with an iteration under way, only
      // problems and a change to its plan; without one, a new iteration and no change.
      const report = keptReport(
        parseScoutReport(result.structured, result.finalMessage),
        open,
        scoutCfg.max_proposals,
      );
      const proposals = report.proposals;
      // Kept before the proposals are filed, so that a scout cut short there still shows them.
      store.updateScout(scout.id, { gaps: report.gaps });
      let filed = await source.file(scout, repo, cfg, proposals);
      if (report.iteration && source.fileIteration) {
        const iteration = await source.fileIteration(scout, repo, cfg, report.iteration);
        // Accepted or turned down as a whole: one more for a human to decide while it waits.
        if (iteration) {
          filed = { ...filed, iteration, pending: filed.pending + (iteration.auto ? 0 : 1) };
        }
      }
      if (open && report.iterationUpdate && source.adjustIteration) {
        // Changed only while it is still under way: it may have ended while the scout ran.
        const current = this.openIteration(repo.id);
        if (current?.id === open.id) {
          await source.adjustIteration(scout, repo, cfg, current, report.iterationUpdate);
        }
      }
      const iteration = filed.iteration;
      store.tx(() => {
        store.updateScout(scout.id, { status: 'completed', proposals, endedAt: nowIso() });
        store.event(null, 'scout.completed', {
          scoutId: scout.id,
          repo: repo.name,
          created: filed.created,
          auto: filed.auto,
          /** Proposals that wait for a human, an iteration waiting to be accepted included. */
          pending: filed.pending,
          // The iteration the scout planned, once written out.
          ...(iteration ? { iteration: { id: iteration.id, auto: iteration.auto } } : {}),
          // Decided on the dashboard rather than on GitHub (see noticeFor).
          ...(source.kind === 'local' ? { backlog: true } : {}),
        });
      });
      source.completed?.(repo, filed);
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
}

class Interrupted extends Error {}
