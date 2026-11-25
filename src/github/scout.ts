// What the AI scout is asked and what it answers.

import { z } from 'zod';
import { brandName } from '../brand.js';
import {
  type AutoAcceptLimits,
  holdsScout,
  PROPOSAL_SIZES,
  RISKS,
  sizeMeanings,
} from '../config/flow.js';
import {
  deniedOperations,
  parseReport,
  type ResultProblemKind,
  type ReviewReport,
  ReviewReportSchema,
  resultProblem,
  TaskReportSchema,
} from '../engine/contracts.js';
import {
  assessmentRounds,
  conclusionLabel,
  conclusionOf,
  humanReplies,
} from '../engine/discussion.js';
import { planSteps } from '../engine/plan.js';
import {
  type ConflictWaitSpan,
  conflictWaitSpans,
  minutes,
  type RunTimePart,
  type RunTimes,
  runTimePartLabels,
  runTimeParts,
  SHOWN_PART_MS,
  storedRunTimes,
  timeParts,
  type WorkSwitch,
  workSwitchesOf,
} from '../engine/times.js';
import { join, t } from '../i18n.js';
import type { Store } from '../store/store.js';
import type {
  Attempt,
  CheckResult,
  EventRow,
  Proposal,
  Run,
  Scout,
  ScoutGap,
  ScoutProposal,
  StageRun,
  Task,
} from '../store/types.js';
import type { UpgradeFailure } from '../upgrade/upgrader.js';
import { executionSlot } from '../util.js';
import type { GhAuthored, GhIssue } from './client.js';
import {
  FOOTER_MARKER,
  isRetriesExhaustedComment,
  isTrusted,
  LABELS,
  proposalSections,
  stripMarker,
} from './issues.js';
import { redactForGitHub } from './redact.js';

export const ProposalSchema = z.object({
  title: z.string().trim().min(1).max(120),
  category: z.enum(['bug', 'feature', 'improvement', 'docs', 'test', 'refactor']),
  size: z.enum(PROPOSAL_SIZES),
  risk: z.enum(RISKS),
  why: z.string().trim().min(1),
  evidence: z.array(z.string().trim().min(1)).min(1),
  what: z.string().trim().min(1),
  acceptance: z.array(z.string().trim().min(1)).min(1),
});

/**
 * A capability the project lacks for one of its README's goals, from the scout's gap analysis.
 * The scout serves every registered repo, each with the goals of its own README, so `goal` copies
 * the goal word for word from that README rather than coming from a fixed list: the dashboard
 * groups gaps by it.
 */
export const GapSchema = z.object({
  goal: z.string().trim().min(1).max(120),
  gap: z.string().trim().min(1),
  evidence: z.array(z.string().trim().min(1)).min(1),
});

export const ScoutReportSchema = z.object({
  gaps: z.array(GapSchema),
  proposals: z.array(ProposalSchema),
});

/**
 * 「S：…；M：…；L：…」: what a proposal's size means, the same meanings a requirement assessment
 * sizes by (`sizeMeanings`), so the two judge a requirement alike.
 */
function sizeDescription(): string {
  const meanings = sizeMeanings();
  return PROPOSAL_SIZES.map((size) => `${size}${t({ zh: '：', en: ': ' })}${meanings[size]}`).join(
    t({ zh: '；', en: '; ' }),
  );
}

/** JSON schema of the scout's answer, its descriptions in the language in use. */
export function scoutReportJsonSchema() {
  return {
    type: 'object',
    required: ['gaps', 'proposals'],
    additionalProperties: false,
    properties: {
      gaps: {
        type: 'array',
        description: t({
          zh: '差距分析：对照 README.md 的目标，这个项目在能力层面还做不到的事，最重要的在前；没有就是空列表',
          en: "Gap analysis: what the project cannot do yet, as capabilities, measured against README.md's goals, most important first; an empty list if there is nothing",
        }),
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['goal', 'gap', 'evidence'],
          properties: {
            goal: {
              type: 'string',
              description: t({
                zh: '缺口挡住的是 README.md 里的哪个目标：一字不差地照抄 README.md 里这个目标的原文，同一个目标在每个缺口里写法相同',
                en: 'The goal in README.md this gap stands in the way of, copied word for word as README.md writes it; the same goal is written the same way in every gap',
              }),
            },
            gap: {
              type: 'string',
              description: t({
                zh: '缺什么能力：系统现在做不到什么',
                en: 'The missing capability: what the system cannot do now',
              }),
            },
            evidence: {
              type: 'array',
              items: { type: 'string' },
              description: t({
                zh: '限制这个能力的代码位置（文件:行号），或 README、文档中的段落',
                en: 'Where the code limits this capability (file:line), or passages of README or other documents',
              }),
            },
          },
        },
      },
      proposals: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'category', 'size', 'risk', 'why', 'evidence', 'what', 'acceptance'],
          properties: {
            title: {
              type: 'string',
              description: t({
                zh: '一句话标题，说清要做什么',
                en: 'One-line title saying what to do',
              }),
            },
            category: { enum: ['bug', 'feature', 'improvement', 'docs', 'test', 'refactor'] },
            size: {
              enum: [...PROPOSAL_SIZES],
              description: sizeDescription(),
            },
            risk: { enum: [...RISKS] },
            why: {
              type: 'string',
              description: t({
                zh: '为什么值得做：现在的问题和做了之后的好处',
                en: 'Why it is worth doing: the problem now and the benefit once done',
              }),
            },
            evidence: {
              type: 'array',
              items: { type: 'string' },
              description: t({
                zh: 'Run id、文件:行号、文档中的段落等可以核对的证据；补能力的提案可以是 README 的目标加上限制这个能力的代码位置',
                en: 'Verifiable evidence: Run ids, file:line, passages of documents; for a proposal that adds a capability, a goal of README together with where the code limits the capability',
              }),
            },
            what: {
              type: 'string',
              description: t({
                zh: '要做什么，写到 Agent 能直接动手的程度；只是一个大能力的第一步时，末尾单独一行写「后续步骤：」，下面列出剩下的步骤',
                en: 'What to do, detailed enough for an agent to start right away; when it is only the first step of a large capability, end it with a line reading "Next steps:" followed by the remaining steps',
              }),
            },
            acceptance: {
              type: 'array',
              items: { type: 'string' },
              description: t({ zh: '验收标准', en: 'Acceptance criteria' }),
            },
          },
        },
      },
    },
  } as const;
}

export function parseScoutReport(
  structured: unknown,
  finalMessage: string,
): { proposals: ScoutProposal[]; gaps: ScoutGap[] } {
  const parsed = parseReport(ScoutReportSchema, structured, finalMessage);
  if (!parsed.ok) {
    throw new Error(
      t({
        zh: `侦察结果不符合约定：${parsed.error}`,
        en: `The scout's result does not follow the contract: ${parsed.error}`,
      }),
    );
  }
  return { proposals: parsed.value.proposals, gaps: parsed.value.gaps };
}

const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

const statusText = (status: Run['status']) =>
  t<Record<Run['status'], string>>({
    zh: {
      queued: '排队中',
      running: '执行中',
      waiting_approval: '等待审批',
      blocked: '卡住',
      paused: '已暂停',
      completed: '已完成',
      failed: '失败',
      cancelled: '已终止',
      dropped: '不做',
    },
    en: {
      queued: 'queued',
      running: 'running',
      waiting_approval: 'waiting for approval',
      blocked: 'stuck',
      paused: 'paused',
      completed: 'completed',
      failed: 'failed',
      cancelled: 'cancelled',
      dropped: 'dropped',
    },
  })[status];

const failText = (reason: NonNullable<StageRun['failReason']>) =>
  t({
    zh: { check: '检查未通过', review: '评审未通过', rejected: '审批被驳回', conflict: '合并冲突' },
    en: {
      check: 'checks failed',
      review: 'review failed',
      rejected: 'approval rejected',
      conflict: 'merge conflict',
    },
  })[reason];

const resultText = (kind: ResultProblemKind) =>
  t<Record<ResultProblemKind, string>>({
    zh: {
      format: '未按格式给出结果',
      incomplete: 'Agent 自称未完成',
      denied: '有操作被拒绝',
    },
    en: {
      format: 'result not in the required format',
      incomplete: 'agent reported it was not done',
      denied: 'operations were denied',
    },
  })[kind];

/** 「：」, between a heading and what follows it on the same line. */
const colon = () => t({ zh: '：', en: ': ' });

/** 「…另有 3 条」, the count of items left out of a list. */
const moreText = (n: number) => t({ zh: `…另有 ${n} 条`, en: `…and ${n} more` });

/** Must-fix issues listed per failed review round; more are only counted. */
const MAX_MUST_ISSUES = 5;

/** Suggestions listed per passed review round; more are only counted. */
const MAX_SUGGESTIONS = 3;

/**
 * Characters kept of each review issue listed (must-fix or suggestion), its file included. This
 * line is the only text of the review the scout sees, and reviewers usually describe what they saw
 * first and how to fix it last, so a short cut drops exactly the fix. With at most
 * MAX_MUST_ISSUES and MAX_SUGGESTIONS listed per round, the prompt stays bounded.
 */
const REVIEW_ISSUE_CHARS = 400;

/** Denied operations listed per stage round (or step of it); more are only counted. */
const MAX_DENIED = 3;

/** Characters kept of a plan step's title on its lines. */
const STEP_TITLE_CHARS = 60;

/** Questions listed per assessment round; more are only counted. */
const MAX_QUESTIONS = 3;

/** Which kind of bad result a failed "result" check was, worked out again from the attempt. */
function resultKind(attempt: Attempt): ResultProblemKind {
  const report = parseReport(TaskReportSchema, attempt.structured, attempt.finalMessage ?? '');
  // An acceptable report in a failed check leaves denied operations as the only cause; they are
  // listed in the check's detail (see deniedOperations), not needed to tell the kind.
  return resultProblem(report, [])?.kind ?? 'denied';
}

