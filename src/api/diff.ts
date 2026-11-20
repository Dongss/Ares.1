import { existsSync } from 'node:fs';
import type { EventRow, Repo, Run } from '../store/types.js';
import { branchExists, diffRange, mergeBase, revParse } from '../workspace/git.js';
import type { DiffView } from './types.js';

/** Larger patches are cut off; the dashboard says so and shows the stat in full. */
export const MAX_PATCH_CHARS = 1_000_000;

function lastEvent(events: EventRow[], type: string, beforeId = Number.POSITIVE_INFINITY) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && e.type === type && e.id < beforeId) return e;
  }
  return undefined;
}

/**
 * The commits that bound what a Run changes on its target branch:
 * - merged: from the target head it last synced with (or its base) to the merged head;
 * - otherwise: from the merge base with the target branch to the Run's current head.
 * Undefined while the Run has no workspace yet.
 */
export async function runDiffRange(
  repo: Repo,
  run: Run,
  events: EventRow[],
): Promise<{ base: string; head: string } | undefined> {
  const merged = lastEvent(events, 'merge.done');
  if (merged && typeof merged.data.head === 'string') {
    const synced = lastEvent(events, 'merge.synced', merged.id);
    const base =
      typeof synced?.data.targetHead === 'string' ? synced.data.targetHead : run.baseCommit;
    if (base) return { base, head: merged.data.head };
  }
  let head: string | undefined;
  if (run.worktreePath && existsSync(run.worktreePath)) {
    head = await revParse(run.worktreePath, 'HEAD');
  } else if (run.branch && (await branchExists(repo.path, run.branch))) {
    head = await revParse(repo.path, run.branch);
  }
  if (!head) return undefined;
  const base = await mergeBase(repo.path, repo.targetBranch, head).catch(() => run.baseCommit);
  return base ? { base, head } : undefined;
}

export async function diffView(repoPath: string, base: string, head: string): Promise<DiffView> {
  const { stat, patch } = await diffRange(repoPath, base, head);
  const truncated = patch.length > MAX_PATCH_CHARS;
  return {
    base,
    head,
    stat,
    patch: truncated ? patch.slice(0, MAX_PATCH_CHARS) : patch,
    truncated,
  };
}
