import type { KeptWorkspace } from '../../../src/api/types.js';
import { t } from '../../../src/i18n.js';

/** The kept workspaces of one repo on the Workspaces page. */
export interface WorkspaceGroup {
  repoId: string;
  repoName: string;
  items: KeptWorkspace[];
}

/** Repos by name; within a repo, most recently finished first (no finish time last). */
export function groupWorkspaces(items: KeptWorkspace[]): WorkspaceGroup[] {
  const groups = new Map<string, WorkspaceGroup>();
  for (const item of items) {
    const { repoId, repoName } = item.run;
    let group = groups.get(repoId);
    if (!group) {
      group = { repoId, repoName, items: [] };
      groups.set(repoId, group);
    }
    group.items.push(item);
  }
  for (const group of groups.values()) group.items.sort(byFinishedDesc);
  return [...groups.values()].sort(
    (a, b) => a.repoName.localeCompare(b.repoName) || a.repoId.localeCompare(b.repoId),
  );
}

function byFinishedDesc(a: KeptWorkspace, b: KeptWorkspace): number {
  const fa = a.run.finishedAt;
  const fb = b.run.finishedAt;
  if (fa !== fb) {
    if (fa === null) return 1;
    if (fb === null) return -1;
    return fb.localeCompare(fa);
  }
  return a.run.id.localeCompare(b.run.id);
}

/** Offer the cleanup button: the cleanup endpoint accepts the Run and something is left. */
export function showCleanup(item: KeptWorkspace): boolean {
  return item.canCleanUp && (item.worktreeExists || item.branchExists);
}

/** Why a kept workspace has no cleanup button; null when it has one. */
export function noCleanupReason(item: KeptWorkspace): string | null {
  if (showCleanup(item)) return null;
  if (item.run.status === 'completed') {
    return t({
      zh: '已完成的 Run 由 Master 在合并后自动清理，这个没有清理掉（工作目录的提交不全在目标分支上，或删除时失败）。看板只清理失败或已终止的 Run，确认不再需要后请在仓库里手动删除。',
      en: 'The Master cleans up completed Runs after merging, but not this one (some commits in the worktree are not on the target branch, or deleting failed). The dashboard only cleans up failed or cancelled Runs; once you are sure it is no longer needed, delete it in the repo by hand.',
    });
  }
  if (item.run.status === 'dropped') {
    return t({
      zh: '评估结论为不做的 Run 由 Master 在结束时自动清理，这个没有清理掉（工作目录里有不在目标分支上的提交，或删除时失败）。看板只清理失败或已终止的 Run，确认不再需要后请在仓库里手动删除。',
      en: 'The Master cleans up Runs the assessment dropped when they end, but not this one (the worktree has commits that are not on the target branch, or deleting failed). The dashboard only cleans up failed or cancelled Runs; once you are sure it is no longer needed, delete it in the repo by hand.',
    });
  }
  return null;
}

/** The branch and worktree lines of one item; `removed`: that one is already gone. */
export function keptWorkspaceLines(
  item: KeptWorkspace,
): { label: string; value: string; removed: boolean }[] {
  return [
    {
      label: t({ zh: '分支', en: 'Branch' }),
      value: item.workspace.branch,
      removed: !item.branchExists,
    },
    {
      label: t({ zh: '工作目录', en: 'Worktree' }),
      value: item.workspace.path,
      removed: !item.worktreeExists,
    },
  ];
}
