import type { RunOverrides, WorkflowTemplate } from '../config/schema.js';

// State machines: see the status types below and how src/engine/engine.ts moves between them.

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'blocked'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  /**
   * Ended by the requirement assessment: a human agreed not to do it, or nobody replied to its
   * questions in time and it concluded not to. Not a failure.
   */
  | 'dropped';

export const FINISHED_RUN_STATUSES: readonly RunStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'dropped',
];

export type StageRunStatus = 'pending' | 'executing' | 'waiting_approval' | 'passed' | 'failed';
export type TaskStatus = 'pending' | 'running' | 'verifying' | 'passed' | 'failed' | 'cancelled';
export type AttemptStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'timeout'
  | 'interrupted';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface Repo {
  id: string;
  name: string;
  path: string;
  targetBranch: string;
  /** Default verify commands when a stage does not set its own. */
  verifyCommands: string[];
  /** Run once after the Run's worktree is created, e.g. ["npm ci"]. */
  setupCommands: string[];
  mergeMode: 'direct';
  createdAt: string;
}

export type BlockKind =
  | 'task_failed'
  | 'agent_error'
  | 'agent_unavailable'
  | 'max_loops'
  | 'merge_conflict'
  | 'target_dirty'
  | 'setup_failed'
  /** The worktree is missing or its history no longer matches the record. */
  | 'workspace'
  /** The Run's cost reached its budget before starting another agent execution. */
  | 'budget'
  /**
   * The requirement assessment has questions; waits for a human's reply, at most the assess
   * stage's `reply_timeout_hours`.
   */
  | 'discussion'
  | 'error';

/** Why a Run is blocked; also tells `retry` what to redo. */
export interface BlockInfo {
  kind: BlockKind;
  message: string;
  taskId?: string;
  stageRunId?: string;
}

