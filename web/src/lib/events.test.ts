import { afterEach, describe, expect, it } from 'vitest';
import { setLang } from '../../../src/i18n.js';
import type { EventRow } from '../../../src/store/types.js';
import {
  globalEventLink,
  globalEventText,
  globalEventTone,
  withLatest,
  withOlder,
} from './events.js';
import { formatTime } from './format.js';

afterEach(() => setLang('zh'));

const NOW = new Date('2026-11-23T12:00:00Z');
const STARTED = '2026-11-20T08:30:00Z';
const ev = (type: string, data: Record<string, unknown> = {}) => ({ type, data });
const text = (type: string, data: Record<string, unknown> = {}) =>
  globalEventText(ev(type, data), NOW);

/** One of each global event the Master records, with the data it records. */
const SAMPLES: [string, Record<string, unknown>][] = [
  ['master.restarted', { pid: 4242, startedAt: STARTED }],
  ['master.node_missing', { node: '/opt/node/bin/node', commit: 'abcdef1234567890' }],
  ['master.working', { on: true }],
  ['master.working', { on: false }],
  ['logs.pruned', { runs: 3, scouts: 2, files: 12, bytes: 5 * 1024 * 1024 }],
  [
    'store.backup_restored',
    {
      backup: '/h/data/ares1.db.bak-v40-x',
      movedTo: '/h/data/ares1.db.newer-v41-y',
      fromVersion: 41,
      toVersion: 40,
    },
  ],
  ['config.reloaded', { errors: 0 }],
  ['config.reloaded', { errors: 2 }],
  ['config.reload_failed', { message: 'agents.yaml: bad indent' }],
  ['github.error', { message: 'HTTP 502' }],
  ['github.pushed', { repo: 'demo', branch: 'main', head: 'abcdef1234567890' }],
  ['issue.auto_accepted', { repo: 'demo', issue: 12 }],
  ['scout.started', { scoutId: 's-1', repo: 'demo', trigger: 'auto' }],
  ['scout.started', { scoutId: 's-1', repo: 'demo', trigger: 'manual' }],
  ['scout.completed', { scoutId: 's-1', repo: 'demo', created: 3, auto: 1, pending: 2 }],
  ['scout.completed', { scoutId: 's-1', repo: 'demo', created: 0, auto: 0, pending: 0 }],
  ['scout.failed', { scoutId: 's-1', repo: 'demo', message: 'timeout', streak: 3 }],
  ['scout.rate_limited', { scoutId: 's-1', repo: 'demo', retryAt: '2026-11-23T13:00:00Z' }],
  ['scout.rate_limited', { scoutId: 's-1', repo: 'demo' }],
  ['upgrade.started', { from: 'aaaaaaaa1111', to: 'bbbbbbbb2222' }],
  ['upgrade.started', { from: 'aaaaaaaa1111', to: 'aaaaaaaa1111', reason: 'node_missing' }],
  ['upgrade.done', { from: 'aaaaaaaa1111', to: 'bbbbbbbb2222' }],
  ['upgrade.failed', { from: 'aaaaaaaa1111', to: 'bbbbbbbb2222', message: 'npm ci failed' }],
  ['upgrade.failed', { from: 'aaaaaaaa1111', to: 'bbbbbbbb2222', message: 'no npm', env: true }],
  ['upgrade.failed', { message: 'install directory is dirty' }],
];

