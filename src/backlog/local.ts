// The local backlog: where the requirements of a repo without GitHub come from (backlog.repos).
// The scout's proposals are kept in the Master (the proposals table) instead of as issues; those
// within the repo's auto_accept become Runs right away, the others wait for a human, who accepts
// them on the dashboard or rejects them with a reason the next scouts are shown. A proposal of its
// own whose Run failed is redone, told why, until max_run_attempts is used up, as an issue is.
// An iteration a scout plans is kept the same way: its record (source local) and one proposal per
// step, accepted or rejected as a whole, its steps started in the order of their dependencies,
// redone the same way when their Runs fail, and the iteration summed up once every step is done
// (the rules shared with GitHub are in iterations.ts and flow.ts). Nothing here calls GitHub.

import type { BacklogStatus } from '../api/types.js';
import {
  attemptsAllowed,
  childReady,
  effectiveDependencies,
  holdsScout,
  ITERATION_OPEN_STATUSES,
  isAutoAcceptable,
  issueRunOverrides,
  iterationKind,
  iterationStatusOf,
  type ProposalKind,
  proposalAwaitingRedo,
  proposalRedoAllowed,
  proposalRedoDueAt,
  proposalRestartable,
} from '../config/flow.js';
import { backlogConfigKey, findTemplate, type LoadedConfig } from '../config/load.js';
import type { BacklogRepoConfig } from '../config/schema.js';
import { type Engine, InvalidStateError } from '../engine/engine.js';
import { goalWithEarlierAttempts } from '../engine/prompts.js';
import { failedAttempt } from '../github/issues.js';
import {
  type IterationUpdate,
  localProposalDigest,
  type PlannedIteration,
  type ProposalRun,
  plannedChildren,
  proposalGoal,
} from '../github/scout.js';
import { t } from '../i18n.js';
import { ConflictError, NotFoundError, type Store } from '../store/store.js';
import {
  type EventRow,
  FINISHED_RUN_STATUSES,
  type Iteration,
  type IterationChild,
  type IterationChildStatus,
  type IterationStatus,
  type Proposal,
  type Repo,
  type Run,
  type Scout,
  type ScoutProposal,
} from '../store/types.js';
import { errorMessage, nowIso } from '../util.js';
import { mayAutoAccept, overBudget } from './guard.js';
import {
  type ChildOutcome,
  closeoutSuggestions,
  followChildren,
  iterationSummary,
  recordAccepted,
  recordAdjustment,
  recordCancelled,
  recordDone,
} from './iterations.js';
import {
  type FiledIteration,
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
  if (p.status === 'rejected') {
    return t({ zh: `提案 ${p.id} 已经被拒绝了`, en: `Proposal ${p.id} was rejected already` });
  }
  if (p.status === 'failed') {
    return t({
      zh: `提案 ${p.id} 已经采纳过，Run 失败 ${p.attempt} 次后不再重做了`,
      en: `Proposal ${p.id} was accepted already, and given up after its Runs failed ${p.attempt === 1 ? 'once' : `${p.attempt} times`}`,
    });
  }
  return t({ zh: `提案 ${p.id} 已经采纳过了`, en: `Proposal ${p.id} was accepted already` });
}

/** Why a proposal cannot be started over: `proposalRestartable` says it cannot. */
function notRestartable(p: Proposal, iteration: Iteration | null): string {
  if (p.status === 'pending') {
    return t({
      zh: `提案 ${p.id} 还没有采纳，不用重新开始`,
      en: `Proposal ${p.id} is not accepted yet, so there is nothing to start over`,
    });
  }
  if (p.status === 'rejected') {
    return t({
      zh: `提案 ${p.id} 已经被拒绝了，不能重新开始`,
      en: `Proposal ${p.id} was rejected, so it cannot be started over`,
    });
  }
  if (p.status === 'accepted') {
    return t({
      zh: `提案 ${p.id} 没有失败：只有 Run 用完尝试次数、标为已失败的提案能重新开始`,
      en: `Proposal ${p.id} has not failed: only a proposal whose Runs used up their attempts can be started over`,
    });
  }
  // Failed, but a step its iteration no longer wants.
  if (!iteration || (iteration.status !== 'active' && iteration.status !== 'blocked')) {
    return t({
      zh: `提案 ${p.id} 所在的迭代 ${p.iterationId} 已经结束了，不能再重新开始它`,
      en: `Iteration ${p.iterationId}, which proposal ${p.id} is a step of, is over, so the step cannot be started over`,
    });
  }
  const child = iteration.children.find((c) => c.proposalId === p.id);
  if (child?.replacedBy !== undefined) {
    return t({
      zh: `提案 ${p.id} 这一步已经由第 ${child.replacedBy} 步换个做法接替，不能再重新开始`,
      en: `Proposal ${p.id} was taken over by step ${child.replacedBy} with another approach, so it cannot be started over`,
    });
  }
  return t({
    zh: `提案 ${p.id} 这一步已经不做了，不能再重新开始`,
    en: `Proposal ${p.id} is a step that was dropped, so it cannot be started over`,
  });
}

