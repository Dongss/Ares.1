import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTrusted, LABELS } from '../src/github/issues.js';
import { GlabCli, GlabError, gitlabAuthor } from '../src/gitlab/client.js';
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
  vi.useRealTimers();
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
      await glabError(cli.listIssues(repo, { state: 'open', limit: 10 }));
      await glabError(cli.listNotPlannedIssues(repo, { limit: 0 }));
      await glabError(cli.getIssue(repo, 1));
      await glabError(cli.listComments(repo, 1));
      await glabError(cli.close(repo, 1, 'completed'));
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

/** An account as GitLab names the author of an issue or a note. */
function user(id: number, username: string) {
  return {
    id,
    username,
    name: username.toUpperCase(),
    state: 'active',
    locked: false,
    avatar_url: null,
    web_url: `https://gitlab.com/${username}`,
  };
}

const ALICE = user(1, 'alice');
const BOB = user(2, 'bob');
const CAROL = user(3, 'carol');

/** An issue as GitLab returns it. */
function rawIssue(iid: number, fields: Record<string, unknown> = {}) {
  return {
    id: 9000 + iid,
    iid,
    project_id: 42,
    title: `Issue ${iid}`,
    description: `Body ${iid}`,
    state: 'opened',
    labels: [],
    author: ALICE,
    assignees: [],
    milestone: null,
    user_notes_count: 0,
    created_at: '2026-11-01T00:00:00.000Z',
    web_url: `https://gitlab.com/acme/widgets/-/issues/${iid}`,
    ...fields,
  };
}

/** A note on an issue as GitLab returns it. */
function note(id: number, author: unknown, body: string | null, fields = {}) {
  return {
    id,
    type: null,
    body,
    author,
    created_at: '2026-11-01T00:00:00.000Z',
    system: false,
    noteable_type: 'Issue',
    internal: false,
    ...fields,
  };
}

/** A member of the project as `members/all` lists it. */
function member(who: { id: number; username: string }, level: number, fields = {}) {
  return {
    ...user(who.id, who.username),
    access_level: level,
    expires_at: null,
    membership_state: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    ...fields,
  };
}

/** The members of the project among the users, as the client asks for them. */
function membersPath(ids: number[], project = PROJECT): string {
  return `${project}/members/all?${ids.map((id) => `user_ids[]=${id}`).join('&')}&per_page=100`;
}

/** The latest notes of the issue, as the client asks for them. */
function notesPath(iid: number, project = PROJECT): string {
  return `${project}/issues/${iid}/notes?order_by=created_at&sort=desc&per_page=100`;
}

/** The API paths of the calls glab got, in order. */
function paths(calls: GlabCall[]): string[] {
  return calls.map((c) => `${c.args[3]} ${c.args[1]}`);
}

describe('gitlabAuthor', () => {
  it('trusts Developer and above by the number alone, naming each level', () => {
    const levels: [level: number | null | undefined, role: string, trusted: boolean][] = [
      [null, 'NONE', false],
      [undefined, 'NONE', false],
      [0, 'NONE', false],
      [5, 'MINIMAL_ACCESS', false],
      [10, 'GUEST', false],
      [15, 'PLANNER', false],
      [20, 'REPORTER', false],
      [25, 'ACCESS_LEVEL_25', false],
      [30, 'DEVELOPER', true],
      [40, 'MAINTAINER', true],
      [50, 'OWNER', true],
      [60, 'ACCESS_LEVEL_60', true],
    ];
    for (const [level, role, trusted] of levels) {
      expect(gitlabAuthor('carol', level), String(level)).toEqual({
        author: 'carol',
        trusted,
        role,
      });
    }
  });

  it('trusts no deleted account, whatever the level', () => {
    for (const username of [null, undefined, '']) {
      expect(gitlabAuthor(username, 50)).toEqual({ author: null, trusted: false, role: 'NONE' });
    }
  });
});

