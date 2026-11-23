// Recognizing "out of quota / rate-limited" in a CLI's own error text, for CLIs that do not
// report it as a structured event. Pure logic: shared by the adapters.

/**
 * Phrases that mean a quota or a rate limit was hit. Kept narrow on purpose: a failure taken
 * for a rate limit is not counted as an error, so the task waits and is tried again with ever
 * longer waits, never failing and never shown to anyone; a missed one only costs a retry.
 */
const LIMIT_PATTERNS: RegExp[] = [
  /\busage[\s_-]?limit/i,
  // rate limit, rate-limit, rate_limit, ratelimit, rate limited, rate-limited, RateLimitError
  /\brate[\s_-]?limit/i,
  /\btoo[\s_-]?many[\s_-]?requests\b/i,
  /\bresource[\s_-]?exhausted\b/i,
  /\bresource\s+has\s+been\s+exhausted\b/i,
  /\bhit\s+your\s+limit\b/i,
  // A bare 429 only next to the words HTTP, status or code, so that line numbers, ids or 4290
  // are not taken for it: "HTTP 429", "HTTP/1.1 429", "status code 429", "statusCode":429.
  /(?:\bhttp(?:\/[\d.]+)?|status|\bcode)(?:[\s_-]?(?:code|error))?[\s:=("']*429(?!\d)/i,
];

/** Running out of a quota; "quota" alone is not enough (it could be a setting or a report). */
const QUOTA_PATTERNS: RegExp[] = [
  /\bquota[\s_-]*(?:(?:has\s+been|was|is)\s+)?exceeded\b/i,
  /\bexceeded\s+(?:\w+\s+){0,3}quota\b/i,
  /\bout\s+of\s+(?:\w+\s+)?quota\b/i,
  /\binsufficient[\s_-]*quota\b/i,
];

/** A disk quota (EDQUOT) is a full disk, not an agent's quota. */
const DISK_QUOTA = /\bdisk\s+quota\b/gi;

/** A reset time further ahead than this is taken for a misread number, not a quota reset. */
const MAX_RESET_AHEAD_MS = 31 * 24 * 3_600_000;

/**
 * Whether a CLI's error text says it ran out of quota or was rate-limited, and if so when the
 * quota is back (`retryAt`, ISO time) when the text tells and that time is still ahead.
 * `undefined` = no rate limit. Only for the CLI's own error message of a failed run: an agent's
 * reply may well talk about rate limits.
 */
export function rateLimitFromText(
  text: string | undefined,
  now: number = Date.now(),
): { retryAt?: string } | undefined {
  if (!text?.trim()) return undefined;
  const noDisk = text.replace(DISK_QUOTA, ' ');
  const limited =
    LIMIT_PATTERNS.some((p) => p.test(text)) || QUOTA_PATTERNS.some((p) => p.test(noDisk));
  if (!limited) return undefined;
  const reset = resetFromText(text);
  if (reset === undefined || reset <= now || reset - now > MAX_RESET_AHEAD_MS) return {};
  return { retryAt: new Date(reset).toISOString() };
}

/**
 * The reset time written in an error text, in epoch milliseconds. In this order: Claude's old
 * "…limit reached|<epoch>", an ISO time, then epoch seconds (10 digits) or milliseconds
 * (13 digits) shortly after the word reset or retry.
 */
function resetFromText(text: string): number | undefined {
  const piped = /limit\s+reached\s*\|\s*(\d{10}|\d{13})(?!\d)/i.exec(text);
  if (piped?.[1]) return resetTime(Number(piped[1]));
  const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/i.exec(
    text,
  );
  if (iso) {
    const ms = Date.parse(iso[0]);
    if (!Number.isNaN(ms)) return ms;
  }
  const epoch = /(?:reset|retry)[^\n]{0,30}?(?<!\d)(\d{10}|\d{13})(?!\d)/i.exec(text);
  if (epoch?.[1]) return resetTime(Number(epoch[1]));
  return undefined;
}

/**
 * A reset time as the CLI writes it, in epoch milliseconds: epoch seconds or milliseconds (a
 * number below 1e12 is taken as seconds, which reaches to the year 33658), or an ISO time.
 */
export function resetTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return resetTime(n);
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}
