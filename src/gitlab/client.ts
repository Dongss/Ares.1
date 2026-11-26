import { execFile } from 'node:child_process';
import { z } from 'zod';
import { LABELS } from '../github/issues.js';
import {
  type CodeHost,
  forcePushable,
  type HostAuthored,
  type HostComment,
  type HostIssue,
  type LabelDef,
} from '../host/code-host.js';
import { t } from '../i18n.js';

/** A failure of glab or of GitLab, or what glab printed that cannot be read. */
export class GlabError extends Error {}

/** The most items a page of GitLab's REST API holds. */
const MAX_PAGE = 100;

/**
 * The most pages of a project's labels `ensureLabels` reads. A project has far fewer labels; the
 * limit only keeps a server that ignores `page` from being asked forever.
 */
const MAX_LABEL_PAGES = 20;

/**
 * How long the client keeps what it learned of a member's access level. Long enough that a round
 * of the bridge asks once per person, short enough that a change of the project's members counts
 * from the next rounds on.
 */
const MEMBER_TTL_MS = 5 * 60_000;

/** GitLab's access levels by the names it gives them. */
const ACCESS_LEVELS: ReadonlyMap<number, string> = new Map([
  [0, 'NONE'],
  [5, 'MINIMAL_ACCESS'],
  [10, 'GUEST'],
  [15, 'PLANNER'],
  [20, 'REPORTER'],
  [30, 'DEVELOPER'],
  [40, 'MAINTAINER'],
  [50, 'OWNER'],
]);

/** The lowest access level that can push to the project: Developer. */
const TRUSTED_ACCESS_LEVEL = 30;

/**
 * Who wrote something, from the username and the access level to the project GitLab gave:
 * trusted from Developer up, as those can change the project anyway. `accessLevel` is null for
 * somebody who is no member (or not let in yet); `username` is empty when the account is gone.
 * The role is GitLab's name for the level, or ACCESS_LEVEL_<n> for a level GitLab added later;
 * trust goes by the number alone.
 */
export function gitlabAuthor(
  username: string | null | undefined,
  accessLevel: number | null | undefined,
): HostAuthored {
  if (!username) return { author: null, trusted: false, role: 'NONE' };
  if (accessLevel === null || accessLevel === undefined) {
    return { author: username, trusted: false, role: 'NONE' };
  }
  return {
    author: username,
    trusted: accessLevel >= TRUSTED_ACCESS_LEVEL,
    role: ACCESS_LEVELS.get(accessLevel) ?? `ACCESS_LEVEL_${accessLevel}`,
  };
}

/**
 * What `command` printed as JSON, read with `schema`. Anything else (a proxy's HTML page, a glab
 * warning, fields of other types) is a GlabError, naming the fields that did not fit, so callers
 * that handle GlabError keep working. Fields the schema does not name are left out, so ones
 * GitLab adds later change nothing.
 */
function parseOutput<T>(out: string, schema: z.ZodType<T>, command: string): T {
  let json: unknown;
  try {
    json = JSON.parse(out);
  } catch {
    throw new GlabError(
      t({
        zh: `${command} 返回的不是 JSON：${out.slice(0, 300)}`,
        en: `${command} returned no JSON: ${out.slice(0, 300)}`,
      }),
    );
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((i) => i.path.map(String).join('.') || '$')),
    ].join(', ');
    throw new GlabError(
      t({
        zh: `${command} 返回的数据无法识别（${fields}）：${out.slice(0, 300)}`,
        en: `${command} returned data it cannot read (${fields}): ${out.slice(0, 300)}`,
      }),
    );
  }
  return parsed.data;
}

/** Whether `path` is a GitLab project's path: "group/name" or "group/sub/.../name". */
function isProjectPath(path: string): boolean {
  const parts = path.split('/');
  return parts.length >= 2 && parts.every((p) => p !== '');
}

/** `repo` when it is a project's path; else a GlabError, before glab or git is called. */
function projectPath(repo: string): string {
  if (!isProjectPath(repo)) {
    throw new GlabError(
      t({
        zh: `GitLab 项目路径应为 group/name 或 group/subgroup/name：${repo}`,
        en: `A GitLab project is named group/name or group/subgroup/name: ${repo}`,
      }),
    );
  }
  return repo;
}

/**
 * The project `repo` ("group/subgroup/.../name") as an API path takes it: one segment, every /
 * encoded. A path that is no project's fails here, before glab is called.
 */
