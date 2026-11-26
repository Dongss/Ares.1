import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigView } from '../../../src/api/types.js';
import { AgentSchema, TemplateSchema } from '../../../src/config/schema.js';
import { setLang } from '../../../src/i18n.js';
import {
  AGENT_STATE,
  agentRows,
  cliNote,
  configEntryErrors,
  configFileWarnings,
  findRepoTemplate,
  REPO_TEMPLATE_STATE,
  repoSourceInfo,
  repoSourceOf,
  repoTemplateBadges,
  repoTemplateChoice,
  repoTemplateGroups,
  repoTemplateNotes,
  repoTemplateProblems,
  templateAnchor,
  templateCards,
  templateSourceText,
} from './config.js';

const dev = TemplateSchema.parse({
  id: 'dev',
  name: '开发',
  stages: [{ id: 'a', agent: 'coder' }],
});
const agent = (id: string, raw: unknown) => ({ ...AgentSchema.parse(raw), id });

const view: ConfigView = {
  language: 'zh',
  perRepo: 1,
  maxRuns: null,
  agents: [
    agent('coder', { cli: 'claude-code', model: 'sonnet', effort: 'high', tags: ['coding'] }),
  ],
  templates: [dev],
  errors: { 'workflows/bad.yaml': ['stages: 至少一个'], 'agents.yaml#typo': ['tierr: 多余'] },
  warnings: {},
  repoSources: {},
  loadedAt: '2026-11-19T00:00:00.000Z',
  reloadError: null,
  restartNeeded: [],
  dir: '/home/me/.ares1',
  configFile: { path: '/home/me/.ares1/config.yaml', source: 'port: 4870\n' },
  agentsFile: { path: '/home/me/.ares1/agents.yaml', source: 'agents: {}\n' },
  agentEntries: [
    {
      id: 'coder',
      state: 'enabled',
      config: agent('coder', {
        cli: 'claude-code',
        model: 'sonnet',
        effort: 'high',
        tags: ['coding'],
      }),
      rawCli: 'claude-code',
      rawModel: 'sonnet',
      errors: [],
      warnings: [],
    },
    {
      id: 'legacy',
      state: 'disabled',
      config: agent('legacy', {
        cli: 'claude-code',
        model: 'opus',
        tier: 'high',
        cost: 'high',
        args: ['--effort', 'max'],
        enabled: false,
      }),
      rawCli: 'claude-code',
      rawModel: 'opus',
      errors: [],
      warnings: [],
    },
    {
      id: 'typo',
      state: 'invalid',
      config: null,
      rawCli: 'claude-code',
      rawModel: null,
      errors: ['tierr: 多余', 'model: 必填'],
      warnings: [],
    },
    {
      id: 'codex-docs',
      state: 'enabled',
      config: agent('codex-docs', { cli: 'codex', model: 'gpt-5.5', permission: 'safe' }),
      rawCli: 'codex',
      rawModel: 'gpt-5.5',
      errors: [],
      warnings: ['Codex 没有「只改文件、不执行命令」的模式'],
    },
  ],
  clis: [
    { cli: 'claude-code', readOnly: true },
    { cli: 'cursor-agent', readOnly: false },
    { cli: 'codex', readOnly: true },
  ],
  templateFiles: [
    {
      key: 'workflows/bad.yaml',
      file: 'bad.yaml',
      path: '/home/me/.ares1/workflows/bad.yaml',
      source: 'id: bad\n',
      templateId: null,
      errors: ['stages: 至少一个'],
      warnings: [],
    },
    {
      key: 'workflows/dev.yaml',
      file: 'dev.yaml',
      path: '/home/me/.ares1/workflows/dev.yaml',
      source: 'id: dev\n',
      templateId: 'dev',
      errors: [],
      warnings: ['评审 Agent 相同'],
    },
  ],
  repoTemplates: [],
};

/** A template parsed from the smallest valid YAML, with `name` to tell versions apart. */
const tpl = (id: string, name = id) =>
  TemplateSchema.parse({ id, name, stages: [{ id: 'a', agent: 'coder' }] });

const appX = tpl('x', 'app 的 x');
const appY = tpl('y', '上次成功的 y');
const appDev = tpl('dev', '仓库里的 dev');
const webX = tpl('x', 'web 的 x');
const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const GOOD_SHA = '11111111222222233333334444444555555566666';

