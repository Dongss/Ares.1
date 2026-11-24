import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { t } from '../i18n.js';
import { runProcess } from './process.js';
import { rateLimitFromText } from './rate-limit.js';
import { summarizeToolInput } from './tool-summary.js';
import {
  type AgentAdapter,
  type AgentEvent,
  type AgentExecution,
  type AgentResult,
  type AgentUsage,
  EMPTY_USAGE,
  type StartInput,
} from './types.js';

/**
 * Codex CLI adapter (command line checked against `codex exec --help` of codex-cli 0.172):
 *   codex exec --json --skip-git-repo-check --ignore-user-config --ignore-rules --model <m>
 *     --sandbox <read-only|workspace-write> -c approval_policy="never"
 *     [-c sandbox_workspace_write.network_access=true] [-c model_reasoning_effort="<e>"]
 *     [--ephemeral] [--output-schema <file>] [<args>] [resume <session id>] -
 * The prompt is sent on stdin (`-`); the workdir is the process's cwd.
 * - Read-only: the read-only sandbox (Codex still runs shell commands to read and search, but they
 *   cannot write), `--ephemeral` so no session is kept, and never a resume.
 * - "full": the workspace-write sandbox (edits and commands in the workdir, with network access)
 *   and no approvals, which nobody could give. "safe" has no Codex equivalent: Codex edits through
 *   its shell and patch tools, so it gets the same sandbox without network access, and loading
 *   agents.yaml warns about it.
 * - Effort: the five values of `effort` are also Codex's names of reasoning efforts (low, medium,
 *   high, xhigh, max), passed as they are; which of them a model supports is up to the model.
 * - The user's ~/.codex/config.toml and execution rules are not read, as Claude Code leaves out
 *   the user's settings: personal MCP servers, hooks and approved commands (which may carry
 *   credentials, or run commands outside the sandbox) stay out of agent runs. The login in
 *   CODEX_HOME still applies; settings an agent needs go in its `args` as `-c key=value`.
 * - The output schema goes to a temporary file, in the strict form Codex's API requires.
 * Codex reports tokens but no cost; the Master estimates it from the agent's price, if any.
 */
export class CodexAdapter implements AgentAdapter {
  readonly cli = 'codex';
  readonly supportsReadOnly = true;

  constructor(private readonly bin = 'codex') {}

  buildArgs(input: StartInput, schemaFile?: string): string[] {
    const readOnly = input.readOnly === true;
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--ignore-rules',
      '--model',
      input.model,
      '--sandbox',
      readOnly ? 'read-only' : 'workspace-write',
      '-c',
      'approval_policy="never"',
    ];
    if (!readOnly && input.permission === 'full') {
      args.push('-c', 'sandbox_workspace_write.network_access=true');
    }
    if (input.effort) args.push('-c', `model_reasoning_effort="${input.effort}"`);
    if (readOnly) args.push('--ephemeral');
    if (schemaFile) args.push('--output-schema', schemaFile);
    // Before the resume subcommand: exec's own options are not taken after it.
    args.push(...input.extraArgs);
    const resume = readOnly ? undefined : input.resumeSessionId;
    if (resume) args.push('resume', resume);
    args.push('-');
    return args;
  }

  start(input: StartInput): AgentExecution {
    const schemaDir = input.outputSchema ? writeSchema(input.outputSchema) : undefined;
    const schemaFile = schemaDir && join(schemaDir, 'schema.json');
    const parser = new CodexJsonParser(input.onEvent, input.workdir);
    const resumed = input.readOnly ? undefined : input.resumeSessionId;
    const proc = runProcess({
      bin: this.bin,
      args: this.buildArgs(input, schemaFile),
      cwd: input.workdir,
      env: input.env,
      stdin: input.prompt,
      timeoutMs: input.timeoutMs,
      logPath: input.logPath,
      onStdoutLine: (line) => parser.feed(line),
      onStderr: (text) => input.onEvent?.({ type: 'stderr', text }),
    });

    const result = proc.done.then((outcome): AgentResult => {
      if (schemaDir) rmSync(schemaDir, { recursive: true, force: true });
      const parsed = parser.toResult(outcome.exitCode, input.outputSchema);
      if (!parsed.sessionId && resumed) parsed.sessionId = resumed;
      // Not started, stopped or timed out: a limit the CLI reported on the way is not why it ended.
      const { errorKind: _kind, retryAt: _at, ...ended } = parsed;
      const base = outcome.ended === 'exit' ? parsed : ended;
      if (outcome.ended === 'spawn_error') {
        return {
          ...base,
          status: 'failed',
          error: t({
            zh: `无法启动 ${this.bin}：${outcome.spawnError}`,
            en: `Cannot start ${this.bin}: ${outcome.spawnError}`,
          }),
        };
      }
      if (outcome.ended === 'stopped') {
        // An error event on the way (a retry, say) is not why it ended.
        const { error: _error, ...stopped } = base;
        return { ...stopped, status: 'stopped' };
      }
      if (outcome.ended === 'timeout') {
        return { ...base, status: 'timeout', error: t({ zh: '执行超时', en: 'Timed out' }) };
      }
      if (base.status === 'failed' && !base.error) {
        // No error event: e.g. a bad argument, exit code 2, the reason on stderr.
        const stderr = outcome.stderrTail.trim();
        const limit = rateLimitFromText(stderr);
        return {
          ...base,
          error:
            stderr ||
            t({
              zh: `进程退出码 ${outcome.exitCode}，没有输出结果`,
              en: `The process exited with code ${outcome.exitCode} and no result`,
            }),
          ...(limit ? { errorKind: 'rate_limited' as const, ...limit } : {}),
        };
      }
      return base;
    });

    return { pid: proc.pid, command: proc.command, result, stop: proc.stop };
  }
}

