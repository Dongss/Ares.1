import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TemplateSchema } from '../src/config/schema.js';
import { setLang } from '../src/i18n.js';
import { MIGRATIONS } from '../src/store/migrations.js';
import {
  type BackupRestore,
  backupRestoredNotice,
  KEEP_BACKUPS,
  NotFoundError,
  Store,
} from '../src/store/store.js';
import type { Attempt, IterationChild, Scout, ScoutProposal } from '../src/store/types.js';
import { type Harness, harness, tmpDir } from './helpers.js';

const template = TemplateSchema.parse({ id: 't', stages: [{ id: 'a', agent: 'x' }] });

function seed(store: Store) {
  const repo = store.createRepo({
    name: 'r',
    path: '/tmp/r',
    targetBranch: 'main',
    verifyCommands: ['npm test'],
    setupCommands: [],
    mergeMode: 'direct',
  });
  const mk = (goal: string) =>
    store.createRun({ repoId: repo.id, templateId: 't', template, goal, overrides: {} });
  return { repo, mk };
}

describe('store', () => {
  it('migrates a new database to the latest version without a backup', () => {
    const dir = tmpDir('ares1-db-');
    const file = join(dir, 'ares1.db');
    new Store(file).close();
    const db = new DatabaseSync(file);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      MIGRATIONS.length,
    );
    db.close();
    new Store(file).close(); // reopening is a no-op
    expect(readdirSync(dir).filter((f) => f.includes('.bak-'))).toEqual([]);
  });

  it('backs up an older database and adds model columns to existing attempts', () => {
    const dir = tmpDir('ares1-db-');
    const file = join(dir, 'ares1.db');
    const old = new DatabaseSync(file);
    old.exec(MIGRATIONS[0] as string);
    old.exec('PRAGMA user_version = 1');
    old.exec(`
      INSERT INTO repos (id, name, path, target_branch, created_at) VALUES ('r', 'r', '/r', 'main', 't');
      INSERT INTO runs (id, repo_id, template_id, template, goal, status, created_at, updated_at)
        VALUES ('run', 'r', 't', '{}', 'g', 'completed', 't', 't');
      INSERT INTO stage_runs (id, run_id, stage_id, round, status, started_at)
        VALUES ('sr', 'run', 'a', 1, 'passed', 't');
      INSERT INTO tasks (id, run_id, stage_run_id, seq, title, instructions, agent_id, status, created_at, updated_at)
        VALUES ('task', 'run', 'sr', 1, 't', 'i', 'x', 'passed', 't', 't');
      INSERT INTO attempts (id, task_id, run_id, seq, agent_id, status, prompt, log_path, started_at)
        VALUES ('att', 'task', 'run', 1, 'x', 'completed', 'p', '/l', 't');
    `);
    old.close();

    const store = new Store(file);
    // Recorded before models were tracked: unknown, not guessed from today's config.
    expect(store.getAttempt('att')).toMatchObject({
      agentId: 'x',
      model: null,
      actualModel: null,
      effort: null,
    });
    // Recorded before stages could be planned: every task was work.
    expect(store.getTask('task').kind).toBe('work');
    store.close();
    expect(readdirSync(dir).filter((f) => f.includes('.bak-v1-'))).toHaveLength(1);
  });

  it("keeps a scout's gap analysis, and has none for scouts recorded before there was one", () => {
    const dir = tmpDir('ares1-db-');
    const file = join(dir, 'ares1.db');
    const old = new DatabaseSync(file);
    for (const m of MIGRATIONS.slice(0, 6)) old.exec(m);
    old.exec('PRAGMA user_version = 6');
    old.exec(`
      INSERT INTO repos (id, name, path, target_branch, created_at) VALUES ('r', 'r', '/r', 'main', 't');
      INSERT INTO scouts (id, repo_id, issues_repo, trigger, status, agent_id, log_path, started_at)
        VALUES ('old', 'r', 'me/r', 'manual', 'completed', 's', '/l', 't');
    `);
    old.close();

    const store = new Store(file);
    expect(store.getScout('old')).toMatchObject({ proposals: [], gaps: null });
    const scout = store.createScout({
      repoId: 'r',
      issuesRepo: 'me/r',
      trigger: 'manual',
      agentId: 's',
      model: null,
      logPath: '/l',
    });
    // Not answered yet.
    expect(scout.gaps).toBeNull();
    const gaps = [
      { goal: '永动', gap: '同一时间只跑一个 Run', evidence: ['src/engine/engine.ts:421'] },
    ];
    store.updateScout(scout.id, { gaps });
    expect(store.getScout(scout.id).gaps).toEqual(gaps);
    // Found no gap: an empty analysis, not none.
    store.updateScout(scout.id, { gaps: [] });
    expect(store.getScout(scout.id).gaps).toEqual([]);
    store.close();
  });

  it('round-trips JSON and boolean columns', () => {
    const store = new Store(':memory:');
    const { repo, mk } = seed(store);
    expect(store.getRepo(repo.id).verifyCommands).toEqual(['npm test']);
    expect(store.findRepo('r')?.id).toBe(repo.id);
    const run = mk('g');
    expect(store.getRun(run.id).template).toEqual(template);
    store.updateRun(run.id, { blocked: { kind: 'error', message: 'x' } });
    expect(store.getRun(run.id).blocked).toEqual({ kind: 'error', message: 'x' });
    store.updateRun(run.id, { blocked: null });
    expect(store.getRun(run.id).blocked).toBeNull();
    const check = store.addCheck({
      runId: run.id,
      stageRunId: null,
      attemptId: null,
      kind: 'command',
      name: 'n',
      passed: true,
      detail: '',
    });
    expect(store.listChecks(run.id)[0]).toEqual(check);
  });

  it("keeps a Run's pull request in its own columns, none for Runs recorded before", () => {
    const dir = tmpDir('ares1-db-');
    const file = join(dir, 'ares1.db');
    const old = new DatabaseSync(file);
    for (const m of MIGRATIONS.slice(0, 9)) old.exec(m);
    old.exec('PRAGMA user_version = 9');
    old.exec(`
      INSERT INTO repos (id, name, path, target_branch, created_at) VALUES ('r', 'r', '/r', 'main', 't');
      INSERT INTO runs (id, repo_id, template_id, template, goal, status, created_at, updated_at)
        VALUES ('old', 'r', 't', '{}', 'g', 'completed', 't', 't');
    `);
    old.close();

    const store = new Store(file);
    const before = store.getRun('old');
    expect(before.pr).toBeNull();
    expect(Object.keys(before)).not.toContain('prNumber');
    expect(Object.keys(before)).not.toContain('prUrl');
    const run = store.createRun({
      repoId: 'r',
      templateId: 't',
      template,
      goal: 'g',
      overrides: {},
    });
    expect(store.getRun(run.id).pr).toBeNull();
    const pr = { number: 12, url: 'https://github.com/me/r/pull/12' };
    expect(store.updateRun(run.id, { pr }).pr).toEqual(pr);
    expect(store.listRuns().find((r) => r.id === run.id)?.pr).toEqual(pr);
    // Other changes leave it as it is.
    expect(store.updateRun(run.id, { goal: 'h' }).pr).toEqual(pr);
    expect(store.updateRun(run.id, { pr: null }).pr).toBeNull();
    store.close();
  });

  it('finds the Runs that ended unfinished with a pull request not settled yet', () => {
    const store = new Store(':memory:');
    const { repo, mk } = seed(store);
    const ended = (goal: string, status: 'failed' | 'cancelled' | 'dropped' | 'completed') => {
      const run = mk(goal);
      const pr = { number: goal.length, url: `https://github.com/me/r/pull/${goal.length}` };
      store.updateRun(run.id, { status, pr });
      return run;
    };
    const failed = ended('f', 'failed');
    const cancelled = ended('cc', 'cancelled');
    const dropped = ended('ddd', 'dropped');
    ended('done', 'completed');
    // Unfinished, or without a pull request: none of its business.
    store.updateRun(mk('waiting').id, {
      status: 'blocked',
      pr: { number: 9, url: 'https://github.com/me/r/pull/9' },
    });
    store.updateRun(mk('nopr').id, { status: 'failed' });
    const settled = ['github.pr_closed_by_master', 'github.pr_found_closed'];
    const ids = () => store.endedRunsWithPullRequest(repo.id, settled).map((r) => r.id);
    expect(ids()).toEqual([failed.id, cancelled.id, dropped.id]);

    store.event(cancelled.id, 'github.pr_found_closed', { state: 'merged' });
    store.event(failed.id, 'github.pr_rework', {});
    expect(ids()).toEqual([failed.id, dropped.id]);
    store.event(failed.id, 'github.pr_closed_by_master', { reason: 'failed' });
    expect(ids()).toEqual([dropped.id]);
    expect(store.endedRunsWithPullRequest('other', settled)).toEqual([]);
  });

  it('orders the queue; queueHead puts a run in front', () => {
    const store = new Store(':memory:');
    const { mk } = seed(store);
    const a = mk('a');
    const b = mk('b');
    expect(store.nextQueuedRun()?.id).toBe(a.id);
    store.updateRun(b.id, { queuePos: store.queueHead() });
    expect(store.nextQueuedRun()?.id).toBe(b.id);
  });

  it('rolls back a failed transaction and emits events', () => {
    const store = new Store(':memory:');
    const { mk } = seed(store);
    const run = mk('g');
    const seen: string[] = [];
    store.bus.on('event', (e) => seen.push(e.type));
    expect(() =>
      store.tx(() => {
        store.updateRun(run.id, { goal: 'changed' });
        throw new Error('nope');
      }),
    ).toThrow('nope');
    expect(store.getRun(run.id).goal).toBe('g');
    store.event(run.id, 'x', { a: 1 });
    expect(seen).toEqual(['x']);
    expect(store.listEvents(run.id)[0]?.data).toEqual({ a: 1 });
  });

  it('lists the global events of one type, oldest first', () => {
    const store = new Store(':memory:');
    const { mk } = seed(store);
    const run = mk('g');
    store.setWorking(false);
    store.event(null, 'master.restarted', {});
    // An event of a Run is not global, even of the same type.
    store.event(run.id, 'master.working', { on: true });
    store.setWorking(true);
    const switches = store.listGlobalEventsOfType('master.working');
    expect(switches.map((e) => [e.runId, e.data])).toEqual([
      [null, { on: false }],
      [null, { on: true }],
    ]);
    expect(switches[0]?.id).toBeLessThan(switches[1]?.id ?? 0);
    expect(store.listGlobalEventsOfType('nothing')).toEqual([]);
  });

  it('counts stage rounds and refuses to delete a repo with runs', () => {
    const store = new Store(':memory:');
    const { repo, mk } = seed(store);
    const run = mk('g');
    expect(store.createStageRun(run.id, 'a', null).round).toBe(1);
    expect(store.createStageRun(run.id, 'a', 'again').round).toBe(2);
    expect(store.countStageRounds(run.id, 'a')).toBe(2);
    expect(() => store.deleteRepo(repo.id)).toThrow(/还有 Run/);
  });

  it('sums attempts and scouts per agent, with the latest error', () => {
    const store = new Store(':memory:');
    const { repo, mk } = seed(store);
    const run = mk('g');
    const sr = store.createStageRun(run.id, 'a', null);
    const task = store.createTask({
      runId: run.id,
      stageRunId: sr.id,
      title: 't',
      instructions: 'i',
      agentId: 'a',
    });
    let n = 0;
    const attempt = (agentId: string, patch: Partial<Attempt>) => {
      n += 1;
      const id = `att-${n}`;
      store.createAttempt({
        id,
        taskId: task.id,
        runId: run.id,
        agentId,
        prompt: 'p',
        logPath: '/l',
        sessionId: null,
      });
      // Start times one minute apart, in creation order.
      const startedAt = new Date(Date.UTC(2026, 10, 19, 8, n)).toISOString();
      return store.updateAttempt(id, { startedAt, ...patch });
    };
    const long = `${'错'.repeat(150)}😀${'x'.repeat(100)}`;
    attempt('a', { status: 'completed', outcome: 'passed', costUsd: 0.1 });
    attempt('a', { status: 'completed', outcome: 'rework', costUsd: 0.2 });
    const failed = attempt('a', {
      status: 'failed',
      outcome: 'agent_error',
      error: `\n  ${long}\n`,
      endedAt: '2026-11-19T09:00:00.000Z',
    });
    // Ended by a human or a restart: counted, but its error is not the agent's latest error.
    attempt('a', { status: 'interrupted', error: 'Master 重启，执行被中断' });
    attempt('a', { status: 'stopped', costUsd: 0.05 });
    // An error of blank space only is no error.
    attempt('a', { status: 'completed', outcome: 'passed', costUsd: 0.1, error: ' \n\t' });
    // Running: neither an outcome nor an unknown cost yet.
    const running = attempt('a', {});
    attempt('b', { status: 'timeout', outcome: 'agent_error', error: '执行超时' });

    expect(store.agentAttemptTotals()).toEqual([
      {
        agentId: 'a',
        attempts: 7,
        passed: 2,
        rework: 1,
        agentError: 1,
        stopped: 2,
        costUsd: 0.45,
        // The agent error and the interrupted attempt; the stopped one reported its cost.
        costUnknown: 2,
        lastAt: running.startedAt,
        lastError: {
          attemptId: failed.id,
          runId: run.id,
          at: '2026-11-19T09:00:00.000Z',
          // 200 characters: the emoji counts as one and is not cut in half.
          message: `${'错'.repeat(150)}😀${'x'.repeat(49)}`,
          truncated: true,
        },
      },
      {
        agentId: 'b',
        attempts: 1,
        passed: 0,
        rework: 0,
        agentError: 1,
        stopped: 0,
        costUsd: 0,
        costUnknown: 1,
        lastAt: store.getAttempt('att-8').startedAt,
        lastError: {
          attemptId: 'att-8',
          runId: run.id,
          // No end recorded: its start.
          at: store.getAttempt('att-8').startedAt,
          message: '执行超时',
          truncated: false,
        },
      },
    ]);

    expect(store.agentScoutTotals()).toEqual([]);
    const scout = (agentId: string, patch: Partial<Scout>) => {
      const s = store.createScout({
        repoId: repo.id,
        issuesRepo: 'me/r',
        trigger: 'manual',
        agentId,
        model: 'm',
        logPath: '/l',
      });
      return store.updateScout(s.id, patch);
    };
    scout('s', { status: 'completed', costUsd: 0.3 });
    scout('s', { status: 'completed' });
    // Failed or interrupted before the agent finished: no cost to know of.
    scout('s', { status: 'failed' });
    const last = scout('s', { status: 'interrupted', costUsd: 0.1 });
    expect(store.agentScoutTotals()).toEqual([
      { agentId: 's', scouts: 4, costUsd: 0.4, costUnknown: 1, lastAt: last.startedAt },
    ]);
  });
});