describe('globalEventText', () => {
  it('says how many raw logs were pruned, how large, from how many Runs and scouts', () => {
    expect(text('logs.pruned', { runs: 3, scouts: 2, files: 12, bytes: 5 * 1024 * 1024 })).toBe(
      '删除了 12 个超过保留期的原始日志（5.0 MB），涉及 3 个 Run、2 次侦察；各 Run 详情页里的 Agent 输出不受影响',
    );
    expect(text('logs.pruned', { runs: 1, scouts: 0, files: 2, bytes: 2048 })).toBe(
      '删除了 2 个超过保留期的原始日志（2.0 KB），涉及 1 个 Run；各 Run 详情页里的 Agent 输出不受影响',
    );
    setLang('en');
    expect(text('logs.pruned', { runs: 3, scouts: 2, files: 12, bytes: 5 * 1024 * 1024 })).toBe(
      "Deleted 12 raw log files past retention (5.0 MB), from 3 Runs and 2 scouts; the agent output on each Run's page is not affected",
    );
    expect(text('logs.pruned', { runs: 1, scouts: 1, files: 1, bytes: 100 })).toBe(
      "Deleted 1 raw log file past retention (100 B), from 1 Run and 1 scout; the agent output on each Run's page is not affected",
    );
  });

  it('does not say the agent output stays visible when only scouts were pruned', () => {
    // Scouts keep no condensed events, so no Run page shows their output.
    const data = { runs: 0, scouts: 2, files: 4, bytes: 2048 };
    expect(text('logs.pruned', data)).toBe(
      '删除了 4 个超过保留期的原始日志（2.0 KB），涉及 2 次侦察；「需求」页上的侦察记录不受影响',
    );
    expect(text('logs.pruned', data)).not.toMatch(/Agent 输出/);
    setLang('en');
    const en = text('logs.pruned', data);
    expect(en).toBe(
      'Deleted 4 raw log files past retention (2.0 KB), from 2 scouts; the scouts on the Issues page are not affected',
    );
    expect(en).not.toMatch(/agent output/i);
    expect(en).not.toMatch(/[一-鿿]/);
    expect(text('logs.pruned', { runs: 0, scouts: 1, files: 1, bytes: 100 })).toBe(
      'Deleted 1 raw log file past retention (100 B), from 1 scout; the scouts on the Issues page are not affected',
    );
  });

  it("names the previous Master's pid and start time after an unexpected restart", () => {
    const at = formatTime(STARTED, NOW);
    expect(text('master.restarted', { pid: 4242, startedAt: STARTED })).toBe(
      `上一个 Master（pid 4242、${at} 启动）没有正常退出（崩溃、被强行结束或机器重启）；之后启动了这个 Master，没做完的 Run 接着做`,
    );
    // Recorded without them when the mark file did not say.
    expect(text('master.restarted', { pid: null, startedAt: null })).toMatch(
      /^上一个 Master 没有正常退出/,
    );
    setLang('en');
    expect(text('master.restarted', { pid: 4242, startedAt: STARTED })).toBe(
      `The previous Master (pid 4242, started ${at}) stopped without shutting down (it crashed, was killed or the machine restarted); this Master started after it and carries on with the unfinished Runs`,
    );
  });

  it('names the restored backup and where the newer database went', () => {
    const data = {
      backup: '/h/data/ares1.db.bak-v40-x',
      movedTo: '/h/data/ares1.db.newer-v41-y',
      fromVersion: 41,
      toVersion: 40,
    };
    expect(text('store.backup_restored', data)).toBe(
      '数据库版本（41）比 Master 支持的（40）更新，多半是升级回退到了旧版本：恢复了迁移前的备份 /h/data/ares1.db.bak-v40-x；较新的数据库移到了 /h/data/ares1.db.newer-v41-y，以后再升级时可以从那里找回',
    );
    setLang('en');
    expect(text('store.backup_restored', data)).toBe(
      'The database (version 41) was newer than the Master supports (version 40), most likely because an upgrade was rolled back: restored the backup taken before the migration, /h/data/ares1.db.bak-v40-x; the newer database was moved to /h/data/ares1.db.newer-v41-y, where it can be recovered after upgrading again',
    );
  });

  it('carries the message of a failed reload, a GitHub error and a failed upgrade', () => {
    expect(text('config.reload_failed', { message: 'agents.yaml: bad indent' })).toBe(
      '配置文件有错误，重新加载失败，仍在用上一份有效配置：agents.yaml: bad indent',
    );
    expect(text('github.error', { message: 'HTTP 502' })).toBe('访问 GitHub 出错：HTTP 502');
    expect(
      text('upgrade.failed', {
        from: 'aaaaaaaa1111',
        to: 'bbbbbbbb2222',
        message: 'npm ci failed',
      }),
    ).toBe('升级 aaaaaaaa → bbbbbbbb 失败：npm ci failed');
    expect(
      text('upgrade.failed', {
        from: 'aaaaaaaa1111',
        to: 'bbbbbbbb2222',
        message: 'no npm',
        env: true,
      }),
    ).toBe(
      '升级 aaaaaaaa → bbbbbbbb 因运行环境的问题失败（比如找不到 node 或 npm），过一阵会再试：no npm',
    );
    expect(text('upgrade.failed', { message: 'dirty' })).toBe('升级失败：dirty');
    setLang('en');
    expect(text('config.reload_failed', { message: 'agents.yaml: bad indent' })).toBe(
      'The configuration files have errors and could not be reloaded; the last valid configuration stays in use: agents.yaml: bad indent',
    );
    expect(text('github.error', { message: 'HTTP 502' })).toBe('GitHub request failed: HTTP 502');
    expect(
      text('upgrade.failed', {
        from: 'aaaaaaaa1111',
        to: 'bbbbbbbb2222',
        message: 'npm ci failed',
      }),
    ).toBe('Upgrading aaaaaaaa → bbbbbbbb failed: npm ci failed');
    expect(text('upgrade.failed', { message: 'dirty' })).toBe('The upgrade failed: dirty');
  });

  it('counts what a scout proposed, with English plurals', () => {
    const data = { repo: 'demo', created: 3, auto: 1, pending: 2 };
    expect(text('scout.completed', data)).toBe(
      '侦察 demo 完成，提出了 3 个 issue，其中 1 个自动采纳、2 个等人采纳',
    );
    expect(text('scout.completed', { repo: 'demo', created: 0 })).toBe(
      '侦察 demo 完成，没有提出新的 issue',
    );
    setLang('en');
    expect(text('scout.completed', data)).toBe(
      'Scouting demo finished and proposed 3 issues: 1 accepted automatically and 2 waiting for a human',
    );
    expect(text('scout.completed', { repo: 'demo', created: 1, auto: 1, pending: 0 })).toBe(
      'Scouting demo finished and proposed 1 issue: 1 accepted automatically',
    );
    expect(text('scout.failed', { repo: 'demo', message: 'timeout', streak: 3 })).toBe(
      'Scouting demo failed (3 times in a row): timeout',
    );
  });

  it('describes every global event in both languages, without Chinese left in English', () => {
    for (const [type, data] of SAMPLES) {
      expect(text(type, data), type).toBeTruthy();
    }
    setLang('en');
    for (const [type, data] of SAMPLES) {
      const s = text(type, data);
      expect(s, type).toBeTruthy();
      expect(s, type).not.toMatch(/[一-鿿]/);
    }
  });

  it('falls back to a general sentence when the data lacks fields, and never throws', () => {
    for (const lang of ['zh', 'en'] as const) {
      setLang(lang);
      for (const [type] of SAMPLES) {
        if (type === 'master.working') continue;
        expect(text(type, {}), type).toBeTruthy();
        expect(text(type, { repo: 5, message: null, pid: 'x', bytes: 'big' }), type).toBeTruthy();
      }
    }
    setLang('en');
    expect(text('logs.pruned', {})).toBe(
      "Deleted raw logs past retention; the agent output on each Run's page is not affected",
    );
    expect(text('github.error', {})).toBe('GitHub request failed');
    expect(text('scout.failed', {})).toBe('Scouting a repo failed');
  });

  it('returns null for types it does not know, so the page shows the raw data', () => {
    expect(text('something.new', { a: 1 })).toBeNull();
    expect(text('run.status', { status: 'running' })).toBeNull();
    // The work switch without a state says nothing it can word.
    expect(text('master.working', {})).toBeNull();
  });
});

