import { randomUUID } from 'node:crypto';
import { t } from '../i18n.js';
import { runProcess } from './process.js';
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
 * Claude Code adapter:
 *   claude -p --output-format stream-json --verbose --model <m> [--effort <e>]
 *     --permission-mode auto --setting-sources project,local --strict-mcp-config
 *     [--session-id <uuid> | --resume <id>] [--json-schema <schema>]
 * The prompt is sent on stdin to avoid argument length limits.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly cli = 'claude-code';
  readonly supportsReadOnly = true;

  constructor(private readonly bin = 'claude') {}

  buildArgs(input: StartInput, sessionId: string | undefined): string[] {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', input.model];
    if (input.effort) args.push('--effort', input.effort);
    const mode = input.readOnly ? 'default' : input.permission === 'full' ? 'auto' : 'acceptEdits';
    args.push(
      '--permission-mode',
      mode,
      // Keep the user's personal hooks / MCP servers out of agent runs.
      '--setting-sources',
      'project,local',
      '--strict-mcp-config',
    );
    if (input.resumeSessionId) args.push('--resume', input.resumeSessionId);
    else if (sessionId) args.push('--session-id', sessionId);
    if (input.outputSchema) args.push('--json-schema', JSON.stringify(input.outputSchema));
    // Read-only tools only; nothing to resume later, so keep no session on disk.
    if (input.readOnly) args.push('--tools', 'Read,Grep,Glob', '--no-session-persistence');
    args.push(...input.extraArgs);
    return args;
  }

  start(input: StartInput): AgentExecution {
    // Pre-assign the session id so it is known before the CLI prints anything.
    const preassigned = input.resumeSessionId ? undefined : randomUUID();
    const parser = new StreamJsonParser(input.onEvent);
    if (preassigned) {
      parser.sessionId = preassigned;
      input.onEvent?.({ type: 'session', sessionId: preassigned });
    }

    const proc = runProcess({
      bin: this.bin,
      args: this.buildArgs(input, preassigned),
      cwd: input.workdir,
      env: input.env,
      stdin: input.prompt,
      timeoutMs: input.timeoutMs,
      logPath: input.logPath,
      onStdoutLine: (line) => parser.feed(line),
      onStderr: (text) => input.onEvent?.({ type: 'stderr', text }),
    });

    const result = proc.done.then((outcome): AgentResult => {
      const parsed = parser.toResult(outcome.exitCode);
      // Not started, stopped or timed out: a limit the CLI hit on the way is not why it ended.
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
      if (outcome.ended === 'stopped') return { ...base, status: 'stopped' };
      if (outcome.ended === 'timeout') {
        return { ...base, status: 'timeout', error: t({ zh: '执行超时', en: 'Timed out' }) };
      }
      if (base.status === 'failed' && !base.error) {
        return {
          ...base,
          error:
            outcome.stderrTail.trim() ||
            t({
              zh: `进程退出码 ${outcome.exitCode}，没有输出结果`,
              en: `The process exited with code ${outcome.exitCode} and no result`,
            }),
        };
      }
      return base;
    });

    return { pid: proc.pid, command: proc.command, result, stop: proc.stop };
  }
}

interface ResultEvent {
  type: 'result';
  subtype?: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  session_id?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  permission_denials?: { tool_name?: string; tool_input?: unknown }[];
  structured_output?: unknown;
}

/** Parses Claude Code's stream-json output (one JSON object per line). */
export class StreamJsonParser {
  sessionId: string | undefined;
  private lastText = '';
  private result: ResultEvent | undefined;
  private rateLimited = false;
  /** When the quota is back (epoch ms), from the rate limit events. */
  private resetAt: number | undefined;

  constructor(private readonly onEvent?: (e: AgentEvent) => void) {}