/** The home directory's `dev`, and two repos keeping templates: every case of a repo's file. */
const withRepos: ConfigView = {
  ...view,
  repoTemplates: [
    {
      repo: 'app',
      branch: 'main',
      sha: SHA,
      templates: [appX, appY, appDev],
      files: [
        {
          key: 'app:.ares1/workflows/a.yaml',
          file: 'a.yaml',
          path: '.ares1/workflows/a.yaml',
          source: 'id: x\n',
          templateId: 'x',
          errors: [],
          warnings: ['阶段 a 没有检查命令'],
        },
        {
          key: 'app:.ares1/workflows/b.yaml',
          file: 'b.yaml',
          path: '.ares1/workflows/b.yaml',
          source: 'id: b\n',
          templateId: null,
          errors: ['stages: 至少一个', 'name: 必须是字符串'],
          warnings: [],
        },
        {
          key: 'app:.ares1/workflows/c.yaml',
          file: 'c.yaml',
          path: '.ares1/workflows/c.yaml',
          source: 'id: [\n',
          templateId: 'y',
          errors: [],
          warnings: [],
          lastGood: { sha: GOOD_SHA, source: 'id: y\n', errors: ['不是合法的 YAML'] },
        },
        {
          key: 'app:.ares1/workflows/dev.yaml',
          file: 'dev.yaml',
          path: '.ares1/workflows/dev.yaml',
          source: 'id: dev\n',
          templateId: 'dev',
          errors: [],
          warnings: [],
          shadowed: true,
        },
      ],
    },
    {
      repo: 'web',
      branch: 'trunk',
      sha: GOOD_SHA,
      templates: [webX],
      files: [
        {
          key: 'web:.ares1/workflows/x.yaml',
          file: 'x.yaml',
          path: '.ares1/workflows/x.yaml',
          source: 'id: x\n',
          templateId: 'x',
          errors: [],
          warnings: [],
        },
      ],
    },
  ],
};

describe('repoTemplateGroups', () => {
  it('gives each repo its cards, telling valid, invalid, overridden and earlier versions apart', () => {
    const groups = repoTemplateGroups(withRepos);
    expect(groups.map((g) => [g.repo, g.branch, g.sha])).toEqual([
      ['app', 'main', SHA],
      ['web', 'trunk', GOOD_SHA],
    ]);
    const [app, web] = groups;
    expect(
      app?.cards.map((c) => [c.file, c.path, c.state, c.template?.name ?? null, c.homeFile]),
    ).toEqual([
      ['a.yaml', 'app:.ares1/workflows/a.yaml', 'valid', 'app 的 x', null],
      ['b.yaml', 'app:.ares1/workflows/b.yaml', 'invalid', null, null],
      ['c.yaml', 'app:.ares1/workflows/c.yaml', 'valid', '上次成功的 y', null],
      [
        'dev.yaml',
        'app:.ares1/workflows/dev.yaml',
        'shadowed',
        '仓库里的 dev',
        'workflows/dev.yaml',
      ],
    ]);
    const [valid, invalid, earlier] = app?.cards ?? [];
    expect(valid).toMatchObject({ warnings: ['阶段 a 没有检查命令'], lastGood: null });
    expect(invalid?.errors).toEqual(['stages: 至少一个', 'name: 必须是字符串']);
    // The YAML as on the branch, and the version in use with why the branch's fails.
    expect(earlier).toMatchObject({
      source: 'id: [\n',
      lastGood: { sha: GOOD_SHA, source: 'id: y\n', errors: ['不是合法的 YAML'] },
    });
    expect(web?.cards.map((c) => [c.path, c.template?.name])).toEqual([
      ['web:.ares1/workflows/x.yaml', 'web 的 x'],
    ]);
    expect(repoTemplateGroups(view)).toEqual([]);
  });

  it('badges and notes each case', () => {
    const [valid, invalid, earlier, shadowed] = repoTemplateGroups(withRepos)[0]?.cards ?? [];
    if (!valid || !invalid || !earlier || !shadowed) throw new Error('missing cards');
    const labels = (c: typeof valid) => repoTemplateBadges(c).map((b) => [b.label, b.tone]);
    expect(labels(valid)).toEqual([['有效', 'success']]);
    expect(labels(invalid)).toEqual([['无效，未加载', 'danger']]);
    expect(labels(earlier)).toEqual([
      ['有效', 'success'],
      ['用的是上次加载成功的版本（11111111）', 'attention'],
    ]);
    expect(labels(shadowed)).toEqual([['被数据目录覆盖，没有生效', 'muted']]);

    expect(repoTemplateNotes(valid)).toEqual([]);
    expect(repoTemplateNotes(invalid)).toEqual([]);
    expect(repoTemplateNotes(earlier)).toEqual([
      '目标分支上的这个文件加载失败，继续用上次加载成功的版本（提交 11111111），直到把它改好。',
    ]);
    expect(repoTemplateNotes(shadowed)).toEqual([
      '数据目录里也有 id 为 dev 的模板（workflows/dev.yaml），这个仓库的 Run 用的是数据目录那份，这份没有生效。想改用仓库里的，就删掉数据目录里的那个文件。',
    ]);
  });
});

