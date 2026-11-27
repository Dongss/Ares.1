// Labels, issue texts and how a Run's status shows on its issue. Pure functions.

import { brandName } from '../brand.js';
import { changeRequestTerms, type ProposalKind, type Risk } from '../config/flow.js';
import { conclusionLabel, waitText } from '../engine/discussion.js';
import { groupedTimeParts, minutes, type RunTimes, timeParts } from '../engine/times.js';
import type { HostAuthored, HostComment, LabelDef } from '../host/code-host.js';
import { join, t } from '../i18n.js';
import type {
  DiscussionEntry,
  FailedAttempt,
  HostPlatform,
  PrCloseReason,
  Run,
  RunStatus,
  ScoutProposal,
  UntrustedAuthor,
} from '../store/types.js';

export const LABELS = {
  /** Proposed by an AI scout, waiting for a human. */
  proposal: 'ares1:proposal',
  /** Go: the Master creates a Run for it. Added by a human, or by auto-accept. */
  ready: 'ares1:ready',
  /** Accepted by the Master without a human. */
  auto: 'ares1:auto',
  running: 'ares1:running',
  /**
   * The Run waits for an approval, a reply to the assessment or its pull request to be merged
   * (deliver: pr; its merge request with deliver: mr on GitLab), is blocked or paused.
   */
  needsYou: 'ares1:needs-you',
  /**
   * The Run was cancelled, or failed and is not redone (the attempts ran out); add ares1:ready
   * again to redo it. A failed Run that is redone keeps ares1:running.
   */
  failed: 'ares1:failed',
  /**
   * An iteration: one larger goal planned by a scout, whose plan lists its child issues. Says
   * what the issue is, not where it stands: it keeps a status label beside it.
   */
  iteration: 'ares1:iteration',
  /**
   * Closed as not planned. GitLab closes an issue without a reason, so its client marks one
   * closed as not planned with this label, and reads it back from it. Says how the issue was
   * closed, not where it stands: not a status label. GitHub keeps the reason itself; the label
   * is created there too, unused.
   */
  notPlanned: 'ares1:not-planned',
} as const;

/** Labels that say where the issue stands; exactly one of them is on an issue at a time. */
const STATUS_LABELS: readonly string[] = [
  LABELS.ready,
  LABELS.running,
  LABELS.needsYou,
  LABELS.failed,
];

/** The labels the Master creates on a repo, described in the language in use. */
export function labelDefs(): LabelDef[] {
  return [
    {
      name: LABELS.proposal,
      color: 'c5def5',
      description: t({
        zh: 'AI 提出的需求，等人审：采纳就加 ares1:ready',
        en: 'Proposed by AI, waiting for a human: add ares1:ready to accept',
      }),
    },
    {
      name: LABELS.ready,
      color: '0e8a16',
      description: t({
        zh: `可以开工：${brandName()}会自动建 Run`,
        en: `Ready to go: ${brandName()} creates a Run for it`,
      }),
    },
    {
      name: LABELS.auto,
      color: 'bfdadc',
      description: t({
        zh: `${brandName()}自动采纳的低风险提案`,
        en: `Low-risk proposal accepted by ${brandName()} automatically`,
      }),
    },
    {
      name: LABELS.running,
      color: '1d76db',
      description: t({ zh: `${brandName()}正在处理`, en: `${brandName()} is working on it` }),
    },
    {
      name: LABELS.needsYou,
      color: 'd93f0b',
      // The same labels go on GitHub and on GitLab: PR/MR names either's.
      description: t({
        zh: 'Run 在等审批、等 PR/MR 合并、卡住了或需求待讨论，需要人处理',
        // GitHub takes at most 100 characters.
        en: 'The Run waits for an approval or its PR/MR to merge, is stuck or has questions: a human is needed',
      }),
    },
    {
      name: LABELS.failed,
      color: 'b60205',
      description: t({
        zh: 'Run 被终止，或多次失败后不再自动重做；重新加 ares1:ready 可重做',
        en: 'The Run was cancelled, or failed too often to be redone; add ares1:ready again to redo it',
      }),
    },
    {
      name: LABELS.iteration,
      color: '5319e7',
      description: t({
        zh: 'AI 规划的迭代：一个大目标和按依赖排好的子 issue；加 ares1:ready 就整批采纳',
        en: 'An iteration planned by AI: one goal and its ordered sub-issues; add ares1:ready to accept all',
      }),
    },
    {
      name: LABELS.notPlanned,
      color: 'cfd3d7',
      description: t({
        zh: '关闭为不做：GitLab 关闭 issue 时不记原因，用这个标签表示',
        en: 'Closed as not planned (on GitLab, which keeps no reason for closing an issue)',
      }),
    },
  ];
}

/** Replace the status label, keeping every other label (provenance, the repo's own labels). */
export function withStatusLabel(labels: readonly string[], status: string | null): string[] {
  const kept = labels.filter((l) => !STATUS_LABELS.includes(l));
  return status ? [...kept, status] : kept;
}

/** Whether the labels say where the issue stands: it was decided, by a human or the Master. */
export function hasStatusLabel(labels: readonly string[]): boolean {
  return labels.some((l) => STATUS_LABELS.includes(l));
}

/** Marks where the Master's footer starts; the Run goal leaves it out. */
export const FOOTER_MARKER = '<!-- ares1:footer -->';

/**
 * Ends every comment the Master posts. The Master comments as the same GitHub account as the
 * human, so this is how a human's reply is told apart from the Master's own comments.
 */
export const COMMENT_MARKER = '<!-- ares1 -->';

/**
 * In the comment that closes an issue after its Runs failed `max_run_attempts` times: tells the
 * scout that no human turned the requirement down.
 */
export const RETRIES_EXHAUSTED_MARKER = '<!-- ares1:retries-exhausted -->';

/** A comment body as the Master posts it: with the marker. */
export function markComment(body: string): string {
  return `${body.trimEnd()}\n\n${COMMENT_MARKER}`;
}

/** Whether a comment body carries the Master's marker; see `isMasterCommentBy` for the author. */
export function isMasterComment(body: string): boolean {
  return body.includes(COMMENT_MARKER);
}

export function isRetriesExhaustedComment(body: string): boolean {
  return body.includes(RETRIES_EXHAUSTED_MARKER);
}

/** A comment body without the hidden markers, e.g. to quote it. */
export function stripMarker(body: string): string {
  return body.replaceAll(COMMENT_MARKER, '').replaceAll(RETRIES_EXHAUSTED_MARKER, '').trim();
}

/**
 * Whether the Master trusts what an issue or comment says: anybody can write on a public repo,
 * and what reaches an agent's prompt steers an agent that runs commands on the Master's machine.
 * Trusted are the people the code host's client counts as able to change the repo anyway
 * (`trusted`: on GitHub its owner, the members of its organization and its collaborators), and
 * the account the Master acts as (`master`: `github.account`, else gh's active account; null
 * when not known), whatever the case of its login. Everybody else is not, contributors included.
 */
export function isTrusted(item: HostAuthored, master: string | null): boolean {
  if (item.trusted) return true;
  return (
    master !== null && item.author !== null && item.author.toLowerCase() === master.toLowerCase()
  );
}

/**
 * A comment the Master posted: its marker, written by someone it trusts. Anybody can copy the
 * marker into a comment of theirs; that does not make it the Master's.
 */
export function isMasterCommentBy(comment: HostComment, master: string | null): boolean {
  return isMasterComment(comment.body) && isTrusted(comment, master);
}

/** Replies to the assessment's questions on the issue, and how many comments were left out. */
export interface IssueReplies {
  /** Bodies of the trusted comments after the Master's last one, oldest first. */
  replies: string[];
  /** Comments after the Master's last one by people it does not trust: not taken as replies. */
  ignored: number;
}

/**
 * A human's replies to the assessment on the issue: the comments after the Master's last one,
 * written by people the Master trusts (`isTrusted`). None when the Master has not commented yet
 * (its questions are not posted).
 */