describe('globalEventTone', () => {
  it('marks errors red and what is worth a look orange', () => {
    for (const type of ['github.error', 'config.reload_failed', 'upgrade.failed', 'scout.failed']) {
      expect(globalEventTone(ev(type)), type).toBe('danger');
    }
    for (const type of ['master.restarted', 'master.node_missing', 'store.backup_restored']) {
      expect(globalEventTone(ev(type)), type).toBe('attention');
    }
    expect(globalEventTone(ev('config.reloaded', { errors: 1 }))).toBe('attention');
    expect(globalEventTone(ev('config.reloaded', { errors: 0 }))).toBe('neutral');
    for (const type of ['logs.pruned', 'upgrade.done', 'scout.completed', 'something.new']) {
      expect(globalEventTone(ev(type)), type).toBe('neutral');
    }
  });
});

describe('globalEventLink', () => {
  it('links scouts and auto-accepted proposals to the Issues page', () => {
    expect(globalEventLink({ type: 'scout.completed' })).toBe('#/issues');
    expect(globalEventLink({ type: 'scout.failed' })).toBe('#/issues');
    expect(globalEventLink({ type: 'issue.auto_accepted' })).toBe('#/issues');
    expect(globalEventLink({ type: 'logs.pruned' })).toBeNull();
    expect(globalEventLink({ type: 'master.restarted' })).toBeNull();
  });
});

