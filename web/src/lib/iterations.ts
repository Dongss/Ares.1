import type { IterationChildView, IterationView } from '../../../src/api/types.js';
import { ITERATION_OPEN_STATUSES, iterationKind } from '../../../src/config/flow.js';
import { join, t } from '../../../src/i18n.js';
import type { IterationChildStatus, IterationStatus } from '../../../src/store/types.js';
import { formatDuration, formatRunCost, goalTitle, type Tone } from './format.js';
import { badge, RISK } from './issues.js';
import { attemptText } from './proposals.js';

// Iterations on the dashboard (the Iterations page and the card on Home): where each stands, its
// progress, what each step waits for, what holds it up and what a human can do about it. Labels
// are getters, so they are picked in the language in use when read.

export const ITERATION_STATUS: Record<IterationStatus, { readonly label: string; tone: Tone }> = {
  pending: badge('待采纳', 'Pending', 'attention'),
  active: badge('进行中', 'In progress', 'active'),
  blocked: badge('受阻', 'Blocked', 'danger'),
  done: badge('已完成', 'Done', 'success'),
  cancelled: badge('不做了', 'Dropped', 'muted'),
};

export const ITERATION_CHILD_STATUS: Record<
  IterationChildStatus,
  { readonly label: string; tone: Tone }
> = {
  planned: badge('已规划', 'Planned', 'neutral'),
  waiting: badge('等依赖', 'Waiting', 'neutral'),
  ready: badge('可开工', 'Ready', 'active'),
  running: badge('进行中', 'In progress', 'active'),
  done: badge('已完成', 'Done', 'success'),
  failed: badge('失败', 'Failed', 'danger'),
  dropped: badge('不做了', 'Dropped', 'muted'),
};

/** A step's badge: a step another one took over from is shown as replaced, whatever became of it. */
export function childBadge(child: Pick<IterationChildView, 'status' | 'replacedBy'>): {
  label: string;
  tone: Tone;
} {
  if (child.replacedBy !== undefined) {
    return { label: t({ zh: '已替换', en: 'Replaced' }), tone: 'muted' };
  }
  return ITERATION_CHILD_STATUS[child.status];
}

/**
 * How many iterations not over the pages load (all of them; a repo has one at most) besides the
 * latest ones, of which they load this many: ended iterations pile up for good.
 */
export const RECENT_ITERATIONS = 50;

/** Whether an iteration is not over yet: waiting to be accepted, under way, or blocked. */
export function isOpen(it: Pick<IterationView, 'status'>): boolean {
  return ITERATION_OPEN_STATUSES.includes(it.status);
}

/** Each iteration once, by id, as the first list that has it gives it. */
export function mergeIterations(...lists: readonly (readonly IterationView[])[]): IterationView[] {
  const byId = new Map<string, IterationView>();
  for (const list of lists) {
    for (const it of list) if (!byId.has(it.id)) byId.set(it.id, it);
  }
  return [...byId.values()];
}

/** Blocked ones first, as they need a human; then those waiting to be accepted; then the rest. */
const RANK: Record<IterationStatus, number> = {
  blocked: 0,
  pending: 1,
  active: 2,
  done: 3,
  cancelled: 3,
};

/** When an iteration last moved on: when it ended, was decided, or else was planned. */
const changedAt = (it: Pick<IterationView, 'endedAt' | 'decidedAt' | 'createdAt'>) =>
  Date.parse(it.endedAt ?? it.decidedAt ?? it.createdAt);

/**
 * The iterations not over first (blocked, then pending, then under way), newest first; then the
 * ended ones, the most recently ended first.
 */
export function sortIterations(iterations: readonly IterationView[]): IterationView[] {
  return [...iterations].sort(
    (a, b) =>
      RANK[a.status] - RANK[b.status] ||
      (isOpen(a) ? Date.parse(b.createdAt) - Date.parse(a.createdAt) : changedAt(b) - changedAt(a)),
  );
}

/** The iterations not over, of one repo (`repoId`) or of all (null), as `sortIterations` orders. */
export function openIterations(
  iterations: readonly IterationView[],
  repoId: string | null,
): IterationView[] {
  return sortIterations(
    iterations.filter((it) => isOpen(it) && (repoId === null || it.repoId === repoId)),
  );
}

/** 「完成 2/5」 / "2 of 5 done". */
export function progressText(progress: IterationView['progress']): string {
  return t({
    zh: `完成 ${progress.done}/${progress.total}`,
    en: `${progress.done} of ${progress.total} done`,
  });
}

