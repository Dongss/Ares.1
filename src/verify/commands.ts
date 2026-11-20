import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
   * `prepareAgentEnv` (see `src/adapters/process.ts`): no GitHub credentials.
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
