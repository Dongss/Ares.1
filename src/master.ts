import { spawn } from 'node:child_process';
import { copyFileSync, openSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { ClaudeCodeAdapter } from './adapters/claude-code.js';
import { CursorAgentAdapter } from './adapters/cursor-agent.js';
import type { AgentAdapter } from './adapters/types.js';
import { createApi } from './api/server.js';
import { defaultWebDir } from './api/static.js';
import { brandName } from './brand.js';
import {
  type HomePaths,
  homePaths,
  initHome,
  type LoadedConfig,
  loadConfig,
} from './config/load.js';
import { ConfigWatcher } from './config/watch.js';
import { Engine } from './engine/engine.js';
import { IssueBridge } from './github/bridge.js';
import type { GitHub } from './github/client.js';
import { type Lang, lang, setLang } from './i18n.js';
import { type SendNotice, SystemNotifier } from './notify/system.js';
import { Store } from './store/store.js';
import { type UpgradePlan, Upgrader } from './upgrade/upgrader.js';
import { revParse } from './workspace/git.js';

/** CLIs with a built-in adapter. */
export const BUILTIN_CLIS = ['claude-code', 'cursor-agent'];
/** Built-in CLIs whose adapter can run an agent read-only (`supportsReadOnly`). */
export const BUILTIN_READ_ONLY_CLIS = ['claude-code'];

export interface MasterOptions {
  home: string;
  /** Overrides config.yaml's port; 0 picks a free port. */
  port?: number;
  /** Replace the built-in adapters (tests use FakeAdapter). */
  adapters?: AgentAdapter[];
  /** Built dashboard directory; defaults to `<package>/dist/web`. */
  webDir?: string;
  /** Reload the configuration when its files change (default true). */
  watchConfig?: boolean;
  /** Replace gh (tests use an in-memory GitHub). */
  github?: GitHub;
  /** Poll GitHub on a timer (default true); tests call `issues.poll()` themselves. */
  pollIssues?: boolean;
  /**
   * The git checkout this Master was built from, for upgrading itself; null/omitted =
   * cannot upgrade itself. The CLI passes it when running from `dist/`.
   */
  installDir?: string | null;
  /** Check for upgrades on a timer (default true); tests call `upgrader.check()` themselves. */
  upgradeTimer?: boolean;
  /** Start the upgrade script (tests replace it); the Master closes and exits after it. */
  launchUpgrade?: (plan: UpgradePlan) => void;
  /** End the process after handing over to the upgrade script (default process.exit). */
  exit?: () => void;
  /** Send a system notification (tests replace it). */
  notice?: SendNotice;
  /**
   * Language of the default config files written on first start (the CLI passes the system's);
   * omitted = the default. After that, config.yaml's `language` is the one in use.
   */
  language?: Lang;
}

/** Start scripts/self-upgrade.sh detached; it waits for this process to exit. */
function launchUpgradeScript(paths: HomePaths, port: number, plan: UpgradePlan): void {
  // A copy, so that `git pull` does not rewrite the script while bash reads it.
  const script = join(paths.dataDir, 'self-upgrade.sh');
  copyFileSync(join(plan.installDir, 'scripts', 'self-upgrade.sh'), script);
  const log = openSync(join(paths.home, 'upgrade.log'), 'a');
  spawn(
    'bash',
    [
      script,
      plan.installDir,
      paths.home,
      String(process.pid),
      plan.from,
      plan.resultFile,
      process.execPath,
      String(port),
      brandName(),
      lang(),
    ],
    { detached: true, stdio: ['ignore', log, log], env: process.env },
  ).unref();
}

/** Wires config, store, engine and API together. */
export class Master {
  private server: Server | undefined;

  private constructor(
    readonly paths: HomePaths,
    readonly configWatcher: ConfigWatcher,
    readonly store: Store,
    readonly engine: Engine,
    readonly issues: IssueBridge,
    readonly notifier: SystemNotifier,
    readonly upgrader: Upgrader,
    readonly app: Hono,
  ) {}

  /** The configuration in use; reloaded when the files change. */
  get config(): LoadedConfig {
    return this.configWatcher.current;
  }

  /** Open the home directory, load config and recover state. Throws if config.yaml is invalid. */
  static async open(opts: MasterOptions): Promise<Master> {
    const paths = homePaths(opts.home);
    if (opts.language) setLang(opts.language);
    initHome(paths);
    const builtin = (cfg: LoadedConfig['master']): AgentAdapter[] => [
      new ClaudeCodeAdapter(cfg.bins['claude-code'] ?? 'claude'),
      new CursorAgentAdapter(cfg.bins['cursor-agent'] ?? 'cursor-agent'),
    ];
    const knownClis = opts.adapters ? opts.adapters.map((a) => a.cli) : BUILTIN_CLIS;
    const readOnlyClis = opts.adapters
      ? opts.adapters.filter((a) => a.supportsReadOnly).map((a) => a.cli)
      : BUILTIN_READ_ONLY_CLIS;
    const initial = loadConfig(paths, knownClis, readOnlyClis);
    const adapters = new Map((opts.adapters ?? builtin(initial.master)).map((a) => [a.cli, a]));
    const store = new Store(paths.dbFile);
    const watcher = new ConfigWatcher(
      paths,
      knownClis,
      initial,
      (change) => {
        if (change.type === 'reloaded') {
          store.event(null, 'config.reloaded', {
            errors: Object.keys(change.config.errors).length,
          });
        } else {
          store.event(null, 'config.reload_failed', { message: change.message });
        }
      },
      readOnlyClis,
    );
    const config = () => watcher.current;
    const engine = new Engine({ store, paths, config, adapters });
    const issues = new IssueBridge({ store, engine, paths, config, adapters, github: opts.github });
    const notifier = new SystemNotifier(store, config, opts.notice);
    const installDir = opts.installDir ?? null;
    let master: Master | undefined;
    const upgrader = new Upgrader({
      store,
      engine,
      paths,
      config,
      installDir,
      busy: () => issues.scoutRunning,
      launch: async (plan) => {
        const launch =
          opts.launchUpgrade ?? ((p) => launchUpgradeScript(paths, master?.port ?? 0, p));
        launch(plan);
        await master?.close();
        (opts.exit ?? (() => process.exit(0)))();
      },
    });
    const version = installDir ? await revParse(installDir, 'HEAD').catch(() => null) : null;
    const app = createApi({
      store,
      engine,
      issues,
      upgrader,
      version,
      config,
      configStatus: () => watcher.status(),
      webDir: opts.webDir ?? defaultWebDir(),
    });
    master = new Master(paths, watcher, store, engine, issues, notifier, upgrader, app);
    notifier.start();
    await engine.start();
    await issues.start({ poll: opts.pollIssues !== false });
    upgrader.start({ timer: opts.upgradeTimer !== false });
    if (opts.watchConfig !== false) watcher.start();
    return master;
  }

  /** The port the HTTP server listens on; 0 before `listen`. */
  port = 0;

  /** Start the HTTP server on 127.0.0.1. Resolves with the URL. */
  listen(port = this.config.master.port): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = serve({ fetch: this.app.fetch, hostname: '127.0.0.1', port }, (info) => {
        this.port = info.port;
        resolve(`http://127.0.0.1:${info.port}`);
      }) as Server;
      server.once('error', reject);
      this.server = server;
    });
  }

  /** Graceful shutdown: stop the active agent (its Run is requeued), close server and database. */
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.doClose();
    return this.closing;
  }

  private closing: Promise<void> | undefined;

  private async doClose(): Promise<void> {
    this.configWatcher.stop();
    this.upgrader.stop();
    this.notifier.stop();
    await this.issues.stop();
    await this.engine.stop();
    const server = this.server;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
    this.store.close();
  }
}
