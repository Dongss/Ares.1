import { afterEach, describe, expect, it } from 'vitest';
import { setLang } from '../src/i18n.js';
import { BLOCK_KIND, NOTICE_KINDS, noticeFor } from '../src/notify/notice.js';
import { noticeScript } from '../src/notify/system.js';
import { blockOnAgentError, type Harness, harness } from './helpers.js';

let h: Harness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('system notifications', () => {
  it('notifies only when a human is needed, and only when enabled', async () => {
    const sent: string[] = [];
    h = await harness({
      config: 'notify:\n  system: true\n',
      master: { notice: (title, body) => sent.push(`${title}|${body}`) },
    });
    h.scripts.coder = () => ({ status: 'failed', error: '炸了' });
    const run = h.run('做一件事\n细节', blockOnAgentError());
    await h.waitStatus(run.id, 'blocked');
    expect(sent).toEqual(['Run 卡住了：Agent 执行出错|做一件事']);

    const ok = h.run('另一件事', { stages: { merge: { gate: false } } });
    h.scripts.coder = undefined as never;
    await h.master.engine.cancel(run.id);
    expect(ok.id).toBeTruthy();
    expect(sent).toHaveLength(1); // cancelled by a human: no notice
  });

  it('titles a macOS notification with the project name, quoting the texts', () => {
    expect(noticeScript('Run 卡住了', '做 "一件" 事')).toBe(
      'display notification "做 \\"一件\\" 事" with title "战神一号" subtitle "Run 卡住了" sound name "default"',
    );
  });

  it('stays quiet when notify.system is off', async () => {
    const sent: string[] = [];
    h = await harness({ master: { notice: (title) => sent.push(title) } });
    h.scripts.coder = () => ({ status: 'failed', error: '炸了' });
    const run = h.run('添加 feature.txt', blockOnAgentError());
    await h.waitStatus(run.id, 'blocked');
    expect(sent).toEqual([]);
  });
});

describe('notifications in English', () => {
  afterEach(() => setLang('zh'));

  it('titles notifications and block reasons in the language in use', () => {
    const blocked = {
      id: 1,
      runId: 'run-1',
      ts: '2026-11-19T00:00:00.000Z',
      type: 'run.blocked',
      data: { kind: 'merge_conflict' },
    };
    expect(noticeFor(blocked, 'Add a thing')?.title).toBe('Run 卡住了：合并冲突');
    setLang('en');
    expect(noticeFor(blocked, 'Add a thing')).toMatchObject({
      title: 'Run is stuck: Merge conflict',
      body: 'Add a thing',
    });
    // The shared records follow the language too.
    expect(BLOCK_KIND.budget).toBe('Over budget');
    expect(Object.values(NOTICE_KINDS).every((k) => !/[\u4e00-\u9fff]/.test(k.label))).toBe(true);
    expect(noticeScript('Run is stuck', 'Add a thing')).toContain('with title "Ares.1"');
  });
});
