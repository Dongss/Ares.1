import {
  chmodSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { RepoSourceInput } from '../src/api/types.js';
import { defaultConfigYaml } from '../src/config/defaults.js';
import {
  editRepoSource,
  RepoSourceInputSchema,
  SourceEditConflict,
  SourceEditInvalid,
  saveRepoSource,
  watcherDeps,
} from '../src/config/edit.js';
import { ConfigError, type HomePaths, homePaths, loadConfig } from '../src/config/load.js';
import { MasterConfigSchema } from '../src/config/schema.js';
import { ConfigWatcher } from '../src/config/watch.js';
import { setLang } from '../src/i18n.js';
import { TEST_WORKFLOW_YAML, tmpDir, writeFile } from './helpers.js';

afterEach(() => setLang('zh'));

/** The edit, checked to give a config.yaml the schema takes. */
function edit(text: string, repo: string, input: RepoSourceInput): string {
  const out = editRepoSource(text, repo, input);
  const parsed = MasterConfigSchema.safeParse(parseYaml(out) ?? {});
  expect(parsed.success, parsed.error?.message).toBe(true);
  return out;
}

/** The file as plain data: what each source's `repos` holds. */
function raw(text: string): Record<string, { repos?: Record<string, unknown> } & object> {
  return parseYaml(text) ?? {};
}

const CONFIG = `# Ares.1 config, by hand

language: zh
port: 4870

defaults:
  timeout_minutes: 60          # one agent execution
  command_timeout_minutes: 20  # one command

# Issues on GitHub
github:
  account: me                  # gh account
  poll_minutes: 3
  repos:
    # the main repo
    app:
      issues_repo: me/app      # where the issues are
      template: self-dev       # template of the Runs
      scout:
        agent: claude          # read-only
        auto: true
      auto_accept:
        max_risk: low
        # max_size: M
      push: true               # push after merge
    # the docs site
    site:
      template: plain          # plain template
      auto_merge: true         # no merge approval

# backlog:
#   repos:
#     my-local-repo:
#       template: self-dev

notify:
  system: true                 # macOS notifications
`;

describe('editRepoSource', () => {
  it('adds a section that is missing, leaving the rest of the file as written', () => {
    const out = edit(CONFIG, 'tool', {
      platform: 'backlog',
      template: 'self-dev',
      scout: { agent: 'claude' },
    });
    expect(out.startsWith(CONFIG)).toBe(true);
    expect(out.slice(CONFIG.length)).toBe(
      '\nbacklog:\n  repos:\n    tool:\n      template: self-dev\n      scout:\n        agent: claude\n',
    );
    // The new section has repos only: the schema gives poll_minutes its default.
    expect(raw(out).backlog).toEqual({
      repos: { tool: { template: 'self-dev', scout: { agent: 'claude' } } },
    });
  });

  it('adds the section to the default config.yaml, keeping every comment of it', () => {
    const text = defaultConfigYaml();
    const out = edit(text, 'mine', { platform: 'backlog', template: 'self-dev' });
    expect(out.startsWith(text)).toBe(true);
    expect(raw(out).backlog).toEqual({ repos: { mine: { template: 'self-dev' } } });
  });

  it('builds the file from nothing, or from comments only', () => {
    expect(edit('', 'mine', { platform: 'backlog', template: 'self-dev' })).toBe(
      'backlog:\n  repos:\n    mine:\n      template: self-dev\n',
    );
    const comments = '# Ares.1 config\n# nothing set yet\n';
    expect(edit(comments, 'mine', { platform: 'backlog', template: 'self-dev' })).toBe(
      `${comments}\nbacklog:\n  repos:\n    mine:\n      template: self-dev\n`,
    );
  });

  it('fills a section or repos written without anything under them', () => {
    const out = edit('backlog:\nport: 4870\n', 'mine', { platform: 'backlog', template: 'a' });
    expect(raw(out)).toEqual({ backlog: { repos: { mine: { template: 'a' } } }, port: 4870 });
    const repos = 'backlog:\n  poll_minutes: 5\n  repos:\n    # mine:\n    #   template: a\n';
    const filled = edit(repos, 'mine', { platform: 'backlog', template: 'b' });
    expect(raw(filled)).toEqual({
      backlog: { poll_minutes: 5, repos: { mine: { template: 'b' } } },
    });
    expect(filled).toContain('    # mine:\n    #   template: a\n');
  });

  it('adds an entry to a section that has others', () => {
    const out = edit(CONFIG, 'tool', { platform: 'github', template: 'plain' });
    expect(Object.keys(raw(out).github?.repos ?? {})).toEqual(['app', 'site', 'tool']);
    expect(raw(out).github?.repos?.tool).toEqual({ template: 'plain' });
    expect(raw(out).github?.repos?.app).toEqual(raw(CONFIG).github?.repos?.app);
  });

  it('moves a repo from GitHub to the local backlog', () => {
    const out = edit(CONFIG, 'app', {
      platform: 'backlog',
      template: 'self-dev',
      auto_accept: { max_risk: 'mid' },
    });
    const github = raw(out).github as Record<string, unknown>;
    expect(github.account).toBe('me');
    expect(github.poll_minutes).toBe(3);
    expect(Object.keys(github.repos as object)).toEqual(['site']);
    expect(raw(out).backlog?.repos).toEqual({
      app: { template: 'self-dev', auto_accept: { max_risk: 'mid' } },
    });
    expect(out).not.toContain('where the issues are');
  });

  it('moves a repo from GitHub to GitLab', () => {
    const out = edit(CONFIG, 'site', {
      platform: 'gitlab',
      issues_repo: 'group/sub/site',
      template: 'plain',
      push: true,
      deliver: 'mr',
    });
    expect(Object.keys(raw(out).github?.repos ?? {})).toEqual(['app']);
    expect(raw(out).gitlab).toEqual({
      repos: {
        site: { issues_repo: 'group/sub/site', template: 'plain', push: true, deliver: 'mr' },
      },
    });
    expect(raw(out).backlog).toBeUndefined();
  });

  it('removes the repo from all three sources for none, keeping the emptied repos', () => {
    const text = [
      'github:',
      '  repos:',
      '    app: { template: a }',
      'gitlab:',
      '  host: gitlab.example.com',
      '  repos:',
      '    app: { issues_repo: g/app, template: a }',
      'backlog:',
      '  poll_minutes: 2',
      '  repos:',
      '    app: { template: a }',
      '    other: { template: b }',
      '',
    ].join('\n');
    const out = edit(text, 'app', { platform: 'none' });
    expect(raw(out)).toEqual({
      github: { repos: {} },
      gitlab: { host: 'gitlab.example.com', repos: {} },
      backlog: { poll_minutes: 2, repos: { other: { template: 'b' } } },
    });
    // Nowhere to remove it from: the file stays as it is.
    expect(editRepoSource(CONFIG, 'tool', { platform: 'none' })).toBe(CONFIG);
  });

  it('keeps the comments: at the top, in the sections and on the other entries', () => {
    const out = edit(CONFIG, 'app', { platform: 'backlog', template: 'self-dev' });
    for (const comment of [
      '# Ares.1 config, by hand',
      '# Issues on GitHub',
      '# gh account',
      '# the docs site',
      '# plain template',
      '# no merge approval',
      '# macOS notifications',
    ]) {
      expect(out).toContain(comment);
    }
    // Sections not touched are byte for byte as written, aligned comments included.
    expect(out).toContain(
      'defaults:\n  timeout_minutes: 60          # one agent execution\n' +
        '  command_timeout_minutes: 20  # one command\n',
    );
    expect(out).toContain('notify:\n  system: true                 # macOS notifications\n');
    // The commented-out section after github stays where it was, not indented into github.
    expect(out).toContain(
      '\n\n# backlog:\n#   repos:\n#     my-local-repo:\n#       template: self-dev\n\nnotify:',
    );
  });

  it('edits an entry where it is, keeping the comments of the lines that stay', () => {
    const out = edit(CONFIG, 'app', {
      platform: 'github',
      issues_repo: 'me/app2',
      template: 'self-dev',
      scout: { agent: 'codex', max_proposals: 3 },
      auto_accept: { max_risk: 'mid', max_per_day: 2 },
      push: true,
      deliver: 'pr',
    });
    expect(raw(out).github?.repos?.app).toEqual({
      issues_repo: 'me/app2',
      template: 'self-dev',
      scout: { agent: 'codex', max_proposals: 3 },
      auto_accept: { max_risk: 'mid', max_per_day: 2 },
      push: true,
      deliver: 'pr',
    });
    expect(out).toContain('issues_repo: me/app2 # where the issues are');
    expect(out).toContain('template: self-dev # template of the Runs');
    expect(out).toContain('agent: codex # read-only');
    expect(out).toContain('push: true # push after merge');
    expect(out).toContain('# the main repo');
    expect(out).toContain('# max_size: M');
    expect(out).not.toContain('auto: true');
    // The entry after it is untouched.
    expect(raw(out).github?.repos?.site).toEqual({ template: 'plain', auto_merge: true });
  });

  it('removes the scout for scout: null', () => {
    const out = edit(CONFIG, 'app', {
      platform: 'github',
      issues_repo: 'me/app',
      template: 'self-dev',
      scout: null,
      push: true,
    });
    expect(raw(out).github?.repos?.app).toEqual({
      issues_repo: 'me/app',
      template: 'self-dev',
      push: true,
    });
    expect(out).not.toContain('scout');
  });

  it('writes only the fields given, never the defaults', () => {
    const body = RepoSourceInputSchema.parse({
      platform: 'github',
      template: 'self-dev',
      scout: { agent: 'claude' },
      auto_accept: { max_size: 'M' },
    });
    expect(body).toEqual({
      platform: 'github',
      template: 'self-dev',
      scout: { agent: 'claude' },
      auto_accept: { max_size: 'M' },
    });
    const out = edit('', 'tool', body);
    expect(raw(out)).toEqual({
      github: {
        repos: {
          tool: {
            template: 'self-dev',
            scout: { agent: 'claude' },
            auto_accept: { max_size: 'M' },
          },
        },
      },
    });
    // Fields in config.yaml's order, whatever the order of the request.
    const ordered = edit('', 'tool', {
      platform: 'gitlab',
      deliver: 'mr',
      push: true,
      template: 't',
      issues_repo: 'g/tool',
      max_run_attempts: 1,
    });
    expect(Object.keys(raw(ordered).gitlab?.repos?.tool as object)).toEqual([
      'issues_repo',
      'template',
      'max_run_attempts',
      'push',
      'deliver',
    ]);
  });

  it('finds a repo by its name, dots and digits included', () => {
    const text = 'backlog:\n  repos:\n    a.b:\n      template: x\n    "123":\n      template: y\n';
    const moved = edit(text, 'a.b', { platform: 'github', template: 'z' });
    expect(raw(moved)).toEqual({
      backlog: { repos: { '123': { template: 'y' } } },
      github: { repos: { 'a.b': { template: 'z' } } },
    });
    const numeric = edit(text, '123', { platform: 'backlog', template: 'w' });
    expect(raw(numeric).backlog?.repos?.['123']).toEqual({ template: 'w' });
  });

  it('rewrites a document whose top level is in flow style', () => {
    const out = edit('{ port: 4870, github: { repos: { app: { template: a } } } }', 'app', {
      platform: 'backlog',
      template: 'a',
    });
    expect(raw(out)).toEqual({
      port: 4870,
      github: { repos: {} },
      backlog: { repos: { app: { template: 'a' } } },
    });
  });

  it('refuses a file that is not valid YAML, or a source that is not a mapping', () => {
    const input: RepoSourceInput = { platform: 'backlog', template: 'a' };
    expect(() => editRepoSource('github: [\n', 'app', input)).toThrow(ConfigError);
    expect(() => editRepoSource('backlog: 3\n', 'app', input)).toThrow(/backlog/);
    expect(() => editRepoSource('backlog:\n  repos: [a]\n', 'app', input)).toThrow(
      /backlog\.repos/,
    );
    setLang('en');
    expect(() => editRepoSource('a: b: c\n', 'app', input)).toThrow(
      /^config\.yaml is not valid YAML: [^\u4e00-\u9fff]*$/,
    );
  });
});

describe('RepoSourceInputSchema', () => {
  const refused = (body: unknown) => RepoSourceInputSchema.safeParse(body).success === false;

  it('takes each platform with its own fields', () => {
    expect(
      RepoSourceInputSchema.safeParse({
        platform: 'github',
        issues_repo: 'me/app',
        template: 'self-dev',
        scout: { agent: 'claude', auto: false, interval_minutes: 30, max_proposals: 3 },
        auto_accept: { max_risk: 'low', max_size: 'M', max_per_day: 2 },
        auto_merge: true,
        max_run_attempts: 2,
        daily_budget_usd: 10,
        push: true,
        deliver: 'pr',
      }).success,
    ).toBe(true);
    expect(
      RepoSourceInputSchema.safeParse({
        platform: 'gitlab',
        issues_repo: 'group/sub/app',
        template: 'self-dev',
        scout: null,
        deliver: 'mr',
      }).success,
    ).toBe(true);
    expect(RepoSourceInputSchema.safeParse({ platform: 'backlog', template: 'a' }).success).toBe(
      true,
    );
    expect(RepoSourceInputSchema.safeParse({ platform: 'none' }).success).toBe(true);
  });

  it('refuses the fields a platform does not have', () => {
    expect(refused({ platform: 'backlog', template: 'a', push: true })).toBe(true);
    expect(refused({ platform: 'backlog', template: 'a', issues_repo: 'me/app' })).toBe(true);
    expect(refused({ platform: 'backlog', template: 'a', deliver: 'push' })).toBe(true);
    expect(refused({ platform: 'none', template: 'a' })).toBe(true);
    expect(refused({ platform: 'none', scout: null })).toBe(true);
    expect(refused({ platform: 'github', template: 'a', deliver: 'mr' })).toBe(true);
    expect(
      refused({ platform: 'gitlab', issues_repo: 'g/app', template: 'a', deliver: 'pr' }),
    ).toBe(true);
    expect(refused({ platform: 'github', template: 'a', scout: { agent: 'c', extra: 1 } })).toBe(
      true,
    );
  });

  it('validates the fields as config.yaml does', () => {
    expect(refused({ platform: 'gitlab', template: 'a' })).toBe(true);
    expect(refused({ platform: 'gitlab', issues_repo: 'app', template: 'a' })).toBe(true);
    expect(refused({ platform: 'github', issues_repo: 'a/b/c', template: 'a' })).toBe(true);
    expect(refused({ platform: 'backlog' })).toBe(true);
    expect(refused({ platform: 'backlog', template: '' })).toBe(true);
    expect(refused({ platform: 'backlog', template: 'a', scout: {} })).toBe(true);
    expect(refused({ platform: 'backlog', template: 'a', max_run_attempts: 0 })).toBe(true);
    expect(refused({ platform: 'backlog', template: 'a', daily_budget_usd: 0 })).toBe(true);
    expect(refused({ platform: 'backlog', template: 'a', auto_accept: { max_risk: 'x' } })).toBe(
      true,
    );
    expect(refused({ platform: 'svn', template: 'a' })).toBe(true);
    // The same message as a bad issues_repo in config.yaml.
    const result = RepoSourceInputSchema.safeParse({
      platform: 'gitlab',
      issues_repo: 'app',
      template: 'a',
    });
    expect(result.error?.issues[0]?.message).toBe('格式应为 group/name 或 group/subgroup/name');
  });
});

describe('saveRepoSource', () => {
  const KNOWN = ['fake', 'claude-code', 'cursor-agent', 'codex'];
  const READ_ONLY = ['claude-code', 'codex'];
  const AGENTS = `agents:
  coder: { cli: fake, model: coder }
  reviewer: { cli: fake, model: reviewer }
  scout: { cli: claude-code, model: haiku }
  writer: { cli: cursor-agent, model: auto }
  off: { cli: claude-code, model: haiku, enabled: false }
`;
  const SAVED = `# my Master
language: zh
port: 4870

# issues on GitHub
github:
  repos:
    app:
      template: dev            # the template of its Runs
      push: true
`;
  /** A template a repo keeps in its own .ares1/workflows/. */
  const OWN = TEST_WORKFLOW_YAML.replace('id: dev', 'id: own');

  /** A Master home with `config` as config.yaml (none when null), and its watcher. */
  function home(config: string | null, configFile?: string) {
    const paths: HomePaths = homePaths(tmpDir('ares1-edit-'));
    writeFile(paths.agentsFile, AGENTS);
    writeFile(join(paths.workflowsDir, 'dev.yaml'), TEST_WORKFLOW_YAML);
    if (configFile) {
      writeFile(configFile, config ?? '');
      symlinkSync(configFile, paths.configFile);
    } else if (config !== null) {
      writeFile(paths.configFile, config);
    }
    const initial = loadConfig(paths, KNOWN, READ_ONLY);
    const watcher = new ConfigWatcher(paths, KNOWN, initial, undefined, READ_ONLY);
    const save = (repo: string, input: RepoSourceInput) =>
      saveRepoSource(watcherDeps(watcher, paths.configFile), repo, input);
    return { paths, watcher, save };
  }

  /** The problems a save refuses with; fails when it does not refuse. */
  function refusal(save: () => unknown): readonly string[] {
    try {
      save();
    } catch (err) {
      expect(err).toBeInstanceOf(SourceEditInvalid);
      return (err as SourceEditInvalid).problems;
    }
    throw new Error('saved');
  }

  /** Files left in `dir` by a save: none should be. */
  const leftovers = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.tmp'));

  it('writes the entry and puts the new configuration in use at once', () => {
    const { paths, watcher, save } = home(SAVED);
    expect(
      save('site', { platform: 'backlog', template: 'dev', scout: { agent: 'scout', auto: true } }),
    ).toBe(true);
    const text = readFileSync(paths.configFile, 'utf8');
    expect(text.startsWith(SAVED)).toBe(true);
    expect(raw(text).backlog?.repos).toEqual({
      site: { template: 'dev', scout: { agent: 'scout', auto: true } },
    });
    expect(watcher.current.master.backlog?.repos.site?.scout?.agent).toBe('scout');
    expect(leftovers(paths.home)).toEqual([]);

    // From GitHub to GitLab: only GitLab has it afterwards.
    save('app', { platform: 'gitlab', issues_repo: 'group/app', template: 'dev' });
    expect(Object.keys(watcher.current.master.github?.repos ?? {})).toEqual([]);
    expect(watcher.current.master.gitlab?.repos.app?.issues_repo).toBe('group/app');
    expect(readFileSync(paths.configFile, 'utf8')).toContain('# issues on GitHub');

    save('site', { platform: 'none' });
    expect(watcher.current.master.backlog?.repos).toEqual({});
  });

  it('makes config.yaml when there is none, and keeps the permissions of one there', () => {
    const { paths, watcher, save } = home(null);
    save('site', { platform: 'backlog', template: 'dev' });
    expect(raw(readFileSync(paths.configFile, 'utf8'))).toEqual({
      backlog: { repos: { site: { template: 'dev' } } },
    });
    expect(watcher.current.master.backlog?.repos.site?.template).toBe('dev');

    chmodSync(paths.configFile, 0o600);
    save('site', { platform: 'backlog', template: 'dev', auto_merge: true });
    expect(statSync(paths.configFile).mode & 0o777).toBe(0o600);
  });

  it('refuses a template that does not exist, leaving config.yaml as it was', () => {
    const { paths, watcher, save } = home(SAVED);
    const problems = refusal(() => save('app', { platform: 'backlog', template: 'nope' }));
    expect(problems).toEqual(['模板 nope 不存在或无效']);
    expect(readFileSync(paths.configFile, 'utf8')).toBe(SAVED);
    expect(leftovers(paths.home)).toEqual([]);
    expect(watcher.current.master.github?.repos.app?.template).toBe('dev');
  });

  it('takes a template the repo keeps itself, seen by that repo only', () => {
    const { watcher, save } = home(SAVED);
    const files = [{ file: 'own.yaml', source: OWN }];
    watcher.setRepoSources(new Map([['site', { branch: 'main', sha: 'abc', files }]]), {
      notify: false,
    });
    expect(save('site', { platform: 'backlog', template: 'own' })).toBe(true);
    expect(watcher.current.master.backlog?.repos.site?.template).toBe('own');
    expect(refusal(() => save('other', { platform: 'backlog', template: 'own' }))).toEqual([
      '模板 own 不存在或无效',
    ]);
  });

  it('refuses a scout agent that is missing, disabled or cannot run read-only', () => {
    const { paths, save } = home(SAVED);
    const scouted = (agent: string): RepoSourceInput => ({
      platform: 'backlog',
      template: 'dev',
      scout: { agent },
    });
    expect(refusal(() => save('site', scouted('ghost')))).toEqual([
      '侦察用的 Agent ghost 不存在或未启用',
    ]);
    expect(refusal(() => save('site', scouted('off')))).toEqual([
      '侦察用的 Agent off 不存在或未启用',
    ]);
    expect(refusal(() => save('site', scouted('writer')))).toEqual([
      '侦察要以只读方式运行，Agent writer 的 CLI cursor-agent 不支持，请换用 claude-code、codex 的 Agent',
    ]);
    expect(readFileSync(paths.configFile, 'utf8')).toBe(SAVED);
    expect(leftovers(paths.home)).toEqual([]);
  });

  it('refuses deliver without push, and what the schema refuses', () => {
    const { paths, save } = home(SAVED);
    expect(
      refusal(() => save('app', { platform: 'github', template: 'dev', deliver: 'pr' }))[0],
    ).toMatch(/^deliver: pr 要求 push: true/);
    expect(
      refusal(() =>
        save('app', { platform: 'gitlab', issues_repo: 'g/app', template: 'dev', deliver: 'mr' }),
      )[0],
    ).toMatch(/^deliver: mr 要求 push: true/);
    // Not a body the API takes: what the whole file's schema says, one problem a line.
    const noIssuesRepo = { platform: 'gitlab', template: 'dev' } as RepoSourceInput;
    expect(refusal(() => save('app', noIssuesRepo))).toEqual([
      expect.stringMatching(/^gitlab\.repos\.app\.issues_repo: /),
    ]);
    expect(readFileSync(paths.configFile, 'utf8')).toBe(SAVED);
    expect(leftovers(paths.home)).toEqual([]);
  });

  it('is not stopped by problems another repo had before', () => {
    const broken = `${SAVED}    broken:\n      template: nope\n`;
    const { watcher, save } = home(broken);
    expect(watcher.current.errors['config.yaml#github.repos.broken']).toBeDefined();
    expect(save('site', { platform: 'backlog', template: 'dev' })).toBe(true);
    expect(watcher.current.master.backlog?.repos.site?.template).toBe('dev');
    expect(watcher.current.errors['config.yaml#github.repos.broken']).toBeDefined();
  });

  it('refuses to touch a config.yaml that does not load as it is', () => {
    const { paths, save } = home(SAVED);
    for (const bad of ['port: [\n', 'port: abc\n']) {
      writeFile(paths.configFile, bad);
      expect(() => save('site', { platform: 'backlog', template: 'dev' })).toThrow(
        SourceEditConflict,
      );
      expect(readFileSync(paths.configFile, 'utf8')).toBe(bad);
      expect(leftovers(paths.home)).toEqual([]);
    }
  });

  it('refuses while the last reload failed, even with the file good again', () => {
    const { paths, watcher, save } = home(SAVED);
    writeFile(paths.agentsFile, 'agents: [\n');
    expect(watcher.reload()).toBe(false);
    writeFile(paths.agentsFile, AGENTS);
    expect(() => save('site', { platform: 'backlog', template: 'dev' })).toThrow(
      /配置现在加载不了.*agents\.yaml 不是合法的 YAML/s,
    );
    expect(readFileSync(paths.configFile, 'utf8')).toBe(SAVED);
  });

  it('writes through a symlink to the file it points to', () => {
    const target = join(tmpDir('ares1-edit-real-'), 'config.yaml');
    const { paths, watcher, save } = home(SAVED, target);
    save('site', { platform: 'backlog', template: 'dev' });
    expect(lstatSync(paths.configFile).isSymbolicLink()).toBe(true);
    expect(raw(readFileSync(target, 'utf8')).backlog?.repos).toEqual({
      site: { template: 'dev' },
    });
    expect(watcher.current.master.backlog?.repos.site?.template).toBe('dev');
    expect(leftovers(dirname(target))).toEqual([]);
    expect(leftovers(paths.home)).toEqual([]);
    rmSync(dirname(target), { recursive: true, force: true });
  });

  it('tells the problems in English', () => {
    setLang('en');
    const { paths, save } = home(SAVED.replace('language: zh', 'language: en'));
    const problems = refusal(() =>
      save('site', { platform: 'backlog', template: 'nope', scout: { agent: 'writer' } }),
    );
    expect(problems).toEqual([
      'Template nope does not exist or is invalid',
      'The scout runs read-only, which the CLI cursor-agent of agent writer does not support; use an agent of claude-code, codex',
    ]);
    writeFile(paths.configFile, 'port: abc\n');
    let conflict = '';
    try {
      save('site', { platform: 'backlog', template: 'dev' });
    } catch (err) {
      conflict = (err as Error).message;
    }
    expect(conflict).toMatch(/^The configuration does not load as it is now/);
    expect(`${problems.join('\n')}\n${conflict}`).not.toMatch(/[一-鿿]/);
  });
});
