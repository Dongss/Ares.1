import { readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { setLang } from '../src/i18n.js';
import {
  formatServiceFailure,
  freePort,
  type ServiceFailure,
  type ServiceOptions,
  type ServiceResult,
  startService,
} from '../src/verify/serve.js';
import { tmpDir, writeFile } from './helpers.js';

// These tests start real processes through /bin/sh and rely on POSIX process groups
// (macOS and Linux).

const dirs: string[] = [];
/** Services started by a test; whatever is left of them is stopped after each test. */
const services: ServiceResult[] = [];
/** Process groups a test learned of; whatever is left of them is killed after each test. */
const groups: number[] = [];

afterEach(async () => {
  setLang('zh');
  for (const service of services.splice(0)) if (service.ok) await service.stop();
  for (const pgid of groups.splice(0)) signal(-pgid, 'SIGKILL');
});

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function signal(pid: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

/** Whether the process group `pgid` has no process left: kill(-pgid, 0) fails with ESRCH. */
function groupGone(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function alive(pid: number): boolean {
  return signal(pid, 0);
}

/**
 * A worktree with `server.mjs`: an HTTP server on 127.0.0.1:$PORT answering every request with
 * $STATUS (default 200) and a body naming its port and the service variables it got. It prints
 * a line when it starts and when it listens, waits $DELAY_MS before listening, and ignores
 * SIGTERM when $IGNORE_TERM is set.
 */
function worktree(): string {
  const dir = tmpDir('ares1-serve-');
  dirs.push(dir);
  writeFile(
    join(dir, 'server.mjs'),
    `import { createServer } from 'node:http';
const status = Number(process.env.STATUS ?? 200);
if (process.env.IGNORE_TERM) process.on('SIGTERM', () => console.log('ignoring SIGTERM'));
console.log('server starting');
setTimeout(() => {
  createServer((req, res) => {
    res.statusCode = status;
    res.end(\`port=\${process.env.PORT} url=\${process.env.ARES1_SERVICE_URL} ci=\${process.env.CI} path=\${req.url}\`);
  }).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('server listening'));
}, Number(process.env.DELAY_MS ?? 0));
`,
  );
  return dir;
}

const NODE = JSON.stringify(process.execPath);

async function start(dir: string, opts: Partial<ServiceOptions> = {}): Promise<ServiceResult> {
  const result = await startService({
    command: `${NODE} server.mjs`,
    cwd: dir,
    env: process.env,
    logPath: join(dir, 'logs', 'serve.log'),
    readyPath: '/',
    readyTimeoutMs: 10_000,
    pollIntervalMs: 50,
    killGraceMs: 300,
    ...opts,
  });
  services.push(result);
  return result;
}

function ready(result: ServiceResult): Extract<ServiceResult, { ok: true }> {
  if (!result.ok) throw new Error(`service not ready: ${JSON.stringify(result)}`);
  return result;
}

function failed(result: ServiceResult): ServiceFailure {
  if (result.ok) throw new Error(`service unexpectedly ready at ${result.url}`);
  return result;
}

/** The pid a command wrote to `file`, waiting for it to be written. */
async function readPid(file: string): Promise<number> {
  for (let i = 0; i < 100; i++) {
    try {
      const pid = Number(readFileSync(file, 'utf8').trim());
      if (pid > 0) return pid;
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no pid in ${file}`);
}

describe('freePort', () => {
  it('returns a port on 127.0.0.1 that can be listened on', async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    await new Promise((r) => server.close(r));
  });
});

describe('startService', () => {
  it('starts the service on a free port, waits until it answers, and logs its output', async () => {
    const dir = worktree();
    const service = ready(await start(dir, { readyPath: '/health', env: { ...process.env } }));

    expect(service.url).toBe(`http://127.0.0.1:${service.port}`);
    expect(service.env).toEqual({
      PORT: String(service.port),
      ARES1_SERVICE_URL: service.url,
    });
    const body = await (await fetch(`${service.url}/x`)).text();
    expect(body).toBe(`port=${service.port} url=${service.url} ci=1 path=/x`);

    await service.stop();
    expect(groupGone(service.pid)).toBe(true);
    // Its output up to the stop, without the log's own lines.
    expect(service.outputTail()).toBe('server starting\nserver listening\n');
    const log = readFileSync(join(dir, 'logs', 'serve.log'), 'utf8');
    expect(log.startsWith(`$ ${NODE} server.mjs\n`)).toBe(true);
    expect(log).toContain('server starting');
    expect(log).toContain('server listening');
    expect(log).toMatch(/\[stopped, (signal SIGTERM|exit \d+)\]\n$/);
    await expect(fetch(service.url)).rejects.toThrow();
  });

  it('waits for a service that takes a while to listen', async () => {
    const dir = worktree();
    const started = Date.now();
    const service = ready(await start(dir, { command: `DELAY_MS=500 ${NODE} server.mjs` }));
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect((await fetch(service.url)).status).toBe(200);
  });

  it('counts any answer below 500 as ready, a 404 too', async () => {
    const dir = worktree();
    const service = ready(await start(dir, { command: `STATUS=404 ${NODE} server.mjs` }));
    expect((await fetch(service.url)).status).toBe(404);
  });

  it('does not count a 500 as ready: it waits until the timeout and stops the service', async () => {
    const dir = worktree();
    const pidFile = join(dir, 'pid');
    const started = Date.now();
    const result = failed(
      await start(dir, {
        command: `echo $$ > pid; STATUS=500 exec ${NODE} server.mjs`,
        readyTimeoutMs: 1000,
      }),
    );
    const pid = await readPid(pidFile);
    groups.push(pid);

    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(result.reason).toBe('timeout');
    expect(result.exitCode).toBeNull();
    expect(result.readyTimeoutMs).toBe(1000);
    expect(result.outputTail).toContain('server listening');
    expect(groupGone(pid)).toBe(true);
  });

  it('times out on a service that never listens', async () => {
    const dir = worktree();
    const result = failed(
      await start(dir, { command: 'echo $$ > pid; exec sleep 30', readyTimeoutMs: 500 }),
    );
    const pid = await readPid(join(dir, 'pid'));
    groups.push(pid);
    expect(result.reason).toBe('timeout');
    expect(groupGone(pid)).toBe(true);
    expect(readFileSync(join(dir, 'logs', 'serve.log'), 'utf8')).toContain(
      '[not ready within 500ms, signal SIGTERM]',
    );
  });

  it('fails with the exit code and output of a command that exits before it is ready', async () => {
    const dir = worktree();
    const started = Date.now();
    const result = failed(await start(dir, { command: 'echo boom; echo oops >&2; exit 3' }));

    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.reason).toBe('exited');
    expect(result.exitCode).toBe(3);
    expect(result.outputTail).toContain('boom');
    expect(result.outputTail).toContain('oops');
    expect(readFileSync(join(dir, 'logs', 'serve.log'), 'utf8')).toContain(
      '[exited before ready, exit 3]',
    );
  });

  it('fails with exit code 127 when the start command is not found', async () => {
    const dir = worktree();
    const result = failed(await start(dir, { command: 'ares1-no-such-program --serve' }));
    expect(result.reason).toBe('exited');
    expect(result.exitCode).toBe(127);
  });

  it('fails when the start command cannot be started at all', async () => {
    const dir = worktree();
    const result = failed(await start(dir, { cwd: join(dir, 'missing') }));
    expect(result.reason).toBe('exited');
    expect(result.exitCode).toBeNull();
    expect(result.outputTail).not.toBe('');
  });

  it('fails when spawn refuses the command before starting anything', async () => {
    const dir = worktree();
    const result = failed(await start(dir, { command: 'echo \0' }));
    expect(result.reason).toBe('exited');
    expect(result.exitCode).toBeNull();
    expect(result.outputTail).not.toBe('');
    expect(readFileSync(join(dir, 'logs', 'serve.log'), 'utf8')).toContain('[not started]');
  });

  it('stops the whole process group, processes the shell started included', async () => {
    const dir = worktree();
    const service = ready(
      await start(dir, { command: `${NODE} server.mjs & echo $! > child.pid; sleep 30 & wait` }),
    );
    const child = await readPid(join(dir, 'child.pid'));
    expect(child).not.toBe(service.pid);
    expect(alive(service.pid)).toBe(true);
    expect(alive(child)).toBe(true);

    await service.stop();

    expect(groupGone(service.pid)).toBe(true);
    expect(alive(child)).toBe(false);
    // Stopping again waits for the same stop and changes nothing.
    await service.stop();
    expect(groupGone(service.pid)).toBe(true);
  });

  it('SIGKILLs a service that ignores SIGTERM after the grace period', async () => {
    const dir = worktree();
    const service = ready(
      await start(dir, { command: `IGNORE_TERM=1 exec ${NODE} server.mjs`, killGraceMs: 400 }),
    );

    const started = Date.now();
    await service.stop();

    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    expect(groupGone(service.pid)).toBe(true);
    const log = readFileSync(join(dir, 'logs', 'serve.log'), 'utf8');
    expect(log).toContain('ignoring SIGTERM');
    expect(log).toContain('[stopped, signal SIGKILL]');
  });

  it('stops the service and ends the wait when the signal aborts', async () => {
    const dir = worktree();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    const result = failed(
      await start(dir, {
        command: 'echo $$ > pid; sleep 30 & wait',
        signal: controller.signal,
      }),
    );
    const pid = await readPid(join(dir, 'pid'));
    groups.push(pid);

    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.reason).toBe('aborted');
    expect(result.exitCode).toBeNull();
    expect(groupGone(pid)).toBe(true);
  });

  it('does not start the service when the signal has already aborted', async () => {
    const dir = worktree();
    const result = failed(
      await start(dir, { command: 'echo started > started', signal: AbortSignal.abort() }),
    );
    expect(result.reason).toBe('aborted');
    await new Promise((r) => setTimeout(r, 100));
    expect(() => readFileSync(join(dir, 'started'))).toThrow();
  });

  it('gives services running at the same time different ports', async () => {
    const dir = worktree();
    const [a, b] = await Promise.all([
      start(dir, { logPath: join(dir, 'logs', 'a.log') }),
      start(dir, { logPath: join(dir, 'logs', 'b.log') }),
    ]);
    const first = ready(a);
    const second = ready(b);
    expect(first.port).not.toBe(second.port);
    expect(await (await fetch(first.url)).text()).toContain(`port=${first.port} `);
    expect(await (await fetch(second.url)).text()).toContain(`port=${second.port} `);
  });
});

