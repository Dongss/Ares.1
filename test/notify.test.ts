import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCOUT_FAILURE_NOTIFY_AFTER } from '../src/config/flow.js';
import type { LoadedConfig } from '../src/config/load.js';
import { WebhookSchema } from '../src/config/schema.js';
import { setLang } from '../src/i18n.js';
import { BLOCK_KIND, NOTICE_KINDS, noticeFor } from '../src/notify/notice.js';
import {
  type ExecFile,
  makeSystemNotice,
  NOTICE_KILL_SIGNAL,
  NOTICE_TIMEOUT_MS,
  type NoticeFailure,
  noticeScript,
  SystemNotifier,
  sendSystemNotice,
  systemNoticeSupported,
} from '../src/notify/system.js';
import {
  escapeCurlConfigValue,
  type Fetch,
  saveWebhookCurlFile,
  WEBHOOK_TIMEOUT_MS,
  WebhookNotifier,
  webhookCurlConfig,
  webhookCurlFile,
  webhookRequest,
  writeWebhookCurlFile,
} from '../src/notify/webhook.js';
import type { EventRow } from '../src/store/types.js';
import {
  blockOnAgentError,
  type Harness,
  harness,
  type Script,
  tmpDir,
  writeFile,
} from './helpers.js';

/**
 * An execFile that records its calls and answers each with `fail()`'s error, if any, and
 * `stderr()` as what the command wrote to its standard error.
 */
function fakeExecFile(fail: () => Error | null = () => null, stderr: () => string = () => '') {
  const calls: { file: string; args: string[]; timeout: number; killSignal: string }[] = [];
  const execFile: ExecFile = (file, args, options, callback) => {
    calls.push({ file, args, timeout: options.timeout, killSignal: options.killSignal });
    callback(fail(), '', stderr());
  };
  return { calls, execFile };
}

function enoent(file: string): Error {
  return Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' });
}

/** The error Node's execFile gives for a command that exited with `code`: the command line in it. */
function exited(code: number, commandLine: string): Error {
  return Object.assign(new Error(`Command failed: ${commandLine}\n`), {
    code,
    killed: false,
    signal: null,
  });
}

const NO_NOTIFY_SEND = '找不到 notify-send，Linux 上需要安装 libnotify（提供 notify-send）';

/** An execFile that fails every command with `err`, passing no stderr on. */
const fail =
  (err: Error): ExecFile =>
  (_file, _args, _options, callback) =>
    callback(err);

/** An error as execFile gives for a command that ran and failed: the command line comes first. */
function commandFailed(
  file: string,
  printed: string,
  how: { code?: number; killed?: boolean; signal?: string },
): Error {
  return Object.assign(
    new Error(`Command failed: ${file} -e display notification "正文"\n${printed}`),
    { code: how.code ?? null, killed: how.killed ?? false, signal: how.signal ?? null },
  );
}

let h: Harness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

