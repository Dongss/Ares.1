import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CursorAgentAdapter } from '../src/adapters/cursor-agent.js';
import { AGENT_GH_TOKEN, agentEnv } from '../src/adapters/process.js';
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
  fs.writeFileSync('.fake-cursor-call.json', JSON.stringify({ args: argv, stdin: input, env: process.env }));
  const at = (flag) => (argv.indexOf(flag) >= 0 ? argv[argv.indexOf(flag) + 1] : undefined);
  const sid = at('--resume') || 'chat-1';
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  if (input.includes('MODE=badmodel')) {
    process.stderr.write('Cannot use this model: ' + at('--model') + '. Available models: auto\\n');
    process.exit(1);
  }
  if (input.includes('MODE=stderr429')) {
    process.stderr.write('Error: request failed with HTTP 429 Too Many Requests\\n');
    process.exit(1);
  }
  if (input.includes('MODE=stderrlimit')) {
    const reset = /AT=(\\S+)/.exec(input)[1];
    process.stderr.write("You've hit your usage limit. It resets at " + reset + '.\\n');
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
  // TALK: the agent's own reply talks about rate limits.
  const last = input.includes('TALK') ? 'Hit a rate limit (HTTP 429, usage limit reached), retried.' : 'all done';
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: last }] }, session_id: sid });
  if (input.includes('MODE=error')) {
    out({ type: 'result', subtype: 'error', is_error: true, result: 'usage limit reached', session_id: sid });
    return;
  }
  if (input.includes('MODE=fail')) {
    out({ type: 'result', subtype: 'error', is_error: true, result: 'Internal server error', session_id: sid });
    return;
  }
  out({
    type: 'result', subtype: 'success', is_error: false, duration_ms: 10,
    result: '先写文件。' + last, session_id: sid,
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
    env: process.env,
    logPath: join(dir, 'logs', 'a.jsonl'),
    onEvent: (e) => events.push(e),
    ...extra,
  });
  const call = () =>
    JSON.parse(readFileSync(join(workdir, '.fake-cursor-call.json'), 'utf8')) as {
      args: string[];
      stdin: string;
      env: Record<string, string>;
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
    // Raw output is kept on disk. The result does not wait for the log file to be flushed, so
    // under load the file may still be catching up when it arrives.
    await vi.waitFor(() =>
      expect(
        readFileSync(join(dir, 'logs', 'a.jsonl'), 'utf8')
          .trim()
          .split('\n'),
      ).toHaveLength(9),
    );
  });

  it('starts the CLI with the environment it is given: the agent one has no GitHub access', async () => {
    const { adapter, input, call, dir } = setup();
    const ghDir = join(dir, 'gh-config');
    const base = {
      ...process.env,
      GH_TOKEN: 'gho_master',
      GH_ENTERPRISE_TOKEN: 'ghe_master',
      CURSOR_API_KEY: 'cursor-keep',
    };
    const result = await adapter.start(input('MODE=ok', { env: agentEnv(base, ghDir) })).result;
    expect(result.status).toBe('completed');
    const { env } = call();
    expect(env.GH_TOKEN).toBe(AGENT_GH_TOKEN);
    expect(env.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(env.GH_CONFIG_DIR).toBe(ghDir);
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    // The CLI's own login and everything else are passed on.
    expect(env.CURSOR_API_KEY).toBe('cursor-keep');
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
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

  it('reports an exhausted quota in an error result as a rate limit, with the CLI message', async () => {
    const { adapter, input } = setup();
    const result = await adapter.start(input('MODE=error')).result;
    expect(result.status).toBe('failed');
    expect(result.error).toBe('usage limit reached');
    expect(result.errorKind).toBe('rate_limited');
    expect(result).not.toHaveProperty('retryAt');
  });

  it('reports a rate limit on stderr without a result (exit 1), with its reset time', async () => {
    const { adapter, input } = setup();
    const r429 = await adapter.start(input('MODE=stderr429')).result;
    expect(r429).toMatchObject({ status: 'failed', errorKind: 'rate_limited', exitCode: 1 });
    expect(r429.error).toBe('Error: request failed with HTTP 429 Too Many Requests');
    expect(r429).not.toHaveProperty('retryAt');

    const at = new Date(Math.ceil(Date.now() / 1000) * 1000 + 3_600_000).toISOString();
    const limit = await adapter.start(input(`MODE=stderrlimit AT=${at}`)).result;
    expect(limit).toMatchObject({
      status: 'failed',
      errorKind: 'rate_limited',
      retryAt: at,
      exitCode: 1,
    });
    expect(limit.error).toBe(`You've hit your usage limit. It resets at ${at}.`);
  });

  it('reports an unknown model (exit 1, stderr only) as failed, not as a rate limit', async () => {
    const { adapter, input } = setup();
    const result = await adapter.start(input('MODE=badmodel')).result;
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Cannot use this model: grok-4.7-high');
    expect(result.exitCode).toBe(1);
    expect(result).not.toHaveProperty('errorKind');
  });

  it("does not take the agent's own talk of rate limits for one", async () => {
    const { adapter, input } = setup();
    // A finished turn whose replies (and so the joined result) mention a rate limit.
    const ok = await adapter.start(input('MODE=ok TALK')).result;
    expect(ok.status).toBe('completed');
    expect(ok.finalMessage).toContain('rate limit');
    expect(ok).not.toHaveProperty('errorKind');

    // A failed turn: only the CLI's error text counts, not what the agent wrote before.
    const failed = await adapter.start(input('MODE=fail TALK')).result;
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('Internal server error');
    expect(failed).not.toHaveProperty('errorKind');
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
