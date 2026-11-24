import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoadedConfig } from '../config/load.js';
import type { WebhookConfig } from '../config/schema.js';
import { redactForGitHub } from '../github/redact.js';
import { t } from '../i18n.js';
import type { Store } from '../store/store.js';
import type { EventRow } from '../store/types.js';
import { errorMessage, nowIso } from '../util.js';
import { type Notice, type NoticeKind, noticeFor } from './notice.js';

/** The part of the global fetch the notifier uses (tests may replace it). */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** A webhook that does not answer is given up on: the Master never waits for it. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * The kinds of webhook notifications: those of the Master (notice.ts); `master_down`, which only
 * the scripts send (scripts/webhook.sh) when the Master is down and they cannot start it; and
 * `test`, the test notification a human asks for on the dashboard. No event makes either of the
 * last two, so they are not NoticeKinds.
 */
export type WebhookKind = NoticeKind | 'master_down' | 'test';

/** A notification as it goes to the webhook: one of the Master's (notice.ts) or a test one. */
export interface WebhookNotice extends Omit<Notice, 'kind'> {
  kind: WebhookKind;
}

/** The event type of the test notification, as `eventType` of its JSON body. */
export const TEST_NOTICE_EVENT = 'notify.test';

/** The JSON body of a webhook notification (`format: json`). */
export interface WebhookPayload {
  kind: WebhookKind;
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
 * The request headers of a notification: the content type of the format, which a header
 * configured with the same name (in any case) replaces, and the other configured headers.
 */
export function webhookHeaders(webhook: WebhookConfig): Headers {
  const headers = new Headers({
    'content-type': webhook.format === 'text' ? 'text/plain; charset=utf-8' : 'application/json',
  });
  for (const [name, value] of Object.entries(webhook.headers)) headers.set(name, value);
  return headers;
}

/**
 * The request for a notification. The texts leave the machine for a service of the user's, so
 * paths under the home directory become `~` as they do on GitHub: the system user name stays
 * private. Headers configured with the same name (in any case) replace the default ones.
 */
export function webhookRequest(
  webhook: WebhookConfig,
  notice: WebhookNotice,
  event: Pick<EventRow, 'type' | 'ts'>,
  home?: string,
): { headers: Headers; body: string } {
  const title = redactForGitHub(notice.title, home);
  const body = redactForGitHub(notice.body, home);
  const text = `${title}\n${body}`;
  const headers = webhookHeaders(webhook);
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

/**
 * Where the Master leaves the webhook's settings for the scripts that notify when it is down
 * (keepalive.sh and self-upgrade.sh, through scripts/webhook.sh): `<home>/webhook.curl`.
 */
export function webhookCurlFile(home: string): string {
  return join(home, 'webhook.curl');
}

/** The escapes curl reads inside double quotes in a config file (`curl -K`). */
const CURL_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  '"': '\\"',
  '\t': '\\t',
  '\n': '\\n',
  '\r': '\\r',
  '\v': '\\v',
};

/**
 * A value as it goes between double quotes in a curl config file: backslashes and quotes
 * escaped, and the line breaks and tabs curl knows written as \n, \r, \t and \v, so that the
 * value stays on its line and reads back the same.
 */
export function escapeCurlConfigValue(value: string): string {
  return value.replace(/[\\"\t\n\r\v]/g, (c) => CURL_ESCAPES[c] ?? c);
}

/** The comment line of webhookCurlConfig that tells the scripts the format, e.g. `json`. */
export const WEBHOOK_FORMAT_COMMENT = '# ares1-format:';

/**
 * The webhook's settings as a curl config file (`curl -K`): the address, a POST, and one line
 * per request header, merged as webhookRequest merges them; the format is in a comment line
 * (WEBHOOK_FORMAT_COMMENT), which curl skips. The scripts add the body, the timeout and where
 * the answer goes. The address is written as fetch requests it (parsed, so with spaces and
 * quotes percent-encoded), which curl would otherwise refuse or send differently.
 */
export function webhookCurlConfig(webhook: WebhookConfig): string {
  const quoted = (value: string) => `"${escapeCurlConfigValue(value)}"`;
  const lines = [
    '# Written by the Master from notify.webhook in config.yaml, for keepalive.sh and',
    '# self-upgrade.sh to notify when the Master is down; rewritten when the configuration changes.',
    `${WEBHOOK_FORMAT_COMMENT} ${webhook.format}`,
    `url = ${quoted(URL.parse(webhook.url)?.href ?? webhook.url)}`,
    'request = "POST"',
    // Brackets and braces in the address are part of it, not a pattern of addresses.
    'globoff',
  ];
  for (const [name, value] of webhookHeaders(webhook)) {
    // curl drops a header given as "Name:" with nothing after it; "Name;" sends it empty.
    lines.push(`header = ${quoted(value ? `${name}: ${value}` : `${name};`)}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Leaves the webhook's settings in `<home>/webhook.curl` (webhookCurlConfig), or deletes the file
 * when there is no webhook. Only its owner may read it: the address and the headers may carry
 * tokens. Written to a temporary file that is renamed over it, so that a script never reads half
 * of it. Throws when it cannot.
 */
export function writeWebhookCurlFile(home: string, webhook: WebhookConfig | undefined): void {
  const file = webhookCurlFile(home);
  if (!webhook) {
    rmSync(file, { force: true });
    return;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    // Created anew, so that it never has the wider mode of one left over.
    rmSync(tmp, { force: true });
    writeFileSync(tmp, webhookCurlConfig(webhook), { mode: 0o600, flag: 'wx' });
    // The umask may have taken away the owner's bits, which the scripts need.
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * writeWebhookCurlFile at start and after each reload of the configuration. A failure is logged,
 * without the file's contents, and the Master goes on: only the scripts' webhook notifications
 * miss it.
 */
export function saveWebhookCurlFile(
  home: string,
  webhook: WebhookConfig | undefined,
  log: (message: string) => void = (message) => console.warn(message),
): void {
  try {
    writeWebhookCurlFile(home, webhook);
  } catch (err) {
    log(
      t({
        zh: `[通知] 无法更新保活和升级脚本用的 webhook 设置（${webhookCurlFile(home)}）：${errorMessage(err)}`,
        en: `[notify] Could not update the webhook settings the keepalive and upgrade scripts use (${webhookCurlFile(home)}): ${errorMessage(err)}`,
      }),
    );
  }
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

/** How a request went: a failure, or the HTTP status of the webhook's answer. */
type Outcome = Failure | { reason: null; status: number };

/** How the test notification went (the dashboard's button). */
export interface WebhookTestOutcome {
  /** The webhook answered with a 2xx status. */
  ok: boolean;
  /** The HTTP status of the answer; null when there was none. */
  status: number | null;
  /** Why it failed, without the address or the headers; null when it did not. */
  reason: string | null;
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
      const outcome = await this.send(webhook, notice, event);
      if (outcome.reason !== null) {
        this.failed(webhook, outcome);
      } else {
        // It got through: the next failure starts a new streak, told again.
        this.failingUrl = undefined;
      }
    } catch {
      // Logging and recording must not fail the Master either: the store is closed when the
      // Master stopped while the request was out.
    }
  }

  /** POSTs one notification; never rejects: a webhook that gave no answer is a failure too. */
  private async send(
    webhook: WebhookConfig,
    notice: WebhookNotice,
    event: Pick<EventRow, 'type' | 'ts'>,
  ): Promise<Outcome> {
    try {
      const { headers, body } = webhookRequest(webhook, notice, event, this.home);
      const response = await this.fetch(webhook.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      // Nothing is read from the answer; let the connection go.
      await response.body?.cancel().catch(() => {});
      if (response.ok) return { reason: null, status: response.status };
      return {
        reason: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
        status: response.status,
      };
    } catch (err) {
      return { reason: failureReason(err, webhook, this.timeoutMs), status: null };
    }
  }

  /**
   * POSTs a test notification (kind `test`, eventType `notify.test`) to the webhook of the
   * configuration in use, for the dashboard's button, and resolves with how it went; null
   * without a webhook. Never rejects. It notifies of no event: a failure goes back to the button
   * only, neither logged nor recorded, and the streak of failures of the real notifications
   * stays as it was, so that their next failure is told as it would have been.
   */
  async sendTest(title: string, body: string): Promise<WebhookTestOutcome | null> {
    const webhook = this.config().master.notify.webhook;
    if (!webhook) return null;
    const notice: WebhookNotice = { kind: 'test', title, body, runId: null, about: 'master' };
    const { reason, status } = await this.send(webhook, notice, {
      type: TEST_NOTICE_EVENT,
      ts: nowIso(),
    });
    return { ok: reason === null, status, reason };
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
