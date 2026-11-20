import { execFile, spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

export interface ProcessOptions {
  bin: string;
  args: string[];
  cwd: string;
  /** Written to stdin, then stdin is closed. */
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Raw stdout is appended here; stderr goes to `<logPath>.stderr`. */
  logPath: string;
  onStdoutLine?: (line: string) => void;
  onStderr?: (text: string) => void;
  /** Grace period between SIGTERM and SIGKILL. */
  killGraceMs?: number;
}

export interface ProcessOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Why it ended early, if it did. */
  ended: 'exit' | 'stopped' | 'timeout' | 'spawn_error';
  stderrTail: string;
  spawnError?: string;
}

export interface RunningProcess {
  pid?: number;
  command: string;
  done: Promise<ProcessOutcome>;
  stop(): Promise<void>;
}

const STDERR_TAIL = 8000;

/**
 * Spawn a CLI in its own process group so that stopping it also stops everything it started.
 */
export function runProcess(opts: ProcessOptions): RunningProcess {
  mkdirSync(dirname(opts.logPath), { recursive: true });
  const stdoutLog = createWriteStream(opts.logPath, { flags: 'a' });
  const stderrLog = createWriteStream(`${opts.logPath}.stderr`, { flags: 'a' });
  const command = [opts.bin, ...opts.args].map(shellQuote).join(' ');

  const child = spawn(opts.bin, opts.args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stopReason: 'stopped' | 'timeout' | null = null;
  let stderrTail = '';
  let exited = false;

  // Signals the whole group even after the leader has exited: other members may still be there.
  const killGroup = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // the group is empty
    }
  };

  const done = new Promise<ProcessOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: ProcessOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdoutLog.end();
      stderrLog.end();
      resolve(outcome);
    };

    child.on('error', (err) => {
      exited = true;
      finish({
        exitCode: null,
        signal: null,
        ended: 'spawn_error',
        stderrTail,
        spawnError: err.message,
      });
    });

    // Wait for stdout to be fully consumed before resolving, so no line is lost.
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      stdoutLog.write(`${line}\n`);
      opts.onStdoutLine?.(line);
    });
    const stdoutClosed = new Promise<void>((r) => rl.on('close', () => r()));

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrLog.write(text);
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL);
      opts.onStderr?.(text);
    });

    child.on('close', (code, signal) => {
      exited = true;
      void stdoutClosed.then(() =>
        finish({ exitCode: code, signal, ended: stopReason ?? 'exit', stderrTail }),
      );
    });
  });

  const stop = async (reason: 'stopped' | 'timeout') => {
    // Once the leader has ended on its own there is nothing to stop.
    if (exited) return;
    stopReason ??= reason;
    killGroup('SIGTERM');
    // The leader may exit on SIGTERM while members that ignore it live on, so the SIGKILL is
    // not tied to `done`: it goes to whatever is left of the group when the grace period ends.
    // Unref'd so that it never holds the Master's exit.
    setTimeout(() => {
      if (child.pid !== undefined && groupAlive(child.pid)) killGroup('SIGKILL');
    }, opts.killGraceMs ?? 5000).unref();
    await done;
  };

  const timer = setTimeout(() => void stop('timeout'), opts.timeoutMs);

  child.stdin.on('error', () => {
    // The CLI may exit before reading stdin; ignore EPIPE.
  });
  child.stdin.end(opts.stdin ?? '');

  return { pid: child.pid, command, done, stop: () => stop('stopped') };
}

function shellQuote(arg: string): string {
  if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Whether a process is still alive and its command line contains `expect`. */
export async function isOurProcess(pid: number, expect: string): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'command=', '-p', String(pid)], (err, stdout) => {
      if (err) return resolve(false);
      resolve(stdout.includes(expect));
    });
  });
}

/**
 * Whether any process is left in the group `pgid`, the leader or any other member. A group id is
 * not reused while the group has members, so signalling a group that is still there is safe.
 */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    // EPERM and the like mean the group exists even if we may not signal it.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * SIGTERM a process group, then SIGKILL whatever is left of it after the grace period. The
 * whole group is watched, not just the leader: members that ignore SIGTERM outlive it.
 */
export async function killProcessGroup(pid: number, graceMs = 5000): Promise<void> {
  const send = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      return false;
    }
  };
  if (!send('SIGTERM')) return;
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    if (!groupAlive(pid)) return;
  }
  send('SIGKILL');
}
