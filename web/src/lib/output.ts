import type { AgentEventRecord } from '../../../src/api/types.js';

/**
 * Merge recorded history with live events received while it was loading: one entry per seq,
 * in order, so the panel shows what is already there and then keeps appending new output.
 */
export function mergeRecords(
  history: AgentEventRecord[],
  live: AgentEventRecord[],
): AgentEventRecord[] {
  const bySeq = new Map<number, AgentEventRecord>();
  for (const r of history) bySeq.set(r.seq, r);
  for (const r of live) if (!bySeq.has(r.seq)) bySeq.set(r.seq, r);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Append one live event unless it is already there. */
export function appendRecord(
  records: AgentEventRecord[],
  record: AgentEventRecord,
): AgentEventRecord[] {
  const last = records[records.length - 1];
  if (!last || record.seq > last.seq) return [...records, record];
  if (records.some((r) => r.seq === record.seq)) return records;
  return mergeRecords(records, [record]);
}