describe('repoTemplateProblems', () => {
  it("lists a repo's problems after their files, and none for a repo without any", () => {
    expect(repoTemplateProblems(withRepos, 'app')).toEqual([
      {
        file: 'app:.ares1/workflows/a.yaml',
        tone: 'attention',
        text: '阶段 a 没有检查命令',
      },
      {
        file: 'app:.ares1/workflows/b.yaml',
        tone: 'danger',
        text: 'stages: 至少一个；name: 必须是字符串',
      },
      {
        file: 'app:.ares1/workflows/c.yaml',
        tone: 'attention',
        text: '目标分支上的这个文件加载失败，继续用上次加载成功的版本（提交 11111111），直到把它改好。失败原因：不是合法的 YAML',
      },
      {
        file: 'app:.ares1/workflows/dev.yaml',
        tone: 'attention',
        text: expect.stringMatching(/^数据目录里也有 id 为 dev 的模板（workflows\/dev\.yaml）/),
      },
    ]);
    expect(repoTemplateProblems(withRepos, 'web')).toEqual([]);
    expect(repoTemplateProblems(withRepos, 'nope')).toEqual([]);
  });
});

describe('repoTemplateChoice', () => {
  it("finds the home directory's first, then the repo's own, never another repo's", () => {
    // The home directory's dev overrides the one app keeps.
    expect(repoTemplateChoice(withRepos, 'app', 'dev')).toEqual({
      template: dev,
      source: 'home',
      file: 'workflows/dev.yaml',
    });
    expect(repoTemplateChoice(withRepos, 'app', 'x')).toEqual({
      template: appX,
      source: 'repo',
      file: 'app:.ares1/workflows/a.yaml',
    });
    // The version that last loaded stands in for the broken file.
    expect(repoTemplateChoice(withRepos, 'app', 'y')).toMatchObject({
      template: appY,
      file: 'app:.ares1/workflows/c.yaml',
    });
    expect(repoTemplateChoice(withRepos, 'web', 'x')?.template).toBe(webX);
    // Each repo sees its own only.
    expect(repoTemplateChoice(withRepos, 'web', 'y')).toBeNull();
    expect(repoTemplateChoice(withRepos, 'other', 'x')).toBeNull();
    expect(findRepoTemplate(withRepos, 'other', 'dev')).toEqual({ template: dev, source: 'home' });
    expect(repoTemplateChoice(withRepos, 'app', 'b')).toBeNull();
  });

  it('words where a template comes from', () => {
    expect(templateSourceText({ source: 'home', file: 'workflows/dev.yaml' })).toBe(
      '数据目录的 workflows/dev.yaml',
    );
    expect(templateSourceText({ source: 'repo', file: 'app:.ares1/workflows/a.yaml' })).toBe(
      '仓库自带的 app:.ares1/workflows/a.yaml',
    );
    expect(templateSourceText({ source: 'repo', file: null })).toBe('仓库自带');
  });
});