/** The operations denied in an execution redone because of them, from its failed result check. */
function deniedIn(attempt: Attempt, failedChecks: CheckResult[]): string[] {
  const check = failedChecks.find((c) => c.kind === 'result');
  if (!check || resultKind(attempt) !== 'denied') return [];
  return deniedOperations(check.detail);
}

/** Why one execution did not pass, from its failed checks. */
function reworkReasons(attempt: Attempt, failedChecks: CheckResult[]): string[] {
  if (attempt.outcome === 'agent_error') return [t({ zh: 'Agent 出错', en: 'agent error' })];
  if (attempt.outcome === 'rate_limited') {
    return [t({ zh: '额度用尽或被限流', en: 'out of quota or rate-limited' })];
  }
  const reasons = failedChecks.map((c) =>
    c.kind === 'command'
      ? t({ zh: `\`${c.name}\` 未通过`, en: `\`${c.name}\` failed` })
      : resultText(resultKind(attempt)),
  );
  // The only rework without a recorded check is a review in the wrong format.
  return reasons.length > 0 ? [...new Set(reasons)] : [resultText('format')];
}

/**
 * Executions within one stage round, or one step of it, when some of them had to be redone:
 * rework inside a stage (failed verify commands, bad output, agent errors, quota or rate limits)
 * never shows up in the stage rounds. The operations denied in them follow, one per line, so the
 * scout can tell what was refused. `indent` is the indent of the line.
 */
function reworkLines(
  head: string,
  attempts: Attempt[],
  failedChecks: Map<string, CheckResult[]>,
  indent = '  ',
): string[] {
  const counts = new Map<string, number>();
  const denied = new Set<string>();
  for (const a of attempts) {
    if (a.outcome !== 'rework' && a.outcome !== 'agent_error' && a.outcome !== 'rate_limited') {
      continue;
    }
    const checks = failedChecks.get(a.id) ?? [];
    for (const reason of reworkReasons(a, checks)) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    for (const operation of deniedIn(a, checks)) denied.add(oneLine(operation, 120));
  }
  if (counts.size === 0) return [];
  const reasons = join([...counts].map(([reason, n]) => `${reason} ×${n}`));
  const n = attempts.length;
  const line = t({
    zh: `${head}：执行 ${n} 次，返工原因：${reasons}`,
    en: `${head}: ${n} execution${n === 1 ? '' : 's'}, reworked because of: ${reasons}`,
  });
  const lines = [`${indent}${oneLine(line, 200)}`];
  const operations = [...denied];
  for (const operation of operations.slice(0, MAX_DENIED)) {
    lines.push(`${indent}  - ${t({ zh: '被拒绝：', en: 'Denied: ' })}${operation}`);
  }
  if (operations.length > MAX_DENIED) {
    lines.push(`${indent}  ${moreText(operations.length - MAX_DENIED)}`);
  }
  return lines;
}

/** 「编码第 2 轮」, a stage round as the digest names it. */
const roundName = (stageName: string, round: number) =>
  t({ zh: `${stageName}第 ${round} 轮`, en: `${stageName} round ${round}` });

/**
 * Why a step of a plan has not passed, or null when it passed or may still pass: it failed, or
 * the Run ended (terminated, or failed elsewhere) before the step was reached or done. Ending a
 * Run cancels its unfinished tasks, so a step's status alone does not tell the two apart; whether
 * it was executed does.
 */
function stepStatusText(task: Task, executions: number, runEnded: boolean): string | null {
  if (task.status === 'passed') return null;
  if (task.status === 'failed') return t({ zh: '失败', en: 'failed' });
  if (!runEnded) return null;
  return executions === 0
    ? t({ zh: 'Run 结束时还没执行到', en: 'not reached before the Run ended' })
    : t({ zh: 'Run 结束时还没做完', en: 'not done when the Run ended' });
}

/**
 * Rework within a stage round. A round its plan split into steps (`planSteps`) says how many,
 * then gives each step's own rework and each step that did not pass a line of its own, so the
 * scout sees how the split worked out and where it got stuck; rework of the plan itself counts
 * toward no step. Any other round counts all its executions together. `showTitles` says whether
 * the steps' titles may be shown: the plan wrote them from the goal.
 */
function roundReworkLines(
  run: Run,
  sr: StageRun,
  stageName: string,
  tasks: { task: Task; attempts: Attempt[] }[],
  failedChecks: Map<string, CheckResult[]>,
  showTitles: boolean,
): string[] {
  const round = roundName(stageName, sr.round);
  const steps = planSteps(tasks.map(({ task }) => task));
  if (steps.size === 0) {
    const attempts = tasks.flatMap((x) => x.attempts);
    return reworkLines(round, attempts, failedChecks);
  }
  const total = steps.size;
  const lines = [
    `  ${t({ zh: `${round}：拆成 ${total} 步`, en: `${round}: split into ${total} steps` })}`,
  ];
  for (const { task, attempts } of tasks) {
    const step = steps.get(task.id);
    if (!step) {
      const head = t({ zh: `${round}的拆分`, en: `${round} planning` });
      lines.push(...reworkLines(head, attempts, failedChecks, '    '));
      continue;
    }
    const name = showTitles ? oneLine(task.title, STEP_TITLE_CHARS) : '';
    const head = t({
      zh: `第 ${step.index}/${total} 步${name ? `「${name}」` : ''}`,
      en: `Step ${step.index}/${total}${name ? ` "${name}"` : ''}`,
    });
    lines.push(...reworkLines(head, attempts, failedChecks, '    '));
    const status = stepStatusText(task, attempts.length, run.finishedAt !== null);
    if (status) lines.push(`    ${head}${colon()}${status}`);
  }
  return lines;
}

/**
 * The review given in a stage round, as the last reviewer that finished gave it; null if none
 * finished or its report cannot be read.
 */
function reviewOf(attempts: Attempt[]): ReviewReport | null {
  const attempt = attempts.findLast((a) => a.outcome === 'passed');
  if (!attempt) return null;
  const parsed = parseReport(ReviewReportSchema, attempt.structured, attempt.finalMessage ?? '');
  return parsed.ok ? parsed.value : null;
}

/** 「    - [src/a.ts] 没有处理空输入」, a review issue on its own line under its round. */
function issueLine(issue: ReviewReport['issues'][number]): string {
  const where = issue.file ? `[${issue.file}] ` : '';
  return `    - ${oneLine(`${where}${issue.description}`, REVIEW_ISSUE_CHARS)}`;
}

/**
 * 「并行时合并冲突（同一仓库里同时在执行或先合并了的有 run-b）」, a merge conflict while other
 * Runs of the execution slot worked side by side with the Run (`parallelRuns`).
 */
const parallelConflictText = (runIds: string[]) =>
  t({
    zh: `并行时合并冲突（同一仓库里同时在执行或先合并了的有 ${join(runIds)}）`,
    en: `merge conflict while working side by side (${join(runIds)} of the same repo executed or merged meanwhile)`,
  });

/**
 * Why a stage round failed. A failed review lists each must-fix issue on its own line, so a long
 * review summary cannot crowd them out; suggestions are only counted. A merge conflict says which
 * Runs worked side by side with this one meanwhile (`parallel`), if any.
 */
function failLines(
  sr: StageRun,
  stageName: string,
  attempts: Attempt[],
  parallel: string[],
): string[] {
  if (!sr.failReason) return [];
  const head = `  ${roundName(stageName, sr.round)}`;
  const review = sr.failReason === 'review' ? reviewOf(attempts) : null;
  if (review) {
    const must = review.issues.filter((i) => i.severity === 'must');
    const suggestions = review.issues.length - must.length;
    const summary = oneLine(review.summary, 100);
    const lines = [
      t({
        zh: `${head}未通过：必须修改 ${must.length} 条${suggestions > 0 ? `（另有建议 ${suggestions} 条）` : ''}${summary ? `；总结：${summary}` : ''}`,
        en: `${head} failed: ${must.length} must-fix${suggestions > 0 ? ` (and ${suggestions} suggestion${suggestions === 1 ? '' : 's'})` : ''}${summary ? `; summary: ${summary}` : ''}`,
      }),
    ];
    for (const issue of must.slice(0, MAX_MUST_ISSUES)) lines.push(issueLine(issue));
    if (must.length > MAX_MUST_ISSUES) lines.push(`    ${moreText(must.length - MAX_MUST_ISSUES)}`);
    return lines;
  }
  const besideOthers = sr.failReason === 'conflict' && parallel.length > 0;
  const reason = besideOthers ? parallelConflictText(parallel) : failText(sr.failReason);
  if (!sr.failFeedback) {
    // Without feedback only a merge conflict beside other Runs is worth a line.
    return besideOthers ? [t({ zh: `${head}${reason}`, en: `${head}: ${reason}` })] : [];
  }
  const feedback = oneLine(sr.failFeedback, 300);
  return [
    t({
      zh: `${head}${reason}：${feedback}`,
      en: `${head}: ${reason}: ${feedback}`,
    }),
  ];
}

/**
 * The suggestions of a review round that passed. Reviewers leave improvements beyond the goal and
 * polish of edge cases as suggestions on purpose, for later; they reach no issue, so unless the
 * scout sees them here nobody picks them up again. A round still executing or waiting for approval
 * has not passed, even when its reviewer already reported: it may yet fail, or the Run may end
 * there.
 */
function suggestionLines(sr: StageRun, stageName: string, attempts: Attempt[]): string[] {
  if (sr.status !== 'passed') return [];
  const suggestions = reviewOf(attempts)?.issues.filter((i) => i.severity === 'suggestion') ?? [];
  const n = suggestions.length;
  if (n === 0) return [];
  const head = `  ${roundName(stageName, sr.round)}`;
  const lines = [
    t({
      zh: `${head}通过，建议 ${n} 条：`,
      en: `${head} passed, ${n} suggestion${n === 1 ? '' : 's'}:`,
    }),
  ];
  for (const issue of suggestions.slice(0, MAX_SUGGESTIONS)) lines.push(issueLine(issue));
  if (n > MAX_SUGGESTIONS) lines.push(`    ${moreText(n - MAX_SUGGESTIONS)}`);
  return lines;
}

