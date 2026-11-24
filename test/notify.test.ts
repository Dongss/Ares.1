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
  noticeScript,
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

/** An execFile that fails every command with `err`. */
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

  it('tells how a system notification failed in English', async () => {
    setLang('en');
    const reason = async (err: Error) =>
      (await sendSystemNotice('Test', 'A thing', { platform: 'darwin', execFile: fail(err) }))
        ?.reason;
    expect(await reason(commandFailed('osascript', 'execution error', { code: 1 }))).toBe(
      'osascript exited with code 1: execution error',
    );
    expect(await reason(commandFailed('osascript', '', { killed: true }))).toBe(
      'osascript did not finish within 10 seconds',
    );
    expect(await reason(commandFailed('osascript', '', { signal: 'SIGKILL' }))).toBe(
      'osascript was ended by SIGKILL',
    );
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
      { file: 'osascript', args: ['-e', noticeScript('标题', '正文')], timeout: 10_000 },
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
      reason: 'osascript 退出码 1：0:5: execution error: 出错了 (-1728)',
    });
    expect(
      (await outcome(commandFailed('notify-send', '', { killed: true }), 'linux'))?.reason,
    ).toBe('notify-send 在 10 秒内没有结束');
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
    expect(outcome).toEqual({
      ok: false,
      file: 'notify-send',
      reason: 'notify-send 退出码 3：没有桌面会话',
    });
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
    // A failed Run, and a scout that failed the third time in a row (not the second).
    store.event(ok.id, 'run.status', { status: 'failed' });
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
