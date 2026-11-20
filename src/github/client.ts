import { execFile } from 'node:child_process';
import { t } from '../i18n.js';

/** An issue as the Master needs it. */
export interface GhIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  /** "completed" / "not_planned" for closed issues. */
  stateReason: string | null;
  labels: string[];
  url: string;
  /** Comment bodies, oldest first; only filled when asked for. */
  comments: string[];
}

/** Whether an issue is open, and why it was closed. */
export interface GhIssueState {
  state: 'open' | 'closed';
  /** "completed" / "not_planned" for closed issues. */
  stateReason: string | null;
}

export interface LabelDef {
  name: string;
  color: string;
  description: string;
}

/** What the Master does on GitHub. `repo` is always "owner/name". */
export interface GitHub {
  /** "owner/name" of the GitHub repo behind a local clone. */
  resolveRepo(path: string): Promise<string>;
  /** Create the labels, or update their color and description. */
  ensureLabels(repo: string, labels: readonly LabelDef[]): Promise<void>;
  listIssues(
    repo: string,
    query: { state: 'open' | 'closed'; label?: string; limit: number; comments?: boolean },
  ): Promise<GhIssue[]>;
  createIssue(
    repo: string,
    issue: { title: string; body: string; labels: string[] },
  ): Promise<{ number: number; url: string }>;
  /** Whether the issue is open or closed (and why). */
  getIssue(repo: string, number: number): Promise<GhIssueState>;
  getLabels(repo: string, number: number): Promise<string[]>;
  /** Replace all labels of the issue. */
  setLabels(repo: string, number: number, labels: string[]): Promise<void>;
  comment(repo: string, number: number, body: string): Promise<void>;
  /** Comment bodies of the issue, oldest first. */
  listComments(repo: string, number: number): Promise<string[]>;
  /** Close as completed (done) or as not planned. */
  close(repo: string, number: number, reason: 'completed' | 'not_planned'): Promise<void>;
  /** Push `branch` of the local clone at `path` to the GitHub repo, as the same account. */
  push(path: string, repo: string, branch: string): Promise<void>;
}

export class GhError extends Error {}

const TOKEN_TTL_MS = 10 * 60_000;

/**
 * GitHub through the gh CLI, so the Master never stores a token: gh keeps it in the keyring.
 * With `account`, every call acts as that gh account (`gh auth token --user`), whichever
 * account is active in gh.
 */
export class GhCli implements GitHub {
  private token: { value: string; at: number } | undefined;

  constructor(
    private readonly bin = 'gh',
    private readonly account?: string,
  ) {}

