import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_GH_TOKEN,
  agentEnv,
  isOurProcess,
  killProcessGroup,
  type ProcessOptions,
  prepareAgentEnv,
  runProcess,
} from '../src/adapters/process.js';
import { tmpDir, writeFile } from './helpers.js';

// These tests start real processes through /bin/sh and rely on POSIX process groups
// (macOS and Linux).

const dirs: string[] = [];
/** Process groups started by a test; whatever is left of them is killed after each test. */
const groups: number[] = [];
/** Single processes started by a test, killed after each test. */
const pids: number[] = [];

afterEach(() => {
  for (const pgid of groups.splice(0)) signal(-pgid, 'SIGKILL');
  for (const pid of pids.splice(0)) signal(pid, 'SIGKILL');
});

// Temp dirs go once every test is done, so that no log stream is still opening its file.
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // already gone
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tmp(): string {
  const dir = tmpDir('ares1-process-');
  dirs.push(dir);
  return dir;
}

/** Polls `check` every 20ms; whether it became true within `timeoutMs`. */
async function until(check: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function gone(pid: number): Promise<boolean> {
  return until(() => !alive(pid));
}

/** The log streams flush after `done` resolves, so wait until the file holds what is expected. */
async function readLog(path: string, expected: string): Promise<string> {
  const read = () => (existsSync(path) ? readFileSync(path, 'utf8') : '');
  await until(() => read() === expected);
  return read();
}

/** Waits for a script to write a pid (`echo $! > "$PIDFILE"`) and returns it. */
async function readPid(path: string): Promise<number> {
  let text = '';
  await until(() => {
    text = existsSync(path) ? readFileSync(path, 'utf8') : '';
    return /^\d+\n$/.test(text);
  });
  expect(text).toMatch(/^\d+\n$/);
  return Number.parseInt(text, 10);
}

function pidOf(child: ChildProcess | { pid?: number }): number {
  if (child.pid === undefined) throw new Error('the process did not start');
  return child.pid;
}

/** Runs a /bin/sh script through runProcess; `$PIDFILE` names a file in its temp dir. */
function sh(script: string, extra: Partial<ProcessOptions> = {}) {
  const dir = tmp();
  const logPath = join(dir, 'logs', 'agent.log');
  const pidFile = join(dir, 'pid');
  const lines: string[] = [];
  const proc = runProcess({
    bin: '/bin/sh',
    args: ['-c', script],
    cwd: dir,
    env: { ...process.env, PIDFILE: pidFile },
    timeoutMs: 10_000,
    killGraceMs: 2000,
    logPath,
    onStdoutLine: (line) => lines.push(line),
    ...extra,
  });
  groups.push(pidOf(proc));
  return { proc, dir, logPath, pidFile, lines };
}

/** Starts a /bin/sh script in its own process group, outside runProcess. */
function detachedSh(script: string) {
  const dir = tmp();
  const pidFile = join(dir, 'pid');
  const child = spawn('/bin/sh', ['-c', script], {
    cwd: dir,
    env: { ...process.env, PIDFILE: pidFile },
    detached: true,
    stdio: 'ignore',
  });
  const pid = pidOf(child);
  groups.push(pid);
  return { pid, pidFile };
}

describe('runProcess', () => {
  it('reports a normal exit and keeps every stdout line, the last one without a newline too', async () => {
    const stderr: string[] = [];
    const { proc, logPath, lines } = sh(
      "printf 'first\\nsecond\\n'; printf 'warn' >&2; printf 'last'",
      {
        onStderr: (text) => stderr.push(text),
      },
    );
    const outcome = await proc.done;

    expect(outcome).toEqual({ exitCode: 0, signal: null, ended: 'exit', stderrTail: 'warn' });
    expect(lines).toEqual(['first', 'second', 'last']);
    expect(stderr.join('')).toBe('warn');
    // Each line is written with a newline, the last one included.
    expect(await readLog(logPath, 'first\nsecond\nlast\n')).toBe('first\nsecond\nlast\n');
    expect(await readLog(`${logPath}.stderr`, 'warn')).toBe('warn');
  });

  it('does not lose the last line of a large output', async () => {
    const count = 20_000;
    const dir = tmp();
    const logPath = join(dir, 'agent.log');
    const lines: string[] = [];
    const proc = runProcess({
      bin: process.execPath,
      args: [
        '-e',
        `process.stdout.write(Array.from({ length: ${count} }, (_, i) => i).join('\\n'))`,
      ],
      cwd: dir,
      timeoutMs: 10_000,
      logPath,
      onStdoutLine: (line) => lines.push(line),
    });
    groups.push(pidOf(proc));
    const outcome = await proc.done;

    expect(outcome.ended).toBe('exit');
    expect(outcome.exitCode).toBe(0);
    expect(lines).toHaveLength(count);
    expect(lines.at(-1)).toBe(String(count - 1));
  });

  it('writes stdin, closes it and reports the exit code', async () => {
    const { proc, lines } = sh('cat; echo end; exit 3', { stdin: 'x\ny\n' });
    expect(proc.command).toBe("/bin/sh -c 'cat; echo end; exit 3'");
    const outcome = await proc.done;

    expect(outcome).toMatchObject({ exitCode: 3, signal: null, ended: 'exit' });
    expect(lines).toEqual(['x', 'y', 'end']);
  });

  it('stops the process with SIGTERM once it runs past timeoutMs', async () => {
    const timeoutMs = 200;
    const killGraceMs = 2000;
    const started = Date.now();
    const { proc } = sh('sleep 30', { timeoutMs, killGraceMs });
    const outcome = await proc.done;
    const elapsed = Date.now() - started;

    expect(outcome).toMatchObject({ exitCode: null, signal: 'SIGTERM', ended: 'timeout' });
    // Timers may fire a few milliseconds early against Date.now().
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 50);
    expect(elapsed).toBeLessThan(timeoutMs + killGraceMs);
    expect(alive(pidOf(proc))).toBe(false);
  });

  it('stop() ends the whole process group, grandchildren included', async () => {
    const { proc, pidFile } = sh('sleep 30 & echo $! > "$PIDFILE"; sleep 30');
    const grandchild = await readPid(pidFile);
    expect(alive(grandchild)).toBe(true);

    await proc.stop();
    const outcome = await proc.done;

    expect(outcome).toMatchObject({ exitCode: null, signal: 'SIGTERM', ended: 'stopped' });
    expect(alive(pidOf(proc))).toBe(false);
    expect(await gone(grandchild)).toBe(true);
    // Stopping again once it has ended is a no-op.
    await proc.stop();
  });

  it('sends SIGKILL after killGraceMs to a process group that ignores SIGTERM', async () => {
    const killGraceMs = 300;
    // A child inherits the ignored SIGTERM.
    const { proc, pidFile } = sh(`trap '' TERM; sleep 30 & echo $! > "$PIDFILE"; sleep 30`, {
      killGraceMs,
    });
    const grandchild = await readPid(pidFile);

    const started = Date.now();
    await proc.stop();
    const elapsed = Date.now() - started;
    const outcome = await proc.done;

    expect(outcome).toMatchObject({ exitCode: null, signal: 'SIGKILL', ended: 'stopped' });
    expect(elapsed).toBeGreaterThanOrEqual(killGraceMs - 50);
    expect(elapsed).toBeLessThan(killGraceMs + 2000);
    expect(await gone(grandchild)).toBe(true);
  });

  it('reports spawn_error when the bin does not exist', async () => {
    const dir = tmp();
    const proc = runProcess({
      bin: join(dir, 'no-such-cli'),
      args: [],
      cwd: dir,
      timeoutMs: 10_000,
      logPath: join(dir, 'agent.log'),
    });
    expect(proc.pid).toBeUndefined();
    const outcome = await proc.done;

    expect(outcome).toMatchObject({ exitCode: null, signal: null, ended: 'spawn_error' });
    expect(outcome.spawnError).toContain('ENOENT');
    // Nothing to stop.
    await proc.stop();
  });

  it('stop() SIGKILLs group members that ignore SIGTERM after the leader has exited', async () => {
    const killGraceMs = 300;
    // The member does not hold the stdout pipe, so the leader's close comes as soon as it exits.
    const { proc, pidFile } = sh(
      `(trap '' TERM; exec sleep 30) >/dev/null 2>&1 & echo $! > "$PIDFILE"; sleep 30`,
      { killGraceMs },
    );
    const member = await readPid(pidFile);
    expect(alive(member)).toBe(true);

    const started = Date.now();
    await proc.stop();
    const elapsed = Date.now() - started;
    const outcome = await proc.done;

    // The leader ends on SIGTERM and `done` does not wait for the member.
    expect(outcome).toMatchObject({ exitCode: null, signal: 'SIGTERM', ended: 'stopped' });
    expect(elapsed).toBeLessThan(killGraceMs + 2000);
    expect(alive(pidOf(proc))).toBe(false);
    expect(await gone(member)).toBe(true);
  });
});