/** Where the requirement assessment stands, as it follows 「结论：」. */
function conclusionText(run: Run): string {
  const conclusion = conclusionOf(run.discussion);
  if (conclusion) {
    const label = conclusionLabel(conclusion);
    // The goal at the head of the Run's digest stays the original requirement.
    return conclusion.revisedGoal
      ? t({
          zh: `${label}（需求在讨论后改过，上面的目标是原需求）`,
          en: `${label} (the requirement was revised in the discussion; the goal above is the original one)`,
        })
      : label;
  }
  if (run.finishedAt) {
    return t({ zh: '没有（Run 在讨论中结束）', en: 'none (the Run ended during the discussion)' });
  }
  const last = run.discussion.at(-1);
  if (last?.role === 'human') {
    return t({
      zh: '还没有（人已回复，重新评估中）',
      en: 'not yet (a human replied; assessing again)',
    });
  }
  if (last?.role === 'timeout') {
    return t({
      zh: '还没有（没人回复，评估自己决定中）',
      en: 'not yet (nobody replied; the assessment is deciding on its own)',
    });
  }
  return assessmentRounds(run.discussion).at(-1)?.proposedDrop
    ? t({
        zh: '评估认为不该做，等人确认',
        en: 'the assessment thinks it should not be done; waiting for a human to confirm',
      })
    : t({ zh: '等人回复', en: 'waiting for a human reply' });
}

/**
 * The requirement assessment's discussion. Questions to a human say the requirement was unclear
 * or off course, yet neither rework nor failed rounds show them: an asking assessment passes its
 * execution and runs again in the same stage round once a human replied.
 */
function discussionLines(run: Run): string[] {
  if (run.discussion.length === 0) return [];
  const rounds = assessmentRounds(run.discussion);
  const replies = humanReplies(run.discussion).length;
  const timeouts = run.discussion.filter((e) => e.role === 'timeout').length;
  const n = rounds.length;
  const unanswered =
    timeouts > 0
      ? t({
          zh: `，没人回复 ${timeouts} 次`,
          en: `, ${timeouts} time${timeouts === 1 ? '' : 's'} nobody replied`,
        })
      : '';
  const lines = [
    t({
      zh: `  需求评估：评估 ${n} 轮，人回复 ${replies} 次${unanswered}；结论：${conclusionText(run)}`,
      en: `  Requirement assessment: ${n} round${n === 1 ? '' : 's'}, ${replies} human repl${replies === 1 ? 'y' : 'ies'}${unanswered}; conclusion: ${conclusionText(run)}`,
    }),
  ];
  for (const [i, round] of rounds.entries()) {
    if (round.verdict !== 'ask') continue;
    const summary = oneLine(round.summary, 150);
    lines.push(
      round.proposedDrop
        ? t({
            zh: `    第 ${i + 1} 轮认为不该做：${summary}`,
            en: `    Round ${i + 1} thinks it should not be done: ${summary}`,
          })
        : t({ zh: `    第 ${i + 1} 轮疑问：`, en: `    Round ${i + 1} questions:` }),
    );
    for (const question of round.questions.slice(0, MAX_QUESTIONS)) {
      lines.push(`      - ${oneLine(question, 150)}`);
    }
    if (round.questions.length > MAX_QUESTIONS) {
      lines.push(`      ${moreText(round.questions.length - MAX_QUESTIONS)}`);
    }
  }
  const conclusion = conclusionOf(run.discussion);
  if (conclusion?.verdict === 'drop') {
    lines.push(
      `    ${t({ zh: '不做的理由：', en: 'Reason for dropping it: ' })}${oneLine(conclusion.summary, 300)}`,
    );
  }
  return lines;
}

/**
 * How long a finished Run took, split so that queueing and waiting for a human are not taken for
 * slow agents: 「，用时 957 分钟（Agent 执行 40 分钟，排队 20 分钟，等审批 890 分钟）」; empty
 * while the Run has not finished.
 */
function tookText(times: RunTimes): string {
  if (times.totalMs === null) return '';
  const parts = timeParts(runTimeParts(times));
  const total = minutes(times.totalMs);
  return t({
    zh: `，用时 ${total} 分钟${parts.length > 0 ? `（${parts.join('，')}）` : ''}`,
    en: `, took ${total} min${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`,
  });
}

/**
 * Whether the Run's goal may go into a prompt: anything but the goal of an issue written by
 * someone the Master does not trust, before a human confirmed it.
 */
function trustedGoal(run: Run): boolean {
  const untrusted = run.issue?.untrusted;
  return !untrusted || untrusted.confirmedAt !== null;
}

/**
 * Events the Master records on a Run it terminated on its own, by type, with the reason each
 * gives. A Master-initiated termination of a new kind adds its event here.
 */
const TERMINATION_REASONS: Record<string, (data: EventRow['data']) => string> = {
  'run.issue_closed': ({ stateReason }) => {
    if (stateReason === 'completed') {
      return t({ zh: 'issue 被人关闭（已完成）', en: 'the issue was closed as completed' });
    }
    if (stateReason === 'not_planned') {
      return t({ zh: 'issue 被人关闭为不做', en: 'the issue was closed as not planned' });
    }
    return t({ zh: 'issue 被人关闭', en: 'the issue was closed' });
  },
  'run.goal_changed': ({ newRun }) =>
    typeof newRun === 'string'
      ? t({
          zh: `issue 的标题或正文被人改了，已按新内容重开为 ${newRun}`,
          en: `the issue's title or body was edited, so it was started over from the new text as ${newRun}`,
        })
      : t({
          zh: 'issue 的标题或正文被人改了，已按新内容重开',
          en: `the issue's title or body was edited, so it was started over from the new text`,
        }),
};

/**
 * Why a cancelled Run was terminated: the reason of the last event the Master recorded when it
 * terminated the Run on its own, otherwise a human terminated it on the dashboard.
 */
function terminationReason(events: EventRow[]): string {
  const event = events.findLast((e) => Object.hasOwn(TERMINATION_REASONS, e.type));
  const reason = event && TERMINATION_REASONS[event.type];
  return reason
    ? reason(event.data)
    : t({ zh: '人在看板上终止', en: 'by a human on the dashboard' });
}

/** A stretch of time, in epoch milliseconds. */
interface Span {
  start: number;
  end: number;
}

const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

/**
 * How many of the Runs, given by their executions, executed at the same time as another of them
 * at least once.
 */
function overlappingRuns(executions: readonly Span[][]): number {
  return executions.filter((own, i) =>
    executions.some((other, j) => j !== i && own.some((a) => other.some((b) => overlaps(a, b)))),
  ).length;
}

/** The digest's first line: the limit on Runs side by side, and how many of them were. */
function parallelHead(perRepo: number, runs: number, overlapping: number): string {
  return t({
    zh: `concurrency.per_repo（同一仓库最多同时执行几个 Run）：${perRepo}；下面 ${runs} 个 Run 里，执行时间和别的 Run 有重叠的 ${overlapping} 个`,
    en: `concurrency.per_repo (how many Runs of a repo may execute at a time): ${perRepo}; ${overlapping} of the ${runs} Run${runs === 1 ? '' : 's'} below executed at the same time as another`,
  });
}

/** Overlapping paths listed on a Run's line of waits; more are only counted. */
const MAX_CONFLICT_PATHS = 3;

/**
 * 「为避开冲突等了 2 次，共 35 分钟（等 run-a，重叠路径 src/a、docs）」: the Run's waits for Runs it
 * overlaps (`waits`, from `conflictWaitSpans`), how long they took (`conflictWaitMs` of its times;
 * a wait still going on counts once it is over), the Runs waited for and the overlapping paths.
 * Empty without waits. `showPaths` says whether the paths may be shown: the assessment wrote them
 * from the goal.
 */
function conflictWaitLines(
  run: Run,
  waits: readonly ConflictWaitSpan[],
  waitedMs: number,
  showPaths: boolean,
): string[] {
  const n = waits.length;
  if (n === 0) return [];
  const runIds = join([...new Set(waits.map((w) => w.runId))]);
  const paths = showPaths ? [...new Set(waits.flatMap((w) => w.paths))] : [];
  const shown = paths.slice(0, MAX_CONFLICT_PATHS).map((p) => oneLine(p, 120));
  const more = paths.length > MAX_CONFLICT_PATHS ? moreText(paths.length - MAX_CONFLICT_PATHS) : '';
  const mins = minutes(waitedMs);
  const still = run.status === 'queued' && waits.at(-1)?.to === null;
  const counted = waitedMs >= SHOWN_PART_MS;
  return [
    t({
      zh: `  为避开冲突等了 ${n} 次${counted ? `，共 ${mins} 分钟` : ''}${still ? '，现在还在等' : ''}（等 ${runIds}${shown.length > 0 ? `，重叠路径 ${join(shown)}${more}` : ''}）`,
      en: `  Waited for an overlapping Run ${n} time${n === 1 ? '' : 's'}${counted ? `, ${mins} min in all` : ''}${still ? ', still waiting' : ''} (for ${runIds}${shown.length > 0 ? `; overlapping paths ${join(shown)}${more}` : ''})`,
    }),
  ];
}

/**
 * What the digest reads of the Runs of the repo's execution slot (`executionSlot`: the repo and
 * any other registered on the same path), each read once: their executions, and when their merges
 * passed.
 */
class SlotHistory {
  private runs: Run[] | undefined;
  private readonly executions = new Map<string, Span[]>();
  private readonly now = Date.now();

  constructor(
    private readonly store: Store,
    private readonly repoId: string,
  ) {}

  /** The Run's executions, each from start to end; one still going lasts until now. */
  executionsOf(runId: string): Span[] {
    let spans = this.executions.get(runId);
    if (!spans) {
      spans = this.store.listRunAttempts(runId).map((a) => ({
        start: Date.parse(a.startedAt),
        end: a.endedAt ? Date.parse(a.endedAt) : this.now,
      }));
      this.executions.set(runId, spans);
    }
    return spans;
  }

