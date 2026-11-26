import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { join as joinList, type Lang, setLang, t } from '../i18n.js';
import { defaultAgentsYaml, defaultConfigYaml, defaultSelfDevYaml } from './defaults.js';
import {
  autoAcceptsL,
  conflictTarget,
  failTarget,
  REPO_WORKFLOWS_DIR,
  type RequirementSource,
  resolveTemplate,
  runsAgent,
  stageAgentIds,
  type TemplateSource,
  templateSplits,
} from './flow.js';
import {
  type AgentConfig,
  type AgentEntry,
  AgentSchema,
  AgentsFileSchema,
  type Escalate,
  type MasterConfig,
  MasterConfigSchema,
  type ProposalSourceConfig,
  type SourceFile,
  type TemplateFile,
  TemplateSchema,
  type WorkflowTemplate,
} from './schema.js';

export class ConfigError extends Error {}

export interface HomePaths {
  home: string;
  configFile: string;
  agentsFile: string;
  workflowsDir: string;
  worktreesDir: string;
  dataDir: string;
  dbFile: string;
  logsDir: string;
  artifactsDir: string;
  /** gh's config directory for agents and their commands: kept empty, so gh has no login. */
  agentGhConfigDir: string;
}

export function homePaths(home: string): HomePaths {
  const dataDir = join(home, 'data');
  return {
    home,
    configFile: join(home, 'config.yaml'),
    agentsFile: join(home, 'agents.yaml'),
    workflowsDir: join(home, 'workflows'),
    worktreesDir: join(home, 'worktrees'),
    dataDir,
    dbFile: join(dataDir, 'ares1.db'),
    logsDir: join(dataDir, 'logs'),
    artifactsDir: join(dataDir, 'artifacts'),
    agentGhConfigDir: join(dataDir, 'agent-gh-config'),
  };
}

/**
 * Create the home layout and write default config files that do not exist yet, in the
 * language in use. The default template is written only into a new workflows/: one left empty
 * had its templates deleted on purpose, e.g. to use those the repos keep in .ares1/workflows/,
 * and a template written there again at the next start would override the repo's.
 */
