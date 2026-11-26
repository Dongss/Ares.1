// How a workflow template flows: which template a repo's Runs get by id (the home directory's or
// the repo's own), effective stage settings, budgets, verify commands, rollback targets, which
// agents a stage may run with and which of them does its work by the requirement's difficulty,
// which stage rounds are split into tasks and whether a template can split an L requirement at
// all; also the overrides of Runs from issues, which proposals are accepted
// automatically, how long the automatic scout backs off and which Runs it waits for, after how
// many failed scouts in a row a human is notified, how long a failed Run of an issue or a local
// proposal waits before it is redone, how long a Run or a scout waits for an agent that is out of
// quota or rate-limited,
// how long the raw output of agents is kept, which worktrees of failed or cancelled Runs of
// issues are left over for the Master to remove, where a repo's requirements come from (GitHub
// or the local backlog), whether a repo delivers through pull requests, how many Runs may
// execute across every repo (`concurrency.max_runs`), and the rules of iterations: how many
// children one plans at most, the kind auto-accept judges one by as a whole, which children a
// child waits for, its progress and where it stands.
// Pure logic (type imports, src/i18n.ts, src/store/types.ts and src/engine/discussion.ts only),
// so the dashboard shows the same rules the engine applies.

import { replyDeadline } from '../engine/discussion.js';
import { t } from '../i18n.js';
import {
  type Attempt,
  type Difficulty,
  type EventRow,
  FINISHED_RUN_STATUSES,
  type IterationChild,
  type IterationStatus,
  type Proposal,
  REQUIREMENT_SIZES,
  type RequirementSize,
  type Run,
  type Scout,
} from '../store/types.js';
import type {
  AgentConfig,
  BacklogConfig,
  Escalate,
  GitHubConfig,
  RunOverrides,
  StageDef,
  WorkflowTemplate,
} from './schema.js';

/** Risk of a proposal, ordered; auto-accept takes everything up to a chosen level. */
export const RISKS = ['low', 'mid', 'high'] as const;
export type Risk = (typeof RISKS)[number];

/**
 * Size of a proposal, ordered and judged by scope (`sizeMeanings`): the same letters, with the
 * same meanings, as the size a requirement assessment gives.
 */
export const PROPOSAL_SIZES = REQUIREMENT_SIZES;
export type ProposalSize = RequirementSize;

/**
 * What each size means, by scope. The one definition the scout's output format, the requirement
 * assessment's prompt and the Run detail page all show, so the scout and the assessment judge a
 * requirement the same way. Lower case and without end punctuation, for callers to put in a list
 * or a sentence.
 */
export function sizeMeanings(): Record<ProposalSize, string> {
  return t({
    zh: {
      S: '一处小改动，比如改一个函数、一段文字或一项配置',
      M: '不用拆分、一次就能做完的普通需求',
      L: '要改多个模块、一次做完容易超时或返工的需求，可能先拆成几步，再一步一步做',
    },
    en: {
      S: 'one small change, such as a function, a passage of text or a setting',
      M: 'an ordinary requirement done in one go, without splitting it',
      L: 'changes across several modules, likely to time out or need rework when done in one go, so it may be split into steps done one after another',
    },
  });
}

/**
 * What each difficulty means (`DIFFICULTIES`). The one definition the requirement assessment's
 * prompt and the Run detail page both show. Lower case and without end punctuation, for callers
 * to put in a list or a sentence.
 */
export function difficultyMeanings(): Record<Difficulty, string> {
  return t({
    zh: {
      low: '局部的小改动，比如改一处文案、补测试',
      mid: '跨模块的行为改动',
      high: '涉及核心的状态机、git 操作、数据库迁移，或者对正确性要求很高的改动',
    },
    en: {
      low: 'a small, local change, such as rewording some text or adding tests',
      mid: 'a change of behavior across modules',
      high: 'changes to a core state machine, git operations or database migrations, or work that has to be exactly right',
    },
  });
}

/** What auto-accept looks at in a proposal. */
export interface ProposalKind {
  risk: Risk;
  size: ProposalSize;
}

/**
 * How far auto-accept goes: the keys of a repo's `auto_accept` setting, so its config is passed
 * as it is.
 */
export interface AutoAcceptLimits {
  max_risk: Risk | 'none';
  max_size: ProposalSize;
}

/** Whether a kind of proposal is accepted without a human under the `auto_accept` limits. */
export type AutoAcceptRule = (p: ProposalKind, limits: AutoAcceptLimits) => boolean;

/**
 * Auto-accept what is within both limits: risk up to `max_risk` and size up to `max_size`.
 * `max_risk: none` accepts nothing, whatever the size.
 */
export const isAutoAcceptable: AutoAcceptRule = (p, limits) => {
  if (limits.max_risk === 'none') return false;
  return (
    RISKS.indexOf(p.risk) <= RISKS.indexOf(limits.max_risk) &&
    PROPOSAL_SIZES.indexOf(p.size) <= PROPOSAL_SIZES.indexOf(limits.max_size)
  );
};

/**
 * Whether size L proposals are accepted without a human at all (those of low risk, so whatever
 * risk `max_risk` allows): false with `max_risk: none` or a `max_size` below L. The config warning
 * about templates that cannot split L and the scout's prompt both go by it.
 */
export function autoAcceptsL(limits: AutoAcceptLimits): boolean {
  return isAutoAcceptable({ risk: 'low', size: 'L' }, limits);
}

/**
 * Whether a proposal waiting for a human holds the automatic scout back, once max_proposals of
 * them do; the same for every source of requirements (GitHub issues, the local backlog). Without
 * auto-accept (`max_risk: none`), every one does: a human decides them all. With it, only those
 * auto-accept would take but has not yet (today's count is used up), and those of an unknown kind
 * (`p` null: no scout record), to stay safe. Proposals beyond what auto-accept takes (over
 * `max_size` or `max_risk`) still wait for a human, but would otherwise stop the system for good,
 * so they do not count; the scout sees them among the requirements there are and does not propose
 * them again.
 */
export function holdsScout(p: ProposalKind | null, limits: AutoAcceptLimits): boolean {
  if (limits.max_risk === 'none') return true;
  return !p || isAutoAcceptable(p, limits);
}

/**
 * Every kind of proposal (risk × size), split into those the Master accepts by itself under
 * `limits` and those left to a human. `rule` is the auto-accept rule; tests may pass another.
 */
export function acceptSplit(
  limits: AutoAcceptLimits,
  rule: AutoAcceptRule = isAutoAcceptable,
): { auto: ProposalKind[]; human: ProposalKind[] } {
  const auto: ProposalKind[] = [];
  const human: ProposalKind[] = [];
  for (const risk of RISKS) {
    for (const size of PROPOSAL_SIZES) {
      (rule({ risk, size }, limits) ? auto : human).push({ risk, size });
    }
  }
  return { auto, human };
}

