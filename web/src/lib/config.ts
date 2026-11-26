import type {
  CliInfo,
  ConfigView,
  RepoSourceView,
  RepoTemplatesView,
} from '../../../src/api/types.js';
import { agentEffort } from '../../../src/config/effort.js';
import { resolveTemplate, type TemplateSource } from '../../../src/config/flow.js';
import type { AgentEntry, TemplateFile, WorkflowTemplate } from '../../../src/config/schema.js';
import { join, t } from '../../../src/i18n.js';
import { shortSha, type Tone } from './format.js';
import { GITHUB, hostLabel, type IssueHost, issuesUrl } from './issues.js';

// The read-only config page: templates with their source files (the home directory's and those
// the repos keep), and every agent entry; also which template a repo's Runs get and where its
// requirements come from, for the pages that show a repo.

/** Where a repo's requirements come from, as the Repos page shows it. */
export interface RepoSourceInfo {
  /** 「GitHub」, 「GitLab（gitlab.example.com）」, 「本地提案池」 or 「未配置」. */
  label: string;
  /** "owner/name", or a GitLab project's path, when config.yaml names it. */
  issuesRepo: string | null;
  /** The repo's open issues on its code host; null without a known `issuesRepo`. */
  url: string | null;
  /** What it means for the repo, for a repo of no source; null otherwise. */
  hint: string | null;
}

/** The source of a repo's requirements in the configuration in use (`repoSources`), if any. */
export function repoSourceOf(
  view: Pick<ConfigView, 'repoSources'>,
  repo: string,
): RepoSourceView | null {
  return Object.hasOwn(view.repoSources, repo) ? (view.repoSources[repo] ?? null) : null;
}

/** Where a registered repo's requirements come from: the code host and its issues, or none. */
export function repoSourceInfo(
  view: Pick<ConfigView, 'repoSources'>,
  repo: string,
): RepoSourceInfo {
  const source = repoSourceOf(view, repo);
  switch (source?.source) {
    case 'github':
    case 'gitlab': {
      const at: IssueHost =
        source.source === 'gitlab' ? { platform: 'gitlab', host: source.host } : GITHUB;
      return {
        label: hostLabel(at),
        issuesRepo: source.issuesRepo,
        url: source.issuesRepo ? issuesUrl(at, source.issuesRepo) : null,
        hint: null,
      };
    }
    case 'backlog':
      return {
        label: t({ zh: '本地提案池', en: 'Local backlog' }),
        issuesRepo: null,
        url: null,
        hint: null,
      };
    default:
      return {
        label: t({ zh: '未配置', en: 'None' }),
        issuesRepo: null,
        url: null,
        hint: t({
          zh: '不在 config.yaml 的 github.repos、gitlab.repos 和 backlog.repos 里，不会建 Run',
          en: 'In none of github.repos, gitlab.repos and backlog.repos of config.yaml, so it gets no Runs',
        }),
      };
  }
}

export interface TemplateCard {
  /** "workflows/<file>", or "<repo>:.ares1/workflows/<file>" for a repo's. */
  key: string;
  file: string;
  /** Where the file is: its absolute path, or "<repo>:.ares1/workflows/<file>" for a repo's. */
  path: string;
  /** The YAML as written. */
  source: string;
  /** The loaded template; null when the file is invalid. */
  template: WorkflowTemplate | null;
  errors: string[];
  warnings: string[];
}

/** Template files split into loaded templates and invalid files, both in file order. */
export function templateCards(view: ConfigView): {
  valid: TemplateCard[];
  invalid: TemplateCard[];
} {
  const valid: TemplateCard[] = [];
  const invalid: TemplateCard[] = [];
  for (const f of view.templateFiles) {
    const template = view.templates.find((t) => t.id === f.templateId) ?? null;
    const card: TemplateCard = {
      key: f.key,
      file: f.file,
      path: f.path,
      source: f.source,
      template,
      errors: f.errors,
      warnings: f.warnings,
    };
    (template ? valid : invalid).push(card);
  }
  return { valid, invalid };
}

/** What became of one of a repo's own template files. */
export type RepoTemplateState =
  /** Its template loaded, and the repo's Runs get it when the repo's `template` names it. */
  | 'valid'
  /** Its template loaded, but the home directory has one of the same id, which Runs get instead. */
  | 'shadowed'
  /** Nothing loaded from the file. */
  | 'invalid';

