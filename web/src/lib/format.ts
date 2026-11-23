import { isCostUnknown } from '../../../src/api/cost.js';
import { agentEffort } from '../../../src/config/effort.js';
import type { AgentConfig } from '../../../src/config/schema.js';
import { type RunTimes, runTimeParts } from '../../../src/engine/times.js';
import { join, t } from '../../../src/i18n.js';
import type {
  Attempt,
  AttemptOutcome,
  AttemptStatus,
  Run,
  RunStatus,
  StageFailReason,
  StageRunStatus,
  TaskStatus,
} from '../../../src/store/types.js';

/** Visual tone of a status badge. */
export type Tone = 'neutral' | 'active' | 'attention' | 'success' | 'danger' | 'muted';

/** A status badge whose label is read in the language in use (a getter, not frozen at import). */
const badge = (zh: string, en: string, tone: Tone): { label: string; tone: Tone } => ({
  get label() {
    return t({ zh, en });
  },
  tone,
});

export const RUN_STATUS: Record<RunStatus, { label: string; tone: Tone }> = {
  queued: badge('排队中', 'Queued', 'neutral'),
  running: badge('执行中', 'Running', 'active'),
  waiting_approval: badge('待审批', 'Awaiting approval', 'attention'),
  blocked: badge('卡住', 'Blocked', 'danger'),
  paused: badge('已暂停', 'Paused', 'muted'),
  completed: badge('已完成', 'Completed', 'success'),
  failed: badge('失败', 'Failed', 'danger'),
  cancelled: badge('已终止', 'Cancelled', 'muted'),
  dropped: badge('不做', 'Dropped', 'muted'),
};

export const STAGE_STATUS: Record<StageRunStatus, { label: string; tone: Tone }> = {
  pending: badge('待开始', 'Not started', 'neutral'),
  executing: badge('执行中', 'Running', 'active'),
  waiting_approval: badge('待审批', 'Awaiting approval', 'attention'),
  passed: badge('通过', 'Passed', 'success'),
  failed: badge('未通过', 'Not passed', 'danger'),
};

export const TASK_STATUS: Record<TaskStatus, { label: string; tone: Tone }> = {
  pending: badge('待执行', 'Pending', 'neutral'),
  running: badge('执行中', 'Running', 'active'),
  verifying: badge('检查中', 'Checking', 'active'),
  passed: badge('通过', 'Passed', 'success'),
  failed: badge('失败', 'Failed', 'danger'),
  cancelled: badge('已终止', 'Cancelled', 'muted'),
};

export const ATTEMPT_STATUS: Record<AttemptStatus, { label: string; tone: Tone }> = {
  running: badge('执行中', 'Running', 'active'),
  completed: badge('已结束', 'Finished', 'neutral'),
  failed: badge('出错', 'Error', 'danger'),
  stopped: badge('已停止', 'Stopped', 'muted'),
  timeout: badge('超时', 'Timed out', 'danger'),
  interrupted: badge('被中断', 'Interrupted', 'muted'),
};

export const ATTEMPT_OUTCOME: Record<AttemptOutcome, { label: string; tone: Tone }> = {
  passed: badge('通过', 'Passed', 'success'),
  rework: badge('需返工', 'Needs rework', 'attention'),
  agent_error: badge('Agent 出错', 'Agent error', 'danger'),
  rate_limited: badge('额度用尽', 'Out of quota', 'attention'),
};

export { BLOCK_KIND, missingCommandText } from '../../../src/notify/notice.js';

/** Why a stage did not pass, in words (getters: read in the language in use). */
export const FAIL_REASON: Record<StageFailReason, string> = {
  get check() {
    return t({ zh: '检查没有通过', en: 'Checks did not pass' });
  },
  get review() {
    return t({ zh: '评审要求修改', en: 'Review asked for changes' });
  },
  get rejected() {
    return t({ zh: '审批被驳回', en: 'Approval rejected' });
  },
  get conflict() {
    return t({ zh: '和目标分支冲突', en: 'Conflicts with the target branch' });
  },
};

