import { spawn } from 'node:child_process';
import {
  accessSync,
  appendFileSync,
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readSync,
  statSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { t } from '../i18n.js';
import { tail } from '../util.js';

export interface CommandResult {
  command: string;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** End of the combined output, used as rework feedback. */
  outputTail: string;
}

export interface CommandOptions {
  timeoutMs: number;
  logPath: string;
  /**
   * Environment of the command. These commands run code the agents wrote, so the engine passes
   * `prepareAgentEnv` (see `src/adapters/process.ts`): no GitHub or GitLab credentials.
   */
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/** Run one shell command in `cwd`; output is appended to `logPath`. */
export function runCommand(
  command: string,
  cwd: string,
  opts: CommandOptions,
): Promise<CommandResult> {
  mkdirSync(dirname(opts.logPath), { recursive: true });
  appendFileSync(opts.logPath, `\n$ ${command}\n`);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      // NO_COLOR as well: tools using tinyrainbow (vitest) treat any FORCE_COLOR, even "0", as "on".
      env: { ...opts.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output = (output + text).slice(-64_000);
      appendFileSync(opts.logPath, text);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const kill = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already exited
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    opts.signal?.addEventListener('abort', kill, { once: true });

    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', kill);
      appendFileSync(opts.logPath, `\n[exit ${exitCode}${timedOut ? ', timeout' : ''}]\n`);
      resolve({
        command,
        passed: exitCode === 0 && !timedOut,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        outputTail: tail(output, 4000),
      });
    };
    child.on('error', (err) => {
      output += `\n${err.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

/** Run commands in order, stopping at the first failure. */
export async function runCommands(
  commands: readonly string[],
  cwd: string,
  opts: CommandOptions,
): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (const command of commands) {
    if (opts.signal?.aborted) break;
    const result = await runCommand(command, cwd, opts);
    results.push(result);
    if (!result.passed) break;
  }
  return results;
}

/**
 * A failed command and the end of its output, as agents and the dashboard read it: the line
 * before the output fence always ends in 「输出末尾：」 / "output:".
 */
export function formatCommandFailure(
  result: CommandResult,
  kind: 'verify' | 'setup' = 'verify',
): string {
  const why = result.timedOut
    ? t({ zh: '超时', en: 'timed out' })
    : t({ zh: `退出码 ${result.exitCode}`, en: `exit code ${result.exitCode}` });
  const output = `\n\`\`\`\n${result.outputTail}\n\`\`\``;
  if (kind === 'setup') {
    return t({
      zh: `准备命令 \`${result.command}\` 失败（${why}）。输出末尾：${output}`,
      en: `Setup command \`${result.command}\` failed (${why}). End of the output:${output}`,
    });
  }
  return t({
    zh: `检查命令 \`${result.command}\` 未通过（${why}）。输出末尾：${output}`,
    en: `Verify command \`${result.command}\` failed (${why}). End of the output:${output}`,
  });
}

/** The exit code of a shell that could not find the command it was to run. */
const COMMAND_NOT_FOUND = 127;

/**
 * Words the shell runs itself, without looking in PATH: a 127 after one of them came from a later
 * command, which cannot be told from here.
 */
const SHELL_WORDS = new Set([
  '.',
  ':',
  '[',
  '!',
  '{',
  'alias',
  'break',
  'case',
  'cd',
  'continue',
  'echo',
  'eval',
  'exit',
  'export',
  'false',
  'for',
  'if',
  'printf',
  'read',
  'readonly',
  'return',
  'set',
  'shift',
  'source',
  'test',
  'trap',
  'true',
  'type',
  'ulimit',
  'umask',
  'unset',
  'until',
  'wait',
  'while',
]);

/** Commands that run the command after them (and their options), e.g. `env FOO=1 npm test`. */
const WRAPPERS = new Set(['command', 'env', 'exec', 'nice', 'nohup', 'time']);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The program a shell command line starts first: its first word, past `VAR=value` assignments
 * and wrappers such as `env` or `exec`, in the first of the commands joined by `&&`, `||`, `;`,
 * `|` or a line break. Null when that cannot be told without running the shell: a word the shell
 * runs itself (`cd`, `if`, a subshell), or one built from expansions or quotes it would rewrite.
 */
export function firstProgram(command: string): string | null {
  const first = command.trim().split(/&&|\|\||[;|&\n()]/)[0] ?? '';
  const words = first.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length) {
    const word = words[i] as string;
    if (ASSIGNMENT.test(word)) {
      i++;
      continue;
    }
    if (WRAPPERS.has(word)) {
      i++;
      // The wrapper's own options, e.g. `nice -n 5`, `env -i`; a number after an option too.
      while (i < words.length && /^-|^\d+$/.test(words[i] as string)) i++;
      continue;
    }
    break;
  }
  let word = words[i];
  if (!word) return null;
  const quoted = /^(['"])(.*)\1$/.exec(word);
  if (quoted) word = quoted[2] as string;
  if (!word || /[$`'"\\*?[\]{}~<>]/.test(word) || SHELL_WORDS.has(word)) return null;
  return word;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where `name` is found in PATH as the shell looks it up; null when it is not. */
export function findInPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const path = join(dir, name);
    if (isExecutableFile(path)) return path;
  }
  return null;
}

/**
 * The interpreter a script's `#!` line names: the program `/usr/bin/env` is to find (`node` for
 * `#!/usr/bin/env node`), or the interpreter's path; null for a file without one.
 */
function interpreterOf(path: string): string | null {
  let head = '';
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(256);
      head = buf.toString('utf8', 0, readSync(fd, buf, 0, buf.length, 0));
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  if (!head.startsWith('#!')) return null;
  const [interpreter, ...args] = (head.slice(2).split('\n')[0] ?? '').trim().split(/\s+/);
  if (!interpreter) return null;
  if (interpreter.endsWith('/env')) {
    return args.find((arg) => !arg.startsWith('-') && !ASSIGNMENT.test(arg)) ?? null;
  }
  return interpreter;
}

/**
 * What of `program` cannot be found with `env`, or null when it can: the program itself (a name
 * not in PATH, or an absolute path that is not an executable file), or the interpreter its `#!`
 * line names (npm's `#!/usr/bin/env node` with no node in PATH).
 */
export function missingProgram(program: string, env: NodeJS.ProcessEnv): string | null {
  const path = isAbsolute(program) ? program : findInPath(program, env);
  if (!path || !isExecutableFile(path)) return program;
  const interpreter = interpreterOf(path);
  if (!interpreter) return null;
  if (isAbsolute(interpreter)) return isExecutableFile(interpreter) ? null : interpreter;
  return findInPath(interpreter, env) ? null : interpreter;
}

/**
 * Whether a failed command failed for the environment rather than for the code: the shell could
 * not find the program the command starts first (exit code 127), looked up in PATH of `env`, the
 * environment the command ran with. Returns the program not found, e.g. `npm`, or its missing
 * interpreter, e.g. `node`; null otherwise. A 127 while that program is there came from inside
 * it, e.g. an npm script calling a tool the repo does not install, which the code can fix. A
 * relative path (`./scripts/check.sh`, `node_modules/.bin/vitest`) names a file of the worktree,
 * which is the code's as well. The output's wording is not read: it differs between shells and
 * languages.
 */
export function environmentProblem(result: CommandResult, env: NodeJS.ProcessEnv): string | null {
  if (result.passed || result.timedOut || result.exitCode !== COMMAND_NOT_FOUND) return null;
  return commandMissing(result.command, env);
}

/**
 * What of the program a command line starts first (`firstProgram`) cannot be found with `env`
 * (`missingProgram`), without running the command; null when it is found, or when it cannot be
 * told without running the shell. A relative path names a file of the worktree, which is the
 * code's, so it is never the environment's fault.
 */
export function commandMissing(command: string, env: NodeJS.ProcessEnv): string | null {
  const program = firstProgram(command);
  if (!program || (program.includes('/') && !isAbsolute(program))) return null;
  return missingProgram(program, env);
}

/**
 * The first of `commands` that could not run with `env` for want of a program (`commandMissing`),
 * with that program; null when every one finds what it starts.
 */
export function firstMissingCommand(
  commands: readonly string[],
  env: NodeJS.ProcessEnv,
): { command: string; missing: string } | null {
  for (const command of commands) {
    const missing = commandMissing(command, env);
    if (missing) return { command, missing };
  }
  return null;
}