export function repliesAfterMaster(
  comments: readonly HostComment[],
  master: string | null,
): IssueReplies {
  const last = comments.findLastIndex((c) => isMasterCommentBy(c, master));
  if (last < 0) return { replies: [], ignored: 0 };
  const after = comments.slice(last + 1).filter((c) => c.body.trim().length > 0);
  const replies = after.filter((c) => isTrusted(c, master)).map((c) => c.body);
  return { replies, ignored: after.length - replies.length };
}

/** How a Run records the author of its issue whom the Master does not trust. */
export function untrustedAuthor(issue: HostAuthored, confirmedAt: string | null): UntrustedAuthor {
  return { author: issue.author, association: issue.role, confirmedAt };
}

/** 「@login（NONE）」, who wrote an issue the Master does not trust. */
export function authorText(author: string | null, association: string): string {
  const who = author ? `@${author}` : t({ zh: '已删除的账号', en: 'a deleted account' });
  return t({ zh: `${who}（${association}）`, en: `${who} (${association})` });
}

/**
 * Why a Run from an issue written by someone the Master does not trust waits for a human before
 * it starts: the block message of the Run.
 */
export function untrustedGoalMessage(issue: {
  number: number;
  author: string | null;
  role: string;
}): string {
  const who = authorText(issue.author, issue.role);
  return t({
    zh: `issue #${issue.number} 的作者 ${who}不是这个仓库的成员。任何人都能在公开仓库发 issue，内容可能是用来操纵 Agent 的（Agent 会在这台机器上执行命令）。Run 的目标是建 Run 时 issue 的内容，之后 issue 再怎么改也不会变。请读一遍上面的目标，确认可以交给 Agent 后点「确认并开始」；不想做就终止这个 Run，或关闭 issue。`,
    en: `The author of issue #${issue.number}, ${who}, is not a member of this repo. Anybody can open an issue on a public repo, and its text may be meant to steer the agents (which run commands on this machine). The Run's goal is the issue as it was when the Run was created; later edits of the issue do not change it. Read the goal above, and once you are sure it can go to the agents, click "Confirm and start"; if not, cancel this Run or close the issue.`,
  });
}

const riskText = (risk: Risk) =>
  t({
    zh: { low: '低', mid: '中', high: '高' },
    en: { low: 'low', mid: 'medium', high: 'high' },
  })[risk];

const categoryText = (category: ScoutProposal['category']) =>
  t<Record<ScoutProposal['category'], string>>({
    zh: {
      bug: '缺陷',
      feature: '新功能',
      improvement: '改进',
      docs: '文档',
      test: '测试',
      refactor: '重构',
    },
    en: {
      bug: 'bug',
      feature: 'feature',
      improvement: 'improvement',
      docs: 'docs',
      test: 'test',
      refactor: 'refactor',
    },
  })[category];

/**
 * What a proposal asks for, as Markdown sections: why, the evidence, what to do and the acceptance
 * criteria. The text of a proposal's issue (`proposalBody`, `iterationChildBody`) and the goal of
 * a Run from a local proposal (`proposalGoal`) both open with it. A section with nothing in it is
 * left out, by the same rule for every source of requirements: a requirement a human wrote into
 * the local backlog may say only what to do. A scout's proposal has every section (its output
 * format requires why, evidence, what to do and acceptance criteria, none empty), so the issues it
 * files on GitHub or GitLab keep all four.
 */
export function proposalSections(
  p: Pick<ScoutProposal, 'why' | 'evidence' | 'what' | 'acceptance'>,
): string {
  const list = (items: string[], prefix: string) => items.map((i) => `${prefix}${i}`).join('\n');
  const sections: [heading: string, body: string][] = [
    [t({ zh: '### 为什么', en: '### Why' }), p.why],
    [t({ zh: '### 证据', en: '### Evidence' }), list(p.evidence, '- ')],
    [t({ zh: '### 要做什么', en: '### What to do' }), p.what],
    [t({ zh: '### 验收标准', en: '### Acceptance criteria' }), list(p.acceptance, '- [ ] ')],
  ];
  return sections
    .filter(([, body]) => body.trim() !== '')
    .map(([heading, body]) => `${heading}\n\n${body}`)
    .join('\n\n');
}

export function proposalBody(p: ScoutProposal, scoutId: string, auto: boolean): string {
  return [
    proposalSections(p),
    '',
    FOOTER_MARKER,
    '---',
    t({
      zh: `类别：${categoryText(p.category)} · 大小：${p.size} · 风险：${riskText(p.risk)}`,
      en: `Category: ${categoryText(p.category)} · Size: ${p.size} · Risk: ${riskText(p.risk)}`,
    }),
    '',
    auto
      ? t({
          zh: `_由${brandName()}侦察提出（${scoutId}），已按自动采纳的设置开工。不想做就关闭为 not planned，并留一句理由。_`,
          en: `_Proposed by the ${brandName()} scout (${scoutId}) and started under the auto-accept setting. If you don't want it, close it as not planned with a one-line reason._`,
        })
      : t({
          zh: `_由${brandName()}侦察提出（${scoutId}）。采纳：加标签 \`${LABELS.ready}\`；不做：关闭为 not planned，并留一句理由。_`,
          en: `_Proposed by the ${brandName()} scout (${scoutId}). To accept, add the label \`${LABELS.ready}\`; to decline, close it as not planned with a one-line reason._`,
        }),
  ].join('\n');
}

/** Comment on an earlier proposal accepted later because of the auto-accept setting. */
export function autoAcceptedComment(): string {
  return t({
    zh: `按当前的自动采纳设置，已自动采纳（加上 \`${LABELS.ready}\`）。不想做就关闭为 not planned，并留一句理由。`,
    en: `Accepted automatically under the current auto-accept setting (\`${LABELS.ready}\` added). If you don't want it, close it as not planned with a one-line reason.`,
  });
}

/**
 * Posted on an iteration's issue accepted as a whole once the auto-accept settings allowed it,
 * after it waited for a human.
 */
export function iterationAutoAcceptedComment(): string {
  return t({
    zh: `按当前的自动采纳设置，已整批自动采纳：这个迭代和全部子 issue 都加上了 \`${LABELS.ready}\`，子 issue 按依赖顺序开工。不想做就关闭为 not planned，并留一句理由，还没完成的子 issue 会一起终止并关成不做。`,
    en: `Accepted automatically as a whole under the current auto-accept setting: \`${LABELS.ready}\` was added to this iteration and all its sub-issues, which are started in the order of their dependencies. If you don't want it, close it as not planned with a one-line reason; the sub-issues not yet done are then stopped and closed as not planned too.`,
  });
}

/**
 * In the footer of an iteration's child issue: the iteration's own issue. Part of the protocol,
 * the same in every language; the Master goes by it, not by the visible line beside it, which
 * follows the language and which people may edit.
 */
export function iterationMarker(iteration: number): string {
  return `<!-- ares1:iteration #${iteration} -->`;
}

/**
 * In the footer of an iteration's child issue: the child issues of the same iteration it depends
 * on, which must all be closed as completed before a Run is created for it. Written even when it
 * depends on none.
 */
export function dependsOnMarker(issues: readonly number[]): string {
  return `<!-- ares1:depends-on${issues.map((n) => ` #${n}`).join('')} -->`;
}

