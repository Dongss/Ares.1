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

/** Run git and return its stdout whatever the exit code (for commands that report by exiting 1). */
function gitOutput(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (_err, stdout) => {
      resolve(stdout ?? '');
    });
  });
}

/** The repo's identity when configured, otherwise an ares1 one (commits and merges need one). */
async function identityArgs(cwd: string): Promise<string[]> {
  return (await gitOk(cwd, ['config', 'user.email']))
    ? []
    : ['-c', 'user.name=ares1', '-c', 'user.email=ares1@localhost'];
}

export async function isGitRepo(path: string): Promise<boolean> {
  return gitOk(path, ['rev-parse', '--git-dir']);
}

export function revParse(cwd: string, ref: string): Promise<string> {
  return git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]);
}

/**
 * When `ref`'s commit was committed (the committer date, which a rebase or cherry-pick updates,
 * unlike the author date), in ms since the epoch; git keeps whole seconds.
 */
export async function commitTime(cwd: string, ref: string): Promise<number> {
  const out = await git(cwd, ['show', '-s', '--format=%ct', `${ref}^{commit}`]);
  const seconds = Number(out);
  if (!out || !Number.isFinite(seconds)) {
    throw new GitError(
      t({
        zh: `读不出 ${ref} 的提交时间：${out}`,
        en: `Could not read the commit time of ${ref}: ${out}`,
      }),
      '',
      null,
    );
  }
  return seconds * 1000;
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
 * During a merge (`startMerge`) it always commits, the merge commit, even when the result is the
 * same as HEAD (every conflict resolved our way): without it the other branch would not count as
 * merged and the next merge would conflict again.
 */
export async function commitAll(cwd: string, message: string): Promise<string | null> {
  await git(cwd, ['add', '-A']);
  if (!(await isMerging(cwd)) && (await gitOk(cwd, ['diff', '--cached', '--quiet']))) return null;
  const identity = await identityArgs(cwd);
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

export type MergeOutcome =
  | { ok: true }
  /**
   * `files`: those that conflicted, empty when the merge failed for another reason, which
   * `error` tells.
   */
  | { ok: false; files: string[]; error: string };

/**
 * Merge `ref` into the current branch. On conflicts the merge is aborted (the worktree is left as
 * it was) and the conflicted files are returned.
 */
export async function mergeOrAbort(
  cwd: string,
  ref: string,
  message: string,
): Promise<MergeOutcome> {
  const identity = await identityArgs(cwd);
  try {
    await git(cwd, [...identity, 'merge', '--no-ff', '--no-verify', '-m', message, ref]);
    return { ok: true };
  } catch (err) {
    const files = await conflictedFiles(cwd).catch(() => []);
    await gitOk(cwd, ['merge', '--abort']);
    return { ok: false, files, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Start merging `ref` into the current branch without committing it: conflicts stay in the files,
 * with their markers, for someone to resolve. MERGE_HEAD stays as well, so the next commit
 * (`commitAll`) is the merge commit; `resetHard` gives up the merge. Returns the conflicted files,
 * empty when everything merged cleanly. Throws when the merge cannot start (e.g. local changes in
 * the way).
 */
export async function startMerge(cwd: string, ref: string): Promise<string[]> {
  const identity = await identityArgs(cwd);
  try {
    await git(cwd, [...identity, 'merge', '--no-commit', '--no-ff', '-q', ref]);
    return [];
  } catch (err) {
    if (!(await isMerging(cwd))) throw err;
    return conflictedFiles(cwd);
  }
}

/** Whether a merge is in progress (MERGE_HEAD exists). */
export function isMerging(cwd: string): Promise<boolean> {
  return gitOk(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
}

/** Files with unresolved conflicts in the index, during a merge. */
export async function conflictedFiles(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['diff', '--name-only', '-z', '--diff-filter=U']);
  return [...new Set(out.split('\0').filter(Boolean))];
}

/**
 * Of `files`, those that still have conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) on lines
 * added since HEAD, as `git diff --check` finds them; markers HEAD already had are no conflict.
 */
export async function filesWithConflictMarkers(cwd: string, files: string[]): Promise<string[]> {
  const left: string[] = [];
  for (const file of files) {
    // One file at a time: the report quotes unusual file names, which then need no parsing.
    const out = await gitOutput(cwd, ['diff', '--check', 'HEAD', '--', `:(literal)${file}`]);
    if (out.split('\n').some((line) => line.endsWith(': leftover conflict marker'))) {
      left.push(file);
    }
  }
  return left;
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

/** Uncommitted changes to tracked files in a worktree (`git status --porcelain`); '' = none. */
function trackedChanges(worktree: string): Promise<string> {
  return git(worktree, ['status', '--porcelain', '--untracked-files=no']);
}

/**
 * Where `target` is checked out with uncommitted changes, which keep `fastForwardBranch` from
 * moving it; undefined when it is clean or not checked out anywhere. Used to see when a human
 * has cleared them.
 */
export async function targetCheckoutDirty(
  repo: string,
  target: string,
): Promise<{ worktree: string; status: string } | undefined> {
  const worktree = await worktreeForBranch(repo, target);
  if (worktree === undefined) return undefined;
  const status = await trackedChanges(worktree);
  return status.length > 0 ? { worktree, status } : undefined;
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
  const status = await trackedChanges(wt);
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
