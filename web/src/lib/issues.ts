import type { GitHubRepoStatus, UpgradeStatus } from '../../../src/api/types.js';
import {
  type AutoAcceptRule,
  acceptSplit,
  PROPOSAL_SIZES,
  type ProposalKind,
  type ProposalSize,
  RISKS,
  type Risk,
} from '../../../src/config/flow.js';
import { join, t } from '../../../src/i18n.js';
import type { RunIssue, ScoutProposal, ScoutStatus } from '../../../src/store/types.js';
import { formatCost, formatMinutes, formatTime, type Tone } from './format.js';

// Display helpers for GitHub issues and AI scouts. Labels are getters, so they are picked in
// the language in use when read, not when this module is imported.

/** A badge whose label is picked in the language in use when read. */
function badge(zh: string, en: string, tone: Tone): { readonly label: string; tone: Tone } {
  return {
    get label() {
      return t({ zh, en });
    },
    tone,
  };
}

export const SCOUT_STATUS: Record<ScoutStatus, { readonly label: string; tone: Tone }> = {
  running: badge('侦察中', 'Scouting', 'active'),
  completed: badge('已完成', 'Done', 'success'),
  failed: badge('失败', 'Failed', 'danger'),
  interrupted: badge('被中断', 'Interrupted', 'muted'),
  rate_limited: badge('额度用尽/限流', 'Out of quota / rate-limited', 'attention'),
};

export const RISK: Record<ScoutProposal['risk'], { readonly label: string; tone: Tone }> = {
  low: badge('风险低', 'Low risk', 'success'),
  mid: badge('风险中', 'Medium risk', 'attention'),
  high: badge('风险高', 'High risk', 'danger'),
};

export const CATEGORY: Readonly<Record<ScoutProposal['category'], string>> = {
  get bug() {
    return t({ zh: '缺陷', en: 'Bug' });
  },
  get feature() {
    return t({ zh: '新功能', en: 'Feature' });
  },
  get improvement() {
    return t({ zh: '改进', en: 'Improvement' });
  },
  get docs() {
    return t({ zh: '文档', en: 'Docs' });
  },
  get test() {
    return t({ zh: '测试', en: 'Tests' });
  },
  get refactor() {
    return t({ zh: '重构', en: 'Refactor' });
  },
};

/** Open issues of the repo on GitHub, optionally with one label. */
export function issuesUrl(repo: string, label?: string): string {
  const q = ['is:issue', 'is:open', ...(label ? [`label:"${label}"`] : [])].join(' ');
  return `https://github.com/${repo}/issues?q=${encodeURIComponent(q)}`;
}

/** A new issue on GitHub with the label already filled in. */
export function newIssueUrl(repo: string, label: string): string {
  return `https://github.com/${repo}/issues/new?labels=${encodeURIComponent(label)}`;
}

/** "#12" for a Run created from an issue. */
export function issueRef(issue: RunIssue): string {
  return `#${issue.number}`;
}

/**
 * When the scout of a repo runs by itself, e.g.
 * "没有在进行中的 Run 时自动侦察（只等人的 Run 不挡），至少间隔 2 小时".
 */
export function scoutPlan(scout: NonNullable<GitHubRepoStatus['scout']>): string {
  if (!scout.auto) return t({ zh: '只在这里手动触发', en: 'Only when started here' });
  const m = scout.intervalMinutes;
  const gap =
    m > 0
      ? t({ zh: `，至少间隔 ${formatMinutes(m)}`, en: `, at least ${formatMinutes(m)} apart` })
      : '';
  return t({
    zh: `没有在进行中的 Run 时自动侦察（只等人的 Run 不挡）${gap}`,
    en: `Scouts by itself when no Run is in progress (Runs waiting only for you do not hold it back)${gap}`,
  });
}

/** Why the automatic scout waits, e.g. "离上次侦察不到设定的间隔（11-20 09:30 之后）". */
export function scoutWaitText(
  waiting: NonNullable<GitHubRepoStatus['scout']>['waiting'],
  now = new Date(),
): string | null {
  if (!waiting) return null;
  if (!waiting.until) return waiting.reason;
  const until = formatTime(waiting.until, now);
  return t({
    zh: `${waiting.reason}（${until} 之后）`,
    en: `${waiting.reason} (after ${until})`,
  });
}

/** "今天 $3.20 / $20"，达到上限时说明后果。 */
export function budgetText(budget: GitHubRepoStatus['budget']): string {
  if (budget.dailyUsd === null) {
    return t({
      zh: `${formatCost(budget.spentToday)}（不设上限）`,
      en: `${formatCost(budget.spentToday)} (no limit)`,
    });
  }
  const text = `${formatCost(budget.spentToday)} / ${formatCost(budget.dailyUsd)}`;
  if (!budget.reached) return text;
  return t({
    zh: `${text}（已达上限，今天不再自动侦察和自动采纳）`,
    en: `${text} (limit reached: no automatic scouting or accepting for the rest of today)`,
  });
}

function upgradeState(state: UpgradeStatus['state']): string {
  switch (state) {
    case 'idle':
      return t({ zh: '还没检查', en: 'Not checked yet' });
    case 'off':
      return t({
        zh: '关闭（config.yaml 的 upgrade.auto）',
        en: 'Off (upgrade.auto in config.yaml)',
      });
    case 'unavailable':
      return t({ zh: '不能自动升级', en: 'Cannot upgrade itself' });
    case 'up_to_date':
      return t({ zh: '已是最新', en: 'Up to date' });
    case 'waiting':
      return t({ zh: '有新版本，等待中', en: 'New version available, waiting' });
    case 'upgrading':
      return t({ zh: '正在升级', en: 'Upgrading' });
    case 'skipped':
      return t({ zh: '跳过', en: 'Skipped' });
    case 'blocked':
      return t({ zh: '需要你处理', en: 'Needs you' });
  }
}

