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
  /**
   * The Run comes from an issue written by someone the Master does not trust (not a member of
   * the repo): it waits for a human to confirm its goal before any agent reads it.
   */
  | 'untrusted_issue'
  /**
   * A setup or verify command could not run because the Master's environment lacks the program
   * it starts (exit code 127, the program not in PATH), or the node the Master runs on is gone;
   * also when an agent reported its task incomplete while a verify command's program was not in
   * PATH (the task then starts over). No fault of the code, so no rework, retry or redo is used
   * up. Goes on by itself once the program is found again or the Master restarts; `missing` names
   * the program.
   */
  | 'environment'
  /**
   * The repo delivers through pull requests (`deliver: pr`) and the merge stage's checks passed:
   * the Run's branch waits for its pull request on GitHub to be merged, with the merge stage
   * still executing. Takes no execution slot; the bridge's polls move it on (merged: the Run
   * goes on, closed: it fails). Nothing for a human to retry on the dashboard: the pull request
   * is merged or closed on GitHub.
   */
  | 'pr_open'
  | 'error';

/** Why a Run is blocked; also tells `retry` what to redo. */
export interface BlockInfo {
  kind: BlockKind;
  message: string;
  taskId?: string;
  stageRunId?: string;
  /** `environment`: the program that could not be found, e.g. `npm`, or the Master's node. */
  missing?: string;
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
   * The GitHub issue this Run was created from. Null for the Runs the Master creates itself to
   * merge a commit from GitHub (`mergeRemote`), for Runs created on the dashboard before Runs
   * came only from issues, and for Runs tests create directly.
   */
  issue: RunIssue | null;
  /**
   * For a Run the Master creates on its own to merge a commit of the target branch on GitHub
   * that could not be merged without an agent (conflicts, or checks failing after the merge):
   * that commit. The first agent task starts merging it in the worktree. Null for every other Run.
   */
  mergeRemote: string | null;
  /**
   * The pull request on GitHub the Run's work goes through, in repos with `deliver: pr`: opened
   * once the merge stage's checks passed, and the merge stage passes when it is merged. Null until
   * one is opened, and for the Runs of every other repo. A redo of the issue is a new Run, which
   * opens its own.
   */
  pr: RunPullRequest | null;
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

/** A Run's pull request on GitHub, from its branch into the target branch. */
export interface RunPullRequest {
  number: number;
  url: string;
}

/**
 * Why a Run's open pull request was sent back for more work, as its `github.pr_rework` events
 * record them: it conflicts with the target branch, a check failed, or a reviewer asked for
 * changes. In the order they are listed: a conflict first, since merging the target branch can
 * change what the checks and the reviewers saw.
 */
export const PR_REWORK_KINDS = ['conflict', 'ci', 'review'] as const;
export type PrReworkKind = (typeof PR_REWORK_KINDS)[number];

export interface RunIssue {
  /** "owner/name". */
  repo: string;
  number: number;
  url: string;
  /** Accepted by the Master without a human. */
  auto: boolean;
  /**
   * Which attempt at the issue this Run is: 1 for a Run started by `ares1:ready` (added by a
   * human or by auto-accept), one more for each automatic redo after a failure. Missing (= 1) in
   * Runs created before failed Runs were redone.
   */
  attempt?: number;
  /** The failed attempts at the issue before this one, oldest first; the agents are told. */
  earlier?: FailedAttempt[];
  /** What became of the issue after this Run failed; missing while it has not. */
  redo?: RedoState;
  /**
   * The issue was written by someone the Master does not trust (not a member of the repo), so
   * its text may be meant to steer the agents. The goal is the issue as it was when the Run was
   * created; the Run started blocked (`untrusted_issue`) until a human confirmed it. Missing
   * when the author is trusted, and in Runs created before authors were checked.
   */
  untrusted?: UntrustedAuthor;
}

/** Who wrote an issue the Master does not trust, and when a human confirmed the Run's goal. */
export interface UntrustedAuthor {
  /** GitHub login; null when the account was deleted. */
  author: string | null;
  /** The author's relation to the repo as GitHub gives it, e.g. NONE or CONTRIBUTOR. */
  association: string;
  /** When a human confirmed the goal on the dashboard; null while nobody has. */
  confirmedAt: string | null;
}

/**
 * After a Run from an issue failed. pending: it is redone once the work switch is on and the
 * day's budget allows; redone: the next attempt was created; exhausted: no attempts were left, so
 * the issue was closed; abandoned: a human closed the issue or started it over with
 * `ares1:ready` meanwhile, so it is not redone.
 */
export type RedoState = 'pending' | 'redone' | 'exhausted' | 'abandoned';

/** A failed Run of an issue, as the next attempts and the issue remember it. */
export interface FailedAttempt {
  runId: string;
  attempt: number;
  /** Name of the stage the Run failed in; null when it failed before any stage. */
  stage: string | null;
  error: string;
}

/**
 * What an assessment concluded. go: start the work; ask: questions for a human first (also when
 * it thinks the requirement should not be done); drop: not doing it, only after a human agreed or
 * after nobody replied to the questions in time.
 */
export type AssessVerdict = 'go' | 'ask' | 'drop';

/**
 * How big an assessment judged the requirement, ordered from small to large; proposals use the
 * same letters (`PROPOSAL_SIZES`). What each means is `sizeMeanings` in `src/config/flow.ts`. The
 * same letters in every language.
 */
export const REQUIREMENT_SIZES = ['S', 'M', 'L'] as const;
export type RequirementSize = (typeof REQUIREMENT_SIZES)[number];

/**
 * How hard an assessment judged the requirement, ordered from easy to hard: the stages with
 * `agent_candidates` pick an agent whose tier is at least this. The same words in every language.
 */
export const DIFFICULTIES = ['low', 'mid', 'high'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

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
  /**
   * How big the agent judged the requirement (asked for with go). Missing when it gave none, and
   * in entries recorded before assessments gave sizes.
   */
  size?: RequirementSize;
  /**
   * How hard the agent judged the requirement (asked for with go). Missing when it gave none, and
   * in entries recorded before assessments gave difficulties.
   */
  difficulty?: Difficulty;
  /**
   * The files and directories the agent expects the Run to change, as repo-relative paths cleaned
   * up by `normalizeTouches` (src/config/flow.ts); recorded only with go, which is when they are
   * asked for. Runs of the same repo whose paths overlap do not work at once. Missing when the
   * agent gave none (or none that names a path inside the repo), with ask and drop, and in entries
   * recorded before assessments gave them.
   */
  touches?: string[];
  /** The agent said drop before any human reply; a human is asked to confirm instead. */
  proposedDrop: boolean;
  /**
   * Concluded on its own after nobody replied to the questions in time: go on the assumptions in
   * `summary`, or drop. Missing in entries recorded before replies could time out.
   */
  decidedAlone?: boolean;
  /**
   * ask, for a Run from an issue: comments on the issue after these questions by people the
   * Master does not trust (not members of the repo), which were not taken as replies. Missing
   * while there are none.
   */
  ignoredComments?: number;
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

/**
 * `rate_limited`: its agent ran out of quota or was rate-limited; not a failure, the automatic
 * scout waits for the quota (see scoutLimitWait in src/config/flow.ts).
 */
export type ScoutStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'rate_limited';

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
  /**
   * Set once it is in the repo's local backlog (backlog.repos), the counterpart of `issue`:
   * `id` of the Proposal, `auto` when it was accepted without a human.
   */
  local?: { id: string; auto: boolean };
  /** Why the issue could not be created. */
  error?: string;
}

/**
 * pending: waits for a human, or for the automatic acceptance; accepted: a Run was created from
 * it; rejected: a human turned it down, with a reason the next scouts are shown.
 */
export type ProposalStatus = 'pending' | 'accepted' | 'rejected';

/**
 * A proposal in the local backlog of a repo without GitHub (backlog.repos): what a scout
 * proposed, kept in the Master instead of as an issue, and what became of it.
 */
export interface Proposal {
  id: string;
  repoId: string;
  /** The scout that proposed it. */
  scoutId: string | null;
  title: string;
  category: ScoutProposal['category'];
  size: ScoutProposal['size'];
  risk: ScoutProposal['risk'];
  why: string;
  evidence: string[];
  what: string;
  acceptance: string[];
  status: ProposalStatus;
  /** Why a human rejected it; null unless rejected. */
  rejectReason: string | null;
  /** Accepted without a human, within the repo's auto_accept. */
  auto: boolean;
  /** The Run created from it once accepted. */
  runId: string | null;
  createdAt: string;
  /** When it was accepted or rejected. */
  decidedAt: string | null;
}

/**
 * A capability the project lacks, from the scout's gap analysis against its README's goals.
 * `goal` is that goal copied word for word from the README: each repo has goals of its own.
 */
export interface ScoutGap {
  goal: string;
  gap: string;
  /** Where the code limits the capability, or passages of the README or other documents. */
  evidence: string[];
}

/** An AI scout: a read-only agent run that proposes issues. */
export interface Scout {
  id: string;
  repoId: string;
  /**
   * "owner/name" of the issues; '' for a repo of the local backlog (backlog.repos), which has
   * none: the column is NOT NULL, and allowing null would mean rebuilding the table.
   */
  issuesRepo: string;
  /** auto: started by the Master when the repo was idle. */
  trigger: 'manual' | 'auto';
  status: ScoutStatus;
  agentId: string;
  model: string | null;
  proposals: ScoutProposal[];
  /**
   * The gap analysis the scout's agent gave, empty when it found no gap; null until it answered
   * (and so for a scout that failed), and for scouts recorded before there was one.
   */
  gaps: ScoutGap[] | null;
  costUsd: number | null;
  error: string | null;
  logPath: string;
  startedAt: string;
  endedAt: string | null;
}

/**
 * check: verify commands failed; review: the reviewer asked for changes; rejected: the approval
 * was rejected; conflict: merging the target branch's latest code conflicted (merge stages).
 */
export type StageFailReason = 'check' | 'review' | 'rejected' | 'conflict';

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

/**
 * work: executed by the stage's agent, then checked and committed. plan: a stage with
 * `planning: llm` first runs its agent read-only to split the stage into work tasks; it is
 * neither checked nor committed.
 */
export type TaskKind = 'work' | 'plan';

export interface Task {
  id: string;
  runId: string;
  stageRunId: string;
  seq: number;
  kind: TaskKind;
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

/**
 * What came of an attempt: passed, sent back for rework, the agent errored (timeouts included),
 * or the agent was out of quota / rate-limited, after which the task runs again once the quota
 * is back (not an error).
 */
export type AttemptOutcome = 'passed' | 'rework' | 'agent_error' | 'rate_limited';

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

export type CheckKind = 'result' | 'command' | 'review' | 'merge' | 'assess' | 'plan';

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
