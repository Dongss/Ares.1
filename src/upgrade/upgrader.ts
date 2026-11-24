import { copyFileSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { UpgradeStatus } from '../api/types.js';
import type { HomePaths, LoadedConfig } from '../config/load.js';
import type { Engine } from '../engine/engine.js';
import { t } from '../i18n.js';
import type { Store } from '../store/store.js';
import type { EventRow } from '../store/types.js';
import { errorMessage, nowIso } from '../util.js';
import { currentBranch, git, isAncestor, revParse } from '../workspace/git.js';

/** What the upgrade script needs (scripts/self-upgrade.sh). */
export interface UpgradePlan {
  installDir: string;
  from: string;
  to: string;
  /** The script writes how it went here; the next Master reports it. */
  resultFile: string;
}

export interface UpgraderDeps {
  store: Store;
  engine: Engine;
  paths: HomePaths;
  config: () => LoadedConfig;
  /**
   * The git checkout the running Master was built from (its `dist/cli.js`); null when it does
   * not run from a build, e.g. with tsx from the dev repo, and can not upgrade itself.
   */
  installDir: string | null;
  /** Work besides Runs that an upgrade must not cut off, e.g. a running scout. */
  busy: () => boolean;
  /** Start the upgrade script and stop this Master. */
  launch: (plan: UpgradePlan) => Promise<void>;
  /** Whether the node this Master runs on is gone; default `execPathMissing`. */
  nodeMissing?: () => boolean;
  /** The current time in epoch milliseconds (tests move it on); default Date.now. */
  now?: () => number;
}

/**
 * Whether the node this process runs on is gone: a version manager (nvm) deletes a version's
 * directory when it is uninstalled. The process keeps running, but whatever it starts that needs
 * that node (npm, through a PATH that still leads there) no longer finds it.
 */
export function execPathMissing(): boolean {
  return !existsSync(process.execPath);
}

const CHECK_EVERY_MS = 2 * 60_000;
/** The longest wait before trying again a target whose upgrade failed for the environment. */
const MAX_ENV_RETRY_MS = 60 * 60_000;
const FAILED_KEY = 'upgrade.failed_to';
/**
 * The commit the launched script was asked to upgrade to. A failed result is recorded against it
 * rather than the script's `to`: when the pull fails, HEAD (and so `to`) is still the old commit,
 * and recording that would retry the real target on every check.
 */
const TARGET_KEY = 'upgrade.target';

/** How a finished upgrade went, written by the script. */
const UpgradeResultSchema = z.object({
  ok: z.boolean(),
  from: z.string(),
  to: z.string(),
  message: z.string().optional(),
  /** On failure, the end of the output that says why (the build's, or the new Master's). */
  detail: z.string().optional(),
  /**
   * The failure is the environment's, not the commit's: the script found no usable node, or no
   * npm (the build exited with 127).
   */
  env: z.boolean().optional(),
});
type UpgradeResult = z.infer<typeof UpgradeResultSchema>;

/**
 * A target whose upgrade failed for the environment (`env` in the result): it is not given up like
 * other failures, but tried again from `after` on, once the environment may be fixed. The wait
 * doubles with each such failure of the same target (`failures`), from one check interval up to
 * `MAX_ENV_RETRY_MS`, so that an environment that stays broken does not stop and rebuild the
 * Master every few minutes.
 */
const ENV_RETRY_KEY = 'upgrade.env_retry';

const EnvRetrySchema = z.object({
  to: z.string(),
  failures: z.number().int().positive(),
  /** Not before this, in epoch milliseconds. */
  after: z.number(),
});
type EnvRetry = z.infer<typeof EnvRetrySchema>;

/** How long to wait before trying a target again after its `failures`-th environment failure. */
export function envRetryDelayMs(failures: number): number {
  return Math.min(CHECK_EVERY_MS * 2 ** Math.max(0, failures - 1), MAX_ENV_RETRY_MS);
}

/**
 * The last upgrade the script tried that failed, kept until an upgrade succeeds: the scout of the
 * Master's own repo is shown it, so that the system fixes the version it cannot build or start.
 */
const LAST_FAILURE_KEY = 'upgrade.last_failure';

const UpgradeFailureSchema = z.object({
  from: z.string(),
  /** The commit that failed; empty when the script could not tell. */
  to: z.string(),
  message: z.string(),
  detail: z.string().nullable(),
  at: z.string(),
  /**
   * The failure is the environment's (no usable node or npm), not the commit's: the scout is not
   * asked to fix the code for it. Missing in records written before the field existed.
   */
  env: z.boolean().optional(),
});
export type UpgradeFailure = z.infer<typeof UpgradeFailureSchema>;

/** The last upgrade that failed, if no upgrade has succeeded since. */
export function lastUpgradeFailure(store: Store): UpgradeFailure | null {
  const value = store.getSetting(LAST_FAILURE_KEY);
  if (!value) return null;
  try {
    const parsed = UpgradeFailureSchema.safeParse(JSON.parse(value));
    return parsed.success ? { ...parsed.data, env: parsed.data.env ?? false } : null;
  } catch {
    return null;
  }
}

/**
 * Puts a copy of the upgrade script at `dest` by renaming a fresh copy over it, never by writing
 * into it. An earlier script may still be running from `dest`: it watches the new Master for a
 * few minutes, and that Master may start the next upgrade meanwhile. bash reads its script as it
 * goes, so the file it has open must not change; after a rename it keeps reading the old one.
 */
export function copyUpgradeScript(source: string, dest: string): void {
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    copyFileSync(source, tmp);
    renameSync(tmp, dest);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** The script's result file; one that cannot be read counts as a failed upgrade. */
function readResult(file: string): UpgradeResult {
  try {
    const parsed = UpgradeResultSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (parsed.success) return parsed.data;
  } catch {}
  return {
    ok: false,
    from: '',
    to: '',
    message: t({
      zh: '升级结果文件无法解析',
      en: 'The upgrade result file could not be parsed',
    }),
  };
}

/**
 * Keeps the Master on the latest commit of its install directory's origin: when the stable
 * copy falls behind (a Run merged into the dev repo), it holds the queue, waits for the executing
 * Run and any scout, then hands over to scripts/self-upgrade.sh, which pulls, builds, restarts and
 * rolls back if the new version does not come up. Once it answers, the script watches it for five
 * minutes (ARES1_UPGRADE_WATCH in the environment sets the seconds): an exit with a non-zero code
 * meanwhile rolls back too, an exit with 0 (stopped on purpose, or handing over to the next
 * upgrade) does not. A target that failed once (pulling, building, starting it or keeping it
 * running) is not retried; a newer commit on origin is. A failure the script puts down to the
 * environment (no node or npm) is retried, after a wait (`ENV_RETRY_KEY`).
 *
 * The node this Master runs on may be deleted under it (`nodeMissing`; a version manager switched
 * versions): then it restarts through the same script on the commit it runs, and the script finds
 * the node to use.
 *
 * A failure found while watching comes after the new version already read the success the script
 * wrote before starting it, and cleared the planned target; the failure is then recorded against
 * the script's `to`, which is past `from`.
 */
export class Upgrader {
  private timer: ReturnType<typeof setInterval> | undefined;
  private soon: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | null = null;
  private launched = false;
  private state: Omit<UpgradeStatus, 'auto' | 'installDir'> = {
    current: null,
    latest: null,
    state: 'idle',
    message: null,
    checkedAt: null,
  };
  private lastProblem: string | null = null;
  private readonly onEvent = (e: EventRow) => {
    if (e.type === 'run.status' || e.type === 'master.working' || e.type.startsWith('scout.')) {
      this.checkSoon();
    }
  };

  constructor(private readonly deps: UpgraderDeps) {}

  get resultFile(): string {
    return join(this.deps.paths.dataDir, 'upgrade-result.json');
  }

  start(opts: { timer: boolean } = { timer: true }): void {
    this.reportResult();
    this.deps.store.bus.on('event', this.onEvent);
    if (opts.timer) {
      this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
      this.checkSoon(5_000);
    }
  }

  stop(): void {
    this.deps.store.bus.off('event', this.onEvent);
    clearInterval(this.timer);
    clearTimeout(this.soon);
  }

  private checkSoon(delayMs = 1_000): void {
    clearTimeout(this.soon);
    this.soon = setTimeout(() => void this.check(), delayMs);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The target waiting to be tried again after failing for the environment, if any. */
  private envRetry(): EnvRetry | null {
    const value = this.deps.store.getSetting(ENV_RETRY_KEY);
    if (!value) return null;
    try {
      const parsed = EnvRetrySchema.safeParse(JSON.parse(value));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** Report what the last upgrade script did, once. */
  private reportResult(): void {
    if (!existsSync(this.resultFile)) return;
    const result = readResult(this.resultFile);
    rmSync(this.resultFile, { force: true });
    const store = this.deps.store;
    store.tx(() => {
      const target = store.getSetting(TARGET_KEY);
      store.setSetting(TARGET_KEY, null);
      const envBefore = this.envRetry();
      store.setSetting(ENV_RETRY_KEY, null);
      if (result.ok) {
        store.setSetting(FAILED_KEY, null);
        store.setSetting(LAST_FAILURE_KEY, null);
        store.event(null, 'upgrade.done', { from: result.from, to: result.to });
      } else {
        // Without a planned target, trust the script's `to` only if it moved past `from`.
        const failed = target ?? (result.to && result.to !== result.from ? result.to : '');
        // The environment's failure says nothing about the commit: try it again later.
        let repeated = false;
        if (result.env && failed) {
          const failures = envBefore?.to === failed ? envBefore.failures + 1 : 1;
          repeated = failures > 1;
          const retry: EnvRetry = {
            to: failed,
            failures,
            after: this.now() + envRetryDelayMs(failures),
          };
          store.setSetting(ENV_RETRY_KEY, JSON.stringify(retry));
        } else if (failed) {
          store.setSetting(FAILED_KEY, failed);
        }
        const message = result.message || t({ zh: '升级失败', en: 'The upgrade failed' });
        const detail = result.detail?.trim() ? result.detail : null;
        const failure: UpgradeFailure = {
          from: result.from,
          to: failed,
          message,
          detail,
          at: nowIso(),
          ...(result.env ? { env: true } : {}),
        };
        store.setSetting(LAST_FAILURE_KEY, JSON.stringify(failure));
        store.event(null, 'upgrade.failed', {
          from: result.from,
          to: failed,
          message,
          ...(detail ? { detail } : {}),
          // The same environment problem again: notified the first time (notice.ts).
          ...(result.env ? { env: true } : {}),
          ...(repeated ? { repeated: true } : {}),
        });
      }
    });
  }

  status(): UpgradeStatus {
    return {
      auto: this.deps.config().master.upgrade.auto,
      installDir: this.deps.installDir,
      ...this.state,
    };
  }

  /** Look at the install directory now; upgrade when it is behind and nothing is in the way. */
  check(): Promise<void> {
    this.running ??= this.doCheck().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private set(state: UpgradeStatus['state'], message: string | null = null): void {
    this.state = { ...this.state, state, message, checkedAt: nowIso() };
  }

  /** A problem that needs a human: notify once per distinct problem (upgrade.failed). */
  private problem(message: string): void {
    this.set('blocked', message);
    if (this.lastProblem !== message) {
      this.deps.store.event(null, 'upgrade.failed', { message });
    }
    this.lastProblem = message;
  }

  private async doCheck(): Promise<void> {
    const { engine, store, installDir } = this.deps;
    if (this.launched) return;
    this.reportResult();
    if ((this.deps.nodeMissing ?? execPathMissing)()) return this.restartForNode();
    const release = () => {
      if (engine.held) engine.hold(false);
    };
    if (!this.deps.config().master.upgrade.auto) {
      release();
      return this.set('off');
    }
    if (!installDir) {
      release();
      return this.set(
        'unavailable',
        t({
          zh: '这个 Master 不是从构建产物（dist/cli.js）启动的，不能自动升级',
          en: 'This Master was not started from a build (dist/cli.js), so it cannot upgrade itself',
        }),
      );
    }
    if (!store.working) {
      release();
      return this.set('waiting', t({ zh: '已停工', en: 'Work is switched off' }));
    }
    let from: string;
    let to: string;
    try {
      await git(installDir, ['fetch', '-q', 'origin']);
      const branch = await currentBranch(installDir);
      from = await revParse(installDir, 'HEAD');
      to = await revParse(installDir, `origin/${branch}`);
      this.state = { ...this.state, current: from, latest: to };
      if (from === to) {
        release();
        this.lastProblem = null;
        return this.set('up_to_date');
      }
      if (!(await isAncestor(installDir, from, to))) {
        release();
        return this.problem(
          t({
            zh: `安装目录 ${installDir} 与 origin 分叉了，不能快进，请手动处理`,
            en: `The install directory ${installDir} has diverged from origin and cannot fast-forward; please sort it out by hand`,
          }),
        );
      }
      const dirty = await git(installDir, ['status', '--porcelain', '--untracked-files=no']);
      if (dirty) {
        release();
        return this.problem(
          t({
            zh: `安装目录 ${installDir} 有未提交的改动，不能自动升级`,
            en: `The install directory ${installDir} has uncommitted changes, so it cannot upgrade automatically`,
          }),
        );
      }
    } catch (err) {
      release();
      return this.problem(
        t({
          zh: `检查新版本失败：${errorMessage(err)}`,
          en: `Checking for a new version failed: ${errorMessage(err)}`,
        }),
      );
    }
    if (store.getSetting(FAILED_KEY) === to) {
      release();
      return this.set(
        'skipped',
        t({
          zh: `升级到 ${to.slice(0, 7)} 失败过，等有新的提交再试`,
          en: `Upgrading to ${to.slice(0, 7)} failed before; waiting for a newer commit`,
        }),
      );
    }
    const envRetry = this.envRetry();
    if (envRetry?.to === to && envRetry.after > this.now()) {
      release();
      const after = new Date(envRetry.after);
      const at = [after.getHours(), after.getMinutes()]
        .map((n) => String(n).padStart(2, '0'))
        .join(':');
      return this.set(
        'skipped',
        t({
          zh: `升级到 ${to.slice(0, 7)} 时找不到能用的 node 或 npm（运行环境的问题），${at} 之后再试`,
          en: `Upgrading to ${to.slice(0, 7)} found no usable node or npm (a problem of the environment); trying again after ${at}`,
        }),
      );
    }
    // Let the executing Runs of every repo (and a scout) finish; start nothing new meanwhile.
    engine.hold(true);
    if (engine.activeRunIds.length > 0 || this.deps.busy()) {
      return this.set(
        'waiting',
        t({
          zh: '等正在执行的工作做完再升级',
          en: 'Waiting for the work in progress to finish before upgrading',
        }),
      );
    }
    this.launched = true;
    this.set('upgrading', `${from.slice(0, 7)} → ${to.slice(0, 7)}`);
    store.tx(() => {
      store.setSetting(TARGET_KEY, to);
      store.event(null, 'upgrade.started', { from, to });
    });
    await this.handOver({ installDir, from, to, resultFile: this.resultFile });
  }

  /** Start the script (which stops this Master); a script that could not start is a problem. */
  private async handOver(plan: UpgradePlan): Promise<void> {
    const { engine, store } = this.deps;
    try {
      await this.deps.launch(plan);
    } catch (err) {
      this.launched = false;
      store.setSetting(TARGET_KEY, null);
      if (engine.held) engine.hold(false);
      this.problem(
        t({
          zh: `启动升级失败：${errorMessage(err)}`,
          en: `Starting the upgrade failed: ${errorMessage(err)}`,
        }),
      );
    }
  }

  /**
   * The node this Master runs on is gone (a version manager deleted it): the commands it runs
   * would no longer find node or npm, and nothing this process does brings them back. It restarts
   * through the upgrade script on the commit it runs (`to` equals `from`); the script finds the
   * node to use, builds and starts the Master, and rolls back like after a failed upgrade. Nothing
   * is waited for, since no Run can pass its checks meanwhile: closing interrupts the executing
   * Run and any scout, and the next Master recovers the Run like after any restart, and Runs
   * blocked on the environment go on (`Engine.start`). Neither `upgrade.auto` nor the work switch
   * matter: this keeps the Master running and does not change its version.
   */
  private async restartForNode(): Promise<void> {
    const { engine, store, installDir } = this.deps;
    const node = process.execPath;
    if (!installDir) {
      return this.problem(
        t({
          zh: `Master 正在用的 node（${node}）已经不存在了（比如换 Node 版本时被删掉），这个 Master 不是从构建产物（dist/cli.js）启动的，不能自己重启，请手动重启它`,
          en: `The node this Master runs on (${node}) is gone (deleted when switching Node versions, say), and this Master was not started from a build (dist/cli.js), so it cannot restart itself; please restart it by hand`,
        }),
      );
    }
    let from: string;
    try {
      from = await revParse(installDir, 'HEAD');
    } catch (err) {
      return this.problem(
        t({
          zh: `Master 正在用的 node（${node}）已经不存在了，但读不出当前的提交，没法重启：${errorMessage(err)}`,
          en: `The node this Master runs on (${node}) is gone, but the current commit could not be read, so it cannot restart: ${errorMessage(err)}`,
        }),
      );
    }
    if (this.launched) return;
    this.launched = true;
    engine.hold(true);
    const message = t({
      zh: `Master 正在用的 node（${node}）已经不存在了（比如换 Node 版本时被删掉），检查命令跑不了；正在找能用的 node，在当前版本 ${from.slice(0, 7)} 上重启，手上的 Run 重启后接着做`,
      en: `The node this Master runs on (${node}) is gone (deleted when switching Node versions, say), so no checks can run; finding a usable node and restarting on the same version ${from.slice(0, 7)}, and the Runs in hand go on after the restart`,
    });
    this.set('upgrading', message);
    console.warn(message);
    store.tx(() => {
      store.setSetting(TARGET_KEY, from);
      store.event(null, 'master.node_missing', { node, commit: from });
      store.event(null, 'upgrade.started', { from, to: from, reason: 'node_missing' });
    });
    await this.handOver({ installDir, from, to: from, resultFile: this.resultFile });
  }
}