/**
 * The most children one iteration plans, whatever a repo's `max_proposals`: a goal that needs
 * more is too large for one iteration and is narrowed down instead.
 */
export const MAX_ITERATION_CHILDREN = 8;

/**
 * The statuses of an iteration that is not over yet: waiting to be accepted, under way, or
 * blocked. A repo has at most one such iteration at a time; while it has one, the scout plans no
 * other.
 */
export const ITERATION_OPEN_STATUSES: readonly IterationStatus[] = ['pending', 'active', 'blocked'];

/**
 * An iteration as auto-accept judges it, as a whole: the highest risk and the largest size of its
 * children, compared with `auto_accept` by `isAutoAcceptable` like a single proposal. A plan
 * without children counts as the smallest kind.
 */
export function iterationKind(children: readonly ProposalKind[]): ProposalKind {
  let risk = 0;
  let size = 0;
  for (const child of children) {
    risk = Math.max(risk, RISKS.indexOf(child.risk));
    size = Math.max(size, PROPOSAL_SIZES.indexOf(child.size));
  }
  return { risk: RISKS[risk] as Risk, size: PROPOSAL_SIZES[size] as ProposalSize };
}

/** What the dependency rules look at in a child of an iteration. */
export type ChildDependency = Pick<IterationChild, 'position' | 'dependsOn'>;
export type ChildPlace = Pick<IterationChild, 'position' | 'status' | 'replacedBy'>;

/**
 * The positions a child really waits for: a child it depends on that was replaced stands for the
 * one that replaced it (followed as far as replacements go), so the plan goes on with the new
 * approach. Positions not in the plan, the child itself and repeats are left out, so a slip in a
 * plan cannot hold a child back for good.
 */
export function effectiveDependencies(
  child: ChildDependency,
  children: readonly Pick<IterationChild, 'position' | 'replacedBy'>[],
): number[] {
  const byPosition = new Map(children.map((c) => [c.position, c]));
  const result: number[] = [];
  for (const dep of child.dependsOn) {
    let at = dep;
    const seen = new Set<number>();
    while (!seen.has(at)) {
      seen.add(at);
      const next = byPosition.get(at)?.replacedBy;
      if (next === undefined) break;
      at = next;
    }
    if (!byPosition.has(at) || at === child.position || result.includes(at)) continue;
    result.push(at);
  }
  return result;
}

/** The positions a child still waits for: its effective dependencies that are not done. */
export function unmetDependencies(
  child: ChildDependency,
  children: readonly ChildPlace[],
): number[] {
  const byPosition = new Map(children.map((c) => [c.position, c]));
  return effectiveDependencies(child, children).filter((p) => byPosition.get(p)?.status !== 'done');
}

/**
 * Whether a child of an accepted iteration may start now (a Run be created for it): it waits for
 * nothing more (`waiting`, or already `ready`), was not replaced, and every child it depends on
 * is done.
 */
export function childReady(
  child: ChildDependency & ChildPlace,
  children: readonly ChildPlace[],
): boolean {
  return (
    (child.status === 'waiting' || child.status === 'ready') &&
    child.replacedBy === undefined &&
    unmetDependencies(child, children).length === 0
  );
}

/**
 * How far an iteration got: its children that are done, of all of them. Children that were
 * replaced are not counted; the ones that replaced them are.
 */
export function iterationProgress(children: readonly ChildPlace[]): {
  done: number;
  total: number;
} {
  const counted = children.filter((c) => c.replacedBy === undefined);
  return { done: counted.filter((c) => c.status === 'done').length, total: counted.length };
}

/**
 * Where an accepted iteration stands by its children: done once every child is (those replaced
 * aside), blocked while a child failed or was dropped and nothing replaced it, otherwise active.
 * Whether it is accepted (pending) or turned down (cancelled) is a human's decision, not its
 * children's. A plan without children is done: nothing is left to do, and the repo can go on.
 */
export function iterationStatusOf(
  children: readonly ChildPlace[],
): Extract<IterationStatus, 'active' | 'blocked' | 'done'> {
  const counted = children.filter((c) => c.replacedBy === undefined);
  if (counted.every((c) => c.status === 'done')) return 'done';
  if (counted.some((c) => c.status === 'failed' || c.status === 'dropped')) return 'blocked';
  return 'active';
}

export const SYSTEM_DEFAULTS = {
  escalate: {
    max_retries: 2,
    // Nobody has to be there: retry, then another agent, then the Run ends as failed.
    on_agent_error: 'switch_agent',
    // Over budget: the Run ends as failed rather than waiting for a human to raise the budget, so
    // nothing stops while nobody is around. A Run from an issue or a local proposal of its own is
    // redone, within max_run_attempts and daily_budget_usd, so spending stays bounded.
    on_budget_exceeded: 'abort',
    // Out of reworks or rollbacks: the Run ends as failed, so an issue is redone with the reason
    // and nothing waits for a human.
    on_exhausted: 'fail',
  } satisfies Required<Escalate>,
  max_loops: 3,
  /** How long an assess stage waits for a reply to its questions when it does not say. */
  reply_timeout_hours: 24,
};

export interface EffectiveStage {
  def: StageDef;
  gate: boolean;
  escalate: Required<Escalate>;
}

/** Resolve a stage's effective settings: system default → template → stage → run override. */
export function effectiveStage(
  template: WorkflowTemplate,
  stageId: string,
  overrides: RunOverrides,
): EffectiveStage {
  const def = template.stages.find((s) => s.id === stageId);
  if (!def) {
    throw new Error(
      t({
        zh: `模板 ${template.id} 中没有阶段 ${stageId}`,
        en: `Template ${template.id} has no stage ${stageId}`,
      }),
    );
  }
  const o = overrides.stages?.[stageId];
  return {
    def,
    gate: o?.gate ?? def.gate,
    escalate: {
      ...SYSTEM_DEFAULTS.escalate,
      ...stripUndefined(template.defaults?.escalate),
      ...stripUndefined(def.escalate),
      ...stripUndefined(o?.escalate),
    },
  };
}

export function effectiveMaxLoops(template: WorkflowTemplate, overrides: RunOverrides): number {
  return overrides.max_loops ?? template.defaults?.max_loops ?? SYSTEM_DEFAULTS.max_loops;
}

/**
 * What happens when a Run rolls back past max_loops: the template's `defaults.escalate.
 * on_exhausted`, else the system default. A rollback belongs to no single stage, so stage
 * settings do not apply, just as max_loops itself is set for the whole Run.
 */
export function loopsExhausted(template: WorkflowTemplate): Required<Escalate>['on_exhausted'] {
  return template.defaults?.escalate?.on_exhausted ?? SYSTEM_DEFAULTS.escalate.on_exhausted;
}

/**
 * How many hours an assess stage waits for a human to reply to its questions before the
 * assessment decides on its own: the stage's `reply_timeout_hours`, else the system default.
 * 0 = it does not wait; null = it waits however long it takes.
 */