function projectId(repo: string): string {
  return encodeURIComponent(projectPath(repo));
}

/** The GitLab git talks to when the client is given no host: glab's own default. */
const DEFAULT_HOST = 'gitlab.com';

/** A GlabError for a force push of a branch `forcePushable` does not allow. */
function forceRefused(branch: string): GlabError {
  return new GlabError(
    t({
      zh: `只能强制推送 ares1/ 开头的 Run 分支，不能强制推送 ${branch}`,
      en: `Only a Run's branch (ares1/...) may be force-pushed, not ${branch}`,
    }),
  );
}

/** Schemes of the remote URLs a GitLab project is cloned from. */
const REMOTE_SCHEMES: readonly string[] = ['https:', 'http:', 'ssh:', 'git+ssh:', 'ssh+git:'];

/**
 * The project's path in a clone's remote URL: https (with a user and a port or without),
 * `ssh://[user@]host[:port]/path` or scp-like `[user@]host:path`, without ".git" and trailing
 * slashes; null for anything else, a local path included. The host is not read: it may be an
 * alias of ~/.ssh/config, and which GitLab the client talks to is its own setting.
 */
function remoteProjectPath(remote: string): string | null {
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    let url: URL;
    try {
      url = new URL(remote);
      path = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
    if (!REMOTE_SCHEMES.includes(url.protocol)) return null;
  } else {
    // As git does, a colon before any slash makes it scp-like; anything else is a local path.
    const scp = /^(?:[^@/:]+@)?[^@/:]+:(.*)$/.exec(remote);
    if (!scp?.[1]) return null;
    path = scp[1];
  }
  path = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  return isProjectPath(path) ? path : null;
}

/** A remote URL without the user and password it may carry, to show in an error. */
function withoutCredentials(remote: string): string {
  return remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
}

/** A label of a project as GitLab lists it, its group's labels included. */
const RawLabel = z.object({
  id: z.number().int(),
  name: z.string(),
  /** "#rrggbb". */
  color: z.string().nullish(),
  description: z.string().nullish(),
  /** false for a label of one of the project's groups. */
  is_project_label: z.boolean().optional(),
});
type RawLabel = z.infer<typeof RawLabel>;

/** Whether the label already has the color and description of `def`. */
function sameLabel(raw: RawLabel, def: LabelDef): boolean {
  return (
    (raw.color ?? '').toLowerCase() === `#${def.color}`.toLowerCase() &&
    (raw.description ?? '') === def.description
  );
}

/** An account as GitLab names the author of an issue or a note; absent when it gave none. */
const RawUser = z.object({ id: z.number().int(), username: z.string() }).nullish();
type RawUser = z.infer<typeof RawUser>;

/** An issue as GitLab returns it. */
const RawIssue = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullish(),
  /** opened or closed. */
  state: z.string(),
  labels: z.array(z.string()),
  web_url: z.string().min(1),
  author: RawUser,
});
type RawIssue = z.infer<typeof RawIssue>;

/** A note (a comment) on an issue as GitLab returns it. */
const RawNote = z.object({
  body: z.string().nullish(),
  author: RawUser,
  /** Written by GitLab itself (a mention elsewhere, a change of assignee), not by a person. */
  system: z.boolean().nullish(),
});
type RawNote = z.infer<typeof RawNote>;

/** A member of a project as `members/all` lists it, memberships of its groups included. */
const RawMember = z.object({
  id: z.number().int(),
  access_level: z.number().int(),
  /** The account's state: active, blocked, deactivated, ... */
  state: z.string().nullish(),
  /** active, or awaiting while GitLab has not let the member in yet (no seat, no approval). */
  membership_state: z.string().nullish(),
});
type RawMember = z.infer<typeof RawMember>;

/** Whether the member can act as one: the account and its membership are active. */
function activeMember(m: RawMember): boolean {
  return (m.state ?? 'active') === 'active' && (m.membership_state ?? 'active') === 'active';
}

/** Who wrote an issue or a note, by the access level the client found for its author. */
type Authors = (user: RawUser) => HostAuthored;

function fromRawNote(note: RawNote, authors: Authors): HostComment {
  return { body: note.body ?? '', ...authors(note.author) };
}

/**
 * GitLab closes an issue without a reason: one closed as not planned carries LABELS.notPlanned
 * (as `close` leaves it), any other closed one counts as completed.
 */
