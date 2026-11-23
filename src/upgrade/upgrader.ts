import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
}

const CHECK_EVERY_MS = 2 * 60_000;
const FAILED_KEY = 'upgrade.failed_to';
/**
 * The commit the launched script was asked to upgrade to. A failed result is recorded against it
 * rather than the script's `to`: when the pull fails, HEAD (and so `to`) is still the old commit,
 * and recording that would retry the real target on every check.
 */
const TARGET_KEY = 'upgrade.target';

/** How a finished upgrade went, written by the script. */
interface UpgradeResult {
  ok: boolean;
  from: string;
  to: string;
  message?: string;
}

/**
 * Keeps the Master on the latest commit of its install directory's origin: when the stable
 * copy falls behind (a Run merged into the dev repo), it holds the queue, waits for the executing
 * Run and any scout, then hands over to scripts/self-upgrade.sh, which pulls, builds, restarts and
 * rolls back if the new version does not come up. A target that failed once (pulling, building
 * or starting it) is not retried; a newer commit on origin is.
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

  /** Report what the last upgrade script did, once. */
  private reportResult(): void {
    if (!existsSync(this.resultFile)) return;
    let result: UpgradeResult;
    try {
      result = JSON.parse(readFileSync(this.resultFile, 'utf8')) as UpgradeResult;
    } catch {
      result = {
        ok: false,
        from: '',
        to: '',
        message: t({
          zh: '升级结果文件无法解析',
          en: 'The upgrade result file could not be parsed',
        }),
      };
    }
    rmSync(this.resultFile, { force: true });
    const store = this.deps.store;
    store.tx(() => {
      const target = store.getSetting(TARGET_KEY);
      store.setSetting(TARGET_KEY, null);
      if (result.ok) {
        store.setSetting(FAILED_KEY, null);
        store.event(null, 'upgrade.done', { from: result.from, to: result.to });
      } else {
        // Without a planned target, trust the script's `to` only if it moved past `from`.
        const failed = target ?? (result.to && result.to !== result.from ? result.to : '');
        if (failed) store.setSetting(FAILED_KEY, failed);
        store.event(null, 'upgrade.failed', {
          from: result.from,
          to: failed,
          message: result.message ?? t({ zh: '升级失败', en: 'The upgrade failed' }),
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
    // Let the executing Run (and a scout) finish; start nothing new meanwhile.
    engine.hold(true);
    if (engine.activeRunId || this.deps.busy()) {
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
    try {
      await this.deps.launch({ installDir, from, to, resultFile: this.resultFile });
    } catch (err) {
      this.launched = false;
      store.setSetting(TARGET_KEY, null);
      release();
      this.problem(
        t({
          zh: `启动升级失败：${errorMessage(err)}`,
          en: `Starting the upgrade failed: ${errorMessage(err)}`,
        }),
      );
    }
  }
}
