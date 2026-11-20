// What the Master publishes on GitHub is public on a public repo. Error output and agents'
// summaries often carry absolute paths of this machine (the worktrees live under the user's home
// directory), which would give away the system user name and the layout of the machine.

import { homedir } from 'node:os';

/** A path separator: either kind, doubled as in JSON-escaped Windows paths. */
const SEP = String.raw`[\\/]+`;

/** Characters of a file or directory name. */
const NAME = String.raw`[\p{L}\p{N}_-]`;

/**
 * Text as the Master publishes it on GitHub (issue comments, the issues it creates, the commit
 * messages it pushes): paths under the user's home directory start with `~` instead, e.g.
 * `/Users/me/.ares1/worktrees/x` becomes `~/.ares1/worktrees/x`. Other paths stay as they are.
 * What the Master keeps for itself (the store, the dashboard, logs) keeps the full paths.
 */
export function redactForGitHub(text: string, home: string = homedir()): string {
  const pattern = homePattern(home);
  return pattern ? text.replace(pattern, '~') : text;
}

/**
 * Matches the home directory where a path starts with it: not inside another path
 * (`/mnt/home/me`), and not when the name goes on (`/home/me2`). null when there is nothing to
 * hide: no home, or the root, which would turn every absolute path into `~`.
 */
function homePattern(home: string): RegExp | null {
  const windows = /^[A-Za-z]:([\\/]|$)/.test(home);
  if (!windows && !/^[\\/]/.test(home)) return null;
  const parts = home.split(/[\\/]+/).filter(Boolean);
  const root = windows ? 1 : 0;
  if (parts.length <= root) return null;
  const body = parts.map(escapeRegExp).join(SEP);
  const path = windows ? body : `${SEP}${body}`;
  return new RegExp(
    `(?<!${NAME}|[.\\\\/])${path}(?!${NAME}|\\.${NAME})`,
    // Windows paths do not tell upper and lower case apart.
    windows ? 'giu' : 'gu',
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
