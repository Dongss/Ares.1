import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { agentEnv } from '../../src/adapters/process.js';
import {
  ASSESS_REPORT_JSON_SCHEMA,
  AssessReportSchema,
  parseReport,
  TASK_REPORT_JSON_SCHEMA,
  TaskReportSchema,
} from '../../src/engine/contracts.js';
import { initRepo, tmpDir } from '../helpers.js';

// Calls the real Codex CLI (uses the logged-in account's quota; needs a logged-in `codex`).
// Run manually with `npm run test:real`. Model can be changed with ARES1_REAL_CODEX_MODEL, the
// executable with ARES1_CODEX_BIN.
const model = process.env.ARES1_REAL_CODEX_MODEL ?? 'gpt-5.5';
const adapter = () => new CodexAdapter(process.env.ARES1_CODEX_BIN ?? 'codex');

/** What the engine gives agents: the CLI has to work without GitHub credentials. */
const base = () => ({
  model,
  effort: 'low' as const,
  timeoutMs: 300_000,
  extraArgs: [],
  env: agentEnv(process.env, tmpDir('ares1-real-gh-')),
});

describe('real Codex CLI', () => {
  it('runs read-only: reads, answers in the strict schema, and changes nothing', async () => {
    const repo = initRepo();
    const logs = tmpDir('ares1-real-codex-');
    const result = await adapter().start({
      ...base(),
      workdir: repo,
      readOnly: true,
      permission: 'safe',
      outputSchema: ASSESS_REPORT_JSON_SCHEMA,
      prompt:
        '读一下 README.md，然后试着创建文件 probe.txt（这个环境是只读的，失败就算了）。最后按给定的 JSON 格式回答：verdict 写 go，summary 用一句话说 README.md 里写了什么，size 写 S。',
      logPath: join(logs, 'readonly.jsonl'),
    }).result;
    expect(result.status, result.error).toBe('completed');
    const report = parseReport(AssessReportSchema, result.structured, result.finalMessage);
    expect(report.ok, JSON.stringify(report)).toBe(true);
    // The read-only sandbox kept the workdir as it was.
    expect(existsSync(join(repo, 'probe.txt'))).toBe(false);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toBe(
      '',
    );
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });

  it('edits a file, reports the agreed JSON, and can resume the session', async () => {
    const repo = initRepo();
    const logs = tmpDir('ares1-real-codex-');
    const full = { ...base(), workdir: repo, permission: 'full' as const };

    const first = await adapter().start({
      ...full,
      outputSchema: TASK_REPORT_JSON_SCHEMA,
      prompt:
        '在当前目录创建 hello.txt，内容只有一行 hello。不要做别的事。最后按给定的 JSON 格式回答。',
      logPath: join(logs, 'first.jsonl'),
    }).result;
    expect(first.status, first.error).toBe('completed');
    expect(readFileSync(join(repo, 'hello.txt'), 'utf8').trim()).toBe('hello');
    const report = parseReport(TaskReportSchema, first.structured, first.finalMessage);
    expect(report.ok, JSON.stringify(report)).toBe(true);
    expect(first.sessionId).toBeTruthy();
    expect(first.usage.outputTokens).toBeGreaterThan(0);

    const second = await adapter().start({
      ...full,
      outputSchema: TASK_REPORT_JSON_SCHEMA,
      prompt: '把 hello.txt 的内容改成 world。完成后同样按给定的 JSON 格式回答。',
      resumeSessionId: first.sessionId,
      logPath: join(logs, 'second.jsonl'),
    }).result;
    expect(second.status, second.error).toBe('completed');
    expect(second.sessionId).toBe(first.sessionId);
    expect(readFileSync(join(repo, 'hello.txt'), 'utf8').trim()).toBe('world');
  });
});
