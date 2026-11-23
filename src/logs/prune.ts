// Deletes the raw output of agents once it is past retention (`runRawLogsExpired`,
// `scoutRawLogExpired` in src/config/flow.ts), so that a Master that never stops does not fill
// the disk. Only the raw stream and its stderr go: the normalized events the dashboard shows,
// verify, setup, command and merge logs and artifacts stay. Each round can do more housekeeping
// of the kind (the Master removes leftover worktrees with it), given as `onRound`.

import { rmSync, statSync } from 'node:fs';
import { runRawLogsExpired, scoutRawLogExpired } from '../config/flow.js';
import { t } from '../i18n.js';
import type { Store } from '../store/store.js';
import { errorMessage } from '../util.js';

/** How often the Master looks for raw logs past retention, after once at start. */
export const PRUNE_RAW_LOGS_EVERY_MS = 24 * 3_600_000;

/** What one round deleted; recorded as the data of a `logs.pruned` event. */
export interface PrunedRawLogs {
  /** Runs with at least one raw log deleted. */
  runs: number;
  /** Scouts whose raw log was deleted. */
  scouts: number;
  files: number;
  /** Their sizes before they were deleted. */
  bytes: number;
}

/** The raw log files of an execution or a scout: the CLI's stdout and its stderr beside it. */
export function rawLogFiles(logPath: string): string[] {
  // An empty path would name the Master's working directory.
  return logPath ? [logPath, `${logPath}.stderr`] : [];
}

/** Removes the raw logs past retention, at start and then about daily, until stopped. */
export class RawLogPruner {
  private timer: NodeJS.Timeout | undefined;
  /** Files that could not be deleted, reported once each. */
  private readonly warned = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
    /**
     * Started after the raw logs in each round, at start and then about daily, and not waited
     * for; it reports its own failures.
     */
    private readonly onRound?: () => void,
  ) {}

  start(opts: { timer?: boolean } = {}): void {
    this.round();
    if (opts.timer === false) return;
    this.timer = setInterval(() => this.round(), PRUNE_RAW_LOGS_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One round: deletes the raw logs of the Runs and scouts past retention, and records
   * `logs.pruned` when it deleted any file. Files already gone are skipped, so a later round over
   * the same Runs deletes nothing and records nothing.
   */
  prune(): PrunedRawLogs {
    const now = this.now();
    const pruned: PrunedRawLogs = { runs: 0, scouts: 0, files: 0, bytes: 0 };
    for (const run of this.store.listRuns()) {
      if (!runRawLogsExpired(run, now)) continue;
      let deleted = false;
      for (const attempt of this.store.listRunAttempts(run.id)) {
        for (const file of rawLogFiles(attempt.logPath)) {
          deleted = this.remove(file, pruned) || deleted;
        }
      }
      if (deleted) pruned.runs++;
    }
    for (const scout of this.store.listScouts({ limit: null })) {
      if (!scoutRawLogExpired(scout, now)) continue;
      let deleted = false;
      for (const file of rawLogFiles(scout.logPath)) {
        deleted = this.remove(file, pruned) || deleted;
      }
      if (deleted) pruned.scouts++;
    }
    if (pruned.files > 0) this.store.event(null, 'logs.pruned', { ...pruned });
    return pruned;
  }

  private round(): void {
    this.safePrune();
    this.onRound?.();
  }

  /** A round that cannot fail the Master: a broken one is reported and tried again next time. */
  private safePrune(): void {
    try {
      this.prune();
    } catch (err) {
      console.warn(
        t({
          zh: `[日志] 清理超过保留期的 Agent 原始日志失败：${errorMessage(err)}`,
          en: `[logs] Could not delete the raw agent logs past retention: ${errorMessage(err)}`,
        }),
      );
    }
  }

  /** Deletes one file and counts it; false when it was not there or could not be deleted. */
  private remove(file: string, pruned: PrunedRawLogs): boolean {
    let size: number;
    try {
      const stat = statSync(file);
      if (!stat.isFile()) return false;
      size = stat.size;
      rmSync(file, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      if (!this.warned.has(file)) {
        this.warned.add(file);
        console.warn(
          t({
            zh: `[日志] 删除超过保留期的 Agent 原始日志 ${file} 失败：${errorMessage(err)}`,
            en: `[logs] Could not delete ${file}, a raw agent log past retention: ${errorMessage(err)}`,
          }),
        );
      }
      return false;
    }
    this.warned.delete(file);
    pruned.files++;
    pruned.bytes += size;
    return true;
  }
}
