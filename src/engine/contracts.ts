import { z } from 'zod';
import { LANGUAGES, type Lang, t } from '../i18n.js';

// Structured results agents must end with (prompt contract + parse/validate,
// plus --json-schema for CLIs that support it).

export const TaskReportSchema = z.object({
  status: z.enum(['done', 'incomplete']),
  summary: z.string(),
});
export type TaskReport = z.infer<typeof TaskReportSchema>;

export const ReviewIssueSchema = z.object({
  severity: z.enum(['must', 'suggestion']),
  file: z.string().optional(),
  description: z.string(),
});

export const ReviewReportSchema = z.object({
  summary: z.string(),
  issues: z.array(ReviewIssueSchema),
});
export type ReviewReport = z.infer<typeof ReviewReportSchema>;

export const AssessReportSchema = z
  .object({
    verdict: z.enum(['go', 'ask', 'drop']),
    summary: z.string().trim().min(1),
    questions: z.array(z.string().trim().min(1)).default([]),
    suggestions: z.array(z.string().trim().min(1)).default([]),
    /** go after a discussion that changed the requirement: the complete new requirement. */
    revisedGoal: z.string().optional(),
  })
  .superRefine((report, ctx) => {
    if (report.verdict === 'ask' && report.questions.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['questions'],
        message: t({
          zh: 'verdict 为 ask 时要在 questions 里列出疑问或顾虑',
          en: 'with verdict ask, list the questions or concerns in questions',
        }),
      });
    }
  });
export type AssessReport = z.infer<typeof AssessReportSchema>;

/**
 * JSON Schema for `claude --json-schema`. The `$schema` (draft 2020-12) marker zod adds is
 * rejected by Claude Code ("no schema with key or ref"), so it is removed.
 */
function toCliJsonSchema(schema: z.ZodType): object {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export const TASK_REPORT_JSON_SCHEMA = toCliJsonSchema(TaskReportSchema);
export const REVIEW_REPORT_JSON_SCHEMA = toCliJsonSchema(ReviewReportSchema);
export const ASSESS_REPORT_JSON_SCHEMA = toCliJsonSchema(AssessReportSchema);

/**
 * Find the structured result: the CLI's own structured output if any, otherwise the last
 * ```json fenced block in the final message, otherwise the whole message as JSON.
 */
export function extractStructured(structured: unknown, finalMessage: string): unknown {
  if (structured !== undefined && structured !== null) return structured;
  const blocks = [...finalMessage.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  const candidates = blocks.map((m) => m[1] ?? '').reverse();
  candidates.push(finalMessage);
  for (const text of candidates) {
    try {
      return JSON.parse(text.trim());
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

export type ParsedReport<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseReport<T>(
  schema: z.ZodType<T>,
  structured: unknown,
  finalMessage: string,
): ParsedReport<T> {
  const raw = extractStructured(structured, finalMessage);
  if (raw === undefined) {
    return {
      ok: false,
      error: t({
        zh: '没有找到约定格式的 JSON 结果',
        en: 'No JSON result in the agreed format was found',
      }),
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join(t({ zh: '；', en: '; ' }));
    return {
      ok: false,
      error: t({
        zh: `JSON 结果不符合约定：${issues}`,
        en: `The JSON result does not match the agreed format: ${issues}`,
      }),
    };
  }
  return { ok: true, value: parsed.data };
}

/** The feedback for a result that could not be parsed (`parseReport`'s error). */
export function formatFeedback(error: string): string {
  return t({
    zh: `${error}。请按「输出格式」的要求，在最后一条回复中给出 JSON 结果。`,
    en: `${error}. Give the JSON result in your last reply, as "Output format" asks.`,
  });
}

/** Why an agent task's result is not acceptable. */
export type ResultProblemKind = 'format' | 'incomplete' | 'denied';

/**
 * The feedback for denied operations: a head line, then one operation per line. Written by
 * resultProblem and read back by deniedOperations, so the format is only defined here. Read back
 * in every language: the stored feedback keeps the language it was written in.
 */
const DENIED_HEAD: Record<Lang, string> = {
  zh: '以下操作被拒绝，任务可能没有完成，请换一种方式完成：',
  en: 'The following operations were denied, so the task may not be complete; complete it another way:',
};
const DENIED_ITEM = '- ';

/** One denied operation on one line: a Bash command may span several. */
const deniedLine = (operation: string) => `${DENIED_ITEM}${operation.replace(/\s+/g, ' ').trim()}`;

/**
 * The denied operations listed in resultProblem's feedback (as stored in the detail of a failed
 * "result" check), whitespace collapsed; empty for any other text.
 */
export function deniedOperations(detail: string): string[] {
  const [head, ...items] = detail.split('\n');
  if (!LANGUAGES.some((l) => DENIED_HEAD[l] === head)) return [];
  return items
    .filter((line) => line.startsWith(DENIED_ITEM))
    .map((line) => line.slice(DENIED_ITEM.length));
}

/**
 * What is wrong with an agent task's result, with the feedback for the agent; null when the
 * result is acceptable. Shared by the engine and the scout's Run digest, so both agree.
 */
export function resultProblem(
  report: ParsedReport<TaskReport>,
  permissionDenials: string[],
): { kind: ResultProblemKind; message: string } | null {
  if (!report.ok) {
    return {
      kind: 'format',
      message: formatFeedback(report.error),
    };
  }
  if (report.value.status === 'incomplete') {
    return {
      kind: 'incomplete',
      message: t({
        zh: `你报告任务没有完成：${report.value.summary}\n请继续完成任务。`,
        en: `You reported the task as not complete: ${report.value.summary}\nPlease continue and complete it.`,
      }),
    };
  }
  if (permissionDenials.length > 0) {
    return {
      kind: 'denied',
      message: [t(DENIED_HEAD), ...permissionDenials.map(deniedLine)].join('\n'),
    };
  }
  return null;
}

export function formatReviewIssues(report: ReviewReport): string {
  const lines = report.issues.map((issue, i) => {
    const level =
      issue.severity === 'must'
        ? t({ zh: '必须修改', en: 'Must fix' })
        : t({ zh: '建议', en: 'Suggestion' });
    const where = issue.file ? t({ zh: `（${issue.file}）`, en: ` (${issue.file})` }) : '';
    return `${i + 1}. [${level}]${where} ${issue.description}`;
  });
  const head = t({ zh: `评审结论：${report.summary}`, en: `Review: ${report.summary}` });
  return [head, ...lines].join('\n');
}
