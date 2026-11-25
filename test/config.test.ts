import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  budgetPauses,
  chooseStageAgent,
  discussionReplyWait,
  issueRunOverrides,
  leftoverWorkspaces,
  levelRank,
  limitedScout,
  loopsExhausted,
  plansStage,
  RATE_LIMIT_WAIT,
  REDO_BACKOFF_MAX_HOURS,
  rateLimitDelayMs,
  recordedLimitWait,
  redoDelayMs,
  redoDueAt,
  resolveTemplate,
  scoutBackoff,
  scoutFailureStreak,
  scoutLimitWait,
  splitUnfinishedRuns,
  stageAgentIds,
  templateSplits,
} from '../src/config/flow.js';
import {
  ConfigError,
  findTemplate,
  githubConfigKey,
  homePaths,
  initHome,
  type LoadedConfig,
  loadConfig,
  type RepoTemplateSource,
} from '../src/config/load.js';
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
import { BUILTIN_CLIS, BUILTIN_READ_ONLY_CLIS } from '../src/master.js';
import {
  type AssessmentEntry,
  type BlockKind,
  DIFFICULTIES,
  type Difficulty,
  type DiscussionEntry,
  type RedoState,
  type Run,
  type RunStatus,
  type Scout,
  type ScoutProposal,
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
    // Coding is split into steps when the assessment sized the requirement L.
    expect(t?.stages.find((s) => s.id === 'implement')?.planning).toBe('auto');
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

  it("leaves workflows/ empty once its templates were deleted, to use the repos' own", () => {
    const paths = home();
    rmSync(join(paths.workflowsDir, 'self-dev.yaml'));
    // Every start runs it: a template written again would override the repo's of the same id.
    initHome(paths);
    expect(readdirSync(paths.workflowsDir)).toEqual([]);
    expect(loadConfig(paths, ['claude-code'], ['claude-code']).templates.size).toBe(0);
    // A home without workflows/ is new, and gets the default again.
    rmSync(paths.workflowsDir, { recursive: true });
    initHome(paths);
    expect(readdirSync(paths.workflowsDir)).toEqual(['self-dev.yaml']);
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
      '未知的配置项 upgarde，已忽略（是不是写错了？可用：language、port、bins、defaults、concurrency、github、notify、upgrade）',
      '未知的配置项 notfy，已忽略（是不是写错了？可用：language、port、bins、defaults、concurrency、github、notify、upgrade）',
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
concurrency: { per_repo: 2 }
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

  it('executes one Run of a repo at a time by default, more with concurrency.per_repo', () => {
    const paths = home();
    // The default config.yaml leaves it out.
    expect(loadConfig(paths, ['claude-code']).master.concurrency).toEqual({ per_repo: 1 });
    writeFile(paths.configFile, 'concurrency: {}\n');
    expect(loadConfig(paths, ['claude-code']).master.concurrency).toEqual({ per_repo: 1 });
    writeFile(paths.configFile, 'concurrency: { per_repo: 3 }\n');
    const cfg = loadConfig(paths, ['claude-code'], ['claude-code']);
    expect(cfg.master.concurrency.per_repo).toBe(3);
    expect(cfg.warnings).toEqual({});
    // At least one, a whole number; a typo in the section is an error, as in the other sections.
    for (const bad of ['0', '-1', '1.5', '"2"', 'null']) {
      writeFile(paths.configFile, `concurrency: { per_repo: ${bad} }\n`);
      expect(() => loadConfig(paths, ['claude-code']), bad).toThrow(/concurrency\.per_repo/);
    }
    writeFile(paths.configFile, 'concurrency: { per_rep: 2 }\n');
    expect(() => loadConfig(paths, ['claude-code'])).toThrow(/per_rep/);
  });

  it('takes a webhook with an http or https address, JSON by default', () => {
    const paths = home();
    expect(loadConfig(paths, ['claude-code']).master.notify).toEqual({ system: false });
    writeFile(paths.configFile, 'notify:\n  webhook:\n    url: https://ntfy.sh/my-topic\n');
    const cfg = loadConfig(paths, ['claude-code'], ['claude-code']);
    expect(cfg.master.notify).toEqual({
      system: false,
      webhook: { url: 'https://ntfy.sh/my-topic', headers: {}, format: 'json' },
    });
    expect(cfg.warnings).toEqual({});
    writeFile(
      paths.configFile,
      `notify:
  system: true
  webhook:
    url: http://127.0.0.1:8080/hook
    headers: { Authorization: Bearer tk_1, X-Priority: high }
    format: text
`,
    );
    expect(loadConfig(paths, ['claude-code']).master.notify).toEqual({
      system: true,
      webhook: {
        url: 'http://127.0.0.1:8080/hook',
        headers: { Authorization: 'Bearer tk_1', 'X-Priority': 'high' },
        format: 'text',
      },
    });
  });

  it('rejects a webhook address that is not http or https, or carries credentials', () => {
    const paths = home();
    const invalid = (webhook: string) => {
      writeFile(paths.configFile, `notify:\n  webhook: ${webhook}\n`);
      try {
        loadConfig(paths, ['claude-code']);
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        return (err as Error).message;
      }
      throw new Error(`accepted ${webhook}`);
    };
    for (const url of ['ftp://example.com/x', 'file:///etc/passwd', 'not a url', 'ntfy.sh/x']) {
      expect(invalid(`{ url: "${url}" }`)).toContain(
        'notify.webhook.url: 应为 http:// 或 https:// 开头的地址',
      );
    }
    const credentials = invalid('{ url: "https://me:secret@example.com/x" }');
    expect(credentials).toContain('notify.webhook.url: 地址里不能带用户名和密码');
    expect(credentials).not.toContain('secret');
    expect(invalid('{}')).toContain('notify.webhook.url');
    expect(invalid('{ url: "https://example.com", format: xml }')).toContain(
      'notify.webhook.format',
    );
    expect(invalid('{ url: "https://example.com", method: PUT }')).toContain('method');
    expect(invalid('{ url: "https://example.com", headers: { "a b": x } }')).toContain(
      'notify.webhook.headers.a b',
    );
    // The value is not repeated in the message: it may be a token.
    const value = invalid('{ url: "https://example.com", headers: { X-Token: "tk\\nsecret" } }');
    expect(value).toContain('请求头的值不能有换行');
    expect(value).not.toContain('secret');
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

  describe('auto-accepting size L with a template that cannot split it', () => {
    /** A template doing the coding in one go, whatever the size. */
    const WHOLE = `id: whole
stages:
  - { id: implement, agent: claude-coder }
  - { id: review, kind: review, agent: claude-reviewer }
  - { id: merge, kind: merge }
`;
    const LLM = WHOLE.replace('id: whole', 'id: llm').replace(
      'agent: claude-coder }',
      'agent: claude-coder, planning: llm }',
    );
    function load(repo: string, extra = '') {
      const paths = home();
      writeFile(join(paths.workflowsDir, 'whole.yaml'), WHOLE);
      writeFile(join(paths.workflowsDir, 'llm.yaml'), LLM);
      writeFile(paths.configFile, `${extra}github:\n  repos:\n    app: ${repo}\n`);
      return loadConfig(paths, ['claude-code'], ['claude-code']);
    }
    const WARNING =
      '仓库 app 会自动采纳大小为 L 的提案（auto_accept.max_size: L），但它用的模板 whole 没有 planning: auto 或 llm 的 Agent 阶段：L 的需求会整个交给一个 Run 一次做完，容易超时或返工。建议编码阶段用 planning: auto，或者把 max_size 调成 M，让 L 的提案留给人';

    it('warns when auto-accept takes L, max_size by default or written', () => {
      for (const accept of ['{ max_risk: low }', '{ max_risk: high, max_size: L }']) {
        const cfg = load(`{ template: whole, auto_accept: ${accept} }`);
        expect(cfg.warnings, accept).toEqual({ 'config.yaml': [WARNING] });
        // Only a warning: the repo and its template keep working.
        expect(cfg.errors, accept).toEqual({});
        expect(cfg.templates.has('whole')).toBe(true);
        expect(cfg.master.github?.repos.app?.auto_accept.max_size).toBe('L');
      }
    });

    it('joins the warnings about unknown keys instead of replacing them', () => {
      const cfg = load('{ template: whole, auto_accept: { max_risk: mid } }', 'upgarde: {}\n');
      expect(cfg.warnings['config.yaml']).toEqual([
        expect.stringMatching(/^未知的配置项 upgarde，已忽略/),
        WARNING,
      ]);
    });

    it('does not warn with a template that splits, or when auto-accept leaves L to a human', () => {
      for (const repo of [
        // The default self-dev template plans its coding stage (planning: auto).
        '{ template: self-dev, auto_accept: { max_risk: high } }',
        '{ template: llm, auto_accept: { max_risk: high } }',
        '{ template: whole, auto_accept: { max_risk: high, max_size: M } }',
        '{ template: whole, auto_accept: { max_risk: low, max_size: S } }',
        '{ template: whole, auto_accept: { max_risk: none } }',
        '{ template: whole }',
      ]) {
        const cfg = load(repo);
        expect(cfg.warnings, repo).toEqual({});
        expect(cfg.errors, repo).toEqual({});
      }
    });

    it('a missing template gets only its error', () => {
      const cfg = load('{ template: nope, auto_accept: { max_risk: high } }');
      expect(cfg.warnings).toEqual({});
      expect(cfg.errors).toEqual({ [githubConfigKey('app')]: ['模板 nope 不存在或无效'] });
    });

    it('warns in English when config.yaml says so', () => {
      try {
        const cfg = load('{ template: whole, auto_accept: { max_risk: low } }', 'language: en\n');
        expect(cfg.warnings).toEqual({
          'config.yaml': [
            'Repo app auto-accepts size L proposals (auto_accept.max_size: L), but its template whole has no agent stage with planning: auto or llm: an L requirement goes to one Run as a whole, done in one go and likely to time out or need rework. Better set planning: auto on the coding stage, or lower max_size to M to leave L proposals to a human',
          ],
        });
        expect(cfg.warnings['config.yaml']?.[0]).not.toMatch(/[一-鿿]/);
      } finally {
        // Back to the default language, zod's messages included, for the other tests.
        load('{ template: whole }');
      }
    });
  });

  describe("repos' own templates", () => {
    /** A template the default agents can run, without warnings. */
    const X = `id: x
stages:
  - { id: implement, agent: claude-coder }
  - { id: review, kind: review, agent: claude-reviewer }
  - { id: merge, kind: merge }
`;
    const BROKEN_YAML = 'id: x\nstages: [\n';
    const UNKNOWN_AGENT = X.replace('agent: claude-coder', 'agent: nobody');
    const SHA1 = '1'.repeat(40);
    const SHA2 = '2'.repeat(40);
    const SHA3 = '3'.repeat(40);

    function source(sha: string, files: Record<string, string>): RepoTemplateSource {
      return {
        branch: 'main',
        sha,
        files: Object.entries(files).map(([file, source]) => ({ file, source })),
      };
    }

    /** Load with `repos` registered for GitHub and the repos' files `sources`. */
    function load(
      paths: ReturnType<typeof homePaths>,
      repos: string,
      sources: Record<string, RepoTemplateSource>,
      previous?: LoadedConfig,
    ) {
      writeFile(paths.configFile, `github:\n  repos:\n${repos}`);
      return loadConfig(paths, ['claude-code'], ['claude-code'], {
        repoSources: new Map(Object.entries(sources)),
        previous,
      });
    }

    it("finds a repo's template by the repo's template id, only for that repo", () => {
      const paths = home();
      const repos = '    app: { template: x }\n    other: { template: x }\n';
      const cfg = load(paths, repos, { app: source(SHA1, { 'x.yaml': X }) });
      // The other repo does not see app's template.
      expect(cfg.errors).toEqual({ [githubConfigKey('other')]: ['模板 x 不存在或无效'] });
      expect(cfg.warnings).toEqual({});
      expect(cfg.templates.has('x')).toBe(false);
      expect(findTemplate(cfg, 'app', 'x')).toMatchObject({
        source: 'repo',
        template: { id: 'x' },
      });
      expect(findTemplate(cfg, 'other', 'x')).toBeNull();
      // The home directory's templates are seen by every repo.
      expect(findTemplate(cfg, 'other', 'self-dev')?.source).toBe('home');
      expect(cfg.repoTemplates.get('app')).toMatchObject({
        repo: 'app',
        branch: 'main',
        sha: SHA1,
        files: [
          {
            key: 'app:.ares1/workflows/x.yaml',
            file: 'x.yaml',
            path: '.ares1/workflows/x.yaml',
            source: X,
            templateId: 'x',
            errors: [],
            warnings: [],
          },
        ],
      });
      expect([...(cfg.repoTemplates.get('app')?.templates.keys() ?? [])]).toEqual(['x']);
      expect(cfg.repoTemplates.has('other')).toBe(false);

      // Each repo has its own, even with the same id.
      const both = load(paths, repos, {
        app: source(SHA1, { 'x.yaml': X }),
        other: source(SHA2, { 'x.yaml': X.replace('{ id: merge', '{ id: land') }),
      });
      expect(both.errors).toEqual({});
      expect(findTemplate(both, 'other', 'x')?.template.stages.map((s) => s.id)).toContain('land');
      expect(findTemplate(both, 'app', 'x')?.template.stages.map((s) => s.id)).toContain('merge');

      // Without the repos' files, nothing changes from before.
      const without = loadConfig(paths, ['claude-code'], ['claude-code']);
      expect(without.repoTemplates.size).toBe(0);
      expect(without.errors).toEqual({
        [githubConfigKey('app')]: ['模板 x 不存在或无效'],
        [githubConfigKey('other')]: ['模板 x 不存在或无效'],
      });
    });

    it("prefers the home directory's template with the same id, and warns", () => {
      const paths = home();
      const repoSelfDev = X.replace('id: x', 'id: self-dev');
      const cfg = load(paths, '    app: { template: self-dev }\n', {
        app: source(SHA1, { 'self-dev.yaml': repoSelfDev }),
      });
      expect(cfg.errors).toEqual({});
      const found = findTemplate(cfg, 'app', 'self-dev');
      expect(found?.source).toBe('home');
      expect(found?.template).toBe(cfg.templates.get('self-dev'));
      const key = 'app:.ares1/workflows/self-dev.yaml';
      expect(cfg.warnings).toEqual({
        [key]: [
          '数据目录里也有 id 为 self-dev 的模板（workflows/self-dev.yaml），用的是数据目录那份，仓库里这份没有生效。想改用仓库里的，就删掉数据目录里的那个文件',
        ],
      });
      const [file] = cfg.repoTemplates.get('app')?.files ?? [];
      expect(file).toMatchObject({ key, templateId: 'self-dev', shadowed: true });
      // The file keeps its template's own warnings only; `shadowed` says the rest.
      expect(file?.warnings).toEqual([]);
    });

    it('keeps the version that last loaded when a file breaks, and warns', () => {
      const paths = home();
      const repos = '    app: { template: x }\n';
      const key = 'app:.ares1/workflows/x.yaml';
      const first = load(paths, repos, { app: source(SHA1, { 'x.yaml': X }) });
      const good = first.repoTemplates.get('app')?.templates.get('x');

      // Invalid YAML on the target branch: the template of SHA1 stays in use.
      const broken = load(paths, repos, { app: source(SHA2, { 'x.yaml': BROKEN_YAML }) }, first);
      expect(broken.errors).toEqual({});
      expect(findTemplate(broken, 'app', 'x')?.template).toEqual(good);
      const [file] = broken.repoTemplates.get('app')?.files ?? [];
      expect(file).toMatchObject({
        key,
        source: BROKEN_YAML,
        templateId: 'x',
        errors: [],
        warnings: [],
        lastGood: { sha: SHA1, source: X },
      });
      expect(file?.lastGood?.errors).toEqual([
        expect.stringMatching(/^app:\.ares1\/workflows\/x\.yaml 不是合法的 YAML：/),
      ]);
      expect(broken.warnings[key]).toEqual([
        `这次加载失败，继续使用上次加载成功的版本（提交 1111111）。失败原因：${file?.lastGood?.errors[0]}`,
      ]);

      // Still broken on the next commit, in another way: still the version of SHA1.
      const still = load(paths, repos, { app: source(SHA3, { 'x.yaml': UNKNOWN_AGENT }) }, broken);
      expect(still.errors).toEqual({});
      expect(findTemplate(still, 'app', 'x')?.template).toEqual(good);
      expect(still.repoTemplates.get('app')?.files[0]?.lastGood).toEqual({
        sha: SHA1,
        source: X,
        errors: ['阶段 implement：Agent nobody 不存在或未启用'],
      });
      expect(still.warnings[key]?.[0]).toBe(
        '这次加载失败，继续使用上次加载成功的版本（提交 1111111）。失败原因：阶段 implement：Agent nobody 不存在或未启用',
      );

      // Fixed: the file as written is used again.
      const fixed = X.replace('{ id: merge', '{ id: land');
      const again = load(paths, repos, { app: source(SHA3, { 'x.yaml': fixed }) }, still);
      expect(again.warnings).toEqual({});
      expect(again.repoTemplates.get('app')?.files[0]?.lastGood).toBeUndefined();
      expect(findTemplate(again, 'app', 'x')?.template.stages.map((s) => s.id)).toContain('land');
    });

    it("keeps on the file only its template's own warnings, and tells the rest in order", () => {
      const paths = home();
      const repos = '    app: { template: self-dev }\n';
      const key = 'app:.ares1/workflows/self-dev.yaml';
      // Reviewed by its own coder: a warning of the template itself.
      const own = X.replace('id: x', 'id: self-dev').replace(
        'agent: claude-reviewer',
        'agent: claude-coder',
      );
      const first = load(paths, repos, { app: source(SHA1, { 'self-dev.yaml': own }) });
      const ownWarning = '阶段 review：评审 Agent claude-coder 与编码 Agent 相同，建议换一个';
      const broken = load(
        paths,
        repos,
        { app: source(SHA2, { 'self-dev.yaml': BROKEN_YAML }) },
        first,
      );
      const [file] = broken.repoTemplates.get('app')?.files ?? [];
      expect(file).toMatchObject({ shadowed: true, lastGood: { sha: SHA1 } });
      expect(file?.warnings).toEqual([ownWarning]);
      expect(broken.warnings[key]).toEqual([
        expect.stringMatching(/^这次加载失败，继续使用上次加载成功的版本（提交 1111111）/),
        ownWarning,
        expect.stringMatching(/^数据目录里也有 id 为 self-dev 的模板/),
      ]);
    });

    it('treats a file that never loaded as missing', () => {
      const paths = home();
      const repos = '    app: { template: x }\n';
      const key = 'app:.ares1/workflows/x.yaml';
      const first = load(paths, repos, { app: source(SHA1, { 'x.yaml': UNKNOWN_AGENT }) });
      expect(first.errors).toEqual({
        [key]: ['阶段 implement：Agent nobody 不存在或未启用'],
        [githubConfigKey('app')]: ['模板 x 不存在或无效'],
      });
      expect(first.warnings).toEqual({});
      expect(findTemplate(first, 'app', 'x')).toBeNull();
      expect(first.repoTemplates.get('app')?.files[0]).toMatchObject({ key, templateId: null });

      // Still broken: there is no earlier version to fall back to.
      const second = load(paths, repos, { app: source(SHA2, { 'x.yaml': BROKEN_YAML }) }, first);
      expect(second.errors[key]).toEqual([expect.stringMatching(/不是合法的 YAML/)]);
      expect(findTemplate(second, 'app', 'x')).toBeNull();

      // A version that loaded once but no longer does with the agents of now stands in for
      // nothing either.
      const loaded = load(paths, repos, { app: source(SHA1, { 'x.yaml': X }) });
      writeFile(
        paths.agentsFile,
        readFileSync(paths.agentsFile, 'utf8').replace(/claude-reviewer:/, 'claude-reviewer-2:'),
      );
      const gone = load(paths, repos, { app: source(SHA2, { 'x.yaml': BROKEN_YAML }) }, loaded);
      expect(gone.errors[key]).toEqual([expect.stringMatching(/不是合法的 YAML/)]);
      expect(gone.repoTemplates.get('app')?.files[0]?.lastGood).toBeUndefined();
      expect(findTemplate(gone, 'app', 'x')).toBeNull();
    });

    it("rejects the same id twice in one repo, and checks auto-accepting L with the repo's", () => {
      const paths = home();
      const cfg = load(paths, '    app: { template: x, auto_accept: { max_risk: low } }\n', {
        app: source(SHA1, { 'a.yaml': X, 'b.yaml': X }),
      });
      expect(cfg.errors).toEqual({ 'app:.ares1/workflows/b.yaml': ['模板 id x 与其他模板重复'] });
      expect(cfg.warnings['config.yaml']).toEqual([
        expect.stringMatching(/^仓库 app 会自动采纳大小为 L 的提案/),
      ]);
    });

    it('warns in English when config.yaml says so', () => {
      const paths = home();
      try {
        writeFile(join(paths.workflowsDir, 'x.yaml'), X);
        writeFile(
          paths.configFile,
          'language: en\ngithub:\n  repos:\n    app: { template: x }\n    web: { template: y }\n',
        );
        const cfg = loadConfig(paths, ['claude-code'], ['claude-code'], {
          repoSources: new Map([
            ['app', source(SHA1, { 'x.yaml': X })],
            ['web', source(SHA2, { 'y.yaml': X.replace('id: x', 'id: y') })],
          ]),
        });
        expect(cfg.errors).toEqual({});
        expect(cfg.warnings).toEqual({
          'app:.ares1/workflows/x.yaml': [
            "The home directory also has a template with id x (workflows/x.yaml), which is the one in use: this one in the repo has no effect. To use the repo's, delete that file from the home directory",
          ],
        });
        const broken = loadConfig(paths, ['claude-code'], ['claude-code'], {
          repoSources: new Map([['web', source(SHA3, { 'y.yaml': UNKNOWN_AGENT })]]),
          previous: cfg,
        });
        const warning = broken.warnings['web:.ares1/workflows/y.yaml'];
        expect(warning).toEqual([
          `Failed to load, so the version that last loaded (commit ${SHA2.slice(0, 7)}) stays in use. Why it failed: Stage implement: agent nobody does not exist or is disabled`,
        ]);
        expect(JSON.stringify([cfg.warnings, broken.warnings])).not.toMatch(/[一-鿿]/);
      } finally {
        // Back to the default language, zod's messages included, for the other tests.
        loadConfig(home(), ['claude-code'], ['claude-code']);
      }
    });
  });

  it('resolveTemplate looks in the home directory first, then in the repo', () => {
    const fromHome = new Map([['a', 'home a']]);
    const fromRepo = new Map([
      ['a', 'repo a'],
      ['b', 'repo b'],
    ]);
    expect(resolveTemplate('a', fromHome, fromRepo)).toEqual({
      template: 'home a',
      source: 'home',
    });
    expect(resolveTemplate('b', fromHome, fromRepo)).toEqual({
      template: 'repo b',
      source: 'repo',
    });
    expect(resolveTemplate('b', fromHome, undefined)).toBeNull();
    expect(resolveTemplate('c', fromHome, fromRepo)).toBeNull();
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

  describe('deliver', () => {
    function load(repo: string, extra = '') {
      const paths = home();
      writeFile(paths.configFile, `${extra}github:\n  repos:\n    app: ${repo}\n`);
      return loadConfig(paths, ['claude-code'], ['claude-code']);
    }
    const PR_NEEDS_PUSH =
      'deliver: pr 要求 push: true：开 PR 要先把 Run 的分支推送到 GitHub，PR 合并后还要从 GitHub 拉取目标分支';

    it('delivers by push unless pr is written, and takes no other value', () => {
      expect(GitHubRepoSchema.parse({ template: 'x' }).deliver).toBe('push');
      expect(GitHubRepoSchema.parse({ template: 'x', deliver: 'pr' }).deliver).toBe('pr');
      for (const bad of ['merge', 'PR', true, null]) {
        expect(GitHubRepoSchema.safeParse({ template: 'x', deliver: bad }).success).toBe(false);
      }
      for (const repo of [
        '{ template: self-dev }',
        '{ template: self-dev, deliver: push }',
        '{ template: self-dev, deliver: push, push: true }',
        '{ template: self-dev, deliver: pr, push: true }',
      ]) {
        const cfg = load(repo);
        expect(cfg.errors, repo).toEqual({});
        expect(cfg.warnings, repo).toEqual({});
      }
      expect(load('{ template: self-dev }').master.github?.repos.app?.deliver).toBe('push');
      expect(
        load('{ template: self-dev, deliver: pr, push: true }').master.github?.repos.app,
      ).toMatchObject({ deliver: 'pr', push: true });
    });

    it('disables a repo delivering by pull request without push, and says why', () => {
      for (const repo of [
        '{ template: self-dev, deliver: pr }',
        '{ template: self-dev, deliver: pr, push: false }',
      ]) {
        const cfg = load(repo);
        expect(cfg.errors, repo).toEqual({ [githubConfigKey('app')]: [PR_NEEDS_PUSH] });
        expect(cfg.warnings, repo).toEqual({});
      }
      // Told together with the repo's other problems.
      expect(load('{ template: nope, deliver: pr }').errors).toEqual({
        [githubConfigKey('app')]: ['模板 nope 不存在或无效', PR_NEEDS_PUSH],
      });
    });

    it('says so in English when config.yaml says so', () => {
      try {
        const cfg = load('{ template: self-dev, deliver: pr }', 'language: en\n');
        const problems = cfg.errors[githubConfigKey('app')];
        expect(problems).toEqual([
          "deliver: pr needs push: true: a pull request needs the Run's branch pushed to GitHub, and the target branch pulled from GitHub once it is merged",
        ]);
        for (const problem of problems ?? []) expect(problem).not.toMatch(/[一-鿿]/);
      } finally {
        // Back to the default language, zod's messages included, for the other tests.
        load('{ template: self-dev }');
      }
    });
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
  - id: r
    kind: review
    agent: ok
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
    // Candidates are fine on an agent stage.
    expect(bad.join('\n')).not.toMatch(/阶段 b：/);
    expect(bad.join('\n')).toMatch(/planning: llm（拆分任务）只能用在 agent（编码）阶段/);
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

  it('accepts codex agents for read-only stages, the scout and coding, warning about "safe"', () => {
    const paths = home();
    writeFile(
      paths.agentsFile,
      `agents:
  codex-coder: { cli: codex, model: gpt-5.5, effort: max }
  codex-reviewer: { cli: codex, model: gpt-5.5, effort: high }
  codex-docs: { cli: codex, model: gpt-5.5, permission: safe }
`,
    );
    // The default template names claude agents.
    rmSync(join(paths.workflowsDir, 'self-dev.yaml'));
    writeFile(
      join(paths.workflowsDir, 'codex.yaml'),
      `id: codex
stages:
  - { id: assess, kind: assess, agent: codex-reviewer }
  - { id: implement, kind: agent, agent: codex-coder, planning: auto, inputs: [assessment] }
  - { id: review, kind: review, agent: codex-reviewer, inputs: [diff, assessment], on_fail: implement }
  - { id: merge, kind: merge, gate: true }
`,
    );
    writeFile(
      paths.configFile,
      `github:
  repos:
    app:
      template: codex
      scout: { agent: codex-reviewer }
`,
    );
    const cfg = loadConfig(paths, BUILTIN_CLIS, BUILTIN_READ_ONLY_CLIS);
    expect(BUILTIN_CLIS).toContain('codex');
    expect(BUILTIN_READ_ONLY_CLIS).toContain('codex');
    expect([...cfg.agents.keys()]).toEqual(['codex-coder', 'codex-reviewer', 'codex-docs']);
    expect(cfg.errors).toEqual({});
    expect(cfg.templates.has('codex')).toBe(true);
    // "safe" runs, but Codex cannot keep it from running commands: said where it is shown.
    const docs = cfg.agentEntries.find((e) => e.id === 'codex-docs');
    expect(docs?.state).toBe('enabled');
    expect(docs?.warnings).toHaveLength(1);
    expect(docs?.warnings[0]).toMatch(/Codex 没有「只改文件、不执行命令」的模式/);
    expect(cfg.warnings).toEqual({ 'agents.yaml#codex-docs': docs?.warnings });
    expect(cfg.agentEntries.find((e) => e.id === 'codex-coder')?.warnings).toEqual([]);

    // Loading follows config.yaml's language.
    writeFile(paths.configFile, 'language: en\n');
    const en = loadConfig(paths, BUILTIN_CLIS, BUILTIN_READ_ONLY_CLIS);
    const warning = en.warnings['agents.yaml#codex-docs']?.join('\n') ?? '';
    expect(warning).toMatch(/Codex has no "edits only, no commands" mode/);
    expect(warning).not.toMatch(/[一-鿿]/);
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

  describe('agent_candidates', () => {
    const AGENTS = `agents:
  cheap: { cli: claude-code, model: haiku, tier: low, cost: low }
  strong: { cli: claude-code, model: opus, tier: high, cost: high }
  grok: { cli: cursor-agent, model: grok-4.7-high, tier: mid, cost: low }
  reviewer: { cli: claude-code, model: sonnet }
  off: { cli: claude-code, model: sonnet, enabled: false }
`;
    const load = (files: Record<string, string>) => {
      const paths = home();
      writeFile(paths.agentsFile, AGENTS);
      for (const [file, yaml] of Object.entries(files)) {
        writeFile(join(paths.workflowsDir, file), yaml);
      }
      return loadConfig(paths, ['claude-code', 'cursor-agent'], ['claude-code']);
    };

    it('load on assess, agent and review stages, whichever CLI a review candidate has', () => {
      const cfg = load({
        'ok.yaml': `id: ok
stages:
  - { id: assess, kind: assess, agent_candidates: [cheap, strong] }
  - { id: implement, agent_candidates: [cheap, strong], planning: auto, inputs: [assessment] }
  - { id: review, kind: review, agent_candidates: [grok, reviewer], inputs: [diff, assessment] }
  - { id: merge, kind: merge }
`,
      });
      expect(cfg.errors['workflows/ok.yaml']).toBeUndefined();
      expect(cfg.warnings['workflows/ok.yaml']).toBeUndefined();
      const tpl = cfg.templates.get('ok') as WorkflowTemplate;
      expect(tpl.stages.map(stageAgentIds)).toEqual([
        ['cheap', 'strong'],
        ['cheap', 'strong'],
        ['grok', 'reviewer'],
        [],
      ]);
    });

    it('cannot go with agent, be empty or repeat a candidate, and some stage needs one or the other', () => {
      const cfg = load({
        'both.yaml': `id: both
stages:
  - { id: implement, agent: cheap, agent_candidates: [cheap, strong] }
`,
        'empty.yaml': `id: empty
stages:
  - { id: implement, agent_candidates: [] }
`,
        'repeated.yaml': `id: repeated
stages:
  - { id: implement, agent_candidates: [cheap, strong, cheap, strong, cheap] }
`,
        'none.yaml': `id: none
stages:
  - { id: implement, agent: cheap }
  - { id: review, kind: review }
`,
      });
      const errors = (file: string) => cfg.errors[`workflows/${file}`];
      expect(errors('both.yaml')).toEqual([
        '阶段 implement：agent 和 agent_candidates 只能写一个：agent 总用同一个 Agent，agent_candidates 按需求的难度从候选里挑',
      ]);
      expect(errors('empty.yaml')).toEqual([
        '阶段 implement：agent_candidates 是空列表，没有可选的 Agent',
      ]);
      expect(errors('repeated.yaml')).toEqual([
        '阶段 implement：agent_candidates 里 cheap、strong 写了不止一次',
      ]);
      expect(errors('none.yaml')).toEqual([
        '阶段 review：需要指定 agent，或者用 agent_candidates 列出按难度挑选的候选 Agent',
      ]);
      for (const id of ['both', 'empty', 'repeated', 'none']) {
        expect(cfg.templates.has(id)).toBe(false);
      }
    });

    it('cannot be on stages the Master runs by itself', () => {
      const tpl = (id: string, stage: string) => `id: ${id}
stages:
  - { id: implement, agent: cheap }
  - ${stage}
  - { id: merge, kind: merge }
`;
      const cfg = load({
        'command.yaml': tpl('c1', '{ id: e2e, kind: command, agent_candidates: [cheap] }'),
        'placeholder.yaml': tpl('c2', '{ id: e2e, kind: placeholder, agent_candidates: [cheap] }'),
        'both.yaml': tpl(
          'c3',
          '{ id: e2e, kind: placeholder, agent: cheap, agent_candidates: [] }',
        ),
        'merge.yaml': `id: c4
stages:
  - { id: implement, agent: cheap }
  - { id: merge, kind: merge, agent_candidates: [cheap, strong] }
`,
      });
      const errors = (file: string) => cfg.errors[`workflows/${file}`];
      expect(errors('command.yaml')).toEqual([
        '阶段 e2e：command（命令）阶段只运行命令、不调用 Agent，不能指定 agent_candidates',
      ]);
      expect(errors('placeholder.yaml')).toEqual([
        '阶段 e2e：placeholder（占位）阶段不执行任何操作，不能指定 agent_candidates',
      ]);
      expect(errors('both.yaml')).toEqual([
        '阶段 e2e：placeholder（占位）阶段不执行任何操作，不能指定 agent、agent_candidates',
      ]);
      expect(errors('merge.yaml')).toEqual([
        '阶段 merge：merge 阶段由 Master 执行，不能指定 agent_candidates',
      ]);
      for (const id of ['c1', 'c2', 'c3', 'c4']) expect(cfg.templates.has(id)).toBe(false);
    });

    it('needs every candidate enabled, and read-only where the stage runs read-only', () => {
      const cfg = load({
        'missing.yaml': `id: missing
stages:
  - { id: implement, agent_candidates: [cheap, off, nobody] }
`,
        'assess.yaml': `id: assess
stages:
  - { id: assess, kind: assess, agent_candidates: [cheap, grok] }
  - { id: implement, agent: cheap, inputs: [assessment] }
`,
        'plan.yaml': `id: plan
stages:
  - { id: implement, agent_candidates: [grok, strong], planning: llm }
`,
        // A single task runs with edits, so any CLI does.
        'single.yaml': `id: single
stages:
  - { id: implement, agent_candidates: [grok, strong] }
`,
      });
      const errors = (file: string) => cfg.errors[`workflows/${file}`];
      expect(errors('missing.yaml')).toEqual([
        '阶段 implement：Agent off 不存在或未启用',
        '阶段 implement：Agent nobody 不存在或未启用',
      ]);
      expect(errors('assess.yaml')).toEqual([
        '阶段 assess：assess（需求评估）阶段要以只读方式运行，Agent grok 的 CLI cursor-agent 不支持，请换用 claude-code 的 Agent',
      ]);
      expect(errors('plan.yaml')).toEqual([
        '阶段 implement：planning: llm 先以只读方式运行阶段的 Agent 来拆分任务，Agent grok 的 CLI cursor-agent 不支持，请换用 claude-code 的 Agent',
      ]);
      expect(errors('single.yaml')).toBeUndefined();
      expect([...cfg.templates.keys()].sort()).toEqual(['single']);
    });

    it('warn when a review candidate is also a coding candidate', () => {
      const tpl = (id: string, implement: string, review: string) => `id: ${id}
stages:
  - { id: implement, ${implement} }
  - { id: docs, kind: placeholder }
  - { id: review, kind: review, ${review} }
  - { id: merge, kind: merge }
`;
      const files = {
        'many.yaml': tpl(
          'many',
          'agent_candidates: [cheap, grok]',
          'agent_candidates: [grok, strong, cheap]',
        ),
        'one.yaml': tpl('one', 'agent_candidates: [cheap, strong]', 'agent: strong'),
        'apart.yaml': tpl('apart', 'agent_candidates: [cheap, grok]', 'agent_candidates: [strong]'),
      };
      const cfg = load(files);
      for (const file of Object.keys(files))
        expect(cfg.errors[`workflows/${file}`]).toBeUndefined();
      expect(cfg.warnings['workflows/many.yaml']).toEqual([
        '阶段 review：评审 Agent grok、cheap 与编码 Agent 相同，建议换一个',
      ]);
      expect(cfg.warnings['workflows/one.yaml']).toEqual([
        '阶段 review：评审 Agent strong 与编码 Agent 相同，建议换一个',
      ]);
      expect(cfg.warnings['workflows/apart.yaml']).toBeUndefined();

      setLang('en');
      const en = load({
        ...files,
        'both.yaml': `id: both
stages:
  - { id: implement, agent: cheap, agent_candidates: [cheap] }
`,
        'repeated.yaml': `id: repeated
stages:
  - { id: implement, agent_candidates: [cheap, cheap] }
`,
      });
      expect(en.warnings['workflows/many.yaml']).toEqual([
        'Stage review: reviewers grok, cheap are also coding agents; better use others',
      ]);
      expect(en.warnings['workflows/one.yaml']).toEqual([
        'Stage review: reviewer strong is also a coding agent; better use another one',
      ]);
      expect(en.errors['workflows/both.yaml']).toEqual([
        "Stage implement: agent and agent_candidates cannot both be set: agent always uses the same agent, agent_candidates picks one of the candidates by the requirement's difficulty",
      ]);
      expect(en.errors['workflows/repeated.yaml']).toEqual([
        'Stage implement: agent_candidates lists cheap more than once',
      ]);
      const texts = [...Object.values(en.errors), ...Object.values(en.warnings)].flat();
      expect(texts.join('\n')).not.toMatch(/[一-鿿]/);
    });
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

  it('accepts planning: llm on agent stages whose agent can run read-only, and nowhere else', () => {
    const paths = home();
    writeFile(
      paths.agentsFile,
      `agents:
  claude: { cli: claude-code, model: opus }
  grok: { cli: cursor-agent, model: grok-4.7-high }
`,
    );
    const files: Record<string, string> = {
      'self-dev.yaml': `id: ok
stages:
  - { id: implement, name: 编码, agent: claude, planning: llm }
  - { id: review, kind: review, agent: grok }
  - { id: merge, kind: merge }
`,
      'cursor.yaml': `id: a2
stages:
  - { id: implement, agent: grok, planning: llm }
`,
      'review.yaml': `id: a3
stages:
  - { id: implement, agent: claude }
  - { id: review, kind: review, agent: grok, planning: llm }
`,
      'assess.yaml': `id: a4
stages:
  - { id: assess, kind: assess, agent: claude, planning: llm }
  - { id: implement, agent: claude, inputs: [assessment] }
`,
      'placeholder.yaml': `id: a5
stages:
  - { id: implement, agent: claude }
  - { id: e2e, kind: placeholder, planning: llm }
`,
      'merge.yaml': `id: a6
stages:
  - { id: implement, agent: claude }
  - { id: merge, kind: merge, planning: llm }
`,
    };
    for (const [file, yaml] of Object.entries(files)) {
      writeFile(join(paths.workflowsDir, file), yaml);
    }
    const load = () => loadConfig(paths, ['claude-code', 'cursor-agent'], ['claude-code']);
    const cfg = load();
    const errors = (file: string) => cfg.errors[`workflows/${file}`];
    // No longer "not implemented yet".
    expect(errors('self-dev.yaml')).toBeUndefined();
    expect(cfg.warnings['workflows/self-dev.yaml']).toBeUndefined();
    expect(cfg.templates.get('ok')?.stages[0]?.planning).toBe('llm');
    // The plan runs the stage's agent read-only, which only some CLIs can.
    expect(errors('cursor.yaml')).toEqual([
      '阶段 implement：planning: llm 先以只读方式运行阶段的 Agent 来拆分任务，Agent grok 的 CLI cursor-agent 不支持，请换用 claude-code 的 Agent',
    ]);
    // Only work that is checked and committed is split.
    expect(errors('review.yaml')).toEqual([
      '阶段 review：planning: llm（拆分任务）只能用在 agent（编码）阶段，review 阶段不能用',
    ]);
    expect(errors('assess.yaml')).toEqual([
      '阶段 assess：planning: llm（拆分任务）只能用在 agent（编码）阶段，assess 阶段不能用',
    ]);
    expect(errors('placeholder.yaml')).toEqual([
      '阶段 e2e：planning: llm（拆分任务）只能用在 agent（编码）阶段，placeholder 阶段不能用',
    ]);
    expect(errors('merge.yaml')).toEqual([
      '阶段 merge：planning: llm（拆分任务）只能用在 agent（编码）阶段，merge 阶段不能用',
    ]);
    expect([...cfg.templates.keys()]).toEqual(['ok']);

    // config.yaml sets the language in use while loading.
    writeFile(paths.configFile, 'language: en\n');
    const en = load();
    expect(en.errors['workflows/cursor.yaml']).toEqual([
      "Stage implement: planning: llm first runs the stage's agent read-only to split the stage into tasks, which the CLI cursor-agent of agent grok does not support; use an agent of claude-code",
    ]);
    expect(en.errors['workflows/review.yaml']).toEqual([
      'Stage review: planning: llm (splitting the stage into tasks) only applies to agent stages, not to a review stage',
    ]);
  });

  it('checks planning: auto as planning: llm, naming the value it has', () => {
    const paths = home();
    writeFile(
      paths.agentsFile,
      `agents:
  claude: { cli: claude-code, model: opus }
  grok: { cli: cursor-agent, model: grok-4.7-high }
`,
    );
    const files: Record<string, string> = {
      'self-dev.yaml': `id: ok
stages:
  - { id: assess, kind: assess, agent: claude }
  - { id: implement, agent: claude, planning: auto, inputs: [assessment] }
`,
      'no-assess.yaml': `id: ok2
stages:
  - { id: implement, agent: claude, planning: auto }
`,
      'cursor.yaml': `id: a2
stages:
  - { id: implement, agent: grok, planning: auto }
`,
      'review.yaml': `id: a3
stages:
  - { id: implement, agent: claude }
  - { id: review, kind: review, agent: grok, planning: auto }
`,
      'command.yaml': `id: a4
stages:
  - { id: implement, agent: claude }
  - { id: e2e, kind: command, planning: auto, verify: { commands: ['npm test'] } }
`,
    };
    for (const [file, yaml] of Object.entries(files)) {
      writeFile(join(paths.workflowsDir, file), yaml);
    }
    const load = () => loadConfig(paths, ['claude-code', 'cursor-agent'], ['claude-code']);
    const cfg = load();
    const errors = (file: string) => cfg.errors[`workflows/${file}`];
    expect(errors('self-dev.yaml')).toBeUndefined();
    expect(cfg.warnings['workflows/self-dev.yaml']).toBeUndefined();
    expect(cfg.templates.get('ok')?.stages[1]?.planning).toBe('auto');
    // Without an assessment it never splits, which is no error.
    expect(errors('no-assess.yaml')).toBeUndefined();
    expect(cfg.warnings['workflows/no-assess.yaml']).toBeUndefined();
    expect(errors('cursor.yaml')).toEqual([
      '阶段 implement：planning: auto 先以只读方式运行阶段的 Agent 来拆分任务，Agent grok 的 CLI cursor-agent 不支持，请换用 claude-code 的 Agent',
    ]);
    expect(errors('review.yaml')).toEqual([
      '阶段 review：planning: auto（拆分任务）只能用在 agent（编码）阶段，review 阶段不能用',
    ]);
    expect(errors('command.yaml')).toEqual([
      '阶段 e2e：command（命令）阶段只运行命令、不调用 Agent，不能指定 planning: auto',
    ]);
    expect([...cfg.templates.keys()].sort()).toEqual(['ok', 'ok2']);

    writeFile(paths.configFile, 'language: en\n');
    const en = load();
    expect(en.errors['workflows/cursor.yaml']).toEqual([
      "Stage implement: planning: auto first runs the stage's agent read-only to split the stage into tasks, which the CLI cursor-agent of agent grok does not support; use an agent of claude-code",
    ]);
    expect(en.errors['workflows/review.yaml']).toEqual([
      'Stage review: planning: auto (splitting the stage into tasks) only applies to agent stages, not to a review stage',
    ]);
    expect(en.errors['workflows/command.yaml']).toEqual([
      'Stage e2e: a command stage only runs commands and calls no agent, it cannot have planning: auto',
    ]);
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

describe('plansStage', () => {
  const SIZES = [undefined, 'S', 'M', 'L'] as const;

  it('splits planning: llm always, auto only for an L, single never', () => {
    for (const size of SIZES) {
      expect(plansStage({ kind: 'agent', planning: 'llm' }, size)).toBe(true);
      expect(plansStage({ kind: 'agent', planning: 'auto' }, size)).toBe(size === 'L');
      expect(plansStage({ kind: 'agent', planning: 'single' }, size)).toBe(false);
    }
  });

  it('never splits stages other than agent stages', () => {
    const kinds = ['review', 'assess', 'merge', 'command', 'placeholder'] as const;
    for (const kind of kinds) {
      for (const planning of ['single', 'llm', 'auto'] as const) {
        expect(plansStage({ kind, planning }, 'L')).toBe(false);
      }
    }
  });

  it('a template splits an L when some agent stage plans, auto or llm', () => {
    const tpl = (...plannings: ('single' | 'llm' | 'auto')[]) =>
      TemplateSchema.parse({
        id: 't',
        stages: [
          ...plannings.map((planning, i) => ({ id: `code${i}`, agent: 'x', planning })),
          { id: 'review', kind: 'review', agent: 'y' },
          { id: 'merge', kind: 'merge' },
        ],
      });
    expect(templateSplits(tpl('single'))).toBe(false);
    expect(templateSplits(tpl('auto'))).toBe(true);
    expect(templateSplits(tpl('llm'))).toBe(true);
    expect(templateSplits(tpl('single', 'auto'))).toBe(true);
    expect(templateSplits(tpl('single', 'single'))).toBe(false);
    const parsed = (stages: object[]) => templateSplits(TemplateSchema.parse({ id: 't', stages }));
    // Planning unset is single.
    expect(parsed([{ id: 'a', agent: 'x' }])).toBe(false);
    // Only agent stages split, whatever another kind of stage says.
    expect(parsed([{ id: 'r', kind: 'review', agent: 'y', planning: 'auto' }])).toBe(false);
  });

  it('takes a stage as the template parses it: single unless it says', () => {
    const t = TemplateSchema.parse({
      id: 't',
      stages: [
        { id: 'a', agent: 'x' },
        { id: 'b', agent: 'x', planning: 'auto' },
      ],
    });
    expect(plansStage(effectiveStage(t, 'a', {}).def, 'L')).toBe(false);
    expect(plansStage(effectiveStage(t, 'b', {}).def, 'L')).toBe(true);
    expect(plansStage(effectiveStage(t, 'b', {}).def, 'M')).toBe(false);
  });
});

describe('stageAgentIds', () => {
  it("lists a stage's candidates, else its agent, else nothing", () => {
    expect(stageAgentIds({ agent_candidates: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(stageAgentIds({ agent: 'a' })).toEqual(['a']);
    expect(stageAgentIds({})).toEqual([]);
    expect(stageAgentIds({ agent: '' })).toEqual([]);
  });

  it('ranks levels low < mid < high', () => {
    expect(DIFFICULTIES.map(levelRank)).toEqual([0, 1, 2]);
  });
});

describe('chooseStageAgent', () => {
  const agents = (...list: [id: string, tier: Difficulty, cost: Difficulty][]) =>
    new Map(list.map(([id, tier, cost]) => [id, { id, tier, cost }]));
  const all = () => true;
  const AGENTS = agents(
    ['strong', 'high', 'high'],
    ['middle', 'mid', 'mid'],
    ['cheap', 'low', 'low'],
  );
  const LIST = ['strong', 'middle', 'cheap'];

  it('takes the cheapest candidate whose tier is at least the difficulty', () => {
    expect(chooseStageAgent(LIST, AGENTS, 'low', all)).toEqual({ id: 'cheap', reason: 'fit' });
    expect(chooseStageAgent(LIST, AGENTS, 'mid', all)).toEqual({ id: 'middle', reason: 'fit' });
    expect(chooseStageAgent(LIST, AGENTS, 'high', all)).toEqual({ id: 'strong', reason: 'fit' });
    // A tier above the difficulty is fine when it costs less.
    const bargain = agents(['pricey', 'mid', 'high'], ['bargain', 'high', 'low']);
    expect(chooseStageAgent(['pricey', 'bargain'], bargain, 'mid', all)).toEqual({
      id: 'bargain',
      reason: 'fit',
    });
  });

  it('takes the first usable candidate without a difficulty', () => {
    expect(chooseStageAgent(LIST, AGENTS, undefined, all)).toEqual({
      id: 'strong',
      reason: 'first',
    });
    expect(chooseStageAgent(['gone', ...LIST], AGENTS, undefined, (id) => id !== 'strong')).toEqual(
      { id: 'middle', reason: 'first' },
    );
  });

  it('takes the highest tier when none is high enough, then the cheapest, then the order', () => {
    const weak = agents(['a', 'low', 'low'], ['b', 'mid', 'high'], ['c', 'mid', 'mid']);
    expect(chooseStageAgent(['a', 'b', 'c'], weak, 'high', all)).toEqual({
      id: 'c',
      reason: 'highest',
    });
    const same = agents(['a', 'low', 'low'], ['b', 'mid', 'mid'], ['c', 'mid', 'mid']);
    expect(chooseStageAgent(['a', 'b', 'c'], same, 'high', all)).toEqual({
      id: 'b',
      reason: 'highest',
    });
    expect(chooseStageAgent(['a', 'c', 'b'], same, 'high', all)).toEqual({
      id: 'c',
      reason: 'highest',
    });
    // Only the usable ones count.
    expect(chooseStageAgent(LIST, AGENTS, 'high', (id) => id !== 'strong')).toEqual({
      id: 'middle',
      reason: 'highest',
    });
  });

  it('goes by the list order between equal costs', () => {
    const twins = agents(['x', 'high', 'mid'], ['y', 'high', 'mid'], ['z', 'low', 'low']);
    for (const difficulty of ['mid', 'high'] as const) {
      expect(chooseStageAgent(['x', 'y', 'z'], twins, difficulty, all)?.id).toBe('x');
      expect(chooseStageAgent(['y', 'x', 'z'], twins, difficulty, all)?.id).toBe('y');
    }
  });

  it('skips candidates that are disabled or cannot run the stage', () => {
    // `off` is not among the enabled agents.
    expect(chooseStageAgent(['off', ...LIST], AGENTS, 'low', all)).toEqual({
      id: 'cheap',
      reason: 'fit',
    });
    expect(chooseStageAgent(LIST, AGENTS, 'low', (id) => id !== 'cheap')).toEqual({
      id: 'middle',
      reason: 'fit',
    });
    expect(chooseStageAgent(LIST, AGENTS, 'low', (id) => id === 'strong')).toEqual({
      id: 'strong',
      reason: 'fit',
    });
  });

  it('chooses nobody when no candidate is usable', () => {
    for (const difficulty of [undefined, ...DIFFICULTIES]) {
      expect(chooseStageAgent(LIST, AGENTS, difficulty, () => false)).toBeUndefined();
      expect(chooseStageAgent(['off', 'gone'], AGENTS, difficulty, all)).toBeUndefined();
      expect(chooseStageAgent([], AGENTS, difficulty, all)).toBeUndefined();
    }
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

  it('limitedScout: the newest rate-limited scout the wait counts from', () => {
    const newest = { ...scout(30, 'rate_limited'), id: 'newest' };
    const scouts = [scout(50, 'running'), scout(40, 'interrupted'), newest, scout(10, 'failed')];
    expect(limitedScout(scouts)).toBe(newest);
    expect(limitedScout([scout(20, 'failed'), scout(10, 'rate_limited')])).toBeUndefined();
    expect(limitedScout([scout(10, 'interrupted')])).toBeUndefined();
    expect(limitedScout([])).toBeUndefined();
  });
});

describe('recordedLimitWait', () => {
  const now = Date.parse('2026-11-20T10:00:00.000Z');
  const retryAt = '2026-11-20T12:01:00.000Z';
  const queued = { status: 'queued' as const };
  const limited = (data: Record<string, unknown> = {}) => ({
    type: 'task.rate_limited',
    data: { taskId: 'task_1', agentId: 'coder', retryAt, delayMs: 1, resetAt: null, ...data },
  });
  const status = (s: string) => ({ type: 'run.status', data: { status: s } });
  const other = (type: string) => ({ type, data: {} });
  /** As waitForQuota leaves them: the limit, then the Run queued in the same transaction. */
  const waiting = [status('running'), other('attempt.started'), limited(), status('queued')];
  const attempts = [
    { taskId: 'task_0', outcome: 'passed' as const },
    { taskId: 'task_1', outcome: 'rate_limited' as const },
  ];

  it('gives back the agent and the time the Run goes on', () => {
    expect(recordedLimitWait(queued, waiting, attempts, now)).toEqual({
      agentId: 'coder',
      until: Date.parse(retryAt),
    });
    // Events that do not touch the Run's status leave the wait as it was.
    const later = [...waiting, other('issue.commented')];
    expect(recordedLimitWait(queued, later, attempts, now)?.until).toBe(Date.parse(retryAt));
  });

  it('only the latest limit counts', () => {
    const again = [
      ...waiting,
      status('running'),
      limited({ agentId: 'coder2', retryAt: '2026-11-20T11:00:00.000Z' }),
      status('queued'),
    ];
    expect(recordedLimitWait(queued, again, attempts, now)).toEqual({
      agentId: 'coder2',
      until: Date.parse('2026-11-20T11:00:00.000Z'),
    });
  });

  it('no wait once anything changed the Run status after the limit', () => {
    // Paused and resumed, recovered after a restart while running, started again.
    for (const after of [
      [status('paused'), status('queued'), other('run.resumed')],
      [status('running'), status('queued'), other('run.recovered')],
      [status('running')],
    ]) {
      expect(recordedLimitWait(queued, [...waiting, ...after], attempts, now)).toBeNull();
    }
    expect(recordedLimitWait({ status: 'paused' }, waiting, attempts, now)).toBeNull();
    expect(recordedLimitWait({ status: 'running' }, waiting, attempts, now)).toBeNull();
  });

  it('no wait without a limit, past its time, or once the task got further', () => {
    expect(recordedLimitWait(queued, [status('queued')], attempts, now)).toBeNull();
    expect(recordedLimitWait(queued, waiting, attempts, Date.parse(retryAt))).toBeNull();
    const passed = [...attempts, { taskId: 'task_1', outcome: 'passed' as const }];
    expect(recordedLimitWait(queued, waiting, passed, now)).toBeNull();
    expect(recordedLimitWait(queued, waiting, [], now)).toBeNull();
    // Not as waitForQuota writes it: without the queued status after the limit.
    expect(recordedLimitWait(queued, [limited()], attempts, now)).toBeNull();
    for (const data of [{ retryAt: 'not a time' }, { retryAt: null }, { agentId: 1 }]) {
      expect(
        recordedLimitWait(queued, [limited(data), status('queued')], attempts, now),
      ).toBeNull();
    }
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
