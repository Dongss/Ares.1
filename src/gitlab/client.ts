import { execFile } from 'node:child_process';
import { z } from 'zod';
import { LABELS } from '../github/issues.js';
import {
  type ChangeRequest,
  type ChangeRequestStatus,
  type CodeHost,
  forcePushable,
  type HostAuthored,
  type HostCheck,
  type HostComment,
  type HostIssue,
  type HostReview,
  type LabelDef,
  type ReviewVerdict,
} from '../host/code-host.js';
import { t } from '../i18n.js';

/** A failure of glab or of GitLab, or what glab printed that cannot be read. */
export class GlabError extends Error {}

/** The most items a page of GitLab's REST API holds. */
const MAX_PAGE = 100;

/**
 * The most pages of a list the client reads: a project's labels, a merge request's discussions,
 * a pipeline's jobs. They have far fewer; the limit only keeps a server that ignores `page` from
 * being asked forever.
 */
const MAX_PAGES = 20;

/** The most review comments of a merge request the client gives: the latest. */
const MAX_REVIEW_COMMENTS = 100;

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

/**
 * An entry of a list, read with `schema`, or null for one that does not fit it: of a kind or a
 * status GitLab added later, or without a field the client needs. One such entry must not make a
 * whole merge request unreadable, which would keep its Run waiting for good, even once merged; it
 * is skipped rather than guessed at (a job of a status the client does not know taken for one
 * still running would keep a failed job from ever sending the Run back). Fields the schema does
 * not name are left out.
 */
