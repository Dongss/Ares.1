import type { BacklogRepoStatus, BacklogStatus, ProposalView } from '../../../src/api/types.js';
import { isAutoAcceptable } from '../../../src/config/flow.js';
import { join, t } from '../../../src/i18n.js';
import type { FailedAttempt, ProposalStatus, ScoutProposal } from '../../../src/store/types.js';
import { formatTime, type Tone } from './format.js';
import { type AcceptLimits, badge } from './issues.js';
import { redoText } from './runs.js';

// The local backlog on the Issues page: the proposals of the repos without GitHub
// (backlog.repos), by repo with the pending ones first, and what a human can do with each.
// Labels are getters, so they are picked in the language in use when read.

export const PROPOSAL_STATUS: Record<ProposalStatus, { readonly label: string; tone: Tone }> = {
  pending: badge('待处理', 'Pending', 'attention'),
  accepted: badge('已采纳', 'Accepted', 'success'),
  rejected: badge('已拒绝', 'Rejected', 'muted'),
  failed: badge('已失败', 'Failed', 'danger'),
};

/**
 * How many of the latest proposals the page loads besides the pending ones, which it loads all
 * of: decided proposals pile up for good, while only the pending ones still need a human.
 */
export const RECENT_PROPOSALS = 50;

/** Each proposal once, by id, as the first list that has it gives it. */
export function mergeProposals(...lists: readonly (readonly ProposalView[])[]): ProposalView[] {
  const byId = new Map<string, ProposalView>();
  for (const list of lists) {
    for (const p of list) if (!byId.has(p.id)) byId.set(p.id, p);
  }
  return [...byId.values()];
}

/** When a proposal last changed: when it was decided, or else proposed. */
const changedAt = (p: ProposalView) => Date.parse(p.decidedAt ?? p.createdAt);

/**
 * The pending proposals first, newest first, since only they wait for anyone; then the decided
 * ones, the most recently decided first.
 */
export function sortProposals(proposals: readonly ProposalView[]): ProposalView[] {
  const rank = (p: ProposalView) => (p.status === 'pending' ? 0 : 1);
  return [...proposals].sort((a, b) => rank(a) - rank(b) || changedAt(b) - changedAt(a));
}

/** One repo's part of the local backlog. */
export interface ProposalGroup {
  /** The repo's name as registered on the dashboard. */
  repo: string;
  /** The repo as backlog.repos has it; null once it was taken out (no proposal of it is accepted). */
  status: BacklogRepoStatus | null;
  proposals: ProposalView[];
}

/**
 * The proposals by repo: every repo of backlog.repos in its order, whether or not it has any,
 * then the repos taken out of it that still have proposals, by name. Each repo's proposals as
 * `sortProposals` orders them.
 */
export function proposalGroups(
  repos: readonly BacklogRepoStatus[],
  proposals: readonly ProposalView[],
): ProposalGroup[] {
  const sorted = sortProposals(proposals);
  const of = (name: string) => sorted.filter((p) => p.repo === name);
  const configured = new Set(repos.map((r) => r.name));
  const others = [...new Set(sorted.map((p) => p.repo))]
    .filter((name) => !configured.has(name))
    .sort((a, b) => a.localeCompare(b));
  return [
    ...repos.map((r) => ({ repo: r.name, status: r, proposals: of(r.name) })),
    ...others.map((name) => ({ repo: name, status: null, proposals: of(name) })),
  ];
}

/**
 * Why a pending proposal cannot be accepted now, as the Master would refuse it; null when it can,
 * and for decided ones, which are not accepted again.
 */
export function acceptBlocker(
  p: Pick<ProposalView, 'status' | 'repo'>,
  repo: Pick<BacklogRepoStatus, 'problems'> | null,
): string | null {
  if (p.status !== 'pending') return null;
  if (!repo) {
    return t({
      zh: `${p.repo} 已经不在 config.yaml 的 backlog.repos 里，不能再采纳它的提案；拒绝还可以`,
      en: `${p.repo} is no longer in backlog.repos of config.yaml, so its proposals cannot be accepted; they can still be rejected`,
    });
  }
  if (repo.problems.length > 0) {
    return t({
      zh: '这个仓库的配置有问题（见上面），改好之后才能采纳',
      en: 'The repo has problems (see above); fix them before accepting',
    });
  }
  return null;
}

