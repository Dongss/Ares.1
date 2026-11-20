import { execFile } from 'node:child_process';
import { brandName } from '../brand.js';
import type { LoadedConfig } from '../config/load.js';
import type { Store } from '../store/store.js';
import type { EventRow } from '../store/types.js';
import { noticeFor } from './notice.js';

export type SendNotice = (title: string, body: string) => void;

/** AppleScript string literal. */
function appleString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** AppleScript that shows a notification titled with the project name, `title` below it. */
export function noticeScript(title: string, body: string): string {
  return `display notification ${appleString(body)} with title ${appleString(brandName())} subtitle ${appleString(title)} sound name "default"`;
}

/** macOS Notification Center, through osascript (no extra install). Failures are ignored. */
export const macNotice: SendNotice = (title, body) => {
  if (process.platform !== 'darwin') return;
  execFile('osascript', ['-e', noticeScript(title, body)], () => {});
};

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
    private readonly send: SendNotice = macNotice,
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