interface Received {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

/**
 * A webhook receiver on 127.0.0.1 and a random port, answering every request with `status()`;
 * `hang` never answers.
 */
async function hookServer(opts: { status?: () => number; hang?: boolean } = {}) {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (opts.hang) return;
      res.statusCode = opts.status?.() ?? 200;
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    received,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

let servers: Awaited<ReturnType<typeof hookServer>>[] = [];

async function startHook(opts?: Parameters<typeof hookServer>[0]) {
  const server = await hookServer(opts);
  servers.push(server);
  return server;
}

/** An address nothing listens on: a server that was closed right away. */
async function deadUrl(): Promise<string> {
  const server = await hookServer();
  await server.close();
  return server.url;
}

afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

/** The token the tests put in the webhook's address and headers: never to be logged. */
const TOKEN = 'tk_secret_token';

const webhookYaml = (url: string, extra = '') =>
  `notify:\n  webhook:\n    url: ${url}/hook?auth=${TOKEN}\n    headers:\n      Authorization: Bearer ${TOKEN}\n${extra}`;

/** A Master's configuration with `webhook()` as its webhook, read on every call. */
function withWebhook(
  config: () => LoadedConfig,
  webhook: () => { url: string; headers?: Record<string, string> } | undefined,
): () => LoadedConfig {
  return () => {
    const base = config();
    const raw = webhook();
    return {
      ...base,
      master: {
        ...base.master,
        notify: { ...base.master.notify, webhook: raw ? WebhookSchema.parse(raw) : undefined },
      },
    };
  };
}

const scoutFailed = (streak: number) => ({
  scoutId: 'scout_1',
  repo: 'demo',
  message: '侦察结果不符合约定',
  streak,
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
    const results: (NoticeFailure | null)[] = [];
    const send = makeSystemNotice({ platform: 'linux', execFile });
    const body = `做 "一件" 事 \\ 'x' $HOME \`id\``;
    send('Run 卡住了', body, (failure) => results.push(failure));
    expect(calls).toEqual([
      {
        file: 'notify-send',
        args: ['--app-name', '战神一号', 'Run 卡住了', body],
        timeout: 10_000,
        killSignal: 'SIGTERM',
      },
    ]);
    expect(NOTICE_TIMEOUT_MS).toBe(10_000);
    // Node's own default for a timeout, passed on explicitly: the reason tells a timeout by it.
    expect(NOTICE_KILL_SIGNAL).toBe('SIGTERM');
    expect(results).toEqual([null]);
    // Nobody listening for the result is fine too.
    expect(() => send('Run 卡住了', body)).not.toThrow();
  });

  it('still sends through osascript on macOS', () => {
    const { calls, execFile } = fakeExecFile();
    const send = makeSystemNotice({ platform: 'darwin', execFile });
    send('Run 卡住了', '做 "一件" 事');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      file: 'osascript',
      args: ['-e', noticeScript('Run 卡住了', '做 "一件" 事')],
    });
  });

  it('runs nothing on other platforms, and reports nothing', () => {
    const { calls, execFile } = fakeExecFile(() => enoent('notify-send'));
    const results: (NoticeFailure | null)[] = [];
    for (const platform of ['win32', 'freebsd', 'aix'] as const) {
      makeSystemNotice({ platform, execFile })('标题', '正文', (f) => results.push(f));
    }
    expect(calls).toEqual([]);
    expect(results).toEqual([]);
    expect(systemNoticeSupported('darwin')).toBe(true);
    expect(systemNoticeSupported('linux')).toBe(true);
    expect(systemNoticeSupported('win32')).toBe(false);
  });

  it('reports each failure without throwing (no notify-send installed)', () => {
    const { calls, execFile } = fakeExecFile(() => enoent('notify-send'));
    const results: (NoticeFailure | null)[] = [];
    const send = makeSystemNotice({ platform: 'linux', execFile });
    for (let i = 0; i < 3; i++) {
      expect(() => send('标题', `正文 ${i}`, (f) => results.push(f))).not.toThrow();
    }
    expect(calls).toHaveLength(3); // it keeps trying: the command may be installed later
    expect(results).toEqual(Array(3).fill({ command: 'notify-send', reason: NO_NOTIFY_SEND }));
  });

  it('reports an error execFile throws right away, without throwing it', () => {
    const results: (NoticeFailure | null)[] = [];
    const send = makeSystemNotice({
      platform: 'linux',
      execFile: () => {
        throw new Error('参数里有 NUL\n第二行');
      },
    });
    expect(() => send('标题', '正文\0', (f) => results.push(f))).not.toThrow();
    expect(() => send('标题', '正文\0')).not.toThrow();
    expect(results).toEqual([{ command: 'notify-send', reason: '参数里有 NUL' }]);
  });

  it('hears the result once, even when the listener throws', () => {
    for (const fail of [() => null, () => enoent('osascript')]) {
      const { execFile } = fakeExecFile(fail);
      let heard = 0;
      const send = makeSystemNotice({ platform: 'darwin', execFile });
      expect(() =>
        send('标题', '正文', () => {
          heard++;
          throw new Error('炸了');
        }),
      ).not.toThrow();
      expect(heard).toBe(1);
    }
  });

  it('keeps the command line and the texts out of the reason: exit code and the first error line', () => {
    const goal = '做一件不该进日志的事';
    const script = noticeScript('Run 卡住了', goal);
    const reasonOf = (err: Error, stderr = '') => {
      const results: (NoticeFailure | null)[] = [];
      const { execFile } = fakeExecFile(
        () => err,
        () => stderr,
      );
      makeSystemNotice({ platform: 'darwin', execFile })('Run 卡住了', goal, (f) =>
        results.push(f),
      );
      expect(results).toHaveLength(1);
      expect(results[0]?.command).toBe('osascript');
      return results[0]?.reason;
    };
    const failed = exited(1, `osascript -e ${script}`);
    expect(reasonOf(failed, '0:120: execution error: 不允许发送通知。 (-1743)\n更多\n')).toBe(
      '退出码 1：0:120: execution error: 不允许发送通知。 (-1743)',
    );
    expect(reasonOf(failed)).toBe('退出码 1');
    expect(reasonOf(failed, `  ${'x'.repeat(300)}`)).toBe(`退出码 1：${'x'.repeat(200)}…`);
    const killed = Object.assign(new Error(`Command failed: osascript -e ${script}`), {
      code: null,
      killed: true,
      signal: 'SIGTERM',
    });
    expect(reasonOf(killed)).toBe('10 秒内无响应被终止');
    const signalled = Object.assign(new Error(`Command failed: osascript -e ${script}`), {
      code: null,
      killed: false,
      signal: 'SIGKILL',
    });
    expect(reasonOf(signalled)).toBe('被信号 SIGKILL 终止');
    expect(reasonOf(signalled, 'oops')).toBe('被信号 SIGKILL 终止：oops');
    // Killed by execFile, but not with the timeout's signal: told by its signal, not as timed out.
    const killedOtherwise = Object.assign(new Error(`Command failed: osascript -e ${script}`), {
      code: null,
      killed: true,
      signal: 'SIGKILL',
    });
    expect(reasonOf(killedOtherwise)).toBe('被信号 SIGKILL 终止');
    expect(reasonOf(killedOtherwise, 'oops')).toBe('被信号 SIGKILL 终止：oops');
    expect(reasonOf(enoent('osascript'))).toBe('找不到 osascript');
  });

  it('reports how a real command failed: missing, exiting with an error, killed or hanging', async () => {
    // The real execFile, running `file` in place of the notification command.
    const result = (file: string, args: string[], timeout?: number) =>
      new Promise<NoticeFailure | null>((resolve) => {
        const send = makeSystemNotice({
          platform: 'linux',
          execFile: (_file, _args, options, callback) =>
            execFile(
              file,
              args,
              { timeout: timeout ?? options.timeout, killSignal: options.killSignal },
              callback,
            ),
        });
        send('标题', '正文', resolve);
      });
    const node = process.execPath;
    const failure = (reason: string) => ({ command: 'notify-send', reason });
    expect(await result(`ares1-no-such-command-${process.pid}`, [])).toEqual(
      failure(NO_NOTIFY_SEND),
    );
    expect(
      await result(node, [
        '-e',
        'process.stderr.write("Failed to connect to bus\\nmore"); process.exit(3)',
      ]),
    ).toEqual(failure('退出码 3：Failed to connect to bus'));
    expect(await result(node, ['-e', 'process.exit(2)'])).toEqual(failure('退出码 2'));
    expect(await result(node, ['-e', 'process.kill(process.pid, "SIGKILL")'])).toEqual(
      failure('被信号 SIGKILL 终止'),
    );
    expect(await result(node, ['-e', 'setTimeout(() => {}, 10000)'], 200)).toEqual(
      failure('10 秒内无响应被终止'),
    );
    expect(await result(node, ['-e', ''])).toBeNull();
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

describe('system notifications that fail', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setLang('zh');
  });

  const systemLogs = (warn: { mock: { calls: unknown[][] } }) =>
    warn.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('[通知] 系统通知'));

  it('records the first failure of each streak on the Events page, notifying nobody of it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hook = await startHook();
    // What the next notification command does: fail with this error (and stderr), or work.
    let error: Error | null = enoent('notify-send');
    let stderr = '';
    const { calls, execFile } = fakeExecFile(
      () => error,
      () => stderr,
    );
    h = await harness({
      config: `notify:\n  system: true\n  webhook:\n    url: ${hook.url}/hook\n`,
      master: { notice: makeSystemNotice({ platform: 'linux', execFile }) },
    });
    const store = h.master.store;
    const failures = () => store.listEventsOfType('notify.system_failed', '');
    const notify = () =>
      expect(() =>
        store.event(null, 'scout.failed', scoutFailed(SCOUT_FAILURE_NOTIFY_AFTER)),
      ).not.toThrow();

    // Failures in a row: told once.
    for (let i = 0; i < 3; i++) notify();
    expect(calls).toHaveLength(3); // it keeps trying: the command may be installed later
    expect(failures().map((e) => [e.runId, e.data])).toEqual([
      [null, { command: 'notify-send', reason: NO_NOTIFY_SEND }],
    ]);
    expect(systemLogs(warn)).toEqual([
      `[通知] 系统通知发送失败（notify-send）：${NO_NOTIFY_SEND}。之后的失败不再记录，直到有通知发送成功。`,
    ]);

    // One got through, then it broke again: told again, in the log and on the Events page.
    error = null;
    notify();
    expect(failures()).toHaveLength(1);
    error = exited(1, 'notify-send --app-name 战神一号 侦察连续失败：demo 侦察结果不符合约定');
    stderr = 'Failed to connect to bus: No such file or directory\n';
    notify();
    notify();
    expect(failures()).toHaveLength(2);
    expect(failures()[1]?.data).toEqual({
      command: 'notify-send',
      reason: '退出码 1：Failed to connect to bus: No such file or directory',
    });
    expect(systemLogs(warn)).toHaveLength(2);

    // The recorded failures notified nobody: no system notification, no POST to the webhook.
    expect(calls).toHaveLength(6);
    await h.master.webhook.idle();
    expect(hook.received.map((r) => JSON.parse(r.body).eventType)).toEqual(
      Array(6).fill('scout.failed'),
    );
    for (const e of failures()) expect(noticeFor(e, undefined)).toBeNull();
  });

  it('never notifies of a failed system notification, so a failure cannot set off another', () => {
    const event: EventRow = {
      id: 1,
      runId: null,
      ts: '2026-11-24T00:00:00.000Z',
      type: 'notify.system_failed',
      data: { command: 'notify-send', reason: NO_NOTIFY_SEND },
    };
    expect(noticeFor(event, undefined)).toBeNull();
  });

  it('records nothing where the platform has no system notifications', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { calls, execFile } = fakeExecFile(() => enoent('notify-send'));
    h = await harness({
      config: 'notify:\n  system: true\n',
      master: { notice: makeSystemNotice({ platform: 'win32', execFile }) },
    });
    h.master.store.event(null, 'scout.failed', scoutFailed(SCOUT_FAILURE_NOTIFY_AFTER));
    expect(calls).toEqual([]);
    expect(h.master.store.listEventsOfType('notify.system_failed', '')).toEqual([]);
    expect(systemLogs(warn)).toEqual([]);
  });

  it('records nothing while notify.system is off', async () => {
    const { calls, execFile } = fakeExecFile(() => enoent('notify-send'));
    h = await harness({ master: { notice: makeSystemNotice({ platform: 'linux', execFile }) } });
    h.master.store.event(null, 'scout.failed', scoutFailed(SCOUT_FAILURE_NOTIFY_AFTER));
    expect(calls).toEqual([]);
    expect(h.master.store.listEventsOfType('notify.system_failed', '')).toEqual([]);
  });

  it('swallows a failure that comes back after the Master stopped', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The commands answer only when the test says so.
    const answers: (() => void)[] = [];
    const execFile: ExecFile = (_file, _args, _options, callback) => {
      answers.push(() => callback(enoent('notify-send'), '', ''));
    };
    h = await harness({
      config: 'notify:\n  system: true\n',
      master: { notice: makeSystemNotice({ platform: 'linux', execFile }) },
    });
    h.master.store.event(null, 'scout.failed', scoutFailed(SCOUT_FAILURE_NOTIFY_AFTER));
    expect(answers).toHaveLength(1);
    await h.close();
    h = undefined;
    expect(() => answers[0]?.()).not.toThrow();
  });
});

