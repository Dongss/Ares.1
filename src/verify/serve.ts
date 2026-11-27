/**
 * A repo's service for a command stage with `serve: true`: the Master picks a free port on this
 * machine, starts the repo's start command in the Run's worktree in a process group of its own,
 * waits until the service answers over HTTP, and hands the stage's commands its address. Once
 * they are over the whole group is stopped, and the stop waits until none of it is left, so the
 * next round (or Run) never finds the old service on a port or in the worktree.
 */
import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';
import { stopProcessGroup } from '../adapters/process.js';
import { t } from '../i18n.js';
import { errorMessage, tail } from '../util.js';

export interface ServiceOptions {
  /** The repo's start command, run with `/bin/sh -c`. */
  command: string;
  /** The Run's worktree. */
  cwd: string;
  /**
   * The service's environment, before `PORT` and `ARES1_SERVICE_URL` are added. It runs code the
   * agents wrote, so the engine passes `prepareAgentEnv` (see `src/adapters/process.ts`): no
   * GitHub or GitLab credentials.
   */
  env: NodeJS.ProcessEnv;
  /** The service's output is appended here, after a first line with the command. */
  logPath: string;
  /** Path polled until the service answers with a status below 500; starts with `/`. */
  readyPath: string;
  readyTimeoutMs: number;
  /**
   * Aborting while the service is not ready yet stops it and ends the wait; once it is ready,
   * stopping it is the caller's (`stop`).
   */
  signal?: AbortSignal;
  /** Time between two readiness requests. */
  pollIntervalMs?: number;
  /** Grace period between SIGTERM and SIGKILL when the service is stopped. */
  killGraceMs?: number;
}

/** The variables the service and the stage's commands get to reach it. */
export interface ServiceEnv {
  PORT: string;
  ARES1_SERVICE_URL: string;
}

/** A service that answered: its commands may use it until `stop`. */
export interface RunningService {
  ok: true;
  port: number;
  /** `http://127.0.0.1:<port>`, without the ready path. */
  url: string;
  env: ServiceEnv;
  /** The group leader's pid, which is also the process group's id. */
  pid: number;
  /**
   * Stops the whole process group, SIGTERM and then SIGKILL after the grace period, and resolves
   * once no process of it is left. Calling it again waits for the same stop.
   */
  stop(): Promise<void>;
  /**
   * End of the service's output so far, as long as a failure's `outputTail`; after `stop`
   * resolved, up to its last line.
   */
  outputTail(): string;
}

/** A service that did not become ready; its process group is already gone. */
export interface ServiceFailure {
  ok: false;
  /**
   * `exited`: the start command ended (or could not be started) before the service answered;
   * `timeout`: it did not answer within `readyTimeoutMs`; `aborted`: the signal aborted the wait.
   */
  reason: 'exited' | 'timeout' | 'aborted';
  /** The start command's exit code when it exited; null otherwise or when a signal ended it. */
  exitCode: number | null;
  port: number;
  /** End of the service's output. */
  outputTail: string;
  /** How long the service had to become ready. */
  readyTimeoutMs: number;
}

export type ServiceResult = RunningService | ServiceFailure;

const DEFAULT_POLL_MS = 300;
/** How long one readiness request may take before it counts as no answer. */
const PROBE_TIMEOUT_MS = 1000;
/** Output kept in memory; only its end is ever shown. */
const OUTPUT_KEEP = 64_000;
/** Characters of the output's end that a result reports. */
const OUTPUT_TAIL = 4000;
/**
 * How long a stop waits for the service's output pipes to close once its group is gone, so the
 * last lines reach the log; a process that left the group may hold them open for good.
 */
const DRAIN_MS = 1000;
/** Tries at a port that no service of this Master holds, before giving up. */
const PORT_TRIES = 20;

/** Ports of the services started here and not stopped yet. */
const held = new Set<number>();

/** A port on 127.0.0.1 that nothing listens on: the one the system gives for port 0. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error(`no port from ${String(address)}`));
      });
    });
  });
}

/**
 * A free port no other service of this Master holds: between picking a port and the service
 * listening on it there is a moment when another Run could be given the same one.
 */
async function servicePort(): Promise<number> {
  let port = await freePort();
  for (let i = 1; i < PORT_TRIES && held.has(port); i++) port = await freePort();
  held.add(port);
  return port;
}

/**
 * Whether the service answers at `url`: any HTTP response with a status below 500. A refused
 * connection, a request that takes too long or a server error is no answer yet.
 */
