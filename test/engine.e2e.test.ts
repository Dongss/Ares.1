import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeAdapter, type FakeContext, type FakeOutcome } from '../src/adapters/fake.js';
import { AGENT_GH_TOKEN } from '../src/adapters/process.js';
import type { AgentAdapter } from '../src/adapters/types.js';
import {
  AGENT_RETRY_BACKOFF,
  backoffMs,
  InvalidStateError,
  RATE_LIMIT_WAIT,
  rateLimitDelayMs,
} from '../src/engine/engine.js';
import { setLang } from '../src/i18n.js';
import { noticeFor } from '../src/notify/notice.js';
import { NotFoundError } from '../src/store/store.js';
import type { Run, Task } from '../src/store/types.js';
import {
  ASSESS_AGENTS_YAML,
  ASSESS_WORKFLOW_YAML,
  assessment,
  done,
  git,
  type Harness,
  harness,
  readEnvFile,
  review,
  type Script,
  TEST_WORKFLOW_YAML,
  tmpDir,
  waitFor,
  writeFile,
} from './helpers.js';

/** TEST_WORKFLOW_YAML whose reworks and rollbacks, once used up, wait for a human. */
const WAIT_WHEN_EXHAUSTED = TEST_WORKFLOW_YAML.replace(
  '    on_agent_error: switch_agent\n',
  '    on_agent_error: switch_agent\n    on_exhausted: human\n',
);

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  vi.unstubAllEnvs();
});