function fromRawIssue(raw: RawIssue, authors: Authors, comments: HostComment[]): HostIssue {
  const closed = raw.state === 'closed';
  return {
    ...authors(raw.author),
    number: raw.iid,
    title: raw.title,
    body: raw.description ?? '',
    state: closed ? 'closed' : 'open',
    stateReason: closed
      ? raw.labels.includes(LABELS.notPlanned)
        ? 'not_planned'
        : 'completed'
      : null,
    labels: raw.labels,
    url: raw.web_url,
    comments,
  };
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * GitLab through the glab CLI, so the Master never stores a token: glab keeps it in its config.
 * Everything goes through `glab api` and GitLab's REST API; `repo` is a project's path, as
 * "group/subgroup/name", and the number of an issue or a merge request is its iid, the one in
 * its link. With `host`, every call goes to that GitLab (a self-hosted one), else to the one glab
 * picks, and git pushes to and fetches from it over https, else from gitlab.com. With `account`,
 * the client checks it is the account glab is logged in as. Authors are trusted by their access
 * level to the project (`gitlabAuthor`), which the client asks GitLab for and keeps a few minutes.
 */
export class GlabCli
  implements
    Pick<
      CodeHost,
      | 'resolveRepo'
      | 'viewer'
      | 'ensureLabels'
      | 'listIssues'
      | 'listNotPlannedIssues'
      | 'getIssue'
      | 'getLabels'
      | 'setLabels'
      | 'comment'
      | 'listComments'
      | 'close'
      | 'createIssue'
      | 'editIssue'
      | 'push'
      | 'fetch'
    >
{
  private readonly host: string | undefined;
  private readonly account: string | undefined;
  /**
   * Access levels found, by project and user id: null for somebody who is no active member;
   * `at` is when it was found (Date.now).
   */
  private readonly members = new Map<string, { level: number | null; at: number }>();

  constructor(
    private readonly bin = 'glab',
    opts: { host?: string; account?: string } = {},
  ) {
    this.host = opts.host || undefined;
    this.account = opts.account || undefined;
  }

  /** glab with `args`, `stdin` written to it; `command` names the call in the error. */
  private exec(args: string[], command: string, stdin?: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = execFile(
        this.bin,
        args,
        { env: process.env, maxBuffer: 32 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const detail = stderr.trim() || err.message;
            reject(
              new GlabError(
                t({ zh: `${command} 失败：${detail}`, en: `${command} failed: ${detail}` }),
              ),
            );
            return;
          }
          resolve(stdout.trim());
        },
      );
      // A glab that is missing or quits early closes its stdin: the callback reports that.
      child.stdin?.on('error', () => {});
      child.stdin?.end(stdin);
    });
  }

  /**
   * A request to GitLab's REST API at `path` (under api/v4). The body goes as JSON through stdin,
   * never in the arguments, so neither its size nor its text matters to the command line.
   */
  private api(method: Method, path: string, body?: unknown): Promise<string> {
    const args = ['api', path, '-X', method];
    if (this.host) args.push('--hostname', this.host);
    if (body !== undefined) args.push('-H', 'Content-Type: application/json', '--input', '-');
    const command = method === 'GET' ? `glab api ${path}` : `glab api -X ${method} ${path}`;
    return this.exec(args, command, body === undefined ? undefined : JSON.stringify(body));
  }

  /** What a GET of `path` returns, read with `schema`. */
  private async read<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return parseOutput(await this.api('GET', path), schema, `glab api ${path}`);
  }

  /** What a request with a body returns, read with `schema`. */
  private async send<T>(
    method: Method,
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    return parseOutput(await this.api(method, path, body), schema, `glab api -X ${method} ${path}`);
  }

  /** The labels the project can use, its groups' labels included. */
  private async projectLabels(project: string): Promise<RawLabel[]> {
    const labels: RawLabel[] = [];
    for (let page = 1; page <= MAX_LABEL_PAGES; page++) {
      const path = `projects/${project}/labels?per_page=${MAX_PAGE}&page=${page}`;
      const found = await this.read(path, z.array(RawLabel));
      labels.push(...found);
      if (found.length < MAX_PAGE) break;
    }
    return labels;
  }

  /**
   * The access level to the project of each of the users, null for one who is no active member:
   * from what the client found in the last few minutes, the rest asked of GitLab together. Who is
   * no member is told by being left out of the members listed, never by an error's text; a
   * request that fails is a GlabError, never taken for "no member".
   */
  private async accessLevels(
    project: string,
    ids: readonly number[],
  ): Promise<Map<number, number | null>> {
    const now = Date.now();
    const levels = new Map<number, number | null>();
    const missing: number[] = [];
    for (const id of new Set(ids)) {
      const known = this.members.get(`${project}/${id}`);
      if (known && now - known.at < MEMBER_TTL_MS) levels.set(id, known.level);
      else missing.push(id);
    }
    missing.sort((a, b) => a - b);
    for (let i = 0; i < missing.length; i += MAX_PAGE) {
      const batch = missing.slice(i, i + MAX_PAGE);
      const users = batch.map((id) => `user_ids[]=${id}`).join('&');
      const path = `projects/${project}/members/all?${users}&per_page=${MAX_PAGE}`;
      const found = await this.read(path, z.array(RawMember));
      for (const id of batch) {
        // A member of several of the project's groups may be listed more than once.
        const own = found.filter((m) => m.id === id && activeMember(m)).map((m) => m.access_level);
        const level = own.length > 0 ? Math.max(...own) : null;
        levels.set(id, level);
        this.members.set(`${project}/${id}`, { level, at: now });
      }
    }
    return levels;
  }

  /** Who wrote what the users wrote in the project, their access levels found first. */
  private async authors(project: string, users: readonly RawUser[]): Promise<Authors> {
    const ids = users.flatMap((u) => (u?.username ? [u.id] : []));
    const levels = await this.accessLevels(project, ids);
    return (user) => gitlabAuthor(user?.username, user ? levels.get(user.id) : null);
  }

  /** The latest notes (up to 100) people wrote on the issue, oldest first. */
  private async notes(project: string, number: number): Promise<RawNote[]> {
    const path = `projects/${project}/issues/${number}/notes?order_by=created_at&sort=desc&per_page=${MAX_PAGE}`;
    const notes = await this.read(path, z.array(RawNote));
    return notes.filter((n) => n.system !== true).reverse();
  }

  /** The issues as the Master needs them, with their notes when `comments`. */
  private async issues(
    project: string,
    raws: readonly RawIssue[],
    comments: boolean,
  ): Promise<HostIssue[]> {
    // One at a time: a page of issues is at most 100 of them.
    const notes: RawNote[][] = [];
    for (const raw of raws) notes.push(comments ? await this.notes(project, raw.iid) : []);
    const authors = await this.authors(project, [
      ...raws.map((r) => r.author),
      ...notes.flat().map((n) => n.author),
    ]);
    const comment = (n: RawNote) => fromRawNote(n, authors);
    return raws.map((raw, i) => fromRawIssue(raw, authors, (notes[i] ?? []).map(comment)));
  }

  async resolveRepo(path: string): Promise<string> {
    // Read from the clone's config: no credentials needed.
    const remote = await new Promise<string>((resolve, reject) => {
      execFile('git', ['remote', 'get-url', 'origin'], { cwd: path }, (err, stdout, stderr) => {
        if (err) {
          const detail = stderr.trim() || err.message;
          reject(
            new GlabError(
              t({
                zh: `读取 ${path} 的 origin 地址失败：${detail}`,
                en: `Reading the origin URL of ${path} failed: ${detail}`,
              }),
            ),
          );
          return;
        }
        resolve(stdout.trim());
      });
    });
    const project = remoteProjectPath(remote);
    if (!project) {
      const shown = withoutCredentials(remote);
      throw new GlabError(
        t({
          zh: `从 origin 的地址读不出 GitLab 项目路径：${shown}`,
          en: `The origin URL names no GitLab project: ${shown}`,
        }),
      );
    }
    return project;
  }

  /**
   * The login glab acts as. glab keeps one login per host and, unlike gh, cannot give the token
   * of another account it knows, so `account` cannot be chosen, only checked: acting as anybody
   * else is an error.
   */
  async viewer(): Promise<string> {
    const { username } = await this.read('user', z.object({ username: z.string().min(1) }));
    if (this.account && username.toLowerCase() !== this.account.toLowerCase()) {
      throw new GlabError(
        t({
          zh: `glab 登录的账号是 ${username}，不是配置的 ${this.account}`,
          en: `glab is logged in as ${username}, not as the configured ${this.account}`,
        }),
      );
    }
    return username;
  }

  async ensureLabels(repo: string, labels: readonly LabelDef[]): Promise<void> {
    const project = projectId(repo);
    if (labels.length === 0) return;
    // What exists is listed rather than told from the error a creation gets, whose text GitLab
    // may change.
    const existing = await this.projectLabels(project);
    for (const def of labels) {
      const color = `#${def.color}`;
      const found = existing.find((l) => l.name === def.name);
      if (!found) {
        await this.api('POST', `projects/${project}/labels`, {
          name: def.name,
          color,
          description: def.description,
        });
      } else if (found.is_project_label !== false && !sameLabel(found, def)) {
        await this.api('PUT', `projects/${project}/labels/${found.id}`, {
          color,
          description: def.description,
        });
      }
      // A label of one of the project's groups serves as it is: the project cannot change it.
    }
  }

  async listIssues(
    repo: string,
    query: { state: 'open' | 'closed'; label?: string; limit: number; comments?: boolean },
  ): Promise<HostIssue[]> {
    const project = projectId(repo);
    const params = [`state=${query.state === 'open' ? 'opened' : 'closed'}`];
    if (query.label) params.push(`labels=${encodeURIComponent(query.label)}`);
    params.push('order_by=created_at', 'sort=desc');
    params.push(`per_page=${Math.min(Math.max(query.limit, 1), MAX_PAGE)}`);
    const raws = await this.read(
      `projects/${project}/issues?${params.join('&')}`,
      z.array(RawIssue),
    );
    return this.issues(project, raws, query.comments === true);
  }

  async listNotPlannedIssues(repo: string, query: { limit: number }): Promise<HostIssue[]> {
    const project = projectId(repo);
    const limit = Math.max(query.limit, 0);
    if (limit === 0) return [];
    // The same page size on every page, so that the pages follow each other.
    const perPage = Math.min(limit, MAX_PAGE);
    const label = encodeURIComponent(LABELS.notPlanned);
    const found: RawIssue[] = [];
    // The label selects only such issues, so the pages needed are known; one more covers those
    // reopened or relabelled meanwhile. Never page on and on.
    const maxPages = Math.ceil(limit / perPage) + 1;
    for (let page = 1; page <= maxPages && found.length < limit; page++) {
      const path =
        `projects/${project}/issues?state=closed&labels=${label}` +
        `&order_by=created_at&sort=desc&per_page=${perPage}&page=${page}`;
      const raws = await this.read(path, z.array(RawIssue));
      for (const raw of raws) {
        // Pages overlap when issues are closed meanwhile.
        const seen = found.some((f) => f.iid === raw.iid);
        if (!seen && raw.state === 'closed' && raw.labels.includes(LABELS.notPlanned)) {
          found.push(raw);
        }
      }
      if (raws.length < perPage) break;
    }
    return this.issues(project, found.slice(0, limit), true);
  }

  async getIssue(repo: string, number: number): Promise<HostIssue> {
    const project = projectId(repo);
    const raw = await this.read(`projects/${project}/issues/${number}`, RawIssue);
    const authors = await this.authors(project, [raw.author]);
    return fromRawIssue(raw, authors, []);
  }

  async listComments(repo: string, number: number): Promise<HostComment[]> {
    const project = projectId(repo);
    const notes = await this.notes(project, number);
    const authors = await this.authors(
      project,
      notes.map((n) => n.author),
    );
    return notes.map((n) => fromRawNote(n, authors));
  }

  /**
   * GitLab closes an issue without a reason, so LABELS.notPlanned says it was not planned: added
   * with the closing, or removed when it is closed as completed (as when it was reopened since).
   */
  async close(repo: string, number: number, reason: 'completed' | 'not_planned'): Promise<void> {
    const labels =
      reason === 'not_planned'
        ? { add_labels: LABELS.notPlanned }
        : { remove_labels: LABELS.notPlanned };
    await this.api('PUT', `projects/${projectId(repo)}/issues/${number}`, {
      state_event: 'close',
      ...labels,
    });
  }

  async getLabels(repo: string, number: number): Promise<string[]> {
    const path = `projects/${projectId(repo)}/issues/${number}`;
    return (await this.read(path, z.object({ labels: z.array(z.string()) }))).labels;
  }

  async setLabels(repo: string, number: number, labels: string[]): Promise<void> {
    // GitLab takes the labels comma-separated (a label's name has no comma), an empty string
    // removing them all.
    await this.api('PUT', `projects/${projectId(repo)}/issues/${number}`, {
      labels: labels.join(','),
    });
  }

  async comment(repo: string, number: number, body: string): Promise<void> {
    await this.api('POST', `projects/${projectId(repo)}/issues/${number}/notes`, { body });
  }

  async createIssue(
    repo: string,
    issue: { title: string; body: string; labels: string[] },
  ): Promise<{ number: number; url: string }> {
    const created = await this.send(
      'POST',
      `projects/${projectId(repo)}/issues`,
      { title: issue.title, description: issue.body, labels: issue.labels.join(',') },
      z.object({ iid: z.number().int().positive(), web_url: z.string().min(1) }),
    );
    return { number: created.iid, url: created.web_url };
  }

  async editIssue(repo: string, number: number, edit: { body: string }): Promise<void> {
    await this.api('PUT', `projects/${projectId(repo)}/issues/${number}`, {
      description: edit.body,
    });
  }

  /** The https URL git reaches the project at. A path that is no project's fails here. */
  private gitUrl(repo: string): string {
    return `https://${this.host ?? DEFAULT_HOST}/${projectPath(repo)}.git`;
  }

  /**
   * git in the clone at `path`, talking to GitLab with glab as its only credential helper, so it
   * acts as the login glab keeps for the host and needs no SSH key. The empty helper first drops
   * every helper git's config names (an older login in the keychain would answer before glab);
   * the path of glab is quoted for the shell git runs the helper with. Of the two ways to give git
   * a token without writing it into its config, the helper rather than the token in GIT_CONFIG_*
   * variables: the token goes from glab to git through a pipe and never passes the Master, so it
   * is in no argument, environment, config file or error. No terminal prompt: without glab's
   * login git fails rather than waits for somebody to type a password. `failed`: the error's
   * text, before what git wrote to stderr.
   */
  private gitWithGlab(
    path: string,
    args: string[],
    failed: (detail: string) => string,
  ): Promise<string> {
    const all = [
      '-c',
      'credential.helper=',
      '-c',
      `credential.helper=!'${this.bin.replace(/'/g, `'\\''`)}' auth git-credential`,
      ...args,
    ];
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    return new Promise<string>((resolve, reject) => {
      execFile('git', all, { cwd: path, env }, (err, stdout, stderr) => {
        if (err) reject(new GlabError(failed(stderr.trim() || err.message)));
        else resolve(stdout.trim());
      });
    });
  }

  async push(
    path: string,
    repo: string,
    branch: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    if (opts.force && !forcePushable(branch)) throw forceRefused(branch);
    const url = this.gitUrl(repo);
    // A leading + lets this one ref replace what GitLab has; --force-with-lease would need a
    // remote-tracking ref, which a push to a URL does not have.
    const refspec = `${opts.force ? '+' : ''}refs/heads/${branch}:refs/heads/${branch}`;
    await this.gitWithGlab(path, ['push', '-q', url, refspec], (detail) =>
      t({
        zh: `推送 ${branch} 到 ${repo} 失败：${detail}`,
        en: `Pushing ${branch} to ${repo} failed: ${detail}`,
      }),
    );
  }

  async fetch(path: string, repo: string, branch: string): Promise<string | null> {
    const url = this.gitUrl(repo);
    const failed = (detail: string) =>
      t({
        zh: `从 ${repo} 拉取 ${branch} 失败：${detail}`,
        en: `Fetching ${branch} from ${repo} failed: ${detail}`,
      });
    const ref = `refs/heads/${branch}`;
    try {
      // Into FETCH_HEAD only: no ref of the clone changes, the caller decides what to move.
      await this.gitWithGlab(path, ['fetch', '-q', '--no-tags', url, ref], failed);
    } catch (err) {
      // Whether GitLab lacks the branch is asked of ls-remote rather than read from fetch's
      // message, which git may write in the system's language; only after a failure, so a
      // round still costs one request.
      let heads: string;
      try {
        heads = await this.gitWithGlab(path, ['ls-remote', '--heads', url, ref], failed);
      } catch {
        throw err;
      }
      if (heads === '') return null;
      throw err;
    }
    return this.gitWithGlab(path, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], failed);
  }
}
