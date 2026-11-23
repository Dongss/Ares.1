import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeContext } from '../src/adapters/fake.js';
import { statsSince } from '../src/api/stats.js';
import type {
  AgentEventRecord,
  AgentSummary,
  ConfigView,
  KeptWorkspace,
  LiveAgentEvent,
  RunSummary,
  StatsView,
} from '../src/api/types.js';
import { storedRunTimes } from '../src/engine/times.js';
import type { Attempt, EventRow, Run, RunStatus } from '../src/store/types.js';
import {
  ASSESS_AGENTS_YAML,
  ASSESS_WORKFLOW_YAML,
  assessment,
  blockOnAgentError,
  blockOverBudget,
  done,
  FakeGitHub,
  git,
  type Harness,
  harness,
  initRepo,
  review,
  TEST_AGENTS_YAML,
  TEST_WORKFLOW_YAML,
  tmpDir,
  waitFor,
  writeFile,
} from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function call(method: string, path: string, body?: unknown) {
  const res = await (h as Harness).master.app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const isJson = res.headers.get('content-type')?.includes('application/json');
  return { status: res.status, json: isJson && text ? JSON.parse(text) : null, text };
}

describe('HTTP API', () => {
  it('registers repos with validation', async () => {
    h = await harness();
    const dir = initRepo();
    expect((await call('POST', '/api/repos', { name: 'x', path: '/nope' })).status).toBe(400);
    expect((await call('POST', '/api/repos', { name: 'bad name', path: dir })).status).toBe(400);
    expect(
      (await call('POST', '/api/repos', { name: 'x', path: dir, targetBranch: 'nope' })).status,
    ).toBe(400);
    const ok = await call('POST', '/api/repos', { name: 'x', path: dir, verifyCommands: ['true'] });
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({ name: 'x', targetBranch: 'main', verifyCommands: ['true'] });
    expect((await call('POST', '/api/repos', { name: 'x', path: dir })).status).toBe(409);
    expect((await call('DELETE', `/api/repos/${ok.json.id}`)).status).toBe(204);
  });

  it('updates repo settings', async () => {
    h = await harness();
    const updated = await call('PATCH', '/api/repos/demo', {
      verifyCommands: ['true'],
      setupCommands: ['echo hi'],
    });
    expect(updated.status).toBe(200);
    expect(updated.json).toMatchObject({
      name: 'demo',
      targetBranch: 'main',
      verifyCommands: ['true'],
      setupCommands: ['echo hi'],
    });
    expect((await call('PATCH', '/api/repos/demo', { targetBranch: 'nope' })).status).toBe(400);
    expect((await call('PATCH', '/api/repos/demo', { path: '/elsewhere' })).status).toBe(400);
    expect((await call('PATCH', '/api/repos/nope', {})).status).toBe(404);
  });

  it('has no endpoint for creating runs: they only come from GitHub issues', async () => {
    h = await harness();
    const created = await call('POST', '/api/runs', { repo: 'demo', template: 'dev', goal: 'g' });
    expect(created.status).toBe(404);
    expect(created.json.error).toBe('接口不存在');
    expect(h.master.store.listRuns()).toEqual([]);
    expect((await call('GET', '/api/runs')).json).toEqual([]);
  });

  it('reports system notifications only when enabled and the platform supports them', async () => {
    const systemNotify = async (platform: NodeJS.Platform, on: boolean) => {
      h = await harness({
        config: on ? 'notify:\n  system: true\n' : undefined,
        master: { platform },
      });
      const health = await call('GET', '/api/health');
      await h.close();
      h = undefined;
      return health.json.systemNotify;
    };
    expect(await systemNotify('darwin', true)).toBe(true);
    expect(await systemNotify('linux', true)).toBe(true);
    // Elsewhere the Master cannot send them, so the dashboard keeps sending its own.
    expect(await systemNotify('win32', true)).toBe(false);
    expect(await systemNotify('linux', false)).toBe(false);
  });

  it('drives a run: inspect, approve', async () => {
    h = await harness();
    const id = h.run('加功能').id;
    await h.waitStatus(id, 'waiting_approval');

    const waiting = await call('GET', '/api/runs');
    expect(waiting.json[0]).toMatchObject({
      id,
      templateName: '测试流程',
      currentStage: { id: 'merge', name: '合并', round: 1 },
    } satisfies Partial<RunSummary>);

    const detail = await call('GET', `/api/runs/${id}`);
    expect(detail.json.run.status).toBe('waiting_approval');
    expect(detail.json.stageRuns).toHaveLength(3);
    expect(detail.json.attempts).toHaveLength(2);
    expect(detail.json.worktreeExists).toBe(true);
    expect(detail.json.rateLimited).toBeNull();
    expect(detail.json.redoAt).toBeNull();
    // The approval asked for is not decided yet, so it does not count.
    expect(detail.json.times).toMatchObject({ totalMs: null, approvalMs: 0 });
    expect(detail.json.times).toEqual(storedRunTimes(h.master.store, h.master.store.getRun(id)));
    const reviewArtifact = detail.json.artifacts.find((a: { name: string }) => a.name === 'review');
    const artifact = await call('GET', `/api/runs/${id}/artifacts/${reviewArtifact.id}`);
    expect(artifact.text).toContain('评审结论');

    const log = await call('GET', `/api/attempts/${detail.json.attempts[0].id}/log`);
    expect(log.text).toContain('"type":"result"');
    const download = await h.master.app.request(
      `/api/attempts/${detail.json.attempts[0].id}/log?download`,
    );
    expect(download.headers.get('content-disposition')).toContain('attachment');

    expect((await call('POST', `/api/runs/${id}/retry`, {})).status).toBe(409);
    expect((await call('POST', `/api/runs/${id}/reject`, {})).status).toBe(409);
    expect((await call('POST', `/api/runs/${id}/approve`, { comment: 'ok' })).status).toBe(200);
    await h.waitStatus(id, 'completed');
    const finished = await call('GET', `/api/runs/${id}`);
    expect(finished.json).toMatchObject({ worktreeExists: false, branchExists: false });
    const completed = h.master.store.getRun(id);
    expect(finished.json.times).toEqual(storedRunTimes(h.master.store, completed));
    expect(finished.json.times.totalMs).toBe(
      Date.parse(completed.finishedAt ?? '') - Date.parse(completed.createdAt),
    );

    const list = await call('GET', '/api/runs?status=completed');
    expect(list.json.map((r: { id: string }) => r.id)).toEqual([id]);
    expect(list.json[0].template).toBeUndefined();
    const events = await call('GET', `/api/runs/${id}/events`);
    expect(events.json.map((e: { type: string }) => e.type)).toContain('merge.done');
  });

  it('shows what a run changes, also after the target moved and the run merged', async () => {
    h = await harness();
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');
    const store = h.master.store;

    // Someone else commits to main meanwhile; the run's diff must not include it.
    writeFile(join(h.repoDir, 'other.txt'), 'other\n');
    git(h.repoDir, 'add', '-A');
    git(h.repoDir, 'commit', '-q', '-m', 'other');

    const before = await call('GET', `/api/runs/${run.id}/diff`);
    expect(before.json.patch).toContain('+++ b/feature.txt');
    expect(before.json.patch).not.toContain('other.txt');
    expect(before.json.stat).toContain('feature.txt');
    expect(before.json.truncated).toBe(false);

    const sha = store.listRunTasks(run.id).find((t) => t.commitSha)?.commitSha as string;
    const one = await call('GET', `/api/runs/${run.id}/diff?commit=${sha}`);
    expect(one.json.patch).toContain('feature.txt');
    expect((await call('GET', `/api/runs/${run.id}/diff?commit=${'0'.repeat(40)}`)).status).toBe(
      404,
    );

    await call('POST', `/api/runs/${run.id}/approve`, {});
    await h.waitStatus(run.id, 'completed');
    expect(store.listEvents(run.id).map((e) => e.type)).toContain('merge.synced');
    // The worktree and branch are gone; the diff comes from the merge record.
    const after = await call('GET', `/api/runs/${run.id}/diff`);
    expect(after.json.patch).toContain('+++ b/feature.txt');
    expect(after.json.patch).not.toContain('other.txt');
  });

  it('has no diff before the run has a workspace', async () => {
    h = await harness();
    h.scripts.coder = async (ctx) => {
      await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
      return { finalMessage: '' };
    };
    const first = h.run('第一个');
    await waitFor(() => h?.fake.calls.length === 1, 'agent start');
    const second = h.run('第二个');
    expect(h.master.store.getRun(second.id).status).toBe('queued');
    const diff = await call('GET', `/api/runs/${second.id}/diff`);
    expect(diff.status).toBe(200);
    expect(diff.json).toBeNull();
    await call('POST', `/api/runs/${first.id}/cancel`);
    await call('POST', `/api/runs/${second.id}/cancel`);
  });

  it('keeps agent events for history and streams them live with sequence numbers', async () => {
    h = await harness();
    h.scripts.coder = (ctx) => {
      ctx.input.onEvent?.({ type: 'tool', name: 'Bash', summary: 'ls' });
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return done();
    };
    const res = await h.master.app.request('/api/stream');
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const run = h.run();
    let text = '';
    const decoder = new TextDecoder();
    while (!text.includes('"type":"tool"')) {
      const { value } = await reader.read();
      text += decoder.decode(value);
    }
    await reader.cancel();
    const live = text
      .split('\n\n')
      .filter((msg) => msg.includes('event: agent'))
      .map((msg) => {
        const data = msg.split('\n').find((l) => l.startsWith('data: ')) ?? '';
        return JSON.parse(data.slice('data: '.length)) as LiveAgentEvent;
      });
    expect(live.find((e) => e.event.type === 'tool')).toMatchObject({ runId: run.id, seq: 2 });

    await h.waitStatus(run.id, 'waiting_approval');
    const [attempt] = h.master.store.listRunAttempts(run.id);
    const history = await call('GET', `/api/attempts/${attempt?.id}/events`);
    const records = history.json as AgentEventRecord[];
    expect(records.map((r) => r.event.type)).toEqual(['session', 'tool', 'message']);
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it('returns the model and effort of each attempt', async () => {
    h = await harness({
      agents: `
agents:
  coder: { cli: fake, model: coder, effort: max }
  reviewer: { cli: fake, model: reviewer }
`,
    });
    h.scripts.coder = (ctx) => {
      ctx.input.onEvent?.({ type: 'model', model: 'fake-coder-1' });
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return done();
    };
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');
    const detail = await call('GET', `/api/runs/${run.id}`);
    const attempts = detail.json.attempts as Attempt[];
    expect(attempts.map((a) => [a.agentId, a.model, a.actualModel, a.effort])).toEqual([
      ['coder', 'coder', 'fake-coder-1', 'max'],
      ['reviewer', 'reviewer', null, null],
    ]);
    const config = await call('GET', '/api/config');
    expect(config.json.agents[0]).toMatchObject({ id: 'coder', model: 'coder', effort: 'max' });
  });

  it('marks run costs as partly unknown when an attempt has no cost', async () => {
    h = await harness();
    // The fake agents report no cost and have no price, like cursor-agent without a price.
    const unknown = h.run('没有费用');
    await h.waitStatus(unknown.id, 'waiting_approval');
    const listed = (await call('GET', '/api/runs')).json as RunSummary[];
    expect(listed.find((r) => r.id === unknown.id)).toMatchObject({
      costUsd: 0,
      costUnknown: true,
    });
    await call('POST', `/api/runs/${unknown.id}/cancel`);

    h.scripts.coder = (ctx) => {
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return { ...done(), costUsd: 0.5 };
    };
    h.scripts.reviewer = () => ({ ...review(), costUsd: 0.25 });
    const known = h.run('有费用');
    await h.waitStatus(known.id, 'waiting_approval');
    const again = (await call('GET', '/api/runs')).json as RunSummary[];
    expect(again.find((r) => r.id === known.id)).toMatchObject({
      costUsd: 0.75,
      costUnknown: false,
    });
  });

  it('takes a new budget when retrying a run that spent its budget', async () => {
    h = await harness({
      workflow: TEST_WORKFLOW_YAML.replace('  max_loops: 3\n', '  max_loops: 3\n  budget_usd: 5\n'),
    });
    h.scripts.coder = (ctx) => {
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return { ...done(), costUsd: 0.5 };
    };
    // The run's 0.4 overrides the template's 5: blocked before the review.
    const created = h.run('g', blockOverBudget(0.4));
    expect(created.overrides).toEqual(blockOverBudget(0.4));
    const id = created.id;
    await h.waitStatus(id, 'blocked');
    expect((await call('GET', `/api/runs/${id}`)).json.run.blocked.kind).toBe('budget');

    const retry = (body: unknown) => call('POST', `/api/runs/${id}/retry`, body);
    expect((await retry({})).status).toBe(409);
    expect((await retry({ budgetUsd: 0.5 })).status).toBe(409);
    expect((await retry({ budgetUsd: 0 })).status).toBe(400);
    expect((await retry({ budgetUsd: '2' })).status).toBe(400);
    const ok = await retry({ budgetUsd: 2 });
    expect(ok.status).toBe(200);
    expect(ok.json.overrides.budget_usd).toBe(2);
    await h.waitStatus(id, 'waiting_approval');
  });

  it('replies to the requirement assessment through retry with a note', async () => {
    h = await harness({ agents: ASSESS_AGENTS_YAML, workflow: ASSESS_WORKFLOW_YAML });
    let n = 0;
    h.scripts.assessor = () =>
      ++n === 1 ? assessment('ask', { questions: ['写什么？'] }) : assessment('go');
    const id = h.run('g').id;
    await h.waitStatus(id, 'blocked');
    const detail = (await call('GET', `/api/runs/${id}`)).json;
    expect(detail.run.blocked.kind).toBe('discussion');
    expect(detail.run.discussion).toMatchObject([{ role: 'assessor', verdict: 'ask' }]);

    const retry = (body: unknown) => call('POST', `/api/runs/${id}/retry`, body);
    expect((await retry({})).status).toBe(409);
    expect((await retry({ note: '  ' })).status).toBe(409);
    const ok = await retry({ note: '写 ok' });
    expect(ok.status).toBe(200);
    expect(ok.json.discussion.at(-1)).toMatchObject({
      role: 'human',
      text: '写 ok',
      source: 'dashboard',
    });
    await h.waitStatus(id, 'completed');
  });

  it('says when a run waiting for its agent quota goes on, until it is cancelled', async () => {
    h = await harness({
      master: { rateLimitWait: { firstMs: 600_000, maxMs: 600_000, marginMs: 0 } },
    });
    h.scripts.coder = () => ({
      status: 'failed',
      error: '额度用尽或被限流',
      errorKind: 'rate_limited',
    });
    const { id } = h.run('g');
    await waitFor(
      () => h?.master.store.listEvents(id).some((e) => e.type === 'task.rate_limited') === true,
      'the rate limit',
    );
    await h.waitStatus(id, 'queued');
    const detail = await call('GET', `/api/runs/${id}`);
    expect(detail.json.run).toMatchObject({ status: 'queued', blocked: null });
    expect(detail.json.rateLimited).toEqual({
      agentId: 'coder',
      retryAt: h.master.store.listEvents(id).find((e) => e.type === 'task.rate_limited')?.data
        .retryAt,
    });
    expect(detail.json.attempts.map((a: Attempt) => a.outcome)).toEqual(['rate_limited']);

    expect((await call('POST', `/api/runs/${id}/cancel`)).json.status).toBe('cancelled');
    expect((await call('GET', `/api/runs/${id}`)).json.rateLimited).toBeNull();
  });

  it('says when the issue of a failed run is redone, only while it waits for that', async () => {
    h = await harness();
    const store = h.master.store;
    store.setWorking(false);
    const { id } = h.run('g');
    const finishedAt = '2026-11-20T06:00:00.000Z';
    const issue = { repo: 'me/demo', number: 1, url: '', auto: false, attempt: 2 };
    store.updateRun(id, {
      queuePos: null,
      status: 'failed',
      finishedAt,
      issue: { ...issue, redo: 'pending' },
    });
    // The second failure waits twice poll_minutes (5 without a github section).
    const detail = await call('GET', `/api/runs/${id}`);
    expect(detail.json.redoAt).toBe('2026-11-20T06:10:00.000Z');

    for (const redo of ['redone', 'exhausted', 'abandoned', undefined] as const) {
      store.updateRun(id, { issue: { ...issue, redo } });
      expect((await call('GET', `/api/runs/${id}`)).json.redoAt).toBeNull();
    }
  });

  it('pauses, resumes and cancels', async () => {
    h = await harness();
    h.scripts.coder = async (ctx) => {
      await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
      return { finalMessage: '' };
    };
    const { id } = h.run('g');
    await waitFor(() => h?.fake.calls.length === 1, 'agent start');
    expect((await call('POST', `/api/runs/${id}/pause`)).json.status).toBe('paused');
    expect((await call('POST', `/api/runs/${id}/pause`)).status).toBe(409);
    // Resuming puts the run at the head of the queue and, with nothing else running, starts it.
    const resumed = await call('POST', `/api/runs/${id}/resume`);
    expect(['queued', 'running']).toContain(resumed.json.status);
    expect((await call('POST', `/api/runs/${id}/cancel`)).json.status).toBe('cancelled');
  });

  it('cleans up the workspace of a cancelled run and keeps its records', async () => {
    h = await harness();
    const created = h.run();
    await h.waitStatus(created.id, 'waiting_approval');
    const { worktreePath, branch } = h.master.store.getRun(created.id) as Run & {
      worktreePath: string;
      branch: string;
    };
    expect((await call('POST', `/api/runs/${created.id}/cancel`)).json.status).toBe('cancelled');
    const kept = await call('GET', `/api/runs/${created.id}`);
    expect(kept.json).toMatchObject({
      workspace: { path: worktreePath, branch },
      worktreeExists: true,
      branchExists: true,
    });

    const cleaned = await call('POST', `/api/runs/${created.id}/cleanup`);
    expect(cleaned.status).toBe(200);
    expect(cleaned.json).toMatchObject({ id: created.id, status: 'cancelled' });
    expect(existsSync(worktreePath)).toBe(false);
    expect(git(h.repoDir, 'branch', '--list', branch)).toBe('');
    expect(git(h.repoDir, 'worktree', 'list', '--porcelain')).not.toContain(branch);

    // Records, events, checks, logs and artifacts stay.
    const detail = await call('GET', `/api/runs/${created.id}`);
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({ worktreeExists: false, branchExists: false });
    expect(detail.json.run).toMatchObject({ status: 'cancelled', worktreePath, branch });
    expect(detail.json.attempts).toHaveLength(2);
    expect(detail.json.checks.length).toBeGreaterThan(0);
    const log = await call('GET', `/api/attempts/${detail.json.attempts[0].id}/log`);
    expect(log.text).toContain('"type":"result"');
    const artifact = await call(
      'GET',
      `/api/runs/${created.id}/artifacts/${detail.json.artifacts[0].id}`,
    );
    expect(artifact.status).toBe(200);
    const diff = await call('GET', `/api/runs/${created.id}/diff`);
    expect(diff.status).toBe(200);
    expect(diff.json).toBeNull();
    const events = (await call('GET', `/api/runs/${created.id}/events`)).json as EventRow[];
    expect(events.map((e) => e.type)).toContain('run.status');
    const removed = events.filter((e) => e.type === 'workspace.removed');
    expect(removed.map((e) => e.data)).toEqual([{ path: worktreePath, branch, manual: true }]);

    // Nothing left to remove is fine, and records nothing more.
    const again = await call('POST', `/api/runs/${created.id}/cleanup`);
    expect(again.status).toBe(200);
    expect(again.json.status).toBe('cancelled');
    expect(h.master.store.listEvents(created.id)).toHaveLength(events.length);
  });

  it('cleans up the workspace of a failed run', async () => {
    h = await harness({
      workflow: TEST_WORKFLOW_YAML.replace(
        '    on_agent_error: switch_agent\n',
        '    on_agent_error: switch_agent\n    on_budget_exceeded: abort\n',
      ),
    });
    h.scripts.coder = (ctx) => {
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return { ...done(), costUsd: 0.5 };
    };
    const created = h.run('目标', { budget_usd: 0.4 });
    const failed = await h.waitStatus(created.id, 'failed');
    expect(existsSync(failed.worktreePath as string)).toBe(true);
    // Right away, while the engine may still be leaving the Run.
    expect((await call('POST', `/api/runs/${created.id}/cleanup`)).status).toBe(200);
    expect(existsSync(failed.worktreePath as string)).toBe(false);
    expect(git(h.repoDir, 'branch', '--list', failed.branch as string)).toBe('');
    const detail = await call('GET', `/api/runs/${created.id}`);
    expect(detail.json).toMatchObject({ worktreeExists: false, branchExists: false });
    expect(detail.json.run.status).toBe('failed');
  });

  it('cleans up what a setup interrupted by a cancel left behind', async () => {
    const hh = await harness({ setupCommands: ['sleep 30'] });
    h = hh;
    const created = h.run();
    await waitFor(
      () => hh.master.store.listEvents(created.id).some((e) => e.type === 'workspace.created'),
      'workspace created',
    );
    await call('POST', `/api/runs/${created.id}/cancel`);
    const event = h.master.store.listEvents(created.id).find((e) => e.type === 'workspace.created');
    const { path, branch } = (event as EventRow).data as { path: string; branch: string };
    // Setup never passed, so the Run has no workspace on record, yet one is on disk; the detail
    // still points at it so the dashboard offers the cleanup.
    expect(h.master.store.getRun(created.id)).toMatchObject({ worktreePath: null, branch: null });
    expect(existsSync(path)).toBe(true);
    const kept = await call('GET', `/api/runs/${created.id}`);
    expect(kept.json).toMatchObject({
      run: { status: 'cancelled', worktreePath: null, branch: null },
      workspace: { path, branch },
      worktreeExists: true,
      branchExists: true,
    });

    // Two requests at once share one removal.
    const [first, second] = await Promise.all([
      call('POST', `/api/runs/${created.id}/cleanup`),
      call('POST', `/api/runs/${created.id}/cleanup`),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(existsSync(path)).toBe(false);
    expect(git(h.repoDir, 'branch', '--list', branch)).toBe('');
    const removed = h.master.store
      .listEvents(created.id)
      .filter((e) => e.type === 'workspace.removed');
    expect(removed.map((e) => e.data)).toEqual([{ path, branch, manual: true }]);
    const detail = await call('GET', `/api/runs/${created.id}`);
    expect(detail.json).toMatchObject({ worktreeExists: false, branchExists: false });
  });

  it('refuses to clean up runs that are not failed or cancelled', async () => {
    h = await harness();
    const hh = h;
    const refused = async (id: string, status: RunStatus) => {
      const run = hh.master.store.getRun(id);
      expect(run.status).toBe(status);
      const res = await call('POST', `/api/runs/${id}/cleanup`);
      expect(res.status).toBe(409);
      expect(res.json.error).toContain(status);
      if (status !== 'queued' && status !== 'completed') {
        expect(existsSync(run.worktreePath as string)).toBe(true);
        expect(git(hh.repoDir, 'branch', '--list', run.branch as string)).not.toBe('');
      }
      const manual = hh.master.store.listEvents(id).filter((e) => e.data.manual === true);
      expect(manual).toEqual([]);
    };

    // blocked: out of budget.
    h.scripts.coder = (ctx) => {
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return { ...done(), costUsd: 0.5 };
    };
    const blocked = h.run('卡住', blockOverBudget(0.4));
    await h.waitStatus(blocked.id, 'blocked');
    await refused(blocked.id, 'blocked');

    // running and queued behind it, then paused.
    h.scripts.coder = async (ctx) => {
      await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
      return { finalMessage: '' };
    };
    const running = h.run('执行中');
    await waitFor(() => hh.fake.calls.length === 2, 'agent start');
    const queued = h.run('排队');
    await refused(running.id, 'running');
    await refused(queued.id, 'queued');
    await call('POST', `/api/runs/${queued.id}/cancel`);
    await call('POST', `/api/runs/${running.id}/pause`);
    await refused(running.id, 'paused');

    // waiting_approval, then completed.
    h.scripts.coder = (ctx) => {
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return done();
    };
    const approval = h.run('待审批');
    await h.waitStatus(approval.id, 'waiting_approval');
    await refused(approval.id, 'waiting_approval');
    await call('POST', `/api/runs/${approval.id}/approve`, {});
    await h.waitStatus(approval.id, 'completed');
    await refused(approval.id, 'completed');
  });

  it('lists the workspaces finished runs kept, until they are cleaned up', async () => {
    h = await harness();
    const hh = h;
    const listed = async () => {
      const res = await call('GET', '/api/workspaces');
      expect(res.status).toBe(200);
      return res.json as KeptWorkspace[];
    };
    expect(await listed()).toEqual([]);

    // Completed and merged: removed automatically, not listed.
    const merged = h.run('合并完成');
    await h.waitStatus(merged.id, 'waiting_approval');
    await call('POST', `/api/runs/${merged.id}/approve`, {});
    await h.waitStatus(merged.id, 'completed');

    // Cancelled: keeps its workspace.
    const cancelled = h.run('第一行目标\n更多说明');
    await h.waitStatus(cancelled.id, 'waiting_approval');
    await call('POST', `/api/runs/${cancelled.id}/cancel`);
    const kept = h.master.store.getRun(cancelled.id) as Run & {
      worktreePath: string;
      branch: string;
    };

    // Running and queued behind it: in use, not listed.
    h.scripts.coder = async (ctx) => {
      await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
      return { finalMessage: '' };
    };
    const running = h.run('执行中');
    // Two runs of coder + reviewer so far, then this one's coder.
    await waitFor(() => hh.fake.calls.length === 5, 'agent start');
    const queued = h.run('排队');
    expect(h.master.store.getRun(running.id).status).toBe('running');
    expect(h.master.store.getRun(queued.id).status).toBe('queued');

    const items = await listed();
    expect(items).toEqual([
      {
        run: {
          id: cancelled.id,
          title: '第一行目标',
          repoId: h.repo.id,
          repoName: 'demo',
          status: 'cancelled',
          finishedAt: kept.finishedAt,
        },
        workspace: { path: kept.worktreePath, branch: kept.branch },
        worktreeExists: true,
        branchExists: true,
        recorded: true,
        canCleanUp: true,
      },
    ] satisfies KeptWorkspace[]);

    // Cleaned up: drops off the list.
    expect((await call('POST', `/api/runs/${cancelled.id}/cleanup`)).status).toBe(200);
    expect(await listed()).toEqual([]);

    // Once cancelled, the formerly running Run is listed; the queued one never had a workspace.
    await call('POST', `/api/runs/${queued.id}/cancel`);
    await call('POST', `/api/runs/${running.id}/cancel`);
    expect((await listed()).map((i) => i.run.id)).toEqual([running.id]);
  });

  it('lists what a failed or interrupted setup left behind, and kept workspaces of completed runs', async () => {
    const hh = await harness({ setupCommands: ['false'] });
    h = hh;
    // A failed setup ends the Run with its workspace on record.
    const failed = await h.waitStatus(h.run('准备失败').id, 'failed');
    expect(failed.worktreePath).not.toBeNull();

    // A setup interrupted by a cancel leaves its workspace behind without a record.
    h.master.store.updateRepo(h.repo.id, { setupCommands: ['sleep 30'] });
    const setup = h.run('准备中断');
    await waitFor(
      () => hh.master.store.listEvents(setup.id).some((e) => e.type === 'workspace.created'),
      'workspace created',
    );
    // Not finished yet while it runs.
    expect((await call('GET', '/api/workspaces')).json.map((i: KeptWorkspace) => i.run.id)).toEqual(
      [failed.id],
    );
    await call('POST', `/api/runs/${setup.id}/cancel`);
    const event = h.master.store.listEvents(setup.id).find((e) => e.type === 'workspace.created');
    const { path, branch } = (event as EventRow).data as { path: string; branch: string };
    expect(h.master.store.getRun(setup.id)).toMatchObject({ worktreePath: null, branch: null });

    // A completed Run whose branch is still there (here: made again by hand) is listed, but the
    // cleanup endpoint does not accept it.
    h.master.store.updateRepo(h.repo.id, { setupCommands: [] });
    const finished = h.run('已完成');
    await h.waitStatus(finished.id, 'waiting_approval');
    await call('POST', `/api/runs/${finished.id}/approve`, {});
    const completed = await h.waitStatus(finished.id, 'completed');
    git(h.repoDir, 'branch', completed.branch as string, 'main');

    const items = (await call('GET', '/api/workspaces')).json as KeptWorkspace[];
    expect(items.map((i) => i.run.id)).toEqual([finished.id, setup.id, failed.id]);
    expect(items[0]).toMatchObject({
      run: { status: 'completed' },
      worktreeExists: false,
      branchExists: true,
      recorded: true,
      canCleanUp: false,
    });
    expect(items[1]).toMatchObject({
      run: { id: setup.id, status: 'cancelled' },
      workspace: { path, branch },
      worktreeExists: true,
      branchExists: true,
      recorded: false,
      canCleanUp: true,
    });
    expect(items[2]).toMatchObject({
      run: { id: failed.id, status: 'failed' },
      workspace: { path: failed.worktreePath, branch: failed.branch },
      worktreeExists: true,
      branchExists: true,
      recorded: true,
      canCleanUp: true,
    });

    for (const id of [setup.id, failed.id]) {
      expect((await call('POST', `/api/runs/${id}/cleanup`)).status).toBe(200);
    }
    expect((await call('GET', '/api/workspaces')).json.map((i: KeptWorkspace) => i.run.id)).toEqual(
      [finished.id],
    );
  });

  it('exposes config with errors and warnings', async () => {
    h = await harness({ config: 'upgarde: { auto: true }\n' });
    const { json } = await call('GET', '/api/config');
    expect(json.language).toBe('zh');
    expect(json.agents.map((a: { id: string }) => a.id)).toEqual(['coder', 'coder2', 'reviewer']);
    expect(json.agents[0]).toMatchObject({ id: 'coder', model: 'coder' });
    expect(json.templates.map((t: { id: string }) => t.id)).toEqual(['dev']);
    // A typo in config.yaml does not stop the Master; the config page shows the warning.
    expect(json.warnings['config.yaml']).toEqual([
      expect.stringMatching(/^未知的配置项 upgarde，已忽略/),
    ]);
  });

  it('exposes config sources, disabled agents and invalid template files', async () => {
    const agents = `${TEST_AGENTS_YAML}  off: { cli: fake, model: off, enabled: false }\n`;
    const home = tmpDir('ares1-home-');
    writeFile(join(home, 'workflows', 'broken.yaml'), 'id: dev2\nstages: []\n');
    h = await harness({ home, agents });
    const { json } = (await call('GET', '/api/config')) as { json: ConfigView };
    // Existing fields are unchanged: only enabled agents and valid templates.
    expect(json.agents.map((a) => a.id)).toEqual(['coder', 'coder2', 'reviewer']);
    expect(json.templates.map((t) => t.id)).toEqual(['dev']);
    expect(json.errors['workflows/broken.yaml']).toBeDefined();

    expect(json.dir).toBe(home);
    expect(json.agentsFile).toEqual({ path: join(home, 'agents.yaml'), source: agents });
    expect(json.configFile.path).toBe(join(home, 'config.yaml'));
    expect(json.agentEntries.map((a) => [a.id, a.state])).toEqual([
      ['coder', 'enabled'],
      ['coder2', 'enabled'],
      ['reviewer', 'enabled'],
      ['off', 'disabled'],
    ]);
    expect(json.agentEntries[3]?.config).toMatchObject({ id: 'off', cli: 'fake', model: 'off' });
    expect(json.templateFiles.map((f) => [f.file, f.templateId])).toEqual([
      ['broken.yaml', null],
      ['dev.yaml', 'dev'],
    ]);
    expect(json.templateFiles[0]?.errors).toEqual(json.errors['workflows/broken.yaml']);
    expect(json.templateFiles[1]).toMatchObject({
      key: 'workflows/dev.yaml',
      path: join(home, 'workflows', 'dev.yaml'),
      source: TEST_WORKFLOW_YAML,
    });
  });

  it('streams events over SSE', async () => {
    h = await harness();
    const res = await h.master.app.request('/api/stream');
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    h.run();
    let text = '';
    const decoder = new TextDecoder();
    while (!text.includes('run.created')) {
      const { value } = await reader.read();
      text += decoder.decode(value);
    }
    await reader.cancel();
    expect(text).toContain('event: event');
  });
});

describe('GET /api/stats', () => {
  const AGENTS = `${TEST_AGENTS_YAML}
  scout:
    cli: fake
    model: scout
`;
  const CONFIG = `
github:
  repos:
    demo:
      template: dev
      scout:
        agent: scout
        auto: false
        max_proposals: 3
      auto_accept:
        max_risk: low
        max_per_day: 1
`;
  const proposal = (title: string, risk: 'low' | 'mid') => ({
    title,
    category: 'improvement',
    size: 'S',
    risk,
    why: `${title}的原因`,
    evidence: ['证据'],
    what: `${title}的做法`,
    acceptance: ['测试通过'],
  });
  const CODER_USAGE = { inputTokens: 100, outputTokens: 10, cachedTokens: 1000 };
  const REVIEW_USAGE = { inputTokens: 50, outputTokens: 5, cachedTokens: 500 };
  const localDay = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const span = (from: string, to: string | null) => (to ? Date.parse(to) - Date.parse(from) : 0);

  it('sums runs, rework, blocks, scouts and issues over a time range and a repo', async () => {
    const gh = new FakeGitHub();
    const hh = await harness({ agents: AGENTS, config: CONFIG, github: gh });
    h = hh;
    const store = hh.master.store;
    const coder = (write: string | null) => (ctx: FakeContext) => {
      if (write !== null) writeFile(join(ctx.input.workdir, 'feature.txt'), write);
      return { ...done(), costUsd: 0.5, usage: CODER_USAGE };
    };
    const reviewer =
      (...answers: ReturnType<typeof review>[]) =>
      () => ({ ...(answers.shift() ?? review()), costUsd: 0.25, usage: REVIEW_USAGE });

    // A: the check fails once (rework), the review sends it back once, then approved.
    const codes = [coder(null), coder('ok\n'), coder('ok again\n')];
    hh.scripts.coder = (ctx) => (codes.shift() ?? coder('ok\n'))(ctx);
    hh.scripts.reviewer = reviewer(review([{ severity: 'must', description: '少了测试' }]));
    const a = hh.run('A');
    await hh.waitStatus(a.id, 'waiting_approval');
    await call('POST', `/api/runs/${a.id}/approve`, {});
    await hh.waitStatus(a.id, 'completed');

    // B: the agent errors (blocked), a retry with coder2 (cost unknown) passes; left waiting.
    hh.scripts.coder = () => ({ status: 'failed', error: '模型不存在' });
    hh.scripts.coder2 = (ctx) => {
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return { ...done(), usage: { inputTokens: 200, outputTokens: 20 } };
    };
    hh.scripts.reviewer = reviewer();
    const b = hh.run('B', blockOnAgentError());
    await hh.waitStatus(b.id, 'blocked');
    await call('POST', `/api/runs/${b.id}/retry`, { agentId: 'coder2' });
    await hh.waitStatus(b.id, 'waiting_approval');

    // C: out of budget after the first execution, then terminated.
    hh.scripts.coder = coder('ok\n');
    const c = hh.run('C', blockOverBudget(0.4));
    await hh.waitStatus(c.id, 'blocked');
    await call('POST', `/api/runs/${c.id}/cancel`);

    // A scout proposes two issues; the low-risk one is accepted and becomes Run D.
    hh.scripts.scout = () => ({
      structured: { proposals: [proposal('低风险', 'low'), proposal('中风险', 'mid')] },
      costUsd: 0.3,
    });
    const scout = await hh.master.issues.startScout('demo', 'manual');
    await waitFor(() => store.listRuns().some((r) => r.issue), 'run from the issue');
    const d = store.listRuns().find((r) => r.issue) as Run;
    await hh.waitStatus(d.id, 'waiting_approval');
    await call('POST', `/api/runs/${d.id}/approve`, {});
    await hh.waitStatus(d.id, 'completed');
    await waitFor(() => store.getRun(d.id).issueSynced === 'completed', 'issue closed');
    expect(gh.get(1).state).toBe('closed');

    const res = await call('GET', '/api/stats?range=7d');
    expect(res.status).toBe(200);
    const stats = res.json as StatsView;
    const runIds = [a.id, b.id, c.id, d.id];
    const attempts = runIds.flatMap((id) => store.listRunAttempts(id));
    const finished = [a.id, d.id].map((id) => store.getRun(id));
    const [first = 0, second = 0] = finished.map((r) => span(r.createdAt, r.finishedAt));
    const approvals = runIds.flatMap((id) => store.listApprovals(id)).filter((x) => x.decidedAt);
    const blockWait = (id: string) => {
      const events = store.listEvents(id);
      const at = events.findIndex((e) => e.type === 'run.blocked');
      const next = events.slice(at).find((e) => e.type === 'run.status') as EventRow;
      return span((events[at] as EventRow).ts, next.ts);
    };
    const scoutRow = store.getScout(scout.id);

    expect(stats).toMatchObject({
      range: '7d',
      repoId: null,
      runs: {
        total: 4,
        byStatus: { completed: 2, waiting_approval: 1, cancelled: 1 },
        fromIssues: 1,
        autoAccepted: 1,
        issuesClosed: 1,
        completed: {
          count: 2,
          costUsd: 2.75,
          avgMs: Math.round((first + second) / 2),
          medianMs: Math.round((first + second) / 2),
        },
      },
      // A: 编码 ×2, 评审 ×2; B, C and D: 编码, 评审 (C's review is stopped by the budget).
      tasks: 10,
      attempts: 11,
      scouts: { total: 1, proposals: 2, autoAccepted: 1 },
      cost: {
        runsUsd: 3.5,
        scoutsUsd: 0.3,
        unknownAttempts: 2,
        unknownScouts: 0,
        byDay: [{ day: localDay(new Date()), runsUsd: 3.5, scoutsUsd: 0.3 }],
        byRepo: [{ repoId: hh.repo.id, repo: 'demo', runsUsd: 3.5, scoutsUsd: 0.3 }],
      },
      tokens: { input: 900, output: 90, cached: 7000 },
      time: {
        attemptsMs: attempts.reduce((n, x) => n + span(x.startedAt, x.endedAt), 0),
        scoutsMs: span(scoutRow.startedAt, scoutRow.endedAt),
        approvals: {
          count: 2,
          waitMs: approvals.reduce((n, x) => n + span(x.createdAt, x.decidedAt), 0),
        },
      },
      quality: {
        runs: 4,
        agentRounds: 5,
        reviewFails: 1,
        checkFails: 0,
        rejections: 0,
        reworks: 1,
      },
      blocks: [
        { kind: 'agent_error', count: 1, handled: 1, waitMs: blockWait(b.id) },
        { kind: 'budget', count: 1, handled: 1, waitMs: blockWait(c.id) },
      ],
    } satisfies Partial<StatsView>);
    expect(stats.since).toBe(statsSince('7d'));
    expect(stats.agents.map((x) => [x.agentId, x.model, x.attempts, x.scouts])).toEqual([
      ['coder', 'coder', 6, 0],
      ['reviewer', 'reviewer', 4, 0],
      ['scout', 'scout', 0, 1],
      ['coder2', 'coder2', 1, 0],
    ]);
    expect(stats.agents[0]).toMatchObject({
      costUsd: 2.5,
      costUnknown: 1,
      inputTokens: 500,
      outputTokens: 50,
      cachedTokens: 5000,
    });
    expect(stats.agents.map((x) => [x.costUsd, x.costUnknown])).toEqual([
      [2.5, 1],
      [1, 0],
      [0.3, 0],
      [0, 1],
    ]);
    expect(stats.agents.reduce((n, x) => n + x.durationMs, 0)).toBe(
      stats.time.attemptsMs + stats.time.scoutsMs,
    );

    // The repo filter: the same for demo, nothing for another repo; unknown ones are refused.
    const other = await call('POST', '/api/repos', { name: 'other', path: initRepo() });
    const demo = (await call('GET', '/api/stats?range=7d&repo=demo')).json as StatsView;
    expect({ ...demo, repoId: null, at: stats.at }).toEqual(stats);
    expect(demo.repoId).toBe(hh.repo.id);
    const empty = (await call('GET', `/api/stats?range=all&repo=${other.json.id}`))
      .json as StatsView;
    expect(empty).toMatchObject({
      repoId: other.json.id,
      since: null,
      runs: { total: 0, byStatus: {}, completed: { count: 0, avgMs: null, medianMs: null } },
      tasks: 0,
      attempts: 0,
      cost: { runsUsd: 0, scoutsUsd: 0, byDay: [], byRepo: [] },
      agents: [],
      blocks: [],
    });
    expect((await call('GET', '/api/stats?repo=nope')).status).toBe(404);
    expect((await call('GET', '/api/stats?range=year')).status).toBe(400);
    // Seven days by default.
    expect(((await call('GET', '/api/stats')).json as StatsView).range).toBe('7d');

    // Move C ten days back: out of today and the last 7 days, still within 30.
    const back = (iso: string | null) =>
      iso && new Date(Date.parse(iso) - 10 * 86_400_000).toISOString();
    const db = store.db;
    const old = store.getRun(c.id);
    db.prepare('UPDATE runs SET created_at = ?, finished_at = ? WHERE id = ?').run(
      back(old.createdAt),
      back(old.finishedAt),
      c.id,
    );
    for (const t of store.listRunTasks(c.id)) {
      db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(back(t.createdAt), t.id);
    }
    for (const x of store.listRunAttempts(c.id)) {
      db.prepare('UPDATE attempts SET started_at = ?, ended_at = ? WHERE id = ?').run(
        back(x.startedAt),
        back(x.endedAt),
        x.id,
      );
    }
    for (const e of store.listEvents(c.id)) {
      db.prepare('UPDATE events SET ts = ? WHERE id = ?').run(back(e.ts), e.id);
    }
    const week = (await call('GET', '/api/stats?range=7d')).json as StatsView;
    const today = (await call('GET', '/api/stats?range=today')).json as StatsView;
    const month = (await call('GET', '/api/stats?range=30d')).json as StatsView;
    for (const s of [week, today]) {
      expect(s).toMatchObject({
        runs: { total: 3, byStatus: { completed: 2, waiting_approval: 1 } },
        tasks: 8,
        attempts: 10,
        cost: { runsUsd: 3, byDay: [{ runsUsd: 3, scoutsUsd: 0.3 }] },
        blocks: [{ kind: 'agent_error', count: 1 }],
      });
    }
    expect(today.since).toBe(statsSince('today'));
    expect(month).toMatchObject({
      runs: { total: 4 },
      attempts: 11,
      cost: {
        runsUsd: 3.5,
        byDay: [
          { day: localDay(new Date(Date.now() - 10 * 86_400_000)), runsUsd: 0.5, scoutsUsd: 0 },
          { day: localDay(new Date()), runsUsd: 3, scoutsUsd: 0.3 },
        ],
      },
    });
  });
});

describe('GET /api/agents', () => {
  const AGENTS = `${TEST_AGENTS_YAML}
  scout:
    cli: fake
    model: scout
  off: { cli: fake, model: off, enabled: false }
  broken: { cli: fake }
`;
  const CONFIG = `
github:
  repos:
    demo:
      template: dev
      scout:
        agent: scout
        auto: false
`;
  const LONG_ERROR = `模型不存在：${'x'.repeat(300)}`;

  it('sums executions, outcomes and costs per agent, with the latest error', async () => {
    const home = tmpDir('ares1-home-');
    const repoDir = initRepo();
    const gh = new FakeGitHub();
    const hh = await harness({ home, repoDir, agents: AGENTS, config: CONFIG, github: gh });
    h = hh;
    const store = hh.master.store;

    // No records yet: every agents.yaml entry, in file order, with zeros.
    const empty = (await call('GET', '/api/agents')).json as AgentSummary[];
    expect(empty.map((a) => [a.id, a.state])).toEqual([
      ['coder', 'enabled'],
      ['coder2', 'enabled'],
      ['reviewer', 'enabled'],
      ['scout', 'enabled'],
      ['off', 'disabled'],
      ['broken', 'invalid'],
    ]);
    expect(empty[0]).toMatchObject({
      entry: { id: 'coder', state: 'enabled', config: { cli: 'fake', model: 'coder' } },
      runs: { attempts: 0, costUsd: 0, costUnknown: 0, lastAt: null, lastError: null },
      scouts: { scouts: 0, costUsd: 0, costUnknown: 0, lastAt: null },
    });
    expect(empty[5]?.entry?.errors.length).toBeGreaterThan(0);

    // A: the check fails once (rework), then passes; the review passes.
    const codes = [null, 'ok\n'];
    hh.scripts.coder = (ctx) => {
      const write = codes.shift();
      if (write) writeFile(join(ctx.input.workdir, 'feature.txt'), write);
      return { ...done(), costUsd: 0.5 };
    };
    hh.scripts.reviewer = () => ({ ...review(), costUsd: 0.25 });
    const a = hh.run('A');
    await hh.waitStatus(a.id, 'waiting_approval');

    // B: the agent errors without a cost (blocked); a retry with coder2 (cost unknown) passes.
    hh.scripts.coder = () => ({ status: 'failed', error: `\n${LONG_ERROR}\n` });
    hh.scripts.coder2 = (ctx) => {
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return done();
    };
    const b = hh.run('B', blockOnAgentError());
    await hh.waitStatus(b.id, 'blocked');
    await call('POST', `/api/runs/${b.id}/retry`, { agentId: 'coder2' });
    await hh.waitStatus(b.id, 'waiting_approval');

    // C: terminated while coding: stopped, without an outcome or a cost.
    hh.scripts.coder = () => new Promise(() => {});
    const c = hh.run('C');
    await waitFor(() => store.listRunAttempts(c.id, 'running').length === 1, 'C coding');
    await call('POST', `/api/runs/${c.id}/cancel`);
    await hh.waitStatus(c.id, 'cancelled');

    // Two scouts: one with a cost, one that reports none.
    const costs = [0.3, undefined];
    hh.scripts.scout = () => ({ structured: { proposals: [] }, costUsd: costs.shift() });
    for (let i = 0; i < 2; i++) {
      const scout = await hh.master.issues.startScout('demo', 'manual');
      // Also wait for the scout to delete its temporary worktree: until then the repo is busy.
      await waitFor(
        () => store.getScout(scout.id).status === 'completed' && !hh.master.issues.scoutRunning,
        'scout completed',
      );
    }

    const agents = (await call('GET', '/api/agents')).json as AgentSummary[];
    const byId = new Map(agents.map((x) => [x.id, x]));
    const attemptsOf = (agentId: string) =>
      [a.id, b.id, c.id]
        .flatMap((id) => store.listRunAttempts(id))
        .filter((x) => x.agentId === agentId);
    const coderAttempts = attemptsOf('coder');
    const failed = coderAttempts.find((x) => x.outcome === 'agent_error') as Attempt;
    expect(failed.runId).toBe(b.id);

    expect(byId.get('coder')?.runs).toEqual({
      // A: rework, passed; B: error; C: stopped.
      attempts: 4,
      passed: 1,
      rework: 1,
      agentError: 1,
      stopped: 1,
      costUsd: 1,
      // The error and the stopped execution reported no cost: unknown, not $0.
      costUnknown: 2,
      lastAt: coderAttempts.at(-1)?.startedAt,
      lastError: {
        attemptId: failed.id,
        runId: b.id,
        at: failed.endedAt,
        message: LONG_ERROR.slice(0, 200),
        truncated: true,
      },
    });
    expect(byId.get('coder2')?.runs).toMatchObject({
      attempts: 1,
      passed: 1,
      rework: 0,
      agentError: 0,
      stopped: 0,
      costUsd: 0,
      costUnknown: 1,
      lastError: null,
    });
    expect(byId.get('reviewer')?.runs).toMatchObject({
      attempts: 2,
      passed: 2,
      costUsd: 0.5,
      costUnknown: 0,
      lastAt: attemptsOf('reviewer').at(-1)?.startedAt,
    });
    expect(byId.get('reviewer')?.scouts.scouts).toBe(0);
    expect(byId.get('scout')).toMatchObject({
      state: 'enabled',
      runs: { attempts: 0, costUsd: 0, costUnknown: 0 },
      scouts: { scouts: 2, costUsd: 0.3, costUnknown: 1 },
    });
    expect(byId.get('off')).toMatchObject({ state: 'disabled', runs: { attempts: 0 } });
    // The totals agree with the statistics page.
    const stats = (await call('GET', '/api/stats?range=all')).json as StatsView;
    const sum = (pick: (x: AgentSummary) => number) => agents.reduce((n, x) => n + pick(x), 0);
    expect(sum((x) => x.runs.attempts)).toBe(stats.attempts);
    expect(sum((x) => x.runs.costUsd)).toBeCloseTo(stats.cost.runsUsd, 8);
    expect(sum((x) => x.scouts.costUsd)).toBeCloseTo(stats.cost.scoutsUsd, 8);
    expect(sum((x) => x.runs.costUnknown)).toBe(stats.cost.unknownAttempts);
    expect(sum((x) => x.scouts.costUnknown)).toBe(stats.cost.unknownScouts);

    // coder2 leaves agents.yaml: still listed with its records, after the configured ones.
    await hh.close();
    h = await harness({
      home,
      repoDir,
      agents: AGENTS.replace(/\n {2}coder2:\n {4}cli: fake\n {4}model: coder2/, ''),
      config: CONFIG,
      github: gh,
    });
    const after = (await call('GET', '/api/agents')).json as AgentSummary[];
    expect(after.map((x) => [x.id, x.state])).toEqual([
      ['coder', 'enabled'],
      ['reviewer', 'enabled'],
      ['scout', 'enabled'],
      ['off', 'disabled'],
      ['broken', 'invalid'],
      ['coder2', 'removed'],
    ]);
    expect(after.at(-1)).toMatchObject({
      entry: null,
      runs: { attempts: 1, passed: 1, costUnknown: 1 },
    });
  });
});