describe('engine: full run with fake agents', () => {
  it('implements, reviews, waits for merge approval, then merges into main', async () => {
    h = await harness();
    const run = h.run();
    const waiting = await h.waitStatus(run.id, 'waiting_approval');
    expect(waiting.worktreePath).toBeTruthy();
    const worktree = waiting.worktreePath as string;
    expect(readFileSync(join(worktree, 'feature.txt'), 'utf8')).toBe('ok\n');

    // One commit per task on the run branch, authored by the repo identity.
    const log = git(worktree, 'log', '--format=%s', `${waiting.baseCommit}..HEAD`);
    expect(log.split('\n')).toEqual(['编码: 添加 feature.txt']);

    // main is untouched until approval.
    expect(existsSync(join(h.repoDir, 'feature.txt'))).toBe(false);

    h.master.engine.approve(run.id, '可以合并');
    const completed = await h.waitStatus(run.id, 'completed');
    expect(completed.finishedAt).toBeTruthy();
    expect(readFileSync(join(h.repoDir, 'feature.txt'), 'utf8')).toBe('ok\n');
    // Merged runs clean up their worktree and branch.
    expect(existsSync(worktree)).toBe(false);
    expect(git(h.repoDir, 'branch', '--list', `ares1/${run.id}`)).toBe('');

    const checks = h.master.store.listChecks(run.id);
    expect(checks.map((c) => [c.kind, c.passed])).toEqual([
      ['result', true],
      ['command', true],
      ['review', true],
      ['merge', true],
    ]);
  });

  it('records the model and effort of each attempt as they were when it ran', async () => {
    h = await harness({
      agents: `
agents:
  coder: { cli: fake, model: coder, effort: high }
  reviewer: { cli: fake, model: reviewer, args: [--effort, low] }
`,
    });
    h.scripts.coder = (ctx) => {
      // what Claude Code reports in its system/init event
      ctx.input.onEvent?.({ type: 'model', model: 'fake-coder-1' });
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return done();
    };
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');

    // The effort field goes to the adapter; an --effort in args stays in extraArgs.
    const coderCall = h.fake.calls.find((c) => c.model === 'coder');
    expect(coderCall?.effort).toBe('high');
    const reviewerCall = h.fake.calls.find((c) => c.model === 'reviewer');
    expect(reviewerCall?.effort).toBeUndefined();
    expect(reviewerCall?.extraArgs).toEqual(['--effort', 'low']);

    const snapshot = () =>
      h?.master.store.listRunAttempts(run.id).map((a) => ({
        agentId: a.agentId,
        model: a.model,
        actual: a.actualModel,
        effort: a.effort,
      }));
    const expected = [
      { agentId: 'coder', model: 'coder', actual: 'fake-coder-1', effort: 'high' },
      { agentId: 'reviewer', model: 'reviewer', actual: null, effort: 'low' },
    ];
    expect(snapshot()).toEqual(expected);
    const events = h.master.store.listEvents(run.id).filter((e) => e.type === 'attempt.model');
    expect(events.map((e) => e.data.model)).toEqual(['fake-coder-1']);

    // Changing the config later does not rewrite history.
    const coder = h.master.config.agents.get('coder');
    if (coder) Object.assign(coder, { model: 'other', effort: 'max' });
    expect(snapshot()).toEqual(expected);
  });

  it('reworks in the same session when a verify command fails', async () => {
    h = await harness();
    let calls = 0;
    h.scripts.coder = (ctx) => {
      calls++;
      writeFile(join(ctx.input.workdir, 'feature.txt'), calls === 1 ? 'wrong\n' : 'ok\n');
      return done();
    };
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');

    const coderCalls = h.fake.calls.filter((c) => c.model === 'coder');
    expect(coderCalls).toHaveLength(2);
    // Rework resumes the previous session and carries the failing command's output.
    expect(coderCalls[1]?.resumeSessionId).toBeTruthy();
    expect(coderCalls[1]?.prompt).toContain('grep -q ok feature.txt');
    expect(coderCalls[1]?.prompt).toContain('没有通过验收');

    const tasks = h.master.store.listRunTasks(run.id);
    expect(tasks[0]?.retries).toBe(1);
    const attempts = h.master.store.listAttempts(tasks[0]?.id as string);
    expect(attempts.map((a) => a.outcome)).toEqual(['rework', 'passed']);
  });

  it('asks for rework when the agent does not report the agreed JSON', async () => {
    h = await harness();
    let calls = 0;
    h.scripts.coder = (ctx) => {
      calls++;
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return calls === 1 ? { finalMessage: '我做完了' } : done();
    };
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');
    expect(calls).toBe(2);
    expect(h.fake.calls[1]?.prompt).toContain('没有找到约定格式的 JSON 结果');
  });

  it('goes back to implement when review finds must-fix issues', async () => {
    h = await harness();
    let reviews = 0;
    h.scripts.reviewer = () => {
      reviews++;
      return reviews === 1 ? review([{ severity: 'must', description: '缺少测试' }]) : review();
    };
    let coderRuns = 0;
    h.scripts.coder = (ctx) => {
      coderRuns++;
      writeFile(join(ctx.input.workdir, 'feature.txt'), `ok\nround ${coderRuns}\n`);
      return done();
    };
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');

    const stages = h.master.store
      .listStageRuns(run.id)
      .map((s) => `${s.stageId}#${s.round}:${s.status}`);
    expect(stages).toEqual([
      'implement#1:passed',
      'review#1:failed',
      'implement#2:passed',
      'review#2:passed',
      'merge#1:waiting_approval',
    ]);
    const secondImplement = h.fake.calls.filter((c) => c.model === 'coder')[1];
    expect(secondImplement?.prompt).toContain('缺少测试');
    expect(secondImplement?.resumeSessionId).toBeUndefined();

    // The second review round first checks the first round's issues; the first round has none.
    const reviewerPrompts = h.fake.calls.filter((c) => c.model === 'reviewer').map((c) => c.prompt);
    expect(reviewerPrompts).toHaveLength(2);
    expect(reviewerPrompts[0]).not.toContain('上一轮评审的意见');
    expect(reviewerPrompts[1]).toContain('## 上一轮评审的意见（第 1 轮）');
    expect(reviewerPrompts[1]).toContain('[必须修改] 缺少测试');
    expect(reviewerPrompts[1]).toContain('逐条确认上一轮的「必须修改」是否已经解决');

    // Rounds after the first are marked in the commit title.
    const waiting = h.master.store.getRun(run.id);
    const worktree = waiting.worktreePath as string;
    const log = git(worktree, 'log', '--format=%s', `${waiting.baseCommit}..HEAD`);
    expect(log.split('\n')).toEqual([
      '编码（第 2 轮）: 添加 feature.txt',
      '编码: 添加 feature.txt',
    ]);
  });

  it('asks the reviewer to redo a review whose output had the wrong format', async () => {
    h = await harness();
    let reviews = 0;
    h.scripts.reviewer = () => {
      reviews++;
      return reviews === 1 ? { finalMessage: '看起来没问题' } : review();
    };
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');

    const reviewerPrompts = h.fake.calls.filter((c) => c.model === 'reviewer').map((c) => c.prompt);
    expect(reviewerPrompts).toHaveLength(2);
    expect(reviewerPrompts[0]).not.toContain('上一次评审没有完成');
    expect(reviewerPrompts[1]).toContain('## 上一次评审没有完成');
    expect(reviewerPrompts[1]).toContain('没有找到约定格式的 JSON 结果');
    expect(reviewerPrompts[1]).not.toContain('上一次评审的问题');
    // Same round: there is no previous round's review to check.
    expect(reviewerPrompts[1]).not.toContain('上一轮评审的意见');
  });

  it('tells the reviewer which verify commands already passed on the current code', async () => {
    h = await harness({ verifyCommands: ['grep -q ok feature.txt', 'test -f feature.txt'] });
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');
    const reviewerCall = h.fake.calls.find((c) => c.model === 'reviewer');
    expect(reviewerCall?.prompt).toContain('## 已通过的检查');
    expect(reviewerCall?.prompt).toContain('`grep -q ok feature.txt`、`test -f feature.txt`');
    expect(reviewerCall?.prompt).toContain('不需要重复运行');
  });

  it("words the coding prompt after the running agent's permission", async () => {
    h = await harness({
      agents: `
agents:
  coder: { cli: fake, model: coder, permission: safe }
  reviewer: { cli: fake, model: reviewer }
`,
    });
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');

    const coderCall = h.fake.calls.find((c) => c.model === 'coder');
    expect(coderCall?.permission).toBe('safe');
    expect(coderCall?.prompt).toContain('你只能修改文件，不能执行命令');
    expect(coderCall?.prompt).toContain('检查命令由 Master 在你完成后运行');
    expect(coderCall?.prompt).toContain('`grep -q ok feature.txt`');
    expect(coderCall?.prompt).not.toContain('先自己运行确认');
  });

  it('records the agent, model and effort in the commit body', async () => {
    h = await harness({
      agents: `
agents:
  coder: { cli: fake, model: coder, effort: high }
  reviewer: { cli: fake, model: reviewer }
`,
    });
    h.scripts.coder = (ctx) => {
      ctx.input.onEvent?.({ type: 'model', model: 'fake-coder-1' });
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return done();
    };
    const run = h.run();
    const waiting = await h.waitStatus(run.id, 'waiting_approval');
    const body = git(waiting.worktreePath as string, 'log', '-1', '--format=%b');
    expect(body).toContain(`Run: ${run.id}`);
    expect(body).toContain('Agent: coder (fake, model: fake-coder-1, effort: high)');
  });

  it('a rejected merge approval sends the comment back to implement', async () => {
    h = await harness();
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');
    expect(() => h?.master.engine.reject(run.id, '  ')).toThrow(/必须填写意见/);
    h.master.engine.reject(run.id, '请把文件名改成 feature.md');
    await waitFor(
      () => h?.master.store.countStageRounds(run.id, 'merge') === 2,
      'second merge round',
    );
    await h.waitStatus(run.id, 'waiting_approval');
    const implementPrompts = h.fake.calls.filter((c) => c.model === 'coder').map((c) => c.prompt);
    expect(implementPrompts[1]).toContain('请把文件名改成 feature.md');
    expect(implementPrompts[1]).toContain('审批被驳回');
  });

  it('passes a placeholder stage without doing anything; a gated one waits for a human', async () => {
    const workflow = TEST_WORKFLOW_YAML.replace(
      '  - id: merge\n',
      '  - id: e2e\n    name: E2E\n    kind: placeholder\n  - id: merge\n',
    );
    h = await harness({ workflow });
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');
    const store = h.master.store;
    const stages = store.listStageRuns(run.id).map((sr) => [sr.stageId, sr.status]);
    expect(stages).toEqual([
      ['implement', 'passed'],
      ['review', 'passed'],
      ['e2e', 'passed'],
      ['merge', 'waiting_approval'],
    ]);
    expect(store.listEvents(run.id).map((e) => e.type)).toContain('stage.placeholder');
    // No agent ran for it: one coder and one reviewer call only.
    expect(h.fake.calls).toHaveLength(2);
    // Rejecting the merge goes back to implement, not to the placeholder.
    h.master.engine.reject(run.id, '再改改');
    await waitFor(() => store.countStageRounds(run.id, 'merge') === 2, 'second merge round');
    expect(store.countStageRounds(run.id, 'implement')).toBe(2);
    await h.waitStatus(run.id, 'waiting_approval');
    h.master.engine.approve(run.id);
    await h.waitStatus(run.id, 'completed');

    // With its gate turned on, the placeholder waits for an approval (e.g. a manual E2E check).
    const gated = h.run('人工验收', { stages: { e2e: { gate: true } } });
    await h.waitStatus(gated.id, 'waiting_approval');
    const current = store.getStageRun(store.getRun(gated.id).currentStageRunId as string);
    expect(current.stageId).toBe('e2e');
    h.master.engine.reject(gated.id, 'E2E 没过');
    await waitFor(
      () => store.countStageRounds(gated.id, 'implement') === 2,
      'rolled back to implement',
    );
  });

  it('with on_exhausted: human, blocks after max_retries, rolls back, and a manual retry can switch agent', async () => {
    h = await harness();
    h.scripts.coder = (ctx) => {
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'wrong\n');
      writeFile(join(ctx.input.workdir, 'junk.txt'), 'junk\n');
      return done();
    };
    // Set on the stage only: a rework follows the stage's effective setting.
    const run = h.run('目标', { stages: { implement: { escalate: { on_exhausted: 'human' } } } });
    const blocked = await h.waitStatus(run.id, 'blocked');
    expect(blocked.blocked?.kind).toBe('task_failed');
    expect(blocked.blocked?.message).toContain('Task「编码」返工 2 次后仍未通过验收');
    expect(blocked.error).toBeNull();
    // 1 first try + 2 reworks (max_retries: 2)
    expect(h.fake.calls.filter((c) => c.model === 'coder')).toHaveLength(3);
    // A task that finally fails is rolled back to before it started.
    const worktree = blocked.worktreePath as string;
    expect(existsSync(join(worktree, 'junk.txt'))).toBe(false);
    expect(git(worktree, 'status', '--porcelain')).toBe('');

    await h.master.engine.retry(run.id, { agentId: 'coder2', note: '用 coder2 再试一次' });
    await h.waitStatus(run.id, 'waiting_approval');
    const coder2 = h.fake.calls.filter((c) => c.model === 'coder2');
    expect(coder2).toHaveLength(1);
    expect(coder2[0]?.prompt).toContain('用 coder2 再试一次');
    expect(h.master.store.listRunTasks(run.id)[0]?.agentId).toBe('coder2');
  });

  it('pausing stops the agent and discards its changes; resuming redoes the task', async () => {
    h = await harness();
    let calls = 0;
    h.scripts.coder = async (ctx) => {
      calls++;
      writeFile(join(ctx.input.workdir, 'partial.txt'), 'half\n');
      if (calls === 1) {
        await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
        return done();
      }
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return done();
    };
    const run = h.run();
    await waitFor(() => calls === 1, 'agent to start');
    const paused = await h.master.engine.pause(run.id);
    expect(paused.status).toBe('paused');
    const worktree = paused.worktreePath as string;
    expect(existsSync(join(worktree, 'partial.txt'))).toBe(false);
    const attempts = h.master.store.listRunAttempts(run.id);
    expect(attempts[0]?.status).toBe('stopped');

    h.master.engine.resume(run.id);
    await h.waitStatus(run.id, 'waiting_approval');
    expect(calls).toBe(2);
    // The redo starts a fresh session.
    expect(h.fake.calls[1]?.resumeSessionId).toBeUndefined();
  });

  it('cancels a running run and keeps its worktree', async () => {
    h = await harness();
    h.scripts.coder = async (ctx) => {
      await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
      return done();
    };
    const run = h.run();
    await waitFor(() => h?.fake.calls.length === 1, 'agent to start');
    const cancelled = await h.master.engine.cancel(run.id);
    expect(cancelled.status).toBe('cancelled');
    expect(existsSync(cancelled.worktreePath as string)).toBe(true);
    expect(h.master.store.listRunTasks(run.id)[0]?.status).toBe('cancelled');
  });

  it('runs one Run at a time; the next starts when the first waits for a human', async () => {
    h = await harness();
    const first = h.run('第一个');
    const second = h.run('第二个');
    expect(h.master.store.getRun(second.id).status).toBe('queued');
    await h.waitStatus(first.id, 'waiting_approval');
    await h.waitStatus(second.id, 'waiting_approval');
    // Approving puts the first back at the head of the queue.
    h.master.engine.approve(first.id);
    await h.waitStatus(first.id, 'completed');
  });

  it('syncs main when it moved, re-runs checks, then merges', async () => {
    h = await harness();
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');
    writeFile(join(h.repoDir, 'other.txt'), 'from main\n');
    git(h.repoDir, 'add', '-A');
    git(h.repoDir, 'commit', '-q', '-m', 'main moved');

    h.master.engine.approve(run.id);
    await h.waitStatus(run.id, 'completed');
    expect(readFileSync(join(h.repoDir, 'feature.txt'), 'utf8')).toBe('ok\n');
    expect(readFileSync(join(h.repoDir, 'other.txt'), 'utf8')).toBe('from main\n');
    expect(h.master.store.listEvents(run.id).some((e) => e.type === 'merge.synced')).toBe(true);
  });

  it('refuses to merge into a checked-out target branch with uncommitted changes', async () => {
    h = await harness();
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');
    writeFile(join(h.repoDir, 'README.md'), '# local edit\n');

    h.master.engine.approve(run.id);
    const blocked = await h.waitStatus(run.id, 'blocked');
    expect(blocked.blocked?.kind).toBe('target_dirty');
    expect(readFileSync(join(h.repoDir, 'README.md'), 'utf8')).toBe('# local edit\n');

    git(h.repoDir, 'checkout', '--', 'README.md');
    await h.master.engine.retry(run.id);
    await h.waitStatus(run.id, 'completed');
    expect(existsSync(join(h.repoDir, 'feature.txt'))).toBe(true);
  });

  it('blocks on a merge conflict until the human merges, resolves and commits', async () => {
    h = await harness();
    const store = h.master.store;
    const run = h.run();
    const waiting = await h.waitStatus(run.id, 'waiting_approval');
    const worktree = waiting.worktreePath as string;
    const runHead = git(worktree, 'rev-parse', 'HEAD');
    // main adds the same file with other content: merging it into the run branch conflicts.
    writeFile(join(h.repoDir, 'feature.txt'), 'from main\n');
    git(h.repoDir, 'add', '-A');
    git(h.repoDir, 'commit', '-q', '-m', 'main adds feature.txt');
    const mainHead = git(h.repoDir, 'rev-parse', 'main');
    const blockedCount = () => store.listEvents(run.id).filter((e) => e.type === 'run.blocked');

    const expectConflictBlock = async (times: number) => {
      await waitFor(() => blockedCount().length === times, `block #${times}`);
      const blocked = store.getRun(run.id);
      expect(blocked.status).toBe('blocked');
      expect(blocked.blocked?.kind).toBe('merge_conflict');
      expect(blocked.blocked?.message).toContain('`git merge main`');
      expect(blocked.blocked?.message).toContain(worktree);
      // The merge was given up: main did not move and the worktree is clean on the run's commit.
      expect(git(h?.repoDir as string, 'rev-parse', 'main')).toBe(mainHead);
      expect(git(h?.repoDir as string, 'show', 'main:feature.txt')).toBe('from main');
      expect(git(worktree, 'status', '--porcelain')).toBe('');
      expect(git(worktree, 'rev-parse', 'HEAD')).toBe(runHead);
    };

    h.master.engine.approve(run.id);
    await expectConflictBlock(1);

    // (a) Retrying without doing anything runs into the same conflict.
    await h.master.engine.retry(run.id);
    await expectConflictBlock(2);

    // (b) Resolved by hand but not committed: the retry discards it and conflicts again.
    const eventTypes = () => store.listEvents(run.id).map((e) => e.type);
    expect(eventTypes()).not.toContain('merge.discarded_changes');
    expect(() => git(worktree, 'merge', '-q', 'main')).toThrow();
    writeFile(join(worktree, 'feature.txt'), 'ok\nfrom main\n');
    git(worktree, 'add', 'feature.txt');
    await h.master.engine.retry(run.id);
    await expectConflictBlock(3);
    expect(eventTypes()).toContain('merge.discarded_changes');

    // (c) Resolved and committed: the merge checks the human's commit and completes.
    expect(() => git(worktree, 'merge', '-q', 'main')).toThrow();
    writeFile(join(worktree, 'feature.txt'), 'ok\nfrom main\n');
    git(worktree, 'add', 'feature.txt');
    git(worktree, 'commit', '-q', '--no-edit');
    await h.master.engine.retry(run.id);
    await h.waitStatus(run.id, 'completed');
    expect(git(h.repoDir, 'show', 'main:feature.txt')).toBe('ok\nfrom main');
    const mergeStage = store.listStageRuns(run.id).find((sr) => sr.stageId === 'merge');
    const checks = store.listChecks(run.id).filter((c) => c.stageRunId === mergeStage?.id);
    expect(checks.filter((c) => c.kind === 'command').map((c) => [c.name, c.passed])).toEqual([
      ['grep -q ok feature.txt', true],
    ]);
    expect(checks.filter((c) => c.kind === 'merge').map((c) => c.passed)).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it('with on_exhausted: human, blocks on max_loops and a retry grants one more round', async () => {
    h = await harness({ workflow: WAIT_WHEN_EXHAUSTED });
    h.scripts.reviewer = () => review([{ severity: 'must', description: '还是不行' }]);
    const run = h.run('目标', { max_loops: 1 });
    const blocked = await h.waitStatus(run.id, 'blocked');
    expect(blocked.blocked?.kind).toBe('max_loops');
    expect(h.master.store.countStageRounds(run.id, 'implement')).toBe(2);

    h.scripts.reviewer = () => review();
    await h.master.engine.retry(run.id);
    await h.waitStatus(run.id, 'waiting_approval');
    expect(h.master.store.countStageRounds(run.id, 'implement')).toBe(3);
  });

  it('refuses to create a Run with an unknown repo or template, or invalid overrides', async () => {
    h = await harness();
    const { engine, store } = h.master;
    const create = (input: Partial<Parameters<typeof engine.createRun>[0]>) => () =>
      engine.createRun({ repo: 'demo', template: 'dev', goal: '目标', ...input });
    expect(create({ repo: 'nope' })).toThrow(NotFoundError);
    expect(create({ template: 'nope' })).toThrow(/模板 nope 不存在或无效/);
    expect(create({ goal: '  ' })).toThrow(InvalidStateError);
    expect(create({ overrides: { budget_usd: -1 } })).toThrow(/budget_usd/);
    expect(create({ overrides: { stages: { nope: { gate: false } } } })).toThrow(/阶段 nope/);
    expect(store.listRuns()).toEqual([]);
  });

  it('run overrides can turn off the merge gate', async () => {
    h = await harness();
    const run = h.run('目标', { stages: { merge: { gate: false } } });
    await h.waitStatus(run.id, 'completed');
    expect(existsSync(join(h.repoDir, 'feature.txt'))).toBe(true);
  });

  it('discards files a reviewer changed', async () => {
    h = await harness();
    h.scripts.reviewer = (ctx) => {
      writeFile(join(ctx.input.workdir, 'reviewer-was-here.txt'), 'x\n');
      return review();
    };
    const run = h.run();
    const waiting = await h.waitStatus(run.id, 'waiting_approval');
    expect(existsSync(join(waiting.worktreePath as string, 'reviewer-was-here.txt'))).toBe(false);
  });

  it('blocks when setup commands fail and retry recreates the workspace', async () => {
    h = await harness({ setupCommands: ['test -f setup-ok'] });
    const run = h.run();
    const blocked = await h.waitStatus(run.id, 'blocked');
    expect(blocked.blocked?.kind).toBe('setup_failed');

    writeFile(join(h.repoDir, 'setup-ok'), '1\n');
    git(h.repoDir, 'add', '-A');
    git(h.repoDir, 'commit', '-q', '-m', 'add setup-ok');
    await h.master.engine.retry(run.id);
    await h.waitStatus(run.id, 'waiting_approval');
  });

  it('gives agents and the setup and verify commands no GitHub credentials', async () => {
    vi.stubEnv('GH_TOKEN', 'gho_master');
    vi.stubEnv('GITHUB_TOKEN', 'ghp_master');
    vi.stubEnv('GH_ENTERPRISE_TOKEN', 'ghe_master');
    vi.stubEnv('GITHUB_ENTERPRISE_TOKEN', 'ghe_master2');
    vi.stubEnv('ARES1_TEST_KEEP', 'kept');
    const out = tmpDir('ares1-env-');
    h = await harness({
      // The setup command also leaves a gh login behind, which the next agent must not get.
      setupCommands: [`env > ${out}/setup.env && echo token > "$GH_CONFIG_DIR/hosts.yml"`],
      verifyCommands: [`env > ${out}/verify.env`, 'grep -q ok feature.txt'],
    });
    const ghDir = h.master.paths.agentGhConfigDir;
    const seen: string[][] = [];
    const coder = h.scripts.coder as Script;
    h.scripts.coder = (ctx) => {
      seen.push(readdirSync(ghDir));
      return coder(ctx);
    };
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');

    const expectNoGitHub = (env: Record<string, string | undefined>) => {
      expect(env.GH_TOKEN).toBe(AGENT_GH_TOKEN);
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.GH_ENTERPRISE_TOKEN).toBeUndefined();
      expect(env.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
      expect(env.GH_CONFIG_DIR).toBe(ghDir);
      expect(env.GIT_TERMINAL_PROMPT).toBe('0');
      expect(env.ARES1_TEST_KEEP).toBe('kept');
      expect(env.PATH).toBe(process.env.PATH);
    };
    // The coder and the reviewer.
    expect(h.fake.calls.map((c) => c.model)).toEqual(['coder', 'reviewer']);
    for (const call of h.fake.calls) expectNoGitHub(call.env);
    expectNoGitHub(readEnvFile(join(out, 'setup.env')));
    expectNoGitHub(readEnvFile(join(out, 'verify.env')));
    expect(seen).toEqual([[]]);
    // The Master keeps its own credentials.
    expect(process.env.GH_TOKEN).toBe('gho_master');
  });
});

/** The discussion of a Run in short: 「assessor:ask」, 「human:dashboard」, 「timeout:24」. */
const discussionKinds = (run: Run) =>
  run.discussion.map(
    (e) =>
      `${e.role}:${e.role === 'assessor' ? e.verdict : e.role === 'human' ? e.source : e.hours}`,
  );

describe('engine: agent errors', () => {
  const failing =
    (error = '模型不存在'): Script =>
    () => ({ status: 'failed', error });
  const eventData = (runId: string, type: string) =>
    (h as Harness).master.store
      .listEvents(runId)
      .filter((e) => e.type === type)
      .map((e) => e.data);
  /** Only a coding stage, so a Run that passes it completes on its own. */
  const implementOnly = (escalate: string) => `
id: dev
defaults:
  escalate: ${escalate}
stages:
  - id: implement
    agent: coder
`;

  it('waits longer before each retry, up to a limit', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffMs(AGENT_RETRY_BACKOFF, n))).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 600_000,
    ]);
  });

  it('retries an agent that errored after a backoff, and goes on once it succeeds', async () => {
    h = await harness({ master: { agentRetryBackoff: { firstMs: 5, maxMs: 8 } } });
    let calls = 0;
    h.scripts.coder = (ctx) => {
      calls++;
      if (calls <= 2) return { status: 'failed', error: `第 ${calls} 次出错` };
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return done();
    };
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');
    expect(h.fake.calls.map((c) => c.model)).toEqual(['coder', 'coder', 'coder', 'reviewer']);
    const task = h.master.store.listRunTasks(run.id)[0] as Task;
    expect(eventData(run.id, 'task.retry_after_error')).toEqual([
      { taskId: task.id, agentId: 'coder', error: '第 1 次出错', attempt: 1, delayMs: 5 },
      { taskId: task.id, agentId: 'coder', error: '第 2 次出错', attempt: 2, delayMs: 8 },
    ]);
    expect(eventData(run.id, 'task.agent_switched')).toEqual([]);
    expect(h.master.store.listAttempts(task.id).map((a) => a.outcome)).toEqual([
      'agent_error',
      'agent_error',
      'passed',
    ]);
    // Errors are counted apart from reworks: none was used up.
    expect(task.retries).toBe(0);
  });

  it('a pause ends the wait before a retry at once; resuming retries', async () => {
    h = await harness({ master: { agentRetryBackoff: { firstMs: 600_000, maxMs: 600_000 } } });
    let calls = 0;
    h.scripts.coder = (ctx) => {
      calls++;
      if (calls === 1) return { status: 'failed', error: 'boom' };
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return done();
    };
    const run = h.run();
    await waitFor(() => eventData(run.id, 'task.retry_after_error').length === 1, 'the wait');
    expect(h.master.store.getRun(run.id).status).toBe('running');
    // Would take ten minutes if the wait went on.
    expect((await h.master.engine.pause(run.id)).status).toBe('paused');
    expect(calls).toBe(1);
    h.master.engine.resume(run.id);
    await h.waitStatus(run.id, 'waiting_approval');
    expect(calls).toBe(2);
  });

  it('switches to another agent once the retries are used up (switch_agent)', async () => {
    h = await harness();
    h.scripts.coder = failing();
    const run = h.run();
    const waiting = await h.waitStatus(run.id, 'waiting_approval');
    // 1 try + 2 retries (max_retries: 2), then coder2 takes over and passes.
    expect(h.fake.calls.map((c) => c.model)).toEqual([
      'coder',
      'coder',
      'coder',
      'coder2',
      'reviewer',
    ]);
    const task = h.master.store.listRunTasks(run.id)[0] as Task;
    expect(task.agentId).toBe('coder2');
    expect(eventData(run.id, 'task.agent_switched')).toEqual([
      { taskId: task.id, from: 'coder', to: 'coder2', error: '模型不存在' },
    ]);
    expect(git(waiting.worktreePath as string, 'log', '-1', '--format=%b')).toContain(
      'Agent: coder2 (fake',
    );
  });

  it('ends the Run as failed, not blocked, when every agent kept erroring', async () => {
    h = await harness({
      agents: `
agents:
  coder: { cli: fake, model: coder, tier: high, cost: high }
  cheap: { cli: fake, model: cheap, tier: low, cost: low }
  pricey: { cli: fake, model: pricey, tier: high, cost: high }
  coder2: { cli: fake, model: coder2, tier: high, cost: mid }
  reviewer: { cli: fake, model: reviewer }
  off: { cli: fake, model: off, tier: high, cost: low, enabled: false }
`,
      workflow: implementOnly('{ max_retries: 1, on_agent_error: switch_agent }'),
    });
    for (const model of ['coder', 'cheap', 'pricey', 'coder2', 'reviewer']) {
      h.scripts[model] = (ctx) => {
        writeFile(join(ctx.input.workdir, 'junk.txt'), `${model}\n`);
        return { status: 'failed', error: `${model} 出错` };
      };
    }
    const run = h.run();
    const failed = await h.waitStatus(run.id, 'failed');
    // Each agent: 1 try + 1 retry. Agents of the same tier or higher first, the cheaper first;
    // then the lower tiers, the cheaper first. The disabled one never.
    const order = ['coder', 'coder2', 'pricey', 'cheap', 'reviewer'];
    expect(h.fake.calls.map((c) => c.model)).toEqual(order.flatMap((m) => [m, m]));
    expect(eventData(run.id, 'task.agent_switched').map((d) => [d.from, d.to])).toEqual([
      ['coder', 'coder2'],
      ['coder2', 'pricey'],
      ['pricey', 'cheap'],
      ['cheap', 'reviewer'],
    ]);
    expect(failed.blocked).toBeNull();
    expect(failed.finishedAt).toBeTruthy();
    expect(failed.error).toContain(
      '试过的 Agent（coder、coder2、pricey、cheap、reviewer）都出错了',
    );
    expect(failed.error).toContain('每个都自动重试了 1 次');
    expect(failed.error).toContain('on_agent_error: switch_agent');
    expect(failed.error).toContain('Agent reviewer 运行出错：reviewer 出错');
    expect(h.master.store.listRunTasks(run.id).map((t) => t.status)).toEqual(['failed']);
    // Rolled back to before the task, and kept for inspection.
    const worktree = failed.worktreePath as string;
    expect(existsSync(join(worktree, 'junk.txt'))).toBe(false);
    expect(git(worktree, 'status', '--porcelain')).toBe('');
    expect(git(h.repoDir, 'branch', '--list', failed.branch as string)).not.toBe('');
    // Nothing waits for a human: the next Run starts.
    await expect(h.master.engine.retry(run.id)).rejects.toThrow(/blocked/);
    h.scripts.coder = (ctx) => {
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return done();
    };
    await h.waitStatus(h.run('下一个').id, 'completed');
  });

  it('ends the Run as failed once the retries are used up with on_agent_error: retry', async () => {
    h = await harness({ workflow: implementOnly('{ max_retries: 1, on_agent_error: retry }') });
    h.scripts.coder = failing();
    const run = h.run();
    const failed = await h.waitStatus(run.id, 'failed');
    expect(h.fake.calls.map((c) => c.model)).toEqual(['coder', 'coder']);
    expect(eventData(run.id, 'task.agent_switched')).toEqual([]);
    expect(failed.error).toContain('自动重试 1 次后仍然出错，Run 结束（on_agent_error: retry）');
    expect(failed.error).toContain('Agent coder 运行出错：模型不存在');
    expect(failed.blocked).toBeNull();
  });

  it('with on_agent_error: human, retries first and then waits; a retry starts over', async () => {
    h = await harness({
      workflow: TEST_WORKFLOW_YAML.replace('on_agent_error: switch_agent', 'on_agent_error: human'),
    });
    h.scripts.coder = failing();
    const run = h.run();
    const blocked = await h.waitStatus(run.id, 'blocked');
    expect(blocked.blocked?.kind).toBe('agent_error');
    expect(blocked.blocked?.message).toContain('Agent coder 运行出错：模型不存在');
    expect(blocked.blocked?.message).toContain('已自动重试 2 次，仍然出错');
    expect(h.fake.calls.map((c) => c.model)).toEqual(['coder', 'coder', 'coder']);
    expect(eventData(run.id, 'task.agent_switched')).toEqual([]);
    expect(() => h?.master.engine.approve(run.id)).toThrow();

    // A human's retry with the same agent gets all the retries again.
    await h.master.engine.retry(run.id);
    await h.waitStatus(run.id, 'blocked');
    expect(h.fake.calls).toHaveLength(6);
    expect(eventData(run.id, 'task.retry_after_error').map((d) => d.attempt)).toEqual([1, 2, 1, 2]);
    // Or with another agent.
    await h.master.engine.retry(run.id, { agentId: 'coder2' });
    await h.waitStatus(run.id, 'waiting_approval');
  });

  it('switches an assessment only to an agent that can run read-only', async () => {
    const scripts: Record<string, Script> = {
      assessor: failing('评估出错'),
      writer: () => assessment('go'),
      backup: () => assessment('go'),
      coder: (ctx) => {
        writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
        return done();
      },
      reviewer: () => review(),
    };
    const fake = new FakeAdapter((ctx) => (scripts[ctx.input.model] as Script)(ctx));
    // A CLI that cannot run an agent read-only.
    const writeOnly: AgentAdapter = { cli: 'fake-rw', start: (input) => fake.start(input) };
    h = await harness({
      agents: `
agents:
  assessor: { cli: fake, model: assessor, tier: high }
  writer: { cli: fake-rw, model: writer, tier: high, cost: low }
  backup: { cli: fake, model: backup, tier: high }
  coder: { cli: fake, model: coder }
  reviewer: { cli: fake, model: reviewer }
`,
      workflow: ASSESS_WORKFLOW_YAML,
      scripts,
      master: { adapters: [fake, writeOnly] },
    });
    const run = h.run();
    await h.waitStatus(run.id, 'completed');
    expect(eventData(run.id, 'task.agent_switched').map((d) => [d.from, d.to])).toEqual([
      ['assessor', 'backup'],
    ]);
    expect(fake.calls.map((c) => c.model)).toEqual([
      'assessor',
      'assessor',
      'assessor',
      'backup',
      'coder',
      'reviewer',
    ]);
  });

  describe('in English', () => {
    afterEach(() => setLang('zh'));

    it('says why the Run ended without Chinese', async () => {
      h = await harness({
        config: 'language: en\n',
        workflow: implementOnly('{ max_retries: 1, on_agent_error: switch_agent }'),
      });
      h.scripts.coder = failing('model not found');
      h.scripts.coder2 = failing('model not found');
      h.scripts.reviewer = failing('model not found');
      const failed = await h.waitStatus(h.run('Add feature.txt').id, 'failed');
      expect(failed.error).toContain('every agent tried (coder, coder2, reviewer) failed');
      expect(failed.error).toContain('each after 1 retry');
      expect(failed.error).toContain('Agent reviewer failed: model not found');
      expect(failed.error).not.toMatch(/[一-鿿]/);
    });
  });
});