describe('repo templates in English', () => {
  afterEach(() => setLang('zh'));

  it('words badges, notes, problems and sources in English', () => {
    setLang('en');
    const english: ConfigView = {
      ...withRepos,
      repoTemplates: withRepos.repoTemplates.map((r) => ({
        ...r,
        files: r.files.map((f) => ({
          ...f,
          errors: f.errors.length ? ['stages: at least one'] : [],
          warnings: f.warnings.length ? ['stage a has no verify commands'] : [],
          ...(f.lastGood ? { lastGood: { ...f.lastGood, errors: ['not valid YAML'] } } : {}),
        })),
      })),
    };
    const cards = repoTemplateGroups(english)[0]?.cards ?? [];
    const texts = [
      ...cards.flatMap((c) => repoTemplateBadges(c).map((b) => b.label)),
      ...cards.flatMap((c) => repoTemplateNotes(c)),
      ...repoTemplateProblems(english, 'app').map((p) => p.text),
      templateSourceText({ source: 'home', file: 'workflows/dev.yaml' }),
      templateSourceText({ source: 'repo', file: 'app:.ares1/workflows/a.yaml' }),
      ...Object.values(REPO_TEMPLATE_STATE).map((s) => s.label),
    ];
    expect(texts).toContain('Using the version that last loaded (11111111)');
    expect(texts).toContain(
      'This file as on the target branch fails to load, so the version that last loaded (commit 11111111) stays in use until it is fixed. Why it fails: not valid YAML',
    );
    expect(texts).toContain("the repo's own app:.ares1/workflows/a.yaml");
    expect(Object.values(REPO_TEMPLATE_STATE).map((s) => s.label)).toEqual([
      'Valid',
      'Overridden by the home directory',
      'Invalid, not loaded',
    ]);
    expect(texts.join('\n')).not.toMatch(/[一-鿿]/);
  });
});

describe('templateCards', () => {
  it('pairs loaded templates with their files and keeps invalid files apart', () => {
    const { valid, invalid } = templateCards(view);
    expect(valid).toEqual([
      {
        key: 'workflows/dev.yaml',
        file: 'dev.yaml',
        path: '/home/me/.ares1/workflows/dev.yaml',
        source: 'id: dev\n',
        template: dev,
        errors: [],
        warnings: ['评审 Agent 相同'],
      },
    ]);
    expect(invalid.map((c) => [c.file, c.template, c.errors])).toEqual([
      ['bad.yaml', null, ['stages: 至少一个']],
    ]);
  });

  it('anchors template cards by id', () => {
    expect(templateAnchor('self-dev')).toBe('template-self-dev');
  });
});

describe('configFileWarnings', () => {
  it('shows the warnings about config.yaml, none when there are none', () => {
    expect(configFileWarnings(view)).toEqual([]);
    const warned: ConfigView = {
      ...view,
      warnings: {
        'config.yaml': ['未知的配置项 upgarde，已忽略'],
        'workflows/dev.yaml': ['评审 Agent 相同'],
      },
    };
    expect(configFileWarnings(warned)).toEqual(['未知的配置项 upgarde，已忽略']);
  });
});

describe('configEntryErrors', () => {
  it("lists the disabled entries of config.yaml by where they are, GitLab's among them", () => {
    expect(configEntryErrors(view)).toEqual([]);
    const errors = {
      ...view.errors,
      'config.yaml#gitlab.repos.app': ['app 已经在 github.repos 里，这里的配置不生效'],
      'config.yaml#backlog.repos.local': ['模板 nope 不存在'],
      'config.yaml#github.repos.hub': ['deliver: pr 要求 push: true'],
    };
    expect(configEntryErrors({ errors })).toEqual([
      { entry: 'backlog.repos.local', errors: ['模板 nope 不存在'] },
      { entry: 'github.repos.hub', errors: ['deliver: pr 要求 push: true'] },
      { entry: 'gitlab.repos.app', errors: ['app 已经在 github.repos 里，这里的配置不生效'] },
    ]);
  });
});

