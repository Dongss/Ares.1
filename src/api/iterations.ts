import { childRuns, iterationTotals } from '../backlog/iterations.js';
import { iterationProgress, unmetDependencies } from '../config/flow.js';
import type { Store } from '../store/store.js';
import type { Iteration, IterationChild, IterationChildStatus } from '../store/types.js';
import { isCostUnknown } from './cost.js';
import { attemptsView, type ProposalSettings } from './proposals.js';
import type { IterationChildView, IterationView } from './types.js';

/** The statuses of a step that has not started, for which it may still wait for others. */
const NOT_STARTED: readonly IterationChildStatus[] = ['planned', 'waiting', 'ready'];

/** What a step of GitHub, or one without a proposal yet, tells about its attempts: nothing. */
const NO_ATTEMPTS = {
  attempt: null,
  maxAttempts: null,
  redoAt: null,
  failures: [],
  restartable: false,
} satisfies Pick<
  IterationChildView,
  'attempt' | 'maxAttempts' | 'redoAt' | 'failures' | 'restartable'
>;

/**
 * GET /api/iterations and /api/iterations/:id: an iteration with its repo's name, each step with
 * the steps it still waits for, the Runs that worked on it (`childRuns`) and, in the local
 * backlog, where its proposal's attempts stand (`attemptsView`, by `settings`), its progress
 * (`iterationProgress`) and what it used (`iterationTotals`) as of `now` (epoch ms). `names`: repo
 * names by id, for listing many; omitted = looked up.
 */
export function iterationView(
  store: Store,
  iteration: Iteration,
  now: number,
  settings: ProposalSettings,
  names?: ReadonlyMap<string, string>,
): IterationView {
  let costUnknown = false;
  const repo =
    (names ? names.get(iteration.repoId) : store.findRepo(iteration.repoId)?.name) ??
    iteration.repoId;
  const attempts = (child: IterationChild) => {
    if (iteration.source !== 'local' || !child.proposalId) return NO_ATTEMPTS;
    const p = store.getProposal(child.proposalId);
    const { redoAt, maxAttempts, restartable } = attemptsView(store, p, repo, settings, iteration);
    return { attempt: p.attempt, maxAttempts, redoAt, failures: p.failures, restartable };
  };
  const children = iteration.children.map((child): IterationChildView => {
    const runs = childRuns(store, iteration, child).map((run) => {
      const unknown = store.listRunAttempts(run.id).some(isCostUnknown);
      costUnknown ||= unknown;
      return { id: run.id, status: run.status, costUsd: run.costUsd, costUnknown: unknown };
    });
    return {
      ...child,
      waitingFor: NOT_STARTED.includes(child.status)
        ? unmetDependencies(child, iteration.children)
        : [],
      runs,
      ...attempts(child),
    };
  });
  return {
    ...iteration,
    repo,
    children,
    progress: iterationProgress(iteration.children),
    totals: { ...iterationTotals(store, iteration, now), costUnknown },
  };
}