  /** When the Run's merge stage rounds passed, in epoch milliseconds. */
  mergesOf(run: Run): number[] {
    const merge = new Set(run.template.stages.filter((s) => s.kind === 'merge').map((s) => s.id));
    return this.store
      .listStageRuns(run.id)
      .filter((sr) => merge.has(sr.stageId) && sr.status === 'passed' && sr.endedAt)
      .map((sr) => Date.parse(sr.endedAt as string));
  }

  /** Every Run of the execution slot, across the repos registered on its path. */
  slotRuns(): Run[] {
    if (!this.runs) {
      const slot = executionSlot(this.store.getRepo(this.repoId).path);
      this.runs = this.store
        .listRepos()
        .filter((r) => r.id === this.repoId || executionSlot(r.path) === slot)
        .flatMap((r) => this.store.listRuns({ repoId: r.id }));
    }
    return this.runs;
  }

  /**
   * The other Runs of the slot that worked side by side with `run` between the start of its work
   * past the assessment (its first round of another stage; its creation without one) and the
   * merge conflict that failed the round `sr`: one executing within that time, or whose merge
   * passed within it, may have changed what the Run then conflicted with. Their ids, oldest
   * first.
   */
  parallelRuns(run: Run, stageRuns: readonly StageRun[], sr: StageRun): string[] {
    const kind = (stageId: string) => run.template.stages.find((s) => s.id === stageId)?.kind;
    const begun = stageRuns.find((r) => kind(r.stageId) !== 'assess')?.startedAt ?? run.createdAt;
    const window = { start: Date.parse(begun), end: Date.parse(sr.endedAt ?? sr.startedAt) };
    return this.slotRuns()
      .filter((other) => {
        if (other.id === run.id || Date.parse(other.createdAt) > window.end) return false;
        if (other.finishedAt && Date.parse(other.finishedAt) < window.start) return false;
        return (
          this.executionsOf(other.id).some((e) => overlaps(e, window)) ||
          this.mergesOf(other).some((at) => at >= window.start && at <= window.end)
        );
      })
      .map((other) => other.id)
      .reverse();
  }
}

/**
 * Recent Runs of the repo, with what went wrong in them: the scout's best evidence. It opens with
 * the repo's `concurrency.per_repo` at the time (`perRepo`) and how many of the Runs executed side
 * by side with another, so that the scout can weigh what working side by side costs in waits,
 * merge conflicts and rework against the time Runs spend queued.
 */
export function runDigest(store: Store, repoId: string, perRepo: number, limit = 15): string {
  const runs = store.listRuns({ repoId }).slice(0, limit);
  if (runs.length === 0) return t({ zh: '（还没有 Run）', en: '(no Runs yet)' });
  // Every finished Run's times need the whole record of the work switch: read it once, at the
  // first finished Run, rather than once per Run.
  let switches: WorkSwitch[] | undefined;
  const workSwitches = () => {
    switches ??= workSwitchesOf(store);
    return switches;
  };
  const slot = new SlotHistory(store, repoId);
  const overlapping = overlappingRuns(runs.map((run) => slot.executionsOf(run.id)));
  const head = parallelHead(perRepo, runs.length, overlapping);
  const digests = runs
    .map((run) => {
      const stageRuns = store.listStageRuns(run.id);
      const events = store.listEvents(run.id);
      const conflictWaits = conflictWaitSpans(events);
      const failedChecks = new Map<string, CheckResult[]>();
      for (const c of store.listChecks(run.id)) {
        if (c.passed || !c.attemptId) continue;
        failedChecks.set(c.attemptId, [...(failedChecks.get(c.attemptId) ?? []), c]);
      }
      const stage = (stageId: string) => run.template.stages.find((s) => s.id === stageId);
      const name = (stageId: string) => stage(stageId)?.name ?? stageId;
      const trusted = trustedGoal(run);
      const rounds = new Map<string, number>();
      for (const sr of stageRuns) rounds.set(sr.stageId, (rounds.get(sr.stageId) ?? 0) + 1);
      // A Run that waited for one it overlaps says how long, finished or not.
      const times =
        run.finishedAt || conflictWaits.length > 0
          ? storedRunTimes(store, run, workSwitches())
          : null;
      const took = times ? tookText(times) : '';
      const status = statusText(run.status);
      const date = run.createdAt.slice(0, 10);
      const goal = trusted
        ? oneLine(run.goal.split('\n')[0] ?? '', 100)
        : t({
            zh: `#${run.issue?.number}（issue 的作者不是仓库成员，也没有人确认过，内容不列出）`,
            en: `#${run.issue?.number} (written by someone who is not a member of the repo and confirmed by nobody, so not shown)`,
          });
      const roundList =
        [...rounds].map(([id, n]) => `${name(id)}×${n}`).join(' ') || t({ zh: '无', en: 'none' });
      const cost = `$${run.costUsd.toFixed(2)}`;
      // An automatic redo of the same issue after earlier Runs failed.
      const attempt = run.issue?.attempt ?? 1;
      const redo =
        attempt > 1 ? t({ zh: `，第 ${attempt} 次尝试`, en: `, attempt ${attempt}` }) : '';
      const lines = [
        t({
          zh: `- ${run.id}（${status}，${date}${redo}）${goal}`,
          en: `- ${run.id} (${status}, ${date}${redo}) ${goal}`,
        }),
        t({
          zh: `  轮次：${roundList}；费用 ${cost}${took}`,
          en: `  Rounds: ${roundList}; cost ${cost}${took}`,
        }),
      ];
      // Blocked on the discussion: its lines below say so and list the questions the block
      // message repeats. Waiting for a human to confirm an untrusted goal: the goal says so.
      if (
        run.blocked &&
        run.blocked.kind !== 'discussion' &&
        run.blocked.kind !== 'untrusted_issue'
      ) {
        lines.push(
          `  ${t({ zh: '卡住', en: 'Stuck' })}${colon()}${oneLine(run.blocked.message, 300)}`,
        );
      }
      if (run.error) {
        lines.push(`  ${t({ zh: '错误', en: 'Error' })}${colon()}${oneLine(run.error, 300)}`);
      }
      // Terminated is a strong lead: a human changed course, turned the requirement down, or it
      // was done some other way.
      if (run.status === 'cancelled') {
        const reason = terminationReason(events);
        lines.push(`  ${t({ zh: '终止', en: 'Terminated' })}${colon()}${reason}`);
      }
      lines.push(...discussionLines(run));
      lines.push(...conflictWaitLines(run, conflictWaits, times?.conflictWaitMs ?? 0, trusted));
      for (const sr of stageRuns) {
        const tasks = store
          .listTasks(sr.id)
          .map((task) => ({ task, attempts: store.listAttempts(task.id) }));
        const attempts = tasks.flatMap((x) => x.attempts);
        const parallel = sr.failReason === 'conflict' ? slot.parallelRuns(run, stageRuns, sr) : [];
        lines.push(...roundReworkLines(run, sr, name(sr.stageId), tasks, failedChecks, trusted));
        lines.push(...failLines(sr, name(sr.stageId), attempts, parallel));
        // Reviewers read the goal: from an untrusted one, their suggestions may carry its text.
        if (trusted && stage(sr.stageId)?.kind === 'review') {
          lines.push(...suggestionLines(sr, name(sr.stageId), attempts));
        }
      }
      return lines.join('\n');
    })
    .join('\n');
  return `${head}\n${digests}`;
}

/**
 * Existing issues, so the scout does not propose them again; rejections are counterexamples.
 * Anybody can open an issue or comment on a public repo, so only issues and comments written by
 * people the Master trusts (`isTrusted`, the Master itself included) are listed; `master` is the
 * login the Master acts as.
 *
 * `closed` are the latest closed issues; `notPlanned` are issues closed as not planned, however
 * old. Those not among `closed` get a section of their own, so that old rejections and their
 * reasons stay in sight without crowding the recent ones. `notPlanned` is null when they could
 * not be fetched: the scout is told that only the recent rejections are in sight.
 *
 * Open and done issues carry their next steps (see nextSteps), so that the scout proposes the
 * next step of a large capability once the one before it is done.
 */
export function issueDigest(
  open: GhIssue[],
  closed: GhIssue[],
  master: string | null,
  notPlanned: GhIssue[] | null = [],
): string {
  const recent = new Set(closed.map((i) => i.number));
  const older = (notPlanned ?? []).filter((i) => !recent.has(i.number));
  const trusted = <T extends GhAuthored>(items: T[]) => items.filter((i) => isTrusted(i, master));
  const labels = (i: GhIssue) => {
    const ours = i.labels.filter((l) => l.startsWith('ares1:'));
    return ours.length ? ` [${ours.join(', ')}]` : '';
  };
  const openLines = trusted(open).map(
    (i) => `- #${i.number}${labels(i)} ${i.title}${nextStepsLines(i.body)}`,
  );
  const closedLines = trusted(closed).map((i) => closedIssueLine(i, master));
  const olderLines = trusted(older).map((i) => closedIssueLine(i, master));
  const none = t({ zh: '（无）', en: '(none)' });
  const sections = [
    t({ zh: '### 未关闭', en: '### Open' }),
    openLines.join('\n') || none,
    '',
    t({ zh: '### 最近关闭', en: '### Recently closed' }),
    closedLines.join('\n') || none,
  ];
  if (!notPlanned) {
    sections.push(
      '',
      t({
        zh: '（更早被关闭为不做的 issue 这次没能取到，上面只列出了最近关闭的。更早被拒绝过的需求不在这里：提出的需求如果可能早就被拒绝过，要多加小心。）',
        en: '(Older issues closed as not planned could not be fetched this time; only the recently closed ones are listed above. Requirements turned down earlier are not here, so be careful with any proposal that may have been rejected before.)',
      }),
    );
  }
  // Nothing older (a young repo): no section saying so.
  if (olderLines.length) {
    sections.push(
      '',
      t({ zh: '### 更早被关闭为不做的', en: '### Older issues closed as not planned' }),
      olderLines.join('\n'),
    );
  }
  return sections.join('\n');
}

/**
 * A closed issue in the scout's list: done, rejected by a human with the reason, or closed by
 * the Master after every attempt failed. Only comments by people the Master trusts count.
 */
