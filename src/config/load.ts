import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { join as joinList, type Lang, setLang, t } from '../i18n.js';
import { defaultAgentsYaml, defaultConfigYaml, defaultSelfDevYaml } from './defaults.js';
import { autoAcceptsL, conflictTarget, failTarget, runsAgent, templateSplits } from './flow.js';
import {
  type AgentConfig,
  type AgentEntry,
  AgentSchema,
  AgentsFileSchema,
  type Escalate,
  type GitHubRepoConfig,
  type MasterConfig,
  MasterConfigSchema,
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
 * language in use.
 */
export function initHome(paths: HomePaths): void {
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
  if (readdirSync(paths.workflowsDir).length === 0) {
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
  /** Valid templates (may still carry warnings). */
  templates: Map<string, WorkflowTemplate>;
  /** Problems keyed by "agents.yaml#<id>" or "workflows/<file>". Those items are disabled. */
  errors: Record<string, string[]>;
  /** Problems that disable nothing, keyed by "config.yaml" or "workflows/<file>". */
  warnings: Record<string, string[]>;
  /** The configuration directory (Master home). */
  dir: string;
  configFile: SourceFile;
  agentsFile: SourceFile;
  /** Every entry of agents.yaml, including disabled and invalid ones, in file order. */
  agentEntries: AgentEntry[];
  /** Every file in workflows/, including invalid ones, sorted by file name. */
  templateFiles: TemplateFile[];
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
 * @param knownClis CLIs with an adapter; agents of other CLIs are invalid.
 * @param readOnlyClis CLIs whose adapter can run an agent read-only, as assess stages need.
 */
export function loadConfig(
  paths: HomePaths,
  knownClis: readonly string[],
  readOnlyClis: readonly string[] = [],
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
    const entry: TemplateFile = {
      key,
      file,
      path,
      source: '',
      templateId: null,
      errors: [],
      warnings: [],
    };
    templateFiles.push(entry);
    let raw: unknown;
    try {
      entry.source = readSource(path) ?? '';
      raw = parseSource(entry.source, key);
    } catch (err) {
      entry.errors = errors[key] = [(err as Error).message];
      continue;
    }
    const parsed = TemplateSchema.safeParse(raw);
    if (!parsed.success) {
      entry.errors = errors[key] = formatZod(parsed.error);
      continue;
    }
    const result = validateTemplate(parsed.data, agents, readOnlyClis);
    if (templates.has(parsed.data.id)) {
      result.errors.push(
        t({
          zh: `模板 id ${parsed.data.id} 与其他模板重复`,
          en: `Template id ${parsed.data.id} is used by another template`,
        }),
      );
    }
    if (result.warnings.length > 0) entry.warnings = warnings[key] = result.warnings;
    if (result.errors.length > 0) {
      entry.errors = errors[key] = result.errors;
      continue;
    }
    entry.templateId = parsed.data.id;
    templates.set(parsed.data.id, parsed.data);
  }

  // GitHub repos refer to templates and agents; a broken reference disables that repo only.
  // Settings that work but likely not as meant only add to config.yaml's warnings.
  const repoWarnings: string[] = [];
  for (const [name, repo] of Object.entries(master.github?.repos ?? {})) {
    const problems: string[] = [];
    const template = templates.get(repo.template);
    if (!template) {
      problems.push(
        t({
          zh: `模板 ${repo.template} 不存在或无效`,
          en: `Template ${repo.template} does not exist or is invalid`,
        }),
      );
    } else if (wholeLAutoAccepted(repo.auto_accept, template)) {
      repoWarnings.push(
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
    if (problems.length > 0) errors[githubConfigKey(name)] = problems;
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
  };
}

/**
 * Whether a repo auto-accepts size L proposals with a template that cannot split them into steps
 * (`templateSplits`), so a whole L requirement would go to one Run unseen by a human.
 */
function wholeLAutoAccepted(
  limits: GitHubRepoConfig['auto_accept'],
  template: WorkflowTemplate,
): boolean {
  return autoAcceptsL(limits) && !templateSplits(template);
}

/** Key of a GitHub repo's problems in `errors`. */
export function githubConfigKey(repoName: string): string {
  return `config.yaml#github.repos.${repoName}`;
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
 * strict (unlike github, notify and upgrade), so a typo such as `upgarde:` would silently
 * leave a setting off. Only warned about, so an existing config.yaml still starts the Master.
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
        zh: 'on_budget_exceeded: pause：Run 花费达到预算（budget_usd）后会卡住等人调高预算，没人在场时就停在那里。建议改成 abort：结束 Run、标为失败，从 issue 来的 Run 会在 max_run_attempts 和 daily_budget_usd 的限制内自动重做',
        en: 'on_budget_exceeded: pause: once a Run has spent its budget (budget_usd), it waits for a human to raise the budget, stuck while nobody is around. Better use abort: the Run ends as failed, and a Run from an issue is redone within max_run_attempts and daily_budget_usd',
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
 * Checks that need more than the schema: references between stages and agents,
 * and features that are not implemented yet in this milestone.
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
    if (s.agent_candidates) {
      errors.push(
        where({
          zh: 'agent_candidates（按难度选 Agent）尚未实现，请改用 agent',
          en: 'agent_candidates (choosing agents by difficulty) is not implemented yet, use agent',
        }),
      );
    }
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
      if (s.agent) {
        errors.push(
          where({
            zh: 'placeholder（占位）阶段不执行任何操作，不能指定 agent',
            en: 'a placeholder stage does nothing and cannot have an agent',
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
      if (s.agent) {
        errors.push(
          where({
            zh: 'merge 阶段由 Master 执行，不能指定 agent',
            en: 'the Master runs the merge stage, it cannot have an agent',
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
    if (!s.agent) {
      errors.push(where({ zh: '需要指定 agent', en: 'an agent is required' }));
      return;
    }
    const agent = agents.get(s.agent);
    if (!agent) {
      errors.push(
        where({
          zh: `Agent ${s.agent} 不存在或未启用`,
          en: `agent ${s.agent} does not exist or is disabled`,
        }),
      );
      return;
    }
    if (s.kind === 'assess' && !readOnlyClis.includes(agent.cli)) {
      errors.push(
        where({
          zh: `assess（需求评估）阶段要以只读方式运行，Agent ${s.agent} 的 CLI ${agent.cli} 不支持，请换用 ${readOnlyClis.join('、') || '支持只读的 CLI'} 的 Agent`,
          en: `an assess stage runs read-only, which the CLI ${agent.cli} of agent ${s.agent} does not support; use an agent of ${readOnlyClis.join(', ') || 'a CLI that supports read-only'}`,
        }),
      );
    }
    // auto splits only some Runs, but any of them may need the read-only run.
    if (s.kind === 'agent' && s.planning !== 'single' && !readOnlyClis.includes(agent.cli)) {
      errors.push(
        where({
          zh: `planning: ${s.planning} 先以只读方式运行阶段的 Agent 来拆分任务，Agent ${s.agent} 的 CLI ${agent.cli} 不支持，请换用 ${readOnlyClis.join('、') || '支持只读的 CLI'} 的 Agent`,
          en: `planning: ${s.planning} first runs the stage's agent read-only to split the stage into tasks, which the CLI ${agent.cli} of agent ${s.agent} does not support; use an agent of ${readOnlyClis.join(', ') || 'a CLI that supports read-only'}`,
        }),
      );
    }
  });

  // The reviewer should differ from the agents it reviews, or it reviews its own work.
  tpl.stages.forEach((s, idx) => {
    if (s.kind !== 'review' || !s.agent) return;
    const reviewed = tpl.stages
      .slice(0, idx)
      .filter((p) => p.kind === 'agent' && p.agent)
      .map((p) => p.agent);
    if (reviewed.includes(s.agent)) {
      warnings.push(
        t({
          zh: `阶段 ${s.id}：评审 Agent ${s.agent} 与编码 Agent 相同，建议换一个`,
          en: `Stage ${s.id}: reviewer ${s.agent} is also the coding agent; better use another one`,
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
        zh: `阶段 ${s.id}：合并阶段${where}。合并目标分支的最新代码发生冲突时，没有 Agent 能解决，Run 会直接结束、标为失败，从 issue 来的 Run 会在 max_run_attempts 的限制内基于目标分支的最新代码自动重做。想让 Agent 解决冲突，就把 on_fail 指向一个 Agent 阶段（kind: agent）`,
        en: `Stage ${s.id}: the merge stage ${where}. When merging the latest target branch runs into conflicts, no agent can resolve them, so the Run ends as failed, and a Run from an issue is redone on the latest target branch within max_run_attempts. To have an agent resolve conflicts, point on_fail at an agent stage (kind: agent)`,
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
