// Unified agent adapter interface: every CLI is started, streamed and stopped the same way.

import type { Effort } from '../config/schema.js';

export interface StartInput {
  workdir: string;
  prompt: string;
  model: string;
  /** Reasoning effort; omitted = the CLI default. */
  effort?: Effort;
  /** Resume this CLI session (rework). */
  resumeSessionId?: string;
  /** "full": the agent may run any command; "safe": edits only. */
  permission: 'full' | 'safe';
  /** JSON Schema of the expected final result, for CLIs that support it. */
  outputSchema?: object;
  /**
   * Only read the workdir (search and read files, no edits or commands), and keep no session.
   * Used for decisions such as scouting; only adapters with `supportsReadOnly` honor it.
   */
  readOnly?: boolean;
  timeoutMs: number;
  extraArgs: string[];
  /**
   * Environment of the CLI process. The engine and the scout pass `prepareAgentEnv` (see
   * `src/adapters/process.ts`): no GitHub or GitLab credentials.
   */
  env: Record<string, string | undefined>;
  /** Raw CLI output is appended here (one line per event for stream-json CLIs). */
  logPath: string;
  /** Called for every normalized event, for live views. */
  onEvent?: (event: AgentEvent) => void;
}

/** Normalized live events. */
export type AgentEvent =
  | { type: 'session'; sessionId: string }
  /** The model the CLI actually uses (e.g. the full id behind an alias). */
  | { type: 'model'; model: string }
  | { type: 'message'; text: string }
  | { type: 'tool'; name: string; summary: string }
  | { type: 'stderr'; text: string };

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface AgentResult {
  /** completed = the CLI finished its turn; this says nothing about the quality of the work. */
  status: 'completed' | 'failed' | 'stopped' | 'timeout';
  sessionId?: string;
  finalMessage: string;
  /** Structured result as reported by the CLI (schema-validated by the caller). */
  structured?: unknown;
  usage: AgentUsage;
  /** Only CLIs that report cost (Claude Code); otherwise estimated by the Master. */
  costUsd?: number;
  permissionDenials: string[];
  /** Human readable error when status is failed. */
  error?: string;
  /**
   * What kind of failure it was, when the CLI tells: `rate_limited` = out of quota or
   * rate-limited. That passes on its own, so the Master waits and runs the task again instead of
   * counting it as an agent error.
   */
  errorKind?: 'rate_limited';
  /** With `rate_limited`: when the quota comes back (ISO time), if the CLI said. */
  retryAt?: string;
  exitCode: number | null;
}

export interface AgentExecution {
  pid?: number;
  /** The command line, recorded so orphaned processes can be identified after a crash. */
  command: string;
  result: Promise<AgentResult>;
  /** SIGTERM the process group, SIGKILL after a grace period. Resolves when it has exited. */
  stop(): Promise<void>;
}

export interface AgentAdapter {
  readonly cli: string;
  /** Whether `StartInput.readOnly` is enforced by the CLI. */
  readonly supportsReadOnly?: boolean;
  start(input: StartInput): AgentExecution;
}

export const EMPTY_USAGE: AgentUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

/** The CLIs of these adapters that can run an agent read-only (`supportsReadOnly`). */
export function readOnlyClis(adapters: Iterable<AgentAdapter>): string[] {
  return [...adapters].filter((a) => a.supportsReadOnly === true).map((a) => a.cli);
}