const ITERATION_MARKER = /<!--\s*ares1:iteration\s+#(\d+)\s*-->/;
const DEPENDS_ON_MARKER = /<!--\s*ares1:depends-on((?:\s+#\d+)*)\s*-->/;

/**
 * The Master's footer of an issue body: from FOOTER_MARKER on, the part `goalFromIssue` leaves
 * out of a Run's goal; '' without one. Markers are read only there, so the text a human or an
 * agent reads as the requirement cannot pass for one.
 */
const footerOf = (body: string): string => {
  const cut = body.indexOf(FOOTER_MARKER);
  return cut >= 0 ? body.slice(cut) : '';
};

/** The iteration's issue a child issue belongs to, by its hidden marker; null for none. */
export function parseIterationOf(body: string): number | null {
  const match = ITERATION_MARKER.exec(footerOf(body));
  const n = match ? Number(match[1]) : 0;
  return n > 0 ? n : null;
}

/** The issues a child issue depends on, by its hidden marker, without repeats; [] for none. */
export function parseDependsOn(body: string): number[] {
  const match = DEPENDS_ON_MARKER.exec(footerOf(body));
  const numbers = (match?.[1]?.match(/\d+/g) ?? []).map(Number).filter((n) => n > 0);
  return [...new Set(numbers)];
}

/** 「#12、#13」, issue numbers as a list in the language in use. */
const issueList = (issues: readonly number[]) => join(issues.map((n) => `#${n}`));

/** One step of an iteration's plan as the iteration's issue lists it. */
export interface PlanItem {
  /**
   * The step's own issue; null while it is not created yet: the iteration's issue is written
   * before its children, which name it, and lists the steps by title until they have issues.
   */
  number: number | null;
  title: string;
  /** The issues of the plan it depends on. */
  dependsOn: readonly number[];
  /** Closed as completed: its task list item is checked. */
  done?: boolean;
  /**
   * Replaced by another step after it failed or was dropped: the replacing step's issue, null
   * while that has none yet. Its item stays in the plan, saying so.
   */
  replacedBy?: number | null;
}

/** What the issue of an iteration says. */
export interface IterationText {
  goal: string;
  /** The goal of the README it serves, copied word for word. */
  readmeGoal: string;
  criteria: readonly string[];
  /** The plan in order, each step with its issue. */
  plan: readonly PlanItem[];
  outOfScope: readonly string[];
  /** The iteration as a whole, as auto-accept judges it (`iterationKind`). */
  kind: ProposalKind;
}

/**
 * One step in the plan of an iteration's issue: `- [ ] #N title`, checked once it is done, with
 * the issues it depends on and, once replaced, which step replaced it; a step without its issue
 * yet is a plain item with its title.
 */
function planItemLine(item: PlanItem): string {
  if (item.number === null) return `- ${item.title}`;
  const deps =
    item.dependsOn.length > 0
      ? t({
          zh: `（依赖 ${issueList(item.dependsOn)}）`,
          en: ` (depends on ${issueList(item.dependsOn)})`,
        })
      : '';
  const replaced =
    item.replacedBy === undefined
      ? ''
      : item.replacedBy === null
        ? t({ zh: '（已被替换）', en: ' (replaced)' })
        : t({ zh: `（已被 #${item.replacedBy} 替换）`, en: ` (replaced by #${item.replacedBy})` });
  return `- [${item.done ? 'x' : ' '}] #${item.number} ${item.title}${deps}${replaced}`;
}

/**
 * The line of an iteration's footer with how many steps it has (those replaced aside) and its
 * kind as a whole; PLAN_STATS finds it again in either language.
 */
function planStatsLine(it: Pick<IterationText, 'plan' | 'kind'>): string {
  const n = it.plan.filter((item) => item.replacedBy === undefined).length;
  return t({
    zh: `共 ${n} 个子 issue · 整体大小：${it.kind.size} · 整体风险：${riskText(it.kind.risk)}`,
    en: `${n} sub-issue${n === 1 ? '' : 's'} · Overall size: ${it.kind.size} · Overall risk: ${riskText(it.kind.risk)}`,
  });
}

const PLAN_STATS = /^(?:共 \d+ 个子 issue|\d+ sub-issues?) · .*$/m;

/** Any checked or unchecked item of an iteration's plan that names an issue. */
const PLAN_ITEM = /^[ \t]*[-*+] \[[ xX]\] #\d+/;

/** The plan's item of issue `number`, checked or not. */
const planItemOf = (number: number) => new RegExp(`^[ \\t]*[-*+] \\[[ xX]\\] #${number}(?!\\d)`);

/**
 * An iteration's body with its plan brought in line with `it` after the plan changed, keeping
 * whatever else a human wrote: each item of a step that has its issue is written again (checked
 * if it was, or if the step is done; deps and replacement as `it` has them), the items of steps
 * the plan does not list yet go after its last item, in order, and the footer's line with the
 * number of steps and the kind is written again. Items of steps without their issue are left
 * out: they are added once their issue is created.
 */
export function revisedPlan(body: string, it: Pick<IterationText, 'plan' | 'kind'>): string {
  const cut = body.indexOf(FOOTER_MARKER);
  const lines = (cut >= 0 ? body.slice(0, cut) : body).split('\n');
  let last = lines.findLastIndex((line) => PLAN_ITEM.test(line));
  if (last < 0) {
    // The plan's items were removed: the steps go at the end of the text, before the footer.
    while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop();
    lines.push('');
    last = lines.length - 1;
    lines.push('', '');
  }
  for (const item of it.plan) {
    if (item.number === null) continue;
    const of = planItemOf(item.number);
    const at = lines.findIndex((line) => of.test(line));
    if (at >= 0) {
      const checked = /^[ \t]*[-*+] \[[xX]\]/.test(lines[at] ?? '');
      lines[at] = planItemLine({ ...item, done: item.done === true || checked });
      continue;
    }
    lines.splice(last + 1, 0, planItemLine(item));
    last++;
  }
  const head = lines.join('\n');
  if (cut < 0) return head;
  const footer = body.slice(cut).replace(PLAN_STATS, () => planStatsLine(it));
  return head + footer;
}

/**
 * The body of an iteration's issue: its goal with the README goal it serves, the completion
 * criteria (numbered: children name them by number), the plan as a task list of its child issues
 * (`- [ ] #N title`, checked by `checkPlanItem` as they are done; a step without its issue yet is
 * a plain item with its title) and what it leaves out; the footer says how to accept it or turn
 * it down. `auto`: accepted under the auto-accept setting.
 */
export function iterationBody(it: IterationText, scoutId: string, auto: boolean): string {
  const plan = it.plan.map(planItemLine);
  const outOfScope =
    it.outOfScope.length > 0
      ? it.outOfScope.map((o) => `- ${o}`).join('\n')
      : t({ zh: '（没有写）', en: '(none given)' });
  return [
    t({ zh: '### 目标', en: '### Goal' }),
    '',
    it.goal,
    '',
    t({ zh: '对应 README 的目标：', en: 'The README goal it serves:' }),
    '',
    quote(it.readmeGoal, 2000),
    '',
    t({ zh: '### 完成标准', en: '### Completion criteria' }),
    '',
    numbered([...it.criteria]),
    '',
    t({ zh: '### 计划', en: '### Plan' }),
    '',
    plan.join('\n'),
    '',
    t({ zh: '### 不做', en: '### Out of scope' }),
    '',
    outOfScope,
    '',
    FOOTER_MARKER,
    '---',
    planStatsLine(it),
    '',
    auto
      ? t({
          zh: `_由${brandName()}侦察规划（${scoutId}），已按自动采纳的设置整批开工：子 issue 按依赖顺序建 Run。不想做就关闭为 not planned，并留一句理由，还没完成的子 issue 会一起终止并关成不做。_`,
          en: `_Planned by the ${brandName()} scout (${scoutId}) and started as a whole under the auto-accept setting: Runs are created for the sub-issues in the order of their dependencies. If you don't want it, close it as not planned with a one-line reason; the sub-issues not yet done are then stopped and closed as not planned too._`,
        })
      : t({
          zh: `_由${brandName()}侦察规划（${scoutId}）。采纳：给这个迭代 issue 加标签 \`${LABELS.ready}\`，全部子 issue 一起采纳，按依赖顺序建 Run；不做：关闭为 not planned，并留一句理由，子 issue 会一起关成不做。_`,
          en: `_Planned by the ${brandName()} scout (${scoutId}). To accept it, add the label \`${LABELS.ready}\` to this iteration issue: all its sub-issues are accepted with it, and Runs are created for them in the order of their dependencies. To decline, close it as not planned with a one-line reason; its sub-issues are closed as not planned too._`,
        }),
  ].join('\n');
}

/**
 * The body of one child issue of an iteration: what it asks for, like any proposal, then in the
 * footer a line for people with the iteration and the issues it depends on, its kind, and the
 * hidden markers the Master goes by (`parseIterationOf`, `parseDependsOn`). In the footer, so
 * they stay out of the Run's goal.
 */
export function iterationChildBody(
  p: Pick<ScoutProposal, 'category' | 'size' | 'risk' | 'why' | 'evidence' | 'what' | 'acceptance'>,
  at: { iteration: number; dependsOn: readonly number[] },
  scoutId: string,
): string {
  return [
    proposalSections(p),
    '',
    FOOTER_MARKER,
    '---',
    childPlaceLine(at.iteration, at.dependsOn),
    '',
    t({
      zh: `类别：${categoryText(p.category)} · 大小：${p.size} · 风险：${riskText(p.risk)}`,
      en: `Category: ${categoryText(p.category)} · Size: ${p.size} · Risk: ${riskText(p.risk)}`,
    }),
    '',
    t({
      zh: `_由${brandName()}侦察规划（${scoutId}），是迭代 #${at.iteration} 的一步：随迭代一起采纳，依赖的子 issue 都以完成关闭后才开工。_`,
      en: `_Planned by the ${brandName()} scout (${scoutId}) as a step of iteration #${at.iteration}: accepted with the iteration, and started once the sub-issues it depends on are closed as completed._`,
    }),
    '',
    iterationMarker(at.iteration),
    dependsOnMarker(at.dependsOn),
  ].join('\n');
}

/**
 * The line for people in a child issue's footer: its iteration and the issues it depends on.
 * CHILD_PLACE finds it again in either language.
 */
function childPlaceLine(iteration: number, dependsOn: readonly number[]): string {
  const deps =
    dependsOn.length > 0
      ? t({ zh: `依赖：${issueList(dependsOn)}`, en: `Depends on: ${issueList(dependsOn)}` })
      : t({ zh: '没有依赖', en: 'No dependencies' });
  return `${t({ zh: `所属迭代：#${iteration}`, en: `Iteration: #${iteration}` })} · ${deps}`;
}

const CHILD_PLACE = /^(?:所属迭代：#\d+|Iteration: #\d+) · .*$/m;

/**
 * A child issue's body depending on `dependsOn` instead, after its iteration's plan changed (a
 * step it depends on was replaced, or the closing step waits for steps added): the hidden
 * marker the Master goes by (`parseDependsOn`) and the line for people beside it, both in the
 * footer, so the Run's goal does not change. A footer without the marker gets it; a body without
 * a footer gets one with the markers.
 */
export function withDependsOn(
  body: string,
  iteration: number,
  dependsOn: readonly number[],
): string {
  const cut = body.indexOf(FOOTER_MARKER);
  if (cut < 0) {
    return [
      body.trimEnd(),
      '',
      FOOTER_MARKER,
      iterationMarker(iteration),
      dependsOnMarker(dependsOn),
    ].join('\n');
  }
  let footer = body.slice(cut).replace(CHILD_PLACE, () => childPlaceLine(iteration, dependsOn));
  footer = DEPENDS_ON_MARKER.test(footer)
    ? footer.replace(DEPENDS_ON_MARKER, () => dependsOnMarker(dependsOn))
    : `${footer.trimEnd()}\n${dependsOnMarker(dependsOn)}`;
  return body.slice(0, cut) + footer;
}

/** A step of an iteration a scout's change added, as the comment about it names it. */
export interface AddedStep {
  /** Its number in the plan. */
  position: number;
  /** Its issue; null when it could not be created yet. */
  number: number | null;
  title: string;
  /** The step it replaces, if any: its number in the plan and its issue. */
  replaces?: { position: number; number: number | null };
}

/**
 * Posted on an iteration's issue when a scout changed its plan: why (the scout's note), each step
 * added and the one it replaces, and the steps that could not be added (`reason` limit: the plan
 * would have more than `max` steps; stale: the step to replace no longer needed it).
 */
export function iterationAdjustedComment(input: {
  note: string;
  scoutId: string;
  added: readonly AddedStep[];
  leftOut: readonly { title: string; reason: 'limit' | 'stale' }[];
  max: number;
}): string {
  const ref = (number: number | null, title: string) =>
    number === null ? `「${title}」` : `#${number} ${title}`;
  const refEn = (number: number | null, title: string) =>
    number === null ? `"${title}"` : `#${number} ${title}`;
  const lines = input.added.map((step) => {
    if (!step.replaces) {
      return t({
        zh: `- 补上第 ${step.position} 步：${ref(step.number, step.title)}`,
        en: `- Added step ${step.position}: ${refEn(step.number, step.title)}`,
      });
    }
    const old = step.replaces.number === null ? '' : `（#${step.replaces.number}）`;
    const oldEn = step.replaces.number === null ? '' : ` (#${step.replaces.number})`;
    return t({
      zh: `- 第 ${step.position} 步 ${ref(step.number, step.title)} 替换第 ${step.replaces.position} 步${old}`,
      en: `- Step ${step.position}, ${refEn(step.number, step.title)}, replaces step ${step.replaces.position}${oldEn}`,
    });
  });
  for (const step of input.leftOut) {
    lines.push(
      step.reason === 'limit'
        ? t({
            zh: `- 没有补上「${step.title}」：迭代最多 ${input.max} 个子项`,
            en: `- Not added: "${step.title}", as an iteration has at most ${input.max} steps`,
          })
        : t({
            zh: `- 没有补上「${step.title}」：它要替换的那一步已经不需要替换了`,
            en: `- Not added: "${step.title}", as the step it was to replace no longer needs it`,
          }),
    );
  }
  return [
    t({ zh: '### 计划调整', en: '### Plan changed' }),
    '',
    input.note.trim(),
    '',
    ...lines,
    '',
    t({
      zh: `_由${brandName()}侦察调整（${input.scoutId}）。新的子 issue 属于这个迭代，依赖的子 issue 都以完成关闭后才开工；收尾的子 issue 会等它们做完。_`,
      en: `_Changed by the ${brandName()} scout (${input.scoutId}). The new sub-issues belong to this iteration and start once the sub-issues they depend on are closed as completed; the closing sub-issue waits for them._`,
    }),
  ].join('\n');
}

/**
 * Posted on a child issue the Master closes as not planned because a human closed its iteration
 * (#`iteration`) before it was done: says so, names its Run that was terminated, and quotes the
 * reason the human left on the iteration's issue, if any, so that the scout reads it as the
 * reason this one was not done.
 */
export function closedWithIterationComment(input: {
  iteration: number;
  runId: string | null;
  reason: string | null;
}): string {
  const run = input.runId
    ? t({
        zh: `；它的 Run \`${input.runId}\` 已终止`,
        en: `; its Run \`${input.runId}\` was terminated`,
      })
    : '';
  const lines = [
    t({
      zh: `迭代 #${input.iteration} 被关掉了，这个子 issue 随之关成不做${run}。`,
      en: `Iteration #${input.iteration} was closed, so this sub-issue is closed as not planned with it${run}.`,
    }),
  ];
  const reason = input.reason?.trim();
  if (reason) {
    lines.push(
      '',
      t({ zh: '关掉迭代时留下的理由：', en: 'The reason given when the iteration was closed:' }),
      '',
      quote(reason),
    );
  }
  return lines.join('\n');
}

/**
 * An iteration's body with the plan's item of child issue `number` checked (`- [ ] #N` becomes
 * `- [x] #N`); checking it again changes nothing, nor does a number the plan does not list.
 */
export function checkPlanItem(body: string, number: number): string {
  const item = new RegExp(`^([ \\t]*[-*+] )\\[ \\]( #${number})(?!\\d)`, 'gm');
  return body.replace(item, '$1[x]$2');
}

/**
 * In the footer of an iteration's closing step once the review suggestions of the iteration were
 * added to its requirement (`withReviewSuggestions`), so that they are added once. Part of the
 * protocol, the same in every language.
 */
export const REVIEW_SUGGESTIONS_MARKER = '<!-- ares1:review-suggestions -->';

const REVIEW_SUGGESTIONS = /<!--\s*ares1:review-suggestions\s*-->/;

/** Whether the review suggestions were added to the body already, by the marker in its footer. */
export function hasReviewSuggestions(body: string): boolean {
  return REVIEW_SUGGESTIONS.test(footerOf(body));
}

/**
 * The body of an iteration's closing step with `section` (the review suggestions, see
 * `closeoutSuggestions` in src/backlog/iterations.ts) added at the end of its requirement, before
 * the footer, so that the goal of its Run has them (`goalFromIssue`); REVIEW_SUGGESTIONS_MARKER
 * ends the footer. A body whose footer is gone gets one with the marker alone.
 */
export function withReviewSuggestions(body: string, section: string): string {
  const cut = body.indexOf(FOOTER_MARKER);
  const head = (cut >= 0 ? body.slice(0, cut) : body).trimEnd();
  const footer = cut >= 0 ? body.slice(cut).trimEnd() : FOOTER_MARKER;
  return [head, '', section.trim(), '', footer, REVIEW_SUGGESTIONS_MARKER].join('\n');
}

/**
 * In the summary the Master posts on an iteration's issue once every child is done, so that it
 * is posted once even if the Master stopped before recording it. Part of the protocol.
 */
export const ITERATION_SUMMARY_MARKER = '<!-- ares1:iteration-summary -->';

/** The comment with an iteration's summary, as posted (before `markComment`). */
export function iterationSummaryComment(summary: string): string {
  return `${summary.trimEnd()}\n\n${ITERATION_SUMMARY_MARKER}`;
}

/**
 * Whether a comment is the Master's summary of an iteration: its marker in a comment the Master
 * posted (`isMasterCommentBy`), so that nobody keeps the summary from being posted by copying it.
 */
export function isIterationSummaryComment(comment: HostComment, master: string | null): boolean {
  return isMasterCommentBy(comment, master) && comment.body.includes(ITERATION_SUMMARY_MARKER);
}

/**
 * Whether an iteration's body lists every one of the child issues `numbers` as an item of its
 * plan's task list, checked or not: once it does, the plan was written out with them.
 */
export function planLists(body: string, numbers: readonly number[]): boolean {
  return numbers.every((n) => new RegExp(`^[ \\t]*[-*+] \\[[ xX]\\] #${n}(?!\\d)`, 'm').test(body));
}

/** The goal of a Run created from an issue. */
export function goalFromIssue(issue: { number: number; title: string; body: string }): string {
  const cut = issue.body.indexOf(FOOTER_MARKER);
  const body = (cut >= 0 ? issue.body.slice(0, cut) : issue.body).trim();
  return [`#${issue.number} ${issue.title}`, body].filter(Boolean).join('\n\n');
}

/** How a Run status shows on its issue. */
export interface IssueUpdate {
  /** The status label to set; null = none (the issue gets closed). */
  label: string | null;
  comment: string | null;
  /** Close the issue as done, or as not planned; null = leave it open. */
  close: 'completed' | 'not_planned' | null;
}

export interface IssueUpdateContext {
  dashboardUrl: string;
  targetBranch: string;
  /** Name of the stage waiting for approval. */
  stageName?: string;
  /** The target branch was pushed to the code host before closing. */
  pushed?: boolean;
  /** The code host the issue is on, whose words the comments use: GitHub if omitted, or GitLab. */
  platform?: HostPlatform;
  /**
   * For a completed Run whose work was merged on the code host through its pull request
   * (deliver: pr; its merge request with deliver: mr on GitLab): the pull request, and the commit
   * its merge put on the target branch when the code host gave it.
   */
  pr?: { number: number; url: string; mergeCommit: string | null };
  /** How long the Run took, split; for a completed Run. */
  times?: RunTimes;
  /**
   * For a failed Run: whether it is redone or its attempts ran out. Omitted = neither (the
   * issue's repo is no longer configured), and a human redoes it with ares1:ready.
   */
  failure?: FailureOutcome;
  /** Now, epoch ms, to say how long until a redo; omitted = the clock's. */
  now?: number;
}

/** What follows a failed Run of an issue. */
export type FailureOutcome =
  | {
      kind: 'redo';
      /** This Run's attempt, and how many the issue gets at most (`max_run_attempts`). */
      attempt: number;
      max: number;
      /** Today's automatic spending reached its limit: the redo waits for the next day. */
      budgetReached: boolean;
      /** When the next attempt starts at the earliest (`redoDueAt`), epoch ms. */
      redoAt: number;
    }
  | {
      kind: 'exhausted';
      attempt: number;
      max: number;
      /** Every failed attempt, this Run's included, oldest first. */
      failures: FailedAttempt[];
    };

/**
 * A failed Run as the next attempts at its requirement remember it. `attempt`: which attempt it
 * was; by default the one its issue records (a Run of a local proposal has none: its proposal
 * says).
 */
export function failedAttempt(
  run: Run,
  stage: string | null,
  attempt = run.issue?.attempt ?? 1,
): FailedAttempt {
  return {
    runId: run.id,
    attempt,
    stage,
    error: run.error ?? noDetail(),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 「14:05 UTC+08:00」: the clock time in the Master's local time, with its offset from UTC. */
export function clockText(ms: number): string {
  const d = new Date(ms);
  const offset = -d.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${pad(d.getHours())}:${pad(d.getMinutes())} UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** 「第 2/3 次尝试」, an attempt of the most an issue gets. */
const attemptText = (attempt: number, max: number) =>
  t({ zh: `第 ${attempt}/${max} 次尝试`, en: `attempt ${attempt} of ${max}` });

/** One line per failed attempt: which Run, in which stage, why. */
function failureLines(failures: readonly FailedAttempt[], max = 500): string {
  return failures
    .map((f) => {
      const error = oneLine(f.error, max);
      return t({
        zh: `- 第 ${f.attempt} 次，Run \`${f.runId}\`${f.stage ? `，在「${f.stage}」阶段` : ''}：${error}`,
        en: `- Attempt ${f.attempt}, Run \`${f.runId}\`${f.stage ? `, in the "${f.stage}" stage` : ''}: ${error}`,
      });
    })
    .join('\n');
}

/** The comment that starts an automatic redo of a failed Run. */
export function redoStartedComment(input: {
  runId: string;
  attempt: number;
  max: number;
  templateName: string;
  dashboardUrl: string;
}): string {
  const link = dashboardLink(input.dashboardUrl, input.runId);
  return t({
    zh: `${brandName()}自动重做：Run \`${input.runId}\`（${attemptText(input.attempt, input.max)}，模板「${input.templateName}」），之前失败的原因会交给这次的 Agent。\n\n${link}`,
    en: `${brandName()} is redoing it automatically: Run \`${input.runId}\` (${attemptText(input.attempt, input.max)}, template "${input.templateName}"); the agents are told why the earlier attempts failed.\n\n${link}`,
  });
}

/**
 * The comment that says a human's change to the issue's title or body ended its Run, and a new
 * Run does the changed requirement.
 */
export function goalChangedComment(input: {
  oldRunId: string;
  runId: string;
  templateName: string;
  dashboardUrl: string;
}): string {
  const link = dashboardLink(input.dashboardUrl, input.runId);
  return t({
    zh: `issue 的标题或正文改了：${brandName()}终止了按旧内容做的 Run \`${input.oldRunId}\`，按新内容开始了 Run \`${input.runId}\`（模板「${input.templateName}」）。\n\n${link}`,
    en: `The issue's title or body changed: ${brandName()} terminated Run \`${input.oldRunId}\`, which worked from the old text, and started Run \`${input.runId}\` (template "${input.templateName}") on the new one.\n\n${link}`,
  });
}

/**
 * The title and body of the pull request a Run's work goes through (deliver: pr; the merge
 * request with deliver: mr on GitLab).
 */
export interface PullRequestText {
  title: string;
  body: string;
}

export interface PullRequestTextContext {
  /**
   * The repo the pull request is opened on: "owner/name" on GitHub, the project's path on GitLab
   * ("group/subgroup/name").
   */
  repo: string;
  dashboardUrl: string;
  /** The code host it is opened on, whose words the body uses: GitHub if omitted, or GitLab. */
  platform?: HostPlatform;
}

/** Lines of the goal the body of a pull request quotes, and the most characters of them. */
const PR_GOAL_LINES = 10;
const PR_GOAL_MAX = 1_500;
/** GitHub takes longer titles, but they no longer fit on a line of its lists. */
const PR_TITLE_MAX = 200;

/**
 * The pull request of a Run of a repo with `deliver: pr` (the merge request with `deliver: mr` on
 * GitLab, `ctx.platform`), from the Run's branch into the target branch. The title is the goal's
 * first line; the body sums the Run up (the goal's first lines, its id, cost and dashboard link)
 * and, for a Run of an issue, closes the issue once merged: `Closes #N`, or `Closes owner/name#N`
 * (`Closes group/subgroup/name#N` on GitLab) when the issue is in another repo than `ctx.repo`.
 * Runs without an issue (merging the code host's commits) close nothing. The body carries no
 * comment marker: it is no issue comment. Not redacted: the caller passes both through
 * redactForGitHub.
 */
export function pullRequestText(
  run: Pick<Run, 'id' | 'goal' | 'issue' | 'costUsd'>,
  ctx: PullRequestTextContext,
): PullRequestText {
  const cr = changeRequestTerms(ctx.platform);
  const lines = run.goal.trim().split('\n');
  const title = oneLine(lines[0] ?? '', PR_TITLE_MAX) || `Run ${run.id}`;
  const more = lines.length > PR_GOAL_LINES ? '\n…' : '';
  const goal = quote(`${lines.slice(0, PR_GOAL_LINES).join('\n')}${more}`, PR_GOAL_MAX);
  const cost = `$${run.costUsd.toFixed(2)}`;
  const issue = run.issue;
  // GitHub and GitLab know the English keyword, in either language; an issue is #N on both.
  const closes = issue
    ? `Closes ${issue.repo.toLowerCase() === ctx.repo.toLowerCase() ? '' : issue.repo}#${issue.number}`
    : null;
  const body = [
    goal,
    t({
      zh: `由${brandName()}的 Run \`${run.id}\` 完成，检查都已通过。在 ${cr.host} 上合并这个 ${cr.short} 后 Run 会自动完成；没合并就关掉，Run 会结束为失败。`,
      en: `Done by ${brandName()} in Run \`${run.id}\`, and its checks passed. Once this ${cr.long} is merged on ${cr.host}, the Run completes by itself; if it is closed without being merged, the Run ends as failed.`,
    }),
    `${t({ zh: `费用 ${cost}`, en: `Cost ${cost}` })} · ${dashboardLink(ctx.dashboardUrl, run.id)}`,
    closes,
  ];
  return { title, body: body.filter((part) => part !== null).join('\n\n') };
}

/**
 * The comment on the issue that its Run's pull request (deliver: pr; the merge request with
 * deliver: mr on GitLab, `platform`) is open.
 */
export function pullRequestComment(input: {
  number: number;
  url: string;
  targetBranch: string;
  runId: string;
  dashboardUrl: string;
  platform?: HostPlatform;
}): string {
  const cr = changeRequestTerms(input.platform);
  const link = dashboardLink(input.dashboardUrl, input.runId);
  const branch = `\`${input.targetBranch}\``;
  const number = cr.number(input.number);
  return t({
    zh: `检查已通过，已开 ${cr.short} ${number}，合并到 ${branch}：${input.url}\n\n在 ${cr.host} 上合并这个 ${cr.short} 后，Run 会自动完成，这个 issue 也会自动关闭；没合并就关掉 ${cr.short}，Run 会结束为失败。\n\n${link}`,
    en: `The checks passed, and ${cr.long} ${number} into ${branch} is open: ${input.url}\n\nOnce it is merged on ${cr.host}, the Run completes and this issue is closed automatically; if the ${cr.long} is closed without being merged, the Run ends as failed.\n\n${link}`,
  });
}

/**
 * The comment on a Run's issue once the commits made since a rework sent the Run back are pushed
 * to the pull request it already has (deliver: pr; the merge request on GitLab, `platform`).
 */
export function pullRequestUpdatedComment(input: {
  number: number;
  url: string;
  runId: string;
  dashboardUrl: string;
  platform?: HostPlatform;
}): string {
  const cr = changeRequestTerms(input.platform);
  const link = dashboardLink(input.dashboardUrl, input.runId);
  const number = cr.number(input.number);
  return t({
    zh: `返工后的提交已推送到 ${cr.short} ${number}：${input.url}\n\n${link}`,
    en: `The reworked commits were pushed to ${cr.long} ${number}: ${input.url}\n\n${link}`,
  });
}

/**
 * The comment on a Run's issue once its open pull request (deliver: pr; the merge request on
 * GitLab, `platform`) sent it back for more work: `reason` is the one line of `reworkReason`. The
 * Run goes back by the workflow's rules, so past max_loops it may stop instead; then the issue
 * hears of that as of any Run that stops.
 */
export function pullRequestReworkComment(input: {
  number: number;
  url: string;
  reason: string;
  runId: string;
  dashboardUrl: string;
  platform?: HostPlatform;
}): string {
  const cr = changeRequestTerms(input.platform);
  const link = dashboardLink(input.dashboardUrl, input.runId);
  const number = cr.number(input.number);
  return t({
    zh: `${cr.short} ${number} 需要返工：${input.reason}\n\nRun 带着这些反馈回去修改（计入回退上限），改好后推送到同一个 ${cr.short}：${input.url}\n\n${link}`,
    en: `${cr.longCapital} ${number} needs more work: ${input.reason}\n\nThe Run goes back to work on it with this feedback (counted toward its rollback limit) and pushes the changes to the same ${cr.long}: ${input.url}\n\n${link}`,
  });
}

/**
 * The comment the Master closes a Run's open pull request with (deliver: pr; the merge request on
 * GitLab, `platform`) once the Run ended without completing, for `reason`: nobody follows the pull
 * request any more. `issue`: the Run came from an issue, which a new Run may take up with a pull
 * request of its own.
 */
export function pullRequestClosedComment(input: {
  reason: PrCloseReason;
  runId: string;
  issue: boolean;
  dashboardUrl: string;
  platform?: HostPlatform;
}): string {
  const { short, long } = changeRequestTerms(input.platform);
  const run = `Run \`${input.runId}\``;
  const brand = brandName();
  const why = (() => {
    switch (input.reason) {
      case 'failed':
        return t({
          zh: `${run} 失败了，这个 ${short} 不会再更新，${brand}把它关掉了。${input.issue ? `issue 重做时，新的 Run 会开新的 ${short}。` : ''}`,
          en: `${run} failed, so this ${long} gets no more updates and ${brand} closed it.${input.issue ? ` If the issue is redone, the new Run opens a new ${long}.` : ''}`,
        });
      case 'issue_closed':
        return t({
          zh: `issue 被关掉了，${run} 随之终止，这个 ${short} 不会再更新，${brand}把它关掉了。`,
          en: `The issue was closed, so ${run} was terminated; this ${long} gets no more updates, and ${brand} closed it.`,
        });
      case 'restarted':
        return t({
          zh: `issue 的标题或正文改了，${brand}终止了按旧内容做的 ${run}，关掉了这个 ${short}。新的 Run 按新内容做，做完会开新的 ${short}。`,
          en: `The issue's title or body changed: ${brand} terminated ${run}, which worked from the old text, and closed this ${long}. A new Run works from the new text and opens a new ${long} once it is done.`,
        });
      case 'dropped':
        return t({
          zh: `需求评估决定不做了，${run} 结束，这个 ${short} 不会再更新，${brand}把它关掉了。`,
          en: `The requirement assessment decided not to do it, so ${run} ended; this ${long} gets no more updates, and ${brand} closed it.`,
        });
      case 'cancelled':
        return t({
          zh: `${run} 被终止了，这个 ${short} 不会再更新，${brand}把它关掉了。`,
          en: `${run} was terminated, so this ${long} gets no more updates and ${brand} closed it.`,
        });
    }
  })();
  return `${why}\n\n${dashboardLink(input.dashboardUrl, input.runId)}`;
}

const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

/** `text` as a Markdown quote, cut to `max` characters with an ellipsis. */
export const quote = (text: string, max = 800) => {
  const cut = text.length > max ? `${text.slice(0, max)}…` : text;
  return cut
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
};

/**
 * 「用时 957 分钟（其中 …）」, the total followed by the groups of `groupedTimeParts`: queueing and
 * waiting for work to be switched on, approvals, replies to a block or a resume are told apart
 * from the agents' work.
 * null when the time is not known.
 */
const tookText = (times: RunTimes | undefined): string | null => {
  if (times?.totalMs == null) return null;
  const parts = timeParts(groupedTimeParts(times));
  const total = minutes(times.totalMs);
  return t({
    zh: `用时 ${total} 分钟${parts.length > 0 ? `（其中 ${join(parts)}）` : ''}`,
    en: `took ${total} min${parts.length > 0 ? ` (of which ${join(parts)})` : ''}`,
  });
};

/** 「看板：<url>」, the link to a Run on the dashboard. */
const dashboardLink = (dashboardUrl: string, runId: string) =>
  `${t({ zh: '看板：', en: 'Dashboard: ' })}${dashboardUrl}/#/runs/${runId}`;

const noDetail = () => t({ zh: '（没有说明）', en: '(no details)' });

export function issueUpdate(run: Run, ctx: IssueUpdateContext): IssueUpdate {
  const link = dashboardLink(ctx.dashboardUrl, run.id);
  const redo = t({
    zh: `要重做，重新加上 \`${LABELS.ready}\` 标签。`,
    en: `To redo it, add the \`${LABELS.ready}\` label again.`,
  });
  const s: RunStatus = run.status;
  switch (s) {
    case 'queued':
    case 'running':
      return { label: LABELS.running, comment: null, close: null };
    case 'paused':
      return { label: LABELS.needsYou, comment: null, close: null };
    case 'waiting_approval':
      return {
        label: LABELS.needsYou,
        comment: t({
          zh: `等你审批${ctx.stageName ? `：「${ctx.stageName}」阶段` : ''}。\n\n${link}`,
          en: `Waiting for your approval${ctx.stageName ? ` of the "${ctx.stageName}" stage` : ''}.\n\n${link}`,
        }),
        close: null,
      };
    case 'blocked':
      // The assessment's questions are posted with the discussion (`discussionComment`).
      if (run.blocked?.kind === 'discussion') {
        return { label: LABELS.needsYou, comment: null, close: null };
      }
      // The pull request (merge request) waits for a human on the code host; its link is posted
      // when it is opened (`pullRequestComment`). Nothing is stuck.
      if (run.blocked?.kind === 'pr_open') {
        return { label: LABELS.needsYou, comment: null, close: null };
      }
      if (run.blocked?.kind === 'untrusted_issue') {
        const author = run.issue?.untrusted;
        const who = author ? authorText(author.author, author.association) : '';
        return {
          label: LABELS.needsYou,
          comment: t({
            zh: `issue 的作者${who ? ` ${who}` : ''}不是这个仓库的成员，所以 Run 要等仓库成员在看板上确认需求后才开始，在这之前不会有 Agent 读到它。之后再改这个 issue 不会改变 Run 的需求。\n\n${link}`,
            en: `The author of this issue${who ? `, ${who},` : ''} is not a member of this repo, so the Run waits until a member confirms the requirement on the dashboard; until then no agent reads it. Editing this issue afterwards does not change the Run's requirement.\n\n${link}`,
          }),
          close: null,
        };
      }
      return {
        label: LABELS.needsYou,
        comment: t({
          zh: `Run 卡住了，需要你处理：\n\n${quote(run.blocked?.message ?? noDetail())}\n\n${link}`,
          en: `The Run is stuck and needs you:\n\n${quote(run.blocked?.message ?? noDetail())}\n\n${link}`,
        }),
        close: null,
      };
    case 'completed': {
      const pr = ctx.pr;
      // What the target branch got: the pull request's merge, a squash or a rebase of the Run's
      // commits, else the Run's last commit itself.
      const short = (pr?.mergeCommit ?? run.headCommit)?.slice(0, 7);
      const sha = short ? t({ zh: `（\`${short}\`）`, en: ` (\`${short}\`)` }) : '';
      const cost = `$${run.costUsd.toFixed(2)}`;
      const stats = [t({ zh: `费用 ${cost}`, en: `cost ${cost}` }), tookText(ctx.times)]
        .filter(Boolean)
        .join(' · ');
      const branch = `\`${ctx.targetBranch}\``;
      const cr = changeRequestTerms(ctx.platform);
      if (pr) {
        const number = cr.number(pr.number);
        return {
          label: null,
          comment: t({
            zh: `${cr.short} ${number} 已合并到 ${branch}${sha}：${pr.url}\n\n${stats}\n\n${link}`,
            en: `${cr.longCapital} ${number} was merged into ${branch}${sha}: ${pr.url}\n\n${stats}\n\n${link}`,
          }),
          close: 'completed',
        };
      }
      const host = cr.host;
      return {
        label: null,
        comment: ctx.pushed
          ? t({
              zh: `已合并到 ${branch}${sha}并推送到 ${host}。\n\n${stats}\n\n${link}`,
              en: `Merged into ${branch}${sha} and pushed to ${host}.\n\n${stats}\n\n${link}`,
            })
          : t({
              zh: `已合并到本地 ${branch}${sha}，推送到 ${host} 后就能看到代码。\n\n${stats}\n\n${link}`,
              en: `Merged into the local ${branch}${sha}; the code shows on ${host} once it is pushed.\n\n${stats}\n\n${link}`,
            }),
        close: 'completed',
      };
    }
    case 'failed':
      return failedUpdate(run, ctx.failure, redo, link, ctx.now ?? Date.now());
    case 'cancelled':
      return {
        label: LABELS.failed,
        comment: t({
          zh: `Run 已终止。${redo}\n\n${link}`,
          en: `The Run was cancelled. ${redo}\n\n${link}`,
        }),
        close: null,
      };
    case 'dropped':
      // The conclusion with its reason is posted with the discussion (`discussionComment`).
      return { label: null, comment: null, close: 'not_planned' };
  }
}

/**
 * A failed Run: redone automatically (the issue stays ares1:running), or, once its attempts ran
 * out, the issue is closed as not planned with the reason of every attempt.
 */
function failedUpdate(
  run: Run,
  failure: FailureOutcome | undefined,
  redo: string,
  link: string,
  now: number,
): IssueUpdate {
  const error = quote(run.error ?? noDetail());
  if (!failure) {
    return {
      label: LABELS.failed,
      comment: t({
        zh: `Run 失败了：\n\n${error}\n\n${redo}\n\n${link}`,
        en: `The Run failed:\n\n${error}\n\n${redo}\n\n${link}`,
      }),
      close: null,
    };
  }
  const which = attemptText(failure.attempt, failure.max);
  if (failure.kind === 'redo') {
    // The comment is read later, possibly in another time zone: both how long and the clock time
    // with its offset.
    const m = minutes(failure.redoAt - now);
    const at = clockText(failure.redoAt);
    const next = attemptText(failure.attempt + 1, failure.max);
    const when = t({
      zh: `为了不让一时的 API 或网络故障很快用完尝试次数，先等一会儿：约 ${m} 分钟后（${at} 左右）开始${next}。`,
      en: `So that a passing API or network outage does not use up the attempts, it waits a while first: ${next} starts in about ${m} minute${m === 1 ? '' : 's'}, around ${at}. `,
    });
    const budget = failure.budgetReached
      ? t({
          zh: '另外，今天的自动花费已达上限（`daily_budget_usd`），等明天预算恢复后才会重做。',
          en: "Today's automatic spending has also reached its limit (`daily_budget_usd`), so the redo waits for tomorrow's budget. ",
        })
      : '';
    return {
      label: LABELS.running,
      comment: t({
        zh: `Run 失败了（${which}）：\n\n${error}\n\n会自动重做：新的 Run 会带上这次的失败原因。${when}${budget}不想再做就关闭这个 issue。\n\n${link}`,
        en: `The Run failed (${which}):\n\n${error}\n\nIt is redone automatically, and the new Run is told why this one failed. ${when}${budget}To stop, close this issue.\n\n${link}`,
      }),
      close: null,
    };
  }
  const n = failure.attempt;
  return {
    label: LABELS.failed,
    comment: [
      t({
        zh: `### 失败了 ${n} 次，达到尝试次数上限（\`max_run_attempts: ${failure.max}\`），不再自动重做`,
        en: `### Failed ${n === 1 ? 'once' : `${n} times`}, the most attempts allowed (\`max_run_attempts: ${failure.max}\`): no more automatic redos`,
      }),
      t({ zh: '每次失败的原因：', en: 'Why each attempt failed:' }),
      failureLines(failure.failures),
      t({
        zh: `这个 issue 关闭为 not planned，但这不等于不要这个需求：侦察会读到这些失败原因，可以换个思路重新提案。要按原样再做，重新打开它并加上 \`${LABELS.ready}\`。`,
        en: `This issue is closed as not planned, which does not mean the requirement is unwanted: the scout reads these reasons and may propose it again with another approach. To redo it as it is, reopen it and add \`${LABELS.ready}\`.`,
      }),
      link,
      RETRIES_EXHAUSTED_MARKER,
    ].join('\n\n'),
    close: 'not_planned',
  };
}

export interface DiscussionCommentContext {
  dashboardUrl: string;
  runId: string;
  /** How often the Master looks at the code host, to say when a reply is picked up. */
  pollMinutes: number;
  /** The code host the issue is on, as people know it: GitHub (if omitted) or GitLab. */
  host?: string;
  /**
   * How long the assess stage of the entry waits for a reply (`replyTimeoutHours`), to say what
   * happens when nobody replies; null = it waits however long it takes.
   */
  replyTimeoutHours: number | null;
}

const numbered = (items: string[]) => items.map((q, i) => `${i + 1}. ${q}`).join('\n');
const bulleted = (items: string[]) => items.map((q) => `- ${q}`).join('\n');

/**
 * How one discussion entry shows on the issue: the assessment's questions, nobody having replied
 * in time, its conclusion (the 「需求评估结论」 comment), or a reply written on the dashboard. null
 * for replies written on the issue itself.
 */
export function discussionComment(
  entry: DiscussionEntry,
  ctx: DiscussionCommentContext,
): string | null {
  const link = dashboardLink(ctx.dashboardUrl, ctx.runId);
  if (entry.role === 'human') {
    if (entry.source === 'issue') return null;
    return t({
      zh: `在看板上回复了需求评估：\n\n${quote(entry.text, 4000)}`,
      en: `Replied to the requirement assessment on the dashboard:\n\n${quote(entry.text, 4000)}`,
    });
  }
  if (entry.role === 'timeout') {
    const head =
      entry.hours === 0
        ? t({
            zh: '### 需求评估：不等回复，由评估自己决定',
            en: '### Requirement assessment: not waiting for replies, the assessment decides',
          })
        : t({
            zh: `### 需求评估：${waitText(entry.hours)}内没有人回复，由评估自己决定`,
            en: `### Requirement assessment: nobody replied within ${waitText(entry.hours)}, the assessment decides`,
          });
    return [
      head,
      t({
        zh: '按配置（`reply_timeout_hours`）不再等回复。评估接着自己决定：写明做了哪些假设后开工，或者给出不做的结论并写明理由。结论会发在这里。',
        en: 'As configured (`reply_timeout_hours`), no longer waiting for replies. The assessment now decides on its own: it goes ahead with its assumptions written down, or concludes not to do it with the reasons. The conclusion is posted here.',
      }),
      link,
    ].join('\n\n');
  }
  const parts: string[] = [];
  if (entry.verdict === 'ask') {
    parts.push(
      entry.proposedDrop
        ? t({
            zh: '### 需求评估：认为不该做，请你确认',
            en: '### Requirement assessment: should not be done, please confirm',
          })
        : t({
            zh: '### 需求评估：有疑问，需要和你讨论',
            en: '### Requirement assessment: questions to discuss with you',
          }),
      entry.summary,
    );
    if (entry.questions.length > 0) {
      parts.push(
        t({ zh: '**疑问和顾虑**', en: '**Questions and concerns**' }) +
          `\n\n${numbered(entry.questions)}`,
      );
    }
    if (entry.suggestions.length > 0) {
      parts.push(
        `${t({ zh: '**建议**', en: '**Suggestions**' })}\n\n${bulleted(entry.suggestions)}`,
      );
    }
    const hours = ctx.replyTimeoutHours;
    if (hours === 0) {
      parts.push(
        t({
          zh: '按配置（`reply_timeout_hours: 0`）不等回复，评估接着自己决定。',
          en: 'As configured (`reply_timeout_hours: 0`), there is no wait for replies: the assessment decides on its own next.',
        }),
      );
    } else {
      parts.push(
        t({
          zh: `直接在这个 issue 下回复就行：Master 下次检查 ${ctx.host ?? 'GitHub'} 时（每 ${ctx.pollMinutes} 分钟）会带着讨论重新评估，讨论可以有多轮。${entry.proposedDrop ? '同意不做就回复说明，评估会给出不做的结论并关闭这个 issue；想继续做也请写明理由。' : '如果同意不做，也回复说明。'}`,
          en: `Just reply on this issue: the next time the Master checks ${ctx.host ?? 'GitHub'} (every ${ctx.pollMinutes} min) it assesses again with the discussion, which can take several rounds. ${entry.proposedDrop ? 'If you agree not to do it, say so in a reply, and the assessment concludes with not doing it and closes this issue; to go ahead anyway, please give your reasons.' : 'If you agree not to do it, say so in a reply too.'}`,
        }),
      );
      if (hours !== null) {
        parts.push(
          t({
            zh: `${waitText(hours)}内没有人回复的话，评估会自己决定：写明做了哪些假设后开工，或者给出不做的结论。`,
            en: `If nobody replies within ${waitText(hours)}, the assessment decides on its own: it goes ahead with its assumptions written down, or concludes not to do it.`,
          }),
        );
      }
    }
  } else {
    parts.push(
      t({ zh: '### 需求评估结论：', en: '### Requirement assessment conclusion: ' }) +
        conclusionLabel(entry),
    );
    if (entry.verdict === 'drop') {
      parts.push(
        t({ zh: `理由：${entry.summary}`, en: `Reason: ${entry.summary}` }),
        t({
          zh: '这个 issue 关闭为 not planned，Run 结束。',
          en: 'This issue is closed as not planned and the Run ends.',
        }),
      );
    } else {
      parts.push(entry.summary);
      if (entry.revisedGoal) {
        parts.push(
          `${t({ zh: '**修改后的需求**', en: '**Revised requirement**' })}\n\n${entry.revisedGoal}`,
        );
      }
      parts.push(
        t({
          zh: '接下来按这个需求编码、评审和合并。',
          en: 'Next, this requirement is coded, reviewed and merged.',
        }),
      );
    }
  }
  parts.push(link);
  return parts.join('\n\n');
}
