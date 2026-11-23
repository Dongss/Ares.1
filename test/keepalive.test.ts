import { type ChildProcess, execFile, execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebhookSchema } from '../src/config/schema.js';
import { redactForGitHub } from '../src/github/redact.js';
import { runningFile } from '../src/master.js';
import { writeWebhookCurlFile } from '../src/notify/webhook.js';
import { type Harness, harness, tmpDir } from './helpers.js';

// scripts/keepalive.sh against a stand-in Master: an install directory whose dist/cli.js is a
// small HTTP server answering /api/health on config.yaml's port, run by the real node. Each start
// leaves a line in <home>/starts. osascript and notify-send are stand-ins that write what they
// would show into a file, so that no real notification shows up.

const script = join(process.cwd(), 'scripts', 'keepalive.sh');
const webhookScript = join(process.cwd(), 'scripts', 'webhook.sh');

/** The stand-in Master: FAKE_MASTER=crash makes it exit with code 3 before it listens. */
const FAKE_CLI = `
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const home = process.argv[process.argv.indexOf('--home') + 1];
fs.appendFileSync(
  path.join(home, 'starts'),
  JSON.stringify({ pid: process.pid, cwd: process.cwd(), path: process.env.PATH.split(':')[0] }) +
    '\\n',
);
if (process.env.FAKE_MASTER === 'crash') {
  console.error('boom');
  process.exit(3);
}
const config = fs.readFileSync(path.join(home, 'config.yaml'), 'utf8');
const port = Number(/^port:\\s*(\\d+)/m.exec(config)[1]);
http
  .createServer((req, res) => {
    res.writeHead(req.url === '/api/health' ? 200 : 404, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  })
  .listen(port, '127.0.0.1');
`;

const chinese = /[一-鿿]/;

/** Processes and servers to stop after each test, also after a failed assertion. */
const pids: number[] = [];
const children: ChildProcess[] = [];
const servers: Server[] = [];

