// The requirement assessment and its discussion: how a reported verdict is taken, what the
// conclusion is and how it is called. Pure (type imports and src/i18n.ts only): the engine, the
// GitHub bridge and the dashboard share these rules.

import { t } from '../i18n.js';
import type {
  AssessmentEntry,
  AssessVerdict,
  DiscussionEntry,
  ReplyEntry,
  ReplyTimeoutEntry,
} from '../store/types.js';

/** What a verdict is called, in the language in use. */
export function verdictLabel(verdict: AssessVerdict): string {
  const labels: Record<AssessVerdict, string> = t({
    zh: { go: '开工', ask: '需要讨论', drop: '不做' },
    en: { go: 'Go ahead', ask: 'Needs discussion', drop: 'Drop' },
  });
  return labels[verdict];
}

/**
 * A human has replied to the assessment; only then may it change the goal. It may conclude drop
 * after a human reply, or once nobody replied in time (`pendingTimeout`).
 */
export function hasHumanReply(discussion: readonly DiscussionEntry[]): boolean {
  return discussion.some((e) => e.role === 'human');
}

/** The human replies so far, one per comment or dashboard reply. */
export function humanReplies(discussion: readonly DiscussionEntry[]): ReplyEntry[] {
  return discussion.filter((e): e is ReplyEntry => e.role === 'human');
}

/** The assessment rounds so far. */
export function assessmentRounds(discussion: readonly DiscussionEntry[]): AssessmentEntry[] {
  return discussion.filter((e): e is AssessmentEntry => e.role === 'assessor');
}

/** The latest assessment's conclusion (go / drop); null while there is none or it asks. */
export function conclusionOf(discussion: readonly DiscussionEntry[]): AssessmentEntry | null {
  const last = assessmentRounds(discussion).at(-1);
  return last && last.verdict !== 'ask' ? last : null;
}

/**
 * The timeout the next round decides after: the discussion ends with nobody having replied in
 * time. Undefined while a human has the last word, or the latest round already concluded.
 */
export function pendingTimeout(
  discussion: readonly DiscussionEntry[],
): ReplyTimeoutEntry | undefined {
  const last = discussion.at(-1);
  return last?.role === 'timeout' ? last : undefined;
}

/**
 * When the questions of a Run's latest round time out, in epoch milliseconds: the round's time
 * plus the stage's wait (`replyTimeoutHours`). null when the discussion does not end with
 * questions, or the stage waits however long it takes.
 */
export function replyDeadline(
  discussion: readonly DiscussionEntry[],
  hours: number | null,
): number | null {
  const last = discussion.at(-1);
  if (hours === null || last?.role !== 'assessor' || last.verdict !== 'ask') return null;
  return Date.parse(last.at) + hours * 3_600_000;
}

/** A wait of `hours` hours in words: 「24 小时」, "30 minutes". */
export function waitText(hours: number): string {
  if (hours >= 1) {
    const h = Math.round(hours * 10) / 10;
    return t({ zh: `${h} 小时`, en: `${h} ${h === 1 ? 'hour' : 'hours'}` });
  }
  const m = Math.max(1, Math.round(hours * 60));
  return t({ zh: `${m} 分钟`, en: `${m} ${m === 1 ? 'minute' : 'minutes'}` });
}

/** How a timeout shows in the discussion, for the assessor and the dashboard alike. */
export function formatReplyTimeout(entry: ReplyTimeoutEntry): { title: string; text: string } {
  return {
    title:
      entry.hours === 0
        ? t({ zh: '不等人回复', en: 'Not waiting for replies' })
        : t({
            zh: `${waitText(entry.hours)}内没有人回复`,
            en: `Nobody replied within ${waitText(entry.hours)}`,
          }),
    text: t({
      zh: '按配置（reply_timeout_hours）不再等人，下一轮由评估自己决定：写明做了哪些假设后开工，或者给出不做的结论并写明理由。',
      en: 'As configured (reply_timeout_hours), no longer waiting for a human: the next round decides on its own, going ahead with its assumptions written down, or concluding not to do it with the reasons.',
    }),
  };
}

