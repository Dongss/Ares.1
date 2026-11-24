import type { RateLimitedWait, RunDetail, RunSummary } from '../../../src/api/types.js';
import { brandTitle } from '../../../src/brand.js';
import {
  discussionReplyWait,
  RAW_LOG_KEEP_DAYS,
  runRawLogsExpired,
} from '../../../src/config/flow.js';
import {
  conclusionLabel,
  conclusionOf,
  formatAssessment,
  formatReplyTimeout,
  pendingTimeout,
  verdictLabel,
} from '../../../src/engine/discussion.js';
import { t } from '../../../src/i18n.js';
import {
  type AssessmentEntry,
  type DiscussionEntry,
  type EventRow,
  FINISHED_RUN_STATUSES,
  type RequirementSize,
  type Run,
} from '../../../src/store/types.js';
import { formatTime, missingCommandText, type Tone } from './format.js';

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
 * 「规模 L」 and what the size means, shown beside the assessment's conclusion; null when the
 * round gave no size (left out, or recorded before assessments gave sizes).
 */
export function sizeText(
  size: RequirementSize | undefined,
): { label: string; meaning: string } | null {
  if (!size) return null;
  const meanings: Record<RequirementSize, string> = t({
    zh: {
      S: '一处小改动',
      M: '一个 Run 能做完的普通需求',
      L: '要改多个模块，一次做完容易超时或返工',
    },
    en: {
      S: 'One small change',
      M: 'An ordinary requirement one Run can finish',
      L: 'Changes across several modules, likely to time out or need rework in one go',
    },
  });
  return { label: t({ zh: `规模 ${size}`, en: `Size ${size}` }), meaning: meanings[size] };
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

/**
 * The event in words, for the events list, from its structured data; null for events that only
 * show their data.
 */
export function eventText(event: Pick<EventRow, 'type' | 'data'>, now = new Date()): string | null {
  if (event.type === 'task.rate_limited') {
    const { agentId, retryAt } = event.data;
    if (typeof agentId === 'string' && typeof retryAt === 'string') {
      return rateLimitText({ agentId, retryAt }, now);
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
  if (event.type === 'task.verify_resumed') {
    return t({
      zh: 'Agent 的改动还在工作目录里，只重新运行检查命令',
      en: "The agent's changes are still in the worktree, so only the verify commands run again",
    });
  }
  if (event.type === 'review.discard_deferred') {
    return t({
      zh: '评审中途停下时，没能丢掉评审者留下的改动、把工作目录放回评审开始时的提交；Run 再拿到执行位时先补做，再检查工作目录、重新评审',
      en: 'When the review stopped halfway, what the reviewer left could not be dropped to put the working directory back where the review started; the Run does it first when it next gets the execution slot, before its working directory is checked and the review runs again',
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
