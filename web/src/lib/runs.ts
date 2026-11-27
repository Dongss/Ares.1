import type {
  ConflictWait,
  RateLimitedWait,
  RepoSourceView,
  RunDetail,
  RunSummary,
} from '../../../src/api/types.js';
import { brandTitle } from '../../../src/brand.js';
import {
  type AgentSelection,
  changeRequestTerms,
  difficultyMeanings,
  discussionReplyWait,
  RAW_LOG_KEEP_DAYS,
  runPlatform as runPlatformOf,
  runRawLogsExpired,
  sizeMeanings,
} from '../../../src/config/flow.js';
import {
  assessedDifficulty,
  assessedSize,
  conclusionLabel,
  conclusionOf,
  formatAssessment,
  formatReplyTimeout,
  pendingTimeout,
  verdictLabel,
} from '../../../src/engine/discussion.js';
import { join, t } from '../../../src/i18n.js';
import {
  type AssessmentEntry,
  DIFFICULTIES,
  type Difficulty,
  type DiscussionEntry,
  type EventRow,
  FINISHED_RUN_STATUSES,
  type HostPlatform,
  PR_CLOSE_REASONS,
  PR_REWORK_KINDS,
  type PrCloseReason,
  type PrReworkKind,
  type RequirementSize,
  type Run,
} from '../../../src/store/types.js';
import {
  blockKindText,
  formatTime,
  missingCommandText,
  RUN_STATUS,
  shortSha,
  type Tone,
} from './format.js';
import { platformName } from './issues.js';

export interface HomeGroups {
  /** Waiting for a human: approvals and blocked Runs, oldest first. */
  attention: RunSummary[];
  running: RunSummary[];
  /** In execution order. */
  queued: RunSummary[];
  paused: RunSummary[];
  /** Most recently finished first. */
  finished: RunSummary[];
}

/** How many finished runs "recently finished" shows when the status filter is "all". */
export const FINISHED_PREVIEW_LIMIT = 20;

const byTime = (key: 'createdAt' | 'updatedAt' | 'finishedAt', dir: 1 | -1) => {
  return (a: RunSummary, b: RunSummary) => dir * (a[key] ?? '').localeCompare(b[key] ?? '');
};

export function groupRuns(
  runs: readonly RunSummary[],
  finishedLimit = FINISHED_PREVIEW_LIMIT,
): HomeGroups {
  const pick = (...statuses: RunSummary['status'][]) =>
    runs.filter((r) => statuses.includes(r.status));
  return {
    attention: pick('waiting_approval', 'blocked').sort(byTime('updatedAt', 1)),
    running: pick('running'),
    queued: pick('queued').sort((a, b) => (a.queuePos ?? 0) - (b.queuePos ?? 0)),
    paused: pick('paused').sort(byTime('updatedAt', -1)),
    finished: pick('completed', 'failed', 'cancelled', 'dropped')
      .sort(byTime('finishedAt', -1))
      .slice(0, finishedLimit),
  };
}

/**
 * Global 1-based queue position by run id, in `groupRuns(runs).queued` order.
 * Pass every run: the queue is global across repositories, so a repository
 * filter must not renumber it.
 */
export function queueRanks(runs: readonly RunSummary[]): Map<string, number> {
  const ranks = new Map<string, number>();
  groupRuns(runs).queued.forEach((run, index) => {
    ranks.set(run.id, index + 1);
  });
  return ranks;
}

/**
 * Whether the Run detail offers to remove the worktree and branch kept for inspection:
 * only for failed or cancelled Runs, and only while one of them is still there.
 */
export function canCleanUpWorkspace(
  detail: Pick<RunDetail, 'worktreeExists' | 'branchExists'> & {
    run: Pick<RunDetail['run'], 'status'>;
  },
): boolean {
  const { run, worktreeExists, branchExists } = detail;
  return (
    (run.status === 'failed' || run.status === 'cancelled') && (worktreeExists || branchExists)
  );
}

/** A branch or worktree line of the Run header. */
export interface WorkspaceLine {
  /** "分支" (branch) or "工作目录" (worktree), in the language in use. */
  label: string;
  value: string;
  /**
   * `removed`: recorded on the Run but gone (merged, or cleaned up by hand);
   * `unrecorded`: created before the setup commands passed, not recorded on the Run yet.
   */
  note: 'removed' | 'unrecorded' | null;
}

/**
 * The Run's branch and worktree for the header: those recorded on the Run, and the ones created
 * before the setup commands passed while they are on disk, so leftovers of a failed or
 * interrupted setup can be seen and cleaned up too.
 */
export function workspaceLines(
  detail: Pick<RunDetail, 'workspace' | 'worktreeExists' | 'branchExists'> & {
    run: Pick<RunDetail['run'], 'branch' | 'worktreePath'>;
  },
): WorkspaceLine[] {
  const { run, workspace } = detail;
  const line = (
    label: WorkspaceLine['label'],
    value: string,
    recorded: boolean,
    exists: boolean,
  ): WorkspaceLine[] => {
    if (recorded) return [{ label, value, note: exists ? null : 'removed' }];
    return exists ? [{ label, value, note: 'unrecorded' }] : [];
  };
  return [
    ...line(
      t({ zh: '分支', en: 'Branch' }),
      workspace.branch,
      run.branch !== null,
      detail.branchExists,
    ),
    ...line(
      t({ zh: '工作目录', en: 'Worktree' }),
      workspace.path,
      run.worktreePath !== null,
      detail.worktreeExists,
    ),
  ];
}

// ---- delivery through a pull request -----------------------------------------------------

/**
 * Whether the Run waits for its pull request to be merged on its code host (deliver: pr on
 * GitHub, deliver: mr on GitLab, its merge request): blocked on `pr_open` with the merge stage's
 * checks passed. Not stuck: it takes no execution slot, has nothing to retry, and goes on by
 * itself once the pull request is merged or closed there.
 */
export function waitingForPr(run: Pick<Run, 'status' | 'blocked'>): boolean {
  return run.status === 'blocked' && run.blocked?.kind === 'pr_open';
}

/**
 * The Run's status badge: a Run waiting for its pull request says so instead of "blocked", a
 * merge request on GitLab (`blockKindText`). `platform`: the code host the Run goes with
 * (`runPlatform`), its issue's if not given.
 */
export function runStatusBadge(
  run: Pick<Run, 'status' | 'blocked' | 'issue'>,
  platform: HostPlatform = runPlatform(run, null),
): {
  label: string;
  tone: Tone;
} {
  if (waitingForPr(run)) {
    return { label: blockKindText('pr_open', platform), tone: 'attention' };
  }
  return RUN_STATUS[run.status];
}

/**
 * 「PR #12」, 「MR !12」: the Run's pull request as people know it on the code host the Run goes
 * with (`platform`, from `runPlatform`).
 */
export function prName(pr: { number: number }, platform: HostPlatform): string {
  const cr = changeRequestTerms(platform);
  return `${cr.short} ${cr.number(pr.number)}`;
}

/**
 * 「等 PR 合并 #12」, 「等 MR 合并 !12」: the headline of a Run waiting for its pull request, on the
 * home page and the Run detail, in the words of the code host the Run goes with (`platform`, from
 * `runPlatform`). Before the bridge has opened it (`pr` still null), says that it is about to.
 */
