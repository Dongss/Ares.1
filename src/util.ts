import { randomBytes } from 'node:crypto';
import { t } from './i18n.js';

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
