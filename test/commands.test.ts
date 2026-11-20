import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatCommandFailure, runCommand } from '../src/verify/commands.js';
import { tmpDir } from './helpers.js';

describe('runCommand', () => {
  it('asks tools not to color their output', async () => {
    const dir = tmpDir();
    const result = await runCommand('echo "CI=$CI NO_COLOR=$NO_COLOR"; exit 3', dir, {
      timeoutMs: 10_000,
      logPath: join(dir, 'logs', 'verify.log'),
    });
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.outputTail.trim()).toBe('CI=1 NO_COLOR=1');
    expect(formatCommandFailure(result)).toBe(
      '检查命令 `echo "CI=$CI NO_COLOR=$NO_COLOR"; exit 3` 未通过（退出码 3）。输出末尾：\n```\nCI=1 NO_COLOR=1\n\n```',
    );
  });
});
