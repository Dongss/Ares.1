// When a human needs to know: shared by the Master's system notifications and the
// dashboard's browser notifications. Pure; the dashboard imports this file.

import { SCOUT_FAILURE_NOTIFY_AFTER } from '../config/flow.js';
import { join, type Lang, t } from '../i18n.js';
import type { BlockKind, EventRow } from '../store/types.js';

/**
 * A record whose values are picked in the language in use each time they are read, so that a
 * shared constant (read as `X[key]`, `Object.values(X)`) follows a language switch.
 */
function localized<K extends string, V>(texts: Record<K, Record<Lang, V>>): Record<K, V> {
  const out = {} as Record<K, V>;
  for (const key of Object.keys(texts) as K[]) {
    Object.defineProperty(out, key, { enumerable: true, get: () => t(texts[key]) });
  }
  return out;
}

/** Why a Run is blocked, in the language in use. */
export const BLOCK_KIND: Record<BlockKind, string> = localized<BlockKind, string>({
  task_failed: { zh: '返工次数用完仍未通过', en: 'Still failing after all retries' },
  agent_error: { zh: 'Agent 执行出错', en: 'Agent error' },
  agent_unavailable: { zh: 'Agent 不可用', en: 'Agent unavailable' },
  max_loops: { zh: '阶段回退次数用完', en: 'Stage loop limit reached' },
  merge_conflict: { zh: '合并冲突', en: 'Merge conflict' },
  target_dirty: { zh: '目标分支有未提交的改动', en: 'Uncommitted changes on the target branch' },
  setup_failed: { zh: '准备命令失败', en: 'Setup command failed' },
  workspace: { zh: '工作目录与记录不一致', en: 'Workspace does not match the record' },
  budget: { zh: '超出预算', en: 'Over budget' },
  discussion: { zh: '需求待讨论', en: 'Requirement under discussion' },
  untrusted_issue: {
    zh: 'issue 作者不是仓库成员，等你确认需求',
    en: 'Issue by a non-member: confirm the requirement',
  },
  environment: { zh: '运行环境缺少命令', en: 'Command missing from the environment' },
  pr_open: { zh: '等 PR 合并', en: 'Waiting for the PR to merge' },
  error: { zh: 'Master 内部错误', en: 'Master internal error' },
});

/**
 * Why a Run is blocked on the environment, naming the program that could not be found (the
 * block's `missing`): 「运行环境里找不到 npm」.
 */
export function missingCommandText(missing: string): string {
  return t({ zh: `运行环境里找不到 ${missing}`, en: `${missing} not found in the environment` });
}

/** The kinds of things a human is notified about. */
export type NoticeKind =
  | 'approval'
  | 'discussion'
  | 'blocked'
  | 'failed'
  | 'proposals'
  | 'scout'
  | 'github'
  | 'pull'
  | 'upgrade';

/**
 * Every kind of notification, in the order the dashboard's guide lists them:
 * `label` is the notification's title, followed by 「：<detail>」 (": <detail>") when it
 * carries one (the block reason, the number of proposals); `when` says in what situation it is
 * sent. Both follow the language in use.
 */
export const NOTICE_KINDS: Record<NoticeKind, { label: string; when: string }> = localized<
  NoticeKind,
  { label: string; when: string }
