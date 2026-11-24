import { execFile as nodeExecFile } from 'node:child_process';
import { brandName } from '../brand.js';
import type { LoadedConfig } from '../config/load.js';
import { t } from '../i18n.js';
import type { Store } from '../store/store.js';
import type { EventRow } from '../store/types.js';
import { noticeFor } from './notice.js';

export type SendNotice = (title: string, body: string) => void;

/** The part of child_process.execFile the notifier uses (tests replace it). */
export type ExecFile = (
  file: string,
  args: string[],
  options: { timeout: number },
  callback: (error: Error | null) => void,
) => void;

/** A notification command that hangs (e.g. waiting for a D-Bus that never answers) is killed. */
const NOTICE_TIMEOUT_MS = 10_000;

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

/** What execFile's error carries besides the message. */
interface CommandError extends Error {
  code?: unknown;
  killed?: unknown;
  signal?: unknown;
}

function failureReason(file: string, err: CommandError): string {
  if (err.code === 'ENOENT') {
    return file === 'notify-send'
      ? t({
          zh: '找不到 notify-send，Linux 上需要安装 libnotify（提供 notify-send）',
          en: 'notify-send was not found; on Linux, install libnotify (it provides notify-send)',
        })
      : t({ zh: `找不到 ${file}`, en: `${file} was not found` });
  }
  // execFile's message starts with the whole command line, the notification's texts included;
  // what the command printed comes after it.
  const newline = err.message.indexOf('\n');
  if (!err.message.startsWith('Command failed:') || newline < 0) return err.message;
  const printed = err.message.slice(newline + 1).trim();
  const ended =
    err.killed === true
      ? t({
          zh: `${file} 在 ${NOTICE_TIMEOUT_MS / 1000} 秒内没有结束`,
          en: `${file} did not finish within ${NOTICE_TIMEOUT_MS / 1000} seconds`,
        })
      : typeof err.code === 'number'
        ? t({ zh: `${file} 退出码 ${err.code}`, en: `${file} exited with code ${err.code}` })
        : typeof err.signal === 'string'
          ? t({ zh: `${file} 被 ${err.signal} 结束`, en: `${file} was ended by ${err.signal}` })
          : t({ zh: `${file} 运行失败`, en: `${file} failed` });
  return printed ? `${ended}${t({ zh: '：', en: ': ' })}${printed}` : ended;
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
 * Runs the command that shows a notification on `platform` and hands `done` how it went
 * (at once when execFile answers at once). Never throws. Returns false, running nothing and
 * calling nothing, where the platform has no command.
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
  const failed = (err: unknown) =>
    done({
      ok: false,
      file,
      reason: failureReason(file, err instanceof Error ? err : new Error(String(err))),
    });
  try {
    execFile(file, command.args, { timeout: NOTICE_TIMEOUT_MS }, (err) => {
      if (err) failed(err);
      else done({ ok: true, file, reason: null });
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
 * nothing elsewhere. A failure never throws and never stops the Master; only the first one is
 * logged, so that a missing command does not fill the log with one line per notification.
 */
export function makeSystemNotice(
  opts: { platform?: NodeJS.Platform; execFile?: ExecFile; log?: (message: string) => void } = {},
): SendNotice {
  const platform = opts.platform ?? process.platform;
  const execFile: ExecFile = opts.execFile ?? nodeExecFile;
  const log = opts.log ?? ((message: string) => console.warn(message));
  let logged = false;
  const done = ({ ok, file, reason }: SystemNoticeOutcome) => {
    if (ok || logged) return;
    logged = true;
    log(
      t({
        zh: `[通知] 系统通知发送失败（${file}）：${reason}。之后的失败不再记录。`,
        en: `[notify] Sending a system notification failed (${file}): ${reason}. Later failures are not logged.`,
      }),
    );
  };
  return (title, body) => {
    runNoticeCommand(platform, execFile, title, body, done);
  };
}

/** System notifications of the platform the Master runs on. */
export const systemNotice: SendNotice = makeSystemNotice();

/**
 * System notifications sent by the Master itself, so they arrive without a dashboard tab:
 * only when a human is needed (see notice.ts). Enabled by `notify.system` in config.yaml.
 */
export class SystemNotifier {
  private readonly onEvent = (e: EventRow) => {
    if (!this.config().master.notify.system) return;
    const goal = e.runId ? this.goal(e.runId) : undefined;
    const notice = noticeFor(e, goal);
    if (notice) this.send(notice.title, notice.body);
  };

  constructor(
    private readonly store: Store,
    private readonly config: () => LoadedConfig,
    private readonly send: SendNotice = systemNotice,
  ) {}

  private goal(runId: string): string | undefined {
    try {
      return this.store.getRun(runId).goal;
    } catch {
      return undefined;
    }
  }

  start(): void {
    this.store.bus.on('event', this.onEvent);
  }

  stop(): void {
    this.store.bus.off('event', this.onEvent);
  }
}
