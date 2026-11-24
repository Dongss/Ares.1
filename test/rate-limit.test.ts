import { describe, expect, it } from 'vitest';
import { rateLimitFromText } from '../src/adapters/rate-limit.js';

const NOW = Date.parse('2026-11-23T10:00:00.000Z');
const IN_AN_HOUR = NOW + 3_600_000;
const AT = new Date(IN_AN_HOUR).toISOString();

describe('rateLimitFromText', () => {
  it('recognizes the usual ways CLIs say a quota or a rate limit was hit', () => {
    for (const text of [
      'usage limit reached',
      "You've hit your usage limit for this month.",
      "You've hit your limit · resets 3pm",
      'Claude AI usage limit reached|1700000000',
      'Rate limit exceeded, please slow down',
      'You have been rate-limited.',
      'Request was rate limited by the provider',
      'anthropic.RateLimitError: rate_limit_error',
      'Error: Too Many Requests',
      'TooManyRequests',
      '[GoogleGenerativeAI Error]: RESOURCE_EXHAUSTED',
      '429 Resource has been exhausted (e.g. check quota).',
      'You exceeded your current quota, please check your plan and billing details.',
      'Quota exceeded for metric generate_content_requests',
      'error: insufficient_quota',
      'Your account is out of quota',
      'HTTP 429',
      'request failed: HTTP/1.1 429',
      'Request failed with status code 429',
      'status: 429',
      '{"statusCode":429,"message":"slow down"}',
      'API error code 429',
    ]) {
      expect(rateLimitFromText(text, NOW), text).toBeDefined();
    }
  });

  it('is case-insensitive', () => {
    expect(rateLimitFromText('USAGE LIMIT REACHED', NOW)).toBeDefined();
    expect(rateLimitFromText('Too many requests', NOW)).toBeDefined();
  });

  it('does not take other failures, a disk quota, or a 429 in other numbers for one', () => {
    for (const text of [
      undefined,
      '',
      '   ',
      'Cannot use this model: grok-4.7-high. Available models: auto',
      'There is an issue with the selected model',
      'Internal server error',
      'not logged in',
      'Disk quota exceeded',
      'write failed: exceeded the disk quota',
      'EDQUOT: disk quota exceeded, write',
      'quota: 100 GB',
      'Set the quota in the settings',
      'accurate limits apply',
      'HTTP 4290',
      'status 1429',
      'wrote 429 lines',
      'Error at line 429',
      'at Object.<anonymous> (/src/code/file.js:429:12)',
      'HTTP 500 Internal Server Error',
    ]) {
      expect(rateLimitFromText(text, NOW), String(text)).toBeUndefined();
    }
  });

  it('gives no reset time when the text has none', () => {
    expect(rateLimitFromText('usage limit reached', NOW)).toEqual({});
    expect(rateLimitFromText('HTTP 429, Retry-After: 30', NOW)).toEqual({});
  });

  it("reads Claude's old 'limit reached|<epoch>' format, in seconds or milliseconds", () => {
    const seconds = IN_AN_HOUR / 1000;
    expect(rateLimitFromText(`Claude AI usage limit reached|${seconds}`, NOW)).toEqual({
      retryAt: AT,
    });
    expect(rateLimitFromText(`Claude AI usage limit reached|${IN_AN_HOUR}`, NOW)).toEqual({
      retryAt: AT,
    });
  });

  it('reads an ISO time', () => {
    expect(rateLimitFromText(`Usage limit reached. Resets at ${AT}.`, NOW)).toEqual({
      retryAt: AT,
    });
    expect(rateLimitFromText('rate limited until 2026-11-23T12:30:00+02:00', NOW)).toEqual({
      retryAt: '2026-11-23T10:30:00.000Z',
    });
  });

  it('reads epoch seconds or milliseconds shortly after reset or retry', () => {
    const seconds = IN_AN_HOUR / 1000;
    expect(rateLimitFromText(`rate limit exceeded; resets_at=${seconds}`, NOW)).toEqual({
      retryAt: AT,
    });
    expect(rateLimitFromText(`429 Too Many Requests, retry at ${IN_AN_HOUR}`, NOW)).toEqual({
      retryAt: AT,
    });
    // Far from the word, or with no such word: not taken for a reset time.
    expect(rateLimitFromText(`rate limit exceeded for request ${seconds}`, NOW)).toEqual({});
  });

  it('prefers the piped format, then an ISO time, then an epoch', () => {
    const later = new Date(IN_AN_HOUR + 600_000).toISOString();
    expect(
      rateLimitFromText(`usage limit reached|${IN_AN_HOUR / 1000}, resets at ${later}`, NOW),
    ).toEqual({ retryAt: AT });
    expect(
      rateLimitFromText(`rate limit; reset ${(IN_AN_HOUR + 600_000) / 1000} (${AT})`, NOW),
    ).toEqual({ retryAt: AT });
  });

  it('reads Codex\'s "try again in <duration>"', () => {
    const limit =
      "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or";
    expect(rateLimitFromText(`${limit} try again in 2 hours 5 minutes.`, NOW)).toEqual({
      retryAt: new Date(NOW + (2 * 60 + 5) * 60_000).toISOString(),
    });
    expect(rateLimitFromText(`${limit} try again in 4 days 2 hours 3 minutes.`, NOW)).toEqual({
      retryAt: new Date(NOW + ((4 * 24 + 2) * 60 + 3) * 60_000).toISOString(),
    });
    expect(rateLimitFromText('rate limited, retry in 90 seconds', NOW)).toEqual({
      retryAt: new Date(NOW + 90_000).toISOString(),
    });
    expect(rateLimitFromText('rate limited, retry in 1h 30m', NOW)).toEqual({
      retryAt: new Date(NOW + 90 * 60_000).toISOString(),
    });
    // No number, or no unit it knows: no reset time.
    expect(rateLimitFromText(`${limit} try again in less than a minute.`, NOW)).toEqual({});
    expect(rateLimitFromText('usage limit reached, try again in 2 weeks', NOW)).toEqual({});
  });

  it('reads Codex\'s "try again at <time>" in local time, the next time the clock shows it', () => {
    /** "3:05 PM" for a local time. */
    const clock = (d: Date) =>
      `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
    const later = new Date(NOW + 90 * 60_000);
    expect(rateLimitFromText(`usage limit reached; try again at ${clock(later)}.`, NOW)).toEqual({
      retryAt: later.toISOString(),
    });
    // Earlier today on the clock: tomorrow.
    const earlier = new Date(NOW - 60 * 60_000);
    const tomorrow = new Date(earlier);
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(rateLimitFromText(`usage limit reached; try again at ${clock(earlier)}.`, NOW)).toEqual({
      retryAt: tomorrow.toISOString(),
    });
    // With a date, as Codex writes it when the reset is not today.
    expect(
      rateLimitFromText(
        "You've hit your usage limit. Visit settings or try again at Nov 25th, 2026 3:15 PM.",
        NOW,
      ),
    ).toEqual({ retryAt: new Date(2026, 10, 25, 15, 15).toISOString() });
    // A 24-hour clock.
    const evening = new Date(NOW);
    evening.setHours(23, 59, 0, 0);
    if (evening.getTime() <= NOW) evening.setDate(evening.getDate() + 1);
    expect(rateLimitFromText('rate limit hit, resets at 23:59', NOW)).toEqual({
      retryAt: evening.toISOString(),
    });
    // Not a time.
    expect(rateLimitFromText('usage limit reached; try again at 13:15 PM', NOW)).toEqual({});
  });

  it('drops a reset time that has passed, or one too far ahead to be one', () => {
    const past = new Date(NOW - 60_000).toISOString();
    expect(rateLimitFromText(`usage limit reached, resets at ${past}`, NOW)).toEqual({});
    expect(rateLimitFromText(`usage limit reached|${NOW / 1000}`, NOW)).toEqual({});
    const farAhead = new Date(NOW + 400 * 24 * 3_600_000).toISOString();
    expect(rateLimitFromText(`usage limit reached, resets at ${farAhead}`, NOW)).toEqual({});
  });
});