/**
 * Writes the output schema, in its strict form, to a new temporary directory and returns the
 * directory; undefined when that fails: the prompt still describes the result, and the Master
 * validates it anyway.
 */
function writeSchema(schema: object): string | undefined {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), 'ares1-codex-'));
    writeFileSync(join(dir, 'schema.json'), JSON.stringify(strictOutputSchema(schema)));
    return dir;
  } catch {
    if (dir) rmSync(dir, { recursive: true, force: true });
    return undefined;
  }
}

/** Keywords kept in the schema sent to Codex: the structure. Constraints are left to the Master. */
const STRICT_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'description',
  'title',
  '$ref',
  '$defs',
  'definitions',
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A JSON Schema in the strict form Codex's API takes (OpenAI structured outputs, strict mode):
 * every object lists all its properties as required and allows no others, so an optional
 * property becomes required and nullable (`dropNullOptionals` removes the nulls again), and an
 * enum of strings without a type gets one; keywords strict mode may reject (minLength, default,
 * ...) are dropped, as the Master validates the result against the full contract anyway.
 */
export function strictOutputSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictOutputSchema);
  if (!isRecord(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!STRICT_KEYWORDS.has(key)) continue;
    if ((key === 'properties' || key === '$defs' || key === 'definitions') && isRecord(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, sub]) => [name, strictOutputSchema(sub)]),
      );
    } else if (key === 'items' || key === 'anyOf') {
      out[key] = strictOutputSchema(value);
    } else {
      out[key] = value;
    }
  }
  // Strict mode wants a type on every schema, an enum's too.
  if (
    out.type === undefined &&
    Array.isArray(out.enum) &&
    out.enum.every((v) => typeof v === 'string')
  ) {
    out.type = 'string';
  }
  if (isRecord(out.properties)) {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const [name, sub] of Object.entries(out.properties)) {
      if (!required.has(name)) out.properties[name] = nullable(sub);
    }
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
  }
  return out;
}

function nullable(schema: unknown): unknown {
  if (!isRecord(schema)) return { anyOf: [schema, { type: 'null' }] };
  const { description, ...rest } = schema;
  return { ...(description ? { description } : {}), anyOf: [rest, { type: 'null' }] };
}

/**
 * Removes the nulls `strictOutputSchema` made the model write for properties `schema` (the
 * original one) leaves optional, so that the result matches the original contract.
 */
export function dropNullOptionals(value: unknown, schema: unknown): unknown {
  if (!isRecord(schema)) return value;
  if (Array.isArray(value)) return value.map((v) => dropNullOptionals(v, schema.items));
  if (!isRecord(value)) return value;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === null && key in properties && !required.has(key)) continue;
    out[key] = dropNullOptionals(v, properties[key]);
  }
  return out;
}

const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Parses `codex exec --json` output (one JSON object per line). Event shapes as seen with
 * codex-cli 0.172: thread.started (thread_id), turn.started, item.started / item.updated /
 * item.completed (item.type agent_message, reasoning, command_execution, file_change,
 * mcp_tool_call, web_search, todo_list, error), turn.completed (usage), turn.failed (error), and
 * error (message). No model is reported.
 */
export class CodexJsonParser {
  sessionId: string | undefined;
  private lastMessage = '';
  private usage: AgentUsage | undefined;
  private completed = false;
  private turnFailed = false;
  /** The CLI's own error texts: of turn.failed, and the last error event. */
  private failure: string | undefined;
  private lastError: string | undefined;
  /** Items whose tool call was already shown when they started. */
  private readonly shown = new Set<string>();
  /** The workdir as given and as resolved (the CLI reports paths under the resolved one). */
  private readonly roots: string[] = [];