export function replyTimeoutHours(def: StageDef): number | null {
  return def.reply_timeout_hours === undefined
    ? SYSTEM_DEFAULTS.reply_timeout_hours
    : def.reply_timeout_hours;
}

/**
 * When a Run blocked on the assessment's questions stops waiting for a reply and the assessment
 * decides on its own: the latest round's questions plus the assess stage's `replyTimeoutHours`
 * (`replyDeadline`, epoch milliseconds). null when the Run does not wait for a reply, its stage
 * waits however long it takes, or the discussion no longer ends with the questions: then only a
 * human moves it on. `stageIdOf` gives the stage of one of the Run's stage runs.
 */
export function discussionReplyWait(
  run: Pick<Run, 'status' | 'blocked' | 'discussion' | 'template'>,
  stageIdOf: (stageRunId: string) => string | undefined,
): { deadline: number; hours: number } | null {
  const info = run.blocked;
  if (run.status !== 'blocked' || info?.kind !== 'discussion' || !info.stageRunId) return null;
  const stageId = stageIdOf(info.stageRunId);
  const def = run.template.stages.find((s) => s.id === stageId);
  const hours = def ? replyTimeoutHours(def) : null;
  const deadline = replyDeadline(run.discussion, hours);
  return hours === null || deadline === null ? null : { deadline, hours };
}

/** A repo's Runs that are not done with, by whether they go on without a human. */
export interface UnfinishedRuns<R> {
  /**
   * They go on by themselves: queued, running, waiting for a reply to the assessment's
   * questions that times out (`discussionReplyWait`), or waiting for uncommitted changes on the
   * target branch to go away (`target_dirty`): nobody has to decide anything for those, they
   * only pause while a human's changes are in the way, and the engine merges them once the
   * changes are committed or discarded.
   */
  moving: R[];
  /**
   * Failed Runs whose issue waits to be redone (`awaitingRedo`): they go on by themselves too,
   * as a new Run once the wait before the redo (`redoDueAt`) is over. Never stuck.
   */
  redo: R[];
  /**
   * Only a human moves them on: every other blocked Run, paused Runs, Runs waiting for approval.
   */
  stuck: R[];
}

/**
 * Split a repo's Runs that are not done with by whether they go on without a human. The
 * automatic scout waits for the moving ones and for the redos to come, as their results change
 * what is worth doing next. The stuck ones would hold it for good when nobody is there, so they
 * count toward `max_proposals` together with the proposals waiting for a human instead: work left
 * for a human is still capped, but no longer stops the repo. Other finished Runs are left out.
 */
export function splitUnfinishedRuns<
  R extends Pick<Run, 'status' | 'blocked' | 'discussion' | 'template' | 'issue'>,
>(runs: readonly R[], stageIdOf: (stageRunId: string) => string | undefined): UnfinishedRuns<R> {
  const split: UnfinishedRuns<R> = { moving: [], redo: [], stuck: [] };
  for (const run of runs) {
    if (awaitingRedo(run)) {
      split.redo.push(run);
      continue;
    }
    if (FINISHED_RUN_STATUSES.includes(run.status)) continue;
    const moving =
      run.status === 'queued' ||
      run.status === 'running' ||
      (run.status === 'blocked' && run.blocked?.kind === 'target_dirty') ||
      discussionReplyWait(run, stageIdOf) !== null;
    (moving ? split.moving : split.stuck).push(run);
  }
  return split;
}

/** The Run's budget in USD: run override → template default; undefined = no budget. */
export function effectiveBudget(
  template: WorkflowTemplate,
  overrides: RunOverrides,
): number | undefined {
  return overrides.budget_usd ?? template.defaults?.budget_usd;
}

/**
 * Whether a Run over its budget waits for a human to raise it (`on_budget_exceeded: pause`) in
 * some stage, rather than ending as failed. Only stages that run an agent count: the budget is
 * checked before an agent runs.
 */
export function budgetPauses(template: WorkflowTemplate, overrides: RunOverrides): boolean {
  return template.stages.some(
    (s) =>
      runsAgent(s.kind) &&
      effectiveStage(template, s.id, overrides).escalate.on_budget_exceeded === 'pause',
  );
}

/**
 * Whether a round of the stage first splits it into tasks (a plan task, then one work task per
 * step) rather than doing it as one task: agent stages with `planning: llm` always; with
 * `planning: auto` only when the requirement's assessed size (`assessedSize`) is L, as splitting
 * a smaller one only costs more. Without an assessment, or one that gave no size, it is not split.
 */
export function plansStage(
  def: Pick<StageDef, 'kind' | 'planning'>,
  size: RequirementSize | undefined,
): boolean {
  if (def.kind !== 'agent') return false;
  return def.planning === 'llm' || (def.planning === 'auto' && size === 'L');
}

/**
 * Whether the template can split an L requirement into steps done one after another in one Run:
 * some agent stage plans (`planning: auto` or `llm`, so `plansStage` splits it for an L). Without
 * one, an L requirement goes to one Run as a whole. The config warning about auto-accepting L and
 * the scout's prompt both go by it.
 */
export function templateSplits(template: Pick<WorkflowTemplate, 'stages'>): boolean {
  return template.stages.some((s) => plansStage(s, 'L'));
}

const LEVEL_RANKS = { low: 0, mid: 1, high: 2 } as const;

/**
 * Rank of a level, low < mid < high: the levels of an agent's tier and cost (agents.yaml) and of
 * a requirement's difficulty (`DIFFICULTIES`), so they compare with each other.
 */
export function levelRank(level: Difficulty | AgentConfig['tier'] | AgentConfig['cost']): number {
  return LEVEL_RANKS[level];
}

/**
 * The agents a stage may run with, in the template's order: its `agent_candidates` when it has
 * them, otherwise its one `agent`; empty when it has neither (merge, placeholder and command
 * stages).
 */
export function stageAgentIds(def: Pick<StageDef, 'agent' | 'agent_candidates'>): string[] {
  if (def.agent_candidates) return [...def.agent_candidates];
  return def.agent ? [def.agent] : [];
}

/**
 * Why `chooseStageAgent` chose its agent: `first` = the Run has no difficulty, so the first
 * usable candidate; `fit` = the cheapest whose tier is at least the difficulty; `highest` = no
 * candidate's tier is that high, so the highest tier.
 */
export type StageAgentReason = 'first' | 'fit' | 'highest';

/**
 * What the engine records when a round of a stage with `agent_candidates` starts (event
 * `agent.selected`): who it gave the round to and why. `unavailable` = no candidate could run the
 * stage, so it went to the first one, whose task then goes the way of an agent that cannot run
 * (by `on_agent_error`). A type alias rather than an interface, so that it passes as event data
 * (`Record<string, unknown>`).
 */