describe('engine: reworks and rollbacks used up', () => {
  const eventTypes = (runId: string) =>
    (h as Harness).master.store.listEvents(runId).map((e) => e.type);
  /** A coder whose work never passes the checks (feature.txt must say ok). */
  const wrongCoder: Script = (ctx) => {
    writeFile(join(ctx.input.workdir, 'feature.txt'), 'wrong\n');
    writeFile(join(ctx.input.workdir, 'junk.txt'), 'junk\n');
    return done();
  };
  const goodCoder: Script = (ctx) => {
    writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
    return done();
  };

  it('ends the Run as failed once the reworks are used up, with the last problems', async () => {
    h = await harness();
    h.scripts.coder = wrongCoder;
    const run = h.run();
    const failed = await h.waitStatus(run.id, 'failed');
    // 1 first try + 2 reworks (max_retries: 2)
    expect(h.fake.calls.filter((c) => c.model === 'coder')).toHaveLength(3);
    expect(failed.blocked).toBeNull();
    expect(failed.finishedAt).toBeTruthy();
    expect(failed.error).toContain(
      'Task「编码」返工 2 次后仍未通过验收，Run 结束（on_exhausted: fail），工作目录和分支已保留。最后一次的问题：\n',
    );
    expect(failed.error).toContain('检查命令 `grep -q ok feature.txt` 未通过');
    expect(eventTypes(run.id)).not.toContain('run.blocked');
    expect(h.master.store.listRunTasks(run.id).map((t) => t.status)).toEqual(['failed']);
    // The task is rolled back to before it started, and the worktree kept for inspection.
    const worktree = failed.worktreePath as string;
    expect(existsSync(join(worktree, 'junk.txt'))).toBe(false);
    expect(git(worktree, 'status', '--porcelain')).toBe('');
    expect(git(h.repoDir, 'branch', '--list', failed.branch as string)).not.toBe('');
    // Nothing waits for a human: the next Run starts.
    await expect(h.master.engine.retry(run.id)).rejects.toThrow(/blocked/);
    h.scripts.coder = goodCoder;
    await h.waitStatus(h.run('下一个').id, 'waiting_approval');
  });

  it('ends the Run as failed once the rollbacks are used up, with the last reason', async () => {
    h = await harness();
    h.scripts.reviewer = () => review([{ severity: 'must', description: '还是不行' }]);
    // The stage's own setting does not apply to rollbacks: max_loops is the Run's.
    const run = h.run('目标', {
      max_loops: 1,
      stages: { review: { escalate: { on_exhausted: 'human' } } },
    });
    const failed = await h.waitStatus(run.id, 'failed');
    expect(h.master.store.countStageRounds(run.id, 'implement')).toBe(2);
    expect(failed.blocked).toBeNull();
    expect(failed.error).toContain(
      '阶段「编码」已执行 2 轮，超过回退上限 1，Run 结束（on_exhausted: fail），工作目录和分支已保留。最后一次「评审」没有通过：\n',
    );
    expect(failed.error).toContain('还是不行');
    expect(eventTypes(run.id)).not.toContain('run.blocked');
    await expect(h.master.engine.retry(run.id)).rejects.toThrow(/blocked/);
  });

  it('counts rejected approvals toward max_loops too', async () => {
    h = await harness();
    const run = h.run('目标', { max_loops: 0 });
    await h.waitStatus(run.id, 'waiting_approval');
    h.master.engine.reject(run.id, '方向不对');
    const failed = await h.waitStatus(run.id, 'failed');
    expect(failed.error).toContain('超过回退上限 0');
    expect(failed.error).toContain('最后一次「合并」审批被驳回：\n方向不对');
    expect(existsSync(join(h.repoDir, 'feature.txt'))).toBe(false);
  });

  it('with on_exhausted: human in the defaults, a rework used up waits for a human', async () => {
    h = await harness({ workflow: WAIT_WHEN_EXHAUSTED });
    h.scripts.coder = wrongCoder;
    const run = h.run();
    const blocked = await h.waitStatus(run.id, 'blocked');
    expect(blocked.blocked?.kind).toBe('task_failed');
    expect(blocked.blocked?.message).toContain('检查命令 `grep -q ok feature.txt` 未通过');
    // A retry gets all the reworks again.
    h.scripts.coder = goodCoder;
    await h.master.engine.retry(run.id);
    await h.waitStatus(run.id, 'waiting_approval');
  });

  describe('in English', () => {
    afterEach(() => setLang('zh'));

    const englishWorkflow = TEST_WORKFLOW_YAML.replace('name: 测试流程', 'name: Test flow')
      .replace('name: 编码', 'name: Coding')
      .replace('name: 评审', 'name: Review')
      .replace('name: 合并', 'name: Merge');

    it('says why the Run ended without Chinese', async () => {
      h = await harness({ config: 'language: en\n', workflow: englishWorkflow });
      h.scripts.coder = wrongCoder;
      const reworked = await h.waitStatus(h.run('Add feature.txt').id, 'failed');
      expect(reworked.error).toContain(
        'Task "Coding" still does not pass after 2 reworks, so the Run ended (on_exhausted: fail); the working directory and branch are kept. The last problems:\n',
      );
      expect(reworked.error).not.toMatch(/[一-鿿]/);

      h.scripts.coder = goodCoder;
      const issues = [{ severity: 'must', description: 'still wrong' }];
      h.scripts.reviewer = (): FakeOutcome => ({
        finalMessage: `\`\`\`json\n${JSON.stringify({ summary: 'needs work', issues })}\n\`\`\``,
      });
      const looped = await h.waitStatus(h.run('Add feature.txt', { max_loops: 1 }).id, 'failed');
      expect(looped.error).toContain(
        'Stage "Coding" has run 2 rounds, over the rollback limit of 1, so the Run ended (on_exhausted: fail); the working directory and branch are kept. The last time, "Review" did not pass:\n',
      );
      expect(looped.error).toContain('still wrong');
      expect(looped.error).not.toMatch(/[一-鿿]/);
    });
  });
});