describe('isOurProcess', () => {
  it('matches a live process by its command line, and no longer once it has exited', async () => {
    const marker = `ares1-process-test-${randomUUID()}`;
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', marker], {
      stdio: 'ignore',
    });
    const pid = pidOf(child);
    pids.push(pid);
    const exited = new Promise((r) => child.once('exit', r));

    expect(await isOurProcess(pid, marker)).toBe(true);
    expect(await isOurProcess(pid, `ares1-process-test-${randomUUID()}`)).toBe(false);

    child.kill('SIGKILL');
    await exited;
    expect(await isOurProcess(pid, marker)).toBe(false);
  });
});

describe('killProcessGroup', () => {
  it('ends the whole process group', async () => {
    const { pid, pidFile } = detachedSh('sleep 30 & echo $! > "$PIDFILE"; sleep 30');
    const grandchild = await readPid(pidFile);
    expect(alive(grandchild)).toBe(true);

    await killProcessGroup(pid, 300);

    expect(await gone(pid)).toBe(true);
    expect(await gone(grandchild)).toBe(true);
  });

  it('sends SIGKILL after the grace period when the group ignores SIGTERM', async () => {
    const graceMs = 300;
    const { pid, pidFile } = detachedSh(`trap '' TERM; sleep 30 & echo $! > "$PIDFILE"; sleep 30`);
    const grandchild = await readPid(pidFile);

    const started = Date.now();
    await killProcessGroup(pid, graceMs);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(graceMs - 50);
    expect(elapsed).toBeLessThan(graceMs + 2000);
    expect(await gone(pid)).toBe(true);
    expect(await gone(grandchild)).toBe(true);
  });

  it('returns at once when the group no longer exists', async () => {
    const { pid } = detachedSh('exit 0');
    expect(await gone(pid)).toBe(true);

    const started = Date.now();
    await killProcessGroup(pid, 5000);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('SIGKILLs group members that ignore SIGTERM after the leader has exited', async () => {
    const graceMs = 300;
    const { pid, pidFile } = detachedSh(
      `(trap '' TERM; exec sleep 30) & echo $! > "$PIDFILE"; sleep 30`,
    );
    const member = await readPid(pidFile);
    expect(alive(member)).toBe(true);

    await killProcessGroup(pid, graceMs);

    expect(await gone(pid)).toBe(true);
    expect(await gone(member)).toBe(true);
  });
});

describe('agentEnv', () => {
  it('drops GitHub credentials, gives gh an empty config dir and git no way to get a password', () => {
    const base = {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/me',
      ANTHROPIC_API_KEY: 'sk-ant',
      CURSOR_API_KEY: 'cursor',
      GH_TOKEN: 'gho_master',
      GITHUB_TOKEN: 'ghp_master',
      GH_ENTERPRISE_TOKEN: 'ghe_master',
      GITHUB_ENTERPRISE_TOKEN: 'ghe_master2',
      GIT_ASKPASS: '/Applications/Editor/askpass.sh',
      SSH_ASKPASS: '/usr/bin/ssh-askpass',
    };
    expect(agentEnv(base, '/data/agent-gh-config')).toEqual({
      // Everything else is passed on as it is, the agent CLIs' own logins included.
      PATH: '/usr/bin:/bin',
      HOME: '/Users/me',
      ANTHROPIC_API_KEY: 'sk-ant',
      CURSOR_API_KEY: 'cursor',
      GH_TOKEN: AGENT_GH_TOKEN,
      GH_CONFIG_DIR: '/data/agent-gh-config',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
    });
    // The Master's own environment is left alone.
    expect(base.GH_TOKEN).toBe('gho_master');
  });

  it('adds the empty credential helper after the git config the environment already has', () => {
    const env = agentEnv(
      {
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: '/hooks',
        GIT_CONFIG_KEY_1: 'credential.helper',
        GIT_CONFIG_VALUE_1: 'osxkeychain',
      },
      '/gh',
    );
    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/hooks',
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: 'osxkeychain',
      GIT_CONFIG_KEY_2: 'credential.helper',
      GIT_CONFIG_VALUE_2: '',
    });
  });
});