describe('formatServiceFailure', () => {
  const failure = (over: Partial<ServiceFailure>): ServiceFailure => ({
    ok: false,
    reason: 'exited',
    exitCode: 1,
    port: 4000,
    outputTail: 'Error: listen EADDRINUSE',
    readyTimeoutMs: 120_000,
    ...over,
  });

  it('says why, the start command and the end of the output', () => {
    expect(formatServiceFailure(failure({ exitCode: 3 }), 'npm start')).toBe(
      '服务没有就绪：启动命令 `npm start`（进程提前退出，退出码 3）。输出末尾：\n```\nError: listen EADDRINUSE\n```',
    );
    expect(formatServiceFailure(failure({ reason: 'timeout', exitCode: null }), 'npm start')).toBe(
      '服务没有就绪：启动命令 `npm start`（120 秒内没有就绪）。输出末尾：\n```\nError: listen EADDRINUSE\n```',
    );
    expect(formatServiceFailure(failure({ reason: 'aborted' }), 'npm start')).toMatch(
      /^服务没有就绪：启动命令 `npm start`（等待被中止）/,
    );
  });

  it('has no Chinese left in English', () => {
    setLang('en');
    const texts = [
      formatServiceFailure(failure({ exitCode: 3 }), 'npm start'),
      formatServiceFailure(failure({ exitCode: null }), 'npm start'),
      formatServiceFailure(failure({ reason: 'timeout', readyTimeoutMs: 1000 }), 'npm start'),
      formatServiceFailure(failure({ reason: 'timeout' }), 'npm start'),
      formatServiceFailure(failure({ reason: 'aborted' }), 'npm start'),
    ];
    for (const text of texts) {
      expect(text).toMatch(/^The service did not become ready: start command `npm start` \(/);
      expect(text).toMatch(/End of the output:\n```\nError: listen EADDRINUSE\n```$/);
      expect(text).not.toMatch(/[一-鿿]/);
    }
    expect(texts[0]).toContain('(it exited early with exit code 3)');
    expect(texts[2]).toContain('(it was not ready within 1 second)');
    expect(texts[3]).toContain('(it was not ready within 120 seconds)');
  });
});
