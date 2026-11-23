import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_GH_TOKEN, agentEnv } from '../src/adapters/process.js';
import {
  environmentProblem,
  firstProgram,
  formatCommandFailure,
  missingProgram,
  runCommand,
  runCommands,
} from '../src/verify/commands.js';
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
    expect(formatCommandFailure(result, 'setup')).toBe(
      '准备命令 `echo "CI=$CI NO_COLOR=$NO_COLOR"; exit 3` 失败（退出码 3）。输出末尾：\n```\nCI=1 NO_COLOR=1\n\n```',
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

describe('firstProgram', () => {
  it('finds the program a command line starts first', () => {
    expect(firstProgram('npm test')).toBe('npm');
    expect(firstProgram('  npm ci --no-audit && npm run build')).toBe('npm');
    expect(firstProgram('CI=1 FOO=bar npx vitest run; echo done')).toBe('npx');
    expect(firstProgram('env -i PATH=/x node --version | head')).toBe('node');
    expect(firstProgram('exec pnpm lint')).toBe('pnpm');
    expect(firstProgram('"npm" test')).toBe('npm');
    expect(firstProgram('/usr/local/bin/npm test')).toBe('/usr/local/bin/npm');
  });

  it('gives up on what only the shell can tell', () => {
    expect(firstProgram('cd web && npm test')).toBeNull();
    expect(firstProgram('(cd web && npm test)')).toBeNull();
    expect(firstProgram('if true; then npm test; fi')).toBeNull();
    expect(firstProgram('$NPM test')).toBeNull();
    expect(firstProgram('~/bin/check')).toBeNull();
    expect(firstProgram('   ')).toBeNull();
  });
});

describe('environmentProblem', () => {
  /** A directory holding executable scripts `name` → body. */
  function bin(scripts: Record<string, string>): string {
    const dir = tmpDir('ares1-bin-');
    for (const [name, body] of Object.entries(scripts)) {
      writeFileSync(join(dir, name), body);
      chmodSync(join(dir, name), 0o755);
    }
    return dir;
  }

  async function run(command: string, path: string) {
    const dir = tmpDir();
    const env = { ...process.env, PATH: path };
    const result = await runCommand(command, dir, {
      timeoutMs: 10_000,
      logPath: join(dir, 'logs', 'verify.log'),
      env,
    });
    return { result, env };
  }

  const system = '/usr/bin:/bin';

  it('names the program the shell could not find (exit code 127)', async () => {
    const { result, env } = await run('ares1-no-such-tool --check', system);
    expect(result.exitCode).toBe(127);
    expect(environmentProblem(result, env)).toBe('ares1-no-such-tool');
    // An absolute path that is not there counts the same.
    const gone = await run('/nowhere/bin/npm test', system);
    expect(environmentProblem(gone.result, gone.env)).toBe('/nowhere/bin/npm');
  });

  it("names a script's missing interpreter, as npm's #!/usr/bin/env node with node gone", async () => {
    const dir = bin({ 'fake-npm': '#!/usr/bin/env ares1-no-such-node\nconsole.log(1)\n' });
    const { result, env } = await run('fake-npm test', `${dir}:${system}`);
    expect(result.exitCode).toBe(127);
    expect(environmentProblem(result, env)).toBe('ares1-no-such-node');
    expect(missingProgram('fake-npm', env)).toBe('ares1-no-such-node');
    expect(missingProgram('sh', env)).toBeNull();
  });

  it('leaves a 127 from inside a program that is there, or a relative path, to the code', async () => {
    // e.g. an npm script calling a tool the repo does not install.
    const inside = await run('sh -c "ares1-no-such-tool"', system);
    expect(inside.result.exitCode).toBe(127);
    expect(environmentProblem(inside.result, inside.env)).toBeNull();
    const relative = await run('./scripts/check.sh', system);
    expect(relative.result.exitCode).toBe(127);
    expect(environmentProblem(relative.result, relative.env)).toBeNull();
    // Other failures are the code's too.
    const failed = await run('false', system);
    expect(environmentProblem(failed.result, failed.env)).toBeNull();
  });
});
