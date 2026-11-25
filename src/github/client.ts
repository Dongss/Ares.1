import { execFile } from 'node:child_process';
import { z } from 'zod';
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

/** A pull request as the Master needs it, to deliver a Run through one. */
export interface GhPullRequest {
  number: number;
  url: string;
  /** merged: GitHub merged it into its base, whether by a merge, a squash or a rebase. */
  state: 'open' | 'merged' | 'closed';
  /** Whether it merges without conflicts; null while GitHub has not worked that out yet. */
  mergeable: boolean | null;
  /** The commit the merge put on the base branch; null unless merged. */
  mergeCommit: string | null;
  /** The branch with the changes. */
  headRefName: string;
  /** The branch it merges into. */
  baseRefName: string;
}

/** A review of a pull request. */
export interface GhReview extends GhAuthored {
  /** As GitHub gives it: APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED or PENDING. */
  state: string;
  body: string;
  /** The commit it reviewed; null when GitHub gives none. */
  commit: string | null;
  /** When it was submitted (ISO 8601); null while pending. */
  submittedAt: string | null;
}

/** A review comment on a line of a pull request's changes. */
export interface GhReviewComment extends GhAuthored {
  body: string;
  /** The file it is on. */
  path: string;
  /** The line it is on; null when the line is gone from the changes (outdated). */
  line: number | null;
  /** The commit it applies to; null when GitHub gives none. */
  commit: string | null;
}

/** A check of a pull request's head commit: a check run (e.g. CI) or a commit status. */
export interface GhCheck {
  name: string;
  /** Whether it has finished. */
  done: boolean;
  /**
   * How it finished, as GitHub gives it: SUCCESS, FAILURE, TIMED_OUT, CANCELLED,
   * ACTION_REQUIRED, STARTUP_FAILURE, ERROR, NEUTRAL, SKIPPED, ...; null while not done.
   */
  conclusion: string | null;
  /** Where to see it; null when GitHub gives no link. */
  url: string | null;
}

/** Where a pull request stands with the reviews its base branch requires. */
export type GhReviewDecision = 'CHANGES_REQUESTED' | 'APPROVED' | 'REVIEW_REQUIRED';

/** A pull request with what was said and checked on it: whether it needs more work. */
export interface GhPullRequestStatus extends GhPullRequest {
  /** The commit its head branch points at. */
  headRefOid: string;
  /** null when GitHub gives none, as when the base branch requires no reviews. */
  reviewDecision: GhReviewDecision | null;
  /** Oldest first. */
  reviews: GhReview[];
  /** The latest (up to 100), oldest first; always empty once merged or closed. */
  reviewComments: GhReviewComment[];
  /** The checks of its head commit. */
  checks: GhCheck[];
}