describe('where a repo gets its requirements', () => {
  afterEach(() => setLang('zh'));
  const sources: Pick<ConfigView, 'repoSources'> = {
    repoSources: {
      hub: { source: 'github', issuesRepo: 'me/hub' },
      guessed: { source: 'github', issuesRepo: null },
      lab: { source: 'gitlab', host: 'gitlab.example.com', issuesRepo: 'grp/sub/lab' },
      local: { source: 'backlog' },
    },
  };

  it('names the code host, with the GitLab host, and links to the issues there', () => {
    expect(repoSourceInfo(sources, 'hub')).toEqual({
      label: 'GitHub',
      issuesRepo: 'me/hub',
      url: 'https://github.com/me/hub/issues?q=is%3Aissue%20is%3Aopen',
      hint: null,
    });
    expect(repoSourceInfo(sources, 'guessed')).toEqual({
      label: 'GitHub',
      issuesRepo: null,
      url: null,
      hint: null,
    });
    expect(repoSourceInfo(sources, 'lab')).toEqual({
      label: 'GitLab（gitlab.example.com）',
      issuesRepo: 'grp/sub/lab',
      url: 'https://gitlab.example.com/grp/sub/lab/-/issues?state=opened',
      hint: null,
    });
    expect(repoSourceInfo(sources, 'local')).toMatchObject({ label: '本地提案池', url: null });
  });

  it('tells a repo of no source, also one named like an object property', () => {
    for (const name of ['nowhere', 'constructor', 'toString']) {
      expect(repoSourceOf(sources, name)).toBeNull();
      expect(repoSourceInfo(sources, name)).toEqual({
        label: '未配置',
        issuesRepo: null,
        url: null,
        hint: '不在 config.yaml 的 github.repos、gitlab.repos 和 backlog.repos 里，不会建 Run',
      });
    }
    expect(repoSourceOf(sources, 'lab')).toEqual(sources.repoSources.lab);
  });

  it('in English', () => {
    setLang('en');
    const texts = ['hub', 'lab', 'local', 'nowhere'].flatMap((name) => {
      const info = repoSourceInfo(sources, name);
      return [info.label, info.hint ?? ''];
    });
    expect(texts).toEqual([
      'GitHub',
      '',
      'GitLab (gitlab.example.com)',
      '',
      'Local backlog',
      '',
      'None',
      'In none of github.repos, gitlab.repos and backlog.repos of config.yaml, so it gets no Runs',
    ]);
    for (const text of texts) expect(text).not.toMatch(/[一-鿿]/);
  });
});

describe('agentRows', () => {
  it('lists every agent with its settings and why it is not in use', () => {
    expect(agentRows(view)).toEqual([
      {
        id: 'coder',
        state: 'enabled',
        cli: 'claude-code',
        model: 'sonnet',
        effort: 'high',
        tier: 'mid',
        cost: 'mid',
        tags: ['coding'],
        reason: null,
        warnings: [],
      },
      {
        id: 'legacy',
        state: 'disabled',
        cli: 'claude-code',
        model: 'opus',
        effort: 'max',
        tier: 'high',
        cost: 'high',
        tags: [],
        reason: '配置了 enabled: false',
        warnings: [],
      },
      {
        id: 'typo',
        state: 'invalid',
        cli: 'claude-code',
        model: null,
        effort: null,
        tier: null,
        cost: null,
        tags: [],
        reason: 'tierr: 多余；model: 必填',
        warnings: [],
      },
      {
        id: 'codex-docs',
        state: 'enabled',
        cli: 'codex',
        model: 'gpt-5.5',
        effort: null,
        tier: 'mid',
        cost: 'mid',
        tags: [],
        reason: null,
        // In use, with what to know about it.
        warnings: ['Codex 没有「只改文件、不执行命令」的模式'],
      },
    ]);
  });
});

describe('cliNote', () => {
  afterEach(() => setLang('zh'));

  it('lists the CLIs and the ones that run read-only', () => {
    expect(cliNote(view.clis)).toBe(
      'cli 可以写 claude-code、cursor-agent、codex。需求评估、拆分任务和侦察以只读方式运行，只能用 claude-code、codex 的 Agent。',
    );
    setLang('en');
    expect(cliNote(view.clis)).toBe(
      'cli can be claude-code, cursor-agent, codex. Assessments, task plans and scouts run read-only, which only agents of claude-code, codex can do.',
    );
  });

  it('says when no CLI runs read-only, and says nothing without CLIs', () => {
    const clis = [{ cli: 'cursor-agent', readOnly: false }];
    expect(cliNote(clis)).toBe(
      'cli 可以写 cursor-agent。其中没有能以只读方式运行的，所以需求评估、拆分任务和侦察都没法做。',
    );
    setLang('en');
    expect(cliNote(clis)).not.toMatch(/[一-鿿]/);
    expect(cliNote([])).toBeNull();
  });
});

describe('agentRows in English', () => {
  afterEach(() => setLang('zh'));

  it('says why an agent is not in use, and labels its state, in English', () => {
    setLang('en');
    const rows = agentRows(view);
    expect(rows.find((r) => r.id === 'legacy')?.reason).toBe('Set to enabled: false');
    // The problems themselves come from the Master, in its language; only the separator changes.
    expect(rows.find((r) => r.id === 'typo')?.reason).toBe('tierr: 多余; model: 必填');
    expect(Object.values(AGENT_STATE).map((s) => s.label)).toEqual([
      'Enabled',
      'Disabled',
      'Invalid',
    ]);
  });
});
