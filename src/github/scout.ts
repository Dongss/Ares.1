// What the AI scout is asked and what it answers.

import { z } from 'zod';
import { brandName } from '../brand.js';
import { isAutoAcceptable, PROPOSAL_SIZES, RISKS, type Risk } from '../config/flow.js';
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
import {
  minutes,
  type RunTimePart,
  type RunTimes,
  runTimePartLabels,
  runTimeParts,
  storedRunTimes,
  timeParts,
} from '../engine/times.js';
import { join, t } from '../i18n.js';
import type { Store } from '../store/store.js';
import type {
  Attempt,
  CheckResult,
  EventRow,
  Run,
  Scout,
  ScoutProposal,
  StageRun,
} from '../store/types.js';
import type { UpgradeFailure } from '../upgrade/upgrader.js';
import type { GhAuthored, GhIssue } from './client.js';
import { isRetriesExhaustedComment, isTrusted, LABELS, stripMarker } from './issues.js';
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

export const ScoutReportSchema = z.object({ proposals: z.array(ProposalSchema) });

/** JSON schema of the scout's answer, its descriptions in the language in use. */
export function scoutReportJsonSchema() {
  return {
    type: 'object',
    required: ['proposals'],
    additionalProperties: false,
    properties: {
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
              description: t({
                zh: 'S：一小时内；M：半天内；L：更大',
                en: 'S: within an hour; M: within half a day; L: larger',
              }),
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
                zh: 'Run id、文件:行号、文档中的段落等可以核对的证据',
                en: 'Verifiable evidence: Run ids, file:line, passages of documents',
              }),
            },
            what: {
              type: 'string',
              description: t({
                zh: '要做什么，写到 Agent 能直接动手的程度',
                en: 'What to do, detailed enough for an agent to start right away',
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

export function parseScoutReport(structured: unknown, finalMessage: string): ScoutProposal[] {
  const parsed = parseReport(ScoutReportSchema, structured, finalMessage);
  if (!parsed.ok) {
    throw new Error(
      t({
        zh: `侦察结果不符合约定：${parsed.error}`,
        en: `The scout's result does not follow the contract: ${parsed.error}`,
      }),
    );
  }
  return parsed.value.proposals;
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

/** Denied operations listed per stage round; more are only counted. */
const MAX_DENIED = 3;

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
 * Executions within one stage round, when some of them had to be redone: rework inside a stage
 * (failed verify commands, bad output, agent errors, quota or rate limits) never shows up in the
 * stage rounds. The operations denied in the round follow, one per line, so the scout can tell
 * what was refused.
 */
function reworkLines(
  head: string,
  attempts: Attempt[],
  failedChecks: Map<string, CheckResult[]>,
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
  const lines = [`  ${oneLine(line, 200)}`];
  const operations = [...denied];
  for (const operation of operations.slice(0, MAX_DENIED)) {
    lines.push(`    - ${t({ zh: '被拒绝：', en: 'Denied: ' })}${operation}`);
  }
  if (operations.length > MAX_DENIED) {
    lines.push(`    ${moreText(operations.length - MAX_DENIED)}`);
  }
  return lines;
}

/** 「编码第 2 轮」, a stage round as the digest names it. */
const roundName = (stageName: string, round: number) =>
  t({ zh: `${stageName}第 ${round} 轮`, en: `${stageName} round ${round}` });

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
  return `    - ${oneLine(`${where}${issue.description}`, 150)}`;
}

/**
 * Why a stage round failed. A failed review lists each must-fix issue on its own line, so a long
 * review summary cannot crowd them out; suggestions are only counted.
 */
function failLines(sr: StageRun, stageName: string, attempts: Attempt[]): string[] {
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
  if (!sr.failFeedback) return [];
  const feedback = oneLine(sr.failFeedback, 300);
  return [
    t({
      zh: `${head}${failText(sr.failReason)}：${feedback}`,
      en: `${head}: ${failText(sr.failReason)}: ${feedback}`,
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

/** Recent Runs of the repo, with what went wrong in them: the scout's best evidence. */
export function runDigest(store: Store, repoId: string, limit = 15): string {
  const runs = store.listRuns({ repoId }).slice(0, limit);
  if (runs.length === 0) return t({ zh: '（还没有 Run）', en: '(no Runs yet)' });
  return runs
    .map((run) => {
      const stageRuns = store.listStageRuns(run.id);
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
      const took = run.finishedAt ? tookText(storedRunTimes(store, run)) : '';
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
        const reason = terminationReason(store.listEvents(run.id));
        lines.push(`  ${t({ zh: '终止', en: 'Terminated' })}${colon()}${reason}`);
      }
      lines.push(...discussionLines(run));
      for (const sr of stageRuns) {
        const attempts = store.listTasks(sr.id).flatMap((task) => store.listAttempts(task.id));
        lines.push(...reworkLines(roundName(name(sr.stageId), sr.round), attempts, failedChecks));
        lines.push(...failLines(sr, name(sr.stageId), attempts));
        // Reviewers read the goal: from an untrusted one, their suggestions may carry its text.
        if (trusted && stage(sr.stageId)?.kind === 'review') {
          lines.push(...suggestionLines(sr, name(sr.stageId), attempts));
        }
      }
      return lines.join('\n');
    })
    .join('\n');
}

/**
 * Existing issues, so the scout does not propose them again; rejections are counterexamples.
 * Anybody can open an issue or comment on a public repo, so only issues and comments written by
 * people the Master trusts (`isTrusted`, the Master itself included) are listed; `master` is the
 * login the Master acts as.
 *
 * `closed` are the latest closed issues; `notPlanned` are issues closed as not planned, however
 * old. Those not among `closed` get a section of their own, so that old rejections and their
 * reasons stay in sight without crowding the recent ones.
 */
export function issueDigest(
  open: GhIssue[],
  closed: GhIssue[],
  master: string | null,
  notPlanned: GhIssue[] = [],
): string {
  const recent = new Set(closed.map((i) => i.number));
  const older = notPlanned.filter((i) => !recent.has(i.number));
  const trusted = <T extends GhAuthored>(items: T[]) => items.filter((i) => isTrusted(i, master));
  const labels = (i: GhIssue) => {
    const ours = i.labels.filter((l) => l.startsWith('ares1:'));
    return ours.length ? ` [${ours.join(', ')}]` : '';
  };
  const openLines = trusted(open).map((i) => `- #${i.number}${labels(i)} ${i.title}`);
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
  return `- #${i.number} ${t({ zh: '已完成', en: 'Done' })}${colon()}${i.title}`;
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
 * Untriaged proposals that hold the automatic scout back once there are `max_proposals` of them.
 * Without auto-accept, every one: a human decides them all. With it, only those auto-accept would
 * take but has not yet (today's count is used up), and those without a scout record, to stay
 * safe. Proposals beyond what auto-accept takes (size L, a higher risk) still wait for a human,
 * but would otherwise stop the system for good, so they do not count; the scout sees them among
 * the open issues and does not propose them again.
 */
export function proposalsHoldingScout(
  open: GhIssue[],
  scouts: Pick<Scout, 'proposals'>[],
  maxRisk: Risk | 'none',
): GhIssue[] {
  const waiting = untriaged(open);
  if (maxRisk === 'none') return waiting;
  return waiting.filter((issue) => {
    const filed = filedProposal(scouts, issue.number);
    return !filed || isAutoAcceptable(filed.proposal, maxRisk);
  });
}

interface ScoutPromptInput {
  repoName: string;
  max: number;
  runs: string;
  issues: string;
  /**
   * The Master's last failed upgrade, given only to the scout of the Master's own repo while no
   * upgrade has succeeded since.
   */
  upgrade?: UpgradeFailure | null;
}

export function scoutPrompt(input: ScoutPromptInput): string {
  return t({ zh: scoutPromptZh, en: scoutPromptEn })(input);
}

/** `text` as a Markdown code block, fenced with more backticks than any run of them inside. */
function codeBlock(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

/**
 * The section on the Master's failed upgrade, followed by a blank line; empty without one. The
 * proposals go to GitHub, so paths under the home directory are left out of what the script
 * recorded, as they are from everything the Master publishes. A failure of the environment (no
 * node or npm) says nothing about the code and is retried by the Master, so the scout is told not
 * to spend a proposal on it rather than to put fixing it first.
 */
function upgradeSection(failure: UpgradeFailure | null | undefined): string {
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
  const advice = failure.env ? envFailureAdvice() : codeFailureAdvice(toShort);
  return `${title}\n${facts}\n\n${advice}\n\n`;
}

/** What the scout does about an upgrade that failed for the environment, not for the code. */
function envFailureAdvice(): string {
  return t({
    zh: `这次失败出在运行环境（比如稳定副本所在的机器上找不到能用的 node 或 npm），和这个提交的代码无关。Master 不会把这个提交记成失败过，会等一段时间后自己再试，环境好了升级就会成功。所以不要为此提代码修复，也不要把它排在上面的线索前面。
- 只有输出表明仓库里的脚本（比如 \`scripts/find-node.sh\`、\`scripts/self-upgrade.sh\`）本身有缺陷时，比如机器上明明装着合适的 node 却没有找到，才提修复：先核对问题在现在的代码里是否还在，已有的 issue 已经覆盖时不要重复提。`,
    en: `This failure is the environment's (for example, no usable node or npm on the machine of the stable copy), not the code's in that commit. The Master does not count the commit as failed: it waits a while and tries again by itself, and the upgrade succeeds once the environment is fixed. So do not propose a code fix for it, and do not put it before the leads above.
- Propose a fix only if the output shows a defect in a script of the repo itself (such as \`scripts/find-node.sh\` or \`scripts/self-upgrade.sh\`), for example that it missed a suitable node installed on the machine: check first whether the problem is still in the code as it is now, and do not propose it again if an existing issue covers it.`,
  });
}

/** What the scout does about an upgrade that failed for any other reason: fix it first. */
function codeFailureAdvice(toShort: string): string {
  return t({
    zh: `这很可能说明目标分支上的代码在稳定副本里无法构建、启动，或者启动后不久就出错退出。修好之前，每次升级都会失败，Master 一直停在旧版本上，系统的自我进化也就停了，所以修复它是最高优先级，排在上面所有线索之前：根据上面的输出和代码找出原因，把修复作为第一条提案，在证据里写上失败的提交和输出中的关键行。
- 如果输出表明是网络、npm 源、磁盘空间这类环境问题，而不是代码的问题，就不要硬提代码修复。
- 你读到的目标分支可能已经比 ${toShort} 新：先核对问题在现在的代码里是否还在，已经修好的不要再提。
- 已有的 issue 里已经有针对这个失败的修复时，不要重复提。`,
    en: `Most likely the code on the target branch cannot be built or started in the stable copy, or exits with an error soon after it starts. Until that is fixed, every upgrade fails, the Master stays on the old version, and the system stops evolving, so fixing it comes first, before all the leads above: find the cause from the output and the code, make the fix your first proposal, and cite the failed commit and the key lines of the output in its evidence.
- If the output shows a problem of the environment, such as the network, the npm registry or disk space, rather than of the code, do not force a code fix.
- The target branch you read may be newer than ${toShort}: check first whether the problem is still in the code as it is now, and do not propose a fix for one already fixed.
- Do not propose a fix again if one for this failure is among the existing issues.`,
  });
}

/** A part of a Run's time, named as the dashboard and the Run summaries name it. */
const part = (p: RunTimePart) => runTimePartLabels()[p];

const scoutPromptZh = (input: ScoutPromptInput) =>
  `你是${brandName()}的「侦察」：为仓库 ${input.repoName} 找出接下来最值得做的事，写成需求提案。提案会成为 GitHub issue，被采纳后由 Agent 按「编码 → 评审 → 合并」完成。你只能读代码和文档，不能修改任何文件。

## 先弄清方向
- 读 README.md 和 AGENTS.md（有 CLAUDE.md 的也读）。README.md 写着项目的目标，是一切决定的依据；AGENTS.md 写着目录结构、命令和约定。
- 提案要服务于 README.md 里的目标，不提和目标无关或背离目标的事。

## 线索（按价值从高到低）
1. 下面附的最近 Run 记录：卡住、失败、返工多轮、评审反复提同类意见、费用或 Agent 执行用时异常，往往说明流程或代码有值得改进的地方。用时里「${part('approvalMs')}」「${part('blockedMs')}」「${part('pausedMs')}」的部分是在等人处理，「${part('queuedMs')}」的部分是在等别的 Run 做完（也包括停工、等升级、Master 没运行的时候），都不说明 Agent 慢。需求评估提了疑问、需求在讨论后改过或结论为不做，说明这条需求没写清楚或方向有偏差：留意其中的疑问和理由，新提案不要再犯。评审通过时给的建议是评审有意留到以后的改进（超出当时目标范围的缺陷、测试缺口、重复代码等），可以作为提案的来源，但要先到代码里核对它是否仍然存在、是否已经有 issue 覆盖。
2. README.md 里的目标还没达到的地方，README.md、AGENTS.md 和代码不一致的地方，代码里的 TODO。
3. 明显的缺陷、测试缺口、重复代码。

## 要求
- 最多 ${input.max} 条，宁缺毋滥；没有值得做的就返回空列表。按价值从高到低排列。
- 每条都要有能核对的证据：Run id、文件:行号、README 或 AGENTS.md 中的段落。拿不出证据的不要提。
- 不要和下面已有的 issue 重复，包括已关闭的。被关闭为「不做」的 issue 是反例，注意其中的理由，不要换个说法再提。
- 「多次失败后关闭」的 issue 不一样：它不是人拒绝的，而是 Run 尝试了几次都失败了，需求本身可能仍然需要。可以根据其中的失败原因换个思路重新提案（比如拆小、先补上缺的能力、换一种做法），在 why 里说明和上次的不同；不要原样再提。
- 每条要能独立完成、独立合并，一个 Run 能做完。太大的拆成几条，实在拆不开就把 size 标为 L。
- risk 的含义：
  - low：只涉及文档、测试、看板展示，或不改变行为的重构；
  - mid：改变行为，但影响范围清楚；
  - high：涉及数据库迁移、合并或回滚等 git 操作、Agent 权限、配置格式、对外发布。
- 用中文写。不要写本机的绝对路径，也不要写任何个人信息。

${upgradeSection(input.upgrade)}## 最近的 Run
${input.runs}

## 已有的 issue
${input.issues}
`;

const scoutPromptEn = (input: ScoutPromptInput) =>
  `You are the scout of ${brandName()}: find what is most worth doing next in the repo ${input.repoName} and write it up as proposals. Each proposal becomes a GitHub issue; once accepted, agents carry it out through "code → review → merge". You may only read code and documents; you must not change any file.

## First, get the direction
- Read README.md and AGENTS.md (and CLAUDE.md if there is one). README.md states the project's goals and is the basis for every decision. AGENTS.md describes the layout, commands and conventions.
- Proposals must serve the goals in README.md; do not propose anything unrelated to them or against them.

## Leads (most valuable first)
1. The recent Runs below: Runs that got stuck, failed, needed many rounds of rework, drew the same kind of review comments again and again, or took unusual cost or agent time often point at something in the process or the code worth improving. In the times, "${part('approvalMs')}", "${part('blockedMs')}" and "${part('pausedMs')}" are time spent waiting for a human, and "${part('queuedMs')}" is time spent waiting for other Runs to finish (including while work is switched off, an upgrade is pending or the Master is not running): none of these mean the agents were slow. When the requirement assessment asked questions, the requirement was revised in the discussion, or the conclusion was to drop it, the requirement was unclear or off course: note the questions and reasons, and do not repeat those mistakes in new proposals. The suggestions given by a review that passed are improvements the reviewer left for later on purpose (bugs beyond the goal of the time, gaps in tests, duplicated code and the like): they can be a source of proposals, but first check in the code that each one is still there and that no existing issue covers it.
2. Goals in README.md not reached yet, places where README.md, AGENTS.md and the code disagree, TODOs in the code.
3. Obvious bugs, gaps in tests, duplicated code.

## Requirements
- At most ${input.max}, and only ones that are worth it; return an empty list if nothing is. Order them by value, most valuable first.
- Every proposal needs verifiable evidence: Run ids, file:line, passages of README or AGENTS.md. Do not propose anything you cannot back with evidence.
- Do not duplicate the existing issues below, including closed ones. Issues closed as not planned are counterexamples: note their reasons and do not propose them again in other words.
- Issues "closed after repeated failures" are different: no human rejected them; their Runs failed attempt after attempt, and the requirement may well still be wanted. You may propose them again with another approach based on the failures (e.g. split them up, first add a missing capability, do it another way), saying in why what is different this time; do not propose them again as they were.
- Each proposal must be doable and mergeable on its own, within one Run. Split anything too large; if it really cannot be split, set its size to L.
- What risk means:
  - low: only documentation, tests, how the dashboard shows things, or refactoring without behavior change;
  - mid: changes behavior, with a clear scope;
  - high: database migrations, git operations such as merging or rollback, agent permissions, the configuration format, publishing anything outside.
- Write in English. Do not write absolute paths of this machine or any personal information.

${upgradeSection(input.upgrade)}## Recent Runs
${input.runs}

## Existing issues
${input.issues}
`;
