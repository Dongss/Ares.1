import { execFile as nodeExecFile } from 'node:child_process';
import { brandName } from '../brand.js';
import type { LoadedConfig } from '../config/load.js';
import { t } from '../i18n.js';
import type { Store } from '../store/store.js';
import type { EventRow } from '../store/types.js';
import { firstLine, noticeFor } from './notice.js';

/** Why a system notification was not shown: the command and a reason of one short line. */
export interface NoticeFailure {
  command: string;
  reason: string;
}

/**
 * Shows a system notification. `done`, when given, hears how it went: null once it was shown, the
 * failure otherwise. Never called where the platform has no notifications.
 */
export type SendNotice = (
  title: string,
  body: string,
  done?: (failure: NoticeFailure | null) => void,
) => void;

/** The part of child_process.execFile the notifier uses (tests replace it). */
export type ExecFile = (
  file: string,
  args: string[],
  options: { timeout: number },
  callback: (error: Error | null, stdout?: string, stderr?: string) => void,
) => void;

/** A notification command that hangs (e.g. waiting for a D-Bus that never answers) is killed. */
export const NOTICE_TIMEOUT_MS = 10_000;

/** Whether the Master can send system notifications on this platform: macOS and Linux. */
export function systemNoticeSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'linux';
}

/** AppleScript string literal. */
function appleString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** AppleScript that shows a notification titled with the project name, `title` below it. */
export function noticeScript(title: string, body: string): string {
  return `display notification ${appleString(body)} with title ${appleString(brandName())} subtitle ${appleString(title)} sound name "default"`;
}

/** The command that shows a notification on `platform`, or null where there is none. */
export function noticeCommand(
  platform: NodeJS.Platform,
  title: string,
  body: string,
): { file: string; args: string[] } | null {
  // macOS Notification Center through osascript, which needs no extra install.
  if (platform === 'darwin') return { file: 'osascript', args: ['-e', noticeScript(title, body)] };
  // Linux desktops through notify-send (libnotify). The texts go as arguments, never via a shell.
  if (platform === 'linux') {
    return { file: 'notify-send', args: ['--app-name', brandName(), title, body] };
  }
  return null;
}

/** How long a reason may be: one line, enough for an error from the command. */
const REASON_MAX = 200;

/**
 * Why `file` failed, short. Not the error's message when the command exited with an error: Node
 * puts the whole command line there, the notification's texts (a Run's goal) included.
 */
function failureReason(file: string, err: Error, stderr = ''): string {
  const e = err as Error & { code?: unknown; killed?: unknown; signal?: unknown };
  if (e.code === 'ENOENT') {
    return file === 'notify-send'
      ? t({
          zh: '找不到 notify-send，Linux 上需要安装 libnotify（提供 notify-send）',
          en: 'notify-send was not found; on Linux, install libnotify (it provides notify-send)',
        })
      : t({ zh: `找不到 ${file}`, en: `${file} was not found` });
  }
  // The Master kills it only when it outlived the timeout.
  if (e.killed === true) {
    const seconds = NOTICE_TIMEOUT_MS / 1000;
    return t({
      zh: `${seconds} 秒内无响应被终止`,
      en: `killed after no answer within ${seconds} seconds`,
    });
  }
  const said = firstLine(stderr, REASON_MAX);
  if (typeof e.signal === 'string') {
    const by = t({ zh: `被信号 ${e.signal} 终止`, en: `terminated by signal ${e.signal}` });
    return said ? `${by}${t({ zh: '：', en: ': ' })}${said}` : by;
  }
  if (typeof e.code === 'number') {
    const exit = t({ zh: `退出码 ${e.code}`, en: `exit code ${e.code}` });
    return said ? `${exit}${t({ zh: '：', en: ': ' })}${said}` : exit;
  }
  return firstLine(err.message, REASON_MAX);
}

/**
 * A sender of system notifications for `platform`: osascript on macOS, notify-send on Linux,
 * nothing elsewhere. A failure never throws and never stops the Master; it is only reported to
 * `done`, which decides what to tell (see SystemNotifier).
 */
export function makeSystemNotice(
  opts: { platform?: NodeJS.Platform; execFile?: ExecFile } = {},
): SendNotice {
  const platform = opts.platform ?? process.platform;
  const execFile: ExecFile = opts.execFile ?? nodeExecFile;
  return (title, body, done) => {
    const command = noticeCommand(platform, title, body);
    if (!command) return;
    const report = (failure: NoticeFailure | null) => {
      try {
        done?.(failure);
      } catch {
        // Hearing the result must not fail the Master, nor count as a failure to send.
      }
    };
    const failed = (err: unknown, stderr?: string) =>
      report({
        command: command.file,
        reason: failureReason(
          command.file,
          err instanceof Error ? err : new Error(String(err)),
          stderr,
        ),
      });
    try {
      execFile(command.file, command.args, { timeout: NOTICE_TIMEOUT_MS }, (err, _out, stderr) => {
        if (err) failed(err, stderr);
        else report(null);
      });
    } catch (err) {
      // execFile throws right away on arguments it cannot pass (e.g. a NUL character).
      failed(err);
    }
  };
}

/** System notifications of the platform the Master runs on. */
export const systemNotice: SendNotice = makeSystemNotice();

/**
 * System notifications sent by the Master itself, so they arrive without a dashboard tab:
 * only when a human is needed (see notice.ts). Enabled by `notify.system` in config.yaml.
 *
 * The first failure of a streak is logged and recorded as the global event notify.system_failed
 * (on the Events page, where a human coming back sees that no notification reached them); later
 * failures are not, until a notification is shown again.
 */
export class SystemNotifier {
  /** A failure was told and no notification has been shown since. */
  private failing = false;
  private readonly log: (message: string) => void;

  private readonly onEvent = (e: EventRow) => {
    if (!this.config().master.notify.system) return;
    const goal = e.runId ? this.goal(e.runId) : undefined;
    const notice = noticeFor(e, goal);
    if (notice) this.send(notice.title, notice.body, (failure) => this.sent(failure));
  };

  constructor(
    private readonly store: Store,
    private readonly config: () => LoadedConfig,
    private readonly send: SendNotice = systemNotice,
    opts: { log?: (message: string) => void } = {},
  ) {
    this.log = opts.log ?? ((message: string) => console.warn(message));
  }

  private goal(runId: string): string | undefined {
    try {
      return this.store.getRun(runId).goal;
    } catch {
      return undefined;
    }
  }

  private sent(failure: NoticeFailure | null): void {
    if (!failure) {
      // It was shown: the next failure starts a new streak, told again.
      this.failing = false;
      return;
    }
    if (this.failing) return;
    this.failing = true;
    try {
      const { command, reason } = failure;
      this.log(
        t({
          zh: `[通知] 系统通知发送失败（${command}）：${reason}。之后的失败不再记录，直到有通知发送成功。`,
          en: `[notify] Sending a system notification failed (${command}): ${reason}. Later failures are not logged until a notification gets through.`,
        }),
      );
      this.store.tx(() => this.store.event(null, 'notify.system_failed', { command, reason }));
    } catch {
      // Logging and recording must not fail the Master either: the store is closed when the
      // Master stopped while the command ran.
    }
  }

  start(): void {
    this.store.bus.on('event', this.onEvent);
  }

  stop(): void {
    this.store.bus.off('event', this.onEvent);
  }
}
