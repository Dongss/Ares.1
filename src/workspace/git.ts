import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { t } from '../i18n.js';

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
  }
}

/** Run git and return trimmed stdout; throws GitError on a non-zero exit. */
export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const code = typeof err.code === 'number' ? err.code : null;
        reject(
          new GitError(
            t({
              zh: `git ${args.join(' ')} 失败：${stderr.trim() || err.message}`,
              en: `git ${args.join(' ')} failed: ${stderr.trim() || err.message}`,
            }),
            stderr,
            code,
          ),
        );
        return;
      }
      resolve(stdout.trimEnd());
    });
  });
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

export async function isGitRepo(path: string): Promise<boolean> {
  return gitOk(path, ['rev-parse', '--git-dir']);
}

export function revParse(cwd: string, ref: string): Promise<string> {
  return git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]);
}

export function branchExists(repo: string, branch: string): Promise<boolean> {
  return gitOk(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
}

/**
 * Names of the repo's local branches, with one git call (instead of `branchExists` per branch).
 * Like `branchExists`, a repo git cannot read has none.
 */
export async function listBranches(repo: string): Promise<Set<string>> {
  let out: string;
  try {
    out = await git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads/']);
  } catch {
    return new Set();
  }
  const names = out
    .split('\n')
    .filter((line) => line.startsWith('refs/heads/'))
    .map((line) => line.slice('refs/heads/'.length));
  return new Set(names);
}

/** The branch currently checked out in the repo's main worktree. */
export function currentBranch(repo: string): Promise<string> {
  return git(repo, ['symbolic-ref', '--short', 'HEAD']);
}

export async function addWorktree(repo: string, path: string, branch: string, startPoint: string) {
  await git(repo, ['worktree', 'add', '-b', branch, path, startPoint]);
}

/** Check out an existing branch in a new worktree (e.g. after the old one was deleted). */
export async function addExistingWorktree(repo: string, path: string, branch: string) {
  await gitOk(repo, ['worktree', 'prune']);
  await git(repo, ['worktree', 'add', path, branch]);
}

/**
 * A worktree of commit `ref` with a detached HEAD: no branch is created, and no branch has to be
 * free to check out.
 */
export async function addDetachedWorktree(repo: string, path: string, ref: string): Promise<void> {
  await pruneWorktrees(repo);
  await git(repo, ['worktree', 'add', '--detach', '-q', path, ref]);
}

/**
 * Remove a worktree and its directory, leaving every branch alone (unlike `removeWorktree`).
 * Missing pieces are ignored; the directory goes even when git no longer knows it as a worktree.
 */
export async function dropWorktree(repo: string, path: string): Promise<void> {
  await gitOk(repo, ['worktree', 'remove', '--force', path]);
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Left for the next start's cleanup.
  }
  await pruneWorktrees(repo);
}

/** Forget worktrees whose directory is gone. Never fails. */
export async function pruneWorktrees(repo: string): Promise<void> {
  await gitOk(repo, ['worktree', 'prune']);
}

/** Remove a Run's worktree and branch. Missing pieces are ignored. */
export async function removeWorktree(repo: string, path: string, branch: string): Promise<void> {
  await gitOk(repo, ['worktree', 'remove', '--force', path]);
  await gitOk(repo, ['worktree', 'prune']);
  await gitOk(repo, ['branch', '-D', branch]);
}

export async function hasChanges(cwd: string): Promise<boolean> {
  return (await git(cwd, ['status', '--porcelain'])).length > 0;
}

/**
 * Commit everything in the worktree. Uses the repo's identity when configured,
 * otherwise falls back to an ares1 identity. Returns null when there is nothing to commit.
 */
export async function commitAll(cwd: string, message: string): Promise<string | null> {
  await git(cwd, ['add', '-A']);
  if (await gitOk(cwd, ['diff', '--cached', '--quiet'])) return null;
  const identity = (await gitOk(cwd, ['config', 'user.email']))
    ? []
    : ['-c', 'user.name=ares1', '-c', 'user.email=ares1@localhost'];
  await git(cwd, [...identity, 'commit', '--no-verify', '-q', '-m', message]);
  return revParse(cwd, 'HEAD');
}

/** Drop every uncommitted change and move HEAD to `ref` (ignored files such as node_modules stay). */
export async function resetHard(cwd: string, ref: string): Promise<void> {
  await gitOk(cwd, ['merge', '--abort']);
  await git(cwd, ['reset', '-q', '--hard', ref]);
  await git(cwd, ['clean', '-fdq']);
}

export function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  return gitOk(repo, ['merge-base', '--is-ancestor', ancestor, descendant]);
}

export function diffStat(cwd: string, base: string): Promise<string> {
  return git(cwd, ['diff', '--stat', `${base}...HEAD`]);
}

export function mergeBase(repo: string, a: string, b: string): Promise<string> {
  return git(repo, ['merge-base', a, b]);
}

/** Patch and stat between two commits, for the dashboard. */
export async function diffRange(
  repo: string,
  base: string,
  head: string,
): Promise<{ stat: string; patch: string }> {
  const [stat, patch] = await Promise.all([
    git(repo, ['diff', '--stat', base, head]),
    git(repo, ['diff', '--no-color', '--no-ext-diff', base, head]),
  ]);
  return { stat, patch };
}

/** Merge `ref` into the current branch. Returns false (after aborting) on conflicts. */
export async function mergeOrAbort(cwd: string, ref: string, message: string): Promise<boolean> {
  const identity = (await gitOk(cwd, ['config', 'user.email']))
    ? []
    : ['-c', 'user.name=ares1', '-c', 'user.email=ares1@localhost'];
  try {
    await git(cwd, [...identity, 'merge', '--no-ff', '--no-verify', '-m', message, ref]);
    return true;
  } catch {
    await gitOk(cwd, ['merge', '--abort']);
    return false;
  }
}

/** Path of the worktree that has `branch` checked out, if any. */
export async function worktreeForBranch(repo: string, branch: string): Promise<string | undefined> {
  const out = await git(repo, ['worktree', 'list', '--porcelain']);
  let path: string | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return undefined;
}

/**
 * Move `target` forward to `newHead` (which must descend from it) without disturbing anyone:
 * - target not checked out anywhere: compare-and-swap the ref;
 * - checked out and clean: fast-forward that worktree;
 * - checked out with uncommitted changes: refuse.
 */
export async function fastForwardBranch(
  repo: string,
  target: string,
  newHead: string,
): Promise<{ ok: true } | { ok: false; reason: 'dirty' | 'diverged'; detail: string }> {
  const oldHead = await revParse(repo, target);
  if (!(await isAncestor(repo, oldHead, newHead))) {
    return {
      ok: false,
      reason: 'diverged',
      detail: t({
        zh: `${target} 已经前进，不能快进`,
        en: `${target} has moved on and cannot be fast-forwarded`,
      }),
    };
  }
  const wt = await worktreeForBranch(repo, target);
  if (wt === undefined) {
    await git(repo, ['update-ref', `refs/heads/${target}`, newHead, oldHead]);
    return { ok: true };
  }
  const status = await git(wt, ['status', '--porcelain', '--untracked-files=no']);
  if (status.length > 0) {
    return {
      ok: false,
      reason: 'dirty',
      detail: t({
        zh: `${target} 分支在 ${wt} 中检出，且有未提交的改动：\n${status}`,
        en: `Branch ${target} is checked out in ${wt} with uncommitted changes:\n${status}`,
      }),
    };
  }
  await git(wt, ['merge', '--ff-only', '-q', newHead]);
  return { ok: true };
}
