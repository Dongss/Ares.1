// The local backlog: where the requirements of a repo without GitHub come from (backlog.repos).
// The scout's proposals are kept in the Master (the proposals table) instead of as issues; those
// within the repo's auto_accept become Runs right away, the others wait for a human, who accepts
// them on the dashboard or rejects them with a reason the next scouts are shown. Nothing here
// calls GitHub.

import type { BacklogStatus } from '../api/types.js';
import { holdsScout, isAutoAcceptable, issueRunOverrides } from '../config/flow.js';
import { backlogConfigKey, findTemplate, type LoadedConfig } from '../config/load.js';
import type { BacklogRepoConfig } from '../config/schema.js';
import { type Engine, InvalidStateError } from '../engine/engine.js';
import { localProposalDigest, type ProposalRun, proposalGoal } from '../github/scout.js';
import { t } from '../i18n.js';
import { NotFoundError, type Store } from '../store/store.js';
import type { EventRow, Proposal, Repo, Scout, ScoutProposal } from '../store/types.js';
import { errorMessage, nowIso } from '../util.js';
import { mayAutoAccept } from './guard.js';
import {
  type FiledProposals,
  notRegistered,
  type ProposalSource,
  type Scouting,
  type ScoutWait,
} from './scouting.js';

export interface LocalBacklogDeps {
  store: Store;
  engine: Engine;
  config: () => LoadedConfig;
  /** The scouts of every repo, which this source's scouts run in. */
  scouting: Scouting;
  /**
   * Read the templates the repos keep in .ares1/workflows/ again where their target branch
   * moved (`RepoWorkflows.refresh`); never rejects. Each poll does it before it creates Runs.
   */
  refreshTemplates?: () => Promise<void>;
}

/** Why a proposal cannot be decided again. */
function decidedAlready(p: Proposal): string {
  return p.status === 'accepted'
    ? t({ zh: `提案 ${p.id} 已经采纳过了`, en: `Proposal ${p.id} was accepted already` })
    : t({ zh: `提案 ${p.id} 已经被拒绝了`, en: `Proposal ${p.id} was rejected already` });
}

/**
 * The local backlog of every repo of backlog.repos:
 * - scout: an AI reads the repo and its Run history and proposes requirements, on demand or by
 *   itself whenever the repo is idle (see Scouting.autoScoutWaiting); its prompt lists the
 *   repo's proposals, the rejected ones with their reasons as counterexamples;
 * - accept: a proposal within `auto_accept` is accepted without a human while the work switch is
 *   on, within today's count and budget (`mayAutoAccept`); the others wait for a human, who
 *   accepts or rejects them on the dashboard. An accepted proposal becomes a Run whose goal is the
 *   proposal's text.
 * Polls on its own timer (`backlog.poll_minutes`), whether or not GitHub is configured. Accepting
 * without a human and automatic scouts only happen while the work switch is on.
 */
export class LocalBacklog {
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  /** Why no automatic scout started at the last poll, per repo name. */
  private readonly scoutWaiting = new Map<string, ScoutWait | null>();
  private lastPollAt: string | null = null;
  private lastError: { message: string; at: string } | null = null;
  private stopping = false;
  private readonly onEvent = (e: EventRow) => {
    // What waited for the switch goes on at once, not at the next poll.
    if (e.type === 'master.working' && e.data.on === true) void this.poll();
  };

  constructor(private readonly deps: LocalBacklogDeps) {}

  private get cfg() {
    return this.deps.config();
  }

  /** How often the Master looks at the local backlog (`backlog.poll_minutes`). */
  private get pollMinutes(): number {
    return this.cfg.master.backlog?.poll_minutes ?? 5;
  }

  // ---- lifecycle -------------------------------------------------------------