/** Only the Runs' own branches may be force-pushed: never a target branch or anybody else's. */
export function forcePushable(branch: string): boolean {
  return branch.startsWith('ares1/');
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
  /** Replace the body of the issue. */
  editIssue(repo: string, number: number, edit: { body: string }): Promise<void>;
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
  /**
   * Push `branch` of the local clone at `path` to the GitHub repo, as the same account. `force`
   * replaces what GitHub has even when it is not a fast-forward (a Run's branch whose history was
   * rewritten, e.g. by a rollback); only for branches `forcePushable` allows, else a GhError.
   */
  push(path: string, repo: string, branch: string, opts?: { force?: boolean }): Promise<void>;
  /** The open pull request from `head`, a branch of `repo` itself; null when there is none. */
  findOpenPullRequest(repo: string, head: string): Promise<GhPullRequest | null>;
  /** Open a pull request from `head` into `base`, both branches of `repo`. */
  createPullRequest(
    repo: string,
    pr: { head: string; base: string; title: string; body: string },
  ): Promise<{ number: number; url: string }>;
  /** The pull request as it is now, with its reviews and the checks of its head commit. */
  getPullRequest(repo: string, number: number): Promise<GhPullRequestStatus>;
  /**
   * Close the open pull request without merging it, with `comment` posted on it first, as it is:
   * the caller marks and redacts it. One already closed stays as it is, with no comment; one
   * already merged is a GhError.
   */
  closePullRequest(repo: string, number: number, comment: string): Promise<void>;
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
  return { body: c.body ?? '', ...authored(c.author?.login, c.authorAssociation) };
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

/** The fields of a pull request asked of `gh pr list/view --json` (see RawPullRequest). */
const PR_FIELDS =
  'number,url,state,mergeable,mergeCommit,headRefName,baseRefName,isCrossRepository';

/** A pull request as `gh pr list/view --json PR_FIELDS` prints it. */
const RawPullRequest = z.object({
  number: z.number().int().positive(),
  url: z.string().min(1),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  /** MERGEABLE, CONFLICTING or UNKNOWN (not worked out yet). */
  mergeable: z.string().nullish(),
  mergeCommit: z.object({ oid: z.string().min(1) }).nullish(),
  headRefName: z.string(),
  baseRefName: z.string(),
  /** From a fork: a branch of the same name there is not the Run's. */
  isCrossRepository: z.boolean().optional(),
});
type RawPullRequest = z.infer<typeof RawPullRequest>;

function fromRawPull(raw: RawPullRequest): GhPullRequest {
  return {
    number: raw.number,
    url: raw.url,
    state: raw.state === 'OPEN' ? 'open' : raw.state === 'MERGED' ? 'merged' : 'closed',
    mergeable:
      raw.mergeable === 'MERGEABLE' ? true : raw.mergeable === 'CONFLICTING' ? false : null,
    mergeCommit: raw.state === 'MERGED' ? (raw.mergeCommit?.oid ?? null) : null,
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName,
  };
}

/** Who wrote something, from the login and the relation to the repo GitHub gave. */
function authored(login: string | null | undefined, association: string | null | undefined) {
  return {
    // gh prints a deleted account as an empty login.
    author: login || null,
    // Unknown counts as unrelated to the repo: never trusted.
    authorAssociation: association || 'NONE',
  } satisfies GhAuthored;
}

/** What gh prints for a commit or an author that GitHub gave none of: null or empty fields. */
const RawCommit = z.object({ oid: z.string() }).nullish();
const RawAuthor = z.object({ login: z.string() }).nullish();

/** A review as `gh pr view --json reviews` prints it. */
const RawReview = z.object({
  author: RawAuthor,
  authorAssociation: z.string().nullish(),
  state: z.string().min(1),
  body: z.string().nullish(),
  commit: RawCommit,
  submittedAt: z.string().nullish(),
});

/** An entry of `gh pr view --json statusCheckRollup`: a check run or a commit status. */
const RawCheck = z.discriminatedUnion('__typename', [
  z.object({
    __typename: z.literal('CheckRun'),
    name: z.string(),
    /** QUEUED, IN_PROGRESS, COMPLETED, ... */
    status: z.string(),
    conclusion: z.string().nullish(),
    detailsUrl: z.string().nullish(),
  }),
  z.object({
    __typename: z.literal('StatusContext'),
    context: z.string(),
    /** EXPECTED, PENDING, SUCCESS, FAILURE or ERROR. */
    state: z.string(),
    targetUrl: z.string().nullish(),
  }),
]);
type RawCheck = z.infer<typeof RawCheck>;

/** The kinds of entry of `statusCheckRollup` that RawCheck reads. */
const CHECK_TYPES: readonly unknown[] = ['CheckRun', 'StatusContext'];

/**
 * An entry of `statusCheckRollup`, or null for one of a kind RawCheck does not know. GitHub may
 * add kinds at any time, and one it adds must not make the whole pull request unreadable: its Run
 * would wait for it for good, even once it is merged. Such an entry is skipped rather than taken
 * for a check not done yet, which would keep a failed check from ever sending the Run back
 * (`judgePullRequest` waits for every check to finish). An entry of a known kind that does not
 * fit still fails the read.
 */
const RawRollupEntry = z.preprocess(
  (entry) =>
    typeof entry === 'object' &&
    entry !== null &&
    CHECK_TYPES.includes((entry as { __typename?: unknown }).__typename)
      ? entry
      : null,
  RawCheck.nullable(),
);

/** The fields `getPullRequest` asks of `gh pr view --json` besides PR_FIELDS. */
const PR_STATUS_FIELDS = 'headRefOid,reviewDecision,reviews,statusCheckRollup';

/** A pull request as `gh pr view --json PR_FIELDS,PR_STATUS_FIELDS` prints it. */
const RawPullRequestStatus = RawPullRequest.extend({
  headRefOid: z.string().min(1),
  /** Empty when there is none. */
  reviewDecision: z.string().nullish(),
  reviews: z.array(RawReview).nullish(),
  statusCheckRollup: z.array(RawRollupEntry).nullish(),
});

/** Review comments as the REST API lists them (`GET /repos/{repo}/pulls/{n}/comments`). */
const RawReviewComments = z.array(
  z.object({
    user: RawAuthor,
    author_association: z.string().nullish(),
    path: z.string(),
    line: z.number().int().nullish(),
    body: z.string().nullish(),
    commit_id: z.string().nullish(),
  }),
);

function fromRawCheck(raw: RawCheck): GhCheck {
  if (raw.__typename === 'CheckRun') {
    const done = raw.status === 'COMPLETED';
    return {
      name: raw.name,
      done,
      conclusion: done ? raw.conclusion || null : null,
      url: raw.detailsUrl || null,
    };
  }
  const done = raw.state !== 'PENDING' && raw.state !== 'EXPECTED';
  return {
    name: raw.context,
    done,
    conclusion: done ? raw.state : null,
    url: raw.targetUrl || null,
  };
}

const REVIEW_DECISIONS: readonly string[] = [
  'CHANGES_REQUESTED',
  'APPROVED',
  'REVIEW_REQUIRED',
] satisfies GhReviewDecision[];

function isReviewDecision(value: string | null | undefined): value is GhReviewDecision {
  return typeof value === 'string' && REVIEW_DECISIONS.includes(value);
}

/**
 * What `command` printed as JSON, read with `schema`. Anything else (a proxy's HTML page, a gh
 * warning, fields of other types) is a GhError, naming the fields that did not fit, so callers
 * that handle GhError keep working.
 */
function parseOutput<T>(out: string, schema: z.ZodType<T>, command: string): T {
  let json: unknown;
  try {
    json = JSON.parse(out);
  } catch {
    throw new GhError(
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
    throw new GhError(
      t({
        zh: `${command} 返回的数据无法识别（${fields}）：${out.slice(0, 300)}`,
        en: `${command} returned data it cannot read (${fields}): ${out.slice(0, 300)}`,
      }),
    );
  }
  return parsed.data;
}

/** A GhError for a force push of a branch `forcePushable` does not allow. */
function forceRefused(branch: string): GhError {
  return new GhError(
    t({
      zh: `只能强制推送 ares1/ 开头的 Run 分支，不能强制推送 ${branch}`,
      en: `Only a Run's branch (ares1/...) may be force-pushed, not ${branch}`,
    }),
  );
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

  async editIssue(repo: string, number: number, edit: { body: string }): Promise<void> {
    await this.gh(['issue', 'edit', String(number), '-R', repo, '--body-file', '-'], {
      stdin: edit.body,
    });
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

  async findOpenPullRequest(repo: string, head: string): Promise<GhPullRequest | null> {
    const out = await this.gh([
      'pr',
      'list',
      '-R',
      repo,
      '--head',
      head,
      '--state',
      'open',
      '--json',
      PR_FIELDS,
      // --head matches the branch name only, so forks' branches of that name come too.
      '--limit',
      String(MAX_PAGE),
    ]);
    const pulls = parseOutput(out, z.array(RawPullRequest), 'gh pr list');
    const own = pulls.find((p) => p.isCrossRepository !== true && p.headRefName === head);
    return own ? fromRawPull(own) : null;
  }

  async createPullRequest(
    repo: string,
    pr: { head: string; base: string; title: string; body: string },
  ): Promise<{ number: number; url: string }> {
    const args = ['pr', 'create', '-R', repo, '--head', pr.head, '--base', pr.base];
    args.push('--title', pr.title, '--body-file', '-');
    const url = (await this.gh(args, { stdin: pr.body })).split('\n').pop() ?? '';
    const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
    if (!Number.isInteger(number)) {
      throw new GhError(
        t({
          zh: `gh pr create 没有返回 PR 链接：${url}`,
          en: `gh pr create returned no pull request link: ${url}`,
        }),
      );
    }
    return { number, url };
  }

  async getPullRequest(repo: string, number: number): Promise<GhPullRequestStatus> {
    const fields = `${PR_FIELDS},${PR_STATUS_FIELDS}`;
    const out = await this.gh(['pr', 'view', String(number), '-R', repo, '--json', fields]);
    const raw = parseOutput(out, RawPullRequestStatus, 'gh pr view');
    const pr = fromRawPull(raw);
    return {
      ...pr,
      headRefOid: raw.headRefOid,
      reviewDecision: isReviewDecision(raw.reviewDecision) ? raw.reviewDecision : null,
      reviews: (raw.reviews ?? []).map((r) => ({
        ...authored(r.author?.login, r.authorAssociation),
        state: r.state,
        body: r.body ?? '',
        commit: r.commit?.oid || null,
        submittedAt: r.submittedAt || null,
      })),
      // What was said on the lines matters only while the work may still change.
      reviewComments: pr.state === 'open' ? await this.reviewComments(repo, number) : [],
      checks: (raw.statusCheckRollup ?? []).flatMap((c) => (c ? [fromRawCheck(c)] : [])),
    };
  }

  async closePullRequest(repo: string, number: number, comment: string): Promise<void> {
    // gh posts the comment, then closes; it refuses a merged pull request, and leaves one
    // already closed as it is, without the comment.
    await this.gh(['pr', 'close', String(number), '-R', repo, '--comment', comment]);
  }

  /**
   * The latest review comments (up to 100) of a pull request, oldest first. Through the REST
   * API: `gh pr view --json` has none of them.
   */
  private async reviewComments(repo: string, number: number): Promise<GhReviewComment[]> {
    const path = `repos/${repo}/pulls/${number}/comments`;
    const out = await this.gh(['api', `${path}?per_page=100&sort=created&direction=desc`]);
    return parseOutput(out, RawReviewComments, `gh api ${path}`)
      .map((c) => ({
        ...authored(c.user?.login, c.author_association),
        body: c.body ?? '',
        path: c.path,
        line: c.line ?? null,
        commit: c.commit_id || null,
      }))
      .reverse();
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

  async push(
    path: string,
    repo: string,
    branch: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    if (opts.force && !forcePushable(branch)) throw forceRefused(branch);
    // A leading + lets this one ref replace what GitHub has; --force-with-lease would need a
    // remote-tracking ref, which a push to a URL does not have.
    const refspec = `${opts.force ? '+' : ''}refs/heads/${branch}:refs/heads/${branch}`;
    await this.gitWithGh(
      path,
      ['push', '-q', `https://github.com/${repo}.git`, refspec],
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
