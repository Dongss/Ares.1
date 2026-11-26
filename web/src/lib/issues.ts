import type { GitHubRepoStatus, GitHubStatus, UpgradeStatus } from '../../../src/api/types.js';
import {
  type AutoAcceptRule,
  acceptSplit,
  changeRequestTerms,
  PROPOSAL_SIZES,
  type ProposalKind,
  type ProposalSize,
  RISKS,
  type Risk,
} from '../../../src/config/flow.js';
import { join, t } from '../../../src/i18n.js';
import type {
  HostPlatform,
  RunIssue,
  ScoutGap,
  ScoutProposal,
  ScoutStatus,
} from '../../../src/store/types.js';
import { formatCost, formatMinutes, formatTime, type Tone } from './format.js';

// Display helpers for the issues of a code host (GitHub or GitLab) and AI scouts. Labels are
// getters, so they are picked in the language in use when read, not when this module is imported.

/** A badge whose label is picked in the language in use when read. */
export function badge(zh: string, en: string, tone: Tone): { readonly label: string; tone: Tone } {
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

/**
 * What two goals are compared by: no whitespace anywhere (half- or full-width) and no trailing
 * punctuation, Chinese or not. Only these small slips are ignored; case, synonyms and meaning are
 * left alone.
 */
const goalKey = (goal: string) =>
  goal.replace(/\s+/g, '').replace(/[。．.，,；;：:！!？?、]+$/, '');

/**
 * A scout's gaps grouped by the README goal they stand in the way of. Goals that differ only in
 * whitespace or trailing punctuation (see `goalKey`) fall in one group, headed by its first gap's
 * goal, trimmed. Goals come in the order their first gap does, so the group of the most important
 * gap leads; gaps keep their order.
 */
export function gapsByGoal(gaps: readonly ScoutGap[]): { goal: string; gaps: ScoutGap[] }[] {
  const groups: { goal: string; key: string; gaps: ScoutGap[] }[] = [];
  for (const gap of gaps) {
    const key = goalKey(gap.goal);
    const group = groups.find((g) => g.key === key);
    if (group) group.gaps.push(gap);
    else groups.push({ goal: gap.goal.trim(), key, gaps: [gap] });
  }
  return groups.map(({ goal, gaps }) => ({ goal, gaps }));
}

/**
 * The heading of a scout's gap analysis, e.g. "差距分析：3 个缺口，涉及 2 个目标"; null for a
 * scout without one (still running, failed, or recorded before there was one).
 */
export function gapsHeading(gaps: readonly ScoutGap[] | null): string | null {
  if (gaps === null) return null;
  const n = gaps.length;
  if (n === 0) {
    return t({ zh: '差距分析：没有找到能力缺口', en: 'Gap analysis: no capability gaps found' });
  }
  const goals = gapsByGoal(gaps).length;
  return t({
    zh: `差距分析：${n} 个缺口，涉及 ${goals} 个目标`,
    en: `Gap analysis: ${n} gap${n === 1 ? '' : 's'} across ${goals} goal${goals === 1 ? '' : 's'}`,
  });
}

/**
 * The code host issues are on, as GET /api/github and GET /api/gitlab give it: GitHub, or GitLab
 * on `host` (gitlab.com or a self-hosted one; gitlab.com when not given).
 */
export type IssueHost = Pick<GitHubStatus, 'platform' | 'host'>;

/** GitHub as an `IssueHost`. */
export const GITHUB: IssueHost = { platform: 'github', host: null };

/** The code host as people know it. */
export function platformName(platform: HostPlatform): 'GitHub' | 'GitLab' {
  return platform === 'gitlab' ? 'GitLab' : 'GitHub';
}

/** 「GitHub」, or 「GitLab（gitlab.example.com）」 with the GitLab's host. */
export function hostLabel(at: IssueHost): string {
  if (at.platform !== 'gitlab') return platformName(at.platform);
  const host = gitlabHost(at);
  return t({ zh: `GitLab（${host}）`, en: `GitLab (${host})` });
}

function gitlabHost(at: IssueHost): string {
  return at.host ?? 'gitlab.com';
}

/**
 * Open issues of the repo ("owner/name", or a GitLab project's path) on its host, optionally with
 * one label.
 */
export function issuesUrl(at: IssueHost, repo: string, label?: string): string {
  if (at.platform === 'gitlab') {
    const filter = label ? `&label_name[]=${encodeURIComponent(label)}` : '';
    return `https://${gitlabHost(at)}/${repo}/-/issues?state=opened${filter}`;
  }
  const q = ['is:issue', 'is:open', ...(label ? [`label:"${label}"`] : [])].join(' ');
  return `https://github.com/${repo}/issues?q=${encodeURIComponent(q)}`;
}

/**
 * A new issue on the repo's host with the label already filled in. GitLab takes no label by name
 * in the link, so the description starts with the quick action that adds it, which GitLab runs
 * and removes when the issue is created.
 */
export function newIssueUrl(at: IssueHost, repo: string, label: string): string {
  if (at.platform === 'gitlab') {
    const labelAction = encodeURIComponent(`/label ~"${label}"`);
    return `https://${gitlabHost(at)}/${repo}/-/issues/new?issue[description]=${labelAction}`;
  }
  return `https://github.com/${repo}/issues/new?labels=${encodeURIComponent(label)}`;
}

/** One issue of the repo on its host, by number. */
export function issueUrl(at: IssueHost, repo: string, number: number): string {
  return at.platform === 'gitlab'
    ? `https://${gitlabHost(at)}/${repo}/-/issues/${number}`
    : `https://github.com/${repo}/issues/${number}`;
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

/**
 * How often the Master checks a source of requirements and when it last did: 「每 5 分钟检查一次
 * · 上次 09:30:00」 / "Checks every 5 minutes · last 09:30:00".
 */
export function pollText(minutes: number, lastPollAt: string | null, now = new Date()): string {
  const every = t({
    zh: `每 ${minutes} 分钟检查一次`,
    en: `Checks every ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`,
  });
  if (!lastPollAt) return every;
  const last = formatTime(lastPollAt, now);
  return t({ zh: `${every} · 上次 ${last}`, en: `${every} · last ${last}` });
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

/**
 * How the repo's Runs reach its code host (`deliver` and `push`): 「推送：合并后自动推送」,
 * 「PR：……」 on GitHub (deliver: pr) or 「MR：……」 on GitLab (deliver: mr). deliver: pr or mr
 * without push: true disables the repo, which its configuration problems say too.
 */
export function deliveryText(repo: Pick<GitHubRepoStatus, 'deliver' | 'push'>): string {
  if (repo.deliver === 'pr' || repo.deliver === 'mr') {
    const { host, short, long, longCapital, deliver } = changeRequestTerms(
      repo.deliver === 'mr' ? 'gitlab' : 'github',
    );
    return repo.push
      ? t({
          zh: `${short}：推送 Run 的分支、开合并到目标分支的 ${short}，在 ${host} 上合并后 Run 完成；目标分支不由 Master 推送`,
          en: `${longCapital}: the Run's branch is pushed with a ${long} into the target branch, and the Run completes once it is merged on ${host}; the Master never pushes the target branch`,
        })
      : t({
          zh: `${short}，但没开 push：deliver: ${deliver} 要配 push: true，这个仓库现在停用`,
          en: `${longCapital}, but push is off: deliver: ${deliver} needs push: true, so the repo is disabled now`,
        });
  }
  return repo.push
    ? t({
        zh: '推送：合并到本地目标分支后自动推送',
        en: 'Push: the target branch is pushed after each local merge',
      })
    : t({
        zh: '推送：只合并到本地目标分支，由你推送',
        en: 'Push: merges stay in the local target branch, and you push',
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

/** The settings of `auto_accept` that decide which proposals it takes. */
export type AcceptLimits = Pick<GitHubRepoStatus['autoAccept'], 'maxRisk' | 'maxSize'>;

/**
 * The proposals the Master accepts by itself under `auto_accept` (`max_risk` and `max_size`) and
 * those left to you, in words, by the auto-accept rule (`rule`; tests may pass another).
 * null = none.
 */
export function acceptRanges(
  accept: AcceptLimits,
  rule?: AutoAcceptRule,
): { auto: string | null; human: string | null } {
  const { auto, human } = acceptSplit({ max_risk: accept.maxRisk, max_size: accept.maxSize }, rule);
  return { auto: proposalKindsText(auto), human: proposalKindsText(human) };
}

export function autoAcceptText(auto: GitHubRepoStatus['autoAccept']): string {
  const range = acceptRanges(auto).auto;
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

/** The `github` section of config.yaml, as an example to copy. */
export function githubExample(): string {
  return t({
    zh: `github:
  account: my-account        # 可选：用 gh 的哪个账号
  repos:
    my-repo:                 # 看板上登记的仓库名
      template: self-dev     # 从 issue 建 Run 用的模板
      scout:
        agent: claude-reviewer
        auto: true           # 没有在进行中的 Run 时自动侦察（只等人的 Run 不挡）；false = 只手动触发
      auto_accept:
        max_risk: none       # 自动采纳到哪个风险等级：none / low / mid / high
        max_size: L          # 自动采纳到哪个大小：S / M / L
      auto_merge: false      # 从 issue 来的 Run 合并前不再等你审批
      push: false            # 合并后自动推送到 GitHub
      # deliver: pr          # 目标分支受保护时：推送 Run 的分支、开 PR，合并后 Run 完成（要配 push: true）
      # daily_budget_usd: 20 # 每天自动花费的上限，不写 = 不限
      max_run_attempts: 3    # 一个 issue 最多跑几次 Run（含第一次），失败后自动重做`,
    en: `github:
  account: my-account        # optional: which gh account to use
  repos:
    my-repo:                 # the repo name registered on the dashboard
      template: self-dev     # template of the Runs created from issues
      scout:
        agent: claude-reviewer
        auto: true           # scout by itself when no Run is in progress (Runs waiting only for you do not hold it back); false = by hand only
      auto_accept:
        max_risk: none       # highest risk accepted automatically: none / low / mid / high
        max_size: L          # largest size accepted automatically: S / M / L
      auto_merge: false      # Runs from issues merge without waiting for your approval
      push: false            # push to GitHub after merging
      # deliver: pr          # protected target branch: push the Run's branch, open a PR, done once merged (needs push: true)
      # daily_budget_usd: 20 # daily limit of automatic spend; omitted = no limit
      max_run_attempts: 3    # Runs an issue gets at most, the first included; failed ones are redone`,
  });
}

/** The `gitlab` section of config.yaml, as an example to copy. */
export function gitlabExample(): string {
  return t({
    zh: `gitlab:
  host: gitlab.com           # GitLab 的主机名；自建的写它自己的，如 gitlab.example.com（不带 https://）
  # account: my-account      # 可选：glab 在这个 host 上应登录的账号，不写 = 当前登录的账号
  poll_minutes: 5            # 多久检查一次 issue
  repos:
    my-repo:                 # 看板上登记的仓库名，不能和 github.repos、backlog.repos 里的重名
      issues_repo: my-group/my-repo  # 项目在 GitLab 上的路径（必填），有子组就写全：group/subgroup/name
      template: self-dev     # 从 issue 建 Run 用的模板
      scout:
        agent: claude-reviewer
        auto: true           # 没有在进行中的 Run 时自动侦察（只等人的 Run 不挡）；false = 只手动触发
      auto_accept:
        max_risk: none       # 自动采纳到哪个风险等级：none / low / mid / high
        max_size: L          # 自动采纳到哪个大小：S / M / L
      auto_merge: false      # 从 issue 来的 Run 合并前不再等你审批
      push: false            # 合并后自动推送到 GitLab
      # deliver: mr          # 目标分支受保护时：推送 Run 的分支、开 MR，合并后 Run 完成（要配 push: true）
      # daily_budget_usd: 20 # 每天自动花费的上限，不写 = 不限
      max_run_attempts: 3    # 一个 issue 最多跑几次 Run（含第一次），失败后自动重做`,
    en: `gitlab:
  host: gitlab.com           # the GitLab's host name; a self-hosted one's own, e.g. gitlab.example.com (no https://)
  # account: my-account      # optional: the account glab must be logged in as on this host; omitted = whichever it is
  poll_minutes: 5            # how often to check the issues
  repos:
    my-repo:                 # the repo name registered on the dashboard; not one of github.repos or backlog.repos
      issues_repo: my-group/my-repo  # the project's path on GitLab (required), subgroups included: group/subgroup/name
      template: self-dev     # template of the Runs created from issues
      scout:
        agent: claude-reviewer
        auto: true           # scout by itself when no Run is in progress (Runs waiting only for you do not hold it back); false = by hand only
      auto_accept:
        max_risk: none       # highest risk accepted automatically: none / low / mid / high
        max_size: L          # largest size accepted automatically: S / M / L
      auto_merge: false      # Runs from issues merge without waiting for your approval
      push: false            # push to GitLab after merging
      # deliver: mr          # protected target branch: push the Run's branch, open an MR, done once merged (needs push: true)
      # daily_budget_usd: 20 # daily limit of automatic spend; omitted = no limit
      max_run_attempts: 3    # Runs an issue gets at most, the first included; failed ones are redone`,
  });
}

/** The `backlog` section of config.yaml, as an example to copy. */
export function backlogExample(): string {
  return t({
    zh: `backlog:
  poll_minutes: 5            # 多久检查一次本地提案池
  repos:
    my-local-repo:           # 看板上登记的仓库名，不能和 github.repos、gitlab.repos 里的重名
      template: self-dev     # 采纳的提案建 Run 用的模板
      scout:                 # 不写 = 不侦察，这个仓库就没有提案
        agent: claude-reviewer
        auto: true           # 没有在进行中的 Run 时自动侦察（只等人的 Run 不挡）；false = 只手动触发
      auto_accept:
        max_risk: low        # 自动采纳到哪个风险等级：none / low / mid / high
        max_size: M          # 自动采纳到哪个大小：S / M / L
      auto_merge: false      # 采纳的提案建出的 Run 合并前不再等你审批
      # daily_budget_usd: 20 # 每天自动花费的上限，不写 = 不限
      max_run_attempts: 3    # 一条提案最多跑几次 Run（含第一次），失败后自动重做`,
    en: `backlog:
  poll_minutes: 5            # how often to go over the local backlog
  repos:
    my-local-repo:           # the repo name registered on the dashboard; not one of github.repos or gitlab.repos
      template: self-dev     # template of the Runs created from accepted proposals
      scout:                 # omitted = no scout, so the repo gets no proposals
        agent: claude-reviewer
        auto: true           # scout by itself when no Run is in progress (Runs waiting only for you do not hold it back); false = by hand only
      auto_accept:
        max_risk: low        # highest risk accepted automatically: none / low / mid / high
        max_size: M          # largest size accepted automatically: S / M / L
      auto_merge: false      # Runs from accepted proposals merge without waiting for your approval
      # daily_budget_usd: 20 # daily limit of automatic spend; omitted = no limit
      max_run_attempts: 3    # Runs a proposal gets at most, the first included; failed ones are redone`,
  });
}