  /**
   * The scouts' own records and leftovers are taken care of by `Scouting.start`, which the
   * Master runs before this. `poll`: poll on a timer (tests call `poll()` themselves). The timer
   * runs without a `backlog` section too, so that one added to config.yaml later takes effect.
   */
  start(opts: { poll: boolean } = { poll: true }): void {
    this.deps.store.bus.on('event', this.onEvent);
    if (opts.poll) this.schedulePoll(2_000);
  }

  /** The scouts in progress are stopped by `Scouting.stop`, which the Master runs alongside. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.deps.store.bus.off('event', this.onEvent);
    clearTimeout(this.pollTimer);
    await this.chain;
  }

  private schedulePoll(delayMs: number): void {
    clearTimeout(this.pollTimer);
    if (this.stopping) return;
    this.pollTimer = setTimeout(() => {
      void this.poll().finally(() => this.schedulePoll(this.pollMinutes * 60_000));
    }, delayMs);
  }

  /** Run `fn` after everything queued before it; polls never overlap. */
  private serial(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  /** Record what a poll could not do: the latest one, for the dashboard. */
  private report(err: unknown): void {
    this.lastError = { message: errorMessage(err), at: nowIso() };
  }

  // ---- poll ------------------------------------------------------------------

  /**
   * One round, repo by repo: accept the pending proposals auto-accept takes, then start a scout
   * where the repo is idle. A repo that is misconfigured or not registered on the dashboard is
   * skipped, with the reason kept as why it does not scout; so is every repo while the work switch
   * is off.
   */
  poll(): Promise<void> {
    return this.serial(async () => {
      const backlog = this.cfg.master.backlog;
      if (!backlog || this.stopping) return;
      // The templates of commits a human made on a target branch, and of repos registered since.
      await this.deps.refreshTemplates?.();
      const working = this.deps.store.working;
      let failed = false;
      for (const name of Object.keys(backlog.repos)) {
        if (this.stopping) return;
        let setup: { repo: Repo; cfg: BacklogRepoConfig };
        try {
          setup = this.repoSetup(name);
        } catch (err) {
          this.scoutWaiting.set(name, { reason: errorMessage(err) });
          continue;
        }
        if (!working) {
          this.scoutWaiting.set(name, {
            reason: t({ zh: '工作开关已关闭', en: 'The work switch is off' }),
          });
          continue;
        }
        try {
          this.acceptWithinLimits(setup.repo, setup.cfg);
          await this.maybeAutoScout(setup.repo, setup.cfg);
        } catch (err) {
          failed = true;
          this.report(err);
        }
      }
      // Repos taken out of backlog.repos.
      for (const name of [...this.scoutWaiting.keys()]) {
        if (!Object.hasOwn(backlog.repos, name)) this.scoutWaiting.delete(name);
      }
      this.lastPollAt = nowIso();
      if (!failed) this.lastError = null;
    });
  }

  /** A repo of backlog.repos and its settings; throws why the Master cannot work on it. */
  private repoSetup(name: string): { repo: Repo; cfg: BacklogRepoConfig } {
    const cfg = this.cfg.master.backlog?.repos[name];
    if (!cfg) {
      throw new NotFoundError(
        t({
          zh: `config.yaml 的 backlog.repos 里没有 ${name}`,
          en: `${name} is not in backlog.repos of config.yaml`,
        }),
      );
    }
    const problems = this.cfg.errors[backlogConfigKey(name)];
    if (problems) {
      throw new InvalidStateError(
        t({
          zh: `backlog.repos.${name} 配置有误：${problems.join('；')}`,
          en: `backlog.repos.${name} is misconfigured: ${problems.join('; ')}`,
        }),
      );
    }
    const repo = this.deps.store.findRepo(name);
    if (!repo) throw new NotFoundError(notRegistered(name));
    return { repo, cfg };
  }

  /**
   * Accept, oldest first, the pending proposals auto-accept takes, as far as today's count and
   * spend allow: those left when the work switch was off or the day's count was used up, and
   * those the settings take since they were loosened. Uses the risk and size the scout gave them.
   */
  private acceptWithinLimits(repo: Repo, cfg: BacklogRepoConfig): void {
    if (cfg.auto_accept.max_risk === 'none') return;
    const store = this.deps.store;
    // Newest first as listed.
    const pending = store.listProposals({ repoId: repo.id, status: 'pending' }).reverse();
    for (const p of pending) {
      if (!isAutoAcceptable(p, cfg.auto_accept)) continue;
      if (!mayAutoAccept(store, repo, cfg)) return;
      this.acceptProposal(p, repo, cfg, true);
    }
  }

  /**
   * Scout by itself when there is nothing to do (see Scouting.autoScoutWaiting). Records why it
   * waits, for the dashboard.
   */
  private async maybeAutoScout(repo: Repo, cfg: BacklogRepoConfig): Promise<void> {
    const waiting = await this.deps.scouting.autoScoutWaiting(this.source, repo, cfg);
    this.scoutWaiting.set(repo.name, waiting);
    if (waiting === null) await this.deps.scouting.startScout(this.source, repo, cfg, 'auto');
  }

  // ---- deciding proposals --------------------------------------------------------

  /**
   * Accept a pending proposal by hand: a Run is created from it. The repo must still be in
   * backlog.repos, without problems.
   */
  accept(id: string): Proposal {
    const p = this.deps.store.getProposal(id);
    if (p.status !== 'pending') throw new InvalidStateError(decidedAlready(p));
    const repo = this.deps.store.findRepo(p.repoId);
    if (!repo) {
      throw new NotFoundError(
        t({ zh: `提案 ${id} 的仓库不存在`, en: `The repo of proposal ${id} not found` }),
      );
    }
    if (!this.cfg.master.backlog?.repos[repo.name]) {
      throw new InvalidStateError(
        t({
          zh: `仓库 ${repo.name} 已经不在 config.yaml 的 backlog.repos 里，不能再采纳它的提案`,
          en: `Repo ${repo.name} is no longer in backlog.repos of config.yaml, so its proposals cannot be accepted`,
        }),
      );
    }
    const { cfg } = this.repoSetup(repo.name);
    return this.acceptProposal(p, repo, cfg, false);
  }

  /** Reject a pending proposal; the reason is shown to the repo's next scouts. */
  reject(id: string, reason: string): Proposal {
    const why = reason.trim();
    if (!why) {
      throw new InvalidStateError(
        t({ zh: '拒绝提案时必须填写理由', en: 'Rejecting a proposal needs a reason' }),
      );
    }
    const store = this.deps.store;
    const p = store.getProposal(id);
    if (p.status !== 'pending') throw new InvalidStateError(decidedAlready(p));
    const repo = store.findRepo(p.repoId);
    return store.tx(() => {
      const rejected = store.updateProposal(id, {
        status: 'rejected',
        rejectReason: why,
        decidedAt: nowIso(),
      });
      store.event(null, 'proposal.rejected', {
        repo: repo?.name ?? p.repoId,
        proposalId: id,
        reason: why,
      });
      return rejected;
    });
  }

  /**
   * Every proposal is accepted here, by a human or not: a Run with the repo's template whose goal
   * is the proposal's text, without approval before merging when `auto_merge` is on (the other
   * gates of the template stay), recorded on the proposal.
   */
  private acceptProposal(p: Proposal, repo: Repo, cfg: BacklogRepoConfig, auto: boolean): Proposal {
    const run = this.deps.engine.createRun({
      repo: repo.name,
      template: cfg.template,
      goal: proposalGoal(p),
      overrides: issueRunOverrides(
        findTemplate(this.cfg, repo.name, cfg.template)?.template,
        cfg.auto_merge,
      ),
    });
    const store = this.deps.store;
    return store.tx(() => {
      const accepted = store.updateProposal(p.id, {
        status: 'accepted',
        runId: run.id,
        auto,
        decidedAt: nowIso(),
      });
      store.event(null, auto ? 'proposal.auto_accepted' : 'proposal.accepted', {
        repo: repo.name,
        proposalId: p.id,
        runId: run.id,
      });
      return accepted;
    });
  }

  // ---- scouting ----------------------------------------------------------------

  /** Start a scout of a repo of backlog.repos; it runs in the background. */
  async startScout(name: string, trigger: Scout['trigger']): Promise<Scout> {
    const { repo, cfg } = this.repoSetup(name);
    return this.deps.scouting.startScout(this.source, repo, cfg, trigger);
  }

  /**
   * The local backlog as where the scouts' proposals go: each proposal becomes a row of the
   * proposals table, and the scout is shown the repo's proposals (see localProposalDigest).
   */
  private readonly source: ProposalSource<BacklogRepoConfig> = {
    kind: 'local',
    configPath: (name) => `backlog.repos.${name}`,
    pollMinutes: () => this.pollMinutes,
    // No issues repo, labels or anything else to make ready.
    prepareScout: async () => '',
    // Without a GitHub repo, the repo is the Master's own source only by its path.
    known: async (_scout, repo) => ({ issues: this.digest(repo), github: null }),
    file: async (scout, repo, cfg, proposals) => this.fileProposals(scout, repo, cfg, proposals),
    holdingProposals: async (repo, cfg) =>
      this.deps.store
        .listProposals({ repoId: repo.id, status: 'pending' })
        .filter((p) => holdsScout(p, cfg.auto_accept)).length,
  };

  /** The repo's proposals for the scout's prompt, with the Runs the accepted ones became. */
  private digest(repo: Repo): string {
    const store = this.deps.store;
    const runOf = (runId: string): ProposalRun | undefined => {
      try {
        return store.getRun(runId);
      } catch (err) {
        if (err instanceof NotFoundError) return undefined;
        throw err;
      }
    };
    return localProposalDigest(store.listProposals({ repoId: repo.id }), runOf);
  }

  /**
   * Keep each proposal in the backlog; one within auto-accept is accepted at once while the work
   * switch is on and today's count and spend allow, the others stay pending (the next polls
   * accept those auto-accept takes once they may). A proposal whose Run could not be created
   * stays pending too, and the error is reported.
   */
  private async fileProposals(
    scout: Scout,
    repo: Repo,
    cfg: BacklogRepoConfig,
    proposals: ScoutProposal[],
  ): Promise<FiledProposals> {
    const store = this.deps.store;
    for (const p of proposals) {
      const row = store.createProposal({ ...p, repoId: repo.id, scoutId: scout.id });
      const local = { id: row.id, auto: false };
      p.local = local;
      if (
        store.working &&
        isAutoAcceptable(p, cfg.auto_accept) &&
        mayAutoAccept(store, repo, cfg)
      ) {
        try {
          this.acceptProposal(row, repo, cfg, true);
          local.auto = true;
        } catch (err) {
          this.report(err);
        }
      }
      // Keep what was filed so far even if the Master stops halfway.
      store.updateScout(scout.id, { proposals });
    }
    const filed = proposals.filter((p) => p.local);
    const auto = filed.filter((p) => p.local?.auto).length;
    return { created: filed.length, auto, pending: filed.length - auto };
  }

  // ---- status ------------------------------------------------------------------

  status(): BacklogStatus {
    const backlog = this.cfg.master.backlog;
    const store = this.deps.store;
    const repos = Object.entries(backlog?.repos ?? {}).map(([name, cfg]) => {
      const repo = store.findRepo(name);
      const problems = [...(this.cfg.errors[backlogConfigKey(name)] ?? [])];
      if (!repo) problems.push(notRegistered(name));
      return {
        ...this.deps.scouting.sourceStatus(name, cfg, repo, problems, this.scoutWaiting.get(name)),
        pending: repo ? store.listProposals({ repoId: repo.id, status: 'pending' }).length : 0,
      };
    });
    return {
      enabled: backlog !== undefined,
      pollMinutes: this.pollMinutes,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      repos,
    };
  }
}
