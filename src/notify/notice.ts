// When a human needs to know: shared by the Master's system notifications and the
// dashboard's browser notifications. Pure; the dashboard imports this file.

import { changeRequestTerms, SCOUT_FAILURE_NOTIFY_AFTER } from '../config/flow.js';
import { join, type Lang, t } from '../i18n.js';
import type { BlockKind, EventRow, HostPlatform } from '../store/types.js';

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
  // Not knowing the Run: a pull request on GitHub, a merge request on GitLab.
  pr_open: { zh: '等 PR/MR 合并', en: 'Waiting for the PR/MR to merge' },
  error: { zh: 'Master 内部错误', en: 'Master internal error' },
});

/**
 * Why a Run is blocked (`BLOCK_KIND`), naming the change request a Run waiting for one is waiting
 * for by the code host the Run goes with (`platform`, e.g. its issue's): 「等 PR 合并」 on GitHub,
 * 「等 MR 合并」 on GitLab. Without the platform, PR/MR names either.
 */
export function blockKindText(kind: BlockKind, platform?: HostPlatform): string {
  if (kind !== 'pr_open' || platform === undefined) return BLOCK_KIND[kind];
  const { short } = changeRequestTerms(platform);
  return t({ zh: `等 ${short} 合并`, en: `Waiting for the ${short} to merge` });
}

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
  | 'iteration'
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
      when: 'Run 没做完就结束了，例如返工次数用完仍未通过、阶段回退次数用完（on_exhausted: fail），Agent 出错且重试、换 Agent 都用完，超出预算（on_budget_exceeded: abort，默认），或通过 PR/MR 交付（GitHub 的 deliver: pr、GitLab 的 deliver: mr）时 PR/MR 没合并就被关掉；你自己终止的不通知',
    },
    en: {
      label: 'Run failed',
      when: 'A Run ended unfinished, e.g. still failing after all retries or past the stage loop limit (on_exhausted: fail), an agent error with every retry and agent used up, over budget (on_budget_exceeded: abort, the default), or its pull request or merge request closed unmerged when the repo delivers through them (deliver: pr on GitHub, deliver: mr on GitLab); Runs you cancel yourself are not notified',
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
  iteration: {
    zh: {
      label: '迭代受阻',
      when: '迭代的一个子 issue 用完重做次数后以失败关闭，或者被人关成不做，又没有别的子 issue 替换它，依赖它的子 issue 开不了工，迭代停在「受阻」，标题后面写着仓库名。每次进入受阻通知一次；侦察下次会把它当作要先解决的问题，换个做法补一个子 issue 替换它',
    },
    en: {
      label: 'Iteration blocked',
      when: 'A sub-issue of an iteration was closed as failed after using up its attempts, or closed as not planned by a human, and nothing replaced it, so the sub-issues depending on it cannot start and the iteration is blocked, with the repo after the title. Notified once each time it gets blocked; the next scout takes it as a problem to solve first and adds a sub-issue that replaces it with another approach',
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
      when: '在 GitHub 或 GitLab 上读写 issue、推送目标分支失败，GitLab 的标题写作「GitLab 访问失败」。同一串连续失败里，同一个错误只通知一次；有一轮访问全部成功后重新开始',
    },
    en: {
      label: 'GitHub access failed',
      when: 'Reading or writing issues, or pushing the target branch, failed on GitHub or GitLab, titled "GitLab access failed" for GitLab. Within a streak of failures each error is notified once; the streak ends, and errors are notified again, after a round in which every call to that host succeeds',
    },
  },
  pull: {
    zh: {
      label: '没能拉取 GitHub 上的新提交',
      when: 'GitHub 或 GitLab 上的目标分支有本地没有的提交，但 Master 没能把本地目标分支更新过去，标题后面写着仓库名（GitLab 的标题写作「没能拉取 GitLab 上的新提交」）：两边已经分叉（各有对方没有的提交），Master 自动合并时有冲突或者合并后检查没通过，于是交给一个 Run，由编码 Agent 合并，评审并合并后自动推送，点开就是这个 Run；建不了 Run，或者这个 Run 被终止、失败了，就要你手动合并；合并前都不推送。或者检查要用的程序找不到；或者目标分支检出的工作目录里有未提交的改动。同一次分叉里，交给同一个 Run、要你手动合并、同一种原因都只通知一次',
    },
    en: {
      label: 'Could not pull new commits from GitHub',
      when: "The target branch on GitHub or GitLab has commits the local one lacks, but the Master could not bring the local branch up to them, with the repo after the title (which says GitLab for GitLab): the two have diverged (each has commits the other lacks) and the Master's merge of the two conflicts or fails the checks, so a Run takes it over, whose coding agent merges them, pushed once the Run is reviewed and merged (a click opens the Run); when no Run can be created, or the Run is terminated or fails, you need to merge them; nothing is pushed until they are merged. Or a program the checks start is missing; or the target branch is checked out with uncommitted changes. Within a divergence, handing it to a Run, asking you to merge, and each reason are each notified once",
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

/** A label, then the detail if any. */
const withDetail = (label: string, detail?: string) =>
  detail ? `${label}${t({ zh: '：', en: ': ' })}${detail}` : label;

/** A notification's title: its kind's label, then the detail if any. */
const titleOf = (kind: NoticeKind, detail?: string) => withDetail(NOTICE_KINDS[kind].label, detail);

/** A code host as people know it. */
type HostName = 'GitHub' | 'GitLab';

/**
 * The code host a `github.*` event or a scout's is about: the GitLab bridge records its own with
 * `platform: 'gitlab'`, GitHub's go without.
 */
const hostOf = (data: Record<string, unknown>): HostName =>
  data.platform === 'gitlab' ? 'GitLab' : 'GitHub';

/**
 * The title of a notification about a code host (kind `github` or `pull`): its kind's label, which
 * names GitHub, naming GitLab instead for GitLab's events. The kind stays the same either way.
 */
function hostTitleOf(kind: 'github' | 'pull', host: HostName, detail?: string): string {
  if (host === 'GitHub') return titleOf(kind, detail);
  const label =
    kind === 'github'
      ? t({ zh: 'GitLab 访问失败', en: 'GitLab access failed' })
      : t({ zh: '没能拉取 GitLab 上的新提交', en: 'Could not pull new commits from GitLab' });
  return withDetail(label, detail);
}

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
 * Why the Master could not merge the code host's commits into a diverged target branch by itself,
 * from the data of a github.diverged event: `conflict` (the merge conflicted in `files`), `failed`
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

/** The target branch could not take the code host's new commits: titled with the repo. */
function pullNotice(event: EventRow, body: string): Notice {
  const repo = text(event.data.repo);
  return {
    kind: 'pull',
    title: hostTitleOf('pull', hostOf(event.data), repo ?? undefined),
    body,
    runId: null,
    about: 'issues',
  };
}

/** A positive whole number from event data, or null. */
const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;

/**
 * An iteration got blocked (`iteration.blocked`): which step held it up, failed after using up
 * its attempts or closed as not planned by a human, and what comes next. Titled with the repo.
 * One of the local backlog (`backlog: true`) is followed on the dashboard instead of on the
 * code host.
 */
function iterationBlockedNotice(event: EventRow): Notice {
  const d = event.data;
  if (d.backlog === true) return localIterationBlockedNotice(event);
  const issue = count(d.issue);
  const position = count(d.position);
  const child = count(d.child);
  const failed = d.reason === 'failed';
  const zhStep =
    position === null ? '一个子项' : `第 ${position} 步${child === null ? '' : `（#${child}）`}`;
  const enStep =
    position === null ? 'a step' : `step ${position}${child === null ? '' : ` (#${child})`}`;
  const zhIteration = issue === null ? '迭代' : `迭代 #${issue} `;
  const enIteration = issue === null ? 'the iteration' : `iteration #${issue}`;
  const what = failed
    ? t({
        zh: `${zhIteration}的${zhStep}用完重做次数后失败了`,
        en: `${capitalize(enStep)} of ${enIteration} failed after using up its attempts`,
      })
    : t({
        zh: `${zhIteration}的${zhStep}被人关成了不做`,
        en: `${capitalize(enStep)} of ${enIteration} was closed as not planned by a human`,
      });
  return {
    kind: 'iteration',
    title: titleOf('iteration', text(d.repo) ?? undefined),
    body: t({
      zh: `${what}，依赖它的子 issue 开不了工。侦察下次会换个做法补一个子 issue 替换它；也可以重新打开它、加上 ares1:ready 重做，或者关掉迭代 issue，不做剩下的`,
      en: `${what}, so the sub-issues depending on it cannot start. The next scout adds a sub-issue replacing it with another approach; you can also reopen it and add ares1:ready to redo it, or close the iteration issue to drop the rest`,
    }),
    runId: null,
    about: 'issues',
  };
}

/**
 * An iteration of the local backlog got blocked: the Runs of one of its steps failed until its
 * attempts were used up, or its Run was terminated or dropped by its assessment, and what comes
 * next, on the dashboard.
 */
function localIterationBlockedNotice(event: EventRow): Notice {
  const d = event.data;
  const position = count(d.position);
  const zhStep = position === null ? '一个子项' : `第 ${position} 步`;
  const enStep = position === null ? 'a step' : `step ${position}`;
  return {
    kind: 'iteration',
    title: titleOf('iteration', text(d.repo) ?? undefined),
    body: t({
      zh: `迭代的${zhStep}没有做成（Run 用完重做次数后仍然失败、被终止，或需求评估结论为不做），依赖它的子项开不了工。侦察下次会换个做法补一个子项替换它；也可以在看板上终止这个迭代，不做剩下的`,
      en: `${capitalize(enStep)} of the iteration was not done (its Runs failed until its attempts were used up, its Run was terminated, or its assessment dropped it), so the steps depending on it cannot start. The next scout adds a step replacing it with another approach; you can also cancel the iteration on the dashboard to drop the rest`,
    }),
    runId: null,
    about: 'issues',
  };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Where to decide the proposals a scout left for a human, on the code host its issues are on. */
function proposalsOnHostText(host: HostName): string {
  return t({
    zh: `这些提案不能自动采纳（太大或超出自动采纳的风险），去 ${host} 上采纳或关闭`,
    en: `These proposals cannot be accepted automatically (too large or above the auto-accept risk); accept or close them on ${host}`,
  });
}

/**
 * The notification for an event, or null when nobody has to act. Only things that wait for a
 * human: approvals, stuck or failed Runs, proposals the Master may not accept by itself, an
 * iteration blocked by a step that failed or was dropped, failures of the Master's own
 * automation (GitHub or GitLab, upgrades, a scout that keeps failing), and a target branch that
 * cannot take the new commits on its code host by itself.
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
      // An open pull request is how deliver: pr goes (a merge request, deliver: mr on GitLab), not
      // a breakdown; the code host tells its reviewers.
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
        // A repo of the local backlog has its proposals in the Master; a repo of gitlab.repos has
        // them on GitLab (`platform`), the others on GitHub.
        body:
          event.data.backlog === true
            ? t({
                zh: '这些提案没有自动采纳（太大、超出自动采纳的风险，或今天的自动采纳额度用完了），去看板的需求页上采纳或拒绝',
                en: "These proposals were not accepted automatically (too large, above the auto-accept risk, or past today's auto-accept limit); accept or reject them on the dashboard's Issues page",
              })
            : proposalsOnHostText(hostOf(event.data)),
        runId: null,
        about: 'issues',
      };
    }
    case 'iteration.blocked':
      return iterationBlockedNotice(event);
    case 'proposal.created':
    case 'proposal.auto_accepted':
    case 'proposal.accepted':
    case 'proposal.rejected':
    case 'proposal.restarted':
      // A requirement a human wrote, or a local proposal decided, by auto-accept or by a human on
      // the dashboard (accepting, rejecting or starting a failed one over): nobody has to act on
      // it that does not know already. Those left for a human were told once, when the scout that
      // filed them ended.
      return null;
    case 'proposal.redo_scheduled':
    case 'proposal.redone':
    case 'proposal.failed':
      // What follows a failed Run of a local proposal: the failure itself was told (run.status).
      return null;
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
        title: hostTitleOf('github', hostOf(event.data)),
        body: firstLine(String(event.data.message ?? ''), 200),
        runId: null,
        about: 'issues',
      };
    case 'github.diverged': {
      // The same divergence, after a Run merged or more was pushed: told the first time.
      if (event.data.repeated === true) return null;
      const host = hostOf(event.data);
      const branch = text(event.data.branch) ?? t({ zh: '目标分支', en: 'The target branch' });
      const local = text(event.data.local);
      const remote = text(event.data.remote);
      const at =
        local && remote
          ? t({
              zh: `（本地 ${local.slice(0, 7)}，${host} ${remote.slice(0, 7)}）`,
              en: ` (local ${local.slice(0, 7)}, ${host} ${remote.slice(0, 7)})`,
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
              zh: `${branch} 和 ${host} 上的已经分叉${at}${why}；已交给 Run ${handedTo} 处理：编码 Agent 合并两边，评审并合并后自动推送。${until}`,
              en: `${branch} has diverged from ${host}'s${at}${why}. Run ${handedTo} takes it over: its coding agent merges the two, and once reviewed and merged it is pushed by itself; ${until}`,
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
            zh: `${branch} 和 ${host} 上的已经分叉${at}，${cause.text}；装好后下一轮检查会自动再合并，${until}`,
            en: `${branch} has diverged from ${host}'s${at}, and ${cause.text}. Once it is installed, the next check merges by itself; ${until}`,
          }),
        );
      }
      if (cause) {
        return pullNotice(
          event,
          t({
            zh: `${branch} 和 ${host} 上的已经分叉${at}，${cause.text}，要你手动合并后推送；${until}`,
            en: `${branch} has diverged from ${host}'s${at}, and ${cause.text}. Merge the two by hand and push; ${until}`,
          }),
        );
      }
      return pullNotice(
        event,
        t({
          zh: `${branch} 和 ${host} 上的已经分叉${at}，要你手动合并后推送；${until}`,
          en: `${branch} has diverged from ${host}'s${at}; merge the two by hand and push. Until then the Master pushes nothing and the issues of completed Runs stay open`,
        }),
      );
    }
    case 'github.pr_closed_by_master':
    case 'github.pr_found_closed':
      // The pull request (merge request) of a Run that ended unfinished, closed or left as its
      // code host had it: the Run's end was told already (a failed Run notifies), and nobody has
      // to act on this.
      return null;
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
      const host = hostOf(event.data);
      return pullNotice(
        event,
        t({
          zh: `${branch} 检出${where}有未提交的改动，不能快进到 ${host} 上的新提交；提交或丢弃这些改动后，下一轮检查会自动拉取`,
          en: `${branch} is checked out${where} with uncommitted changes, so it cannot be fast-forwarded to the new commits on ${host}; once they are committed or discarded, the next check pulls by itself`,
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