export interface Run {
  id: string;
  repoId: string;
  templateId: string;
  /** Snapshot taken when the Run is created. */
  template: WorkflowTemplate;
  goal: string;
  overrides: RunOverrides;
  status: RunStatus;
  /** Order in the queue; smaller runs first. Only meaningful while queued. */
  queuePos: number | null;
  currentStageRunId: string | null;
  branch: string | null;
  worktreePath: string | null;
  baseCommit: string | null;
  /**
   * The last commit of the worktree the Master accepted: the base, then each task commit and
   * each checked merge of the target branch. Recovery resets to it; the consistency check
   * compares the worktree against it. Null for Runs created before it was recorded.
   */
  headCommit: string | null;
  blocked: BlockInfo | null;
  /**
   * The GitHub issue this Run was created from. Null only for Runs created on the dashboard
   * before Runs came only from issues (and for Runs tests create directly).
   */
  issue: RunIssue | null;
  /** The last Run status reported on the issue; the issue is caught up when it differs. */
  issueSynced: RunStatus | null;
  /** Extra stage rollbacks granted by a human after hitting max_loops. */
  extraLoops: number;
  /** The requirement assessment and the replies to it, oldest first; empty without one. */
  discussion: DiscussionEntry[];
  /** How many entries of `discussion` were handled on the issue (posted, or came from it). */
  issueDiscussionSynced: number;
  error: string | null;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface RunIssue {
  /** "owner/name". */
  repo: string;
  number: number;
  url: string;
  /** Accepted by the Master without a human. */
  auto: boolean;
}

/**
 * What an assessment concluded. go: start the work; ask: questions for a human first (also when
 * it thinks the requirement should not be done); drop: not doing it, only after a human agreed or
 * after nobody replied to the questions in time.
 */
export type AssessVerdict = 'go' | 'ask' | 'drop';

/** The result of one round of a requirement assessment. */
export interface AssessmentEntry {
  role: 'assessor';
  /** As the Master took it: a drop before any human reply counts as ask. */
  verdict: AssessVerdict;
  /** Opinion and the assumptions it made (go), what is unclear (ask), why not (drop). */
  summary: string;
  /** Questions and concerns a human should answer (ask). */
  questions: string[];
  /** How the requirement could be changed (ask). */
  suggestions: string[];
  /** go after a discussion that changed the requirement: the complete new requirement. */
  revisedGoal: string | null;
  /** The agent said drop before any human reply; a human is asked to confirm instead. */
  proposedDrop: boolean;
  /**
   * Concluded on its own after nobody replied to the questions in time: go on the assumptions in
   * `summary`, or drop. Missing in entries recorded before replies could time out.
   */
  decidedAlone?: boolean;
  stageRunId: string;
  at: string;
}

/** A human's reply to an assessment's questions. */
export interface ReplyEntry {
  role: 'human';
  text: string;
  /** Written on the issue, or on the dashboard (Run detail). */
  source: 'issue' | 'dashboard';
  at: string;
}

/**
 * Nobody replied to the assessment's questions within the assess stage's `reply_timeout_hours`:
 * the next round decides on its own (go with its assumptions, or drop).
 */
export interface ReplyTimeoutEntry {
  role: 'timeout';
  /** The configured wait, in hours; 0 = the stage does not wait for replies. */
  hours: number;
  at: string;
}

export type DiscussionEntry = AssessmentEntry | ReplyEntry | ReplyTimeoutEntry;

export type ScoutStatus = 'running' | 'completed' | 'failed' | 'interrupted';

/** One issue proposed by a scout. */
export interface ScoutProposal {
  title: string;
  category: 'bug' | 'feature' | 'improvement' | 'docs' | 'test' | 'refactor';
  size: 'S' | 'M' | 'L';
  risk: 'low' | 'mid' | 'high';
  why: string;
  evidence: string[];
  what: string;
  acceptance: string[];
  /** Set once the issue is created. */
  issue?: { number: number; url: string; auto: boolean };
  /** Why the issue could not be created. */
  error?: string;
}

/** An AI scout: a read-only agent run that proposes issues. */
export interface Scout {
  id: string;
  repoId: string;
  /** "owner/name" of the issues. */
  issuesRepo: string;
  /** auto: started by the Master when the repo was idle. */
  trigger: 'manual' | 'auto';
  status: ScoutStatus;
  agentId: string;
  model: string | null;
  proposals: ScoutProposal[];
  costUsd: number | null;
  error: string | null;
  logPath: string;
  startedAt: string;
  endedAt: string | null;
}

export type StageFailReason = 'check' | 'review' | 'rejected';

export interface StageRun {
  id: string;
  runId: string;
  stageId: string;
  round: number;
  status: StageRunStatus;
  /** Why this round exists: feedback carried over from the stage that rolled back to it. */
  feedback: string | null;
  failReason: StageFailReason | null;
  failFeedback: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface Task {
  id: string;
  runId: string;
  stageRunId: string;
  seq: number;
  title: string;
  instructions: string;
  agentId: string;
  status: TaskStatus;
  retries: number;
  /** HEAD before the first attempt; the task rolls back here when it finally fails. */
  baseCommit: string | null;
  commitSha: string | null;
  /** CLI session of the last attempt, resumed on rework. */
  sessionId: string | null;
  sessionAgentId: string | null;
  /** Feedback to give the agent in the next attempt. */
  pendingFeedback: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AttemptOutcome = 'passed' | 'rework' | 'agent_error';

export interface Attempt {
  id: string;
  taskId: string;
  runId: string;
  seq: number;
  agentId: string;
  /** Model as configured for the agent when the attempt started, e.g. "opus". */
  model: string | null;
  /** Model the CLI reported it actually uses, e.g. "claude-opus-5-5"; null until known. */
  actualModel: string | null;
  /** Effort when the attempt started; null = the CLI default. */
  effort: string | null;
  sessionId: string | null;
  status: AttemptStatus;
  outcome: AttemptOutcome | null;
  prompt: string;
  finalMessage: string | null;
  structured: unknown;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number | null;
  logPath: string;
  pid: number | null;
  command: string | null;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
}

/**
 * What one agent did in Runs, over every attempt on record; summed by
 * `Store.agentAttemptTotals()`.
 */
export interface AgentAttemptTotals {
  agentId: string;
  /** Executions, running ones included. */
  attempts: number;
  /** By outcome: passed, sent back for rework, the agent errored (timeouts included). */
  passed: number;
  rework: number;
  agentError: number;
  /**
   * Stopped by a pause or termination, or interrupted by a Master restart; these have no
   * outcome, and neither has a running one or one whose Run was paused while being checked.
   */
  stopped: number;
  /** Known costs; executions that ended without one are counted in `costUnknown`. */
  costUsd: number;
  costUnknown: number;
  /** Start of the latest execution. */
  lastAt: string | null;
  /** The latest execution that recorded an error; stopped and interrupted ones are left out. */
  lastError: AgentLastError | null;
}

export interface AgentLastError {
  attemptId: string;
  runId: string;
  /** When the execution ended (its start if it has no end). */
  at: string;
  /** The first 200 characters of the error, surrounding blank space removed. */
  message: string;
  /** The error is longer than `message`. */
  truncated: boolean;
}

/** Scouts one agent ran; summed by `Store.agentScoutTotals()`. */
export interface AgentScoutTotals {
  agentId: string;
  scouts: number;
  costUsd: number;
  /** Completed scouts without a known cost, as on the statistics page. */
  costUnknown: number;
  /** Start of the latest scout. */
  lastAt: string | null;
}

export type CheckKind = 'result' | 'command' | 'review' | 'merge' | 'assess';

export interface CheckResult {
  id: string;
  runId: string;
  stageRunId: string | null;
  attemptId: string | null;
  kind: CheckKind;
  name: string;
  passed: boolean;
  detail: string;
  createdAt: string;
}

export interface Approval {
  id: string;
  runId: string;
  stageRunId: string;
  status: ApprovalStatus;
  comment: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface Artifact {
  id: string;
  runId: string;
  stageRunId: string | null;
  name: string;
  kind: string;
  path: string;
  createdAt: string;
}

export interface EventRow {
  id: number;
  runId: string | null;
  ts: string;
  type: string;
  data: Record<string, unknown>;
}
