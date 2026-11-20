import type { Engine } from '../engine/engine.js';
import type { Store } from '../store/store.js';
import type { Run } from '../store/types.js';
import type { FinishedRunStatus, KeptWorkspace } from './types.js';

const FINISHED: readonly FinishedRunStatus[] = ['completed', 'failed', 'cancelled', 'dropped'];

function isFinished(run: Run): run is Run & { status: FinishedRunStatus } {
  return (FINISHED as readonly string[]).includes(run.status);
}

/**
 * GET /api/workspaces: finished Runs whose worktree or branch is still there.
 * Runs that have not finished are left out: their workspace is in use.
 */
export async function keptWorkspaces(store: Store, engine: Engine): Promise<KeptWorkspace[]> {
  const runs = store.listRuns().filter(isFinished);
  const states = await engine.inspectWorkspaces(runs);
  const repoNames = new Map(store.listRepos().map((r) => [r.id, r.name]));
  const kept: KeptWorkspace[] = [];
  for (const run of runs) {
    const state = states.get(run.id);
    if (!state || (!state.worktreeExists && !state.branchExists)) continue;
    kept.push({
      run: {
        id: run.id,
        title: run.goal.trim().split('\n')[0] ?? '',
        repoId: run.repoId,
        repoName: repoNames.get(run.repoId) ?? run.repoId,
        status: run.status,
        finishedAt: run.finishedAt,
      },
      ...state,
      recorded: run.worktreePath !== null,
      canCleanUp: run.status === 'failed' || run.status === 'cancelled',
    });
  }
  // Most recently finished first; Runs without a finish time (none expected) last.
  return kept.sort((a, b) => (b.run.finishedAt ?? '').localeCompare(a.run.finishedAt ?? ''));
}