describe('engine: rate limits', () => {
  const eventData = (runId: string, type: string) =>
    (h as Harness).master.store
      .listEvents(runId)
      .filter((e) => e.type === type)
      .map((e) => e.data);
  /** Only a coding stage, where an agent error would wait for a human at once. */
  const WORKFLOW = `
id: dev
defaults:
  escalate: { max_retries: 0, on_agent_error: human }
stages:
  - id: implement
    agent: coder
`;
  const limited = (retryAt?: string): FakeOutcome => ({
    status: 'failed',
    error: '额度用尽或被限流',
    errorKind: 'rate_limited',
    ...(retryAt ? { retryAt } : {}),
  });
  const writeFeature = (ctx: FakeContext): FakeOutcome => {
    writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
    return done();
  };

  it('waits 5, 10, 20, 40 minutes, then hourly; or until the reset time plus a minute', () => {
    expect(
      [1, 2, 3, 4, 5, 6].map((n) => rateLimitDelayMs(RATE_LIMIT_WAIT, 0, undefined, n)),
    ).toEqual([300_000, 600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000]);
    expect(rateLimitDelayMs(RATE_LIMIT_WAIT, 1000, 1000 + 7_200_000, 1)).toBe(7_260_000);
    // A reset time already past says nothing about when the quota is back.
    expect(rateLimitDelayMs(RATE_LIMIT_WAIT, 1000, 500, 2)).toBe(600_000);
  });

  it('waits for the quota without using up retries or blocking, then completes', async () => {
    h = await harness({
      workflow: WORKFLOW,
      master: { rateLimitWait: { firstMs: 50, maxMs: 50, marginMs: 0 } },
    });
    const at: number[] = [];
    h.scripts.coder = (ctx) => {
      at.push(Date.now());
      return at.length === 1 ? limited() : writeFeature(ctx);
    };
    const run = h.run();
    const completed = await h.waitStatus(run.id, 'completed');
    expect(h.fake.calls.map((c) => c.model)).toEqual(['coder', 'coder']);
    expect((at[1] as number) - (at[0] as number)).toBeGreaterThanOrEqual(45);
    const task = h.master.store.listRunTasks(run.id)[0] as Task;
    expect(task.retries).toBe(0);
    expect(task.agentId).toBe('coder');
    expect(h.master.store.listAttempts(task.id).map((a) => a.outcome)).toEqual([
      'rate_limited',
      'passed',
    ]);
    const events = eventData(run.id, 'task.rate_limited');
    expect(events).toEqual([
      {
        taskId: task.id,
        agentId: 'coder',
        retryAt: expect.any(String),
        delayMs: 50,
        resetAt: null,
        error: '额度用尽或被限流',
      },
    ]);
    // Waited in the queue: no retry after an error, no other agent, nothing for a human.
    expect(eventData(run.id, 'task.retry_after_error')).toEqual([]);
    expect(eventData(run.id, 'task.agent_switched')).toEqual([]);
    expect(eventData(run.id, 'run.blocked')).toEqual([]);
    expect(eventData(run.id, 'run.status').map((d) => d.status)).toEqual([
      'running',
      'queued',
      'running',
      'completed',
    ]);
    expect(completed.blocked).toBeNull();
    expect(h.master.engine.rateLimited(completed)).toBeNull();
  });

  it('waits until the reset time the CLI gave, plus the margin', async () => {
    h = await harness({
      workflow: WORKFLOW,
      master: { rateLimitWait: { firstMs: 600_000, maxMs: 600_000, marginMs: 100 } },
    });
    const at: number[] = [];
    let resetAt = 0;
    h.scripts.coder = (ctx) => {
      at.push(Date.now());
      if (at.length > 1) return writeFeature(ctx);
      resetAt = Date.now() + 200;
      return limited(new Date(resetAt).toISOString());
    };
    const run = h.run();
    // Not the ten-minute backoff.
    await h.waitStatus(run.id, 'completed');
    const [event] = eventData(run.id, 'task.rate_limited');
    expect(event?.resetAt).toBe(new Date(resetAt).toISOString());
    expect(event?.retryAt).toBe(new Date(resetAt + 100).toISOString());
    expect(at[1]).toBeGreaterThanOrEqual(resetAt + 100 - 5);
  });

  it('gives the execution slot to other Runs; pausing and resuming tries again at once', async () => {
    h = await harness({
      workflow: WORKFLOW,
      master: { rateLimitWait: { firstMs: 600_000, maxMs: 600_000, marginMs: 0 } },
    });
    let quota = false;
    h.scripts.coder = (ctx) =>
      ctx.input.prompt.includes('第一个') && !quota ? limited() : writeFeature(ctx);
    const first = h.run('第一个');
    await waitFor(() => eventData(first.id, 'task.rate_limited').length === 1, 'the rate limit');
    const waiting = await h.waitStatus(first.id, 'queued');
    expect(waiting.blocked).toBeNull();
    const wait = h.master.engine.rateLimited(waiting);
    expect(wait).toEqual({
      agentId: 'coder',
      retryAt: eventData(first.id, 'task.rate_limited')[0]?.retryAt,
    });
    expect(Date.parse(wait?.retryAt as string) - Date.now()).toBeGreaterThan(500_000);

    // Another Run goes ahead meanwhile; the waiting one stays in the queue.
    const second = h.run('第二个');
    await h.waitStatus(second.id, 'completed');
    expect(h.master.store.getRun(first.id).status).toBe('queued');

    quota = true;
    expect((await h.master.engine.pause(first.id)).status).toBe('paused');
    expect(h.master.engine.rateLimited(h.master.store.getRun(first.id))).toBeNull();
    h.master.engine.resume(first.id);
    await h.waitStatus(first.id, 'completed');
    expect(h.fake.calls.map((c) => c.prompt.includes('第一个'))).toEqual([true, false, true]);
  });

  it('waits longer for each limit in a row; limits neither count as errors nor reset their count', async () => {
    h = await harness({
      workflow: WORKFLOW.replace(
        'max_retries: 0, on_agent_error: human',
        'max_retries: 1, on_agent_error: retry',
      ),
      master: { rateLimitWait: { firstMs: 10, maxMs: 25, marginMs: 0 } },
    });
    const outcomes: FakeOutcome[] = [
      limited(),
      limited(),
      limited(),
      { status: 'failed', error: 'boom 1' },
      limited(),
      { status: 'failed', error: 'boom 2' },
    ];
    let calls = 0;
    h.scripts.coder = () => outcomes[calls++] ?? done();
    const run = h.run();
    const failed = await h.waitStatus(run.id, 'failed');
    expect(calls).toBe(6);
    expect(eventData(run.id, 'task.rate_limited').map((d) => d.delayMs)).toEqual([10, 20, 25, 10]);
    // boom 1 used the one retry; the limit after it did not give another.
    expect(eventData(run.id, 'task.retry_after_error').map((d) => d.error)).toEqual(['boom 1']);
    expect(failed.error).toContain('boom 2');
  });
});