  private exec(
    args: string[],
    opts: { cwd?: string; stdin?: string; env?: NodeJS.ProcessEnv } = {},
  ) {
    return new Promise<string>((resolve, reject) => {
      const child = execFile(
        this.bin,
        args,
        { cwd: opts.cwd, env: opts.env ?? process.env, maxBuffer: 32 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const detail = stderr.trim() || err.message;
            const command = `gh ${args.slice(0, 2).join(' ')}`;
            reject(
              new GhError(
                t({ zh: `${command} 失败：${detail}`, en: `${command} failed: ${detail}` }),
              ),
            );
            return;
          }
          resolve(stdout.trim());
        },
      );
      if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
    });
  }

  private async env(): Promise<NodeJS.ProcessEnv> {
    if (!this.account) return process.env;
    if (!this.token || Date.now() - this.token.at > TOKEN_TTL_MS) {
      const value = await this.exec(['auth', 'token', '--user', this.account]);
      this.token = { value, at: Date.now() };
    }
    return { ...process.env, GH_TOKEN: this.token.value };
  }

  private async gh(args: string[], opts: { cwd?: string; stdin?: string } = {}): Promise<string> {
    return this.exec(args, { ...opts, env: await this.env() });
  }

  async resolveRepo(path: string): Promise<string> {
    return this.gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
      cwd: path,
    });
  }

  async ensureLabels(repo: string, labels: readonly LabelDef[]): Promise<void> {
    for (const l of labels) {
      await this.gh([
        'label',
        'create',
        l.name,
        '-R',
        repo,
        '--color',
        l.color,
        '--description',
        l.description,
        '--force',
      ]);
    }
  }

  async listIssues(
    repo: string,
    query: { state: 'open' | 'closed'; label?: string; limit: number; comments?: boolean },
  ): Promise<GhIssue[]> {
    const fields = ['number', 'title', 'body', 'state', 'stateReason', 'labels', 'url'];
    if (query.comments) fields.push('comments');
    const args = ['issue', 'list', '-R', repo, '--state', query.state];
    args.push('--limit', String(query.limit), '--json', fields.join(','));
    if (query.label) args.push('--label', query.label);
    const raw = JSON.parse(await this.gh(args)) as {
      number: number;
      title: string;
      body: string;
      state: string;
      stateReason?: string | null;
      labels: { name: string }[];
      url: string;
      comments?: { body: string }[];
    }[];
    return raw.map((i) => ({
      number: i.number,
      title: i.title,
      body: i.body ?? '',
      state: i.state.toLowerCase() === 'open' ? 'open' : 'closed',
      stateReason: i.stateReason ? i.stateReason.toLowerCase() : null,
      labels: i.labels.map((l) => l.name),
      url: i.url,
      comments: (i.comments ?? []).map((c) => c.body),
    }));
  }

  async createIssue(
    repo: string,
    issue: { title: string; body: string; labels: string[] },
  ): Promise<{ number: number; url: string }> {
    const args = ['issue', 'create', '-R', repo, '--title', issue.title, '--body-file', '-'];
    for (const label of issue.labels) args.push('--label', label);
    const url = (await this.gh(args, { stdin: issue.body })).split('\n').pop() ?? '';
    const number = Number(/\/issues\/(\d+)/.exec(url)?.[1]);
    if (!Number.isInteger(number)) {
      throw new GhError(
        t({
          zh: `gh issue create 没有返回 issue 链接：${url}`,
          en: `gh issue create returned no issue link: ${url}`,
        }),
      );
    }
    return { number, url };
  }

  async getIssue(repo: string, number: number): Promise<GhIssueState> {
    const raw = JSON.parse(
      await this.gh(['issue', 'view', String(number), '-R', repo, '--json', 'state,stateReason']),
    ) as { state: string; stateReason?: string | null };
    return {
      state: raw.state.toLowerCase() === 'open' ? 'open' : 'closed',
      stateReason: raw.stateReason ? raw.stateReason.toLowerCase() : null,
    };
  }

  async getLabels(repo: string, number: number): Promise<string[]> {
    const out = await this.gh(['api', `repos/${repo}/issues/${number}/labels`, '-q', '.[].name']);
    return out ? out.split('\n') : [];
  }

  async setLabels(repo: string, number: number, labels: string[]): Promise<void> {
    await this.gh(
      ['api', '-X', 'PUT', `repos/${repo}/issues/${number}/labels`, '--input', '-', '--silent'],
      { stdin: JSON.stringify({ labels }) },
    );
  }

  async comment(repo: string, number: number, body: string): Promise<void> {
    await this.gh(['issue', 'comment', String(number), '-R', repo, '--body-file', '-'], {
      stdin: body,
    });
  }

  async listComments(repo: string, number: number): Promise<string[]> {
    const raw = JSON.parse(
      await this.gh(['issue', 'view', String(number), '-R', repo, '--json', 'comments']),
    ) as { comments?: { body: string }[] };
    return (raw.comments ?? []).map((c) => c.body ?? '');
  }

  async close(repo: string, number: number, reason: 'completed' | 'not_planned'): Promise<void> {
    const flag = reason === 'not_planned' ? 'not planned' : 'completed';
    await this.gh(['issue', 'close', String(number), '-R', repo, '--reason', flag]);
  }

  async push(path: string, repo: string, branch: string): Promise<void> {
    const env = await this.env();
    // gh is the credential helper, so the push acts as the same account as everything else and
    // needs no SSH key; the token only travels through the environment.
    const args = [
      '-c',
      'credential.helper=',
      '-c',
      `credential.helper=!'${this.bin.replace(/'/g, `'\\''`)}' auth git-credential`,
      'push',
      '-q',
      `https://github.com/${repo}.git`,
      `refs/heads/${branch}:refs/heads/${branch}`,
    ];
    await new Promise<void>((resolve, reject) => {
      execFile('git', args, { cwd: path, env }, (err, _stdout, stderr) => {
        if (err) {
          const detail = stderr.trim() || err.message;
          reject(
            new GhError(
              t({
                zh: `推送 ${branch} 到 ${repo} 失败：${detail}`,
                en: `Pushing ${branch} to ${repo} failed: ${detail}`,
              }),
            ),
          );
        } else resolve();
      });
    });
  }
}