describe('a scout that keeps failing', () => {
  afterEach(() => setLang('zh'));
  const failed = (data: Record<string, unknown>) => ({
    id: 7,
    runId: null,
    ts: '2026-11-19T00:00:00.000Z',
    type: 'scout.failed',
    data: { scoutId: 'scout_1', repo: 'demo', message: '侦察结果不符合约定\n细节', ...data },
  });

  it('is notified once, when the failures in a row reach the threshold', () => {
    expect(SCOUT_FAILURE_NOTIFY_AFTER).toBe(3);
    expect(noticeFor(failed({ streak: 3 }), undefined)).toEqual({
      kind: 'scout',
      title: '侦察连续失败：demo',
      body: '侦察结果不符合约定',
      runId: null,
      about: 'issues',
    });
    for (const streak of [0, 1, 2, 4, 10]) {
      expect(noticeFor(failed({ streak }), undefined)).toBeNull();
    }
    // Events from before the streak was recorded, and scouts the Master cut short, have none.
    expect(noticeFor(failed({}), undefined)).toBeNull();
    expect(noticeFor(failed({ streak: '3' }), undefined)).toBeNull();
  });

  it('cuts a long error to its first line of 200 characters', () => {
    const notice = noticeFor(failed({ streak: 3, message: `  ${'x'.repeat(300)}\nmore` }), 'g');
    expect(notice?.body).toBe(`${'x'.repeat(200)}…`);
  });

  it('is told in English without Chinese', () => {
    setLang('en');
    const notice = noticeFor(
      failed({ streak: 3, message: 'The scout did not end normally (timeout)\ndetails' }),
      undefined,
    );
    expect(notice).toMatchObject({
      kind: 'scout',
      title: 'Scout keeps failing: demo',
      body: 'The scout did not end normally (timeout)',
    });
    const text = `${notice?.title}\n${notice?.body}\n${NOTICE_KINDS.scout.when}`;
    expect(text).not.toMatch(/[一-鿿]/);
  });
});

