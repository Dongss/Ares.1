import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { MasterOptions } from '../src/master.js';
import { noticeFor } from '../src/notify/notice.js';
import { githubNameOf, isMasterSource } from '../src/upgrade/source.js';
import {
  copyUpgradeScript,
  envRetryDelayMs,
  lastUpgradeFailure,
  type UpgradePlan,
} from '../src/upgrade/upgrader.js';
import {
  done,
  git,
  type Harness,
  harness,
  initRepo,
  tmpDir,
  waitFor,
  writeFile,
} from './helpers.js';

let h: Harness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

/**
 * A Master "installed" in a clone of `origin`, with auto upgrade on. `master` adds to its
 * options, e.g. whether its node is gone (`nodeMissing`).
 */
async function installed(
  opts: {
    auto?: boolean;
    master?: Partial<MasterOptions>;
    verifyCommands?: string[];
    config?: string;
  } = {},
) {
  const origin = initRepo();
  const installDir = join(tmpDir('ares1-install-'), 'stable');
  git(origin, 'clone', '-q', origin, installDir);
  const launches: UpgradePlan[] = [];
  let exits = 0;
  h = await harness({
    config: `upgrade:\n  auto: ${opts.auto ?? true}\n${opts.config ?? ''}`,
    verifyCommands: opts.verifyCommands,
    master: {
      installDir,
      launchUpgrade: (plan) => launches.push(plan),
      exit: () => {
        exits++;
      },
      ...opts.master,
    },
  });
  // The Master closes its database when it hands over, so collect events as they happen.
  const seen: { type: string; runId: string | null; data: Record<string, unknown> }[] = [];
  h.master.store.bus.on('event', (e) => seen.push(e));
  const commit = (file: string) => {
    writeFile(join(origin, file), `${file}\n`);
    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', file);
    return git(origin, 'rev-parse', 'HEAD');
  };
  return { t: h, origin, installDir, launches, exits: () => exits, commit, seen };
}

const eventsOf = (t: Harness, type: string) =>
  t.master.store.db.prepare('SELECT data FROM events WHERE type = ?').all(type) as {
    data: string;
  }[];