function closedIssueLine(i: GhIssue, master: string | null): string {
  const comments = i.comments.filter((c) => isTrusted(c, master)).map((c) => c.body);
  // Closed by the Master after every attempt failed: not a human's rejection.
  const exhausted = comments.findLast(isRetriesExhaustedComment);
  if (i.stateReason === 'not_planned' && exhausted && exhausted === comments.at(-1)) {
    const head = t({
      zh: '多次失败后关闭（不是人拒绝的）',
      en: 'Closed after repeated failures (not rejected by a human)',
    });
    const reasons = `${t({ zh: '失败原因', en: 'Failures' })}${colon()}${oneLine(stripMarker(exhausted), 800)}`;
    return `- #${i.number} ${head}${colon()}${i.title}\n  ${reasons}`;
  }
  if (i.stateReason === 'not_planned') {
    const last = comments.at(-1);
    const reason = last && stripMarker(last);
    const why = reason
      ? `\n  ${t({ zh: '理由', en: 'Reason' })}${colon()}${oneLine(reason, 300)}`
      : '';
    return `- #${i.number} ${t({ zh: '不做', en: 'Not planned' })}${colon()}${i.title}${why}`;
  }
  return `- #${i.number} ${t({ zh: '已完成', en: 'Done' })}${colon()}${i.title}${nextStepsLines(i.body)}`;
}

/** Characters kept of the next steps an issue lists, in the scout's list of issues. */
const NEXT_STEPS_CHARS = 600;

/**
 * The line that opens the next steps: a heading, a line of its own (bold or not, a colon after it
 * or not), or the name, a colon and the first step on the same line. Both names count whatever
 * the language in use: the issue may have been written in either.
 */
