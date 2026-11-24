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

/** What execFile's error carries besides the message. */
interface CommandError extends Error {
  code?: unknown;
  killed?: unknown;
  signal?: unknown;
}

/** How execFile's message starts for a command that ran and failed. */
const COMMAND_FAILED = 'Command failed:';

/**
 * Why `file` failed, short. Never the first line of execFile's message for a command that ran:
 * Node puts the whole command line there, the notification's texts (a Run's goal) included.
 */
function failureReason(file: string, err: CommandError, stderr = ''): string {
  if (err.code === 'ENOENT') {
    return file === 'notify-send'
      ? t({
          zh: '找不到 notify-send，Linux 上需要安装 libnotify（提供 notify-send）',
          en: 'notify-send was not found; on Linux, install libnotify (it provides notify-send)',
        })
      : t({ zh: `找不到 ${file}`, en: `${file} was not found` });
  }
  // What the command said: its standard error, which execFile also puts after the command line
  // in its message (all there is when the caller passed no stderr on).
  const ran = err.message.startsWith(COMMAND_FAILED);
  const newline = err.message.indexOf('\n');
  const printed = stderr || (ran && newline >= 0 ? err.message.slice(newline + 1) : '');
  const said = firstLine(printed, REASON_MAX);
  const saying = (what: string) => (said ? `${what}${t({ zh: '：', en: ': ' })}${said}` : what);
  // The Master kills it only when it outlived the timeout.
  if (err.killed === true) {
    const seconds = NOTICE_TIMEOUT_MS / 1000;
    return t({
      zh: `${seconds} 秒内无响应被终止`,
      en: `killed after no answer within ${seconds} seconds`,
    });
  }
  if (typeof err.signal === 'string') {
    return saying(t({ zh: `被信号 ${err.signal} 终止`, en: `terminated by signal ${err.signal}` }));
  }
  if (typeof err.code === 'number') {
    return saying(t({ zh: `退出码 ${err.code}`, en: `exit code ${err.code}` }));
  }
  if (ran) return saying(t({ zh: '运行失败', en: 'failed' }));
  return firstLine(err.message, REASON_MAX);
}

/** How sending one system notification went. */
export interface SystemNoticeOutcome {
  /** The command was run and ended well. */
  ok: boolean;
  /** The command run, e.g. notify-send. */
  file: string;
  /** Why it failed; null when it did not. */
  reason: string | null;
}

/**
 * Runs the command that shows a notification on `platform` and hands `done` how it went, once
 * (at once when execFile answers at once). Never throws, whatever `done` does. Returns false,
 * running nothing and calling nothing, where the platform has no command.
 */
function runNoticeCommand(
  platform: NodeJS.Platform,
  execFile: ExecFile,
  title: string,
  body: string,
  done: (outcome: SystemNoticeOutcome) => void,
): boolean {
  const command = noticeCommand(platform, title, body);
  if (!command) return false;
  const { file } = command;
  const report = (outcome: SystemNoticeOutcome) => {
    try {
      done(outcome);
    } catch {
      // Hearing the result must not fail the Master, nor count as a failure to send.
    }
  };
  const failed = (err: unknown, stderr?: string) =>
    report({
      ok: false,
      file,
      reason: failureReason(file, err instanceof Error ? err : new Error(String(err)), stderr),
    });
  try {
    execFile(file, command.args, { timeout: NOTICE_TIMEOUT_MS }, (err, _stdout, stderr) => {
      if (err) failed(err, stderr);
      else report({ ok: true, file, reason: null });
    });
  } catch (err) {
    // execFile throws right away on arguments it cannot pass (e.g. a NUL character).
    failed(err);
  }
  return true;
}

/**
 * Sends one system notification and resolves with how it went, for the dashboard's test
 * notification; null where the platform has no command. Never rejects and logs nothing: the
 * outcome goes back to whoever asked.
 */
export function sendSystemNotice(
  title: string,
  body: string,
  opts: { platform?: NodeJS.Platform; execFile?: ExecFile } = {},
): Promise<SystemNoticeOutcome> | null {
  const { promise, resolve } = Promise.withResolvers<SystemNoticeOutcome>();
  const ran = runNoticeCommand(
    opts.platform ?? process.platform,
    opts.execFile ?? nodeExecFile,
    title,
    body,
    resolve,
  );
  return ran ? promise : null;
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
    runNoticeCommand(platform, execFile, title, body, ({ ok, file, reason }) =>
      done?.(ok ? null : { command: file, reason: reason ?? '' }),
    );
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
 * failures are not, until a notification is shown again. The dashboard's test notification
 * (sendSystemNotice) does not go through it: it neither starts nor ends a streak.
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