const defaultEffort = () => t({ zh: '默认 effort', en: 'default effort' });

/**
 * "claude-coder · claude-opus-5-5 · high": who ran an attempt, with which model and effort.
 * Uses the configured model until the CLI reports the one it actually uses. Attempts recorded
 * before models were tracked only show the agent.
 */
export function attemptAgentLabel(
  a: Pick<Attempt, 'agentId' | 'model' | 'actualModel' | 'effort'>,
): string {
  const model = a.actualModel ?? a.model;
  if (!model) return a.agentId;
  return [a.agentId, model, a.effort ?? defaultEffort()].join(' · ');
}

/** "claude-coder（opus · high）" ("claude-coder (opus · high)" in English) for agent pickers. */
export function agentOptionLabel(a: Pick<AgentConfig, 'id' | 'model' | 'effort' | 'args'>): string {
  const what = `${a.model} · ${agentEffort(a) ?? defaultEffort()}`;
  return t({ zh: `${a.id}（${what}）`, en: `${a.id} (${what})` });
}

export function formatCost(usd: number | null | undefined): string {
  if (!usd) return '$0';
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** Cost of one attempt: unknown when the CLI reports none and no price is configured. */
export function formatAttemptCost(attempt: Pick<Attempt, 'costUsd' | 'status'>): string {
  if (attempt.status === 'running' && attempt.costUsd === null) return '';
  return isCostUnknown(attempt) ? costUnknown() : formatCost(attempt.costUsd);
}

/** Total of a Run; when some attempts have no known cost the total is only a lower bound. */
export function formatRunCost(usd: number, unknown: boolean): string {
  if (!unknown) return formatCost(usd);
  return usd ? `${formatCost(usd)} + ${t({ zh: '未知', en: 'unknown' })}` : costUnknown();
}

const costUnknown = () => t({ zh: '费用未知', en: 'cost unknown' });

/** "15 分 3 秒" / "15m 3s". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t({ zh: `${s} 秒`, en: `${s}s` });
  const m = Math.floor(s / 60);
  if (m < 60) return t({ zh: `${m} 分 ${s % 60} 秒`, en: `${m}m ${s % 60}s` });
  const h = Math.floor(m / 60);
  return t({ zh: `${h} 小时 ${m % 60} 分`, en: `${h}h ${m % 60}m` });
}

/**
 * A configured interval in minutes, in words: "15 分钟" / "15 minutes", "6 小时" / "6 hours",
 * "1 小时 30 分钟" / "1 hour 30 minutes". Fractions are rounded to whole minutes, except below
 * one minute where the value is shown as is.
 */
export function formatMinutes(minutes: number): string {
  const minuteText = (n: number) =>
    t({ zh: `${n} 分钟`, en: `${n} ${n === 1 ? 'minute' : 'minutes'}` });
  if (minutes < 1) return minuteText(minutes);
  const total = Math.round(minutes);
  if (total < 60) return minuteText(total);
  const h = Math.floor(total / 60);
  const m = total % 60;
  const hours = t({ zh: `${h} 小时`, en: `${h} ${h === 1 ? 'hour' : 'hours'}` });
  return m === 0 ? hours : `${hours} ${minuteText(m)}`;
}

/** Duration between two ISO times; an open end means "until now". */
export function formatSpan(start: string, end: string | null, now = Date.now()): string {
  const to = end ? Date.parse(end) : now;
  return formatDuration(to - Date.parse(start));
}

/**
 * 「Agent 执行 15 分 3 秒」 for each part of a Run's time, in the same order as the scout's digest
 * (`runTimeParts`). Parts that would show as 「0 秒」 are left out: a Run is queued for a few
 * milliseconds whenever it is created or requeued.
 */
export function runTimePartTexts(times: RunTimes): string[] {
  return runTimeParts(times)
    .filter(([, ms]) => Math.round(ms / 1000) > 0)
    .map(([label, ms]) => `${label} ${formatDuration(ms)}`);
}

/**
 * 「15 小时 51 分（Agent 执行 15 分 3 秒、等审批 14 小时 30 分）」: a Run's time from creation to
 * finish, or until now while it goes on, and what it was spent on. While the Run goes on only
 * the parts that ended are listed.
 */
export function formatRunTime(
  run: Pick<Run, 'createdAt' | 'finishedAt'>,
  times: RunTimes,
  now = Date.now(),
): string {
  const total = formatSpan(run.createdAt, run.finishedAt, now);
  const parts = runTimePartTexts(times);
  if (parts.length === 0) return total;
  return t({ zh: `${total}（${join(parts)}）`, en: `${total} (${join(parts)})` });
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "14:03:21" today, "11-17 14:03" otherwise (local time). */
export function formatTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** A size in bytes: "512 B", "3.4 KB", "12.5 MB", "1.20 GB" (powers of 1024). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 8) : '';
}

