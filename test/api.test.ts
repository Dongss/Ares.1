import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeContext } from '../src/adapters/fake.js';
import { statsSince } from '../src/api/stats.js';
import type {
  AgentEventRecord,
  AgentSummary,
  BacklogRepoStatus,
  BacklogStatus,
  ConfigView,
  ConflictWait,
  GitHubStatus,
  HealthView,
  IterationView,
  KeptWorkspace,
  LiveAgentEvent,
  NotifyTestResult,
  ProposalAccepted,
  ProposalRestarted,
  ProposalView,
  RawLogMissing,
  RunSummary,
  StatsView,
} from '../src/api/types.js';
import { SCOUT_FAILURE_NOTIFY_AFTER } from '../src/config/flow.js';
import { findTemplate, githubConfigKey } from '../src/config/load.js';
import { storedRunTimes } from '../src/engine/times.js';
import { setLang } from '../src/i18n.js';
import { type ExecFile, noticeScript } from '../src/notify/system.js';
import { testNoticeText } from '../src/notify/test-notice.js';
import type { Fetch } from '../src/notify/webhook.js';
import type {
  Attempt,
  EventRow,
  Iteration,
  IterationChild,
  Proposal,
  Run,
  RunStatus,
  Scout,
} from '../src/store/types.js';
import {
  ASSESS_AGENTS_YAML,
  ASSESS_WORKFLOW_YAML,
  assessment,
  blockOnAgentError,
  blockOverBudget,
  done,
  FakeGitHub,
  FakeGitLab,
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
  setLang('zh');
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

  it('reads the templates a repo keeps when it is registered, changed or deleted', async () => {
    h = await harness();
    const dir = initRepo();
    const commitWorkflow = (name: string) => {
      writeFile(
        join(dir, '.ares1', 'workflows', 'x.yaml'),
        TEST_WORKFLOW_YAML.replace('id: dev', 'id: x').replace('name: 测试流程', `name: ${name}`),
      );
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', name);
    };
    commitWorkflow('主干的流程');
    git(dir, 'checkout', '-q', '-b', 'next');
    commitWorkflow('next 的流程');
    git(dir, 'checkout', '-q', 'main');
    const master = h.master;
    const name = () => findTemplate(master.config, 'mine', 'x')?.template.name;

    const created = await call('POST', '/api/repos', { name: 'mine', path: dir });
    expect(created.status).toBe(201);
    expect(name()).toBe('主干的流程');
    expect(findTemplate(master.config, 'demo', 'x')).toBeNull();
    expect((await call('PATCH', '/api/repos/mine', { targetBranch: 'next' })).status).toBe(200);
    expect(name()).toBe('next 的流程');
    expect((await call('DELETE', '/api/repos/mine')).status).toBe(204);
    expect(name()).toBeUndefined();
    expect(master.config.repoTemplates.has('mine')).toBe(false);
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

  it('reports whether a webhook is set, never its address or headers', async () => {
    h = await harness();
    expect((await call('GET', '/api/health')).json.webhookNotify).toBe(false);
    await h.close();
    h = undefined;
    h = await harness({
      config:
        'notify:\n  webhook:\n    url: https://ntfy.sh/topic-tk_secret\n    headers: { Authorization: Bearer tk_hidden }\n',
      master: { platform: 'win32' },
    });
    const health = await call('GET', '/api/health');
    expect(health.json).toMatchObject({ webhookNotify: true, systemNotify: false });
    expect(health.text).not.toContain('ntfy');
    expect(health.text).not.toContain('tk_');
  });

  it('reports every executing Run, one per repo, and the first as activeRun', async () => {
    h = await harness();
    const t = h;
    const idle: HealthView = (await call('GET', '/api/health')).json;
    expect(idle).toMatchObject({ activeRun: null, activeRuns: [] });
    t.master.store.createRepo({
      name: 'other',
      path: initRepo(),
      targetBranch: 'main',
      verifyCommands: [],
      setupCommands: [],
      mergeMode: 'direct',
    });
    // The coders run until they are stopped.
    t.scripts.coder = (ctx) =>
      new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve(done())));
    const first = t.run();
    const second = t.master.engine.createRun({ repo: 'other', template: 'dev', goal: 'g' });
    const third = t.run('同一个仓库的第二个');
    await waitFor(() => t.fake.calls.length === 2, 'both coders to start');
    const busy: HealthView = (await call('GET', '/api/health')).json;
    expect(busy).toMatchObject({ activeRun: first.id, activeRuns: [first.id, second.id] });
    expect(busy.activeRuns).not.toContain(third.id);

    await t.master.engine.pause(first.id);
    await waitFor(() => t.fake.calls.length === 3, 'the next coder to start');
    const paused: HealthView = (await call('GET', '/api/health')).json;
    // The repo's next Run takes its slot, after the other repo's Run.
    expect(paused).toMatchObject({ activeRun: second.id, activeRuns: [second.id, third.id] });
  });

  it('reports up to concurrency.per_repo executing Runs of a repo', async () => {
    h = await harness({ config: 'concurrency: { per_repo: 2 }\n' });
    const t = h;
    t.scripts.coder = (ctx) =>
      new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve(done())));
    const runs = [t.run('一'), t.run('二'), t.run('三')];
    await waitFor(() => t.fake.calls.length === 2, 'two coders to start');
    const busy: HealthView = (await call('GET', '/api/health')).json;
    expect(busy).toMatchObject({ activeRun: runs[0]?.id, activeRuns: [runs[0]?.id, runs[1]?.id] });
    const config: ConfigView = (await call('GET', '/api/config')).json;
    expect(config.perRepo).toBe(2);
    expect(config.maxRuns).toBeNull();
    // Without max_runs, no queued Run waits for the total.
    const list: RunSummary[] = (await call('GET', '/api/runs')).json;
    expect(list.map((r) => r.waitingForMaxRuns)).toEqual([false, false, false]);
  });

  it('reports concurrency.max_runs and the Runs queued because of it', async () => {
    h = await harness({ config: 'concurrency: { per_repo: 2, max_runs: 1 }\n' });
    const t = h;
    t.scripts.coder = (ctx) =>
      new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve(done())));
    const first = t.run('一');
    const second = t.run('二');
    await waitFor(() => t.fake.calls.length === 1, 'the first coder to start');
    const config: ConfigView = (await call('GET', '/api/config')).json;
    expect(config).toMatchObject({ perRepo: 2, maxRuns: 1 });
    const health: HealthView = (await call('GET', '/api/health')).json;
    expect(health.activeRuns).toEqual([first.id]);

    // The repo has room for the second, the total does not.
    const waiting = (id: string) =>
      call('GET', `/api/runs/${id}`).then((r) => r.json.waitingForMaxRuns);
    expect(await waiting(first.id)).toBe(false);
    expect(await waiting(second.id)).toBe(true);
    const list: RunSummary[] = (await call('GET', '/api/runs')).json;
    expect(Object.fromEntries(list.map((r) => [r.id, r.waitingForMaxRuns]))).toEqual({
      [first.id]: false,
      [second.id]: true,
    });

    // Paused, it waits for the human, not for the total.
    await t.master.engine.pause(second.id);
    expect(await waiting(second.id)).toBe(false);
    t.master.engine.resume(second.id);
    expect(await waiting(second.id)).toBe(true);

    // The first ending makes room: the second starts and waits no more.
    await t.master.engine.cancel(first.id);
    await waitFor(() => t.fake.calls.length === 2, 'the second coder to start');
    expect(await waiting(second.id)).toBe(false);
  });

  it('reports the Run a queued Run waits for, expected to change the same paths', async () => {
    h = await harness({
      config: 'concurrency: { per_repo: 2 }\n',
      agents: ASSESS_AGENTS_YAML,
      workflow: ASSESS_WORKFLOW_YAML,
    });
    const t = h;
    let coding = 0;
    // The coders run until they are stopped.
    t.scripts.coder = (ctx) => {
      coding++;
      return new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve(done())));
    };
    t.scripts.assessor = async (ctx) => {
      if (ctx.input.prompt.includes('目标甲')) return assessment('go', { touches: ['src/engine'] });
      // Assessed once the first codes, so that the first goes ahead.
      await waitFor(() => coding === 1, 'the first coder');
      return assessment('go', { touches: ['src', 'docs'] });
    };
    const first = t.run('目标甲');
    const second = t.run('目标乙');
    await waitFor(
      () =>
        t.master.store.getRun(second.id).status === 'queued' &&
        t.master.store.listEvents(second.id).some((e) => e.type === 'run.waiting_conflict'),
      'the second to wait for the first',
    );

    const waiting = (id: string): Promise<ConflictWait | null> =>
      call('GET', `/api/runs/${id}`).then((r) => r.json.waitingForConflict);
    expect(await waiting(first.id)).toBeNull();
    expect(await waiting(second.id)).toEqual({ runId: first.id, paths: ['src/engine'] });
    const list: RunSummary[] = (await call('GET', '/api/runs')).json;
    expect(Object.fromEntries(list.map((r) => [r.id, r.waitingForConflict]))).toEqual({
      [first.id]: null,
      [second.id]: { runId: first.id, paths: ['src/engine'] },
    });
    // It waits for the Run it overlaps, not for room.
    expect(list.map((r) => r.waitingForMaxRuns)).toEqual([false, false]);

    // The first ending, the second goes on and waits no more.
    await t.master.engine.cancel(first.id);
    await waitFor(() => coding === 2, 'the second coder to start');
    expect(await waiting(second.id)).toBeNull();
    const after: RunSummary[] = (await call('GET', '/api/runs')).json;
    expect(after.map((r) => r.waitingForConflict)).toEqual([null, null]);
  });

  it('tells a raw log deleted past retention from a missing one, and keeps the events', async () => {
    h = await harness();
    const { store, logPruner } = h.master;
    const id = h.run('加功能').id;
    await h.waitStatus(id, 'waiting_approval');
    expect((await call('POST', `/api/runs/${id}/approve`, { comment: 'ok' })).status).toBe(200);
    await h.waitStatus(id, 'completed');
    const attempts = store.listRunAttempts(id);
    const [attempt] = attempts;
    if (!attempt) throw new Error('no attempt');
    const events = await call('GET', `/api/attempts/${attempt.id}/events`);
    expect((events.json as AgentEventRecord[]).length).toBeGreaterThan(0);
    const rawFiles = attempts
      .flatMap((a) => [a.logPath, `${a.logPath}.stderr`])
      .filter((f) => existsSync(f));
    expect(rawFiles).toContain(attempt.logPath);

    // Ended a day ago: kept.
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    store.updateRun(id, { finishedAt: daysAgo(1) });
    expect(logPruner.prune().files).toBe(0);
    expect((await call('GET', `/api/attempts/${attempt.id}/log`)).status).toBe(200);

    store.updateRun(id, { finishedAt: daysAgo(31) });
    expect(logPruner.prune()).toMatchObject({ runs: 1, scouts: 0, files: rawFiles.length });
    expect(existsSync(attempt.logPath)).toBe(false);
    // The dashboard shows the agent output from the events, which stay.
    expect(await call('GET', `/api/attempts/${attempt.id}/events`)).toEqual(events);
    const pruned = await call('GET', `/api/attempts/${attempt.id}/log`);
    expect(pruned.status).toBe(404);
    expect(pruned.json).toEqual({
      error: '原始日志已超过保留期（Run 结束 30 天后）被删除，Agent 输出仍可在 Run 详情页查看',
      pruned: true,
    } satisfies RawLogMissing);
    setLang('en');
    const prunedEn = await call('GET', `/api/attempts/${attempt.id}/log?download`);
    expect(prunedEn).toMatchObject({ status: 404, json: { pruned: true } });
    expect(prunedEn.json.error).not.toMatch(/[一-鿿]/);
    setLang('zh');

    // Gone while its Run is within retention: missing, not pruned.
    store.updateRun(id, { finishedAt: daysAgo(1) });
    const missing = await call('GET', `/api/attempts/${attempt.id}/log`);
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual({
      error: '日志文件不存在',
      pruned: false,
    } satisfies RawLogMissing);
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

  it("gives a Run's pull request (deliver: pr), and refuses to retry one waiting for it", async () => {
    h = await harness({
      config:
        'github:\n  repos:\n    demo:\n      template: dev\n      push: true\n      deliver: pr\n',
      github: new FakeGitHub(),
    });
    const t = h;
    const id = t.run('加功能', { stages: { merge: { gate: false } } }).id;
    await t.waitStatus(id, 'blocked');
    await waitFor(() => t.master.engine.activeRunIds.length === 0, 'the execution slot');
    const waiting = await call('GET', `/api/runs/${id}`);
    expect(waiting.json.run).toMatchObject({ status: 'blocked', blocked: { kind: 'pr_open' } });
    expect(waiting.json.run.pr).toBeNull();
    expect((await call('GET', '/api/runs')).json[0].pr).toBeNull();
    expect((await call('POST', `/api/runs/${id}/retry`, {})).status).toBe(409);

    const pr = { number: 7, url: 'https://github.com/me/demo/pull/7' };
    t.master.engine.recordPullRequest(t.master.store.getRun(id), pr);
    expect((await call('GET', `/api/runs/${id}`)).json.run.pr).toEqual(pr);
    const [summary] = (await call('GET', '/api/runs')).json as RunSummary[];
    expect(summary?.pr).toEqual(pr);
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
    // The CLIs it has adapters for, and whether they run read-only.
    expect(json.clis).toEqual([{ cli: 'fake', readOnly: true }]);
  });

  it('exposes config sources, disabled agents and invalid template files', async () => {
    const agents = `${TEST_AGENTS_YAML}  off: { cli: fake, model: off, enabled: false }\n`;
    const home = tmpDir('ares1-home-');
    writeFile(join(home, 'workflows', 'broken.yaml'), 'id: dev2\nstages: []\n');
    h = await harness({ home, agents });
    const { json } = (await call('GET', '/api/config')) as { json: ConfigView };
    // config.yaml leaves concurrency out: one Run of a repo at a time, no limit across repos.
    expect(json.perRepo).toBe(1);
    expect(json.maxRuns).toBeNull();
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

  it('exposes the templates each repo keeps, with what became of their files', async () => {
    h = await harness();
    const { repoDir, master } = h;
    const workflows = join(repoDir, '.ares1', 'workflows');
    const X = TEST_WORKFLOW_YAML.replace('id: dev', 'id: x');
    const commit = (files: Record<string, string>) => {
      for (const [file, source] of Object.entries(files)) writeFile(join(workflows, file), source);
      git(repoDir, 'add', '-A');
      git(repoDir, 'commit', '-q', '-m', 'workflows');
      return git(repoDir, 'rev-parse', 'HEAD');
    };
    const get = async () => ((await call('GET', '/api/config')) as { json: ConfigView }).json;
    expect((await get()).repoTemplates).toEqual([]);

    // One valid, one the home directory overrides (same id), one invalid.
    const first = commit({ 'x.yaml': X, 'dev.yaml': TEST_WORKFLOW_YAML, 'bad.yaml': 'id: bad\n' });
    // Uncommitted changes play no part.
    writeFile(join(workflows, 'y.yaml'), X.replace('id: x', 'id: y'));
    await master.repoWorkflows.refresh();
    const json = await get();
    // The home directory's own templates are as before.
    expect(json.templates.map((t) => t.id)).toEqual(['dev']);
    expect(json.repoTemplates).toHaveLength(1);
    const [demo] = json.repoTemplates;
    expect(demo).toMatchObject({ repo: 'demo', branch: 'main', sha: first });
    expect(demo?.templates.map((t) => t.id).sort()).toEqual(['dev', 'x']);
    expect(demo?.files.map((f) => [f.file, f.templateId, f.shadowed ?? false])).toEqual([
      ['bad.yaml', null, false],
      ['dev.yaml', 'dev', true],
      ['x.yaml', 'x', false],
    ]);
    expect(demo?.files[0]?.errors).toEqual(json.errors['demo:.ares1/workflows/bad.yaml']);
    expect(demo?.files[2]).toMatchObject({
      key: 'demo:.ares1/workflows/x.yaml',
      path: '.ares1/workflows/x.yaml',
      source: X,
      errors: [],
    });
    // The structured flag says it; the configuration's warnings word it.
    expect(demo?.files[1]?.warnings).toEqual([]);
    expect(json.warnings['demo:.ares1/workflows/dev.yaml']).toEqual([
      expect.stringMatching(/^数据目录里也有 id 为 dev 的模板（workflows\/dev\.yaml）/),
    ]);

    // Broken on the target branch: the version that last loaded stays, marked with its commit.
    const second = commit({ 'x.yaml': 'id: [\n' });
    await master.repoWorkflows.refresh();
    const broken = (await get()).repoTemplates[0];
    expect(broken?.sha).toBe(second);
    const x = broken?.files.find((f) => f.file === 'x.yaml');
    expect(x).toMatchObject({ templateId: 'x', source: 'id: [\n', errors: [], warnings: [] });
    expect(x?.lastGood).toMatchObject({ sha: first, source: X });
    expect(x?.lastGood?.errors).toEqual([expect.stringMatching(/不是合法的 YAML/)]);
    expect(broken?.templates.find((t) => t.id === 'x')?.name).toBe('测试流程');

    // Repos in name order.
    const other = initRepo();
    writeFile(join(other, '.ares1', 'workflows', 'z.yaml'), X.replace('id: x', 'id: z'));
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'workflows');
    expect((await call('POST', '/api/repos', { name: 'alpha', path: other })).status).toBe(201);
    expect((await get()).repoTemplates.map((r) => r.repo)).toEqual(['alpha', 'demo']);
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

describe('POST /api/notify/test', () => {
  /** The token in the webhook's address and headers: never to be returned. */
  const TOKEN = 'tk_secret_token';
  const WEBHOOK_URL = `https://hooks.example.com/hook?auth=${TOKEN}`;
  const notifyYaml = (opts: { system?: boolean; webhook?: boolean }) =>
    [
      'notify:',
      `  system: ${opts.system ?? false}`,
      ...(opts.webhook
        ? [
            '  webhook:',
            `    url: ${WEBHOOK_URL}`,
            `    headers: { Authorization: Bearer ${TOKEN} }`,
          ]
        : []),
      '',
    ].join('\n');

  /** A fetch that records its requests and answers each with `answer()`. */
  function fakeFetch(answer: () => Response = () => new Response('ok')) {
    const requests: { url: string; headers: Headers; body: string }[] = [];
    const fetch: Fetch = async (url, init) => {
      requests.push({
        url,
        headers: new Headers(init.headers),
        body: String(init.body),
      });
      return answer();
    };
    return { requests, fetch };
  }

  /** An execFile that records its calls and answers each with `fail()`'s error, if any. */
  function fakeExecFile(fail: () => Error | null = () => null) {
    const calls: { file: string; args: string[] }[] = [];
    const execFile: ExecFile = (file, args, _options, callback) => {
      calls.push({ file, args });
      callback(fail());
    };
    return { calls, execFile };
  }

  const failures = () => h?.master.store.listEventsOfType('notify.webhook_failed', '') ?? [];
  const globalEventIds = () => h?.master.store.listGlobalEvents({ limit: 500 }).map((e) => e.id);
  const scoutFailed = () =>
    h?.master.store.event(null, 'scout.failed', {
      scoutId: 'scout_1',
      repo: 'demo',
      message: '侦察结果不符合约定',
      streak: SCOUT_FAILURE_NOTIFY_AFTER,
    });

  async function sendTest() {
    const res = await call('POST', '/api/notify/test');
    expect(res.status).toBe(200);
    // Neither the address nor the headers of the webhook come back.
    expect(res.text).not.toContain(TOKEN);
    expect(res.text).not.toContain('example.com');
    expect(res.text).not.toContain('Bearer');
    return res.json as NotifyTestResult;
  }

  it('sends through both channels and tells how each went, recording nothing', async () => {
    const hook = fakeFetch();
    const exec = fakeExecFile();
    h = await harness({
      config: notifyYaml({ system: true, webhook: true }),
      master: { platform: 'darwin', fetch: hook.fetch, execFile: exec.execFile },
    });
    const before = globalEventIds();
    const startedAt = new Date().toISOString();
    expect(await sendTest()).toEqual({
      system: { enabled: true, supported: true, ok: true, reason: null },
      webhook: { enabled: true, ok: true, status: 200, reason: null },
    } satisfies NotifyTestResult);

    expect(exec.calls).toEqual([
      { file: 'osascript', args: ['-e', noticeScript('测试通知', testNoticeText().body)] },
    ]);
    expect(hook.requests).toHaveLength(1);
    const [request] = hook.requests;
    expect(request?.url).toBe(WEBHOOK_URL);
    expect(request?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(request?.headers.get('content-type')).toBe('application/json');
    const payload = JSON.parse(request?.body ?? '');
    expect(payload).toEqual({
      kind: 'test',
      title: '测试通知',
      body: '这是一条测试通知，收到说明通知通道可用。',
      text: '测试通知\n这是一条测试通知，收到说明通知通道可用。',
      runId: null,
      about: 'master',
      eventType: 'notify.test',
      at: expect.any(String),
    });
    expect(payload.at >= startedAt).toBe(true);
    // A check of the channels, not something that happened: no event.
    expect(globalEventIds()).toEqual(before);
  });

  it('returns the HTTP status of a failing webhook without recording notify.webhook_failed', async () => {
    let answer = () => new Response('no', { status: 500, statusText: 'Internal Server Error' });
    const hook = fakeFetch(() => answer());
    h = await harness({
      config: notifyYaml({ webhook: true }),
      master: { platform: 'darwin', fetch: hook.fetch },
    });
    const before = globalEventIds();
    expect(await sendTest()).toEqual({
      system: { enabled: false, supported: true, ok: false, reason: null },
      webhook: { enabled: true, ok: false, status: 500, reason: 'HTTP 500 Internal Server Error' },
    } satisfies NotifyTestResult);
    expect(globalEventIds()).toEqual(before);

    // Not answering at all: the reason hides the address it names.
    answer = () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error(`connect ECONNREFUSED ${WEBHOOK_URL}`), {
          code: 'ECONNREFUSED',
        }),
      });
    };
    expect((await sendTest()).webhook).toEqual({
      enabled: true,
      ok: false,
      status: null,
      reason: 'fetch failed (connect ECONNREFUSED ***)',
    });
    expect(failures()).toEqual([]);

    // The streak of the real notifications was left alone: their first failure is still told.
    scoutFailed();
    await h.master.webhook.idle();
    expect(failures()).toHaveLength(1);
    // A test getting through does not end their streak either: the next one is not told again.
    answer = () => new Response('ok', { status: 202 });
    expect((await sendTest()).webhook).toEqual({
      enabled: true,
      ok: true,
      status: 202,
      reason: null,
    });
    answer = () => new Response('no', { status: 500 });
    scoutFailed();
    await h.master.webhook.idle();
    expect(failures()).toHaveLength(1);
    expect(hook.requests.map((r) => JSON.parse(r.body).kind)).toEqual([
      'test',
      'test',
      'scout',
      'test',
      'scout',
    ]);
  });

  it('sends no webhook when none is set, and tells why a system notification failed', async () => {
    const hook = fakeFetch();
    let fail: Error | null = null;
    const exec = fakeExecFile(() => fail);
    h = await harness({
      config: notifyYaml({ system: true }),
      master: { platform: 'linux', fetch: hook.fetch, execFile: exec.execFile },
    });
    expect(await sendTest()).toEqual({
      system: { enabled: true, supported: true, ok: true, reason: null },
      webhook: { enabled: false, ok: false, status: null, reason: null },
    } satisfies NotifyTestResult);
    expect(hook.requests).toEqual([]);
    expect(exec.calls).toEqual([
      { file: 'notify-send', args: ['--app-name', '战神一号', '测试通知', testNoticeText().body] },
    ]);

    fail = Object.assign(new Error('spawn notify-send ENOENT'), { code: 'ENOENT' });
    const { system } = await sendTest();
    expect(system).toMatchObject({ enabled: true, ok: false });
    expect(system.reason).toContain('libnotify');
  });

  it('sends no system notification where the platform has none', async () => {
    const hook = fakeFetch();
    const exec = fakeExecFile();
    h = await harness({
      config: notifyYaml({ system: true, webhook: true }),
      master: { platform: 'win32', fetch: hook.fetch, execFile: exec.execFile },
    });
    expect(await sendTest()).toEqual({
      system: { enabled: false, supported: false, ok: false, reason: null },
      webhook: { enabled: true, ok: true, status: 200, reason: null },
    } satisfies NotifyTestResult);
    expect(exec.calls).toEqual([]);
    expect(hook.requests).toHaveLength(1);
  });

  it('sends nothing without a channel', async () => {
    const hook = fakeFetch();
    const exec = fakeExecFile();
    h = await harness({
      config: notifyYaml({}),
      master: { platform: 'darwin', fetch: hook.fetch, execFile: exec.execFile },
    });
    expect(await sendTest()).toEqual({
      system: { enabled: false, supported: true, ok: false, reason: null },
      webhook: { enabled: false, ok: false, status: null, reason: null },
    } satisfies NotifyTestResult);
    expect(exec.calls).toEqual([]);
    expect(hook.requests).toEqual([]);
  });

  it('follows the language of config.yaml', async () => {
    const hook = fakeFetch(() => new Response('no', { status: 503 }));
    const exec = fakeExecFile(() =>
      Object.assign(new Error('spawn notify-send ENOENT'), { code: 'ENOENT' }),
    );
    h = await harness({
      config: `language: en\n${notifyYaml({ system: true, webhook: true })}`,
      master: { platform: 'linux', fetch: hook.fetch, execFile: exec.execFile },
    });
    const res = await call('POST', '/api/notify/test');
    expect(res.text).not.toMatch(/[一-鿿]/);
    expect(res.json.system.reason).toContain('install libnotify');
    expect(JSON.parse(hook.requests[0]?.body ?? '')).toMatchObject({
      kind: 'test',
      title: 'Test notification',
      text: `Test notification\n${testNoticeText().body}`,
    });
    expect(hook.requests[0]?.body).not.toMatch(/[一-鿿]/);
    expect(exec.calls[0]?.args).toContain('Test notification');
  });
});

describe('GET /api/scouts', () => {
  it("returns each scout's gap analysis, null for a scout without one", async () => {
    h = await harness();
    const store = h.master.store;
    const scout = (status: Scout['status']) =>
      store.updateScout(
        store.createScout({
          repoId: (h as Harness).repo.id,
          issuesRepo: 'me/demo',
          trigger: 'auto',
          agentId: 'scout',
          model: null,
          logPath: '/l',
        }).id,
        { status },
      );
    const failed = scout('failed');
    const empty = store.updateScout(scout('completed').id, { gaps: [] });
    const gaps = [
      { goal: '永动', gap: '同一时间只跑一个 Run', evidence: ['src/engine/engine.ts:421'] },
    ];
    const found = store.updateScout(scout('completed').id, { gaps });

    const res = await call('GET', '/api/scouts?repo=demo');
    expect(res.status).toBe(200);
    const byId = new Map((res.json as Scout[]).map((s) => [s.id, s.gaps]));
    expect(byId.get(failed.id)).toBeNull();
    expect(byId.get(empty.id)).toEqual([]);
    expect(byId.get(found.id)).toEqual(gaps);
  });
});

describe('GET /api/github', () => {
  it("gives each repo's auto-accept limits, max_size L by default", async () => {
    const config = (acceptLines: string) => `
github:
  repos:
    demo:
      template: dev
      auto_accept:
${acceptLines}
`;
    h = await harness({ config: config('        max_risk: high'), github: new FakeGitHub() });
    const autoAccept = async () =>
      ((await call('GET', '/api/github')).json as GitHubStatus).repos[0]?.autoAccept;
    expect(await autoAccept()).toEqual({
      maxRisk: 'high',
      maxSize: 'L',
      maxPerDay: null,
      usedToday: 0,
    });

    writeFile(
      join(h.home, 'config.yaml'),
      config('        max_risk: low\n        max_size: M\n        max_per_day: 2'),
    );
    h.master.configWatcher.reload();
    expect(await autoAccept()).toEqual({
      maxRisk: 'low',
      maxSize: 'M',
      maxPerDay: 2,
      usedToday: 0,
    });
  });

  it("gives each repo's way of delivering, and why pr without push disables it", async () => {
    const config = (lines: string) => `
github:
  repos:
    demo:
      template: dev
${lines}`;
    h = await harness({ config: config(''), github: new FakeGitHub() });
    const repo = async () => ((await call('GET', '/api/github')).json as GitHubStatus).repos[0];
    expect(await repo()).toMatchObject({ push: false, deliver: 'push', problems: [] });

    const reload = (lines: string) => {
      writeFile(join((h as Harness).home, 'config.yaml'), config(lines));
      (h as Harness).master.configWatcher.reload();
    };
    reload('      push: true\n      deliver: pr\n');
    expect(await repo()).toMatchObject({ push: true, deliver: 'pr', problems: [] });

    // Without push the repo is disabled; the problem shows on the repo and the config page.
    reload('      deliver: pr\n');
    const problem =
      'deliver: pr 要求 push: true：开 PR 要先把 Run 的分支推送到 GitHub，PR 合并后还要从 GitHub 拉取目标分支';
    expect(await repo()).toMatchObject({ push: false, deliver: 'pr', problems: [problem] });
    const { json } = (await call('GET', '/api/config')) as { json: ConfigView };
    expect(json.errors[githubConfigKey('demo')]).toEqual([problem]);
  });

  it('says which platform it is, GitHub without a host', async () => {
    h = await harness({ config: 'github:\n  repos: {}\n', github: new FakeGitHub() });
    expect((await call('GET', '/api/github')).json).toMatchObject({
      platform: 'github',
      host: null,
      enabled: true,
    } satisfies Partial<GitHubStatus>);
  });
});

describe('GET /api/gitlab', () => {
  const AGENTS = `${TEST_AGENTS_YAML}
  scout:
    cli: fake
    model: scout
`;
  const CONFIG = `
gitlab:
  host: gitlab.example.com:8443
  poll_minutes: 3
  repos:
    demo:
      issues_repo: grp/sub/demo
      template: dev
      scout: { agent: scout, auto: false }
      push: true
`;

  it('gives the platform, its host and its repos, and polls it on demand', async () => {
    const gl = new FakeGitLab('grp/sub/demo', 'gitlab.example.com:8443');
    const gh = new FakeGitHub();
    h = await harness({ agents: AGENTS, config: CONFIG, gitlab: gl, github: gh });
    const res = await call('GET', '/api/gitlab');
    expect(res.status).toBe(200);
    const status = res.json as GitHubStatus;
    expect(status).toMatchObject({
      platform: 'gitlab',
      host: 'gitlab.example.com:8443',
      enabled: true,
      account: null,
      pollMinutes: 3,
      lastPollAt: null,
      lastError: null,
    });
    expect(status.repos).toEqual([
      expect.objectContaining({
        name: 'demo',
        issuesRepo: 'grp/sub/demo',
        push: true,
        deliver: 'push',
        problems: [],
      }),
    ]);
    // GitHub's section is another's: none in config.yaml.
    expect((await call('GET', '/api/github')).json).toMatchObject({
      platform: 'github',
      enabled: false,
      repos: [],
    });

    gl.add({ title: '加 feature', labels: ['ares1:ready'] });
    const polled = await call('POST', '/api/gitlab/poll');
    expect(polled.status).toBe(200);
    expect((polled.json as GitHubStatus).lastPollAt).toEqual(expect.any(String));
    expect(h.master.store.listRuns()[0]?.issue).toMatchObject({
      repo: 'grp/sub/demo',
      platform: 'gitlab',
      url: 'https://gitlab.example.com:8443/grp/sub/demo/-/issues/1',
    });
    expect(gh.calls).toEqual([]);
  });

  it("tells on GET /api/config where each repo's requirements come from", async () => {
    const config = `
github:
  repos:
    hub: { issues_repo: me/hub, template: dev }
    guessed: { template: dev }
gitlab:
  host: gitlab.example.com:8443
  repos:
    lab: { issues_repo: grp/sub/lab, template: dev }
    hub: { issues_repo: grp/hub, template: dev }
backlog:
  repos:
    local: { template: dev }
    lab: { template: dev }
`;
    h = await harness({ config, gitlab: new FakeGitLab(), github: new FakeGitHub() });
    const { json } = (await call('GET', '/api/config')) as { json: ConfigView };
    // A name in two sources is the first's, as requirementSource has it; the later one is an error.
    expect(json.repoSources).toEqual({
      guessed: { source: 'github', issuesRepo: null },
      hub: { source: 'github', issuesRepo: 'me/hub' },
      lab: { source: 'gitlab', host: 'gitlab.example.com:8443', issuesRepo: 'grp/sub/lab' },
      local: { source: 'backlog' },
    });
    expect(Object.keys(json.errors)).toEqual(
      expect.arrayContaining(['config.yaml#gitlab.repos.hub', 'config.yaml#backlog.repos.lab']),
    );
  });

  it('starts the scout of a GitLab repo through GitLab', async () => {
    const gl = new FakeGitLab();
    const gh = new FakeGitHub();
    h = await harness({ agents: AGENTS, config: CONFIG, gitlab: gl, github: gh });
    const t = h;
    t.scripts.scout = () => ({ structured: { gaps: [], proposals: [] } });
    const res = await call('POST', '/api/scouts', { repo: 'demo' });
    expect(res.status).toBe(201);
    expect(res.json as Scout).toMatchObject({ trigger: 'manual', issuesRepo: 'grp/sub/demo' });
    await waitFor(
      () => t.master.store.getScout(res.json.id).status !== 'running' && !t.master.scouting.running,
      'scout to finish',
    );
    expect(t.master.store.getScout(res.json.id).status).toBe('completed');
    expect([...gl.projects]).toEqual(['grp/sub/demo']);
    expect(gh.calls).toEqual([]);
  });
});

describe('local backlog API', () => {
  const AGENTS = `${TEST_AGENTS_YAML}
  scout:
    cli: fake
    model: scout
`;
  /** Only backlog.repos; `other` is not registered on the dashboard. */
  const CONFIG = `
backlog:
  poll_minutes: 7
  repos:
    demo:
      template: dev
      scout:
        agent: scout
        auto: false
        max_proposals: 3
      auto_accept:
        max_risk: low
        max_size: M
        max_per_day: 2
      auto_merge: true
      daily_budget_usd: 5
    other:
      template: dev
`;
  let gh: FakeGitHub;

  /** A Master whose GitHub is fake, so that any call to it shows in `gh.calls`. */
  async function start(config = CONFIG): Promise<Harness> {
    gh = new FakeGitHub();
    h = await harness({ agents: AGENTS, config, github: gh });
    return h;
  }

  /** A pending proposal of the repo, as a scout files it. */
  const propose = (repoId: string, title: string, risk: Proposal['risk'] = 'high') =>
    (h as Harness).master.store.createProposal({
      repoId,
      scoutId: null,
      title,
      category: 'improvement',
      size: 'M',
      risk,
      why: `${title}的原因`,
      evidence: ['run_abc 返工了 3 轮'],
      what: `${title}的做法`,
      acceptance: ['测试通过'],
    });

  const titles = async (path: string) =>
    ((await call('GET', path)).json as ProposalView[]).map((p) => p.title);

  /** Wait until the scout has ended, its temporary worktree deleted. */
  async function scoutDone(t: Harness, id: string): Promise<Scout> {
    await waitFor(
      () => t.master.store.getScout(id).status !== 'running' && !t.master.scouting.running,
      'scout to finish',
    );
    return t.master.store.getScout(id);
  }

  it("gives each repo's settings, scout, auto-accept and pending proposals", async () => {
    const t = await start();
    propose(t.repo.id, '要人定的');
    const rejected = propose(t.repo.id, '不想要的');
    t.master.store.updateProposal(rejected.id, { status: 'rejected', rejectReason: '不划算' });

    const res = await call('GET', '/api/backlog');
    expect(res.status).toBe(200);
    expect(res.json as BacklogStatus).toEqual({
      enabled: true,
      pollMinutes: 7,
      lastPollAt: null,
      lastError: null,
      repos: [
        {
          name: 'demo',
          template: 'dev',
          problems: [],
          scout: {
            agent: 'scout',
            auto: false,
            intervalMinutes: 0,
            maxProposals: 3,
            running: false,
            lastAt: null,
            waiting: null,
          },
          autoAccept: { maxRisk: 'low', maxSize: 'M', maxPerDay: 2, usedToday: 0 },
          autoMerge: true,
          budget: { dailyUsd: 5, spentToday: 0, reached: false },
          maxRunAttempts: 3,
          pendingProposals: 1,
        },
        {
          name: 'other',
          template: 'dev',
          problems: ['仓库 other 没有在看板上登记'],
          scout: null,
          autoAccept: { maxRisk: 'none', maxSize: 'L', maxPerDay: null, usedToday: 0 },
          autoMerge: false,
          budget: { dailyUsd: null, spentToday: 0, reached: false },
          maxRunAttempts: 3,
          pendingProposals: 0,
        },
      ] satisfies BacklogRepoStatus[],
    });

    // A poll now: the proposal beyond auto-accept stays for a human, the scout only by hand.
    const polled = await call('POST', '/api/backlog/poll');
    expect(polled.status).toBe(200);
    const status = polled.json as BacklogStatus;
    expect(status.lastPollAt).toEqual(expect.any(String));
    expect(status.repos[0]).toMatchObject({
      pendingProposals: 1,
      scout: { waiting: { reason: '只在看板上手动触发' } },
    });
    expect(t.master.store.listRuns()).toHaveLength(0);
    expect(gh.calls).toEqual([]);
  });

  it('is disabled without a backlog section', async () => {
    // The config.yaml written on first start.
    h = await harness();
    expect((await call('GET', '/api/backlog')).json).toEqual({
      enabled: false,
      pollMinutes: 5,
      lastPollAt: null,
      lastError: null,
      repos: [],
    } satisfies BacklogStatus);
    expect((await call('GET', '/api/proposals')).json).toEqual([]);
  });

  it('lists proposals newest first, filtered by repo and status', async () => {
    const t = await start();
    const other = t.master.store.createRepo({
      name: 'other',
      path: initRepo(),
      targetBranch: 'main',
      verifyCommands: [],
      setupCommands: [],
      mergeMode: 'direct',
    });
    propose(t.repo.id, 'A');
    const b = propose(t.repo.id, 'B');
    t.master.store.updateProposal(b.id, { status: 'rejected', rejectReason: '不划算' });
    propose(other.id, 'C');

    const all = await call('GET', '/api/proposals');
    expect(all.status).toBe(200);
    expect((all.json as ProposalView[]).map((p) => [p.title, p.repo, p.status])).toEqual([
      ['C', 'other', 'pending'],
      ['B', 'demo', 'rejected'],
      ['A', 'demo', 'pending'],
    ]);
    expect(all.json[1]).toMatchObject({
      id: b.id,
      repoId: t.repo.id,
      rejectReason: '不划算',
      runId: null,
      runStatus: null,
      evidence: ['run_abc 返工了 3 轮'],
      acceptance: ['测试通过'],
    });
    expect(await titles('/api/proposals?repo=demo')).toEqual(['B', 'A']);
    expect(await titles(`/api/proposals?repo=${other.id}`)).toEqual(['C']);
    expect(await titles('/api/proposals?status=pending')).toEqual(['C', 'A']);
    expect(await titles('/api/proposals?repo=demo&status=rejected')).toEqual(['B']);
    expect(await titles('/api/proposals?repo=demo&status=accepted')).toEqual([]);
    expect(await titles('/api/proposals?limit=2')).toEqual(['C', 'B']);

    expect((await call('GET', '/api/proposals?status=done')).status).toBe(400);
    expect((await call('GET', '/api/proposals?limit=0')).status).toBe(400);
    expect((await call('GET', '/api/proposals?limit=501')).status).toBe(400);
    expect((await call('GET', '/api/proposals?state=pending')).status).toBe(400);
    expect((await call('GET', '/api/proposals?repo=nowhere')).status).toBe(404);
  });

  it('says when a proposal whose Run failed is redone, and lists the failed ones', async () => {
    const t = await start();
    const store = t.master.store;
    const failedRun = (goal: string) => {
      const run = t.run(goal);
      const ended = '2026-11-25T08:00:00.000Z';
      return store.updateRun(run.id, { status: 'failed', finishedAt: ended, error: '失败了' });
    };
    const waiting = propose(t.repo.id, '等重做的');
    const run = failedRun('等重做的');
    const failure = { runId: run.id, attempt: 1, stage: '编码', error: '失败了' };
    store.updateProposal(waiting.id, {
      status: 'accepted',
      runId: run.id,
      redo: 'pending',
      failures: [failure],
    });
    const given = propose(t.repo.id, '放弃的');
    const last = failedRun('放弃的');
    store.updateProposal(given.id, {
      status: 'failed',
      runId: last.id,
      redo: 'exhausted',
      failures: [{ ...failure, runId: last.id }],
    });

    const listed = (await call('GET', '/api/proposals')).json as ProposalView[];
    // The first failure waits poll_minutes (7) after the Run ended.
    expect(listed.find((p) => p.id === waiting.id)).toMatchObject({
      status: 'accepted',
      runStatus: 'failed',
      attempt: 1,
      maxAttempts: 3,
      failures: [failure],
      redo: 'pending',
      redoAt: '2026-11-25T08:07:00.000Z',
      restartable: false,
    });
    expect(listed.find((p) => p.id === given.id)).toMatchObject({
      status: 'failed',
      runStatus: 'failed',
      attempt: 1,
      maxAttempts: 3,
      redo: 'exhausted',
      redoAt: null,
      restartable: true,
    });
    expect(await titles('/api/proposals?status=failed')).toEqual(['放弃的']);

    // A step of an iteration is redone the same way, only while its iteration still wants it.
    const step = propose(t.repo.id, '迭代的一步');
    const stepRun = failedRun('迭代的一步');
    const iteration = store.createIteration({
      repoId: t.repo.id,
      scoutId: null,
      source: 'local',
      issuesRepo: '',
      title: '本地迭代',
      goal: '本地仓库也能永动',
      readmeGoal: '永动',
      criteria: ['能演示'],
      outOfScope: [],
      children: [
        {
          title: '迭代的一步',
          category: 'feature',
          size: 'M',
          risk: 'low',
          why: '',
          evidence: [],
          what: '',
          acceptance: [],
          position: 1,
          criteria: [1],
          dependsOn: [],
          closeout: false,
          proposalId: step.id,
          status: 'running',
          runIds: [stepRun.id],
        },
      ],
    });
    store.updateIteration(iteration.id, { status: 'active' });
    store.updateProposal(step.id, {
      status: 'accepted',
      runId: stepRun.id,
      redo: 'pending',
      failures: [{ ...failure, runId: stepRun.id }],
      iterationId: iteration.id,
    });
    const redoAtOf = async (id: string) =>
      ((await call('GET', '/api/proposals')).json as ProposalView[]).find((p) => p.id === id)
        ?.redoAt;
    expect(await redoAtOf(step.id)).toBe('2026-11-25T08:07:00.000Z');
    // Its iteration's page tells the same of the step.
    const stepView = async () =>
      ((await call('GET', `/api/iterations/${iteration.id}`)).json as IterationView).children[0];
    expect(await stepView()).toMatchObject({
      proposalId: step.id,
      attempt: 1,
      maxAttempts: 3,
      redoAt: '2026-11-25T08:07:00.000Z',
      failures: [{ ...failure, runId: stepRun.id }],
      restartable: false,
    });
    // Cancelled by a human: the step is dropped and not redone.
    store.updateIteration(iteration.id, {
      status: 'cancelled',
      children: store
        .getIteration(iteration.id)
        .children.map((c) => ({ ...c, status: 'dropped' as const })),
    });
    expect(await redoAtOf(step.id)).toBeNull();
    expect((await stepView())?.redoAt).toBeNull();
  });

  it('starts a failed proposal over into a Run, its attempts from 1; any other, 409', async () => {
    const t = await start();
    const store = t.master.store;
    // Given up once its third Run failed.
    const failed = propose(t.repo.id, '失败的');
    const failedRun = store.updateRun(t.run('失败的').id, {
      status: 'failed',
      finishedAt: '2026-11-25T08:00:00.000Z',
      error: '失败了',
    }).id;
    store.updateProposal(failed.id, {
      status: 'failed',
      runId: failedRun,
      attempt: 3,
      redo: 'exhausted',
      failures: [{ runId: failedRun, attempt: 3, stage: '编码', error: '第 3 次失败了' }],
    });
    const before = (await call('GET', '/api/proposals?status=failed')).json as ProposalView[];
    expect(before).toMatchObject([
      { id: failed.id, attempt: 3, maxAttempts: 3, restartable: true },
    ]);

    const res = await call('POST', `/api/proposals/${failed.id}/restart`);
    expect(res.status).toBe(200);
    const { proposal, run } = res.json as ProposalRestarted;
    expect(run).toMatchObject({ repoId: t.repo.id, templateName: '测试流程' });
    expect(run.goal.startsWith('失败的\n\n')).toBe(true);
    expect(run.goal).toContain(`### 第 3 次（Run ${failedRun}，失败在「编码」阶段）`);
    expect(proposal).toMatchObject({
      id: failed.id,
      repo: 'demo',
      status: 'accepted',
      runId: run.id,
      runStatus: run.status,
      attempt: 1,
      maxAttempts: 3,
      redo: null,
      redoAt: null,
      failures: [expect.objectContaining({ runId: failedRun, attempt: 3 })],
      restartable: false,
    });
    expect(store.listGlobalEventsOfType('proposal.restarted').map((e) => e.data)).toEqual([
      {
        repo: 'demo',
        proposalId: failed.id,
        runId: run.id,
        failedRunId: failedRun,
        attempts: 3,
        maxAttempts: 3,
      },
    ]);
    await t.waitStatus(run.id, 'completed');
    expect((await call('GET', '/api/proposals?status=accepted')).json).toMatchObject([
      { id: failed.id, runId: run.id, runStatus: 'completed', attempt: 1, restartable: false },
    ]);

    // Not failed (any more): nothing to start over.
    expect(await call('POST', `/api/proposals/${failed.id}/restart`)).toMatchObject({
      status: 409,
      json: {
        error: `提案 ${failed.id} 没有失败：只有 Run 用完尝试次数、标为已失败的提案能重新开始`,
      },
    });
    const pending = propose(t.repo.id, '待处理的');
    expect(await call('POST', `/api/proposals/${pending.id}/restart`)).toMatchObject({
      status: 409,
      json: { error: `提案 ${pending.id} 还没有采纳，不用重新开始` },
    });
    await call('POST', `/api/proposals/${pending.id}/reject`, { reason: '不要' });
    expect(await call('POST', `/api/proposals/${pending.id}/restart`)).toMatchObject({
      status: 409,
      json: { error: `提案 ${pending.id} 已经被拒绝了，不能重新开始` },
    });
    expect((await call('POST', '/api/proposals/proposal_none/restart')).status).toBe(404);

    // A repo no longer in backlog.repos gets no Run.
    const third = store.createRepo({
      name: 'third',
      path: initRepo(),
      targetBranch: 'main',
      verifyCommands: [],
      setupCommands: [],
      mergeMode: 'direct',
    });
    const elsewhere = store.updateProposal(propose(third.id, '别处的').id, {
      status: 'failed',
      redo: 'exhausted',
    });
    const listed = (await call('GET', `/api/proposals?repo=third`)).json as ProposalView[];
    // Its setting unknown, it may still be started over once it is back in backlog.repos.
    expect(listed).toMatchObject([{ id: elsewhere.id, maxAttempts: null, restartable: true }]);
    expect(await call('POST', `/api/proposals/${elsewhere.id}/restart`)).toMatchObject({
      status: 409,
      json: {
        error: '仓库 third 已经不在 config.yaml 的 backlog.repos 里，不能再重新开始它的提案',
      },
    });
    expect(store.getProposal(elsewhere.id).status).toBe('failed');
    // The Runs: the failed one, and the one it was started over with.
    expect(
      store
        .listRuns()
        .map((r) => r.id)
        .sort(),
    ).toEqual([failedRun, run.id].sort());
    expect(gh.calls).toEqual([]);
  });

  it('starts a failed step over: running again, its iteration active once nothing blocks it', async () => {
    const t = await start();
    const store = t.master.store;
    store.setWorking(false);
    const iteration = planIteration(t);
    // Both steps start at once, neither depending on the other.
    const [first, second] = stepsOf(t, iteration.id);
    if (!first || !second) throw new Error('no steps');
    store.updateProposal(second.id, { dependsOn: [] });
    store.updateIteration(iteration.id, {
      children: store.getIteration(iteration.id).children.map((c) => ({ ...c, dependsOn: [] })),
    });
    // Accepted by hand with the work switch off: their Runs wait in the queue.
    await call('POST', `/api/iterations/${iteration.id}/accept`);
    const ran = stepsOf(t, iteration.id).map((p) => p.runId ?? '');
    // Each Run failed, the attempts used up.
    for (const [i, p] of stepsOf(t, iteration.id).entries()) {
      const runId = ran[i] ?? '';
      store.updateRun(runId, { status: 'failed', finishedAt: new Date().toISOString() });
      store.updateProposal(p.id, {
        status: 'failed',
        redo: 'exhausted',
        attempt: 3,
        failures: [{ runId, attempt: 3, stage: '编码', error: '失败了' }],
      });
    }
    await call('POST', '/api/backlog/poll');
    const view = async () =>
      (await call('GET', `/api/iterations/${iteration.id}`)).json as IterationView;
    const blocked = await view();
    expect(blocked.status).toBe('blocked');
    expect(
      blocked.children.map((c) => [c.status, c.attempt, c.maxAttempts, c.restartable]),
    ).toEqual([
      ['failed', 3, 3, true],
      ['failed', 3, 3, true],
    ]);

    // The first started over: running again, the second still blocks the iteration.
    const res = await call('POST', `/api/proposals/${first.id}/restart`);
    expect(res.status).toBe(200);
    const { proposal, run } = res.json as ProposalRestarted;
    expect(proposal).toMatchObject({
      status: 'accepted',
      attempt: 1,
      iterationId: iteration.id,
      restartable: false,
    });
    expect(run.status).toBe('queued');
    const once = await view();
    expect(once.status).toBe('blocked');
    expect(once.children.map((c) => [c.status, c.runIds, c.attempt, c.restartable])).toEqual([
      ['running', [ran[0], run.id], 1, false],
      ['failed', [ran[1]], 3, true],
    ]);
    expect(once.children[0]?.runs.map((r) => [r.id, r.status])).toEqual([
      [ran[0], 'failed'],
      [run.id, 'queued'],
    ]);

    // The second too: nothing blocks it any more.
    expect((await call('POST', `/api/proposals/${second.id}/restart`)).status).toBe(200);
    const twice = await view();
    expect(twice.status).toBe('active');
    expect(twice.children.map((c) => c.status)).toEqual(['running', 'running']);
    expect(store.listGlobalEventsOfType('iteration.unblocked')).toHaveLength(1);
    expect(store.listGlobalEventsOfType('proposal.restarted').map((e) => e.data)).toEqual([
      expect.objectContaining({ proposalId: first.id, iterationId: iteration.id }),
      expect.objectContaining({ proposalId: second.id, iterationId: iteration.id }),
    ]);

    // A step of an iteration that is over is not started over.
    store.updateProposal(first.id, { status: 'failed', redo: 'exhausted' });
    await call('POST', `/api/iterations/${iteration.id}/cancel`);
    expect(await call('POST', `/api/proposals/${first.id}/restart`)).toMatchObject({
      status: 409,
      json: { error: `提案 ${first.id} 所在的迭代 ${iteration.id} 已经结束了，不能再重新开始它` },
    });
    expect(
      ((await call('GET', `/api/proposals?status=failed`)).json as ProposalView[]).map((p) => [
        p.id,
        p.restartable,
      ]),
    ).toEqual([[first.id, false]]);
    expect(gh.calls).toEqual([]);
  });

  it('accepts a proposal into a Run, and rejects one only with a reason', async () => {
    const t = await start();
    const wanted = propose(t.repo.id, '要人定的');
    const unwanted = propose(t.repo.id, '不想要的', 'mid');

    const accepted = await call('POST', `/api/proposals/${wanted.id}/accept`);
    expect(accepted.status).toBe(200);
    const { proposal, run } = accepted.json as ProposalAccepted;
    expect(run).toMatchObject({ repoId: t.repo.id, templateName: '测试流程' });
    expect(run.goal.startsWith('要人定的\n\n')).toBe(true);
    expect(proposal).toMatchObject({
      id: wanted.id,
      repo: 'demo',
      status: 'accepted',
      auto: false,
      runId: run.id,
      runStatus: run.status,
      decidedAt: expect.any(String),
    });
    expect(t.master.store.getProposal(wanted.id).status).toBe('accepted');
    await t.waitStatus(run.id, 'completed');
    expect((await call('GET', '/api/proposals?status=accepted')).json).toMatchObject([
      { id: wanted.id, runId: run.id, runStatus: 'completed' },
    ]);

    // Decided already.
    const again = await call('POST', `/api/proposals/${wanted.id}/accept`);
    expect(again).toMatchObject({
      status: 409,
      json: { error: `提案 ${wanted.id} 已经采纳过了` },
    });
    expect(
      (await call('POST', `/api/proposals/${wanted.id}/reject`, { reason: '不要了' })).status,
    ).toBe(409);

    // A reason is required.
    for (const input of [{ reason: ' \n ' }, { reason: '' }, {}, undefined]) {
      const res = await call('POST', `/api/proposals/${unwanted.id}/reject`, input);
      expect(res.status).toBe(400);
      expect(res.json.error).toContain('拒绝提案时必须填写理由');
    }
    expect(
      (await call('POST', `/api/proposals/${unwanted.id}/reject`, { reason: 'x', why: 'y' }))
        .status,
    ).toBe(400);
    expect(t.master.store.getProposal(unwanted.id).status).toBe('pending');

    const rejected = await call('POST', `/api/proposals/${unwanted.id}/reject`, {
      reason: ' 太复杂，不划算 \n',
    });
    expect(rejected.status).toBe(200);
    expect(rejected.json as ProposalView).toMatchObject({
      id: unwanted.id,
      repo: 'demo',
      status: 'rejected',
      rejectReason: '太复杂，不划算',
      runId: null,
      runStatus: null,
    });
    expect(await call('POST', `/api/proposals/${unwanted.id}/accept`)).toMatchObject({
      status: 409,
      json: { error: `提案 ${unwanted.id} 已经被拒绝了` },
    });
    expect(
      (await call('POST', `/api/proposals/${unwanted.id}/reject`, { reason: '再拒' })).status,
    ).toBe(409);

    expect((await call('POST', '/api/proposals/proposal_none/accept')).status).toBe(404);
    expect(
      (await call('POST', '/api/proposals/proposal_none/reject', { reason: '没有' })).status,
    ).toBe(404);
    expect(t.master.store.listRuns()).toHaveLength(1);
    expect(gh.calls).toEqual([]);
  });

  /**
   * A pending iteration of the repo as the local backlog keeps it: a proposal per step, the
   * second depending on the first. Of `source` github, the same without proposals.
   */
  function planIteration(t: Harness, source: Iteration['source'] = 'local'): Iteration {
    const store = t.master.store;
    const iteration = store.createIteration({
      repoId: t.repo.id,
      scoutId: null,
      source,
      issuesRepo: source === 'github' ? 'me/demo' : '',
      title: '本地迭代',
      goal: '本地仓库也能永动',
      readmeGoal: '永动',
      criteria: ['能演示'],
      outOfScope: [],
      children: [],
      ...(source === 'github' ? { issue: { number: 1, url: 'https://github.com/me/demo/1' } } : {}),
    });
    const child = (title: string, position: number, dependsOn: number[]): IterationChild => ({
      title,
      category: 'feature',
      size: 'M',
      risk: 'high',
      why: `${title}的原因`,
      evidence: ['run_abc 返工了 3 轮'],
      what: `${title}的做法`,
      acceptance: ['测试通过'],
      position,
      criteria: [1],
      dependsOn,
      closeout: false,
      status: 'planned',
      runIds: [],
    });
    const children = [child('第一步', 1, []), child('第二步', 2, [1])];
    if (source === 'github') return store.updateIteration(iteration.id, { children });
    const first = propose(t.repo.id, '第一步');
    const second = propose(t.repo.id, '第二步');
    store.updateProposal(first.id, { iterationId: iteration.id });
    store.updateProposal(second.id, { iterationId: iteration.id, dependsOn: [first.id] });
    return store.updateIteration(iteration.id, {
      children: [
        { ...(children[0] as IterationChild), proposalId: first.id },
        { ...(children[1] as IterationChild), proposalId: second.id },
      ],
    });
  }

  /** The proposal of each step of an iteration, in the order of its plan. */
  const stepsOf = (t: Harness, id: string) =>
    t.master.store
      .getIteration(id)
      .children.map((c) => t.master.store.getProposal(c.proposalId ?? ''));

  it('accepts and cancels a local iteration as a whole, its steps never on their own', async () => {
    const t = await start();
    const iteration = planIteration(t);
    const [first, second] = stepsOf(t, iteration.id);
    if (!first || !second) throw new Error('no steps');

    // A step is decided with its iteration.
    const whole = `提案 ${second.id} 是迭代 ${iteration.id} 的子项，要和迭代一起整体采纳或拒绝`;
    expect(await call('POST', `/api/proposals/${second.id}/accept`)).toMatchObject({
      status: 409,
      json: { error: whole },
    });
    expect(
      await call('POST', `/api/proposals/${second.id}/reject`, { reason: '不要' }),
    ).toMatchObject({ status: 409, json: { error: whole } });
    // Nor is a pending one cancelled.
    expect(await call('POST', `/api/iterations/${iteration.id}/cancel`)).toMatchObject({
      status: 409,
      json: { error: `迭代 ${iteration.id} 还没有采纳，要拒绝它（填写理由），而不是终止` },
    });

    const accepted = await call('POST', `/api/iterations/${iteration.id}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.json as Iteration).toMatchObject({
      id: iteration.id,
      status: 'active',
      auto: false,
      decidedAt: expect.any(String),
    });
    // Every step accepted; only the first, which waits for nothing, became a Run.
    const [acceptedFirst, acceptedSecond] = stepsOf(t, iteration.id);
    expect([acceptedFirst?.status, acceptedSecond?.status]).toEqual(['accepted', 'accepted']);
    expect(acceptedFirst?.runId).toEqual(expect.any(String));
    expect(acceptedSecond?.runId).toBeNull();
    expect((accepted.json as Iteration).children.map((c) => c.status)).toEqual([
      'running',
      'waiting',
    ]);
    expect(await call('POST', `/api/iterations/${iteration.id}/accept`)).toMatchObject({
      status: 409,
      json: { error: `迭代 ${iteration.id} 已经采纳过了` },
    });
    expect(
      (await call('POST', `/api/iterations/${iteration.id}/reject`, { reason: '不要' })).status,
    ).toBe(409);

    const cancelled = await call('POST', `/api/iterations/${iteration.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.json as Iteration).toMatchObject({ id: iteration.id, status: 'cancelled' });
    const run = t.master.store.getRun(acceptedFirst?.runId ?? '');
    // Its Run had either been terminated or completed by then.
    expect(['cancelled', 'completed']).toContain(run.status);
    expect((await call('POST', `/api/iterations/${iteration.id}/cancel`)).status).toBe(409);
    expect((await call('POST', '/api/iterations/iteration_none/accept')).status).toBe(404);
    expect((await call('POST', '/api/iterations/iteration_none/cancel')).status).toBe(404);
    expect(gh.calls).toEqual([]);
  });

  it('rejects a pending local iteration only with a reason, its steps with it', async () => {
    const t = await start();
    const iteration = planIteration(t);
    for (const input of [{ reason: ' \n ' }, { reason: '' }, {}, undefined]) {
      const res = await call('POST', `/api/iterations/${iteration.id}/reject`, input);
      expect(res.status).toBe(400);
      expect(res.json.error).toContain('拒绝迭代时必须填写理由');
    }
    expect(
      (await call('POST', `/api/iterations/${iteration.id}/reject`, { reason: 'x', why: 'y' }))
        .status,
    ).toBe(400);
    expect(t.master.store.getIteration(iteration.id).status).toBe('pending');

    const rejected = await call('POST', `/api/iterations/${iteration.id}/reject`, {
      reason: ' 现在不做 \n',
    });
    expect(rejected.status).toBe(200);
    expect(rejected.json as Iteration).toMatchObject({ id: iteration.id, status: 'cancelled' });
    expect(stepsOf(t, iteration.id).map((p) => [p.status, p.rejectReason])).toEqual([
      ['rejected', '现在不做'],
      ['rejected', '现在不做'],
    ]);
    expect(await call('POST', `/api/iterations/${iteration.id}/accept`)).toMatchObject({
      status: 409,
      json: { error: `迭代 ${iteration.id} 已经不做了` },
    });
    expect(t.master.store.listRuns()).toEqual([]);
  });

  it('leaves an iteration of GitHub to GitHub', async () => {
    const t = await start();
    const iteration = planIteration(t, 'github');
    const onGitHub = `迭代 ${iteration.id} 在 GitHub 上：给迭代 issue 加上 ares1:ready 来采纳，关掉迭代 issue 来拒绝或终止`;
    for (const [path, input] of [
      ['accept', undefined],
      ['reject', { reason: '不要' }],
      ['cancel', undefined],
    ] as const) {
      expect(await call('POST', `/api/iterations/${iteration.id}/${path}`, input)).toMatchObject({
        status: 409,
        json: { error: onGitHub },
      });
    }
    expect(t.master.store.getIteration(iteration.id).status).toBe('pending');
    expect(gh.calls).toEqual([]);
  });

  it('shows an iteration with its steps, their Runs, its progress and what it used', async () => {
    const t = await start();
    const iteration = planIteration(t);
    const view = async () => {
      const res = await call('GET', `/api/iterations/${iteration.id}`);
      expect(res.status).toBe(200);
      return res.json as IterationView;
    };

    // Waiting to be accepted: nothing run, nothing used; the second step depends on the first.
    const pending = await view();
    expect(pending).toMatchObject({
      id: iteration.id,
      repo: 'demo',
      source: 'local',
      status: 'pending',
      goal: '本地仓库也能永动',
      criteria: ['能演示'],
      progress: { done: 0, total: 2 },
      totals: { runs: 0, costUsd: 0, costUnknown: false, elapsedMs: null, agentMs: 0 },
    });
    expect(pending.children.map((c) => [c.position, c.status, c.waitingFor, c.runs])).toEqual([
      [1, 'planned', [], []],
      [2, 'planned', [1], []],
    ]);
    expect(pending.children[0]).toMatchObject({ title: '第一步', what: '第一步的做法' });

    // The first step's agents report what they cost, the second's coder does not.
    let step = 0;
    t.scripts.coder = (ctx) => {
      step += 1;
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      writeFile(join(ctx.input.workdir, `step-${step}.txt`), 'ok\n');
      return step === 1 ? { ...done(), costUsd: 0.5 } : done();
    };
    t.scripts.reviewer = () => ({ ...review(), costUsd: 0.25 });

    // Accepted: the first step runs, the second waits for it.
    await call('POST', `/api/iterations/${iteration.id}/accept`);
    const [first] = stepsOf(t, iteration.id);
    const firstRun = first?.runId ?? '';
    await t.waitStatus(firstRun, 'completed');
    const started = await view();
    expect(started.status).toBe('active');
    expect(started.children.map((c) => [c.status, c.waitingFor])).toEqual([
      ['running', []],
      ['waiting', [1]],
    ]);
    expect(started.children[0]?.runs).toEqual([
      { id: firstRun, status: 'completed', costUsd: 0.75, costUnknown: false },
    ]);
    expect(started.totals).toMatchObject({ runs: 1, costUsd: 0.75, costUnknown: false });
    expect(started.totals.elapsedMs).toEqual(expect.any(Number));

    // The next check finds the first done and starts the second; the one after, the iteration done.
    await call('POST', '/api/backlog/poll');
    const second = stepsOf(t, iteration.id)[1];
    const secondRun = second?.runId ?? '';
    expect(secondRun).not.toBe('');
    await t.waitStatus(secondRun, 'completed');
    await call('POST', '/api/backlog/poll');
    const finished = await view();
    const stored = t.master.store.getIteration(iteration.id);
    // The second Run's coder reported no cost, so the total is a lower bound.
    expect(finished).toMatchObject({
      status: 'done',
      summary: expect.any(String),
      progress: { done: 2, total: 2 },
      totals: {
        runs: 2,
        costUsd: 1,
        costUnknown: true,
        elapsedMs: Date.parse(stored.endedAt ?? '') - Date.parse(stored.decidedAt ?? ''),
      },
    });
    expect(
      finished.children.map((c) => [
        c.status,
        c.waitingFor,
        c.runs.map((r) => [r.id, r.costUnknown]),
      ]),
    ).toEqual([
      ['done', [], [[firstRun, false]]],
      ['done', [], [[secondRun, true]]],
    ]);
    expect(finished.totals.agentMs).toBeGreaterThanOrEqual(0);

    expect((await call('GET', '/api/iterations/iteration_none')).status).toBe(404);
    expect(gh.calls).toEqual([]);
  });

  it('lists iterations of both sources newest first, by repo and status', async () => {
    const t = await start();
    const store = t.master.store;
    const older = planIteration(t, 'github');
    store.updateIteration(older.id, { status: 'done', endedAt: '2026-11-20T00:00:00.000Z' });
    const newer = planIteration(t);
    const other = store.createRepo({
      name: 'other',
      path: initRepo(),
      targetBranch: 'main',
      verifyCommands: [],
      setupCommands: [],
      mergeMode: 'direct',
    });
    const elsewhere = store.createIteration({
      repoId: other.id,
      scoutId: null,
      source: 'local',
      issuesRepo: '',
      title: '别处的迭代',
      goal: '别处',
      readmeGoal: '永动',
      criteria: [],
      outOfScope: [],
      children: [],
    });
    const ids = async (path: string) => {
      const res = await call('GET', path);
      expect(res.status).toBe(200);
      return (res.json as IterationView[]).map((i) => i.id);
    };

    const all = (await call('GET', '/api/iterations')).json as IterationView[];
    expect(all.map((i) => [i.id, i.repo, i.source, i.status])).toEqual([
      [elsewhere.id, 'other', 'local', 'pending'],
      [newer.id, 'demo', 'local', 'pending'],
      [older.id, 'demo', 'github', 'done'],
    ]);
    // An iteration of GitHub: its issue; its steps without issues have no Runs.
    expect(all[2]).toMatchObject({
      issue: { number: 1, url: 'https://github.com/me/demo/1' },
      issuesRepo: 'me/demo',
      progress: { done: 0, total: 2 },
      totals: { runs: 0, costUsd: 0, costUnknown: false, elapsedMs: null },
    });
    expect(all[2]?.children.map((c) => c.runs)).toEqual([[], []]);
    expect(all[0]).toMatchObject({ progress: { done: 0, total: 0 }, children: [] });

    expect(await ids('/api/iterations?repo=demo')).toEqual([newer.id, older.id]);
    expect(await ids(`/api/iterations?repo=${other.id}`)).toEqual([elsewhere.id]);
    expect(await ids('/api/iterations?status=done')).toEqual([older.id]);
    expect(await ids('/api/iterations?status=pending,active,blocked&repo=demo')).toEqual([
      newer.id,
    ]);
    expect(await ids('/api/iterations?status=active,blocked')).toEqual([]);
    expect(await ids('/api/iterations?limit=2')).toEqual([elsewhere.id, newer.id]);

    for (const path of [
      '/api/iterations?status=open',
      '/api/iterations?status=pending,',
      '/api/iterations?status=',
      '/api/iterations?limit=0',
      '/api/iterations?limit=501',
      '/api/iterations?state=pending',
    ]) {
      expect((await call('GET', path)).status, path).toBe(400);
    }
    expect((await call('GET', '/api/iterations?repo=nowhere')).status).toBe(404);
    expect(gh.calls).toEqual([]);
  });

  it('scouts a repo of backlog.repos by hand without GitHub, showing it the rejected reasons', async () => {
    const t = await start();
    const unwanted = propose(t.repo.id, '不想要的');
    await call('POST', `/api/proposals/${unwanted.id}/reject`, { reason: '和目标无关' });
    t.scripts.scout = () => ({
      structured: {
        gaps: [],
        proposals: [
          {
            title: '要人定的',
            category: 'improvement',
            size: 'M',
            risk: 'high',
            lead: 'problem',
            why: '原因',
            evidence: ['run_abc 返工了 3 轮'],
            what: '做法',
            acceptance: ['测试通过'],
          },
        ],
      },
    });

    const res = await call('POST', '/api/scouts', { repo: 'demo' });
    expect(res.status).toBe(201);
    expect(res.json as Scout).toMatchObject({
      repoId: t.repo.id,
      trigger: 'manual',
      agentId: 'scout',
      issuesRepo: '',
    });
    const done = await scoutDone(t, res.json.id);
    expect(done.status).toBe('completed');
    const prompt = t.fake.calls.filter((c) => c.model === 'scout').at(-1)?.prompt ?? '';
    expect(prompt).toContain('不想要的');
    expect(prompt).toContain('和目标无关');
    expect(await titles('/api/proposals?repo=demo&status=pending')).toEqual(['要人定的']);

    // A repo not registered on the dashboard, and one of neither source.
    expect(await call('POST', '/api/scouts', { repo: 'other' })).toMatchObject({
      status: 404,
      json: { error: '仓库 other 没有在看板上登记' },
    });
    expect(await call('POST', '/api/scouts', { repo: 'nowhere' })).toMatchObject({
      status: 404,
      json: {
        error: 'config.yaml 的 github.repos、gitlab.repos 和 backlog.repos 里都没有 nowhere',
      },
    });
    expect(gh.calls).toEqual([]);
  });

  it('scouts a repo in both github.repos and backlog.repos through GitHub', async () => {
    const t = await start(`
github:
  repos:
    demo:
      template: dev
      scout: { agent: scout, auto: false }
backlog:
  repos:
    demo:
      template: dev
      scout: { agent: scout, auto: false }
`);
    t.scripts.scout = () => ({ structured: { gaps: [], proposals: [] } });
    const res = await call('POST', '/api/scouts', { repo: 'demo' });
    expect(res.status).toBe(201);
    expect((res.json as Scout).issuesRepo).not.toBe('');
    await scoutDone(t, res.json.id);
    expect(gh.calls.length).toBeGreaterThan(0);
    // The backlog entry is the one disabled, with the reason.
    const status = (await call('GET', '/api/backlog')).json as BacklogStatus;
    expect(status.repos[0]?.problems[0]).toContain('同时写在 github.repos 和 backlog.repos 里');
  });

  it('answers in English', async () => {
    const t = await start();
    // After the Master took config.yaml's language.
    setLang('en');
    const p = propose(t.repo.id, 'Wanted');
    const res = await call('POST', `/api/proposals/${p.id}/reject`, { reason: ' ' });
    expect(res).toMatchObject({
      status: 400,
      json: { error: 'reason: Rejecting a proposal needs a reason' },
    });
    expect((await call('POST', `/api/proposals/${p.id}/accept`)).status).toBe(200);
    const again = await call('POST', `/api/proposals/${p.id}/accept`);
    expect(again.json.error).toBe(`Proposal ${p.id} was accepted already`);
    const scout = await call('POST', '/api/scouts', { repo: 'nowhere' });
    expect(scout.json.error).toBe(
      'nowhere is in none of github.repos, gitlab.repos and backlog.repos of config.yaml',
    );
    const status = (await call('GET', '/api/backlog')).json as BacklogStatus;
    expect(status.repos[1]?.problems).toEqual(['Repo other is not registered on the dashboard']);
    for (const text of [res.text, again.text, scout.text, JSON.stringify(status)]) {
      expect(text).not.toMatch(/[一-鿿]/);
    }
  });
});

describe('GET /api/events', () => {
  it('lists the events of no Run, newest first, paged with before and limit', async () => {
    h = await harness();
    const store = h.master.store;
    // Whatever the Master recorded on its own at start, then ours interleaved with a Run's.
    const before = store.listGlobalEvents({ limit: 500 }).map((e) => e.id);
    const a = store.event(null, 'logs.pruned', { runs: 1, scouts: 0, files: 2, bytes: 10 });
    store.event('run-x', 'run.status', { status: 'running' });
    const b = store.event(null, 'github.error', { message: 'boom' });
    store.event('run-x', 'run.status', { status: 'completed' });
    const c = store.event(null, 'master.restarted', { pid: 1, startedAt: a.ts });

    const all = await call('GET', '/api/events');
    expect(all.status).toBe(200);
    const rows = all.json as EventRow[];
    expect(rows.every((e) => e.runId === null)).toBe(true);
    expect(rows.map((e) => e.id)).toEqual([c.id, b.id, a.id, ...before]);
    expect(rows[0]).toEqual({
      id: c.id,
      runId: null,
      ts: c.ts,
      type: 'master.restarted',
      data: { pid: 1, startedAt: a.ts },
    });

    const first = (await call('GET', '/api/events?limit=2')).json as EventRow[];
    expect(first.map((e) => e.id)).toEqual([c.id, b.id]);
    const next = (await call('GET', `/api/events?before=${b.id}&limit=2`)).json as EventRow[];
    expect(next[0]?.id).toBe(a.id);
    expect(next.every((e) => e.id < b.id && e.runId === null)).toBe(true);
    expect((await call('GET', `/api/events?before=${a.id}&limit=500`)).json).toEqual(
      rows.filter((e) => e.id < a.id),
    );

    // 200 by default.
    for (let i = 0; i < 200; i++) store.event(null, 'master.working', { on: i % 2 === 0 });
    expect(((await call('GET', '/api/events')).json as EventRow[]).length).toBe(200);
  });

  it('rejects invalid paging parameters', async () => {
    h = await harness();
    for (const q of [
      'limit=0',
      'limit=501',
      'limit=abc',
      'limit=1.5',
      'before=0',
      'before=-3',
      'before=x',
      'other=1',
    ]) {
      const res = await call('GET', `/api/events?${q}`);
      expect(res.status, q).toBe(400);
      expect(typeof res.json.error).toBe('string');
    }
    expect((await call('GET', '/api/events?limit=500')).status).toBe(200);
    expect((await call('GET', '/api/events?limit=1&before=1')).json).toEqual([]);
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
    lead: 'problem',
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
      structured: { gaps: [], proposals: [proposal('低风险', 'low'), proposal('中风险', 'mid')] },
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
    hh.scripts.scout = () => ({ structured: { gaps: [], proposals: [] }, costUsd: costs.shift() });
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
