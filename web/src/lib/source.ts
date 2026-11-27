import type { ConfigView, RepoSourceFieldsInput, RepoSourceInput } from '../../../src/api/types.js';
import {
  changeRequestTerms,
  PROPOSAL_SIZES,
  type ProposalSize,
  REPO_SOURCE_DEFAULTS,
  RISKS,
  type Risk,
  type TemplateSource,
} from '../../../src/config/flow.js';
import { join, t } from '../../../src/i18n.js';
import { repoSourceOf } from './config.js';

// The form of the Repos page that sets where a repo's requirements come from: what it offers to
// choose from, what it starts from, the request it sends (PUT /api/repos/:id/source), and the
// problems it can tell before sending it. The Master checks everything again.

/** The choices of where the requirements come from; `none`: nowhere, so the repo gets no Runs. */
export const SOURCE_PLATFORMS = ['github', 'gitlab', 'backlog', 'none'] as const;
export type SourcePlatform = (typeof SOURCE_PLATFORMS)[number];

export function sourcePlatformLabel(platform: SourcePlatform): string {
  switch (platform) {
    case 'github':
      return 'GitHub';
    case 'gitlab':
      return 'GitLab';
    case 'backlog':
      return t({ zh: '本地提案池', en: 'Local backlog' });
    case 'none':
      return t({ zh: '无', en: 'None' });
  }
}

/** What choosing the platform means, in a sentence. */
export function sourcePlatformHint(platform: SourcePlatform): string {
  switch (platform) {
    case 'github':
      return t({
        zh: '需求是 GitHub 上打了 ares1:ready 标签的 issue，写进 config.yaml 的 github.repos',
        en: 'Requirements are the issues labeled ares1:ready on GitHub; written under github.repos in config.yaml',
      });
    case 'gitlab':
      return t({
        zh: '需求是 GitLab 上打了 ares1:ready 标签的 issue，写进 config.yaml 的 gitlab.repos；自建的 GitLab 要在 config.yaml 里写 gitlab.host',
        en: 'Requirements are the issues labeled ares1:ready on GitLab; written under gitlab.repos in config.yaml. For a self-hosted GitLab, set gitlab.host in config.yaml',
      });
    case 'backlog':
      return t({
        zh: '需求是 Master 自己保存的提案（侦察提的、人写的），不用 GitHub 或 GitLab，写进 config.yaml 的 backlog.repos',
        en: 'Requirements are proposals the Master keeps itself (from the scout or written by people), with neither GitHub nor GitLab; written under backlog.repos in config.yaml',
      });
    case 'none':
      return t({
        zh: '从 github.repos、gitlab.repos 和 backlog.repos 里都删掉，这个仓库不会再有 Run 和侦察',
        en: 'Removed from github.repos, gitlab.repos and backlog.repos: the repo gets no Runs and no scouts',
      });
  }
}

/** A template the form offers, and where the repo's Runs would get it from. */
export interface TemplateOption {
  id: string;
  name: string;
  /** `missing`: the repo's entry names it, but no template with that id is loaded. */
  source: TemplateSource | 'missing';
}

/**
 * The templates the repo's Runs can get (`resolveTemplate`): the home directory's, then the
 * repo's own whose id the home directory does not have, each id once. `current`, the template the
 * entry names, is offered too when it is neither, marked missing, so the form shows what is set.
 */
export function sourceTemplateOptions(
  view: Pick<ConfigView, 'templates' | 'repoTemplates'>,
  repo: string,
  current?: string,
): TemplateOption[] {
  const options: TemplateOption[] = [];
  const seen = new Set<string>();
  const add = (id: string, name: string, source: TemplateOption['source']) => {
    if (seen.has(id)) return;
    seen.add(id);
    options.push({ id, name, source });
  };
  for (const tpl of view.templates) add(tpl.id, tpl.name ?? tpl.id, 'home');
  const own = view.repoTemplates.find((r) => r.repo === repo);
  for (const tpl of own?.templates ?? []) add(tpl.id, tpl.name ?? tpl.id, 'repo');
  if (current) add(current, current, 'missing');
  return options;
}