describe('event pages', () => {
  const row = (id: number): EventRow => ({
    id,
    runId: null,
    ts: '2026-11-23T00:00:00Z',
    type: 'x',
    data: {},
  });
  const rows = (...ids: number[]) => ids.map(row);
  const ids = (p: { events: EventRow[] }) => p.events.map((e) => e.id);

  it('starts from the newest page; a short page is all there is', () => {
    expect(withLatest(null, rows(9, 8, 7), 3)).toEqual({ events: rows(9, 8, 7), complete: false });
    expect(withLatest(null, rows(9, 8), 3)).toEqual({ events: rows(9, 8), complete: true });
    expect(withLatest(null, [], 3)).toEqual({ events: [], complete: true });
  });

  it('appends older pages and knows when the oldest is loaded', () => {
    let pages = withLatest(null, rows(9, 8, 7), 3);
    pages = withOlder(pages, 7, rows(6, 5, 4), 3);
    expect(ids(pages)).toEqual([9, 8, 7, 6, 5, 4]);
    expect(pages.complete).toBe(false);
    pages = withOlder(pages, 4, rows(2), 3);
    expect(ids(pages)).toEqual([9, 8, 7, 6, 5, 4, 2]);
    expect(pages.complete).toBe(true);
  });

  it('merges a reloaded newest page with the older pages, each event once', () => {
    let pages = withLatest(null, rows(9, 8, 7), 3);
    pages = withOlder(pages, 7, rows(6, 5, 4), 3);
    pages = withLatest(pages, rows(11, 10, 9), 3);
    expect(ids(pages)).toEqual([11, 10, 9, 8, 7, 6, 5, 4]);
    expect(pages.complete).toBe(false);
    // A short newest page reaches the oldest event.
    pages = withLatest(withLatest(null, rows(3, 2), 3), rows(4, 3, 2), 5);
    expect(ids(pages)).toEqual([4, 3, 2]);
    expect(pages.complete).toBe(true);
  });

  it('starts over when a full newest page no longer reaches what is loaded', () => {
    let pages = withLatest(null, rows(9, 8, 7), 3);
    pages = withOlder(pages, 7, rows(6, 5, 4), 3);
    pages = withLatest(pages, rows(15, 14, 13), 3);
    expect(ids(pages)).toEqual([15, 14, 13]);
    expect(pages.complete).toBe(false);
  });

  it('drops an older page that no longer joins on', () => {
    const pages = withLatest(null, rows(15, 14, 13), 3);
    expect(withOlder(pages, 7, rows(6, 5, 4), 3)).toBe(pages);
  });
});
