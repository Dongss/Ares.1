// The requirement assessment and its discussion: how a reported verdict is taken, what the
// conclusion is and how it is called. Pure (type imports and src/i18n.ts only): the engine, the
// GitHub bridge and the dashboard share these rules.

import { t } from '../i18n.js';
import type {
  AssessmentEntry,
  AssessVerdict,
  DiscussionEntry,
  ReplyEntry,
} from '../store/types.js';

/** What a verdict is called, in the language in use. */
export function verdictLabel(verdict: AssessVerdict): string {
  const labels: Record<AssessVerdict, string> = t({
    zh: { go: '开工', ask: '需要讨论', drop: '不做' },
    en: { go: 'Go ahead', ask: 'Needs discussion', drop: 'Drop' },
  });
  return labels[verdict];
}

/** A human has replied to the assessment; only then may it conclude drop or change the goal. */
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

/** What a conclusion means, in a few words: shown on the issue and the dashboard alike. */
export function conclusionLabel(entry: Pick<AssessmentEntry, 'verdict' | 'revisedGoal'>): string {
  if (entry.verdict === 'drop') return t({ zh: '不做', en: 'Drop' });
  if (entry.verdict === 'go') {
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
 * Take an assessment as the Master acts on it. Before any human reply the agent may not decide on
 * its own: a drop becomes ask (a human confirms not doing it), and a changed goal is ignored (the
 * original requirement holds until a human agreed to change it).
 */
export function takeAssessment(
  report: ReportedAssessment,
  discussion: readonly DiscussionEntry[],
  where: { stageRunId: string; at: string },
): AssessmentEntry {
  const replied = hasHumanReply(discussion);
  const proposedDrop = report.verdict === 'drop' && !replied;
  const revised = report.revisedGoal?.trim();
  return {
    role: 'assessor',
    verdict: proposedDrop ? 'ask' : report.verdict,
    summary: report.summary.trim(),
    questions: report.questions,
    suggestions: report.suggestions,
    revisedGoal: report.verdict === 'go' && replied && revised ? revised : null,
    proposedDrop,
    stageRunId: where.stageRunId,
    at: where.at,
  };
}