>({
  approval: {
    zh: {
      label: '等待你审批',
      when: 'Run 走到需要人工审批的地方，例如合并前（看模板和 auto_merge 的设置）',
    },
    en: {
      label: 'Waiting for your approval',
      when: 'A Run reached a step that needs a human approval, e.g. before merging (see the template and auto_merge)',
    },
  },
  discussion: {
    zh: {
      label: '需求待讨论，等你回复',
      when: '需求评估对需求有疑问，或认为不该做，等你在 issue 上或 Run 详情页回复',
    },
    en: {
      label: 'Requirement under discussion, waiting for your reply',
      when: 'The requirement assessment has questions or thinks it should not be done, and waits for your reply on the issue or the Run page',
    },
  },
  blocked: {
    zh: {
      label: 'Run 卡住了',
      when: 'Run 停下来等你处理，标题后面写着原因，例如目标分支有未提交的改动、运行环境里找不到检查命令要用的程序（比如换 Node 版本后找不到 npm），或配置为等人时超出预算（on_budget_exceeded: pause）、返工次数用完仍未通过（on_exhausted: human）',
    },
    en: {
      label: 'Run is stuck',
      when: 'A Run stopped and waits for you, with the reason after the title, e.g. uncommitted changes on the target branch, a program the checks need missing from the environment (npm after switching Node versions, say), or, when set to wait for a human, over budget (on_budget_exceeded: pause) or still failing after all retries (on_exhausted: human)',
    },
  },
  failed: {
    zh: {
      label: 'Run 失败了',
      when: 'Run 没做完就结束了，例如返工次数用完仍未通过、阶段回退次数用完（on_exhausted: fail），Agent 出错且重试、换 Agent 都用完，超出预算（on_budget_exceeded: abort，默认），或通过 PR 交付（deliver: pr）时 PR 没合并就被关掉；你自己终止的不通知',
    },
    en: {
      label: 'Run failed',
      when: 'A Run ended unfinished, e.g. still failing after all retries or past the stage loop limit (on_exhausted: fail), an agent error with every retry and agent used up, over budget (on_budget_exceeded: abort, the default), or its pull request closed unmerged when the repo delivers through pull requests (deliver: pr); Runs you cancel yourself are not notified',
    },
  },
  proposals: {
    zh: {
      label: '有提案等你决定',
      when: '侦察提出的提案里有不能自动采纳的（太大，或超出自动采纳的风险等级）',
    },
    en: {
      label: 'Proposals waiting for your decision',
      when: 'The scout proposed something that cannot be accepted automatically (too large, or above the auto-accept risk level)',
    },
  },
  scout: {
    zh: {
      label: '侦察连续失败',
      when: `一个仓库的侦察（自动或手动）连续失败 ${SCOUT_FAILURE_NOTIFY_AFTER} 次，例如 Agent 出错或超时、输出不符合约定、建临时工作目录失败，标题后面写着仓库名；额度用尽或限流、被 Master 停止的不算，也不打断计数。同一串连续失败只通知一次，有侦察正常结束后重新计数`,
    },
    en: {
      label: 'Scout keeps failing',
      when: `Scouts of a repo (automatic or by hand) failed ${SCOUT_FAILURE_NOTIFY_AFTER} times in a row, e.g. an agent error or timeout, output not in the agreed format, or no temporary working directory, with the repo after the title; scouts out of quota, rate-limited or stopped by the Master neither count nor end the streak. Each streak is notified once; a scout that ends normally starts the count over`,
    },
  },
  github: {
    zh: {
      label: 'GitHub 访问失败',
      when: '读写 issue 或推送目标分支失败。同一串连续失败里，同一个错误只通知一次；有一轮访问全部成功后重新开始',
    },
    en: {
      label: 'GitHub access failed',
      when: 'Reading or writing issues, or pushing the target branch, failed. Within a streak of failures each error is notified once; the streak ends, and errors are notified again, after a round in which every GitHub call succeeds',
    },
  },
  pull: {
    zh: {
      label: '没能拉取 GitHub 上的新提交',
      when: 'GitHub 上的目标分支有本地没有的提交，但 Master 没能把本地目标分支更新过去，标题后面写着仓库名：两边已经分叉（各有对方没有的提交），Master 自动合并时有冲突或者合并后检查没通过，于是交给一个 Run，由编码 Agent 合并，评审并合并后自动推送，点开就是这个 Run；建不了 Run，或者这个 Run 被终止、失败了，就要你手动合并；合并前都不推送。或者检查要用的程序找不到；或者目标分支检出的工作目录里有未提交的改动。同一次分叉里，交给同一个 Run、要你手动合并、同一种原因都只通知一次',
    },
    en: {
      label: 'Could not pull new commits from GitHub',
      when: "The target branch on GitHub has commits the local one lacks, but the Master could not bring the local branch up to them, with the repo after the title: the two have diverged (each has commits the other lacks) and the Master's merge of the two conflicts or fails the checks, so a Run takes it over, whose coding agent merges them, pushed once the Run is reviewed and merged (a click opens the Run); when no Run can be created, or the Run is terminated or fails, you need to merge them; nothing is pushed until they are merged. Or a program the checks start is missing; or the target branch is checked out with uncommitted changes. Within a divergence, handing it to a Run, asking you to merge, and each reason are each notified once",
    },
  },
  upgrade: {
    zh: {
      label: 'Master 自动升级失败',
      when: '升级失败并已回退到旧版本，或安装目录有未提交的改动、与 origin 分叉，需要你处理；因为找不到 node 或 npm 而失败的，同一个提交反复失败时只通知第一次',
    },
    en: {
      label: 'Master auto-upgrade failed',
      when: 'An upgrade failed and was rolled back, or the install directory has uncommitted changes or diverged from origin, and needs you; when no node or npm was found, only the first of repeated failures of a commit is notified',
    },
  },
});

