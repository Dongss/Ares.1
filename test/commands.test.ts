import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_GH_TOKEN, agentEnv } from '../src/adapters/process.js';
import { formatCommandFailure, runCommand, runCommands } from '../src/verify/commands.js';
import { readEnvFile, tmpDir } from './helpers.js';

describe('runCommand', () => {
  it('asks tools not to color their output', async () => {
    const dir = tmpDir();
    const result = await runCommand('echo "CI=$CI NO_COLOR=$NO_COLOR"; exit 3', dir, {
      timeoutMs: 10_000,
      logPath: join(dir, 'logs', 'verify.log'),
      env: process.env,
    });
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.outputTail.trim()).toBe('CI=1 NO_COLOR=1');
    expect(formatCommandFailure(result)).toBe(
      '检查命令 `echo "CI=$CI NO_COLOR=$NO_COLOR"; exit 3` 未通过（退出码 3）。输出末尾：\n```\nCI=1 NO_COLOR=1\n\n```',
    );
  });

  it('runs every command in the environment it is given: the agent one has no GitHub access', async () => {
    const dir = tmpDir();
    const ghDir = join(dir, 'gh-config');
    const base = {
      ...process.env,
      GH_TOKEN: 'gho_master',
      GITHUB_TOKEN: 'ghp_master',
      GH_ENTERPRISE_TOKEN: 'ghe_master',
      GITHUB_ENTERPRISE_TOKEN: 'ghe_master2',
      KEEP_ME: 'kept',
    };
    const results = await runCommands(['env > first.env', 'env > second.env'], dir, {
      timeoutMs: 10_000,
      logPath: join(dir, 'logs', 'setup.log'),
      env: agentEnv(base, ghDir),
    });
    expect(results.map((r) => r.passed)).toEqual([true, true]);
    for (const file of ['first.env', 'second.env']) {
      const env = readEnvFile(join(dir, file));
      expect(env.GH_TOKEN).toBe(AGENT_GH_TOKEN);
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.GH_ENTERPRISE_TOKEN).toBeUndefined();
      expect(env.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
      expect(env.GH_CONFIG_DIR).toBe(ghDir);
      expect(env.GIT_TERMINAL_PROMPT).toBe('0');
      expect(env.KEEP_ME).toBe('kept');
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.HOME).toBe(process.env.HOME);
      expect(env.CI).toBe('1');
    }
  });

  it('leaves git no credential helper in the agent environment', async () => {
    const dir = tmpDir();
    // Only the helper set here, none from the user's config files (and no keychain lookups).
    const base: NodeJS.ProcessEnv = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_CONFIG')),
      ),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '!f() { echo username=me; echo password=leaked; }; f',
    };
    const fill = "printf 'protocol=https\\nhost=example.invalid\\n\\n' | git credential fill";
    const opts = { timeoutMs: 10_000, logPath: join(dir, 'logs', 'verify.log') };

    // The helper works with the Master's environment...
    const master = await runCommand(fill, dir, { ...opts, env: base });
    expect(master.passed).toBe(true);
    expect(master.outputTail).toContain('password=leaked');

    // ...and is gone with the agents', which does not prompt for a password either.
    const agent = await runCommand(fill, dir, { ...opts, env: agentEnv(base, join(dir, 'gh')) });
    expect(agent.passed).toBe(false);
    expect(agent.outputTail).not.toContain('leaked');
  });
});