/** One line about the Master upgrading itself. */
export function upgradeText(u: UpgradeStatus): string {
  const head = upgradeState(u.state);
  const paren = (s: string) => t({ zh: `（${s}）`, en: ` (${s})` });
  const version =
    u.current && u.latest && u.current !== u.latest
      ? paren(`${u.current.slice(0, 7)} → ${u.latest.slice(0, 7)}`)
      : u.current
        ? paren(u.current.slice(0, 7))
        : '';
  return [head + version, u.message].filter(Boolean).join(t({ zh: '：', en: ': ' }));
}

const RISK_WORD: Readonly<Record<Risk, { zh: string; en: string }>> = {
  low: { zh: '低', en: 'low' },
  mid: { zh: '中', en: 'medium' },
  high: { zh: '高', en: 'high' },
};

/** "S、M" / "S or M", "S, M or L". */
function orList(items: readonly string[]): string {
  if (items.length < 2) return items.join('');
  return t({ zh: join(items), en: `${items.slice(0, -1).join(', ')} or ${items.at(-1)}` });
}

/** "A和B", "A、B和C" / "A and B", "A, B and C". */
function andList(items: readonly string[]): string {
  if (items.length < 2) return items.join('');
  return `${join(items.slice(0, -1))}${t({ zh: '和', en: ' and ' })}${items.at(-1)}`;
}

/** "风险中、高" / "medium- or high-risk". */
function risksText(risks: readonly Risk[]): string {
  const words = risks.map((r) => t(RISK_WORD[r]));
  return t({
    zh: `风险${join(words)}`,
    en: `${orList(words.map((w, i) => (i < words.length - 1 ? `${w}-` : w)))}-risk`,
  });
}

/**
 * Kinds of proposals in a few words, e.g. "L 级提案和风险高的提案" / "size L proposals and
 * high-risk proposals": whole sizes and whole risks first, then what they leave, by risk.
 * null when there are none.
 */
export function proposalKindsText(kinds: readonly ProposalKind[]): string | null {
  if (kinds.length === 0) return null;
  const has = (risk: Risk, size: ProposalSize) =>
    kinds.some((k) => k.risk === risk && k.size === size);
  const sizes = PROPOSAL_SIZES.filter((s) => RISKS.every((r) => has(r, s)));
  if (sizes.length === PROPOSAL_SIZES.length) return t({ zh: '所有提案', en: 'all proposals' });
  const risks = RISKS.filter((r) => PROPOSAL_SIZES.every((s) => has(r, s)));
  // The rest by risk, risks that leave the same sizes together.
  const rest: { risks: Risk[]; sizes: ProposalSize[] }[] = [];
  for (const r of RISKS) {
    if (risks.includes(r)) continue;
    const left = PROPOSAL_SIZES.filter((s) => !sizes.includes(s) && has(r, s));
    if (left.length === 0) continue;
    const same = rest.find((g) => g.sizes.join() === left.join());
    if (same) same.risks.push(r);
    else rest.push({ risks: [r], sizes: left });
  }
  const phrases = [
    ...(sizes.length > 0
      ? [t({ zh: `${orList(sizes)} 级提案`, en: `size ${orList(sizes)} proposals` })]
      : []),
    ...(risks.length > 0
      ? [t({ zh: `${risksText(risks)}的提案`, en: `${risksText(risks)} proposals` })]
      : []),
    ...rest.map((g) =>
      t({
        zh: `${risksText(g.risks)}的 ${orList(g.sizes)} 级提案`,
        en: `${risksText(g.risks)} proposals of size ${orList(g.sizes)}`,
      }),
    ),
  ];
  return andList(phrases);
}

/** Text to put right after Chinese: with a space when it starts with Latin, as in "采纳 L 级提案". */
export function afterChinese(text: string): string {
  return /^[A-Za-z0-9]/.test(text) ? ` ${text}` : text;
}

/** Text to put right before Chinese: with a space when it ends with Latin, as in "$20.00 后". */
export function beforeChinese(text: string): string {
  return /[A-Za-z0-9]$/.test(text) ? `${text} ` : text;
}

/**
 * The proposals the Master accepts by itself under `auto_accept.max_risk` and those left to you,
 * in words, by the auto-accept rule (`rule`; tests may pass another). null = none.
 */
export function acceptRanges(
  maxRisk: Risk | 'none',
  rule?: AutoAcceptRule,
): { auto: string | null; human: string | null } {
  const { auto, human } = acceptSplit(maxRisk, rule);
  return { auto: proposalKindsText(auto), human: proposalKindsText(human) };
}

export function autoAcceptText(auto: GitHubRepoStatus['autoAccept']): string {
  const range = acceptRanges(auto.maxRisk).auto;
  if (range === null) {
    return t({ zh: '关闭：提案都由你采纳', en: 'Off: you accept every proposal' });
  }
  const max = auto.maxPerDay;
  const limit =
    max === null
      ? t({ zh: '不限条数', en: 'no daily limit' })
      : t({ zh: `每天最多 ${max} 条`, en: `at most ${max} a day` });
  return t({
    zh: `${range}；${limit}，今天 ${auto.usedToday} 条`,
    en: `${range}; ${limit}, ${auto.usedToday} today`,
  });
}
