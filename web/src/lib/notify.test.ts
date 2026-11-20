import { describe, expect, it } from 'vitest';
import type { EventRow } from '../../../src/store/types.js';
import { noticeFor, notifyState } from './notify.js';

const ev = (type: string, data: Record<string, unknown> = {}, runId: string | null = 'run-1') =>
  ({ id: 42, runId, ts: '2026-11-19T00:00:00.000Z', type, data }) satisfies EventRow;

describe('noticeFor', () => {
  it('notifies approvals, blocks, completions and failures with the goal as body', () => {
    const goal = '加一个功能\n细节';
    expect(noticeFor(ev('approval.requested', { stageId: 'merge' }), goal)).toEqual({
      title: '等待你审批',
      body: '加一个功能',
      href: '#/runs/run-1',
      tag: 'ares1-event-42',
    });
    expect(noticeFor(ev('run.blocked', { kind: 'task_failed' }), goal)?.title).toBe(
      'Run 卡住了：返工次数用完仍未通过',
    );
    expect(noticeFor(ev('run.blocked', { kind: 'something_new' }), goal)?.title).toBe('Run 卡住了');
    expect(noticeFor(ev('run.status', { status: 'completed' }), goal)).toBeNull();
    expect(noticeFor(ev('run.status', { status: 'failed' }), goal)?.title).toBe('Run 失败了');
  });

  it('ignores everything else, and falls back to the run id without a goal', () => {
    expect(noticeFor(ev('run.status', { status: 'running' }), 'g')).toBeNull();
    expect(noticeFor(ev('run.status', { status: 'blocked' }), 'g')).toBeNull();
    expect(noticeFor(ev('attempt.started'), 'g')).toBeNull();
    expect(noticeFor(ev('config.reloaded', {}, null), 'g')).toBeNull();
    expect(noticeFor(ev('approval.requested'), undefined)?.body).toBe('run-1');
  });
});

describe('noticeFor automation', () => {
  it('notifies only proposals that wait for a human, linking to the issues page', () => {
    expect(
      noticeFor(ev('scout.completed', { created: 3, auto: 1, pending: 2 }, null), undefined),
    ).toEqual({
      title: '有提案等你决定：2 条',
      body: '这些提案不能自动采纳（太大或超出自动采纳的风险），去 GitHub 上采纳或关闭',
      href: '#/issues',
      tag: 'ares1-event-42',
    });
    expect(
      noticeFor(ev('scout.completed', { created: 3, auto: 3, pending: 0 }, null), undefined),
    ).toBeNull();
    expect(noticeFor(ev('scout.failed', { message: '超时' }, null), undefined)).toBeNull();
  });

  it('notifies failures of GitHub access and upgrades', () => {
    expect(
      noticeFor(ev('github.error', { message: '推送失败\n详情' }, null), undefined),
    ).toMatchObject({
      title: 'GitHub 访问失败',
      body: '推送失败',
      href: '#/issues',
    });
    expect(noticeFor(ev('upgrade.failed', { message: '构建失败' }, null), undefined)).toMatchObject(
      {
        title: 'Master 自动升级失败',
        href: '#/',
      },
    );
  });
});

describe('notifyState', () => {
  it('leaves notifying to the Master when it sends system notifications', () => {
    expect(notifyState('granted', 'on', true)).toBe('system');
  });

  it('combines the browser permission with the user choice', () => {
    expect(notifyState('unsupported', 'on')).toBe('unsupported');
    expect(notifyState('default', null)).toBe('ask');
    expect(notifyState('default', 'on')).toBe('ask');
    expect(notifyState('default', 'off')).toBe('off');
    expect(notifyState('granted', null)).toBe('on');
    expect(notifyState('granted', 'off')).toBe('off');
    expect(notifyState('denied', 'on')).toBe('denied');
    expect(notifyState('denied', null)).toBe('off');
  });
});
