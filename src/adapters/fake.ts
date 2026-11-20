import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type AgentAdapter,
  type AgentExecution,
  type AgentResult,
  EMPTY_USAGE,
  type StartInput,
} from './types.js';

export interface FakeContext {
  input: StartInput;
  /** Session id of this execution (the resumed one when resuming). */
  sessionId: string;
  /** Aborted when the execution is stopped. */
  signal: AbortSignal;
}

/** What a scripted fake run returns; anything left out gets a sensible default. */
export type FakeOutcome = Partial<Omit<AgentResult, 'usage'>> & {
  usage?: Partial<AgentResult['usage']>;
};

export type FakeScript = (ctx: FakeContext) => FakeOutcome | Promise<FakeOutcome>;

/**
 * Scripted stand-in for a real CLI. The script may modify files in `input.workdir`
 * and decides what the "agent" reports. Used by tests; costs nothing and is deterministic.
 */
export class FakeAdapter implements AgentAdapter {
  readonly cli: string;
  readonly supportsReadOnly = true;
  readonly calls: StartInput[] = [];

  constructor(
    private script: FakeScript,
    cli = 'fake',
  ) {
    this.cli = cli;
  }

  setScript(script: FakeScript): void {
    this.script = script;
  }

  start(input: StartInput): AgentExecution {
    this.calls.push(input);
    const controller = new AbortController();
    const sessionId = input.resumeSessionId ?? randomUUID();
    mkdirSync(dirname(input.logPath), { recursive: true });
    const log = (obj: unknown) => appendFileSync(input.logPath, `${JSON.stringify(obj)}\n`);
    log({ type: 'start', sessionId, prompt: input.prompt });
    input.onEvent?.({ type: 'session', sessionId });

    const stopped = new Promise<'stopped'>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve('stopped'), { once: true });
    });

    const result = (async (): Promise<AgentResult> => {
      const run = Promise.resolve(this.script({ input, sessionId, signal: controller.signal }));
      const outcome = await Promise.race([run, stopped]);
      if (outcome === 'stopped') {
        log({ type: 'stopped' });
        return {
          status: 'stopped',
          sessionId,
          finalMessage: '',
          usage: { ...EMPTY_USAGE },
          permissionDenials: [],
          exitCode: 143,
        };
      }
      const res: AgentResult = {
        status: outcome.status ?? 'completed',
        sessionId,
        finalMessage: outcome.finalMessage ?? '',
        structured: outcome.structured,
        usage: { ...EMPTY_USAGE, ...outcome.usage },
        costUsd: outcome.costUsd,
        permissionDenials: outcome.permissionDenials ?? [],
        error: outcome.error,
        exitCode: outcome.exitCode ?? (outcome.status === 'failed' ? 1 : 0),
      };
      if (res.finalMessage) input.onEvent?.({ type: 'message', text: res.finalMessage });
      log({ type: 'result', ...res });
      return res;
    })();

    return {
      command: `fake ${input.model}`,
      result,
      stop: async () => {
        controller.abort();
        await result;
      },
    };
  }
}
