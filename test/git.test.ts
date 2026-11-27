import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addWorktree,
  cloneRepo,
  cloneUrlAllowed,
  commitAll,
  commitTime,
  committedYamlFiles,
  conflictedFiles,
  currentBranch,
  fastForwardBranch,
  filesWithConflictMarkers,
  GitError,
  hasChanges,
  INITIAL_COMMIT_MESSAGE,
  initEmptyRepo,
  isMerging,
  mergeOrAbort,
  pathDiffers,
  removeWorktree,
  resetHard,
  revParse,
  startMerge,
  targetCheckoutDirty,
  validBranchName,
  withoutUrlCredentials,
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

  it('targetCheckoutDirty finds uncommitted changes where the target is checked out', async () => {
    const repo = initRepo();
    expect(await targetCheckoutDirty(repo, 'main')).toBeUndefined();
    // Untracked files do not count, as for the fast-forward.
    writeFile(join(repo, 'new.txt'), 'new\n');
    expect(await targetCheckoutDirty(repo, 'main')).toBeUndefined();
    writeFile(join(repo, 'README.md'), 'dirty\n');
    expect(await targetCheckoutDirty(repo, 'main')).toEqual({
      worktree: realpathSync(repo),
      status: ' M README.md',
    });
    // Not checked out anywhere: nothing to disturb.
    git(repo, 'checkout', '-q', '-b', 'other');
    expect(await targetCheckoutDirty(repo, 'main')).toBeUndefined();
  });

  it('reads the YAML files of a directory as committed, untouched by the worktree', async () => {
    const repo = initRepo();
    const dir = '.ares1/workflows';
    // No such directory: no files, no error.
    expect(await committedYamlFiles(repo, 'main', dir)).toEqual([]);

    writeFile(join(repo, dir, 'b.yml'), 'id: b\n');
    writeFile(join(repo, dir, 'a.yaml'), 'id: a\n\n');
    writeFile(join(repo, dir, 'notes.md'), 'not a template\n');
    writeFile(join(repo, dir, 'nested', 'c.yaml'), 'id: c\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'templates');
    const committed = [
      // Sorted by name, content as committed (the trailing blank line included).
      { file: 'a.yaml', source: 'id: a\n\n' },
      { file: 'b.yml', source: 'id: b\n' },
    ];
    expect(await committedYamlFiles(repo, 'main', dir)).toEqual(committed);

    // Uncommitted changes, new and deleted files of the checkout play no part.
    writeFile(join(repo, dir, 'a.yaml'), 'id: changed\n');
    writeFile(join(repo, dir, 'new.yaml'), 'id: new\n');
    rmSync(join(repo, dir, 'b.yml'));
    expect(await committedYamlFiles(repo, 'main', dir)).toEqual(committed);
    // Nor does staging them.
    git(repo, 'add', '-A');
    expect(await committedYamlFiles(repo, 'main', dir)).toEqual(committed);
    // Any commit can be read, and the directory is from the repo's root wherever git runs.
    const before = await revParse(repo, 'main');
    git(repo, 'commit', '-q', '-m', 'change');
    expect(await committedYamlFiles(repo, before, dir)).toEqual(committed);
    expect(await committedYamlFiles(join(repo, dir), before, dir)).toEqual(committed);
    expect(await committedYamlFiles(repo, 'main', dir)).toEqual([
      { file: 'a.yaml', source: 'id: changed\n' },
      { file: 'new.yaml', source: 'id: new\n' },
    ]);
    await expect(committedYamlFiles(repo, 'nope', dir)).rejects.toThrow();
  });

  it('tells whether a directory differs between two commits', async () => {
    const repo = initRepo();
    const dir = '.ares1/workflows';
    const init = await revParse(repo, 'main');
    writeFile(join(repo, 'other.txt'), 'other\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'other');
    const other = await revParse(repo, 'main');
    expect(await pathDiffers(repo, init, other, dir)).toBe(false);

    writeFile(join(repo, dir, 'a.yaml'), 'id: a\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'template');
    const added = await revParse(repo, 'main');
    expect(await pathDiffers(repo, other, added, dir)).toBe(true);
    expect(await pathDiffers(repo, added, other, dir)).toBe(true);
    // Uncommitted changes are not compared.
    writeFile(join(repo, dir, 'a.yaml'), 'id: changed\n');
    expect(await pathDiffers(repo, added, 'main', dir)).toBe(false);
    await expect(pathDiffers(repo, added, 'nope', dir)).rejects.toThrow();
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

describe('repos the Master clones or makes', () => {
  it('clones only from https://, ssh://, user@host:path and absolute local paths', () => {
    for (const url of [
      'https://github.com/me/repo.git',
      'HTTPS://example.com:8443/group/sub/repo',
      'https://me:token@example.com/repo.git',
      'ssh://git@example.com:2222/me/repo.git',
      'ssh://[::1]/repo',
      'git@github.com:me/repo.git',
      'me@host.example:repos/x',
      '/srv/git/repo.git',
      '/Users/me/my repo',
    ]) {
      expect(cloneUrlAllowed(url), url).toBe(true);
    }
    for (const url of [
      '',
      'ext::sh -c touch% /tmp/pwned',
      'fd::17',
      'file:///srv/git/repo.git',
      'git://example.com/repo.git',
      'http://example.com/repo.git',
      'ftp://example.com/repo.git',
      'relative/path',
      './repo',
      'host:path',
      '--upload-pack=touch /tmp/x',
      '-x',
      'https://-oProxyCommand=x/repo',
      'ssh://-oProxyCommand=x/repo',
      'ssh://git@-oProxyCommand=x/repo',
      'ssh://host:-p/repo',
      'https:///repo',
      'https://exa mple.com/repo',
      '-git@host:repo',
      'git@-oProxyCommand=x:repo',
      'git@host:',
      'git@host/x:repo',
      '/srv/repo\n--upload-pack=x',
      'https://example.com/repo\u0000',
    ]) {
      expect(cloneUrlAllowed(url), JSON.stringify(url)).toBe(false);
    }
  });

  it('keeps credentials of URLs out of the text it shows', () => {
    expect(
      withoutUrlCredentials(
        "fatal: repository 'https://me:ghp_secret@github.com/me/repo.git/' not found",
      ),
    ).toBe("fatal: repository 'https://github.com/me/repo.git/' not found");
    expect(withoutUrlCredentials('ssh://git@host/x and https://token@host/y')).toBe(
      'ssh://host/x and https://host/y',
    );
    expect(withoutUrlCredentials('git@github.com:me/repo.git')).toBe('git@github.com:me/repo.git');
  });

  it('accepts branch names git accepts, never one that looks like an option', async () => {
    expect(await validBranchName('main')).toBe(true);
    expect(await validBranchName('feature/x')).toBe(true);
    expect(await validBranchName('-x')).toBe(false);
    expect(await validBranchName('a..b')).toBe(false);
    expect(await validBranchName('has space')).toBe(false);
  });

  it('clones a branch or the default one, and fails with the end of git output', async () => {
    const src = initRepo();
    git(src, 'checkout', '-q', '-b', 'trunk');
    const dest = join(tmpDir(), 'clone');
    await cloneRepo(src, dest, { timeoutMs: 60_000 });
    expect(await currentBranch(dest)).toBe('trunk');
    const other = join(tmpDir(), 'clone');
    await cloneRepo(src, other, { branch: 'main', timeoutMs: 60_000 });
    expect(await currentBranch(other)).toBe('main');
    const missing = join(tmpDir(), 'missing');
    const err = await cloneRepo(missing, join(tmpDir(), 'clone'), { timeoutMs: 60_000 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GitError);
    // Then git's own output, in whatever language git speaks here.
    const [first, ...output] = (err as GitError).message.split('\n');
    expect(first).toBe(`克隆 ${missing} 失败：`);
    expect(output.join('\n')).toContain(missing);
    await expect(
      cloneRepo('ext::sh -c true', join(tmpDir(), 'x'), { timeoutMs: 1000 }),
    ).rejects.toThrow('不支持的仓库地址');
  });

  it('makes a new repo with an empty first commit on the branch', async () => {
    const dir = tmpDir();
    await initEmptyRepo(dir, 'trunk');
    expect(await currentBranch(dir)).toBe('trunk');
    expect(git(dir, 'log', '--format=%B', 'trunk')).toBe(INITIAL_COMMIT_MESSAGE);
    expect(git(dir, 'ls-tree', '-r', '--name-only', 'trunk')).toBe('');
  });
});
