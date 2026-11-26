// Whether a Run's open pull request (deliver: pr) needs more work, and the feedback that hands it
// back to the coding agent. Pure logic: what GitHub reported on the pull request and what the Run
// has already reworked go in, the judgement comes out.

import type {
  ChangeRequestStatus,
  HostCheck,
  HostReview,
  HostReviewComment,
} from '../host/code-host.js';
import { join, t } from '../i18n.js';
import { type EventRow, PR_REWORK_KINDS, type PrReworkKind } from '../store/types.js';
import { isTrusted, quote } from './issues.js';

// Declared with the store's types, so that the dashboard reads the events by the same kinds.
export type { PrReworkKind };

/**
 * The order the kinds are listed in. A conflict comes first: the merge stage resolves it by
 * merging the target branch, which can change what the checks and the reviewers saw.
 */
const KIND_ORDER: readonly PrReworkKind[] = PR_REWORK_KINDS;

/**
 * Conclusions of a finished check that mean it failed; the others (SUCCESS, NEUTRAL, SKIPPED, ...)
 * do not.
 */
export const FAILED_CHECK_CONCLUSIONS: readonly string[] = [
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'ERROR',
];

/** Whether a check finished and failed. */
export function checkFailed(check: HostCheck): boolean {
  return (
    check.done &&
    check.conclusion !== null &&
    FAILED_CHECK_CONCLUSIONS.includes(check.conclusion.toUpperCase())
  );
}

/** Review states that say where a reviewer stands; COMMENTED and PENDING leave it as it was. */
const STANCES: readonly string[] = ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'];

/**
 * A review asking for changes on the pull request's head by someone the Master does not trust:
 * it triggers no rework, and its text reaches no prompt. Only who wrote it is kept.
 */
export interface IgnoredReview {
  /** Login; null when the account was deleted. */
  author: string | null;
  /**
   * The author's relation to the repo as the code host words it (the review's `role`), e.g.
   * NONE or CONTRIBUTOR on GitHub.
   */
  association: string;
  /** The commit it reviewed. */
  commit: string | null;
}

/** A failed check of the pull request's head. */
export interface PrReworkCheck {
  name: string;
  /** Where to see it; null when GitHub gives no link. */
  url: string | null;
}

/** What the pull request needs reworked, on its head commit. */
export interface PrRework {
  /** The head commit it was judged on: one rework per head and kind. */
  head: string;
  /** Not empty; conflict, ci, review in that order. */
  kinds: PrReworkKind[];
  /** Logins of the trusted reviewers who asked for changes; empty unless kinds has review. */
  reviewers: string[];
  /** The failed checks; empty unless kinds has ci. */
  checks: PrReworkCheck[];
  /** For the coding agent: the link, the reviews and their line comments, the failed checks. */
  feedback: string;
  /** One line on why, to follow 「PR #N 需要返工：」 in the issue comment. */
  reason: string;
}

export interface PrReworkContext {
  /** The commit the Run delivered (its headCommit); null when not known. */
  head: string | null;
  /** The account the Master acts as, which it trusts; null when not known. */
  master: string | null;
  /** The reworks already triggered (from the Run's events): each head with its kinds. */
  done: readonly { head: string; kinds: readonly string[] }[];
}

export interface PrJudgement {
  /** null when the pull request needs nothing (new) reworked. */
  rework: PrRework | null;
  /**
   * Reviews that would ask for a rework if the Master trusted their authors. Given each time the
   * pull request is judged, already reworked or not: the caller records each once.
   */
  ignored: IgnoredReview[];
}

/** Characters kept of a review's body, and of a line comment's. */
const MAX_REVIEW_BODY = 3_000;
const MAX_COMMENT_BODY = 1_000;
/** Line comments listed at most; the rest are counted. */
const MAX_COMMENTS = 30;
/** Failed checks named at most in the reason; the rest are counted. */
const MAX_REASON_CHECKS = 5;

/**
 * Whether the open pull request of a Run needs more work, judged on its head commit only, and
 * only when that is the commit the Run delivered (`ctx.head`): results on older commits were
 * answered by the commits since, and a head the Run did not push is not its work to judge.
 *
 * - review: a reviewer the Master trusts (`isTrusted`) asks for changes. Each reviewer counts
 *   with their latest review that takes a stance (APPROVED, CHANGES_REQUESTED, DISMISSED), and it
 *   must be on the head. When GitHub's reviewDecision is APPROVED or REVIEW_REQUIRED somebody
 *   approved or dismissed it since, so nothing triggers. Reviews by people the Master does not
 *   trust go to `ignored`, without their text.
 * - ci: every check of the head finished, and at least one failed (`checkFailed`). None while a
 *   check still runs, nor when there are no checks.
 * - conflict: GitHub found it conflicts with its base (mergeable false); not while unknown.
 *
 * A kind already reworked on the same head (`ctx.done`) does not count again.
 */
