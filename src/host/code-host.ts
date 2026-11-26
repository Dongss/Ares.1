// What the Master does on a code host (GitHub, GitLab, ...), whatever the platform: the issues it
// takes requirements from and reports progress on, the change requests (pull requests, merge
// requests) it delivers Runs through, and the pushes and fetches of the repo's branches. Each
// platform's client implements CodeHost; the bridge and the scout depend on nothing else.

/**
 * Who wrote an issue, a comment or a review, which decides whether the Master trusts what it
 * says (`isTrusted`).
 */
export interface HostAuthored {
  /** Login of the author; null when the account was deleted. */
  author: string | null;
  /**
   * Whether the platform counts the author among the people who can change the repo anyway (on
   * GitHub: its owner, the members of its organization, its collaborators). Each client works it
   * out by its platform's rules; false when the platform does not say.
   */
  trusted: boolean;
  /**
   * The author's relation to the repo as the platform words it, to show to people (on GitHub
   * e.g. OWNER, CONTRIBUTOR or NONE); NONE when the platform gives none.
   */
  role: string;
}

export interface HostComment extends HostAuthored {
  body: string;
}

/** An issue as the Master needs it. */
export interface HostIssue extends HostAuthored {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  /** "completed" / "not_planned" for closed issues. */
  stateReason: string | null;
  labels: string[];
  url: string;
  /** The latest comments (up to 100), oldest first; only filled when asked for. */
  comments: HostComment[];
}

export interface LabelDef {
  name: string;
  color: string;
  description: string;
}

/** A change request (a pull request on GitHub) as the Master needs it, to deliver a Run. */
export interface ChangeRequest {
  number: number;
  url: string;
  /** merged: the host merged it into its base, whether by a merge, a squash or a rebase. */
  state: 'open' | 'merged' | 'closed';
  /** Whether it merges without conflicts; null while the host has not worked that out yet. */
  mergeable: boolean | null;
  /** The commit the merge put on the base branch; null unless merged. */
  mergeCommit: string | null;
  /** The branch with the changes. */
  headRefName: string;
  /** The branch it merges into. */
  baseRefName: string;
}

/** A review of a change request. */
export interface HostReview extends HostAuthored {
  /** As GitHub gives it: APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED or PENDING. */
  state: string;
  body: string;
  /** The commit it reviewed; null when the host gives none. */
  commit: string | null;
  /** When it was submitted (ISO 8601); null while pending. */
  submittedAt: string | null;
}

/** A review comment on a line of a change request's changes. */
export interface HostReviewComment extends HostAuthored {
  body: string;
  /** The file it is on. */
  path: string;
  /** The line it is on; null when the line is gone from the changes (outdated). */
  line: number | null;
  /** The commit it applies to; null when the host gives none. */
  commit: string | null;
}

/** A check of a change request's head commit: a CI job, a check run or a commit status. */
export interface HostCheck {
  name: string;
  /** Whether it has finished. */
  done: boolean;
  /**
   * How it finished, as GitHub gives it: SUCCESS, FAILURE, TIMED_OUT, CANCELLED,
   * ACTION_REQUIRED, STARTUP_FAILURE, ERROR, NEUTRAL, SKIPPED, ...; null while not done.
   */
  conclusion: string | null;
  /** Where to see it; null when the host gives no link. */
  url: string | null;
}

/** Where a change request stands with the reviews its base branch requires. */
export type ReviewDecision = 'CHANGES_REQUESTED' | 'APPROVED' | 'REVIEW_REQUIRED';

/** A change request with what was said and checked on it: whether it needs more work. */
export interface ChangeRequestStatus extends ChangeRequest {
  /** The commit its head branch points at. */
  headRefOid: string;
  /** null when the host gives none, as when the base branch requires no reviews. */
  reviewDecision: ReviewDecision | null;
  /** Oldest first. */
  reviews: HostReview[];
  /** The latest (up to 100), oldest first; always empty once merged or closed. */
  reviewComments: HostReviewComment[];
  /** The checks of its head commit. */
  checks: HostCheck[];
}

/** Only the Runs' own branches may be force-pushed: never a target branch or anybody else's. */
export function forcePushable(branch: string): boolean {
  return branch.startsWith('ares1/');
}

/**
 * What the Master does on a code host. `repo` is always the repo's id on the platform, as
 * `resolveRepo` gives it: "owner/name" on GitHub.
 */
export interface CodeHost {
  /** The id on the platform of the repo behind a local clone. */
  resolveRepo(path: string): Promise<string>;
  /** Login of the account the Master acts as. */
  viewer(): Promise<string>;
  /** Create the labels, or update their color and description. */
  ensureLabels(repo: string, labels: readonly LabelDef[]): Promise<void>;
  /** Newest first: one page, so at most `limit` and never more than 100. */
  listIssues(
    repo: string,
    query: { state: 'open' | 'closed'; label?: string; limit: number; comments?: boolean },
  ): Promise<HostIssue[]>;
  /**
   * Issues closed as not planned, newest first, with their comments: at most `limit`, over as
   * many pages as that takes.
   */
  listNotPlannedIssues(repo: string, query: { limit: number }): Promise<HostIssue[]>;
  createIssue(
    repo: string,
    issue: { title: string; body: string; labels: string[] },
  ): Promise<{ number: number; url: string }>;
  /** Replace the body of the issue. */
  editIssue(repo: string, number: number, edit: { body: string }): Promise<void>;
  /** The issue as it is now, without its comments. */
  getIssue(repo: string, number: number): Promise<HostIssue>;
  getLabels(repo: string, number: number): Promise<string[]>;
  /** Replace all labels of the issue. */
  setLabels(repo: string, number: number, labels: string[]): Promise<void>;
  comment(repo: string, number: number, body: string): Promise<void>;
  /** The latest comments of the issue (up to 100), oldest first. */
  listComments(repo: string, number: number): Promise<HostComment[]>;
  /** Close as completed (done) or as not planned. */
  close(repo: string, number: number, reason: 'completed' | 'not_planned'): Promise<void>;
  /**
   * Push `branch` of the local clone at `path` to the repo on the host, as the same account.
   * `force` replaces what the host has even when it is not a fast-forward (a Run's branch whose
   * history was rewritten, e.g. by a rollback); only for branches `forcePushable` allows, else
   * an error.
   */
  push(path: string, repo: string, branch: string, opts?: { force?: boolean }): Promise<void>;
  /** The open change request from `head`, a branch of `repo` itself; null when there is none. */
  findOpenChangeRequest(repo: string, head: string): Promise<ChangeRequest | null>;
  /** Open a change request from `head` into `base`, both branches of `repo`. */
  createChangeRequest(
    repo: string,
    request: { head: string; base: string; title: string; body: string },
  ): Promise<{ number: number; url: string }>;
  /** The change request as it is now, with its reviews and the checks of its head commit. */
  getChangeRequest(repo: string, number: number): Promise<ChangeRequestStatus>;
  /**
   * Close the open change request without merging it, with `comment` posted on it first, as it
   * is: the caller marks and redacts it. One already closed stays as it is, with no comment; one
   * already merged is an error.
   */
  closeChangeRequest(repo: string, number: number, comment: string): Promise<void>;
  /**
   * Fetch `branch` of the repo on the host into the local clone at `path`, as the same account,
   * and return the commit it points at. No ref of the clone moves; the commit's objects are in
   * it. null: the repo on the host has no such branch yet (e.g. a new, empty repo).
   */
  fetch(path: string, repo: string, branch: string): Promise<string | null>;
}