/** How full its progress bar is, 0 to 100; a plan without steps is full once done. */
export function progressPercent(it: Pick<IterationView, 'progress' | 'status'>): number {
  const { done, total } = it.progress;
  if (total === 0) return it.status === 'done' ? 100 : 0;
  return Math.round((done / total) * 100);
}

/** 「第 2 步」 / "step 2". */
export function stepName(position: number): string {
  return t({ zh: `第 ${position} 步`, en: `step ${position}` });
}

/** 「第 1、3 步」 / "steps 1, 3" (one: "step 1"). */
export function stepsName(positions: readonly number[]): string {
  const list = join(positions.map(String));
  return t({
    zh: `第 ${list} 步`,
    en: positions.length === 1 ? `step ${list}` : `steps ${list}`,
  });
}

/** 「第 2 步「标题」」 / "step 2 “title”", the title cut to one short line. */
function namedStep(child: Pick<IterationChildView, 'position' | 'title'>): string {
  const title = goalTitle(child.title, 60);
  return t({
    zh: `${stepName(child.position)}「${title}」`,
    en: `${stepName(child.position)} “${title}”`,
  });
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * What a step waits for or depends on: 「在等第 1 步」 while it waits for steps not done
 * (`waiting`), otherwise 「依赖第 1 步」 when it depends on any; null for a step that depends on
 * nothing, and for one replaced (`replacedText` says that).
 */
export function dependencyText(
  child: Pick<IterationChildView, 'status' | 'dependsOn' | 'waitingFor' | 'replacedBy'>,
): { text: string; waiting: boolean } | null {
  if (child.replacedBy !== undefined) return null;
  if (child.status === 'waiting' && child.waitingFor.length > 0) {
    return {
      text: t({
        zh: `在等${stepsName(child.waitingFor)}完成`,
        en: `Waiting for ${stepsName(child.waitingFor)} to be done`,
      }),
      waiting: true,
    };
  }
  if (child.dependsOn.length === 0) return null;
  return {
    text: t({
      zh: `依赖${stepsName(child.dependsOn)}`,
      en: `Depends on ${stepsName(child.dependsOn)}`,
    }),
    waiting: false,
  };
}

/** 「已由第 5 步换个做法接替」; null for a step not replaced. */
export function replacedText(child: Pick<IterationChildView, 'replacedBy'>): string | null {
  if (child.replacedBy === undefined) return null;
  return t({
    zh: `已由${stepName(child.replacedBy)}换个做法接替`,
    en: `Taken over by ${stepName(child.replacedBy)} with another approach`,
  });
}

/** The steps that hold an iteration up: failed or dropped, and nothing replaced them. */
export function blockingSteps(it: Pick<IterationView, 'children'>): IterationChildView[] {
  return it.children.filter(
    (c) => (c.status === 'failed' || c.status === 'dropped') && c.replacedBy === undefined,
  );
}

/**
 * What blocks an iteration: 「第 3 步「…」失败了」 for each step that holds it up, so the steps
 * depending on them cannot start; null unless it is blocked.
 */
export function blockedText(it: Pick<IterationView, 'status' | 'children'>): string | null {
  if (it.status !== 'blocked') return null;
  const steps = blockingSteps(it).map((c) =>
    c.status === 'failed'
      ? t({ zh: `${namedStep(c)}失败了`, en: `${namedStep(c)} failed` })
      : t({ zh: `${namedStep(c)}不做了`, en: `${namedStep(c)} was dropped` }),
  );
  if (steps.length === 0) return null;
  const one = steps.length === 1;
  return t({
    zh: `${join(steps)}，依赖${one ? '它' : '它们'}的步骤不能开工`,
    en: `${capitalize(join(steps))}, so the steps depending on ${one ? 'it' : 'them'} cannot start`,
  });
}

/**
 * What a human can do about a blocked iteration, wherever its steps are. In the local backlog, a
 * step that failed after its attempts were used up may also be started over (`restartable`).
 */
export function blockedHint(it: Pick<IterationView, 'source' | 'children'>): string {
  if (it.source !== 'local') {
    return t({
      zh: '下次侦察会换个做法补一个子 issue 替换它，替换后迭代接着做；也可以修好原因后重新打开那个子 issue、加上 ares1:ready 重做；不想做剩下的，就关掉迭代 issue',
      en: 'The next scout adds a sub-issue that replaces it with another approach, and the iteration goes on once it is replaced; or fix the cause, reopen the sub-issue and add ares1:ready to redo it; to drop the rest, close the iteration issue',
    });
  }
  return blockingSteps(it).some((c) => c.restartable)
    ? t({
        zh: '下次侦察会换个做法补一步替换它，替换后迭代接着做；也可以修好原因后在下面的计划里点那一步的「重新开始」，次数从头算；不想做剩下的，就终止这个迭代',
        en: 'The next scout adds a step that replaces it with another approach, and the iteration goes on once it is replaced; or fix the cause and use "Start over" on that step in the plan below, its attempts counted from 1 again; to drop the rest, cancel the iteration',
      })
    : t({
        zh: '下次侦察会换个做法补一步替换它，替换后迭代接着做；不想做剩下的，就终止这个迭代',
        en: 'The next scout adds a step that replaces it with another approach, and the iteration goes on once it is replaced; to drop the rest, cancel the iteration',
      });
}

/**
 * Which attempt a step of the local backlog is at, while it runs or once it failed: 「第 2/3 次
 * 尝试」 once its first Run failed (`attemptText`); null before, on GitHub, and for a step
 * neither running nor failed.
 */
export function stepAttemptsText(
  child: Pick<IterationChildView, 'status' | 'attempt' | 'maxAttempts' | 'failures'>,
): string | null {
  if (child.status !== 'running' && child.status !== 'failed') return null;
  if (child.attempt === null || (child.attempt === 1 && child.failures.length === 0)) return null;
  return attemptText(child.attempt, child.maxAttempts);
}

/** Who accepts a pending iteration, and how; null unless it is pending. */
export function pendingHint(it: Pick<IterationView, 'status' | 'source'>): string | null {
  if (it.status !== 'pending') return null;
  const host = hostName(it.source);
  return host
    ? t({
        zh: `等采纳：在 ${host} 上给迭代 issue 加上 ares1:ready 就整体采纳，关掉它就不做`,
        en: `Waiting to be accepted: add ares1:ready to the iteration issue on ${host} to accept it as a whole, or close it to drop it`,
      })
    : t({
        zh: '等采纳：在迭代页整体采纳，或者填上理由拒绝',
        en: 'Waiting to be accepted: accept it as a whole on its page, or reject it with a reason',
      });
}

/** 「正在做：第 2 步「…」」 for the steps whose Runs go on now; null when none does. */
export function runningText(it: Pick<IterationView, 'children'>): string | null {
  const running = it.children.filter((c) => c.status === 'running' && c.replacedBy === undefined);
  if (running.length === 0) return null;
  return t({
    zh: `正在做：${join(running.map(namedStep))}`,
    en: `Working on ${join(running.map(namedStep))}`,
  });
}

/**
 * The one line a card of an iteration not over says about it: what blocks it, who accepts it,
 * or what is under way; null for one over, or under way with no Run going on right now.
 */
export function iterationNote(
  it: Pick<IterationView, 'status' | 'source' | 'children'>,
): { text: string; tone: Tone } | null {
  const blocked = blockedText(it);
  if (blocked) return { text: blocked, tone: 'danger' };
  const pending = pendingHint(it);
  if (pending) return { text: pending, tone: 'attention' };
  if (it.status !== 'active') return null;
  const running = runningText(it);
  return running ? { text: running, tone: 'active' } : null;
}

/** 「3 个 Run」 / "3 Runs". */
export function runCountText(n: number): string {
  return t({ zh: `${n} 个 Run`, en: `${n} ${n === 1 ? 'Run' : 'Runs'}` });
}

/** What its Runs cost, a lower bound when some costs are unknown. */
export function iterationCostText(it: Pick<IterationView, 'totals'>): string {
  return formatRunCost(it.totals.costUsd, it.totals.costUnknown);
}

type Decision = Pick<IterationView, 'status' | 'decidedAt' | 'endedAt'>;

/**
 * Whether it was ever accepted. One turned down while pending (rejected, or its issue closed) was
 * decided and ended at the same moment (`recordCancelled`); one accepted ended later.
 */
export function wasAccepted(it: Decision): boolean {
  if (it.status === 'pending' || it.decidedAt === null) return false;
  return !(it.status === 'cancelled' && it.decidedAt === it.endedAt);
}

/** 「采纳」 or, for one turned down while pending, 「拒绝」: what its decision was; null before. */
export function decisionLabel(it: Decision): string | null {
  if (it.decidedAt === null) return null;
  return wasAccepted(it) ? t({ zh: '采纳', en: 'Accepted' }) : t({ zh: '拒绝', en: 'Rejected' });
}

/** 「用时 2 小时 5 分」 since it was accepted; null when it never was. */
export function elapsedText(it: Decision & Pick<IterationView, 'totals'>): string | null {
  const ms = it.totals.elapsedMs;
  if (ms === null || !wasAccepted(it)) return null;
  return t({ zh: `用时 ${formatDuration(ms)}`, en: `took ${formatDuration(ms)}` });
}

/** 「推进完成标准第 1、3 条」: the completion criteria a step moves forward; null for none. */
export function criteriaText(criteria: readonly number[]): string | null {
  if (criteria.length === 0) return null;
  const list = join(criteria.map(String));
  return t({
    zh: `推进完成标准第 ${list} 条`,
    en: `Moves completion ${criteria.length === 1 ? 'criterion' : 'criteria'} ${list} forward`,
  });
}

/**
 * How auto-accept judges it, as a whole: 「整体：风险高 · L」 by the highest risk and the largest
 * size of its steps (`iterationKind`).
 */
export function overallKindText(it: Pick<IterationView, 'children'>): string {
  const kind = iterationKind(it.children);
  return t({
    zh: `整体：${RISK[kind.risk].label} · ${kind.size}`,
    en: `As a whole: ${RISK[kind.risk].label.toLowerCase()} · ${kind.size}`,
  });
}

/**
 * The steps that move a completion criterion (`index` from 1) forward, replaced ones left out:
 * 「第 1、2 步」; null when no step names it.
 */
export function criterionSteps(it: Pick<IterationView, 'children'>, index: number): string | null {
  const positions = it.children
    .filter((c) => c.replacedBy === undefined && c.criteria.includes(index))
    .map((c) => c.position);
  return positions.length > 0 ? stepsName(positions) : null;
}

/**
 * What a human can do on the dashboard: a pending iteration of the local backlog can be accepted,
 * or rejected with a reason; an accepted one not over can be cancelled. Those of GitHub are
 * decided on GitHub.
 */
export function iterationActions(it: Pick<IterationView, 'source' | 'status'>): {
  decide: boolean;
  cancel: boolean;
} {
  if (it.source !== 'local') return { decide: false, cancel: false };
  return {
    decide: it.status === 'pending',
    cancel: it.status === 'active' || it.status === 'blocked',
  };
}

/** A pending iteration of the local backlog may be rejected once there is a reason. */
export function canRejectIteration(
  it: Pick<IterationView, 'source' | 'status'>,
  reason: string,
): boolean {
  return iterationActions(it).decide && reason.trim() !== '';
}

/** The code host an iteration's issues are on, as people know it; null for the local backlog. */
export function hostName(source: IterationView['source']): string | null {
  if (source === 'local') return null;
  return source === 'gitlab' ? 'GitLab' : 'GitHub';
}

/**
 * Where an iteration on a code host (GitHub or GitLab) is decided; null for the local backlog and
 * once it is over.
 */
export function githubHint(it: Pick<IterationView, 'source' | 'status'>): string | null {
  const host = hostName(it.source);
  if (!host || !isOpen(it)) return null;
  return t({
    zh: `这个迭代在 ${host} 上：采纳、拒绝和终止都在迭代 issue 上做。加上 ares1:ready 就整体采纳；关掉它就不做，还没完成的子 issue 会一起终止并关成不做。`,
    en: `This iteration is on ${host}, where it is accepted, rejected or cancelled on the iteration issue: add ares1:ready to accept it as a whole; close it to drop it, and the sub-issues not done yet are stopped and closed as not planned with it.`,
  });
}

/**
 * The live events after which iterations on a page are out of date: iterations accepted, moving
 * on, blocked, adjusted or ended; scouts (one files a new iteration); Runs created or changing
 * status (each step shows its Runs); a local proposal's failure recorded, redone, given up or
 * started over (a step of the local backlog shows its attempts and when it is redone).
 */
export function iterationsOutdatedBy(type: string): boolean {
  return (
    type.startsWith('iteration.') ||
    type.startsWith('scout.') ||
    type === 'run.created' ||
    type === 'run.status' ||
    type === 'proposal.redo_scheduled' ||
    type === 'proposal.redone' ||
    type === 'proposal.failed' ||
    type === 'proposal.restarted'
  );
}
