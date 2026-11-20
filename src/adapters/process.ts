import { execFile, spawn } from 'node:child_process';
import { createWriteStream, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

/**
 * The GitHub token agents and their commands get: invalid on purpose. gh takes GH_TOKEN before
 * any login it keeps elsewhere (its config, the macOS keychain), so it fails instead of falling
 * back to one of those.
 */
export const AGENT_GH_TOKEN = 'ares1-agent-no-github-access';

/** Variables that hand GitHub credentials to gh and other tools. */
const GITHUB_TOKEN_VARS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
] as const;

/**
 * Programs git and ssh ask for a password when there is no terminal. Editors set them to hand
 * out their own logins (VS Code's GIT_ASKPASS answers with its GitHub session).
 */
const ASKPASS_VARS = ['GIT_ASKPASS', 'SSH_ASKPASS'] as const;

/**
 * The environment of agent CLIs and of the commands run on their work (setup and verify
 * commands, which execute code the agents wrote): the Master's own without its GitHub access.
 * The Master reads issues and pushes by itself, so agents need no GitHub credentials; with them
 * they could read what people the Master does not trust wrote, and act as every GitHub account
 * logged in on this machine.
 * - GitHub tokens are dropped and GH_TOKEN is an invalid one;
 * - gh's config directory is `ghConfigDir`, meant to be an empty directory: gh has no login;
 * - git has no credential helper (keychain, gh) or askpass program and never prompts.
 * Everything else stays as it is, PATH, HOME and the agent CLIs' own logins included.
 */
export function agentEnv(base: NodeJS.ProcessEnv, ghConfigDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of [...GITHUB_TOKEN_VARS, ...ASKPASS_VARS]) delete env[name];
  env.GH_TOKEN = AGENT_GH_TOKEN;
  env.GH_CONFIG_DIR = ghConfigDir;
  env.GIT_TERMINAL_PROMPT = '0';
  // git reads config from the environment after every config file, and an empty helper empties
  // the list of helpers set before it, URL-specific ones included. Added after any such config
  // the environment already has.
  const count = Number(base.GIT_CONFIG_COUNT ?? 0);
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  env[`GIT_CONFIG_KEY_${n}`] = 'credential.helper';
  env[`GIT_CONFIG_VALUE_${n}`] = '';
  env.GIT_CONFIG_COUNT = String(n + 1);
  return env;
}

/**
 * `agentEnv` of the Master's environment, with `ghConfigDir` emptied first: whatever an earlier
 * agent wrote there (a gh login, say) does not reach the next one.
 */
export function prepareAgentEnv(ghConfigDir: string): NodeJS.ProcessEnv {
  emptyDir(ghConfigDir);
  return agentEnv(process.env, ghConfigDir);
}

/** Makes `dir` an empty directory. A symlink put in its place is removed, never followed. */
export function emptyDir(dir: string): void {
  let isDir = false;
  try {
    isDir = lstatSync(dir).isDirectory();
  } catch {
    // missing
  }
  if (!isDir) {
    rmSync(dir, { force: true });
    mkdirSync(dir, { recursive: true });
    return;
  }
  for (const entry of readdirSync(dir)) {
    rmSync(join(dir, entry), { recursive: true, force: true });
  }
}

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
