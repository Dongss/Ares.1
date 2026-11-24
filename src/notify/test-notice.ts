import type { NotifyTestResult } from '../api/types.js';
import type { LoadedConfig } from '../config/load.js';
import { t } from '../i18n.js';
import { type ExecFile, sendSystemNotice, systemNoticeSupported } from './system.js';
import type { WebhookNotifier } from './webhook.js';

/** The title and body of the test notification. */
export function testNoticeText(): { title: string; body: string } {
  return {
    title: t({ zh: '测试通知', en: 'Test notification' }),
    body: t({
      zh: '这是一条测试通知，收到说明通知通道可用。',
      en: 'This is a test notification. If you got it, this channel works.',
    }),
  };
}

/**
 * Sends the test notification a human asks for on the dashboard through each channel the
 * configuration in use enables: a system notification where `notify.system` is on and the
 * platform has one, and the webhook of `notify.webhook`. Both go out at once; resolves when
 * both have ended (the webhook within its timeout). Never rejects and records no event: it is
 * a check of the channels, not a notification of something that happened.
 */
export async function sendTestNotice(opts: {
  config: LoadedConfig;
  platform: NodeJS.Platform;
  webhook: WebhookNotifier;
  /** Runs the system notification's command (tests replace it). */
  execFile?: ExecFile;
}): Promise<NotifyTestResult> {
  const { title, body } = testNoticeText();
  const supported = systemNoticeSupported(opts.platform);
  const [system, webhook] = await Promise.all([
    opts.config.master.notify.system && supported
      ? sendSystemNotice(title, body, { platform: opts.platform, execFile: opts.execFile })
      : null,
    opts.webhook.sendTest(title, body),
  ]);
  return {
    system: system
      ? { enabled: true, supported, ok: system.ok, reason: system.reason }
      : { enabled: false, supported, ok: false, reason: null },
    webhook: webhook
      ? { enabled: true, ...webhook }
      : { enabled: false, ok: false, status: null, reason: null },
  };
}