/**
 * A pending proposal may be rejected once there is a reason, which the repo's next scouts are
 * shown so that they do not propose it again.
 */
export function canReject(p: Pick<ProposalView, 'status'>, reason: string): boolean {
  return p.status === 'pending' && reason.trim() !== '';
}

/**
 * What a pending proposal waits for: auto-accept takes it at a later poll (it was left today
 * because the count or the budget was used up, or the work switch was off), or a human decides.
 * null for decided proposals, and without auto-accept settings (the repo left backlog.repos).
 */
export function pendingText(
  p: Pick<ProposalView, 'status' | 'risk' | 'size'>,
  auto: AcceptLimits | null,
): string | null {
  if (p.status !== 'pending' || !auto) return null;
  return isAutoAcceptable(p, { max_risk: auto.maxRisk, max_size: auto.maxSize })
    ? t({
        zh: '在自动采纳范围内，还没采纳（今天的自动采纳条数或预算用完了，或者工作开关关着），之后的检查会自动采纳；也可以现在就采纳',
        en: "Within auto-accept but not accepted yet (today's auto-accept count or budget was used up, or the work switch was off); a later check accepts it by itself, or accept it now",
      })
    : t({
        zh: '超出自动采纳的范围，等你采纳或拒绝',
        en: 'Beyond auto-accept, so it waits for you to accept or reject it',
      });
}

/** 「2 条待处理、3 条已采纳」 / "2 pending, 3 accepted"; null without proposals. */
export function proposalCountsText(
  proposals: readonly Pick<ProposalView, 'status'>[],
): string | null {
  const count = (s: ProposalStatus) => proposals.filter((p) => p.status === s).length;
  const pending = count('pending');
  const accepted = count('accepted');
  const rejected = count('rejected');
  const failed = count('failed');
  const parts = [
    pending > 0 ? t({ zh: `${pending} 条待处理`, en: `${pending} pending` }) : null,
    accepted > 0 ? t({ zh: `${accepted} 条已采纳`, en: `${accepted} accepted` }) : null,
    rejected > 0 ? t({ zh: `${rejected} 条已拒绝`, en: `${rejected} rejected` }) : null,
    failed > 0 ? t({ zh: `${failed} 条已失败`, en: `${failed} failed` }) : null,
  ].filter((s): s is string => s !== null);
  return parts.length > 0 ? join(parts) : null;
}

/**
 * 「第 2/3 次尝试」 / "Attempt 2 of 3": which attempt the latest Run is, of how many it gets
 * (`max`, the API's `maxAttempts`; without it, null, only which: 「第 2 次尝试」).
 */
export function attemptText(attempt: number, max: number | null): string {
  return t({
    zh: `第 ${attempt}${max === null ? '' : `/${max}`} 次尝试`,
    en: `Attempt ${attempt}${max === null ? '' : ` of ${max}`}`,
  });
}

/** What the attempt texts read of a proposal, or of a step of an iteration (its proposal's). */
export interface AttemptsOf {
  /** Which attempt its latest Run is; null for a step without a proposal (GitHub). */
  attempt: number | null;
  /** How many Runs it gets in all; null once its repo left backlog.repos. */
  maxAttempts: number | null;
  failures: readonly Pick<FailedAttempt, 'attempt'>[];
}

/**
 * Whether a proposal, or a step's proposal, has been through more than one Run, or its only one
 * failed: only then is it worth telling which attempt it is at.
 */
function triedAgain(p: AttemptsOf): p is AttemptsOf & { attempt: number } {
  return p.attempt !== null && (p.attempt > 1 || p.failures.length > 0);
}

/**
 * Where the attempts at an accepted or failed proposal (a step of an iteration included) stand:
 * 「第 2/3 次尝试」 while a redo works on it or waits, or 「失败 3 次，达到尝试次数上限，不再自动
 * 重做」 once it failed (「重新开始后又失败 3 次…」 when it failed before it was started over, its
 * attempts counted from 1 again). null for one not decided or rejected, and for an accepted one
 * whose first Run has not failed.
 */