const NEXT_STEPS_HEAD =
  /^(?:#{1,6}[ \t]+)?(?:\*\*|__)?(?:后续步骤|next steps)(?:\*\*|__)?[ \t]*(?:[:：](?:\*\*|__)?[ \t]*(.*))?$/i;

/** The level of a Markdown heading; 0 for any other line. */
const headingLevel = (line: string) => /^ {0,3}(#{1,6})(?:[ \t]|$)/.exec(line)?.[1]?.length ?? 0;

/**
 * The 「后续步骤」/"Next steps" of an issue's body, one string per line: the steps a scout left
 * for later when it proposed only the first step of a large capability (a human may write them
 * too). They run from the line that opens them (see NEXT_STEPS_HEAD) to the next heading (of the
 * same level or higher when that line is a heading itself) or the end of the body, the proposal's
 * footer left out; at most NEXT_STEPS_CHARS characters. Empty when there are none.
 */
export function nextSteps(body: string): string[] {
  const cut = body.indexOf(FOOTER_MARKER);
  const lines = (cut >= 0 ? body.slice(0, cut) : body).split(/\r?\n/);
  const start = lines.findIndex((l) => NEXT_STEPS_HEAD.test(l.trim()));
  if (start < 0) return [];
  const head = lines[start] as string;
  const level = headingLevel(head);
  const steps = [NEXT_STEPS_HEAD.exec(head.trim())?.[1] ?? ''];
  for (const line of lines.slice(start + 1)) {
    const next = headingLevel(line);
    if (next > 0 && (level === 0 || next <= level)) break;
    steps.push(line);
  }
  const kept: string[] = [];
  let left = NEXT_STEPS_CHARS;
  for (const step of steps.map((s) => s.trimEnd()).filter((s) => s.trim())) {
    if (step.length > left) {
      kept.push(`${step.slice(0, left)}…`);
      break;
    }
    kept.push(step);
    left -= step.length;
  }
  return kept;
}

/**
 * The next steps of an issue's body, or of a local proposal's what, under its line in the scout's
 * list, so that a later scout goes on with the next step once this one is done; empty when it
 * lists none. Only issues by people the Master trusts reach here.
 */
function nextStepsLines(body: string): string {
  const steps = nextSteps(body);
  if (steps.length === 0) return '';
  const head = `\n  ${t({ zh: '后续步骤：', en: 'Next steps:' })}`;
  return `${head}${steps.map((s) => `\n    ${s}`).join('')}`;
}

/** Local proposals listed per section of the scout's list; more are only counted. */
const MAX_LOCAL_PENDING = 100;
const MAX_LOCAL_ACCEPTED = 50;
/** Rejections stay counterexamples however old, as issues closed as not planned do. */
const MAX_LOCAL_REJECTED = 300;

/** What the scout's list of local proposals reads of the Run an accepted one became. */
export type ProposalRun = Pick<Run, 'status' | 'error' | 'discussion'>;

/** A section of the list: its lines, at most `max` of them, the rest only counted. */
function digestSection(heading: string, lines: string[], max: number): string {
  if (lines.length === 0) return `${heading}\n${t({ zh: '（无）', en: '(none)' })}`;
  const shown = lines.slice(0, max);
  if (lines.length > max) shown.push(moreText(lines.length - max));
  return `${heading}\n${shown.join('\n')}`;
}

/**
 * An accepted proposal: the Run it became and how that stands, whether it was accepted without a
 * human; why the Run failed or why its assessment dropped the requirement, which the Run digest
 * no longer shows once the Run is old; and its next steps.
 */
function acceptedProposalLine(p: Proposal, run: ProposalRun | undefined): string {
  const parts: string[] = [];
  if (p.runId) {
    parts.push(run ? `Run ${p.runId}${colon()}${statusText(run.status)}` : `Run ${p.runId}`);
  }
  if (p.auto) parts.push(t({ zh: '自动采纳', en: 'accepted automatically' }));
  const about = parts.length
    ? t({ zh: `（${parts.join('，')}）`, en: ` (${parts.join('; ')})` })
    : '';
  const lines = [`- ${p.id} ${oneLine(p.title, 120)}${about}`];
  const dropped = run?.status === 'dropped' ? conclusionOf(run.discussion) : null;
  if (dropped) {
    const reason = oneLine(dropped.summary, 300);
    lines.push(
      `  ${t({ zh: '需求评估结论为不做，理由', en: 'The assessment dropped it; reason' })}${colon()}${reason}`,
    );
  }
  if (run?.status === 'failed' && run.error) {
    lines.push(
      `  ${t({ zh: '失败原因', en: 'Why it failed' })}${colon()}${oneLine(run.error, 300)}`,
    );
  }
  return `${lines.join('\n')}${nextStepsLines(p.what)}`;
}

/**
 * The repo's local proposals (backlog.repos), so the scout does not propose them again: those
 * waiting for a human, those accepted with the Run each became (`runOf`, undefined when it is not
 * known), and the rejected ones with the human's reason, as counterexamples. Pending and accepted
 * proposals carry their next steps (see nextSteps), so that the scout proposes the next step of a
 * large capability once the one before it is done. `proposals` are newest first; every one was
 * written by a scout of the Master and decided on its dashboard, so all of them are trusted.
 */
export function localProposalDigest(
  proposals: readonly Proposal[],
  runOf?: (runId: string) => ProposalRun | undefined,
): string {
  const of = (status: Proposal['status']) => proposals.filter((p) => p.status === status);
  const pending = of('pending').map(
    (p) => `- ${p.id} ${oneLine(p.title, 120)}${nextStepsLines(p.what)}`,
  );
  const accepted = of('accepted').map((p) =>
    acceptedProposalLine(p, p.runId ? runOf?.(p.runId) : undefined),
  );
  const rejected = of('rejected').map((p) => {
    const reason = p.rejectReason?.trim();
    const why = reason
      ? `\n  ${t({ zh: '理由', en: 'Reason' })}${colon()}${oneLine(reason, 300)}`
      : '';
    return `- ${p.id} ${oneLine(p.title, 120)}${why}`;
  });
  return [
    digestSection(
      t({ zh: '### 等人决定', en: '### Waiting for a human' }),
      pending,
      MAX_LOCAL_PENDING,
    ),
    digestSection(t({ zh: '### 已采纳', en: '### Accepted' }), accepted, MAX_LOCAL_ACCEPTED),
    digestSection(t({ zh: '### 被拒绝', en: '### Rejected' }), rejected, MAX_LOCAL_REJECTED),
  ].join('\n\n');
}

/**
 * The goal of a Run created from a local proposal: its title, then why, the evidence, what to do
 * and the acceptance criteria, as the issue of a proposal reads (`proposalSections`).
 */
export function proposalGoal(
  p: Pick<Proposal, 'title' | 'why' | 'evidence' | 'what' | 'acceptance'>,
): string {
  return `${p.title}\n\n${proposalSections(p)}`;
}

/** Proposals a human still has to look at. */
export function untriaged(open: GhIssue[]): GhIssue[] {
  const decided: string[] = [LABELS.ready, LABELS.running, LABELS.needsYou, LABELS.failed];
  return open.filter(
    (i) => i.labels.includes(LABELS.proposal) && !i.labels.some((l) => decided.includes(l)),
  );
}

/** The scout that filed an issue, and the proposal (the stored object) the issue came from. */
export function filedProposal<S extends Pick<Scout, 'proposals'>>(
  scouts: S[],
  issue: number,
): { scout: S; proposal: ScoutProposal } | null {
  for (const scout of scouts) {
    const proposal = scout.proposals.find((p) => p.issue?.number === issue);
    if (proposal) return { scout, proposal };
  }
  return null;
}

/**
 * Untriaged proposals that hold the automatic scout back once there are `max_proposals` of them,
 * by `holdsScout`: an issue without a scout record is of an unknown kind.
 */
export function proposalsHoldingScout(
  open: GhIssue[],
  scouts: Pick<Scout, 'proposals'>[],
  limits: AutoAcceptLimits,
): GhIssue[] {
  return untriaged(open).filter((issue) =>
    holdsScout(filedProposal(scouts, issue.number)?.proposal ?? null, limits),
  );
}

/**
 * Where a repo's requirements are, as the scout's prompt says it: GitHub issues, or the local
 * backlog of a repo without GitHub (backlog.repos), where proposals stay in the Master and are
 * accepted on the dashboard.
 */
export type ScoutSource = 'github' | 'local';

interface ScoutPromptInput {
  repoName: string;
  /** Where proposals go and the requirements there are come from; github when omitted. */
  source?: ScoutSource;
  max: number;
  runs: string;
  /** The requirements there are: `issueDigest` on GitHub, `localProposalDigest` otherwise. */
  issues: string;
  /**
   * Whether the repo's template splits an L requirement into steps done in one Run
   * (`templateSplits`). Then a capability one Run finishes that way is one proposal of size L,
   * not several issues; without it, large capabilities are split into issues as before.
   */
  splits: boolean;
  /** Whether size L proposals within `max_risk` are accepted without a human (`autoAcceptsL`). */
  autoAcceptsL: boolean;
  /**
   * The Master's last failed upgrade, given only to the scout of the Master's own repo while no
   * upgrade has succeeded since.
   */
  upgrade?: UpgradeFailure | null;
}

export function scoutPrompt(input: ScoutPromptInput): string {
  return t({ zh: scoutPromptZh, en: scoutPromptEn })(input, input.source ?? 'github');
}

/** `text` as a Markdown code block, fenced with more backticks than any run of them inside. */
function codeBlock(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

/**
 * The section on the Master's failed upgrade, followed by a blank line; empty without one. The
 * proposals may go to GitHub, so paths under the home directory are left out of what the script
 * recorded, as they are from everything the Master publishes. A failure of the environment (no
 * node or npm) says nothing about the code and is retried by the Master, so the scout is told not
 * to spend a proposal on it rather than to put fixing it first.
 */
function upgradeSection(failure: UpgradeFailure | null | undefined, source: ScoutSource): string {
  if (!failure) return '';
  const unknown = t({ zh: '（不知道是哪个）', en: '(unknown)' });
  const to = failure.to || unknown;
  const toShort = failure.to ? failure.to.slice(0, 7) : unknown;
  const from = failure.from ? failure.from.slice(0, 7) : unknown;
  const date = failure.at.slice(0, 10);
  const message = oneLine(redactForGitHub(failure.message), 300);
  const output = failure.detail
    ? `${t({ zh: '- 输出末尾：', en: '- End of the output:' })}\n${codeBlock(redactForGitHub(failure.detail))}`
    : t({ zh: '- 输出末尾：没有记下。', en: '- End of the output: not recorded.' });
  const title = failure.env
    ? t({
        zh: '## Master 自动升级因运行环境失败',
        en: "## The Master's automatic upgrade failed because of the environment",
      })
    : t({ zh: '## Master 自动升级失败', en: "## The Master's automatic upgrade failed" });
  const facts = t({
    zh: `${brandName()}的 Master 就是从这个仓库构建的：它运行在这个仓库的一份克隆（稳定副本）里，目标分支有新提交时自动升级（\`npm ci\`、\`npm run build\`，再启动新版本，检查它能否响应，并观察几分钟，看它会不会出错退出）。${date} 它尝试升级到目标分支上的提交 ${to}，失败了，已回退到 ${from} 继续运行。
- 失败消息：${message}
${output}`,
    en: `The Master of ${brandName()} is built from this repo: it runs in a clone of it (the stable copy) and upgrades itself when the target branch gets new commits (\`npm ci\`, \`npm run build\`, then it starts the new version, checks that it responds and watches it for a few minutes in case it exits with an error). On ${date} it tried to upgrade to commit ${to} on the target branch and failed; it rolled back to ${from} and keeps running that.
- Failure message: ${message}
${output}`,
  });
  const advice = failure.env ? envFailureAdvice(source) : codeFailureAdvice(toShort, source);
  return `${title}\n${facts}\n\n${advice}\n\n`;
}

/** What the scout does about an upgrade that failed for the environment, not for the code. */
function envFailureAdvice(source: ScoutSource): string {
  const covered = t({
    zh: source === 'local' ? '已有的提案已经覆盖时' : '已有的 issue 已经覆盖时',
    en: source === 'local' ? 'an existing proposal' : 'an existing issue',
  });
  return t({
    zh: `这次失败出在运行环境（比如稳定副本所在的机器上找不到能用的 node 或 npm），和这个提交的代码无关。Master 不会把这个提交记成失败过，会等一段时间后自己再试，环境好了升级就会成功。所以不要为此提代码修复，也不要把它排在上面的线索前面。
- 只有输出表明仓库里的脚本（比如 \`scripts/find-node.sh\`、\`scripts/self-upgrade.sh\`）本身有缺陷时，比如机器上明明装着合适的 node 却没有找到，才提修复：先核对问题在现在的代码里是否还在，${covered}不要重复提。`,
    en: `This failure is the environment's (for example, no usable node or npm on the machine of the stable copy), not the code's in that commit. The Master does not count the commit as failed: it waits a while and tries again by itself, and the upgrade succeeds once the environment is fixed. So do not propose a code fix for it, and do not put it before the leads above.
- Propose a fix only if the output shows a defect in a script of the repo itself (such as \`scripts/find-node.sh\` or \`scripts/self-upgrade.sh\`), for example that it missed a suitable node installed on the machine: check first whether the problem is still in the code as it is now, and do not propose it again if ${covered} covers it.`,
  });
}

/** What the scout does about an upgrade that failed for any other reason: fix it first. */
function codeFailureAdvice(toShort: string, source: ScoutSource): string {
  const existing = t({
    zh: source === 'local' ? '已有的提案里' : '已有的 issue 里',
    en: source === 'local' ? 'the existing proposals' : 'the existing issues',
  });
  return t({
    zh: `这很可能说明目标分支上的代码在稳定副本里无法构建、启动，或者启动后不久就出错退出。修好之前，每次升级都会失败，Master 一直停在旧版本上，系统的自我进化也就停了，所以修复它是最高优先级，排在上面所有线索之前：根据上面的输出和代码找出原因，把修复作为第一条提案，在证据里写上失败的提交和输出中的关键行。
- 如果输出表明是网络、npm 源、磁盘空间这类环境问题，而不是代码的问题，就不要硬提代码修复。
- 你读到的目标分支可能已经比 ${toShort} 新：先核对问题在现在的代码里是否还在，已经修好的不要再提。
- ${existing}已经有针对这个失败的修复时，不要重复提。`,
    en: `Most likely the code on the target branch cannot be built or started in the stable copy, or exits with an error soon after it starts. Until that is fixed, every upgrade fails, the Master stays on the old version, and the system stops evolving, so fixing it comes first, before all the leads above: find the cause from the output and the code, make the fix your first proposal, and cite the failed commit and the key lines of the output in its evidence.
- If the output shows a problem of the environment, such as the network, the npm registry or disk space, rather than of the code, do not force a code fix.
- The target branch you read may be newer than ${toShort}: check first whether the problem is still in the code as it is now, and do not propose a fix for one already fixed.
- Do not propose a fix again if one for this failure is among ${existing}.`,
  });
}

/**
 * The Master's failed upgrade among the problems that stop the system, when its section below
 * asks to fix it first; a failure of the environment is retried by the Master and is no such lead.
 */
function upgradeLead(failure: UpgradeFailure | null | undefined): string {
  if (!failure || failure.env) return '';
  return t({
    zh: '，以及下面的「Master 自动升级失败」',
    en: ", and the Master's failed upgrade below",
  });
}

/** A part of a Run's time, named as the dashboard and the Run summaries name it. */
const part = (p: RunTimePart) => runTimePartLabels()[p];

/** Whether size L proposals are accepted automatically or wait for a human, as one sentence. */
function autoAcceptLNote(autoAcceptsL: boolean): string {
  return autoAcceptsL
    ? t({
        zh: '风险在自动采纳范围内的 L 提案也会被自动采纳。',
        en: 'Proposals of size L are accepted automatically too when their risk is within what auto-accept takes.',
      })
    : t({
        zh: 'L 的提案不会被自动采纳，要等人处理。',
        en: 'Proposals of size L are not accepted automatically: they wait for a human.',
      });
}

/** What makes a step of a large capability worth an issue of its own. */
function stepRule(): string {
  return t({
    zh: '每一步都能单独合并，合并后系统照常可用，并且实际推进了这个能力，不能只是空壳（比如只加了配置项、类型或接口，却没有实际行为）。',
    en: 'Each step must be mergeable on its own, leave the system working as usual once merged, and actually advance the capability, not be an empty shell (for example a config option, a type or an interface without any real behavior).',
  });
}

/**
 * The start of the section on splitting a large capability: whether the repo's template splits
 * an L requirement in one Run, whether L is accepted automatically, and when to split a capability
 * into several issues. A template that splits finishes in one Run what would otherwise take
 * several issues, each with its own assessment, review, merge and upgrade, so a capability is
 * split into issues only when one Run cannot finish it or its first steps are worth merging alone.
 */
function splitIntro(input: ScoutPromptInput): string {
  const note = autoAcceptLNote(input.autoAcceptsL);
  const source = input.source ?? 'github';
  if (input.splits) {
    const items = severalItems(source);
    const extra = t({
      zh: source === 'local' ? '每多一条提案' : '每多一个 issue',
      en: source === 'local' ? 'every extra proposal' : 'every extra issue',
    });
    return t({
      zh: `这个仓库用的模板能拆分大需求：size 为 L 的需求，在编码阶段会先拆成几步，再一步一步做、一步一步检查，一个 Run 就能做完。${note}
- 一个能力一个 Run 拆成几步能做完的，作为一条提案，size 标 L，不要拆成${items}：${extra}，就多一轮评估、评审、合并和升级。
- 只有一个 Run 拆了也做不完，或者前面几步单独合并就有价值时，才把它拆成有先后的${items}。${stepRule()}这次只提第一步，第一步也可以是 L。`,
      en: `The template this repo uses can split large requirements: a requirement of size L is first split into steps in the coding stage, then done and checked step by step, all in one Run. ${note}
- When one Run can finish a capability by splitting it into steps, make it one proposal of size L; do not split it into several ${items}: ${extra} costs another round of assessment, review, merge and upgrade.
- Only when one Run cannot finish it even split up, or when its first steps are worth merging on their own, split it into several ${items} in order. ${stepRule()} Propose only the first step now; it may be of size L too.`,
    });
  }
  return t({
    zh: `这个仓库用的模板不拆分需求：每条需求都整个交给一个 Run 一次做完。${note}
一个能力一个 Run 做不完时，把它拆成有先后的几步。${stepRule()}
- 这次只提第一步，size 尽量是 S 或 M。`,
    en: `The template this repo uses does not split requirements: each one goes to one Run as a whole, done in one go. ${note}
When a capability is too much for one Run, split it into steps in order. ${stepRule()}
- Propose only the first step now, preferably of size S or M.`,
  });
}

/**
 * 「几个 issue」, what a large capability is split into when one Run cannot finish it: issues, or
 * proposals of the local backlog. In English the plural noun alone.
 */
function severalItems(source: ScoutSource): string {
  return t({
    zh: source === 'local' ? '几条提案' : '几个 issue',
    en: source === 'local' ? 'proposals' : 'issues',
  });
}

/** The requirement on how large a proposal is, by whether the repo's template splits. */
function sizeRequirement(splits: boolean, source: ScoutSource): string {
  const items = severalItems(source);
  return splits
    ? t({
        zh: `每条要能独立完成、独立合并，一个 Run 能做完。一个 Run 拆成几步能做完的能力，作为一条提案、size 标 L，不要拆成${items}；什么时候才拆成${items}，见上面「拆一个大能力」。`,
        en: `Each proposal must be doable and mergeable on its own, within one Run. A capability one Run can finish by splitting it into steps is one proposal of size L, not several ${items}; when to split it into ${items} anyway is described in "Splitting a large capability".`,
      })
    : t({
        zh: '每条要能独立完成、独立合并，一个 Run 能做完。太大的按上面「拆一个大能力」的做法拆开，只提第一步；那样也拆不开的，才把 size 标为 L。',
        en: 'Each proposal must be doable and mergeable on its own, within one Run. Split anything too large as described in "Splitting a large capability" and propose only its first step; only if it cannot be split even that way, set its size to L.',
      });
}

// The parts of the prompt that depend on where the repo's requirements are (`ScoutSource`): on
// GitHub, proposals become issues and the requirements there are are issues, open or closed; in
// the local backlog, proposals stay in the Master, waiting for a human, accepted or rejected.

/** What becomes of a proposal. */
function proposalFate(source: ScoutSource): string {
  return source === 'local'
    ? t({
        zh: '提案会存进 Master 的本地提案池，在看板上被采纳（或按自动采纳的设置采纳）后由 Agent 按「编码 → 评审 → 合并」完成。',
        en: `Each proposal goes into the Master's local backlog; once accepted on the dashboard (or under the auto-accept setting), agents carry it out through "code → review → merge".`,
      })
    : t({
        zh: '提案会成为 GitHub issue，被采纳后由 Agent 按「编码 → 评审 → 合并」完成。',
        en: 'Each proposal becomes a GitHub issue; once accepted, agents carry it out through "code → review → merge".',
      });
}

/** That gaps some requirement already works on are listed too. */
function coveredGapsText(source: ScoutSource): string {
  return source === 'local'
    ? t({
        zh: '已经有提案在做的缺口也照样列出。',
        en: 'List gaps that existing proposals already work on as well.',
      })
    : t({
        zh: '已经有 issue 在做的缺口也照样列出。',
        en: 'List gaps that existing issues already work on as well.',
      });
}

/** What a review suggestion is checked against besides the code, within lead 4. */
function coveredCheck(source: ScoutSource): string {
  return source === 'local'
    ? t({ zh: '是否已经有提案覆盖', en: 'that no existing proposal covers it' })
    : t({ zh: '是否已经有 issue 覆盖', en: 'that no existing issue covers it' });
}

/** What to do about a gap some requirement already works on, in the mix of proposals. */
function takenGapText(source: ScoutSource): string {
  return source === 'local'
    ? t({
        zh: '缺口已经有提案在做（还在等人决定，或已采纳、Run 还没完成）时，换一个缺口；只有那条提案覆盖面很大、还在等人决定时，才提它能独立合并的第一步（见下面「拆一个大能力」里等人决定的大提案那一条）。',
        en: 'When a proposal already works on a gap (still waiting for a human, or accepted with its Run not completed yet), take another gap; only when that proposal covers a lot and is still waiting for a human, propose a first step of it that can be merged on its own (see the point on large proposals waiting for a human in "Splitting a large capability" below).',
      })
    : t({
        zh: '缺口已经有未关闭的 issue 在做时，换一个缺口；只有那个 issue 覆盖面很大、还在等人采纳时，才提它能独立合并的第一步（见下面「拆一个大能力」里等人采纳的大 issue 那一条）。',
        en: 'When an open issue already works on a gap, take another gap; only when that issue covers a lot and is still waiting for a human to accept it, propose a first step of it that can be merged on its own (see the point on large issues waiting for a human in "Splitting a large capability" below).',
      });
}

/** Going on with the next step of a requirement whose step was merged, and not before. */
function followUpText(source: ScoutSource): string {
  return source === 'local'
    ? t({
        zh: '- 下面已有的本地提案里，列着「后续步骤」、而且已采纳、Run 已完成（前一步已经合并）的，优先考虑提它的下一步：在 why 里写明接着哪条提案（写上它的 id），what 末尾的「后续步骤」只列还剩下的步骤。列着「后续步骤」、但还在等人决定或 Run 还没完成的提案，说明这一步还没合并，不要提它后面的步骤。',
        en: '- Among the existing local proposals below, when a proposal lists "Next steps", was accepted and its Run completed (its step was merged), consider its next step first: say in why which proposal it follows (with its id), and list only the steps still left under "Next steps" at the end of what. A proposal listing "Next steps" that still waits for a human, or whose Run has not completed, has its step not merged yet: do not propose the steps after it.',
      })
    : t({
        zh: '- 下面已有的 issue 里，列着「后续步骤」、而且已完成（前一步已经合并）的，优先考虑提它的下一步：在 why 里写明接着哪条 issue，what 末尾的「后续步骤」只列还剩下的步骤。已经拆好、列着「后续步骤」但还没关闭的 issue，说明这一步正在做、还没合并，不要提它后面的步骤。',
        en: '- Among the existing issues below, when an issue lists "Next steps" and is done (its step was merged), consider its next step first: say in why which issue it follows, and list only the steps still left under "Next steps" at the end of what. An issue already split up, listing "Next steps" and still open, has its step in progress and not merged yet: do not propose the steps after it.',
      });
}

/** Proposing the first step of a large requirement still waiting for a human. */
function largeWaitingText(source: ScoutSource): string {
  return source === 'local'
    ? t({
        zh: '- 这和还在等人决定的大提案不同：已有的提案覆盖的能力太大、没有拆过、一直在等人决定的，可以提它能独立合并的第一步，在 why 里注明对应哪条提案（写上它的 id），这不算重复。',
        en: '- A large proposal still waiting for a human is different: when an existing proposal covers a capability too large to have been taken up, was never split, and still waits for a human, you may propose a first step of it that can be merged on its own, saying in why which proposal it belongs to (with its id); that is not a duplicate.',
      })
    : t({
        zh: '- 这和还在等人采纳的大 issue 不同：已有的 issue 覆盖的能力太大、没有拆过、一直没人做的（比如还在等人采纳的大提案），可以提它能独立合并的第一步，在 why 里注明对应哪条 issue，这不算重复。',
        en: '- A large issue still waiting for a human is different: when an existing issue covers a capability too large to have been taken up, was never split, and nobody has worked on it (such as a large proposal still waiting for a human), you may propose a first step of it that can be merged on its own, saying in why which issue it belongs to; that is not a duplicate.',
      });
}

/** Not proposing what there is already, and the rejections as counterexamples. */
function duplicatesText(source: ScoutSource): string {
  return source === 'local'
    ? t({
        zh: '- 不要和下面已有的本地提案重复，包括已采纳的和被拒绝的。被拒绝的提案是反例，注意其中的理由，不要换个说法再提；已采纳、但需求评估结论为不做的，也一样。',
        en: '- Do not duplicate the existing local proposals below, including accepted and rejected ones. Rejected proposals are counterexamples: note their reasons and do not propose them again in other words; the same goes for accepted ones the requirement assessment dropped.',
      })
    : t({
        zh: '- 不要和下面已有的 issue 重复，包括已关闭的。被关闭为「不做」的 issue 是反例，注意其中的理由，不要换个说法再提。',
        en: '- Do not duplicate the existing issues below, including closed ones. Issues closed as not planned are counterexamples: note their reasons and do not propose them again in other words.',
      });
}

/** Requirements whose Runs failed: no human turned them down. */
function failedRequirementsText(source: ScoutSource): string {
  return source === 'local'
    ? t({
        zh: '- 已采纳、但 Run 失败了的提案不一样：它不是人拒绝的，需求本身可能仍然需要。可以根据其中的失败原因换个思路重新提案（比如拆小、先补上缺的能力、换一种做法），在 why 里说明和上次的不同；不要原样再提。',
        en: '- Accepted proposals whose Run failed are different: no human rejected them, and the requirement may well still be wanted. You may propose them again with another approach based on the failure (e.g. split them up, first add a missing capability, do it another way), saying in why what is different this time; do not propose them again as they were.',
      })
    : t({
        zh: '- 「多次失败后关闭」的 issue 不一样：它不是人拒绝的，而是 Run 尝试了几次都失败了，需求本身可能仍然需要。可以根据其中的失败原因换个思路重新提案（比如拆小、先补上缺的能力、换一种做法），在 why 里说明和上次的不同；不要原样再提。',
        en: '- Issues "closed after repeated failures" are different: no human rejected them; their Runs failed attempt after attempt, and the requirement may well still be wanted. You may propose them again with another approach based on the failures (e.g. split them up, first add a missing capability, do it another way), saying in why what is different this time; do not propose them again as they were.',
      });
}

/** The heading of the requirements there are. */
function existingHeading(source: ScoutSource): string {
  return source === 'local'
    ? t({ zh: '## 已有的本地提案', en: '## Existing local proposals' })
    : t({ zh: '## 已有的 issue', en: '## Existing issues' });
}

const scoutPromptZh = (input: ScoutPromptInput, source: ScoutSource) =>
  `你是${brandName()}的「侦察」：为仓库 ${input.repoName} 找出接下来最值得做的事，写成需求提案。${proposalFate(source)}你只能读代码和文档，不能修改任何文件。

## 先弄清方向
- 读 README.md 和 AGENTS.md（有 CLAUDE.md 的也读）。README.md 写着项目的目标，是一切决定的依据；AGENTS.md 写着目录结构、命令和约定。
- 提案要服务于 README.md 里的目标，不提和目标无关或背离目标的事。

## 先做差距分析
提案之前，先按 README.md 的原文列出它写的目标（只用来对照，不写进结果），再对照其中的每个目标，在能力层面列出这个项目现在还做不到什么，写进结果的 gaps。要看的是缺了哪些能力，不是零碎的缺陷：比如能对接哪些外部工具和服务、能做多大的任务、能不能并行、能服务什么样的用户、场景和需求来源、出了问题能不能自己恢复。代码里定义了却没有实现的选项、只支持一种情况的地方、写死的上限，往往就是缺口。
- 每个缺口写明：goal 是上面列出的哪个目标，一字不差地照抄 README.md 里这个目标的原文，同一个目标在每个缺口里写法相同；gap 是缺什么能力，evidence 是限制这个能力的代码位置（文件:行号）或 README、文档里的段落。
- 最重要的缺口放在最前：越是挡住目标、越多事情依赖它，越重要。${coveredGapsText(source)}
- 认真对照每个目标后仍然找不到缺口，gaps 才是空列表。

## 线索（按优先级从高到低）
1. 让系统停转或空耗的问题：下面附的最近 Run 里卡住、失败、反复返工、评审反复提同类意见、费用或 Agent 执行用时异常的${upgradeLead(input.upgrade)}。用时里「${part('stoppedMs')}」「${part('approvalMs')}」「${part('blockedMs')}」「${part('pausedMs')}」的部分是在等人处理，「${part('queuedMs')}」的部分是在等别的 Run 做完（也包括等升级、Master 没运行的时候），「${part('conflictWaitMs')}」和排队一样是在等别的 Run（避开和它改同一处的 Run，免得合并时冲突），都不说明 Agent 慢。摘要开头写着当时的 concurrency.per_repo 和有几个 Run 并行执行过：per_repo 为 1、排队时间远多于 Agent 执行时间、并行带来的错开等待和「并行时合并冲突」又很少时，可以建议人调大 per_repo，并写明依据。per_repo 由用户在自己数据目录的 config.yaml 里设置，不在仓库里：侦察只提建议，不改用户的配置。需求评估提了疑问、需求在讨论后改过或结论为不做，说明这条需求没写清楚或方向有偏差：留意其中的疑问和理由，新提案不要再犯。
2. 差距分析里最重要的能力缺口。
3. 明显的缺陷和测试缺口，README.md、AGENTS.md 和代码不一致的地方，代码里的 TODO。
4. 评审建议和对最近改动的修饰：评审通过时给的建议是评审有意留到以后的改进（超出当时目标范围的缺陷、测试缺口、重复代码等），对最近合并的改动还能再修一修的地方也归在这一类。要先到代码里核对它是否仍然存在、${coveredCheck(source)}；相关的几条合成一条提案，不要一条建议提一条。

## 提案的配比
- 第 1 类问题优先：有就先提；条数上限放不下时，以第 1 类为先。
- 第 1 类之外，只要差距分析里有缺口，至少有一条提案是补能力的：category 为 feature，补上差距分析里的一个缺口，推进 README.md 的某个目标，而不是对最近改动的修补。${takenGapText(source)}
- 第 4 类每次最多一条。

## 拆一个大能力
${splitIntro(input)}
- what 的末尾单独起一行写「后续步骤：」（不要写成标题），下面按顺序列出剩下的几步，每步一句话，以后的侦察从这里接着往下提。
${followUpText(source)}
${largeWaitingText(source)}

## 要求
- 最多 ${input.max} 条，宁缺毋滥；没有值得做的就返回空列表。按上面的优先级和配比排列，同一类里价值高的在前。
- 每条都要有能核对的证据：Run id、文件:行号、README 或 AGENTS.md 中的段落。补能力的提案不需要有出错的 Run：README.md 里的目标加上限制这个能力的代码位置就是证据。拿不出证据的不要提。
${duplicatesText(source)}
${failedRequirementsText(source)}
- ${sizeRequirement(input.splits, source)}
- risk 的含义：
  - low：只涉及文档、测试、看板展示，或不改变行为的重构；
  - mid：改变行为，但影响范围清楚；
  - high：涉及数据库迁移、合并或回滚等 git 操作、Agent 权限、配置格式、对外发布，或者改动 .ares1/ 下的文件（仓库自己的开发流程）。
- 用中文写。不要写本机的绝对路径，也不要写任何个人信息。

${upgradeSection(input.upgrade, source)}## 最近的 Run
${input.runs}

${existingHeading(source)}
${input.issues}
`;

const scoutPromptEn = (input: ScoutPromptInput, source: ScoutSource) =>
  `You are the scout of ${brandName()}: find what is most worth doing next in the repo ${input.repoName} and write it up as proposals. ${proposalFate(source)} You may only read code and documents; you must not change any file.

## First, get the direction
- Read README.md and AGENTS.md (and CLAUDE.md if there is one). README.md states the project's goals and is the basis for every decision. AGENTS.md describes the layout, commands and conventions.
- Proposals must serve the goals in README.md; do not propose anything unrelated to them or against them.

## First, a gap analysis
Before proposing anything, list the goals README.md states, in its own words (only to go by, not part of your answer); then go through each of them and list, as capabilities, what the project cannot do yet; put them in the gaps of your answer. Look for missing capabilities, not scattered bugs: for example which outside tools and services it can work with, how large a task it can take on, whether it can do things in parallel, what users, situations and sources of requirements it can serve, and whether it can recover by itself when something goes wrong. Options defined in the code but never implemented, places that support only one case, and hard-coded limits are often gaps.
- For each gap, give goal: one of the goals you listed, copied word for word as README.md writes it, and written the same way in every gap of that goal; gap: the missing capability; evidence: where the code limits this capability (file:line), or passages of README or other documents.
- Put the most important gaps first: the more a gap stands in the way of a goal and the more depends on it, the more important it is. ${coveredGapsText(source)}
- Leave gaps empty only if you find none after carefully going through every goal.

## Leads (highest priority first)
1. Problems that stop the system or make it spin without progress: Runs below that got stuck, failed, needed rework again and again, drew the same kind of review comments again and again, or took unusual cost or agent time${upgradeLead(input.upgrade)}. In the times, "${part('stoppedMs')}", "${part('approvalMs')}", "${part('blockedMs')}" and "${part('pausedMs')}" are time spent waiting for a human; "${part('queuedMs')}" is time spent waiting for other Runs to finish (including while an upgrade is pending or the Master is not running), and "${part('conflictWaitMs')}" is waiting for another Run just like the queue (keeping clear of a Run that changes the same place, so that the two do not conflict at the merge): none of these mean the agents were slow. The digest of the Runs opens with concurrency.per_repo at the time and how many Runs executed side by side: when per_repo is 1, the Runs spent far more time queued than executing, and working side by side brought few waits for overlapping Runs and few merge conflicts, you may suggest that a human raise per_repo, giving your grounds. per_repo is set by the user in config.yaml in their own data directory, not in the repo: the scout only suggests it and does not change the user's configuration. When the requirement assessment asked questions, the requirement was revised in the discussion, or the conclusion was to drop it, the requirement was unclear or off course: note the questions and reasons, and do not repeat those mistakes in new proposals.
2. The most important capability gaps from your gap analysis.
3. Obvious bugs and gaps in tests, places where README.md, AGENTS.md and the code disagree, TODOs in the code.
4. Review suggestions and polish of recent changes: the suggestions given by a review that passed are improvements the reviewer left for later on purpose (bugs beyond the goal of the time, gaps in tests, duplicated code and the like), and whatever could still be touched up in recently merged changes belongs here too. First check in the code that each one is still there and ${coveredCheck(source)}; merge related ones into one proposal rather than proposing each suggestion on its own.

## Mix of proposals
- Problems of lead 1 come first: propose them before anything else, and when the limit leaves no room for more, they take it.
- Besides lead 1, as long as your gap analysis found a gap, at least one proposal must add a capability: category feature, closing a gap from your gap analysis and advancing a goal of README.md, not patching a recent change. ${takenGapText(source)}
- At most one proposal from lead 4 per scout.

## Splitting a large capability
${splitIntro(input)}
- End what with a line of its own reading "Next steps:" (not a heading), followed by the remaining steps in order, one sentence each, for later scouts to go on from.
${followUpText(source)}
${largeWaitingText(source)}

## Requirements
- At most ${input.max}, and only ones that are worth it; return an empty list if nothing is. Order them by the priorities and the mix above, the more valuable first within each lead.
- Every proposal needs verifiable evidence: Run ids, file:line, passages of README or AGENTS.md. A proposal that adds a capability needs no failed Run: a goal in README.md together with where the code limits the capability is evidence. Do not propose anything you cannot back with evidence.
${duplicatesText(source)}
${failedRequirementsText(source)}
- ${sizeRequirement(input.splits, source)}
- What risk means:
  - low: only documentation, tests, how the dashboard shows things, or refactoring without behavior change;
  - mid: changes behavior, with a clear scope;
  - high: database migrations, git operations such as merging or rollback, agent permissions, the configuration format, publishing anything outside, or changes to files under .ares1/ (the repo's own development workflow).
- Write in English. Do not write absolute paths of this machine or any personal information.

${upgradeSection(input.upgrade, source)}## Recent Runs
${input.runs}

${existingHeading(source)}
${input.issues}
`;