describe('GlabCli issues', () => {
  it('getIssue maps the issue, its author trusted by the access level', async () => {
    const description = '## 为什么\n\n需要它。\n';
    const glab = fakeGlab([
      get(
        `${PROJECT}/issues/7`,
        rawIssue(7, {
          description,
          labels: ['ares1:ready', 'bug'],
          // Fields the client does not read are ignored.
          task_completion_status: { count: 0 },
          extra: [1, 2],
        }),
      ),
      get(membersPath([1]), [member(ALICE, 40)]),
    ]);
    const cli = new GlabCli(glab.bin, { host: 'gitlab.example.com' });
    expect(await cli.getIssue('acme/widgets', 7)).toEqual({
      number: 7,
      title: 'Issue 7',
      body: description,
      state: 'open',
      stateReason: null,
      labels: ['ares1:ready', 'bug'],
      url: 'https://gitlab.com/acme/widgets/-/issues/7',
      author: 'alice',
      trusted: true,
      role: 'MAINTAINER',
      comments: [],
    });
    expect(glab.calls().map((c) => c.args)).toEqual([
      apiArgs('GET', `${PROJECT}/issues/7`, { host: 'gitlab.example.com' }),
      apiArgs('GET', membersPath([1]), { host: 'gitlab.example.com' }),
    ]);
  });

  it('getIssue tells closed as not planned by ares1:not-planned, any other closed as completed', async () => {
    const glab = fakeGlab([
      get(
        `${PROJECT}/issues/8`,
        rawIssue(8, { state: 'closed', labels: ['bug', LABELS.notPlanned], description: null }),
      ),
      get(`${PROJECT}/issues/9`, rawIssue(9, { state: 'closed', labels: ['bug'] })),
      // Reopened since: open, whatever label it kept.
      get(`${PROJECT}/issues/10`, rawIssue(10, { labels: [LABELS.notPlanned] })),
      // Asked once: the same author's level is kept.
      get(membersPath([1]), [member(ALICE, 30)]),
    ]);
    const cli = new GlabCli(glab.bin);
    const issues = [
      await cli.getIssue('acme/widgets', 8),
      await cli.getIssue('acme/widgets', 9),
      await cli.getIssue('acme/widgets', 10),
    ];
    expect(issues.map((i) => [i.number, i.state, i.stateReason, i.body])).toEqual([
      [8, 'closed', 'not_planned', ''],
      [9, 'closed', 'completed', 'Body 9'],
      [10, 'open', null, 'Body 10'],
    ]);
    expect(issues.every((i) => i.trusted && i.role === 'DEVELOPER')).toBe(true);
    expect(paths(glab.calls())).toEqual([
      `GET ${PROJECT}/issues/8`,
      `GET ${membersPath([1])}`,
      `GET ${PROJECT}/issues/9`,
      `GET ${PROJECT}/issues/10`,
    ]);
  });

  it('listIssues asks for one page of the state and label, newest first, without notes', async () => {
    const path = `${PROJECT}/issues?state=opened&labels=ares1%3Aready&order_by=created_at&sort=desc&per_page=50`;
    const glab = fakeGlab([
      get(path, [
        rawIssue(12, { author: BOB, labels: [LABELS.ready] }),
        rawIssue(11, { labels: [LABELS.ready, 'bug'] }),
        rawIssue(10, { author: BOB, labels: [LABELS.ready] }),
      ]),
      get(membersPath([1, 2]), [member(BOB, 10), member(ALICE, 30)]),
    ]);
    const issues = await new GlabCli(glab.bin).listIssues('acme/widgets', {
      state: 'open',
      label: LABELS.ready,
      limit: 50,
    });
    expect(issues.map((i) => [i.number, i.author, i.trusted, i.role, i.labels])).toEqual([
      [12, 'bob', false, 'GUEST', [LABELS.ready]],
      [11, 'alice', true, 'DEVELOPER', [LABELS.ready, 'bug']],
      [10, 'bob', false, 'GUEST', [LABELS.ready]],
    ]);
    expect(issues.every((i) => i.comments.length === 0)).toBe(true);
    expect(glab.calls().map((c) => c.args)).toEqual([
      apiArgs('GET', path),
      apiArgs('GET', membersPath([1, 2])),
    ]);
  });

  it('listIssues keeps the page within 1 and 100 issues, and lists them without a label', async () => {
    const closed = (perPage: number) =>
      `${PROJECT}/issues?state=closed&order_by=created_at&sort=desc&per_page=${perPage}`;
    const glab = fakeGlab([
      get(closed(1), [rawIssue(5, { state: 'closed', author: null })]),
      get(closed(100), []),
      get(closed(1), []),
    ]);
    const cli = new GlabCli(glab.bin);
    const [deleted] = await cli.listIssues('acme/widgets', { state: 'closed', limit: 0 });
    expect(deleted).toMatchObject({
      number: 5,
      state: 'closed',
      stateReason: 'completed',
      author: null,
      trusted: false,
      role: 'NONE',
    });
    expect(await cli.listIssues('acme/widgets', { state: 'closed', limit: 500 })).toEqual([]);
    expect(await cli.listIssues('acme/widgets', { state: 'closed', label: '', limit: -3 })).toEqual(
      [],
    );
    // Nobody to ask about: no members are asked for.
    expect(paths(glab.calls())).toEqual([
      `GET ${closed(1)}`,
      `GET ${closed(100)}`,
      `GET ${closed(1)}`,
    ]);
  });

  it("listIssues with comments reads each issue's notes, people's only, oldest first", async () => {
    const path = `${PROJECT}/issues?state=opened&labels=ares1%3Aproposal&order_by=created_at&sort=desc&per_page=2`;
    const glab = fakeGlab([
      get(path, [rawIssue(12), rawIssue(11, { author: BOB })]),
      // Newest first, as asked.
      get(notesPath(12), [
        note(103, BOB, 'third'),
        note(102, ALICE, 'mentioned in merge request !4', { system: true }),
        note(101, CAROL, 'first', { type: 'DiscussionNote', resolvable: false, unknown: {} }),
      ]),
      get(notesPath(11), []),
      get(membersPath([1, 2, 3]), [member(ALICE, 50), member(BOB, 20)]),
    ]);
    const issues = await new GlabCli(glab.bin).listIssues('acme/widgets', {
      state: 'open',
      label: LABELS.proposal,
      limit: 2,
      comments: true,
    });
    expect(issues.map((i) => [i.number, i.author, i.role])).toEqual([
      [12, 'alice', 'OWNER'],
      [11, 'bob', 'REPORTER'],
    ]);
    expect(issues[0]?.comments).toEqual([
      { body: 'first', author: 'carol', trusted: false, role: 'NONE' },
      { body: 'third', author: 'bob', trusted: false, role: 'REPORTER' },
    ]);
    expect(issues[1]?.comments).toEqual([]);
    expect(paths(glab.calls())).toEqual([
      `GET ${path}`,
      `GET ${notesPath(12)}`,
      `GET ${notesPath(11)}`,
      `GET ${membersPath([1, 2, 3])}`,
    ]);
  });

  it("listComments reads the issue's notes, people's only, oldest first", async () => {
    const glab = fakeGlab([
      get(notesPath(7, NESTED_PROJECT), [
        note(4, ALICE, null),
        note(3, null, 'from an account deleted since'),
        note(2, BOB, 'changed the description', { system: true }),
        note(1, BOB, 'first'),
      ]),
      get(membersPath([1, 2], NESTED_PROJECT), [member(ALICE, 30), member(BOB, 30)]),
    ]);
    expect(await new GlabCli(glab.bin).listComments(NESTED, 7)).toEqual([
      { body: 'first', author: 'bob', trusted: true, role: 'DEVELOPER' },
      { body: 'from an account deleted since', author: null, trusted: false, role: 'NONE' },
      { body: '', author: 'alice', trusted: true, role: 'DEVELOPER' },
    ]);
  });

  it('close closes the issue, ares1:not-planned saying whether it was planned', async () => {
    const glab = fakeGlab([
      { path: `${PROJECT}/issues/7`, method: 'PUT', stdout: '{}', keep: true },
    ]);
    const cli = new GlabCli(glab.bin);
    await cli.close('acme/widgets', 7, 'not_planned');
    await cli.close('acme/widgets', 7, 'completed');
    const calls = glab.calls();
    expect(calls.map((c) => c.args)).toEqual([
      apiArgs('PUT', `${PROJECT}/issues/7`, { body: true }),
      apiArgs('PUT', `${PROJECT}/issues/7`, { body: true }),
    ]);
    expect(calls.map(body)).toEqual([
      { state_event: 'close', add_labels: 'ares1:not-planned' },
      { state_event: 'close', remove_labels: 'ares1:not-planned' },
    ]);
  });
});

