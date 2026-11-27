import type {
  AgentEventRecord,
  AgentSummary,
  BacklogStatus,
  ConfigView,
  DiffView,
  GitHubStatus,
  HealthView,
  IterationView,
  KeptWorkspace,
  NotifyTestResult,
  ProposalAccepted,
  ProposalRestarted,
  ProposalView,
  ProposalWritten,
  RepoDetection,
  RepoInput,
  RepoTrial,
  RepoTrialInput,
  RunDetail,
  RunSummary,
  StatsView,
  UpgradeStatus,
} from '../../../src/api/types.js';
import { t } from '../../../src/i18n.js';
import type {
  EventRow,
  Iteration,
  IterationStatus,
  ProposalStatus,
  Repo,
  Run,
  Scout,
  ScoutProposal,
} from '../../../src/store/types.js';
import { type StatsFilter, statsQuery } from './stats.js';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(
      t({
        zh: '连接不上 Master，请确认它在运行',
        en: 'Cannot reach the Master; make sure it is running',
      }),
      0,
    );
  }
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  const data: unknown = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : t({
            zh: `请求失败（HTTP ${res.status}）`,
            en: `Request failed (HTTP ${res.status})`,
          });
    throw new ApiError(message, res.status);
  }
  return data as T;
}

const id = encodeURIComponent;

export type RepoPatch = Partial<Pick<Repo, 'targetBranch' | 'verifyCommands' | 'setupCommands'>>;

/**
 * A requirement a human writes into the local backlog of a repo of backlog.repos (POST
 * /api/proposals). Left out: `category` feature, `size` M, `risk` mid, `start` true.
 */
export interface RequirementInput {
  repo: string;
  title: string;
  what: string;
  why?: string;
  evidence?: string[];
  acceptance?: string[];
  category?: ScoutProposal['category'];
  size?: ScoutProposal['size'];
  risk?: ScoutProposal['risk'];
  /** Accept it at once, a Run created from it; false keeps it pending for the human to start. */
  start?: boolean;
}

/**
 * An edit of a pending proposal of its own (PATCH /api/proposals/:id): the fields of a
 * requirement to change, the others left out; at least one.
 */
export type ProposalEdit = Partial<Omit<RequirementInput, 'repo' | 'start'>>;

