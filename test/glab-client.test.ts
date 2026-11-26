import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GlabCli, GlabError } from '../src/gitlab/client.js';
import { setLang } from '../src/i18n.js';
import { git, tmpDir, writeFile } from './helpers.js';

// A stand-in `glab` that records every call (arguments, stdin, working directory and the GitLab
// variables of its environment) in calls.jsonl next to it and answers from responses.json: the
// first response that matches, removed once used unless it has `keep`. A response with `path`
// matches a `glab api` call of that API path and method (GET unless `method` says otherwise),
// wherever the flags around it are; one with `when` matches the calls whose arguments start so.
const FAKE_GLAB = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const file = path.join(__dirname, 'responses.json');
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? null : (args[i + 1] ?? null);
};
const answer = (stdin) => {
  const call = {
    args,
    stdin,
    cwd: process.cwd(),
    token: process.env.GITLAB_TOKEN ?? null,
    host: process.env.GITLAB_HOST ?? null,
  };
  fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(call) + '\\n');
  const responses = JSON.parse(fs.readFileSync(file, 'utf8'));
  const api = args[0] === 'api' ? { path: args[1], method: flag('-X') ?? 'GET' } : null;
  const i = responses.findIndex((r) =>
    r.path !== undefined
      ? api !== null && api.path === r.path && api.method === (r.method ?? 'GET')
      : r.when.every((a, k) => args[k] === a),
  );
  if (i < 0) {
    process.stderr.write('fake glab: no response for ' + args.join(' '));
    process.exitCode = 99;
    return;
  }
  const r = responses[i];
  if (!r.keep) {
    responses.splice(i, 1);
    fs.writeFileSync(file, JSON.stringify(responses));
  }
  process.stdout.write(r.stdout ?? '');
  process.stderr.write(r.stderr ?? '');
  process.exitCode = r.code ?? 0;
};
// Like glab, read stdin only when the request body comes from it.
if (flag('--input') === '-') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => answer(input));
} else {
  answer(null);
}
`;

interface Reply {
  /** The API path of a `glab api` call. */
  path?: string;
  /** Its method; GET when not given. */
  method?: string;
  /** The arguments of another call start so. */
  when?: string[];
  stdout?: string;
  stderr?: string;
  code?: number;
  /** Answer every matching call, not only the first. */
  keep?: boolean;
}

interface GlabCall {
  args: string[];
  stdin: string | null;
  cwd: string;
  token: string | null;
  host: string | null;
}

function fakeGlab(replies: Reply[]) {
  const dir = tmpDir('ares1-glab-');
  const bin = join(dir, 'glab');
  writeFile(bin, FAKE_GLAB);
  chmodSync(bin, 0o755);
  writeFile(join(dir, 'responses.json'), JSON.stringify(replies));
  const log = join(dir, 'calls.jsonl');
  return {
    bin,
    calls: (): GlabCall[] =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as GlabCall)
        : [],
  };
}

/** A GET of `path` answered with `data` as JSON. */
function get(path: string, data: unknown, more: Partial<Reply> = {}): Reply {
  return { path, stdout: JSON.stringify(data), ...more };
}

/** The arguments `glab api` gets for a request, as GlabCli builds them. */
function apiArgs(
  method: string,
  path: string,
  opts: { host?: string; body?: boolean } = {},
): string[] {
  const args = ['api', path, '-X', method];
  if (opts.host) args.push('--hostname', opts.host);
  if (opts.body) args.push('-H', 'Content-Type: application/json', '--input', '-');
  return args;
}

/** The JSON body a call sent through stdin. */
function body(call: GlabCall | undefined): unknown {
  return JSON.parse(call?.stdin ?? '');
}

/** The GlabError a promise rejects with. */
async function glabError(promise: Promise<unknown>): Promise<GlabError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GlabError);
  return err as GlabError;
}

/** A git repo whose origin is `url`, with nothing committed. */
function cloneWithOrigin(url: string): string {
  const dir = emptyClone();
  git(dir, 'remote', 'add', 'origin', url);
  return dir;
}

/** A git repo with no remote and nothing committed. */
function emptyClone(): string {
  const dir = tmpDir('ares1-clone-');
  git(dir, 'init', '-q', '-b', 'main');
  return dir;
}

const PROJECT = 'projects/acme%2Fwidgets';
const NESTED = 'acme/platform/tools/widgets';
const NESTED_PROJECT = 'projects/acme%2Fplatform%2Ftools%2Fwidgets';

const CJK = /[一-鿿]/;

// Environment variables a test changed, with their values before; restored after each test.
const savedEnv = new Map<string, string | undefined>();
function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  // GitLab settings of whoever runs the tests would show up in the calls.
  setEnv('GITLAB_TOKEN', undefined);
  setEnv('GITLAB_HOST', undefined);
  // Nor may their git config rewrite the remotes the tests read (url.<base>.insteadOf).
  const empty = join(tmpDir('ares1-gitconfig-'), 'config');
  writeFile(empty, '');
  setEnv('GIT_CONFIG_GLOBAL', empty);
  setEnv('GIT_CONFIG_NOSYSTEM', '1');
});

afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
  setLang('zh');
});

describe('GlabCli projects and hosts', () => {
  it('encodes a project of nested groups as one segment and sends it to the given host', async () => {
    const glab = fakeGlab([get(`${NESTED_PROJECT}/issues/7`, { labels: ['ares1:ready'] })]);
    const cli = new GlabCli(glab.bin, { host: 'gitlab.example.com' });
    expect(await cli.getLabels(NESTED, 7)).toEqual(['ares1:ready']);
    expect(glab.calls()).toMatchObject([
      {
        args: apiArgs('GET', `${NESTED_PROJECT}/issues/7`, { host: 'gitlab.example.com' }),
        stdin: null,
        // The host goes in the arguments, not through glab's environment.
        host: null,
        token: null,
      },
    ]);
  });

  it('leaves the host to glab when none is given', async () => {
    const glab = fakeGlab([
      get(`${PROJECT}/issues/7`, { labels: [] }),
      { path: `${PROJECT}/issues/7/notes`, method: 'POST' },
    ]);
    const cli = new GlabCli(glab.bin, { host: '' });
    expect(await cli.getLabels('acme/widgets', 7)).toEqual([]);
    await cli.comment('acme/widgets', 7, 'hi');
    expect(glab.calls().map((c) => c.args)).toEqual([
      apiArgs('GET', `${PROJECT}/issues/7`),
      apiArgs('POST', `${PROJECT}/issues/7/notes`, { body: true }),
    ]);
  });

  it('rejects project paths that are no group/name before calling glab', async () => {
    const glab = fakeGlab([]);
    const cli = new GlabCli(glab.bin);
    for (const repo of ['widgets', '', 'acme/', '/widgets', 'acme//widgets', 'acme/widgets/']) {
      expect((await glabError(cli.getLabels(repo, 1))).message).toBe(
        `GitLab 项目路径应为 group/name 或 group/subgroup/name：${repo}`,
      );
      await glabError(cli.setLabels(repo, 1, []));
      await glabError(cli.comment(repo, 1, 'x'));
      await glabError(cli.createIssue(repo, { title: 't', body: 'b', labels: [] }));
      await glabError(cli.editIssue(repo, 1, { body: 'b' }));
      await glabError(
        cli.ensureLabels(repo, [{ name: 'ares1:ready', color: '0e8a16', description: '' }]),
      );
    }
    expect(glab.calls()).toEqual([]);
  });
});

describe('GlabCli resolveRepo', () => {
  it("reads the project's path from origin's https, ssh and scp-like URLs", async () => {
    const remotes: [url: string, project: string][] = [
      ['https://gitlab.com/acme/widgets.git', 'acme/widgets'],
      ['https://gitlab.com/acme/widgets', 'acme/widgets'],
      ['https://gitlab.com/acme/widgets/', 'acme/widgets'],
      ['https://gitlab.com/acme/widgets.git/', 'acme/widgets'],
      ['http://gitlab.internal/acme/widgets.git', 'acme/widgets'],
      [
        'https://oauth2:secret@gitlab.example.com:8443/acme/platform/widgets.git',
        'acme/platform/widgets',
      ],
      ['https://me@gitlab.example.com/acme/platform/tools/widgets', NESTED],
      ['git@gitlab.com:acme/platform/tools/widgets.git', NESTED],
      ['git@gitlab.com:acme/widgets', 'acme/widgets'],
      // A host alias of ~/.ssh/config: the client's host setting decides where calls go.
      ['gitlab-work:acme/widgets.git', 'acme/widgets'],
      ['ssh://git@gitlab.example.com:2222/acme/platform/widgets.git', 'acme/platform/widgets'],
      ['ssh://gitlab-alias/acme/widgets.git/', 'acme/widgets'],
      ['git+ssh://git@gitlab.example.com/acme/widgets.git', 'acme/widgets'],
    ];
    const glab = fakeGlab([]);
    const cli = new GlabCli(glab.bin, { host: 'gitlab.example.com' });
    for (const [url, project] of remotes) {
      expect(await cli.resolveRepo(cloneWithOrigin(url)), url).toBe(project);
    }
    // Only git is asked: glab and GitLab have no part in it.
    expect(glab.calls()).toEqual([]);
  });

  it('fails on remotes that name no project, without showing their credentials', async () => {
    const cli = new GlabCli(fakeGlab([]).bin);
    const remotes = [
      '/srv/git/acme/widgets.git',
      'file:///srv/git/acme/widgets.git',
      'https://gitlab.com/widgets.git',
      'git@gitlab.com:widgets.git',
      'https://gitlab.com/',
    ];
    for (const url of remotes) {
      expect((await glabError(cli.resolveRepo(cloneWithOrigin(url)))).message).toBe(
        `从 origin 的地址读不出 GitLab 项目路径：${url}`,
      );
    }
    const secret = await glabError(
      cli.resolveRepo(cloneWithOrigin('https://oauth2:glpat-secret@gitlab.com/widgets.git')),
    );
    expect(secret.message).toBe(
      '从 origin 的地址读不出 GitLab 项目路径：https://gitlab.com/widgets.git',
    );
  });

  it('fails when the clone has no origin', async () => {
    const dir = emptyClone();
    const err = await glabError(new GlabCli(fakeGlab([]).bin).resolveRepo(dir));
    expect(err.message.startsWith(`读取 ${dir} 的 origin 地址失败：`)).toBe(true);
    expect(err.message.length).toBeGreaterThan(`读取 ${dir} 的 origin 地址失败：`.length);
  });
});

describe('GlabCli viewer', () => {
  it('returns the login glab acts as', async () => {
    const glab = fakeGlab([
      get('user', { id: 1, username: 'alice', name: 'Alice', state: 'active' }),
    ]);
    expect(await new GlabCli(glab.bin, { host: 'gitlab.example.com' }).viewer()).toBe('alice');
    expect(glab.calls().map((c) => c.args)).toEqual([
      apiArgs('GET', 'user', { host: 'gitlab.example.com' }),
    ]);
  });

  it('checks it is the account asked for, whatever the case', async () => {
    const glab = fakeGlab([get('user', { username: 'ares1-bot' }, { keep: true })]);
    expect(await new GlabCli(glab.bin, { account: 'Ares1-Bot' }).viewer()).toBe('ares1-bot');
    const err = await glabError(new GlabCli(glab.bin, { account: 'alice' }).viewer());
    expect(err.message).toBe('glab 登录的账号是 ares1-bot，不是配置的 alice');
  });
});

/** A label as GitLab lists it. */
function rawLabel(id: number, name: string, fields: Record<string, unknown> = {}) {
  return {
    id,
    name,
    color: '#0e8a16',
    text_color: '#FFFFFF',
    description: null,
    is_project_label: true,
    subscribed: false,
    ...fields,
  };
}

const LABELS_PAGE_1 = `${PROJECT}/labels?per_page=100&page=1`;
const LABELS_PAGE_2 = `${PROJECT}/labels?per_page=100&page=2`;

describe('GlabCli labels', () => {
  it('ensureLabels creates the missing labels and updates the ones that differ', async () => {
    const glab = fakeGlab([
      get(LABELS_PAGE_1, [
        // Same color in another case, same description: left as it is.
        rawLabel(1, 'ares1:ready', { color: '#0E8A16', description: 'Ready' }),
        // Another color.
        rawLabel(2, 'ares1:running', { color: '#ffffff', description: 'Running' }),
        // Another description.
        rawLabel(3, 'ares1:failed', { color: '#b60205', description: 'Old' }),
        // No description is an empty one.
        rawLabel(4, 'ares1:auto', { color: '#ededed' }),
        // A group's label differs, but the project cannot change it.
        rawLabel(5, 'ares1:proposal', { color: '#000000', is_project_label: false }),
        rawLabel(6, 'bug', { color: '#d73a4a' }),
      ]),
      { path: `${PROJECT}/labels/2`, method: 'PUT', stdout: '{}' },
      { path: `${PROJECT}/labels/3`, method: 'PUT', stdout: '{}' },
      { path: `${PROJECT}/labels`, method: 'POST', stdout: '{}' },
    ]);
    const cli = new GlabCli(glab.bin);
    await cli.ensureLabels('acme/widgets', [
      { name: 'ares1:ready', color: '0e8a16', description: 'Ready' },
      { name: 'ares1:running', color: 'fbca04', description: 'Running' },
      { name: 'ares1:failed', color: 'b60205', description: 'Failed' },
      { name: 'ares1:auto', color: 'ededed', description: '' },
      { name: 'ares1:proposal', color: 'c5def5', description: 'Proposed' },
      { name: 'ares1:needs-you', color: 'd93f0b', description: 'Needs you' },
    ]);
    // No labels to ensure: GitLab is not asked.
    await cli.ensureLabels('acme/widgets', []);

    const calls = glab.calls();
    expect(calls.map((c) => c.args)).toEqual([
      apiArgs('GET', LABELS_PAGE_1),
      apiArgs('PUT', `${PROJECT}/labels/2`, { body: true }),
      apiArgs('PUT', `${PROJECT}/labels/3`, { body: true }),
      apiArgs('POST', `${PROJECT}/labels`, { body: true }),
    ]);
    expect(calls.slice(1).map(body)).toEqual([
      { color: '#fbca04', description: 'Running' },
      { color: '#b60205', description: 'Failed' },
      { name: 'ares1:needs-you', color: '#d93f0b', description: 'Needs you' },
    ]);
  });

  it('ensureLabels reads every page of labels before creating any', async () => {
    const full = Array.from({ length: 100 }, (_, i) => rawLabel(100 + i, `label-${i}`));
    const glab = fakeGlab([
      get(LABELS_PAGE_1, full),
      get(LABELS_PAGE_2, [rawLabel(7, 'ares1:ready', { description: 'Ready' })]),
      { path: `${PROJECT}/labels`, method: 'POST', stdout: '{}' },
    ]);
    await new GlabCli(glab.bin).ensureLabels('acme/widgets', [
      { name: 'ares1:ready', color: '0e8a16', description: 'Ready' },
      { name: 'label-5', color: '0e8a16', description: '' },
      { name: 'ares1:failed', color: 'b60205', description: 'Failed' },
    ]);
    const calls = glab.calls();
    expect(calls.map((c) => c.args)).toEqual([
      apiArgs('GET', LABELS_PAGE_1),
      apiArgs('GET', LABELS_PAGE_2),
      apiArgs('POST', `${PROJECT}/labels`, { body: true }),
    ]);
    expect(body(calls[2])).toEqual({
      name: 'ares1:failed',
      color: '#b60205',
      description: 'Failed',
    });
  });

  it('getLabels reads the labels of the issue', async () => {
    const glab = fakeGlab([
      get(`${PROJECT}/issues/7`, { iid: 7, title: 'x', labels: ['ares1:ready', 'bug'] }),
    ]);
    expect(await new GlabCli(glab.bin).getLabels('acme/widgets', 7)).toEqual([
      'ares1:ready',
      'bug',
    ]);
  });

  it('setLabels replaces the labels of the issue, an empty list removing them all', async () => {
    const glab = fakeGlab([
      { path: `${PROJECT}/issues/7`, method: 'PUT', stdout: '{}', keep: true },
    ]);
    const cli = new GlabCli(glab.bin);
    await cli.setLabels('acme/widgets', 7, ['ares1:running', 'bug']);
    await cli.setLabels('acme/widgets', 7, []);
    const calls = glab.calls();
    expect(calls.map((c) => c.args)).toEqual([
      apiArgs('PUT', `${PROJECT}/issues/7`, { body: true }),
      apiArgs('PUT', `${PROJECT}/issues/7`, { body: true }),
    ]);
    expect(calls.map(body)).toEqual([{ labels: 'ares1:running,bug' }, { labels: '' }]);
  });
});

describe('GlabCli issue writes', () => {
  const text = '## 为什么\n\nline with \'quotes\', "double quotes" and --flags\n';

  it('comment posts a note with the body as it is, through stdin', async () => {
    const glab = fakeGlab([{ path: `${PROJECT}/issues/7/notes`, method: 'POST', stdout: '{}' }]);
    await new GlabCli(glab.bin).comment('acme/widgets', 7, text);
    const [call] = glab.calls();
    expect(call?.args).toEqual(apiArgs('POST', `${PROJECT}/issues/7/notes`, { body: true }));
    expect(body(call)).toEqual({ body: text });
  });

  it('createIssue posts title, description and labels, and returns the iid and link', async () => {
    const url = 'https://gitlab.example.com/acme/platform/tools/widgets/-/issues/57';
    const glab = fakeGlab([
      {
        path: `${NESTED_PROJECT}/issues`,
        method: 'POST',
        // GitLab's id is not the iid the link has; fields the client does not read are ignored.
        stdout: JSON.stringify({ id: 9001, iid: 57, web_url: url, state: 'opened', extra: {} }),
      },
    ]);
    const cli = new GlabCli(glab.bin, { host: 'gitlab.example.com' });
    const created = await cli.createIssue(NESTED, {
      title: 'A title',
      body: text,
      labels: ['ares1:proposal', 'good first issue'],
    });
    expect(created).toEqual({ number: 57, url });
    const [call] = glab.calls();
    expect(call?.args).toEqual(
      apiArgs('POST', `${NESTED_PROJECT}/issues`, { host: 'gitlab.example.com', body: true }),
    );
    expect(body(call)).toEqual({
      title: 'A title',
      description: text,
      labels: 'ares1:proposal,good first issue',
    });
  });

  it('createIssue fails when GitLab returns no iid or link', async () => {
    const glab = fakeGlab([
      { path: `${PROJECT}/issues`, method: 'POST', stdout: JSON.stringify({ id: 9001 }) },
    ]);
    const err = await glabError(
      new GlabCli(glab.bin).createIssue('acme/widgets', { title: 't', body: 'b', labels: [] }),
    );
    expect(err.message).toBe(
      `glab api -X POST ${PROJECT}/issues 返回的数据无法识别（iid, web_url）：{"id":9001}`,
    );
    expect(body(glab.calls()[0])).toEqual({ title: 't', description: 'b', labels: '' });
  });

  it('editIssue replaces the description through stdin', async () => {
    const plan = '### 计划\n\n- [ ] #58 第一步\n- [ ] #59 第二步（依赖 #58）\n';
    const glab = fakeGlab([{ path: `${PROJECT}/issues/57`, method: 'PUT', stdout: '{}' }]);
    await new GlabCli(glab.bin).editIssue('acme/widgets', 57, { body: plan });
    const [call] = glab.calls();
    expect(call?.args).toEqual(apiArgs('PUT', `${PROJECT}/issues/57`, { body: true }));
    expect(body(call)).toEqual({ description: plan });
  });
});

describe('GlabCli failures', () => {
  it('reports what glab wrote to stderr when it fails, naming the call', async () => {
    const glab = fakeGlab([
      { path: 'user', stderr: 'glab: 401 Unauthorized (HTTP 401)\n', code: 1 },
      { path: 'user', code: 4 },
      {
        path: `${PROJECT}/issues/7/notes`,
        method: 'POST',
        stderr: 'glab: 404 Project Not Found (HTTP 404)\n',
        code: 1,
      },
    ]);
    const cli = new GlabCli(glab.bin);
    expect((await glabError(cli.viewer())).message).toBe(
      'glab api user 失败：glab: 401 Unauthorized (HTTP 401)',
    );
    // Nothing on stderr: the error of the process stands in.
    expect((await glabError(cli.viewer())).message).toMatch(/^glab api user 失败：Command failed/);
    expect((await glabError(cli.comment('acme/widgets', 7, 'hi'))).message).toBe(
      `glab api -X POST ${PROJECT}/issues/7/notes 失败：glab: 404 Project Not Found (HTTP 404)`,
    );
  });

  it('reports a glab that is not there, whether or not a body goes to it', async () => {
    const cli = new GlabCli(join(tmpDir(), 'no-glab'));
    expect((await glabError(cli.viewer())).message).toContain('ENOENT');
    expect(
      (await glabError(cli.comment('acme/widgets', 7, 'x'.repeat(200_000)))).message,
    ).toContain('ENOENT');
  });

  it('throws a GlabError, not a SyntaxError, when glab prints no JSON', async () => {
    const page = `<html>${'x'.repeat(1000)}</html>`;
    const glab = fakeGlab([get('user', null, { stdout: page }), { path: 'user', stdout: '' }]);
    const cli = new GlabCli(glab.bin);
    const err = await glabError(cli.viewer());
    expect(err).not.toBeInstanceOf(SyntaxError);
    expect(err.message).toBe(`glab api user 返回的不是 JSON：${page.slice(0, 300)}`);
    expect((await glabError(cli.viewer())).message).toBe('glab api user 返回的不是 JSON：');
  });

  it('names the fields that do not fit, and ignores the ones it does not read', async () => {
    const glab = fakeGlab([
      get(`${PROJECT}/issues/7`, { labels: 'ares1:ready' }),
      get(`${PROJECT}/issues/8`, null),
      get(LABELS_PAGE_1, [{ id: 'one', name: 'ares1:ready' }]),
      get('user', { username: '' }),
    ]);
    const cli = new GlabCli(glab.bin);
    expect((await glabError(cli.getLabels('acme/widgets', 7))).message).toBe(
      `glab api ${PROJECT}/issues/7 返回的数据无法识别（labels）：{"labels":"ares1:ready"}`,
    );
    expect((await glabError(cli.getLabels('acme/widgets', 8))).message).toBe(
      `glab api ${PROJECT}/issues/8 返回的数据无法识别（$）：null`,
    );
    const ready = { name: 'ares1:ready', color: '0e8a16', description: '' };
    expect((await glabError(cli.ensureLabels('acme/widgets', [ready]))).message).toContain(
      '（0.id）',
    );
    expect((await glabError(cli.viewer())).message).toContain('（username）');
  });
});

describe('GlabCli in English', () => {
  it('writes its errors without Chinese', async () => {
    setLang('en');
    // git's own messages follow the system's language.
    setEnv('LC_ALL', 'C');
    setEnv('LANGUAGE', undefined);
    const glab = fakeGlab([
      { path: 'user', stderr: 'glab: 401 Unauthorized (HTTP 401)\n', code: 1 },
      get('user', { username: 'ares1-bot' }),
      get(`${PROJECT}/issues/7`, null, { stdout: '<html>proxy</html>' }),
      get(`${PROJECT}/issues/7`, { labels: 'x' }),
      { path: `${PROJECT}/issues`, method: 'POST', stdout: '{}' },
    ]);
    const cli = new GlabCli(glab.bin, { account: 'alice' });
    const noOrigin = emptyClone();

    const messages = [
      (await glabError(cli.viewer())).message,
      (await glabError(cli.viewer())).message,
      (await glabError(cli.getLabels('widgets', 7))).message,
      (await glabError(cli.getLabels('acme/widgets', 7))).message,
      (await glabError(cli.getLabels('acme/widgets', 7))).message,
      (await glabError(cli.createIssue('acme/widgets', { title: 't', body: 'b', labels: [] })))
        .message,
      (await glabError(cli.resolveRepo(cloneWithOrigin('/srv/git/widgets.git')))).message,
      (await glabError(cli.resolveRepo(noOrigin))).message,
    ];
    expect(messages.slice(0, 7)).toEqual([
      'glab api user failed: glab: 401 Unauthorized (HTTP 401)',
      'glab is logged in as ares1-bot, not as the configured alice',
      'A GitLab project is named group/name or group/subgroup/name: widgets',
      `glab api ${PROJECT}/issues/7 returned no JSON: <html>proxy</html>`,
      `glab api ${PROJECT}/issues/7 returned data it cannot read (labels): {"labels":"x"}`,
      `glab api -X POST ${PROJECT}/issues returned data it cannot read (iid, web_url): {}`,
      'The origin URL names no GitLab project: /srv/git/widgets.git',
    ]);
    expect(messages[7]?.startsWith(`Reading the origin URL of ${noOrigin} failed: `)).toBe(true);
    for (const message of messages) expect(message).not.toMatch(CJK);
  });
});