/** Why an iteration that is no longer pending cannot be accepted or rejected. */
function iterationDecidedAlready(it: Pick<Iteration, 'id' | 'status'>): string {
  if (it.status === 'done') {
    return t({ zh: `迭代 ${it.id} 已经完成了`, en: `Iteration ${it.id} is done already` });
  }
  if (it.status === 'cancelled') {
    return t({ zh: `迭代 ${it.id} 已经不做了`, en: `Iteration ${it.id} was turned down already` });
  }
  return t({ zh: `迭代 ${it.id} 已经采纳过了`, en: `Iteration ${it.id} was accepted already` });
}

/** Statuses of a child that is over: its dependencies are not rewritten any more. */
const CHILD_OVER: readonly IterationChildStatus[] = ['done', 'failed', 'dropped'];

/**
 * The local backlog of every repo of backlog.repos:
 * - scout: an AI reads the repo and its Run history and proposes requirements, on demand or by
 *   itself whenever the repo is idle (see Scouting.autoScoutWaiting); its prompt lists the
 *   repo's proposals, the rejected ones with their reasons as counterexamples, and the iteration
 *   under way if any;
 * - accept: a proposal within `auto_accept` is accepted without a human while the work switch is
 *   on, within today's count and budget (`mayAutoAccept`); the others wait for a human, who
 *   accepts or rejects them on the dashboard. An accepted proposal becomes a Run whose goal is the
 *   proposal's text;
 * - redo: a proposal whose Run failed, of its own or a step of an iteration that still wants it
 *   (`proposalRedoAllowed`), is redone as a new Run whose goal tells why the earlier attempts
 *   failed, after the wait an issue's redo waits (`proposalRedoDueAt`), up to `max_run_attempts`
 *   Runs and within the day's budget, while the work switch is on; after that the proposal
 *   failed. A Run a human terminated is not redone;
 * - restart: a human may start a failed proposal over on the dashboard, a step of an iteration
 *   that still wants it included: its attempts count from 1 again, the new Run told why the
 *   earlier ones failed, and its iteration goes on unless another step still blocks it;
 * - iterations: one a scout planned is accepted as a whole, by its riskiest and largest step
 *   (`iterationKind`) and counting once toward today's limit, or by a human on the dashboard, or
 *   rejected as a whole with a reason. Accepted, each step becomes a Run once every step it
 *   depends on completed; a step whose Run failed keeps running while it is redone, and blocks
 *   the iteration once its attempts are used up, its Run was terminated or dropped, until a scout
 *   replaces that step; a human may cancel it, terminating the Runs of its steps not done, and its
 *   steps are not redone any more. Once every step is done its summary is recorded and it is
 *   done.
 * Polls on its own timer (`backlog.poll_minutes`), whether or not GitHub is configured. Accepting
 * without a human, starting the next steps of iterations and automatic scouts only happen while
 * the work switch is on.
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
   * One round, repo by repo: record the failed Runs of proposals and (while the work switch is
   * on) redo those whose wait is over, follow the iterations (and, while the work switch is on,
   * start the steps whose dependencies are done), then accept the pending proposals and
   * iterations auto-accept takes, then start a scout where the repo is idle. A repo that is
   * misconfigured or not registered on the dashboard is skipped, with the reason kept as why it
   * does not scout; with the work switch off, only the failed Runs and the iterations are
   * followed.
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
        try {
          // Before following the iterations: a step whose Run failed with attempts left is seen
          // as waiting for its redo, never as failed. Before auto-accepting: a requirement already
          // taken on goes first within the budget.
          this.redoFailedProposals(setup.repo, setup.cfg, working);
        } catch (err) {
          failed = true;
          this.report(err);
        }
        try {
          // A step whose Run just completed lets the next one start before the scout looks at
          // whether the repo is idle.
          await this.followIterations(setup.repo, setup.cfg, working);
        } catch (err) {
          failed = true;
          this.report(err);
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
   * Accept, oldest first, the pending proposals and iterations auto-accept takes, as far as
   * today's count and spend allow: those left when the work switch was off or the day's count was
   * used up, and those the settings take since they were loosened. Uses the risk and size the
   * scout gave them; an iteration goes by its riskiest and largest step (`iterationKind`), and is
   * accepted as a whole, counting once. The steps of an iteration are not proposals of their own.
   */
  private acceptWithinLimits(repo: Repo, cfg: BacklogRepoConfig): void {
    if (cfg.auto_accept.max_risk === 'none') return;
    const store = this.deps.store;
    const waiting: { at: string; kind: ProposalKind; accept: () => void }[] = [
      // Newest first as listed.
      ...store
        .listProposals({ repoId: repo.id, status: 'pending' })
        .filter((p) => p.iterationId === null)
        .reverse()
        .map((p) => ({
          at: p.createdAt,
          kind: p,
          accept: () => {
            this.acceptProposal(p, repo, cfg, true);
          },
        })),
      ...this.localIterations(repo, 'pending')
        .reverse()
        .map((it) => ({
          at: it.createdAt,
          kind: iterationKind(it.children),
          accept: () => {
            this.acceptWhole(it.id, repo, cfg, true);
          },
        })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    for (const w of waiting) {
      if (!isAutoAcceptable(w.kind, cfg.auto_accept)) continue;
      if (!mayAutoAccept(store, repo, cfg)) return;
      w.accept();
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
   * The repo of a proposal or iteration a human accepts, or of a proposal a human starts over
   * (`restart`), with its settings: it must still be in backlog.repos, without problems. `what`:
   * the proposal or iteration, for messages.
   */
  private deciding(
    repoId: string,
    what: { kind: 'proposal' | 'restart' | 'iteration'; id: string },
  ): { repo: Repo; cfg: BacklogRepoConfig } {
    const repo = this.deps.store.findRepo(repoId);
    if (!repo) {
      throw new NotFoundError(
        what.kind === 'iteration'
          ? t({
              zh: `迭代 ${what.id} 的仓库不存在`,
              en: `The repo of iteration ${what.id} not found`,
            })
          : t({
              zh: `提案 ${what.id} 的仓库不存在`,
              en: `The repo of proposal ${what.id} not found`,
            }),
      );
    }
    if (!this.cfg.master.backlog?.repos[repo.name]) {
      const name = repo.name;
      throw new InvalidStateError(
        what.kind === 'proposal'
          ? t({
              zh: `仓库 ${name} 已经不在 config.yaml 的 backlog.repos 里，不能再采纳它的提案`,
              en: `Repo ${name} is no longer in backlog.repos of config.yaml, so its proposals cannot be accepted`,
            })
          : what.kind === 'restart'
            ? t({
                zh: `仓库 ${name} 已经不在 config.yaml 的 backlog.repos 里，不能再重新开始它的提案`,
                en: `Repo ${name} is no longer in backlog.repos of config.yaml, so its proposals cannot be started over`,
              })
            : t({
                zh: `仓库 ${name} 已经不在 config.yaml 的 backlog.repos 里，不能再采纳它的迭代`,
                en: `Repo ${name} is no longer in backlog.repos of config.yaml, so its iterations cannot be accepted`,
              }),
      );
    }
    return this.repoSetup(repo.name);
  }

  /** A step of an iteration is decided with its iteration, never on its own. */
  private refuseStep(p: Proposal): void {
    if (p.iterationId === null) return;
    throw new ConflictError(
      t({
        zh: `提案 ${p.id} 是迭代 ${p.iterationId} 的子项，要和迭代一起整体采纳或拒绝`,
        en: `Proposal ${p.id} is a step of iteration ${p.iterationId}: accept or reject the iteration as a whole`,
      }),
    );
  }

  /**
   * Accept a pending proposal by hand: a Run is created from it. The repo must still be in
   * backlog.repos, without problems. A step of an iteration is refused: it goes with its
   * iteration.
   */
  accept(id: string): Proposal {
    const p = this.deps.store.getProposal(id);
    this.refuseStep(p);
    if (p.status !== 'pending') throw new InvalidStateError(decidedAlready(p));
    const { repo, cfg } = this.deciding(p.repoId, { kind: 'proposal', id });
    return this.acceptProposal(p, repo, cfg, false);
  }

  /**
   * Reject a pending proposal; the reason is shown to the repo's next scouts. A step of an
   * iteration is refused: it goes with its iteration.
   */
  reject(id: string, reason: string): Proposal {
    const why = reason.trim();
    if (!why) {
      throw new InvalidStateError(
        t({ zh: '拒绝提案时必须填写理由', en: 'Rejecting a proposal needs a reason' }),
      );
    }
    const store = this.deps.store;
    const p = store.getProposal(id);
    this.refuseStep(p);
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
   * Every proposal of its own is accepted here, by a human or not: a Run whose goal is the
   * proposal's text (createProposalRun), recorded on the proposal.
   */
  private acceptProposal(p: Proposal, repo: Repo, cfg: BacklogRepoConfig, auto: boolean): Proposal {
    const run = this.createProposalRun(repo, cfg, proposalGoal(p));
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

  /**
   * The Run of a proposal, of its own or a step of an iteration: the repo's template, the goal
   * (the proposal's text, `proposalGoal`, with why the earlier attempts failed for a redo), and no
   * approval before merging when `auto_merge` is on (the other gates of the template stay).
   */
  private createProposalRun(repo: Repo, cfg: BacklogRepoConfig, goal: string): Run {
    return this.deps.engine.createRun({
      repo: repo.name,
      template: cfg.template,
      goal,
      overrides: issueRunOverrides(
        findTemplate(this.cfg, repo.name, cfg.template)?.template,
        cfg.auto_merge,
      ),
    });
  }

  // ---- redoing failed Runs -----------------------------------------------------------

  /**
   * Follow the repo's proposals whose latest Run failed, oldest first: those of their own, and
   * the steps of iterations that still want them (`proposalRedoAllowed`: accepted and not over,
   * the step neither replaced nor dropped; the others are left as they are). A failure not
   * recorded yet is recorded (recordFailure), which gives the proposal up once its attempts are
   * used up (a step so given up blocks its iteration); then, while the work switch is on, each one
   * waiting whose wait is over (`proposalRedoDueAt`) is redone (redo) as long as the day's budget
   * is not spent. Neither wait costs an attempt, and each proposal waits on its own. A Run a human
   * terminated is cancelled, not failed, so it is not redone. A proposal that could not be redone
   * (its Run not created) leaves the others to go on, and the error is thrown afterwards.
   */
  private redoFailedProposals(repo: Repo, cfg: BacklogRepoConfig, working: boolean): void {
    const store = this.deps.store;
    let failure: { err: unknown } | undefined;
    for (const found of store.proposalsWithFailedRun(repo.id)) {
      if (this.stopping) break;
      const iteration = this.iterationOf(found);
      if (!proposalRedoAllowed(found, iteration)) continue;
      const failed = store.getRun(found.runId ?? '');
      const p =
        found.redo === null ? this.recordFailure(repo, cfg, found, failed, iteration) : found;
      if (!working) continue;
      const due = proposalRedoDueAt(p, iteration, failed, this.pollMinutes);
      if (due === null || due > Date.now()) continue;
      // Over budget the redos wait for the next day; the other failures are still recorded.
      if (overBudget(store, repo, cfg)) continue;
      try {
        this.redo(repo, cfg, p, failed);
      } catch (err) {
        failure ??= { err };
      }
    }
    if (failure) throw failure.err;
  }

  /**
   * Record that the latest Run of a proposal failed (`failedAttempt`: which attempt, in which
   * stage, why) and what follows, decided once as for an issue: while attempts are left
   * (`max_run_attempts`) it waits to be redone, with a `proposal.redo_scheduled` event saying
   * when; otherwise the proposal failed, with a `proposal.failed` event listing every attempt.
   * In one transaction. `iteration`: the one it is a step of, null for a proposal of its own.
   * Returns the proposal as recorded then.
   */
  private recordFailure(
    repo: Repo,
    cfg: BacklogRepoConfig,
    p: Proposal,
    run: Run,
    iteration: Iteration | null,
  ): Proposal {
    const store = this.deps.store;
    const failures = [
      ...p.failures,
      failedAttempt(run, store.currentStageName(run) ?? null, p.attempt),
    ];
    const maxAttempts = attemptsAllowed(cfg.max_run_attempts, p.attempt);
    return store.tx(() => {
      if (p.attempt < cfg.max_run_attempts) {
        const pending = store.updateProposal(p.id, { failures, redo: 'pending' });
        const redoAt = proposalRedoDueAt(pending, iteration, run, this.pollMinutes) ?? Date.now();
        store.event(null, 'proposal.redo_scheduled', {
          repo: repo.name,
          proposalId: p.id,
          runId: run.id,
          attempt: p.attempt + 1,
          maxAttempts,
          redoAt: new Date(redoAt).toISOString(),
        });
        return pending;
      }
      const given = store.updateProposal(p.id, { failures, redo: 'exhausted', status: 'failed' });
      store.event(null, 'proposal.failed', {
        repo: repo.name,
        proposalId: p.id,
        runId: run.id,
        attempts: p.attempt,
        maxAttempts,
        failures,
      });
      return given;
    });
  }

  /**
   * Redo a proposal whose failed Run waited long enough: a new Run, the next attempt, whose goal
   * is the proposal's text as kept (for a closing step, with the review suggestions it was given
   * when it started) followed by why each earlier attempt failed
   * (`goalWithEarlierAttempts`), recorded on the proposal with a `proposal.redone` event in one
   * transaction. The Run counts toward the day's automatic spending, whoever accepted the
   * proposal. When the Run cannot be created nothing is recorded: a later poll tries again.
   */
  private redo(repo: Repo, cfg: BacklogRepoConfig, p: Proposal, failed: Run): void {
    const store = this.deps.store;
    const attempt = p.attempt + 1;
    const run = this.createProposalRun(
      repo,
      cfg,
      goalWithEarlierAttempts(proposalGoal(p), p.failures),
    );
    store.tx(() => {
      store.updateProposal(p.id, { runId: run.id, attempt, redo: null });
      store.event(null, 'proposal.redone', {
        repo: repo.name,
        proposalId: p.id,
        runId: run.id,
        failedRunId: failed.id,
        attempt,
        maxAttempts: attemptsAllowed(cfg.max_run_attempts, attempt),
      });
    });
  }

  /**
   * Start a failed proposal over by hand, as adding ares1:ready again does for an issue: its
   * attempts count from 1 again, and a Run is created at once whose goal is the proposal's text
   * as kept followed by why each earlier attempt failed (`goalWithEarlierAttempts`; `failures`
   * stays, for that and for the dashboard). Only a failed proposal its iteration, if any, still
   * wants (`proposalRestartable`); the repo must still be in backlog.repos, without problems. A
   * human's decision, like accepting: neither today's auto-accept count nor the day's budget hold
   * it back, and whether it was accepted without a human stays as it was. Then, in one
   * transaction: the proposal accepted again with the new Run as its latest, attempt 1 and no
   * redo; a `proposal.restarted` event; for a step, its iteration brought in line (follow): the
   * step running again, and the iteration active again unless another step still blocks it.
   * Nothing is recorded when the Run cannot be created, as for a redo.
   */
  restart(id: string): Proposal {
    const store = this.deps.store;
    const p = store.getProposal(id);
    const iteration = this.iterationOf(p);
    if (!proposalRestartable(p, iteration)) {
      throw new InvalidStateError(notRestartable(p, iteration));
    }
    const { repo, cfg } = this.deciding(p.repoId, { kind: 'restart', id });
    const run = this.createProposalRun(
      repo,
      cfg,
      goalWithEarlierAttempts(proposalGoal(p), p.failures),
    );
    return store.tx(() => {
      const restarted = store.updateProposal(id, {
        status: 'accepted',
        runId: run.id,
        attempt: 1,
        redo: null,
      });
      store.event(null, 'proposal.restarted', {
        repo: repo.name,
        proposalId: id,
        runId: run.id,
        ...(p.runId ? { failedRunId: p.runId } : {}),
        // The attempts it had used up before.
        attempts: p.attempt,
        maxAttempts: attemptsAllowed(cfg.max_run_attempts, 1),
        ...(iteration ? { iterationId: iteration.id } : {}),
      });
      if (iteration) this.follow(repo, iteration.id);
      return restarted;
    });
  }

  /**
   * The repo's proposals whose failed Run waits to be redone (`proposalAwaitingRedo`), steps of
   * iterations included.
   */
  private awaitingRedo(repo: Repo): number {
    return this.deps.store
      .listProposals({ repoId: repo.id, status: 'accepted' })
      .filter((p) => p.redo === 'pending' && proposalAwaitingRedo(p, this.iterationOf(p))).length;
  }

  /** The iteration a proposal is a step of; null for one of its own, or once it is gone. */
  private iterationOf(p: Pick<Proposal, 'iterationId'>): Iteration | null {
    if (p.iterationId === null) return null;
    try {
      return this.deps.store.getIteration(p.iterationId);
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  }

  // ---- iterations ----------------------------------------------------------------

  /** The repo's iterations of the local backlog, newest first; of `status` if given. */
  private localIterations(
    repo: Repo,
    status?: IterationStatus | readonly IterationStatus[],
  ): Iteration[] {
    return this.deps.store
      .listIterations({ repoId: repo.id, ...(status === undefined ? {} : { status }) })
      .filter((it) => it.source === 'local');
  }

  /**
   * An iteration of the local backlog, by id. One of GitHub is refused (ConflictError): it is
   * decided on GitHub, where its issues are.
   */
  private localIteration(id: string): Iteration {
    const iteration = this.deps.store.getIteration(id);
    if (iteration.source !== 'local') {
      throw new ConflictError(
        t({
          zh: `迭代 ${id} 在 GitHub 上：给迭代 issue 加上 ares1:ready 来采纳，关掉迭代 issue 来拒绝或终止`,
          en: `Iteration ${id} is on GitHub: add ares1:ready to its issue to accept it, or close the issue to turn it down`,
        }),
      );
    }
    return iteration;
  }

  /** Name of the repo an iteration belongs to, for its events; its id once the repo is gone. */
  private repoName(repoId: string): string {
    return this.deps.store.findRepo(repoId)?.name ?? repoId;
  }

  /**
   * Accept a pending iteration of the local backlog by hand, as a whole: every step's proposal is
   * accepted with it, and the steps whose dependencies are done become Runs at once. The repo
   * must still be in backlog.repos, without problems. A step that could not become a Run is
   * started by a later poll, the error reported.
   */
  acceptIteration(id: string): Iteration {
    const iteration = this.localIteration(id);
    if (iteration.status !== 'pending') {
      throw new InvalidStateError(iterationDecidedAlready(iteration));
    }
    const { repo, cfg } = this.deciding(iteration.repoId, { kind: 'iteration', id });
    return this.acceptWhole(id, repo, cfg, false);
  }

  /**
   * Reject a pending iteration of the local backlog, as a whole, with a reason: each step's
   * proposal is rejected with it, the reason recorded on each so that the repo's next scouts are
   * shown it; the iteration is cancelled (`recordCancelled`, the reason in its event).
   */
  rejectIteration(id: string, reason: string): Iteration {
    const why = reason.trim();
    if (!why) {
      throw new InvalidStateError(
        t({ zh: '拒绝迭代时必须填写理由', en: 'Rejecting an iteration needs a reason' }),
      );
    }
    const store = this.deps.store;
    const iteration = this.localIteration(id);
    if (iteration.status !== 'pending') {
      throw new InvalidStateError(
        ITERATION_OPEN_STATUSES.includes(iteration.status)
          ? t({
              zh: `迭代 ${id} 已经采纳了，不能再拒绝；不想做剩下的，就终止它`,
              en: `Iteration ${id} was accepted already and cannot be rejected; cancel it to drop the rest`,
            })
          : iterationDecidedAlready(iteration),
      );
    }
    return store.tx(() => {
      const at = nowIso();
      for (const child of iteration.children) {
        if (!child.proposalId) continue;
        if (store.getProposal(child.proposalId).status !== 'pending') continue;
        store.updateProposal(child.proposalId, {
          status: 'rejected',
          rejectReason: why,
          decidedAt: at,
        });
      }
      return recordCancelled(store, id, this.repoName(iteration.repoId), { reason: why });
    });
  }

  /**
   * Cancel an accepted iteration of the local backlog that is not over: nobody wants the rest of
   * it. It is recorded first (`recordCancelled`: every step neither done nor failed nor replaced
   * dropped), so that nothing takes the end of their Runs for a failure nor redoes a failed one
   * (`proposalRedoAllowed`), then the unfinished Runs
   * of its steps are terminated (stopDroppedRuns; a later poll finishes what a Master stopping
   * halfway left). A pending one is rejected instead, with a reason.
   */
  async cancelIteration(id: string): Promise<Iteration> {
    const store = this.deps.store;
    const iteration = this.localIteration(id);
    if (iteration.status === 'pending') {
      throw new InvalidStateError(
        t({
          zh: `迭代 ${id} 还没有采纳，要拒绝它（填写理由），而不是终止`,
          en: `Iteration ${id} is not accepted yet: reject it, with a reason, rather than cancel it`,
        }),
      );
    }
    if (!ITERATION_OPEN_STATUSES.includes(iteration.status)) {
      throw new InvalidStateError(iterationDecidedAlready(iteration));
    }
    const repo = this.repoName(iteration.repoId);
    const cancelled = recordCancelled(store, id, repo);
    await this.stopDroppedRuns(repo, cancelled);
    return store.getIteration(id);
  }

  /**
   * Accept a pending iteration as a whole, by a human or without one (`auto`, which counts once
   * toward today's limit): the iteration (`recordAccepted`) and the proposal of each step still
   * pending, accepted without a human as the iteration was (so that their Runs count toward
   * today's spend), in one transaction; then the steps whose dependencies are done become Runs
   * (advance). Throws when it is no longer pending. A step that could not become a Run is started
   * by a later poll, the error reported.
   */
  private acceptWhole(id: string, repo: Repo, cfg: BacklogRepoConfig, auto: boolean): Iteration {
    const store = this.deps.store;
    store.tx(() => {
      const accepted = recordAccepted(store, id, repo.name, auto);
      if (!accepted) throw new InvalidStateError(iterationDecidedAlready(store.getIteration(id)));
      for (const child of accepted.children) {
        if (!child.proposalId) continue;
        if (store.getProposal(child.proposalId).status !== 'pending') continue;
        store.updateProposal(child.proposalId, {
          status: 'accepted',
          auto,
          decidedAt: accepted.decidedAt ?? nowIso(),
        });
      }
    });
    try {
      return this.advance(repo, cfg, id, true);
    } catch (err) {
      this.report(err);
      return store.getIteration(id);
    }
  }

  /**
   * Follow the repo's iterations of the local backlog: each accepted one not over is brought in
   * line with its steps' Runs, its next steps started while the work switch is on, and summed up
   * once every step is done (advance); each cancelled one has the Runs of its steps stopped that
   * a Master stopping halfway through cancelling it left running (stopDroppedRuns). A failure of
   * one iteration leaves the others to go on and is thrown afterwards.
   */
  private async followIterations(
    repo: Repo,
    cfg: BacklogRepoConfig,
    working: boolean,
  ): Promise<void> {
    let failure: { err: unknown } | undefined;
    for (const iteration of this.localIterations(repo, ['active', 'blocked', 'cancelled'])) {
      if (this.stopping) break;
      try {
        if (iteration.status === 'cancelled') await this.stopDroppedRuns(repo.name, iteration);
        else this.advance(repo, cfg, iteration.id, working);
      } catch (err) {
        failure ??= { err };
      }
    }
    if (failure) throw failure.err;
  }

  /**
   * Bring an accepted iteration's steps in line with their Runs (follow); then, if `start`,
   * create a Run for each step whose dependencies are all done that has none yet (`childReady`,
   * startChild), and follow again so that they count as running. Ready steps start while the
   * iteration is blocked too: only the steps that depend on the one that blocked it wait. Returns
   * the iteration as recorded then.
   */
  private advance(repo: Repo, cfg: BacklogRepoConfig, id: string, start: boolean): Iteration {
    const iteration = this.follow(repo, id);
    if (!start || (iteration.status !== 'active' && iteration.status !== 'blocked')) {
      return iteration;
    }
    let started = false;
    for (const child of iteration.children) {
      if (!child.proposalId || !childReady(child, iteration.children)) continue;
      const p = this.deps.store.getProposal(child.proposalId);
      if (p.status !== 'accepted' || p.runId) continue;
      this.startChild(repo, cfg, iteration, child, p);
      started = true;
    }
    return started ? this.follow(repo, id) : iteration;
  }

  /**
   * Record where each step of an accepted iteration not over stands by its Runs
   * (`followChildren`): done once its Run completed; running while it goes on, and while its
   * failed Run is to be redone; failed once its attempts are used up, its Run was terminated or
   * dropped (blocking the iteration until a scout replaces the step); waiting or ready while it
   * has none. A step done or replaced is not read again. Once every step is done, the iteration
   * is summed up and done (complete). Returns the iteration as recorded then.
   */
  private follow(repo: Repo, id: string): Iteration {
    const store = this.deps.store;
    const iteration = store.getIteration(id);
    if (iteration.status !== 'active' && iteration.status !== 'blocked') return iteration;
    const outcomes = new Map<number, ChildOutcome>();
    for (const child of iteration.children) {
      if (!child.proposalId || child.status === 'done' || child.replacedBy !== undefined) continue;
      outcomes.set(child.position, this.outcomeOf(store.getProposal(child.proposalId), iteration));
    }
    const followed = followChildren(store, id, repo.name, outcomes);
    if (iterationStatusOf(followed.children) !== 'done') return followed;
    return this.complete(repo, followed);
  }

  /**
   * Where a step of `iteration` stands by its proposal's latest Run: none yet or not finished,
   * open; completed, done. Failed while the proposal is accepted, not given up and still wanted
   * (`proposalRedoAllowed`), redo: its failure not recorded yet or its redo still to come
   * (redoFailedProposals), so the step goes on. Otherwise failed: its Runs failed until the
   * attempts were used up (the proposal failed), a human terminated its Run (not redone, as for a
   * proposal of its own), or its assessment dropped the requirement.
   */
  private outcomeOf(p: Proposal, iteration: Iteration): ChildOutcome {
    if (!p.runId) return 'open';
    const status = this.deps.store.getRun(p.runId).status;
    if (status === 'completed') return 'done';
    if (!FINISHED_RUN_STATUSES.includes(status)) return 'open';
    const redone =
      status === 'failed' &&
      p.status === 'accepted' &&
      (p.redo === null || p.redo === 'pending') &&
      proposalRedoAllowed(p, iteration);
    return redone ? 'redo' : 'failed';
  }

  /**
   * Sum up an iteration whose steps are all done: its summary (`iterationSummary`, put together
   * from the Runs' records) kept on it for the dashboard, then the iteration done with an
   * `iteration.completed` event (`recordDone`), in one transaction.
   */
  private complete(repo: Repo, iteration: Iteration): Iteration {
    const store = this.deps.store;
    return store.tx(() => {
      if (!iteration.summaryPosted) {
        store.updateIteration(iteration.id, {
          summary: iterationSummary(store, iteration),
          summaryPosted: true,
        });
      }
      return recordDone(store, iteration.id, repo.name);
    });
  }

  /**
   * Create the Run of a step whose dependencies are done, recorded on its proposal. The closing
   * step's requirement gets the review suggestions the iteration's other steps left
   * (`closeoutSuggestions`) first, kept on its proposal so that it says what the Run was given;
   * a redo of the step goes by that text, the suggestions once. Nothing is recorded when the Run
   * cannot be created.
   */
  private startChild(
    repo: Repo,
    cfg: BacklogRepoConfig,
    iteration: Iteration,
    child: IterationChild,
    p: Proposal,
  ): void {
    const store = this.deps.store;
    const what = child.closeout
      ? `${p.what.trimEnd()}\n\n${closeoutSuggestions(store, iteration, child)}`
      : p.what;
    const run = this.createProposalRun(repo, cfg, proposalGoal({ ...p, what }));
    store.updateProposal(p.id, what === p.what ? { runId: run.id } : { runId: run.id, what });
  }

  /**
   * Terminate the unfinished Runs of a cancelled iteration's steps, each recorded as
   * `run.iteration_cancelled` so that neither the Run's page nor the scout takes it for a
   * failure. A Run that finished meanwhile is left as it is.
   */
  private async stopDroppedRuns(repo: string, iteration: Iteration): Promise<void> {
    const store = this.deps.store;
    for (const child of iteration.children) {
      if (!child.proposalId) continue;
      const runId = store.getProposal(child.proposalId).runId;
      if (!runId || FINISHED_RUN_STATUSES.includes(store.getRun(runId).status)) continue;
      try {
        await this.deps.engine.cancel(runId);
      } catch (err) {
        if (err instanceof InvalidStateError) continue;
        throw err;
      }
      store.event(runId, 'run.iteration_cancelled', { repo, iterationId: iteration.id });
    }
  }

  /**
   * Give each step of the iteration that has none its proposal, in the order of the plan, then
   * write on the proposal of every step not over the steps it really waits for, by proposal id
   * (`effectiveDependencies`: a replaced step stands for the one that replaced it). A proposal is
   * pending while its iteration is, otherwise accepted with it, without a human if the iteration
   * was. Call it within a transaction. Returns the iteration as recorded then.
   */
  private writeOutSteps(iterationId: string, scoutId: string | null): Iteration {
    const store = this.deps.store;
    const iteration = store.getIteration(iterationId);
    const accepted = iteration.status !== 'pending';
    const at = nowIso();
    const children = iteration.children.map((child) => {
      if (child.proposalId) return child;
      const p = store.createProposal({
        repoId: iteration.repoId,
        scoutId,
        title: child.title,
        category: child.category,
        size: child.size,
        risk: child.risk,
        why: child.why,
        evidence: child.evidence,
        what: child.what,
        acceptance: child.acceptance,
        iterationId,
      });
      if (accepted) {
        store.updateProposal(p.id, { status: 'accepted', auto: iteration.auto, decidedAt: at });
      }
      return { ...child, proposalId: p.id };
    });
    const ids = new Map(children.map((c) => [c.position, c.proposalId]));
    for (const child of children) {
      const own = child.proposalId;
      if (!own || child.replacedBy !== undefined || CHILD_OVER.includes(child.status)) continue;
      const dependsOn = effectiveDependencies(child, children).flatMap((position) => {
        const dep = ids.get(position);
        return dep ? [dep] : [];
      });
      if (store.getProposal(own).dependsOn.join() !== dependsOn.join()) {
        store.updateProposal(own, { dependsOn });
      }
    }
    return store.updateIteration(iterationId, { children });
  }

  /**
   * Keep the iteration a scout planned: its record and one proposal per step, with the steps each
   * depends on, in one transaction. Accepted as a whole at once while the work switch is on when
   * its riskiest and largest step is within auto_accept (`iterationKind`) and today's count and
   * spend allow; otherwise it waits for a human, or for a later poll once auto-accept may take it.
   */
  private fileIteration(
    scout: Scout,
    repo: Repo,
    cfg: BacklogRepoConfig,
    plan: PlannedIteration,
  ): FiledIteration {
    const store = this.deps.store;
    const iteration = store.tx(() => {
      const created = store.createIteration({
        repoId: repo.id,
        scoutId: scout.id,
        source: 'local',
        issuesRepo: '',
        title: plan.title,
        goal: plan.goal,
        readmeGoal: plan.readmeGoal,
        criteria: plan.criteria,
        outOfScope: plan.outOfScope,
        children: plannedChildren(plan),
      });
      return this.writeOutSteps(created.id, scout.id);
    });
    let auto = false;
    if (
      store.working &&
      isAutoAcceptable(iterationKind(iteration.children), cfg.auto_accept) &&
      mayAutoAccept(store, repo, cfg)
    ) {
      try {
        this.acceptWhole(iteration.id, repo, cfg, true);
        auto = true;
      } catch (err) {
        this.report(err);
      }
    }
    return { id: iteration.id, auto };
  }

  /**
   * Change the plan of the repo's iteration under way as a scout says (`recordAdjustment`: the
   * steps added, the ones they replace marked, the closing step waiting for them, the note kept),
   * the proposals of the steps added and the dependencies rewritten (writeOutSteps), in one
   * transaction. While the work switch is on, a step that may start now (one replacing the step
   * that blocked the iteration) becomes a Run at once; otherwise at a later poll.
   */
  private adjustIteration(
    scout: Scout,
    repo: Repo,
    cfg: BacklogRepoConfig,
    iteration: Iteration,
    update: IterationUpdate,
  ): void {
    if (iteration.source !== 'local') return;
    const store = this.deps.store;
    store.tx(() => {
      recordAdjustment(store, iteration.id, repo.name, update, scout.id);
      this.writeOutSteps(iteration.id, scout.id);
    });
    if (!store.working) return;
    try {
      this.advance(repo, cfg, iteration.id, true);
    } catch (err) {
      this.report(err);
    }
  }

  // ---- scouting ----------------------------------------------------------------

  /** Start a scout of a repo of backlog.repos; it runs in the background. */
  async startScout(name: string, trigger: Scout['trigger']): Promise<Scout> {
    const { repo, cfg } = this.repoSetup(name);
    return this.deps.scouting.startScout(this.source, repo, cfg, trigger);
  }

  /**
   * The local backlog as where the scouts' proposals go: each proposal becomes a row of the
   * proposals table, an iteration a record with one such row per step, and the scout is shown the
   * repo's proposals (see localProposalDigest).
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
    fileIteration: async (scout, repo, cfg, plan) => this.fileIteration(scout, repo, cfg, plan),
    adjustIteration: async (scout, repo, cfg, iteration, update) =>
      this.adjustIteration(scout, repo, cfg, iteration, update),
    holdingProposals: async (repo, cfg) => this.waitingForHuman(repo, cfg),
    awaitingRedo: (repo) => this.awaitingRedo(repo),
  };

  /**
   * How many proposals waiting for a human hold the automatic scout back (`holdsScout`): those of
   * their own, and each iteration waiting as a whole, as the kind auto-accept judges it by
   * (`iterationKind`). The steps of an iteration go with it and do not count.
   */
  private waitingForHuman(repo: Repo, cfg: BacklogRepoConfig): number {
    const proposals = this.deps.store
      .listProposals({ repoId: repo.id, status: 'pending' })
      .filter((p) => p.iterationId === null && holdsScout(p, cfg.auto_accept)).length;
    const iterations = this.localIterations(repo, 'pending').filter((it) =>
      holdsScout(iterationKind(it.children), cfg.auto_accept),
    ).length;
    return proposals + iterations;
  }

  /**
   * The repo's proposals for the scout's prompt, with the Runs the accepted ones became, and its
   * iterations: the steps of the one under way are left to the iteration's own digest.
   */
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
    return localProposalDigest(
      store.listProposals({ repoId: repo.id }),
      runOf,
      this.localIterations(repo),
    );
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
        // An iteration waiting is one, its steps none.
        pendingProposals: repo
          ? store
              .listProposals({ repoId: repo.id, status: 'pending' })
              .filter((p) => p.iterationId === null).length +
            this.localIterations(repo, 'pending').length
          : 0,
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
