import type {
  AgentEventRecord,
  AgentSummary,
  ConfigView,
  DiffView,
  GitHubStatus,
  HealthView,
  KeptWorkspace,
  RunDetail,
  RunSummary,
  StatsView,
  UpgradeStatus,
} from '../../../src/api/types.js';
import { t } from '../../../src/i18n.js';
import type { EventRow, Repo, Run, Scout } from '../../../src/store/types.js';
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

export interface RepoInput {
  name: string;
  path: string;
  targetBranch?: string;
  verifyCommands: string[];
  setupCommands: string[];
}

export type RepoPatch = Partial<Pick<Repo, 'targetBranch' | 'verifyCommands' | 'setupCommands'>>;

export const api = {
  health: () => request<HealthView>('GET', '/api/health'),
  setWorking: (on: boolean) => request<HealthView>('PUT', '/api/working', { on }),
  config: () => request<ConfigView>('GET', '/api/config'),
  agents: () => request<AgentSummary[]>('GET', '/api/agents'),

  repos: () => request<Repo[]>('GET', '/api/repos'),
  createRepo: (input: RepoInput) => request<Repo>('POST', '/api/repos', input),
  updateRepo: (repoId: string, patch: RepoPatch) =>
    request<Repo>('PATCH', `/api/repos/${id(repoId)}`, patch),
  deleteRepo: (repoId: string) => request<string>('DELETE', `/api/repos/${id(repoId)}`),

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
  upgrade: () => request<UpgradeStatus>('GET', '/api/upgrade'),
  upgradeCheck: () => request<UpgradeStatus>('POST', '/api/upgrade/check'),
  scouts: () => request<Scout[]>('GET', '/api/scouts'),
  stats: (filter: StatsFilter) => request<StatsView>('GET', `/api/stats?${statsQuery(filter)}`),
  startScout: (repo: string) => request<Scout>('POST', '/api/scouts', { repo }),
};

export const urls = {
  log: (attemptId: string, download = false) =>
    `/api/attempts/${id(attemptId)}/log${download ? '?download' : ''}`,
  artifact: (runId: string, artifactId: string) =>
    `/api/runs/${id(runId)}/artifacts/${id(artifactId)}`,
};
