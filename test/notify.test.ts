import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLang } from '../src/i18n.js';
import { BLOCK_KIND, NOTICE_KINDS, noticeFor } from '../src/notify/notice.js';
import {
  type ExecFile,
  makeSystemNotice,
  noticeScript,
  systemNoticeSupported,
} from '../src/notify/system.js';
import { blockOnAgentError, type Harness, harness } from './helpers.js';

/** An execFile that records its calls and answers each with `fail()`'s error, if any. */
function fakeExecFile(fail: () => Error | null = () => null) {
  const calls: { file: string; args: string[]; timeout: number }[] = [];
  const execFile: ExecFile = (file, args, options, callback) => {
    calls.push({ file, args, timeout: options.timeout });
    callback(fail());
  };
  return { calls, execFile };
}

function enoent(file: string): Error {
  return Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' });
}

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

  it('sends through notify-send on Linux, passing the texts as they are, without a shell', () => {
    const { calls, execFile } = fakeExecFile();
    const logs: string[] = [];
    const send = makeSystemNotice({ platform: 'linux', execFile, log: (m) => logs.push(m) });
    const body = `做 "一件" 事 \\ 'x' $HOME \`id\``;
    send('Run 卡住了', body);
    expect(calls).toEqual([
      {
        file: 'notify-send',
        args: ['--app-name', '战神一号', 'Run 卡住了', body],
        timeout: 10_000,
      },
    ]);
    expect(logs).toEqual([]);
  });

  it('still sends through osascript on macOS', () => {
    const { calls, execFile } = fakeExecFile();
    const send = makeSystemNotice({ platform: 'darwin', execFile, log: () => {} });
    send('Run 卡住了', '做 "一件" 事');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      file: 'osascript',
      args: ['-e', noticeScript('Run 卡住了', '做 "一件" 事')],
    });
  });

  it('runs nothing on other platforms', () => {
    const { calls, execFile } = fakeExecFile();
    const logs: string[] = [];
    for (const platform of ['win32', 'freebsd', 'aix'] as const) {
      makeSystemNotice({ platform, execFile, log: (m) => logs.push(m) })('标题', '正文');
    }
    expect(calls).toEqual([]);
    expect(logs).toEqual([]);
    expect(systemNoticeSupported('darwin')).toBe(true);
    expect(systemNoticeSupported('linux')).toBe(true);
    expect(systemNoticeSupported('win32')).toBe(false);
  });

  it('logs only the first failure, never throwing (no notify-send installed)', () => {
    const { calls, execFile } = fakeExecFile(() => enoent('notify-send'));
    const logs: string[] = [];
    const send = makeSystemNotice({ platform: 'linux', execFile, log: (m) => logs.push(m) });
    for (let i = 0; i < 5; i++) expect(() => send('标题', `正文 ${i}`)).not.toThrow();
    expect(calls).toHaveLength(5); // it keeps trying: the command may be installed later
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('[通知]');
    expect(logs[0]).toContain('找不到 notify-send');
    expect(logs[0]).toContain('libnotify');
  });

  it('logs an error execFile throws right away once, without throwing it', () => {
    const logs: string[] = [];
    const send = makeSystemNotice({
      platform: 'linux',
      execFile: () => {
        throw new Error('参数里有 NUL');
      },
      log: (m) => logs.push(m),
    });
    expect(() => send('标题', '正文\0')).not.toThrow();
    expect(() => send('标题', '正文\0')).not.toThrow();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('参数里有 NUL');
  });

  it('does not throw when notify-send really is missing', async () => {
    const logs: string[] = [];
    const missing = `ares1-no-such-command-${process.pid}`;
    const send = makeSystemNotice({
      platform: 'linux',
      // The real execFile, running a command that does not exist.
      execFile: (_file, args, options, callback) =>
        execFile(missing, args, options, (err) => callback(err)),
      log: (m) => logs.push(m),
    });
    send('标题', '正文');
    send('标题', '正文');
    await vi.waitFor(() => expect(logs).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(logs).toHaveLength(1);
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

  it('names the app and logs a failure in English', () => {
    setLang('en');
    const { calls, execFile } = fakeExecFile(() => enoent('notify-send'));
    const logs: string[] = [];
    makeSystemNotice({ platform: 'linux', execFile, log: (m) => logs.push(m) })('Stuck', 'A thing');
    expect(calls[0]?.args).toEqual(['--app-name', 'Ares.1', 'Stuck', 'A thing']);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('[notify]');
    expect(logs[0]).toContain('install libnotify');
    expect(logs[0]).not.toMatch(/[一-鿿]/);
  });
});
