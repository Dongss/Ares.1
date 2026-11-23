import type { LoadedConfig } from '../config/load.js';
import type { WebhookConfig } from '../config/schema.js';
import { redactForGitHub } from '../github/redact.js';
import { t } from '../i18n.js';
import type { Store } from '../store/store.js';
import type { EventRow } from '../store/types.js';
import { type Notice, type NoticeKind, noticeFor } from './notice.js';

/** The part of the global fetch the notifier uses (tests may replace it). */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** A webhook that does not answer is given up on: the Master never waits for it. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/** The JSON body of a webhook notification (`format: json`). */
export interface WebhookPayload {
  kind: NoticeKind;
  title: string;
  body: string;
  /** "title\nbody": what services that show one text (a Slack incoming webhook) display. */
  text: string;
  runId: string | null;
  about: Notice['about'];
  /** The event that caused it, e.g. run.blocked. */
  eventType: string;
  /** When the event happened (ISO time). */
  at: string;
}

/**
 * The request for a notification. The texts leave the machine for a service of the user's, so
 * paths under the home directory become `~` as they do on GitHub: the system user name stays
 * private. Headers configured with the same name (in any case) replace the default ones.
 */
export function webhookRequest(
  webhook: WebhookConfig,
  notice: Notice,
  event: EventRow,
  home?: string,
): { headers: Headers; body: string } {
  const title = redactForGitHub(notice.title, home);
  const body = redactForGitHub(notice.body, home);
  const text = `${title}\n${body}`;
  const headers = new Headers({
    'content-type': webhook.format === 'text' ? 'text/plain; charset=utf-8' : 'application/json',
  });
  for (const [name, value] of Object.entries(webhook.headers)) headers.set(name, value);
  if (webhook.format === 'text') return { headers, body: text };
  const payload: WebhookPayload = {
    kind: notice.kind,
    title,
    body,
    text,
    runId: notice.runId ?? null,
    about: notice.about,
    eventType: event.type,
    at: event.ts,
  };
  return { headers, body: JSON.stringify(payload) };
}

/** Why a request failed, without the address or the headers (they may carry tokens). */
function failureReason(err: unknown, webhook: WebhookConfig, timeoutMs: number): string {
  let reason: string;
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    reason = t({
      zh: `${timeoutMs / 1000} 秒内没有响应`,
      en: `no response within ${timeoutMs / 1000} seconds`,
    });
  } else if (err instanceof Error) {
    // fetch says only "fetch failed"; the cause tells why (ECONNREFUSED, ENOTFOUND, ...).
    const cause = err.cause as { code?: unknown; message?: unknown } | undefined;
    const detail =
      typeof cause?.message === 'string' && cause.message
        ? cause.message
        : typeof cause?.code === 'string'
          ? cause.code
          : '';
    reason = detail ? `${err.message} (${detail})` : err.message;
  } else {
    reason = String(err);
  }
  const secrets = [webhook.url, ...Object.values(webhook.headers)];
  try {
    secrets.push(new URL(webhook.url).href);
  } catch {
    // The schema only lets valid URLs through.
  }
  for (const secret of secrets) {
    if (secret.length >= 4) reason = reason.split(secret).join('***');
  }
  return reason;
}

/** Why a request failed: words without the address or the headers, and the HTTP status if any. */
interface Failure {
  reason: string;
  status: number | null;
}

/**
 * Notifications POSTed to the address in `notify.webhook` (config.yaml), so that a human is
 * reached even away from this machine or on a server without a desktop: only when a human is
 * needed (see notice.ts). Read on every event, so a reloaded configuration applies at once.
 * A failure is never retried, never throws and never stops the Master. It is logged and
 * recorded as the global event notify.webhook_failed (on the Events page, where a human coming
 * back sees that notifications stopped) once per streak of failures: a dead webhook does not
 * fill the log with one line per notification, and one that comes back and breaks again is told
 * again. That event notifies nobody (see noticeFor), so a failure cannot set off another POST.
 */
export class WebhookNotifier {
  /**
   * The address whose failure was told in the current streak of failures; cleared when a
   * notification gets through, so another address or a new streak is told again.
   */
  private failingUrl: string | undefined;
  private readonly pending = new Set<Promise<void>>();
  private readonly fetch: Fetch;
  private readonly log: (message: string) => void;
  private readonly timeoutMs: number;
  private readonly home: string | undefined;

  private readonly onEvent = (e: EventRow) => {
    const webhook = this.config().master.notify.webhook;
    if (!webhook) return;
    const goal = e.runId ? this.goal(e.runId) : undefined;
    const notice = noticeFor(e, goal);
    if (!notice) return;
    const sent = this.post(webhook, notice, e);
    this.pending.add(sent);
    void sent.finally(() => this.pending.delete(sent));
  };

  constructor(
    private readonly store: Store,
    private readonly config: () => LoadedConfig,
    opts: {
      fetch?: Fetch;
      log?: (message: string) => void;
      /** How long to wait for an answer (tests shorten it). */
      timeoutMs?: number;
      /** The home directory hidden as `~` (default the user's). */
      home?: string;
    } = {},
  ) {
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.log = opts.log ?? ((message: string) => console.warn(message));
    this.timeoutMs = opts.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
    this.home = opts.home;
  }

  private goal(runId: string): string | undefined {
    try {
      return this.store.getRun(runId).goal;
    } catch {
      return undefined;
    }
  }

  /** Never rejects: every failure ends in `failed`. */
  private async post(webhook: WebhookConfig, notice: Notice, event: EventRow): Promise<void> {
    try {
      const failure = await this.send(webhook, notice, event).catch(
        (err: unknown): Failure => ({
          reason: failureReason(err, webhook, this.timeoutMs),
          status: null,
        }),
      );
      if (failure) {
        this.failed(webhook, failure);
      } else {
        // It got through: the next failure starts a new streak, told again.
        this.failingUrl = undefined;
      }
    } catch {
      // Logging and recording must not fail the Master either: the store is closed when the
      // Master stopped while the request was out.
    }
  }

  /** null when the webhook took the notification; throws when it gave no answer. */
  private async send(
    webhook: WebhookConfig,
    notice: Notice,
    event: EventRow,
  ): Promise<Failure | null> {
    const { headers, body } = webhookRequest(webhook, notice, event, this.home);
    const response = await this.fetch(webhook.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    // Nothing is read from the answer; let the connection go.
    await response.body?.cancel().catch(() => {});
    if (response.ok) return null;
    return {
      reason: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
      status: response.status,
    };
  }

  /** The first failure of a streak (or of another address) is logged and recorded; later ones not. */
  private failed(webhook: WebhookConfig, { reason, status }: Failure): void {
    if (this.failingUrl === webhook.url) return;
    this.failingUrl = webhook.url;
    this.log(
      t({
        zh: `[通知] webhook 通知发送失败：${reason}。之后的失败不再记录，直到有通知发送成功。`,
        en: `[notify] Sending a webhook notification failed: ${reason}. Later failures are not logged until a notification gets through.`,
      }),
    );
    // The reason names neither the address nor the headers: they may carry tokens.
    this.store.tx(() => this.store.event(null, 'notify.webhook_failed', { reason, status }));
  }

  /** Resolves when the requests sent so far have ended (tests wait for it). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  start(): void {
    this.store.bus.on('event', this.onEvent);
  }

  stop(): void {
    this.store.bus.off('event', this.onEvent);
  }
}
