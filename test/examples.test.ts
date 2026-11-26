import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { defaultSelfDevYaml } from '../src/config/defaults.js';
import { chooseStageAgent } from '../src/config/flow.js';
import { homePaths, loadConfig, validateTemplate } from '../src/config/load.js';
import { TemplateSchema } from '../src/config/schema.js';
import { switchCandidate } from '../src/engine/engine.js';
import { setLang } from '../src/i18n.js';
import { BUILTIN_CLIS, BUILTIN_READ_ONLY_CLIS } from '../src/master.js';
import { DIFFICULTIES, type Difficulty } from '../src/store/types.js';

// docs/examples is laid out like a Master home. Loading it reads config.yaml, agents.yaml and
// workflows/ only and writes nothing, so the directory is used in place.
const examplesDir = fileURLToPath(new URL('../docs/examples/', import.meta.url));

/** The examples as the Master would load them, with the CLIs it has adapters for. */
function loadExamples() {
  return loadConfig(homePaths(examplesDir), BUILTIN_CLIS, BUILTIN_READ_ONLY_CLIS);
}

// config.yaml sets the language in use while loading.
afterEach(() => setLang('zh'));

describe('configuration examples (docs/examples)', () => {
  it('load without any error or warning', () => {
    expect(BUILTIN_CLIS).toEqual(['claude-code', 'cursor-agent', 'codex']);
    expect(BUILTIN_READ_ONLY_CLIS).toEqual(['claude-code', 'codex']);
    const cfg = loadExamples();
    expect(cfg.configFile.source).not.toBeNull();
    expect(cfg.agentsFile.source).not.toBeNull();
    expect(cfg.errors).toEqual({});
    expect(cfg.warnings).toEqual({});
  });

  it('every template file loads, under the id of its file name', () => {
    const cfg = loadExamples();
    const files = readdirSync(join(examplesDir, 'workflows')).sort();
    expect(cfg.templateFiles.map((f) => [f.file, f.templateId])).toEqual(
      files.map((file) => [file, file.replace(/\.ya?ml$/, '')]),
    );
    // The scenarios the README promises.
    expect([...cfg.templates.keys()].sort()).toEqual([
      'cross-review',
      'light',
      'strict',
      'with-e2e',
    ]);
  });

  it('every repo of config.yaml uses an example template, and the scouts run read-only', () => {
    const cfg = loadExamples();
    const repos = Object.entries(cfg.master.github?.repos ?? {});
    expect(repos.length).toBeGreaterThan(1);
    // A repo on GitLab is shown too: a project in a subgroup, on a self-hosted GitLab, pushed.
    expect(cfg.master.gitlab?.host).not.toBe('gitlab.com');
    const onGitLab = Object.entries(cfg.master.gitlab?.repos ?? {});
    expect(onGitLab.length).toBeGreaterThan(0);
    expect(onGitLab.some(([, repo]) => repo.issues_repo.split('/').length > 2)).toBe(true);
    expect(onGitLab.some(([, repo]) => repo.scout && repo.push)).toBe(true);
    // A repo without GitHub or GitLab is shown too, with a scout and auto-accept of its own.
    const local = Object.entries(cfg.master.backlog?.repos ?? {});
    expect(local.length).toBeGreaterThan(0);
    expect(local.some(([, repo]) => repo.scout && repo.auto_accept.max_risk !== 'none')).toBe(true);
    // A repo takes its requirements from one source only.
    const names = [...repos, ...onGitLab, ...local].map(([n]) => n);
    expect(new Set(names).size).toBe(names.length);
    for (const [name, repo] of [...repos, ...onGitLab, ...local]) {
      expect(cfg.templates.has(repo.template), `${name}: template ${repo.template}`).toBe(true);
      if (!repo.scout) continue;
      const scout = cfg.agents.get(repo.scout.agent);
      expect(scout, `${name}: scout agent ${repo.scout.agent}`).toBeDefined();
      // The scout runs with read-only tools, which only some CLIs support.
      expect(BUILTIN_READ_ONLY_CLIS).toContain(scout?.cli);
    }
    // Each scenario is shown in use.
    expect(new Set(repos.map(([, repo]) => repo.template))).toEqual(new Set(cfg.templates.keys()));
  });

  it('every agent a template names is an enabled agent of agents.yaml', () => {
    const cfg = loadExamples();
    const named = [...cfg.templates.values()].flatMap((tpl) =>
      tpl.stages.flatMap((s) =>
        [s.agent, ...(s.agent_candidates ?? [])]
          .filter((id): id is string => id !== undefined)
          .map((id) => ({ where: `${tpl.id}.${s.id}`, id })),
      ),
    );
    expect(named.length).toBeGreaterThan(0);
    for (const { where, id } of named) {
      expect(cfg.agents.has(id), `${where}: agent ${id}`).toBe(true);
    }
  });

  it('shows an agent stage split into tasks by its own agent, run read-only', () => {
    const cfg = loadExamples();
    const planned = [...cfg.templates.values()].flatMap((tpl) =>
      tpl.stages.filter((s) => s.planning !== 'single'),
    );
    expect(planned.length).toBeGreaterThan(0);
    for (const stage of planned) {
      expect(stage.kind).toBe('agent');
      expect(BUILTIN_READ_ONLY_CLIS).toContain(cfg.agents.get(stage.agent ?? '')?.cli);
    }
    // Planning by size goes by an assessment, so its template has one.
    const bySize = [...cfg.templates.values()].filter((tpl) =>
      tpl.stages.some((s) => s.planning === 'auto'),
    );
    expect(bySize.length).toBeGreaterThan(0);
    for (const tpl of bySize) expect(tpl.stages.some((s) => s.kind === 'assess')).toBe(true);
  });

  it('shows stages picking their agent by difficulty from agent_candidates', () => {
    const cfg = loadExamples();
    const tpl = cfg.templates.get('cross-review');
    // A difficulty comes from an assessment, so the template has one.
    expect(tpl?.stages.some((s) => s.kind === 'assess')).toBe(true);
    const stage = (id: string) => {
      const s = tpl?.stages.find((x) => x.id === id);
      expect(s?.agent_candidates, id).toBeDefined();
      return s?.agent_candidates ?? [];
    };
    const pick = (id: string, difficulty: Difficulty | undefined) =>
      chooseStageAgent(stage(id), cfg.agents, difficulty, () => true)?.id;
    // What the template's comments say each difficulty picks.
    expect(DIFFICULTIES.map((d) => pick('implement', d))).toEqual([
      'claude-docs',
      'claude-reviewer',
      'claude-coder',
    ]);
    expect(pick('implement', undefined)).toBe('claude-coder');
    expect(DIFFICULTIES.map((d) => pick('review', d))).toEqual([
      'codex-reviewer',
      'codex-reviewer',
      'cursor-grok',
    ]);
    expect(pick('review', undefined)).toBe('codex-reviewer');
    // What the comments say switch_agent switches each candidate to, among the stage's candidates.
    const switched = (id: string, from: string) =>
      switchCandidate(
        stage(id).flatMap((a) => cfg.agents.get(a) ?? []),
        cfg.agents.get(from),
        new Set([from]),
        () => true,
      )?.id;
    expect(switched('implement', 'claude-docs')).toBe('claude-reviewer');
    expect(switched('implement', 'claude-reviewer')).toBe('claude-coder');
    expect(switched('implement', 'claude-coder')).toBe('claude-docs');
    expect(switched('review', 'codex-reviewer')).toBe('cursor-grok');
    expect(switched('review', 'cursor-grok')).toBe('codex-reviewer');
    // Cross review: no reviewer is of the coders' CLI, also after switching among candidates.
    const coderClis = new Set(stage('implement').map((id) => cfg.agents.get(id)?.cli));
    for (const id of stage('review')) {
      expect(coderClis.has(cfg.agents.get(id)?.cli), id).toBe(false);
    }
  });

  it('agents.yaml shows the kinds of agents the README lists', () => {
    const cfg = loadExamples();
    const entries = cfg.agentEntries;
    expect(entries.every((e) => e.state !== 'invalid')).toBe(true);
    const configs = entries.flatMap((e) => (e.config ? [e.config] : []));
    expect(configs.some((a) => a.cli === 'claude-code')).toBe(true);
    expect(configs.some((a) => a.cli === 'cursor-agent')).toBe(true);
    expect(configs.some((a) => a.cli === 'codex')).toBe(true);
    // Every built-in CLI has its executable shown in config.yaml's bins.
    expect(Object.keys(cfg.master.bins)).toEqual(BUILTIN_CLIS);
    expect(configs.some((a) => a.permission === 'safe')).toBe(true);
    expect(configs.some((a) => !a.enabled)).toBe(true);
    expect(configs.some((a) => a.price !== undefined)).toBe(true);
    expect(configs.some((a) => a.timeout_minutes !== undefined)).toBe(true);
    expect(configs.some((a) => a.args.length > 0)).toBe(true);
  });

  it('the default self-dev template still loads with the example agents', () => {
    const cfg = loadExamples();
    const selfDev = TemplateSchema.parse(parseYaml(defaultSelfDevYaml()));
    expect(validateTemplate(selfDev, cfg.agents, BUILTIN_READ_ONLY_CLIS)).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it('the README describes every example file', () => {
    const readme = readFileSync(join(examplesDir, 'README.md'), 'utf8');
    const files = [
      'config.yaml',
      'agents.yaml',
      ...readdirSync(join(examplesDir, 'workflows')).map((f) => `workflows/${f}`),
    ];
    for (const file of files) expect(readme, file).toContain(`(${file})`);
  });
});
