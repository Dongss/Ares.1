import { useEffect, useState } from 'react';
import { t } from '../../../src/i18n.js';
import type { EventRow } from '../../../src/store/types.js';
import { Badge, Collapsible, Empty, ErrorBox, Pre } from '../components/ui.js';
import { api } from '../lib/api.js';
import {
  type EventPages,
  globalEventLink,
  globalEventText,
  globalEventTone,
  withLatest,
  withOlder,
} from '../lib/events.js';
import { formatTime } from '../lib/format.js';
import { useAction, useReloadOn, useResource } from '../lib/hooks.js';

/** Events per request, the newest page and each older one. */
const PAGE = 200;

/**
 * What the Master recorded outside any Run, newest first: what happened while nobody watched.
 * The newest page reloads when such an event arrives; older pages load on request.
 */
export function EventsPage() {
  const latest = useResource(() => api.globalEvents({ limit: PAGE }), 'events');
  useReloadOn(latest.reload, (e) => e.runId === null, 500);
  const [pages, setPages] = useState<EventPages | null>(null);
  useEffect(() => {
    const rows = latest.data;
    if (rows) setPages((prev) => withLatest(prev, rows, PAGE));
  }, [latest.data]);

  const older = useAction();
  const loadOlder = async () => {
    const before = pages?.events.at(-1)?.id;
    if (before === undefined) return;
    const rows = await older.run(() => api.globalEvents({ before, limit: PAGE }));
    if (rows) setPages((prev) => (prev ? withOlder(prev, before, rows, PAGE) : prev));
  };

  return (
    <div className="events-page">
      <h1>{t({ zh: '事件', en: 'Events' })}</h1>
      <p className="hint">
        {t({
          zh: 'Master 记下的不属于任何 Run 的事：异常重启、日志清理、恢复数据库备份、升级、配置重新加载、GitHub 或 GitLab 出错、侦察等，最新的在前。每个 Run 自己的事件在它的详情页里。',
          en: "What the Master recorded outside any Run, newest first: unexpected restarts, pruned logs, a restored database backup, upgrades, configuration reloads, GitHub or GitLab errors, scouts and so on. Each Run's own events are on its page.",
        })}
      </p>
      <ErrorBox>{latest.error}</ErrorBox>
      {!pages ? (
        !latest.error && <Empty>{t({ zh: '加载中…', en: 'Loading…' })}</Empty>
      ) : pages.events.length === 0 ? (
        <Empty>{t({ zh: '还没有事件', en: 'No events yet' })}</Empty>
      ) : (
        <>
          <div className="card">
            <table className="events global-events">
              <thead>
                <tr>
                  <th>{t({ zh: '时间', en: 'Time' })}</th>
                  <th>{t({ zh: '类型', en: 'Type' })}</th>
                  <th>{t({ zh: '说明', en: 'Description' })}</th>
                </tr>
              </thead>
              <tbody>
                {pages.events.map((e) => (
                  <EventLine key={e.id} event={e} />
                ))}
              </tbody>
            </table>
          </div>
          <ErrorBox>{older.error}</ErrorBox>
          {pages.complete ? (
            <p className="hint events-end">
              {t({ zh: '没有更早的事件了', en: 'No older events' })}
            </p>
          ) : (
            <div className="events-more">
              <button type="button" disabled={older.busy} onClick={loadOlder}>
                {older.busy
                  ? t({ zh: '加载中…', en: 'Loading…' })
                  : t({ zh: '加载更早的', en: 'Load older' })}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function EventLine({ event }: { event: EventRow }) {
  const text = globalEventText(event);
  const tone = globalEventTone(event);
  const link = globalEventLink(event);
  const data = Object.keys(event.data).length > 0 ? JSON.stringify(event.data) : '';
  const detail = typeof event.data.detail === 'string' ? event.data.detail.trim() : '';
  return (
    <tr className={`event-${tone}`}>
      <td className="muted" title={event.ts}>
        {formatTime(event.ts)}
      </td>
      <td>
        <Badge tone={tone}>{event.type}</Badge>
      </td>
      <td>
        {text === null ? (
          <code className="event-data">{data}</code>
        ) : (
          <div className="event-text" title={data}>
            {text}
            {link && (
              <>
                {' '}
                <a href={link.href}>{link.label}</a>
              </>
            )}
          </div>
        )}
        {text !== null && detail && (
          <Collapsible title={t({ zh: '详细输出', en: 'Output' })}>
            <Pre>{detail}</Pre>
          </Collapsible>
        )}
      </td>
    </tr>
  );
}
