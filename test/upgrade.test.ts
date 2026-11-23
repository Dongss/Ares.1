import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UpgradePlan } from '../src/upgrade/upgrader.js';
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

  it('reports the planned target, not the old HEAD, when it cannot fast-forward', () => {
    const origin = initRepo();
    const installDir = join(tmpDir('ares1-install-'), 'stable');
    git(origin, 'clone', '-q', origin, installDir);
    const old = git(installDir, 'rev-parse', 'HEAD');
    writeFile(join(origin, 'new.txt'), 'new\n');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', 'new');
    const target = git(origin, 'rev-parse', 'HEAD');
    git(installDir, 'fetch', '-q', 'origin'); // as the Master does before launching
    // An untracked file in the way of the new commit makes the fast-forward fail.
    writeFileSync(join(installDir, 'new.txt'), 'local\n');

    const bin = tmpDir('ares1-bin-');
    // npm and curl stand in for the build and the health check, osascript for notifications,
    // fake-node for the Master the script starts.
    for (const cmd of ['npm', 'curl', 'osascript', 'fake-node']) {
      writeFileSync(join(bin, cmd), '#!/bin/sh\nexit 0\n');
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
      return JSON.parse(readFileSync(result, 'utf8')) as Record<string, unknown>;
    };

    expect(run(target)).toEqual({
      ok: false,
      from: old,
      to: target,
      message: `Pulling or building ${target.slice(0, 7)} failed; rolled back to ${old.slice(0, 7)}`,
    });
    expect(git(installDir, 'rev-parse', 'HEAD')).toBe(old);
    // Without a target it pulls, and reports where HEAD is, as before.
    expect(run()).toMatchObject({ ok: false, from: old, to: old });
  });
});