describe('the target branch cannot take the commits on GitHub', () => {
  afterEach(() => setLang('zh'));
  const ev = (type: string, data: Record<string, unknown>) => ({
    id: 8,
    runId: null,
    ts: '2026-11-19T00:00:00.000Z',
    type,
    data: { repo: 'demo', branch: 'main', ...data },
  });
  const diverged = ev('github.diverged', { local: 'aaaaaaaa1111', remote: 'bbbbbbbb2222' });
  const blocked = ev('github.pull_blocked', {
    reason: 'dirty',
    worktree: '/w/demo',
    status: ' M a.ts',
  });

  it('notifies a divergence the first time and a refused fast-forward, not a pull', () => {
    expect(noticeFor(diverged, undefined)).toEqual({
      kind: 'pull',
      title: '没能拉取 GitHub 上的新提交：demo',
      body: 'main 和 GitHub 上的已经分叉（本地 aaaaaaa，GitHub bbbbbbb），要你手动合并后推送；在此之前 Master 不推送，已完成 Run 的 issue 保持打开',
      runId: null,
      about: 'issues',
    });
    // The same divergence again, after a Run merged or more was pushed.
    expect(noticeFor({ ...diverged, data: { ...diverged.data, repeated: true } }, undefined)).toBe(
      null,
    );
    expect(noticeFor(blocked, undefined)).toEqual({
      kind: 'pull',
      title: '没能拉取 GitHub 上的新提交：demo',
      body: 'main 检出在 /w/demo 有未提交的改动，不能快进到 GitHub 上的新提交；提交或丢弃这些改动后，下一轮检查会自动拉取',
      runId: null,
      about: 'issues',
    });
    expect(noticeFor(ev('github.pulled', { from: 'a', to: 'b' }), undefined)).toBeNull();
    // Without the data it still says something.
    expect(noticeFor(ev('github.diverged', { repo: null, branch: null }), undefined)?.title).toBe(
      '没能拉取 GitHub 上的新提交',
    );
  });

  it('is told in English without Chinese', () => {
    setLang('en');
    const texts = [diverged, blocked].map((e) => {
      const notice = noticeFor(e, undefined);
      return `${notice?.title}\n${notice?.body}`;
    });
    expect(texts).toEqual([
      "Could not pull new commits from GitHub: demo\nmain has diverged from GitHub's (local aaaaaaa, GitHub bbbbbbb); merge the two by hand and push. Until then the Master pushes nothing and the issues of completed Runs stay open",
      'Could not pull new commits from GitHub: demo\nmain is checked out in /w/demo with uncommitted changes, so it cannot be fast-forwarded to the new commits on GitHub; once they are committed or discarded, the next check pulls by itself',
    ]);
    for (const text of [...texts, NOTICE_KINDS.pull.when]) expect(text).not.toMatch(/[一-鿿]/);
  });

  const pair = { local: 'aaaaaaaa1111', remote: 'bbbbbbbb2222' };
  const conflict = ev('github.diverged', { ...pair, conflict: true, files: ['a.ts', 'b.ts'] });
  const failed = ev('github.diverged', {
    ...pair,
    failed: { command: 'npm test', kind: 'verify', exitCode: 1, timedOut: false },
    log: '/h/data/logs/github-merge-demo.log',
  });
  const missing = ev('github.diverged', {
    ...pair,
    failed: { command: 'npm ci', kind: 'setup', missing: 'npm' },
  });

  it("says whether the Master's merge of a divergence conflicted or failed the checks", () => {
    const body = (e: typeof diverged) => noticeFor(e, undefined)?.body;
    expect(body(conflict)).toBe(
      'main 和 GitHub 上的已经分叉（本地 aaaaaaa，GitHub bbbbbbb），自动合并有冲突（a.ts、b.ts），要你手动合并后推送；在此之前 Master 不推送，已完成 Run 的 issue 保持打开',
    );
    expect(body(failed)).toBe(
      'main 和 GitHub 上的已经分叉（本地 aaaaaaa，GitHub bbbbbbb），自动合并后检查命令 `npm test` 没通过（退出码 1），要你手动合并后推送；在此之前 Master 不推送，已完成 Run 的 issue 保持打开',
    );
    expect(body(missing)).toBe(
      'main 和 GitHub 上的已经分叉（本地 aaaaaaa，GitHub bbbbbbb），自动合并后要运行的准备命令 `npm ci` 在运行环境里找不到 npm；装好后下一轮检查会自动再合并，在此之前 Master 不推送，已完成 Run 的 issue 保持打开',
    );
    for (const e of [conflict, failed, missing]) {
      expect(noticeFor({ ...e, data: { ...e.data, repeated: true } }, undefined)).toBeNull();
    }
    // A divergence the Master merged by itself is nobody's business.
    const merged = ev('github.merged_remote', { ...pair, merge: 'cccccccc3333' });
    expect(noticeFor(merged, undefined)).toBeNull();

    setLang('en');
    const texts = [conflict, failed, missing].map((e) => body(e) ?? '');
    expect(texts).toEqual([
      "main has diverged from GitHub's (local aaaaaaa, GitHub bbbbbbb), and the Master's merge conflicts in a.ts, b.ts. Merge the two by hand and push; until then the Master pushes nothing and the issues of completed Runs stay open",
      "main has diverged from GitHub's (local aaaaaaa, GitHub bbbbbbb), and the verify command `npm test` failed on the Master's merge (exit code 1). Merge the two by hand and push; until then the Master pushes nothing and the issues of completed Runs stay open",
      "main has diverged from GitHub's (local aaaaaaa, GitHub bbbbbbb), and the setup command `npm ci` to run on the Master's merge cannot find npm. Once it is installed, the next check merges by itself; until then the Master pushes nothing and the issues of completed Runs stay open",
    ]);
    for (const text of texts) expect(text).not.toMatch(/[一-鿿]/);
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

  it('names the app, and logs and records a failure in English', async () => {
    h = await harness({ config: 'language: en\nnotify:\n  system: true\n' });
    const store = h.master.store;
    const { calls, execFile } = fakeExecFile(() => enoent('notify-send'));
    const logs: string[] = [];
    const notifier = new SystemNotifier(
      store,
      () => h?.master.config as LoadedConfig,
      makeSystemNotice({ platform: 'linux', execFile }),
      { log: (m) => logs.push(m) },
    );
    notifier.start();
    try {
      store.event(null, 'scout.failed', { ...scoutFailed(3), message: 'A thing' });
    } finally {
      notifier.stop();
    }
    expect(calls[0]?.args).toEqual([
      '--app-name',
      'Ares.1',
      'Scout keeps failing: demo',
      'A thing',
    ]);
    expect(logs).toEqual([
      '[notify] Sending a system notification failed (notify-send): notify-send was not found; on Linux, install libnotify (it provides notify-send). Later failures are not logged until a notification gets through.',
    ]);
    const [failure] = store.listEventsOfType('notify.system_failed', '');
    expect(failure?.data).toEqual({
      command: 'notify-send',
      reason: 'notify-send was not found; on Linux, install libnotify (it provides notify-send)',
    });
    for (const text of [...logs, JSON.stringify(failure?.data)]) {
      expect(text).not.toMatch(/[一-鿿]/);
    }

    const reasonOf = (err: Error, stderr = '') => {
      const results: (NoticeFailure | null)[] = [];
      const fake = fakeExecFile(
        () => err,
        () => stderr,
      );
      makeSystemNotice({ platform: 'darwin', execFile: fake.execFile })('Stuck', 'A thing', (f) =>
        results.push(f),
      );
      return results[0]?.reason;
    };
    expect(reasonOf(exited(1, 'osascript -e …'), 'execution error')).toBe(
      'exit code 1: execution error',
    );
    expect(reasonOf(Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' }))).toBe(
      'killed after no answer within 10 seconds',
    );
    expect(reasonOf(Object.assign(new Error('x'), { killed: false, signal: 'SIGKILL' }))).toBe(
      'terminated by signal SIGKILL',
    );
    expect(reasonOf(Object.assign(new Error('x'), { killed: true, signal: 'SIGKILL' }))).toBe(
      'terminated by signal SIGKILL',
    );
    expect(reasonOf(enoent('osascript'))).toBe('osascript was not found');
  });

  it('tells how a system notification failed in English', async () => {
    setLang('en');
    const reason = async (err: Error) =>
      (await sendSystemNotice('Test', 'A thing', { platform: 'darwin', execFile: fail(err) }))
        ?.reason;
    expect(await reason(commandFailed('osascript', 'execution error', { code: 1 }))).toBe(
      'exit code 1: execution error',
    );
    expect(await reason(commandFailed('osascript', '', { killed: true, signal: 'SIGTERM' }))).toBe(
      'killed after no answer within 10 seconds',
    );
    expect(await reason(commandFailed('osascript', '', { signal: 'SIGKILL' }))).toBe(
      'terminated by signal SIGKILL',
    );
    expect(await reason(commandFailed('osascript', 'oops', {}))).toBe('failed: oops');
  });

  it('tells a timeout only by the signal the timeout kills with, in both languages', async () => {
    const reason = async (err: Error) =>
      (await sendSystemNotice('Test', 'A thing', { platform: 'darwin', execFile: fail(err) }))
        ?.reason;
    const timedOut = () => commandFailed('osascript', '', { killed: true, signal: 'SIGTERM' });
    const killed = (printed: string) =>
      commandFailed('osascript', printed, { killed: true, signal: 'SIGKILL' });

    expect(await reason(timedOut())).toBe('10 秒内无响应被终止');
    expect(await reason(killed(''))).toBe('被信号 SIGKILL 终止');
    expect(await reason(killed('oops\nmore'))).toBe('被信号 SIGKILL 终止：oops');
    // Killed without a signal: not a timeout either, but a command that ran and failed.
    expect(await reason(commandFailed('osascript', '', { killed: true }))).toBe('运行失败');

    setLang('en');
    const english = [
      await reason(timedOut()),
      await reason(killed('')),
      await reason(killed('oops\nmore')),
      await reason(commandFailed('osascript', '', { killed: true })),
    ];
    expect(english).toEqual([
      'killed after no answer within 10 seconds',
      'terminated by signal SIGKILL',
      'terminated by signal SIGKILL: oops',
      'failed',
    ]);
    for (const text of english) expect(text).not.toMatch(/[一-鿿]/);
  });
});

describe('a system notification whose outcome is wanted (the test notification)', () => {
  it('resolves with how it went, running nothing where the platform has no command', async () => {
    const { calls, execFile } = fakeExecFile();
    expect(sendSystemNotice('标题', '正文', { platform: 'win32', execFile })).toBeNull();
    expect(calls).toEqual([]);
    expect(await sendSystemNotice('标题', '正文', { platform: 'darwin', execFile })).toEqual({
      ok: true,
      file: 'osascript',
      reason: null,
    });
    expect(calls).toEqual([
      {
        file: 'osascript',
        args: ['-e', noticeScript('标题', '正文')],
        timeout: 10_000,
        killSignal: NOTICE_KILL_SIGNAL,
      },
    ]);
  });

  it('says why it failed, without the command line and the texts it carried', async () => {
    const outcome = (err: Error, platform: NodeJS.Platform = 'darwin') =>
      sendSystemNotice('标题', '正文', { platform, execFile: fail(err) });
    expect(
      await outcome(
        commandFailed('osascript', '0:5: execution error: 出错了 (-1728)\n', { code: 1 }),
      ),
    ).toEqual({
      ok: false,
      file: 'osascript',
      reason: '退出码 1：0:5: execution error: 出错了 (-1728)',
    });
    expect(
      (
        await outcome(
          commandFailed('notify-send', '', { killed: true, signal: NOTICE_KILL_SIGNAL }),
          'linux',
        )
      )?.reason,
    ).toBe('10 秒内无响应被终止');
    expect(
      (
        await outcome(
          commandFailed('notify-send', 'oops', { killed: true, signal: 'SIGKILL' }),
          'linux',
        )
      )?.reason,
    ).toBe('被信号 SIGKILL 终止：oops');
    // A command that ran and failed with neither an exit code nor a signal: still no command line.
    expect((await outcome(commandFailed('osascript', '', {})))?.reason).toBe('运行失败');
    expect((await outcome(enoent('notify-send'), 'linux'))?.reason).toContain('libnotify');
    // Not execFile's own wording: as it is.
    expect((await outcome(new Error('参数里有 NUL')))?.reason).toBe('参数里有 NUL');
    // execFile throwing right away fails it the same.
    const throwing = await sendSystemNotice('标题', '正文\0', {
      platform: 'linux',
      execFile: () => {
        throw new Error('参数里有 NUL');
      },
    });
    expect(throwing).toEqual({ ok: false, file: 'notify-send', reason: '参数里有 NUL' });
  });

  it('reads a command that really failed', async () => {
    const outcome = await sendSystemNotice('标题', '正文', {
      platform: 'linux',
      // The real execFile, running a command that prints why and exits 3.
      execFile: (_file, _args, options, callback) =>
        execFile('sh', ['-c', 'echo 没有桌面会话 >&2; exit 3'], options, (err) => callback(err)),
    });
    expect(outcome).toEqual({ ok: false, file: 'notify-send', reason: '退出码 3：没有桌面会话' });
  });

  it('logs nothing, records nothing and leaves the streak of real notifications alone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logged = () =>
      warn.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('[通知] 系统通知'));
    try {
      let error: Error | null = enoent('notify-send');
      const { execFile } = fakeExecFile(() => error);
      h = await harness({
        config: 'notify:\n  system: true\n',
        master: { notice: makeSystemNotice({ platform: 'linux', execFile }) },
      });
      const store = h.master.store;
      const failures = () => store.listEventsOfType('notify.system_failed', '');
      const test = () => sendSystemNotice('标题', '正文', { platform: 'linux', execFile });
      const real = () => store.event(null, 'scout.failed', scoutFailed(SCOUT_FAILURE_NOTIFY_AFTER));

      // A failed test: no log, no event; the first real failure is still told.
      expect((await test())?.ok).toBe(false);
      expect(failures()).toEqual([]);
      expect(logged()).toEqual([]);
      real();
      expect(failures()).toHaveLength(1);
      // A test getting through does not end the streak: the next real failure is not told.
      error = null;
      expect((await test())?.ok).toBe(true);
      error = enoent('notify-send');
      real();
      expect(failures()).toHaveLength(1);
      expect(logged()).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('webhook notifications', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setLang('zh');
  });

  it('POSTs only what needs a human, once each, as JSON with the configured headers', async () => {
    const hook = await startHook();
    h = await harness({ config: webhookYaml(hook.url) });
    const { store, engine, webhook } = h.master;
    const coder = h.scripts.coder as Script;
    h.scripts.coder = () => ({ status: 'failed', error: '炸了' });
    const stuck = h.run('做一件事\n细节', blockOnAgentError());
    await h.waitStatus(stuck.id, 'blocked');
    await webhook.idle();
    expect(hook.received).toHaveLength(1);
    const [first] = hook.received;
    expect(first).toMatchObject({ method: 'POST', url: `/hook?auth=${TOKEN}` });
    expect(first?.headers['content-type']).toBe('application/json');
    expect(first?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const blockedEvent = store.listEvents(stuck.id).find((e) => e.type === 'run.blocked');
    expect(JSON.parse(first?.body ?? '')).toEqual({
      kind: 'blocked',
      title: 'Run 卡住了：Agent 执行出错',
      body: '做一件事',
      text: 'Run 卡住了：Agent 执行出错\n做一件事',
      runId: stuck.id,
      about: 'run',
      eventType: 'run.blocked',
      at: blockedEvent?.ts,
    });

    // Cancelled by a human: nothing to tell.
    await engine.cancel(stuck.id);
    // Waiting for an approval is told; the Run completing after it is not.
    h.scripts.coder = coder;
    const ok = h.run('加一个功能');
    await h.waitStatus(ok.id, 'waiting_approval');
    engine.approve(ok.id);
    await h.waitStatus(ok.id, 'completed');
    // Every notice is POSTed on its own, so two sent together may arrive in either order: each
    // one is waited for before the next event, to check the order they were sent in.
    await webhook.idle();
    // A failed Run, and a scout that failed the third time in a row (not the second).
    store.event(ok.id, 'run.status', { status: 'failed' });
    await webhook.idle();
    store.event(null, 'scout.failed', scoutFailed(SCOUT_FAILURE_NOTIFY_AFTER - 1));
    store.event(null, 'scout.failed', scoutFailed(SCOUT_FAILURE_NOTIFY_AFTER));
    await webhook.idle();
    const sent = hook.received.map((r) => JSON.parse(r.body));
    expect(sent.map((s) => [s.kind, s.eventType, s.runId])).toEqual([
      ['blocked', 'run.blocked', stuck.id],
      ['approval', 'approval.requested', ok.id],
      ['failed', 'run.status', ok.id],
      ['scout', 'scout.failed', null],
    ]);
    expect(sent[3]).toMatchObject({
      title: '侦察连续失败：demo',
      body: '侦察结果不符合约定',
      about: 'issues',
    });
  });

  it('puts ~ for the home directory in what it sends', async () => {
    const hook = await startHook();
    h = await harness({ config: webhookYaml(hook.url) });
    const home = homedir();
    h.scripts.coder = () => ({ status: 'failed', error: '炸了' });
    const run = h.run(`修好 ${join(home, 'proj', 'a.ts')} 里的问题`, blockOnAgentError());
    await h.waitStatus(run.id, 'blocked');
    // Sent on its own, so it arrives before the next one only once it is through.
    await h.master.webhook.idle();
    // The Master's own node, under the home directory with a version manager, went missing.
    const node = join(home, '.nvm', 'versions', 'node', 'v24.0.0', 'bin', 'node');
    h.master.store.event(run.id, 'run.blocked', { kind: 'environment', missing: node });
    await h.master.webhook.idle();
    expect(hook.received).toHaveLength(2);
    const [blocked, missing] = hook.received.map((r) => JSON.parse(r.body));
    expect(blocked.body).toBe(`修好 ${join('~', 'proj', 'a.ts')} 里的问题`);
    const tilde = join('~', '.nvm', 'versions', 'node', 'v24.0.0', 'bin', 'node');
    expect(missing.title).toBe(`Run 卡住了：运行环境里找不到 ${tilde}`);
    expect(missing.text).toBe(`Run 卡住了：运行环境里找不到 ${tilde}\n${blocked.body}`);
    for (const r of hook.received) expect(r.body).not.toContain(home);
  });

  it('sends the title and body as plain text with format: text', async () => {
    const hook = await startHook();
    h = await harness({ config: webhookYaml(hook.url, '    format: text\n') });
    h.master.store.event(null, 'scout.failed', scoutFailed(SCOUT_FAILURE_NOTIFY_AFTER));
    await h.master.webhook.idle();
    expect(hook.received).toHaveLength(1);
    expect(hook.received[0]?.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(hook.received[0]?.body).toBe('侦察连续失败：demo\n侦察结果不符合约定');
  });

  it('lets configured headers replace the default ones, whatever their case', () => {
    const event: EventRow = {
      id: 1,
      runId: null,
      ts: '2026-11-19T00:00:00.000Z',
      type: 'scout.failed',
      data: scoutFailed(SCOUT_FAILURE_NOTIFY_AFTER),
    };
    const notice = noticeFor(event, undefined);
    if (!notice) throw new Error('no notice');
    const webhook = WebhookSchema.parse({
      url: 'https://ntfy.sh/topic',
      format: 'text',
      headers: { 'Content-Type': 'text/markdown', Title: 'Ares' },
    });
    const { headers, body } = webhookRequest(webhook, notice, event);
    expect([...headers.entries()]).toEqual([
      ['content-type', 'text/markdown'],
      ['title', 'Ares'],
    ]);
    expect(body).toBe('侦察连续失败：demo\n侦察结果不符合约定');
    // The home directory given is the one hidden.
    const json = webhookRequest(
      WebhookSchema.parse({ url: 'https://example.com/hook' }),
      { ...notice, body: '/home/someone/x 和 /home/someone2/y' },
      event,
      '/home/someone',
    );
    expect(JSON.parse(json.body).body).toBe('~/x 和 /home/someone2/y');
  });

  it('logs and records a failing webhook once per address, without its token, and never throws', async () => {
    h = await harness();
    const failures = () => h?.master.store.listEventsOfType('notify.webhook_failed', '') ?? [];
    const failing = await startHook({ status: () => 500 });
    const dead = await deadUrl();
    let url: string | undefined = `${failing.url}/hook?auth=${TOKEN}`;
    const logs: string[] = [];
    const notifier = new WebhookNotifier(
      h.master.store,
      withWebhook(
        () => h?.master.config as LoadedConfig,
        () => (url ? { url, headers: { Authorization: `Bearer ${TOKEN}` } } : undefined),
      ),
      { log: (m) => logs.push(m) },
    );
    notifier.start();
    try {
      const fail = () =>
        expect(() =>
          h?.master.store.event(null, 'scout.failed', scoutFailed(SCOUT_FAILURE_NOTIFY_AFTER)),
        ).not.toThrow();
      for (let i = 0; i < 3; i++) fail();
      await notifier.idle();
      // No retries: one request per notification.
      expect(failing.received).toHaveLength(3);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/^\[通知\] webhook 通知发送失败：HTTP 500/);
      expect(failures().map((e) => [e.runId, e.data])).toEqual([
        [null, { reason: 'HTTP 500 Internal Server Error', status: 500 }],
      ]);

      // Another address (the configuration was reloaded): its failure is logged again, once.
      url = `${dead}/hook?auth=${TOKEN}`;
      fail();
      fail();
      await notifier.idle();
      expect(logs).toHaveLength(2);
      expect(logs[1]).toContain('ECONNREFUSED');
      expect(failures()).toHaveLength(2);
      expect(failures()[1]?.data).toMatchObject({ status: null });
      expect(String(failures()[1]?.data.reason)).toContain('ECONNREFUSED');

      // Without a webhook, nothing is sent.
      url = undefined;
      fail();
      await notifier.idle();
      expect(failing.received).toHaveLength(3);
      for (const text of [...logs, ...failures().map((e) => JSON.stringify(e.data))]) {
        expect(text).not.toContain(TOKEN);
        expect(text).not.toContain('/hook');
      }
    } finally {
      notifier.stop();
    }
  });

  it('tells each streak of failures once: again after one got through, never notifying of it', async () => {
    const notices: string[] = [];
    h = await harness({
      config: 'notify:\n  system: true\n',
      master: { notice: (title) => notices.push(title) },
    });
    const store = h.master.store;
    let url = `https://hooks.example.com/hook?auth=${TOKEN}`;
    // What the webhook answers to each request, in order.
    const answers: (() => Response)[] = [];
    const requested: string[] = [];
    const fetch: Fetch = async (to) => {
      requested.push(to);
      const answer = answers.shift();
      if (!answer) throw new Error('no answer planned');
      return answer();
    };
    const ok = () => new Response('ok');
    const status = (code: number, text: string) => () =>
      new Response('no', { status: code, statusText: text });
    const refused = (): Response => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error(`connect ECONNREFUSED ${url}`), { code: 'ECONNREFUSED' }),
      });
    };
    const logs: string[] = [];
    const notifier = new WebhookNotifier(
      store,
      withWebhook(
        () => h?.master.config as LoadedConfig,
        () => ({ url, headers: { Authorization: `Bearer ${TOKEN}` } }),
      ),
      { fetch, log: (m) => logs.push(m) },
    );
    const failures = () => store.listEventsOfType('notify.webhook_failed', '');
    // One notification each, sent one after the other so that the answers come in order.
    const notify = async (...next: (() => Response)[]) => {
      for (const answer of next) {
        answers.push(answer);
        store.event(null, 'scout.failed', scoutFailed(SCOUT_FAILURE_NOTIFY_AFTER));
        await notifier.idle();
      }
    };
    notifier.start();
    try {
      // Failures in a row: told once, whatever the reason.
      await notify(status(500, 'Internal Server Error'), status(502, 'Bad Gateway'), refused);
      expect(failures().map((e) => [e.runId, e.data])).toEqual([
        [null, { reason: 'HTTP 500 Internal Server Error', status: 500 }],
      ]);
      expect(logs).toHaveLength(1);

      // It came back, then broke again: told again, in the log and on the Events page.
      await notify(ok, ok, refused, status(500, 'Internal Server Error'));
      expect(failures()).toHaveLength(2);
      expect(failures()[1]?.data).toEqual({
        reason: 'fetch failed (connect ECONNREFUSED ***)',
        status: null,
      });
      expect(logs).toHaveLength(2);
      expect(logs[1]).toBe(
        '[通知] webhook 通知发送失败：fetch failed (connect ECONNREFUSED ***)。之后的失败不再记录，直到有通知发送成功。',
      );

      // Another address failing is told again, still within the streak.
      url = `https://other.example.com/hook?auth=${TOKEN}`;
      await notify(status(404, 'Not Found'), status(404, 'Not Found'));
      expect(failures().map((e) => e.data.status)).toEqual([500, null, 404]);
      expect(logs).toHaveLength(3);

      // The recorded failures notified nobody: no system notification, no POST to the webhook.
      expect(requested).toHaveLength(9);
      expect(notices).toEqual(Array(9).fill('侦察连续失败：demo'));
      for (const e of failures()) expect(noticeFor(e, undefined)).toBeNull();
      for (const text of [...logs, ...failures().map((e) => JSON.stringify(e.data))]) {
        expect(text).not.toContain(TOKEN);
        expect(text).not.toContain('example.com');
      }
    } finally {
      notifier.stop();
    }
  });

  it('never notifies of a failed webhook, so a failure cannot set off another POST', () => {
    const event: EventRow = {
      id: 1,
      runId: null,
      ts: '2026-11-23T00:00:00.000Z',
      type: 'notify.webhook_failed',
      data: { reason: 'HTTP 500 Internal Server Error', status: 500 },
    };
    expect(noticeFor(event, undefined)).toBeNull();
  });

  it('gives up on a webhook that does not answer', async () => {
    h = await harness();
    const hanging = await startHook({ hang: true });
    const logs: string[] = [];
    const notifier = new WebhookNotifier(
      h.master.store,
      withWebhook(
        () => h?.master.config as LoadedConfig,
        () => ({ url: hanging.url }),
      ),
      { log: (m) => logs.push(m), timeoutMs: 50 },
    );
    notifier.start();
    try {
      h.master.store.event(null, 'scout.failed', scoutFailed(SCOUT_FAILURE_NOTIFY_AFTER));
      await notifier.idle();
      expect(hanging.received).toHaveLength(1);
      expect(logs).toEqual([
        '[通知] webhook 通知发送失败：0.05 秒内没有响应。之后的失败不再记录，直到有通知发送成功。',
      ]);
    } finally {
      notifier.stop();
    }
    expect(WEBHOOK_TIMEOUT_MS).toBe(10_000);
  });

  it('keeps the Master working when the webhook cannot be reached', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h = await harness({ config: webhookYaml(await deadUrl()) });
    const coder = h.scripts.coder as Script;
    h.scripts.coder = () => ({ status: 'failed', error: '炸了' });
    const stuck = h.run('做一件事', blockOnAgentError());
    await h.waitStatus(stuck.id, 'blocked');
    await h.master.engine.cancel(stuck.id);
    h.scripts.coder = coder;
    const ok = h.run('加一个功能');
    await h.waitStatus(ok.id, 'waiting_approval');
    h.master.engine.approve(ok.id);
    await h.waitStatus(ok.id, 'completed');
    await h.master.webhook.idle();
    const notifyLogs = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('[通知]'));
    expect(notifyLogs).toHaveLength(1);
    expect(notifyLogs[0]).toContain('webhook');
    expect(h.master.store.listEventsOfType('notify.webhook_failed', '')).toHaveLength(1);
  });

  it('sends nothing without a webhook', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    h = await harness();
    expect(h.master.config.master.notify.webhook).toBeUndefined();
    h.scripts.coder = () => ({ status: 'failed', error: '炸了' });
    const run = h.run('做一件事', blockOnAgentError());
    await h.waitStatus(run.id, 'blocked');
    h.master.store.event(null, 'scout.failed', scoutFailed(SCOUT_FAILURE_NOTIFY_AFTER));
    await h.master.webhook.idle();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends and logs in English when config.yaml says so', async () => {
    const hook = await startHook({ status: () => 503 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h = await harness({ config: `language: en\n${webhookYaml(hook.url)}` });
    h.master.store.event(null, 'scout.failed', {
      ...scoutFailed(SCOUT_FAILURE_NOTIFY_AFTER),
      message: 'The scout did not end normally (timeout)',
    });
    await h.master.webhook.idle();
    expect(JSON.parse(hook.received[0]?.body ?? '')).toMatchObject({
      title: 'Scout keeps failing: demo',
      text: 'Scout keeps failing: demo\nThe scout did not end normally (timeout)',
    });
    const logs = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('webhook'));
    expect(logs).toEqual([
      '[notify] Sending a webhook notification failed: HTTP 503 Service Unavailable. Later failures are not logged until a notification gets through.',
    ]);
    expect(logs[0]).not.toMatch(/[一-鿿]/);
    expect(h.master.store.listEventsOfType('notify.webhook_failed', '')[0]?.data).toEqual({
      reason: 'HTTP 503 Service Unavailable',
      status: 503,
    });
  });
});