function skippable<T>(schema: z.ZodType<T>): z.ZodType<T | null> {
  return z.preprocess(
    (entry) => (schema.safeParse(entry).success ? entry : null),
    schema.nullable(),
  );
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

/**
 * The GitLab the client talks to when it is given no host, glab and git alike. Named to glab too,
 * rather than left to glab's default (its config, GITLAB_HOST), which may be another GitLab than
 * the one git pushes to.
 */
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

/** An account as GitLab names it. */
const RawAccount = z.object({ id: z.number().int(), username: z.string() });

/** The author of an issue or a note; absent when GitLab gave none. */
const RawUser = RawAccount.nullish();
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

/** A merge request as GitLab returns it, listed or read alone. */
const RawMergeRequest = z.object({
  iid: z.number().int().positive(),
  web_url: z.string().min(1),
  /** locked: a merge is going on. */
  state: z.enum(['opened', 'locked', 'merged', 'closed']),
  source_branch: z.string(),
  target_branch: z.string(),
  /** The project of the source branch: a fork's when it differs from the target's. */
  source_project_id: z.number().int().nullish(),
  target_project_id: z.number().int().nullish(),
  /** The commit the source branch points at. */
  sha: z.string().nullish(),
  /** The merge commit; none when the project merges by fast-forward. */
  merge_commit_sha: z.string().nullish(),
  /** The squashed commit, when the merge squashed the changes. */
  squash_commit_sha: z.string().nullish(),
  /** Since GitLab 15.6: mergeable, conflict, checking, not_approved, ci_must_pass, ... */
  detailed_merge_status: z.string().nullish(),
  /** Older and deprecated: can_be_merged, cannot_be_merged, unchecked, checking, ... */
  merge_status: z.string().nullish(),
  has_conflicts: z.boolean().nullish(),
});
type RawMergeRequest = z.infer<typeof RawMergeRequest>;

/** detailed_merge_status values that say the merge request does not merge without conflicts. */
const CONFLICTING_STATUSES: readonly string[] = ['conflict', 'broken_status'];

/** detailed_merge_status values while GitLab has not worked out whether it merges yet. */
const UNCHECKED_STATUSES: readonly string[] = [
  'checking',
  'unchecked',
  'preparing',
  'approvals_syncing',
];

/** merge_status values, read when detailed_merge_status is absent, while not worked out yet. */
const UNCHECKED_MERGE_STATUSES: readonly string[] = [
  'checking',
  'unchecked',
  'cannot_be_merged_recheck',
];

/**
 * Whether the merge request merges without conflicts; null while GitLab is still working it out.
 * Only conflicts count: a merge request waiting for approvals or for its pipeline still merges
 * (those are told by the reviews and checks). Any status GitLab adds later is no conflict.
 */
function mergeable(raw: RawMergeRequest): boolean | null {
  if (raw.has_conflicts === true) return false;
  const detailed = raw.detailed_merge_status;
  if (detailed) {
    if (CONFLICTING_STATUSES.includes(detailed)) return false;
    return UNCHECKED_STATUSES.includes(detailed) ? null : true;
  }
  const status = raw.merge_status ?? '';
  if (status === 'cannot_be_merged') return false;
  return UNCHECKED_MERGE_STATUSES.includes(status) ? null : true;
}

/**
 * The merge request as the Master needs it. A locked one is still open: GitLab is merging it, and
 * it turns merged or back to opened. The commit the merge put on the target branch is the merge
 * commit, else the squashed commit (a squash merged by fast-forward), else the head itself (a
 * fast-forward merge without squashing).
 */
function fromRawMergeRequest(raw: RawMergeRequest): ChangeRequest {
  const merged = raw.state === 'merged';
  return {
    number: raw.iid,
    url: raw.web_url,
    state: merged ? 'merged' : raw.state === 'closed' ? 'closed' : 'open',
    mergeable: mergeable(raw),
    mergeCommit: merged ? raw.merge_commit_sha || raw.squash_commit_sha || raw.sha || null : null,
    headRefName: raw.source_branch,
    baseRefName: raw.target_branch,
  };
}

/** A merge request read alone, with what `getChangeRequest` needs besides the mapping. */
const RawMergeRequestStatus = RawMergeRequest.extend({
  /** The commit the source branch points at: the head. */
  sha: z.string().min(1),
  /**
   * The pipeline of the head, merged-results pipelines included; none before one runs, and none
   * when the project has no CI or the account may not see its pipelines.
   */
  head_pipeline: z.object({ id: z.number().int().positive() }).nullish(),
});

/** Who approved a merge request, as `merge_requests/:iid/approvals` lists them. */
const RawApprover = z.object({ user: RawAccount, approved_at: z.string().nullish() });

/**
 * What `merge_requests/:iid/approvals` says of a merge request. approvals_required and
 * approvals_left come with approval rules (GitLab Premium); without them nothing is required.
 */
const RawApprovals = z.object({
  approved: z.boolean().nullish(),
  approvals_required: z.number().int().nullish(),
  approvals_left: z.number().int().nullish(),
  approved_by: z.array(skippable(RawApprover)).nullish(),
});
type RawApprovals = z.infer<typeof RawApprovals>;

/**
 * A reviewer of a merge request as `merge_requests/:iid/reviewers` lists them. Their state:
 * unreviewed, review_started, reviewed, requested_changes, approved, unapproved, ...
 */
const RawReviewer = z.object({ user: RawAccount, state: z.string() });

/**
 * A note of a merge request's discussions that is on a line of its changes. The position says
 * where: new_path and new_line on the changed file, old_path and old_line on a line removed, and
 * head_sha the head the note was written on.
 */
const RawDiffNote = z.object({
  type: z.literal('DiffNote'),
  body: z.string().nullish(),
  author: RawUser,
  created_at: z.string().refine((at) => !Number.isNaN(Date.parse(at))),
  /** Written by GitLab itself, not by a person. */
  system: z.boolean().nullish(),
  /** Whether it can be resolved, and whether it was. */
  resolvable: z.boolean().nullish(),
  resolved: z.boolean().nullish(),
  position: z
    .object({
      new_path: z.string().nullish(),
      old_path: z.string().nullish(),
      new_line: z.number().int().nullish(),
      old_line: z.number().int().nullish(),
      head_sha: z.string().nullish(),
    })
    .refine((p) => Boolean(p.new_path || p.old_path)),
});
type RawDiffNote = z.infer<typeof RawDiffNote>;

/** A discussion of a merge request: a thread of notes, any note that is no DiffNote skipped. */
const RawDiscussion = z.object({ notes: z.array(skippable(RawDiffNote)) });

/** How a job of a pipeline stands, by its status. */
type JobOutcome = 'running' | 'passed' | 'failed';

/**
 * GitLab's statuses of a job by how it stands. A canceled job counts as failed, as its work was
 * not done. A manual job waiting for somebody to play it is running here; `jobOutcome` tells the
 * ones that may be left unplayed.
 */
const JOB_STATUSES: ReadonlyMap<string, JobOutcome> = new Map([
  ['created', 'running'],
  ['pending', 'running'],
  ['running', 'running'],
  ['preparing', 'running'],
  ['waiting_for_resource', 'running'],
  ['scheduled', 'running'],
  ['canceling', 'running'],
  ['waiting_for_callback', 'running'],
  ['success', 'passed'],
  ['skipped', 'passed'],
  ['manual', 'running'],
  ['failed', 'failed'],
  ['canceled', 'failed'],
]);

/** A job of a pipeline, of a status the client knows. */
const RawJob = z.object({
  name: z.string(),
  status: z.string().refine((status) => JOB_STATUSES.has(status)),
  /** A job that may fail: its failure fails nothing. */
  allow_failure: z.boolean().nullish(),
  web_url: z.string().nullish(),
});
type RawJob = z.infer<typeof RawJob>;

/**
 * A job as a check: GitLab's status kept, once it is done, as the conclusion. allow_failure
 * excuses a failure only: a canceled job's work was not done either way.
 */
function fromRawJob(raw: RawJob): HostCheck {
  const outcome = jobOutcome(raw);
  const done = outcome !== 'running';
  const allowed = raw.status === 'failed' && raw.allow_failure === true;
  return {
    name: raw.name,
    done,
    failed: outcome === 'failed' && !allowed,
    conclusion: done ? raw.status : null,
    url: raw.web_url || null,
  };
}

/**
 * How a job stands, by its status (`JOB_STATUSES`). A manual job that may fail (allow_failure,
 * as a `when: manual` job outside `rules` is by default) holds nothing up: the pipeline goes on
 * and finishes without it, so it counts as passed. A blocking one holds the pipeline up until
 * somebody plays it, so it is still running, never passed: taking it for passed would have the
 * Master think the CI passed when GitLab does not. A manual job GitLab does not say may fail is
 * taken for a blocking one.
 */
function jobOutcome(raw: RawJob): JobOutcome {
  if (raw.status === 'manual' && raw.allow_failure === true) return 'passed';
  return JOB_STATUSES.get(raw.status) ?? 'running';
}

/**
 * Where the merge request stands with its approvals: changes requested by any reviewer first;
 * else, when the project requires approvals, whether they were given; none required, no verdict.
 */
function reviewVerdict(approvals: RawApprovals, changesRequested: boolean): ReviewVerdict | null {
  if (changesRequested) return 'changes_requested';
  if ((approvals.approvals_required ?? 0) <= 0) return null;
  return approvals.approvals_left === 0 || approvals.approved === true
    ? 'approved'
    : 'review_required';
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * GitLab through the glab CLI, so the Master never stores a token: glab keeps it in its config.
 * Everything goes through `glab api` and GitLab's REST API; `repo` is a project's path, as
 * "group/subgroup/name", and the number of an issue or a merge request is its iid, the one in
 * its link. Every call goes to the GitLab `host` names (a self-hosted one), else to gitlab.com,
 * and git pushes to and fetches from that same GitLab over https. With `account`,
 * the client checks it is the account glab is logged in as. Authors (of issues, notes, approvals
 * and reviews) are trusted by their access level to the project (`gitlabAuthor`), which the client
 * asks GitLab for and keeps a few minutes.
 */
export class GlabCli implements CodeHost {
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
    const args = ['api', path, '-X', method, '--hostname', this.host ?? DEFAULT_HOST];
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

  /**
   * Every entry of the list at `path` (without a query), each read with `entry`: page after page
   * of the most entries a page holds, until a page is not full (or MAX_PAGES).
   */
  private async pages<T>(path: string, entry: z.ZodType<T>): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const found = await this.read(`${path}?per_page=${MAX_PAGE}&page=${page}`, z.array(entry));
      all.push(...found);
      if (found.length < MAX_PAGE) break;
    }
    return all;
  }

  /** The labels the project can use, its groups' labels included. */
  private projectLabels(project: string): Promise<RawLabel[]> {
    return this.pages(`projects/${project}/labels`, RawLabel);
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

  async findOpenChangeRequest(repo: string, head: string): Promise<ChangeRequest | null> {
    const project = projectId(repo);
    const path =
      `projects/${project}/merge_requests?state=opened` +
      `&source_branch=${encodeURIComponent(head)}&per_page=${MAX_PAGE}`;
    const found = await this.read(path, z.array(RawMergeRequest));
    // A fork's branch of the same name is not the Run's: only a merge request whose source is
    // the project itself counts, and only when GitLab says which projects both sides are of.
    const own = found.find(
      (m) =>
        m.source_branch === head &&
        typeof m.source_project_id === 'number' &&
        m.source_project_id === m.target_project_id,
    );
    return own ? fromRawMergeRequest(own) : null;
  }

  async createChangeRequest(
    repo: string,
    request: { head: string; base: string; title: string; body: string },
  ): Promise<{ number: number; url: string }> {
    // GitLab refuses a second open merge request of the branch into the same target: glab fails,
    // and so does this, with what it wrote.
    const created = await this.send(
      'POST',
      `projects/${projectId(repo)}/merge_requests`,
      {
        source_branch: request.head,
        target_branch: request.base,
        title: request.title,
        description: request.body,
      },
      z.object({ iid: z.number().int().positive(), web_url: z.string().min(1) }),
    );
    return { number: created.iid, url: created.web_url };
  }

  /**
   * The merge request with its approvals, the reviewers who asked for changes, its unresolved line
   * comments while it is open, and the jobs of its head pipeline. Approvals, reviewers, notes or
   * jobs of a kind, a state or a status the client does not know, or without the fields it needs,
   * are left out; the merge request itself must be read in full, and any call that fails fails
   * the whole read.
   */
  async getChangeRequest(repo: string, number: number): Promise<ChangeRequestStatus> {
    const project = projectId(repo);
    const path = `projects/${project}/merge_requests/${number}`;
    const raw = await this.read(path, RawMergeRequestStatus);
    const mr = fromRawMergeRequest(raw);
    const approvals = await this.read(`${path}/approvals`, RawApprovals);
    const reviewers = await this.read(`${path}/reviewers`, z.array(skippable(RawReviewer)));
    // What was said on the lines matters only while the work may still change.
    const notes = mr.state === 'open' ? await this.diffNotes(path) : [];
    // The jobs as they are now: a job retried counts by its latest run only (include_retried is
    // off by default).
    const jobs = raw.head_pipeline
      ? await this.pages(
          `projects/${project}/pipelines/${raw.head_pipeline.id}/jobs`,
          skippable(RawJob),
        )
      : [];

    const approvers = (approvals.approved_by ?? []).flatMap((a) => (a ? [a] : []));
    const asking = reviewers.flatMap((r) => (r?.state === 'requested_changes' ? [r] : []));
    // Everybody the merge request involves, asked about together.
    const authors = await this.authors(project, [
      ...approvers.map((a) => a.user),
      ...asking.map((r) => r.user),
      ...notes.map((n) => n.author),
    ]);
    const reviews: HostReview[] = [
      ...approvers.map((a) => ({
        ...authors(a.user),
        state: 'approved' as const,
        body: '',
        commit: null,
        submittedAt: a.approved_at || null,
      })),
      // GitLab gives a reviewer's state without the commit it was set on. It stands for the head
      // as it is now: the state holds until the reviewer changes it, and judgePullRequest acts
      // only on a request for changes on the head. A Run is sent back for it once per head; after
      // it pushes a new head, a reviewer who still asks for changes sends it back once more. So a
      // reviewer who never changes the state sends the Run back on every head it pushes, until
      // the template's limit on loops (max_loops, then on_exhausted) stops it: that limit, not a
      // check here, keeps it from going on for ever. Telling whether the reviewer looked at the
      // new head would take the time the state was set, which GitLab does not give.
      ...asking.map((r) => ({
        ...authors(r.user),
        state: 'changes_requested' as const,
        body: '',
        commit: raw.sha,
        submittedAt: null,
      })),
    ];
    return {
      ...mr,
      headRefOid: raw.sha,
      reviewVerdict: reviewVerdict(approvals, asking.length > 0),
      reviews,
      reviewComments: notes.map((n) => ({
        ...authors(n.author),
        body: n.body ?? '',
        path: n.position.new_path || n.position.old_path || '',
        line: n.position.new_line ?? n.position.old_line ?? null,
        commit: n.position.head_sha || null,
      })),
      checks: jobs.flatMap((j) => (j ? [fromRawJob(j)] : [])),
    };
  }

  /**
   * The comments on lines of the merge request's changes still to be resolved, people's only: the
   * latest (up to MAX_REVIEW_COMMENTS), oldest first. GitLab lists the discussions oldest first,
   * a page at a time, so all of them are read.
   */
  private async diffNotes(mrPath: string): Promise<RawDiffNote[]> {
    const discussions = await this.pages(`${mrPath}/discussions`, skippable(RawDiscussion));
    return discussions
      .flatMap((d) => d?.notes ?? [])
      .flatMap((n) =>
        n && n.resolvable === true && n.resolved !== true && n.system !== true ? [n] : [],
      )
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
      .slice(-MAX_REVIEW_COMMENTS);
  }

  async closeChangeRequest(repo: string, number: number, comment: string): Promise<void> {
    const path = `projects/${projectId(repo)}/merge_requests/${number}`;
    const raw = await this.read(path, RawMergeRequest);
    if (raw.state === 'closed') return;
    if (raw.state !== 'opened') {
      // Merged, or being merged (locked): GitLab would refuse to close it, after the comment.
      throw new GlabError(
        t({
          zh: `合并请求 !${number}（${repo}）已经合并或正在合并，不能关闭`,
          en: `Merge request !${number} of ${repo} is merged or being merged and cannot be closed`,
        }),
      );
    }
    await this.api('POST', `${path}/notes`, { body: comment });
    await this.api('PUT', path, { state_event: 'close' });
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
