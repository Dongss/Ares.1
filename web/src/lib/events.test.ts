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
  ['notify.webhook_failed', { reason: 'HTTP 500 Internal Server Error', status: 500 }],
  ['notify.webhook_failed', { reason: 'fetch failed (connect ECONNREFUSED ***)', status: null }],
  ['notify.system_failed', { command: 'notify-send', reason: 'exit code 1: no bus' }],
  ['notify.system_failed', { command: 'osascript', reason: 'exit code 1' }],
  ['github.pushed', { repo: 'demo', branch: 'main', head: 'abcdef1234567890' }],
  ['github.pulled', { repo: 'demo', branch: 'main', from: 'aaaaaaaa1111', to: 'bbbbbbbb2222' }],
  ['github.diverged', { repo: 'demo', branch: 'main', local: 'aaaaaaaa1111', remote: 'cccc3333' }],
  [
    'github.diverged',
    { repo: 'demo', branch: 'main', local: 'a1', remote: 'c3', conflict: true, files: ['a.ts'] },
  ],
  [
    'github.diverged',
    {
      repo: 'demo',
      branch: 'main',
      local: 'a1',
      remote: 'c3',
      failed: { command: 'npm test', kind: 'verify', exitCode: 1, timedOut: false },
    },
  ],
  [
    'github.diverged',
    {
      repo: 'demo',
      branch: 'main',
      local: 'a1',
      remote: 'c3',
      failed: { command: 'npm ci', kind: 'setup', missing: 'npm' },
    },
  ],
  [
    'github.diverged',
    {
      repo: 'demo',
      branch: 'main',
      local: 'a1',
      remote: 'c3',
      conflict: true,
      files: ['a.ts'],
      runId: 'run-1',
    },
  ],
  [
    'github.diverged_run',
    { repo: 'demo', branch: 'main', local: 'aaaa1111', remote: 'cccc3333', runId: 'run-1' },
  ],
  [
    'github.merged_remote',
    { repo: 'demo', branch: 'main', local: 'aaaa1111', remote: 'cccc3333', merge: 'dddd4444' },
  ],
  [
    'github.pull_blocked',
    { repo: 'demo', branch: 'main', reason: 'dirty', worktree: '/w/demo', status: ' M a.ts' },
  ],
  ['issue.auto_accepted', { repo: 'demo', issue: 12 }],
  ['iteration.auto_accepted', { repo: 'demo', iterationId: 'iteration-1', issue: 20 }],
  ['iteration.accepted', { repo: 'demo', iterationId: 'iteration-1', issue: 20 }],
  [
    'iteration.child_status',
    {
      repo: 'demo',
      iterationId: 'iteration-1',
      issue: 20,
      position: 2,
      child: 22,
      status: 'running',
      previous: 'ready',
    },
  ],
  [
    'iteration.completed',
    { repo: 'demo', iterationId: 'iteration-1', issue: 20, costUsd: 1.5, runs: 4 },
  ],
  [
    'iteration.blocked',
    {
      repo: 'demo',
      iterationId: 'iteration-1',
      issue: 20,
      position: 2,
      child: 22,
      reason: 'failed',
    },
  ],
  ['iteration.unblocked', { repo: 'demo', iterationId: 'iteration-1', issue: 20 }],
  [
    'iteration.cancelled',
    { repo: 'demo', iterationId: 'iteration-1', issue: 20, dropped: [2, 3], pending: false },
  ],
  [
    'iteration.adjusted',
    {
      repo: 'demo',
      iterationId: 'iteration-1',
      issue: 20,
      scoutId: 's-1',
      added: [5],
      replaced: [{ position: 2, by: 5 }],
      leftOut: 0,
    },
  ],
  ['proposal.auto_accepted', { repo: 'demo', proposalId: 'proposal-1', runId: 'run-1' }],
  ['proposal.accepted', { repo: 'demo', proposalId: 'proposal-1', runId: 'run-1' }],
  // The reason is a human's own words, kept as written: English here, so the check below holds.
  ['proposal.rejected', { repo: 'demo', proposalId: 'proposal-1', reason: 'a duplicate' }],
  [
    'scout.completed',
    { scoutId: 's-1', repo: 'demo', created: 2, auto: 1, pending: 1, backlog: true },
  ],
  ['scout.started', { scoutId: 's-1', repo: 'demo', trigger: 'auto' }],
  ['scout.started', { scoutId: 's-1', repo: 'demo', trigger: 'manual' }],
  ['scout.completed', { scoutId: 's-1', repo: 'demo', created: 3, auto: 1, pending: 2 }],
  ['scout.completed', { scoutId: 's-1', repo: 'demo', created: 0, auto: 0, pending: 0 }],
  ['scout.failed', { scoutId: 's-1', repo: 'demo', message: 'timeout', streak: 3 }],
  // The problems are in the Master's language: English here, so the check below holds.
  [
    'scout.update_dropped',
    {
      scoutId: 's-1',
      repo: 'demo',
      problems: ['step 3 cannot replace step 2: it is the closing step'],
    },
  ],
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

  it('says a webhook notification failed, why, and that it is told once until one gets through', () => {
    const data = { reason: 'HTTP 500 Internal Server Error', status: 500 };
    expect(text('notify.webhook_failed', data)).toBe(
      'webhook 通知发送失败：HTTP 500 Internal Server Error；之后的失败不再记录，直到有通知发送成功',
    );
    expect(text('notify.webhook_failed', {})).toBe(
      'webhook 通知发送失败；之后的失败不再记录，直到有通知发送成功',
    );
    setLang('en');
    const en = text('notify.webhook_failed', data);
    expect(en).toBe(
      'A webhook notification could not be sent: HTTP 500 Internal Server Error; later failures are not recorded until one gets through',
    );
    expect(en).not.toMatch(/[一-鿿]/);
    expect(text('notify.webhook_failed', { reason: null, status: null })).toBe(
      'A webhook notification could not be sent; later failures are not recorded until one gets through',
    );
  });

  it('says a system notification failed, through which command and why, told once per streak', () => {
    const data = {
      command: 'notify-send',
      reason: '找不到 notify-send，Linux 上需要安装 libnotify（提供 notify-send）',
    };
    expect(text('notify.system_failed', data)).toBe(
      '系统通知发送失败（notify-send）：找不到 notify-send，Linux 上需要安装 libnotify（提供 notify-send）；之后的失败不再记录，直到有通知发送成功',
    );
    expect(text('notify.system_failed', {})).toBe(
      '系统通知发送失败；之后的失败不再记录，直到有通知发送成功',
    );
    setLang('en');
    const en = text('notify.system_failed', {
      command: 'osascript',
      reason: 'exit code 1: execution error (-1743)',
    });
    expect(en).toBe(
      'A system notification could not be sent (osascript): exit code 1: execution error (-1743); later failures are not recorded until one gets through',
    );
    expect(en).not.toMatch(/[一-鿿]/);
    expect(text('notify.system_failed', { command: null, reason: 'exit code 1' })).toBe(
      'A system notification could not be sent: exit code 1; later failures are not recorded until one gets through',
    );
    expect(text('notify.system_failed', { command: 5, reason: null })).toBe(
      'A system notification could not be sent; later failures are not recorded until one gets through',
    );
  });

  it('says what pulling the target branch from GitHub did, and what a human has to do', () => {
    const pulled = { repo: 'demo', branch: 'main', from: 'aaaaaaaa1111', to: 'bbbbbbbb2222' };
    const diverged = {
      repo: 'demo',
      branch: 'main',
      local: 'aaaaaaaa1111',
      remote: 'cccc33334444',
    };
    const blocked = {
      repo: 'demo',
      branch: 'main',
      reason: 'dirty',
      worktree: '/w/demo',
      status: ' M a.ts',
    };
    expect(text('github.pulled', pulled)).toBe(
      '从 GitHub 拉取了新提交，demo 的 main 快进了过去（aaaaaaaa → bbbbbbbb）；之后的 Run 以它为基础',
    );
    expect(text('github.diverged', diverged)).toBe(
      'demo 的 main 和 GitHub 上的已经分叉（本地 aaaaaaaa，GitHub cccc3333），两边各有对方没有的提交，不会自动合并，要你手动合并；在此之前不推送，已完成 Run 的 issue 保持打开',
    );
    expect(text('github.pull_blocked', blocked)).toBe(
      'GitHub 上有新提交，但 demo 的 main 检出在 /w/demo 有未提交的改动，没能快进；提交或丢弃这些改动后，下一轮检查会自动拉取',
    );
    setLang('en');
    expect(text('github.pulled', pulled)).toBe(
      'Pulled new commits from GitHub and fast-forwarded main of demo to them (aaaaaaaa → bbbbbbbb); later Runs build on them',
    );
    expect(text('github.diverged', diverged)).toBe(
      'Diverged from GitHub: main of demo (local aaaaaaaa, GitHub cccc3333) and the one on GitHub each have commits the other lacks, and they are not merged by themselves. Merge them by hand; until then nothing is pushed and the issues of completed Runs stay open',
    );
    expect(text('github.pull_blocked', blocked)).toBe(
      'GitHub has new commits, but main of demo is checked out in /w/demo with uncommitted changes and could not be fast-forwarded; once they are committed or discarded, the next check pulls by itself',
    );
    expect(text('github.pulled', {})).toBe(
      'Pulled new commits from GitHub and fast-forwarded the target branch of a repo to them; later Runs build on them',
    );
    for (const type of ['github.diverged', 'github.pull_blocked']) {
      expect(globalEventTone(ev(type)), type).toBe('attention');
    }
    expect(globalEventTone(ev('github.pulled'))).toBe('neutral');
  });

  it("says how the Master's merge of a divergence went", () => {
    const pair = { repo: 'demo', branch: 'main', local: 'aaaaaaaa1111', remote: 'cccc33334444' };
    const conflict = { ...pair, conflict: true, files: ['a.ts', 'b.ts'] };
    const failed = {
      ...pair,
      failed: { command: 'npm test', kind: 'verify', exitCode: 1, timedOut: false },
    };
    const timedOut = {
      ...pair,
      failed: { command: 'npm ci', kind: 'setup', exitCode: null, timedOut: true },
    };
    const missing = { ...pair, failed: { command: 'npm test', kind: 'verify', missing: 'npm' } };
    const merged = { ...pair, merge: 'dddddddd5555' };
    expect(text('github.diverged', conflict)).toBe(
      'demo 的 main 和 GitHub 上的已经分叉（本地 aaaaaaaa，GitHub cccc3333），自动合并有冲突（a.ts、b.ts），要你手动合并；在此之前不推送，已完成 Run 的 issue 保持打开',
    );
    expect(text('github.diverged', failed)).toBe(
      'demo 的 main 和 GitHub 上的已经分叉（本地 aaaaaaaa，GitHub cccc3333），自动合并后检查命令 `npm test` 没通过（退出码 1），要你手动合并；在此之前不推送，已完成 Run 的 issue 保持打开',
    );
    expect(text('github.diverged', timedOut)).toContain(
      '自动合并后准备命令 `npm ci` 没通过（超时）',
    );
    expect(text('github.diverged', missing)).toBe(
      'demo 的 main 和 GitHub 上的已经分叉（本地 aaaaaaaa，GitHub cccc3333），自动合并后要运行的检查命令 `npm test` 在运行环境里找不到 npm；装好后下一轮检查会自动再合并，在此之前不推送，已完成 Run 的 issue 保持打开',
    );
    expect(text('github.merged_remote', merged)).toBe(
      'demo 的 main 和 GitHub 上的分叉了，Master 自己合并了 GitHub 上的新提交，仓库的检查通过后把分支快进到合并提交（本地 aaaaaaaa 和 GitHub cccc3333 → dddddddd），随后推送到 GitHub',
    );
    expect(globalEventTone(ev('github.merged_remote'))).toBe('neutral');
    const many = { ...pair, conflict: true, files: ['1', '2', '3', '4', '5', '6', '7'] };
    expect(text('github.diverged', many)).toContain('自动合并有冲突（1、2、3、4、5 等 7 个文件）');

    setLang('en');
    expect(text('github.diverged', conflict)).toBe(
      "Diverged from GitHub: main of demo (local aaaaaaaa, GitHub cccc3333) and the one on GitHub each have commits the other lacks, and the Master's merge conflicts in a.ts, b.ts. Merge them by hand; until then nothing is pushed and the issues of completed Runs stay open",
    );
    expect(text('github.diverged', failed)).toBe(
      "Diverged from GitHub: main of demo (local aaaaaaaa, GitHub cccc3333) and the one on GitHub each have commits the other lacks, and the verify command `npm test` failed on the Master's merge (exit code 1). Merge them by hand; until then nothing is pushed and the issues of completed Runs stay open",
    );
    expect(text('github.diverged', timedOut)).toContain(
      "the setup command `npm ci` failed on the Master's merge (timed out)",
    );
    expect(text('github.diverged', missing)).toBe(
      "Diverged from GitHub: main of demo (local aaaaaaaa, GitHub cccc3333) and the one on GitHub each have commits the other lacks, and the verify command `npm test` to run on the Master's merge cannot find npm. Once it is installed, the next check merges by itself; until then nothing is pushed and the issues of completed Runs stay open",
    );
    expect(text('github.merged_remote', merged)).toBe(
      "main of demo had diverged from GitHub: the Master merged the new commits from GitHub, and with the repo's checks passing, fast-forwarded the branch to the merge (local aaaaaaaa and GitHub cccc3333 → dddddddd), to be pushed to GitHub",
    );
    expect(text('github.diverged', many)).toContain('in 1, 2, 3, 4, 5 and 2 more files');
    for (const data of [conflict, failed, timedOut, missing]) {
      expect(text('github.diverged', data)).not.toMatch(/[一-鿿]/);
    }
    expect(text('github.merged_remote', merged)).not.toMatch(/[一-鿿]/);
  });

  it('says when a divergence is handed to a Run the Master created to merge it', () => {
    const pair = { repo: 'demo', branch: 'main', local: 'aaaaaaaa1111', remote: 'cccc33334444' };
    const conflict = { ...pair, conflict: true, files: ['a.ts', 'b.ts'], runId: 'run-7' };
    const failed = {
      ...pair,
      failed: { command: 'npm test', kind: 'verify', exitCode: 1, timedOut: false },
      runId: 'run-7',
    };
    const created = { ...pair, runId: 'run-7' };
    expect(text('github.diverged', conflict)).toBe(
      'demo 的 main 和 GitHub 上的已经分叉（本地 aaaaaaaa，GitHub cccc3333），自动合并有冲突（a.ts、b.ts）；已交给 Run run-7 处理，不用你手动合并：编码 Agent 合并两边，评审并合并后推送；在此之前不推送，已完成 Run 的 issue 保持打开',
    );
    expect(text('github.diverged', failed)).toBe(
      'demo 的 main 和 GitHub 上的已经分叉（本地 aaaaaaaa，GitHub cccc3333），自动合并后检查命令 `npm test` 没通过（退出码 1）；已交给 Run run-7 处理，不用你手动合并：编码 Agent 合并两边，评审并合并后推送；在此之前不推送，已完成 Run 的 issue 保持打开',
    );
    expect(text('github.diverged', { ...pair, runId: 'run-7' })).toBe(
      'demo 的 main 和 GitHub 上的已经分叉（本地 aaaaaaaa，GitHub cccc3333），两边各有对方没有的提交；已交给 Run run-7 处理，不用你手动合并：编码 Agent 合并两边，评审并合并后推送；在此之前不推送，已完成 Run 的 issue 保持打开',
    );
    expect(text('github.diverged_run', created)).toBe(
      'demo 的 main 和 GitHub 上的分叉了（本地 aaaaaaaa，GitHub cccc3333），Master 自己没能合并，建了 Run run-7：由编码 Agent 合并 GitHub 上的提交 cccc3333，评审并合并后推送到 GitHub',
    );
    expect(text('github.diverged_run', { repo: 'demo', branch: 'main' })).toBe(
      'demo 的 main 和 GitHub 上的分叉了，Master 自己没能合并，建了一个 Run：由编码 Agent 合并 GitHub 上的新提交，评审并合并后推送到 GitHub',
    );
    // Still worth a look while nothing is pushed; the Run it created is told by the same.
    expect(globalEventTone(ev('github.diverged', conflict))).toBe('attention');
    expect(globalEventTone(ev('github.diverged_run', created))).toBe('neutral');

    setLang('en');
    expect(text('github.diverged', conflict)).toBe(
      "Diverged from GitHub: main of demo (local aaaaaaaa, GitHub cccc3333) and the one on GitHub each have commits the other lacks, and the Master's merge conflicts in a.ts, b.ts. Run run-7 takes it over, with nothing to merge by hand: its coding agent merges the two, pushed once the Run is reviewed and merged; until then nothing is pushed and the issues of completed Runs stay open",
    );
    expect(text('github.diverged', failed)).toBe(
      "Diverged from GitHub: main of demo (local aaaaaaaa, GitHub cccc3333) and the one on GitHub each have commits the other lacks, and the verify command `npm test` failed on the Master's merge (exit code 1). Run run-7 takes it over, with nothing to merge by hand: its coding agent merges the two, pushed once the Run is reviewed and merged; until then nothing is pushed and the issues of completed Runs stay open",
    );
    expect(text('github.diverged_run', created)).toBe(
      'Diverged from GitHub: the Master could not merge main of demo (local aaaaaaaa, GitHub cccc3333) by itself, so it created Run run-7, whose coding agent merges commit cccc3333 from GitHub; pushed to GitHub once the Run is reviewed and merged',
    );
    expect(text('github.diverged_run', {})).toBe(
      'Diverged from GitHub: the Master could not merge the target branch of a repo by itself, so it created a Run, whose coding agent merges the new commits from GitHub; pushed to GitHub once the Run is reviewed and merged',
    );
    for (const data of [conflict, failed, { ...pair, runId: 'run-7' }]) {
      expect(text('github.diverged', data)).not.toMatch(/[一-鿿]/);
    }
    for (const data of [created, {}]) {
      expect(text('github.diverged_run', data)).not.toMatch(/[一-鿿]/);
    }
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

  it('says a change to the plan was dropped and why, the rest of the scout taken', () => {
    const data = {
      scoutId: 's-1',
      repo: 'demo',
      problems: [
        '追加的第 1 个子项（序号 3）不能替换第 2 个子项：它是收尾子项',
        '计划最多 8 个子项',
      ],
    };
    expect(text('scout.update_dropped', data)).toBe(
      '侦察 demo 时提出的计划调整不符合进行中迭代的计划，丢掉了这份调整，其余结果照常采用：追加的第 1 个子项（序号 3）不能替换第 2 个子项：它是收尾子项；计划最多 8 个子项',
    );
    // Without the problems, or with something else in their place, it still says what happened.
    expect(text('scout.update_dropped', { repo: 'demo', problems: 'x' })).toBe(
      '侦察 demo 时提出的计划调整不符合进行中迭代的计划，丢掉了这份调整，其余结果照常采用',
    );
    setLang('en');
    const en = {
      ...data,
      problems: [
        'step 3 cannot replace step 2: it is the closing step',
        'the plan would have 9 steps',
      ],
    };
    expect(text('scout.update_dropped', en)).toBe(
      'Scouting demo gave a change that does not fit the plan of the iteration under way; the change was dropped and the rest of the result taken as usual: step 3 cannot replace step 2: it is the closing step; the plan would have 9 steps',
    );
    expect(text('scout.update_dropped', { repo: 'demo' })).toBe(
      'Scouting demo gave a change that does not fit the plan of the iteration under way; the change was dropped and the rest of the result taken as usual',
    );
  });

  it('says a scout of the local backlog wrote proposals there rather than issues', () => {
    const data = { repo: 'demo', created: 3, auto: 1, pending: 2, backlog: true };
    expect(text('scout.completed', data)).toBe(
      '侦察 demo 完成，写入了 3 条本地提案，其中 1 条自动采纳、2 条等人采纳或拒绝',
    );
    expect(text('scout.completed', { repo: 'demo', created: 0, backlog: true })).toBe(
      '侦察 demo 完成，没有提出新的本地提案',
    );
    setLang('en');
    expect(text('scout.completed', data)).toBe(
      'Scouting demo finished with 3 proposals for the local backlog: 1 accepted automatically and 2 waiting for a human',
    );
    expect(text('scout.completed', { ...data, created: 1, auto: 0, pending: 1 })).toBe(
      'Scouting demo finished with 1 proposal for the local backlog: 1 waiting for a human',
    );
    expect(text('scout.completed', { repo: 'demo', created: 0, backlog: true })).toBe(
      'Scouting demo finished without proposing anything for the local backlog',
    );
  });

  it('says an iteration was accepted as a whole, by a human or not', () => {
    const data = { repo: 'demo', iterationId: 'iteration-1', issue: 20 };
    expect(text('iteration.auto_accepted', data)).toBe(
      '整批自动采纳了 demo 的迭代 #20，子 issue 按依赖顺序开工',
    );
    expect(text('iteration.accepted', data)).toBe(
      'demo 的迭代 #20 已整批采纳，子 issue 按依赖顺序开工',
    );
    setLang('en');
    expect(text('iteration.auto_accepted', data)).toBe(
      'Accepted iteration #20 of demo automatically as a whole; its sub-issues start in the order of their dependencies',
    );
    expect(text('iteration.accepted', { repo: 'demo' })).toBe(
      'Iteration of demo was accepted as a whole; its sub-issues start in the order of their dependencies',
    );
  });

  it('says where a step of an iteration stands now, and that an iteration is done and what it used', () => {
    const step = { repo: 'demo', iterationId: 'iteration-1', issue: 20, position: 2, child: 22 };
    expect(text('iteration.child_status', { ...step, status: 'running' })).toBe(
      'demo 的迭代 #20：第 2 步（#22）开工了',
    );
    expect(text('iteration.child_status', { ...step, status: 'waiting' })).toBe(
      'demo 的迭代 #20：第 2 步（#22）在等它依赖的步骤完成',
    );
    const done = { repo: 'demo', iterationId: 'iteration-1', issue: 20, costUsd: 1.5, runs: 4 };
    expect(text('iteration.completed', done)).toBe(
      'demo 的迭代 #20 全部完成：用了 4 个 Run，共 $1.50；总结发在了迭代 issue 上',
    );
    setLang('en');
    expect(text('iteration.child_status', { ...step, status: 'done' })).toBe(
      'Iteration #20 of demo: step 2 (#22) is done',
    );
    expect(text('iteration.child_status', { repo: 'demo', status: 'mystery' })).toBe(
      'Iteration of demo: a step changed',
    );
    expect(text('iteration.completed', done)).toBe(
      'Iteration #20 of demo is done: 4 Runs, $1.50 in all; its summary is posted on the iteration issue',
    );
    expect(text('iteration.completed', { repo: 'demo', runs: 1 })).toBe(
      'An iteration of demo is done: 1 Run',
    );
  });

  it('says an iteration got blocked and by which step, and that it goes on again', () => {
    const at = { repo: 'demo', iterationId: 'iteration-1', issue: 20 };
    const step = { ...at, position: 2, child: 22 };
    expect(text('iteration.blocked', { ...step, reason: 'failed' })).toBe(
      'demo 的迭代 #20 受阻：第 2 步（#22）用完重做次数后失败了，依赖它的步骤开不了工；侦察下次会换个做法替换它',
    );
    expect(text('iteration.blocked', { ...step, reason: 'dropped' })).toBe(
      'demo 的迭代 #20 受阻：第 2 步（#22）被人关成了不做，依赖它的步骤开不了工；侦察下次会换个做法替换它',
    );
    expect(text('iteration.unblocked', at)).toBe('demo 的迭代 #20 不再受阻，接着按依赖开工');
    expect(globalEventTone(ev('iteration.blocked', step))).toBe('attention');
    expect(globalEventTone(ev('iteration.unblocked', at))).toBe('neutral');
    setLang('en');
    expect(text('iteration.blocked', { ...step, reason: 'failed' })).toBe(
      'Iteration #20 of demo is blocked: step 2 (#22) failed after using up its attempts, so the steps depending on it cannot start; the next scout replaces it with another approach',
    );
    expect(text('iteration.blocked', { repo: 'demo' })).toBe(
      'Iteration of demo is blocked: a step was not done, so the steps depending on it cannot start; the next scout replaces it with another approach',
    );
    expect(text('iteration.unblocked', at)).toBe(
      'Iteration #20 of demo is no longer blocked and goes on in the order of its dependencies',
    );
  });

  it('says a human turned an iteration down, and a scout changed its plan', () => {
    const at = { repo: 'demo', iterationId: 'iteration-1', issue: 20 };
    expect(text('iteration.cancelled', { ...at, dropped: [2, 3], pending: false })).toBe(
      'demo 的迭代 #20 被人关掉了，2 个没完成的子项随之关成不做',
    );
    expect(text('iteration.cancelled', { ...at, dropped: [1, 2, 3], pending: true })).toBe(
      'demo 等采纳的迭代 #20 被人关掉了，3 个没完成的子项随之关成不做',
    );
    expect(text('iteration.cancelled', { ...at, dropped: [], pending: false })).toBe(
      'demo 的迭代 #20 被人关掉了',
    );
    const changed = {
      ...at,
      scoutId: 'scout-1',
      added: [5, 6],
      replaced: [{ position: 2, by: 5 }],
      leftOut: 1,
    };
    expect(text('iteration.adjusted', changed)).toBe(
      '侦察调整了 demo 的迭代 #20 的计划：补上 2 步，其中 1 步替换没做成的步骤，1 步没能加上',
    );
    expect(text('iteration.adjusted', { ...at, added: [5], replaced: [], leftOut: 0 })).toBe(
      '侦察调整了 demo 的迭代 #20 的计划：补上 1 步',
    );
    setLang('en');
    expect(text('iteration.cancelled', { ...at, dropped: [3], pending: true })).toBe(
      'Iteration #20 of demo, waiting to be accepted, was closed by a human; its 1 step not done was closed as not planned with it',
    );
    expect(text('iteration.cancelled', { ...at, dropped: [2, 3], pending: false })).toBe(
      'Iteration #20 of demo was closed by a human; its 2 steps not done were closed as not planned with it',
    );
    expect(text('iteration.adjusted', changed)).toBe(
      'A scout changed the plan of iteration #20 of demo: 2 steps added, 1 of them replacing a step that was not done; 1 step left out',
    );
    expect(text('iteration.adjusted', { repo: 'demo', added: [] })).toBe(
      'A scout changed the plan of an iteration of demo',
    );
  });

  it('tells an iteration of the local backlog by its steps being proposals, decided on the dashboard', () => {
    const at = { repo: 'demo', iterationId: 'iteration-1', backlog: true };
    expect(text('iteration.auto_accepted', at)).toBe(
      '整批自动采纳了 demo 的一个本地迭代，子项按依赖顺序开工',
    );
    expect(text('iteration.accepted', at)).toBe(
      'demo 的一个本地迭代已整批采纳，子项按依赖顺序开工',
    );
    expect(text('iteration.blocked', { ...at, position: 2, reason: 'failed' })).toBe(
      'demo 的迭代受阻：第 2 步没有做成（Run 失败、被终止，或需求评估结论为不做），依赖它的步骤开不了工；侦察下次会换个做法替换它',
    );
    const rejected = { ...at, dropped: [1, 2], pending: true, reason: '现在不做' };
    expect(text('iteration.cancelled', rejected)).toBe(
      '拒绝了 demo 的一个本地迭代，它的子项随之拒绝，理由：现在不做；之后的侦察会看到这条理由',
    );
    expect(text('iteration.cancelled', { ...at, dropped: [2, 3], pending: false })).toBe(
      'demo 的一个本地迭代被人在看板上终止了，2 个没完成的子项随之不做',
    );
    setLang('en');
    const english = [
      text('iteration.auto_accepted', at),
      text('iteration.accepted', at),
      text('iteration.blocked', { ...at, position: 2, reason: 'failed' }),
      text('iteration.cancelled', { ...rejected, reason: 'not now' }),
      text('iteration.cancelled', { ...at, dropped: [3], pending: false }),
    ];
    expect(english).toEqual([
      'Accepted a local iteration of demo automatically as a whole; its steps start in the order of their dependencies',
      'A local iteration of demo was accepted as a whole; its steps start in the order of their dependencies',
      'Iteration of demo is blocked: step 2 was not done (its Run failed, was terminated, or its assessment dropped it), so the steps depending on it cannot start; the next scout replaces it with another approach',
      'Rejected a local iteration of demo, its steps with it, because: not now; later scouts are shown the reason',
      'A local iteration of demo was cancelled on the dashboard; its 1 step not done was dropped with it',
    ]);
    expect(english.join('\n')).not.toMatch(/[一-鿿]/);
  });

  it('says a local proposal was accepted, by a human or not, or rejected and why', () => {
    const accepted = { repo: 'demo', proposalId: 'proposal-1', runId: 'run-7' };
    expect(text('proposal.auto_accepted', accepted)).toBe(
      '自动采纳了 demo 的一条本地提案，用它的正文建了 Run run-7',
    );
    expect(text('proposal.accepted', accepted)).toBe(
      '采纳了 demo 的一条本地提案，用它的正文建了 Run run-7',
    );
    const rejected = { repo: 'demo', proposalId: 'proposal-1', reason: '和已有的重复' };
    expect(text('proposal.rejected', rejected)).toBe(
      '拒绝了 demo 的一条本地提案，理由：和已有的重复；之后的侦察会看到这条理由',
    );
    expect(text('proposal.accepted', {})).toBe(
      '采纳了 某个仓库 的一条本地提案，用它的正文建了 Run',
    );
    setLang('en');
    expect(text('proposal.auto_accepted', accepted)).toBe(
      'Accepted a local proposal of demo automatically and created Run run-7 from its text',
    );
    expect(text('proposal.accepted', accepted)).toBe(
      'Accepted a local proposal of demo and created Run run-7 from its text',
    );
    expect(text('proposal.rejected', { ...rejected, reason: 'a duplicate' })).toBe(
      'Rejected a local proposal of demo because: a duplicate; later scouts are shown the reason',
    );
    expect(text('proposal.rejected', { repo: 'demo' })).toBe(
      'Rejected a local proposal of demo; later scouts are shown it with the reason',
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
    for (const type of [
      'github.error',
      'notify.webhook_failed',
      'notify.system_failed',
      'config.reload_failed',
      'upgrade.failed',
      'scout.failed',
    ]) {
      expect(globalEventTone(ev(type)), type).toBe('danger');
    }
    for (const type of [
      'master.restarted',
      'master.node_missing',
      'store.backup_restored',
      'scout.update_dropped',
    ]) {
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
    const issues = { href: '#/issues', label: '查看需求' };
    expect(globalEventLink(ev('scout.completed'))).toEqual(issues);
    expect(globalEventLink(ev('scout.failed'))).toEqual(issues);
    expect(globalEventLink(ev('scout.update_dropped'))).toEqual(issues);
    expect(globalEventLink(ev('issue.auto_accepted'))).toEqual(issues);
    expect(globalEventLink(ev('iteration.auto_accepted'))).toEqual(issues);
    expect(globalEventLink(ev('iteration.accepted'))).toEqual(issues);
    expect(globalEventLink(ev('logs.pruned'))).toBeNull();
    expect(globalEventLink(ev('master.restarted'))).toBeNull();
    setLang('en');
    expect(globalEventLink(ev('scout.completed'))).toEqual({
      href: '#/issues',
      label: 'See issues',
    });
  });

  it('links iteration events to the iteration, and those recorded without one to Issues', () => {
    const page = { href: '#/iterations/iteration-7', label: '查看迭代' };
    for (const type of [
      'iteration.accepted',
      'iteration.auto_accepted',
      'iteration.child_status',
      'iteration.blocked',
      'iteration.unblocked',
      'iteration.adjusted',
      'iteration.completed',
      'iteration.cancelled',
    ]) {
      expect(globalEventLink(ev(type, { repo: 'demo', iterationId: 'iteration-7' }))).toEqual(page);
    }
    expect(globalEventLink(ev('iteration.blocked', { iterationId: '' }))).toEqual({
      href: '#/issues',
      label: '查看需求',
    });
    // Not an iteration's event, even with an iterationId.
    expect(globalEventLink(ev('scout.completed', { iterationId: 'iteration-7' }))).toEqual({
      href: '#/issues',
      label: '查看需求',
    });
    setLang('en');
    expect(globalEventLink(ev('iteration.completed', { iterationId: 'iteration-7' }))).toEqual({
      href: '#/iterations/iteration-7',
      label: 'See the iteration',
    });
  });

  it('links an accepted local proposal to its Run, and a rejected one to the Issues page', () => {
    const run = { href: '#/runs/run-7', label: '查看 Run' };
    const issues = { href: '#/issues', label: '查看需求' };
    expect(globalEventLink(ev('proposal.auto_accepted', { runId: 'run-7' }))).toEqual(run);
    expect(globalEventLink(ev('proposal.accepted', { runId: 'run-7' }))).toEqual(run);
    expect(globalEventLink(ev('proposal.accepted'))).toEqual(issues);
    expect(globalEventLink(ev('proposal.rejected', { reason: 'x' }))).toEqual(issues);
    setLang('en');
    expect(globalEventLink(ev('proposal.rejected'))).toEqual({
      href: '#/issues',
      label: 'See issues',
    });
  });

  it('links a divergence handed to a Run, and the Run created for it, to that Run', () => {
    const run = { href: '#/runs/run-7', label: '查看 Run' };
    expect(globalEventLink(ev('github.diverged', { conflict: true, runId: 'run-7' }))).toEqual(run);
    expect(globalEventLink(ev('github.diverged_run', { runId: 'run-7' }))).toEqual(run);
    // For a human to merge: no Run to see.
    expect(globalEventLink(ev('github.diverged', { conflict: true }))).toBeNull();
    expect(globalEventLink(ev('github.diverged_run'))).toBeNull();
    expect(globalEventLink(ev('github.pushed', { runId: 'run-7' }))).toBeNull();
    setLang('en');
    expect(globalEventLink(ev('github.diverged_run', { runId: 'run-7' }))).toEqual({
      href: '#/runs/run-7',
      label: 'See the Run',
    });
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