describe('GlabCli listNotPlannedIssues', () => {
  const page = (n: number, perPage: number) =>
    `${PROJECT}/issues?state=closed&labels=ares1%3Anot-planned&order_by=created_at&sort=desc&per_page=${perPage}&page=${n}`;
  const notPlanned = (iid: number, fields: Record<string, unknown> = {}) =>
    rawIssue(iid, { state: 'closed', labels: ['bug', LABELS.notPlanned], ...fields });

  it('pages through the closed issues with ares1:not-planned, with their notes', async () => {
    const glab = fakeGlab([
      get(page(1, 3), [
        notPlanned(30),
        notPlanned(29, { author: BOB }),
        // Its label was removed after the page was listed.
        notPlanned(28, { labels: ['bug'] }),
      ]),
      get(page(2, 3), [
        // Pages overlap when issues are closed meanwhile.
        notPlanned(29, { author: BOB }),
        notPlanned(27, { author: CAROL }),
        notPlanned(26),
      ]),
      get(notesPath(30), [note(1, BOB, 'not now')]),
      get(notesPath(29), []),
      get(notesPath(27), [note(2, ALICE, 'no', { system: true })]),
      get(membersPath([1, 2, 3]), [member(ALICE, 40)]),
    ]);
    const issues = await new GlabCli(glab.bin).listNotPlannedIssues('acme/widgets', { limit: 3 });
    expect(issues.map((i) => [i.number, i.state, i.stateReason, i.author, i.trusted])).toEqual([
      [30, 'closed', 'not_planned', 'alice', true],
      [29, 'closed', 'not_planned', 'bob', false],
      [27, 'closed', 'not_planned', 'carol', false],
    ]);
    expect(issues.map((i) => i.comments)).toEqual([
      [{ body: 'not now', author: 'bob', trusted: false, role: 'NONE' }],
      [],
      [],
    ]);
    // The notes of the issues past the limit are not read.
    expect(paths(glab.calls())).toEqual([
      `GET ${page(1, 3)}`,
      `GET ${page(2, 3)}`,
      `GET ${notesPath(30)}`,
      `GET ${notesPath(29)}`,
      `GET ${notesPath(27)}`,
      `GET ${membersPath([1, 2, 3])}`,
    ]);
  });

  it('stops at a short page, and one page past what the limit needs', async () => {
    const glab = fakeGlab([
      get(page(1, 5), [notPlanned(9), notPlanned(8)]),
      // A server that ignores the page, listing an issue reopened since.
      get(page(1, 2), [notPlanned(5), notPlanned(4, { state: 'opened' })]),
      get(page(2, 2), [notPlanned(5), notPlanned(4, { state: 'opened' })]),
      get(notesPath(9), []),
      get(notesPath(8), []),
      get(notesPath(5), []),
      get(membersPath([1]), [member(ALICE, 10)]),
    ]);
    const cli = new GlabCli(glab.bin);
    expect(
      (await cli.listNotPlannedIssues('acme/widgets', { limit: 5 })).map((i) => i.number),
    ).toEqual([9, 8]);
    expect(
      (await cli.listNotPlannedIssues('acme/widgets', { limit: 2 })).map((i) => i.number),
    ).toEqual([5]);
    expect(paths(glab.calls())).toEqual([
      `GET ${page(1, 5)}`,
      `GET ${notesPath(9)}`,
      `GET ${notesPath(8)}`,
      `GET ${membersPath([1])}`,
      `GET ${page(1, 2)}`,
      `GET ${page(2, 2)}`,
      `GET ${notesPath(5)}`,
    ]);
  });

  it('asks nothing for none', async () => {
    const glab = fakeGlab([]);
    const cli = new GlabCli(glab.bin);
    expect(await cli.listNotPlannedIssues('acme/widgets', { limit: 0 })).toEqual([]);
    expect(await cli.listNotPlannedIssues('acme/widgets', { limit: -1 })).toEqual([]);
    expect(glab.calls()).toEqual([]);
  });
});