export function initHome(paths: HomePaths): void {
  const newWorkflows = !existsSync(paths.workflowsDir);
  for (const dir of [
    paths.home,
    paths.workflowsDir,
    paths.worktreesDir,
    paths.dataDir,
    paths.logsDir,
    paths.artifactsDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  writeIfMissing(paths.configFile, defaultConfigYaml());
  writeIfMissing(paths.agentsFile, defaultAgentsYaml());
  if (newWorkflows) {
    writeFileSync(join(paths.workflowsDir, 'self-dev.yaml'), defaultSelfDevYaml());
  }
}

function writeIfMissing(file: string, content: string): void {
  if (!existsSync(file)) writeFileSync(file, content);
}

export interface LoadedConfig {
  master: MasterConfig;
  /** Valid and enabled agents. */
  agents: Map<string, AgentConfig>;
  /** Valid templates of the home directory (may still carry warnings). */
  templates: Map<string, WorkflowTemplate>;
  /**
   * Problems keyed by "agents.yaml#<id>", "workflows/<file>", a repo's
   * "<repo>:.ares1/workflows/<file>", or a repo's requirements source in config.yaml
   * (`githubConfigKey` / `gitlabConfigKey` / `backlogConfigKey`). Those items are disabled; a
   * repo named in more than one source is an error of every source after the first in the order
   * github, gitlab, backlog, so that only the first keeps it.
   */
  errors: Record<string, string[]>;
  /** Problems that disable nothing, keyed by "config.yaml" or a template file's key. */
  warnings: Record<string, string[]>;
  /** The configuration directory (Master home). */
  dir: string;
  configFile: SourceFile;
  agentsFile: SourceFile;
  /** Every entry of agents.yaml, including disabled and invalid ones, in file order. */
  agentEntries: AgentEntry[];
  /** Every file in workflows/, including invalid ones, sorted by file name. */
  templateFiles: TemplateFile[];
  /**
   * The templates registered repos keep in their own .ares1/workflows/, by repo name: those of
   * the repos whose files were given to `loadConfig`. Each is seen by its own repo only.
   */
  repoTemplates: Map<string, RepoTemplates>;
}

/** The files of a repo's .ares1/workflows/ as committed on its target branch. */
export interface RepoTemplateSource {
  branch: string;
  /** The commit of `branch` they were read from. */
  sha: string;
  /** Sorted by file name. */
  files: readonly { file: string; source: string }[];
}

/** The templates a repo keeps in its own .ares1/workflows/, loaded. */
export interface RepoTemplates {
  /** The repo's name. */
  repo: string;
  branch: string;
  sha: string;
  /** Templates in use (may still carry warnings), including earlier versions (`lastGood`). */
  templates: Map<string, WorkflowTemplate>;
  /** Every file, including invalid ones, sorted by file name. */
  files: TemplateFile[];
}

export interface LoadOptions {
  /** Each repo's template files, by repo name; repos left out have none. */
  repoSources?: ReadonlyMap<string, RepoTemplateSource>;
  /** The configuration loaded before, whose repo templates stand in for files that now fail. */
  previous?: LoadedConfig;
}

/**
 * Load all configuration. An invalid config.yaml throws (the Master refuses to start);
 * an invalid agent or template is only disabled and reported in `errors`.
 */
/** CLIs whose effort is part of the model name, so an `effort` field would be ignored. */
function effortInModelName(cli: string): string | undefined {
  if (cli !== 'cursor-agent') return undefined;
  return t({
    zh: 'cursor-agent 的 effort 包含在模型名里（如 grok-4.7-high），请写进 model，不要配置 effort 字段',
    en: "cursor-agent's effort is part of the model name (e.g. grok-4.7-high): put it in model and do not set the effort field",
  });
}

/**
 * Settings of a valid agent its CLI cannot honor exactly. Codex has no "edits only" mode: its
 * adapter runs "safe" in the same sandbox as "full", without network access.
 */
function agentWarnings(agent: { cli: string; permission: string }): string[] {
  if (agent.cli !== 'codex' || agent.permission !== 'safe') return [];
  return [
    t({
      zh: 'Codex 没有「只改文件、不执行命令」的模式：permission: safe 时它在工作目录可写的沙箱里运行（不能联网），仍然能执行命令。只用它做需求评估、拆分任务和侦察（都以只读方式运行）时不受影响，可以去掉 permission: safe 消除这条警告',
      en: 'Codex has no "edits only, no commands" mode: with permission: safe it runs in the workspace-write sandbox (no network access) and can still run commands. Agents used only to assess, plan and scout (which run read-only) are not affected; remove permission: safe to get rid of this warning',
    }),
  ];
}

/**
 * @param knownClis CLIs with an adapter; agents of other CLIs are invalid.
 * @param readOnlyClis CLIs whose adapter can run an agent read-only, as assess stages need.
 * @param options the repos' own template files, and the configuration loaded before them.
 */
export function loadConfig(
  paths: HomePaths,
  knownClis: readonly string[],
  readOnlyClis: readonly string[] = [],
  options: LoadOptions = {},
): LoadedConfig {
  const errors: Record<string, string[]> = {};
  const warnings: Record<string, string[]> = {};

  const { master, warnings: masterWarnings } = parseMaster(paths.configFile);
  if (masterWarnings.length > 0) warnings['config.yaml'] = masterWarnings;

  const agents = new Map<string, AgentConfig>();
  const agentEntries: AgentEntry[] = [];
  const agentsRaw = readYaml(paths.agentsFile, 'agents.yaml');
  const agentsFile = AgentsFileSchema.safeParse(agentsRaw ?? {});
  if (!agentsFile.success) {
    errors['agents.yaml'] = formatZod(agentsFile.error);
  } else {
    for (const [id, raw] of Object.entries(agentsFile.data.agents)) {
      const key = `agents.yaml#${id}`;
      const entry: AgentEntry = {
        id,
        state: 'invalid',
        config: null,
        rawCli: rawString(raw, 'cli'),
        rawModel: rawString(raw, 'model'),
        errors: [],
        warnings: [],
      };
      agentEntries.push(entry);
      const parsed = AgentSchema.safeParse(raw);
      if (!parsed.success) {
        entry.errors = errors[key] = formatZod(parsed.error);
        continue;
      }
      entry.config = { ...parsed.data, id };
      if (!knownClis.includes(parsed.data.cli)) {
        entry.errors = errors[key] = [
          t({
            zh: `不支持的 cli：${parsed.data.cli}（可用：${knownClis.join('、')}）`,
            en: `Unsupported cli: ${parsed.data.cli} (available: ${knownClis.join(', ')})`,
          }),
        ];
        continue;
      }
      const effortProblem = parsed.data.effort ? effortInModelName(parsed.data.cli) : undefined;
      if (effortProblem) {
        entry.errors = errors[key] = [effortProblem];
        continue;
      }
      entry.warnings = agentWarnings(parsed.data);
      if (entry.warnings.length > 0) warnings[key] = entry.warnings;
      entry.state = parsed.data.enabled ? 'enabled' : 'disabled';
      if (parsed.data.enabled) agents.set(id, entry.config);
    }
  }

  const templates = new Map<string, WorkflowTemplate>();
  const templateFiles: TemplateFile[] = [];
  const files = existsSync(paths.workflowsDir)
    ? readdirSync(paths.workflowsDir)
        .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
        .sort()
    : [];
  for (const file of files) {
    const key = `workflows/${file}`;
    const path = join(paths.workflowsDir, file);
    let source = '';
    let loaded: TemplateLoad;
    try {
      source = readSource(path) ?? '';
      loaded = loadTemplateSource(source, key, agents, readOnlyClis, templates);
    } catch (err) {
      loaded = { template: null, errors: [(err as Error).message], warnings: [] };
    }
    const entry: TemplateFile = {
      key,
      file,
      path,
      source,
      templateId: loaded.template?.id ?? null,
      errors: loaded.errors,
      warnings: loaded.warnings,
    };
    templateFiles.push(entry);
    if (loaded.template) templates.set(loaded.template.id, loaded.template);
  }
  recordProblems(templateFiles, errors, warnings);

  const repoTemplates = new Map<string, RepoTemplates>();
  for (const [name, source] of options.repoSources ?? []) {
    const previous = options.previous?.repoTemplates.get(name);
    const loaded = loadRepoTemplates(name, source.files, agents, readOnlyClis, previous);
    for (const entry of loaded.files) {
      // The home directory's template wins: this machine's override of the repo's.
      if (entry.templateId !== null && templates.has(entry.templateId)) entry.shadowed = true;
      if (entry.errors.length > 0) errors[entry.key] = entry.errors;
      const told = repoFileWarnings(entry, templateFiles);
      if (told.length > 0) warnings[entry.key] = told;
    }
    repoTemplates.set(name, {
      repo: name,
      branch: source.branch,
      sha: source.sha,
      templates: loaded.templates,
      files: loaded.files,
    });
  }

  // GitHub, GitLab and local backlog repos refer to templates and agents; a broken reference
  // disables that repo only. Settings that work but likely not as meant only add to config.yaml's
  // warnings.
  const repoWarnings: string[] = [];
  const checkSource = (name: string, repo: ProposalSourceConfig): string[] => {
    const checked = proposalSourceProblems(name, repo, { templates, repoTemplates }, agents);
    repoWarnings.push(...checked.warnings);
    return checked.problems;
  };
  // Two sources would both scout and accept for the repo. The first in the order github, gitlab,
  // backlog keeps working as it did, so adding an entry elsewhere by mistake stops nothing; the
  // later entry itself is disabled, and only the conflict is told: its settings are not used
  // either way.
  const githubRepos = master.github?.repos ?? {};
  const gitlabRepos = master.gitlab?.repos ?? {};
  const earlierRepos = { github: githubRepos, gitlab: gitlabRepos };
  const keptSource = (name: string, earlier: readonly (keyof typeof earlierRepos)[]) =>
    earlier.find((source) => Object.hasOwn(earlierRepos[source], name));
  for (const [name, repo] of Object.entries(githubRepos)) {
    const problems = checkSource(name, repo);
    // A pull request needs the Run's branch on GitHub and the target branch pulled back after
    // the merge, which only repos with push do.
    if (repo.deliver === 'pr' && !repo.push) {
      problems.push(
        t({
          zh: 'deliver: pr 要求 push: true：开 PR 要先把 Run 的分支推送到 GitHub，PR 合并后还要从 GitHub 拉取目标分支',
          en: "deliver: pr needs push: true: a pull request needs the Run's branch pushed to GitHub, and the target branch pulled from GitHub once it is merged",
        }),
      );
    }
    if (problems.length > 0) errors[githubConfigKey(name)] = problems;
  }
  for (const [name, repo] of Object.entries(gitlabRepos)) {
    const kept = keptSource(name, ['github']);
    if (kept) {
      errors[gitlabConfigKey(name)] = [inTwoSources(name, kept, 'gitlab')];
      continue;
    }
    const problems = checkSource(name, repo);
    if (problems.length > 0) errors[gitlabConfigKey(name)] = problems;
  }
  for (const [name, repo] of Object.entries(master.backlog?.repos ?? {})) {
    const kept = keptSource(name, ['github', 'gitlab']);
    if (kept) {
      errors[backlogConfigKey(name)] = [inTwoSources(name, kept, 'backlog')];
      continue;
    }
    const problems = checkSource(name, repo);
    if (problems.length > 0) errors[backlogConfigKey(name)] = problems;
  }
  if (repoWarnings.length > 0) {
    warnings['config.yaml'] = [...(warnings['config.yaml'] ?? []), ...repoWarnings];
  }

  return {
    master,
    agents,
    templates,
    errors,
    warnings,
    dir: paths.home,
    configFile: { path: paths.configFile, source: readSource(paths.configFile) },
    agentsFile: { path: paths.agentsFile, source: readSource(paths.agentsFile) },
    agentEntries,
    templateFiles,
    repoTemplates,
  };
}

/**
 * The template a repo's Runs get by id, and where it comes from (`resolveTemplate`): the home
 * directory's first, then the repo's own. Null when neither has it.
 */
export function findTemplate(
  cfg: Pick<LoadedConfig, 'templates' | 'repoTemplates'>,
  repoName: string,
  id: string,
): { template: WorkflowTemplate; source: TemplateSource } | null {
  return resolveTemplate(id, cfg.templates, cfg.repoTemplates.get(repoName)?.templates);
}

/** Key of a repo's template file in `errors` / `warnings`. */
export function repoTemplateKey(repoName: string, file: string): string {
  return `${repoName}:${REPO_WORKFLOWS_DIR}/${file}`;
}

/**
 * Load a repo's own template files (`files`, as committed) like those of the home directory,
 * except that a file failing to load keeps its template as last loaded (`previous`: this repo's
 * last load) when that version still loads with the agents of now: a broken change on the target
 * branch must not stop the repo's work. The file is then marked with `lastGood`, and its
 * `warnings` are those of that version (`repoFileWarnings` adds what `lastGood` says). A file that
 * never loaded is invalid, as in the home directory. Ids are only checked against the repo's other
 * files, not against the home directory's.
 */
export function loadRepoTemplates(
  repoName: string,
  files: readonly { file: string; source: string }[],
  agents: Map<string, AgentConfig>,
  readOnlyClis: readonly string[],
  previous?: Pick<RepoTemplates, 'sha' | 'files'>,
): { templates: Map<string, WorkflowTemplate>; files: TemplateFile[] } {
  const templates = new Map<string, WorkflowTemplate>();
  const entries: TemplateFile[] = [];
  const sorted = [...files].sort((a, b) => (a.file < b.file ? -1 : 1));
  for (const { file, source } of sorted) {
    const key = repoTemplateKey(repoName, file);
    const entry: TemplateFile = {
      key,
      file,
      path: `${REPO_WORKFLOWS_DIR}/${file}`,
      source,
      templateId: null,
      errors: [],
      warnings: [],
    };
    entries.push(entry);
    const loaded = loadTemplateSource(source, key, agents, readOnlyClis, templates);
    const good = loaded.template ? undefined : lastGood(previous, file);
    const earlier = good && loadTemplateSource(good.source, key, agents, readOnlyClis, templates);
    if (good && earlier?.template) {
      entry.templateId = earlier.template.id;
      entry.lastGood = { ...good, errors: loaded.errors };
      entry.warnings = earlier.warnings;
      templates.set(earlier.template.id, earlier.template);
      continue;
    }
    entry.errors = loaded.errors;
    entry.warnings = loaded.warnings;
    if (loaded.template) {
      entry.templateId = loaded.template.id;
      templates.set(loaded.template.id, loaded.template);
    }
  }
  return { templates, files: entries };
}

/** The version of a repo's file that last loaded, and the commit it was read from. */
function lastGood(
  previous: Pick<RepoTemplates, 'sha' | 'files'> | undefined,
  file: string,
): { sha: string; source: string } | undefined {
  const entry = previous?.files.find((f) => f.file === file);
  if (!previous || !entry || entry.templateId === null) return undefined;
  if (entry.lastGood) return { sha: entry.lastGood.sha, source: entry.lastGood.source };
  return { sha: previous.sha, source: entry.source };
}

/**
 * A repo's file's warnings as the configuration tells them: what `lastGood` says first, then
 * those of the template in use, then what `shadowed` says. The file itself keeps only the middle
 * ones, so that the dashboard can word the other two in its own language.
 */
function repoFileWarnings(entry: TemplateFile, homeFiles: readonly TemplateFile[]): string[] {
  const told = [...entry.warnings];
  if (entry.lastGood) told.unshift(lastGoodWarning(entry.lastGood.sha, entry.lastGood.errors));
  if (entry.shadowed && entry.templateId !== null) {
    told.push(shadowedWarning(entry.templateId, homeFiles));
  }
  return told;
}

function lastGoodWarning(sha: string, errors: readonly string[]): string {
  const commit = sha.slice(0, 7);
  return t({
    zh: `这次加载失败，继续使用上次加载成功的版本（提交 ${commit}）。失败原因：${errors.join('；')}`,
    en: `Failed to load, so the version that last loaded (commit ${commit}) stays in use. Why it failed: ${errors.join('; ')}`,
  });
}

function shadowedWarning(id: string, homeFiles: readonly TemplateFile[]): string {
  const home = homeFiles.find((f) => f.templateId === id)?.key ?? 'workflows/';
  return t({
    zh: `数据目录里也有 id 为 ${id} 的模板（${home}），用的是数据目录那份，仓库里这份没有生效。想改用仓库里的，就删掉数据目录里的那个文件`,
    en: `The home directory also has a template with id ${id} (${home}), which is the one in use: this one in the repo has no effect. To use the repo's, delete that file from the home directory`,
  });
}

/** Copy the problems of template files into `errors` / `warnings`, under their keys. */
function recordProblems(
  files: readonly TemplateFile[],
  errors: Record<string, string[]>,
  warnings: Record<string, string[]>,
): void {
  for (const f of files) {
    if (f.errors.length > 0) errors[f.key] = f.errors;
    if (f.warnings.length > 0) warnings[f.key] = f.warnings;
  }
}

interface TemplateLoad {
  /** Null when the file has an error. */
  template: WorkflowTemplate | null;
  errors: string[];
  warnings: string[];
}

/**
 * Load one template file: its YAML, the schema, `validateTemplate`, and its id against `loaded`,
 * the templates loaded beside it so far. `key` names the file in the problems.
 */
function loadTemplateSource(
  source: string,
  key: string,
  agents: Map<string, AgentConfig>,
  readOnlyClis: readonly string[],
  loaded: ReadonlyMap<string, WorkflowTemplate>,
): TemplateLoad {
  let raw: unknown;
  try {
    raw = parseSource(source, key);
  } catch (err) {
    return { template: null, errors: [(err as Error).message], warnings: [] };
  }
  const parsed = TemplateSchema.safeParse(raw);
  if (!parsed.success) {
    return { template: null, errors: formatZod(parsed.error), warnings: [] };
  }
  const result = validateTemplate(parsed.data, agents, readOnlyClis);
  if (loaded.has(parsed.data.id)) {
    result.errors.push(
      t({
        zh: `模板 id ${parsed.data.id} 与其他模板重复`,
        en: `Template id ${parsed.data.id} is used by another template`,
      }),
    );
  }
  return {
    template: result.errors.length > 0 ? null : parsed.data,
    errors: result.errors,
    warnings: result.warnings,
  };
}

/**
 * What GitHub, GitLab and local backlog repos share, checked against the templates and agents:
 * problems disable the repo; warnings are about settings that work, but likely not as meant.
 */
function proposalSourceProblems(
  name: string,
  repo: ProposalSourceConfig,
  cfg: Pick<LoadedConfig, 'templates' | 'repoTemplates'>,
  agents: Map<string, AgentConfig>,
): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const template = findTemplate(cfg, name, repo.template)?.template;
  if (!template) {
    problems.push(
      t({
        zh: `模板 ${repo.template} 不存在或无效`,
        en: `Template ${repo.template} does not exist or is invalid`,
      }),
    );
  } else if (wholeLAutoAccepted(repo.auto_accept, template)) {
    warnings.push(
      t({
        zh: `仓库 ${name} 会自动采纳大小为 L 的提案（auto_accept.max_size: L），但它用的模板 ${repo.template} 没有 planning: auto 或 llm 的 Agent 阶段：L 的需求会整个交给一个 Run 一次做完，容易超时或返工。建议编码阶段用 planning: auto，或者把 max_size 调成 M，让 L 的提案留给人`,
        en: `Repo ${name} auto-accepts size L proposals (auto_accept.max_size: L), but its template ${repo.template} has no agent stage with planning: auto or llm: an L requirement goes to one Run as a whole, done in one go and likely to time out or need rework. Better set planning: auto on the coding stage, or lower max_size to M to leave L proposals to a human`,
      }),
    );
  }
  if (repo.scout && !agents.has(repo.scout.agent)) {
    problems.push(
      t({
        zh: `侦察用的 Agent ${repo.scout.agent} 不存在或未启用`,
        en: `Scout agent ${repo.scout.agent} does not exist or is disabled`,
      }),
    );
  }
  return { problems, warnings };
}

/**
 * Whether a repo auto-accepts size L proposals with a template that cannot split them into steps
 * (`templateSplits`), so a whole L requirement would go to one Run unseen by a human.
 */
function wholeLAutoAccepted(
  limits: ProposalSourceConfig['auto_accept'],
  template: WorkflowTemplate,
): boolean {
  return autoAcceptsL(limits) && !templateSplits(template);
}

/** Key of a GitHub repo's problems in `errors`. */
export function githubConfigKey(repoName: string): string {
  return `config.yaml#github.repos.${repoName}`;
}

/** Key of a GitLab repo's problems in `errors`. */
export function gitlabConfigKey(repoName: string): string {
  return `config.yaml#gitlab.repos.${repoName}`;
}

/** Key of a local backlog repo's problems in `errors`. */
export function backlogConfigKey(repoName: string): string {
  return `config.yaml#backlog.repos.${repoName}`;
}

/**
 * Why the entry of repo `name` in `dropped`'s repos is disabled: `kept`, a source before it in
 * the order github, gitlab, backlog, has the repo too, and keeps it.
 */
function inTwoSources(name: string, kept: RequirementSource, dropped: RequirementSource): string {
  const k = sourceWords(kept);
  const d = sourceWords(dropped);
  return t({
    zh: `仓库 ${name} 同时写在 ${k.key} 和 ${d.key} 里：一个仓库只能选一种需求来源（GitHub issue、GitLab issue 或本地提案池）。${d.key} 里的设置没有生效，${k.side}照常工作；想${d.use}，就把它从 ${k.key} 里删掉`,
    en: `Repo ${name} is in both ${k.key} and ${d.key}: a repo takes its requirements from one source only (GitHub issues, GitLab issues or the local backlog). The settings in ${d.key} are not in effect and ${k.side} keeps working as before; to ${d.use}, remove the repo from ${k.key}`,
  });
}

/** How `inTwoSources` names a source: its key in config.yaml, its side, and switching to it. */
function sourceWords(source: RequirementSource): { key: string; side: string; use: string } {
  switch (source) {
    case 'github':
      return {
        key: 'github.repos',
        side: t({ zh: 'GitHub 一侧', en: 'GitHub' }),
        use: t({ zh: '改用 GitHub issue', en: 'use GitHub issues instead' }),
      };
    case 'gitlab':
      return {
        key: 'gitlab.repos',
        side: t({ zh: 'GitLab 一侧', en: 'GitLab' }),
        use: t({ zh: '改用 GitLab issue', en: 'use GitLab issues instead' }),
      };
    case 'backlog':
      return {
        key: 'backlog.repos',
        side: t({ zh: '本地提案池一侧', en: 'the local backlog' }),
        use: t({ zh: '改用本地提案池', en: 'use the local backlog instead' }),
      };
  }
}

/** A string field of an unvalidated YAML mapping, or null. */
function rawString(raw: unknown, field: string): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = (raw as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : null;
}

function parseMaster(file: string): { master: MasterConfig; warnings: string[] } {
  const raw = readYaml(file, 'config.yaml');
  const parsed = MasterConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new ConfigError(
      t({ zh: 'config.yaml 无效：\n', en: 'config.yaml is invalid:\n' }) +
        formatZod(parsed.error).join('\n'),
    );
  }
  // The configured language applies from here on, so that the rest of the configuration is
  // reported in it. An invalid config.yaml keeps the language in use.
  applyLanguage(parsed.data.language);
  return { master: parsed.data, warnings: unknownMasterKeys(raw) };
}

