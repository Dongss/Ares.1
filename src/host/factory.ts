// The clients of the code hosts the Master works with, made from its config: GitHub through the
// gh CLI, GitLab through the glab CLI.

import type { MasterConfig } from '../config/schema.js';
import { GhCli } from '../github/client.js';
import { GlabCli } from '../gitlab/client.js';
import type { HostPlatform } from '../store/types.js';
import type { CodeHost } from './code-host.js';

/** The settings of the Master's config a code host's client is made with. */
export type CodeHostConfig = Pick<MasterConfig, 'bins' | 'github' | 'gitlab'>;

/** The platforms a code host's client is made for. */
export type CodeHostPlatform = HostPlatform;

/**
 * Makes the code host's client for the config, once per platform and setting: while the settings
 * a platform's client is made with stay the same (its program, and for GitLab the host, and the
 * account), the same client comes back, so what it keeps (gh's token, the members glab looked up,
 * the login the caller asked it for) stays with it; a changed setting makes a new one. Each
 * platform keeps its own, so asking for one never replaces the other's.
 */
export class CodeHostFactory {
  private readonly cached = new Map<CodeHostPlatform, { key: string; host: CodeHost }>();

  get(config: CodeHostConfig, platform: CodeHostPlatform = 'github'): CodeHost {
    const made = platform === 'github' ? github(config) : gitlab(config);
    const cached = this.cached.get(platform);
    if (cached?.key === made.key) return cached.host;
    const host = made.make();
    this.cached.set(platform, { key: made.key, host });
    return host;
  }
}

/** What a platform's client is made with, as a key, and how to make it. */
interface Making {
  key: string;
  make: () => CodeHost;
}

function github(config: CodeHostConfig): Making {
  const bin = config.bins.gh ?? 'gh';
  const account = config.github?.account;
  return { key: JSON.stringify([bin, account ?? '']), make: () => new GhCli(bin, account) };
}

function gitlab(config: CodeHostConfig): Making {
  const bin = config.bins.glab ?? 'glab';
  const host = config.gitlab?.host;
  const account = config.gitlab?.account;
  return {
    key: JSON.stringify([bin, host ?? '', account ?? '']),
    make: () => new GlabCli(bin, { host, account }),
  };
}
