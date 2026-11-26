import { execFile } from 'node:child_process';
import { z } from 'zod';
import type { CodeHost, LabelDef } from '../host/code-host.js';
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

/**
 * The project `repo` ("group/subgroup/.../name") as an API path takes it: one segment, every /
 * encoded. A path that is no project's fails here, before glab is called.
 */
function projectId(repo: string): string {
  if (!isProjectPath(repo)) {
    throw new GlabError(
      t({
        zh: `GitLab 项目路径应为 group/name 或 group/subgroup/name：${repo}`,
        en: `A GitLab project is named group/name or group/subgroup/name: ${repo}`,
      }),
    );
  }
  return encodeURIComponent(repo);
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

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * GitLab through the glab CLI, so the Master never stores a token: glab keeps it in its config.
 * Everything goes through `glab api` and GitLab's REST API; `repo` is a project's path, as
 * "group/subgroup/name", and the number of an issue or a merge request is its iid, the one in
 * its link. With `host`, every call goes to that GitLab (a self-hosted one), else to the one glab
 * picks. With `account`, the client checks it is the account glab is logged in as.
 */
export class GlabCli
  implements
    Pick<
      CodeHost,
      | 'resolveRepo'
      | 'viewer'
      | 'ensureLabels'
      | 'getLabels'
      | 'setLabels'
      | 'comment'
      | 'createIssue'
      | 'editIssue'
    >
{
  private readonly host: string | undefined;
  private readonly account: string | undefined;

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
}
