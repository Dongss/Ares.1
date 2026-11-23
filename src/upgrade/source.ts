// Which registered repo is the Master's own source code: the repo its install directory (the
// stable copy) pulls from. Only that repo's scout is told about the Master's failed upgrades.

import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The install directory the Master runs from, and its `origin` as git reports it. */
export interface MasterOrigin {
  installDir: string;
  url: string;
}

/** A registered repo: where it is, and its GitHub name (owner/name) if known. */
export interface SourceCandidate {
  path: string;
  github: string | null;
}

/** The path itself when it cannot be resolved, e.g. because it does not exist. */
function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** A GitHub URL: https://, ssh://, git:// or scp-like git@github.com:owner/name. */
const GITHUB_URL =
  /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|(?:[^@/]+@)?github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;

/** owner/name of a GitHub URL; null for anything else. */
export function githubNameOf(url: string): string | null {
  const match = GITHUB_URL.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * The local directory an origin URL points to, resolved against the install directory when it is
 * relative; null when it is a remote URL (`scheme://…` or scp-like `host:path`).
 */
export function localPathOf(origin: MasterOrigin): string | null {
  const url = origin.url.trim();
  if (!url) return null;
  if (/^file:\/\//i.test(url)) {
    try {
      return fileURLToPath(url);
    } catch {
      return null;
    }
  }
  // A Windows drive (C:\…) is a path, not scp-like host:path.
  if (/^[A-Za-z]:[\\/]/.test(url)) return url;
  if (/^[A-Za-z][\w+.-]*:\/\//.test(url) || /^[^/\\]+:/.test(url)) return null;
  return isAbsolute(url) ? url : resolve(origin.installDir, url);
}

/**
 * Whether `repo` is the Master's own source: the install directory's origin is the repo's
 * directory (compared after resolving symbolic links), or the same GitHub repo (ignoring case).
 * Without an origin nothing is.
 */
export function isMasterSource(
  origin: MasterOrigin | null,
  repo: SourceCandidate,
  realpath: (path: string) => string = realpathOrSelf,
): boolean {
  if (!origin) return false;
  const local = localPathOf(origin);
  // A clone of `<repo>/.git` has the same source as a clone of `<repo>`.
  const dir = (path: string) => realpath(path.replace(/[\\/]\.git[\\/]?$/, ''));
  if (local !== null) return dir(local) === dir(repo.path);
  const github = githubNameOf(origin.url);
  return (
    github !== null && repo.github !== null && github.toLowerCase() === repo.github.toLowerCase()
  );
}