describe('engine: requirement assessment', () => {
  const start = () => harness({ agents: ASSESS_AGENTS_YAML, workflow: ASSESS_WORKFLOW_YAML });
  const prompts = (t: Harness, model: string) =>
    t.fake.calls.filter((c) => c.model === model).map((c) => c.prompt);

  it('goes ahead on go: coding starts and its prompt carries the assessment', async () => {
    h = await start();
    h.scripts.assessor = () => assessment('go', { summary: '需求清楚，和已有功能不冲突' });
    const run = h.run();
    const completed = await h.waitStatus(run.id, 'completed');
    const store = h.master.store;

    // Read-only, in the Run's worktree, before anything else.
    const call = h.fake.calls[0];
    expect(call?.model).toBe('assessor');
    expect(call?.readOnly).toBe(true);
    expect(call?.permission).toBe('safe');
    expect(call?.prompt).toContain('添加 feature.txt');
    expect(call?.prompt).toContain('README 里写的目标是判断一切的依据');
    expect(call?.prompt).toContain('还没有和人讨论过，不能给出 drop');
    expect(call?.prompt).not.toContain('## 讨论记录');

    expect(store.listStageRuns(run.id).map((sr) => `${sr.stageId}:${sr.status}`)).toEqual([
      'assess:passed',
      'implement:passed',
      'review:passed',
      'merge:passed',
    ]);
    expect(completed.discussion).toMatchObject([
      { role: 'assessor', verdict: 'go', summary: '需求清楚，和已有功能不冲突', revisedGoal: null },
    ]);
    expect(store.listChecks(run.id)[0]).toMatchObject({ kind: 'assess', passed: true });
    expect(store.latestArtifact(run.id, 'assessment')).toBeTruthy();

    // Coding and review read the assessment through `inputs: [assessment]`.
    for (const model of ['coder', 'reviewer']) {
      const [prompt] = prompts(h, model);
      expect(prompt).toContain('### assessment');
      expect(prompt).toContain('需求评估结论：按原需求开工');
      expect(prompt).toContain('需求清楚，和已有功能不冲突');
    }
  });

  it('blocks on ask, and a reply sends it back to assess; go with a revised goal', async () => {
    h = await start();
    let n = 0;
    h.scripts.assessor = (ctx) => {
      n++;
      if (n === 1) {
        return assessment('ask', {
          summary: '没说 feature.txt 写什么',
          questions: ['feature.txt 的内容是什么？'],
          suggestions: ['写 ok'],
        });
      }
      // The second round reads the whole discussion.
      expect(ctx.input.prompt).toContain('## 讨论记录');
      expect(ctx.input.prompt).toContain('feature.txt 的内容是什么？');
      expect(ctx.input.prompt).toContain('### 人的回复（看板上）\n\n写 ok，再加一行 B');
      return assessment('go', {
        summary: '按回复修改了需求',
        revisedGoal: '添加 feature.txt，第一行 ok，第二行 B',
      });
    };
    const run = h.run();
    const blocked = await h.waitStatus(run.id, 'blocked');
    expect(blocked.blocked?.kind).toBe('discussion');
    expect(blocked.blocked?.message).toContain('需求评估有疑问，等你回复');
    expect(blocked.blocked?.message).toContain('1. feature.txt 的内容是什么？');
    // Nothing else ran, and a human is told.
    expect(h.fake.calls).toHaveLength(1);
    const event = h.master.store.listEvents(run.id).findLast((e) => e.type === 'run.blocked');
    expect(event && noticeFor(event, blocked.goal)?.title).toBe('需求待讨论，等你回复');

    // A reply is required to go on.
    await expect(h.master.engine.retry(run.id, {})).rejects.toThrow('请填写回复');
    await h.master.engine.retry(run.id, { note: '写 ok，再加一行 B' });
    const completed = await h.waitStatus(run.id, 'completed');

    expect(discussionKinds(completed)).toEqual(['assessor:ask', 'human:dashboard', 'assessor:go']);
    expect(completed.discussion[2]).toMatchObject({
      revisedGoal: '添加 feature.txt，第一行 ok，第二行 B',
    });
    // One stage round: the reply runs the same assessment task again.
    expect(h.master.store.countStageRounds(run.id, 'assess')).toBe(1);
    expect(
      h.master.store.listRunAttempts(run.id).filter((a) => a.agentId === 'assessor'),
    ).toHaveLength(2);

    // The coder works from the revised requirement and sees the discussion.
    const [coder] = prompts(h, 'coder');
    expect(coder).toContain('需求评估结论：按讨论后修改的需求开工');
    expect(coder).toContain('修改后的需求（以它为准，替代「目标」中的原需求）');
    expect(coder).toContain('添加 feature.txt，第一行 ok，第二行 B');
    expect(coder).toContain('写 ok，再加一行 B');
  });

  it('ends the Run as dropped, not failed, once a human agreed not to do it', async () => {
    h = await start();
    let n = 0;
    h.scripts.assessor = (ctx) => {
      if (++n === 1) {
        return assessment('ask', { questions: ['和已有的 X 重复，还要做吗？'] });
      }
      expect(ctx.input.prompt).toContain('同意，不做了');
      return assessment('drop', { summary: '和 X 重复，人已同意不做' });
    };
    const run = h.run();
    await h.waitStatus(run.id, 'blocked');
    const worktree = h.master.store.getRun(run.id).worktreePath as string;
    await h.master.engine.retry(run.id, { note: '同意，不做了' });
    const dropped = await h.waitStatus(run.id, 'dropped');

    expect(dropped.error).toBeNull();
    expect(dropped.finishedAt).toBeTruthy();
    expect(dropped.discussion.at(-1)).toMatchObject({
      verdict: 'drop',
      summary: '和 X 重复，人已同意不做',
    });
    // No code was written; nothing is kept.
    expect(h.fake.calls.map((c) => c.model)).toEqual(['assessor', 'assessor']);
    expect(h.master.store.listStageRuns(run.id).map((sr) => `${sr.stageId}:${sr.status}`)).toEqual([
      'assess:passed',
    ]);
    const store = h.master.store;
    await waitFor(
      () => store.listEvents(run.id).some((e) => e.type === 'workspace.removed'),
      'the workspace to be removed',
    );
    expect(existsSync(worktree)).toBe(false);
    expect(git(h.repoDir, 'branch', '--list', `ares1/${run.id}`)).toBe('');
    // Not announced as a failure; it is over.
    const events = h.master.store.listEvents(run.id);
    expect(events.map((e) => noticeFor(e, run.goal)?.kind)).not.toContain('failed');
    await expect(h.master.engine.cancel(run.id)).rejects.toThrow('已经结束');
  });

  it('takes a drop in the first round as ask, to be confirmed by a human', async () => {
    h = await start();
    let n = 0;
    h.scripts.assessor = (ctx) => {
      if (++n === 1) {
        return assessment('drop', {
          summary: '和 README 的「不做的事」冲突',
          // The agent also tried to change the goal on its own: ignored.
          revisedGoal: '别的需求',
        });
      }
      expect(ctx.input.prompt).toContain('### 第 1 轮评估：认为不该做，请人确认');
      return assessment('go', { revisedGoal: '只做不冲突的部分：添加 feature.txt' });
    };
    const run = h.run();
    const blocked = await h.waitStatus(run.id, 'blocked');
    expect(blocked.blocked?.kind).toBe('discussion');
    expect(blocked.blocked?.message).toContain('需求评估认为不该做，请确认');
    expect(blocked.discussion).toMatchObject([
      { verdict: 'ask', proposedDrop: true, revisedGoal: null },
    ]);
    expect(h.master.store.listChecks(run.id)[0]).toMatchObject({ kind: 'assess', passed: false });

    await h.master.engine.retry(run.id, { note: '还是要做，只做不冲突的部分' });
    const completed = await h.waitStatus(run.id, 'completed');
    expect(completed.discussion.at(-1)).toMatchObject({
      verdict: 'go',
      revisedGoal: '只做不冲突的部分：添加 feature.txt',
    });
  });

  it('reassesses when the output has the wrong format', async () => {
    h = await start();
    let n = 0;
    h.scripts.assessor = () =>
      ++n === 1 ? assessment('ask', { questions: [] }) : assessment('go');
    const run = h.run();
    await h.waitStatus(run.id, 'completed');
    const [, second] = prompts(h, 'assessor');
    expect(second).toContain('## 上一次评估没有完成');
    expect(second).toContain('verdict 为 ask 时要在 questions 里列出疑问或顾虑');
    expect(h.master.store.getRun(run.id).discussion.map((e) => e.role)).toEqual(['assessor']);
  });
});

