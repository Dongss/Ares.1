import { describe, expect, it } from 'vitest';
import { dashboardLang } from './lang.js';

describe('dashboardLang', () => {
  it("prefers this browser's choice over the Master's", () => {
    expect(dashboardLang('en', 'zh')).toBe('en');
    expect(dashboardLang('zh', 'en')).toBe('zh');
  });

  it("follows the Master's language when the browser has not chosen", () => {
    expect(dashboardLang(null, 'en')).toBe('en');
  });

  it('falls back to Chinese before the Master answers', () => {
    expect(dashboardLang(null, undefined)).toBe('zh');
  });
});
