import { t } from '../../../src/i18n.js';
import { noticeFor as sharedNotice } from '../../../src/notify/notice.js';
import type { EventRow } from '../../../src/store/types.js';
import { href } from './router.js';

// Browser notifications when a human is needed. Which events notify is decided
// in src/notify/notice.ts, shared with the Master's system notifications. Pure logic only; the
// React side is in notifications.ts.

export interface Notice {
  title: string;
  body: string;
  /** Where a click on the notification leads. */
  href: string;
  /**
   * One tag per event: when several dashboard tabs show the same event, the browser replaces the
   * notification instead of showing it twice.
   */
  tag: string;
}

/** The notification for a live event, or null when the event needs none. */
export function noticeFor(event: EventRow, goal: string | undefined): Notice | null {
  const n = sharedNotice(event, goal);
  if (!n) return null;
  const to = n.runId ? href.run(n.runId) : n.about === 'issues' ? href.issues : href.home;
  return { title: n.title, body: n.body, href: to, tag: `ares1-event-${event.id}` };
}

/**
 * Said where the dashboard explains notifications when the Master also POSTs them to a webhook
 * (notify.webhook). The webhook does not replace the browser's, which stay as they are.
 */
export function webhookNote(): string {
  return t({
    zh: '已配置 webhook（config.yaml 的 notify.webhook），需要人处理时 Master 也会 POST 到配置的地址。',
    en: 'A webhook is set (notify.webhook in config.yaml): when you are needed, the Master also POSTs to its address.',
  });
}

/** The user's choice in this browser; null until they chose. */
export type NotifyPref = 'on' | 'off' | null;

/**
 * - `unsupported`: the browser has no notifications;
 * - `ask`: not decided yet, offer to turn them on;
 * - `on` / `off`: notifications are shown / the user turned them off;
 * - `denied`: the user wants them but the browser blocks them (permission denied);
 * - `system`: the Master sends system notifications itself, so the browser stays quiet.
 */
export type NotifyState = 'unsupported' | 'ask' | 'on' | 'off' | 'denied' | 'system';

export function notifyState(
  permission: NotificationPermission | 'unsupported',
  pref: NotifyPref,
  system = false,
): NotifyState {
  if (system) return 'system';
  if (permission === 'unsupported') return 'unsupported';
  if (pref === 'off') return 'off';
  if (permission === 'granted') return 'on';
  if (permission === 'denied') return pref === 'on' ? 'denied' : 'off';
  return 'ask';
}