export function prWaitTitle(run: Pick<Run, 'pr'>, platform: HostPlatform = 'github'): string {
  const { host, short, number } = changeRequestTerms(platform);
  if (!run.pr) {
    return t({
      zh: `等 ${short} 合并：下次检查 ${host} 时推送分支、开 ${short}`,
      en: `Waiting for the ${short} to merge: the branch is pushed and the ${short} opened at the next ${host} check`,
    });
  }
  return t({
    zh: `等 ${short} 合并 ${number(run.pr.number)}`,
    en: `Waiting for ${short} ${number(run.pr.number)} to merge`,
  });
}

/**
 * The short line under `prWaitTitle` on the home page: what merging or closing it on the code
 * host (`platform`) does.
 */
export function prWaitHint(platform: HostPlatform = 'github'): string {
  const { host } = changeRequestTerms(platform);
  return t({
    zh: `在 ${host} 上合并后 Run 自动完成；没合并就关掉，Run 失败`,
    en: `Merging it on ${host} completes the Run; closing it unmerged fails the Run`,
  });
}

/**
 * Who the Master trusts to ask for changes on a pull request (`isTrusted`, by what the code host
 * says of them): a GitHub repo's owner, members and collaborators; a GitLab project's members
 * from Developer up, also by its groups.
 */
function trustedReviewers(platform: HostPlatform): string {
  return platform === 'gitlab'
    ? t({
        zh: '项目里 Developer 及以上的成员，包括从群组继承的',
        en: 'a member of the project from Developer up, also through its groups',
      })
    : t({
        zh: '仓库所有者、成员和协作者',
        en: "the repo's owner, a member or a collaborator",
      });
}

/**
 * What the Run detail says about a Run waiting for its pull request into `target`: where it
 * stands, what merging it on the code host (`platform`, from `runPlatform`: a merge request on
 * GitLab), asking for changes on it (or failed checks, or a conflict) and closing it do, and that
 * there is nothing to retry here.
 */
export function prWaitText(
  run: Pick<Run, 'pr' | 'issue'>,
  target: string,
  platform: HostPlatform = 'github',
): string[] {
  const { host, short, long, number } = changeRequestTerms(platform);
  const gitlab = platform === 'gitlab';
  const opened = run.pr
    ? t({
        zh: `检查已通过，Run 的分支已推送到 ${host}，${short} ${number(run.pr.number)} 等着合并到 ${target}。`,
        en: `The checks passed and the Run's branch is pushed to ${host}, where ${short} ${number(run.pr.number)} waits to be merged into ${target}.`,
      })
    : t({
        zh: `检查已通过。Master 下次检查 ${host} 时推送 Run 的分支，开一个合并到 ${target} 的 ${short}（已经有开着的就接着用）；推送或开 ${short} 失败时，在「需求」页能看到原因，之后每次检查都会再试。`,
        en: `The checks passed. At its next ${host} check the Master pushes the Run's branch and opens a ${long} into ${target} (or keeps using one already open); if the push or the ${long} fails, the Issues page shows why, and every later check tries again.`,
      });
  // GitLab merges by a merge commit, a squash or a fast-forward, as the project is set up.
  const how = gitlab
    ? t({ zh: '（合并方式不限）', en: ' (by whichever merge method)' })
    : t({ zh: '（merge、squash 或 rebase 都行）', en: ' (by a merge, a squash or a rebase)' });
  const merged = run.issue
    ? t({
        zh: `在 ${host} 上合并它${how}后，Master 下次检查 ${host} 时把本地的 ${target} 快进到合并后的提交，Run 完成，issue 关闭。`,
        en: `Once it is merged on ${host}${how}, the Master fast-forwards the local ${target} to the merged commit at its next ${host} check, the Run completes and the issue is closed.`,
      })
    : t({
        zh: `在 ${host} 上合并它${how}后，Master 下次检查 ${host} 时把本地的 ${target} 快进到合并后的提交，Run 完成。`,
        en: `Once it is merged on ${host}${how}, the Master fast-forwards the local ${target} to the merged commit at its next ${host} check, and the Run completes.`,
      });
  const checks = gitlab
    ? t({ zh: 'head 流水线结束且有失败的 job', en: 'its head pipeline finishes with failed jobs' })
    : t({ zh: 'CI 检查全部结束且有失败的', en: 'its checks all finish with some failed' });
  const trusted = trustedReviewers(platform);
  const rework = t({
    zh: `${short} 上受信任的人（${trusted}）要求修改、${checks}，或者和 ${target} 冲突时，Master 下次检查 ${host} 时让 Run 带着这些反馈自动回去返工（回到合并阶段的 on_fail 指向的阶段，计入回退上限 max_loops），改好后推送到同一个 ${short}。其他人的评审不触发返工，也不交给 Agent。`,
    en: `If someone the Master trusts (${trusted}) asks for changes on it, ${checks}, or it conflicts with ${target}, the Master sends the Run back to work on it with that feedback at its next ${host} check (to the stage the merge stage's on_fail names, counted toward max_loops), and the changes are pushed to the same ${long}. Reviews by anyone else trigger no rework and go to no agent.`,
  });
  const closed = run.issue
    ? t({
        zh: `${short} 没合并就被关掉时，Run 结束为失败；还有重做次数（max_run_attempts）时 issue 自动重做，重做的 Run 开新的 ${short}。`,
        en: `If the ${long} is closed unmerged, the Run ends as failed; while attempts remain (max_run_attempts) the issue is redone, and the new Run opens a new ${long}.`,
      })
    : t({
        zh: `${short} 没合并就被关掉时，Run 结束为失败。`,
        en: `If the ${long} is closed unmerged, the Run ends as failed.`,
      });
  const meanwhile = t({
    zh: `等待期间不占执行名额，排队的 Run 照常执行；Master 重启后也接着等。这里没有可以重试的；终止 Run 后，Master 下次检查 ${host} 时会关掉这个 ${short}（已经合并的不动）。`,
    en: `Meanwhile it takes no execution slot, so queued Runs go ahead, and it keeps waiting across Master restarts. There is nothing to retry here; once the Run is cancelled, the Master closes the ${long} at its next ${host} check (unless it was merged).`,
  });
  return [opened, merged, rework, closed, meanwhile];
}

/**
 * What a retry does for a Run waiting for its pull request (`pr_open`): nothing, as merging or
 * closing it on the code host (`platform`, from `runPlatform`) is what moves the Run on; in that
 * host's words, a merge request on GitLab.
 */
export function prRetryHint(platform: HostPlatform): string {
  const { short, long } = changeRequestTerms(platform);
  return t({
    zh: `不能重试：${short} 合并后 Run 会完成；没合并就关掉，Run 会结束为失败。`,
    en: `No retry here: merge the ${long} and the Run completes; close it unmerged and the Run ends as failed.`,
  });
}

/**
 * What the Run detail says, next to its cancel button, of the pull request of a Run waiting for
 * it: the Master closes it at its next check of the code host (`platform`), with a comment, unless
 * it was merged meanwhile.
 */
