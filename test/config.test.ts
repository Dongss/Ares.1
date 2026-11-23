import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  budgetPauses,
  discussionReplyWait,
  issueRunOverrides,
  leftoverWorkspaces,
  loopsExhausted,
  RATE_LIMIT_WAIT,
  REDO_BACKOFF_MAX_HOURS,
  rateLimitDelayMs,
  redoDelayMs,
  redoDueAt,
  scoutBackoff,
  scoutFailureStreak,
  scoutLimitWait,
  splitUnfinishedRuns,
} from '../src/config/flow.js';
import { ConfigError, homePaths, initHome, loadConfig } from '../src/config/load.js';
import {
  agentEffort,
  defaultRollbackTarget,
  effectiveStage,
  failTarget,
  GitHubRepoSchema,
  replyTimeoutHours,
  rollbackTarget,
  stageVerifyCommands,
  TemplateSchema,
  type WorkflowTemplate,
} from '../src/config/schema.js';
import { setLang } from '../src/i18n.js';
import type {
  AssessmentEntry,
  BlockKind,
  DiscussionEntry,
  RedoState,
  Run,
  RunStatus,
  Scout,
  ScoutProposal,
} from '../src/store/types.js';
import { tmpDir, writeFile } from './helpers.js';

afterEach(() => setLang('zh'));

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
    // Nobody replying to the assessment does not stop the Run for good.
    expect(t?.stages[0]?.reply_timeout_hours).toBe(24);
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

  it('sets the interval between automatic scouts in minutes; the old key in hours is an error', () => {
    const paths = home();
    const scoutConfig = (scout: string) => `github:
  repos:
    app:
      template: self-dev
      scout: { agent: claude-reviewer, ${scout} }
`;
    writeFile(paths.configFile, scoutConfig('interval_minutes: 15'));
    const cfg = loadConfig(paths, ['claude-code'], ['claude-code']);
    expect(cfg.master.github?.repos.app?.scout?.interval_minutes).toBe(15);
    expect(cfg.errors).toEqual({});
    expect(cfg.warnings).toEqual({});

    // The old key in hours is no longer accepted, like any other unknown key of the scout, and
    // the error names it. Built from parts so that a search for the old key finds no use left.
    const oldKey = ['interval', 'hours'].join('_');
    writeFile(paths.configFile, scoutConfig(`${oldKey}: 6`));
    expect(() => loadConfig(paths, ['claude-code'])).toThrow(ConfigError);
    expect(() => loadConfig(paths, ['claude-code'])).toThrow(new RegExp(`\\b${oldKey}\\b`));

    const scout = (s: object) =>
      GitHubRepoSchema.safeParse({ template: 'x', scout: { agent: 'a', ...s } });
    expect(scout({}).data?.scout?.interval_minutes).toBe(0);
    expect(scout({ interval_minutes: 7.5 }).data?.scout?.interval_minutes).toBe(7.5);
    expect(scout({ interval_minutes: -1 }).success).toBe(false);
  });

  it('gives an issue 3 Runs by default, and at least 1', () => {
    expect(GitHubRepoSchema.parse({ template: 'self-dev' }).max_run_attempts).toBe(3);
    expect(GitHubRepoSchema.parse({ template: 'x', max_run_attempts: 1 }).max_run_attempts).toBe(1);
    for (const bad of [0, 2.5, -1]) {
      expect(GitHubRepoSchema.safeParse({ template: 'x', max_run_attempts: bad }).success).toBe(
        false,
      );
    }
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

  describe('command stages', () => {
    const tpl = (id: string, extra: string) => `id: ${id}
stages:
  - { id: implement, kind: agent, agent: claude-coder }
  - { id: docs, kind: agent, agent: claude-coder }
  - { id: e2e, kind: command${extra} }
  - { id: merge, kind: merge }
`;
    const load = (files: Record<string, string>) => {
      const paths = home();
      for (const [file, yaml] of Object.entries(files)) {
        writeFile(join(paths.workflowsDir, file), yaml);
      }
      return loadConfig(paths, ['claude-code']);
    };
    const e2eOf = (t: WorkflowTemplate) => t.stages[2] as WorkflowTemplate['stages'][number];

    it('load with their own commands or the repo default, and fail back like a review', () => {
      const cfg = load({
        'own.yaml': tpl(
          'own',
          ', name: E2E, gate: true, verify: { commands: [npx playwright test] }',
        ),
        'repo.yaml': tpl('repo', ''),
        'back.yaml': tpl('back', ', on_fail: implement'),
      });
      for (const file of ['own.yaml', 'repo.yaml', 'back.yaml']) {
        expect(cfg.errors[`workflows/${file}`]).toBeUndefined();
        expect(cfg.warnings[`workflows/${file}`]).toBeUndefined();
      }
      const own = cfg.templates.get('own') as WorkflowTemplate;
      expect(stageVerifyCommands(e2eOf(own), ['npm test'])).toEqual(['npx playwright test']);
      const repo = cfg.templates.get('repo') as WorkflowTemplate;
      expect(stageVerifyCommands(e2eOf(repo), ['npm test'])).toEqual(['npm test']);
      // The nearest earlier agent stage, unless on_fail says otherwise.
      expect(defaultRollbackTarget(own, 'e2e')).toBe('docs');
      expect(failTarget(own, 'e2e')).toBe('docs');
      expect(failTarget(cfg.templates.get('back') as WorkflowTemplate, 'e2e')).toBe('implement');
      expect(rollbackTarget(own, 'e2e', 'reject')).toBe('docs');
    });

    it('cannot have what only an agent uses, nor an empty list of commands', () => {
      const cfg = load({
        'agent.yaml': tpl('a1', ', agent: claude-coder'),
        'candidates.yaml': tpl('a2', ', agent_candidates: [claude-coder]'),
        'planning.yaml': tpl('a3', ', planning: llm'),
        'all.yaml': tpl('a4', ', agent: claude-coder, planning: llm, verify: { llm_check: true }'),
        'empty.yaml': tpl('a5', ', verify: { commands: [] }'),
      });
      const errors = (file: string) => cfg.errors[`workflows/${file}`];
      expect(errors('agent.yaml')).toEqual([
        '阶段 e2e：command（命令）阶段只运行命令、不调用 Agent，不能指定 agent',
      ]);
      expect(errors('candidates.yaml')).toEqual([
        '阶段 e2e：command（命令）阶段只运行命令、不调用 Agent，不能指定 agent_candidates',
      ]);
      expect(errors('planning.yaml')).toEqual([
        '阶段 e2e：command（命令）阶段只运行命令、不调用 Agent，不能指定 planning: llm',
      ]);
      expect(errors('all.yaml')).toEqual([
        '阶段 e2e：command（命令）阶段只运行命令、不调用 Agent，不能指定 agent、planning: llm、verify.llm_check',
      ]);
      expect(errors('empty.yaml')).toEqual([
        '阶段 e2e：command（命令）阶段的 verify.commands 是空列表，没有要运行的命令；不写 verify.commands 时运行仓库登记的检查命令',
      ]);
      for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) expect(cfg.templates.has(id)).toBe(false);

      setLang('en');
      const en = load({ 'all.yaml': tpl('a4', ', agent: claude-coder, verify: { commands: [] }') });
      expect(en.errors['workflows/all.yaml']).toEqual([
        'Stage e2e: a command stage only runs commands and calls no agent, it cannot have agent',
        "Stage e2e: a command stage's verify.commands is an empty list, so there is nothing to run; without verify.commands it runs the repo's verify commands",
      ]);
    });

    it('warn when a failure goes back to no agent stage, and never about waiting or the budget', () => {
      const cfg = load({
        'alone.yaml': `id: alone
stages:
  - { id: e2e, kind: command }
  - { id: merge, kind: merge }
`,
        'review.yaml': `id: to-review
stages:
  - { id: implement, agent: claude-coder }
  - { id: review, kind: review, agent: claude-reviewer }
  - { id: e2e, kind: command, on_fail: review }
  - { id: merge, kind: merge }
`,
        // No agent runs there: nothing errors, is reworked or checks the budget.
        'escalate.yaml': tpl(
          'escalate',
          ', escalate: { on_exhausted: human, on_agent_error: human, on_budget_exceeded: pause }',
        ),
      });
      expect(cfg.templates.has('alone')).toBe(true);
      // Without an agent stage, the merge stage cannot have conflicts resolved either.
      expect(cfg.warnings['workflows/alone.yaml']).toEqual([
        expect.stringMatching(/^阶段 merge：合并阶段失败时没有可回退的 Agent 阶段。/),
        '阶段 e2e：命令阶段失败时没有可回退的 Agent 阶段。命令失败后没有 Agent 按失败输出修改代码，只会重新运行同样的代码，直到超过 max_loops。想让 Agent 修复，就把 on_fail 指向一个 Agent 阶段（kind: agent）',
      ]);
      expect(cfg.warnings['workflows/review.yaml']).toEqual([
        expect.stringMatching(/^阶段 e2e：命令阶段失败时回退到的 review 不是 Agent 阶段。/),
      ]);
      expect(cfg.warnings['workflows/escalate.yaml']).toBeUndefined();
      expect(budgetPauses(cfg.templates.get('escalate') as WorkflowTemplate, {})).toBe(false);
    });
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

  it('reads how long an assess stage waits for a reply: 24 hours unless it says otherwise', () => {
    const stage = (extra: object) =>
      TemplateSchema.safeParse({
        id: 'dev',
        stages: [{ id: 'assess', kind: 'assess', agent: 'claude', ...extra }],
      });
    const hours = (extra: object) => {
      const parsed = stage(extra);
      if (!parsed.success) throw parsed.error;
      return replyTimeoutHours(parsed.data.stages[0] as WorkflowTemplate['stages'][number]);
    };
    expect(hours({})).toBe(24);
    expect(hours({ reply_timeout_hours: 2.5 })).toBe(2.5);
    // 0 = do not wait; null = wait however long it takes.
    expect(hours({ reply_timeout_hours: 0 })).toBe(0);
    expect(hours({ reply_timeout_hours: null })).toBeNull();
    expect(stage({ reply_timeout_hours: -1 }).success).toBe(false);
    expect(stage({ reply_timeout_hours: '24' }).success).toBe(false);

    // Only an assessment waits for replies: elsewhere it is a warning, the template stays.
    const paths = home();
    writeFile(
      join(paths.workflowsDir, 'self-dev.yaml'),
      `id: self-dev
stages:
  - { id: assess, kind: assess, agent: claude-reviewer, reply_timeout_hours: null }
  - { id: implement, agent: claude-coder, inputs: [assessment], reply_timeout_hours: 1 }
  - { id: merge, kind: merge }
`,
    );
    const cfg = loadConfig(paths, ['claude-code'], ['claude-code']);
    expect(cfg.templates.has('self-dev')).toBe(true);
    expect(cfg.warnings['workflows/self-dev.yaml']).toEqual([
      '阶段 implement：reply_timeout_hours 只对需求评估阶段（kind: assess）有效，这里不起作用',
    ]);
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

  it('keeps templates using on_agent_error: human, with a warning that the Run waits for a human', () => {
    const paths = home();
    // What self-dev.yaml said before switch_agent was its default: installed copies keep it.
    writeFile(
      join(paths.workflowsDir, 'defaults.yaml'),
      `id: by-default
defaults:
  escalate: { max_retries: 2, on_agent_error: human }
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
    escalate: { max_retries: 3, on_agent_error: human }
  - id: review
    kind: review
    agent: claude-reviewer
    escalate: { on_agent_error: switch_agent }
  - id: merge
    kind: merge
    escalate: { on_agent_error: human }
`,
    );
    const cfg = loadConfig(paths, ['claude-code']);
    expect(cfg.errors['workflows/defaults.yaml']).toBeUndefined();
    expect(cfg.errors['workflows/stage.yaml']).toBeUndefined();
    expect(cfg.templates.has('by-default')).toBe(true);
    expect(cfg.templates.has('by-stage')).toBe(true);

    const byDefault = cfg.warnings['workflows/defaults.yaml'] ?? [];
    expect(byDefault).toHaveLength(1);
    expect(byDefault[0]).toMatch(/^defaults\.escalate：on_agent_error: human：/);
    expect(byDefault[0]).toMatch(/自动重试 max_retries 次后，Run 会卡住等人处理/);
    expect(byDefault[0]).toMatch(/建议改成 switch_agent/);

    // Only the stage that runs an agent; merge never calls one. switch_agent is not warned about.
    const byStage = cfg.warnings['workflows/stage.yaml'] ?? [];
    expect(byStage).toHaveLength(1);
    expect(byStage[0]).toMatch(/^阶段 implement：on_agent_error: human：/);

    // The config page shows the warnings on the template's card.
    const file = cfg.templateFiles.find((f) => f.key === 'workflows/stage.yaml');
    expect(file?.templateId).toBe('by-stage');
    expect(file?.warnings).toEqual(byStage);
  });

  it('warns about on_agent_error: human in English too', () => {
    setLang('en');
    const paths = home();
    writeFile(
      join(paths.workflowsDir, 'self-dev.yaml'),
      `id: self-dev
defaults:
  escalate: { on_agent_error: human }
stages:
  - id: implement
    agent: claude-coder
`,
    );
    const warnings = loadConfig(paths, ['claude-code']).warnings['workflows/self-dev.yaml'] ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^defaults\.escalate: on_agent_error: human: /);
    expect(warnings[0]).toContain('Better use switch_agent');
    expect(warnings[0]).not.toMatch(/[一-鿿]/);
  });

  it('does not wait for a human on agent errors by default', () => {
    const paths = home();
    const cfg = loadConfig(paths, ['claude-code'], ['claude-code']);
    const selfDev = cfg.templates.get('self-dev') as WorkflowTemplate;
    expect(selfDev.defaults?.escalate?.on_agent_error).toBe('switch_agent');
    // A template that does not say gets the system default.
    const bare = TemplateSchema.parse({ id: 't', stages: [{ id: 'a', agent: 'x' }] });
    expect(effectiveStage(bare, 'a', {}).escalate.on_agent_error).toBe('switch_agent');
  });

  it('does not wait for a human once reworks or rollbacks are used up by default', () => {
    for (const lang of ['zh', 'en'] as const) {
      setLang(lang);
      const paths = home();
      const cfg = loadConfig(paths, ['claude-code'], ['claude-code']);
      const selfDev = cfg.templates.get('self-dev') as WorkflowTemplate;
      expect(selfDev.defaults?.escalate?.on_exhausted).toBe('fail');
      expect(loopsExhausted(selfDev)).toBe('fail');
      expect(cfg.warnings['workflows/self-dev.yaml']).toBeUndefined();
      // The comment says what the other choice does.
      const source = readFileSync(join(paths.workflowsDir, 'self-dev.yaml'), 'utf8');
      expect(source).toMatch(/on_exhausted: fail +# .*human = /);
    }
    setLang('zh');
    // A template that does not say gets the system default.
    const bare = TemplateSchema.parse({ id: 't', stages: [{ id: 'a', agent: 'x' }] });
    expect(effectiveStage(bare, 'a', {}).escalate.on_exhausted).toBe('fail');
    expect(loopsExhausted(bare)).toBe('fail');
    // Rollbacks follow the template's defaults only; reworks the stage's effective setting.
    const set = TemplateSchema.parse({
      id: 't',
      defaults: { escalate: { on_exhausted: 'human' } },
      stages: [{ id: 'a', agent: 'x', escalate: { on_exhausted: 'fail' } }],
    });
    expect(loopsExhausted(set)).toBe('human');
    expect(effectiveStage(set, 'a', {}).escalate.on_exhausted).toBe('fail');
    const o = { stages: { a: { escalate: { on_exhausted: 'human' as const } } } };
    expect(effectiveStage(bare, 'a', o).escalate.on_exhausted).toBe('human');
    expect(() =>
      TemplateSchema.parse({
        id: 't',
        defaults: { escalate: { on_exhausted: 'wait' } },
        stages: [{ id: 'a', agent: 'x' }],
      }),
    ).toThrow();
  });

  it('warns about on_exhausted: human in the defaults and in stages that run an agent', () => {
    const paths = home();
    writeFile(
      join(paths.workflowsDir, 'defaults.yaml'),
      `id: by-default
defaults:
  escalate: { on_agent_error: human, on_exhausted: human }
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
    escalate: { on_exhausted: human }
  - id: review
    kind: review
    agent: claude-reviewer
    escalate: { on_exhausted: fail }
  - id: merge
    kind: merge
    escalate: { on_exhausted: human }
`,
    );
    const cfg = loadConfig(paths, ['claude-code']);
    expect(cfg.templates.has('by-default')).toBe(true);
    expect(cfg.templates.has('by-stage')).toBe(true);

    const byDefault = cfg.warnings['workflows/defaults.yaml'] ?? [];
    expect(byDefault).toHaveLength(2);
    expect(byDefault[0]).toMatch(/^defaults\.escalate：on_agent_error: human：/);
    expect(byDefault[1]).toMatch(/^defaults\.escalate：on_exhausted: human：/);
    expect(byDefault[1]).toContain('返工 max_retries 次后仍未通过，或回退超过 max_loops 时');
    expect(byDefault[1]).toContain('建议改成 fail');

    // Only the stage that runs an agent; merge never reworks. fail is not warned about.
    expect(cfg.warnings['workflows/stage.yaml']).toEqual([
      expect.stringMatching(/^阶段 implement：on_exhausted: human：/),
    ]);
  });

  it('warns about on_exhausted: human in English too', () => {
    setLang('en');
    const paths = home();
    writeFile(
      join(paths.workflowsDir, 'self-dev.yaml'),
      `id: self-dev
defaults:
  escalate: { on_exhausted: human }
stages:
  - id: implement
    agent: claude-coder
`,
    );
    const warnings = loadConfig(paths, ['claude-code']).warnings['workflows/self-dev.yaml'] ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^defaults\.escalate: on_exhausted: human: /);
    expect(warnings[0]).toContain('Better use fail');
    expect(warnings[0]).not.toMatch(/[一-鿿]/);
  });

  it('does not wait for a human over budget by default', () => {
    for (const lang of ['zh', 'en'] as const) {
      setLang(lang);
      const paths = home();
      // A budget alone, with nothing said about what happens over it: no warning.
      writeFile(
        join(paths.workflowsDir, 'budget.yaml'),
        `id: budget
defaults:
  budget_usd: 5
stages:
  - id: implement
    agent: claude-coder
`,
      );
      const cfg = loadConfig(paths, ['claude-code'], ['claude-code']);
      expect(cfg.warnings['workflows/budget.yaml']).toBeUndefined();
      expect(cfg.warnings['workflows/self-dev.yaml']).toBeUndefined();
      const selfDev = cfg.templates.get('self-dev') as WorkflowTemplate;
      expect(budgetPauses(selfDev, {})).toBe(false);
      const budget = cfg.templates.get('budget') as WorkflowTemplate;
      expect(effectiveStage(budget, 'implement', {}).escalate.on_budget_exceeded).toBe('abort');
      expect(budgetPauses(budget, {})).toBe(false);
    }
    setLang('zh');
    // A Run override can still make it wait.
    const bare = TemplateSchema.parse({ id: 't', stages: [{ id: 'a', agent: 'x' }] });
    const o = { stages: { a: { escalate: { on_budget_exceeded: 'pause' as const } } } };
    expect(effectiveStage(bare, 'a', o).escalate.on_budget_exceeded).toBe('pause');
    expect(budgetPauses(bare, o)).toBe(true);
  });

  it('warns about on_budget_exceeded: pause in the defaults and in stages that run an agent', () => {
    const paths = home();
    writeFile(
      join(paths.workflowsDir, 'defaults.yaml'),
      `id: by-default
defaults:
  budget_usd: 5
  escalate: { on_agent_error: switch_agent, on_budget_exceeded: pause }
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
    escalate: { on_budget_exceeded: pause }
  - id: review
    kind: review
    agent: claude-reviewer
    escalate: { on_budget_exceeded: abort }
  - id: merge
    kind: merge
    escalate: { on_budget_exceeded: pause }
`,
    );
    const cfg = loadConfig(paths, ['claude-code']);
    expect(cfg.errors['workflows/defaults.yaml']).toBeUndefined();
    expect(cfg.errors['workflows/stage.yaml']).toBeUndefined();
    expect(cfg.templates.has('by-default')).toBe(true);
    expect(cfg.templates.has('by-stage')).toBe(true);

    const byDefault = cfg.warnings['workflows/defaults.yaml'] ?? [];
    expect(byDefault).toHaveLength(1);
    expect(byDefault[0]).toMatch(/^defaults\.escalate：on_budget_exceeded: pause：/);
    expect(byDefault[0]).toContain('卡住等人调高预算，没人在场时就停在那里');
    expect(byDefault[0]).toContain('建议改成 abort');
    expect(byDefault[0]).toContain('从 issue 来的 Run 会在 max_run_attempts 和 daily_budget_usd');

    // Only the stage that runs an agent; merge never checks the budget. abort is not warned about.
    expect(cfg.warnings['workflows/stage.yaml']).toEqual([
      expect.stringMatching(/^阶段 implement：on_budget_exceeded: pause：/),
    ]);
  });

  it('warns about on_budget_exceeded: pause in English too', () => {
    setLang('en');
    const paths = home();
    writeFile(
      join(paths.workflowsDir, 'self-dev.yaml'),
      `id: self-dev
defaults:
  escalate: { on_budget_exceeded: pause }
stages:
  - id: implement
    agent: claude-coder
    escalate: { on_budget_exceeded: pause }
`,
    );
    const warnings = loadConfig(paths, ['claude-code']).warnings['workflows/self-dev.yaml'] ?? [];
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^defaults\.escalate: on_budget_exceeded: pause: /);
    expect(warnings[1]).toMatch(/^Stage implement: on_budget_exceeded: pause: /);
    for (const warning of warnings) {
      expect(warning).toContain('waits for a human to raise the budget');
      expect(warning).toContain('Better use abort');
      expect(warning).not.toMatch(/[一-鿿]/);
    }
  });

  /** Templates whose merge stage has no agent stage to go back to for a conflict, and one that has. */
  const writeMergeTemplates = (workflowsDir: string) => {
    writeFile(
      join(workflowsDir, 'to-review.yaml'),
      `id: to-review
stages:
  - id: implement
    agent: claude-coder
  - id: review
    kind: review
    agent: claude-reviewer
  - id: merge
    kind: merge
    on_fail: review
`,
    );
    writeFile(
      join(workflowsDir, 'merge-only.yaml'),
      `id: merge-only
stages:
  - id: merge
    kind: merge
`,
    );
    writeFile(
      join(workflowsDir, 'to-coding.yaml'),
      `id: to-coding
stages:
  - id: implement
    agent: claude-coder
  - id: review
    kind: review
    agent: claude-reviewer
  - id: merge
    kind: merge
    on_fail: implement
`,
    );
  };

  it('warns when a merge conflict has no agent stage to resolve it', () => {
    const paths = home();
    writeMergeTemplates(paths.workflowsDir);
    const cfg = loadConfig(paths, ['claude-code']);
    for (const id of ['to-review', 'merge-only', 'to-coding']) {
      expect(cfg.errors[`workflows/${id}.yaml`]).toBeUndefined();
      expect(cfg.templates.has(id)).toBe(true);
    }

    const toReview = cfg.warnings['workflows/to-review.yaml'] ?? [];
    expect(toReview).toEqual([
      '阶段 merge：合并阶段失败时回退到的 review 不是 Agent 阶段。合并目标分支的最新代码发生冲突时，没有 Agent 能解决，Run 会直接结束、标为失败，从 issue 来的 Run 会在 max_run_attempts 的限制内基于目标分支的最新代码自动重做。想让 Agent 解决冲突，就把 on_fail 指向一个 Agent 阶段（kind: agent）',
    ]);
    expect(cfg.warnings['workflows/merge-only.yaml']).toEqual([
      expect.stringMatching(/^阶段 merge：合并阶段失败时没有可回退的 Agent 阶段。合并目标分支/),
    ]);
    // Going back to an agent stage, explicitly or by default (the self-dev template): no warning.
    expect(cfg.warnings['workflows/to-coding.yaml']).toBeUndefined();
    expect(cfg.warnings['workflows/self-dev.yaml']).toBeUndefined();
  });

  it('warns when a merge conflict has no agent stage to resolve it in English too', () => {
    setLang('en');
    const paths = home();
    writeMergeTemplates(paths.workflowsDir);
    const cfg = loadConfig(paths, ['claude-code']);
    expect(cfg.warnings['workflows/to-review.yaml']).toEqual([
      'Stage merge: the merge stage goes back to review when it fails, which is not an agent stage. When merging the latest target branch runs into conflicts, no agent can resolve them, so the Run ends as failed, and a Run from an issue is redone on the latest target branch within max_run_attempts. To have an agent resolve conflicts, point on_fail at an agent stage (kind: agent)',
    ]);
    const mergeOnly = cfg.warnings['workflows/merge-only.yaml'] ?? [];
    expect(mergeOnly).toEqual([
      expect.stringMatching(/^Stage merge: the merge stage has no agent stage to go back to\. /),
    ]);
    for (const warning of [...(cfg.warnings['workflows/to-review.yaml'] ?? []), ...mergeOnly]) {
      expect(warning).not.toMatch(/[一-鿿]/);
    }
    expect(cfg.warnings['workflows/to-coding.yaml']).toBeUndefined();
    expect(cfg.warnings['workflows/self-dev.yaml']).toBeUndefined();
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
      on_budget_exceeded: 'abort',
      on_exhausted: 'fail',
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

describe('redo after a failure', () => {
  const MIN = 60_000;
  const MAX = REDO_BACKOFF_MAX_HOURS * 60 * MIN;

  it('waits poll_minutes after the first failure and doubles the wait with each one after', () => {
    expect(redoDelayMs(1, 5)).toBe(5 * MIN);
    expect(redoDelayMs(2, 5)).toBe(10 * MIN);
    expect(redoDelayMs(3, 5)).toBe(20 * MIN);
    expect(redoDelayMs(4, 5)).toBe(40 * MIN);
    expect(redoDelayMs(3, 1.5)).toBe(6 * MIN);
  });

  it('waits at most REDO_BACKOFF_MAX_HOURS', () => {
    expect(REDO_BACKOFF_MAX_HOURS).toBe(2);
    expect(redoDelayMs(5, 5)).toBe(80 * MIN);
    expect(redoDelayMs(6, 5)).toBe(MAX);
    expect(redoDelayMs(100, 5)).toBe(MAX);
    expect(redoDelayMs(5_000, 5)).toBe(MAX);
    // A poll interval longer than the cap is capped too.
    expect(redoDelayMs(1, 180)).toBe(MAX);
  });

  it('counts from when the failed Run ended, only while its issue waits for the redo', () => {
    const finishedAt = '2026-11-20T00:00:00.000Z';
    const ended = Date.parse(finishedAt);
    const failed = (attempt: number | undefined, redo?: RedoState) => ({
      status: 'failed' as const,
      finishedAt,
      updatedAt: '2026-11-20T00:30:00.000Z',
      issue: { repo: 'me/demo', number: 1, url: '', auto: false, attempt, redo },
    });
    expect(redoDueAt(failed(1, 'pending'), 5)).toBe(ended + 5 * MIN);
    expect(redoDueAt(failed(2, 'pending'), 5)).toBe(ended + 10 * MIN);
    // Runs from before attempts were counted are the first.
    expect(redoDueAt(failed(undefined, 'pending'), 5)).toBe(ended + 5 * MIN);
    expect(redoDueAt({ ...failed(1, 'pending'), finishedAt: null }, 5)).toBe(
      Date.parse('2026-11-20T00:30:00.000Z') + 5 * MIN,
    );
    for (const redo of [undefined, 'redone', 'exhausted', 'abandoned'] as const) {
      expect(redoDueAt(failed(1, redo), 5)).toBeNull();
    }
    expect(redoDueAt({ ...failed(1, 'pending'), status: 'cancelled' }, 5)).toBeNull();
    expect(redoDueAt({ ...failed(1, 'pending'), issue: null }, 5)).toBeNull();
  });
});

describe('leftoverWorkspaces', () => {
  type IssueRun = Pick<Run, 'id' | 'status' | 'issue'>;
  const run = (id: string, status: RunStatus, number: number | null, redo?: RedoState) =>
    ({
      id,
      status,
      issue:
        number === null
          ? null
          : { repo: 'me/demo', number, url: '', auto: false, attempt: 1, redo },
    }) satisfies IssueRun;
  const event = (runId: string, type: string, data: Record<string, unknown> = {}) => ({
    runId,
    type,
    data,
  });

  it('lists the failed attempts a later Run of the issue completed after', () => {
    const runs = [
      run('a1', 'failed', 1, 'redone'),
      run('a2', 'failed', 1, 'redone'),
      run('a3', 'completed', 1),
      // Failed after the completion: a redo is still to come, nothing supersedes it.
      run('a4', 'failed', 1, 'pending'),
      run('a5', 'completed', 1),
      // Another issue completed: not this one's.
      run('b1', 'failed', 2, 'pending'),
      run('c1', 'completed', 3),
    ];
    expect(leftoverWorkspaces(runs, [])).toEqual([
      { runId: 'a1', why: { reason: 'superseded', supersededBy: 'a3' } },
      { runId: 'a2', why: { reason: 'superseded', supersededBy: 'a3' } },
      { runId: 'a4', why: { reason: 'superseded', supersededBy: 'a5' } },
    ]);
  });

  it('keeps only the last attempt once the newest Run of the issue used up its attempts', () => {
    const runs = [
      run('a1', 'failed', 1, 'redone'),
      run('a2', 'cancelled', 1),
      run('a3', 'failed', 1, 'redone'),
      run('a4', 'failed', 1, 'exhausted'),
      // Recorded issue.retries_exhausted: its redo state does not matter then.
      run('b1', 'failed', 2, 'redone'),
      run('b2', 'failed', 2),
      // The newest still goes on, or failed with a redo to come: nothing yet.
      run('c1', 'failed', 3, 'exhausted'),
      run('c2', 'running', 3),
      run('d1', 'failed', 4, 'redone'),
      run('d2', 'failed', 4, 'pending'),
    ];
    const events = [event('b2', 'issue.retries_exhausted', { runIds: ['b1', 'b2'] })];
    expect(leftoverWorkspaces(runs, events)).toEqual([
      { runId: 'a1', why: { reason: 'retries_exhausted', keptRun: 'a4' } },
      { runId: 'a3', why: { reason: 'retries_exhausted', keptRun: 'a4' } },
      { runId: 'b1', why: { reason: 'retries_exhausted', keptRun: 'b2' } },
    ]);
  });

  it('lists the attempts an issue.retries_exhausted named even after the issue started over', () => {
    const runs = [
      run('a1', 'failed', 1, 'redone'),
      run('a2', 'failed', 1, 'redone'),
      run('a3', 'failed', 1, 'exhausted'),
      // A human started the issue over with ares1:ready; the new Run still goes on.
      run('a4', 'running', 1),
    ];
    const events = [event('a3', 'issue.retries_exhausted', { runIds: ['a1', 'a2', 'a3'] })];
    expect(leftoverWorkspaces(runs, events)).toEqual([
      { runId: 'a1', why: { reason: 'retries_exhausted', keptRun: 'a3' } },
      { runId: 'a2', why: { reason: 'retries_exhausted', keptRun: 'a3' } },
    ]);
    // Used up again: everything before the newest goes, the earlier last attempt too.
    const again = [...runs.slice(0, 3), run('a4', 'failed', 1, 'exhausted')];
    expect(leftoverWorkspaces(again, events)).toEqual([
      { runId: 'a1', why: { reason: 'retries_exhausted', keptRun: 'a4' } },
      { runId: 'a2', why: { reason: 'retries_exhausted', keptRun: 'a4' } },
      { runId: 'a3', why: { reason: 'retries_exhausted', keptRun: 'a4' } },
    ]);
  });

  it('lists the Runs terminated because their issue changed, not those a human terminated', () => {
    const runs = [
      run('a1', 'cancelled', 1),
      run('a2', 'cancelled', 1),
      run('a3', 'queued', 1),
      run('b1', 'cancelled', 2),
    ];
    const events = [
      event('a2', 'run.goal_changed', { repo: 'me/demo', issue: 1, newRun: 'a3' }),
      // Not a Run of an issue: nothing to go by.
      event('x1', 'run.goal_changed', { newRun: 'x2' }),
    ];
    expect(leftoverWorkspaces(runs, events)).toEqual([
      { runId: 'a2', why: { reason: 'goal_changed', newRun: 'a3' } },
    ]);
  });

  it('passes by what was removed, Runs not from an issue and every other status', () => {
    const runs = [
      run('a1', 'failed', 1, 'redone'),
      run('a2', 'failed', 1, 'redone'),
      run('a3', 'cancelled', 1),
      run('a4', 'completed', 1),
      run('l1', 'failed', null),
      run('l2', 'completed', null),
      ...(['queued', 'running', 'paused', 'blocked', 'waiting_approval', 'dropped'] as const).map(
        (status, i) => run(`s${i}`, status, 9),
      ),
      run('s9', 'completed', 9),
    ];
    const events = [
      event('a1', 'workspace.removed', { reason: 'superseded', supersededBy: 'a4' }),
      event('a3', 'run.goal_changed', { newRun: 'a4' }),
      event('a3', 'workspace.removed', { reason: 'goal_changed', newRun: 'a4' }),
      // Other events and events without a Run change nothing.
      event('a2', 'workspace.cleanup_failed', { reason: 'superseded', supersededBy: 'a4' }),
      { runId: null, type: 'workspace.removed', data: {} },
    ];
    expect(leftoverWorkspaces(runs, events)).toEqual([
      { runId: 'a2', why: { reason: 'superseded', supersededBy: 'a4' } },
    ]);
  });
});

describe('scoutBackoff', () => {
  const MIN = 60_000;
  const at = (min: number) => new Date(Date.UTC(2026, 10, 20, 0, min)).toISOString();
  /** A scout that started at minute `min` and ran a minute. */
  const scout = (
    min: number,
    status: Scout['status'],
    proposals: Pick<ScoutProposal, 'issue'>[] = [],
  ) => ({
    status,
    proposals: proposals as ScoutProposal[],
    startedAt: at(min),
    endedAt: status === 'running' ? null : at(min + 1),
  });
  const filed = [{ issue: { number: 1, url: '', auto: false } }];

  it('has none before any scout, or after a scout that filed an issue', () => {
    expect(scoutBackoff([], 5)).toBeNull();
    expect(scoutBackoff([scout(10, 'completed', filed), scout(0, 'failed')], 5)).toBeNull();
  });

  it('doubles poll_minutes with every scout in a row that found nothing or failed', () => {
    const one = [scout(20, 'completed')];
    expect(scoutBackoff(one, 5)).toEqual({ count: 1, until: at(21 + 5) });
    // Proposals that filed no issue (duplicates, GitHub failing) found nothing either.
    const two = [scout(30, 'completed', [{}]), ...one];
    expect(scoutBackoff(two, 5)).toEqual({ count: 2, until: at(31 + 10) });
    const three = [scout(40, 'failed'), ...two, scout(10, 'completed', filed), scout(0, 'failed')];
    expect(scoutBackoff(three, 5)).toEqual({ count: 3, until: at(41 + 20) });
  });

  it('waits 6 hours at most, however long the streak', () => {
    const scouts = Array.from({ length: 80 }, (_, i) => scout(1000 - i * 10, 'failed'));
    const backoff = scoutBackoff(scouts, 5);
    expect(backoff?.count).toBe(80);
    expect(backoff?.until).toBe(new Date(Date.parse(at(1001)) + 6 * 60 * MIN).toISOString());
  });

  it('skips scouts the Master cut short, or still running, and counts from the one before', () => {
    const scouts = [
      scout(50, 'running'),
      scout(40, 'interrupted'),
      scout(30, 'failed'),
      scout(20, 'interrupted'),
      scout(10, 'completed'),
    ];
    expect(scoutBackoff(scouts, 5)).toEqual({ count: 2, until: at(31 + 10) });
    expect(scoutBackoff([scout(10, 'interrupted')], 5)).toBeNull();
  });

  it('counts only scouts started after the target branch last changed', () => {
    const scouts = [scout(30, 'failed'), scout(20, 'completed'), scout(10, 'failed')];
    expect(scoutBackoff(scouts, 5, Date.parse(at(15)))).toEqual({ count: 2, until: at(31 + 10) });
    expect(scoutBackoff(scouts, 5, Date.parse(at(30)))).toEqual({ count: 1, until: at(31 + 5) });
    expect(scoutBackoff(scouts, 5, Date.parse(at(35)))).toBeNull();
  });

  it('counts from the start of a scout that has no end', () => {
    const scouts = [{ ...scout(10, 'failed'), endedAt: null }];
    expect(scoutBackoff(scouts, 5)).toEqual({ count: 1, until: at(15) });
  });

  it('neither counts nor ends the streak at scouts whose agent hit a limit', () => {
    const scouts = [
      scout(60, 'rate_limited'),
      scout(50, 'rate_limited'),
      scout(40, 'failed'),
      scout(30, 'rate_limited'),
      scout(20, 'completed'),
      scout(10, 'completed', filed),
    ];
    // The streak counted from the failure at 40, as if the limited scouts had not been.
    expect(scoutBackoff(scouts, 5)).toEqual({ count: 2, until: at(41 + 10) });
    expect(scoutBackoff([scout(10, 'rate_limited')], 5)).toBeNull();
    expect(scoutBackoff([scout(20, 'rate_limited'), scout(10, 'completed', filed)], 5)).toBeNull();
  });
});

describe('scoutFailureStreak', () => {
  const scouts = (...statuses: Scout['status'][]) => statuses.map((status) => ({ status }));

  it('is 0 without scouts, or when the newest that ended completed', () => {
    expect(scoutFailureStreak([])).toBe(0);
    expect(scoutFailureStreak(scouts('completed', 'failed', 'failed'))).toBe(0);
    expect(scoutFailureStreak(scouts('running', 'completed', 'failed'))).toBe(0);
  });

  it('counts failures in a row from the newest, up to a completed scout', () => {
    expect(scoutFailureStreak(scouts('failed'))).toBe(1);
    expect(scoutFailureStreak(scouts('failed', 'failed', 'failed'))).toBe(3);
    expect(scoutFailureStreak(scouts('failed', 'failed', 'completed', 'failed'))).toBe(2);
  });

  it('skips scouts still running, cut short by the Master, or that hit a limit', () => {
    const mixed = scouts(
      'running',
      'failed',
      'rate_limited',
      'interrupted',
      'failed',
      'rate_limited',
      'failed',
      'completed',
      'failed',
    );
    expect(scoutFailureStreak(mixed)).toBe(3);
    expect(scoutFailureStreak(scouts('rate_limited', 'interrupted', 'running'))).toBe(0);
  });
});

describe('scoutLimitWait', () => {
  const at = (min: number) => new Date(Date.UTC(2026, 10, 20, 0, min)).toISOString();
  /** A scout that started at minute `min` and ran a minute. */
  const scout = (min: number, status: Scout['status']) => ({
    status,
    startedAt: at(min),
    endedAt: status === 'running' ? null : at(min + 1),
  });
  const limitedInARow = (n: number) =>
    Array.from({ length: n }, (_, i) => scout(1000 - i * 100, 'rate_limited'));

  it('waits only while the newest scout that ended hit a limit', () => {
    expect(scoutLimitWait([])).toBeNull();
    expect(scoutLimitWait([scout(10, 'completed')])).toBeNull();
    expect(scoutLimitWait([scout(20, 'failed'), scout(10, 'rate_limited')])).toBeNull();
    // A reset time left over from an older limit does not hold a scout that ended otherwise.
    const after = [scout(20, 'completed'), scout(10, 'rate_limited')];
    expect(scoutLimitWait(after, Date.parse(at(300)))).toBeNull();
  });

  it('waits until the reset time the CLI gave, plus a minute', () => {
    const scouts = [scout(10, 'rate_limited'), scout(0, 'rate_limited')];
    expect(scoutLimitWait(scouts, Date.parse(at(200)))).toEqual({ count: 2, until: at(201) });
    // A reset time already past when the scout ended: as without one.
    expect(scoutLimitWait(scouts, Date.parse(at(5)))).toEqual({ count: 2, until: at(11 + 10) });
  });

  it('without a reset time waits 5, 10, 20, 40 minutes, then hourly, over the limits in a row', () => {
    const waits = [1, 2, 3, 4, 5, 6].map((n) => scoutLimitWait(limitedInARow(n)));
    expect(waits.map((w) => w?.count)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(waits.map((w) => w?.until)).toEqual([5, 10, 20, 40, 60, 60].map((m) => at(1001 + m)));
    // The same rule as a Run whose agent hit a limit.
    expect(waits.map((w) => Date.parse(w?.until ?? '') - Date.parse(at(1001)))).toEqual(
      [1, 2, 3, 4, 5, 6].map((n) => rateLimitDelayMs(RATE_LIMIT_WAIT, 0, undefined, n)),
    );
  });

  it('skips scouts the Master cut short or still running, and stops counting at any other', () => {
    const scouts = [
      scout(50, 'running'),
      scout(40, 'interrupted'),
      scout(30, 'rate_limited'),
      scout(20, 'interrupted'),
      scout(15, 'rate_limited'),
      scout(10, 'failed'),
      scout(5, 'rate_limited'),
    ];
    expect(scoutLimitWait(scouts)).toEqual({ count: 2, until: at(31 + 10) });
    expect(scoutLimitWait([scout(10, 'interrupted')])).toBeNull();
  });

  it('counts from the start of a scout that has no end', () => {
    const scouts = [{ ...scout(10, 'rate_limited'), endedAt: null }];
    expect(scoutLimitWait(scouts)).toEqual({ count: 1, until: at(15) });
  });
});

describe('splitUnfinishedRuns', () => {
  const asked = '2026-11-20T00:00:00.000Z';
  const ask: AssessmentEntry = {
    role: 'assessor',
    verdict: 'ask',
    summary: '不清楚',
    questions: ['写什么？'],
    suggestions: [],
    revisedGoal: null,
    proposedDrop: false,
    stageRunId: 'sr-assess',
    at: asked,
  };
  const reply: DiscussionEntry = { role: 'human', text: '写这个', source: 'issue', at: asked };
  const template = (reply_timeout_hours?: number | null): WorkflowTemplate =>
    TemplateSchema.parse({
      id: 't',
      stages: [
        { id: 'assess', kind: 'assess', agent: 'x', reply_timeout_hours },
        { id: 'code', agent: 'x' },
      ],
    });
  /** The stage runs of the fixtures: sr-assess belongs to the assess stage. */
  const stageIdOf = (id: string) => (id === 'sr-assess' ? 'assess' : undefined);
  type Fixture = Pick<Run, 'status' | 'blocked' | 'discussion' | 'template' | 'issue'> & {
    id: string;
  };
  const run = (
    id: string,
    status: RunStatus,
    kind?: BlockKind,
    opts: {
      hours?: number | null;
      discussion?: DiscussionEntry[];
      stageRunId?: string;
      redo?: RedoState;
    } = {},
  ): Fixture => ({
    id,
    status,
    blocked: kind
      ? { kind, message: '', stageRunId: 'stageRunId' in opts ? opts.stageRunId : 'sr-assess' }
      : null,
    discussion: opts.discussion ?? (kind === 'discussion' ? [ask] : []),
    template: template(opts.hours),
    issue: { repo: 'me/demo', number: 1, url: '', auto: false, attempt: 1, redo: opts.redo },
  });
  const ids = (runs: Fixture[]) => runs.map((r) => r.id);

  it('waits for queued and running Runs, and counts the ones only a human moves on', () => {
    const { moving, stuck } = splitUnfinishedRuns(
      [
        run('queued', 'queued'),
        run('running', 'running'),
        run('approval', 'waiting_approval'),
        run('paused', 'paused'),
        run('error', 'blocked', 'error'),
        run('setup', 'blocked', 'setup_failed'),
        run('budget', 'blocked', 'budget'),
        run('stranger', 'blocked', 'untrusted_issue'),
        run('completed', 'completed'),
        run('failed', 'failed'),
        run('cancelled', 'cancelled'),
        run('dropped', 'dropped'),
      ],
      stageIdOf,
    );
    expect(ids(moving)).toEqual(['queued', 'running']);
    expect(ids(stuck)).toEqual(['approval', 'paused', 'error', 'setup', 'budget', 'stranger']);
  });

  it('waits for failed Runs whose issue is to be redone, and never counts them as stuck', () => {
    const { moving, redo, stuck } = splitUnfinishedRuns(
      [
        run('pending', 'failed', undefined, { redo: 'pending' }),
        run('redone', 'failed', undefined, { redo: 'redone' }),
        run('exhausted', 'failed', undefined, { redo: 'exhausted' }),
        run('abandoned', 'failed', undefined, { redo: 'abandoned' }),
        // Not caught up on the issue yet: nothing is decided about a redo.
        run('unsynced', 'failed'),
        { ...run('no-issue', 'failed'), issue: null },
        run('queued', 'queued'),
      ],
      stageIdOf,
    );
    expect(ids(redo)).toEqual(['pending']);
    expect(ids(moving)).toEqual(['queued']);
    expect(ids(stuck)).toEqual([]);
  });

  it('lets a Run waiting for changes on its target branch to clear move on, as the engine does', () => {
    const { moving, stuck } = splitUnfinishedRuns(
      [
        run('dirty', 'blocked', 'target_dirty'),
        run('conflict', 'blocked', 'merge_conflict'),
        run('workspace', 'blocked', 'workspace'),
      ],
      stageIdOf,
    );
    expect(ids(moving)).toEqual(['dirty']);
    expect(ids(stuck)).toEqual(['conflict', 'workspace']);
  });

  it('lets a Run waiting for a reply move on only when the reply times out, as the engine does', () => {
    const { moving, stuck } = splitUnfinishedRuns(
      [
        run('default', 'blocked', 'discussion'),
        run('half-hour', 'blocked', 'discussion', { hours: 0.5 }),
        run('forever', 'blocked', 'discussion', { hours: null }),
        // Not waiting on the questions any more: a human replied after them.
        run('replied', 'blocked', 'discussion', { discussion: [ask, reply] }),
        // The stage is unknown: nothing times it out.
        run('no-stage', 'blocked', 'discussion', { stageRunId: 'sr-gone' }),
        run('no-stage-run', 'blocked', 'discussion', { stageRunId: undefined }),
      ],
      stageIdOf,
    );
    expect(ids(moving)).toEqual(['default', 'half-hour']);
    expect(ids(stuck)).toEqual(['forever', 'replied', 'no-stage', 'no-stage-run']);
  });

  it('works out when the reply times out', () => {
    const at = Date.parse(asked);
    expect(discussionReplyWait(run('d', 'blocked', 'discussion'), stageIdOf)).toEqual({
      deadline: at + 24 * 3_600_000,
      hours: 24,
    });
    expect(discussionReplyWait(run('d', 'blocked', 'discussion', { hours: 0 }), stageIdOf)).toEqual(
      { deadline: at, hours: 0 },
    );
    expect(
      discussionReplyWait(run('d', 'blocked', 'discussion', { hours: null }), stageIdOf),
    ).toBeNull();
    expect(discussionReplyWait(run('e', 'blocked', 'error'), stageIdOf)).toBeNull();
    const notBlocked = { ...run('d', 'blocked', 'discussion'), status: 'running' as const };
    expect(discussionReplyWait(notBlocked, stageIdOf)).toBeNull();
  });
});