function probe(url: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let req: ReturnType<typeof request>;
    try {
      req = request(url, {
        method: 'GET',
        // A socket of its own, closed after the answer: nothing keeps a connection to the
        // service open while it is being stopped.
        agent: false,
        headers: { connection: 'close' },
        timeout: PROBE_TIMEOUT_MS,
        signal,
      });
    } catch {
      resolve(false);
      return;
    }
    req.on('response', (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

/** Resolves after `ms`, or earlier once `early` settles or `signal` aborts. */
function pause(ms: number, early: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    void early.then(done, done);
  });
}

/**
 * Starts the repo's service for a command stage: picks a free port, runs `command` in `cwd`
 * with `/bin/sh -c` in a process group of its own, with `PORT` and `ARES1_SERVICE_URL` added to
 * `env` (and CI=1, no colors, as for the stage's commands), and polls
 * `ARES1_SERVICE_URL + readyPath` every `pollIntervalMs` until it answers with a status below
 * 500. The command's output is appended to `logPath`.
 *
 * Resolves with the running service once it answered, or with why it did not: the command
 * exited first, it took longer than `readyTimeoutMs`, or `signal` aborted the wait. A service
 * that did not become ready is stopped, its whole group, before the promise resolves.
 */
export async function startService(opts: ServiceOptions): Promise<ServiceResult> {
  mkdirSync(dirname(opts.logPath), { recursive: true });
  appendFileSync(opts.logPath, `$ ${opts.command}\n`);
  const port = await servicePort();
  const url = `http://127.0.0.1:${port}`;
  const env: ServiceEnv = { PORT: String(port), ARES1_SERVICE_URL: url };
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;

  const fail = (
    reason: ServiceFailure['reason'],
    exitCode: number | null,
    output: string,
  ): ServiceFailure => {
    held.delete(port);
    return {
      ok: false,
      reason,
      exitCode,
      port,
      outputTail: tail(output, OUTPUT_TAIL),
      readyTimeoutMs: opts.readyTimeoutMs,
    };
  };
  if (opts.signal?.aborted) {
    appendFileSync(opts.logPath, '[aborted, not started]\n');
    return fail('aborted', null, '');
  }

  const started = Date.now();
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn('/bin/sh', ['-c', opts.command], {
      cwd: opts.cwd,
      // NO_COLOR as well: tools using tinyrainbow (vitest) treat any FORCE_COLOR, even "0", as
      // "on".
      env: { ...opts.env, ...env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // An argument spawn refuses before starting anything, e.g. a NUL byte in the command.
    const message = errorMessage(err);
    appendFileSync(opts.logPath, `${message}\n[not started]\n`);
    return fail('exited', null, message);
  }
  let output = '';
  const onData = (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    output = (output + text).slice(-OUTPUT_KEEP);
    appendFileSync(opts.logPath, text);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  // How the leader ended, for the log's last line.
  let leaderExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.on('exit', (code, signal) => {
    leaderExit = { code, signal };
  });
  // 'close', not 'exit': a shell that starts the server in the background and exits is still
  // the service while the server holds its output open.
  let ended: { exitCode: number | null } | null = null;
  // Read through a function: the handlers below set it, which the loop's narrowing cannot see.
  const endedNow = () => ended;
  const endedPromise = new Promise<void>((resolve) => {
    child.on('close', (code) => {
      ended ??= { exitCode: code };
      resolve();
    });
    child.on('error', (err) => {
      onData(Buffer.from(`${err.message}\n`));
      ended ??= { exitCode: null };
      resolve();
    });
  });

  let stopping: Promise<void> | null = null;
  const stop = (why: string): Promise<void> => {
    stopping ??= (async () => {
      if (child.pid !== undefined) await stopProcessGroup(child.pid, opts.killGraceMs);
      await pause(DRAIN_MS, endedPromise);
      held.delete(port);
      const how = !leaderExit
        ? 'not started'
        : leaderExit.signal
          ? `signal ${leaderExit.signal}`
          : `exit ${leaderExit.code}`;
      appendFileSync(opts.logPath, `\n[${why}, ${how}]\n`);
    })();
    return stopping;
  };

  const deadline = started + opts.readyTimeoutMs;
  const readyUrl = `${url}${opts.readyPath}`;
  for (;;) {
    if (opts.signal?.aborted) {
      await stop('aborted');
      return fail('aborted', null, output);
    }
    const settled = endedNow();
    if (settled) {
      await stop('exited before ready');
      return fail('exited', settled.exitCode, output);
    }
    const answered = await probe(readyUrl, opts.signal);
    // The command may have ended or the wait been aborted meanwhile, an answer coming from the
    // last moment of a service that is ending: the top of the loop says which.
    if (endedNow() || opts.signal?.aborted) continue;
    if (answered && child.pid !== undefined) {
      appendFileSync(opts.logPath, `\n[ready after ${Date.now() - started}ms at ${url}]\n`);
      return {
        ok: true,
        port,
        url,
        env,
        pid: child.pid,
        stop: () => stop('stopped'),
        outputTail: () => tail(output, OUTPUT_TAIL),
      };
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      await stop(`not ready within ${opts.readyTimeoutMs}ms`);
      return fail('timeout', null, output);
    }
    await pause(Math.min(pollMs, left), endedPromise, opts.signal);
  }
}

/**
 * A service that did not become ready, as agents and the dashboard read it: why, the start
 * command, and the end of its output after a line ending in 「输出末尾：」 / "output:", as
 * `formatCommandFailure` writes it.
 */
export function formatServiceFailure(result: ServiceFailure, command: string): string {
  const seconds = Math.round(result.readyTimeoutMs / 1000);
  const why =
    result.reason === 'exited'
      ? result.exitCode === null
        ? t({ zh: '进程提前退出', en: 'it exited early' })
        : t({
            zh: `进程提前退出，退出码 ${result.exitCode}`,
            en: `it exited early with exit code ${result.exitCode}`,
          })
      : result.reason === 'timeout'
        ? t({
            zh: `${seconds} 秒内没有就绪`,
            en: `it was not ready within ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`,
          })
        : t({ zh: '等待被中止', en: 'the wait for it was cut short' });
  const output = `\n\`\`\`\n${result.outputTail}\n\`\`\``;
  return t({
    zh: `服务没有就绪：启动命令 \`${command}\`（${why}）。输出末尾：${output}`,
    en: `The service did not become ready: start command \`${command}\` (${why}). End of the output:${output}`,
  });
}