export function prCancelHint(platform: HostPlatform = 'github'): string {
  const { host, short, long } = changeRequestTerms(platform);
  return t({
    zh: `终止后，Master 下次检查 ${host} 时关掉这个 ${short} 并留言说明（已经合并的不动）。`,
    en: ` Once cancelled, the Master closes the ${long} at its next ${host} check and says why on it (unless it was merged).`,
  });
}

/**
 * The PR line of the Run detail's summary, for any Run that has one: 「#12」 (the link; 「!12」 for
 * a merge request on GitLab, `platform`) and how it stands when the Run tells: waiting for it;
 * completed, which only a merge of it gets to; or reworking. The merge stage is the last, and its
 * pull request merged completes the Run, so a Run with one that neither waits for it nor finished
 * went back for more work: a reviewer asked for changes, a check failed or it conflicts with the
 * target branch. `rework`, the latest of the Run's reworks (`latestPrRework`), says which, when it
 * was of this pull request.
 */
export function prSummary(
  run: Pick<Run, 'pr' | 'status' | 'blocked'>,
  rework: Pick<PullRequestRework, 'number' | 'kinds' | 'reviewers' | 'checks'> | null = null,
  platform: HostPlatform = 'github',
): { label: string; note: string | null } | null {
  if (!run.pr) return null;
  const label = changeRequestTerms(platform).number(run.pr.number);
  if (waitingForPr(run)) return { label, note: t({ zh: '（等合并）', en: ' (awaiting merge)' }) };
  if (run.status === 'completed') return { label, note: t({ zh: '（已合并）', en: ' (merged)' }) };
  if (FINISHED_RUN_STATUSES.includes(run.status)) return { label, note: null };
  if (rework?.number === run.pr.number) {
    const why = prReworkReasonText(rework, platform);
    return { label, note: t({ zh: `（返工中：${why}）`, en: ` (reworking: ${why})` }) };
  }
  return { label, note: t({ zh: '（返工中）', en: ' (reworking)' }) };
}

/** A rework of a Run's pull request, as its `github.pr_rework` event records it. */
export interface PullRequestRework {
  number: number;
  url: string;
  /** The commit of the Run's it was judged on; null when not recorded. */
  head: string | null;
  /** Not empty; conflict, ci, review in that order. */
  kinds: PrReworkKind[];
  /** Who asked for changes (people the Master trusts), null for a deleted account. */
  reviewers: (string | null)[];
  /** The failed checks, and where to see each when GitHub gives a link. */
  checks: { name: string; url: string | null }[];
}

const isReworkKind = (value: unknown): value is PrReworkKind =>
  typeof value === 'string' && (PR_REWORK_KINDS as readonly string[]).includes(value);

/**
 * The rework recorded in the data of a `github.pr_rework` event; null for data not of that shape:
 * no number or link, a kind it does not know, none at all, or reviewers and checks that are not
 * lists of logins and of named checks.
 */
export function pullRequestRework(data: Record<string, unknown>): PullRequestRework | null {
  const { number, url, head, kinds, reviewers, checks } = data;
  if (typeof number !== 'number' || typeof url !== 'string') return null;
  if (!Array.isArray(kinds) || kinds.length === 0 || !kinds.every(isReworkKind)) return null;
  if (!Array.isArray(reviewers) || !reviewers.every((r) => r === null || typeof r === 'string')) {
    return null;
  }
  if (!Array.isArray(checks)) return null;
  const named: PullRequestRework['checks'] = [];
  for (const check of checks) {
    if (typeof check !== 'object' || check === null) return null;
    const { name, url: link } = check as Record<string, unknown>;
    if (typeof name !== 'string') return null;
    named.push({ name, url: typeof link === 'string' ? link : null });
  }
  return {
    number,
    url,
    head: typeof head === 'string' ? head : null,
    kinds: PR_REWORK_KINDS.filter((kind) => kinds.includes(kind)),
    reviewers: reviewers as (string | null)[],
    checks: named,
  };
}

/** How many failed checks a rework's reason names; the rest are counted. */
const CHECKS_SHOWN = 5;

/**
 * Why a pull request was sent back for more work, in one line: 「和目标分支冲突；CI 检查没通过：
 * build；@alice 要求修改」. The failed checks are CI checks on GitHub and the head pipeline's jobs
 * on GitLab (`platform`, from `runPlatform`): 「流水线没通过：build」.
 */
export function prReworkReasonText(
  rework: Pick<PullRequestRework, 'kinds' | 'reviewers' | 'checks'>,
  platform: HostPlatform = 'github',
): string {
  const gitlab = platform === 'gitlab';
  const parts = rework.kinds.map((kind) => {
    if (kind === 'conflict') {
      return t({ zh: '和目标分支冲突', en: 'a conflict with the target branch' });
    }
    if (kind === 'ci') {
      const all = rework.checks.map((c) => c.name);
      if (all.length === 0) {
        return gitlab
          ? t({ zh: '流水线没通过', en: 'a failed pipeline' })
          : t({ zh: 'CI 检查没通过', en: 'failed checks' });
      }
      const shown = join(all.slice(0, CHECKS_SHOWN));
      const more = all.length - CHECKS_SHOWN;
      const list =
        more > 0
          ? t({ zh: `${shown} 等 ${all.length} 个`, en: `${shown} and ${more} more` })
          : shown;
      if (gitlab) {
        return t({
          zh: `流水线没通过：${list}`,
          en: `${all.length === 1 ? 'a failed pipeline job' : 'failed pipeline jobs'}: ${list}`,
        });
      }
      return t({
        zh: `CI 检查没通过：${list}`,
        en: `${all.length === 1 ? 'a failed check' : 'failed checks'}: ${list}`,
      });
    }
    if (rework.reviewers.length === 0) {
      return t({ zh: '评审要求修改', en: 'changes requested in a review' });
    }
    const who = join(
      rework.reviewers.map((r) =>
        r ? `@${r}` : t({ zh: '已删除的账号', en: 'a deleted account' }),
      ),
    );
    return t({ zh: `${who} 要求修改`, en: `changes requested by ${who}` });
  });
  return parts.join(t({ zh: '；', en: '; ' }));
}

/** The latest rework of a Run's pull request, when it was recorded, and how many it had in all. */
export type LatestPrRework = PullRequestRework & { at: string; count: number };

/**
 * The latest rework of the Run's pull request, from the Run's events (oldest first); null before
 * the first.
 */
export function latestPrRework(
  events: readonly Pick<EventRow, 'type' | 'data' | 'ts'>[],
): LatestPrRework | null {
  let latest: LatestPrRework | null = null;
  let count = 0;
  for (const e of events) {
    if (e.type !== 'github.pr_rework') continue;
    const rework = pullRequestRework(e.data);
    if (!rework) continue;
    count++;
    latest = { ...rework, at: e.ts, count };
  }
  return latest;
}

/**
 * What the pull request panel says of the reworks a Run waiting for its pull request had: how
 * many, and the latest one's reason and time, in the words of the code host the Run goes with
 * (`platform`, from `runPlatform`: a merge request on GitLab). null without any of this pull
 * request's.
 */
