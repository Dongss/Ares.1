// When a human needs to know: shared by the Master's system notifications and the
// dashboard's browser notifications. Pure; the dashboard imports this file.

import { SCOUT_FAILURE_NOTIFY_AFTER } from '../config/flow.js';
import { type Lang, t } from '../i18n.js';
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
      when: 'Run 没做完就结束了，例如返工次数用完仍未通过、阶段回退次数用完（on_exhausted: fail），Agent 出错且重试、换 Agent 都用完，或超出预算（on_budget_exceeded: abort，默认）；你自己终止的不通知',
    },
    en: {
      label: 'Run failed',
      when: 'A Run ended unfinished, e.g. still failing after all retries or past the stage loop limit (on_exhausted: fail), an agent error with every retry and agent used up, or over budget (on_budget_exceeded: abort, the default); Runs you cancel yourself are not notified',
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
      when: 'Reading or writing issues, or pushing the target branch, failed. Within a streak of failures each error is notified once; a round in which every GitHub call succeeds starts over',
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

/**
 * The notification for an event, or null when nobody has to act. Only things that wait for a
 * human: approvals, stuck or failed Runs, proposals the Master may not accept by itself, and
 * failures of the Master's own automation (GitHub, upgrades, a scout that keeps failing).
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
