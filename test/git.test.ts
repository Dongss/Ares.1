import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addWorktree,
  commitAll,
  fastForwardBranch,
  hasChanges,
  removeWorktree,
  resetHard,
  revParse,
} from '../src/workspace/git.js';
import { git, initRepo, tmpDir, writeFile } from './helpers.js';

async function branchWithCommit(repo: string) {
  const wt = join(tmpDir('ares1-wt-'), 'wt');
  const base = await revParse(repo, 'main');
  await addWorktree(repo, wt, 'feature', base);
  writeFile(join(wt, 'a.txt'), 'a\n');
  const sha = await commitAll(wt, 'add a');
  return { wt, sha: sha as string, base };
}

describe('git workspace', () => {
  it('commits everything and returns null when there is nothing to commit', async () => {
    const repo = initRepo();
    const { wt, sha } = await branchWithCommit(repo);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await commitAll(wt, 'empty')).toBeNull();
  });

  it('resetHard drops tracked and untracked changes', async () => {
    const repo = initRepo();
    const { wt, base } = await branchWithCommit(repo);
    writeFile(join(wt, 'b.txt'), 'b\n');
    expect(await hasChanges(wt)).toBe(true);
    await resetHard(wt, base);
    expect(await hasChanges(wt)).toBe(false);
    expect(await revParse(wt, 'HEAD')).toBe(base);
  });

  it('fast-forwards a target branch that is not checked out by moving the ref', async () => {
    const repo = initRepo();
    git(repo, 'checkout', '-q', '-b', 'other');
    const { sha } = await branchWithCommit(repo);
    expect(await fastForwardBranch(repo, 'main', sha)).toEqual({ ok: true });
    expect(await revParse(repo, 'main')).toBe(sha);
  });

  it('fast-forwards a clean checked-out target and updates its files', async () => {
    const repo = initRepo();
    const { sha } = await branchWithCommit(repo);
    expect(await fastForwardBranch(repo, 'main', sha)).toEqual({ ok: true });
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'show', 'HEAD:a.txt')).toBe('a');
  });

  it('refuses when the checked-out target has uncommitted changes, or diverged', async () => {
    const repo = initRepo();
    const { sha } = await branchWithCommit(repo);
    writeFile(join(repo, 'README.md'), 'dirty\n');
    const dirty = await fastForwardBranch(repo, 'main', sha);
    expect(dirty).toMatchObject({ ok: false, reason: 'dirty' });

    git(repo, 'commit', '-qam', 'diverge');
    const diverged = await fastForwardBranch(repo, 'main', sha);
    expect(diverged).toMatchObject({ ok: false, reason: 'diverged' });
  });

  it('removeWorktree removes the worktree and branch and tolerates missing ones', async () => {
    const repo = initRepo();
    const { wt } = await branchWithCommit(repo);
    await removeWorktree(repo, wt, 'feature');
    expect(git(repo, 'branch', '--list', 'feature')).toBe('');
    await removeWorktree(repo, wt, 'feature');
  });
});