/** What a conclusion means, in a few words: shown on the issue and the dashboard alike. */
export function conclusionLabel(
  entry: Pick<AssessmentEntry, 'verdict' | 'revisedGoal' | 'decidedAlone'>,
): string {
  if (entry.verdict === 'drop') {
    return entry.decidedAlone
      ? t({
          zh: '没人回复，评估决定不做',
          en: 'Drop, decided by the assessment as nobody replied',
        })
      : t({ zh: '不做', en: 'Drop' });
  }
  if (entry.verdict === 'go') {
    if (entry.decidedAlone) {
      return t({
        zh: '没人回复，按评估的假设开工',
        en: "Go ahead on the assessment's assumptions, as nobody replied",
      });
    }
    return entry.revisedGoal
      ? t({
          zh: '按讨论后修改的需求开工',
          en: 'Go ahead with the requirement as revised in the discussion',
        })
      : t({ zh: '按原需求开工', en: 'Go ahead with the original requirement' });
  }
  return t({ zh: '需要讨论', en: 'Needs discussion' });
}

/**
 * One assessment round in words: its summary, questions, suggestions and changed requirement.
 * The engine's check detail and the dashboard's discussion show it alike.
 */
export function formatAssessment(entry: AssessmentEntry): string {
  const parts = [entry.summary];
  if (entry.questions.length > 0) {
    const questions = entry.questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
    parts.push(
      t({ zh: `疑问和顾虑：\n${questions}`, en: `Questions and concerns:\n${questions}` }),
    );
  }
  if (entry.suggestions.length > 0) {
    const suggestions = entry.suggestions.map((q) => `- ${q}`).join('\n');
    parts.push(t({ zh: `建议：\n${suggestions}`, en: `Suggestions:\n${suggestions}` }));
  }
  if (entry.revisedGoal) {
    parts.push(
      t({
        zh: `修改后的需求：\n\n${entry.revisedGoal}`,
        en: `Revised requirement:\n\n${entry.revisedGoal}`,
      }),
    );
  }
  return parts.join('\n\n');
}

/** An assessment as the agent reported it. */
export interface ReportedAssessment {
  verdict: AssessVerdict;
  summary: string;
  questions: string[];
  suggestions: string[];
  revisedGoal?: string;
}

/**
 * Why a reported assessment cannot be taken, as feedback for the agent's next attempt; null when
 * it can. After nobody replied in time the round has to conclude: asking again is not accepted.
 */
export function assessmentProblem(
  report: Pick<ReportedAssessment, 'verdict'>,
  discussion: readonly DiscussionEntry[],
): string | null {
  const timeout = pendingTimeout(discussion);
  if (!timeout || report.verdict !== 'ask') return null;
  const why =
    timeout.hours === 0
      ? t({ zh: '这个阶段不等人回复', en: 'This stage does not wait for replies' })
      : t({
          zh: `${waitText(timeout.hours)}内没有人回复`,
          en: `Nobody replied within ${waitText(timeout.hours)}`,
        });
  return t({
    zh: `${why}，这一轮不能再给 ask，只能自己决定：go 并在 summary 里写明做了哪些假设，或者 drop 并在 summary 里写明理由。请按「输出格式」的要求，在最后一条回复中给出 JSON 结果。`,
    en: `${why}, so this round may not give ask again and has to decide on its own: go with the assumptions you made written in summary, or drop with the reasons in summary. Give the JSON result in your last reply, as "Output format" asks.`,
  });
}

/**
 * Take an assessment as the Master acts on it. Before any human reply the agent may not decide on
 * its own: a drop becomes ask (a human confirms not doing it), and a changed goal is ignored (the
 * original requirement holds until a human agreed to change it). After nobody replied in time it
 * decides alone: a drop stands, and a changed goal is still ignored (its assumptions are in the
 * summary, which the later stages read). An ask then is refused before (`assessmentProblem`).
 */
export function takeAssessment(
  report: ReportedAssessment,
  discussion: readonly DiscussionEntry[],
  where: { stageRunId: string; at: string },
): AssessmentEntry {
  const alone = pendingTimeout(discussion) !== undefined;
  const replied = hasHumanReply(discussion);
  const proposedDrop = report.verdict === 'drop' && !replied && !alone;
  const revised = report.revisedGoal?.trim();
  return {
    role: 'assessor',
    verdict: proposedDrop ? 'ask' : report.verdict,
    summary: report.summary.trim(),
    questions: report.questions,
    suggestions: report.suggestions,
    revisedGoal: report.verdict === 'go' && replied && !alone && revised ? revised : null,
    proposedDrop,
    ...(alone && report.verdict !== 'ask' ? { decidedAlone: true } : {}),
    stageRunId: where.stageRunId,
    at: where.at,
  };
}
