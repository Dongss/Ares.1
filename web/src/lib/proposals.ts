import type { BacklogRepoStatus, ProposalView } from '../../../src/api/types.js';
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
 * Where the attempts at an accepted or failed proposal (a step of an iteration included) stand:
 * 「第 2/3 次尝试」 while
 * a redo works on it or waits (`max`: the repo's `max_run_attempts`, null once the repo left
 * backlog.repos), or 「失败 3 次，达到尝试次数上限，不再自动重做」 once it failed. null for one
 * not decided or rejected, and for an accepted one whose first Run has not failed.
 */
export function attemptsText(
  p: Pick<ProposalView, 'status' | 'attempt' | 'failures'>,
  max: number | null,
): string | null {
  if (p.status === 'failed') {
    const n = p.failures.length;
    return t({
      zh: `失败 ${n} 次，达到尝试次数上限（max_run_attempts），不再自动重做`,
      en: `Failed ${n === 1 ? 'once' : `${n} times`}, the most attempts it gets (max_run_attempts); not redone any more`,
    });
  }
  if (p.status !== 'accepted' || (p.attempt === 1 && p.failures.length === 0)) return null;
  const most = max === null ? null : Math.max(max, p.attempt);
  return t({
    zh: `第 ${p.attempt}${most === null ? '' : `/${most}`} 次尝试`,
    en: `Attempt ${p.attempt}${most === null ? '' : ` of ${most}`}`,
  });
}

/**
 * When the failed Run of a proposal waiting to be redone is redone (`redoText`, as on a Run's
 * page): 「预计 14:05 自动重做，开始第 2 次尝试」; null when it does not wait.
 */
export function proposalRedoText(
  p: Pick<ProposalView, 'redoAt' | 'attempt'>,
  now = new Date(),
): string | null {
  return p.redoAt ? redoText(p.redoAt, p.attempt, now) : null;
}

/** 「第 1 次，失败在「编码」阶段」: which attempt failed, and in which stage if any. */
export function failureLabel(f: Pick<FailedAttempt, 'attempt' | 'stage'>): string {
  return f.stage
    ? t({
        zh: `第 ${f.attempt} 次，失败在「${f.stage}」阶段`,
        en: `Attempt ${f.attempt}, failed in the "${f.stage}" stage`,
      })
    : t({ zh: `第 ${f.attempt} 次`, en: `Attempt ${f.attempt}` });
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
 * accepted, rejected, redone or failed, on their own or with their iteration, scouts, Runs created or changing
 * status (an accepted proposal shows its Run's status), and configuration reloads (backlog.repos
 * changed).
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
