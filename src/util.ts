import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { t } from './i18n.js';

/**
 * The execution slot of a repo registered at `path`: the path with symlinks resolved, so that
 * repos registered on the same git repository (e.g. with different target branches) share one.
 * `concurrency.per_repo` limits the Runs executing in each slot, and they take turns at its
 * merge lock. The path as given when it cannot be resolved (it is gone).
 */
export function executionSlot(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function newId(prefix: string): string {
  return `${prefix}-${randomBytes(5).toString('hex')}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Keep the last `max` characters of a (possibly long) output, marking the cut. */
export function tail(text: string, max = 4000): string {
  if (text.length <= max) return text;
  const omitted = text.length - max;
  return `${t({ zh: `…（前面省略 ${omitted} 个字符）`, en: `…(${omitted} characters omitted before)` })}\n${text.slice(-max)}`;
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