export function prReworkNote(
  run: Pick<Run, 'pr'>,
  rework: LatestPrRework | null,
  now = new Date(),
  platform: HostPlatform = 'github',
): string | null {
  if (!run.pr || !rework || rework.number !== run.pr.number) return null;
  const { short, long } = changeRequestTerms(platform);
  const why = prReworkReasonText(rework, platform);
  const at = formatTime(rework.at, now);
  if (rework.count === 1) {
    return t({
      zh: `这个 ${short} 返工过 1 次（${at}）：${why}。`,
      en: `This ${long} was reworked once (${at}), for ${why}.`,
    });
  }
  return t({
    zh: `这个 ${short} 返工过 ${rework.count} 次，最近一次（${at}）：${why}。`,
    en: `This ${long} was reworked ${rework.count} times, most recently (${at}) for ${why}.`,
  });
}

/** Number of Runs waiting for a human, shown in the tab title. */
export function attentionCount(runs: RunSummary[]): number {
  return runs.filter((r) => r.status === 'waiting_approval' || r.status === 'blocked').length;
}

/** Browser tab title: name and slogan, preceded by `(n) ` when n Runs wait for a human. */
export function pageTitle(pending: number): string {
  return pending > 0 ? `(${pending}) ${brandTitle()}` : brandTitle();
}

export interface PatchFile {
  /** Path after the change (before it, for deletions). */
  path: string;
  lines: string[];
  added: number;
  removed: number;
}

/** Split a unified diff into files, for collapsible per-file views. */
export function splitPatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let current: PatchFile | undefined;
  for (const line of patch.split('\n')) {
    const header = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (header) {
      current = { path: header[2] ?? header[1] ?? '', lines: [], added: 0, removed: 0 };
      files.push(current);
    }
    if (!current) continue;
    current.lines.push(line);
    if (line.startsWith('+') && !line.startsWith('+++')) current.added++;
    else if (line.startsWith('-') && !line.startsWith('---')) current.removed++;
  }
  for (const file of files) {
    while (file.lines.length > 0 && file.lines[file.lines.length - 1] === '') file.lines.pop();
  }
  return files;
}

/** CSS class for one line of a unified diff. */
export function patchLineClass(line: string): string {
  if (line.startsWith('diff --git') || line.startsWith('index ')) return 'diff-meta';
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-meta';
  if (line.startsWith('@@')) return 'diff-hunk';
  if (line.startsWith('+')) return 'diff-add';
  if (line.startsWith('-')) return 'diff-del';
  return '';
}

// ---- requirement assessment --------------------------------------------------------------

export interface AssessmentHeadline {
  label: string;
  tone: Tone;
  /** The concluding round (go / drop), if the assessment has concluded. */
  conclusion: AssessmentEntry | null;
}

/** Where the Run's requirement assessment stands; null when it had none. */
export function assessmentHeadline(
  run: Pick<Run, 'discussion' | 'status' | 'blocked'>,
): AssessmentHeadline | null {
  if (run.discussion.length === 0) return null;
  const conclusion = conclusionOf(run.discussion);
  if (conclusion) {
    return {
      label: t({
        zh: `结论：${conclusionLabel(conclusion)}`,
        en: `Conclusion: ${conclusionLabel(conclusion)}`,
      }),
      tone: conclusion.verdict === 'go' ? 'success' : 'muted',
      conclusion,
    };
  }
  if (run.status === 'blocked' && run.blocked?.kind === 'discussion') {
    return {
      label: t({
        zh: '需求待讨论，等你回复',
        en: 'The requirement is under discussion, waiting for your reply',
      }),
      tone: 'attention',
      conclusion: null,
    };
  }
  if (FINISHED_RUN_STATUSES.includes(run.status)) {
    return { label: t({ zh: '没有结论', en: 'No conclusion' }), tone: 'muted', conclusion: null };
  }
  if (pendingTimeout(run.discussion)) {
    return {
      label: t({
        zh: '没人回复，评估自己决定中',
        en: 'Nobody replied; the assessment is deciding on its own',
      }),
      tone: 'active',
      conclusion: null,
    };
  }
  return { label: t({ zh: '重新评估中', en: 'Reassessing' }), tone: 'active', conclusion: null };
}

/**
 * The requirement's size the Run detail shows beside the assessment: the one stages planning by
 * size go by (`assessedSize`, the latest go round's), so the page tells why a round was split or
 * not. Undefined when the assessment concluded drop, even if that round gave a size: nothing is
 * planned for a dropped requirement.
 */
export function assessmentSize(run: Pick<Run, 'discussion'>): RequirementSize | undefined {
  if (conclusionOf(run.discussion)?.verdict === 'drop') return undefined;
  return assessedSize(run.discussion);
}

/**
 * The requirement's difficulty the Run detail shows beside the size: the one stages with
 * `agent_candidates` pick their agent by (`assessedDifficulty`, the latest go round's), so the page
 * tells why a round went to the agent it did. Undefined when the assessment concluded drop, even
 * if that round gave a difficulty: nothing runs for a dropped requirement.
 */
export function assessmentDifficulty(run: Pick<Run, 'discussion'>): Difficulty | undefined {
  if (conclusionOf(run.discussion)?.verdict === 'drop') return undefined;
  return assessedDifficulty(run.discussion);
}

/**
 * 「难度 mid」 and what the difficulty means (`difficultyMeanings`, the meanings the assessment
 * judged by), shown beside the size; null without a difficulty (`assessmentDifficulty`).
 */
export function difficultyText(
  difficulty: Difficulty | undefined,
): { label: string; meaning: string } | null {
  if (!difficulty) return null;
  const meaning = difficultyMeanings()[difficulty];
  // Shown on its own, so it starts with a capital in English.
  return {
    label: t({ zh: `难度 ${difficulty}`, en: `Difficulty ${difficulty}` }),
    meaning: meaning.charAt(0).toUpperCase() + meaning.slice(1),
  };
}

/**
 * 「规模 L」 and what the size means (`sizeMeanings`, the meanings the assessment sized by),
 * shown beside the assessment's conclusion; null without a size (`assessmentSize`).
 */
export function sizeText(
  size: RequirementSize | undefined,
): { label: string; meaning: string } | null {
  if (!size) return null;
  const meaning = sizeMeanings()[size];
  // Shown on its own, so it starts with a capital in English.
  return {
    label: t({ zh: `规模 ${size}`, en: `Size ${size}` }),
    meaning: meaning.charAt(0).toUpperCase() + meaning.slice(1),
  };
}

/**
 * When a Run waiting for a reply to the assessment's questions stops waiting and the assessment
 * decides on its own, in epoch milliseconds, as the engine computes it; null when it is not
 * waiting, or waits however long it takes.
 */
export function replyDeadlineOf(detail: Pick<RunDetail, 'run' | 'stageRuns'>): number | null {
  const stageIdOf = (id: string) => detail.stageRuns.find((sr) => sr.id === id)?.stageId;
  return discussionReplyWait(detail.run, stageIdOf)?.deadline ?? null;
}

/** 「Agent coder 额度用尽或被限流，预计 14:05:00 继续」: why a queued Run waits, and until when. */
export function rateLimitText(wait: RateLimitedWait, now = new Date()): string {
  const at = formatTime(wait.retryAt, now);
  return t({
    zh: `Agent ${wait.agentId} 额度用尽或被限流，预计 ${at} 继续`,
    en: `Agent ${wait.agentId} is out of quota or rate-limited; expected to continue at ${at}`,
  });
}

