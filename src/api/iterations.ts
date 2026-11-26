import { childRuns, iterationTotals } from '../backlog/iterations.js';
import { iterationProgress, unmetDependencies } from '../config/flow.js';
import type { Store } from '../store/store.js';
import type { Iteration, IterationChildStatus } from '../store/types.js';
import { isCostUnknown } from './cost.js';
import type { IterationChildView, IterationView } from './types.js';

/** The statuses of a step that has not started, for which it may still wait for others. */
const NOT_STARTED: readonly IterationChildStatus[] = ['planned', 'waiting', 'ready'];

/**
 * GET /api/iterations and /api/iterations/:id: an iteration with its repo's name, each step with
 * the steps it still waits for and the Runs that worked on it (`childRuns`), its progress
 * (`iterationProgress`) and what it used (`iterationTotals`) as of `now` (epoch ms). `names`: repo
 * names by id, for listing many; omitted = looked up.
 */
export function iterationView(
  store: Store,
  iteration: Iteration,
  now: number,
  names?: ReadonlyMap<string, string>,
): IterationView {
  let costUnknown = false;
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
    };
  });
  const repo = names ? names.get(iteration.repoId) : store.findRepo(iteration.repoId)?.name;
  return {
    ...iteration,
    repo: repo ?? iteration.repoId,
    children,
    progress: iterationProgress(iteration.children),
    totals: { ...iterationTotals(store, iteration, now), costUnknown },
  };
}