describe('upgrader', () => {
  it('stays put while the install directory is up to date', async () => {
    const { t, launches } = await installed();
    await t.master.upgrader.check();
    expect(t.master.upgrader.status().state).toBe('up_to_date');
    expect(launches).toEqual([]);
  });

  it('hands over to the upgrade script when origin moved on, then stops the Master', async () => {
    const { t, installDir, launches, exits, commit, seen } = await installed();
    const from = git(installDir, 'rev-parse', 'HEAD');
    const to = commit('new.txt');
    await t.master.upgrader.check();
    expect(launches).toEqual([
      {
        installDir,
        from,
        to,
        resultFile: join(t.home, 'data', 'upgrade-result.json'),
      },
    ]);
    expect(exits()).toBe(1);
    expect(seen.filter((e) => e.type === 'upgrade.started')).toHaveLength(1);
  });

  it('waits for the executing Run and starts no other Run meanwhile', async () => {
    const { t, launches, commit, seen } = await installed();
    let finish: (() => void) | undefined;
    const coder = t.scripts.coder as NonNullable<typeof t.scripts.coder>;
    t.scripts.coder = (ctx) =>
      new Promise((resolve) => {
        finish = () => resolve(coder(ctx));
      });
    const first = t.run('第一个', { stages: { merge: { gate: false } } });
    const second = t.run('第二个');
    await t.waitStatus(first.id, 'running');
    commit('new.txt');

    await t.master.upgrader.check();
    expect(t.master.upgrader.status().state).toBe('waiting');
    expect(t.master.engine.held).toBe(true);
    expect(launches).toEqual([]);

    await waitFor(() => finish !== undefined, 'coder to start');
    finish?.();
    // Completing the Run triggers another check, which launches and closes the Master.
    await waitFor(() => launches.length === 1, 'upgrade launch');
    const statuses = (id: string) =>
      seen.filter((e) => e.type === 'run.status' && e.runId === id).map((e) => e.data.status);
    expect(statuses(first.id).at(-1)).toBe('completed');
    expect(statuses(second.id)).not.toContain('running');
  });

  it('reports the result left by the script, and does not retry a target that failed', async () => {
    const origin = initRepo();
    const installDir = join(tmpDir('ares1-install-'), 'stable');
    git(origin, 'clone', '-q', origin, installDir);
    writeFile(join(origin, 'x.txt'), 'x\n');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', 'x');
    const to = git(origin, 'rev-parse', 'HEAD');
    const home = tmpDir('ares1-home-');
    writeFile(
      join(home, 'data', 'upgrade-result.json'),
      JSON.stringify({ ok: false, from: 'aaa', to, message: '构建失败，已回退' }),
    );
    const launches: UpgradePlan[] = [];
    h = await harness({
      home,
      config: 'upgrade:\n  auto: true\n',
      master: { installDir, launchUpgrade: (p) => launches.push(p), exit: () => {} },
    });
    const failed = eventsOf(h, 'upgrade.failed');
    expect(failed).toHaveLength(1);
    expect(JSON.parse(failed[0]?.data ?? '{}')).toMatchObject({ message: '构建失败，已回退' });

    await h.master.upgrader.check();
    expect(h.master.upgrader.status().state).toBe('skipped');
    expect(h.master.engine.held).toBe(false);
    expect(launches).toEqual([]);
  });

  it('does not retry a target it could not pull, until origin has a newer commit', async () => {
    const first = await installed();
    const { home } = first.t;
    const from = git(first.installDir, 'rev-parse', 'HEAD');
    const to = first.commit('new.txt');
    await first.t.master.upgrader.check();
    expect(first.launches).toHaveLength(1);
    // The pull failed, so HEAD never moved: the script reports the old commit as `to`.
    writeFile(
      join(home, 'data', 'upgrade-result.json'),
      JSON.stringify({ ok: false, from, to: from, message: '拉取失败，已回退' }),
    );
    const launches: UpgradePlan[] = [];
    h = await harness({
      home,
      config: 'upgrade:\n  auto: true\n',
      master: {
        installDir: first.installDir,
        launchUpgrade: (p) => launches.push(p),
        exit: () => {},
      },
    });
    const failed = eventsOf(h, 'upgrade.failed');
    expect(failed).toHaveLength(1);
    expect(JSON.parse(failed[0]?.data ?? '{}')).toMatchObject({ from, to });

    await h.master.upgrader.check();
    expect(h.master.upgrader.status()).toMatchObject({
      state: 'skipped',
      message: `升级到 ${to.slice(0, 7)} 失败过，等有新的提交再试`,
    });
    expect(h.master.engine.held).toBe(false);
    expect(launches).toEqual([]);

    const newer = first.commit('newer.txt');
    await h.master.upgrader.check();
    expect(launches).toEqual([expect.objectContaining({ from, to: newer })]);
  });

  it('records a failure found while the script watched the new version, after its success', async () => {
    const first = await installed();
    const { home } = first.t;
    const from = git(first.installDir, 'rev-parse', 'HEAD');
    const to = first.commit('new.txt');
    await first.t.master.upgrader.check();
    expect(first.launches).toHaveLength(1);
    const resultFile = join(home, 'data', 'upgrade-result.json');
    const launches: UpgradePlan[] = [];
    const start = () =>
      harness({
        home,
        config: 'upgrade:\n  auto: true\n',
        master: {
          installDir: first.installDir,
          launchUpgrade: (p) => launches.push(p),
          exit: () => {},
        },
      });

    // The new version starts and reads the success the script wrote before starting it; that
    // clears the planned target and any earlier failure.
    writeFile(resultFile, JSON.stringify({ ok: true, from, to, message: '' }));
    const upgraded = await start();
    expect(eventsOf(upgraded, 'upgrade.done')).toHaveLength(1);
    await upgraded.close();

    // It crashes while the script watches it; the script rolls back and leaves a failure for
    // the old version, which it starts again.
    const message = `新版本 ${to.slice(0, 7)} 启动后 1 分钟内退出（退出码 1），已回退到 ${from.slice(0, 7)}`;
    const detail = 'TypeError: boom';
    writeFile(resultFile, JSON.stringify({ ok: false, from, to, message, detail }));
    h = await start();
    const failed = eventsOf(h, 'upgrade.failed');
    expect(failed).toHaveLength(1);
    expect(JSON.parse(failed[0]?.data ?? '{}')).toEqual({ from, to, message, detail });
    expect(lastUpgradeFailure(h.master.store)).toMatchObject({
      from,
      to,
      message,
      detail,
      env: false,
    });
    expect(h.master.store.getSetting('upgrade.failed_to')).toBe(to);

    // And it does not try that commit again.
    await h.master.upgrader.check();
    expect(h.master.upgrader.status()).toMatchObject({
      state: 'skipped',
      message: `升级到 ${to.slice(0, 7)} 失败过，等有新的提交再试`,
    });
    expect(launches).toEqual([]);
  });

  it('reports a successful upgrade on the next start', async () => {
    const home = tmpDir('ares1-home-');
    writeFile(
      join(home, 'data', 'upgrade-result.json'),
      JSON.stringify({ ok: true, from: 'aaa', to: 'bbb' }),
    );
    h = await harness({ home });
    expect(eventsOf(h, 'upgrade.done')).toHaveLength(1);
  });

  it("keeps the failure's output until an upgrade succeeds", async () => {
    const home = tmpDir('ares1-home-');
    const detail = 'npm ERR! "quoted" C:\\path\\to\nsrc/a.ts(3,1): error TS1005: \';\' expected.';
    writeFile(
      join(home, 'data', 'upgrade-result.json'),
      `${JSON.stringify({ ok: false, from: 'aaa', to: 'bbb', message: '拉取或构建 bbb 失败', detail })}\n`,
    );
    h = await harness({ home });
    const failed = eventsOf(h, 'upgrade.failed');
    expect(failed).toHaveLength(1);
    // A field of its own, not part of the message.
    expect(JSON.parse(failed[0]?.data ?? '{}')).toEqual({
      from: 'aaa',
      to: 'bbb',
      message: '拉取或构建 bbb 失败',
      detail,
    });
    expect(lastUpgradeFailure(h.master.store)).toEqual({
      from: 'aaa',
      to: 'bbb',
      message: '拉取或构建 bbb 失败',
      detail,
      at: expect.any(String),
      env: false,
    });
    // Only a failure of the environment records the flag.
    expect(
      JSON.parse(h.master.store.getSetting('upgrade.last_failure') ?? '{}'),
    ).not.toHaveProperty('env');
    await h.close();

    // Still there after another start without a result; gone once an upgrade succeeds.
    h = await harness({ home });
    expect(lastUpgradeFailure(h.master.store)?.detail).toBe(detail);
    await h.close();
    writeFile(
      join(home, 'data', 'upgrade-result.json'),
      JSON.stringify({ ok: true, from: 'aaa', to: 'ccc', message: '' }),
    );
    h = await harness({ home });
    expect(lastUpgradeFailure(h.master.store)).toBeNull();
  });

  it('reads a failure recorded before it said whether the environment caused it', async () => {
    h = await harness();
    const old = {
      from: 'aaa',
      to: 'bbb',
      message: '拉取或构建 bbb 失败',
      detail: null,
      at: '2026-11-20T08:00:00.000Z',
    };
    h.master.store.setSetting('upgrade.last_failure', JSON.stringify(old));
    expect(lastUpgradeFailure(h.master.store)).toEqual({ ...old, env: false });
  });

  it('counts a result file of the wrong shape as a failure it cannot read', async () => {
    const home = tmpDir('ares1-home-');
    writeFile(join(home, 'data', 'upgrade-result.json'), JSON.stringify({ ok: 'yes' }));
    h = await harness({ home });
    expect(eventsOf(h, 'upgrade.done')).toHaveLength(0);
    const failed = eventsOf(h, 'upgrade.failed');
    expect(JSON.parse(failed[0]?.data ?? '{}')).toMatchObject({ message: '升级结果文件无法解析' });
    expect(lastUpgradeFailure(h.master.store)).toMatchObject({
      message: '升级结果文件无法解析',
      detail: null,
    });
  });

  it('needs a human when the install directory has local changes', async () => {
    const { t, installDir, launches, commit } = await installed();
    commit('new.txt');
    writeFileSync(join(installDir, 'README.md'), 'changed\n');
    await t.master.upgrader.check();
    await t.master.upgrader.check();
    expect(t.master.upgrader.status().state).toBe('blocked');
    expect(eventsOf(t, 'upgrade.failed')).toHaveLength(1); // notified once
    expect(launches).toEqual([]);
    expect(t.master.engine.held).toBe(false);
  });

  it('does nothing when auto upgrade is off or work is stopped', async () => {
    const off = await installed({ auto: false });
    off.commit('new.txt');
    await off.t.master.upgrader.check();
    expect(off.t.master.upgrader.status().state).toBe('off');
    await off.t.close();

    const on = await installed();
    on.commit('new.txt');
    on.t.master.engine.setWorking(false);
    await on.t.master.upgrader.check();
    expect(on.t.master.upgrader.status()).toMatchObject({ state: 'waiting', message: '已停工' });
    expect(on.launches).toEqual([]);
  });

  it('cannot upgrade a Master that does not run from a build', async () => {
    h = await harness({ config: 'upgrade:\n  auto: true\n' });
    await h.master.upgrader.check();
    expect(h.master.upgrader.status().state).toBe('unavailable');
  });

  it('restarts on the commit it runs once its node is gone, without waiting for the Run', async () => {
    let gone = false;
    // Auto upgrade off: restarting keeps the Master running, it changes no version.
    const { t, installDir, launches, exits, seen } = await installed({
      auto: false,
      master: { nodeMissing: () => gone },
    });
    const from = git(installDir, 'rev-parse', 'HEAD');
    let started = false;
    t.scripts.coder = async (ctx) => {
      started = true;
      await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
      return done();
    };
    const run = t.run();
    await waitFor(() => started, 'coder to start');

    gone = true;
    await t.master.upgrader.check();
    expect(launches).toEqual([
      { installDir, from, to: from, resultFile: join(t.home, 'data', 'upgrade-result.json') },
    ]);
    expect(exits()).toBe(1);
    const of = (type: string) => seen.filter((e) => e.type === type).map((e) => e.data);
    expect(of('master.node_missing')).toEqual([{ node: process.execPath, commit: from }]);
    expect(of('upgrade.started')).toEqual([{ from, to: from, reason: 'node_missing' }]);
    // The Run was interrupted like on any restart, and waits in the queue for the next Master.
    const statuses = seen
      .filter((e) => e.type === 'run.status' && e.runId === run.id)
      .map((e) => e.data.status);
    expect(statuses.at(-1)).toBe('queued');
    expect(seen.some((e) => e.type === 'run.interrupted' && e.runId === run.id)).toBe(true);
  });

  it('blocks a Run on the environment instead of running checks when the node is gone; the restarted Master goes on', async () => {
    let gone = false;
    const marker = join(tmpDir('ares1-marker-'), 'verified');
    const first = await installed({
      master: { nodeMissing: () => gone },
      verifyCommands: [`touch ${marker}`, 'grep -q ok feature.txt'],
    });
    const coder = first.t.scripts.coder as NonNullable<typeof first.t.scripts.coder>;
    first.t.scripts.coder = (ctx) => {
      // nvm uninstalls the version the Master runs on while the agent works.
      gone = true;
      return coder(ctx);
    };
    const run = first.t.run();
    // The block wakes the upgrader, which restarts the Master.
    await waitFor(() => first.launches.length === 1, 'the restart', 10_000);
    const from = git(first.installDir, 'rev-parse', 'HEAD');
    expect(first.launches[0]).toMatchObject({ from, to: from });
    const blocked = first.seen.find((e) => e.type === 'run.blocked' && e.runId === run.id);
    expect(blocked?.data).toMatchObject({ kind: 'environment', missing: process.execPath });
    expect(String(blocked?.data.message)).toContain(`Master 正在用的 node（${process.execPath}）`);
    // No check ran, so none was failed and nothing was sent back to the agent.
    expect(existsSync(marker)).toBe(false);
    expect(first.seen.some((e) => e.type === 'task.rework')).toBe(false);

    // The script found a node and started the next Master: the Run goes on with the checks only.
    writeFile(
      join(first.t.home, 'data', 'upgrade-result.json'),
      JSON.stringify({ ok: true, from, to: from, message: '' }),
    );
    h = await harness({
      home: first.t.home,
      repoDir: first.t.repoDir,
      config: 'upgrade:\n  auto: true\n',
      master: { installDir: first.installDir, launchUpgrade: () => {}, exit: () => {} },
    });
    await h.waitStatus(run.id, 'waiting_approval');
    expect(existsSync(marker)).toBe(true);
    expect(h.fake.calls.filter((c) => c.model === 'coder')).toEqual([]);
    const [task] = h.master.store.listRunTasks(run.id);
    expect(task?.retries).toBe(0);
    const types = h.master.store.listEvents(run.id).map((e) => e.type);
    expect(types).toContain('environment.resumed');
    expect(types).toContain('task.verify_resumed');
    expect(eventsOf(h, 'upgrade.done')).toHaveLength(1);
  });

  it('tries a target that failed for the environment again after a wait, notifying once', async () => {
    const origin = initRepo();
    const installDir = join(tmpDir('ares1-install-'), 'stable');
    git(origin, 'clone', '-q', origin, installDir);
    const from = git(installDir, 'rev-parse', 'HEAD');
    writeFile(join(origin, 'x.txt'), 'x\n');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', 'x');
    const to = git(origin, 'rev-parse', 'HEAD');
    const home = tmpDir('ares1-home-');
    const resultFile = join(home, 'data', 'upgrade-result.json');
    const message = `构建 ${to.slice(0, 7)} 时找不到能用的 node 或 npm`;
    let now = Date.parse('2026-11-23T10:00:00Z');
    const launches: UpgradePlan[] = [];
    const start = () =>
      harness({
        home,
        config: 'upgrade:\n  auto: true\n',
        master: {
          installDir,
          launchUpgrade: (p) => launches.push(p),
          exit: () => {},
          now: () => now,
        },
      });
    const failedEvents = (t: Harness) =>
      eventsOf(t, 'upgrade.failed').map((e) => JSON.parse(e.data) as Record<string, unknown>);

    writeFile(resultFile, JSON.stringify({ ok: false, from, to, message, env: true }));
    let t = await start();
    expect(failedEvents(t)).toEqual([{ from, to, message, env: true }]);
    // Not given up like a commit that failed: nothing records it as failed.
    expect(t.master.store.getSetting('upgrade.failed_to')).toBeNull();
    // Recorded as the environment's, so the scout is not asked to fix the code for it.
    expect(lastUpgradeFailure(t.master.store)).toMatchObject({ to, message, env: true });

    // Within a check interval, it waits.
    await t.master.upgrader.check();
    expect(t.master.upgrader.status().state).toBe('skipped');
    expect(t.master.upgrader.status().message).toContain('运行环境的问题');
    expect(t.master.engine.held).toBe(false);
    expect(launches).toEqual([]);

    // Then the same commit is tried again.
    now += envRetryDelayMs(1);
    await t.master.upgrader.check();
    expect(launches).toEqual([expect.objectContaining({ from, to })]);
    await t.close();

    // Failing for the environment again: the wait doubles, and nobody is notified again.
    writeFile(resultFile, JSON.stringify({ ok: false, from, to, message, env: true }));
    t = await start();
    h = t;
    const [again] = failedEvents(t).slice(-1);
    expect(again).toEqual({ from, to, message, env: true, repeated: true });
    expect(noticeFor({ type: 'upgrade.failed', data: again ?? {} } as never, undefined)).toBeNull();
    expect(
      noticeFor({ type: 'upgrade.failed', data: failedEvents(t)[0] ?? {} } as never, undefined),
    ).not.toBeNull();
    now += envRetryDelayMs(1);
    await t.master.upgrader.check();
    expect(launches).toHaveLength(1);
    now += envRetryDelayMs(2) - envRetryDelayMs(1);
    await t.master.upgrader.check();
    expect(launches).toHaveLength(2);
    expect(envRetryDelayMs(2)).toBe(2 * envRetryDelayMs(1));
    expect(envRetryDelayMs(30)).toBe(60 * 60_000);
  });
});

