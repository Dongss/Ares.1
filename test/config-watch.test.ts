import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigView } from '../src/api/types.js';
import {
  findTemplate,
  homePaths,
  initHome,
  loadConfig,
  type RepoTemplateSource,
} from '../src/config/load.js';
import { RepoWorkflows } from '../src/config/repo-workflows.js';
import { type ConfigChange, ConfigWatcher } from '../src/config/watch.js';
import { setLang } from '../src/i18n.js';
import {
  done,
  git,
  type Harness,
  harness,
  initRepo,
  TEST_AGENTS_YAML,
  TEST_WORKFLOW_YAML,
  tmpDir,
  waitFor,
  writeFile,
} from './helpers.js';

/** Commit `content` as `.ares1/workflows/<file>` on the branch checked out in `dir`. */
function commitWorkflow(dir: string, file: string, content: string): string {
  writeFile(join(dir, '.ares1', 'workflows', file), content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', `workflow ${file}`);
  return git(dir, 'rev-parse', 'HEAD');
}

/** A template with id `id` named `name`, of the fake agents of the harness; merges on its own. */
const repoWorkflow = (name: string, id = 'x') => `id: ${id}
name: ${name}
stages:
  - id: implement
    name: 编码
    kind: agent
    agent: coder
  - id: merge
    name: 合并
    kind: merge
    on_reject: implement
`;

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('ConfigWatcher', () => {
  it('reloads, keeps the previous configuration when the new one is broken', () => {
    const paths = homePaths(tmpDir('ares1-watch-'));
    initHome(paths);
    const changes: ConfigChange['type'][] = [];
    const watcher = new ConfigWatcher(
      paths,
      ['claude-code'],
      loadConfig(paths, ['claude-code']),
      (c) => changes.push(c.type),
    );
    expect([...watcher.current.agents.keys()]).toEqual(['claude-coder', 'claude-reviewer']);

    writeFile(paths.agentsFile, 'agents:\n  solo: { cli: claude-code, model: haiku }\n');
    expect(watcher.reload()).toBe(true);
    expect([...watcher.current.agents.keys()]).toEqual(['solo']);
    expect(watcher.status().reloadError).toBeNull();

    // A half-saved file: keep using the last good configuration and say why.
    writeFile(paths.agentsFile, 'agents:\n  solo: { cli: claude-code, model: [\n');
    expect(watcher.reload()).toBe(false);
    expect([...watcher.current.agents.keys()]).toEqual(['solo']);
    expect(watcher.status().reloadError?.message).toMatch(/agents\.yaml 不是合法的 YAML/);
    writeFile(paths.configFile, 'port: [\n');
    expect(watcher.reload()).toBe(false);
    expect(changes).toEqual(['reloaded', 'reload_failed', 'reload_failed']);

    // Port and CLI paths only apply after a restart.
    writeFile(paths.configFile, 'port: 5000\nbins:\n  claude-code: /opt/claude\n');
    writeFile(paths.agentsFile, 'agents:\n  solo: { cli: claude-code, model: haiku }\n');
    expect(watcher.reload()).toBe(true);
    expect(watcher.status().restartNeeded).toEqual(['端口（port）', 'CLI 路径（bins）']);

    // A typo in config.yaml is reported on reload as at startup, and fixing it clears it.
    writeFile(paths.configFile, 'upgarde:\n  auto: true\n');
    expect(watcher.reload()).toBe(true);
    expect(watcher.current.master.upgrade.auto).toBe(false);
    expect(watcher.current.warnings['config.yaml']?.[0]).toMatch(/未知的配置项 upgarde/);
    writeFile(paths.configFile, 'upgrade:\n  auto: true\n');
    expect(watcher.reload()).toBe(true);
    expect(watcher.current.master.upgrade.auto).toBe(true);
    expect(watcher.current.warnings).toEqual({});
  });
});

describe('config reload in the Master', () => {
  it('picks up file changes: new runs use the new template, the dashboard is told', async () => {
    h = await harness();
    const events: string[] = [];
    h.master.store.bus.on('event', (e: { type: string }) => events.push(e.type));
    const first = h.run('旧模板');
    await h.waitStatus(first.id, 'waiting_approval');

    // Switch the coding stage to coder2 by editing the template file.
    writeFile(
      join(h.home, 'workflows', 'dev.yaml'),
      TEST_WORKFLOW_YAML.replace('agent: coder\n', 'agent: coder2\n'),
    );
    await waitFor(
      () => h?.master.config.templates.get('dev')?.stages[0]?.agent === 'coder2',
      'template reload',
      5000,
    );
    expect(events).toContain('config.reloaded');

    // The waiting run keeps its snapshot; a new run uses the new template.
    expect(h.master.store.getRun(first.id).template.stages[0]?.agent).toBe('coder');
    h.master.engine.approve(first.id);
    await h.waitStatus(first.id, 'completed');
    const second = h.run('新模板');
    await h.waitStatus(second.id, 'waiting_approval');
    expect(h.fake.calls.map((c) => c.model)).toEqual(['coder', 'reviewer', 'coder2', 'reviewer']);

    // A broken agents.yaml is reported and the last good configuration stays in use.
    writeFile(join(h.home, 'agents.yaml'), `${TEST_AGENTS_YAML}  broken: [\n`);
    await waitFor(() => events.includes('config.reload_failed'), 'reload failure', 5000);
    const res = await h.master.app.request('/api/config');
    const view = (await res.json()) as ConfigView;
    expect(view.reloadError?.message).toMatch(/agents\.yaml/);
    expect(view.agents.map((a) => a.id)).toEqual(['coder', 'coder2', 'reviewer']);
    expect(view.restartNeeded).toEqual([]);
    expect(Date.parse(view.loadedAt)).not.toBeNaN();
  });

  it('applies agent settings from the next execution', async () => {
    h = await harness();
    writeFile(
      join(h.home, 'agents.yaml'),
      TEST_AGENTS_YAML.replace('    model: coder\n', '    model: coder\n    effort: high\n'),
    );
    await waitFor(() => h?.master.config.agents.get('coder')?.effort === 'high', 'reload', 5000);
    h.scripts.coder = (ctx) => {
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return done();
    };
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');
    expect(h.fake.calls[0]?.effort).toBe('high');
  });
});

describe('RepoWorkflows', () => {
  type Source = RepoTemplateSource | undefined;

  it('reads the files committed on the target branch, and again only when it moved', async () => {
    const dir = initRepo();
    const first = commitWorkflow(dir, 'x.yaml', 'id: x\n');
    // Uncommitted changes and untracked files of the checkout play no part.
    writeFile(join(dir, '.ares1', 'workflows', 'x.yaml'), 'id: uncommitted\n');
    writeFile(join(dir, '.ares1', 'workflows', 'new.yaml'), 'id: untracked\n');
    const repos = [{ name: 'a', path: dir, targetBranch: 'main' }];
    const applied: Map<string, RepoTemplateSource>[] = [];
    const rw = new RepoWorkflows({ repos: () => repos, apply: (s) => applied.push(new Map(s)) });

    await rw.refresh();
    const read: Source = applied[0]?.get('a');
    expect(read).toEqual({
      branch: 'main',
      sha: first,
      files: [{ file: 'x.yaml', source: 'id: x\n' }],
    });
    // Nothing moved: the files are not read again.
    await rw.refresh();
    expect(applied[1]?.get('a')).toBe(read);

    // A commit on the target branch is read.
    git(dir, 'checkout', '-q', '--', '.ares1');
    const second = commitWorkflow(dir, 'y.yml', 'id: y\n');
    await rw.refresh();
    expect(applied[2]?.get('a')?.sha).toBe(second);
    expect(applied[2]?.get('a')?.files.map((f) => f.file)).toEqual(['new.yaml', 'x.yaml', 'y.yml']);

    // Another target branch: read from it, though at the same commit.
    git(dir, 'branch', 'other', first);
    repos[0] = { name: 'a', path: dir, targetBranch: 'other' };
    await rw.refresh();
    expect(applied[3]?.get('a')).toEqual({ ...read, branch: 'other' });

    // A repo no longer registered has no files.
    repos.length = 0;
    await rw.refresh();
    expect(applied[4]).toEqual(new Map());
  });

  it('runs one refresh at a time; asked again while one waits, it is that one', async () => {
    const dir = initRepo();
    commitWorkflow(dir, 'x.yaml', 'id: x\n');
    let active = 0;
    let most = 0;
    let applied = 0;
    const rw = new RepoWorkflows({
      repos: () => {
        active++;
        most = Math.max(most, active);
        return [{ name: 'a', path: dir, targetBranch: 'main' }];
      },
      apply: () => {
        active--;
        applied++;
      },
    });
    const one = rw.refresh();
    // Once the first has started, the next two wait for it, as one.
    await new Promise((r) => setImmediate(r));
    const two = rw.refresh();
    const three = rw.refresh();
    expect(two).not.toBe(one);
    expect(three).toBe(two);
    await Promise.all([one, two, three]);
    expect(applied).toBe(2);
    expect(most).toBe(1);

    // None after stopping.
    await rw.stop();
    await rw.refresh();
    expect(applied).toBe(2);
  });

  it('keeps what it read when the branch cannot be read, telling once per streak', async () => {
    const dir = initRepo();
    const sha = commitWorkflow(dir, 'x.yaml', 'id: x\n');
    const repos = [{ name: 'a', path: dir, targetBranch: 'main' }];
    const applied: Map<string, RepoTemplateSource>[] = [];
    const warnings: string[] = [];
    const rw = new RepoWorkflows({
      repos: () => repos,
      apply: (s) => applied.push(new Map(s)),
      warn: (m) => warnings.push(m),
    });
    await rw.refresh();
    const read = applied[0]?.get('a');

    // The branch is gone for a while: what was read from it stands, told once.
    git(dir, 'update-ref', '-d', 'refs/heads/main');
    await rw.refresh();
    await rw.refresh();
    expect(applied[1]?.get('a')).toBe(read);
    expect(applied[2]?.get('a')).toBe(read);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /^\[流程模板\] 读不到仓库 a 目标分支 main 上的 \.ares1\/workflows\/：/,
    );

    // Back: the streak ends, and the next failure is told again.
    git(dir, 'update-ref', 'refs/heads/main', sha);
    await rw.refresh();
    expect(warnings).toHaveLength(1);
    git(dir, 'update-ref', '-d', 'refs/heads/main');
    await rw.refresh();
    expect(warnings).toHaveLength(2);

    // A target branch that cannot be read has no files: those read from another do not stand in.
    git(dir, 'update-ref', 'refs/heads/main', sha);
    repos[0] = { name: 'a', path: dir, targetBranch: 'nope' };
    await rw.refresh();
    expect(applied.at(-1)?.has('a')).toBe(false);
    expect(warnings).toHaveLength(3);
  });

  it('tells in English when the Master speaks English', async () => {
    setLang('en');
    try {
      const warnings: string[] = [];
      const rw = new RepoWorkflows({
        repos: () => [{ name: 'a', path: initRepo(), targetBranch: 'nope' }],
        apply: () => {
          throw new Error('broken');
        },
        warn: (m) => warnings.push(m),
      });
      await rw.refresh();
      expect(warnings[0]).toMatch(
        /^\[workflows\] Could not read \.ares1\/workflows\/ on the target branch nope of repo a: /,
      );
      expect(warnings[1]).toBe(
        '[workflows] Could not refresh the templates the repos keep: broken',
      );
      // What git itself says follows in the machine's locale.
      const ours = [warnings[0]?.split(': git ')[0], warnings[1]].join('\n');
      expect(ours).not.toMatch(/[一-鿿]/);
    } finally {
      setLang('zh');
    }
  });
});

