import { execFile } from 'node:child_process';
import { t } from '../i18n.js';

/** Who wrote an issue or a comment, which decides whether the Master trusts what it says. */
export interface GhAuthored {
  /** Login of the author; null when the account was deleted. */
  author: string | null;
  /**
   * The author's relation to the repo, as GitHub gives it: OWNER, MEMBER, COLLABORATOR,
   * CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, FIRST_TIMER, MANNEQUIN or NONE.
   */
  authorAssociation: string;
}

export interface GhComment extends GhAuthored {
  body: string;
}

/** An issue as the Master needs it. */
export interface GhIssue extends GhAuthored {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  /** "completed" / "not_planned" for closed issues. */
  stateReason: string | null;
  labels: string[];
  url: string;
  /** The latest comments (up to 100), oldest first; only filled when asked for. */
  comments: GhComment[];
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
  /** Login of the account the Master acts as. */
  viewer(): Promise<string>;
  /** Create the labels, or update their color and description. */
  ensureLabels(repo: string, labels: readonly LabelDef[]): Promise<void>;
  /** Newest first: one page, so at most `limit` and never more than 100. */
  listIssues(
    repo: string,
    query: { state: 'open' | 'closed'; label?: string; limit: number; comments?: boolean },
  ): Promise<GhIssue[]>;
  /**
   * Issues closed as not planned, newest first, with their comments: at most `limit`, over as
   * many pages as that takes.
   */
  listNotPlannedIssues(repo: string, query: { limit: number }): Promise<GhIssue[]>;
  createIssue(
    repo: string,
    issue: { title: string; body: string; labels: string[] },
  ): Promise<{ number: number; url: string }>;
  /** The issue as it is now, without its comments. */
  getIssue(repo: string, number: number): Promise<GhIssue>;
  getLabels(repo: string, number: number): Promise<string[]>;
  /** Replace all labels of the issue. */
  setLabels(repo: string, number: number, labels: string[]): Promise<void>;
  comment(repo: string, number: number, body: string): Promise<void>;
  /** The latest comments of the issue (up to 100), oldest first. */
  listComments(repo: string, number: number): Promise<GhComment[]>;
  /** Close as completed (done) or as not planned. */
  close(repo: string, number: number, reason: 'completed' | 'not_planned'): Promise<void>;
  /** Push `branch` of the local clone at `path` to the GitHub repo, as the same account. */
  push(path: string, repo: string, branch: string): Promise<void>;
  /**
   * Fetch `branch` of the GitHub repo into the local clone at `path`, as the same account, and
   * return the commit it points at. No ref of the clone moves; the commit's objects are in it.
   * null: the GitHub repo has no such branch yet (e.g. a new, empty repo).
   */
  fetch(path: string, repo: string, branch: string): Promise<string | null>;
}

export class GhError extends Error {}

/** A comment as the GraphQL API returns it (see ISSUE_FRAGMENT). */
interface RawComment {
  body?: string | null;
  author?: { login: string } | null;
  authorAssociation?: string | null;
}

/** An issue as the GraphQL API returns it (see ISSUE_FRAGMENT). */
interface RawIssue extends RawComment {
  number: number;
  title: string;
  state: string;
  stateReason?: string | null;
  url: string;
  labels?: { nodes?: { name: string }[] | null } | null;
  comments?: { nodes?: RawComment[] | null } | null;
}

/**
 * The fields of an issue the Master reads. GraphQL, because `gh issue list/view --json` and the
 * REST API leave out how the author of an issue is related to the repo, which decides whether
 * the Master trusts what the issue says. The comments come only with `$withComments`.
 */
const ISSUE_FRAGMENT = `fragment issue on Issue {
  number title body state stateReason url
  author { login }
  authorAssociation
  labels(first: 100) { nodes { name } }
  comments(last: 100) @include(if: $withComments) {
    nodes { body author { login } authorAssociation }
  }
}`;

/** A page of a GraphQL search for issues (see ISSUE_FRAGMENT). */
interface SearchPage {
  pageInfo?: { hasNextPage: boolean; endCursor: string | null } | null;
  /** Results that are no issue (none with `is:issue`) come back as empty objects. */
  nodes?: (RawIssue | null)[] | null;
}