describe('isMasterSource', () => {
  const installDir = '/opt/ares1-stable';
  const origin = (url: string) => ({ installDir, url });

  it('matches the repo whose directory the install directory was cloned from', () => {
    const repo = tmpDir('ares1-repo-');
    const link = join(tmpDir('ares1-link-'), 'repo');
    symlinkSync(repo, link);
    const candidate = { path: repo, github: null };
    expect(isMasterSource(origin(repo), candidate)).toBe(true);
    // Compared after resolving symbolic links, on either side.
    expect(isMasterSource(origin(link), candidate)).toBe(true);
    expect(isMasterSource(origin(repo), { path: link, github: null })).toBe(true);
    expect(isMasterSource(origin(pathToFileURL(repo).href), candidate)).toBe(true);
    expect(isMasterSource(origin(`${repo}/.git`), candidate)).toBe(true);
    expect(isMasterSource(origin(tmpDir('ares1-other-')), candidate)).toBe(false);
  });

  it('resolves a relative origin against the install directory', () => {
    const real = (path: string) => path;
    expect(
      isMasterSource(origin('../dev/ares1'), { path: '/opt/dev/ares1', github: null }, real),
    ).toBe(true);
  });

  it("matches a GitHub origin with the repo's GitHub name, ignoring case", () => {
    const repo = { path: '/somewhere/else', github: 'Owner/Ares.1' };
    for (const url of [
      'https://github.com/owner/ares.1.git',
      'https://github.com/Owner/Ares.1',
      'git@github.com:Owner/Ares.1.git',
      'ssh://git@github.com/Owner/Ares.1.git',
    ]) {
      expect(isMasterSource(origin(url), repo), url).toBe(true);
    }
    expect(isMasterSource(origin('https://github.com/owner/other.git'), repo)).toBe(false);
    expect(isMasterSource(origin('https://gitlab.com/Owner/Ares.1.git'), repo)).toBe(false);
    expect(
      isMasterSource(origin('git@github.com:Owner/Ares.1.git'), { ...repo, github: null }),
    ).toBe(false);
  });

  it('matches nothing without an install directory', () => {
    expect(isMasterSource(null, { path: '/opt/dev/ares1', github: 'owner/ares1' })).toBe(false);
  });

  it('reads owner/name from GitHub URLs only', () => {
    expect(githubNameOf('git@github.com:a/b.git')).toBe('a/b');
    expect(githubNameOf('https://x-access-token@github.com/a/b/')).toBe('a/b');
    expect(githubNameOf('/home/me/b')).toBeNull();
    expect(githubNameOf('https://github.com/a')).toBeNull();
  });
});