/** Stops the Masters the script started. */
function stopStarted(): void {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

afterEach(async () => {
  stopStarted();
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** An HTTP server on `port` answering /api/health with `status`. */
async function serve(port: number, status: number): Promise<void> {
  const server = createServer((_req, res) => {
    res.writeHead(status);
    res.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
}

interface Setup {
  installDir: string;
  home: string;
  port: number;
  /** Where the notification stand-ins write what they would show. */
  notified: string;
  env: NodeJS.ProcessEnv;
}

async function setup(opts: { language?: string; config?: boolean } = {}): Promise<Setup> {
  const installDir = tmpDir('ares1-install-');
  mkdirSync(join(installDir, 'dist'));
  writeFileSync(join(installDir, 'package.json'), '{"type":"commonjs"}\n');
  writeFileSync(join(installDir, 'dist', 'cli.js'), FAKE_CLI);
  // Resolved, as the script makes the home absolute through `cd` and `pwd`.
  const home = realpathSync(tmpDir('ares1-home-'));
  const port = await freePort();
  if (opts.config !== false) {
    writeFileSync(
      join(home, 'config.yaml'),
      `# config\nlanguage: ${opts.language ?? 'zh'}   # language\nport: ${port}\n`,
    );
  }
  const bin = tmpDir('ares1-bin-');
  const notified = join(bin, 'notified');
  writeFileSync(join(bin, 'osascript'), `#!/bin/sh\necho "$2" >> '${notified}'\n`);
  writeFileSync(join(bin, 'notify-send'), `#!/bin/sh\necho "$4" >> '${notified}'\n`);
  chmodSync(join(bin, 'osascript'), 0o755);
  chmodSync(join(bin, 'notify-send'), 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  delete env.FAKE_MASTER;
  return { installDir, home, port, notified, env };
}

interface Outcome {
  code: number;
  stderr: string;
}

/** One call of the script: `<install dir> <home> [args...]`. */
function keepalive(s: Setup, args: string[] = ['', process.execPath], env: NodeJS.ProcessEnv = {}) {
  return new Promise<Outcome>((resolve) => {
    execFile(
      'bash',
      [script, s.installDir, s.home, ...args],
      { env: { ...s.env, ...env }, encoding: 'utf8' },
      (err, _stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
        resolve({ code, stderr });
      },
    );
  });
}

/** The Masters the script started, which the test stops afterwards. */
function starts(s: Setup): { pid: number; cwd: string; path: string }[] {
  const file = join(s.home, 'starts');
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  const started = lines.map(
    (line) => JSON.parse(line) as { pid: number; cwd: string; path: string },
  );
  for (const { pid } of started) if (!pids.includes(pid)) pids.push(pid);
  return started;
}

/** The lines of keepalive.log, without their time. */
function logLines(s: Setup): string[] {
  const file = join(s.home, 'keepalive.log');
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  for (const line of lines) expect(line).toMatch(/^\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\] /);
  return lines.map((line) => line.replace(/^\[[^\]]*\] /, ''));
}

function notifications(s: Setup): string[] {
  return existsSync(s.notified) ? readFileSync(s.notified, 'utf8').trim().split('\n') : [];
}

async function health(port: number): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/api/health`);
  return res.status;
}

/** A process whose command line looks like `what` followed by `args`, doing nothing. */
function standIn(...args: string[]): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...args], {
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}

describe('keepalive script', () => {
  it('parses, is executable, and braces every variable', () => {
    // webhook.sh too, which it sources.
    for (const file of [script, webhookScript]) {
      execFileSync('bash', ['-n', file]);
      const source = readFileSync(file, 'utf8');
      expect(source.match(/\$[A-Za-z_][A-Za-z0-9_]*/g) ?? []).toEqual([]);
    }
    // A timer may run it directly.
    expect(statSync(script).mode & 0o111).toBe(0o111);
  });

  it('starts nothing while the Master answers', async () => {
    const s = await setup();
    await serve(s.port, 200);
    expect(await keepalive(s)).toEqual({ code: 0, stderr: '' });
    expect(starts(s)).toEqual([]);
    // A Master that answers leaves no line: calls every minute do not grow the log.
    expect(existsSync(join(s.home, 'keepalive.log'))).toBe(false);
    expect(existsSync(join(s.home, 'keepalive.lock'))).toBe(false);
  });

  it('starts the Master when it is not running, logs it, and then it answers', async () => {
    const s = await setup();
    expect(await keepalive(s)).toEqual({ code: 0, stderr: '' });
    const started = starts(s);
    expect(started).toHaveLength(1);
    // In the install directory, with the given node's directory first in PATH.
    expect(realpathSync(started[0]?.cwd ?? '')).toBe(realpathSync(s.installDir));
    expect(started[0]?.path).toBe(dirname(process.execPath));
    expect(await health(s.port)).toBe(200);
    const lines = logLines(s);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`Master 没有在运行，已启动（pid ${started[0]?.pid}`);
    expect(existsSync(join(s.home, 'keepalive.lock'))).toBe(false);
    expect(notifications(s)).toEqual([]);

    // The next call finds it answering.
    expect(await keepalive(s)).toEqual({ code: 0, stderr: '' });
    expect(starts(s)).toHaveLength(1);
    expect(logLines(s)).toHaveLength(1);
  });

  it('uses the port given, in English when config.yaml says so', async () => {
    const s = await setup({ config: false });
    const port = await freePort();
    writeFileSync(join(s.home, 'config.yaml'), `language: "en"\nport: ${port}\n`);
    // config.yaml's port is not read when one is given: the Master listens on the given one here.
    expect(await keepalive(s, [String(port), process.execPath])).toEqual({ code: 0, stderr: '' });
    expect(starts(s)).toHaveLength(1);
    expect(await health(port)).toBe(200);
    const [line] = logLines(s);
    expect(line).toContain('The Master was not running; started it');
    expect(line).not.toMatch(chinese);
  });

  it('does not start the Master while an upgrade of the same home runs', async () => {
    const s = await setup();
    // As the Master starts its copy of the script: bash <home>/data/self-upgrade.sh <dir> <home> …
    const other = realpathSync(tmpDir('ares1-home-'));
    standIn(join(other, 'data', 'self-upgrade.sh'), s.installDir, other, '123');
    // An upgrade of another home does not count.
    expect(await keepalive(s)).toMatchObject({ code: 0 });
    expect(starts(s)).toHaveLength(1);
    stopStarted();

    const t = await setup();
    standIn(join(t.home, 'data', 'self-upgrade.sh'), t.installDir, t.home, '123', 'abc');
    expect(await keepalive(t)).toEqual({ code: 0, stderr: '' });
    expect(starts(t)).toEqual([]);
    expect(logLines(t)).toEqual([]);
  });

  it('starts one Master when called twice at once, or once more after that', async () => {
    const s = await setup();
    const outcomes = await Promise.all([keepalive(s), keepalive(s)]);
    expect(outcomes).toEqual([
      { code: 0, stderr: '' },
      { code: 0, stderr: '' },
    ]);
    expect(await keepalive(s)).toEqual({ code: 0, stderr: '' });
    expect(starts(s)).toHaveLength(1);
    expect(logLines(s)).toHaveLength(1);
    expect(await health(s.port)).toBe(200);
  });

  it('leaves a Master that runs without answering alone, and only logs it', async () => {
    const s = await setup();
    const hung = standIn('dist/cli.js', '--home', s.home);
    expect(await keepalive(s)).toEqual({ code: 0, stderr: '' });
    expect(starts(s)).toEqual([]);
    expect(hung.exitCode).toBeNull();
    expect(hung.signalCode).toBeNull();
    expect(logLines(s)).toEqual([
      `Master（pid ${hung.pid}）在运行，但 http://127.0.0.1:${s.port}/api/health 没有响应（卡住了，或者还在启动），不强行结束它`,
    ]);
    expect(notifications(s)).toEqual([]);
  });

  it('does not take a Master of a home whose path only begins the same for this one', async () => {
    const s = await setup();
    standIn('dist/cli.js', '--home', `${s.home}-other`);
    expect(await keepalive(s)).toMatchObject({ code: 0 });
    expect(starts(s)).toHaveLength(1);
  });

  it('starts nothing while another call holds the lock, unless the lock is left over', async () => {
    const s = await setup();
    const lock = join(s.home, 'keepalive.lock');
    mkdirSync(lock);
    expect(await keepalive(s)).toEqual({ code: 0, stderr: '' });
    expect(starts(s)).toEqual([]);
    expect(existsSync(lock)).toBe(true);

    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, tenMinutesAgo, tenMinutesAgo);
    expect(await keepalive(s)).toEqual({ code: 0, stderr: '' });
    expect(starts(s)).toHaveLength(1);
    expect(existsSync(lock)).toBe(false);
  });

  it('only logs and notifies when another process answers on the port, once per outage', async () => {
    const s = await setup({ language: 'en' });
    await serve(s.port, 404);
    expect(await keepalive(s, ['', process.execPath, 'Ares.1'])).toEqual({ code: 0, stderr: '' });
    expect(await keepalive(s, ['', process.execPath, 'Ares.1'])).toEqual({ code: 0, stderr: '' });
    expect(starts(s)).toEqual([]);
    const taken = `Port ${s.port} is taken by another process (http://127.0.0.1:${s.port}/api/health does not answer as a Master does); not starting the Master`;
    expect(logLines(s)).toEqual([taken, taken]);
    const notes = notifications(s);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`the keepalive script could not start it: ${taken}`);
    expect(notes[0]).toContain('with title "Ares.1"');
    expect(notes[0]).not.toMatch(chinese);
  });

  it('notifies when the Master it started exits, once until it answers again', async () => {
    const s = await setup();
    const crash = { FAKE_MASTER: 'crash' };
    expect(await keepalive(s, undefined, crash)).toMatchObject({ code: 1 });
    expect(await keepalive(s, undefined, crash)).toMatchObject({ code: 1 });
    const crashed = starts(s);
    expect(crashed).toHaveLength(2);
    expect(logLines(s)).toEqual(
      crashed.map(
        ({ pid }) =>
          `启动的 Master（pid ${pid}）退出了（退出码 3），输出见 ${join(s.home, 'master.out')}`,
      ),
    );
    expect(readFileSync(join(s.home, 'master.out'), 'utf8')).toContain('boom');
    expect(notifications(s)).toHaveLength(1);
    expect(notifications(s)[0]).toContain('Master 停了，保活脚本没能把它启动起来');

    // Once it answers again, the next outage is notified again.
    expect(await keepalive(s)).toEqual({ code: 0, stderr: '' });
    expect(existsSync(join(s.home, 'keepalive.notified'))).toBe(false);
    starts(s);
    stopStarted();
    await waitClosed(s.port);
    expect(await keepalive(s, undefined, crash)).toMatchObject({ code: 1 });
    expect(notifications(s)).toHaveLength(2);
  });

  it('starts the Master with another node when the one given is gone, and logs it', async () => {
    const s = await setup({ language: 'en' });
    // What a version manager leaves behind after uninstalling the version.
    const gone = join(tmpDir('ares1-nvm-'), 'v24.22.1', 'bin', 'node');
    expect(await keepalive(s, ['', gone])).toEqual({ code: 0, stderr: '' });
    const started = starts(s);
    expect(started).toHaveLength(1);
    expect(await health(s.port)).toBe(200);
    // The node in PATH, whose directory went first in PATH.
    const node = execFileSync('bash', ['-c', 'command -v node'], {
      env: s.env,
      encoding: 'utf8',
    }).trim();
    expect(started[0]?.path).toBe(dirname(node));
    const version = execFileSync(node, ['--version'], { encoding: 'utf8' }).trim();
    const lines = logLines(s);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      `node ${gone} cannot be used (missing, not executable or not the version needed); using ${node} (${version}) instead`,
    );
    expect(lines[1]).toContain('The Master was not running; started it');
    expect(notifications(s)).toEqual([]);
  });

  it('notifies when no node it can use is found', async () => {
    const s = await setup();
    writeFileSync(join(s.installDir, 'package.json'), '{"engines": {"node": ">=999"}}\n');
    const gone = join(tmpDir('ares1-nvm-'), 'gone', 'node');
    expect(await keepalive(s, ['', gone])).toMatchObject({ code: 1 });
    expect(starts(s)).toEqual([]);
    expect(logLines(s)).toEqual([
      `找不到能用的 node（${gone}；PATH、nvm 的默认版本和常见的安装位置里也没有满足 >=999 的可用的 node）`,
    ]);
    expect(notifications(s)).toHaveLength(1);
  });

  it('gives up without starting anything when the install directory is missing', async () => {
    const s = await setup();
    s.installDir = join(s.installDir, 'missing');
    expect(await keepalive(s)).toMatchObject({ code: 1 });
    expect(starts(s)).toEqual([]);
    expect(logLines(s)).toEqual([`找不到安装目录 ${s.installDir}`]);
    expect(notifications(s)).toHaveLength(1);
  });

  it('explains its arguments when they are missing', async () => {
    const outcome = await new Promise<Outcome>((resolve) => {
      execFile('bash', [script], { encoding: 'utf8' }, (err, _stdout, stderr) =>
        resolve({ code: typeof err?.code === 'number' ? err.code : 0, stderr }),
      );
    });
    expect(outcome.code).toBe(2);
    expect(outcome.stderr).toContain('用法：keepalive.sh <安装目录> <数据目录>');
    expect(outcome.stderr).toContain('Usage: keepalive.sh <install dir> <home>');
  });
});