/**
 * Why a queued Run waits when `waitingForMaxRuns`: the Runs executing across all repos reached
 * config.yaml's `concurrency.max_runs` (`maxRuns`; null when the configuration is not loaded).
 */
export function maxRunsWaitText(maxRuns: number | null): string {
  const limit =
    maxRuns === null ? 'concurrency.max_runs' : `concurrency.max_runs: ${String(maxRuns)}`;
  return t({
    zh: `所有仓库执行中的 Run 已达上限（${limit}），等其中一个结束再开始`,
    en: `The Runs executing across all repos are at the limit (${limit}); it starts once one of them ends`,
  });
}

/** How many of the paths a wait for an overlapping Run names; the rest are counted. */
const CONFLICT_PATHS_SHOWN = 3;

/**
 * `conflictWaitText` around the id of the Run waited for, so that a page can make the id a link:
 * the text is `${before}${wait.runId}${after}`.
 */
export function conflictWaitParts(wait: ConflictWait): { before: string; after: string } {
  const shown = join(wait.paths.slice(0, CONFLICT_PATHS_SHOWN));
  const more = wait.paths.length - CONFLICT_PATHS_SHOWN;
  const paths =
    more > 0
      ? t({ zh: `${shown} 等 ${wait.paths.length} 处`, en: `${shown} and ${more} more` })
      : shown;
  return t({
    zh: { before: '等 Run ', after: `：预计改同一处（${paths}）` },
    en: {
      before: 'Waiting for Run ',
      after: `: expected to change the same ${wait.paths.length === 1 ? 'place' : 'places'} (${paths})`,
    },
  });
}

/**
 * 「等 Run X：预计改同一处（src/engine、docs）」: why a queued Run waits when `waitingForConflict`
 * (or its `run.waiting_conflict` event says): Run X of its repo executes and has not merged yet,
 * and both assessments expect to change these paths. Names the first few paths, counts the rest.
 */
export function conflictWaitText(wait: ConflictWait): string {
  const { before, after } = conflictWaitParts(wait);
  return `${before}${wait.runId}${after}`;
}

/**
 * 「执行中 2 / 上限 3」: how many Runs execute across all repos (`executing`) against config.yaml's
 * `concurrency.max_runs`; `allRepos` when the list shows one repo only, so the count is not
 * taken for that repo's.
 */
export function executingOfMaxText(executing: number, maxRuns: number, allRepos = false): string {
  return allRepos
    ? t({
        zh: `所有仓库执行中 ${executing} / 上限 ${maxRuns}（concurrency.max_runs）`,
        en: `${executing} of at most ${maxRuns} executing across all repos (concurrency.max_runs)`,
      })
    : t({
        zh: `执行中 ${executing} / 上限 ${maxRuns}（concurrency.max_runs）`,
        en: `${executing} of at most ${maxRuns} executing (concurrency.max_runs)`,
      });
}

/**
 * 「预计 14:05:00 自动重做，开始第 2 次尝试」: when the issue of a failed Run (its `attempt`) is
 * redone as a new Run (`RunDetail.redoAt`). Once that time has passed, the redo starts at the next
 * check, unless today's automatic spending is at its limit or the work switch is off.
 */
export function redoText(redoAt: string, attempt: number, now = new Date()): string {
  const next = attempt + 1;
  if (Date.parse(redoAt) <= now.getTime()) {
    return t({
      zh: `下一次检查时自动重做，开始第 ${next} 次尝试`,
      en: `To be redone automatically at the next check, as attempt ${next}`,
    });
  }
  const at = formatTime(redoAt, now);
  return t({
    zh: `预计 ${at} 自动重做，开始第 ${next} 次尝试`,
    en: `To be redone automatically at ${at}, as attempt ${next}`,
  });
}

/**
 * Why the raw logs of the Run's executions can no longer be opened: the Master deletes them once
 * the Run ended over RAW_LOG_KEEP_DAYS ago (`runRawLogsExpired`); the agent output still shows
 * from the events kept beside them. null while they are kept.
 */
export function rawLogPrunedText(
  run: Pick<Run, 'status' | 'issue' | 'finishedAt'>,
  now = new Date(),
): string | null {
  if (!runRawLogsExpired(run, now.getTime())) return null;
  return t({
    zh: `原始日志已超过保留期（Run 结束 ${RAW_LOG_KEEP_DAYS} 天后）被删除`,
    en: `The raw log was deleted once past retention (${RAW_LOG_KEEP_DAYS} days after the Run ended)`,
  });
}

const SELECTION_REASONS: readonly AgentSelection['reason'][] = [
  'first',
  'fit',
  'highest',
  'unavailable',
];

/**
 * 「阶段 implement 第 1 轮：按难度 mid，从候选（a、b、c）里选了 b……」: who a round of a stage with
 * `agent_candidates` went to and why (`agent.selected`, `AgentSelection`); null when the data is
 * not of that shape.
 */
function agentSelectedText(data: EventRow['data']): string | null {
  const { stageId, round, agentId, difficulty, reason, candidates } = data;
  const why = SELECTION_REASONS.find((r) => r === reason);
  if (
    typeof stageId !== 'string' ||
    typeof round !== 'number' ||
    typeof agentId !== 'string' ||
    !why ||
    !Array.isArray(candidates) ||
    !candidates.every((c) => typeof c === 'string')
  ) {
    return null;
  }
  const level = DIFFICULTIES.find((d) => d === difficulty);
  const list = join(candidates);
  const where = t({
    zh: `阶段 ${stageId} 第 ${round} 轮：`,
    en: `Stage ${stageId}, round ${round}: `,
  });
  switch (why) {
    case 'fit':
      if (!level) return null;
      return `${where}${t({
        zh: `按难度 ${level}，从候选（${list}）里选了 ${agentId}：档次够用、成本最低`,
        en: `by difficulty ${level}, ${agentId} was picked from the candidates (${list}) as the cheapest whose tier is enough`,
      })}`;
    case 'highest':
      if (!level) return null;
      return `${where}${t({
        zh: `按难度 ${level}，候选（${list}）里没有档次够的，选了档次最高的 ${agentId}`,
        en: `by difficulty ${level}, none of the candidates (${list}) has a tier that high, so ${agentId}, the highest tier, was picked`,
      })}`;
    case 'first':
      return `${where}${t({
        zh: `需求评估没有给出难度，用候选（${list}）里第一个能用的 ${agentId}`,
        en: `the assessment gave no difficulty, so ${agentId}, the first usable of the candidates (${list}), was picked`,
      })}`;
    case 'unavailable':
      return `${where}${t({
        zh: `候选（${list}）都不能跑这个阶段，先交给第一个 ${agentId}，之后按 on_agent_error 处理`,
        en: `none of the candidates (${list}) can run this stage, so it goes to the first, ${agentId}, and on_agent_error decides what follows`,
      })}`;
  }
}