export type AgentSelection = {
  stageId: string;
  round: number;
  taskId: string;
  agentId: string;
  difficulty: Difficulty | null;
  reason: StageAgentReason | 'unavailable';
  candidates: string[];
};

/**
 * Who does a stage's work, from its candidates (`stageAgentIds`) by the requirement's assessed
 * difficulty (`assessedDifficulty`). Only candidates that are enabled (in `agents`, which holds
 * enabled agents only) and that `usable` says can run the stage count; undefined when none does.
 * Without a difficulty (no assess stage, an assessment that gave none or was recorded before
 * assessments gave one) it is the first of them in the list. With one, it is the cheapest of
 * those whose tier is at least the difficulty, equal costs going by the list's order; when no
 * tier is that high, the highest tier, then the cheapest, then the list's order. Only `tier` and
 * `cost` of the agents are read.
 */
export function chooseStageAgent(
  candidates: readonly string[],
  agents: ReadonlyMap<string, Pick<AgentConfig, 'id' | 'tier' | 'cost'>>,
  difficulty: Difficulty | undefined,
  usable: (id: string) => boolean,
): { id: string; reason: StageAgentReason } | undefined {
  const available = candidates.flatMap((id) => {
    const agent = agents.get(id);
    return agent && usable(id) ? [agent] : [];
  });
  const [first] = available;
  if (!first) return undefined;
  if (difficulty === undefined) return { id: first.id, reason: 'first' };
  type Candidate = (typeof available)[number];
  const byCost = (a: Candidate, b: Candidate) => levelRank(a.cost) - levelRank(b.cost);
  // Array.prototype.sort is stable: equal ranks keep the list's order.
  const fit = available.filter((a) => levelRank(a.tier) >= levelRank(difficulty)).sort(byCost)[0];
  if (fit) return { id: fit.id, reason: 'fit' };
  const highest =
    [...available].sort((a, b) => levelRank(b.tier) - levelRank(a.tier) || byCost(a, b))[0] ??
    first;
  return { id: highest.id, reason: 'highest' };
}

/**
 * Where a registered repo keeps its own workflow templates, from its root; they are read as
 * committed on its target branch.
 */
export const REPO_WORKFLOWS_DIR = '.ares1/workflows';

/** Where a template comes from: the home directory's workflows/, or the repo's own. */
export type TemplateSource = 'home' | 'repo';

/**
 * The template a repo's Runs get by id: the home directory's first, as this machine's override
 * of the repo's, then the repo's own (`repo`: the templates of that repo only, so no repo sees
 * another's). Null when neither has it.
 */
export function resolveTemplate<T>(
  id: string,
  home: ReadonlyMap<string, T>,
  repo: ReadonlyMap<string, T> | undefined,
): { template: T; source: TemplateSource } | null {
  const fromHome = home.get(id);
  if (fromHome !== undefined) return { template: fromHome, source: 'home' };
  const fromRepo = repo?.get(id);
  if (fromRepo !== undefined) return { template: fromRepo, source: 'repo' };
  return null;
}

/**
 * Stage kinds an agent runs in. In merge, placeholder and command stages the Master does the work
 * itself, so nothing there errors, is reworked or checks the budget.
 */
export function runsAgent(kind: StageDef['kind']): boolean {
  return kind === 'agent' || kind === 'review' || kind === 'assess';
}

/**
 * Whether the repo delivers its Runs' work through pull requests (`deliver: pr`): the merge stage
 * then leaves the local target branch alone and the Run waits for its pull request on GitHub
 * (`pr_open`). Goes by what config.yaml says, also when push is off, which disables the repo for
 * GitHub: its Runs then wait at the merge until the configuration is fixed, rather than merge
 * locally what was meant to go through a pull request.
 */
export function deliversByPr(
  github: Pick<GitHubConfig, 'repos'> | undefined,
  repoName: string,
): boolean {
  return github?.repos[repoName]?.deliver === 'pr';
}

/**
 * Where a repo's requirements come from: GitHub issues (`github.repos`), the local backlog
 * (`backlog.repos`), or neither (null). A repo in both is a configuration error that disables
 * only its backlog entry, so GitHub keeps it.
 */
export function requirementSource(
  master: {
    github?: Pick<GitHubConfig, 'repos'> | undefined;
    backlog?: Pick<BacklogConfig, 'repos'> | undefined;
  },
  repoName: string,
): 'github' | 'backlog' | null {
  if (master.github && Object.hasOwn(master.github.repos, repoName)) return 'github';
  if (master.backlog && Object.hasOwn(master.backlog.repos, repoName)) return 'backlog';
  return null;
}

/**
 * Whether one more Run may start while `executing` Runs execute across every repo, under
 * config.yaml's `concurrency.max_runs` (undefined or null = no limit). Executing Runs count as
 * for `concurrency.per_repo`: every Run the engine drives, those waiting to retry after an agent
 * error and those waiting for their repo's merge lock included; queued Runs (also those waiting
 * for their agent's quota), Runs waiting for approval, blocked and paused Runs do not. Lowering
 * the limit stops no executing Run: no new one starts until fewer execute.
 */
export function roomUnderMaxRuns(executing: number, maxRuns: number | null | undefined): boolean {
  return maxRuns === undefined || maxRuns === null || executing < maxRuns;
}

/**
 * Whether a queued Run waits for room under `concurrency.max_runs`: that many Runs execute across
 * every repo (`roomUnderMaxRuns`). A Run waiting for its agent's quota (`rateLimited`) waits for
 * that first, so it is not said to wait for this. The Run may wait for room in its own repo
 * (`concurrency.per_repo`) as well.
 */
export function waitsForMaxRuns(
  run: Pick<Run, 'status'>,
  rateLimited: boolean,
  executing: number,
  maxRuns: number | null | undefined,
): boolean {
  return run.status === 'queued' && !rateLimited && !roomUnderMaxRuns(executing, maxRuns);
}

/**
 * The most paths an assessment may name as the ones a Run expects to change (its `touches`).
 * More are cut off rather than rejected: a long list is still useful, and an assessment should
 * not fail over it. Twenty is enough to name the directories of a change that spans the repo.
 */
export const MAX_TOUCHES = 20;

/**
 * Normalizes the paths an assessment says a Run expects to change into repo-relative paths that
 * `touchesOverlap` can compare segment by segment. Each item is trimmed, `\` becomes `/`, empty
 * and `.` segments go (so leading `./`, repeated `/` and a trailing `/` do too); an item that is
 * then empty, absolute (`/…`, or a drive such as `C:` / `C:/`) or has a `..` segment is dropped,
 * since it names nothing inside the repo, or something outside it. Duplicates keep their first
 * place, and the first `MAX_TOUCHES` stay. Agents write these by hand, so the list is cleaned
 * rather than failing the assessment. Nothing left (or no list) gives undefined: the Run then has
 * no touches and never counts as conflicting with another, as before touches existed.
 */