interface Received {
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A webhook receiver on 127.0.0.1 and a random port, answering every request with `status`. */
async function hookServer(status = 200) {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body });
      res.writeHead(status);
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { received, url: `http://127.0.0.1:${port}` };
}

/** The token the tests put in the webhook's address and headers: never to be logged. */
const TOKEN = 'tk_secret_token';

/** Leaves the settings of a webhook at `url` in the home, as a Master that ran with it does. */
function leaveWebhook(s: Setup, url: string, format: 'json' | 'text' = 'json'): void {
  writeWebhookCurlFile(
    s.home,
    WebhookSchema.parse({
      url: `${url}/hook?auth=${TOKEN}`,
      headers: { Authorization: `Bearer ${TOKEN}` },
      format,
    }),
  );
}

/** What the script sends when it gives up on the missing install directory of `s`. */
const missingDirMessage = (s: Setup) =>
  `Master 停了，保活脚本没能把它启动起来：找不到安装目录 ${s.installDir}（日志：~/keepalive.log）`;

/** Runs `code` in bash after sourcing webhook.sh, with `args` as $1...; resolves with stdout. */
function sourced(code: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'bash',
      ['-c', `. "$WEBHOOK_SH"\n${code}`, 'bash', ...args],
      { env: { ...process.env, WEBHOOK_SH: webhookScript, ...env }, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

describe('keepalive script and the webhook', () => {
  it('also POSTs to the webhook the last Master left, once per outage, with ~ for the home directory', async () => {
    const s = await setup();
    const hook = await hookServer();
    leaveWebhook(s, hook.url);
    s.installDir = join(s.installDir, 'missing');
    // The data directory is the user's home directory here, so the log is under it.
    const env = { HOME: s.home };
    const args = ['', process.execPath, 'Ares.1'];
    expect(await keepalive(s, args, env)).toEqual({ code: 1, stderr: '' });
    expect(hook.received).toHaveLength(1);
    const [request] = hook.received;
    expect(request?.url).toBe(`/hook?auth=${TOKEN}`);
    expect(request?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request?.headers['content-type']).toBe('application/json');
    const body = missingDirMessage(s);
    expect(JSON.parse(request?.body ?? '')).toEqual({
      kind: 'master_down',
      title: 'Ares.1',
      body,
      text: `Ares.1\n${body}`,
      runId: null,
      about: 'master',
      eventType: 'keepalive.alert',
      at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
    });
    expect(request?.body).not.toContain(s.home);
    // The system notification stays on this machine, with the whole path.
    expect(notifications(s)).toHaveLength(1);
    expect(notifications(s)[0]).toContain(join(s.home, 'keepalive.log'));
    expect(logLines(s)).toEqual([`找不到安装目录 ${s.installDir}`]);

    // The same outage: logged again, not sent again.
    expect(await keepalive(s, args, env)).toEqual({ code: 1, stderr: '' });
    expect(hook.received).toHaveLength(1);
    expect(notifications(s)).toHaveLength(1);
    expect(logLines(s)).toHaveLength(2);
  });

  it('sends the title and the message as plain text with format: text', async () => {
    const s = await setup();
    const hook = await hookServer();
    leaveWebhook(s, hook.url, 'text');
    s.installDir = join(s.installDir, 'missing');
    expect(await keepalive(s, ['', process.execPath, 'Ares.1'], { HOME: s.home })).toEqual({
      code: 1,
      stderr: '',
    });
    expect(hook.received).toHaveLength(1);
    expect(hook.received[0]?.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(hook.received[0]?.body).toBe(`Ares.1\n${missingDirMessage(s)}`);
  });

  it('sends nothing when no Master left webhook settings, and goes on as before', async () => {
    const s = await setup();
    const hook = await hookServer();
    s.installDir = join(s.installDir, 'missing');
    expect(await keepalive(s)).toEqual({ code: 1, stderr: '' });
    expect(hook.received).toEqual([]);
    expect(logLines(s)).toEqual([`找不到安装目录 ${s.installDir}`]);
    expect(notifications(s)).toHaveLength(1);
  });

  it('logs a webhook that fails without its address, and exits as before', async () => {
    const s = await setup({ language: 'en' });
    const port = await freePort();
    leaveWebhook(s, `http://127.0.0.1:${port}`);
    s.installDir = join(s.installDir, 'missing');
    expect(await keepalive(s)).toEqual({ code: 1, stderr: '' });
    expect(logLines(s)).toEqual([
      `Install directory ${s.installDir} not found`,
      // Nothing listens: curl could not connect.
      'Sending the webhook notification failed (curl exit code 7); not retrying',
    ]);
    const log = readFileSync(join(s.home, 'keepalive.log'), 'utf8');
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain(`127.0.0.1:${port}`);
    expect(log).not.toMatch(chinese);
    expect(notifications(s)).toHaveLength(1);

    // A webhook that answers with an error fails too (curl -f).
    const t = await setup({ language: 'en' });
    const hook = await hookServer(500);
    leaveWebhook(t, hook.url);
    t.installDir = join(t.installDir, 'missing');
    expect(await keepalive(t)).toEqual({ code: 1, stderr: '' });
    expect(hook.received).toHaveLength(1);
    expect(logLines(t)[1]).toBe(
      'Sending the webhook notification failed (curl exit code 22); not retrying',
    );
  });

  it('keeps the JSON valid whatever the message and the title hold', async () => {
    const hook = await startHookIn();
    const home = '/home/someone';
    const message = `say "hi" \\ C:\\path\\to {"json": true}\nnext line\ttab\r\u0001\u001f end 中文 ${home}/x`;
    const name = 'Ares "1" \\ x';
    await sourced('webhook "$1" "$2"', [message, 'test.event'], {
      HOME: home,
      home: hook.home,
      name,
    });
    expect(hook.received).toHaveLength(1);
    const payload = JSON.parse(hook.received[0]?.body ?? '');
    const body = message.replace(`${home}/x`, '~/x');
    expect(payload).toMatchObject({
      kind: 'master_down',
      title: name,
      body,
      text: `${name}\n${body}`,
      eventType: 'test.event',
    });
  });

  it('puts ~ only where a path starts with the home directory, as the Master does', async () => {
    const tilde = (text: string, home: string) =>
      sourced('webhook_tilde "$1"; printf %s "$tilded"', [text], { HOME: home });
    const texts = [
      'x /home/me/a y',
      '/home/me',
      '（日志：/home/me/.ares1/keepalive.log）',
      '/mnt/home/me/b, /home/me2/c, /home/me.bak/d and x/home/me',
      '(/home/me) /home/me. a:/home/me/e /home/me//f',
      'no home here',
    ];
    for (const text of texts) {
      expect(await tilde(text, '/home/me')).toBe(redactForGitHub(text, '/home/me'));
      // A trailing slash makes no difference.
      expect(await tilde(text, '/home/me/')).toBe(redactForGitHub(text, '/home/me'));
    }
    // A home directory with characters special to patterns is plain text.
    const odd = '/tmp/a*b[c]';
    const text = `${odd}/x /tmp/aXbc/y ${odd}`;
    expect(await tilde(text, odd)).toBe('~/x /tmp/aXbc/y ~');
    expect(await tilde(text, odd)).toBe(redactForGitHub(text, odd));
    // Nothing to hide without a home directory, or with / as one.
    expect(await tilde('/home/me/x', '')).toBe('/home/me/x');
    expect(await tilde('/home/me/x', '/')).toBe('/home/me/x');
  });
});

/** A webhook receiver and a data directory whose webhook.curl leads to it. */
async function startHookIn() {
  const hook = await hookServer();
  const home = tmpDir('ares1-home-');
  writeWebhookCurlFile(home, WebhookSchema.parse({ url: `${hook.url}/hook` }));
  return { ...hook, home };
}

describe('Master started after one that did not close', () => {
  let h: Harness | undefined;

  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  const restarted = (t: Harness) =>
    (
      t.master.store.db
        .prepare("SELECT data FROM events WHERE type = 'master.restarted'")
        .all() as { data: string }[]
    ).map((e) => JSON.parse(e.data) as unknown);

  it('records master.restarted with when the last one started', async () => {
    h = await harness();
    const { home } = h;
    const file = runningFile(h.master.paths);
    const mark = JSON.parse(readFileSync(file, 'utf8')) as { pid: number; startedAt: string };
    expect(mark.pid).toBe(process.pid);
    expect(restarted(h)).toEqual([]);

    // Closed as on SIGTERM or before an upgrade: the next one starts as usual.
    await h.close();
    expect(existsSync(file)).toBe(false);
    h = await harness({ home });
    expect(restarted(h)).toEqual([]);

    // What a Master killed with kill -9 leaves behind.
    const crashed = { pid: 4242, startedAt: '2026-11-20T08:00:00.000Z', token: 'master-x' };
    await h.close();
    writeFileSync(file, JSON.stringify(crashed));
    h = await harness({ home });
    expect(restarted(h)).toEqual([{ pid: 4242, startedAt: '2026-11-20T08:00:00.000Z' }]);
    // Its own mark replaced the old one, and goes when it closes.
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ pid: process.pid });
    await h.close();
    expect(existsSync(file)).toBe(false);
    h = undefined;
  });

  it('does not remove the mark of another Master that started on the home since', async () => {
    h = await harness();
    const file = runningFile(h.master.paths);
    writeFileSync(file, JSON.stringify({ pid: 1, startedAt: '2026-11-20T08:00:00.000Z' }));
    await h.close();
    h = undefined;
    expect(existsSync(file)).toBe(true);
  });
});

/** Waits until nothing listens on `port` any more. */
async function waitClosed(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`port ${port} still answers`);
}
