import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter, dropNullOptionals, strictOutputSchema } from '../src/adapters/codex.js';
import { AGENT_GH_TOKEN, agentEnv } from '../src/adapters/process.js';
import type { AgentEvent, StartInput } from '../src/adapters/types.js';
import { ASSESS_REPORT_JSON_SCHEMA, REVIEW_REPORT_JSON_SCHEMA } from '../src/engine/contracts.js';
import { scoutReportJsonSchema } from '../src/github/scout.js';
import { setLang } from '../src/i18n.js';
import { tmpDir, writeFile } from './helpers.js';

// A stand-in `codex` that records how it was called and prints `codex exec --json` output. The
// quota failure, the failed resume and the ignored-settings warning are as the real CLI printed
// them (codex-cli 0.172, recorded 2026-11-24); the rest follows the same event shapes.
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('fs');
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const argv = process.argv.slice(2);
  const at = (flag) => (argv.indexOf(flag) >= 0 ? argv[argv.indexOf(flag) + 1] : undefined);
  const schemaFile = at('--output-schema');
  const schema = schemaFile ? JSON.parse(fs.readFileSync(schemaFile, 'utf8')) : null;
  fs.writeFileSync('.fake-codex-call.json', JSON.stringify({ args: argv, stdin: input, env: process.env, schemaFile, schema }));
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  if (input.includes('MODE=badresume')) {
    process.stderr.write('Error: thread/resume: thread/resume failed: no rollout found for thread id ' + at('resume') + ' (code -32600)\\n');
    process.exit(1);
  }
  if (input.includes('MODE=stderr429')) {
    process.stderr.write('Error: unexpected status 429 Too Many Requests\\n');
    process.exit(1);
  }
  const resumed = argv.indexOf('resume') >= 0 ? at('resume') : undefined;
  out({ type: 'thread.started', thread_id: resumed || '01a20c78-3767-7240-a106-4046bc470bec' });
  if (input.includes('MODE=warn')) {
    out({ type: 'item.completed', item: { id: 'item_w', type: 'error', message: 'Codex is ignoring 1 unrecognized configuration setting.' } });
  }
  out({ type: 'turn.started' });
  if (input.includes('MODE=quota')) {
    out({ type: 'error', message: 'Quota exceeded. Check your plan and billing details.' });
    out({ type: 'turn.failed', error: { message: 'Quota exceeded. Check your plan and billing details.' } });
    process.exit(1);
  }
  if (input.includes('MODE=usagelimit')) {
    const msg = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again in 2 hours 5 minutes.";
    out({ type: 'error', message: msg });
    out({ type: 'turn.failed', error: { message: msg } });
    process.exit(1);
  }
  if (input.includes('MODE=hang')) {
    setInterval(() => {}, 1000);
    return;
  }
  if (input.includes('MODE=reconnect')) {
    out({ type: 'error', message: 'Reconnecting... 1/5 (unexpected status 429 Too Many Requests)' });
  }
  out({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '**Reading the file**' } });
  out({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: '先看文件。' } });
  out({ type: 'item.started', item: { id: 'item_2', type: 'command_execution', command: "/bin/zsh -lc 'cat note.txt'", aggregated_output: '', exit_code: null, status: 'in_progress' } });
  out({ type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: "/bin/zsh -lc 'cat note.txt'", aggregated_output: 'hello\\n', exit_code: 0, status: 'completed' } });
  out({ type: 'item.completed', item: { id: 'item_3', type: 'file_change', changes: [{ path: process.cwd() + '/src/a.ts', kind: 'update' }, { path: '/elsewhere/b.ts', kind: 'add' }], status: 'completed' } });
  out({ type: 'item.started', item: { id: 'item_4', type: 'mcp_tool_call', server: 'docs', tool: 'search', arguments: { query: 'sandbox' }, status: 'in_progress' } });
  out({ type: 'item.completed', item: { id: 'item_4', type: 'mcp_tool_call', server: 'docs', tool: 'search', arguments: { query: 'sandbox' }, status: 'completed' } });
  out({ type: 'item.completed', item: { id: 'item_5', type: 'web_search', query: 'codex exec json' } });
  out({ type: 'item.updated', item: { id: 'item_6', type: 'todo_list', items: [{ text: 'read', completed: true }] } });
  // TALK: the agent's own reply talks about rate limits.
  const talk = input.includes('TALK') ? 'Hit a rate limit (HTTP 429, usage limit reached), retried.' : null;
  const last = schema
    ? JSON.stringify({ summary: 'fine', issues: [{ severity: 'must', file: null, description: 'x' }, { severity: 'suggestion', file: 'a.ts', description: 'y' }] })
    : talk || 'all done';
  out({ type: 'item.completed', item: { id: 'item_7', type: 'agent_message', text: last } });
  if (input.includes('MODE=fail')) {
    out({ type: 'error', message: 'stream error: Internal server error' });
    out({ type: 'turn.failed', error: { message: 'stream error: Internal server error' } });
    process.exit(1);
  }
  out({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 80, reasoning_output_tokens: 30 } });
});
`;

const THREAD = '01a20c78-3767-7240-a106-4046bc470bec';

function setup() {
  const dir = tmpDir('ares1-codex-');
  const bin = join(dir, 'codex');
  writeFile(bin, FAKE_CODEX);
  chmodSync(bin, 0o755);
  const workdir = join(dir, 'work');
  writeFile(join(workdir, '.keep'), '');
  const events: AgentEvent[] = [];
  const input = (prompt: string, extra: Partial<StartInput> = {}): StartInput => ({
    workdir,
    prompt,
    model: 'gpt-5.5',
    permission: 'full',
    timeoutMs: 10_000,
    extraArgs: [],
    env: process.env,
    logPath: join(dir, 'logs', 'a.jsonl'),
    onEvent: (e) => events.push(e),
    ...extra,
  });
  const call = () =>
    JSON.parse(readFileSync(join(workdir, '.fake-codex-call.json'), 'utf8')) as {
      args: string[];
      stdin: string;
      env: Record<string, string>;
      schemaFile: string | null;
      schema: unknown;
    };
  return { adapter: new CodexAdapter(bin), input, events, call, dir, workdir };
}

/** What every run passes before the settings that differ. */
const COMMON = [
  'exec',
  '--json',
  '--skip-git-repo-check',
  '--ignore-user-config',
  '--ignore-rules',
  '--model',
  'gpt-5.5',
];

afterEach(() => setLang('zh'));

describe('CodexAdapter', () => {
  it('can run read-only', () => {
    expect(new CodexAdapter().cli).toBe('codex');
    expect(new CodexAdapter().supportsReadOnly).toBe(true);
  });

  it('runs "full" in the writable sandbox without approvals, prompt on stdin, and parses it', async () => {
    const { adapter, input, events, call, dir } = setup();
    const result = await adapter.start(
      input('MODE=ok do it', { effort: 'high', extraArgs: ['--add-dir', '/opt/cache'] }),
    ).result;

    const { args, stdin } = call();
    expect(stdin).toBe('MODE=ok do it');
    expect(args).toEqual([
      ...COMMON,
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '-c',
      'sandbox_workspace_write.network_access=true',
      '-c',
      'model_reasoning_effort="high"',
      '--add-dir',
      '/opt/cache',
      '-',
    ]);
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--ephemeral');
    expect(result).toEqual({
      status: 'completed',
      sessionId: THREAD,
      finalMessage: 'all done',
      structured: undefined,
      // input_tokens includes the cached ones, which are counted apart.
      usage: { inputTokens: 200, outputTokens: 80, cachedTokens: 1000 },
      permissionDenials: [],
      exitCode: 0,
      error: undefined,
    });
    // No cost from Codex; the Master estimates it from the agent's price, if any.
    expect(result.costUsd).toBeUndefined();
    expect(events).toEqual([
      { type: 'session', sessionId: THREAD },
      { type: 'message', text: '先看文件。' },
      // Once, when it started.
      { type: 'tool', name: 'Shell', summary: "/bin/zsh -lc 'cat note.txt'" },
      // No started event: shown when it completed; paths in the workdir relative to it.
      { type: 'tool', name: 'Edit', summary: 'update src/a.ts, add /elsewhere/b.ts' },
      { type: 'tool', name: 'mcp:docs/search', summary: '{"query":"sandbox"}' },
      { type: 'tool', name: 'WebSearch', summary: 'codex exec json' },
      { type: 'message', text: 'all done' },
    ]);
    // Raw output is kept on disk; the result does not wait for the file to be flushed.
    await vi.waitFor(() =>
      expect(
        readFileSync(join(dir, 'logs', 'a.jsonl'), 'utf8')
          .trim()
          .split('\n'),
      ).toHaveLength(13),
    );
  });

  it('runs read-only in the read-only sandbox, keeps no session and never resumes', async () => {
    const { adapter, input, call } = setup();
    const result = await adapter.start(
      input('MODE=ok look', { readOnly: true, permission: 'safe', resumeSessionId: 'sess-old' }),
    ).result;
    const { args } = call();
    expect(args).toEqual([
      ...COMMON,
      '--sandbox',
      'read-only',
      '-c',
      'approval_policy="never"',
      '--ephemeral',
      '-',
    ]);
    expect(args).not.toContain('resume');
    expect(args).not.toContain('sandbox_workspace_write.network_access=true');
    expect(result.status).toBe('completed');
    // A new session, not the one asked to resume.
    expect(result.sessionId).toBe(THREAD);
  });

  it('runs "safe" in the writable sandbox without network access', async () => {
    const { adapter, input, call } = setup();
    await adapter.start(input('MODE=ok', { permission: 'safe' })).result;
    const { args } = call();
    expect(args).toEqual([
      ...COMMON,
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '-',
    ]);
  });

  it('resumes a session with the resume subcommand, after the options', async () => {
    const { adapter, input, call } = setup();
    const result = await adapter.start(
      input('MODE=ok again', { resumeSessionId: 'sess-9', extraArgs: ['-c', 'x=1'] }),
    ).result;
    const { args } = call();
    // exec's own options (the sandbox, the agent's args) are not taken after the subcommand.
    expect(args.slice(-5)).toEqual(['-c', 'x=1', 'resume', 'sess-9', '-']);
    expect(args.indexOf('--sandbox')).toBeLessThan(args.indexOf('resume'));
    expect(result.sessionId).toBe('sess-9');
  });

  it('passes every effort as Codex names it, and none when unset', async () => {
    const { adapter, input, call } = setup();
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      await adapter.start(input('MODE=ok', { effort })).result;
      expect(call().args).toContain(`model_reasoning_effort="${effort}"`);
    }
    await adapter.start(input('MODE=ok')).result;
    expect(call().args.some((a) => a.startsWith('model_reasoning_effort'))).toBe(false);
  });

  it('passes the output schema in its strict form, and returns the result as the contract has it', async () => {
    const { adapter, input, call } = setup();
    const result = await adapter.start(
      input('MODE=ok', { outputSchema: REVIEW_REPORT_JSON_SCHEMA }),
    ).result;
    const { args, schemaFile, schema } = call();
    expect(schemaFile).toBeTruthy();
    expect(args[args.indexOf('--output-schema') + 1]).toBe(schemaFile);
    expect(schema).toEqual(strictOutputSchema(REVIEW_REPORT_JSON_SCHEMA));
    // The temporary file is gone after the run.
    expect(existsSync(schemaFile as string)).toBe(false);
    expect(result.status).toBe('completed');
    // The null the strict schema made the model write for an optional field is dropped.
    expect(result.structured).toEqual({
      summary: 'fine',
      issues: [
        { severity: 'must', description: 'x' },
        { severity: 'suggestion', file: 'a.ts', description: 'y' },
      ],
    });
  });

  it('starts the CLI with the environment it is given: the agent one has no GitHub access', async () => {
    const { adapter, input, call, dir } = setup();
    const ghDir = join(dir, 'gh-config');
    const base = {
      ...process.env,
      GH_TOKEN: 'gho_master',
      GITHUB_TOKEN: 'ghp_master',
      OPENAI_API_KEY: 'sk-keep',
      CODEX_HOME: '/home/me/.codex',
    };
    const result = await adapter.start(input('MODE=ok', { env: agentEnv(base, ghDir) })).result;
    expect(result.status).toBe('completed');
    const { env, args } = call();
    expect(env.GH_TOKEN).toBe(AGENT_GH_TOKEN);
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_CONFIG_DIR).toBe(ghDir);
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    // The CLI's own login and everything else are passed on.
    expect(env.OPENAI_API_KEY).toBe('sk-keep');
    expect(env.CODEX_HOME).toBe('/home/me/.codex');
    expect(env.PATH).toBe(process.env.PATH);
    // Nothing on the command line hands it credentials either.
    expect(args.join(' ')).not.toMatch(/gh[op]_|token/i);
  });

  it('reports an exhausted quota (as the real CLI printed it) as a rate limit', async () => {
    const { adapter, input } = setup();
    const result = await adapter.start(input('MODE=quota')).result;
    expect(result).toMatchObject({
      status: 'failed',
      sessionId: THREAD,
      error: 'Quota exceeded. Check your plan and billing details.',
      errorKind: 'rate_limited',
      exitCode: 1,
    });
    expect(result).not.toHaveProperty('retryAt');
  });

  it("reads the reset time of Codex's usage limit", async () => {
    const { adapter, input } = setup();
    const before = Date.now();
    const result = await adapter.start(input('MODE=usagelimit')).result;
    expect(result).toMatchObject({ status: 'failed', errorKind: 'rate_limited' });
    const retryAt = Date.parse(result.retryAt ?? '');
    const wait = (2 * 60 + 5) * 60_000;
    expect(retryAt).toBeGreaterThanOrEqual(before + wait);
    expect(retryAt).toBeLessThanOrEqual(Date.now() + wait);
  });

  it('reports a rate limit on stderr without events (exit 1)', async () => {
    const { adapter, input } = setup();
    const result = await adapter.start(input('MODE=stderr429')).result;
    expect(result).toMatchObject({ status: 'failed', errorKind: 'rate_limited', exitCode: 1 });
    expect(result.error).toBe('Error: unexpected status 429 Too Many Requests');
  });

  it('reports a failed resume (stderr only) as failed, not as a rate limit', async () => {
    const { adapter, input } = setup();
    const result = await adapter.start(input('MODE=badresume', { resumeSessionId: 'sess-gone' }))
      .result;
    expect(result.status).toBe('failed');
    expect(result.error).toContain('no rollout found for thread id sess-gone');
    expect(result.exitCode).toBe(1);
    expect(result).not.toHaveProperty('errorKind');
  });

  it("does not take the agent's own talk of rate limits, or retries on the way, for one", async () => {
    const { adapter, input } = setup();
    // A finished turn whose reply mentions a rate limit.
    const ok = await adapter.start(input('MODE=ok TALK')).result;
    expect(ok.status).toBe('completed');
    expect(ok.finalMessage).toContain('rate limit');
    expect(ok).not.toHaveProperty('errorKind');

    // A failed turn: only the CLI's error text counts, not what the agent wrote before.
    const failed = await adapter.start(input('MODE=fail TALK')).result;
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('stream error: Internal server error');
    expect(failed).not.toHaveProperty('errorKind');

    // A 429 the CLI retried past: the turn finished.
    const retried = await adapter.start(input('MODE=reconnect')).result;
    expect(retried.status).toBe('completed');
    expect(retried.error).toBeUndefined();
    expect(retried).not.toHaveProperty('errorKind');
  });

  it('shows warnings and error events as stderr, without failing the turn', async () => {
    const { adapter, input, events } = setup();
    const result = await adapter.start(input('MODE=warn MODE=reconnect')).result;
    expect(result.status).toBe('completed');
    expect(events).toEqual(
      expect.arrayContaining([
        { type: 'stderr', text: 'Codex is ignoring 1 unrecognized configuration setting.' },
        {
          type: 'stderr',
          text: 'Reconnecting... 1/5 (unexpected status 429 Too Many Requests)',
        },
      ]),
    );
  });

  it('can be stopped, and times out', async () => {
    const { adapter, input, events } = setup();
    const exec = adapter.start(input('MODE=hang'));
    // Stopped once the session started: what it reported on the way is kept.
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'session', sessionId: THREAD }));
    await exec.stop();
    const stopped = await exec.result;
    expect(stopped.status).toBe('stopped');
    expect(stopped.sessionId).toBe(THREAD);

    const slow = await adapter.start(input('MODE=hang', { timeoutMs: 300 })).result;
    expect(slow.status).toBe('timeout');
    expect(slow).not.toHaveProperty('errorKind');
  });

  it('fails cleanly when the CLI is not installed, and removes the schema file', async () => {
    const { input } = setup();
    const result = await new CodexAdapter('/nonexistent/codex').start(
      input('x', { outputSchema: REVIEW_REPORT_JSON_SCHEMA }),
    ).result;
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/无法启动 \/nonexistent\/codex/);
    expect(result).not.toHaveProperty('errorKind');

    setLang('en');
    const en = await new CodexAdapter('/nonexistent/codex').start(input('x')).result;
    expect(en.error).toMatch(/^Cannot start \/nonexistent\/codex/);
  });
});

describe('strictOutputSchema', () => {
  /** Every object schema in it, nested ones included. */
  function objects(schema: unknown): Record<string, unknown>[] {
    if (Array.isArray(schema)) return schema.flatMap(objects);
    if (!schema || typeof schema !== 'object') return [];
    const s = schema as Record<string, unknown>;
    const nested = Object.values(s).flatMap((v) => (v && typeof v === 'object' ? objects(v) : []));
    return s.type === 'object' ? [s, ...nested] : nested;
  }

  it('makes every object list all its properties and allow no others', () => {
    for (const schema of [ASSESS_REPORT_JSON_SCHEMA, REVIEW_REPORT_JSON_SCHEMA]) {
      const strict = strictOutputSchema(schema);
      const found = objects(strict);
      expect(found.length).toBeGreaterThan(0);
      for (const o of found) {
        expect(o.additionalProperties).toBe(false);
        expect(o.required).toEqual(Object.keys(o.properties as object));
      }
    }
  });

  it('turns optional properties into nullable ones and drops constraints', () => {
    const strict = strictOutputSchema(ASSESS_REPORT_JSON_SCHEMA) as {
      properties: Record<string, unknown>;
    };
    expect(strict.properties.revisedGoal).toEqual({
      anyOf: [{ type: 'string' }, { type: 'null' }],
    });
    expect(strict.properties.size).toEqual({
      anyOf: [{ type: 'string', enum: ['S', 'M', 'L'] }, { type: 'null' }],
    });
    // minLength and default are left to the Master's validation.
    expect(strict.properties.summary).toEqual({ type: 'string' });
    expect(strict.properties.questions).toEqual({ type: 'array', items: { type: 'string' } });
  });

  it('keeps a schema that is strict already, descriptions included, typing its enums', () => {
    const scout = scoutReportJsonSchema();
    const strict = strictOutputSchema(scout) as typeof scout;
    const proposal = strict.properties.proposals.items.properties;
    // An enum without a type gets one; everything else stays as it was.
    expect(proposal.category).toEqual({
      ...scout.properties.proposals.items.properties.category,
      type: 'string',
    });
    expect(proposal.title).toEqual(scout.properties.proposals.items.properties.title);
    expect(strict.properties.gaps).toEqual(scout.properties.gaps);
    expect(strict.required).toEqual(scout.required);
    expect(strict.properties.proposals.items.required).toEqual(
      scout.properties.proposals.items.required,
    );
  });

  it('dropNullOptionals removes only the nulls of optional properties', () => {
    expect(
      dropNullOptionals(
        {
          verdict: 'go',
          summary: 's',
          questions: [],
          suggestions: [],
          revisedGoal: null,
          size: null,
        },
        ASSESS_REPORT_JSON_SCHEMA,
      ),
    ).toEqual({ verdict: 'go', summary: 's', questions: [], suggestions: [] });
    // A null where the contract requires a value stays, for the Master to reject.
    expect(dropNullOptionals({ summary: null, issues: [] }, REVIEW_REPORT_JSON_SCHEMA)).toEqual({
      summary: null,
      issues: [],
    });
  });
});
