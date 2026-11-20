import { afterEach, describe, expect, it } from 'vitest';
import type { KeptWorkspace } from '../../../src/api/types.js';
import { setLang } from '../../../src/i18n.js';
import { groupWorkspaces, keptWorkspaceLines, noCleanupReason, showCleanup } from './workspaces.js';

function kept(
  id: string,
  extra: { run?: Partial<KeptWorkspace['run']> } & Partial<Omit<KeptWorkspace, 'run'>> = {},
): KeptWorkspace {
  const { run, ...rest } = extra;
  const status = run?.status ?? 'cancelled';
  return {
    run: {
      id,
      title: `目标 ${id}`,
      repoId: 'repo-1',
      repoName: 'demo',
      status,
      finishedAt: '2026-11-18T00:00:00.000Z',
      ...run,
    },
    workspace: { path: `/home/worktrees/${id}`, branch: `ares1/${id}` },
    worktreeExists: true,
    branchExists: true,
    recorded: true,
    canCleanUp: status === 'failed' || status === 'cancelled',
    ...rest,
  };
}

describe('groupWorkspaces', () => {
  it('groups by repo name, most recently finished first within a repo', () => {
    const groups = groupWorkspaces([
      kept('a-old', { run: { finishedAt: '2026-11-18T01:00:00.000Z' } }),
      kept('b', { run: { repoId: 'repo-2', repoName: 'api' } }),
      kept('a-none', { run: { finishedAt: null } }),
      kept('a-new', { run: { finishedAt: '2026-11-18T03:00:00.000Z' } }),
      kept('a-new2', { run: { finishedAt: '2026-11-18T03:00:00.000Z' } }),
    ]);
    expect(groups.map((g) => [g.repoId, g.repoName])).toEqual([
      ['repo-2', 'api'],
      ['repo-1', 'demo'],
    ]);
    expect(groups[1]?.items.map((i) => i.run.id)).toEqual(['a-new', 'a-new2', 'a-old', 'a-none']);
  });

  it('is empty without kept workspaces', () => {
    expect(groupWorkspaces([])).toEqual([]);
  });
});

describe('cleanup button', () => {
  it('is offered for failed and cancelled runs with something left', () => {
    expect(showCleanup(kept('c'))).toBe(true);
    expect(showCleanup(kept('f', { run: { status: 'failed' } }))).toBe(true);
    expect(showCleanup(kept('w', { branchExists: false }))).toBe(true);
    expect(showCleanup(kept('b', { worktreeExists: false }))).toBe(true);
    expect(showCleanup(kept('gone', { worktreeExists: false, branchExists: false }))).toBe(false);
    expect(noCleanupReason(kept('c'))).toBeNull();
  });

  it('is not offered for completed runs, with the reason', () => {
    const completed = kept('done', { run: { status: 'completed' } });
    expect(completed.canCleanUp).toBe(false);
    expect(showCleanup(completed)).toBe(false);
    expect(noCleanupReason(completed)).toContain('手动删除');
  });

  it('follows the server on what the cleanup endpoint accepts', () => {
    expect(showCleanup(kept('x', { canCleanUp: false }))).toBe(false);
  });
});

describe('keptWorkspaceLines', () => {
  it('lists the branch and the worktree, marking removed ones', () => {
    expect(keptWorkspaceLines(kept('r', { branchExists: false }))).toEqual([
      { label: '分支', value: 'ares1/r', removed: true },
      { label: '工作目录', value: '/home/worktrees/r', removed: false },
    ]);
  });
});

describe('in English', () => {
  afterEach(() => setLang('zh'));

  it('labels lines and explains missing cleanups without Chinese', () => {
    setLang('en');
    expect(keptWorkspaceLines(kept('r')).map((line) => line.label)).toEqual(['Branch', 'Worktree']);
    for (const status of ['completed', 'dropped'] as const) {
      const reason = noCleanupReason(kept('x', { run: { status } }));
      expect(reason).toContain('by hand');
      expect(reason).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });
});
