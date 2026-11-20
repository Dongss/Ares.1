import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { agentEnv } from '../../src/adapters/process.js';
import {
  parseReport,
  TASK_REPORT_JSON_SCHEMA,
  TaskReportSchema,
} from '../../src/engine/contracts.js';
import { initRepo, tmpDir } from '../helpers.js';

// Calls the real Claude Code CLI (costs a little; needs a logged-in `claude`).
// Run manually with `npm run test:real`. Model can be changed with ARES1_REAL_MODEL.
const model = process.env.ARES1_REAL_MODEL ?? 'haiku';

describe('real Claude Code', () => {
  it('edits a file, reports the agreed JSON, and can resume the session', async () => {
    const repo = initRepo();
    const logs = tmpDir('ares1-real-');
    const adapter = new ClaudeCodeAdapter(process.env.ARES1_CLAUDE_BIN ?? 'claude');
    const base = {
      workdir: repo,
      model,
      permission: 'full' as const,
      outputSchema: TASK_REPORT_JSON_SCHEMA,
      timeoutMs: 180_000,
      extraArgs: [],
      // What the engine gives agents: the CLI has to work without GitHub credentials.
      env: agentEnv(process.env, tmpDir('ares1-real-gh-')),
    };

    const first = await adapter.start({
      ...base,
      prompt:
        '在当前目录创建 hello.txt，内容只有一行 hello。不要做别的事。完成后按要求输出 JSON：{"status":"done","summary":"..."}',
      logPath: join(logs, 'first.jsonl'),
    }).result;
    expect(first.status, first.error).toBe('completed');
    expect(readFileSync(join(repo, 'hello.txt'), 'utf8').trim()).toBe('hello');
    const report = parseReport(TaskReportSchema, first.structured, first.finalMessage);
    expect(report.ok, JSON.stringify(report)).toBe(true);
    expect(first.sessionId).toBeTruthy();
    expect(first.costUsd).toBeGreaterThan(0);

    const second = await adapter.start({
      ...base,
      prompt: '把 hello.txt 的内容改成 world。完成后同样输出 JSON。',
      resumeSessionId: first.sessionId,
      logPath: join(logs, 'second.jsonl'),
    }).result;
    expect(second.status, second.error).toBe('completed');
    expect(second.sessionId).toBe(first.sessionId);
    expect(readFileSync(join(repo, 'hello.txt'), 'utf8').trim()).toBe('world');
    expect(existsSync(join(logs, 'second.jsonl'))).toBe(true);
  });
});