export function normalizeTouches(raw: readonly string[] | undefined): string[] | undefined {
  if (!raw) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const path = normalizeTouch(item);
    if (path === null || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length === MAX_TOUCHES) break;
  }
  return out.length > 0 ? out : undefined;
}

/** One item of `normalizeTouches`, or null when it is dropped. */
function normalizeTouch(item: string): string | null {
  const path = item.trim().replace(/\\/g, '/');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return null;
  const segments = path.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0 || segments.includes('..')) return null;
  return segments.join('/');
}

/** Whether every segment of `dir` begins `path`: the same path, or one of its directories. */
function containsPath(dir: readonly string[], path: readonly string[]): boolean {
  return dir.length <= path.length && dir.every((segment, i) => segment === path[i]);
}

/**
 * The paths where two Runs' touches (as `normalizeTouches` leaves them) overlap; empty when they
 * do not. Two paths overlap when they are the same or one is a directory of the other, compared
 * by `/` segments, so `src/a` and `src/ab` do not overlap while `src` and `src/a` do. Of an
 * overlapping pair the more specific path is given (`src/a` there), as it says best where the two
 * Runs meet. The result has no duplicates and follows the order of `a`. A side without touches
 * (no assessment stage, or the assessment named none) overlaps nothing: such a Run is scheduled
 * as before touches existed.
 */
export function touchesOverlap(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): string[] {
  if (!a?.length || !b?.length) return [];
  const others = b.map((path) => ({ path, segments: path.split('/') }));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of a) {
    const segments = path.split('/');
    for (const other of others) {
      let deeper: string | null = null;
      if (containsPath(segments, other.segments)) deeper = other.path;
      else if (containsPath(other.segments, segments)) deeper = path;
      if (deeper === null || seen.has(deeper)) continue;
      seen.add(deeper);
      out.push(deeper);
    }
  }
  return out;
}

/** A Run's id and the paths it expects to change (`normalizeTouches`), if its assessment said. */
export interface RunTouches {
  runId: string;
  touches: readonly string[] | undefined;
}

/** The Run another one waits for, and the paths both expect to change (`touchesOverlap`). */
export interface ConflictBlock {
  runId: string;
  paths: string[];
}

/**
 * Which of `others` (Runs executing in the same slot that are past their assessment and not yet
 * past their merge) keeps a Run with these `touches` from going on, so that two Runs expected to
 * change the same place do not work at once and then conflict at the merge: the first in order
 * that overlaps it (`touchesOverlap`), with the overlapping paths. Runs in `outlasted` are passed
 * over: the Run has already waited for one of their merges, and waiting on the same Run again
 * could starve it. A Run without touches is held back by none (null), and so is one that overlaps
 * nothing.
 */
export function conflictBlocker(
  touches: readonly string[] | undefined,
  others: readonly RunTouches[],
  outlasted: ReadonlySet<string>,
): ConflictBlock | null {
  if (!touches?.length) return null;
  for (const other of others) {
    if (outlasted.has(other.runId)) continue;
    const paths = touchesOverlap(touches, other.touches);
    if (paths.length > 0) return { runId: other.runId, paths };
  }
  return null;
}

/**
 * Overrides of a Run created from a GitHub issue: with `auto_merge` the approvals
 * of the merge stages are off; other approval points of the template stay. The dashboard's guide
 * shows the same rule.
 */
export function issueRunOverrides(
  template: WorkflowTemplate | undefined,
  autoMerge: boolean,
): RunOverrides | undefined {
  const merges = (template?.stages ?? []).filter((st) => st.kind === 'merge');
  if (!autoMerge || merges.length === 0) return undefined;
  return { stages: Object.fromEntries(merges.map((st) => [st.id, { gate: false }])) };
}

/** An exponential backoff: the first wait, doubled on each further retry up to the longest. */
export interface Backoff {
  firstMs: number;
  maxMs: number;
}

/** The wait before the `retry`-th retry (1 = the first). */
export function backoffMs(backoff: Backoff, retry: number): number {
  return Math.min(backoff.firstMs * 2 ** Math.max(0, retry - 1), backoff.maxMs);
}

/** The longest a failed Run of an issue or a local proposal waits before it is redone. */
export const REDO_BACKOFF_MAX_HOURS = 2;

/**
 * How long a requirement (an issue, or a local proposal) waits after its `attempt`-th Run (1 =
 * the first) failed before the next attempt starts: poll_minutes × 2^(attempt-1), at most
 * REDO_BACKOFF_MAX_HOURS. A passing outage of the agents' API or of the network fails every agent
 * at once, retries and switching agents included; without a wait the attempts would be used up
 * within minutes and the requirement given up. A failure the code itself brings about every time
 * only ends a little later: the attempts and their cost stay the same.
 */
export function redoDelayMs(attempt: number, pollMinutes: number): number {
  return backoffMs(
    { firstMs: pollMinutes * 60_000, maxMs: REDO_BACKOFF_MAX_HOURS * 3_600_000 },
    attempt,
  );
}

/**
 * Whether the Run failed and its issue waits for it to be redone (the issue has attempts left,
 * nobody closed it or started it over yet). Such a Run goes on by itself: the bridge redoes it
 * once `redoDueAt` has passed, the day's budget allows and the work switch is on.
 */
export function awaitingRedo(run: Pick<Run, 'status' | 'issue'>): boolean {
  return run.status === 'failed' && run.issue?.redo === 'pending';
}

/**
 * When the failed Run's issue is redone, epoch ms: `redoDelayMs` for its attempt after it ended.
 * Over the day's budget or with the work switch off it waits longer. Counted from the Run alone,
 * so it holds across Master restarts. null when it does not wait for a redo (`awaitingRedo`).
 */
export function redoDueAt(
  run: Pick<Run, 'status' | 'issue' | 'finishedAt' | 'updatedAt'>,
  pollMinutes: number,
): number | null {
  if (!awaitingRedo(run)) return null;
  return redoDueAfter(run.issue?.attempt ?? 1, run.finishedAt ?? run.updatedAt, pollMinutes);
}

/**
 * When the next attempt at a requirement whose `attempt`-th Run failed is due, epoch ms:
 * `redoDelayMs` after that Run ended (`endedAt`, ISO time). The one wait of issues
 * (`redoDueAt`) and local proposals (`proposalRedoDueAt`) alike.
 */
export function redoDueAfter(attempt: number, endedAt: string, pollMinutes: number): number {
  return Date.parse(endedAt) + redoDelayMs(attempt, pollMinutes);
}

/**
 * Whether a proposal of the local backlog waits for its failed Run to be redone: accepted, of its
 * own (the steps of an iteration are not redone), and attempts were left when its latest Run
 * failed. It goes on by itself, as a new Run once `proposalRedoDueAt` has passed, the day's
 * budget allows and the work switch is on.
 */
export function proposalAwaitingRedo(
  p: Pick<Proposal, 'status' | 'iterationId' | 'redo'>,
): boolean {
  return p.status === 'accepted' && p.iterationId === null && p.redo === 'pending';
}

