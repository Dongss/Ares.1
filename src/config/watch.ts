import { type FSWatcher, watch } from 'node:fs';
import { t } from '../i18n.js';
import { errorMessage, nowIso } from '../util.js';
import { type HomePaths, type LoadedConfig, loadConfig, type RepoTemplateSource } from './load.js';

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

/** Whether two sets of repos' template files have the same repos with the same files. */
function sameFiles(
  a: ReadonlyMap<string, RepoTemplateSource>,
  b: ReadonlyMap<string, RepoTemplateSource>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [name, x] of a) {
    const y = b.get(name);
    if (!y || x.files.length !== y.files.length) return false;
    if (x.files.some((f, i) => f.file !== y.files[i]?.file || f.source !== y.files[i]?.source)) {
      return false;
    }
  }
  return true;
}

/** Whether every repo's files were read from the same branch and commit in both. */
function sameCommits(
  a: ReadonlyMap<string, RepoTemplateSource>,
  b: ReadonlyMap<string, RepoTemplateSource>,
): boolean {
  for (const [name, x] of a) {
    const y = b.get(name);
    if (y?.branch !== x.branch || y.sha !== x.sha) return false;
  }
  return a.size === b.size;
}

/**
 * Holds the configuration in use and reloads it when config.yaml, agents.yaml or workflows/
 * change, or the templates the repos keep in .ares1/workflows/ (`setRepoSources`). A reload that
 * throws keeps the previous configuration; invalid agents or templates are disabled as at
 * startup, except that a repo's template file that fails keeps its version that last loaded.
 * Runs keep the template snapshot they were created with; agent settings apply from the next
 * execution.
 */
export class ConfigWatcher {
  private config: LoadedConfig;
  private loadedAt = nowIso();
  private reloadError: ConfigStatus['reloadError'] = null;
  private readonly startup: LoadedConfig['master'];
  private watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The template files of every registered repo, by repo name, as last read. */
  private repoSources: ReadonlyMap<string, RepoTemplateSource> = new Map();

  constructor(
    private readonly paths: HomePaths,
    private readonly knownClis: readonly string[],
    initial: LoadedConfig,
    private readonly onChange: (change: ConfigChange) => void = () => {},
    /** CLIs that can run an agent read-only (see `loadConfig`). */
    readonly readOnlyClis: readonly string[] = [],
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
    return this.load(true);
  }

  /**
   * The configuration as a reload would load it now with `configFile` read as config.yaml: for
   * checking a config.yaml before it is written. Neither put in use nor told; throws as
   * `loadConfig` does. Like `loadConfig`, it applies the file's `language` (`setLang`) to the
   * whole Master at once: a candidate that changes the language switches it before the file is
   * written or kept, and a candidate that is then thrown away does not switch it back. Callers
   * that check such a candidate have to restore the language themselves.
   */
  loadCandidate(configFile: string): LoadedConfig {
    return loadConfig({ ...this.paths, configFile }, this.knownClis, this.readOnlyClis, {
      repoSources: this.repoSources,
      previous: this.config,
    });
  }

  /**
   * Take the template files of the repos (`RepoWorkflows`): every registered repo's, by name;
   * those left out have none, as have those without files (most repos), which never cause a
   * load. When they differ from the files in use, the configuration is loaded again (`reload`;
   * told unless `notify` is false, as before the Master has started). When only the commits they
   * were read from moved, it is loaded again without telling, so that it names the commits the
   * templates now stand for.
   */
  setRepoSources(
    sources: ReadonlyMap<string, RepoTemplateSource>,
    opts: { notify?: boolean } = {},
  ): void {
    const before = this.repoSources;
    this.repoSources = new Map([...sources].filter(([, s]) => s.files.length > 0));
    if (!sameFiles(before, this.repoSources)) this.load(opts.notify ?? true);
    else if (!sameCommits(before, this.repoSources)) this.load(false);
  }

  /**
   * Load the configuration files, with the repos' template files and the configuration in use as
   * the last loaded (whose versions stand in for repo files that now fail). `notify`: tell
   * `onChange`. Returns whether the new configuration is in use.
   */
  private load(notify: boolean): boolean {
    let next: LoadedConfig;
    try {
      next = this.loadCandidate(this.paths.configFile);
    } catch (err) {
      this.reloadError = { message: errorMessage(err), at: nowIso() };
      if (notify) this.onChange({ type: 'reload_failed', message: this.reloadError.message });
      return false;
    }
    this.config = next;
    this.loadedAt = nowIso();
    this.reloadError = null;
    if (notify) this.onChange({ type: 'reloaded', config: next });
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
