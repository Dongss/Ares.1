import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RAW_LOG_KEEP_DAYS, runRawLogsExpired, scoutRawLogExpired } from '../src/config/flow.js';
import { TemplateSchema } from '../src/config/schema.js';
import { attemptEventsPath } from '../src/engine/engine.js';
import { setLang } from '../src/i18n.js';
import { type PrunedRawLogs, RawLogPruner } from '../src/logs/prune.js';
import { Store } from '../src/store/store.js';
import type { Run, RunStatus, Scout } from '../src/store/types.js';
import { type Harness, harness, tmpDir, writeFile } from './helpers.js';

const template = TemplateSchema.parse({ id: 't', stages: [{ id: 'a', agent: 'x' }] });
const NOW = Date.parse('2026-11-23T00:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

let store: Store | undefined;
let h: Harness | undefined;
afterEach(async () => {
  store?.close();
  store = undefined;
  await h?.close();
  h = undefined;
  setLang('zh');
  vi.restoreAllMocks();
});

/** A store and a logs directory, with helpers that create Runs and scouts with their log files. */
function setup() {
  const dir = tmpDir('ares1-logs-');
  const logsDir = join(dir, 'logs');
  const s = new Store(join(dir, 'ares1.db'));
  store = s;
  const repo = s.createRepo({
    name: 'r',
    path: '/tmp/r',
    targetBranch: 'main',
    verifyCommands: [],
    setupCommands: [],
    mergeMode: 'direct',
  });

  /** A Run with `attempts` executions, each with raw log, stderr, events and verify log. */
  const run = (status: RunStatus, finishedAt: string | null, patch: Partial<Run> = {}) => {
    const r = s.createRun({ repoId: repo.id, templateId: 't', template, goal: 'g', overrides: {} });
    const sr = s.createStageRun(r.id, 'a', null);
    const task = s.createTask({
      runId: r.id,
      stageRunId: sr.id,
      title: 'x',
      instructions: 'x',
      agentId: 'x',
    });
    const runDir = join(logsDir, r.id);
    const raw: string[] = [];
    const kept: string[] = [join(runDir, 'setup.log'), join(runDir, `command-${sr.id}.log`)];
    for (const n of [1, 2]) {
      const logPath = join(runDir, `att_${r.id}_${n}.jsonl`);
      s.createAttempt({
        id: `att_${r.id}_${n}`,
        taskId: task.id,
        runId: r.id,
        agentId: 'x',
        prompt: 'p',
        logPath,
        sessionId: null,
      });
      raw.push(logPath, `${logPath}.stderr`);
      kept.push(attemptEventsPath(logPath), logPath.replace(/\.jsonl$/, '.verify.log'));
    }
    for (const f of [...raw, ...kept]) writeFile(f, `${f}\n`);
    s.updateRun(r.id, { status, finishedAt, ...patch });
    return { id: r.id, raw, kept };
  };

  const scout = (status: Scout['status'], endedAt: string | null, withLog = true) => {
    const sc = s.createScout({
      repoId: repo.id,
      issuesRepo: 'me/r',
      trigger: 'auto',
      agentId: 'x',
      model: null,
      logPath: '',
    });
    const logPath = withLog ? join(logsDir, 'scouts', `${sc.id}.jsonl`) : '';
    if (withLog) {
      writeFile(logPath, 'x\n');
      writeFile(`${logPath}.stderr`, 'y\n');
    }
    s.updateScout(sc.id, { status, endedAt, logPath });
    return { id: sc.id, raw: withLog ? [logPath, `${logPath}.stderr`] : [] };
  };

  const pruner = new RawLogPruner(s, () => NOW);
  const prunedEvents = () => s.listEventsOfType('logs.pruned', '');
  return { s, logsDir, run, scout, pruner, prunedEvents };
}

const sizes = (files: string[]) => files.reduce((sum, f) => sum + statSync(f).size, 0);

describe('raw log retention rules', () => {
  it('expires the raw logs of finished Runs ended over 30 days ago', () => {
    expect(RAW_LOG_KEEP_DAYS).toBe(30);
    const run = (status: RunStatus, finishedAt: string | null, issue: Run['issue'] = null) => ({
      status,
      finishedAt,
      issue,
    });
    for (const status of ['completed', 'failed', 'cancelled', 'dropped'] as const) {
      expect(runRawLogsExpired(run(status, daysAgo(31)), NOW)).toBe(true);
      expect(runRawLogsExpired(run(status, daysAgo(29)), NOW)).toBe(false);
      expect(runRawLogsExpired(run(status, null), NOW)).toBe(false);
    }
    for (const status of ['queued', 'running', 'waiting_approval', 'blocked', 'paused'] as const) {
      expect(runRawLogsExpired(run(status, daysAgo(400)), NOW)).toBe(false);
    }
    // Waiting for its issue to be redone: it still goes on.
    const issue = { repo: 'me/r', number: 1, url: 'u', auto: false, redo: 'pending' as const };
    expect(runRawLogsExpired(run('failed', daysAgo(31), issue), NOW)).toBe(false);
    expect(
      runRawLogsExpired(run('failed', daysAgo(31), { ...issue, redo: 'exhausted' }), NOW),
    ).toBe(true);
  });

  it('expires the raw log of a scout ended over 30 days ago', () => {
    expect(scoutRawLogExpired({ status: 'completed', endedAt: daysAgo(31) }, NOW)).toBe(true);
    expect(scoutRawLogExpired({ status: 'interrupted', endedAt: daysAgo(31) }, NOW)).toBe(true);
    expect(scoutRawLogExpired({ status: 'failed', endedAt: daysAgo(1) }, NOW)).toBe(false);
    expect(scoutRawLogExpired({ status: 'completed', endedAt: null }, NOW)).toBe(false);
    expect(scoutRawLogExpired({ status: 'running', endedAt: daysAgo(31) }, NOW)).toBe(false);
  });
});

describe('pruning raw logs', () => {
  it('deletes only the raw logs and stderr of Runs finished over 30 days ago', () => {
    const { run, pruner, prunedEvents } = setup();
    const old = run('completed', daysAgo(31));
    const recent = run('failed', daysAgo(1));
    const bytes = sizes(old.raw);

    const pruned = pruner.prune();
    expect(pruned).toEqual({ runs: 1, scouts: 0, files: 4, bytes } satisfies PrunedRawLogs);
    for (const f of old.raw) expect(existsSync(f), f).toBe(false);
    // Events, verify, setup and command logs stay; so does everything of the recent Run.
    for (const f of [...old.kept, ...recent.raw, ...recent.kept])
      expect(existsSync(f), f).toBe(true);
    const events = prunedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ runId: null, data: pruned });
  });

  it('leaves Runs that may still go on, however old', () => {
    const { run, pruner, prunedEvents } = setup();
    const issue = { repo: 'me/r', number: 1, url: 'u', auto: false, redo: 'pending' as const };
    const runs = [
      run('running', daysAgo(90)),
      run('queued', daysAgo(90)),
      run('blocked', daysAgo(90)),
      run('waiting_approval', daysAgo(90)),
      run('paused', daysAgo(90)),
      run('failed', daysAgo(90), { issue }),
      // Finished without a recorded end: nothing to count from.
      run('cancelled', null),
    ];
    expect(pruner.prune()).toEqual({ runs: 0, scouts: 0, files: 0, bytes: 0 });
    for (const r of runs)
      for (const f of [...r.raw, ...r.kept]) expect(existsSync(f), f).toBe(true);
    expect(prunedEvents()).toEqual([]);
  });

  it('deletes the raw logs of scouts ended over 30 days ago and keeps newer ones', () => {
    const { scout, pruner } = setup();
    const old = scout('completed', daysAgo(31));
    const interrupted = scout('interrupted', daysAgo(45));
    const recent = scout('failed', daysAgo(2));
    const running = scout('running', null);
    // A scout that never got a log path: nothing to delete, and certainly no directory.
    scout('failed', daysAgo(60), false);
    const bytes = sizes([...old.raw, ...interrupted.raw]);

    expect(pruner.prune()).toEqual({ runs: 0, scouts: 2, files: 4, bytes });
    for (const f of [...old.raw, ...interrupted.raw]) expect(existsSync(f), f).toBe(false);
    for (const f of [...recent.raw, ...running.raw]) expect(existsSync(f), f).toBe(true);
  });

  it('does nothing more and records nothing more when run again', () => {
    const { run, scout, pruner, prunedEvents } = setup();
    run('completed', daysAgo(31));
    scout('completed', daysAgo(31));
    expect(pruner.prune()).toMatchObject({ runs: 1, scouts: 1, files: 6 });
    expect(pruner.prune()).toEqual({ runs: 0, scouts: 0, files: 0, bytes: 0 });
    expect(prunedEvents()).toHaveLength(1);
  });

  it('counts only the files that were there, once at start', () => {
    const { run, pruner, prunedEvents } = setup();
    const old = run('completed', daysAgo(31));
    // No stderr for the first execution.
    const [log, stderr, ...rest] = old.raw;
    rmSync(stderr ?? '');
    const bytes = sizes([log ?? '', ...rest]);
    pruner.start({ timer: false });
    for (const f of old.raw) expect(existsSync(f), f).toBe(false);
    expect(prunedEvents().map((e) => e.data)).toEqual([{ runs: 1, scouts: 0, files: 3, bytes }]);
  });

  it('starts the other housekeeping of a round after the raw logs', () => {
    const { s, run } = setup();
    const old = run('completed', daysAgo(31));
    const rounds: boolean[] = [];
    const pruner = new RawLogPruner(
      s,
      () => NOW,
      () => rounds.push(old.raw.every((f) => !existsSync(f))),
    );
    pruner.start({ timer: false });
    expect(rounds).toEqual([true]);
  });

  it('keeps a directory where a log path points to one', () => {
    const { s, logsDir, scout, pruner } = setup();
    const sc = scout('completed', daysAgo(31), false);
    const dir = join(logsDir, 'scouts', 'a-dir.jsonl');
    mkdirSync(dir, { recursive: true });
    s.updateScout(sc.id, { logPath: dir });
    expect(pruner.prune().files).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it('reports a file it cannot delete once and goes on with the others', () => {
    if (process.getuid?.() === 0) return; // root deletes from read-only directories
    const { s, logsDir, run, pruner, prunedEvents } = setup();
    const stuck = run('completed', daysAgo(31));
    const other = run('cancelled', daysAgo(40));
    const dir = join(logsDir, stuck.id);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    chmodSync(dir, 0o555);
    try {
      expect(pruner.prune()).toMatchObject({ runs: 1, files: 4 });
      for (const f of other.raw) expect(existsSync(f), f).toBe(false);
      for (const f of stuck.raw) expect(existsSync(f), f).toBe(true);
      const warned = warn.mock.calls.length;
      expect(warned).toBe(stuck.raw.length);
      expect(String(warn.mock.calls[0]?.[0])).toContain(stuck.raw[0]);
      // Not again in the next round.
      expect(pruner.prune()).toMatchObject({ files: 0 });
      expect(warn.mock.calls.length).toBe(warned);
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(prunedEvents()).toHaveLength(1);
    // Once it can, it deletes them.
    expect(pruner.prune()).toMatchObject({ runs: 1, files: 4 });
    expect(s.listEventsOfType('logs.pruned', '')).toHaveLength(2);
  });

  it('runs when the Master starts', async () => {
    const home = tmpDir('ares1-home-');
    h = await harness({ home });
    const repo = h.repo;
    const r = h.master.store.createRun({
      repoId: repo.id,
      templateId: 't',
      template,
      goal: 'g',
      overrides: {},
    });
    const sr = h.master.store.createStageRun(r.id, 'a', null);
    const task = h.master.store.createTask({
      runId: r.id,
      stageRunId: sr.id,
      title: 'x',
      instructions: 'x',
      agentId: 'x',
    });
    const logPath = join(h.master.paths.logsDir, r.id, 'att_old.jsonl');
    h.master.store.createAttempt({
      id: 'att_old',
      taskId: task.id,
      runId: r.id,
      agentId: 'x',
      prompt: 'p',
      logPath,
      sessionId: null,
    });
    writeFile(logPath, 'raw\n');
    writeFile(attemptEventsPath(logPath), 'events\n');
    h.master.store.updateRun(r.id, {
      status: 'completed',
      queuePos: null,
      finishedAt: new Date(Date.now() - 31 * 86_400_000).toISOString(),
    });
    await h.close();

    h = await harness({ home });
    expect(existsSync(logPath)).toBe(false);
    expect(existsSync(attemptEventsPath(logPath))).toBe(true);
    const [event] = h.master.store.listEventsOfType('logs.pruned', '');
    expect(event?.data).toEqual({ runs: 1, scouts: 0, files: 1, bytes: 4 });
  });
});
