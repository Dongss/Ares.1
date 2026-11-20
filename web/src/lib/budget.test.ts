import { afterEach, describe, expect, it } from 'vitest';
import { setLang } from '../../../src/i18n.js';
import { newBudget, parseBudget, suggestedBudget } from './budget.js';

describe('parseBudget', () => {
  it('leaves an empty budget unset and accepts positive amounts', () => {
    expect(parseBudget('')).toEqual({ ok: true, value: undefined });
    expect(parseBudget('  ')).toEqual({ ok: true, value: undefined });
    expect(parseBudget(' 2.5 ')).toEqual({ ok: true, value: 2.5 });
  });

  it('refuses zero, negative and non-numeric amounts', () => {
    for (const text of ['0', '-1', 'abc', '1e999', '$3']) {
      expect(parseBudget(text).ok).toBe(false);
    }
  });
});

describe('suggestedBudget', () => {
  it('offers twice the spending, rounded up to the cent', () => {
    expect(suggestedBudget(1.2)).toBe('2.40');
    expect(suggestedBudget(1.601)).toBe('3.21');
    expect(suggestedBudget(0.001)).toBe('0.01');
    expect(Number(suggestedBudget(0.004))).toBeGreaterThan(0.004);
  });
});

describe('newBudget', () => {
  it('must be given and above what the Run has spent', () => {
    expect(newBudget('', 1)).toMatchObject({ ok: false });
    expect(newBudget('1', 1)).toMatchObject({ ok: false });
    expect(newBudget('0.5', 1)).toMatchObject({ ok: false });
    expect(newBudget('x', 1)).toMatchObject({ ok: false });
    expect(newBudget('1.01', 1)).toEqual({ ok: true, value: 1.01 });
  });
});

describe('in English', () => {
  afterEach(() => setLang('zh'));

  it('explains refused budgets without Chinese', () => {
    setLang('en');
    for (const result of [parseBudget('0'), newBudget('', 1), newBudget('1', 1)]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).not.toMatch(/[\u4e00-\u9fff]/);
    }
    expect(newBudget('', 1)).toEqual({ ok: false, error: 'Enter a new budget' });
  });
});