/**
 * A fetch whose requests wait for the test to answer them; one whose signal is aborted fails as
 * fetch does, with the signal's reason.
 */
function heldFetch() {
  const requests: { url: string; signal: AbortSignal; answer: (response: Response) => void }[] = [];
  const fetch: Fetch = (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      requests.push({ url, signal, answer: resolve });
    });
  return { requests, fetch };
}

/** Whether `promise` is still pending after the tasks queued so far (and a little more) ran. */
async function stillPending(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  return !settled;
}

describe('webhook notifications when the Master stops', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setLang('zh');
  });

  /** A notifier on the harness's store whose requests the test answers. */
  function heldNotifier(timeoutMs = 60_000) {
    if (!h) throw new Error('no harness');
    const held = heldFetch();
    const logs: string[] = [];
    const notifier = new WebhookNotifier(
      h.master.store,
      withWebhook(
        () => h?.master.config as LoadedConfig,
        () => ({ url: `https://hooks.example.com/hook?auth=${TOKEN}` }),
      ),
      { fetch: held.fetch, log: (m) => logs.push(m), timeoutMs },
    );
    notifier.start();
    const notify = () =>
      h?.master.store.event(null, 'scout.failed', scoutFailed(SCOUT_FAILURE_NOTIFY_AFTER));
    const failures = () => h?.master.store.listEventsOfType('notify.webhook_failed', '') ?? [];
    return { held, logs, notifier, notify, failures };
  }

  it('waits for a notification already sent, and returns as soon as it got through', async () => {
    h = await harness();
    const { held, logs, notifier, notify, failures } = heldNotifier();
    notify();
    expect(held.requests).toHaveLength(1);
    const drained = notifier.drain(20_000);
    // It sends nothing more.
    notify();
    expect(held.requests).toHaveLength(1);
    expect(await stillPending(drained)).toBe(true);
    const answered = performance.now();
    held.requests[0]?.answer(new Response('ok'));
    await drained;
    expect(performance.now() - answered).toBeLessThan(5_000);
    expect(held.requests[0]?.signal.aborted).toBe(false);
    expect(failures()).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('returns at once with nothing out', async () => {
    h = await harness();
    const { held, logs, notifier } = heldNotifier();
    const started = performance.now();
    await notifier.drain(20_000);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(held.requests).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('gives up on what is still out at its deadline without recording a failure', async () => {
    h = await harness();
    const { held, logs, notifier, notify, failures } = heldNotifier();
    notify();
    // The test notification is aborted with them, though not waited for.
    const test = notifier.sendTest('测试', '正文');
    expect(held.requests).toHaveLength(2);
    const started = performance.now();
    await notifier.drain(50);
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(45);
    expect(waited).toBeLessThan(5_000);
    expect(held.requests.map((r) => r.signal.aborted)).toEqual([true, true]);
    expect(failures()).toEqual([]);
    expect(logs).toEqual([
      '[通知] Master 停止时还有 1 条 webhook 通知 0.05 秒内没有发完，已放弃。',
    ]);
    expect(await test).toEqual({ ok: false, status: null, reason: 'Master 正在停止' });
  });

  it('tells in English what it gave up on', async () => {
    h = await harness({ config: 'language: en\n' });
    const { held, logs, notifier, notify, failures } = heldNotifier();
    notify();
    notify();
    await notifier.drain(50);
    expect(held.requests.map((r) => r.signal.aborted)).toEqual([true, true]);
    expect(failures()).toEqual([]);
    expect(logs).toEqual([
      '[notify] The Master stopped with 2 webhook notifications still unsent after 0.05 seconds; gave up on them.',
    ]);
    expect(logs[0]).not.toMatch(/[一-鿿]/);
  });

  it('still records a failure that happens while it waits', async () => {
    h = await harness();
    const { held, logs, notifier, notify, failures } = heldNotifier();
    notify();
    const drained = notifier.drain(20_000);
    expect(await stillPending(drained)).toBe(true);
    held.requests[0]?.answer(
      new Response('no', { status: 500, statusText: 'Internal Server Error' }),
    );
    await drained;
    expect(failures().map((e) => [e.runId, e.data])).toEqual([
      [null, { reason: 'HTTP 500 Internal Server Error', status: 500 }],
    ]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^\[通知\] webhook 通知发送失败：HTTP 500/);
  });

  it('records a request that timed out by itself before the deadline as a failure', async () => {
    h = await harness();
    const { held, logs, notifier, notify, failures } = heldNotifier(50);
    notify();
    await notifier.drain(20_000);
    expect(held.requests[0]?.signal.aborted).toBe(true);
    expect(failures().map((e) => e.data)).toEqual([{ reason: '0.05 秒内没有响应', status: null }]);
    expect(logs).toEqual([
      '[通知] webhook 通知发送失败：0.05 秒内没有响应。之后的失败不再记录，直到有通知发送成功。',
    ]);
  });

  it('closes the Master only after the notifications already sent, recording their failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const held = heldFetch();
    const first = await harness({
      config: webhookYaml('https://hooks.example.com'),
      master: { fetch: held.fetch },
    });
    h = first;
    first.master.store.event(null, 'scout.failed', scoutFailed(SCOUT_FAILURE_NOTIFY_AFTER));
    expect(held.requests).toHaveLength(1);
    const closed = first.master.close();
    expect(await stillPending(closed)).toBe(true);
    held.requests[0]?.answer(
      new Response('no', { status: 503, statusText: 'Service Unavailable' }),
    );
    await closed;
    // Recorded before the database closed: the next Master finds it on the Events page.
    h = await harness({
      home: first.home,
      repoDir: first.repoDir,
      master: { fetch: async () => new Response('ok') },
    });
    expect(h.master.store.listEventsOfType('notify.webhook_failed', '').map((e) => e.data)).toEqual(
      [{ reason: 'HTTP 503 Service Unavailable', status: 503 }],
    );
  });
});

describe('webhook settings for the scripts (webhook.curl)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setLang('zh');
  });

  /** The webhook.curl files of `home`, temporary ones included. */
  const curlFiles = (home: string) => readdirSync(home).filter((f) => f.startsWith('webhook.curl'));

  it('is written at start, readable by its owner only, follows reloads and goes with the webhook', async () => {
    const hook = await startHook();
    h = await harness({ config: webhookYaml(hook.url), master: { watchConfig: false } });
    const { configFile } = h.master.paths;
    const file = webhookCurlFile(h.home);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe(
      [
        '# Written by the Master from notify.webhook in config.yaml, for keepalive.sh and',
        '# self-upgrade.sh to notify when the Master is down; rewritten when the configuration changes.',
        '# ares1-format: json',
        `url = "${hook.url}/hook?auth=${TOKEN}"`,
        'request = "POST"',
        'globoff',
        `header = "authorization: Bearer ${TOKEN}"`,
        'header = "content-type: application/json"',
        '',
      ].join('\n'),
    );

    // Another address, other headers and another format, once the configuration is reloaded.
    writeFile(
      configFile,
      'notify:\n  webhook:\n    url: https://ntfy.sh/topic\n    headers:\n      X-Title: Ares\n    format: text\n',
    );
    expect(h.master.configWatcher.reload()).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# ares1-format: text\nurl = "https://ntfy.sh/topic"\n');
    expect(text).toContain('header = "content-type: text/plain; charset=utf-8"\n');
    expect(text).toContain('header = "x-title: Ares"\n');
    expect(text).not.toContain(TOKEN);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(curlFiles(h.home)).toEqual(['webhook.curl']);

    // A config.yaml that does not load keeps the configuration in use, and the file.
    writeFile(configFile, 'notify: [\n');
    expect(h.master.configWatcher.reload()).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(text);

    // Without a webhook there is nothing for the scripts to send to.
    writeFile(configFile, 'language: zh\n');
    expect(h.master.configWatcher.reload()).toBe(true);
    expect(curlFiles(h.home)).toEqual([]);

    // A Master that starts with one writes it again; one that starts without deletes it.
    const { home } = h;
    await h.close();
    writeFile(configFile, webhookYaml(hook.url));
    h = await harness({ home });
    expect(curlFiles(home)).toEqual(['webhook.curl']);
    await h.close();
    // Closing leaves it: the scripts need it while no Master runs.
    expect(curlFiles(home)).toEqual(['webhook.curl']);
    writeFile(configFile, 'language: zh\n');
    h = await harness({ home });
    expect(curlFiles(home)).toEqual([]);
  });

  it('makes all of it 0600, even a temporary file left over or a umask that takes more', () => {
    const home = tmpDir('ares1-curl-');
    const webhook = WebhookSchema.parse({ url: 'https://example.com/hook' });
    writeFileSync(`${webhookCurlFile(home)}.${process.pid}.tmp`, 'left over', { mode: 0o644 });
    const umask = process.umask(0o277);
    try {
      writeWebhookCurlFile(home, webhook);
    } finally {
      process.umask(umask);
    }
    expect(statSync(webhookCurlFile(home)).mode & 0o777).toBe(0o600);
    expect(curlFiles(home)).toEqual(['webhook.curl']);
    // Deleting one that is not there is no error.
    writeWebhookCurlFile(home, undefined);
    writeWebhookCurlFile(home, undefined);
    expect(curlFiles(home)).toEqual([]);
  });

  it('escapes values as curl reads them, so that curl sends what fetch would', async () => {
    expect(escapeCurlConfigValue('a"b\\c\td\ne\rf\vg 中文')).toBe(
      'a\\"b\\\\c\\td\\ne\\rf\\vg 中文',
    );
    const hook = await startHook();
    const webhook = WebhookSchema.parse({
      url: `${hook.url}/hook/[x]?q="a b"&r=c\\d`,
      headers: {
        'X-Quoted': 'say "hi" \\n C:\\path\tend',
        'Content-Type': 'text/markdown',
        'X-Empty': '',
      },
      format: 'text',
    });
    const config = webhookCurlConfig(webhook);
    expect(config.split('\n').slice(2)).toEqual([
      '# ares1-format: text',
      `url = "${hook.url}/hook/[x]?q=%22a%20b%22&r=c\\\\d"`,
      'request = "POST"',
      'globoff',
      'header = "content-type: text/markdown"',
      'header = "x-empty;"',
      'header = "x-quoted: say \\"hi\\" \\\\n C:\\\\path\\tend"',
      '',
    ]);

    // Read back by curl as scripts/webhook.sh calls it, the request is the one the Master sends.
    const home = tmpDir('ares1-curl-');
    writeWebhookCurlFile(home, webhook);
    await new Promise<void>((resolve, reject) =>
      execFile(
        'curl',
        ['-q', '-fsS', '--max-time', '10', '-K', webhookCurlFile(home), '-o', '/dev/null'].concat([
          '--data-binary',
          'hello',
        ]),
        (err) => (err ? reject(err) : resolve()),
      ),
    );
    const { url, headers } = new Request(webhook.url, {
      method: 'POST',
      headers: webhookRequest(
        webhook,
        { kind: 'scout', title: 't', body: 'b', runId: null, about: 'issues' },
        { ts: '', type: 'scout.failed' },
      ).headers,
    });
    expect(hook.received).toHaveLength(1);
    const [received] = hook.received;
    expect(received?.method).toBe('POST');
    expect(`${hook.url}${received?.url}`).toBe(url);
    expect(received?.body).toBe('hello');
    for (const [name, value] of headers) expect(received?.headers[name]).toBe(value);
    expect(received?.headers['x-quoted']).toBe('say "hi" \\n C:\\path\tend');
    expect(received?.headers['x-empty']).toBe('');
  });

  it('logs when it cannot write the file, without its contents, and goes on', () => {
    const logs: string[] = [];
    const home = join(tmpDir('ares1-curl-'), 'missing');
    const webhook = WebhookSchema.parse({
      url: `https://example.com/hook?auth=${TOKEN}`,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    saveWebhookCurlFile(home, webhook, (m) => logs.push(m));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^\[通知\] 无法更新保活和升级脚本用的 webhook 设置/);
    expect(logs[0]).not.toContain(TOKEN);
    setLang('en');
    saveWebhookCurlFile(home, webhook, (m) => logs.push(m));
    expect(logs[1]).toMatch(/^\[notify\] Could not update the webhook settings/);
    expect(logs[1]).not.toMatch(/[一-鿿]/);
  });
});