export function attemptsText(p: Pick<ProposalView, 'status'> & AttemptsOf): string | null {
  if (p.status === 'failed') {
    const n = p.attempt ?? p.failures.length;
    return p.failures.length > n
      ? t({
          zh: `重新开始后又失败 ${n} 次，达到尝试次数上限（max_run_attempts），不再自动重做`,
          en: `Failed ${n === 1 ? 'once more' : `${n} more times`} after being started over, the most attempts it gets (max_run_attempts); not redone any more`,
        })
      : t({
          zh: `失败 ${n} 次，达到尝试次数上限（max_run_attempts），不再自动重做`,
          en: `Failed ${n === 1 ? 'once' : `${n} times`}, the most attempts it gets (max_run_attempts); not redone any more`,
        });
  }
  if (p.status !== 'accepted' || !triedAgain(p)) return null;
  return attemptText(p.attempt, p.maxAttempts);
}

/**
 * When the failed Run of a proposal (or a step's) waiting to be redone is redone (`redoText`, as
 * on a Run's page): 「预计 14:05 自动重做，开始第 2 次尝试」; null when it does not wait.
 */
export function proposalRedoText(
  p: { redoAt: string | null; attempt: number | null },
  now = new Date(),
): string | null {
  return p.redoAt && p.attempt !== null ? redoText(p.redoAt, p.attempt, now) : null;
}

/** 「第 1 次，失败在「编码」阶段」: which attempt failed, and in which stage if any. */
export function failureLabel(f: Pick<FailedAttempt, 'attempt' | 'stage'>): string {
  return labelIn(f, 1);
}

/**
 * The label of each failed attempt, oldest first, as `failureLabel` gives it; once a human started
 * the proposal over, its attempts counted from 1 again, the later ones tell their round:
 * 「第 2 轮第 1 次，失败在「编码」阶段」. A new round begins wherever the attempt does not go up.
 */
export function failureLabels(
  failures: readonly Pick<FailedAttempt, 'attempt' | 'stage'>[],
): string[] {
  let round = 1;
  return failures.map((f, i) => {
    const before = failures[i - 1];
    if (before && f.attempt <= before.attempt) round += 1;
    return labelIn(f, round);
  });
}

function labelIn(f: Pick<FailedAttempt, 'attempt' | 'stage'>, round: number): string {
  const which =
    round > 1
      ? t({ zh: `第 ${round} 轮第 ${f.attempt} 次`, en: `Round ${round}, attempt ${f.attempt}` })
      : t({ zh: `第 ${f.attempt} 次`, en: `Attempt ${f.attempt}` });
  return f.stage
    ? t({
        zh: `${which}，失败在「${f.stage}」阶段`,
        en: `${which}, failed in the "${f.stage}" stage`,
      })
    : which;
}

/** 「失败的尝试（3 次）及原因」: the heading of the failures folded under a proposal or a step. */
export function failuresHeading(n: number): string {
  return t({ zh: `失败的尝试（${n} 次）及原因`, en: `Failed attempts (${n}) and why` });
}

/**
 * What starting a failed proposal over does, beside its button: for one of its own, or a step
 * (`iterationId`) whose iteration goes on again unless another step still blocks it. null unless
 * it may be started over (`restartable`).
 */
export function restartHint(
  p: Pick<ProposalView, 'restartable'> & { iterationId: string | null },
): string | null {
  if (!p.restartable) return null;
  const common = t({
    zh: '不再自动重做了。修好原因后可以重新开始：次数从头算，马上建一个新的 Run，它会看到之前每次失败的原因',
    en: 'It is not redone automatically any more. Once the cause is fixed, start it over: its attempts count from 1 again, and a new Run is created at once, told why each earlier attempt failed',
  });
  return p.iterationId === null
    ? common
    : t({
        zh: `${common}；迭代没有别的步骤卡住时回到进行中`,
        en: `${common}; the iteration goes on again unless another step still blocks it`,
      });
}

/**
 * Why a failed proposal cannot be started over now, as the Master would refuse it: its repo left
 * backlog.repos, or has problems. null when it can, and for one that may not be started over at
 * all (`restartable` false). `problemsShown`: the page shows the repo's problems above the
 * proposal, so they are only pointed to; otherwise they are spelled out.
 */