/** First line of a goal, for lists. */
export function goalTitle(goal: string, max = 80): string {
  const line = goal.trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Split a textarea into commands: one per line, blank lines dropped. */
export function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
/** ANSI escape sequences (colors, cursor moves, OSC links) that some tools print even when piped. */
const ANSI = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}`,
  'g',
);

/** Remove terminal control sequences; for "\r"-rewritten lines keep only what was shown last. */
export function stripAnsi(line: string): string {
  const visible = line.replace(ANSI, '');
  const cr = visible.replace(/\r+$/, '').lastIndexOf('\r');
  return cr >= 0 ? visible.slice(cr + 1) : visible;
}

/** Lines of tool output that say nothing about what failed (timings, npm boilerplate). */
const OUTPUT_NOISE = [
  /^\s*(Start at|Duration)\b/,
  /^\s*npm (error|ERR!) (code|path|workspace|location|command|Lifecycle script)\b/,
  /^\s*npm (error|ERR!) A complete log of this run/,
  /^\s*npm (error|ERR!)\s*$/,
];

/** Separator lines such as vitest's "⎯⎯⎯⎯[1/2]⎯": nothing left once box characters are removed. */
const isSeparator = (line: string) =>
  line.replace(/\[\d+\/\d+\]/g, '').replace(/[\s⎯─━═\-=_~*·`]/g, '') === '';

/** Output lines that name what failed: test failures, errors, failed summaries. */
const OUTPUT_KEY = /\bFAIL(ED)?\b|\w*(error|exception)\b|[×✗✘]|\bERR!|\bpanic\b/i;
/** Code frames ("  5| foo()", "   |   ^") and diff markers: helpful, but only if there is room. */
const OUTPUT_FRAME = /^\s*(\d+\s*)?\|/;

/**
 * A numbered review issue written by formatReviewIssues(): "3. [必须修改]（a.ts） …", in English
 * "3. [must fix] (a.ts) …" or "3. [suggestion] …". Group 1 is the level.
 */
const REVIEW_ISSUE = /^\d+\.\s*\[(必须修改|建议|must[\w ]*|should[\w ]*|suggest[\w ]*)\]/i;
/** The level of a review issue that must be fixed. */
const MUST_FIX = /^(必须修改|must)/i;

/**
 * The line formatCommandFailure() writes right before the fence of the command output:
 * "…输出末尾：", in English ending in "output:" (e.g. "Output tail:", "End of output:").
 */
const OUTPUT_HEAD = /输出末尾：$|output[\w ]*:$/i;

/** Minimum number of command-output lines an excerpt keeps when the message has any. */
const MIN_OUTPUT_LINES = 3;