/** The most a GraphQL connection returns at once. */
const MAX_PAGE = 100;

function fromRawComment(c: RawComment): GhComment {
  return {
    body: c.body ?? '',
    author: c.author?.login ?? null,
    // Unknown counts as unrelated to the repo: never trusted.
    authorAssociation: c.authorAssociation ?? 'NONE',
  };
}

function fromRaw(i: RawIssue): GhIssue {
  return {
    ...fromRawComment(i),
    number: i.number,
    title: i.title,
    state: i.state.toLowerCase() === 'open' ? 'open' : 'closed',
    stateReason: i.stateReason ? i.stateReason.toLowerCase() : null,
    labels: (i.labels?.nodes ?? []).map((l) => l.name),
    url: i.url,
    comments: (i.comments?.nodes ?? []).map(fromRawComment),
  };
}

/** "owner/name" split for GraphQL. */
function repoParts(repo: string): { owner: string; name: string } {
  const [owner, name, ...rest] = repo.split('/');
  if (!owner || !name || rest.length > 0) {
    throw new GhError(
      t({ zh: `仓库名应为 owner/name：${repo}`, en: `A repo is named owner/name: ${repo}` }),
    );
  }
  return { owner, name };
}

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

  /** A GraphQL query; the request goes through stdin, so variables keep their JSON types. */
  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const out = await this.gh(['api', 'graphql', '--input', '-'], {
      stdin: JSON.stringify({ query, variables }),
    });
    let res: { data?: T | null; errors?: { message?: string }[] } | null;
    try {
      res = JSON.parse(out);
    } catch {
      // A proxy's HTML page or a gh warning instead of the answer: still a GitHub failure, so
      // callers that handle GhError keep working.
      throw new GhError(
        t({
          zh: `gh api graphql 返回的不是 JSON：${out.slice(0, 300)}`,
          en: `gh api graphql returned no JSON: ${out.slice(0, 300)}`,
        }),
      );
    }
    if (!res || res.errors?.length || !res.data) {
      const detail = res?.errors?.map((e) => e.message ?? '').join('; ') || out.slice(0, 300);
      throw new GhError(
        t({ zh: `gh api graphql 失败：${detail}`, en: `gh api graphql failed: ${detail}` }),
      );
    }
    return res.data;
  }

  private async issue(repo: string, number: number, withComments: boolean): Promise<GhIssue> {
    const data = await this.graphql<{ repository: { issue: RawIssue | null } | null }>(
      `query($owner: String!, $name: String!, $number: Int!, $withComments: Boolean!) {
        repository(owner: $owner, name: $name) { issue(number: $number) { ...issue } }
      }
      ${ISSUE_FRAGMENT}`,
      { ...repoParts(repo), number, withComments },
    );
    const raw = data.repository?.issue;
    if (!raw) {
      throw new GhError(
        t({ zh: `${repo} 没有 issue #${number}`, en: `${repo} has no issue #${number}` }),
      );
    }
    return fromRaw(raw);
  }

  async resolveRepo(path: string): Promise<string> {
    return this.gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
      cwd: path,
    });
  }

  async viewer(): Promise<string> {
    return this.gh(['api', 'user', '-q', '.login']);
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
    const data = await this.graphql<{ repository: { issues: { nodes: RawIssue[] } } | null }>(
      `query($owner: String!, $name: String!, $states: [IssueState!], $labels: [String!],
        $first: Int!, $withComments: Boolean!) {
        repository(owner: $owner, name: $name) {
          issues(first: $first, states: $states, labels: $labels,
            orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ...issue } }
        }
      }
      ${ISSUE_FRAGMENT}`,
      {
        ...repoParts(repo),
        states: [query.state.toUpperCase()],
        labels: query.label ? [query.label] : null,
        first: Math.min(Math.max(query.limit, 1), MAX_PAGE),
        withComments: query.comments === true,
      },
    );
    return (data.repository?.issues.nodes ?? []).map(fromRaw);
  }

  async listNotPlannedIssues(repo: string, query: { limit: number }): Promise<GhIssue[]> {
    const { owner, name } = repoParts(repo);
    const limit = Math.max(query.limit, 0);
    // A search, so that only these issues come with their comments, not every closed one.
    const q = `repo:${owner}/${name} is:issue is:closed reason:"not planned" sort:created-desc`;
    const found: GhIssue[] = [];
    let after: string | null = null;
    // The search returns only such issues, so the pages needed are known; one more covers the
    // few a stale search index may still list after they were reopened. Never page on and on.
    const maxPages = Math.ceil(limit / MAX_PAGE) + 1;
    for (let page = 0; page < maxPages && found.length < limit; page++) {
      const data: { search: SearchPage } = await this.graphql<{ search: SearchPage }>(
        `query($q: String!, $first: Int!, $after: String, $withComments: Boolean!) {
          search(query: $q, type: ISSUE, first: $first, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { ...issue }
          }
        }
        ${ISSUE_FRAGMENT}`,
        { q, first: Math.min(limit - found.length, MAX_PAGE), after, withComments: true },
      );
      for (const raw of data.search.nodes ?? []) {
        if (typeof raw?.number !== 'number') continue;
        const issue = fromRaw(raw);
        // Pages of a search can overlap when issues change meanwhile.
        const seen = found.some((i) => i.number === issue.number);
        if (!seen && issue.state === 'closed' && issue.stateReason === 'not_planned') {
          found.push(issue);
        }
      }
      const next = data.search.pageInfo;
      if (!next?.hasNextPage || !next.endCursor || next.endCursor === after) break;
      after = next.endCursor;
    }
    return found.slice(0, limit);
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

  async getIssue(repo: string, number: number): Promise<GhIssue> {
    return this.issue(repo, number, false);
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

  async listComments(repo: string, number: number): Promise<GhComment[]> {
    return (await this.issue(repo, number, true)).comments;
  }

  async close(repo: string, number: number, reason: 'completed' | 'not_planned'): Promise<void> {
    const flag = reason === 'not_planned' ? 'not planned' : 'completed';
    await this.gh(['issue', 'close', String(number), '-R', repo, '--reason', flag]);
  }

  /**
   * git in the clone at `path`, talking to GitHub with gh as the credential helper, so it acts
   * as the same account as everything else and needs no SSH key; the token only travels through
   * the environment, never in the arguments or the error. `failed`: the error's text, before
   * what git wrote to stderr.
   */
  private async gitWithGh(
    path: string,
    args: string[],
    failed: (detail: string) => string,
  ): Promise<string> {
    const env = await this.env();
    const all = [
      '-c',
      'credential.helper=',
      '-c',
      `credential.helper=!'${this.bin.replace(/'/g, `'\\''`)}' auth git-credential`,
      ...args,
    ];
    return new Promise<string>((resolve, reject) => {
      execFile('git', all, { cwd: path, env }, (err, stdout, stderr) => {
        if (err) reject(new GhError(failed(stderr.trim() || err.message)));
        else resolve(stdout.trim());
      });
    });
  }

  async push(path: string, repo: string, branch: string): Promise<void> {
    await this.gitWithGh(
      path,
      ['push', '-q', `https://github.com/${repo}.git`, `refs/heads/${branch}:refs/heads/${branch}`],
      (detail) =>
        t({
          zh: `推送 ${branch} 到 ${repo} 失败：${detail}`,
          en: `Pushing ${branch} to ${repo} failed: ${detail}`,
        }),
    );
  }

  async fetch(path: string, repo: string, branch: string): Promise<string | null> {
    const failed = (detail: string) =>
      t({
        zh: `从 ${repo} 拉取 ${branch} 失败：${detail}`,
        en: `Fetching ${branch} from ${repo} failed: ${detail}`,
      });
    const url = `https://github.com/${repo}.git`;
    const ref = `refs/heads/${branch}`;
    try {
      // Into FETCH_HEAD only: no ref of the clone changes, the caller decides what to move.
      await this.gitWithGh(path, ['fetch', '-q', '--no-tags', url, ref], failed);
    } catch (err) {
      // Whether GitHub lacks the branch is asked of ls-remote rather than read from fetch's
      // message, which git may write in the system's language; only after a failure, so a
      // round still costs one request.
      let heads: string;
      try {
        heads = await this.gitWithGh(path, ['ls-remote', '--heads', url, ref], failed);
      } catch {
        throw err;
      }
      if (heads === '') return null;
      throw err;
    }
    return this.gitWithGh(path, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], failed);
  }
}