export function judgePullRequest(pr: ChangeRequestStatus, ctx: PrReworkContext): PrJudgement {
  const head = pr.headRefOid;
  if (pr.state !== 'open' || ctx.head === null || head !== ctx.head) {
    return { rework: null, ignored: [] };
  }
  const decided = pr.reviewDecision === null || pr.reviewDecision === 'CHANGES_REQUESTED';
  const asking = decided
    ? latestStances(pr.reviews).filter(
        (r) => r.state.toUpperCase() === 'CHANGES_REQUESTED' && r.commit === head,
      )
    : [];
  const reviews = asking.filter((r) => isTrusted(r, ctx.master));
  const ignored = asking
    .filter((r) => !isTrusted(r, ctx.master))
    .map((r) => ({ author: r.author, association: r.role, commit: r.commit }));
  const finished = pr.checks.length > 0 && pr.checks.every((c) => c.done);
  const failed = finished ? pr.checks.filter(checkFailed) : [];

  const done = new Set(ctx.done.filter((d) => d.head === head).flatMap((d) => d.kinds));
  const found: Record<PrReworkKind, boolean> = {
    conflict: pr.mergeable === false,
    ci: failed.length > 0,
    review: reviews.length > 0,
  };
  const kinds = KIND_ORDER.filter((kind) => found[kind] && !done.has(kind));
  if (kinds.length === 0) return { rework: null, ignored };

  const forReview = kinds.includes('review') ? reviews : [];
  const forCi = kinds.includes('ci') ? failed : [];
  const comments = forReview.length
    ? pr.reviewComments.filter((c) => c.commit === head && isTrusted(c, ctx.master))
    : [];
  return {
    rework: {
      head,
      kinds,
      reviewers: forReview.flatMap((r) => (r.author ? [r.author] : [])),
      checks: forCi.map((c) => ({ name: c.name, url: c.url })),
      feedback: feedbackText(pr, kinds, forCi, forReview, comments),
      reason: reasonText(pr, kinds, forCi, forReview),
    },
    ignored,
  };
}

/** Each reviewer's latest review that takes a stance, in the order of those reviews. */
function latestStances(reviews: readonly HostReview[]): HostReview[] {
  const latest = new Map<string, HostReview>();
  for (const review of reviews) {
    if (!STANCES.includes(review.state.toUpperCase())) continue;
    const key = review.author?.toLowerCase() ?? '';
    latest.delete(key);
    latest.set(key, review);
  }
  return [...latest.values()];
}

/** 「@login」, or a deleted account. */
function who(author: string | null): string {
  return author ? `@${author}` : t({ zh: '已删除的账号', en: 'a deleted account' });
}

/** `text` as a quote, indented under a list item when `indent` is given. */
function quoted(text: string, max: number, indent = ''): string {
  return quote(text.replace(/\r\n/g, '\n').trim(), max)
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n');
}

/** What the coding agent is told about the pull request, one part per kind. */
function feedbackText(
  pr: ChangeRequestStatus,
  kinds: readonly PrReworkKind[],
  checks: readonly HostCheck[],
  reviews: readonly HostReview[],
  comments: readonly HostReviewComment[],
): string {
  const base = `\`${pr.baseRefName}\``;
  const parts = [
    t({
      zh: `PR #${pr.number} 需要返工：${pr.url}`,
      en: `Pull request #${pr.number} needs more work: ${pr.url}`,
    }),
  ];
  for (const kind of kinds) {
    if (kind === 'conflict') {
      parts.push(
        t({
          zh: `与目标分支冲突：PR 和目标分支 ${base} 有冲突。合并阶段会合入 ${base} 的新提交并解决冲突。`,
          en: `Conflict with the target branch: the pull request conflicts with ${base}. The merge stage merges the new commits of ${base} and resolves the conflicts.`,
        }),
      );
    } else if (kind === 'ci') {
      const lines = checks.map((c) => {
        const conclusion = c.conclusion ?? '';
        const link = c.url ? t({ zh: `：${c.url}`, en: `: ${c.url}` }) : '';
        return t({
          zh: `- \`${c.name}\`（${conclusion}）${link}`,
          en: `- \`${c.name}\` (${conclusion})${link}`,
        });
      });
      parts.push(
        [
          t({ zh: 'CI 检查没通过：', en: 'Failed checks:' }),
          ...lines,
          t({
            zh: '打不开检查的日志时，在工作目录里运行相应的构建和测试命令复现失败。',
            en: 'If you cannot open the logs, reproduce the failures by running the matching build and test commands in the working directory.',
          }),
        ].join('\n'),
      );
    } else {
      parts.push(reviewText(reviews, comments));
    }
  }
  return parts.join('\n\n');
}