/**
 * A few lines of a multi-line message for cards: the headline plus the most telling details.
 *
 * - Command output is the block formatCommandFailure() writes after "…输出末尾：", from the
 *   first "```" to the last one (so fences inside the output don't confuse it). Color codes,
 *   separators, timing and npm boilerplate lines are dropped; lines naming failures and errors
 *   ("FAIL …", "AssertionError: …", "error TS…", "1 failed") are kept first, later lines winning.
 * - Other lines (headline, "检查命令 `x` 未通过（退出码 N）", review issues) keep their order; when
 *   there are too many, "[必须修改]" issues go first and "[建议]" ones are dropped first. Lines
 *   continuing an issue's description stay with that issue.
 *
 * At most `maxLines` lines are returned. Omitted lines are marked with "…" at the start of the
 * line after the gap (or at the end of the last line) so markers take no extra lines.
 */
export function messageExcerpt(message: string, maxLines = 6, maxWidth = 160): string {
  const raw = message.split('\n').map((l) => stripAnsi(l).trim());
  let open = -1;
  let close = raw.length;
  for (let i = 1; i < raw.length; i++) {
    if (raw[i] === '```' && OUTPUT_HEAD.test(raw[i - 1] ?? '')) {
      open = i;
      break;
    }
  }
  if (open >= 0) {
    const last = raw.lastIndexOf('```');
    if (last > open) close = last;
  }

  // rank: lower is kept first. Plain lines and output lines are budgeted separately.
  const items: { text: string; output: boolean; rank: number }[] = [];
  let issueRank: number | null = null;
  raw.forEach((line, i) => {
    if (!line || i === open || i === close) return;
    if (open >= 0 && i > open && i < close) {
      if (OUTPUT_NOISE.some((re) => re.test(line)) || isSeparator(line)) return;
      const rank = OUTPUT_KEY.test(line) ? 0 : OUTPUT_FRAME.test(line) ? 2 : 1;
      items.push({ text: line, output: true, rank });
      return;
    }
    const issue = REVIEW_ISSUE.exec(line);
    if (issue) issueRank = MUST_FIX.test(issue[1] ?? '') ? 0 : 2;
    const rank = i + 1 === open ? -1 : (issueRank ?? 1);
    items.push({ text: line, output: false, rank });
  });

  const clip = (s: string) => (s.length > maxWidth ? `${s.slice(0, maxWidth)}…` : s);
  if (items.length <= maxLines) return items.map((item) => clip(item.text)).join('\n');

  const keep = new Set<number>([0]);
  const plain: number[] = [];
  const output: number[] = [];
  items.forEach((item, i) => {
    if (i > 0) (item.output ? output : plain).push(i);
  });
  const remaining = Math.max(0, maxLines - 1);
  // Output gets at least a few lines, but never at the cost of the first plain detail line
  // (usually "检查命令 `x` 未通过（退出码 N）").
  const reserved = Math.min(
    output.length,
    MIN_OUTPUT_LINES,
    Math.max(0, remaining - Math.min(plain.length, 1)),
  );
  const plainBudget = Math.min(plain.length, remaining - reserved);
  const outputBudget = Math.min(output.length, remaining - plainBudget);
  const rankOf = (i: number) => items[i]?.rank ?? 1;
  for (const i of [...plain].sort((a, b) => rankOf(a) - rankOf(b) || a - b).slice(0, plainBudget))
    keep.add(i);
  for (const i of [...output].sort((a, b) => rankOf(a) - rankOf(b) || b - a).slice(0, outputBudget))
    keep.add(i);

  const lines: string[] = [];
  let skipped = false;
  items.forEach((item, i) => {
    if (!keep.has(i)) {
      skipped = true;
      return;
    }
    lines.push(skipped ? `… ${clip(item.text)}` : clip(item.text));
    skipped = false;
  });
  if (skipped && lines.length > 0) {
    const last = lines.length - 1;
    if (!lines[last]?.endsWith('…')) lines[last] = `${lines[last]} …`;
  }
  return lines.join('\n');
}
