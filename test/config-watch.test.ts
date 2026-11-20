import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigView } from '../src/api/types.js';
import { homePaths, initHome, loadConfig } from '../src/config/load.js';
import { type ConfigChange, ConfigWatcher } from '../src/config/watch.js';
import {
  done,
  type Harness,
  harness,
  TEST_AGENTS_YAML,
  TEST_WORKFLOW_YAML,
  tmpDir,
  waitFor,
  writeFile,
} from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('ConfigWatcher', () => {
  it('reloads, keeps the previous configuration when the new one is broken', () => {
    const paths = homePaths(tmpDir('ares1-watch-'));
    initHome(paths);
    const changes: ConfigChange['type'][] = [];
    const watcher = new ConfigWatcher(
      paths,
      ['claude-code'],
      loadConfig(paths, ['claude-code']),
      (c) => changes.push(c.type),
    );
    expect([...watcher.current.agents.keys()]).toEqual(['claude-coder', 'claude-reviewer']);

    writeFile(paths.agentsFile, 'agents:\n  solo: { cli: claude-code, model: haiku }\n');
    expect(watcher.reload()).toBe(true);
    expect([...watcher.current.agents.keys()]).toEqual(['solo']);
    expect(watcher.status().reloadError).toBeNull();

    // A half-saved file: keep using the last good configuration and say why.
    writeFile(paths.agentsFile, 'agents:\n  solo: { cli: claude-code, model: [\n');
    expect(watcher.reload()).toBe(false);
    expect([...watcher.current.agents.keys()]).toEqual(['solo']);
    expect(watcher.status().reloadError?.message).toMatch(/agents\.yaml 不是合法的 YAML/);
    writeFile(paths.configFile, 'port: [\n');
    expect(watcher.reload()).toBe(false);
    expect(changes).toEqual(['reloaded', 'reload_failed', 'reload_failed']);

    // Port and CLI paths only apply after a restart.
    writeFile(paths.configFile, 'port: 5000\nbins:\n  claude-code: /opt/claude\n');
    writeFile(paths.agentsFile, 'agents:\n  solo: { cli: claude-code, model: haiku }\n');
    expect(watcher.reload()).toBe(true);
    expect(watcher.status().restartNeeded).toEqual(['端口（port）', 'CLI 路径（bins）']);

    // A typo in config.yaml is reported on reload as at startup, and fixing it clears it.
    writeFile(paths.configFile, 'upgarde:\n  auto: true\n');
    expect(watcher.reload()).toBe(true);
    expect(watcher.current.master.upgrade.auto).toBe(false);
    expect(watcher.current.warnings['config.yaml']?.[0]).toMatch(/未知的配置项 upgarde/);
    writeFile(paths.configFile, 'upgrade:\n  auto: true\n');
    expect(watcher.reload()).toBe(true);
    expect(watcher.current.master.upgrade.auto).toBe(true);
    expect(watcher.current.warnings).toEqual({});
  });
});

describe('config reload in the Master', () => {
  it('picks up file changes: new runs use the new template, the dashboard is told', async () => {
    h = await harness();
    const events: string[] = [];
    h.master.store.bus.on('event', (e: { type: string }) => events.push(e.type));
    const first = h.run('旧模板');
    await h.waitStatus(first.id, 'waiting_approval');

    // Switch the coding stage to coder2 by editing the template file.
    writeFile(
      join(h.home, 'workflows', 'dev.yaml'),
      TEST_WORKFLOW_YAML.replace('agent: coder\n', 'agent: coder2\n'),
    );
    await waitFor(
      () => h?.master.config.templates.get('dev')?.stages[0]?.agent === 'coder2',
      'template reload',
      5000,
    );
    expect(events).toContain('config.reloaded');

    // The waiting run keeps its snapshot; a new run uses the new template.
    expect(h.master.store.getRun(first.id).template.stages[0]?.agent).toBe('coder');
    h.master.engine.approve(first.id);
    await h.waitStatus(first.id, 'completed');
    const second = h.run('新模板');
    await h.waitStatus(second.id, 'waiting_approval');
    expect(h.fake.calls.map((c) => c.model)).toEqual(['coder', 'reviewer', 'coder2', 'reviewer']);

    // A broken agents.yaml is reported and the last good configuration stays in use.
    writeFile(join(h.home, 'agents.yaml'), `${TEST_AGENTS_YAML}  broken: [\n`);
    await waitFor(() => events.includes('config.reload_failed'), 'reload failure', 5000);
    const res = await h.master.app.request('/api/config');
    const view = (await res.json()) as ConfigView;
    expect(view.reloadError?.message).toMatch(/agents\.yaml/);
    expect(view.agents.map((a) => a.id)).toEqual(['coder', 'coder2', 'reviewer']);
    expect(view.restartNeeded).toEqual([]);
    expect(Date.parse(view.loadedAt)).not.toBeNaN();
  });

  it('applies agent settings from the next execution', async () => {
    h = await harness();
    writeFile(
      join(h.home, 'agents.yaml'),
      TEST_AGENTS_YAML.replace('    model: coder\n', '    model: coder\n    effort: high\n'),
    );
    await waitFor(() => h?.master.config.agents.get('coder')?.effort === 'high', 'reload', 5000);
    h.scripts.coder = (ctx) => {
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return done();
    };
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');
    expect(h.fake.calls[0]?.effort).toBe('high');
  });
});