describe('GlabCli trust', () => {
  it('trusts active members from Developer up, and nobody else but the Master', async () => {
    const guest = user(11, 'guest');
    const planner = user(12, 'planner');
    const reporter = user(13, 'reporter');
    const minimal = user(14, 'minimal');
    const stranger = user(15, 'stranger');
    const awaiting = user(16, 'awaiting');
    const blocked = user(17, 'blocked');
    const developer = user(18, 'developer');
    const maintainer = user(19, 'maintainer');
    const owner = user(20, 'owner');
    const inherited = user(21, 'inherited');
    const bot = user(22, 'ares1-bot');
    const authors = [
      guest,
      planner,
      reporter,
      minimal,
      stranger,
      awaiting,
      blocked,
      null,
      developer,
      maintainer,
      owner,
      inherited,
      bot,
    ];
    const glab = fakeGlab([
      get(
        notesPath(7),
        authors.map((a, i) => note(i + 1, a, `by ${a?.username ?? 'nobody'}`)).reverse(),
      ),
      get(membersPath([11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]), [
        member(owner, 50),
        member(guest, 10),
        member(planner, 15),
        member(reporter, 20),
        member(minimal, 5),
        member(awaiting, 30, { membership_state: 'awaiting' }),
        member(blocked, 40, { state: 'blocked' }),
        member(developer, 30),
        member(maintainer, 40),
        // Listed by each of the groups it is a member of.
        member(inherited, 10),
        member(inherited, 30),
        member(bot, 10),
        // Somebody it did not ask about counts for nothing.
        member(user(99, 'other'), 50),
      ]),
    ]);
    const comments = await new GlabCli(glab.bin).listComments('acme/widgets', 7);
    expect(comments.map((c) => [c.author, c.role, c.trusted])).toEqual([
      ['guest', 'GUEST', false],
      ['planner', 'PLANNER', false],
      ['reporter', 'REPORTER', false],
      ['minimal', 'MINIMAL_ACCESS', false],
      ['stranger', 'NONE', false],
      ['awaiting', 'NONE', false],
      ['blocked', 'NONE', false],
      [null, 'NONE', false],
      ['developer', 'DEVELOPER', true],
      ['maintainer', 'MAINTAINER', true],
      ['owner', 'OWNER', true],
      ['inherited', 'DEVELOPER', true],
      ['ares1-bot', 'GUEST', false],
    ]);
    const by = (name: string | null) => {
      const found = comments.find((c) => c.author === name);
      if (!found) throw new Error(`no comment by ${name}`);
      return found;
    };
    // The Master's own account is trusted whatever its level; nobody else gains from it.
    expect(isTrusted(by('ares1-bot'), 'ares1-bot')).toBe(true);
    expect(isTrusted(by('ares1-bot'), 'Ares1-Bot')).toBe(true);
    expect(isTrusted(by('ares1-bot'), null)).toBe(false);
    for (const name of ['guest', 'reporter', 'stranger', 'awaiting', null]) {
      expect(isTrusted(by(name), 'ares1-bot'), String(name)).toBe(false);
    }
    expect(isTrusted(by('developer'), null)).toBe(true);
  });

  it('asks for the members of a project at most 100 at a time', async () => {
    const people = Array.from({ length: 150 }, (_, i) => user(i + 1, `user${i + 1}`));
    const ids = people.map((p) => p.id);
    const last = user(150, 'user150');
    const glab = fakeGlab([
      get(
        notesPath(7),
        people.map((p) => note(p.id, p, 'hi')),
      ),
      get(
        membersPath(ids.slice(0, 100)),
        people.slice(0, 100).flatMap((p) => (p.id % 2 === 0 ? [member(p, 30)] : [])),
      ),
      get(membersPath(ids.slice(100)), [member(last, 40)]),
    ]);
    const comments = await new GlabCli(glab.bin).listComments('acme/widgets', 7);
    expect(comments).toHaveLength(150);
    expect(comments.filter((c) => c.trusted).map((c) => c.author)).toEqual([
      'user150',
      ...people
        .slice(0, 100)
        .filter((p) => p.id % 2 === 0)
        .map((p) => p.username)
        .reverse(),
    ]);
    expect(paths(glab.calls())).toEqual([
      `GET ${notesPath(7)}`,
      `GET ${membersPath(ids.slice(0, 100))}`,
      `GET ${membersPath(ids.slice(100))}`,
    ]);
  });

  it('keeps what it learned of a member for five minutes, per project', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-01-01T00:00:00Z').getTime();
    vi.setSystemTime(start);
    const glab = fakeGlab([
      get(`${PROJECT}/issues/7`, rawIssue(7), { keep: true }),
      get(notesPath(7), [note(2, BOB, 'b'), note(1, ALICE, 'a')], { keep: true }),
      get(`${NESTED_PROJECT}/issues/7`, rawIssue(7)),
      get(membersPath([1]), [member(ALICE, 30)]),
      get(membersPath([2]), [member(BOB, 40)]),
      get(membersPath([1], NESTED_PROJECT), []),
      get(membersPath([1, 2]), [member(ALICE, 10), member(BOB, 40)]),
    ]);
    const cli = new GlabCli(glab.bin);
    const roles = async () =>
      (await cli.listComments('acme/widgets', 7)).map((c) => [c.author, c.role, c.trusted]);

    expect((await cli.getIssue('acme/widgets', 7)).role).toBe('DEVELOPER');
    // Only bob is asked about.
    expect(await roles()).toEqual([
      ['alice', 'DEVELOPER', true],
      ['bob', 'MAINTAINER', true],
    ]);
    vi.setSystemTime(start + 4 * 60_000);
    await cli.getIssue('acme/widgets', 7);
    await roles();
    // Another project has members of its own.
    expect((await cli.getIssue(NESTED, 7)).trusted).toBe(false);
    vi.setSystemTime(start + 5 * 60_000);
    // What was learned at the start is too old: both asked about again, together.
    expect(await roles()).toEqual([
      ['alice', 'GUEST', false],
      ['bob', 'MAINTAINER', true],
    ]);
    expect(paths(glab.calls()).filter((p) => p.includes('/members/'))).toEqual([
      `GET ${membersPath([1])}`,
      `GET ${membersPath([2])}`,
      `GET ${membersPath([1], NESTED_PROJECT)}`,
      `GET ${membersPath([1, 2])}`,
    ]);
  });

  it('fails when the members cannot be read, never taking the author for no member', async () => {
    const glab = fakeGlab([
      get(notesPath(7), [note(1, ALICE, 'a')], { keep: true }),
      { path: membersPath([1]), stderr: 'glab: 403 Forbidden (HTTP 403)\n', code: 1 },
      get(membersPath([1]), [{ id: 1, username: 'alice' }]),
      get(membersPath([1]), [member(ALICE, 30)]),
    ]);
    const cli = new GlabCli(glab.bin);
    expect((await glabError(cli.listComments('acme/widgets', 7))).message).toBe(
      `glab api ${membersPath([1])} 失败：glab: 403 Forbidden (HTTP 403)`,
    );
    expect((await glabError(cli.listComments('acme/widgets', 7))).message).toContain(
      `glab api ${membersPath([1])} 返回的数据无法识别（0.access_level）：`,
    );
    // Nothing was kept of the failures: asked again.
    expect(await cli.listComments('acme/widgets', 7)).toEqual([
      { body: 'a', author: 'alice', trusted: true, role: 'DEVELOPER' },
    ]);
  });
});

