import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter, StreamJsonParser } from '../src/adapters/claude-code.js';
import { AGENT_GH_TOKEN, agentEnv } from '../src/adapters/process.js';
import { resetTime } from '../src/adapters/rate-limit.js';
import type { AgentEvent, StartInput } from '../src/adapters/types.js';
import { setLang } from '../src/i18n.js';
import { tmpDir, writeFile } from './helpers.js';

// A stand-in `claude` executable that records how it was called and prints stream-json
// shaped like the real CLI's output (captured from real runs of the CLI).
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const argv = process.argv.slice(2);
  fs.writeFileSync('.fake-claude-call.json', JSON.stringify({ args: argv, stdin: input, env: process.env }));
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
  if (input.includes('MODE=limit')) {
    out({ type: 'rate_limit_event', session_id: sid, rate_limit_info: { status: 'allowed_warning', resetsAt: 1900000000, rateLimitType: 'seven_day' } });
    out({ type: 'rate_limit_event', session_id: sid, rate_limit_info: { status: 'rejected', resetsAt: 1800000000, rateLimitType: 'five_hour' } });
    if (input.includes('MODE=limit-hang')) {
      setInterval(() => {}, 1000);
      return;
    }
    out({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit", session_id: sid, usage: {}, permission_denials: [] });
    process.exit(1);
  }
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
    env: process.env,
    logPath: join(dir, 'logs', 'a.jsonl'),
    onEvent: (e) => events.push(e),
    ...extra,
  });
  const call = () =>
    JSON.parse(readFileSync(join(workdir, '.fake-claude-call.json'), 'utf8')) as {
      args: string[];
      stdin: string;
      env: Record<string, string>;
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

  it('starts the CLI with the environment it is given: the agent one has no GitHub access', async () => {
    const { adapter, input, call, dir } = setup();
    const ghDir = join(dir, 'gh-config');
    const base = {
      ...process.env,
      GH_TOKEN: 'gho_master',
      GITHUB_TOKEN: 'ghp_master',
      ANTHROPIC_API_KEY: 'sk-ant-keep',
    };
    const result = await adapter.start(input('MODE=ok', { env: agentEnv(base, ghDir) })).result;
    expect(result.status).toBe('completed');
    const { env } = call();
    expect(env.GH_TOKEN).toBe(AGENT_GH_TOKEN);
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_CONFIG_DIR).toBe(ghDir);
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    // The CLI's own login and everything else are passed on.
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-keep');
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
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

  it('reports a rate limit with its reset time; a timeout is not one', async () => {
    const { adapter, input } = setup();
    const result = await adapter.start(input('MODE=limit')).result;
    expect(result).toMatchObject({
      status: 'failed',
      errorKind: 'rate_limited',
      // The limit that was hit (rejected), not the one only warned about.
      retryAt: new Date(1_800_000_000_000).toISOString(),
      exitCode: 1,
    });
    expect(result.error).toContain("You've hit your limit");

    const slow = await adapter.start(input('MODE=limit-hang', { timeoutMs: 300 })).result;
    expect(slow.status).toBe('timeout');
    expect(slow.errorKind).toBeUndefined();
    expect(slow.retryAt).toBeUndefined();
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

describe('StreamJsonParser: rate limits', () => {
  const limit = (info: Record<string, unknown>) =>
    JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info });
  const result = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', ...extra });
  const parse = (...lines: string[]) => {
    const parser = new StreamJsonParser();
    for (const line of lines) parser.feed(line);
    return parser.toResult(1);
  };
  const SECONDS = 1_800_000_000;
  const AT = new Date(SECONDS * 1000).toISOString();

  it('marks a limit without a result as rate_limited, with the reset time in seconds', () => {
    const r = parse(limit({ status: 'rejected', resetsAt: SECONDS }));
    expect(r).toMatchObject({ status: 'failed', errorKind: 'rate_limited', retryAt: AT });
    expect(r.error).toBe('额度用尽或被限流');
  });

  it('takes the reset time in milliseconds, as an ISO time or as resets_at', () => {
    for (const info of [
      { status: 'rejected', resetsAt: SECONDS * 1000 },
      { status: 'rejected', resetsAt: AT },
      { status: 'rejected', resets_at: SECONDS },
      { status: 'rejected', resetsAt: String(SECONDS) },
    ]) {
      expect(parse(limit(info)).retryAt).toBe(AT);
    }
  });

  it('marks a limit without a reset time as rate_limited, without retryAt', () => {
    for (const info of [{ status: 'rejected' }, { status: 'rejected', resetsAt: 'soon' }]) {
      const r = parse(limit(info));
      expect(r.errorKind).toBe('rate_limited');
      expect(r).not.toHaveProperty('retryAt');
    }
  });

  it('marks an error result after a limit as rate_limited, keeping the CLI message', () => {
    const r = parse(
      limit({ status: 'rejected', resetsAt: SECONDS }),
      result({ is_error: true, result: 'Usage limit reached' }),
    );
    expect(r).toMatchObject({
      status: 'failed',
      error: 'Usage limit reached',
      errorKind: 'rate_limited',
      retryAt: AT,
    });
  });

  it('without a limit event, takes the error text of a failed result for a rate limit', () => {
    const api = parse(
      result({
        is_error: true,
        result: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
      }),
    );
    expect(api).toMatchObject({ status: 'failed', errorKind: 'rate_limited' });
    expect(api.error).toContain('rate_limit_error');
    expect(api).not.toHaveProperty('retryAt');

    // The old format with the reset time in epoch seconds.
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const old = parse(result({ is_error: true, result: `Claude AI usage limit reached|${reset}` }));
    expect(old).toMatchObject({
      status: 'failed',
      error: `Claude AI usage limit reached|${reset}`,
      errorKind: 'rate_limited',
      retryAt: new Date(reset * 1000).toISOString(),
    });

    // A limit event wins over the text.
    const both = parse(
      limit({ status: 'rejected', resetsAt: SECONDS }),
      result({ is_error: true, result: `Claude AI usage limit reached|${reset}` }),
    );
    expect(both.retryAt).toBe(AT);
  });

  it('does not take other failures, or a finished turn that talks about limits, for one', () => {
    const failed = parse(result({ is_error: true, result: 'There is an issue with the model' }));
    expect(failed.status).toBe('failed');
    expect(failed).not.toHaveProperty('errorKind');

    const finished = parse(result({ result: 'Handled the rate limit (HTTP 429) with a retry' }));
    expect(finished.status).toBe('completed');
    expect(finished).not.toHaveProperty('errorKind');
  });

  it('keeps the latest reset time of the limits hit', () => {
    const r = parse(
      limit({ status: 'rejected', resetsAt: SECONDS + 3600 }),
      limit({ status: 'rejected', resetsAt: SECONDS }),
    );
    expect(r.retryAt).toBe(new Date((SECONDS + 3600) * 1000).toISOString());
  });

  it('is no rate limit when the turn finished, or when the CLI only allowed or warned', () => {
    const finished = parse(limit({ status: 'rejected', resetsAt: SECONDS }), result());
    expect(finished.status).toBe('completed');
    expect(finished).not.toHaveProperty('errorKind');
    expect(finished).not.toHaveProperty('retryAt');

    for (const status of ['allowed', 'allowed_warning']) {
      const failed = parse(
        limit({ status, resetsAt: SECONDS }),
        result({ is_error: true, result: 'boom' }),
      );
      expect(failed.status).toBe('failed');
      expect(failed.errorKind).toBeUndefined();
      expect(parse(limit({ status })).errorKind).toBeUndefined();
    }
  });

  it('reads reset times as seconds below 1e12, milliseconds above', () => {
    expect(resetTime(SECONDS)).toBe(SECONDS * 1000);
    expect(resetTime(SECONDS * 1000)).toBe(SECONDS * 1000);
    expect(resetTime(AT)).toBe(SECONDS * 1000);
    expect(resetTime(undefined)).toBeUndefined();
    expect(resetTime(0)).toBeUndefined();
    expect(resetTime('')).toBeUndefined();
    expect(resetTime('later')).toBeUndefined();
  });

  it('says so in English too', () => {
    setLang('en');
    try {
      const r = parse(limit({ status: 'rejected' }));
      expect(r.error).toBe('Out of quota or rate-limited');
      expect(r.error).not.toMatch(/[一-鿿]/);
    } finally {
      setLang('zh');
    }
  });
});