export function templateOptionLabel(option: TemplateOption): string {
  const name = option.name === option.id ? option.id : `${option.id} · ${option.name}`;
  switch (option.source) {
    case 'home':
      return t({ zh: `${name}（数据目录）`, en: `${name} (home directory)` });
    case 'repo':
      return t({ zh: `${name}（仓库自带）`, en: `${name} (the repo's own)` });
    case 'missing':
      return t({ zh: `${name}（不存在或无效）`, en: `${name} (missing or invalid)` });
  }
}

/** An agent the form offers for the scout. */
export interface ScoutAgentOption {
  id: string;
  /** Its CLI; empty when it is not an enabled agent. */
  cli: string;
  /**
   * Whether it can scout: an enabled agent of a CLI that runs read-only. false only for the agent
   * the entry names already, offered so the form shows what is set.
   */
  usable: boolean;
}

/**
 * The agents that can scout: enabled ones (`ConfigView.agents`) of a CLI that can run read-only
 * (`ConfigView.clis`), in agents.yaml's order. `current`, the scout agent the entry names, is
 * offered too when it is not one of them, marked unusable.
 */
export function scoutAgentOptions(
  view: Pick<ConfigView, 'agents' | 'clis'>,
  current?: string,
): ScoutAgentOption[] {
  const readOnly = new Set(view.clis.filter((c) => c.readOnly).map((c) => c.cli));
  const options: ScoutAgentOption[] = view.agents
    .filter((a) => readOnly.has(a.cli))
    .map((a) => ({ id: a.id, cli: a.cli, usable: true }));
  if (current && !options.some((o) => o.id === current)) {
    const agent = view.agents.find((a) => a.id === current);
    options.push({ id: current, cli: agent?.cli ?? '', usable: false });
  }
  return options;
}

export function scoutAgentLabel(option: ScoutAgentOption): string {
  if (option.usable) return `${option.id} (${option.cli})`;
  return option.cli
    ? t({
        zh: `${option.id}（${option.cli}，不能只读运行）`,
        en: `${option.id} (${option.cli}, cannot run read-only)`,
      })
    : t({
        zh: `${option.id}（不存在或未启用）`,
        en: `${option.id} (missing or disabled)`,
      });
}

/**
 * Why no agent can scout, for a form that offers none; null when some agent can. The scout runs
 * read-only, so it needs an enabled agent of a CLI that can.
 */
export function noScoutAgentNote(view: Pick<ConfigView, 'agents' | 'clis'>): string | null {
  if (scoutAgentOptions(view).length > 0) return null;
  const readOnly = view.clis.filter((c) => c.readOnly).map((c) => c.cli);
  if (readOnly.length === 0) {
    return t({
      zh: '没有能以只读方式运行的 CLI，侦察没法运行，所以不能设置侦察。',
      en: 'No CLI here can run read-only, which the scout needs, so it cannot be set.',
    });
  }
  const clis = join(readOnly);
  return t({
    zh: `侦察要以只读方式运行，只能用 ${clis} 的 Agent，agents.yaml 里还没有启用的。加一个之后就能在这里选。`,
    en: `The scout runs read-only, which only agents of ${clis} can do, and agents.yaml has no enabled one. Add one to choose it here.`,
  });
}

/** The highest risk auto-accept takes, as config.yaml's `auto_accept.max_risk` has it. */
export type MaxRisk = 'none' | Risk;
export const MAX_RISKS: readonly MaxRisk[] = ['none', ...RISKS];

export function maxRiskLabel(risk: MaxRisk): string {
  switch (risk) {
    case 'none':
      return t({ zh: 'none：不自动采纳', en: 'none: accept nothing automatically' });
    case 'low':
      return t({ zh: 'low：风险低的', en: 'low: low risk' });
    case 'mid':
      return t({ zh: 'mid：风险低、中的', en: 'mid: up to medium risk' });
    case 'high':
      return t({ zh: 'high：任何风险', en: 'high: any risk' });
  }
}

export const MAX_SIZES: readonly ProposalSize[] = PROPOSAL_SIZES;

/**
 * What the form holds: the fields of the entry as typed, numbers as text so a box may be left
 * empty. The fields of every platform are kept while another is chosen.
 */
