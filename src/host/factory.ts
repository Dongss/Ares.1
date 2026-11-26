// The client of the code host the Master works with, made from its config. Only GitHub so far,
// through the gh CLI.

import type { MasterConfig } from '../config/schema.js';
import { GhCli } from '../github/client.js';
import type { CodeHost } from './code-host.js';

/** The settings of the Master's config a code host's client is made with. */
export type CodeHostConfig = Pick<MasterConfig, 'bins' | 'github'>;

/**
 * Makes the code host's client for the config, once per setting: while the settings it is made
 * with stay the same, the same client comes back, so what it keeps (gh's token, the login the
 * caller asked it for) stays with it; a changed setting makes a new one.
 */
export class CodeHostFactory {
  private cached: { key: string; host: CodeHost } | undefined;

  get(config: CodeHostConfig): CodeHost {
    const bin = config.bins.gh ?? 'gh';
    const account = config.github?.account;
    const key = `${bin}|${account ?? ''}`;
    if (this.cached?.key !== key) this.cached = { key, host: new GhCli(bin, account) };
    return this.cached.host;
  }
}