describe('ConfigWatcher: templates the repos keep', () => {
  const x = (name: string) =>
    `id: x\nname: ${name}\nstages:\n  - id: implement\n    name: 编码\n    kind: agent\n    agent: claude-coder\n`;
  const source = (sha: string, files: { file: string; source: string }[]) => ({
    branch: 'main',
    sha: sha.repeat(40),
    files,
  });
  const key = 'a:.ares1/workflows/x.yaml';

  it('loads them again when their files change, without telling when only commits moved', () => {
    const paths = homePaths(tmpDir('ares1-watch-'));
    initHome(paths);
    const changes: ConfigChange['type'][] = [];
    const clis = ['claude-code'];
    const watcher = new ConfigWatcher(
      paths,
      clis,
      loadConfig(paths, clis, clis),
      (c) => changes.push(c.type),
      clis,
    );
    const name = () => findTemplate(watcher.current, 'a', 'x')?.template.name;

    watcher.setRepoSources(new Map([['a', source('1', [{ file: 'x.yaml', source: x('一') }])]]));
    expect(changes).toEqual(['reloaded']);
    expect(name()).toBe('一');
    expect(findTemplate(watcher.current, 'b', 'x')).toBeNull();

    // The same files at another commit: loaded again to name it, nobody told.
    watcher.setRepoSources(new Map([['a', source('2', [{ file: 'x.yaml', source: x('一') }])]]));
    expect(changes).toEqual(['reloaded']);
    expect(watcher.current.repoTemplates.get('a')?.sha).toBe('2'.repeat(40));
    // A repo without files is as one left out: nothing to load.
    const unchanged = watcher.current;
    watcher.setRepoSources(
      new Map([
        ['a', source('2', [{ file: 'x.yaml', source: x('一') }])],
        ['b', source('3', [])],
      ]),
    );
    expect(watcher.current).toBe(unchanged);

    // Broken: the version that last loaded stays, with a warning naming its commit.
    watcher.setRepoSources(
      new Map([['a', source('4', [{ file: 'x.yaml', source: 'id: x\nstages: [\n' }])]]),
    );
    expect(changes).toEqual(['reloaded', 'reloaded']);
    expect(name()).toBe('一');
    expect(watcher.current.warnings[key]?.[0]).toMatch(
      /继续使用上次加载成功的版本（提交 2222222）/,
    );
    expect(watcher.current.errors).toEqual({});

    // The home directory's files change: loaded with the repos' files as they are.
    writeFile(paths.configFile, 'upgrade:\n  auto: true\n');
    expect(watcher.reload()).toBe(true);
    expect(watcher.current.master.upgrade.auto).toBe(true);
    expect(name()).toBe('一');
    expect(watcher.current.warnings[key]?.[0]).toMatch(/提交 2222222/);

    // Fixed; then gone, without telling when asked not to.
    watcher.setRepoSources(new Map([['a', source('5', [{ file: 'x.yaml', source: x('二') }])]]));
    expect(name()).toBe('二');
    expect(watcher.current.warnings).toEqual({});
    watcher.setRepoSources(new Map(), { notify: false });
    expect(name()).toBeUndefined();
    expect(changes).toEqual(['reloaded', 'reloaded', 'reloaded', 'reloaded']);
  });
});