/**
 * When a proposal waiting to be redone (`proposalAwaitingRedo`) gets its next attempt, epoch ms:
 * the wait of an issue (`redoDueAfter`) after its latest Run (`run`) ended, by the local
 * backlog's poll_minutes. Over the day's budget or with the work switch off it waits longer.
 * Counted from the records alone, so it holds across Master restarts. null when it does not wait
 * for a redo.
 */
export function proposalRedoDueAt(
  p: Pick<Proposal, 'status' | 'iterationId' | 'redo' | 'attempt'>,
  run: Pick<Run, 'finishedAt' | 'updatedAt'>,
  pollMinutes: number,
): number | null {
  if (!proposalAwaitingRedo(p)) return null;
  return redoDueAfter(p.attempt, run.finishedAt ?? run.updatedAt, pollMinutes);
}

/**
 * How long a Run or a scout waits when its agent is out of quota or rate-limited: until the reset
 * time the CLI gave plus `marginMs` (clocks differ, and a quota may come back a little late);
 * without one, a backoff over the limits hit in a row.
 */
export interface RateLimitWait extends Backoff {
  marginMs: number;
}

/** 5, 10, 20, 40 minutes, then hourly; one more minute after a reset time the CLI gave. */
export const RATE_LIMIT_WAIT: RateLimitWait = {
  firstMs: 300_000,
  maxMs: 3_600_000,
  marginMs: 60_000,
};

/**
 * The wait after an agent hit a limit at `now`: until `resetAt` (epoch ms, from the CLI) plus the
 * margin when it is still ahead, else the backoff for the `inARow`-th limit in a row.
 */
export function rateLimitDelayMs(
  wait: RateLimitWait,
  now: number,
  resetAt: number | undefined,
  inARow: number,
): number {
  if (resetAt !== undefined && resetAt > now) return resetAt - now + wait.marginMs;
  return backoffMs(wait, inARow);
}

/** A queued Run waiting for its agent's quota: the agent, and when the Run goes on (epoch ms). */
export interface RunLimitWait {
  agentId: string;
  until: number;
}

/**
 * The wait for its agent's quota a queued Run is in, as its events record it: read back when the
 * Master starts, so that a restart does not try the agent again before the quota is back. The
 * Run's latest `task.rate_limited` holds while
 * - the Run is still queued, and the only `run.status` after that event is the `queued` written
 *   with it: whatever lifts the wait (a pause and resume, a cancel, a retry, the Run starting
 *   again, its recovery after a restart while it ran) changes the Run's status;
 * - the latest attempt of the event's task still hit the limit;
 * - its `retryAt` (the CLI's reset time plus the margin, or the backoff) is still ahead of `now`.
 * `events`: the Run's, oldest first; `attempts`: the Run's, oldest first. null: no wait.
 */
export function recordedLimitWait(
  run: Pick<Run, 'status'>,
  events: readonly Pick<EventRow, 'type' | 'data'>[],
  attempts: readonly Pick<Attempt, 'taskId' | 'outcome'>[],
  now: number,
): RunLimitWait | null {
  if (run.status !== 'queued') return null;
  const at = events.findLastIndex((e) => e.type === 'task.rate_limited');
  const limited = events[at];
  if (!limited) return null;
  const statuses = events.slice(at + 1).filter((e) => e.type === 'run.status');
  if (statuses.length !== 1 || statuses[0]?.data.status !== 'queued') return null;
  const { taskId, agentId, retryAt } = limited.data;
  if (typeof taskId !== 'string' || typeof agentId !== 'string' || typeof retryAt !== 'string') {
    return null;
  }
  if (attempts.findLast((a) => a.taskId === taskId)?.outcome !== 'rate_limited') return null;
  const until = Date.parse(retryAt);
  if (Number.isNaN(until) || until <= now) return null;
  return { agentId, until };
}

export interface ScoutLimitWait {
  /** Scouts in a row, counting back from the newest, whose agent hit a limit. */
  count: number;
  /** When the next automatic scout may start. */
  until: string;
}

/**
 * The scout the automatic scout's wait for the quota counts from (see scoutLimitWait): the newest
 * scout that was not cut short by the Master stopping (nor is still running), when its agent hit
 * a limit. `scouts` are newest first. undefined: no wait.
 */
export function limitedScout<S extends Pick<Scout, 'status'>>(scouts: readonly S[]): S | undefined {
  for (const s of scouts) {
    if (s.status === 'interrupted' || s.status === 'running') continue;
    return s.status === 'rate_limited' ? s : undefined;
  }
  return undefined;
}

/**
 * How long the automatic scout waits after its agent ran out of quota or was rate-limited: the
 * same rule as a Run's (`rateLimitDelayMs`), counted from when the newest such scout
 * (`limitedScout`) ended. Until `resetAt` (epoch ms, the reset time the CLI gave for that scout,
 * which its `scout.rate_limited` event records) plus the margin; without one, 5, 10, 20, 40
 * minutes, then hourly over the scouts in a row that hit a limit. Only while the newest scout
 * that was not cut short by the Master stopping (nor is still running) hit a limit; a scout that
 * ends any other way ends the wait. `scouts` are newest first. null: no wait.
 */
export function scoutLimitWait(
  scouts: Pick<Scout, 'status' | 'startedAt' | 'endedAt'>[],
  resetAt?: number,
  wait: RateLimitWait = RATE_LIMIT_WAIT,
): ScoutLimitWait | null {
  const newest = limitedScout(scouts);
  if (!newest) return null;
  let count = 0;
  for (const s of scouts) {
    if (s.status === 'interrupted' || s.status === 'running') continue;
    if (s.status !== 'rate_limited') break;
    count++;
  }
  const from = Date.parse(newest.endedAt ?? newest.startedAt);
  const until = from + rateLimitDelayMs(wait, from, resetAt, count);
  return { count, until: new Date(until).toISOString() };
}

/** The longest the automatic scout backs off after scouts that found nothing or failed. */
export const MAX_SCOUT_BACKOFF_HOURS = 6;

export interface ScoutBackoff {
  /** Scouts in a row, counting back from the newest, that found nothing or failed. */
  count: number;
  /** When the next automatic scout may start. */
  until: string;
}

/**
 * How long the automatic scout backs off: scouting an unchanged repo again most likely finds
 * nothing again, at the price of a full read of the repo every poll. Counting back from the newest
 * scout (started by hand or not), k is the number of scouts in a row that failed or filed no
 * proposal (proposals that were all duplicates or could not be filed find nothing). The next one
 * may start poll_minutes × 2^(k-1) after the newest of them ended, at most
 * MAX_SCOUT_BACKOFF_HOURS.
 * - A scout that filed a proposal ends the streak: as an issue, or into the local backlog.
 * - So does a scout that wrote out an iteration, its id among `iterationScouts`.
 * - So does a scout started before `changedAt` (the target branch's latest commit): it did not
 *   see the repo as it is now.
 * - A scout cut short by the Master stopping, or still running, neither counts nor ends it.
 * - Nor does a scout whose agent ran out of quota or was rate-limited: it says nothing about the
 *   repo, and waits for the quota apart (see scoutLimitWait).
 * `scouts` are newest first. null: no streak, no back-off.
 */