export interface Notice {
  kind: NoticeKind;
  title: string;
  body: string;
  /** The Run it is about, if any (a click opens it). */
  runId: string | null;
  /** What it is about otherwise: the issues page or nothing in particular. */
  about: 'run' | 'issues' | 'master';
}

/** A notification's title: its kind's label, then the detail if any. */
const titleOf = (kind: NoticeKind, detail?: string) =>
  detail
    ? `${NOTICE_KINDS[kind].label}${t({ zh: '：', en: ': ' })}${detail}`
    : NOTICE_KINDS[kind].label;

/** The first line of `text` without its surrounding blanks, cut to `max` characters with "…". */
export const firstLine = (text: string, max: number) => {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

/** A non-empty string from event data, or null. */
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** How many of the conflicted files a text about a divergence names. */
const FILES_SHOWN = 5;

/**
 * Why the Master could not merge GitHub's commits into a diverged target branch by itself, from
 * the data of a github.diverged event: `conflict` (the merge conflicted in `files`), `failed`
 * (a check failed on the merge) or `environment` (a check could not find a program it starts,
 * tried again each round), with a clause that says so. null for an event without any, as
 * recorded before the Master merged by itself. Shared by the notification and the dashboard.
 */
export function divergedCause(
  data: Record<string, unknown>,
): { kind: 'conflict' | 'failed' | 'environment'; text: string } | null {
  if (data.conflict === true) {
    const all = Array.isArray(data.files) ? data.files.filter((f) => typeof f === 'string') : [];
    const shown = join(all.slice(0, FILES_SHOWN));
    const more = all.length - FILES_SHOWN;
    const files =
      more > 0
        ? t({
            zh: `${shown} 等 ${all.length} 个文件`,
            en: `${shown} and ${more} more file${more === 1 ? '' : 's'}`,
          })
        : shown;
    return {
      kind: 'conflict',
      text: files
        ? t({ zh: `自动合并有冲突（${files}）`, en: `the Master's merge conflicts in ${files}` })
        : t({ zh: '自动合并有冲突', en: "the Master's merge conflicts" }),
    };
  }
  const failed = data.failed;
  if (typeof failed !== 'object' || failed === null) return null;
  const f = failed as Record<string, unknown>;
  const command = text(f.command) ?? '?';
  const setup = f.kind === 'setup';
  const what = setup
    ? t({ zh: `准备命令 \`${command}\``, en: `setup command \`${command}\`` })
    : t({ zh: `检查命令 \`${command}\``, en: `verify command \`${command}\`` });
  const missing = text(f.missing);
  if (missing) {
    return {
      kind: 'environment',
      text: t({
        zh: `自动合并后要运行的${what} 在运行环境里找不到 ${missing}`,
        en: `the ${what} to run on the Master's merge cannot find ${missing}`,
      }),
    };
  }
  const why =
    f.timedOut === true
      ? t({ zh: '超时', en: 'timed out' })
      : typeof f.exitCode === 'number'
        ? t({ zh: `退出码 ${f.exitCode}`, en: `exit code ${f.exitCode}` })
        : null;
  const at = why ? t({ zh: `（${why}）`, en: ` (${why})` }) : '';
  return {
    kind: 'failed',
    text: t({
      zh: `自动合并后${what} 没通过${at}`,
      en: `the ${what} failed on the Master's merge${at}`,
    }),
  };
}

/** The target branch could not take GitHub's new commits: titled with the repo. */
function pullNotice(event: EventRow, body: string): Notice {
  const repo = text(event.data.repo);
  return {
    kind: 'pull',
    title: titleOf('pull', repo ?? undefined),
    body,
    runId: null,
    about: 'issues',
  };
}

/**
 * The notification for an event, or null when nobody has to act. Only things that wait for a
 * human: approvals, stuck or failed Runs, proposals the Master may not accept by itself,
 * failures of the Master's own automation (GitHub, upgrades, a scout that keeps failing), and a
 * target branch that cannot take the new commits on GitHub by itself.
 * Finished Runs are not announced.
 */
export function noticeFor(event: EventRow, goal: string | undefined): Notice | null {
  const runId = event.runId;
  const run = (kind: NoticeKind, detail?: string): Notice | null => {
    if (!runId) return null;
    const title = titleOf(kind, detail);
    return { kind, title, body: goal ? firstLine(goal, 120) : runId, runId, about: 'run' };
  };
  switch (event.type) {
    case 'approval.requested':
      return run('approval');
    case 'run.blocked':
      // Questions about the requirement are a conversation, not a breakdown.
      if (event.data.kind === 'discussion') return run('discussion');
      // An open pull request is how deliver: pr goes, not a breakdown; GitHub tells its reviewers.
      if (event.data.kind === 'pr_open') return null;
      if (event.data.kind === 'environment' && typeof event.data.missing === 'string') {
        return run('blocked', missingCommandText(event.data.missing));
      }
      return run('blocked', BLOCK_KIND[event.data.kind as BlockKind]);
    case 'run.status':
      return event.data.status === 'failed' ? run('failed') : null;
    case 'scout.completed': {
      const pending = Number(event.data.pending ?? 0);
      if (pending === 0) return null;
      return {
        kind: 'proposals',
        title: titleOf('proposals', t({ zh: `${pending} 条`, en: String(pending) })),
        body: t({
          zh: '这些提案不能自动采纳（太大或超出自动采纳的风险），去 GitHub 上采纳或关闭',
          en: 'These proposals cannot be accepted automatically (too large or above the auto-accept risk); accept or close them on GitHub',
        }),
        runId: null,
        about: 'issues',
      };
    }
    case 'scout.failed':
      // A single failure only backs off; told once, when the failures in a row reach the
      // threshold. Events from before the streak was recorded have none and are not told.
      if (event.data.streak !== SCOUT_FAILURE_NOTIFY_AFTER) return null;
      return {
        kind: 'scout',
        title: titleOf('scout', String(event.data.repo ?? '')),
        body: firstLine(String(event.data.message ?? ''), 200),
        runId: null,
        about: 'issues',
      };
    case 'github.error':
      return {
        kind: 'github',
        title: titleOf('github'),
        body: firstLine(String(event.data.message ?? ''), 200),
        runId: null,
        about: 'issues',
      };
    case 'github.diverged': {
      // The same divergence, after a Run merged or more was pushed: told the first time.
      if (event.data.repeated === true) return null;
      const branch = text(event.data.branch) ?? t({ zh: '目标分支', en: 'The target branch' });
      const local = text(event.data.local);
      const remote = text(event.data.remote);
      const at =
        local && remote
          ? t({
              zh: `（本地 ${local.slice(0, 7)}，GitHub ${remote.slice(0, 7)}）`,
              en: ` (local ${local.slice(0, 7)}, GitHub ${remote.slice(0, 7)})`,
            })
          : '';
      const until = t({
        zh: '在此之前 Master 不推送，已完成 Run 的 issue 保持打开',
        en: 'until then the Master pushes nothing and the issues of completed Runs stay open',
      });
      const cause = divergedCause(event.data);
      const handedTo = text(event.data.runId);
      if (handedTo) {
        // Handed to a Run the Master created to merge it: a click opens that Run.
        const why = cause ? t({ zh: `，${cause.text}`, en: `, and ${cause.text}` }) : '';
        return {
          ...pullNotice(
            event,
            t({
              zh: `${branch} 和 GitHub 上的已经分叉${at}${why}；已交给 Run ${handedTo} 处理：编码 Agent 合并两边，评审并合并后自动推送。${until}`,
              en: `${branch} has diverged from GitHub's${at}${why}. Run ${handedTo} takes it over: its coding agent merges the two, and once reviewed and merged it is pushed by itself; ${until}`,
            }),
          ),
          runId: handedTo,
          about: 'run',
        };
      }
      if (cause?.kind === 'environment') {
        return pullNotice(
          event,
          t({
            zh: `${branch} 和 GitHub 上的已经分叉${at}，${cause.text}；装好后下一轮检查会自动再合并，${until}`,
            en: `${branch} has diverged from GitHub's${at}, and ${cause.text}. Once it is installed, the next check merges by itself; ${until}`,
          }),
        );
      }
      if (cause) {
        return pullNotice(
          event,
          t({
            zh: `${branch} 和 GitHub 上的已经分叉${at}，${cause.text}，要你手动合并后推送；${until}`,
            en: `${branch} has diverged from GitHub's${at}, and ${cause.text}. Merge the two by hand and push; ${until}`,
          }),
        );
      }
      return pullNotice(
        event,
        t({
          zh: `${branch} 和 GitHub 上的已经分叉${at}，要你手动合并后推送；${until}`,
          en: `${branch} has diverged from GitHub's${at}; merge the two by hand and push. Until then the Master pushes nothing and the issues of completed Runs stay open`,
        }),
      );
    }
    case 'github.pulled':
    case 'github.merged_remote':
      // GitHub's new commits were taken in by themselves (the merge passed the repo's checks):
      // nothing for a human to do.
      return null;
    case 'github.diverged_run':
      // Told by the github.diverged recorded with it, which names the Run.
      return null;
    case 'run.merge_remote_obsolete':
      // A merge Run completed with nothing left to merge: the target branch had GitHub's commit
      // already. Like any completed Run, nothing for a human to do.
      return null;
    case 'github.pull_blocked': {
      const branch = text(event.data.branch) ?? t({ zh: '目标分支', en: 'The target branch' });
      const worktree = text(event.data.worktree);
      const where = worktree ? t({ zh: `在 ${worktree} `, en: ` in ${worktree}` }) : '';
      return pullNotice(
        event,
        t({
          zh: `${branch} 检出${where}有未提交的改动，不能快进到 GitHub 上的新提交；提交或丢弃这些改动后，下一轮检查会自动拉取`,
          en: `${branch} is checked out${where} with uncommitted changes, so it cannot be fast-forwarded to the new commits on GitHub; once they are committed or discarded, the next check pulls by itself`,
        }),
      );
    }
    case 'upgrade.failed':
      // The same environment problem failing the same target again: told the first time.
      if (event.data.repeated === true) return null;
      return {
        kind: 'upgrade',
        title: titleOf('upgrade'),
        body: firstLine(String(event.data.message ?? ''), 200),
        runId: null,
        about: 'master',
      };
    default:
      // notify.webhook_failed and notify.system_failed among them: notifying of a failed
      // channel would send through the failing channel again, and fail again.
      return null;
  }
}