describe('engine: requirement assessment without a reply', () => {
  const HOUR = 3_600_000;
  /** The assess stage of ASSESS_WORKFLOW_YAML with `reply_timeout_hours: <value>`. */
  const withTimeout = (value: string) =>
    ASSESS_WORKFLOW_YAML.replace(
      '    kind: assess\n    agent: assessor\n',
      `    kind: assess\n    agent: assessor\n    reply_timeout_hours: ${value}\n`,
    );
  /** A Master whose clock is `offset` ms ahead of the real one. */
  const clock = { offset: 0 };
  const start = (workflow = ASSESS_WORKFLOW_YAML) => {
    clock.offset = 0;
    return harness({
      agents: ASSESS_AGENTS_YAML,
      workflow,
      master: { now: () => Date.now() + clock.offset },
    });
  };
  const prompts = (t: Harness) =>
    t.fake.calls.filter((c) => c.model === 'assessor').map((c) => c.prompt);
  const ask = () =>
    assessment('ask', { summary: '没说 feature.txt 写什么', questions: ['feature.txt 写什么？'] });

  it('decides on its own once nobody replied within the default 24 hours, then goes ahead', async () => {
    h = await start();
    let n = 0;
    h.scripts.assessor = (ctx) => {
      if (++n === 1) return ask();
      // The round after the timeout sees the questions and may only conclude.
      expect(ctx.input.prompt).toContain('feature.txt 写什么？');
      expect(ctx.input.prompt).toContain('### 24 小时内没有人回复');
      expect(ctx.input.prompt).toContain('上面的疑问 24 小时内没有人回复，这一轮由你自己决定');
      expect(ctx.input.prompt).toContain('不能再给 ask');
      expect(ctx.input.prompt).toContain('不要写 revisedGoal');
      return assessment('go', {
        summary: '没人回复，假设 feature.txt 写 ok',
        // Not taken: assumptions go into the summary.
        revisedGoal: '别的需求',
      });
    };
    const run = h.run();
    const blocked = await h.waitStatus(run.id, 'blocked');
    expect(blocked.blocked?.kind).toBe('discussion');
    expect(blocked.blocked?.message).toContain('24 小时内没有人回复的话，评估会自己决定');
    const engine = h.master.engine;

    // Not yet: it keeps waiting.
    clock.offset = 23 * HOUR;
    expect(engine.checkReplyTimeouts()).toEqual([]);
    expect(h.master.store.getRun(run.id).status).toBe('blocked');

    // Over the deadline but with the work switch off: a human may still reply.
    clock.offset = 24 * HOUR + 1000;
    engine.setWorking(false);
    expect(engine.checkReplyTimeouts()).toEqual([]);
    expect(h.master.store.getRun(run.id).status).toBe('blocked');

    // Switching it on times the discussion out, and the Run goes on by itself.
    engine.setWorking(true);
    const completed = await h.waitStatus(run.id, 'completed');
    expect(discussionKinds(completed)).toEqual(['assessor:ask', 'timeout:24', 'assessor:go']);
    expect(completed.discussion.at(-1)).toMatchObject({
      verdict: 'go',
      summary: '没人回复，假设 feature.txt 写 ok',
      revisedGoal: null,
      decidedAlone: true,
    });
    const events = h.master.store.listEvents(run.id);
    expect(events.filter((e) => e.type === 'discussion.timed_out').map((e) => e.data)).toEqual([
      { hours: 24 },
    ]);
    // The same assessment task ran again, in the same stage round.
    expect(h.master.store.countStageRounds(run.id, 'assess')).toBe(1);
    expect(prompts(h)).toHaveLength(2);

    // The coder works on the assessment's assumptions and sees the discussion.
    const [coder] = h.fake.calls.filter((c) => c.model === 'coder').map((c) => c.prompt);
    expect(coder).toContain('需求评估结论：没人回复，按评估的假设开工');
    expect(coder).toContain('没人回复，假设 feature.txt 写 ok');
    expect(coder).toContain('feature.txt 写什么？');
    expect(coder).not.toContain('别的需求');
  });

  it('ends the Run as dropped when the assessment decides so after the timeout', async () => {
    // A timeout of about a second, run by the engine's own timer.
    h = await start(withTimeout('0.0003'));
    let n = 0;
    h.scripts.assessor = () =>
      ++n === 1
        ? assessment('drop', { summary: '和已有的 X 重复' })
        : assessment('drop', { summary: '没人确认，和 X 重复，不做' });
    const run = h.run();
    const blocked = await h.waitStatus(run.id, 'blocked');
    // Before the timeout a drop still waits for a human to confirm.
    expect(blocked.discussion).toMatchObject([{ verdict: 'ask', proposedDrop: true }]);
    const dropped = await h.waitStatus(run.id, 'dropped');

    expect(dropped.error).toBeNull();
    expect(discussionKinds(dropped)).toEqual(['assessor:ask', 'timeout:0.0003', 'assessor:drop']);
    expect(dropped.discussion.at(-1)).toMatchObject({
      verdict: 'drop',
      summary: '没人确认，和 X 重复，不做',
      proposedDrop: false,
      decidedAlone: true,
    });
    expect(h.fake.calls.map((c) => c.model)).toEqual(['assessor', 'assessor']);
    const events = h.master.store.listEvents(run.id);
    expect(events.map((e) => noticeFor(e, run.goal)?.kind)).not.toContain('failed');
  });

  it('does not wait at all with 0, and refuses another ask in the round that decides', async () => {
    h = await start(withTimeout('0'));
    let n = 0;
    h.scripts.assessor = () => (++n <= 2 ? ask() : assessment('go', { summary: '假设写 ok' }));
    const run = h.run();
    const completed = await h.waitStatus(run.id, 'completed');

    // Never blocked: nobody was asked to reply.
    const events = h.master.store.listEvents(run.id);
    expect(events.some((e) => e.type === 'run.blocked')).toBe(false);
    expect(discussionKinds(completed)).toEqual(['assessor:ask', 'timeout:0', 'assessor:go']);
    const [, second, third] = prompts(h);
    expect(second).toContain('这个阶段不等人回复，这一轮由你自己决定');
    // The second round asked again: sent back as a result that does not pass.
    expect(third).toContain('## 上一次评估没有完成');
    expect(third).toContain('这一轮不能再给 ask');
    expect(
      h.master.store
        .listRunAttempts(run.id)
        .filter((a) => a.agentId === 'assessor')
        .map((a) => a.outcome),
    ).toEqual(['passed', 'rework', 'passed']);
  });

  it('a reply before the timeout is followed as before, and nothing times out after it', async () => {
    h = await start();
    let n = 0;
    h.scripts.assessor = (ctx) => {
      if (++n === 1) return ask();
      // The usual round after a reply: the human's answer, and a revised goal is allowed.
      expect(ctx.input.prompt).toContain('### 人的回复（看板上）\n\n写 ok');
      expect(ctx.input.prompt).toContain('在 revisedGoal 里写修改后的完整需求');
      expect(ctx.input.prompt).not.toContain('不能再给 ask');
      return assessment('go', { summary: '按回复', revisedGoal: '添加 feature.txt，内容 ok' });
    };
    const run = h.run();
    await h.waitStatus(run.id, 'blocked');
    clock.offset = 23 * HOUR;
    expect(h.master.engine.checkReplyTimeouts()).toEqual([]);
    await h.master.engine.retry(run.id, { note: '写 ok' });
    const completed = await h.waitStatus(run.id, 'completed');

    clock.offset = 48 * HOUR;
    expect(h.master.engine.checkReplyTimeouts()).toEqual([]);
    expect(discussionKinds(h.master.store.getRun(run.id))).toEqual([
      'assessor:ask',
      'human:dashboard',
      'assessor:go',
    ]);
    expect(completed.discussion.at(-1)).toMatchObject({
      revisedGoal: '添加 feature.txt，内容 ok',
    });
    expect(completed.discussion.at(-1)).not.toHaveProperty('decidedAlone');
    const events = h.master.store.listEvents(run.id);
    expect(events.some((e) => e.type === 'discussion.timed_out')).toBe(false);
  });

  it('waits however long it takes with null', async () => {
    h = await start(withTimeout('null'));
    h.scripts.assessor = ask;
    const run = h.run();
    const blocked = await h.waitStatus(run.id, 'blocked');
    expect(blocked.blocked?.message).not.toContain('没有人回复');
    clock.offset = 1000 * HOUR;
    expect(h.master.engine.checkReplyTimeouts()).toEqual([]);
    expect(h.master.store.getRun(run.id).status).toBe('blocked');
  });
});