export interface RepoTemplateCard extends TemplateCard {
  state: RepoTemplateState;
  /**
   * The file as on the target branch fails to load, and the version that last loaded stands in
   * for it (`template`): the commit it was read from, its YAML, and why the file fails now.
   */
  lastGood: { sha: string; source: string; errors: string[] } | null;
  /** `shadowed`: the home directory's file with the same template id, when known. */
  homeFile: string | null;
}

/** The templates one repo keeps, read from `branch` at commit `sha`. */
export interface RepoTemplateGroup {
  repo: string;
  branch: string;
  sha: string;
  /** One per file, in file order. */
  cards: RepoTemplateCard[];
}

/** The templates each repo keeps in .ares1/workflows/, by repo, as the config page shows them. */
export function repoTemplateGroups(
  view: Pick<ConfigView, 'repoTemplates' | 'templateFiles'>,
): RepoTemplateGroup[] {
  return view.repoTemplates.map((r) => ({
    repo: r.repo,
    branch: r.branch,
    sha: r.sha,
    cards: r.files.map((f) => repoTemplateCard(r, f, view.templateFiles)),
  }));
}

function repoTemplateCard(
  repo: RepoTemplatesView,
  f: TemplateFile,
  homeFiles: readonly TemplateFile[],
): RepoTemplateCard {
  const template = repo.templates.find((x) => x.id === f.templateId) ?? null;
  const state: RepoTemplateState = !template ? 'invalid' : f.shadowed ? 'shadowed' : 'valid';
  const home = state === 'shadowed' ? homeFiles.find((h) => h.templateId === f.templateId) : null;
  return {
    key: f.key,
    file: f.file,
    path: repoFilePath(repo.repo, f),
    source: f.source,
    template,
    errors: f.errors,
    warnings: f.warnings,
    state,
    lastGood: template && f.lastGood ? f.lastGood : null,
    homeFile: home?.key ?? null,
  };
}

/** How the dashboard names a repo's template file: "<repo>:.ares1/workflows/<file>". */
function repoFilePath(repo: string, f: Pick<TemplateFile, 'path'>): string {
  return `${repo}:${f.path}`;
}

/** Badges of a repo's template card: what became of the file, and which version is in use. */
export function repoTemplateBadges(
  card: Pick<RepoTemplateCard, 'state' | 'lastGood'>,
): { label: string; tone: Tone }[] {
  const badges = [REPO_TEMPLATE_STATE[card.state]];
  if (card.lastGood) {
    badges.push({
      label: t({
        zh: `用的是上次加载成功的版本（${shortSha(card.lastGood.sha)}）`,
        en: `Using the version that last loaded (${shortSha(card.lastGood.sha)})`,
      }),
      tone: 'attention',
    });
  }
  return badges;
}

/**
 * What a repo's template card says about where it stands, in the language in use: why the home
 * directory's is used instead, and that an earlier version stands in for a broken file (whose
 * errors the page lists apart). Empty when the file is in use as written, or invalid.
 */
export function repoTemplateNotes(
  card: Pick<RepoTemplateCard, 'state' | 'lastGood' | 'homeFile' | 'template'>,
): string[] {
  const notes: string[] = [];
  if (card.state === 'shadowed' && card.template) {
    notes.push(shadowedNote(card.template.id, card.homeFile));
  }
  if (card.lastGood) notes.push(lastGoodNote(card.lastGood.sha));
  return notes;
}

function shadowedNote(id: string, homeFile: string | null): string {
  const home = homeFile ?? 'workflows/';
  return t({
    zh: `数据目录里也有 id 为 ${id} 的模板（${home}），这个仓库的 Run 用的是数据目录那份，这份没有生效。想改用仓库里的，就删掉数据目录里的那个文件。`,
    en: `The home directory also has a template with id ${id} (${home}), which is the one this repo's Runs get: this one has no effect. To use the repo's, delete that file from the home directory.`,
  });
}

/** `errors`: why the file fails, told after the note; left out where they are listed apart. */
function lastGoodNote(sha: string, errors?: readonly string[]): string {
  const commit = shortSha(sha);
  return t({
    zh: `目标分支上的这个文件加载失败，继续用上次加载成功的版本（提交 ${commit}），直到把它改好。${errors ? `失败原因：${errors.join('；')}` : ''}`,
    en: `This file as on the target branch fails to load, so the version that last loaded (commit ${commit}) stays in use until it is fixed.${errors ? ` Why it fails: ${errors.join('; ')}` : ''}`,
  });
}

