import { type FSWatcher, watch } from 'node:fs';
import { t } from '../i18n.js';
import { errorMessage, nowIso } from '../util.js';
import { type HomePaths, type LoadedConfig, loadConfig } from './load.js';

export interface ConfigStatus {
  /** When the configuration in use was loaded. */
  loadedAt: string;
  /** The last reload failed (e.g. invalid config.yaml); the previous configuration is kept. */
  reloadError: { message: string; at: string } | null;
  /** Changed settings that only take effect after a Master restart (e.g. port, CLI paths). */
  restartNeeded: string[];
}

export type ConfigChange =
  | { type: 'reloaded'; config: LoadedConfig }
  | { type: 'reload_failed'; message: string };

/**
 * Holds the configuration in use and reloads it when config.yaml, agents.yaml or workflows/
 * change. A reload that throws keeps the previous configuration; invalid
 * agents or templates are disabled as at startup. Runs keep the template snapshot they were
 * created with; agent settings apply from the next execution.
 */
export class ConfigWatcher {
  private config: LoadedConfig;
  private loadedAt = nowIso();
  private reloadError: ConfigStatus['reloadError'] = null;
  private readonly startup: LoadedConfig['master'];
  private watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly paths: HomePaths,
    private readonly knownClis: readonly string[],
    initial: LoadedConfig,
    private readonly onChange: (change: ConfigChange) => void = () => {},
    /** CLIs that can run an agent read-only (see `loadConfig`). */
    private readonly readOnlyClis: readonly string[] = [],
  ) {
    this.config = initial;
    this.startup = initial.master;
  }

  get current(): LoadedConfig {
    return this.config;
  }

  status(): ConfigStatus {
    const restartNeeded: string[] = [];
    if (this.config.master.port !== this.startup.port) {
      restartNeeded.push(t({ zh: '端口（port）', en: 'the port (port)' }));
    }
    if (JSON.stringify(this.config.master.bins) !== JSON.stringify(this.startup.bins)) {
      restartNeeded.push(t({ zh: 'CLI 路径（bins）', en: 'the CLI paths (bins)' }));
    }
    return { loadedAt: this.loadedAt, reloadError: this.reloadError, restartNeeded };
  }

  /** Load the files again now. Returns whether the new configuration is in use. */
  reload(): boolean {
    let next: LoadedConfig;
    try {
      next = loadConfig(this.paths, this.knownClis, this.readOnlyClis);
    } catch (err) {
      this.reloadError = { message: errorMessage(err), at: nowIso() };
      this.onChange({ type: 'reload_failed', message: this.reloadError.message });
      return false;
    }
    this.config = next;
    this.loadedAt = nowIso();
    this.reloadError = null;
    this.onChange({ type: 'reloaded', config: next });
    return true;
  }

  /** Watch the configuration files; changes are picked up after a short quiet period. */
  start(debounceMs = 300): void {
    const schedule = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.reload(), debounceMs);
    };
    const add = (dir: string, wanted: (file: string) => boolean) => {
      try {
        const w = watch(dir, (_event, file) => {
          // Editors often save by renaming, so watch the directory and filter by name.
          if (!file || wanted(file.toString())) schedule();
        });
        w.on('error', () => {});
        this.watchers.push(w);
      } catch {
        // The directory may be missing; the configuration is then only read at startup.
      }
    };
    add(this.paths.home, (f) => f === 'config.yaml' || f === 'agents.yaml');
    add(this.paths.workflowsDir, (f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  }

  stop(): void {
    clearTimeout(this.timer);
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }
}