export function restartBlocker(
  p: Pick<ProposalView, 'restartable' | 'repo'>,
  repo: Pick<BacklogRepoStatus, 'problems'> | null,
  problemsShown = true,
): string | null {
  if (!p.restartable) return null;
  if (!repo) {
    return t({
      zh: `${p.repo} 已经不在 config.yaml 的 backlog.repos 里，不能再重新开始它的提案`,
      en: `${p.repo} is no longer in backlog.repos of config.yaml, so its proposals cannot be started over`,
    });
  }
  if (repo.problems.length === 0) return null;
  if (problemsShown) {
    return t({
      zh: '这个仓库的配置有问题（见上面），改好之后才能重新开始',
      en: 'The repo has problems (see above); fix them before starting it over',
    });
  }
  // The problems come from the Master, in its language; only the separator follows the page's.
  const problems = repo.problems.join(t({ zh: '；', en: '; ' }));
  return t({
    zh: `${p.repo} 的配置有问题，改好之后才能重新开始：${problems}`,
    en: `${p.repo} has problems; fix them before starting it over: ${problems}`,
  });
}

/**
 * Why a failed step of an iteration of the local backlog cannot be started over now, as
 * `restartBlocker` says of a proposal of `repo` (the iteration's), the repo's problems spelled
 * out: the iteration's page does not show them. null while the local backlog's status is not
 * known (`backlog` undefined), so that the button is not held back on a guess; the Master still
 * refuses what it must.
 */
export function stepRestartBlocker(
  step: Pick<ProposalView, 'restartable'>,
  repo: string,
  backlog: Pick<BacklogStatus, 'repos'> | undefined,
): string | null {
  if (!backlog) return null;
  const status = backlog.repos.find((r) => r.name === repo) ?? null;
  return restartBlocker({ restartable: step.restartable, repo }, status, false);
}

/** The button that starts a failed proposal (or step) over, and what confirming it says. */
export function restartLabels(): { label: string; confirm: string } {
  return {
    label: t({ zh: '重新开始', en: 'Start over' }),
    confirm: t({
      zh: '确认重新开始：次数从头算，马上建 Run',
      en: 'Confirm: count from 1 again and create a Run now',
    }),
  };
}

/**
 * How and when a proposal was decided: 「11-20 09:30 自动采纳」 / "Accepted automatically
 * 11-20 09:30"; null while pending.
 */
export function decidedText(
  p: Pick<ProposalView, 'status' | 'auto' | 'decidedAt'>,
  now = new Date(),
): string | null {
  if (p.status === 'pending') return null;
  const at = p.decidedAt ? formatTime(p.decidedAt, now) : null;
  if (p.status === 'rejected') {
    return at ? t({ zh: `${at} 拒绝`, en: `Rejected ${at}` }) : t({ zh: '拒绝', en: 'Rejected' });
  }
  if (p.auto) {
    return at
      ? t({ zh: `${at} 自动采纳`, en: `Accepted automatically ${at}` })
      : t({ zh: '自动采纳', en: 'Accepted automatically' });
  }
  return at ? t({ zh: `${at} 采纳`, en: `Accepted ${at}` }) : t({ zh: '采纳', en: 'Accepted' });
}

/**
 * Where a scout's proposal went: an issue on GitHub, or the local backlog (`auto`: accepted
 * without a human); `where` null when it was filed nowhere (it failed, or the scout is cut short).
 */
export function scoutProposalFiled(p: Pick<ScoutProposal, 'issue' | 'local'>): {
  where: 'issue' | 'local' | null;
  auto: boolean;
} {
  if (p.issue) return { where: 'issue', auto: p.issue.auto };
  if (p.local) return { where: 'local', auto: p.local.auto };
  return { where: null, auto: false };
}

/**
 * The live events after which the local backlog on the page is out of date: proposals filed,
 * accepted, rejected, redone, failed or started over, on their own or with their iteration,
 * scouts, Runs created or changing status (an accepted proposal shows its Run's status), and
 * configuration reloads (backlog.repos changed).
 */
export function backlogOutdatedBy(type: string): boolean {
  return (
    type.startsWith('proposal.') ||
    type.startsWith('iteration.') ||
    type.startsWith('scout.') ||
    type.startsWith('config.') ||
    type === 'run.created' ||
    type === 'run.status'
  );
}