export interface SourceForm {
  platform: SourcePlatform;
  /** `issues_repo`; empty: none (GitHub resolves it from the repo's remotes). */
  issuesRepo: string;
  template: string;
  /** The scout's agent; empty: no scouting. */
  scoutAgent: string;
  scoutAuto: boolean;
  scoutIntervalMinutes: string;
  scoutMaxProposals: string;
  maxRisk: MaxRisk;
  maxSize: ProposalSize;
  /** Empty: no daily limit. */
  maxPerDay: string;
  autoMerge: boolean;
  maxRunAttempts: string;
  /** Empty: no limit. */
  dailyBudgetUsd: string;
  push: boolean;
  /**
   * `deliver` through a change request rather than `push`: `pr` on GitHub, `mr` on GitLab, so the
   * choice holds while the platform changes.
   */
  byRequest: boolean;
}

/**
 * What the form starts from: the repo's entry in the source its requirements come from now
 * (`RepoSourceView.settings`), else the schema's defaults (`REPO_SOURCE_DEFAULTS`), with no
 * platform, no scout and the first template offered.
 */
export function sourceFormInit(
  view: Pick<ConfigView, 'repoSources' | 'templates' | 'repoTemplates'>,
  repo: string,
): SourceForm {
  const current = repoSourceOf(view, repo);
  const s = current?.settings;
  const host = current && current.source !== 'backlog' ? current : null;
  const d = REPO_SOURCE_DEFAULTS;
  return {
    platform: current?.source ?? 'none',
    issuesRepo: host?.issuesRepo ?? '',
    template: s?.template ?? sourceTemplateOptions(view, repo)[0]?.id ?? '',
    scoutAgent: s?.scout?.agent ?? '',
    scoutAuto: s?.scout?.auto ?? d.scout.auto,
    scoutIntervalMinutes: String(s?.scout?.interval_minutes ?? d.scout.interval_minutes),
    scoutMaxProposals: String(s?.scout?.max_proposals ?? d.scout.max_proposals),
    maxRisk: s?.auto_accept.max_risk ?? d.auto_accept.max_risk,
    maxSize: s?.auto_accept.max_size ?? d.auto_accept.max_size,
    maxPerDay: optionalText(s?.auto_accept.max_per_day),
    autoMerge: s?.auto_merge ?? d.auto_merge,
    maxRunAttempts: String(s?.max_run_attempts ?? d.max_run_attempts),
    dailyBudgetUsd: optionalText(s?.daily_budget_usd),
    push: host?.settings.push ?? d.push,
    byRequest: host ? host.settings.deliver !== d.deliver : false,
  };
}

function optionalText(n: number | null | undefined): string {
  return n === null || n === undefined ? '' : String(n);
}

/**
 * The body of PUT /api/repos/:id/source for the form: only the fields the platform has, no
 * scouting as `scout: null`, empty number boxes left out, and fields equal to the schema's
 * defaults left out too, so config.yaml says only what differs (the schema fills in the rest).
 */
