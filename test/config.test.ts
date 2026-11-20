import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { issueRunOverrides } from '../src/config/flow.js';
import { ConfigError, homePaths, initHome, loadConfig } from '../src/config/load.js';
import {
  agentEffort,
  defaultRollbackTarget,
  effectiveStage,
  failTarget,
  rollbackTarget,
  stageVerifyCommands,
  TemplateSchema,
  type WorkflowTemplate,
} from '../src/config/schema.js';
import { tmpDir, writeFile } from './helpers.js';

function home(): ReturnType<typeof homePaths> {
  const paths = homePaths(tmpDir('ares1-cfg-'));
  initHome(paths);
  return paths;
}

describe('config', () => {
  it('initHome writes usable defaults: two Claude agents and the self-dev template', () => {
    const paths = home();
    expect(readdirSync(paths.workflowsDir)).toEqual(['self-dev.yaml']);
    const cfg = loadConfig(paths, ['claude-code'], ['claude-code']);
    expect(cfg.errors).toEqual({});
    expect(cfg.warnings).toEqual({});
    expect([...cfg.agents.keys()]).toEqual(['claude-coder', 'claude-reviewer']);
    const coder = cfg.agents.get('claude-coder');
    expect(coder?.model).toBe('opus');
    expect(coder?.effort).toBe('xhigh');
    expect(cfg.master.port).toBe(4870);
    expect(cfg.master.defaults.timeout_minutes).toBe(60);
    const comments = readFileSync(paths.configFile, 'utf8');
    expect(comments.startsWith('# 战神一号全局配置。')).toBe(true);
    expect(comments).toContain('说明见战神一号仓库的 docs/running.md');
    const t = cfg.templates.get('self-dev');
    expect(t?.stages.map((s) => `${s.id}:${s.kind}`)).toEqual([
      'assess:assess',
      'implement:agent',
      'review:review',
      'e2e:placeholder',
      'merge:merge',
    ]);
    // Coding and review work from the requirement as the assessment confirmed it.
    expect(t?.stages.find((s) => s.id === 'implement')?.inputs).toEqual(['assessment']);
    expect(t?.stages.find((s) => s.id === 'review')?.inputs).toEqual(['diff', 'assessment']);
    // The assessment runs read-only, which only some CLIs can.
    expect(loadConfig(paths, ['claude-code']).errors['workflows/self-dev.yaml']?.[0]).toMatch(
      /assess（需求评估）阶段要以只读方式运行/,
    );
  });

  it('does not overwrite existing files', () => {
    const paths = home();
    writeFile(paths.configFile, 'port: 5000\n');
    initHome(paths);
    expect(readFileSync(paths.configFile, 'utf8')).toBe('port: 5000\n');
  });

  it('an invalid config.yaml stops the Master', () => {
    const paths = home();
    writeFile(paths.configFile, 'port: "abc"\n');
    expect(() => loadConfig(paths, ['claude-code'])).toThrow(ConfigError);
    writeFile(paths.configFile, 'port: [\n');
    expect(() => loadConfig(paths, ['claude-code'])).toThrow(/YAML/);
  });

  it('warns about unknown keys of config.yaml and ignores them instead of failing', () => {
    const paths = home();
    writeFile(
      paths.configFile,
      `port: 4900
upgarde: { auto: true }
notfy: { system: true }
defaults:
  timeout_minute: 5
  command_timeout_minutes: 10
`,
    );
    const cfg = loadConfig(paths, ['claude-code'], ['claude-code']);
    expect(cfg.master.port).toBe(4900);
    expect(cfg.master.upgrade.auto).toBe(false);
    expect(cfg.master.notify.system).toBe(false);
    expect(cfg.master.defaults).toEqual({ timeout_minutes: 60, command_timeout_minutes: 10 });
    expect(cfg.warnings['config.yaml']).toEqual([
      '未知的配置项 upgarde，已忽略（是不是写错了？可用：language、port、bins、defaults、github、notify、upgrade）',
      '未知的配置项 notfy，已忽略（是不是写错了？可用：language、port、bins、defaults、github、notify、upgrade）',
      '未知的配置项 defaults.timeout_minute，已忽略（是不是写错了？可用：timeout_minutes、command_timeout_minutes）',
    ]);
    expect(cfg.errors).toEqual({});
  });

  it('reports configuration problems in English when config.yaml says so', () => {
    const paths = home();
    writeFile(paths.configFile, 'language: en\nupgarde: { auto: true }\n');
    writeFile(
      paths.agentsFile,
      'agents:\n  c: { cli: nope, model: m }\n  d: { cli: claude-code }\n',
    );
    writeFile(join(paths.workflowsDir, 'bad.yaml'), 'id: bad\nname: Bad\nstages:\n  - id: Bad\n');
    try {
      const cfg = loadConfig(paths, ['claude-code'], ['claude-code']);
      expect(cfg.warnings['config.yaml']?.[0]).toMatch(
        /^Unknown setting upgarde, ignored \(a typo\? Available: language, port, /,
      );
      expect(cfg.errors['agents.yaml#c']).toEqual([
        'Unsupported cli: nope (available: claude-code)',
      ]);
      // zod's own messages follow the language too.
      expect(cfg.errors['agents.yaml#d']).toEqual([
        'model: Invalid input: expected string, received undefined',
      ]);
      expect(cfg.errors['workflows/bad.yaml']).toEqual([
        'stages.0.id: a stage id may only contain lowercase letters, digits, - and _',
      ]);
    } finally {
      // Back to the default language, zod's messages included, for the other tests.
      writeFile(paths.configFile, 'port: 4870\n');
      loadConfig(paths, ['claude-code']);
    }
  });

  it('a config.yaml with only known keys has no warnings', () => {
    const paths = home();
    writeFile(
      paths.configFile,
      `port: 4870
bins: { claude-code: /opt/bin/claude }
defaults: { timeout_minutes: 30, command_timeout_minutes: 10 }
github:
  account: me
  poll_minutes: 5
  repos:
    app: { template: self-dev, push: true }
notify: { system: true }
upgrade: { auto: true }
`,
    );
    const cfg = loadConfig(paths, ['claude-code'], ['claude-code']);
    expect(cfg.warnings).toEqual({});
    expect(cfg.errors).toEqual({});
    // An empty file has no keys at all.
    writeFile(paths.configFile, '');
    expect(loadConfig(paths, ['claude-code'], ['claude-code']).warnings).toEqual({});
    // Strict sections still reject typos: unlike the top level, they never ignored them.
    writeFile(paths.configFile, 'upgrade: { autto: true }\n');
    expect(() => loadConfig(paths, ['claude-code'])).toThrow(/autto/);
  });

  it('disables invalid agents and templates instead of failing', () => {
    const paths = home();
    writeFile(
      paths.agentsFile,
      `agents:
  ok: { cli: claude-code, model: sonnet }
  typo: { cli: claude-code, model: sonnet, tierr: high }
  unknown: { cli: nope, model: x }
  off: { cli: claude-code, model: sonnet, enabled: false }
`,
    );
    writeFile(
      join(paths.workflowsDir, 'bad.yaml'),
      `id: bad
stages:
  - id: a
    agent: off
  - id: b
    agent_candidates: [ok]
    planning: llm
  - id: m
    kind: merge
  - id: c
    agent: ok
    on_fail: nowhere
`,
    );
    const cfg = loadConfig(paths, ['claude-code']);
    expect([...cfg.agents.keys()]).toEqual(['ok']);
    expect(cfg.errors['agents.yaml#typo']?.[0]).toMatch(/tierr/);
    expect(cfg.errors['agents.yaml#unknown']?.[0]).toMatch(/不支持的 cli/);
    const bad = cfg.errors['workflows/bad.yaml'] ?? [];
    expect(bad.join('\n')).toMatch(/Agent off 不存在或未启用/);
    expect(bad.join('\n')).toMatch(/agent_candidates/);
    expect(bad.join('\n')).toMatch(/planning: llm/);
    expect(bad.join('\n')).toMatch(/merge 阶段必须是最后一个/);
    expect(bad.join('\n')).toMatch(/回退目标 nowhere 不存在/);
    expect(cfg.templates.has('bad')).toBe(false);
    // self-dev refers to agents that are now missing
    expect(cfg.errors['workflows/self-dev.yaml']).toBeDefined();

    // Every entry is still listed, with why it is not in use (shown on the config page).
    expect(cfg.agentEntries.map((e) => [e.id, e.state, e.config?.model ?? null, e.rawCli])).toEqual(
      [
        ['ok', 'enabled', 'sonnet', 'claude-code'],
        ['typo', 'invalid', null, 'claude-code'],
        ['unknown', 'invalid', 'x', 'nope'],
        ['off', 'disabled', 'sonnet', 'claude-code'],
      ],
    );
    expect(cfg.agentEntries[1]?.errors).toEqual(cfg.errors['agents.yaml#typo']);
    expect(cfg.agentEntries[1]?.rawModel).toBe('sonnet');
    expect(cfg.agentEntries[3]?.errors).toEqual([]);
  });

  it('lists every template file with its path and source, valid or not', () => {
    const paths = home();
    writeFile(join(paths.workflowsDir, 'broken.yaml'), 'id: [\n');
    writeFile(join(paths.workflowsDir, 'notes.txt'), 'ignored');
    const cfg = loadConfig(paths, ['claude-code'], ['claude-code']);
    expect(cfg.dir).toBe(paths.home);
    expect(cfg.configFile).toEqual({
      path: paths.configFile,
      source: readFileSync(paths.configFile, 'utf8'),
    });
    expect(cfg.agentsFile.source).toMatch(/claude-coder/);
    expect(cfg.templateFiles.map((f) => [f.key, f.templateId])).toEqual([
      ['workflows/broken.yaml', null],
      ['workflows/self-dev.yaml', 'self-dev'],
    ]);
    const [broken, selfDev] = cfg.templateFiles;
    expect(broken?.source).toBe('id: [\n');
    expect(broken?.errors[0]).toMatch(/不是合法的 YAML/);
    expect(broken?.errors).toEqual(cfg.errors['workflows/broken.yaml']);
    expect(selfDev).toMatchObject({
      file: 'self-dev.yaml',
      path: join(paths.workflowsDir, 'self-dev.yaml'),
      source: readFileSync(join(paths.workflowsDir, 'self-dev.yaml'), 'utf8'),
      errors: [],
      warnings: [],
    });
  });

  it('accepts an effort field, but not together with --effort in args', () => {
    const paths = home();
    writeFile(
      paths.agentsFile,
      `agents:
  plain: { cli: claude-code, model: sonnet }
  high: { cli: claude-code, model: opus, effort: high }
  legacy: { cli: claude-code, model: opus, args: [--effort, max] }
  both: { cli: claude-code, model: opus, effort: high, args: [--effort, low] }
  both_eq: { cli: claude-code, model: opus, effort: high, args: [--effort=low] }
  bad: { cli: claude-code, model: opus, effort: extreme }
`,
    );
    const cfg = loadConfig(paths, ['claude-code']);
    expect([...cfg.agents.keys()]).toEqual(['plain', 'high', 'legacy']);
    expect(cfg.agents.get('plain')?.effort).toBeUndefined();
    expect(cfg.agents.get('high')?.effort).toBe('high');
    expect(cfg.errors['agents.yaml#both']?.join('\n')).toMatch(/不能同时配置/);
    expect(cfg.errors['agents.yaml#both_eq']?.join('\n')).toMatch(/不能同时配置/);
    expect(cfg.errors['agents.yaml#bad']?.[0]).toMatch(/^effort:/);

    // The effort an agent effectively runs with, also from older args-only configs.
    const effort = (id: string) => {
      const a = cfg.agents.get(id);
      return a && agentEffort(a);
    };
    expect(effort('plain')).toBeUndefined();
    expect(effort('high')).toBe('high');
    expect(effort('legacy')).toBe('max');
    expect(agentEffort({ args: ['--verbose', '--effort=xhigh'] })).toBe('xhigh');
  });

  it('accepts cursor-agent agents, with the effort in the model name only', () => {
    const paths = home();
    writeFile(
      paths.agentsFile,
      `agents:
  grok: { cli: cursor-agent, model: grok-4.7-high }
  grok_effort: { cli: cursor-agent, model: grok-4.7, effort: high }
`,
    );
    const cfg = loadConfig(paths, ['claude-code', 'cursor-agent']);
    expect([...cfg.agents.keys()]).toEqual(['grok']);
    expect(cfg.errors['agents.yaml#grok_effort']?.join('\n')).toMatch(/写进 model/);
    // Unknown CLIs are still rejected.
    expect(loadConfig(paths, ['claude-code']).errors['agents.yaml#grok']?.[0]).toMatch(
      /不支持的 cli：cursor-agent/,
    );
  });

  it('accepts placeholder stages, which take no agent and no checks', () => {
    const paths = home();
    const tpl = (extra: string) => `id: p
stages:
  - { id: implement, kind: agent, agent: claude-coder }
  - { id: e2e, kind: placeholder${extra} }
  - { id: merge, kind: merge }
`;
    writeFile(join(paths.workflowsDir, 'ok.yaml'), tpl(', name: E2E, gate: true'));
    writeFile(
      join(paths.workflowsDir, 'agent.yaml'),
      tpl(', agent: claude-coder').replace('id: p', 'id: p2'),
    );
    writeFile(
      join(paths.workflowsDir, 'verify.yaml'),
      tpl(', verify: { commands: [npm test] }').replace('id: p', 'id: p3'),
    );
    const cfg = loadConfig(paths, ['claude-code']);
    expect(cfg.templates.has('p')).toBe(true);
    expect(cfg.errors['workflows/agent.yaml']?.join('\n')).toMatch(/不能指定 agent/);
    expect(cfg.errors['workflows/verify.yaml']?.join('\n')).toMatch(/不能配置检查命令/);

    const t = cfg.templates.get('p') as WorkflowTemplate;
    expect(failTarget(t, 'e2e')).toBeNull();
    expect(
      stageVerifyCommands(t.stages[1] as WorkflowTemplate['stages'][number], ['npm test']),
    ).toEqual([]);
    // A rejected placeholder approval goes back to the nearest agent stage.
    expect(rollbackTarget(t, 'e2e', 'reject')).toBe('implement');
    expect(rollbackTarget(t, 'merge', 'reject')).toBe('implement');
  });

  it('accepts assess stages run by an agent that can run read-only, without checks', () => {
    const paths = home();
    writeFile(
      paths.agentsFile,
      `agents:
  claude: { cli: claude-code, model: opus }
  grok: { cli: cursor-agent, model: grok-4.7-high }
`,
    );
    const tpl = (id: string, assess: string) => `id: ${id}
stages:
  - { id: assess, name: 需求评估, kind: assess${assess} }
  - { id: implement, kind: agent, agent: claude, inputs: [assessment] }
  - { id: merge, kind: merge }
`;
    writeFile(join(paths.workflowsDir, 'self-dev.yaml'), tpl('ok', ', agent: claude, gate: true'));
    writeFile(join(paths.workflowsDir, 'noagent.yaml'), tpl('a2', ''));
    writeFile(join(paths.workflowsDir, 'cursor.yaml'), tpl('a3', ', agent: grok'));
    writeFile(
      join(paths.workflowsDir, 'verify.yaml'),
      tpl('a4', ', agent: claude, verify: { commands: [npm test] }'),
    );
    const cfg = loadConfig(paths, ['claude-code', 'cursor-agent'], ['claude-code']);
    expect(cfg.errors['workflows/self-dev.yaml']).toBeUndefined();
    expect(cfg.warnings['workflows/self-dev.yaml']).toBeUndefined();
    expect(cfg.errors['workflows/noagent.yaml']?.join('\n')).toMatch(/需要指定 agent/);
    expect(cfg.errors['workflows/cursor.yaml']?.join('\n')).toMatch(
      /Agent grok 的 CLI cursor-agent 不支持，请换用 claude-code 的 Agent/,
    );
    expect(cfg.errors['workflows/verify.yaml']?.join('\n')).toMatch(/不能配置检查命令/);

    // It changes no code: no checks, it never fails; a rejected approval assesses again.
    const t = cfg.templates.get('ok') as WorkflowTemplate;
    const assess = t.stages[0] as WorkflowTemplate['stages'][number];
    expect(stageVerifyCommands(assess, ['npm test'])).toEqual([]);
    expect(failTarget(t, 'assess')).toBeNull();
    expect(rollbackTarget(t, 'assess', 'reject')).toBe('assess');
  });

  it('warns when the reviewer is the same agent as the coder', () => {
    const paths = home();
    writeFile(
      join(paths.workflowsDir, 'self-dev.yaml'),
      `id: self-dev
stages:
  - id: implement
    agent: claude-coder
  - id: review
    kind: review
    agent: claude-coder
`,
    );
    const cfg = loadConfig(paths, ['claude-code']);
    expect(cfg.templates.has('self-dev')).toBe(true);
    expect(cfg.warnings['workflows/self-dev.yaml']?.[0]).toMatch(/评审 Agent claude-coder/);
  });

  it('warns about inputs no stage produces, but keeps the template', () => {
    const paths = home();
    writeFile(
      join(paths.workflowsDir, 'self-dev.yaml'),
      `id: self-dev
stages:
  - id: design
    agent: claude-coder
    inputs: [review]
    outputs: [design_doc]
  - id: implement
    agent: claude-coder
    inputs: [design_doc, assesment, assessment, assesment]
  - id: review
    kind: review
    agent: claude-reviewer
    inputs: [diff, review]
    outputs: [notes]
  - id: docs
    agent: claude-coder
    inputs: [notes]
  - id: merge
    kind: merge
`,
    );
    const cfg = loadConfig(paths, ['claude-code']);
    expect(cfg.errors['workflows/self-dev.yaml']).toBeUndefined();
    expect(cfg.templates.has('self-dev')).toBe(true);
    // design reads `review` produced by a later stage (after a rollback): not warned.
    // A review stage does not save its `outputs`, so `notes` is never produced.
    const available = '（可用：design_doc、review、diff）';
    expect(cfg.warnings['workflows/self-dev.yaml']).toEqual([
      `阶段 implement：inputs 里的 assesment 没有阶段会产出，不会放进提示词${available}`,
      `阶段 implement：inputs 里的 assessment 没有阶段会产出，不会放进提示词${available}`,
      `阶段 docs：inputs 里的 notes 没有阶段会产出，不会放进提示词${available}`,
    ]);
    const file = cfg.templateFiles.find((f) => f.key === 'workflows/self-dev.yaml');
    expect(file?.warnings).toEqual(cfg.warnings['workflows/self-dev.yaml']);

    // Without a review stage, `review` is not produced either; `diff` always is.
    writeFile(
      join(paths.workflowsDir, 'self-dev.yaml'),
      `id: self-dev
stages:
  - id: implement
    agent: claude-coder
    inputs: [diff, review]
`,
    );
    expect(loadConfig(paths, ['claude-code']).warnings['workflows/self-dev.yaml']).toEqual([
      '阶段 implement：inputs 里的 review 没有阶段会产出，不会放进提示词（可用：diff）',
    ]);
  });

  it('warns when a stage after the assess stage does not read the assessment', () => {
    const paths = home();
    const tpl = (implement: string, review: string) => `id: self-dev
stages:
  - { id: before, agent: claude-coder }
  - { id: assess, kind: assess, agent: claude-reviewer }
  - { id: implement, agent: claude-coder${implement} }
  - { id: review, kind: review, agent: claude-reviewer${review} }
  - { id: e2e, kind: placeholder }
  - { id: merge, kind: merge }
`;
    const warnings = (yaml: string) => {
      writeFile(join(paths.workflowsDir, 'self-dev.yaml'), yaml);
      const cfg = loadConfig(paths, ['claude-code'], ['claude-code']);
      expect(cfg.errors['workflows/self-dev.yaml']).toBeUndefined();
      expect(cfg.templates.has('self-dev')).toBe(true);
      return cfg.warnings['workflows/self-dev.yaml'];
    };
    // Only coding and review stages after the assessment; placeholder and merge run no agent.
    expect(warnings(tpl('', ', inputs: [diff]'))).toEqual([
      '阶段 implement：模板有需求评估阶段，但这个阶段的 inputs 没有 assessment，讨论后修改的需求不会交给它',
      '阶段 review：模板有需求评估阶段，但这个阶段的 inputs 没有 assessment，讨论后修改的需求不会交给它',
    ]);
    expect(warnings(tpl(', inputs: [assessment]', ''))).toEqual([
      '阶段 review：模板有需求评估阶段，但这个阶段的 inputs 没有 assessment，讨论后修改的需求不会交给它',
    ]);
    expect(warnings(tpl(', inputs: [assessment]', ', inputs: [diff, assessment]'))).toBeUndefined();
  });

  it('keeps templates using on_agent_error: switch_agent, with a warning that it acts as human', () => {
    const paths = home();
    writeFile(
      join(paths.workflowsDir, 'defaults.yaml'),
      `id: by-default
defaults:
  escalate: { on_agent_error: switch_agent }
stages:
  - id: implement
    agent: claude-coder
`,
    );
    writeFile(
      join(paths.workflowsDir, 'stage.yaml'),
      `id: by-stage
stages:
  - id: implement
    agent: claude-coder
    escalate: { max_retries: 3, on_agent_error: switch_agent }
  - id: review
    kind: review
    agent: claude-reviewer
    escalate: { on_agent_error: human }
  - id: merge
    kind: merge
    escalate: { on_agent_error: switch_agent }
`,
    );
    const cfg = loadConfig(paths, ['claude-code']);
    expect(cfg.errors['workflows/defaults.yaml']).toBeUndefined();
    expect(cfg.errors['workflows/stage.yaml']).toBeUndefined();
    expect(cfg.templates.has('by-default')).toBe(true);
    expect(cfg.templates.has('by-stage')).toBe(true);

    const byDefault = cfg.warnings['workflows/defaults.yaml'] ?? [];
    expect(byDefault).toHaveLength(1);
    expect(byDefault[0]).toMatch(/^defaults\.escalate：on_agent_error: switch_agent/);
    expect(byDefault[0]).toMatch(/尚未实现，目前按 human 处理/);

    // Only the stage that runs an agent; merge never calls one.
    const byStage = cfg.warnings['workflows/stage.yaml'] ?? [];
    expect(byStage).toHaveLength(1);
    expect(byStage[0]).toMatch(/^阶段 implement：on_agent_error: switch_agent/);
    expect(byStage[0]).toMatch(/Agent 出错时 Run 卡住等人处理/);

    // The config page shows the warnings on the template's card.
    const file = cfg.templateFiles.find((f) => f.key === 'workflows/stage.yaml');
    expect(file?.templateId).toBe('by-stage');
    expect(file?.warnings).toEqual(byStage);
  });

  it('resolves stage settings: system default → template → stage → run override', () => {
    const t: WorkflowTemplate = TemplateSchema.parse({
      id: 't',
      defaults: { escalate: { max_retries: 5 } },
      stages: [
        { id: 'a', agent: 'x', escalate: { on_agent_error: 'human' } },
        { id: 'r', kind: 'review', agent: 'y' },
        { id: 'm', kind: 'merge', gate: true },
      ],
    });
    expect(effectiveStage(t, 'a', {}).escalate).toEqual({
      max_retries: 5,
      on_agent_error: 'human',
      on_budget_exceeded: 'pause',
    });
    const o = { stages: { a: { escalate: { max_retries: 1 } }, m: { gate: false } } };
    expect(effectiveStage(t, 'a', o).escalate.max_retries).toBe(1);
    expect(effectiveStage(t, 'm', {}).gate).toBe(true);
    expect(effectiveStage(t, 'm', o).gate).toBe(false);
    expect(defaultRollbackTarget(t, 'a')).toBe('a');
    expect(defaultRollbackTarget(t, 'r')).toBe('a');
    expect(defaultRollbackTarget(t, 'm')).toBe('a');
  });

  it('resolves rollback targets and verify commands', () => {
    const t: WorkflowTemplate = TemplateSchema.parse({
      id: 't',
      stages: [
        { id: 'design', agent: 'x' },
        { id: 'code', agent: 'x', verify: { commands: ['npm test'] }, on_reject: 'design' },
        { id: 'review', kind: 'review', agent: 'y', verify: { commands: ['ignored'] } },
        { id: 'merge', kind: 'merge', gate: true, on_fail: 'design' },
      ],
    });
    expect(rollbackTarget(t, 'code', 'reject')).toBe('design');
    expect(rollbackTarget(t, 'code', 'fail')).toBe('code');
    expect(rollbackTarget(t, 'review', 'fail')).toBe('code');
    expect(rollbackTarget(t, 'merge', 'fail')).toBe('design');
    expect(rollbackTarget(t, 'merge', 'reject')).toBe('code');
    expect(failTarget(t, 'design')).toBeNull();
    expect(failTarget(t, 'code')).toBeNull();
    expect(failTarget(t, 'review')).toBe('code');
    expect(failTarget(t, 'merge')).toBe('design');
    expect(failTarget(t, 'missing')).toBeNull();
    const stage = (id: string) => effectiveStage(t, id, {}).def;
    expect(stageVerifyCommands(stage('design'), ['npm run lint'])).toEqual(['npm run lint']);
    expect(stageVerifyCommands(stage('code'), ['npm run lint'])).toEqual(['npm test']);
    expect(stageVerifyCommands(stage('review'), ['npm run lint'])).toEqual([]);
    expect(stageVerifyCommands(stage('merge'), ['npm run lint'])).toEqual(['npm run lint']);
  });
});

describe('issueRunOverrides', () => {
  const t = TemplateSchema.parse({
    id: 't',
    stages: [
      { id: 'code', agent: 'a', gate: true },
      { id: 'merge', kind: 'merge', gate: true },
    ],
  });

  it('turns off only the merge approvals with auto_merge', () => {
    expect(issueRunOverrides(t, false)).toBeUndefined();
    const o = issueRunOverrides(t, true);
    expect(o).toEqual({ stages: { merge: { gate: false } } });
    expect(effectiveStage(t, 'merge', o ?? {}).gate).toBe(false);
    expect(effectiveStage(t, 'code', o ?? {}).gate).toBe(true);
  });

  it('has nothing to override without a merge stage or a template', () => {
    const noMerge = TemplateSchema.parse({ id: 'n', stages: [{ id: 'code', agent: 'a' }] });
    expect(issueRunOverrides(noMerge, true)).toBeUndefined();
    expect(issueRunOverrides(undefined, true)).toBeUndefined();
  });
});