export function scoutBackoff(
  scouts: (Pick<Scout, 'status' | 'proposals' | 'startedAt' | 'endedAt'> &
    Partial<Pick<Scout, 'id'>>)[],
  pollMinutes: number,
  changedAt = Number.NEGATIVE_INFINITY,
  iterationScouts: ReadonlySet<string> = new Set(),
): ScoutBackoff | null {
  let count = 0;
  let newest: (typeof scouts)[number] | undefined;
  for (const s of scouts) {
    if (s.status === 'interrupted' || s.status === 'running' || s.status === 'rate_limited') {
      continue;
    }
    if (Date.parse(s.startedAt) < changedAt) break;
    if (s.status === 'completed' && s.proposals.some((p) => p.issue || p.local)) break;
    if (s.status === 'completed' && s.id !== undefined && iterationScouts.has(s.id)) break;
    count++;
    newest ??= s;
  }
  if (!newest) return null;
  // 2^(k-1) stops mattering long before it could overflow: the wait is capped.
  const delay = Math.min(
    pollMinutes * 60_000 * 2 ** Math.min(count - 1, 30),
    MAX_SCOUT_BACKOFF_HOURS * 3_600_000,
  );
  const from = Date.parse(newest.endedAt ?? newest.startedAt);
  return { count, until: new Date(from + delay).toISOString() };
}

/**
 * Scouts failed in a row at which a human is notified: once per streak, when it reaches this many.
 * A single failure only backs off (see scoutBackoff); a scout that keeps failing (its agent's
 * config broken, its output not matching the format) would otherwise dry up the repo's new
 * requirements without anybody knowing.
 */
export const SCOUT_FAILURE_NOTIFY_AFTER = 3;

/**
 * How many scouts in a row failed, counting back from the newest (started by hand or not). A
 * completed scout ends the streak, whether it filed an issue or not: finding nothing is not
 * failing. Scouts cut short by the Master stopping, still running, or whose agent ran out of quota
 * or was rate-limited neither count nor end it, as in scoutBackoff. `scouts` are newest first.
 */
export function scoutFailureStreak(scouts: Pick<Scout, 'status'>[]): number {
  let count = 0;
  for (const s of scouts) {
    if (s.status === 'interrupted' || s.status === 'running' || s.status === 'rate_limited') {
      continue;
    }
    if (s.status !== 'failed') break;
    count++;
  }
  return count;
}

/**
 * Days the raw output of agents (the CLI's stream: `<attempt>.jsonl` and its `.stderr` for a
 * Run's executions, `scouts/<scout>.jsonl` for a scout) is kept after the Run or scout ended. It
 * holds whole tool results (files read, test output) and grows without end on a Master that never
 * stops, while the dashboard shows agent output from the normalized events kept next to it.
 */
export const RAW_LOG_KEEP_DAYS = 30;

/** Whether something that ended at `endedAt` (ISO time) did so over RAW_LOG_KEEP_DAYS before `now`. */
function endedBeforeRawLogKeep(endedAt: string | null, now: number): boolean {
  if (!endedAt) return false;
  const ended = Date.parse(endedAt);
  return Number.isFinite(ended) && ended < now - RAW_LOG_KEEP_DAYS * 86_400_000;
}

/**
 * Whether the raw logs of a Run's executions are past retention at `now` (epoch ms), so the Master
 * deletes them: the Run finished (completed, failed, cancelled or dropped) over RAW_LOG_KEEP_DAYS
 * ago. Never while it may still go on: queued, running, waiting for approval, blocked, paused, or
 * failed and waiting for its issue to be redone (`awaitingRedo`), however old.
 */
export function runRawLogsExpired(
  run: Pick<Run, 'status' | 'issue' | 'finishedAt'>,
  now: number,
): boolean {
  if (!FINISHED_RUN_STATUSES.includes(run.status) || awaitingRedo(run)) return false;
  return endedBeforeRawLogKeep(run.finishedAt, now);
}

/** Whether a scout's raw log is past retention at `now`: it ended over RAW_LOG_KEEP_DAYS ago. */
export function scoutRawLogExpired(scout: Pick<Scout, 'status' | 'endedAt'>, now: number): boolean {
  return scout.status !== 'running' && endedBeforeRawLogKeep(scout.endedAt, now);
}

/**
 * Why the Master removes the worktree and branch a failed or cancelled Run of an issue kept, as
 * its `workspace.removed` event records it: a later Run of the issue completed (`supersededBy`),
 * the issue used up its attempts and only its last attempt (`keptRun`) keeps them, or a human
 * changed the issue and a new Run (`newRun`) does the changed requirement instead.
 */
export type LeftoverWorkspaceReason =
  | { reason: 'superseded'; supersededBy: string }
  | { reason: 'retries_exhausted'; keptRun: string }
  | { reason: 'goal_changed'; newRun: string };

/** The events `leftoverWorkspaces` reads; other types are passed by. */
export const LEFTOVER_WORKSPACE_EVENTS = [
  'workspace.removed',
  'issue.retries_exhausted',
  'run.goal_changed',
] as const;

/**
 * The worktrees and branches of failed or cancelled Runs of issues that nobody needs any more,
 * oldest Run first. They are removed once, right when it is decided (a redo completed, the issue
 * used up its attempts, the issue was changed), and kept when the Master stopped before that or the
 * removal failed: so the Master looks for them again at start and daily, as nothing else would
 * while nobody is around, and every one keeps its dependencies.
 *
 * `runs` are oldest first (creation order); `events` are those of LEFTOVER_WORKSPACE_EVENTS. A Run
 * is listed when it is not recorded as removed and:
 * - failed, and a later Run of its issue completed: `superseded` by the first of those;
 * - failed, and the newest Run of its issue failed with its attempts used up (its redo is
 *   `exhausted`, or it recorded `issue.retries_exhausted`): `retries_exhausted`, kept by that one;
 * - failed, and named in the `runIds` of another Run's `issue.retries_exhausted`:
 *   `retries_exhausted`, kept by that Run (what removing them right then would have done);
 * - cancelled because a human changed its issue (`run.goal_changed`): `goal_changed`, the new Run
 *   from the event.
 *
 * Never: a Run a human cancelled (they may still want to look), Runs that may go on (any other
 * status), the last failed attempt of an issue, or Runs not from an issue. Whether the worktree
 * or branch is still there is for the caller to find out.
 */