/** Problem of a repo's template file, for the pages that show the repo. */
export interface TemplateProblem {
  /** "<repo>:.ares1/workflows/<file>". */
  file: string;
  /** `danger`: nothing loaded from the file; `attention`: it loaded, but read the text. */
  tone: 'danger' | 'attention';
  text: string;
}

/**
 * The problems of the templates a repo keeps, in file order: files nothing loaded from, files an
 * earlier version stands in for, files the home directory overrides, and the templates' warnings.
 * Empty for a repo without problems or without templates of its own.
 */
export function repoTemplateProblems(
  view: Pick<ConfigView, 'repoTemplates' | 'templateFiles'>,
  repo: string,
): TemplateProblem[] {
  const group = repoTemplateGroups(view).find((g) => g.repo === repo);
  const sep = t({ zh: '；', en: '; ' });
  const problems: TemplateProblem[] = [];
  for (const card of group?.cards ?? []) {
    const file = card.path;
    if (card.state === 'invalid') {
      problems.push({ file, tone: 'danger', text: card.errors.join(sep) });
      continue;
    }
    if (card.lastGood) {
      const text = lastGoodNote(card.lastGood.sha, card.lastGood.errors);
      problems.push({ file, tone: 'attention', text });
    }
    if (card.state === 'shadowed' && card.template) {
      problems.push({
        file,
        tone: 'attention',
        text: shadowedNote(card.template.id, card.homeFile),
      });
    }
    for (const w of card.warnings) problems.push({ file, tone: 'attention', text: w });
  }
  return problems;
}

/**
 * The template a repo's Runs get by id, as the Master finds it (`resolveTemplate`): the home
 * directory's first, then the repo's own. Null when neither has it.
 */
export function findRepoTemplate(
  view: Pick<ConfigView, 'templates' | 'repoTemplates'>,
  repo: string,
  id: string,
): { template: WorkflowTemplate; source: TemplateSource } | null {
  const own = view.repoTemplates.find((r) => r.repo === repo);
  return resolveTemplate(id, byId(view.templates), own && byId(own.templates));
}

/** The template a repo's Runs get by id (`findRepoTemplate`), and the file it comes from. */
export interface RepoTemplateChoice {
  template: WorkflowTemplate;
  source: TemplateSource;
  /**
   * As the config page names it: "workflows/<file>" in the home directory, or
   * "<repo>:.ares1/workflows/<file>"; null when not known.
   */
  file: string | null;
}

export function repoTemplateChoice(
  view: Pick<ConfigView, 'templates' | 'templateFiles' | 'repoTemplates'>,
  repo: string,
  id: string,
): RepoTemplateChoice | null {
  const found = findRepoTemplate(view, repo, id);
  if (!found) return null;
  if (found.source === 'home') {
    const file = view.templateFiles.find((f) => f.templateId === id);
    return { ...found, file: file?.key ?? null };
  }
  const own = view.repoTemplates.find((r) => r.repo === repo);
  const file = own?.files.find((f) => f.templateId === id);
  return { ...found, file: file ? repoFilePath(repo, file) : null };
}

/** Where a repo's template comes from, worded in the language in use. */
export function templateSourceText(choice: Pick<RepoTemplateChoice, 'source' | 'file'>): string {
  const where = choice.file ?? '';
  if (choice.source === 'home') {
    return where
      ? t({ zh: `数据目录的 ${where}`, en: `${where} in the home directory` })
      : t({ zh: '数据目录', en: 'the home directory' });
  }
  return where
    ? t({ zh: `仓库自带的 ${where}`, en: `the repo's own ${where}` })
    : t({ zh: '仓库自带', en: "the repo's own" });
}

function byId(templates: readonly WorkflowTemplate[]): Map<string, WorkflowTemplate> {
  return new Map(templates.map((x) => [x.id, x]));
}

/**
 * Warnings about config.yaml itself, e.g. unknown keys that were ignored, or a repo that
 * auto-accepts size L with a template that cannot split it.
 */
export function configFileWarnings(view: ConfigView): string[] {
  return view.warnings['config.yaml'] ?? [];
}

/** Key prefix of the problems of config.yaml's entries, as in "config.yaml#gitlab.repos.app". */
const CONFIG_ENTRY = 'config.yaml#';

