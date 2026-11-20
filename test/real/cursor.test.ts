import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CursorAgentAdapter } from '../../src/adapters/cursor-agent.js';
import { parseReport, TaskReportSchema } from '../../src/engine/contracts.js';
import { initRepo, tmpDir } from '../helpers.js';

// Calls the real cursor-agent CLI (uses the logged-in Cursor account's quota).
// Run manually with `npm run test:real`. Model can be changed with ARES1_REAL_CURSOR_MODEL.
const model = process.env.ARES1_REAL_CURSOR_MODEL ?? 'auto';

describe('real cursor-agent', () => {
  it('edits a file, reports the agreed JSON, and can resume the session', async () => {
    const repo = initRepo();
    const logs = tmpDir('ares1-real-cursor-');
    const adapter = new CursorAgentAdapter(process.env.ARES1_CURSOR_BIN ?? 'cursor-agent');
    const base = {
      workdir: repo,
      model,
      permission: 'full' as const,
      timeoutMs: 180_000,
      extraArgs: [],
    };

    const first = await adapter.start({
      ...base,
      prompt:
        '在当前目录创建 hello.txt，内容只有一行 hello。不要做别的事。最后一条回复以一个 JSON 代码块结束：\n```json\n{"status": "done", "summary": "一句话"}\n```',
      logPath: join(logs, 'first.jsonl'),
    }).result;
    expect(first.status, first.error).toBe('completed');
    expect(readFileSync(join(repo, 'hello.txt'), 'utf8').trim()).toBe('hello');
    const report = parseReport(TaskReportSchema, first.structured, first.finalMessage);
    expect(report.ok, JSON.stringify(report)).toBe(true);
    expect(first.sessionId).toBeTruthy();
    expect(first.usage.outputTokens).toBeGreaterThan(0);

    const second = await adapter.start({
      ...base,
      prompt: '把 hello.txt 的内容改成 world。完成后同样以 JSON 代码块结束。',
      resumeSessionId: first.sessionId,
      logPath: join(logs, 'second.jsonl'),
    }).result;
    expect(second.status, second.error).toBe('completed');
    expect(second.sessionId).toBe(first.sessionId);
    expect(readFileSync(join(repo, 'hello.txt'), 'utf8').trim()).toBe('world');
  });
});
