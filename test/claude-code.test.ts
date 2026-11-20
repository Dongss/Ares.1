import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import type { AgentEvent, StartInput } from '../src/adapters/types.js';
import { tmpDir, writeFile } from './helpers.js';

// A stand-in `claude` executable that records how it was called and prints stream-json
// shaped like the real CLI's output (captured from real runs of the CLI).
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const argv = process.argv.slice(2);
  fs.writeFileSync('.fake-claude-call.json', JSON.stringify({ args: argv, stdin: input }));
  const at = (flag) => (argv.indexOf(flag) >= 0 ? argv[argv.indexOf(flag) + 1] : undefined);
  const sid = at('--session-id') || at('--resume');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  if (input.includes('MODE=crash')) {
    process.stderr.write('boom: not logged in\\n');
    process.exit(1);
  }
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-' + at('--model') + '-9' });
  if (input.includes('MODE=hang')) {
    setInterval(() => {}, 1000);
    return;
  }
  out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'a.txt', content: 'x' } }] } });
  out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: 'all done' }] } });
  if (input.includes('MODE=error')) {
    out({ type: 'result', subtype: 'success', is_error: true, result: 'There is an issue with the selected model', session_id: sid, usage: {}, permission_denials: [] });
    process.exit(1);
  }
  out({
    type: 'result', subtype: 'success', is_error: false, result: 'all done', session_id: sid,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 20 },
    permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'python3 x.py' } }],
    structured_output: { status: 'done', summary: 's' },
  });
});
`;

function setup() {
  const dir = tmpDir('ares1-claude-');
  const bin = join(dir, 'claude');
  writeFile(bin, FAKE_CLAUDE);
  chmodSync(bin, 0o755);
  const workdir = join(dir, 'work');
  writeFile(join(workdir, '.keep'), '');
  const events: AgentEvent[] = [];
  const input = (prompt: string, extra: Partial<StartInput> = {}): StartInput => ({
    workdir,
    prompt,
    model: 'sonnet',
    permission: 'full',
    timeoutMs: 10_000,
    extraArgs: [],
    logPath: join(dir, 'logs', 'a.jsonl'),
    onEvent: (e) => events.push(e),
    ...extra,
  });
  const call = () =>
    JSON.parse(readFileSync(join(workdir, '.fake-claude-call.json'), 'utf8')) as {
      args: string[];
      stdin: string;
    };
  return { adapter: new ClaudeCodeAdapter(bin), input, events, call, dir };
}

describe('ClaudeCodeAdapter', () => {
  it('passes the agreed flags, sends the prompt on stdin, and parses the result', async () => {
    const { adapter, input, events, call, dir } = setup();
    const exec = adapter.start(input('MODE=ok do it', { outputSchema: { type: 'object' } }));
    const result = await exec.result;

    const { args, stdin } = call();
    expect(stdin).toBe('MODE=ok do it');
    expect(args.slice(0, 6)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'sonnet',
    ]);
    expect(args).toEqual(
      expect.arrayContaining([
        '--permission-mode',
        'auto',
        '--setting-sources',
        'project,local',
        '--strict-mcp-config',
      ]),
    );
    expect(args[args.indexOf('--json-schema') + 1]).toBe('{"type":"object"}');
    // No effort configured: leave it to the CLI.
    expect(args).not.toContain('--effort');
    const sid = args[args.indexOf('--session-id') + 1];
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);

    expect(result).toMatchObject({
      status: 'completed',
      sessionId: sid,
      finalMessage: 'all done',
      structured: { status: 'done', summary: 's' },
      costUsd: 0.0123,
      usage: { inputTokens: 15, outputTokens: 20, cachedTokens: 100 },
      permissionDenials: ['Bash: python3 x.py'],
      exitCode: 0,
    });
    expect(events).toEqual([
      { type: 'session', sessionId: sid },
      // the model behind the alias, from the system/init event
      { type: 'model', model: 'claude-sonnet-9' },
      { type: 'tool', name: 'Write', summary: 'a.txt' },
      { type: 'message', text: 'all done' },
    ]);
    // Raw output is kept on disk.
    expect(
      readFileSync(join(dir, 'logs', 'a.jsonl'), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(4);
  });

  it('passes the effort as --effort', async () => {
    const { adapter, input, call } = setup();
    await adapter.start(input('MODE=ok', { model: 'opus', effort: 'xhigh' })).result;
    const { args } = call();
    expect(args.slice(4, 8)).toEqual(['--model', 'opus', '--effort', 'xhigh']);
    expect(args.filter((a) => a === '--effort')).toHaveLength(1);
  });

  it('resumes a session and maps "safe" permission to acceptEdits', async () => {
    const { adapter, input, call } = setup();
    const result = await adapter.start(
      input('MODE=ok again', { resumeSessionId: 'abc', permission: 'safe' }),
    ).result;
    const { args } = call();
    expect(args).toEqual(
      expect.arrayContaining(['--resume', 'abc', '--permission-mode', 'acceptEdits']),
    );
    expect(args).not.toContain('--session-id');
    expect(result.sessionId).toBe('abc');
  });

  it('reports is_error results as failed with the CLI message', async () => {
    const { adapter, input } = setup();
    const result = await adapter.start(input('MODE=error')).result;
    expect(result.status).toBe('failed');
    expect(result.error).toContain('issue with the selected model');
    expect(result.exitCode).toBe(1);
  });

  it('reports a crash without a result using stderr', async () => {
    const { adapter, input } = setup();
    const result = await adapter.start(input('MODE=crash')).result;
    expect(result.status).toBe('failed');
    expect(result.error).toContain('not logged in');
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
    const result = await new ClaudeCodeAdapter('/nonexistent/claude').start(input('x')).result;
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/无法启动/);
  });
});