  feed(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    const sid = typeof event.session_id === 'string' ? event.session_id : undefined;
    if (sid && sid !== this.sessionId) {
      this.sessionId = sid;
      this.onEvent?.({ type: 'session', sessionId: sid });
    }
    switch (event.type) {
      case 'system':
        if (event.subtype === 'init' && typeof event.model === 'string' && event.model) {
          this.onEvent?.({ type: 'model', model: event.model });
        }
        break;
      case 'assistant':
        this.handleAssistant(event.message);
        break;
      case 'rate_limit_event':
        this.handleRateLimit(event.rate_limit_info);
        break;
      case 'result':
        this.result = event as unknown as ResultEvent;
        break;
    }
  }

  /**
   * `rate_limit_info.status` is `allowed`, `allowed_warning` (close to a limit, still allowed) or
   * something else when a limit is hit (`rejected`). Of the limits hit, the latest reset time
   * counts: the quota is back only once every one of them has reset.
   */
  private handleRateLimit(info: unknown): void {
    if (!info || typeof info !== 'object') return;
    const { status, resetsAt, resets_at } = info as Record<string, unknown>;
    if (typeof status !== 'string' || !status || status.startsWith('allowed')) return;
    this.rateLimited = true;
    const reset = resetTime(resetsAt ?? resets_at);
    if (reset !== undefined) this.resetAt = Math.max(this.resetAt ?? reset, reset);
  }

  private handleAssistant(message: unknown): void {
    const content = (message as { content?: unknown[] } | undefined)?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Record<string, unknown>[]) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        this.lastText = block.text;
        this.onEvent?.({ type: 'message', text: block.text });
      } else if (block.type === 'tool_use') {
        this.onEvent?.({
          type: 'tool',
          name: String(block.name ?? '?'),
          summary: summarizeToolInput(block.input),
        });
      }
    }
  }

  /** Marks a failure as a rate limit when a limit was hit on the way, with its reset time. */
  private limitFields(): Pick<AgentResult, 'errorKind' | 'retryAt'> {
    if (!this.rateLimited) return {};
    return {
      errorKind: 'rate_limited',
      ...(this.resetAt !== undefined ? { retryAt: new Date(this.resetAt).toISOString() } : {}),
    };
  }

  toResult(exitCode: number | null): AgentResult {
    const r = this.result;
    if (!r) {
      return {
        status: 'failed',
        sessionId: this.sessionId,
        finalMessage: this.lastText,
        usage: { ...EMPTY_USAGE },
        permissionDenials: [],
        exitCode,
        error: this.rateLimited
          ? t({ zh: '额度用尽或被限流', en: 'Out of quota or rate-limited' })
          : undefined,
        ...this.limitFields(),
      };
    }
    const usage: AgentUsage = {
      inputTokens: (r.usage?.input_tokens ?? 0) + (r.usage?.cache_creation_input_tokens ?? 0),
      outputTokens: r.usage?.output_tokens ?? 0,
      cachedTokens: r.usage?.cache_read_input_tokens ?? 0,
    };
    const failed = r.is_error === true || (r.subtype !== undefined && r.subtype !== 'success');
    return {
      status: failed ? 'failed' : 'completed',
      sessionId: r.session_id ?? this.sessionId,
      finalMessage: r.result ?? this.lastText,
      structured: r.structured_output,
      usage,
      costUsd: r.total_cost_usd,
      permissionDenials: (r.permission_denials ?? []).map(
        (d) => `${d.tool_name ?? '?'}: ${summarizeToolInput(d.tool_input)}`,
      ),
      exitCode,
      error: failed
        ? [r.result, ...(r.errors ?? [])].filter(Boolean).join('\n') ||
          t({ zh: `失败（${r.subtype}）`, en: `Failed (${r.subtype})` })
        : undefined,
      // A limit hit on the way does not matter once the turn finished.
      ...(failed ? this.limitFields() : {}),
    };
  }
}

/**
 * A reset time as the CLI writes it, in epoch milliseconds: epoch seconds or milliseconds (a
 * number below 1e12 is taken as seconds, which reaches to the year 33658), or an ISO time.
 */
export function resetTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return resetTime(n);
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}
