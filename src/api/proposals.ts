import { attemptsAllowed, proposalRedoDueAt, proposalRestartable } from '../config/flow.js';
import type { LoadedConfig } from '../config/load.js';
import { NotFoundError, type Store } from '../store/store.js';
import type { Iteration, Proposal, Run } from '../store/types.js';
import type { ProposalView } from './types.js';

/** What the views of local proposals read from the configuration in use. */
export interface ProposalSettings {
  /** `backlog.poll_minutes`: a failed proposal's redo waits by it. */
  pollMinutes: number;
  /** `max_run_attempts` of a repo of backlog.repos, by name; undefined for one not in it. */
  maxRunAttempts: (repo: string) => number | undefined;
}

/** The settings `proposalView` and `attemptsView` go by, from config.yaml as loaded. */
export function proposalSettings(config: LoadedConfig): ProposalSettings {
  const backlog = config.master.backlog;
  return {
    pollMinutes: backlog?.poll_minutes ?? 5,
    maxRunAttempts: (repo) => backlog?.repos[repo]?.max_run_attempts,
  };
}

/**
 * Where the attempts at a proposal stand, as the dashboard shows them for a proposal of its own
 * and for a step of an iteration alike: the status of its latest Run, when that one is redone if
 * it waits to be (`proposalRedoDueAt`), how many Runs it gets (`attemptsAllowed`, null once its
 * repo `repo` left backlog.repos) and whether a human may start it over (`proposalRestartable`).
 * `iteration`: the one it is a step of, when the caller has it; undefined = looked up when the
 * rules need it.
 */
export function attemptsView(
  store: Store,
  p: Proposal,
  repo: string,
  settings: ProposalSettings,
  iteration?: Iteration | null,
): Pick<ProposalView, 'runStatus' | 'redoAt' | 'maxAttempts' | 'restartable'> {
  const run = p.runId ? found(() => store.getRun(p.runId ?? '')) : null;
  // A step's iteration only matters once its Run failed: whether it still wants a redo or a
  // restart.
  const failed = p.status === 'failed' || (run?.status === 'failed' && p.redo === 'pending');
  const it =
    iteration !== undefined
      ? iteration
      : p.iterationId && failed
        ? found(() => store.getIteration(p.iterationId ?? ''))
        : null;
  const redoAt =
    run?.status === 'failed' ? proposalRedoDueAt(p, it, run, settings.pollMinutes) : null;
  const max = settings.maxRunAttempts(repo);
  return {
    runStatus: run?.status ?? null,
    redoAt: redoAt === null ? null : new Date(redoAt).toISOString(),
    maxAttempts: max === undefined ? null : attemptsAllowed(max, p.attempt),
    restartable: proposalRestartable(p, it),
  };
}

/**
 * GET /api/proposals items: a proposal with its repo's name and where its attempts stand
 * (`attemptsView`). `names`: repo names by id, for listing many; omitted = looked up.
 */
export function proposalView(
  store: Store,
  p: Proposal,
  settings: ProposalSettings,
  names?: ReadonlyMap<string, string>,
): ProposalView {
  const repo = (names ? names.get(p.repoId) : store.findRepo(p.repoId)?.name) ?? p.repoId;
  return { ...p, repo, ...attemptsView(store, p, repo, settings) };
}

/** What `read` returns; null when it is not there (deleted meanwhile). */
function found<T extends Run | Iteration>(read: () => T): T | null {
  try {
    return read();
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}
