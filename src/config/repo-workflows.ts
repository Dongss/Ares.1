// The workflow templates registered repos keep in their own .ares1/workflows/, read as committed on
// their target branch and kept in step with it: a refresh looks where each target branch is and
// reads the files again only for those that moved (or whose branch or path changed), then hands
// every repo's files to the configuration (`ConfigWatcher.setRepoSources`).

import { t } from '../i18n.js';
import type { Repo } from '../store/types.js';
import { errorMessage } from '../util.js';
import { committedYamlFiles, revParse } from '../workspace/git.js';
import { REPO_WORKFLOWS_DIR } from './flow.js';
import type { RepoTemplateSource } from './load.js';

export interface RepoWorkflowsDeps {
  /** The repos registered now. */
  repos: () => readonly Pick<Repo, 'name' | 'path' | 'targetBranch'>[];
  /** Takes the files read: those of every registered repo, by repo name. */
  apply: (sources: ReadonlyMap<string, RepoTemplateSource>) => void;
  /**
   * Something went wrong, in the Master's language: a repo's target branch could not be read
   * (its directory or branch gone, git failing), told once per streak of the same error, which
   * ends with a refresh that reads it; or the refresh itself failed.
   */
  warn?: (message: string) => void;
}

/** What was last read of a repo: from where, and the files. */
interface Cached {
  path: string;
  source: RepoTemplateSource;
}

/**
 * Reads each registered repo's .ares1/workflows/ from the commit its target branch is at, never
 * from a worktree, so uncommitted changes play no part. Refreshes run one at a time; a refresh
 * asked for while another waits to start is that one, as it reads the repos as they are when it
 * starts. A refresh never rejects: a repo whose branch cannot be read keeps the files read before
 * from the same path and branch (`warn` tells why), and a repo no longer registered is forgotten.
 */
export class RepoWorkflows {
  private readonly cache = new Map<string, Cached>();
  /** The last error told per repo name, so that a streak of the same error is told once. */
  private readonly warned = new Map<string, string>();
  private chain: Promise<void> = Promise.resolve();
  /** The refresh queued and not started yet. */
  private waiting: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly deps: RepoWorkflowsDeps) {}

  /** Look at every repo's target branch again and hand the files over; resolves when done. */
  refresh(): Promise<void> {
    if (this.waiting) return this.waiting;
    const next = this.chain.then(() => {
      this.waiting = undefined;
      return this.load();
    });
    this.waiting = next;
    this.chain = next;
    return next;
  }

  /** No refresh after this; resolves once the one going on, if any, has ended. */
  stop(): Promise<void> {
    this.stopped = true;
    return this.chain;
  }

  private async load(): Promise<void> {
    if (this.stopped) return;
    try {
      const repos = this.deps.repos();
      const sources = new Map<string, RepoTemplateSource>();
      for (const repo of repos) {
        const source = await this.read(repo);
        if (source) sources.set(repo.name, source);
      }
      const names = new Set(repos.map((r) => r.name));
      for (const name of [...this.cache.keys()]) {
        if (names.has(name)) continue;
        this.cache.delete(name);
        this.warned.delete(name);
      }
      if (!this.stopped) this.deps.apply(sources);
    } catch (err) {
      this.deps.warn?.(
        t({
          zh: `[流程模板] 刷新各仓库自带的流程模板失败：${errorMessage(err)}`,
          en: `[workflows] Could not refresh the templates the repos keep: ${errorMessage(err)}`,
        }),
      );
    }
  }

  /** The repo's files as committed on its target branch now; reads them only when it moved. */
  private async read(
    repo: Pick<Repo, 'name' | 'path' | 'targetBranch'>,
  ): Promise<RepoTemplateSource | undefined> {
    const cached = this.cache.get(repo.name);
    const same = cached?.path === repo.path && cached.source.branch === repo.targetBranch;
    try {
      const sha = await revParse(repo.path, repo.targetBranch);
      let source = same ? cached?.source : undefined;
      if (source?.sha !== sha) {
        const files = await committedYamlFiles(repo.path, sha, REPO_WORKFLOWS_DIR);
        source = { branch: repo.targetBranch, sha, files };
        this.cache.set(repo.name, { path: repo.path, source });
      }
      this.warned.delete(repo.name);
      return source;
    } catch (err) {
      const message = errorMessage(err);
      if (this.warned.get(repo.name) !== message) {
        this.warned.set(repo.name, message);
        this.deps.warn?.(
          t({
            zh: `[流程模板] 读不到仓库 ${repo.name} 目标分支 ${repo.targetBranch} 上的 ${REPO_WORKFLOWS_DIR}/：${message}`,
            en: `[workflows] Could not read ${REPO_WORKFLOWS_DIR}/ on the target branch ${repo.targetBranch} of repo ${repo.name}: ${message}`,
          }),
        );
      }
      // What was read from this very branch still stands for it; a repo that moved elsewhere
      // has no files until they can be read.
      if (same && cached) return cached.source;
      this.cache.delete(repo.name);
      return undefined;
    }
  }
}