describe('engine: budget', () => {
  const withBudget = (defaults: string) =>
    TEST_WORKFLOW_YAML.replace('  max_loops: 3\n', `  max_loops: 3\n${defaults}`);

  /** Every execution costs `cost`; the coder's first result fails the verify command. */
  function costly(target: Harness, cost: number): void {
    let coderRuns = 0;
    target.scripts.coder = (ctx) => {
      coderRuns++;
      writeFile(join(ctx.input.workdir, 'feature.txt'), coderRuns === 1 ? 'wrong\n' : 'ok\n');
      return { ...done(), costUsd: cost };
    };
    target.scripts.reviewer = () => ({ ...review(), costUsd: cost });
  }

  it('blocks before the next execution once the budget is spent; a higher budget continues', async () => {
    h = await harness({ workflow: withBudget('  budget_usd: 1\n') });
    costly(h, 1.2);
    const run = h.run();
    const blocked = await h.waitStatus(run.id, 'blocked');
    expect(blocked.blocked?.kind).toBe('budget');
    expect(blocked.blocked?.message).toContain('已花费 $1.20，超过预算 $1.00');
    expect(blocked.blocked?.taskId).toBeUndefined();
    // Soft limit: the execution that crossed the budget was checked; the rework never started.
    expect(h.fake.calls).toHaveLength(1);
    expect(blocked.costUsd).toBeCloseTo(1.2);
    const task = h.master.store.listRunTasks(run.id)[0];
    expect(task).toMatchObject({ status: 'pending', retries: 1 });
    expect(task?.pendingFeedback).toContain('grep -q ok feature.txt');
    const types = h.master.store.listEvents(run.id).map((e) => e.type);
    expect(types).toContain('run.budget_exceeded');

    const engine = h.master.engine;
    await expect(engine.retry(run.id)).rejects.toThrow(/新的预算/);
    await expect(engine.retry(run.id, { budgetUsd: 1.2 })).rejects.toThrow(/必须大于已花费/);
    await expect(engine.retry(run.id, { budgetUsd: 5, agentId: 'coder2' })).rejects.toThrow(
      /不能换 Agent/,
    );
    expect(h.master.store.getRun(run.id).status).toBe('blocked');

    const resumed = await engine.retry(run.id, { budgetUsd: 5 });
    expect(resumed.overrides.budget_usd).toBe(5);
    await h.waitStatus(run.id, 'waiting_approval');
    // The task went on where it stopped: the rework resumed the session with the feedback.
    const coderCalls = h.fake.calls.filter((c) => c.model === 'coder');
    expect(coderCalls).toHaveLength(2);
    expect(coderCalls[1]?.resumeSessionId).toBeTruthy();
    expect(coderCalls[1]?.prompt).toContain('grep -q ok feature.txt');
    const changed = h.master.store.listEvents(run.id).find((e) => e.type === 'run.budget_changed');
    expect(changed?.data).toMatchObject({ from: 1, to: 5 });

    engine.approve(run.id);
    const completed = await h.waitStatus(run.id, 'completed');
    expect(completed.costUsd).toBeCloseTo(3.6);
  });

  it('keeps going while under budget and checks before every execution', async () => {
    h = await harness({ workflow: withBudget('  budget_usd: 1\n') });
    costly(h, 0.8);
    const run = h.run();
    const blocked = await h.waitStatus(run.id, 'blocked');
    expect(blocked.blocked?.kind).toBe('budget');
    // $0.80 < $1: the rework ran; $1.60 ≥ $1: the review did not.
    expect(h.fake.calls.map((c) => c.model)).toEqual(['coder', 'coder']);
    expect(blocked.blocked?.message).toContain('已花费 $1.60，超过预算 $1.00');
    const current = h.master.store.getStageRun(blocked.currentStageRunId as string);
    expect(current.stageId).toBe('review');
  });

  it('fails the Run when on_budget_exceeded is abort', async () => {
    h = await harness({
      workflow: withBudget('  budget_usd: 1\n').replace(
        '    on_agent_error: switch_agent\n',
        '    on_agent_error: switch_agent\n    on_budget_exceeded: abort\n',
      ),
    });
    costly(h, 1.2);
    const run = h.run();
    const failed = await h.waitStatus(run.id, 'failed');
    expect(failed.error).toContain('超过预算 $1.00');
    expect(failed.error).toContain('on_budget_exceeded: abort');
    expect(failed.finishedAt).toBeTruthy();
    expect(failed.blocked).toBeNull();
    expect(h.fake.calls).toHaveLength(1);
    expect(h.master.store.listRunTasks(run.id).map((t) => t.status)).toEqual(['cancelled']);
    // Kept for inspection, like a cancelled Run.
    expect(existsSync(failed.worktreePath as string)).toBe(true);
    await expect(h.master.engine.retry(run.id, { budgetUsd: 5 })).rejects.toThrow(/blocked/);
  });

  it('a budget given when creating the Run overrides the template default', async () => {
    h = await harness({ workflow: withBudget('  budget_usd: 1\n') });
    costly(h, 1.2);
    const run = h.run('目标', { budget_usd: 10 });
    const waiting = await h.waitStatus(run.id, 'waiting_approval');
    expect(waiting.costUsd).toBeCloseTo(3.6);

    // A lower one applies as well.
    costly(h, 0.3);
    const tight = h.run('目标', { budget_usd: 0.25 });
    const blocked = await h.waitStatus(tight.id, 'blocked');
    expect(blocked.blocked?.message).toContain('预算 $0.25');
  });

  it('does not check anything without a budget', async () => {
    h = await harness();
    costly(h, 100);
    const run = h.run();
    const waiting = await h.waitStatus(run.id, 'waiting_approval');
    expect(waiting.costUsd).toBe(300);
    await expect(h.master.engine.retry(run.id, { budgetUsd: 5 })).rejects.toThrow(/blocked/);
  });
});

