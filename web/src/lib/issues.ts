import type { GitHubRepoStatus, UpgradeStatus } from '../../../src/api/types.js';
import { t } from '../../../src/i18n.js';
import type { RunIssue, ScoutProposal, ScoutStatus } from '../../../src/store/types.js';
import { formatCost, formatTime, type Tone } from './format.js';

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

/** When the scout of a repo runs by itself, e.g. "没有未结束的 Run 时自动侦察，至少间隔 2 小时". */
export function scoutPlan(scout: NonNullable<GitHubRepoStatus['scout']>): string {
  if (!scout.auto) return t({ zh: '只在这里手动触发', en: 'Only when started here' });
  const h = scout.intervalHours;
  const gap =
    h > 0
      ? t({ zh: `，至少间隔 ${h} 小时`, en: `, at least ${h} ${h === 1 ? 'hour' : 'hours'} apart` })
      : '';
  return t({
    zh: `没有未结束的 Run 时自动侦察${gap}`,
    en: `Scouts by itself when no Run is unfinished${gap}`,
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

/** The proposals `auto_accept.max_risk` lets the Master accept by itself, by its setting. */
export const RISK_UP_TO: Readonly<Record<'low' | 'mid' | 'high', string>> = {
  get low() {
    return t({ zh: '风险低', en: 'low-risk' });
  },
  get mid() {
    return t({ zh: '风险中及以下', en: 'low- and medium-risk' });
  },
  get high() {
    return t({ zh: '所有风险', en: 'all' });
  },
};

export function autoAcceptText(auto: GitHubRepoStatus['autoAccept']): string {
  if (auto.maxRisk === 'none') {
    return t({ zh: '关闭：提案都由你采纳', en: 'Off: you accept every proposal' });
  }
  const max = auto.maxPerDay;
  const limit =
    max === null
      ? t({ zh: '不限条数', en: 'no daily limit' })
      : t({ zh: `每天最多 ${max} 条`, en: `at most ${max} a day` });
  return t({
    zh: `${RISK_UP_TO[auto.maxRisk]}、一个 Run 能做完的提案；${limit}，今天 ${auto.usedToday} 条`,
    en: `${RISK_UP_TO[auto.maxRisk]} proposals one Run can finish; ${limit}, ${auto.usedToday} today`,
  });
}
