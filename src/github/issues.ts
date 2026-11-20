// Labels, issue texts and how a Run's status shows on its issue. Pure functions.

import { brandName } from '../brand.js';
import { RISKS, type Risk } from '../config/schema.js';
import { conclusionLabel, waitText } from '../engine/discussion.js';
import { groupedTimeParts, minutes, type RunTimes, timeParts } from '../engine/times.js';
import { join, t } from '../i18n.js';
import type { DiscussionEntry, Run, RunStatus, ScoutProposal } from '../store/types.js';
import type { LabelDef } from './client.js';

export const LABELS = {
  /** Proposed by an AI scout, waiting for a human. */
  proposal: 'ares1:proposal',
  /** Go: the Master creates a Run for it. Added by a human, or by auto-accept. */
  ready: 'ares1:ready',
  /** Accepted by the Master without a human. */
  auto: 'ares1:auto',
  running: 'ares1:running',
  /** The Run waits for an approval or a reply to the assessment, is blocked or paused. */
  needsYou: 'ares1:needs-you',
  /** The Run failed or was cancelled; add ares1:ready again to redo it. */
  failed: 'ares1:failed',
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
      description: t({
        zh: 'Run 在等审批、卡住了或需求待讨论，需要人处理',
        en: 'The Run waits for an approval, is stuck or has questions: a human is needed',
      }),
    },
    {
      name: LABELS.failed,
      color: 'b60205',
      description: t({
        zh: 'Run 失败或被终止；重新加 ares1:ready 可重做',
        en: 'The Run failed or was cancelled; add ares1:ready again to redo it',
      }),
    },
  ];
}

/** Replace the status label, keeping every other label (provenance, the repo's own labels). */
export function withStatusLabel(labels: readonly string[], status: string | null): string[] {
  const kept = labels.filter((l) => !STATUS_LABELS.includes(l));
  return status ? [...kept, status] : kept;
}

/** Marks where the Master's footer starts; the Run goal leaves it out. */
export const FOOTER_MARKER = '<!-- ares1:footer -->';

/**
 * Ends every comment the Master posts. The Master comments as the same GitHub account as the
 * human, so this is how a human's reply is told apart from the Master's own comments.
 */
export const COMMENT_MARKER = '<!-- ares1 -->';

/** A comment body as the Master posts it: with the marker. */
export function markComment(body: string): string {
  return `${body.trimEnd()}\n\n${COMMENT_MARKER}`;
}

export function isMasterComment(body: string): boolean {
  return body.includes(COMMENT_MARKER);
}

/** A comment body without the marker, e.g. to quote it. */
export function stripMarker(body: string): string {
  return body.replaceAll(COMMENT_MARKER, '').trim();
}

/**
 * A human's replies to the assessment on the issue: the comments after the Master's last one.
 * Empty when the Master has not commented yet (its questions are not posted).
 */
export function repliesAfterMaster(comments: readonly string[]): string[] {
  const last = comments.findLastIndex(isMasterComment);
  if (last < 0) return [];
  return comments.slice(last + 1).filter((c) => c.trim().length > 0);
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

/** Auto-accept up to the configured risk, and only what fits one Run. */
export function isAutoAcceptable(
  p: Pick<ScoutProposal, 'risk' | 'size'>,
  maxRisk: Risk | 'none',
): boolean {
  if (maxRisk === 'none' || p.size === 'L') return false;
  return RISKS.indexOf(p.risk) <= RISKS.indexOf(maxRisk);
}

export function proposalBody(p: ScoutProposal, scoutId: string, auto: boolean): string {
  const list = (items: string[], prefix: string) => items.map((i) => `${prefix}${i}`).join('\n');
  return [
    t({ zh: '### 为什么', en: '### Why' }),
    '',
    p.why,
    '',
    t({ zh: '### 证据', en: '### Evidence' }),
    '',
    list(p.evidence, '- '),
    '',
    t({ zh: '### 要做什么', en: '### What to do' }),
    '',
    p.what,
    '',
    t({ zh: '### 验收标准', en: '### Acceptance criteria' }),
    '',
    list(p.acceptance, '- [ ] '),
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
  /** The target branch was pushed to GitHub before closing. */
  pushed?: boolean;
  /** How long the Run took, split; for a completed Run. */
  times?: RunTimes;
}

const quote = (text: string, max = 800) => {
  const cut = text.length > max ? `${text.slice(0, max)}…` : text;
  return cut
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
};

/**
 * 「用时 957 分钟（其中 …）」, the total followed by the groups of `groupedTimeParts`: queueing and
 * waiting for approvals, replies to a block or a resume are told apart from the agents' work.
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
      return {
        label: LABELS.needsYou,
        comment: t({
          zh: `Run 卡住了，需要你处理：\n\n${quote(run.blocked?.message ?? noDetail())}\n\n${link}`,
          en: `The Run is stuck and needs you:\n\n${quote(run.blocked?.message ?? noDetail())}\n\n${link}`,
        }),
        close: null,
      };
    case 'completed': {
      const short = run.headCommit?.slice(0, 7);
      const sha = short ? t({ zh: `（\`${short}\`）`, en: ` (\`${short}\`)` }) : '';
      const cost = `$${run.costUsd.toFixed(2)}`;
      const stats = [t({ zh: `费用 ${cost}`, en: `cost ${cost}` }), tookText(ctx.times)]
        .filter(Boolean)
        .join(' · ');
      const branch = `\`${ctx.targetBranch}\``;
      return {
        label: null,
        comment: ctx.pushed
          ? t({
              zh: `已合并到 ${branch}${sha}并推送到 GitHub。\n\n${stats}\n\n${link}`,
              en: `Merged into ${branch}${sha} and pushed to GitHub.\n\n${stats}\n\n${link}`,
            })
          : t({
              zh: `已合并到本地 ${branch}${sha}，推送到 GitHub 后就能看到代码。\n\n${stats}\n\n${link}`,
              en: `Merged into the local ${branch}${sha}; the code shows on GitHub once it is pushed.\n\n${stats}\n\n${link}`,
            }),
        close: 'completed',
      };
    }
    case 'failed':
      return {
        label: LABELS.failed,
        comment: t({
          zh: `Run 失败了：\n\n${quote(run.error ?? noDetail())}\n\n${redo}\n\n${link}`,
          en: `The Run failed:\n\n${quote(run.error ?? noDetail())}\n\n${redo}\n\n${link}`,
        }),
        close: null,
      };
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

export interface DiscussionCommentContext {
  dashboardUrl: string;
  runId: string;
  /** How often the Master looks at GitHub, to say when a reply is picked up. */
  pollMinutes: number;
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
          zh: `直接在这个 issue 下回复就行：Master 下次检查 GitHub 时（每 ${ctx.pollMinutes} 分钟）会带着讨论重新评估，讨论可以有多轮。${entry.proposedDrop ? '同意不做就回复说明，评估会给出不做的结论并关闭这个 issue；想继续做也请写明理由。' : '如果同意不做，也回复说明。'}`,
          en: `Just reply on this issue: the next time the Master checks GitHub (every ${ctx.pollMinutes} min) it assesses again with the discussion, which can take several rounds. ${entry.proposedDrop ? 'If you agree not to do it, say so in a reply, and the assessment concludes with not doing it and closes this issue; to go ahead anyway, please give your reasons.' : 'If you agree not to do it, say so in a reply too.'}`,
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