describe('engine: restart', () => {
  it('a graceful stop requeues the active run and a new Master finishes it', async () => {
    const first = await harness();
    first.scripts.coder = async (ctx) => {
      writeFile(join(ctx.input.workdir, 'partial.txt'), 'half\n');
      await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
      return done();
    };
    const run = first.run();
    await waitFor(() => first.fake.calls.length === 1, 'agent to start');
    await first.close();

    h = await harness({ home: first.home, repoDir: first.repoDir });
    const waiting = await h.waitStatus(run.id, 'waiting_approval');
    expect(existsSync(join(waiting.worktreePath as string, 'partial.txt'))).toBe(false);
    const statuses = h.master.store.listRunAttempts(run.id).map((a) => a.status);
    expect(statuses).toEqual(['stopped', 'completed', 'completed']);
  });

  it('redoes a merge interrupted after syncing the target, checks included', async () => {
    const first = await harness();
    const run = first.run();
    await first.waitStatus(run.id, 'waiting_approval');
    // main moves on, so the merge must sync and re-run the checks; make the checks hang.
    writeFile(join(first.repoDir, 'other.txt'), 'other\n');
    git(first.repoDir, 'add', '-A');
    git(first.repoDir, 'commit', '-q', '-m', 'other');
    const marker = join(first.home, 'checks-may-finish');
    first.master.store.updateRepo(first.repo.id, {
      verifyCommands: [`test -f ${marker} || sleep 30; grep -q ok feature.txt`],
    });
    first.master.engine.approve(run.id);
    const synced = () =>
      first.master.store.listEvents(run.id).some((e) => e.type === 'merge.synced');
    await waitFor(synced, 'merge to sync main');
    const accepted = first.master.store.getRun(run.id).headCommit;
    // Stopped in the middle of the checks (a crash goes through the same recovery).
    await first.close();

    writeFile(marker, '1\n');
    h = await harness({ home: first.home, repoDir: first.repoDir });
    const store = h.master.store;
    expect(store.listEvents(run.id).map((e) => e.type)).toContain('merge.unchecked_discarded');
    const done = await h.waitStatus(run.id, 'completed');
    expect(done.headCommit).not.toBe(accepted);
    // The checks ran on the synced code before merging.
    const mergeStage = store.listStageRuns(run.id).find((sr) => sr.stageId === 'merge');
    const checks = store.listChecks(run.id).filter((c) => c.stageRunId === mergeStage?.id);
    expect(checks.some((c) => c.kind === 'command' && c.passed)).toBe(true);
    expect(git(h.repoDir, 'show', 'main:feature.txt')).toBe('ok');
    expect(git(h.repoDir, 'show', 'main:other.txt')).toBe('other');
  });

  it('recovers a run left "running" by a crash', async () => {
    const first = await harness();
    first.scripts.coder = async (ctx) => {
      await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
      return done();
    };
    const run = first.run();
    await waitFor(() => first.fake.calls.length === 1, 'agent to start');
    // Simulate a crash: the database still says "running" when the next Master opens it.
    const store = first.master.store;
    expect(store.getRun(run.id).status).toBe('running');

    h = await harness({ home: first.home, repoDir: first.repoDir });
    await h.waitStatus(run.id, 'waiting_approval');
    const attempts = h.master.store.listRunAttempts(run.id);
    expect(attempts[0]?.status).toBe('interrupted');
    expect(h.master.store.listEvents(run.id).some((e) => e.type === 'run.recovered')).toBe(true);
    // The "crashed" first Master is left as is; its hanging fake agent never resolves.
  });
});

describe('engine: workspace consistency', () => {
  it('blocks when the worktree is gone; a retry brings it back from the branch', async () => {
    h = await harness();
    const run = h.run();
    const waiting = await h.waitStatus(run.id, 'waiting_approval');
    rmSync(waiting.worktreePath as string, { recursive: true, force: true });
    h.master.engine.approve(run.id);
    const blocked = await h.waitStatus(run.id, 'blocked');
    expect(blocked.blocked?.kind).toBe('workspace');
    expect(blocked.blocked?.message).toMatch(/不存在/);
    await h.master.engine.retry(run.id);
    await h.waitStatus(run.id, 'completed');
    expect(git(h.repoDir, 'show', 'main:feature.txt')).toBe('ok');
  });

  it('blocks when the history was reset by hand; a retry continues from it', async () => {
    h = await harness();
    const run = h.run();
    const waiting = await h.waitStatus(run.id, 'waiting_approval');
    const worktree = waiting.worktreePath as string;
    git(worktree, 'reset', '-q', '--hard', waiting.baseCommit as string);
    h.master.engine.approve(run.id);
    const blocked = await h.waitStatus(run.id, 'blocked');
    expect(blocked.blocked?.kind).toBe('workspace');
    expect(blocked.blocked?.message).toMatch(/不一致/);
    await h.master.engine.retry(run.id);
    const done = await h.waitStatus(run.id, 'completed');
    expect(done.headCommit).toBe(waiting.baseCommit);
  });

  it('a retry does nothing when the Run is cancelled while it restores the worktree', async () => {
    h = await harness();
    const { engine, store } = h.master;
    const run = h.run();
    const waiting = await h.waitStatus(run.id, 'waiting_approval');
    rmSync(waiting.worktreePath as string, { recursive: true, force: true });
    engine.approve(run.id);
    await h.waitStatus(run.id, 'blocked');
    const calls = h.fake.calls.length;
    const attempts = store.listRunAttempts(run.id).length;

    const p = engine.retry(run.id);
    await engine.cancel(run.id);
    await expect(p).rejects.toBeInstanceOf(InvalidStateError);
    await expect(p).rejects.toThrow(/状态已经变了（现在是 cancelled）/);

    const after = store.getRun(run.id);
    expect(after.status).toBe('cancelled');
    expect(after.queuePos).toBeNull();
    const events = store.listEvents(run.id);
    expect(events.map((e) => e.type)).not.toContain('run.retry');
    // Nothing happened to the Run after it was cancelled.
    expect(events.at(-1)?.type).toBe('run.status');
    expect(events.at(-1)?.data.status).toBe('cancelled');
    expect(h.fake.calls.length).toBe(calls);
    expect(store.listRunAttempts(run.id).length).toBe(attempts);
  });

  it('only one of two concurrent retries of the same Run takes effect', async () => {
    h = await harness();
    const { engine, store } = h.master;
    const run = h.run();
    const waiting = await h.waitStatus(run.id, 'waiting_approval');
    git(waiting.worktreePath as string, 'reset', '-q', '--hard', waiting.baseCommit as string);
    engine.approve(run.id);
    await h.waitStatus(run.id, 'blocked');

    const results = await Promise.allSettled([engine.retry(run.id), engine.retry(run.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(InvalidStateError);
    expect(String(rejected[0]?.reason)).toMatch(/这次重试没有生效/);

    await h.waitStatus(run.id, 'completed');
    const retries = store.listEvents(run.id).filter((e) => e.type === 'run.retry');
    expect(retries).toHaveLength(1);
  });

  it('checks commits added by hand before merging them', async () => {
    h = await harness();
    const run = h.run();
    const waiting = await h.waitStatus(run.id, 'waiting_approval');
    const worktree = waiting.worktreePath as string;
    writeFile(join(worktree, 'extra.txt'), 'by hand\n');
    git(worktree, 'add', '-A');
    git(
      worktree,
      '-c',
      'user.email=me@example.com',
      '-c',
      'user.name=Me',
      'commit',
      '-q',
      '-m',
      'by hand',
    );
    h.master.engine.approve(run.id);
    await h.waitStatus(run.id, 'completed');
    const store = h.master.store;
    const mergeStage = store.listStageRuns(run.id).find((sr) => sr.stageId === 'merge');
    const checks = store.listChecks(run.id).filter((c) => c.stageRunId === mergeStage?.id);
    expect(checks.filter((c) => c.kind === 'command').map((c) => c.passed)).toEqual([true]);
    expect(git(h.repoDir, 'show', 'main:extra.txt')).toBe('by hand');
  });
});