export function sourceRequest(form: SourceForm): RepoSourceInput {
  if (form.platform === 'none') return { platform: 'none' };
  const d = REPO_SOURCE_DEFAULTS;
  const fields: RepoSourceFieldsInput = { template: form.template };

  if (form.scoutAgent) {
    const scout: NonNullable<RepoSourceFieldsInput['scout']> = { agent: form.scoutAgent };
    if (form.scoutAuto !== d.scout.auto) scout.auto = form.scoutAuto;
    const interval = numberOf(form.scoutIntervalMinutes);
    if (interval !== undefined && interval !== d.scout.interval_minutes) {
      scout.interval_minutes = interval;
    }
    const proposals = numberOf(form.scoutMaxProposals);
    if (proposals !== undefined && proposals !== d.scout.max_proposals) {
      scout.max_proposals = proposals;
    }
    fields.scout = scout;
  } else {
    fields.scout = null;
  }

  const accept: NonNullable<RepoSourceFieldsInput['auto_accept']> = {};
  if (form.maxRisk !== d.auto_accept.max_risk) accept.max_risk = form.maxRisk;
  if (form.maxSize !== d.auto_accept.max_size) accept.max_size = form.maxSize;
  const perDay = numberOf(form.maxPerDay);
  if (perDay !== undefined) accept.max_per_day = perDay;
  if (Object.keys(accept).length > 0) fields.auto_accept = accept;

  if (form.autoMerge !== d.auto_merge) fields.auto_merge = form.autoMerge;
  const attempts = numberOf(form.maxRunAttempts);
  if (attempts !== undefined && attempts !== d.max_run_attempts) {
    fields.max_run_attempts = attempts;
  }
  const budget = numberOf(form.dailyBudgetUsd);
  if (budget !== undefined) fields.daily_budget_usd = budget;

  if (form.platform === 'backlog') return { platform: 'backlog', ...fields };
  const push = form.push !== d.push ? { push: form.push } : {};
  const issuesRepo = form.issuesRepo.trim();
  if (form.platform === 'github') {
    return {
      platform: 'github',
      ...(issuesRepo ? { issues_repo: issuesRepo } : {}),
      ...fields,
      ...push,
      ...(form.byRequest ? { deliver: 'pr' as const } : {}),
    };
  }
  return {
    platform: 'gitlab',
    issues_repo: issuesRepo,
    ...fields,
    ...push,
    ...(form.byRequest ? { deliver: 'mr' as const } : {}),
  };
}

/** A number box's value; undefined when left empty. Not a number: NaN, which the Master refuses. */
function numberOf(text: string): number | undefined {
  const trimmed = text.trim();
  return trimmed === '' ? undefined : Number(trimmed);
}

/**
 * What is sure to be refused, told before the form is sent: GitLab without `issues_repo`, a pull
 * or merge request without `push`, no template, and a scout agent that cannot scout. The Master
 * checks everything again, so an empty list does not mean it will take the settings.
 */
export function sourceFormProblems(
  form: SourceForm,
  scoutAgents: readonly ScoutAgentOption[],
): string[] {
  if (form.platform === 'none') return [];
  const problems: string[] = [];
  if (form.platform === 'gitlab' && form.issuesRepo.trim() === '') {
    problems.push(
      t({
        zh: 'GitLab 必须填 issues_repo（项目路径，如 group/name）',
        en: "GitLab needs issues_repo (the project's path, such as group/name)",
      }),
    );
  }
  if (!form.template) {
    problems.push(t({ zh: '请选一个模板（template）', en: 'Choose a template' }));
  }
  const agent = scoutAgents.find((a) => a.id === form.scoutAgent);
  if (agent && !agent.usable) {
    problems.push(
      t({
        zh: `侦察 Agent ${agent.id} 用不了：侦察要用启用的、能以只读方式运行的 Agent`,
        en: `The scout agent ${agent.id} cannot scout: the scout needs an enabled agent that can run read-only`,
      }),
    );
  }
  if (form.platform !== 'backlog' && form.byRequest && !form.push) {
    const terms = changeRequestTerms(form.platform);
    problems.push(
      t({
        zh: `deliver: ${terms.deliver} 要求开启 push：开 ${terms.short} 要先把 Run 的分支推送到 ${terms.host}`,
        en: `deliver: ${terms.deliver} needs push: a ${terms.long} needs the Run's branch pushed to ${terms.host}`,
      }),
    );
  }
  return problems;
}

/** Why a save failed, as the form shows it: the Master's problems one by one, or its message. */
export interface SourceSaveFailure {
  error: string;
  problems: string[];
}

/** `err`: what the request threw (an ApiError carries the problems of a 400). */
export function sourceSaveFailure(err: unknown): SourceSaveFailure {
  const message = err instanceof Error ? err.message : String(err);
  const problems =
    err && typeof err === 'object' && 'problems' in err && Array.isArray(err.problems)
      ? err.problems.filter((p): p is string => typeof p === 'string')
      : [];
  if (problems.length === 0) return { error: message, problems: [] };
  return {
    error: t({
      zh: '设置有问题，config.yaml 没有改动：',
      en: 'The settings have problems; config.yaml was left as it was:',
    }),
    problems,
  };
}
