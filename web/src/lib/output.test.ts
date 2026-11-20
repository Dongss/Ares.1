import { describe, expect, it } from 'vitest';
import type { AgentEventRecord } from '../../../src/api/types.js';
import { appendRecord, mergeRecords } from './output.js';

const rec = (seq: number, text = `m${seq}`): AgentEventRecord => ({
  seq,
  ts: '2026-11-18T00:00:00.000Z',
  event: { type: 'message', text },
});

describe('agent output merging', () => {
  it('merges history with live events received while loading, without duplicates', () => {
    const merged = mergeRecords([rec(1), rec(2), rec(3)], [rec(3, 'dup'), rec(4)]);
    expect(merged.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(merged[2]?.event).toEqual({ type: 'message', text: 'm3' });
  });

  it('appends new events and ignores ones already shown', () => {
    const base = [rec(1), rec(2)];
    expect(appendRecord(base, rec(3)).map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(appendRecord(base, rec(2))).toBe(base);
    expect(appendRecord([rec(1), rec(3)], rec(2)).map((r) => r.seq)).toEqual([1, 2, 3]);
  });
});