/** 「失败」: how a Run ended, as the reason the Master closed its pull request gives it. */
function prCloseReasonText(reason: PrCloseReason): string {
  switch (reason) {
    case 'failed':
      return t({ zh: '失败', en: 'it failed' });
    case 'cancelled':
      return t({ zh: '被终止', en: 'it was cancelled' });
    case 'issue_closed':
      return t({ zh: 'issue 被关掉，Run 随之终止', en: 'its issue was closed' });
    case 'restarted':
      return t({
        zh: 'issue 的内容改了，按新内容重新开始',
        en: "its issue's text changed, so it was started over",
      });
    case 'dropped':
      return t({ zh: '需求评估决定不做', en: 'the requirement assessment dropped it' });
  }
}

/**
 * The code host of an event about a Run's pull request (`github.pr_*`): GitLab's carry it in their
 * data (`platform: 'gitlab'`), GitHub's go without.
 */
function pullRequestEventPlatform(data: Record<string, unknown>): HostPlatform {
  return data.platform === 'gitlab' ? 'gitlab' : 'github';
}

/**
 * The events of delivering through a pull request (deliver: pr; deliver: mr, a merge request on
 * GitLab) in words: the merge stage waits for it (`merge.pr_pending`, in the words of the code
 * host the Run goes with, `platform`), it was opened, merged or closed on its code host, sent back
 * for more work, updated with the reworked commits, a review on it ignored, or, once the Run ended
 * without completing, closed by the Master or found merged or closed already (`github.pr_*`, in
 * the words of the code host the event names, `pullRequestEventPlatform`); null for other events
 * and data not of that shape.
 */
function pullRequestEventText(
  event: Pick<EventRow, 'type' | 'data'>,
  platform: HostPlatform,
): string | null {
  const { target, number, base, mergeCommit, head } = event.data;
  if (event.type === 'merge.pr_pending') {
    if (typeof target !== 'string') return null;
    const { short, long, deliver } = changeRequestTerms(platform);
    return t({
      zh: `检查已通过，这个仓库通过 ${short} 交付（deliver: ${deliver}）：不合并进本地的 ${target}，等推送 Run 的分支、开 ${short}`,
      en: `The checks passed and this repo delivers through ${long}s (deliver: ${deliver}): nothing is merged into the local ${target}; the Run's branch is to be pushed and a ${long} opened`,
    });
  }
  if (typeof number !== 'number') return null;
  const on = pullRequestEventPlatform(event.data);
  const { host, short, long } = changeRequestTerms(on);
  /** 「PR #12」, 「MR !12」. */
  const pr = prName({ number }, on);
  switch (event.type) {
    case 'github.pr_opened':
      return typeof base === 'string'
        ? t({
            zh: `推送了 Run 的分支，${pr} 等着合并到 ${base}`,
            en: `The Run's branch was pushed; ${pr} waits to be merged into ${base}`,
          })
        : null;
    case 'github.pr_merged':
      return typeof mergeCommit === 'string'
        ? t({
            zh: `${pr} 在 ${host} 上合并了（合并提交 ${shortSha(mergeCommit)}），本地目标分支已快进`,
            en: `${pr} was merged on ${host} (merge commit ${shortSha(mergeCommit)}), and the local target branch fast-forwarded`,
          })
        : t({
            zh: `${pr} 在 ${host} 上合并了，本地目标分支已快进`,
            en: `${pr} was merged on ${host}, and the local target branch fast-forwarded`,
          });
    case 'github.pr_closed':
      return t({
        zh: `${pr} 没合并就被关掉了，Run 结束为失败`,
        en: `${pr} was closed without being merged, so the Run ended as failed`,
      });
    case 'github.pr_closed_by_master': {
      const reason = PR_CLOSE_REASONS.find((r) => r === event.data.reason);
      if (!reason) return null;
      return t({
        zh: `Run 没做完就结束了（${prCloseReasonText(reason)}），${pr} 不会再更新：Master 关掉了它，并在 ${short} 上说明了原因`,
        en: `The Run ended unfinished (${prCloseReasonText(reason)}), so ${pr} gets no more updates: the Master closed it and said why on it`,
      });
    }
    case 'github.pr_found_closed':
      if (event.data.state === 'merged') {
        return t({
          zh: `Run 没做完就结束了，它的 ${pr} 在 ${host} 上已经合并，Master 没有动它`,
          en: `The Run ended unfinished, and its ${pr} was already merged on ${host}; the Master left it as it is`,
        });
      }
      if (event.data.state === 'closed') {
        return t({
          zh: `Run 没做完就结束了，它的 ${pr} 在 ${host} 上已经关掉，不用 Master 再关`,
          en: `The Run ended unfinished, and its ${pr} was already closed on ${host}; nothing for the Master to close`,
        });
      }
      return null;
    case 'github.pr_rework': {
      const rework = pullRequestRework(event.data);
      if (!rework) return null;
      const why = prReworkReasonText(rework, on);
      const at = rework.head
        ? t({ zh: `（提交 ${shortSha(rework.head)}）`, en: ` (commit ${shortSha(rework.head)})` })
        : t({ zh: ' ', en: '' });
      const merge = rework.kinds.includes('conflict')
        ? t({
            zh: '；回到的是 Agent 阶段时，那一轮先合并目标分支、解决冲突',
            en: '; when that is an agent stage, its round starts by merging the target branch to resolve the conflict',
          })
        : '';
      return t({
        zh: `${pr}${at}需要返工：${why}。Run 带着这些反馈回到合并阶段的 on_fail 指向的阶段（计入回退上限 max_loops，用完后按 on_exhausted 处理）${merge}，改好后推送到同一个 ${short}`,
        en: `${pr}${at} needs more work: ${why}. The Run goes back with this feedback to the stage the merge stage's on_fail names (counted toward max_loops; past them, on_exhausted decides)${merge}, and the changes are pushed to the same ${long}`,
      });
    }
    case 'github.pr_updated':
      return typeof head === 'string'
        ? t({
            zh: `返工后的提交已推送到 ${pr}（head ${shortSha(head)}），${short} 接着等合并`,
            en: `The reworked commits were pushed to ${pr} (head ${shortSha(head)}), which waits to be merged again`,
          })
        : t({
            zh: `返工后的提交已推送到 ${pr}，${short} 接着等合并`,
            en: `The reworked commits were pushed to ${pr}, which waits to be merged again`,
          });
    case 'github.pr_review_ignored': {
      const { reviewer, association } = event.data;
      if (reviewer !== null && typeof reviewer !== 'string') return null;
      if (typeof association !== 'string') return null;
      const who = reviewer ? `@${reviewer}` : t({ zh: '已删除的账号', en: 'a deleted account' });
      // Who counts: a GitHub repo's members; a GitLab project's from Developer up.
      const member =
        on === 'gitlab'
          ? t({
              zh: '不是项目里 Developer 及以上的成员',
              en: 'not a member of the project from Developer up',
            })
          : t({ zh: '不是仓库成员', en: 'not a member of the repo' });
      return t({
        zh: `${pr} 上 ${who}（${association}）要求修改，但${member}：评审已忽略，不触发返工，内容也不交给 Agent`,
        en: `The review by ${who} (${association}) asking for changes on ${pr} was ignored, as they are ${member}: it triggers no rework, and its text goes to no agent`,
      });
    }
    default:
      return null;
  }
}