/** The reviews that ask for changes, then their line comments by file and line. */
function reviewText(
  reviews: readonly HostReview[],
  comments: readonly HostReviewComment[],
): string {
  const lines = [t({ zh: '评审要求修改：', en: 'Changes requested in review:' })];
  for (const review of reviews) {
    const name = who(review.author);
    if (review.body.trim()) {
      lines.push(
        t({ zh: `${name} 要求修改：`, en: `${name} requested changes:` }),
        quoted(review.body, MAX_REVIEW_BODY),
      );
    } else {
      lines.push(
        t({
          zh: `${name} 要求修改（评审没有写正文）。`,
          en: `${name} requested changes (the review has no text).`,
        }),
      );
    }
  }
  if (comments.length > 0) {
    lines.push('', t({ zh: '行内评论：', en: 'Line comments:' }));
    for (const c of comments.slice(0, MAX_COMMENTS)) {
      const where = c.line === null ? c.path : `${c.path}:${c.line}`;
      const name = who(c.author);
      lines.push(
        t({ zh: `- \`${where}\`（${name}）：`, en: `- \`${where}\` (${name}):` }),
        quoted(c.body, MAX_COMMENT_BODY, '  '),
      );
    }
    const more = comments.length - MAX_COMMENTS;
    if (more > 0) {
      lines.push(
        t({
          zh: `还有 ${more} 条行内评论没有列出，见 PR。`,
          en: `${more} more line ${more === 1 ? 'comment is' : 'comments are'} not listed; see the pull request.`,
        }),
      );
    }
  }
  return lines.join('\n');
}

/** Why, in one line: the conflict, the failed checks by name, who asked for changes. */
function reasonText(
  pr: ChangeRequestStatus,
  kinds: readonly PrReworkKind[],
  checks: readonly HostCheck[],
  reviews: readonly HostReview[],
): string {
  return reworkReason({
    kinds,
    base: pr.baseRefName,
    checks: checks.map((c) => c.name),
    reviewers: reviews.map((r) => r.author),
  });
}

/**
 * Why a pull request needs more work, in one line, from what a rework records: the conflict with
 * `base`, the failed checks by name, who asked for changes (null for a deleted account).
 */
export function reworkReason(rework: {
  kinds: readonly PrReworkKind[];
  base: string;
  checks: readonly string[];
  reviewers: readonly (string | null)[];
}): string {
  const { base, checks, reviewers } = rework;
  const parts = rework.kinds.map((kind) => {
    if (kind === 'conflict') {
      return t({
        zh: `与目标分支 \`${base}\` 冲突`,
        en: `a conflict with the target branch \`${base}\``,
      });
    }
    if (kind === 'ci') {
      const names = checks.slice(0, MAX_REASON_CHECKS);
      const more = checks.length - names.length;
      const list =
        more > 0
          ? t({
              zh: `${join(names)} 等 ${checks.length} 个`,
              en: `${join(names)} and ${more} more`,
            })
          : join(names);
      return t({
        zh: `CI 检查没通过：${list}`,
        en: `${checks.length === 1 ? 'a failed check' : 'failed checks'}: ${list}`,
      });
    }
    const names = join(reviewers.map(who));
    return t({ zh: `${names} 要求修改`, en: `changes requested by ${names}` });
  });
  return parts.join(t({ zh: '；', en: '; ' }));
}

/** What `reworksDone` and `pullRequestPushPending` read of a Run's events. */
type RunEventLike = Pick<EventRow, 'type' | 'data'>;

const isKind = (value: unknown): value is PrReworkKind =>
  typeof value === 'string' && (KIND_ORDER as readonly string[]).includes(value);

/**
 * The reworks a Run's pull request already had, from its events (`github.pr_rework`, oldest
 * first): each head commit with the kinds reworked on it. Kept in the database, so that a head
 * is not reworked twice for the same kind, also across a restart of the Master.
 */
export function reworksDone(
  events: readonly RunEventLike[],
): { head: string; kinds: PrReworkKind[] }[] {
  return events.flatMap((e) => {
    if (e.type !== 'github.pr_rework' || typeof e.data.head !== 'string') return [];
    const kinds = Array.isArray(e.data.kinds) ? e.data.kinds.filter(isKind) : [];
    return [{ head: e.data.head, kinds }];
  });
}

/**
 * Whether a Run waiting for its pull request (`pr_open`) still has to push its branch there: it
 * got to wait again (`merge.pr_pending`) after its last push (`github.pr_opened`, or
 * `github.pr_updated` after a rework). Until then the pull request on GitHub shows the Run's
 * earlier work, which is not to be judged again.
 */
export function pullRequestPushPending(events: readonly RunEventLike[]): boolean {
  const pending = events.findLastIndex((e) => e.type === 'merge.pr_pending');
  const pushed = events.findLastIndex(
    (e) => e.type === 'github.pr_opened' || e.type === 'github.pr_updated',
  );
  return pending > pushed;
}
