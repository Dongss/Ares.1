import { afterEach, describe, expect, it } from 'vitest';
import { setLang } from '../../../src/i18n.js';
import type { EventRow } from '../../../src/store/types.js';
import { noticeFor, notifyState, webhookNote } from './notify.js';

describe('webhookNote', () => {
  afterEach(() => setLang('zh'));

  it('says the Master also POSTs to the configured webhook, in the language in use', () => {
    expect(webhookNote()).toBe(
      '已配置 webhook（config.yaml 的 notify.webhook），需要人处理时 Master 也会 POST 到配置的地址。',
    );
    setLang('en');
    expect(webhookNote()).toContain('the Master also POSTs to its address');
    expect(webhookNote()).not.toMatch(/[一-鿿]/);
  });
});

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
  afterEach(() => setLang('zh'));

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
    // A scout that keeps failing: told at the third failure in a row.
    const failing = { repo: 'demo', message: '超时\n详情' };
    expect(noticeFor(ev('scout.failed', { ...failing, streak: 2 }, null), undefined)).toBeNull();
    expect(noticeFor(ev('scout.failed', { ...failing, streak: 3 }, null), undefined)).toEqual({
      title: '侦察连续失败：demo',
      body: '超时',
      href: '#/issues',
      tag: 'ares1-event-42',
    });
    // Out of quota passes on its own: the automatic scout waits for it, nobody needs to act.
    const limited = { scoutId: 's', repo: 'demo', retryAt: '2026-11-19T01:00:00.000Z' };
    expect(noticeFor(ev('scout.rate_limited', limited, null), undefined)).toBeNull();
    // A change to the plan dropped: the iteration, blocked, is told of when it blocks.
    const dropped = { scoutId: 's', repo: 'demo', problems: ['它是收尾子项'] };
    expect(noticeFor(ev('scout.update_dropped', dropped, null), undefined)).toBeNull();
  });

  it('sends proposals of the local backlog to the Issues page, and not their decisions', () => {
    const scout = { repo: 'demo', created: 3, auto: 1, pending: 2, backlog: true };
    expect(noticeFor(ev('scout.completed', scout, null), undefined)).toEqual({
      title: '有提案等你决定：2 条',
      body: '这些提案没有自动采纳（太大、超出自动采纳的风险，或今天的自动采纳额度用完了），去看板的需求页上采纳或拒绝',
      href: '#/issues',
      tag: 'ares1-event-42',
    });
    // Accepted by auto-accept or a human, rejected or started over by a human: nobody has to act.
    const decided = { repo: 'demo', proposalId: 'proposal-1', runId: 'run-1', reason: 'x' };
    for (const type of [
      'proposal.auto_accepted',
      'proposal.accepted',
      'proposal.rejected',
      'proposal.restarted',
    ]) {
      expect(noticeFor(ev(type, decided, null), undefined), type).toBeNull();
    }
    // A redo of a failed local proposal, or giving it up: the failed Run was told already.
    for (const type of ['proposal.redo_scheduled', 'proposal.redone', 'proposal.failed']) {
      expect(noticeFor(ev(type, decided, null), undefined), type).toBeNull();
    }
    setLang('en');
    const en = noticeFor(ev('scout.completed', scout, null), undefined);
    expect(en?.title).toBe('Proposals waiting for your decision: 2');
    expect(`${en?.title} ${en?.body}`).not.toMatch(/[一-鿿]/);
  });

  it('sends a blocked iteration to its page', () => {
    const blocked = {
      repo: 'demo',
      iterationId: 'iteration-7',
      issue: 12,
      position: 2,
      child: 14,
      reason: 'failed',
    };
    expect(noticeFor(ev('iteration.blocked', blocked, null), undefined)).toMatchObject({
      title: expect.stringContaining('demo'),
      href: '#/iterations/iteration-7',
    });
    const local = { repo: 'demo', iterationId: 'iteration-8', position: 1, backlog: true };
    expect(noticeFor(ev('iteration.blocked', local, null), undefined)?.href).toBe(
      '#/iterations/iteration-8',
    );
    // Recorded without its id: the Issues page.
    expect(noticeFor(ev('iteration.blocked', { repo: 'demo' }, null), undefined)?.href).toBe(
      '#/issues',
    );
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