describe('GlabCli issue failures', () => {
  it('names the issue it cannot find', async () => {
    const notFound = { stderr: 'glab: 404 Not found (HTTP 404)\n', code: 1 };
    const glab = fakeGlab([
      { path: `${PROJECT}/issues/404`, ...notFound },
      { path: notesPath(404), ...notFound },
      { path: `${PROJECT}/issues/404`, method: 'PUT', ...notFound },
    ]);
    const cli = new GlabCli(glab.bin);
    expect((await glabError(cli.getIssue('acme/widgets', 404))).message).toBe(
      `glab api ${PROJECT}/issues/404 失败：glab: 404 Not found (HTTP 404)`,
    );
    expect((await glabError(cli.listComments('acme/widgets', 404))).message).toBe(
      `glab api ${notesPath(404)} 失败：glab: 404 Not found (HTTP 404)`,
    );
    expect((await glabError(cli.close('acme/widgets', 404, 'not_planned'))).message).toBe(
      `glab api -X PUT ${PROJECT}/issues/404 失败：glab: 404 Not found (HTTP 404)`,
    );
  });

  it('names the fields of an issue or a note it cannot read', async () => {
    const list = `${PROJECT}/issues?state=opened&order_by=created_at&sort=desc&per_page=10`;
    const glab = fakeGlab([
      get(`${PROJECT}/issues/7`, { ...rawIssue(7), iid: '7', labels: null }),
      get(notesPath(7), [note(1, ALICE, 'a', { system: 'no' })]),
      get(list, { message: '403 Forbidden' }),
      get(list, [rawIssue(1), { iid: 2 }]),
    ]);
    const cli = new GlabCli(glab.bin);
    expect((await glabError(cli.getIssue('acme/widgets', 7))).message).toContain(
      `glab api ${PROJECT}/issues/7 返回的数据无法识别（iid, labels）：`,
    );
    expect((await glabError(cli.listComments('acme/widgets', 7))).message).toContain(
      '（0.system）',
    );
    const query = { state: 'open', limit: 10 } as const;
    expect((await glabError(cli.listIssues('acme/widgets', query))).message).toContain('（$）');
    expect((await glabError(cli.listIssues('acme/widgets', query))).message).toContain(
      '（1.title, 1.state, 1.labels, 1.web_url）',
    );
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
