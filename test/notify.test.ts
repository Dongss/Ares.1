import { execFile } from 'node:child_process';
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
  systemNoticeSupported,
} from '../src/notify/system.js';
import { WEBHOOK_TIMEOUT_MS, WebhookNotifier, webhookRequest } from '../src/notify/webhook.js';
import type { EventRow } from '../src/store/types.js';
import { blockOnAgentError, type Harness, harness, type Script } from './helpers.js';

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

  it('logs a failing webhook once per address, without its token, and never throws', async () => {
    h = await harness();
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

      // Another address (the configuration was reloaded): its failure is logged again, once.
      url = `${dead}/hook?auth=${TOKEN}`;
      fail();
      fail();
      await notifier.idle();
      expect(logs).toHaveLength(2);
      expect(logs[1]).toContain('ECONNREFUSED');

      // Without a webhook, nothing is sent.
      url = undefined;
      fail();
      await notifier.idle();
      expect(failing.received).toHaveLength(3);
      for (const log of logs) {
        expect(log).not.toContain(TOKEN);
        expect(log).not.toContain('/hook');
      }
    } finally {
      notifier.stop();
    }
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
        '[通知] webhook 通知发送失败：0.05 秒内没有响应。之后的失败不再记录，改了 notify.webhook.url 后重新记录。',
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
      '[notify] Sending a webhook notification failed: HTTP 503 Service Unavailable. Later failures are not logged until notify.webhook.url changes.',
    ]);
    expect(logs[0]).not.toMatch(/[一-鿿]/);
  });
});
