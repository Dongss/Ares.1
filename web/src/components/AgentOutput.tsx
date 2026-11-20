import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentEventRecord } from '../../../src/api/types.js';
import { t } from '../../../src/i18n.js';
import { api } from '../lib/api.js';
import { formatTime } from '../lib/format.js';
import { appendRecord, mergeRecords } from '../lib/output.js';
import { useStream } from '../lib/stream.js';
import { ErrorBox } from './ui.js';

/**
 * What an agent did in one attempt: tool calls and replies. Loads the recorded events
 * first, then appends live ones while the attempt runs.
 */
export function AgentOutput({ attemptId, live }: { attemptId: string; live: boolean }) {
  const [records, setRecords] = useState<AgentEventRecord[]>([]);
  const [error, setError] = useState<string>();
  const [loadCount, setLoadCount] = useState(0);
  const loaded = useRef(false);
  const pending = useRef<AgentEventRecord[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useStream({
    onAgent: (e) => {
      if (e.attemptId !== attemptId) return;
      const record = { seq: e.seq, ts: e.ts, event: e.event };
      if (loaded.current) setRecords((prev) => appendRecord(prev, record));
      else pending.current.push(record);
    },
    onReconnect: () => setLoadCount((n) => n + 1),
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadCount triggers a reload
  useEffect(() => {
    let cancelled = false;
    loaded.current = false;
    api.attemptEvents(attemptId).then(
      (history) => {
        if (cancelled) return;
        const early = pending.current;
        pending.current = [];
        setRecords((prev) => mergeRecords(history, [...prev, ...early]));
        loaded.current = true;
        setError(undefined);
      },
      (err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attemptId, loadCount]);

  // Follow new output unless the user scrolled up to read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever records change
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [records]);

  const onScroll = () => {
    const el = box.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <div className="output" ref={box} onScroll={onScroll}>
      <ErrorBox>{error}</ErrorBox>
      {records.length === 0 && !error && (
        <div className="out-meta">
          {live
            ? t({ zh: '等待 Agent 输出…', en: 'Waiting for agent output…' })
            : t({ zh: '没有记录到输出', en: 'No output recorded' })}
        </div>
      )}
      {records.map((r) => (
        <OutputLine key={r.seq} record={r} />
      ))}
      {live && records.length > 0 && (
        <div className="out-meta out-live">{t({ zh: '执行中…', en: 'Running…' })}</div>
      )}
    </div>
  );
}

function OutputLine({ record }: { record: AgentEventRecord }) {
  const { event } = record;
  const time = formatTime(record.ts);
  switch (event.type) {
    case 'message':
      return (
        <div className="out-msg" title={time}>
          {event.text}
        </div>
      );
    case 'tool':
      return (
        <div className="out-tool" title={time}>
          <span className="out-tool-name">{event.name}</span>
          <code>{event.summary}</code>
        </div>
      );
    case 'stderr':
      return (
        <div className="out-stderr" title={time}>
          {event.text}
        </div>
      );
    case 'session':
      return (
        <div className="out-meta">
          {t({ zh: '会话 ', en: 'Session ' })}
          {event.sessionId}
        </div>
      );
    case 'model':
      return (
        <div className="out-meta">
          {t({ zh: '模型 ', en: 'Model ' })}
          {event.model}
        </div>
      );
  }
}
