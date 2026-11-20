import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { TemplateSchema } from '../src/config/schema.js';
import { MIGRATIONS } from '../src/store/migrations.js';
import { Store } from '../src/store/store.js';
import type { Attempt, Scout } from '../src/store/types.js';
import { tmpDir } from './helpers.js';

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
    store.close();
    expect(readdirSync(dir).filter((f) => f.includes('.bak-v1-'))).toHaveLength(1);
  });

  it('refuses a database written by a newer Master', () => {
    const file = join(tmpDir('ares1-db-'), 'ares1.db');
    new Store(file).close();
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    db.close();
    expect(() => new Store(file)).toThrow(/比当前 Master 支持的/);
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
