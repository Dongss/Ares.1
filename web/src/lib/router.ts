import { useSyncExternalStore } from 'react';

// Hash-based routing: the Master serves one index.html, so routes live after the "#".

export type Route =
  | { name: 'home' }
  | { name: 'run'; id: string }
  | { name: 'repos' }
  /** GitHub issues and AI scouts. */
  | { name: 'issues' }
  /** Totals of Runs, issues, cost, tokens and time; filters live in the hash query. */
  | { name: 'stats' }
  /** Worktrees and branches finished Runs kept. */
  | { name: 'workspaces' }
  /** Every agent with its executions, outcomes, cost and latest error. */
  | { name: 'agents' }
  /** How the self-hosting loop works; `section`: scroll to that section. */
  | { name: 'guide'; section?: string }
  /** `template`: scroll to that template's card. */
  | { name: 'config'; template?: string }
  | { name: 'notFound'; path: string };

export const href = {
  home: '#/',
  run: (id: string) => `#/runs/${encodeURIComponent(id)}`,
  repos: '#/repos',
  issues: '#/issues',
  stats: '#/stats',
  workspaces: '#/workspaces',
  agents: '#/agents',
  config: '#/config',
  configTemplate: (id: string) => `#/config/templates/${encodeURIComponent(id)}`,
  guide: '#/guide',
  guideSection: (id: string) => `#/guide/${encodeURIComponent(id)}`,
};

export function parseRoute(hash: string): Route {
  // Query lives in the hash (`#/?status=active`) so a refresh keeps the home filters.
  const path = (hash.replace(/^#/, '').split('?')[0] ?? '').replace(/\/+$/, '') || '/';
  if (path === '/') return { name: 'home' };
  if (path === '/repos') return { name: 'repos' };
  if (path === '/issues') return { name: 'issues' };
  if (path === '/stats') return { name: 'stats' };
  if (path === '/workspaces') return { name: 'workspaces' };
  if (path === '/agents') return { name: 'agents' };
  if (path === '/config') return { name: 'config' };
  if (path === '/guide') return { name: 'guide' };
  const section = /^\/guide\/([^/]+)$/.exec(path);
  if (section?.[1]) return { name: 'guide', section: decodeURIComponent(section[1]) };
  const template = /^\/config\/templates\/([^/]+)$/.exec(path);
  if (template?.[1]) return { name: 'config', template: decodeURIComponent(template[1]) };
  const run = /^\/runs\/([^/]+)$/.exec(path);
  if (run?.[1]) return { name: 'run', id: decodeURIComponent(run[1]) };
  return { name: 'notFound', path };
}

export function navigate(to: string): void {
  window.location.hash = to.replace(/^#/, '');
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

export function useLocationHash(): string {
  return useSyncExternalStore(subscribe, () => window.location.hash);
}

export function useRoute(): Route {
  return parseRoute(useLocationHash());
}