/**
 * Keys of config.yaml the schema drops without a word: the top level and `defaults` are not
 * strict (unlike github, gitlab, backlog, notify and upgrade), so a typo such as `upgarde:` would
 * silently leave a setting off. Only warned about, so an existing config.yaml still starts the
 * Master.
 */
function unknownMasterKeys(raw: unknown): string[] {
  const warnings: string[] = [];
  const check = (value: unknown, known: readonly string[], prefix: string) => {
    if (!isMapping(value)) return;
    for (const key of Object.keys(value)) {
      if (known.includes(key)) continue;
      warnings.push(
        t({
          zh: `未知的配置项 ${prefix}${key}，已忽略（是不是写错了？可用：${known.join('、')}）`,
          en: `Unknown setting ${prefix}${key}, ignored (a typo? Available: ${known.join(', ')})`,
        }),
      );
    }
  };
  check(raw, Object.keys(MasterConfigSchema.shape), '');
  if (isMapping(raw)) {
    check(raw.defaults, Object.keys(MasterConfigSchema.shape.defaults.unwrap().shape), 'defaults.');
  }
  return warnings;
}

/**
 * Use a language for every text produced from now on, zod's own validation messages included
 * (they are part of the configuration problems and of what agents are told about their output).
 */
function applyLanguage(l: Lang): void {
  setLang(l);
  z.config(l === 'zh' ? z.locales.zhCN() : z.locales.en());
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSource(file: string): string | null {
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

function readYaml(file: string, label: string): unknown {
  const source = readSource(file);
  return source === null ? undefined : parseSource(source, label);
}

function parseSource(source: string, label: string): unknown {
  try {
    return parseYaml(source);
  } catch (err) {
    const message = t({
      zh: `${label} 不是合法的 YAML：${(err as Error).message}`,
      en: `${label} is not valid YAML: ${(err as Error).message}`,
    });
    if (label === 'config.yaml') throw new ConfigError(message);
    throw new Error(message);
  }
}

function formatZod(error: z.ZodError): string[] {
  const root = t({ zh: '(根)', en: '(root)' });
  return error.issues.map((i) => `${i.path.join('.') || root}: ${i.message}`);
}

/** The escalate options that can make a Run wait for a human, and the value that does. */
const WAITING_OPTIONS = {
  on_agent_error: 'human',
  on_exhausted: 'human',
  on_budget_exceeded: 'pause',
} as const satisfies { [K in keyof Escalate]?: Escalate[K] };

type WaitingOption = keyof typeof WAITING_OPTIONS;

/** Escalate options of `escalate` set to wait for a human, in WAITING_OPTIONS order. */
function waitsForHuman(escalate: Escalate | undefined): WaitingOption[] {
  return (Object.keys(WAITING_OPTIONS) as WaitingOption[]).filter(
    (option) => escalate?.[option] === WAITING_OPTIONS[option],
  );
}

function waitForHumanWarning(option: WaitingOption): string {
  switch (option) {
    case 'on_budget_exceeded':
      return t({
        zh: 'on_budget_exceeded: pause：Run 花费达到预算（budget_usd）后会卡住等人调高预算，没人在场时就停在那里。建议改成 abort：结束 Run、标为失败，从 issue 或单独的本地提案来的 Run 会在 max_run_attempts 和 daily_budget_usd 的限制内自动重做',
        en: 'on_budget_exceeded: pause: once a Run has spent its budget (budget_usd), it waits for a human to raise the budget, stuck while nobody is around. Better use abort: the Run ends as failed, and a Run from an issue or a local proposal of its own is redone within max_run_attempts and daily_budget_usd',
      });
    case 'on_agent_error':
      return t({
        zh: 'on_agent_error: human：Agent 出错时自动重试 max_retries 次后，Run 会卡住等人处理，没人在场时就停在那里。建议改成 switch_agent：重试用完后换另一个 Agent 再试，都不行就结束 Run、标为失败',
        en: 'on_agent_error: human: when an agent errors, the Run is retried max_retries times and then waits for a human, stuck while nobody is around. Better use switch_agent: once the retries are used up another agent tries, and if none succeeds the Run ends as failed',
      });
    case 'on_exhausted':
      return t({
        zh: 'on_exhausted: human：返工 max_retries 次后仍未通过，或回退超过 max_loops 时，Run 会卡住等人处理，没人在场时就停在那里。建议改成 fail：结束 Run、标为失败，从 issue 来的 Run 会带着失败原因自动重做',
        en: 'on_exhausted: human: when a task still fails after max_retries reworks, or the stages roll back more than max_loops times, the Run waits for a human, stuck while nobody is around. Better use fail: the Run ends as failed, and a Run from an issue is redone with the reason it failed',
      });
  }
}

/**
 * Checks that need more than the schema: references between stages and agents, which stages
 * may name agents and which settings go together, and features that are not implemented yet
 * (verify.llm_check).
 */
export function validateTemplate(
  tpl: WorkflowTemplate,
  agents: Map<string, AgentConfig>,
  readOnlyClis: readonly string[] = [],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  for (const s of tpl.stages) {
    if (ids.has(s.id)) {
      errors.push(t({ zh: `阶段 id 重复：${s.id}`, en: `Duplicate stage id: ${s.id}` }));
    }
    ids.add(s.id);
  }

  tpl.stages.forEach((s, idx) => {
    const where = (problem: { zh: string; en: string }) =>
      t({ zh: `阶段 ${s.id}：${problem.zh}`, en: `Stage ${s.id}: ${problem.en}` });
    for (const ref of [s.on_fail, s.on_reject]) {
      if (ref && !ids.has(ref)) {
        errors.push(
          where({ zh: `回退目标 ${ref} 不存在`, en: `rollback target ${ref} does not exist` }),
        );
      }
    }
    if (s.kind === 'command') {
      // The Master runs the commands itself: nothing an agent would use applies.
      const agentOnly = [
        s.agent !== undefined && 'agent',
        s.agent_candidates !== undefined && 'agent_candidates',
        s.planning !== 'single' && `planning: ${s.planning}`,
        s.verify?.llm_check && 'verify.llm_check',
      ].filter((field): field is string => typeof field === 'string');
      if (agentOnly.length > 0) {
        errors.push(
          where({
            zh: `command（命令）阶段只运行命令、不调用 Agent，不能指定 ${joinList(agentOnly)}`,
            en: `a command stage only runs commands and calls no agent, it cannot have ${joinList(agentOnly)}`,
          }),
        );
      }
      if (s.verify?.commands?.length === 0) {
        errors.push(
          where({
            zh: 'command（命令）阶段的 verify.commands 是空列表，没有要运行的命令；不写 verify.commands 时运行仓库登记的检查命令',
            en: "a command stage's verify.commands is an empty list, so there is nothing to run; without verify.commands it runs the repo's verify commands",
          }),
        );
      }
      return;
    }
    // What a stage the Master runs by itself wrongly names; `agent: ""` counts as none.
    const agentFields = [
      s.agent && 'agent',
      s.agent_candidates !== undefined && 'agent_candidates',
    ].filter((field): field is string => typeof field === 'string');
    if (s.planning !== 'single' && s.kind !== 'agent') {
      // Only work that is checked and committed is worth splitting into steps.
      errors.push(
        where({
          zh: `planning: ${s.planning}（拆分任务）只能用在 agent（编码）阶段，${s.kind} 阶段不能用`,
          en: `planning: ${s.planning} (splitting the stage into tasks) only applies to agent stages, not to a ${s.kind} stage`,
        }),
      );
    }
    if (s.verify?.llm_check) {
      errors.push(
        where({
          zh: 'verify.llm_check（LLM 验收判定）尚未实现',
          en: 'verify.llm_check (an LLM judging acceptance) is not implemented yet',
        }),
      );
    }
    if (s.kind === 'placeholder') {
      if (agentFields.length > 0) {
        errors.push(
          where({
            zh: `placeholder（占位）阶段不执行任何操作，不能指定 ${joinList(agentFields)}`,
            en: `a placeholder stage does nothing and cannot have ${joinList(agentFields)}`,
          }),
        );
      }
      if (s.verify?.commands?.length) {
        errors.push(
          where({
            zh: 'placeholder（占位）阶段不执行任何操作，不能配置检查命令',
            en: 'a placeholder stage does nothing and cannot have verify commands',
          }),
        );
      }
      return;
    }
    if (s.kind === 'merge') {
      if (agentFields.length > 0) {
        errors.push(
          where({
            zh: `merge 阶段由 Master 执行，不能指定 ${joinList(agentFields)}`,
            en: `the Master runs the merge stage, it cannot have ${joinList(agentFields)}`,
          }),
        );
      }
      if (idx !== tpl.stages.length - 1) {
        errors.push(
          where({
            zh: 'merge 阶段必须是最后一个阶段',
            en: 'the merge stage must be the last stage',
          }),
        );
      }
      return;
    }
    if (s.kind === 'assess' && s.verify?.commands?.length) {
      errors.push(
        where({
          zh: 'assess（需求评估）阶段只读，不改代码，不能配置检查命令',
          en: 'an assess stage is read-only and changes no code, it cannot have verify commands',
        }),
      );
    }
    if (s.agent !== undefined && s.agent_candidates !== undefined) {
      errors.push(
        where({
          zh: 'agent 和 agent_candidates 只能写一个：agent 总用同一个 Agent，agent_candidates 按需求的难度从候选里挑',
          en: "agent and agent_candidates cannot both be set: agent always uses the same agent, agent_candidates picks one of the candidates by the requirement's difficulty",
        }),
      );
      return;
    }
    if (s.agent_candidates?.length === 0) {
      errors.push(
        where({
          zh: 'agent_candidates 是空列表，没有可选的 Agent',
          en: 'agent_candidates is an empty list, so there is no agent to pick',
        }),
      );
      return;
    }
    const candidates = stageAgentIds(s);
    if (candidates.length === 0) {
      errors.push(
        where({
          zh: '需要指定 agent，或者用 agent_candidates 列出按难度挑选的候选 Agent',
          en: 'an agent is required, or agent_candidates listing the agents to pick from by difficulty',
        }),
      );
      return;
    }
    const repeated = [...new Set(candidates.filter((id, i) => candidates.indexOf(id) !== i))];
    if (repeated.length > 0) {
      errors.push(
        where({
          zh: `agent_candidates 里 ${joinList(repeated)} 写了不止一次`,
          en: `agent_candidates lists ${joinList(repeated)} more than once`,
        }),
      );
    }
    for (const id of new Set(candidates)) {
      const agent = agents.get(id);
      if (!agent) {
        errors.push(
          where({
            zh: `Agent ${id} 不存在或未启用`,
            en: `agent ${id} does not exist or is disabled`,
          }),
        );
        continue;
      }
      // Any candidate may be the one chosen, so each must be able to run read-only where the
      // stage needs it.
      if (s.kind === 'assess' && !readOnlyClis.includes(agent.cli)) {
        errors.push(
          where({
            zh: `assess（需求评估）阶段要以只读方式运行，Agent ${id} 的 CLI ${agent.cli} 不支持，请换用 ${readOnlyClis.join('、') || '支持只读的 CLI'} 的 Agent`,
            en: `an assess stage runs read-only, which the CLI ${agent.cli} of agent ${id} does not support; use an agent of ${readOnlyClis.join(', ') || 'a CLI that supports read-only'}`,
          }),
        );
      }
      // auto splits only some Runs, but any of them may need the read-only run.
      if (s.kind === 'agent' && s.planning !== 'single' && !readOnlyClis.includes(agent.cli)) {
        errors.push(
          where({
            zh: `planning: ${s.planning} 先以只读方式运行阶段的 Agent 来拆分任务，Agent ${id} 的 CLI ${agent.cli} 不支持，请换用 ${readOnlyClis.join('、') || '支持只读的 CLI'} 的 Agent`,
            en: `planning: ${s.planning} first runs the stage's agent read-only to split the stage into tasks, which the CLI ${agent.cli} of agent ${id} does not support; use an agent of ${readOnlyClis.join(', ') || 'a CLI that supports read-only'}`,
          }),
        );
      }
    }
  });

  // The reviewer should differ from the agents it reviews, or it reviews its own work. With
  // candidates, any of a review's may meet any of the coding stages' before it.
  tpl.stages.forEach((s, idx) => {
    if (s.kind !== 'review') return;
    const coders = new Set(
      tpl.stages
        .slice(0, idx)
        .filter((p) => p.kind === 'agent')
        .flatMap(stageAgentIds),
    );
    const both = [...new Set(stageAgentIds(s).filter((id) => coders.has(id)))];
    if (both.length > 0) {
      const list = joinList(both);
      warnings.push(
        t({
          zh: `阶段 ${s.id}：评审 Agent ${list} 与编码 Agent 相同，建议换一个`,
          en:
            both.length === 1
              ? `Stage ${s.id}: reviewer ${list} is also a coding agent; better use another one`
              : `Stage ${s.id}: reviewers ${list} are also coding agents; better use others`,
        }),
      );
    }
  });

  // The engine silently skips an input no stage produced, so the agent misses it unnoticed.
  // A later stage's artifact can be read after a rollback: only whether some stage produces
  // the name matters, not the order.
  const produced = producedArtifacts(tpl);
  const available = joinList([...produced, 'diff']);
  for (const s of tpl.stages) {
    for (const name of new Set(s.inputs)) {
      if (name === 'diff' || produced.includes(name)) continue;
      warnings.push(
        t({
          zh: `阶段 ${s.id}：inputs 里的 ${name} 没有阶段会产出，不会放进提示词（可用：${available}）`,
          en: `Stage ${s.id}: no stage produces ${name} in inputs, so it is left out of the prompt (available: ${available})`,
        }),
      );
    }
  }

  // With an assess stage, the requirement as revised in the discussion only reaches the
  // stages after it through `inputs: [assessment]`; without it they work from the original.
  const assessIdx = tpl.stages.findIndex((s) => s.kind === 'assess');
  if (assessIdx >= 0) {
    for (const s of tpl.stages.slice(assessIdx + 1)) {
      if (s.kind !== 'agent' && s.kind !== 'review') continue;
      if (s.inputs.includes('assessment')) continue;
      warnings.push(
        t({
          zh: `阶段 ${s.id}：模板有需求评估阶段，但这个阶段的 inputs 没有 assessment，讨论后修改的需求不会交给它`,
          en: `Stage ${s.id}: the template has an assess stage but this stage's inputs lack assessment, so it will not get the requirement as revised in the discussion`,
        }),
      );
    }
  }

  // Only an assessment asks a human questions, so only it waits for replies.
  for (const s of tpl.stages) {
    if (s.kind === 'assess' || s.reply_timeout_hours === undefined) continue;
    warnings.push(
      t({
        zh: `阶段 ${s.id}：reply_timeout_hours 只对需求评估阶段（kind: assess）有效，这里不起作用`,
        en: `Stage ${s.id}: reply_timeout_hours only applies to assess stages (kind: assess) and has no effect here`,
      }),
    );
  }

  // Only an agent can resolve a merge conflict. Without one to go back to, a conflict ends the
  // Run, to be redone on the latest target branch: valid, but the template's author may expect
  // the agent to resolve it.
  for (const s of tpl.stages) {
    if (s.kind !== 'merge' || conflictTarget(tpl, s.id) !== null) continue;
    const back = failTarget(tpl, s.id);
    // An on_fail naming no stage is already an error.
    if (back === null || !ids.has(back)) continue;
    const where =
      back === s.id
        ? t({ zh: '失败时没有可回退的 Agent 阶段', en: 'has no agent stage to go back to' })
        : t({
            zh: `失败时回退到的 ${back} 不是 Agent 阶段`,
            en: `goes back to ${back} when it fails, which is not an agent stage`,
          });
    warnings.push(
      t({
        zh: `阶段 ${s.id}：合并阶段${where}。合并目标分支的最新代码发生冲突时，没有 Agent 能解决，Run 会直接结束、标为失败，从 issue 或单独的本地提案来的 Run 会在 max_run_attempts 的限制内基于目标分支的最新代码自动重做。想让 Agent 解决冲突，就把 on_fail 指向一个 Agent 阶段（kind: agent）`,
        en: `Stage ${s.id}: the merge stage ${where}. When merging the latest target branch runs into conflicts, no agent can resolve them, so the Run ends as failed, and a Run from an issue or a local proposal of its own is redone on the latest target branch within max_run_attempts. To have an agent resolve conflicts, point on_fail at an agent stage (kind: agent)`,
      }),
    );
  }

  // A failed command is only fixed by an agent that reads its output and changes the code.
  // Going back anywhere else runs the same code again, which passes only if the failure was
  // flaky, until max_loops ends the Run: valid, but most likely not what the author meant.
  for (const s of tpl.stages) {
    if (s.kind !== 'command') continue;
    const back = failTarget(tpl, s.id);
    // An on_fail naming no stage is already an error.
    if (back === null || !ids.has(back)) continue;
    if (tpl.stages.find((p) => p.id === back)?.kind === 'agent') continue;
    const where =
      back === s.id
        ? t({ zh: '失败时没有可回退的 Agent 阶段', en: 'has no agent stage to go back to' })
        : t({
            zh: `失败时回退到的 ${back} 不是 Agent 阶段`,
            en: `goes back to ${back} when it fails, which is not an agent stage`,
          });
    warnings.push(
      t({
        zh: `阶段 ${s.id}：命令阶段${where}。命令失败后没有 Agent 按失败输出修改代码，只会重新运行同样的代码，直到超过 max_loops。想让 Agent 修复，就把 on_fail 指向一个 Agent 阶段（kind: agent）`,
        en: `Stage ${s.id}: the command stage ${where}. After a command fails, no agent changes the code by its output, so the same code runs again until max_loops is reached. To have an agent fix it, point on_fail at an agent stage (kind: agent)`,
      }),
    );
  }

  // "human" (or "pause" over budget) is a valid choice, but a Run waiting for a human stops the
  // system while nobody is around. Only a warning: templates already installed (self-dev used to
  // say human) stay usable.
  for (const option of waitsForHuman(tpl.defaults?.escalate)) {
    warnings.push(`defaults.escalate${t({ zh: '：', en: ': ' })}${waitForHumanWarning(option)}`);
  }
  for (const s of tpl.stages) {
    // No agent runs there, so nothing errors, is reworked or checks the budget; their rollbacks
    // follow the defaults.
    if (!runsAgent(s.kind)) continue;
    for (const option of waitsForHuman(s.escalate)) {
      warnings.push(
        t({
          zh: `阶段 ${s.id}：${waitForHumanWarning(option)}`,
          en: `Stage ${s.id}: ${waitForHumanWarning(option)}`,
        }),
      );
    }
  }

  return { errors, warnings };
}

/**
 * Artifact names the stages of a template produce, in stage order: what `inputs` may name
 * besides `diff`. Mirrors the engine: an agent stage saves its last reply under each of its
 * `outputs`, a review stage saves `review`, an assess stage saves `assessment`; merge,
 * placeholder and command stages save nothing (nor do other stages save their `outputs`).
 */
function producedArtifacts(t: WorkflowTemplate): string[] {
  const names = new Set<string>();
  for (const s of t.stages) {
    if (s.kind === 'agent') for (const name of s.outputs) names.add(name);
    else if (s.kind === 'review') names.add('review');
    else if (s.kind === 'assess') names.add('assessment');
  }
  return [...names];
}
