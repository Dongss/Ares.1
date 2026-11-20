import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CursorAgentAdapter } from '../src/adapters/cursor-agent.js';
import type { AgentEvent, StartInput } from '../src/adapters/types.js';
import { tmpDir, writeFile } from './helpers.js';

// A stand-in `cursor-agent` that records how it was called and prints stream-json shaped like
// the real CLI's output (cursor-agent 2026.11, probed 2026-11-18).
const FAKE_CURSOR = `#!/usr/bin/env node
const fs = require('fs');
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const argv = process.argv.slice(2);
  fs.writeFileSync('.fake-cursor-call.json', JSON.stringify({ args: argv, stdin: input }));
  const at = (flag) => (argv.indexOf(flag) >= 0 ? argv[argv.indexOf(flag) + 1] : undefined);
  const sid = at('--resume') || 'chat-1';
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  if (input.includes('MODE=badmodel')) {
    process.stderr.write('Cannot use this model: ' + at('--model') + '. Available models: auto\\n');
    process.exit(1);
  }
  out({ type: 'system', subtype: 'init', apiKeySource: 'login', session_id: sid, model: 'Grok 4.7 256K High', permissionMode: 'default' });
  out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: input }] }, session_id: sid });
  out({ type: 'thinking', subtype: 'delta', text: 'hmm', session_id: sid });
  if (input.includes('MODE=hang')) {
    setInterval(() => {}, 1000);
    return;
  }
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '先写文件。' }] }, session_id: sid });
  out({ type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: { editToolCall: { args: { path: '/w/a.txt', streamContent: 'x' } } }, session_id: sid });
  out({ type: 'tool_call', subtype: 'started', call_id: 'c2', tool_call: { shellToolCall: { args: { command: 'npm test', workingDirectory: '' } } }, session_id: sid });
  out({ type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: { editToolCall: { args: {}, result: { success: {} } } }, session_id: sid });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'all done' }] }, session_id: sid });
  if (input.includes('MODE=error')) {
    out({ type: 'result', subtype: 'error', is_error: true, result: 'usage limit reached', session_id: sid });
    return;
  }
  out({
    type: 'result', subtype: 'success', is_error: false, duration_ms: 10,
    result: '先写文件。all done', session_id: sid,
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 5, reasoningTokens: 7 },
  });
});
`;

function setup() {
  const dir = tmpDir('ares1-cursor-');
  const bin = join(dir, 'cursor-agent');
  writeFile(bin, FAKE_CURSOR);
  chmodSync(bin, 0o755);
  const workdir = join(dir, 'work');
  writeFile(join(workdir, '.keep'), '');
  const events: AgentEvent[] = [];
  const input = (prompt: string, extra: Partial<StartInput> = {}): StartInput => ({
    workdir,
    prompt,
    model: 'grok-4.7-high',
    permission: 'full',
    timeoutMs: 10_000,
    extraArgs: [],
    logPath: join(dir, 'logs', 'a.jsonl'),
    onEvent: (e) => events.push(e),
    ...extra,
  });
  const call = () =>
    JSON.parse(readFileSync(join(workdir, '.fake-cursor-call.json'), 'utf8')) as {
      args: string[];
      stdin: string;
    };
  return { adapter: new CursorAgentAdapter(bin), input, events, call, dir };
}

describe('CursorAgentAdapter', () => {
  it('passes the agreed flags, sends the prompt on stdin, and parses the result', async () => {
    const { adapter, input, events, call, dir } = setup();
    const result = await adapter.start(input('MODE=ok do it', { outputSchema: { type: 'object' } }))
      .result;

    const { args, stdin } = call();
    expect(stdin).toBe('MODE=ok do it');
    expect(args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--trust',
      '--model',
      'grok-4.7-high',
      '--force',
    ]);
    expect(result).toEqual({
      status: 'completed',
      sessionId: 'chat-1',
      // the last reply, which carries the report (result joins all replies)
      finalMessage: 'all done',
      usage: { inputTokens: 105, outputTokens: 20, cachedTokens: 50 },
      permissionDenials: [],
      exitCode: 0,
      error: undefined,
    });
    // No cost from cursor-agent; the Master estimates it from the agent's price, if any.
    expect(result.costUsd).toBeUndefined();
    expect(events).toEqual([
      { type: 'session', sessionId: 'chat-1' },
      { type: 'model', model: 'Grok 4.7 256K High' },
      { type: 'message', text: '先写文件。' },
      { type: 'tool', name: 'Edit', summary: '/w/a.txt' },
      { type: 'tool', name: 'Shell', summary: 'npm test' },
      { type: 'message', text: 'all done' },
    ]);
    expect(
      readFileSync(join(dir, 'logs', 'a.jsonl'), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(9);
  });

  it('ignores effort, resumes a session, and leaves out --force for "safe"', async () => {
    const { adapter, input, call } = setup();
    const result = await adapter.start(
      input('MODE=ok again', { resumeSessionId: 'chat-9', permission: 'safe', effort: 'high' }),
    ).result;
    const { args } = call();
    expect(args).toEqual(expect.arrayContaining(['--resume', 'chat-9']));
    expect(args).not.toContain('--force');
    expect(args).not.toContain('--effort');
    expect(result.sessionId).toBe('chat-9');
  });

  it('reports error results as failed with the CLI message', async () => {
    const { adapter, input } = setup();
    const result = await adapter.start(input('MODE=error')).result;
    expect(result.status).toBe('failed');
    expect(result.error).toBe('usage limit reached');
  });

  it('reports an unknown model (exit 1, stderr only) as failed', async () => {
    const { adapter, input } = setup();
    const result = await adapter.start(input('MODE=badmodel')).result;
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Cannot use this model: grok-4.7-high');
    expect(result.exitCode).toBe(1);
  });

  it('can be stopped, and times out', async () => {
    const { adapter, input } = setup();
    const exec = adapter.start(input('MODE=hang'));
    await new Promise((r) => setTimeout(r, 200));
    await exec.stop();
    expect((await exec.result).status).toBe('stopped');

    const slow = await adapter.start(input('MODE=hang', { timeoutMs: 300 })).result;
    expect(slow.status).toBe('timeout');
  });

  it('fails cleanly when the CLI is not installed', async () => {
    const { input } = setup();
    const result = await new CursorAgentAdapter('/nonexistent/cursor-agent').start(input('x'))
      .result;
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/无法启动/);
  });
});