  constructor(
    private readonly onEvent?: (e: AgentEvent) => void,
    /** Paths of changed files are shown relative to it. */
    workdir?: string,
  ) {
    if (!workdir) return;
    this.roots.push(workdir);
    try {
      const real = realpathSync(workdir);
      if (real !== workdir) this.roots.push(real);
    } catch {
      // not there (yet): paths are shown relative to it as given
    }
  }

  feed(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!isRecord(event)) return;
    switch (event.type) {
      case 'thread.started': {
        const sid = text(event.thread_id);
        if (sid && sid !== this.sessionId) {
          this.sessionId = sid;
          this.onEvent?.({ type: 'session', sessionId: sid });
        }
        break;
      }
      case 'item.started':
        if (isRecord(event.item)) this.handleItem(event.item, false);
        break;
      case 'item.completed':
        if (isRecord(event.item)) this.handleItem(event.item, true);
        break;
      case 'turn.completed':
        this.completed = true;
        if (isRecord(event.usage)) {
          const cached = count(event.usage.cached_input_tokens);
          this.usage = {
            // input_tokens includes the cached ones; here they are counted apart, as elsewhere.
            inputTokens: Math.max(0, count(event.usage.input_tokens) - cached),
            outputTokens: count(event.usage.output_tokens),
            cachedTokens: cached,
          };
        }
        break;
      case 'turn.failed': {
        this.turnFailed = true;
        const error = isRecord(event.error) ? text(event.error.message)?.trim() : undefined;
        if (error) this.failure = error;
        break;
      }
      case 'error': {
        // Also sent for retries on the way ("Reconnecting... 1/5"); fatal only with turn.failed.
        const message = text(event.message)?.trim();
        if (!message) break;
        this.lastError = message;
        this.onEvent?.({ type: 'stderr', text: message });
        break;
      }
    }
  }

  private handleItem(item: Record<string, unknown>, done: boolean): void {
    const id = text(item.id);
    if (item.type === 'agent_message') {
      const message = text(item.text);
      if (done && message?.trim()) {
        this.lastMessage = message;
        this.onEvent?.({ type: 'message', text: message });
      }
      return;
    }
    if (item.type === 'error') {
      // A warning the turn goes on after (an ignored setting, say), not the CLI's failure.
      const message = text(item.message)?.trim();
      if (done && message) this.onEvent?.({ type: 'stderr', text: message });
      return;
    }
    const tool = this.toolCall(item);
    if (!tool) return;
    // Shown once, when it starts; items with no started event when they complete.
    if (id && this.shown.has(id)) return;
    if (id) this.shown.add(id);
    this.onEvent?.({ type: 'tool', ...tool });
  }

  private toolCall(item: Record<string, unknown>): { name: string; summary: string } | undefined {
    switch (item.type) {
      case 'command_execution':
        return { name: 'Shell', summary: summarizeToolInput({ command: text(item.command) }) };
      case 'file_change': {
        const changes = Array.isArray(item.changes) ? item.changes.filter(isRecord) : [];
        const files = changes.map((c) => `${text(c.kind) ?? '?'} ${this.path(text(c.path))}`);
        return { name: 'Edit', summary: summarizeToolInput({ path: files.join(', ') }) };
      }
      case 'mcp_tool_call':
        return {
          name: `mcp:${text(item.server) ?? '?'}/${text(item.tool) ?? '?'}`,
          summary: summarizeToolInput(item.arguments ?? {}),
        };
      case 'web_search':
        return { name: 'WebSearch', summary: summarizeToolInput({ pattern: text(item.query) }) };
      default:
        return undefined;
    }
  }

  private path(path: string | undefined): string {
    if (!path) return '?';
    if (!isAbsolute(path)) return path;
    for (const root of this.roots) {
      const rel = relative(root, path);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
    }
    return path;
  }

  /**
   * @param outputSchema the schema the run was given: the final message is then the structured
   * result.
   */
  toResult(exitCode: number | null, outputSchema?: object): AgentResult {
    const failed = !this.completed || this.turnFailed;
    // The CLI's own error texts; the agent's replies are never looked at, they may well talk
    // about rate limits.
    const errorText = failed
      ? [...new Set([this.failure, this.lastError].filter((e): e is string => !!e))].join('\n')
      : '';
    const limit = failed ? rateLimitFromText(errorText) : undefined;
    return {
      status: failed ? 'failed' : 'completed',
      sessionId: this.sessionId,
      finalMessage: this.lastMessage,
      structured: !failed && outputSchema ? this.structured(outputSchema) : undefined,
      usage: this.usage ?? { ...EMPTY_USAGE },
      permissionDenials: [],
      exitCode,
      error: errorText || undefined,
      ...(limit ? { errorKind: 'rate_limited' as const, ...limit } : {}),
    };
  }

  /** With an output schema, the final message is the JSON result. */
  private structured(schema: object): unknown {
    try {
      return dropNullOptionals(JSON.parse(this.lastMessage), schema);
    } catch {
      return undefined;
    }
  }
}