export function leftoverWorkspaces(
  runs: readonly Pick<Run, 'id' | 'status' | 'issue'>[],
  events: readonly Pick<EventRow, 'runId' | 'type' | 'data'>[],
): { runId: string; why: LeftoverWorkspaceReason }[] {
  const removed = new Set<string>();
  /** Earlier attempt → the Run that recorded `issue.retries_exhausted` naming it. */
  const exhaustedBy = new Map<string, string>();
  const exhausted = new Set<string>();
  const goalChanged = new Map<string, string>();
  for (const e of events) {
    if (!e.runId) continue;
    if (e.type === 'workspace.removed') removed.add(e.runId);
    if (e.type === 'issue.retries_exhausted') {
      exhausted.add(e.runId);
      const ids = Array.isArray(e.data.runIds) ? e.data.runIds : [];
      for (const id of ids) {
        if (typeof id === 'string' && id !== e.runId) exhaustedBy.set(id, e.runId);
      }
    }
    if (e.type === 'run.goal_changed' && typeof e.data.newRun === 'string') {
      goalChanged.set(e.runId, e.data.newRun);
    }
  }
  const byIssue = new Map<string, Pick<Run, 'id' | 'status' | 'issue'>[]>();
  for (const run of runs) {
    if (!run.issue) continue;
    const key = `${run.issue.repo}#${run.issue.number}`;
    const list = byIssue.get(key);
    if (list) list.push(run);
    else byIssue.set(key, [run]);
  }
  const leftovers: { runId: string; why: LeftoverWorkspaceReason }[] = [];
  for (const issueRuns of byIssue.values()) {
    const newest = issueRuns[issueRuns.length - 1];
    const kept =
      newest?.status === 'failed' &&
      (newest.issue?.redo === 'exhausted' || exhausted.has(newest.id))
        ? newest.id
        : undefined;
    const found: { runId: string; why: LeftoverWorkspaceReason }[] = [];
    // Newest first, so the first completed Run after each one is known when it is reached.
    let completedAfter: string | undefined;
    for (let i = issueRuns.length - 1; i >= 0; i--) {
      const run = issueRuns[i] as Pick<Run, 'id' | 'status' | 'issue'>;
      if (run.status === 'completed') {
        completedAfter = run.id;
        continue;
      }
      if (removed.has(run.id)) continue;
      let why: LeftoverWorkspaceReason | undefined;
      if (run.status === 'failed') {
        const keptBy = exhaustedBy.get(run.id);
        if (completedAfter) why = { reason: 'superseded', supersededBy: completedAfter };
        else if (kept && kept !== run.id) why = { reason: 'retries_exhausted', keptRun: kept };
        else if (keptBy) why = { reason: 'retries_exhausted', keptRun: keptBy };
      } else if (run.status === 'cancelled') {
        const newRun = goalChanged.get(run.id);
        if (newRun) why = { reason: 'goal_changed', newRun };
      }
      if (why) found.push({ runId: run.id, why });
    }
    leftovers.push(...found.reverse());
  }
  return leftovers;
}

function stripUndefined<T extends object>(obj: T | undefined): Partial<T> {
  if (!obj) return {};
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Stage kinds that change no code, so they run no verify commands. */
export function runsNoCommands(kind: StageDef['kind']): boolean {
  return kind === 'review' || kind === 'placeholder' || kind === 'assess';
}

/**
 * Verify commands a stage runs: its own `verify.commands`, otherwise the repo default.
 * Review, assess and placeholder stages run none (they change no code; the reviewer's verdict is
 * the review's check); merge stages run them only after bringing in new commits from the target
 * branch; command stages run them and nothing else.
 */
export function stageVerifyCommands(def: StageDef, repoDefault: string[]): string[] {
  if (runsNoCommands(def.kind)) return [];
  return def.verify?.commands ?? repoDefault;
}

/**
 * Where a failed / rejected stage rolls back to when the template does not say.
 * agent stage → itself; any other stage (review, merge, command, placeholder, assess) → the
 * nearest earlier agent stage, or itself when there is none.
 */
export function defaultRollbackTarget(template: WorkflowTemplate, stageId: string): string {
  const idx = template.stages.findIndex((s) => s.id === stageId);
  const stage = template.stages[idx];
  if (!stage || stage.kind === 'agent') return stageId;
  for (let i = idx - 1; i >= 0; i--) {
    const s = template.stages[i];
    if (s?.kind === 'agent') return s.id;
  }
  return stageId;
}

/**
 * Where a stage rolls back to: `on_reject` after a rejected approval, `on_fail` after failing
 * its checks or review; the default rule when the template does not say.
 */
export function rollbackTarget(
  template: WorkflowTemplate,
  stageId: string,
  reason: 'fail' | 'reject',
): string {
  const def = template.stages.find((s) => s.id === stageId);
  const explicit = reason === 'reject' ? def?.on_reject : def?.on_fail;
  return explicit ?? defaultRollbackTarget(template, stageId);
}

/**
 * Where a stage goes back to when it does not pass its checks or review; null when it stays.
 *
 * Mirrors the engine (src/engine/engine.ts):
 * - placeholder stage → null: it does nothing and always passes.
 * - assess stage → null: doubts about the requirement are discussed with a human and the stage
 *   assesses again with the replies; it ends with going ahead or dropping the Run, never fails.
 * - agent stage → null: a task that fails its checks is reworked within the stage
 *   (`rework`, up to `max_retries`, then the Run fails or waits for a human by `on_exhausted`);
 *   the stage itself never fails.
 * - review / merge / command stage → the stage is marked failed and `rollback` goes to
 *   `rollbackTarget(…, 'fail')`, i.e. `on_fail` or the nearest earlier agent stage.
 *   (A merge stage fails when its verify commands fail after syncing the target branch, or when
 *   syncing it conflicts and `conflictTarget` has an agent stage to resolve that; a command stage
 *   fails when one of its commands fails.)
 */
export function failTarget(template: WorkflowTemplate, stageId: string): string | null {
  const def = template.stages.find((s) => s.id === stageId);
  // A placeholder does nothing and an assessment discusses instead, so neither can fail (only
  // their approval can be rejected).
  if (!def || def.kind === 'agent' || def.kind === 'placeholder' || def.kind === 'assess') {
    return null;
  }
  return rollbackTarget(template, stageId, 'fail');
}

/**
 * Where a merge stage goes when merging the target branch's latest code conflicts: its
 * `failTarget`, whose agent merges the target branch again and resolves the conflicts (rounds
 * count toward max_loops like any rollback). Only an agent stage can change files; for anything
 * else null: the Run ends as failed, and a Run from an issue is redone on the latest target
 * branch, where the conflicts are gone.
 */
export function conflictTarget(template: WorkflowTemplate, stageId: string): string | null {
  if (template.stages.find((s) => s.id === stageId)?.kind !== 'merge') return null;
  const target = failTarget(template, stageId);
  const def = template.stages.find((s) => s.id === target);
  return def?.kind === 'agent' ? def.id : null;
}