/**
 * 「@alice 在 issue 上用 /ares1 retry 重试了」: what a human did with a command on the Run's issue
 * (the one event of each with `source: 'issue'`), and how many commands on it were not carried
 * out because their authors are not trusted. null for other events, and for the same events
 * from the dashboard.
 */
export function issueCommandEventText(event: Pick<EventRow, 'type' | 'data'>): string | null {
  if (event.type === 'issue.commands_ignored') {
    const { count } = event.data;
    if (typeof count !== 'number') return null;
    return t({
      zh: `issue 上有 ${count} 条命令的作者不是仓库成员，没有执行`,
      en: `${count} command${count === 1 ? '' : 's'} on the issue by non-members of the repo ${count === 1 ? 'was' : 'were'} not carried out`,
    });
  }
  const { source, author } = event.data;
  if (source !== 'issue' || (author !== null && typeof author !== 'string')) return null;
  // Each English text opens with who wrote the command.
  const who = author ? `@${author}` : t({ zh: '已删除的账号', en: 'A deleted account' });
  switch (event.type) {
    case 'approval.approved':
      return t({
        zh: `${who} 在 issue 上用 /ares1 approve 批准了`,
        en: `${who} approved with /ares1 approve on the issue`,
      });
    case 'approval.rejected':
      return t({
        zh: `${who} 在 issue 上用 /ares1 reject 驳回了`,
        en: `${who} rejected with /ares1 reject on the issue`,
      });
    case 'run.retry':
      return event.data.kind === 'untrusted_issue'
        ? t({
            zh: `${who} 在 issue 上用 /ares1 confirm 确认了需求`,
            en: `${who} confirmed the requirement with /ares1 confirm on the issue`,
          })
        : t({
            zh: `${who} 在 issue 上用 /ares1 retry 重试了`,
            en: `${who} retried with /ares1 retry on the issue`,
          });
    case 'run.resumed':
      return t({
        zh: `${who} 在 issue 上用 /ares1 resume 让暂停的 Run 继续`,
        en: `${who} resumed the paused Run with /ares1 resume on the issue`,
      });
    case 'run.status':
      return event.data.status === 'cancelled'
        ? t({
            zh: `${who} 在 issue 上用 /ares1 cancel 终止了 Run`,
            en: `${who} cancelled the Run with /ares1 cancel on the issue`,
          })
        : null;
    default:
      return null;
  }
}

/**
 * The event in words, for the events list, from its structured data; null for events that only
 * show their data. `platform`: the code host the Run goes with (`runPlatform`), named where an
 * event is about its commits, and whose words the merge stage's wait for a pull request uses (a
 * merge request on GitLab); the events about the pull request itself name their own.
 */
export function eventText(
  event: Pick<EventRow, 'type' | 'data'>,
  now = new Date(),
  platform: HostPlatform = 'github',
): string | null {
  if (event.type === 'agent.selected') return agentSelectedText(event.data);
  const command = issueCommandEventText(event);
  if (command !== null) return command;
  if (event.type === 'task.rate_limited') {
    const { agentId, retryAt } = event.data;
    if (typeof agentId === 'string' && typeof retryAt === 'string') {
      return rateLimitText({ agentId, retryAt }, now);
    }
  }
  if (event.type === 'run.waiting_conflict') {
    const { blockedBy, paths } = event.data;
    if (
      typeof blockedBy === 'string' &&
      Array.isArray(paths) &&
      paths.length > 0 &&
      paths.every((p) => typeof p === 'string')
    ) {
      const wait = conflictWaitText({ runId: blockedBy, paths });
      return t({
        zh: `${wait}。这个 Run 在队列里等，不占名额，等它合并或结束后接着做，不重新评估`,
        en: `${wait}. This Run waits in the queue, taking no place, and goes on once that one has merged or ended, without being assessed again`,
      });
    }
  }
  if (event.type === 'run.blocked' && event.data.kind === 'environment') {
    const { missing } = event.data;
    if (typeof missing === 'string') {
      return t({
        zh: `${missingCommandText(missing)}：命令没能运行，这不是代码的问题，不返工，也不消耗返工和重做次数；找到它或 Master 重启后自动接着做`,
        en: `${missingCommandText(missing)}: the commands could not run, which is no fault of the code, so there is no rework and no rework or redo is used up; the Run goes on by itself once it is found or the Master restarts`,
      });
    }
  }
  if (event.type === 'environment.resumed') {
    const { missing, reason } = event.data;
    const what =
      typeof missing === 'string' ? missing : t({ zh: '缺的命令', en: 'the missing program' });
    return reason === 'restart'
      ? t({
          zh: `Master 重启了，在新的运行环境里重新运行之前因为找不到 ${what} 没能运行的命令`,
          en: `The Master restarted, so the commands that could not find ${what} run again in its environment`,
        })
      : t({
          zh: `运行环境里又能找到 ${what} 了，自动接着做`,
          en: `${what} is found in the environment again, so the Run goes on by itself`,
        });
  }
  const pr = pullRequestEventText(event, platform);
  if (pr !== null) return pr;
  if (event.type === 'run.merge_remote_obsolete') {
    const { remote, target } = event.data;
    const host = platformName(platform);
    if (typeof remote === 'string' && typeof target === 'string') {
      return t({
        zh: `${target} 已经有了这个 Run 要合并的 ${host} 提交 ${shortSha(remote)}（Master 自己合并了，或者别的 Run 合并了进去），没什么要合并的了：不再启动 Agent，Run 直接完成`,
        en: `${target} has the commit ${shortSha(remote)} from ${host} this Run was to merge already (the Master merged it by itself, or another Run did), so nothing is left to merge: the Run completed without starting another agent`,
      });
    }
  }
  if (event.type === 'task.verify_resumed') {
    return t({
      zh: 'Agent 的改动还在工作目录里，只重新运行检查命令',
      en: "The agent's changes are still in the worktree, so only the verify commands run again",
    });
  }
  if (event.type === 'review.discard_deferred') {
    return t({
      zh: '评审中途停下时，没能丢掉评审者留下的改动、把工作目录放回评审开始时的提交；Run 再开始执行时先补做，再检查工作目录、重新评审',
      en: 'When the review stopped halfway, what the reviewer left could not be dropped to put the working directory back where the review started; the Run does it first when it next starts executing, before its working directory is checked and the review runs again',
    });
  }
  const { reason, supersededBy } = event.data;
  if (reason === 'superseded' && typeof supersededBy === 'string') {
    if (event.type === 'workspace.removed') {
      return t({
        zh: `同一 issue 的 Run ${supersededBy} 已完成，自动删掉了这次失败留下的工作目录和分支`,
        en: `Run ${supersededBy} of the same issue completed, so the working directory and branch this failed Run kept were removed automatically`,
      });
    }
    if (event.type === 'workspace.cleanup_failed') {
      return t({
        zh: `同一 issue 的 Run ${supersededBy} 已完成，但没能自动删掉这次失败留下的工作目录和分支，请在「工作区」页手动清理`,
        en: `Run ${supersededBy} of the same issue completed, but the working directory and branch this failed Run kept could not be removed automatically; clean them up by hand on the Workspaces page`,
      });
    }
  }
  if (event.type === 'run.iteration_closed') {
    const { iteration } = event.data;
    const which = typeof iteration === 'number' ? ` #${iteration}` : '';
    return t({
      zh: `所属迭代${which ? `${which} ` : ''}被人关掉了，这个 Run 随之终止，它的 issue 关成不做`,
      en: `Its iteration${which} was closed by a human, so this Run was terminated and its issue closed as not planned`,
    });
  }
  if (event.type === 'run.iteration_cancelled') {
    return t({
      zh: '所属迭代被人在看板上终止了，这个 Run 随之终止',
      en: 'Its iteration was cancelled on the dashboard, so this Run was terminated',
    });
  }
  const { newRun } = event.data;
  if (event.type === 'run.goal_changed' && typeof newRun === 'string') {
    return t({
      zh: `issue 的标题或正文改了，这次 Run 按的是旧内容，已自动终止；按新内容开始了 Run ${newRun}`,
      en: `The issue's title or body changed, so this Run, which worked from the old text, was terminated automatically; Run ${newRun} started on the new one`,
    });
  }
  if (reason === 'goal_changed' && typeof newRun === 'string') {
    if (event.type === 'workspace.removed') {
      return t({
        zh: `issue 改过后由 Run ${newRun} 按新内容重做，自动删掉了这次 Run 的工作目录和分支`,
        en: `Run ${newRun} redoes the changed issue from the start, so this Run's working directory and branch were removed automatically`,
      });
    }
    if (event.type === 'workspace.cleanup_failed') {
      return t({
        zh: `issue 改过后由 Run ${newRun} 按新内容重做，但没能自动删掉这次 Run 的工作目录和分支，请在「工作区」页手动清理`,
        en: `Run ${newRun} redoes the changed issue from the start, but this Run's working directory and branch could not be removed automatically; clean them up by hand on the Workspaces page`,
      });
    }
  }
  const { keptRun } = event.data;
  if (reason === 'retries_exhausted' && typeof keptRun === 'string') {
    if (event.type === 'workspace.removed') {
      return t({
        zh: `issue 用完了重做次数，只保留最后一次尝试 ${keptRun} 的工作目录和分支，自动删掉了这次的`,
        en: `The issue used up its attempts, so only the last one, Run ${keptRun}, keeps its working directory and branch; this Run's were removed automatically`,
      });
    }
    if (event.type === 'workspace.cleanup_failed') {
      return t({
        zh: `issue 用完了重做次数，只保留最后一次尝试 ${keptRun} 的工作目录和分支，但没能自动删掉这次的，请在「工作区」页手动清理`,
        en: `The issue used up its attempts, so only the last one, Run ${keptRun}, keeps its working directory and branch, but this Run's could not be removed automatically; clean them up by hand on the Workspaces page`,
      });
    }
  }
  return null;
}

