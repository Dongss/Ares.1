import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addWorktree,
  commitAll,
  commitTime,
  conflictedFiles,
  fastForwardBranch,
  filesWithConflictMarkers,
  hasChanges,
  isMerging,
  mergeOrAbort,
  removeWorktree,
  resetHard,
  revParse,
  startMerge,
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

  it("reads a branch's commit time from the committer date, and fails on an unknown ref", async () => {
    const repo = initRepo();
    execFileSync('git', ['commit', '-q', '--amend', '--no-edit'], {
      cwd: repo,
      env: { ...process.env, GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z' },
    });
    expect(await commitTime(repo, 'main')).toBe(Date.parse('2026-01-02T03:04:05Z'));
    await expect(commitTime(repo, 'nope')).rejects.toThrow();
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

describe('git merges', () => {
  /**
   * A worktree on branch feature whose a.txt conflicts with main's, plus a file only main
   * changes; `legit.md` has a line that looks like a conflict marker on both sides.
   */
  async function conflicting() {
    const repo = initRepo();
    writeFile(join(repo, 'legit.md'), '<<<<<<< not a conflict\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'legit');
    const { wt } = await branchWithCommit(repo);
    const head = await revParse(wt, 'HEAD');
    writeFile(join(repo, 'a.txt'), 'main\n');
    writeFile(join(repo, 'b.txt'), 'b\n');
    writeFile(join(repo, 'legit.md'), '<<<<<<< not a conflict\nmore\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'main');
    return { repo, wt, head, main: await revParse(repo, 'main') };
  }

  it('mergeOrAbort names the conflicted files and leaves the worktree as it was', async () => {
    const { wt, head, main } = await conflicting();
    const outcome = await mergeOrAbort(wt, main, 'merge main');
    expect(outcome).toMatchObject({ ok: false, files: ['a.txt'] });
    expect(await isMerging(wt)).toBe(false);
    expect(await hasChanges(wt)).toBe(false);
    expect(await revParse(wt, 'HEAD')).toBe(head);
  });

  it('startMerge leaves the conflicts in the files and the next commit is the merge', async () => {
    const { wt, head, main } = await conflicting();
    expect(await startMerge(wt, main)).toEqual(['a.txt']);
    expect(await isMerging(wt)).toBe(true);
    expect(readFileSync(join(wt, 'a.txt'), 'utf8')).toContain('<<<<<<<');
    expect(await conflictedFiles(wt)).toEqual(['a.txt']);
    // Markers HEAD already had are no conflict.
    expect(await filesWithConflictMarkers(wt, ['a.txt', 'legit.md'])).toEqual(['a.txt']);

    writeFile(join(wt, 'a.txt'), 'a\nmain\n');
    expect(await filesWithConflictMarkers(wt, ['a.txt', 'legit.md'])).toEqual([]);
    const sha = await commitAll(wt, 'resolved');
    expect(await isMerging(wt)).toBe(false);
    expect(git(wt, 'rev-parse', `${sha}^1`, `${sha}^2`).split('\n')).toEqual([head, main]);
    expect(git(wt, 'show', `${sha}:b.txt`)).toBe('b');
  });

  it('commits the merge even when every conflict is resolved to our side', async () => {
    const { wt, head, main } = await conflicting();
    await startMerge(wt, main);
    // Our side for everything: the result is HEAD's tree.
    git(wt, 'checkout', 'HEAD', '--', '.');
    rmSync(join(wt, 'b.txt'));
    const sha = await commitAll(wt, 'ours');
    expect(sha).not.toBeNull();
    expect(git(wt, 'rev-parse', `${sha}^2`)).toBe(main);
    expect(git(wt, 'rev-parse', `${sha}^{tree}`)).toBe(git(wt, 'rev-parse', `${head}^{tree}`));
  });

  it('startMerge returns no files for a clean merge, and resetHard gives a merge up', async () => {
    const repo = initRepo();
    const { wt, base } = await branchWithCommit(repo);
    writeFile(join(repo, 'b.txt'), 'b\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'main');
    expect(await startMerge(wt, await revParse(repo, 'main'))).toEqual([]);
    expect(await isMerging(wt)).toBe(true);
    await resetHard(wt, base);
    expect(await isMerging(wt)).toBe(false);
    expect(await hasChanges(wt)).toBe(false);
    expect(await revParse(wt, 'HEAD')).toBe(base);
  });

  it('startMerge throws when the merge cannot start', async () => {
    const { wt, main } = await conflicting();
    writeFile(join(wt, 'b.txt'), 'in the way\n');
    await expect(startMerge(wt, main)).rejects.toThrow();
    expect(await isMerging(wt)).toBe(false);
  });
});
