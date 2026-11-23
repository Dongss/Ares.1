import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { githubNameOf, isMasterSource } from '../src/upgrade/source.js';
import { lastUpgradeFailure, type UpgradePlan } from '../src/upgrade/upgrader.js';
import { git, type Harness, harness, initRepo, tmpDir, waitFor, writeFile } from './helpers.js';

let h: Harness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** A Master "installed" in a clone of `origin`, with auto upgrade on. */
async function installed(opts: { auto?: boolean } = {}) {
  const origin = initRepo();
  const installDir = join(tmpDir('ares1-install-'), 'stable');
  git(origin, 'clone', '-q', origin, installDir);
  const launches: UpgradePlan[] = [];
  let exits = 0;
  h = await harness({
    config: `upgrade:\n  auto: ${opts.auto ?? true}\n`,
    master: {
      installDir,
      launchUpgrade: (plan) => launches.push(plan),
      exit: () => {
        exits++;
      },
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
    });
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

  /**
   * A stable copy one commit behind origin, and a run of the script on it with stand-ins in
   * PATH: npm and curl for the build and the health check, osascript for notifications, sleep so
   * that waiting takes no time, and fake-node for the Master the script starts. fake-node hands
   * `-e` (writing the result file) to the real node. Each stand-in does what `fakes` says, else
   * succeeds silently.
   */
  function stableCopy(fakes: Record<string, string> = {}) {
    const origin = initRepo();
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
    const home = tmpDir('ares1-home-');
    const result = join(home, 'result.json');
    const run = (...extra: string[]) => {
      execFileSync(
        'bash',
        [
          join(process.cwd(), 'scripts', 'self-upgrade.sh'),
          installDir,
          home,
          '999999', // no such process: nothing to wait for
          old,
          result,
          join(bin, 'fake-node'),
          '1',
          'Ares.1',
          'en',
          ...extra,
        ],
        {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      // Parsing fails the test if the file is not valid JSON.
      return JSON.parse(readFileSync(result, 'utf8')) as Record<string, unknown>;
    };
    return { installDir, home, old, target, run };
  }

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
});