/**
 * Entries of config.yaml that are disabled, each by where it is in the file (e.g.
 * "gitlab.repos.app": a repo of GitHub, GitLab or the local backlog), with why, in key order.
 */
export function configEntryErrors(
  view: Pick<ConfigView, 'errors'>,
): { entry: string; errors: string[] }[] {
  return Object.entries(view.errors)
    .filter(([key]) => key.startsWith(CONFIG_ENTRY))
    .map(([key, errors]) => ({ entry: key.slice(CONFIG_ENTRY.length), errors }))
    .sort((a, b) => (a.entry < b.entry ? -1 : a.entry > b.entry ? 1 : 0));
}

/** DOM id of a template's card, the target of 「查看全部模板」. */
export const templateAnchor = (id: string): string => `template-${id}`;

export interface AgentRow {
  id: string;
  state: AgentEntry['state'];
  /** null when the entry is invalid and does not say. */
  cli: string | null;
  model: string | null;
  /** null: the CLI default for a valid entry, unknown for an invalid one. */
  effort: string | null;
  tier: string | null;
  cost: string | null;
  tags: string[];
  /** Why the agent is not in use; null when it is. */
  reason: string | null;
  /** What to know about a valid agent, e.g. a setting its CLI cannot honor exactly. */
  warnings: string[];
}

/** A badge whose label is picked in the language in use when read, not at import. */
function badge(zh: string, en: string, tone: Tone): { readonly label: string; tone: Tone } {
  return {
    get label() {
      return t({ zh, en });
    },
    tone,
  };
}

export const REPO_TEMPLATE_STATE: Record<
  RepoTemplateState,
  { readonly label: string; tone: Tone }
> = {
  valid: badge('有效', 'Valid', 'success'),
  shadowed: badge('被数据目录覆盖，没有生效', 'Overridden by the home directory', 'muted'),
  invalid: badge('无效，未加载', 'Invalid, not loaded', 'danger'),
};

export const AGENT_STATE: Record<AgentEntry['state'], { readonly label: string; tone: Tone }> = {
  enabled: badge('启用', 'Enabled', 'success'),
  disabled: badge('停用', 'Disabled', 'muted'),
  invalid: badge('无效', 'Invalid', 'danger'),
};

/**
 * Which CLIs an agent's `cli` may name, and which of them can run an agent read-only, in the
 * language in use; null when the Master told none.
 */
export function cliNote(clis: readonly CliInfo[]): string | null {
  if (clis.length === 0) return null;
  const all = join(clis.map((c) => c.cli));
  const readOnly = join(clis.filter((c) => c.readOnly).map((c) => c.cli));
  if (!readOnly) {
    return t({
      zh: `cli 可以写 ${all}。其中没有能以只读方式运行的，所以需求评估、拆分任务和侦察都没法做。`,
      en: `cli can be ${all}. No CLI here can run read-only, so assessments, task plans and scouts cannot run.`,
    });
  }
  return t({
    zh: `cli 可以写 ${all}。需求评估、拆分任务和侦察以只读方式运行，只能用 ${readOnly} 的 Agent。`,
    en: `cli can be ${all}. Assessments, task plans and scouts run read-only, which only agents of ${readOnly} can do.`,
  });
}

/** One table row per agents.yaml entry, in file order. */
export function agentRows(view: ConfigView): AgentRow[] {
  return view.agentEntries.map(agentRow);
}

/** The table row of one agents.yaml entry (also used by the 「Agent」 page). */
export function agentRow(entry: AgentEntry): AgentRow {
  const c = entry.config;
  return {
    id: entry.id,
    state: entry.state,
    cli: c?.cli ?? entry.rawCli,
    model: c?.model ?? entry.rawModel,
    effort: c ? (agentEffort(c) ?? null) : null,
    tier: c?.tier ?? null,
    cost: c?.cost ?? null,
    tags: c?.tags ?? [],
    reason:
      entry.state === 'invalid'
        ? entry.errors.join(t({ zh: '；', en: '; ' })) ||
          t({ zh: '配置无效', en: 'Invalid configuration' })
        : entry.state === 'disabled'
          ? t({ zh: '配置了 enabled: false', en: 'Set to enabled: false' })
          : null,
    warnings: entry.state === 'invalid' ? [] : entry.warnings,
  };
}