describe('proposals of the local backlog', () => {
  afterEach(() => setLang('zh'));

  const proposed = (title: string, patch: Partial<ScoutProposal> = {}): ScoutProposal => ({
    title,
    category: 'feature',
    size: 'M',
    risk: 'low',
    why: `为什么要 ${title}`,
    evidence: ['README.md:1', 'src/a.ts:2'],
    what: `做 ${title}`,
    acceptance: ['能用', '有测试'],
    ...patch,
  });

  it('migrates a v10 database, keeping its scouts, and the scouts of local repos have no issues repo', () => {
    const dir = tmpDir('ares1-db-');
    const file = join(dir, 'ares1.db');
    const old = new DatabaseSync(file);
    for (const m of MIGRATIONS.slice(0, 10)) old.exec(m);
    old.exec('PRAGMA user_version = 10');
    old.exec(`
      INSERT INTO repos (id, name, path, target_branch, created_at) VALUES ('r', 'r', '/r', 'main', 't');
      INSERT INTO scouts (id, repo_id, issues_repo, trigger, status, agent_id, log_path, started_at)
        VALUES ('old', 'r', 'me/r', 'manual', 'completed', 's', '/l', 't');
    `);
    old.close();

    const store = new Store(file);
    expect(
      (store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    ).toBe(MIGRATIONS.length);
    expect(store.getScout('old')).toMatchObject({ issuesRepo: 'me/r', status: 'completed' });
    expect(store.listProposals()).toEqual([]);
    const scout = store.createScout({
      repoId: 'r',
      issuesRepo: '',
      trigger: 'auto',
      agentId: 's',
      model: null,
      logPath: '/l',
    });
    expect(store.getScout(scout.id).issuesRepo).toBe('');
    const p = store.createProposal({ ...proposed('a'), repoId: 'r', scoutId: scout.id });
    expect(store.getProposal(p.id)).toEqual(p);
    expect(
      store.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'proposals'")
        .all()
        .map((r) => (r as { name: string }).name),
    ).toContain('proposals_repo_status');
    store.close();
    expect(readdirSync(dir).filter((f) => f.includes('.bak-v10-'))).toHaveLength(1);
  });

  it('creates, reads back, decides and lists them by repo and status, newest first', () => {
    const store = new Store(':memory:');
    const { repo, mk } = seed(store);
    const other = store.createRepo({
      name: 'o',
      path: '/tmp/o',
      targetBranch: 'main',
      verifyCommands: [],
      setupCommands: [],
      mergeMode: 'direct',
    });

    // A ScoutProposal as it is: its issue, local and error are not columns.
    const a = store.createProposal({
      ...proposed('a', {
        issue: { number: 1, url: 'u', auto: false },
        local: { id: 'nope', auto: true },
        error: 'x',
      }),
      repoId: repo.id,
      scoutId: 'scout-1',
    });
    expect(a).toEqual({
      id: a.id,
      repoId: repo.id,
      scoutId: 'scout-1',
      title: 'a',
      category: 'feature',
      size: 'M',
      risk: 'low',
      why: '为什么要 a',
      evidence: ['README.md:1', 'src/a.ts:2'],
      what: '做 a',
      acceptance: ['能用', '有测试'],
      status: 'pending',
      rejectReason: null,
      auto: false,
      runId: null,
      iterationId: null,
      dependsOn: [],
      createdAt: a.createdAt,
      decidedAt: null,
    });
    expect(Object.keys(store.getProposal(a.id)).sort()).toEqual(Object.keys(a).sort());
    // JSON and boolean columns come back as they went in.
    expect(store.getProposal(a.id)).toEqual(a);

    const b = store.createProposal({
      ...proposed('b', { category: 'bug', size: 'L', risk: 'high', evidence: [], acceptance: [] }),
      repoId: repo.id,
      scoutId: null,
    });
    expect(store.getProposal(b.id)).toMatchObject({
      scoutId: null,
      category: 'bug',
      size: 'L',
      risk: 'high',
      evidence: [],
      acceptance: [],
    });
    const c = store.createProposal({ ...proposed('c'), repoId: other.id, scoutId: null });
    const d = store.createProposal({ ...proposed('d'), repoId: repo.id, scoutId: 'scout-2' });

    const run = mk('做 a');
    const accepted = store.updateProposal(a.id, {
      status: 'accepted',
      auto: true,
      runId: run.id,
      decidedAt: '2026-11-25T08:00:00.000Z',
    });
    expect(accepted).toMatchObject({
      status: 'accepted',
      auto: true,
      runId: run.id,
      decidedAt: '2026-11-25T08:00:00.000Z',
      rejectReason: null,
      title: 'a',
    });
    expect(store.getProposal(a.id)).toEqual(accepted);
    const rejected = store.updateProposal(b.id, {
      status: 'rejected',
      rejectReason: '不做：和 README 的目标无关',
      decidedAt: '2026-11-25T09:00:00.000Z',
    });
    expect(rejected).toMatchObject({ status: 'rejected', auto: false, runId: null });
    expect(store.getProposal(b.id).rejectReason).toBe('不做：和 README 的目标无关');
    // Back to false.
    expect(store.updateProposal(a.id, { auto: false }).auto).toBe(false);
    // Nothing to change is no change.
    expect(store.updateProposal(c.id, {})).toEqual(c);

    const ids = (list: { id: string }[]) => list.map((p) => p.id);
    expect(ids(store.listProposals())).toEqual([d.id, c.id, b.id, a.id]);
    expect(ids(store.listProposals({ repoId: repo.id }))).toEqual([d.id, b.id, a.id]);
    expect(ids(store.listProposals({ repoId: repo.id, status: 'pending' }))).toEqual([d.id]);
    expect(ids(store.listProposals({ status: 'pending' }))).toEqual([d.id, c.id]);
    expect(ids(store.listProposals({ status: 'rejected' }))).toEqual([b.id]);
    expect(ids(store.listProposals({ repoId: repo.id, status: ['pending', 'accepted'] }))).toEqual([
      d.id,
      a.id,
    ]);
    expect(store.listProposals({ status: [] })).toEqual([]);
    expect(ids(store.listProposals({ repoId: repo.id, limit: 2 }))).toEqual([d.id, b.id]);
    expect(store.listProposals({ repoId: 'nope' })).toEqual([]);
    // Listed as they are read one by one.
    expect(store.listProposals({ status: 'accepted' })).toEqual([store.getProposal(a.id)]);
  });

  it('finds the Runs of the proposals a repo accepted without a human since a time', () => {
    const store = new Store(':memory:');
    const { repo, mk } = seed(store);
    const accepted = (title: string, auto: boolean, repoId = repo.id) => {
      const p = store.createProposal({ ...proposed(title), repoId, scoutId: null });
      const run = mk(title);
      store.updateProposal(p.id, { status: 'accepted', auto, runId: run.id });
      return run;
    };
    const old = accepted('old', true);
    store.updateRun(old.id, { createdAt: '2026-11-24T08:00:00.000Z' });
    const auto = accepted('auto', true);
    accepted('by hand', false);
    // Pending, and accepted for another repo.
    store.createProposal({ ...proposed('pending'), repoId: repo.id, scoutId: null });
    const other = store.createRepo({
      name: 'o',
      path: '/tmp/o',
      targetBranch: 'main',
      verifyCommands: [],
      setupCommands: [],
      mergeMode: 'direct',
    });
    accepted('elsewhere', true, other.id);
    // A Run of no proposal.
    mk('plain');

    const since = '2026-11-25T00:00:00.000Z';
    expect(store.autoProposalRunsSince(repo.id, since).map((r) => r.id)).toEqual([auto.id]);
    expect(store.autoProposalRunsSince(repo.id, '1970-01-01T00:00:00.000Z')).toEqual([
      store.getRun(old.id),
      store.getRun(auto.id),
    ]);
    expect(store.autoProposalRunsSince('nope', since)).toEqual([]);
  });

  it('tells a proposal that does not exist, in both languages', () => {
    const store = new Store(':memory:');
    expect(() => store.getProposal('nope')).toThrow(NotFoundError);
    expect(() => store.getProposal('nope')).toThrow('提案 nope 不存在');
    expect(() => store.updateProposal('nope', { status: 'accepted' })).toThrow(NotFoundError);
    setLang('en');
    expect(() => store.getProposal('nope')).toThrow('Proposal nope not found');
    expect(() => store.updateProposal('nope', {})).toThrow('Proposal nope not found');
  });

  it('are deleted with their repo, and only theirs', () => {
    const store = new Store(':memory:');
    const { repo } = seed(store);
    const other = store.createRepo({
      name: 'o',
      path: '/tmp/o',
      targetBranch: 'main',
      verifyCommands: [],
      setupCommands: [],
      mergeMode: 'direct',
    });
    const scout = store.createScout({
      repoId: repo.id,
      issuesRepo: '',
      trigger: 'manual',
      agentId: 's',
      model: null,
      logPath: '/l',
    });
    store.createProposal({ ...proposed('a'), repoId: repo.id, scoutId: scout.id });
    const b = store.createProposal({ ...proposed('b'), repoId: repo.id, scoutId: scout.id });
    store.updateProposal(b.id, { status: 'rejected', rejectReason: 'no' });
    const kept = store.createProposal({ ...proposed('c'), repoId: other.id, scoutId: null });

    store.deleteRepo(repo.id);
    expect(store.findRepo(repo.id)).toBeUndefined();
    expect(store.listScouts({ repoId: repo.id })).toEqual([]);
    expect(store.listProposals({ repoId: repo.id })).toEqual([]);
    expect(store.listProposals()).toEqual([kept]);
  });
});

describe('iterations', () => {
  afterEach(() => setLang('zh'));

  const child = (position: number, patch: Partial<IterationChild> = {}): IterationChild => ({
    position,
    title: `第 ${position} 步`,
    category: 'feature',
    size: 'M',
    risk: 'low',
    why: '为什么',
    evidence: ['README.md:1'],
    what: '做什么',
    acceptance: ['能演示'],
    criteria: [1],
    dependsOn: position > 1 ? [position - 1] : [],
    closeout: false,
    status: 'planned',
    runIds: [],
    ...patch,
  });

  const planned = (repoId: string, scoutId: string | null, title = '本地仓库自己运转') => ({
    repoId,
    scoutId,
    source: 'github' as const,
    issuesRepo: 'me/r',
    title,
    goal: '不接 GitHub 的仓库也能自己提需求、开工和合并',
    readmeGoal: '永动',
    criteria: ['本地仓库能自动侦察', '提案能在看板上采纳'],
    outOfScope: ['GitLab'],
    children: [child(1), child(2), child(3, { closeout: true, dependsOn: [1, 2] })],
  });

  it('migrates a v11 database: its proposals belong to no iteration and depend on nothing', () => {
    const dir = tmpDir('ares1-db-');
    const file = join(dir, 'ares1.db');
    const old = new DatabaseSync(file);
    for (const m of MIGRATIONS.slice(0, 11)) old.exec(m);
    old.exec('PRAGMA user_version = 11');
    old.exec(`
      INSERT INTO repos (id, name, path, target_branch, created_at) VALUES ('r', 'r', '/r', 'main', 't');
      INSERT INTO proposals (id, repo_id, scout_id, title, category, size, risk, why, what, created_at)
        VALUES ('old', 'r', 's', 'a', 'feature', 'M', 'low', 'w', 'x', 't');
    `);
    old.close();

    const store = new Store(file);
    expect(
      (store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    ).toBe(MIGRATIONS.length);
    expect(store.getProposal('old')).toMatchObject({
      title: 'a',
      status: 'pending',
      iterationId: null,
      dependsOn: [],
    });
    expect(store.listIterations()).toEqual([]);
    expect(
      store.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'iterations'")
        .all()
        .map((r) => (r as { name: string }).name),
    ).toContain('iterations_repo_status');
    const it = store.createIteration(planned('r', 's'));
    expect(store.getIteration(it.id)).toEqual(it);
    store.close();
    expect(readdirSync(dir).filter((f) => f.includes('.bak-v11-'))).toHaveLength(1);
  });

  it('creates, reads back, updates and lists them by repo, status and scout, newest first', () => {
    const store = new Store(':memory:');
    const { repo } = seed(store);
    const other = store.createRepo({
      name: 'o',
      path: '/tmp/o',
      targetBranch: 'main',
      verifyCommands: [],
      setupCommands: [],
      mergeMode: 'direct',
    });

    const a = store.createIteration(planned(repo.id, 'scout-1', 'a'));
    expect(a).toEqual({
      id: a.id,
      repoId: repo.id,
      scoutId: 'scout-1',
      source: 'github',
      issuesRepo: 'me/r',
      issue: null,
      title: 'a',
      goal: '不接 GitHub 的仓库也能自己提需求、开工和合并',
      readmeGoal: '永动',
      criteria: ['本地仓库能自动侦察', '提案能在看板上采纳'],
      outOfScope: ['GitLab'],
      children: planned(repo.id, 'scout-1').children,
      notes: [],
      status: 'pending',
      auto: false,
      summaryPosted: false,
      summary: null,
      createdAt: a.createdAt,
      decidedAt: null,
      endedAt: null,
    });
    expect(a.id).toMatch(/^iteration-/);
    // JSON, boolean and split columns come back as they went in.
    expect(store.getIteration(a.id)).toEqual(a);
    expect(Object.keys(store.getIteration(a.id)).sort()).toEqual(Object.keys(a).sort());

    // Accepted on creation, in the local backlog.
    const b = store.createIteration({
      ...planned(repo.id, null, 'b'),
      source: 'local',
      issuesRepo: '',
      status: 'active',
      auto: true,
      decidedAt: '2026-11-25T08:00:00.000Z',
    });
    expect(store.getIteration(b.id)).toMatchObject({
      scoutId: null,
      source: 'local',
      issuesRepo: '',
      issue: null,
      status: 'active',
      auto: true,
      decidedAt: '2026-11-25T08:00:00.000Z',
    });
    const c = store.createIteration({
      ...planned(other.id, 'scout-1', 'c'),
      issue: { number: 7, url: 'https://github.com/me/r/issues/7' },
    });
    expect(store.getIteration(c.id).issue).toEqual({
      number: 7,
      url: 'https://github.com/me/r/issues/7',
    });
    const d = store.createIteration(planned(repo.id, 'scout-2', 'd'));

    // Children and notes change as the plan goes on.
    const children: IterationChild[] = a.children.map((ch) =>
      ch.position === 1
        ? { ...ch, status: 'done', issue: { number: 8, url: 'u8' }, runIds: ['run-1'] }
        : ch.position === 2
          ? { ...ch, status: 'failed', replacedBy: 4, runIds: ['run-2', 'run-3'] }
          : { ...ch, status: 'waiting' },
    );
    children.push(child(4, { status: 'ready', dependsOn: [1], proposalId: 'proposal-x' }));
    const updated = store.updateIteration(a.id, {
      issue: { number: 6, url: 'u6' },
      status: 'blocked',
      children,
      notes: [{ at: '2026-11-25T09:00:00.000Z', scoutId: 'scout-3', text: '第 2 步换个做法' }],
      decidedAt: '2026-11-25T08:30:00.000Z',
    });
    expect(updated).toMatchObject({
      issue: { number: 6, url: 'u6' },
      status: 'blocked',
      children,
      notes: [{ at: '2026-11-25T09:00:00.000Z', scoutId: 'scout-3', text: '第 2 步换个做法' }],
      title: 'a',
    });
    expect(store.getIteration(a.id)).toEqual(updated);
    const ended = store.updateIteration(a.id, {
      status: 'done',
      summaryPosted: true,
      summary: '做成了',
      endedAt: '2026-11-26T00:00:00.000Z',
    });
    expect(ended).toMatchObject({ status: 'done', summaryPosted: true, summary: '做成了' });
    // Back to false, and the issue back to none.
    expect(store.updateIteration(a.id, { summaryPosted: false, issue: null })).toMatchObject({
      summaryPosted: false,
      issue: null,
    });
    // Nothing to change is no change.
    expect(store.updateIteration(d.id, {})).toEqual(d);

    const ids = (list: { id: string }[]) => list.map((i) => i.id);
    expect(ids(store.listIterations())).toEqual([d.id, c.id, b.id, a.id]);
    expect(ids(store.listIterations({ repoId: repo.id }))).toEqual([d.id, b.id, a.id]);
    expect(ids(store.listIterations({ status: 'pending' }))).toEqual([d.id, c.id]);
    expect(ids(store.listIterations({ repoId: repo.id, status: ['active', 'done'] }))).toEqual([
      b.id,
      a.id,
    ]);
    expect(store.listIterations({ status: [] })).toEqual([]);
    expect(ids(store.listIterations({ scoutId: 'scout-1' }))).toEqual([c.id, a.id]);
    expect(ids(store.listIterations({ repoId: repo.id, scoutId: 'scout-1' }))).toEqual([a.id]);
    expect(ids(store.listIterations({ repoId: repo.id, limit: 2 }))).toEqual([d.id, b.id]);
    expect(store.listIterations({ repoId: 'nope' })).toEqual([]);
    // Listed as they are read one by one.
    expect(store.listIterations({ status: 'active' })).toEqual([store.getIteration(b.id)]);

    // An iteration never written out is forgotten, and only that one.
    store.deleteIteration(d.id);
    expect(ids(store.listIterations())).toEqual([c.id, b.id, a.id]);
    expect(() => store.getIteration(d.id)).toThrow(NotFoundError);
    store.deleteIteration('nope');
    expect(ids(store.listIterations())).toEqual([c.id, b.id, a.id]);
  });

  it('keeps the iteration of a local proposal and the proposals it depends on', () => {
    const store = new Store(':memory:');
    const { repo } = seed(store);
    const it = store.createIteration({
      ...planned(repo.id, null),
      source: 'local',
      issuesRepo: '',
    });
    const fields = {
      category: 'feature' as const,
      size: 'M' as const,
      risk: 'low' as const,
      why: 'w',
      evidence: [],
      what: 'x',
      acceptance: [],
      repoId: repo.id,
      scoutId: null,
    };
    const first = store.createProposal({ ...fields, title: '1', iterationId: it.id });
    const second = store.createProposal({
      ...fields,
      title: '2',
      iterationId: it.id,
      dependsOn: [first.id],
    });
    expect(store.getProposal(first.id)).toMatchObject({ iterationId: it.id, dependsOn: [] });
    expect(store.getProposal(second.id)).toMatchObject({
      iterationId: it.id,
      dependsOn: [first.id],
    });
    expect(store.updateProposal(second.id, { dependsOn: [] }).dependsOn).toEqual([]);
  });

  it('tells an iteration that does not exist, in both languages', () => {
    const store = new Store(':memory:');
    expect(() => store.getIteration('nope')).toThrow(NotFoundError);
    expect(() => store.getIteration('nope')).toThrow('迭代 nope 不存在');
    expect(() => store.updateIteration('nope', { status: 'done' })).toThrow(NotFoundError);
    setLang('en');
    expect(() => store.getIteration('nope')).toThrow('Iteration nope not found');
    expect(() => store.updateIteration('nope', {})).toThrow('Iteration nope not found');
  });

  it('are deleted with their repo, and only theirs', () => {
    const store = new Store(':memory:');
    const { repo } = seed(store);
    const other = store.createRepo({
      name: 'o',
      path: '/tmp/o',
      targetBranch: 'main',
      verifyCommands: [],
      setupCommands: [],
      mergeMode: 'direct',
    });
    store.createIteration(planned(repo.id, 's'));
    const kept = store.createIteration(planned(other.id, 's'));
    store.deleteRepo(repo.id);
    expect(store.listIterations({ repoId: repo.id })).toEqual([]);
    expect(store.listIterations()).toEqual([kept]);
  });
});

describe('old backups taken before migrations', () => {
  afterEach(() => setLang('zh'));

  const CJK = /[　-〿一-鿿＀-￯]/;
  const BACKUP = /^ares1\.db\.bak-v\d+-/;

  /** A database of version 1, which the Store migrates and backs up. */
  function oldDatabase(file: string) {
    const db = new DatabaseSync(file);
    db.exec(MIGRATIONS[0] as string);
    db.exec('PRAGMA user_version = 1');
    db.close();
  }

  /**
   * Seven earlier backups. Their times in the name, oldest first, differ from both name order
   * (v10 < v2 < v9) and modification order (the oldest was touched last).
   */
  function earlierBackups(dir: string) {
    const names = [
      'ares1.db.bak-v9-2026-11-01T08-00-00-000Z',
      'ares1.db.bak-v2-2026-11-02T08-00-00-000Z',
      'ares1.db.bak-v3-2026-11-03T08-00-00-000Z',
      'ares1.db.bak-v4-2026-11-04T08-00-00-000Z',
      'ares1.db.bak-v5-2026-11-05T08-00-00-000Z',
      'ares1.db.bak-v6-2026-11-06T08-00-00-000Z',
      'ares1.db.bak-v10-2026-11-07T08-00-00-000Z',
    ];
    names.forEach((name, i) => {
      const path = join(dir, name);
      writeFileSync(path, 'an old backup');
      const time = new Date(Date.UTC(2026, 10, 20 - i));
      utimesSync(path, time, time);
    });
    return names;
  }

  /** Names beside the database that are not its backups, however much they look like one. */
  const OTHERS = [
    'ares1.db.bak-v3-2026-10-01T08-00-00-000Z-wal',
    'ares1.db.bak-v3-2026-10-01T08-00-00-000Z.copy',
    'ares1.db.bak-v3-before-the-fix',
    'ares1.db.bak-v-2026-10-01T08-00-00-000Z',
    'ares1.db.newer-v99-2026-10-01T08-00-00-000Z',
    'ares1.db.restoring-2026-10-01T08-00-00-000Z',
    'ares1xdb.bak-v3-2026-10-01T08-00-00-000Z',
    'other.db.bak-v3-2026-10-01T08-00-00-000Z',
    'my-ares1.db.bak-v3-2026-10-01T08-00-00-000Z',
    'notes.txt',
  ];

  it(`keeps only the newest ${KEEP_BACKUPS}, the new one included, and nothing else is touched`, () => {
    const dir = tmpDir('ares1-db-');
    const file = join(dir, 'ares1.db');
    oldDatabase(file);
    const earlier = earlierBackups(dir);
    for (const name of OTHERS) writeFileSync(join(dir, name), 'not a backup');

    const warn = vi.spyOn(console, 'warn');
    try {
      new Store(file).close();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }

    const files = readdirSync(dir);
    const backups = files.filter((f) => BACKUP.test(f) && !OTHERS.includes(f));
    const fresh = backups.filter((f) => !earlier.includes(f));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatch(/^ares1\.db\.bak-v1-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/);
    expect(backups.sort()).toEqual([...fresh, ...earlier.slice(-(KEEP_BACKUPS - 1))].sort());
    for (const name of OTHERS) expect(files).toContain(name);
  });

  it('keeps the new one even when the clock says the others are newer', () => {
    const dir = tmpDir('ares1-db-');
    const file = join(dir, 'ares1.db');
    oldDatabase(file);
    const future = Array.from(
      { length: 6 },
      (_, i) => `ares1.db.bak-v1-2999-01-0${i + 1}T00-00-00-000Z`,
    );
    for (const name of future) writeFileSync(join(dir, name), 'an old backup');

    new Store(file).close();
    const backups = readdirSync(dir).filter((f) => BACKUP.test(f));
    expect(backups).toHaveLength(KEEP_BACKUPS);
    expect(backups.filter((f) => !future.includes(f))).toHaveLength(1);
  });

  it('leaves them alone when nothing is migrated', () => {
    const dir = tmpDir('ares1-db-');
    const file = join(dir, 'ares1.db');
    const earlier = earlierBackups(dir);
    const warn = vi.spyOn(console, 'warn');
    try {
      // A new database is not backed up, nor is one already at the latest version.
      new Store(file).close();
      new Store(file).close();
      // Neither is a database in memory.
      new Store(':memory:').close();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    expect(
      readdirSync(dir)
        .filter((f) => BACKUP.test(f))
        .sort(),
    ).toEqual([...earlier].sort());
  });

  it('only warns when one cannot be deleted, and deletes the rest', () => {
    for (const lang of ['zh', 'en'] as const) {
      setLang(lang);
      const dir = tmpDir('ares1-db-');
      const file = join(dir, 'ares1.db');
      oldDatabase(file);
      const earlier = earlierBackups(dir);
      // Named like the oldest backup, but a directory with a file in it: deleting it fails.
      const stuck = 'ares1.db.bak-v1-2026-10-01T08-00-00-000Z';
      mkdirSync(join(dir, stuck));
      writeFileSync(join(dir, stuck, 'inside'), 'x');

      const printed: string[] = [];
      const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        printed.push(args.map(String).join(' '));
      });
      try {
        new Store(file).close();
      } finally {
        warn.mockRestore();
      }

      expect(printed).toHaveLength(1);
      expect(printed[0]).toContain(join(dir, stuck));
      if (lang === 'zh') expect(printed[0]).toContain('删除旧的迁移前备份');
      else expect(printed[0]).not.toMatch(CJK);
      const files = readdirSync(dir);
      expect(files).toContain(stuck);
      const backups = files.filter((f) => BACKUP.test(f) && f !== stuck);
      expect(backups).toHaveLength(KEEP_BACKUPS);
      expect(backups).toEqual(expect.arrayContaining(earlier.slice(-(KEEP_BACKUPS - 1))));
      // The database opens as usual.
      const store = new Store(file);
      expect(store.listRepos()).toEqual([]);
      store.close();
    }
  });
});

describe('a database written by a newer Master', () => {
  afterEach(() => setLang('zh'));

  const N = MIGRATIONS.length;
  const CJK = /[　-〿一-鿿＀-￯]/;

  function addRepo(store: Store, name: string) {
    store.createRepo({
      name,
      path: `/tmp/${name}`,
      targetBranch: 'main',
      verifyCommands: [],
      setupCommands: [],
      mergeMode: 'direct',
    });
  }

  /** A database of this version with these repos, closed. */
  function current(file: string, ...repos: string[]) {
    const store = new Store(file);
    for (const name of repos) addRepo(store, name);
    store.close();
  }

  function vacuumInto(file: string, to: string) {
    const db = new DatabaseSync(file);
    db.exec(`VACUUM INTO '${to}'`);
    db.close();
  }

  /** Version and repos of a database file, read without the Store. */
  function inspect(file: string) {
    const db = new DatabaseSync(file);
    try {
      return {
        version: (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        repos: (db.prepare('SELECT name FROM repos ORDER BY name').all() as { name: string }[]).map(
          (r) => r.name,
        ),
      };
    } finally {
      db.close();
    }
  }

  /**
   * A newer Master migrates the database past this version, adds repo `newer` and crashes with
   * those writes still in the WAL.
   */
  function migrateAndCrash(file: string) {
    const scratch = join(tmpDir('ares1-crash-'), 'ares1.db');
    copyFileSync(file, scratch);
    const store = new Store(scratch);
    store.db.exec('PRAGMA wal_autocheckpoint = 0');
    addRepo(store, 'newer');
    store.db.exec(`PRAGMA user_version = ${N + 1}`);
    for (const suffix of ['', '-wal', '-shm']) copyFileSync(scratch + suffix, file + suffix);
    store.close();
  }

  function openError(file: string): Error | null {
    try {
      new Store(file).close();
      return null;
    } catch (err) {
      return err as Error;
    }
  }

  it('puts back the newest backup taken before it was migrated past this version', () => {
    const dir = tmpDir('ares1-db-');
    const file = join(dir, 'ares1.db');
    current(file, 'kept');
    vacuumInto(file, `${file}.bak-v${N}-2026-11-19T08-00-00-000Z`);
    current(file, 'later');
    const backup = `${file}.bak-v${N}-2026-11-20T08-00-00-000Z`;
    vacuumInto(file, backup);
    // Names that sort after it but are not backups of this version.
    writeFileSync(`${backup}-wal`, 'not a backup');
    writeFileSync(`${file}.bak-v${N}0-2026-11-21T08-00-00-000Z`, 'not a backup');
    migrateAndCrash(file);
    expect(existsSync(`${file}-wal`)).toBe(true);

    const store = new Store(file);
    expect(store.findRepo('kept')).toBeDefined();
    expect(store.findRepo('later')).toBeDefined();
    // Neither the newer database nor its WAL left behind under the name.
    expect(store.findRepo('newer')).toBeUndefined();
    const restored = store.restoredBackup as BackupRestore;
    expect(restored).toEqual({
      backup,
      movedTo: expect.stringMatching(/\.newer-v\d+-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/),
      fromVersion: N + 1,
      toVersion: N,
    });
    expect(restored.movedTo.startsWith(`${file}.newer-v${N + 1}-`)).toBe(true);
    expect(store.listEventsOfType('store.backup_restored', '').map((e) => e.data)).toEqual([
      { ...restored },
    ]);
    store.close();

    const files = readdirSync(dir);
    expect(files).not.toContain('ares1.db-wal');
    expect(files).not.toContain('ares1.db-shm');
    expect(files.filter((f) => f.includes('.restoring-'))).toEqual([]);
    expect(existsSync(backup)).toBe(true);
    // The newer database is all there, its last writes included.
    expect(inspect(restored.movedTo)).toEqual({
      version: N + 1,
      repos: ['kept', 'later', 'newer'],
    });

    // Opening it again is as usual.
    const again = new Store(file);
    expect(again.restoredBackup).toBeNull();
    expect(again.findRepo('later')).toBeDefined();
    expect(again.listEventsOfType('store.backup_restored', '')).toHaveLength(1);
    again.close();
    expect(readdirSync(dir).filter((f) => f.includes('.newer-v'))).toHaveLength(1);
  });

  it('refuses it, leaving the files as they were, without a backup of exactly this version', () => {
    const dir = tmpDir('ares1-db-');
    const file = join(dir, 'ares1.db');
    current(file, 'kept');
    vacuumInto(file, `${file}.bak-v1-2026-11-20T08-00-00-000Z`);
    vacuumInto(file, `${file}.bak-v${N}0-2026-11-20T08-00-00-000Z`);
    const store = new Store(file);
    addRepo(store, 'newer');
    store.db.exec(`PRAGMA user_version = ${N + 1}`);
    store.close();
    const files = readdirSync(dir).sort();
    const bytes = readFileSync(file);

    const err = openError(file);
    expect(err?.message).toMatch(/比当前 Master 支持的/);
    expect(err?.message).toContain(dir);
    expect(err?.message).toContain(`ares1.db.bak-v${N}-*`);
    expect(readdirSync(dir).sort()).toEqual(files);
    expect(readFileSync(file).equals(bytes)).toBe(true);
    expect(inspect(file)).toEqual({ version: N + 1, repos: ['kept', 'newer'] });
  });

  it('refuses a backup that is not the version its name says, changing nothing', () => {
    const dir = tmpDir('ares1-db-');
    const file = join(dir, 'ares1.db');
    current(file, 'kept');
    const backup = `${file}.bak-v${N}-2026-11-20T08-00-00-000Z`;
    vacuumInto(file, backup);
    const db = new DatabaseSync(backup);
    db.exec(`PRAGMA user_version = ${N + 2}`);
    db.close();
    migrateAndCrash(file);

    expect(openError(file)?.message).toContain(`恢复备份 ${backup} 失败`);
    expect(readdirSync(dir).filter((f) => /\.(newer|restoring)-/.test(f))).toEqual([]);
    expect(inspect(file)).toEqual({ version: N + 1, repos: ['kept', 'newer'] });
  });

  it('explains itself in English too', () => {
    setLang('en');
    const dir = tmpDir('ares1-db-');
    const file = join(dir, 'ares1.db');
    current(file);
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA user_version = ${N + 1}`);
    db.close();
    const message = openError(file)?.message ?? '';
    expect(message).toContain('is newer than this Master supports');
    expect(message).toContain(`ares1.db.bak-v${N}-*`);
    expect(message).not.toMatch(CJK);

    const restored = { backup: '/b', movedTo: '/m', fromVersion: N + 1, toVersion: N };
    const notice = backupRestoredNotice(restored);
    expect(notice).toContain('restored the backup taken before the migration, /b');
    expect(notice).toContain('/m');
    expect(notice).not.toMatch(CJK);
    setLang('zh');
    expect(backupRestoredNotice(restored)).toContain('已恢复迁移前的备份 /b');
  });

  it('says so in the Master output', async () => {
    setLang('en');
    const first = await harness();
    const { home } = first;
    const file = first.master.paths.dbFile;
    await first.close();
    const backup = `${file}.bak-v${N}-2026-11-20T08-00-00-000Z`;
    vacuumInto(file, backup);
    migrateAndCrash(file);

    const printed: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(' '));
    });
    let h: Harness;
    try {
      h = await harness({ home });
    } finally {
      warn.mockRestore();
    }
    try {
      const restored = h.master.store.restoredBackup as BackupRestore;
      expect(restored).toMatchObject({ backup, fromVersion: N + 1, toVersion: N });
      const lines = printed.filter((l) => l.includes(backup));
      expect(lines).toEqual([backupRestoredNotice(restored)]);
      expect(lines[0]).toContain(restored.movedTo);
      expect(lines[0]).not.toMatch(CJK);
      expect(h.master.store.findRepo('demo')).toBeDefined();
      expect(h.master.store.findRepo('newer')).toBeUndefined();
    } finally {
      await h.close();
    }
  });
});
