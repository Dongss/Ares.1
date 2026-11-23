import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { HealthView } from '../src/api/types.js';
import { tmpDir } from './helpers.js';

// Starts the Master the way the upgrade script does: a separate process through the CLI. The other
// tests open it in-process, so without this one a Master that cannot start, or that exits with a
// non-zero code on SIGTERM (which the upgrade script takes for a crash and rolls back), would only
// show up after it was merged and upgraded to.

const root = fileURLToPath(new URL('..', import.meta.url));
const builtCli = join(root, 'dist', 'cli.js');
const builtWebIndex = join(root, 'dist', 'web', 'index.html');

/** Startup up to the first 200 from /api/health. */
const STARTUP_MS = 20_000;
const STOP_MS = 10_000;

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface MasterProcess {
  proc: ChildProcess;
  exited: Promise<Exit>;
  /** Everything it printed so far, stdout and stderr. */
  output: () => string;
}

/**
 * The build when there is one, since that is what the upgrade script starts. The registered check
 * commands build before they test, so a stale dist/ only happens locally. Without a build the
 * source runs through tsx's loader, in the same process so that signals reach the Master itself.
 */
function cliArgs(): { label: string; args: string[] } {
  if (existsSync(builtCli)) return { label: 'dist/cli.js', args: [builtCli] };
  return { label: 'src/cli.ts (tsx)', args: ['--import', 'tsx', join(root, 'src', 'cli.ts')] };
}

function startMaster(args: string[], home: string): MasterProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' };
  delete env.ARES1_HOME;
  delete env.LC_MESSAGES;
  // An empty home has no `github` section and automatic upgrades off: nothing reaches the network.
  const proc = spawn(process.execPath, [...args, '--home', home, '--port', '0'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  proc.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  const exited = new Promise<Exit>((resolve) => {
    proc.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { proc, exited, output: () => output };
}

function isRunning(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The dashboard URL from the startup line, e.g. `http://127.0.0.1:53817`. */
async function waitForUrl(m: MasterProcess, deadline: number): Promise<string> {
  while (Date.now() < deadline) {
    // A digit must follow the port, or a chunk ending inside the port would cut it short.
    const match = /http:\/\/127\.0\.0\.1:\d+(?=\D)/.exec(m.output());
    if (match) return match[0];
    if (!isRunning(m.proc)) {
      const { code, signal } = await m.exited;
      throw new Error(`exited before listening (code ${code}, signal ${signal}):\n${m.output()}`);
    }
    await sleep(50);
  }
  throw new Error(`no dashboard URL printed within ${STARTUP_MS} ms:\n${m.output()}`);
}

async function waitForHealth(m: MasterProcess, url: string, deadline: number): Promise<unknown> {
  let last = '';
  while (Date.now() < deadline) {
    if (!isRunning(m.proc)) throw new Error(`exited while starting:\n${m.output()}`);
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.status === 200) return await res.json();
      last = `status ${res.status}`;
    } catch (err) {
      last = String(err);
    }
    await sleep(200);
  }
  throw new Error(`/api/health gave no 200 within ${STARTUP_MS} ms (${last}):\n${m.output()}`);
}

async function waitForExit(m: MasterProcess): Promise<Exit> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`still running ${STOP_MS} ms after SIGTERM:\n${m.output()}`)),
      STOP_MS,
    );
  });
  try {
    return await Promise.race([m.exited, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

let started: MasterProcess | undefined;
let home: string | undefined;

afterEach(async () => {
  // Also after a failed assertion: no Master is left running.
  if (started && isRunning(started.proc)) {
    started.proc.kill('SIGKILL');
    await started.exited;
  }
  started = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

describe('CLI smoke test', () => {
  const { label, args } = cliArgs();

  it(`${label} starts on an empty home, serves the API and the dashboard, exits 0 on SIGTERM`, async () => {
    home = tmpDir('ares1-smoke-');
    const m = startMaster(args, home);
    started = m;

    const deadline = Date.now() + STARTUP_MS;
    const url = await waitForUrl(m, deadline);
    const health = (await waitForHealth(m, url, deadline)) as HealthView;
    expect(health, m.output()).toMatchObject({
      ok: true,
      activeRun: null,
      working: expect.any(Boolean),
      systemNotify: false,
      webhookNotify: false,
    });
    expect(health.version === null || typeof health.version === 'string', m.output()).toBe(true);

    // First start writes the default configuration.
    for (const file of ['config.yaml', 'agents.yaml', join('workflows', 'self-dev.yaml')]) {
      expect(existsSync(join(home, file)), `${file} missing:\n${m.output()}`).toBe(true);
    }

    const page = await fetch(`${url}/`);
    expect(page.headers.get('content-type'), m.output()).toMatch(/^text\/html/);
    const html = await page.text();
    if (existsSync(builtWebIndex)) {
      expect(page.status, m.output()).toBe(200);
      expect(html).toBe(readFileSync(builtWebIndex, 'utf8'));
    }

    m.proc.kill('SIGTERM');
    const exit = await waitForExit(m);
    expect(exit, m.output()).toEqual({ code: 0, signal: null });
  }, 60_000);
});