export interface DiscussionItem {
  /** Who said it: the assessment (with its round) or a human. */
  title: string;
  tone: Tone;
  text: string;
  at: string;
  /** What else happened to it, e.g. comments on the issue that were not taken as replies. */
  note?: string;
}

/**
 * The code host a Run goes with: its issue's (`RunIssue.platform`); for a Run of no issue, such as
 * one the Master created to merge the target branch's new commits, its repo's source of
 * requirements (`source`, from `repoSourceOf`); GitHub otherwise. The rule is `runPlatform` of
 * src/config/flow.ts, which the Master's texts go by too.
 */
export function runPlatform(run: Pick<Run, 'issue'>, source: RepoSourceView | null): HostPlatform {
  return runPlatformOf(run, source?.source);
}

/** How to answer the assessment's questions on the Run's issue, on the code host it is on. */
export function issueReplyHint(platform: HostPlatform): string {
  const host = platformName(platform);
  return t({
    zh: `可以直接在 issue 上回复（只认仓库成员和 Master 所用账号的回复），Master 下次检查 ${host} 时会带着回复重新评估；也可以在这里回复。`,
    en: `You can reply on the issue (only replies by members of the repo and the account the Master uses count): the Master reassesses with your reply the next time it checks ${host}. Or reply here.`,
  });
}

/**
 * 「issue 上有 2 条非仓库成员的评论，没有当作回复」: comments after the assessment's questions by
 * people the Master does not trust.
 */
export function ignoredCommentsText(n: number): string {
  return t({
    zh: `issue 上有 ${n} 条非仓库成员的评论，没有当作回复，也不会交给 Agent`,
    en: `${n} comment${n === 1 ? '' : 's'} on the issue by non-members of the repo ${n === 1 ? 'was' : 'were'} not taken as ${n === 1 ? 'a reply' : 'replies'} and ${n === 1 ? 'does' : 'do'} not go to the agents`,
  });
}

/**
 * 「issue 作者 @x（NONE）不是仓库成员……」: what the Run page says about an issue written by
 * someone the Master does not trust; null when it trusts the author (or did not check).
 */
export function untrustedIssueText(issue: Run['issue']): string | null {
  const untrusted = issue?.untrusted;
  if (!untrusted) return null;
  const who = untrusted.author
    ? `@${untrusted.author}`
    : t({ zh: '已删除的账号', en: 'a deleted account' });
  const role = untrusted.association;
  if (untrusted.confirmedAt === null) {
    return t({
      zh: `issue 的作者 ${who}（${role}）不是仓库成员：目标是建 Run 时 issue 的内容，要你确认后才交给 Agent。`,
      en: `The issue's author ${who} (${role}) is not a member of the repo: the goal is the issue as it was when the Run was created, and goes to the agents only once you confirm it.`,
    });
  }
  return t({
    zh: `issue 的作者 ${who}（${role}）不是仓库成员：目标是建 Run 时 issue 的内容，${formatTime(untrusted.confirmedAt)} 由人确认后才交给 Agent。`,
    en: `The issue's author ${who} (${role}) is not a member of the repo: the goal is the issue as it was when the Run was created, confirmed by a human at ${formatTime(untrusted.confirmedAt)} before it went to the agents.`,
  });
}

/** The discussion, oldest first, as the Run detail lists it. */
export function discussionItems(discussion: readonly DiscussionEntry[]): DiscussionItem[] {
  let round = 0;
  return discussion.map((e) => {
    if (e.role === 'human') {
      return {
        title: t({
          zh: `人的回复（${e.source === 'issue' ? 'issue 上' : '看板上'}）`,
          en: `Human reply (${e.source === 'issue' ? 'on the issue' : 'on the dashboard'})`,
        }),
        tone: 'neutral',
        text: e.text,
        at: e.at,
      };
    }
    if (e.role === 'timeout') {
      return { ...formatReplyTimeout(e), tone: 'muted', at: e.at };
    }
    round++;
    const what =
      e.verdict === 'ask'
        ? e.proposedDrop
          ? t({
              zh: '认为不该做，请人确认',
              en: 'Thinks it should not be done; asks a human to confirm',
            })
          : verdictLabel('ask')
        : conclusionLabel(e);
    return {
      title: t({ zh: `第 ${round} 轮评估：${what}`, en: `Assessment round ${round}: ${what}` }),
      tone: e.verdict === 'ask' ? 'attention' : e.verdict === 'go' ? 'success' : 'muted',
      text: formatAssessment(e),
      at: e.at,
      ...(e.ignoredComments ? { note: ignoredCommentsText(e.ignoredComments) } : {}),
    };
  });
}