describe('upgrade script', () => {
  it('parses, and braces every variable (bash misreads $name followed by Chinese text)', () => {
    const path = join(process.cwd(), 'scripts', 'self-upgrade.sh');
    execFileSync('bash', ['-n', path]);
    const source = readFileSync(path, 'utf8');
    expect(source.match(/\$[A-Za-z_][A-Za-z0-9_]*/g) ?? []).toEqual([]);
  });

  it("writes its log and notification in the Master's language", () => {
    const bin = tmpDir('ares1-bin-');
    const notified = join(bin, 'notified');
    // Stands in for osascript, so that no real notification shows up.
    writeFileSync(join(bin, 'osascript'), `#!/bin/sh\necho "$2" >> '${notified}'\n`);
    chmodSync(join(bin, 'osascript'), 0o755);
    // Returns what it logged; it fails at the missing install directory.
    const run = (lang: string): string => {
      try {
        execFileSync(
          'bash',
          [
            join(process.cwd(), 'scripts', 'self-upgrade.sh'),
            join(bin, 'missing'), // no install directory: the script gives up right away
            bin,
            '999999', // no such process: nothing to wait for
            'abc1234',
            join(bin, 'result.json'),
            process.execPath,
            '1',
            'Ares.1',
            lang,
          ],
          {
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
      } catch (err) {
        return String((err as { stdout?: string }).stdout);
      }
      throw new Error('the script should have failed');
    };
    expect(run('en')).toContain('Upgrading (now at abc1234)');
    expect(run('zh')).toContain('开始升级（当前 abc1234）');
    const notes = readFileSync(notified, 'utf8');
    expect(notes).toContain('Automatic upgrade failed: install directory');
    expect(notes).toContain('自动升级失败：找不到安装目录');
  });

  it('notifies through notify-send where there is no osascript', () => {
    const bin = tmpDir('ares1-bin-');
    const notified = join(bin, 'notified');
    // Stands in for notify-send, writing one argument per line.
    writeFileSync(join(bin, 'notify-send'), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${notified}'\n`);
    chmodSync(join(bin, 'notify-send'), 0o755);
    // Only the stand-in is in PATH, so osascript is not found even on macOS.
    const bash = execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();
    expect(() =>
      execFileSync(
        bash,
        [
          join(process.cwd(), 'scripts', 'self-upgrade.sh'),
          join(bin, 'missing'), // no install directory: the script gives up right away
          bin,
          '999999',
          'abc1234',
          join(bin, 'result.json'),
          process.execPath,
          '1',
          'Ares.1',
          'en',
        ],
        { env: { ...process.env, PATH: bin }, stdio: 'ignore' },
      ),
    ).toThrow();
    expect(readFileSync(notified, 'utf8').split('\n')).toEqual([
      '--app-name',
      'Ares.1',
      'Ares.1',
      `Automatic upgrade failed: install directory ${join(bin, 'missing')} not found`,
      '',
    ]);
  });

  /**
   * A stable copy one commit behind origin, and a run of a copy of the script on it (as the
   * Master runs a copy) with stand-ins in PATH: npm and curl for the build and the health check,
   * osascript for notifications, sleep so that waiting takes no time, and fake-node for the
   * Master the script starts. fake-node hands `-e` (writing the result file) to the real node.
   * Each stand-in does what `fakes` says, else succeeds silently; $FAKE_DIR is the directory they
   * and the script's copy are in, next to a copy of find-node.sh as the Master puts it. `env` adds
   * to the script's environment, where ARES1_UPGRADE_WATCH is unset unless it says otherwise.
   * `node` is the old Master's node the script is given (default: fake-node). The repository
   * has this repository's .gitignore, so that what the script leaves there is ignored as it
   * would be in a real stable copy.
   */
  function stableCopy(
    fakes: Record<string, string> = {},
    opts: { env?: Record<string, string>; lang?: string; node?: string } = {},
  ) {
    const origin = initRepo();
    copyFileSync(join(process.cwd(), '.gitignore'), join(origin, '.gitignore'));
    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', 'gitignore');
    const installDir = join(tmpDir('ares1-install-'), 'stable');
    git(origin, 'clone', '-q', origin, installDir);
    const old = git(installDir, 'rev-parse', 'HEAD');
    writeFile(join(origin, 'new.txt'), 'new\n');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', 'new');
    const target = git(origin, 'rev-parse', 'HEAD');
    git(installDir, 'fetch', '-q', 'origin'); // as the Master does before launching

    const bin = tmpDir('ares1-bin-');
    const scripts: Record<string, string> = {
      npm: 'exit 0',
      curl: 'exit 0',
      osascript: 'exit 0',
      sleep: 'exit 0',
      'fake-node': `if [ "$1" = -e ]; then exec '${process.execPath}' "$@"; fi\nexit 0`,
      ...fakes,
    };
    for (const [cmd, body] of Object.entries(scripts)) {
      writeFileSync(join(bin, cmd), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, cmd), 0o755);
    }
    const script = join(bin, 'self-upgrade.sh');
    copyFileSync(join(process.cwd(), 'scripts', 'self-upgrade.sh'), script);
    copyFileSync(join(process.cwd(), 'scripts', 'find-node.sh'), join(bin, 'find-node.sh'));
    const home = tmpDir('ares1-home-');
    const result = join(home, 'result.json');
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== 'ARES1_UPGRADE_WATCH'),
      ),
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_DIR: bin,
      ...opts.env,
    };
    let output = '';
    const run = (...extra: string[]) => {
      output = execFileSync(
        'bash',
        [
          script,
          installDir,
          home,
          '999999', // no such process: nothing to wait for
          old,
          result,
          opts.node ?? join(bin, 'fake-node'),
          '1',
          'Ares.1',
          opts.lang ?? 'en',
          ...extra,
        ],
        { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      // Parsing fails the test if the file is not valid JSON.
      return JSON.parse(readFileSync(result, 'utf8')) as Record<string, unknown>;
    };
    /** What the last run logged. */
    const log = () => output;
    return { installDir, home, bin, old, target, run, log };
  }

  /**
   * fake-node standing in for a Master: it leaves its pid in $FAKE_DIR/pid, then runs `lines`.
   */
  const fakeMaster = (...lines: string[]) =>
    [
      `if [ "$1" = -e ]; then exec '${process.execPath}' "$@"; fi`,
      'echo $$ > "$FAKE_DIR/pid"',
      ...lines,
    ].join('\n');

  /** A sleep that returns once the Master fakeMaster started has written its pid. */
  const untilMasterStarted = 'while [ ! -s "$FAKE_DIR/pid" ]; do /bin/sleep 0.01; done';

  /** A sleep that returns once the Master fakeMaster started has exited. */
  const untilMasterExited = [
    'while [ ! -s "$FAKE_DIR/pid" ]; do /bin/sleep 0.01; done',
    'while kill -0 "$(cat "$FAKE_DIR/pid")" 2>/dev/null; do /bin/sleep 0.01; done',
  ].join('\n');

  const short = (commit: string) => commit.slice(0, 7);
  const chinese = /[一-鿿]/;

  it('rolls back when the new version exits with an error after it answered', () => {
    const { installDir, home, old, target, run, log } = stableCopy({
      sleep: untilMasterExited,
      'fake-node': fakeMaster(
        `echo "TypeError: Cannot read properties of undefined (reading 'poll')"`,
        'exit 3',
      ),
    });
    writeFileSync(join(home, 'master.out'), 'output of an earlier run\n');
    const result = run(target);
    expect(result).toMatchObject({
      ok: false,
      from: old,
      to: target,
      message: `The new version ${short(target)} exited within 1 minute of starting (exit code 3); rolled back to ${short(old)}`,
    });
    // What this start printed, not what earlier runs left in master.out.
    expect(result.detail).toBe("TypeError: Cannot read properties of undefined (reading 'poll')");
    expect(git(installDir, 'rev-parse', 'HEAD')).toBe(old);
    expect(log()).toContain(`watching it for 300 seconds`);
    expect(log()).toContain(`Rolled back to ${old}`);
    expect(log()).not.toMatch(chinese);
  });

  it('counts the minutes until the new version exited, and a signal as a crash', () => {
    // sleep counts the looks; the new Master is killed by a signal during the 15th (75 seconds).
    const { installDir, bin, old, target, run } = stableCopy(
      {
        sleep: [
          'echo x >> "$FAKE_DIR/looks"',
          '[ $(wc -l < "$FAKE_DIR/looks") -ge 15 ] || exit 0',
          untilMasterExited,
        ].join('\n'),
        'fake-node': fakeMaster(
          "echo 'Error: the scout failed'",
          'while [ $(wc -l < "$FAKE_DIR/looks") -lt 15 ]; do /bin/sleep 0.01; done',
          'kill -9 $$',
        ),
      },
      { lang: 'zh' },
    );
    writeFileSync(join(bin, 'looks'), '');
    expect(run(target)).toMatchObject({
      ok: false,
      to: target,
      message: `新版本 ${short(target)} 启动后 2 分钟内退出（退出码 137），已回退到 ${short(old)}`,
      detail: 'Error: the scout failed',
    });
    expect(git(installDir, 'rev-parse', 'HEAD')).toBe(old);
  });

  it('does not roll back when the new version exits with code 0', () => {
    // Stopped on purpose (SIGTERM), or handed over to the next upgrade.
    const { installDir, target, old, run, log } = stableCopy({
      sleep: untilMasterExited,
      'fake-node': fakeMaster('exit 0'),
    });
    expect(run(target)).toEqual({ ok: true, from: old, to: target, message: '' });
    expect(git(installDir, 'rev-parse', 'HEAD')).toBe(target);
    expect(log()).toContain('exited cleanly (exit code 0, stopped on purpose); not rolling back');
    expect(log()).not.toContain('Rolled back');
  });

  it('ends once the watch is over while the new version still runs', () => {
    const { installDir, bin, target, old, run, log } = stableCopy(
      { sleep: untilMasterStarted, 'fake-node': fakeMaster('exec /bin/sleep 30') },
      { env: { ARES1_UPGRADE_WATCH: '15' } },
    );
    try {
      expect(run(target)).toEqual({ ok: true, from: old, to: target, message: '' });
      expect(git(installDir, 'rev-parse', 'HEAD')).toBe(target);
      expect(log()).toContain('watching it for 15 seconds');
      expect(log()).toContain(`Upgraded to ${target}`);
      // Still running: the script left it alone.
      const pid = Number(readFileSync(join(bin, 'pid'), 'utf8'));
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      try {
        process.kill(Number(readFileSync(join(bin, 'pid'), 'utf8')), 'SIGKILL');
      } catch {}
    }
  });

  it('reads all of itself before it starts, so a copy written over it meanwhile changes nothing', () => {
    // The Master renames each new copy over the old one; this is what writing into it would do.
    const { installDir, old, target, run, log } = stableCopy({
      sleep: [
        `printf 'echo overwritten\\nexit 9\\n' > "$FAKE_DIR/self-upgrade.sh"`,
        untilMasterExited,
      ].join('\n'),
      // Crashes once the script has been written over, so that it rolls back after that.
      'fake-node': fakeMaster(
        'until grep -q overwritten "$FAKE_DIR/self-upgrade.sh"; do /bin/sleep 0.01; done',
        'exit 1',
      ),
    });
    expect(run(target)).toMatchObject({ ok: false, to: target });
    expect(git(installDir, 'rev-parse', 'HEAD')).toBe(old);
    expect(log()).toContain(`Rolled back to ${old}`);
    expect(log()).not.toContain('overwritten');
  });

  it('puts a new copy of the script in place without changing the one a running script reads', () => {
    const dir = tmpDir('ares1-script-');
    const dest = join(dir, 'data', 'self-upgrade.sh');
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'first.sh'), 'first\n');
    writeFileSync(join(dir, 'second.sh'), 'second\n');
    copyUpgradeScript(join(dir, 'first.sh'), dest);
    const running = openSync(dest, 'r');
    try {
      copyUpgradeScript(join(dir, 'second.sh'), dest);
      expect(readFileSync(running, 'utf8')).toBe('first\n');
    } finally {
      closeSync(running);
    }
    expect(readFileSync(dest, 'utf8')).toBe('second\n');
    expect(readdirSync(join(dir, 'data'))).toEqual(['self-upgrade.sh']);
  });

  it('reports the planned target, not the old HEAD, when it cannot fast-forward', () => {
    const { installDir, old, target, run } = stableCopy();
    // An untracked file in the way of the new commit makes the fast-forward fail.
    writeFileSync(join(installDir, 'new.txt'), 'local\n');

    expect(run(target)).toEqual({
      ok: false,
      from: old,
      to: target,
      message: `Pulling or building ${target.slice(0, 7)} failed; rolled back to ${old.slice(0, 7)}`,
      // What git said about the file in the way.
      detail: expect.stringContaining('new.txt'),
    });
    expect(git(installDir, 'rev-parse', 'HEAD')).toBe(old);
    // Without a target it pulls, and reports where HEAD is, as before.
    expect(run()).toMatchObject({ ok: false, from: old, to: old });
  });

  it('puts the end of the build output in the result, as valid JSON whatever it contains', () => {
    // A build that prints a lot, ending in quotes, backslashes, a tab and Chinese, then fails.
    const npm = [
      'i=1; while [ "$i" -le 100 ]; do echo "line $i"; i=$((i + 1)); done',
      `printf '%s\\n' 'error: "quoted" C:\\path\\to {"json": true}' 'tab\there, 中文'`,
      'exit 1',
    ].join('\n');
    const { old, target, run } = stableCopy({ npm });
    const result = run(target);
    expect(result).toMatchObject({ ok: false, from: old, to: target });
    const detail = String(result.detail);
    expect(detail).toContain('error: "quoted" C:\\path\\to {"json": true}\ntab\there, 中文');
    // Only the last 60 lines.
    expect(detail.split('\n')).toHaveLength(60);
    expect(detail).not.toContain('line 42\n');
    expect(detail).toContain('line 100\n');
  });

  it("reports what the new Master printed when it does not respond, not earlier runs' output", () => {
    const { home, old, target, run } = stableCopy({
      curl: 'exit 7', // the new Master never answers /api/health
      'fake-node': [
        `if [ "$1" = -e ]; then exec '${process.execPath}' "$@"; fi`,
        `echo 'Error: Cannot find module "./missing.js"'`,
        'exit 1',
      ].join('\n'),
    });
    writeFileSync(join(home, 'master.out'), 'output of an earlier run\n');
    const result = run(target);
    expect(result).toMatchObject({
      ok: false,
      to: target,
      message: `The new version ${target.slice(0, 7)} did not respond after starting; rolled back to ${old.slice(0, 7)}`,
    });
    expect(result.detail).toContain('Error: Cannot find module "./missing.js"');
    expect(result.detail).not.toContain('earlier run');
  });

  it("builds and starts with another node when the old Master's is gone, and logs it", () => {
    // `node` in the stand-ins' directory, first in PATH: what nvm's new version would be.
    const { installDir, bin, old, target, run, log } = stableCopy(
      {
        sleep: untilMasterExited,
        node: fakeMaster('[ "$1" = --version ] && echo v26.1.0', 'exit 0'),
        npm: 'command -v node > "$FAKE_DIR/npm-node"',
      },
      { node: join(tmpDir('ares1-nvm-'), 'v24.22.1', 'bin', 'node') },
    );
    expect(run(target)).toEqual({ ok: true, from: old, to: target, message: '' });
    expect(git(installDir, 'rev-parse', 'HEAD')).toBe(target);
    expect(log()).toMatch(
      new RegExp(`node \\S+/v24\\.22\\.1/bin/node cannot be used .*; using ${bin}/node \\(`),
    );
    // npm ran with that node's directory first in PATH, and the Master was started with it.
    expect(readFileSync(join(bin, 'npm-node'), 'utf8').trim()).toBe(join(bin, 'node'));
    expect(readFileSync(join(bin, 'pid'), 'utf8').trim()).not.toBe('');
  });

  it('reports a failure for want of node as the environment’s, and starts nothing it cannot', () => {
    const { installDir, home, old, target, run, log } = stableCopy(
      {},
      { node: join(tmpDir('ares1-nvm-'), 'gone', 'node') },
    );
    // No node anywhere is new enough: as if every node were gone.
    writeFileSync(join(installDir, 'package.json'), '{"engines": {"node": ">=999"}}\n');
    expect(run(target)).toEqual({
      ok: false,
      from: old,
      to: target,
      message: `Building ${short(target)} found no usable node or npm (a problem of the environment, not of the commit; it is tried again once that is fixed); rolled back to ${short(old)}`,
      env: true,
    });
    expect(git(installDir, 'rev-parse', 'HEAD')).toBe(old);
    expect(log()).toContain('No usable node found');
    expect(log()).toContain('the Master cannot be started after the rollback');
    // Nothing was started: no Master wrote its output.
    expect(existsSync(join(home, 'master.out'))).toBe(false);
  });

  it('counts a build that cannot find a command (exit code 127) as the environment’s', () => {
    const { old, target, run } = stableCopy({
      npm: 'echo "sh: npm: command not found" >&2; exit 127',
    });
    expect(run(target)).toEqual({
      ok: false,
      from: old,
      to: target,
      message: expect.stringContaining('found no usable node or npm'),
      detail: 'sh: npm: command not found',
      env: true,
    });
  });

  it('still reports the failure, without the output, when node cannot write the result', () => {
    const { installDir, old, target, run } = stableCopy({ 'fake-node': 'exit 1' });
    writeFileSync(join(installDir, 'new.txt'), 'local\n');
    expect(run(target)).toEqual({
      ok: false,
      from: old,
      to: target,
      message: `Pulling or building ${target.slice(0, 7)} failed; rolled back to ${old.slice(0, 7)}`,
    });
  });

  /** Where the script keeps node_modules from before the upgrade. */
  const prev = 'node_modules.ares1-prev';
  const ci = 'ci --no-audit --no-fund';

  /**
   * An npm that appends its arguments to $FAKE_DIR/npm-calls, then runs `onCi` for `npm ci` and
   * `onBuild` for `npm run build`, in the directory the script runs it in (the install
   * directory); otherwise it succeeds.
   */
  const recordingNpm = (onCi: string, onBuild = ':') =>
    [
      'echo "$*" >> "$FAKE_DIR/npm-calls"',
      'if [ "$1" = ci ]; then',
      onCi,
      'elif [ "$1 $2" = "run build" ]; then',
      onBuild,
      'fi',
      'exit 0',
    ].join('\n');
  /** An npm ci that installs the new version's dependencies. */
  const installsNew = 'rm -rf node_modules; mkdir node_modules; echo new > node_modules/marker';
  /** What npm was run with, one call per item. */
  const npmCalls = (bin: string) =>
    readFileSync(join(bin, 'npm-calls'), 'utf8').trimEnd().split('\n');
  const marker = (dir: string) => readFileSync(join(dir, 'marker'), 'utf8');

  it('puts back the dependencies from before the upgrade, without npm ci, when the registry is down', () => {
    // npm ci deletes node_modules first, then cannot download anything.
    const { installDir, bin, old, target, run, log } = stableCopy({
      npm: recordingNpm('rm -rf node_modules; echo "npm error code ECONNREFUSED" >&2; exit 1'),
    });
    writeFile(join(installDir, 'node_modules', 'marker'), 'old\n');
    // Left behind by an earlier upgrade: replaced, never put back.
    writeFile(join(installDir, prev, 'stale'), 'stale\n');
    expect(run(target)).toEqual({
      ok: false,
      from: old,
      to: target,
      message: `Pulling or building ${short(target)} failed; rolled back to ${short(old)}`,
      detail: 'npm error code ECONNREFUSED',
    });
    expect(git(installDir, 'rev-parse', 'HEAD')).toBe(old);
    expect(marker(join(installDir, 'node_modules'))).toBe('old\n');
    expect(existsSync(join(installDir, 'node_modules', 'stale'))).toBe(false);
    expect(existsSync(join(installDir, prev))).toBe(false);
    // Only the upgrade ran npm ci; the rollback only rebuilt the old version's dist.
    expect(npmCalls(bin)).toEqual([ci, 'run build']);
    expect(log()).toContain('Put back the dependencies from before the upgrade (node_modules)');
    expect(log()).toContain(`Rolled back to ${old}`);
    expect(log()).not.toMatch(chinese);
  });

  it('puts back the old dependencies in place of the new ones when the new version crashes', () => {
    const { installDir, bin, old, target, run } = stableCopy(
      {
        npm: recordingNpm(installsNew),
        sleep: untilMasterExited,
        'fake-node': fakeMaster('exit 3'),
      },
      { lang: 'zh' },
    );
    writeFile(join(installDir, 'node_modules', 'marker'), 'old\n');
    expect(run(target)).toMatchObject({ ok: false, to: target });
    expect(git(installDir, 'rev-parse', 'HEAD')).toBe(old);
    expect(marker(join(installDir, 'node_modules'))).toBe('old\n');
    expect(existsSync(join(installDir, prev))).toBe(false);
    expect(npmCalls(bin)).toEqual([ci, 'run build', 'run build']);
  });

  it('still starts the old version when rebuilding it after the rollback fails', () => {
    const { installDir, home, bin, old, target, run, log } = stableCopy({
      npm: recordingNpm('rm -rf node_modules; exit 1', 'exit 2'),
    });
    writeFile(join(installDir, 'node_modules', 'marker'), 'old\n');
    expect(run(target)).toMatchObject({ ok: false, to: target });
    expect(marker(join(installDir, 'node_modules'))).toBe('old\n');
    expect(npmCalls(bin)).toEqual([ci, 'run build']);
    // Started all the same: it wrote to master.out and answered.
    expect(existsSync(join(home, 'master.out'))).toBe(true);
    expect(log()).toContain(`Rolled back to ${old}`);
  });

  it('deletes the backup once the watch is over while the new version still runs', () => {
    const { installDir, bin, target, old, run } = stableCopy(
      {
        npm: recordingNpm(installsNew),
        sleep: untilMasterStarted,
        'fake-node': fakeMaster('exec /bin/sleep 30'),
      },
      { env: { ARES1_UPGRADE_WATCH: '15' } },
    );
    writeFile(join(installDir, 'node_modules', 'marker'), 'old\n');
    try {
      expect(run(target)).toEqual({ ok: true, from: old, to: target, message: '' });
      expect(marker(join(installDir, 'node_modules'))).toBe('new\n');
      expect(existsSync(join(installDir, prev))).toBe(false);
      expect(git(installDir, 'status', '--porcelain')).toBe('');
    } finally {
      try {
        process.kill(Number(readFileSync(join(bin, 'pid'), 'utf8')), 'SIGKILL');
      } catch {}
    }
  });

  it('keeps the backup, ignored by git, when the new version exits with code 0', () => {
    // It may have handed over to the next upgrade, whose script may have made a backup by now.
    const { installDir, target, run } = stableCopy({
      npm: recordingNpm(installsNew),
      sleep: untilMasterExited,
      'fake-node': fakeMaster('exit 0'),
    });
    writeFile(join(installDir, 'node_modules', 'marker'), 'old\n');
    expect(run(target)).toMatchObject({ ok: true, to: target });
    expect(marker(join(installDir, prev))).toBe('old\n');
    expect(marker(join(installDir, 'node_modules'))).toBe('new\n');
    expect(git(installDir, 'status', '--porcelain')).toBe('');
  });

  it('installs with npm ci on rollback when there was no node_modules to keep', () => {
    // Only the new commit, which adds new.txt, fails to install.
    const { installDir, bin, old, target, run, log } = stableCopy({
      npm: recordingNpm('if [ -e new.txt ]; then exit 1; fi'),
    });
    expect(run(target)).toMatchObject({ ok: false, to: target });
    expect(git(installDir, 'rev-parse', 'HEAD')).toBe(old);
    expect(npmCalls(bin)).toEqual([ci, ci, 'run build']);
    expect(existsSync(join(installDir, prev))).toBe(false);
    expect(log()).not.toContain('Put back');
  });
});
