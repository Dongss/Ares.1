import { t } from '../i18n.js';
import { runProcess } from './process.js';
import { summarizeToolInput } from './tool-summary.js';
import {
  type AgentAdapter,
  type AgentEvent,
  type AgentExecution,
  type AgentResult,
  EMPTY_USAGE,
  type StartInput,
} from './types.js';

/**
 * cursor-agent adapter:
 *   cursor-agent -p --output-format stream-json --trust --model <m> [--force] [--resume <id>]
 * The prompt is sent on stdin. Effort is part of the model name (e.g. grok-4.7-high), so
 * `effort` is not used. The CLI reports tokens but no cost; the Master estimates it from the
 * agent's configured price, if any.
 */
export class CursorAgentAdapter implements AgentAdapter {
  readonly cli = 'cursor-agent';

  constructor(private readonly bin = 'cursor-agent') {}

  buildArgs(input: StartInput): string[] {
    const args = ['-p', '--output-format', 'stream-json', '--trust', '--model', input.model];
    // Without --force, commands need an approval nobody can give in print mode.
    if (input.permission === 'full') args.push('--force');
    if (input.resumeSessionId) args.push('--resume', input.resumeSessionId);
    args.push(...input.extraArgs);
    return args;
  }

  start(input: StartInput): AgentExecution {
    const parser = new CursorStreamParser(input.onEvent);
    const proc = runProcess({
      bin: this.bin,
      args: this.buildArgs(input),
      cwd: input.workdir,
      stdin: input.prompt,
      timeoutMs: input.timeoutMs,
      logPath: input.logPath,
      onStdoutLine: (line) => parser.feed(line),
      onStderr: (text) => input.onEvent?.({ type: 'stderr', text }),
    });

    const result = proc.done.then((outcome): AgentResult => {
      const base = parser.toResult(outcome.exitCode);
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
        // e.g. an unknown model: exit code 1, nothing on stdout, the reason on stderr.
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

interface CursorResultEvent {
  type: 'result';
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

/**
 * Parses cursor-agent's stream-json output (one JSON object per line). Event shapes as seen
 * with cursor-agent 2026.11: system/init (session_id, model), assistant (message.content),
 * tool_call started/completed (tool_call.<kind>ToolCall.args), thinking deltas, result.
 */
export class CursorStreamParser {
  sessionId: string | undefined;
  private lastText = '';
  private result: CursorResultEvent | undefined;

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
      case 'tool_call':
        if (event.subtype === 'started') this.handleToolCall(event.tool_call);
        break;
      case 'result':
        this.result = event as unknown as CursorResultEvent;
        break;
    }
  }

  private handleAssistant(message: unknown): void {
    const content = (message as { content?: unknown[] } | undefined)?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Record<string, unknown>[]) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        this.lastText = block.text;
        this.onEvent?.({ type: 'message', text: block.text });
      }
    }
  }

  /** `{ shellToolCall: { args: { command } } }` → tool "Shell", summary "<command>". */
  private handleToolCall(toolCall: unknown): void {
    if (!toolCall || typeof toolCall !== 'object') return;
    const entry = Object.entries(toolCall as Record<string, unknown>).find(([key]) =>
      key.endsWith('ToolCall'),
    );
    if (!entry) return;
    const [key, value] = entry;
    const kind = key.slice(0, -'ToolCall'.length);
    const name = kind ? kind[0]?.toUpperCase() + kind.slice(1) : '?';
    const args = (value as { args?: unknown } | undefined)?.args;
    this.onEvent?.({ type: 'tool', name, summary: summarizeToolInput(args) });
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
      };
    }
    const failed = r.is_error === true || (r.subtype !== undefined && r.subtype !== 'success');
    return {
      status: failed ? 'failed' : 'completed',
      sessionId: r.session_id ?? this.sessionId,
      // `result` joins every reply of the turn; the last reply is the one with the report.
      finalMessage: this.lastText || r.result || '',
      usage: {
        inputTokens: (r.usage?.inputTokens ?? 0) + (r.usage?.cacheWriteTokens ?? 0),
        outputTokens: r.usage?.outputTokens ?? 0,
        cachedTokens: r.usage?.cacheReadTokens ?? 0,
      },
      permissionDenials: [],
      exitCode,
      error: failed
        ? r.result || t({ zh: `失败（${r.subtype}）`, en: `Failed (${r.subtype})` })
        : undefined,
    };
  }
}
