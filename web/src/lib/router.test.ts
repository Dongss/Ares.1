import { describe, expect, it } from 'vitest';
import { href, parseRoute } from './router.js';

describe('parseRoute', () => {
  it('maps hashes to pages', () => {
    expect(parseRoute('')).toEqual({ name: 'home' });
    expect(parseRoute('#/')).toEqual({ name: 'home' });
    expect(parseRoute('#/repos/')).toEqual({ name: 'repos' });
    expect(parseRoute('#/runs/run-abc')).toEqual({ name: 'run', id: 'run-abc' });
    expect(parseRoute('#/config')).toEqual({ name: 'config' });
    expect(parseRoute('#/stats')).toEqual({ name: 'stats' });
    expect(parseRoute('#/stats?range=30d&repo=repo-1')).toEqual({ name: 'stats' });
    expect(parseRoute('#/workspaces')).toEqual({ name: 'workspaces' });
    expect(parseRoute('#/workspaces/')).toEqual({ name: 'workspaces' });
    expect(parseRoute('#/workspaces/x')).toEqual({ name: 'notFound', path: '/workspaces/x' });
    expect(parseRoute('#/agents')).toEqual({ name: 'agents' });
    expect(parseRoute('#/agents/')).toEqual({ name: 'agents' });
    expect(parseRoute('#/events')).toEqual({ name: 'events' });
    expect(parseRoute('#/events/')).toEqual({ name: 'events' });
    expect(parseRoute('#/events/x')).toEqual({ name: 'notFound', path: '/events/x' });
    expect(parseRoute('#/guide')).toEqual({ name: 'guide' });
    expect(parseRoute('#/guide/')).toEqual({ name: 'guide' });
    expect(parseRoute('#/guide/labels')).toEqual({ name: 'guide', section: 'labels' });
    expect(parseRoute('#/guide/a/b')).toEqual({ name: 'notFound', path: '/guide/a/b' });
    expect(parseRoute('#/nope')).toEqual({ name: 'notFound', path: '/nope' });
    expect(parseRoute('#/?status=active&repo=repo-1')).toEqual({ name: 'home' });
    expect(parseRoute('#/runs/run-abc?x=1')).toEqual({ name: 'run', id: 'run-abc' });
  });

  it('round-trips run links', () => {
    expect(parseRoute(href.run('run-1'))).toEqual({ name: 'run', id: 'run-1' });
    expect(parseRoute(href.workspaces)).toEqual({ name: 'workspaces' });
    expect(parseRoute(href.agents)).toEqual({ name: 'agents' });
    expect(parseRoute(href.events)).toEqual({ name: 'events' });
    expect(parseRoute(href.guide)).toEqual({ name: 'guide' });
    expect(parseRoute(href.guideSection('faq'))).toEqual({ name: 'guide', section: 'faq' });
    expect(parseRoute(href.configTemplate('self-dev'))).toEqual({
      name: 'config',
      template: 'self-dev',
    });
  });
});