describe('templates the repos keep, in the Master', () => {
  it('creates Runs with them, reads what a Run merged, and shows them to their repo only', async () => {
    h = await harness();
    const events: string[] = [];
    h.master.store.bus.on('event', (e: { type: string }) => events.push(e.type));
    commitWorkflow(h.repoDir, 'x.yaml', repoWorkflow('仓库流程'));
    await h.master.repoWorkflows.refresh();
    expect(events).toEqual(['config.reloaded']);

    h.scripts.coder = (ctx) => {
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      writeFile(
        join(ctx.input.workdir, '.ares1', 'workflows', 'x.yaml'),
        repoWorkflow('Run 改过的流程'),
      );
      return done();
    };
    const run = h.master.engine.createRun({ repo: 'demo', template: 'x', goal: '改流程' });
    expect(run.templateId).toBe('x');
    expect(run.template.name).toBe('仓库流程');
    await h.waitStatus(run.id, 'completed');
    // The merge moved the target branch: the template it brought is read.
    const master = h.master;
    await waitFor(
      () => findTemplate(master.config, 'demo', 'x')?.template.name === 'Run 改过的流程',
      'the merged template',
    );
    expect(h.master.store.getRun(run.id).template.name).toBe('仓库流程');

    // A file that never loaded: a Run of its template says why.
    commitWorkflow(h.repoDir, 'y.yaml', 'id: y\nstages: [\n');
    await h.master.repoWorkflows.refresh();
    expect(() => h?.master.engine.createRun({ repo: 'demo', template: 'y', goal: 'g' })).toThrow(
      /模板 y 不存在或无效（demo:\.ares1\/workflows\/y\.yaml: /,
    );

    // Another repo does not see them.
    h.master.store.createRepo({
      name: 'other',
      path: initRepo(),
      targetBranch: 'main',
      verifyCommands: [],
      setupCommands: [],
      mergeMode: 'direct',
    });
    await h.master.repoWorkflows.refresh();
    let error: unknown;
    try {
      h.master.engine.createRun({ repo: 'other', template: 'x', goal: 'g' });
    } catch (err) {
      error = err;
    }
    expect((error as Error).message).toBe('模板 x 不存在或无效');
  });

  it('reads them at startup, before the first poll, without telling', async () => {
    h = await harness();
    commitWorkflow(h.repoDir, 'x.yaml', repoWorkflow('仓库流程'));
    const { home, repoDir } = h;
    await h.close();
    h = await harness({ home, repoDir });
    expect(findTemplate(h.master.config, 'demo', 'x')?.template.name).toBe('仓库流程');
    expect(h.master.store.listGlobalEventsOfType('config.reloaded')).toEqual([]);
  });
});