export const api = {
  health: () => request<HealthView>('GET', '/api/health'),
  setWorking: (on: boolean) => request<HealthView>('PUT', '/api/working', { on }),
  /** Sends a test notification through each channel the Master notifies by. */
  notifyTest: () => request<NotifyTestResult>('POST', '/api/notify/test'),
  config: () => request<ConfigView>('GET', '/api/config'),
  agents: () => request<AgentSummary[]>('GET', '/api/agents'),

  repos: () => request<Repo[]>('GET', '/api/repos'),
  createRepo: (input: RepoInput) => request<Repo>('POST', '/api/repos', input),
  updateRepo: (repoId: string, patch: RepoPatch) =>
    request<Repo>('PATCH', `/api/repos/${id(repoId)}`, patch),
  deleteRepo: (repoId: string) => request<string>('DELETE', `/api/repos/${id(repoId)}`),
  /** Setup and verify commands suggested by the files committed on the repo's target branch. */
  detectRepo: (repoId: string) => request<RepoDetection>('GET', `/api/repos/${id(repoId)}/detect`),
  /**
   * Starts trying the repo's setup and verify commands: `commands` instead of the registered
   * ones, which stay as they are.
   */
  tryRepo: (repoId: string, commands?: RepoTrialInput) =>
    request<RepoTrial>('POST', `/api/repos/${id(repoId)}/trial`, commands ?? {}),
  /** The repo's latest trial; null when it has not been tried since the Master started. */
  repoTrial: (repoId: string) =>
    request<RepoTrial>('GET', `/api/repos/${id(repoId)}/trial`).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }),

  runs: () => request<RunSummary[]>('GET', '/api/runs'),
  run: (runId: string) => request<RunDetail>('GET', `/api/runs/${id(runId)}`),
  runEvents: (runId: string) => request<EventRow[]>('GET', `/api/runs/${id(runId)}/events`),
  /** Events of no Run, newest first; `before`: only those older than that event id. */
  globalEvents: (opts: { before?: number; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.before !== undefined) q.set('before', String(opts.before));
    if (opts.limit !== undefined) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return request<EventRow[]>('GET', `/api/events${qs ? `?${qs}` : ''}`);
  },
  diff: (runId: string, commit?: string) =>
    request<DiffView | null>(
      'GET',
      `/api/runs/${id(runId)}/diff${commit ? `?commit=${id(commit)}` : ''}`,
    ),
  attemptEvents: (attemptId: string) =>
    request<AgentEventRecord[]>('GET', `/api/attempts/${id(attemptId)}/events`),

  approve: (runId: string, comment?: string) =>
    request<Run>('POST', `/api/runs/${id(runId)}/approve`, { comment }),
  reject: (runId: string, comment: string) =>
    request<Run>('POST', `/api/runs/${id(runId)}/reject`, { comment }),
  retry: (runId: string, input: { agentId?: string; note?: string; budgetUsd?: number }) =>
    request<Run>('POST', `/api/runs/${id(runId)}/retry`, input),
  pause: (runId: string) => request<Run>('POST', `/api/runs/${id(runId)}/pause`),
  resume: (runId: string) => request<Run>('POST', `/api/runs/${id(runId)}/resume`),
  cancel: (runId: string) => request<Run>('POST', `/api/runs/${id(runId)}/cancel`),
  cleanup: (runId: string) => request<Run>('POST', `/api/runs/${id(runId)}/cleanup`),
  workspaces: () => request<KeptWorkspace[]>('GET', '/api/workspaces'),

  github: () => request<GitHubStatus>('GET', '/api/github'),
  githubPoll: () => request<GitHubStatus>('POST', '/api/github/poll'),
  gitlab: () => request<GitHubStatus>('GET', '/api/gitlab'),
  gitlabPoll: () => request<GitHubStatus>('POST', '/api/gitlab/poll'),
  upgrade: () => request<UpgradeStatus>('GET', '/api/upgrade'),
  upgradeCheck: () => request<UpgradeStatus>('POST', '/api/upgrade/check'),
  scouts: () => request<Scout[]>('GET', '/api/scouts'),
  stats: (filter: StatsFilter) => request<StatsView>('GET', `/api/stats?${statsQuery(filter)}`),
  /**
   * A scout by hand, whichever source the repo's requirements come from (GitHub, GitLab or the
   * backlog); `goal`: a direction it plans its iteration around, refused while the repo has an
   * iteration under way.
   */
  startScout: (repo: string, goal?: string) =>
    request<Scout>('POST', '/api/scouts', goal === undefined ? { repo } : { repo, goal }),

  /** The local backlog of the repos without GitHub (backlog.repos). */
  backlog: () => request<BacklogStatus>('GET', '/api/backlog'),
  backlogPoll: () => request<BacklogStatus>('POST', '/api/backlog/poll'),
  /** Proposals of the local backlog, newest first. */
  proposals: (opts: { repo?: string; status?: ProposalStatus; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.repo !== undefined) q.set('repo', opts.repo);
    if (opts.status !== undefined) q.set('status', opts.status);
    if (opts.limit !== undefined) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return request<ProposalView[]>('GET', `/api/proposals${qs ? `?${qs}` : ''}`);
  },
  /**
   * A requirement a human writes, as a proposal of author human: started (`start` true, the
   * default), its Run in the answer; or kept pending until accepted.
   */
  writeProposal: (input: RequirementInput) =>
    request<ProposalWritten>('POST', '/api/proposals', input),
  /**
   * Edits a pending proposal of its own; one a scout proposed may come back accepted already,
   * the edit having put it within auto-accept.
   */
  editProposal: (proposalId: string, edit: ProposalEdit) =>
    request<ProposalView>('PATCH', `/api/proposals/${id(proposalId)}`, edit),
  /** Accepting creates a Run whose goal is the proposal's text. */
  acceptProposal: (proposalId: string) =>
    request<ProposalAccepted>('POST', `/api/proposals/${id(proposalId)}/accept`),
  /** The reason is required; the repo's next scouts are shown it. */
  rejectProposal: (proposalId: string, reason: string) =>
    request<ProposalView>('POST', `/api/proposals/${id(proposalId)}/reject`, { reason }),
  /** A failed proposal (or step) started over: attempts from 1 again, a Run created at once. */
  restartProposal: (proposalId: string) =>
    request<ProposalRestarted>('POST', `/api/proposals/${id(proposalId)}/restart`),

  /** Iterations of both sources, newest first; `status`: any of these. */
  iterations: (
    opts: { repo?: string; status?: readonly IterationStatus[]; limit?: number } = {},
  ) => {
    const q = new URLSearchParams();
    if (opts.repo !== undefined) q.set('repo', opts.repo);
    if (opts.status !== undefined) q.set('status', opts.status.join(','));
    if (opts.limit !== undefined) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return request<IterationView[]>('GET', `/api/iterations${qs ? `?${qs}` : ''}`);
  },
  iteration: (iterationId: string) =>
    request<IterationView>('GET', `/api/iterations/${id(iterationId)}`),
  /** A pending iteration of the local backlog, as a whole: its steps start by dependencies. */
  acceptIteration: (iterationId: string) =>
    request<Iteration>('POST', `/api/iterations/${id(iterationId)}/accept`),
  /** A pending iteration of the local backlog, with every step; the reason is required. */
  rejectIteration: (iterationId: string, reason: string) =>
    request<Iteration>('POST', `/api/iterations/${id(iterationId)}/reject`, { reason }),
  /** An accepted iteration of the local backlog: the Runs of its steps not done are terminated. */
  cancelIteration: (iterationId: string) =>
    request<Iteration>('POST', `/api/iterations/${id(iterationId)}/cancel`),
};

export const urls = {
  log: (attemptId: string, download = false) =>
    `/api/attempts/${id(attemptId)}/log${download ? '?download' : ''}`,
  artifact: (runId: string, artifactId: string) =>
    `/api/runs/${id(runId)}/artifacts/${id(artifactId)}`,
};
