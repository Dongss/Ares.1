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

  const killGroup = (signal: NodeJS.Signals) => {
    if (child.pid === undefined || exited) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // already gone
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
    if (exited) return;
    stopReason ??= reason;
    killGroup('SIGTERM');
    const grace = setTimeout(() => killGroup('SIGKILL'), opts.killGraceMs ?? 5000);
    await done;
    clearTimeout(grace);
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

/** SIGTERM a process group, then SIGKILL if it is still there after the grace period. */
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
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
  }
  send('SIGKILL');
}
