import { execFile } from 'node:child_process';
import { z } from 'zod';
import {
  type ChangeRequest,
  type ChangeRequestStatus,
  type CodeHost,
  forcePushable,
  type HostAuthored,
  type HostCheck,
  type HostComment,
  type HostIssue,
  type HostReviewComment,
  type LabelDef,
  type ReviewDecision,
} from '../host/code-host.js';
import { t } from '../i18n.js';

/** A failure of gh or of GitHub, or what gh printed that cannot be read. */
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

function fromRawComment(c: RawComment): HostComment {
  return { body: c.body ?? '', ...authored(c.author?.login, c.authorAssociation) };
}

function fromRaw(i: RawIssue): HostIssue {
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

function fromRawPull(raw: RawPullRequest): ChangeRequest {
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
  } satisfies HostAuthored;
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

/** The fields `getChangeRequest` asks of `gh pr view --json` besides PR_FIELDS. */
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

function fromRawCheck(raw: RawCheck): HostCheck {
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
] satisfies ReviewDecision[];

function isReviewDecision(value: string | null | undefined): value is ReviewDecision {
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
export class GhCli implements CodeHost {
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

  private async issue(repo: string, number: number, withComments: boolean): Promise<HostIssue> {
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
  ): Promise<HostIssue[]> {
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

  async listNotPlannedIssues(repo: string, query: { limit: number }): Promise<HostIssue[]> {
    const { owner, name } = repoParts(repo);
    const limit = Math.max(query.limit, 0);
    // A search, so that only these issues come with their comments, not every closed one.
    const q = `repo:${owner}/${name} is:issue is:closed reason:"not planned" sort:created-desc`;
    const found: HostIssue[] = [];
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

  async getIssue(repo: string, number: number): Promise<HostIssue> {
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

  async listComments(repo: string, number: number): Promise<HostComment[]> {
    return (await this.issue(repo, number, true)).comments;
  }

  async close(repo: string, number: number, reason: 'completed' | 'not_planned'): Promise<void> {
    const flag = reason === 'not_planned' ? 'not planned' : 'completed';
    await this.gh(['issue', 'close', String(number), '-R', repo, '--reason', flag]);
  }

  async findOpenChangeRequest(repo: string, head: string): Promise<ChangeRequest | null> {
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

  async createChangeRequest(
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

  async getChangeRequest(repo: string, number: number): Promise<ChangeRequestStatus> {
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

  async closeChangeRequest(repo: string, number: number, comment: string): Promise<void> {
    // gh posts the comment, then closes; it refuses a merged pull request, and leaves one
    // already closed as it is, without the comment.
    await this.gh(['pr', 'close', String(number), '-R', repo, '--comment', comment]);
  }

  /**
   * The latest review comments (up to 100) of a pull request, oldest first. Through the REST
   * API: `gh pr view --json` has none of them.
   */
  private async reviewComments(repo: string, number: number): Promise<HostReviewComment[]> {
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
