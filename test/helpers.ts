import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FakeAdapter, type FakeContext, type FakeOutcome } from '../src/adapters/fake.js';
import type { GhComment, GhIssue, GitHub, LabelDef } from '../src/github/client.js';
import { Master, type MasterOptions } from '../src/master.js';
import type { Repo, Run, RunStatus } from '../src/store/types.js';

export function tmpDir(prefix = 'ares1-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

export function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A git repo on branch main with one commit. */
export function initRepo(): string {
  const dir = tmpDir('ares1-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  writeFile(join(dir, 'README.md'), '# test\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

export async function waitFor(
  check: () => boolean,
  what = 'condition',
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export const TEST_AGENTS_YAML = `
agents:
  coder:
    cli: fake
    model: coder
  coder2:
    cli: fake
    model: coder2
  reviewer:
    cli: fake
    model: reviewer
`;

export const TEST_WORKFLOW_YAML = `
id: dev
name: 测试流程
defaults:
  escalate:
    max_retries: 2
    on_agent_error: switch_agent
  max_loops: 3
stages:
  - id: implement
    name: 编码
    kind: agent
    agent: coder
  - id: review
    name: 评审
    kind: review
    agent: reviewer
    inputs: [diff]
    on_fail: implement
  - id: merge
    name: 合并
    kind: merge
    gate: true
    on_reject: implement
`;

/** TEST_AGENTS_YAML plus `assessor`, the agent of assess stages. */
export const ASSESS_AGENTS_YAML = `${TEST_AGENTS_YAML}
  assessor:
    cli: fake
    model: assessor
`;

/**
 * Requirement assessment → coding → review → merge (no approval, so a Run that goes ahead
 * completes on its own). Same id as TEST_WORKFLOW_YAML.
 */
export const ASSESS_WORKFLOW_YAML = `
id: dev
name: 测试流程
defaults:
  escalate:
    max_retries: 2
    on_agent_error: switch_agent
  max_loops: 3
stages:
  - id: assess
    name: 需求评估
    kind: assess
    agent: assessor
  - id: implement
    name: 编码
    kind: agent
    agent: coder
    inputs: [assessment]
  - id: review
    name: 评审
    kind: review
    agent: reviewer
    inputs: [diff, assessment]
    on_fail: implement
  - id: merge
    name: 合并
    kind: merge
    on_reject: implement
`;

/**
 * Run overrides that make an agent error of a stage wait for a human at once (no automatic
 * retries, no other agent), for tests about what a human does with a blocked Run.
 */
export const blockOnAgentError = (stage = 'implement') => ({
  stages: { [stage]: { escalate: { max_retries: 0, on_agent_error: 'human' } } },
});

export type Script = (ctx: FakeContext) => FakeOutcome | Promise<FakeOutcome>;

export const done = (summary = 'ok'): FakeOutcome => ({
  finalMessage: `完成。\n\`\`\`json\n${JSON.stringify({ status: 'done', summary })}\n\`\`\``,
});

export const review = (issues: { severity: 'must' | 'suggestion'; description: string }[] = []) =>
  ({
    finalMessage: `\`\`\`json\n${JSON.stringify({ summary: issues.length ? '有问题' : '没问题', issues })}\n\`\`\``,
  }) satisfies FakeOutcome;

/** What an assess stage's agent reports. */
export const assessment = (
  verdict: 'go' | 'ask' | 'drop',
  extra: {
    summary?: string;
    questions?: string[];
    suggestions?: string[];
    revisedGoal?: string;
  } = {},
): FakeOutcome => ({
  finalMessage: `\`\`\`json\n${JSON.stringify({
    verdict,
    summary: extra.summary ?? `评估结论：${verdict}`,
    questions: extra.questions ?? [],
    suggestions: extra.suggestions ?? [],
    ...(extra.revisedGoal ? { revisedGoal: extra.revisedGoal } : {}),
  })}\n\`\`\``,
});

export interface Harness {
  master: Master;
  repoDir: string;
  repo: Repo;
  home: string;
  /** Scripts per fake model; tests replace them freely. */
  scripts: Record<string, Script>;
  fake: FakeAdapter;
  run(goal?: string, overrides?: unknown): Run;
  waitStatus(runId: string, status: RunStatus, timeoutMs?: number): Promise<Run>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** agents.yaml content; defaults to TEST_AGENTS_YAML. */
  agents?: string;
  workflow?: string;
  verifyCommands?: string[];
  setupCommands?: string[];
  home?: string;
  repoDir?: string;
  scripts?: Record<string, Script>;
  /** Dashboard directory; defaults to an empty temp dir so tests never depend on a build. */
  webDir?: string;
  /** config.yaml content; omitted = the default written on first start. */
  config?: string;
  /** In-memory GitHub; the harness never polls it on a timer. */
  github?: GitHub;
  /** More Master options (the harness never runs the upgrade timer). */
  master?: Partial<MasterOptions>;
}

/** A Master on a temp home with fake agents (coder, coder2, reviewer) and one registered repo. */
export async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const home = opts.home ?? tmpDir('ares1-home-');
  writeFile(join(home, 'agents.yaml'), opts.agents ?? TEST_AGENTS_YAML);
  writeFile(join(home, 'workflows', 'dev.yaml'), opts.workflow ?? TEST_WORKFLOW_YAML);
  if (opts.config !== undefined) writeFile(join(home, 'config.yaml'), opts.config);
  const scripts: Record<string, Script> = opts.scripts ?? {
    coder: (ctx) => {
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return done('写了 feature.txt');
    },
    coder2: (ctx) => {
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return done('coder2 写了 feature.txt');
    },
    reviewer: () => review(),
  };
  const fake = new FakeAdapter((ctx) => {
    const script = scripts[ctx.input.model];
    if (!script) throw new Error(`no fake script for ${ctx.input.model}`);
    return script(ctx);
  });
  const master = await Master.open({
    home,
    adapters: [fake],
    webDir: opts.webDir ?? join(home, 'no-web'),
    github: opts.github,
    pollIssues: false,
    upgradeTimer: false,
    notice: () => {},
    // Retry an agent that errored right away.
    agentRetryBackoff: { firstMs: 0, maxMs: 0 },
    ...opts.master,
  });
  const repoDir = opts.repoDir ?? initRepo();
  const repo =
    master.store.findRepo('demo') ??
    master.store.createRepo({
      name: 'demo',
      path: repoDir,
      targetBranch: 'main',
      verifyCommands: opts.verifyCommands ?? ['grep -q ok feature.txt'],
      setupCommands: opts.setupCommands ?? [],
      mergeMode: 'direct',
    });
  return {
    master,
    repoDir,
    repo,
    home,
    scripts,
    fake,
    run: (goal = '添加 feature.txt', overrides?: unknown) =>
      master.engine.createRun({ repo: 'demo', template: 'dev', goal, overrides }),
    waitStatus: async (runId, status, timeoutMs) => {
      await waitFor(
        () => master.store.getRun(runId).status === status,
        `run ${runId} to become ${status} (now ${master.store.getRun(runId).status})`,
        timeoutMs,
      );
      return master.store.getRun(runId);
    },
    close: () => master.close(),
  };
}

/** Who wrote an issue or a comment on FakeGitHub. */
export interface FakeAuthor {
  login: string | null;
  /** GitHub's authorAssociation, e.g. OWNER or NONE. */
  association: string;
}

/** The owner of "me/demo"; the Master acts as this account unless a test says otherwise. */
export const OWNER: FakeAuthor = { login: 'me', association: 'OWNER' };

/** Somebody with no relation to the repo, as anybody on a public repo. */
export const STRANGER: FakeAuthor = { login: 'stranger', association: 'NONE' };

/**
 * An issue as FakeGitHub keeps it: the comment bodies as strings, so tests read and add them
 * directly, and who wrote each beside them.
 */
export interface FakeIssue extends Omit<GhIssue, 'comments'> {
  comments: string[];
  /** Authors of `comments` by index; a comment without one was written by OWNER. */
  commentAuthors: (FakeAuthor | undefined)[];
}

/** GitHub in memory: issues of one repo, "me/demo". */
export class FakeGitHub implements GitHub {
  readonly issues = new Map<number, FakeIssue>();
  readonly labelDefs = new Map<string, LabelDef>();
  /** Every call, e.g. "comment #3". */
  readonly calls: string[] = [];
  /** When set, every call throws this message. */
  failWith: string | null = null;
  /** The account the Master acts as: it writes the Master's comments and issues. */
  master: FakeAuthor = OWNER;
  private next = 1;

  private call(what: string): void {
    this.calls.push(what);
    if (this.failWith) throw new Error(this.failWith);
  }

  /** An issue written by a human, the repo's owner unless `author` says otherwise. */
  add(issue: { title: string; body?: string; labels?: string[]; author?: FakeAuthor }): FakeIssue {
    const number = this.next++;
    const author = issue.author ?? OWNER;
    const created: FakeIssue = {
      number,
      title: issue.title,
      body: issue.body ?? '',
      state: 'open',
      stateReason: null,
      labels: issue.labels ?? [],
      url: `https://github.com/me/demo/issues/${number}`,
      author: author.login,
      authorAssociation: author.association,
      comments: [],
      commentAuthors: [],
    };
    this.issues.set(number, created);
    return created;
  }

  /** A comment on issue #number written by `author`, as a human writes it on GitHub. */
  commentAs(number: number, author: FakeAuthor, body: string): void {
    const issue = this.get(number);
    issue.commentAuthors[issue.comments.length] = author;
    issue.comments.push(body);
  }

  get(number: number): FakeIssue {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`no issue #${number}`);
    return issue;
  }

  /** The issue as the GitHub client returns it, with or without its comments. */
  private view(issue: FakeIssue, withComments: boolean): GhIssue {
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      stateReason: issue.stateReason,
      labels: [...issue.labels],
      url: issue.url,
      author: issue.author,
      authorAssociation: issue.authorAssociation,
      comments: withComments ? this.commentsOf(issue) : [],
    };
  }

  private commentsOf(issue: FakeIssue): GhComment[] {
    return issue.comments.map((body, i) => {
      const author = issue.commentAuthors[i] ?? OWNER;
      return { body, author: author.login, authorAssociation: author.association };
    });
  }

  async resolveRepo(): Promise<string> {
    this.call('resolveRepo');
    return 'me/demo';
  }

  async viewer(): Promise<string> {
    this.call('viewer');
    if (!this.master.login) throw new Error('the Master has no login');
    return this.master.login;
  }

  async ensureLabels(_repo: string, labels: readonly LabelDef[]): Promise<void> {
    this.call('ensureLabels');
    for (const l of labels) this.labelDefs.set(l.name, l);
  }

  async listIssues(
    _repo: string,
    q: { state: 'open' | 'closed'; label?: string; limit: number; comments?: boolean },
  ): Promise<GhIssue[]> {
    this.call(`list ${q.state}${q.label ? ` ${q.label}` : ''}`);
    return [...this.issues.values()]
      .filter((i) => i.state === q.state && (!q.label || i.labels.includes(q.label)))
      .sort((a, b) => b.number - a.number)
      .slice(0, q.limit)
      .map((i) => this.view(i, q.comments === true));
  }

  async createIssue(
    _repo: string,
    issue: { title: string; body: string; labels: string[] },
  ): Promise<{ number: number; url: string }> {
    this.call(`create ${issue.title}`);
    const created = this.add({ ...issue, author: this.master });
    return { number: created.number, url: created.url };
  }

  async getIssue(_repo: string, number: number): Promise<GhIssue> {
    this.call(`getIssue #${number}`);
    return this.view(this.get(number), false);
  }

  async getLabels(_repo: string, number: number): Promise<string[]> {
    this.call(`getLabels #${number}`);
    return [...this.get(number).labels];
  }

  async setLabels(_repo: string, number: number, labels: string[]): Promise<void> {
    this.call(`setLabels #${number} ${labels.join(',')}`);
    this.get(number).labels = [...labels];
  }

  async comment(_repo: string, number: number, body: string): Promise<void> {
    this.call(`comment #${number}`);
    this.commentAs(number, this.master, body);
  }

  /** Branch heads pushed, in order. */
  readonly pushes: string[] = [];

  async push(path: string, _repo: string, branch: string): Promise<void> {
    this.call(`push ${branch}`);
    this.pushes.push(
      execFileSync('git', ['rev-parse', branch], { cwd: path, encoding: 'utf8' }).trim(),
    );
  }

  async listComments(_repo: string, number: number): Promise<GhComment[]> {
    this.call(`listComments #${number}`);
    return this.commentsOf(this.get(number));
  }

  async close(_repo: string, number: number, reason: 'completed' | 'not_planned'): Promise<void> {
    this.call(`close #${number} ${reason}`);
    const issue = this.get(number);
    issue.state = 'closed';
    issue.stateReason = reason;
  }
}