describe('prepareAgentEnv', () => {
  it("is agentEnv of the Master's environment, with the gh config dir created empty", () => {
    const dir = join(tmp(), 'data', 'agent-gh-config');
    const env = prepareAgentEnv(dir);
    expect(env).toEqual(agentEnv(process.env, dir));
    expect(readdirSync(dir)).toEqual([]);
  });

  it('empties the gh config dir of whatever an earlier agent left there', () => {
    const dir = join(tmp(), 'agent-gh-config');
    prepareAgentEnv(dir);
    writeFile(join(dir, 'hosts.yml'), 'github.com:\n  oauth_token: gho_left\n');
    writeFile(join(dir, 'extensions', 'x', 'bin'), 'x');
    prepareAgentEnv(dir);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('removes a symlink or file put in place of the dir, never what a symlink points to', () => {
    const root = tmp();
    const real = join(root, 'real-gh-config');
    writeFile(join(real, 'hosts.yml'), 'mine');
    const dir = join(root, 'agent-gh-config');
    symlinkSync(real, dir);
    prepareAgentEnv(dir);
    expect(lstatSync(dir).isDirectory()).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
    expect(readFileSync(join(real, 'hosts.yml'), 'utf8')).toBe('mine');

    rmSync(dir, { recursive: true });
    writeFile(dir, 'a file');
    prepareAgentEnv(dir);
    expect(lstatSync(dir).isDirectory()).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });
});
