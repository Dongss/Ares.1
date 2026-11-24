import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeAdapter, type FakeContext, type FakeOutcome } from '../src/adapters/fake.js';
import { AGENT_GH_TOKEN } from '../src/adapters/process.js';
import type { AgentAdapter } from '../src/adapters/types.js';
import {
  backoffMs,
  RATE_LIMIT_WAIT,
  REDO_BACKOFF_MAX_HOURS,
  rateLimitDelayMs,
} from '../src/config/flow.js';
import { PLAN_REPORT_JSON_SCHEMA } from '../src/engine/contracts.js';
import { AGENT_RETRY_BACKOFF, InvalidStateError } from '../src/engine/engine.js';
import { LABELS, RETRIES_EXHAUSTED_MARKER } from '../src/github/issues.js';
import { runDigest } from '../src/github/scout.js';
import { setLang } from '../src/i18n.js';
import { noticeFor } from '../src/notify/notice.js';
import { NotFoundError } from '../src/store/store.js';
import type { Run, StageRun, Task } from '../src/store/types.js';
import {
  ASSESS_AGENTS_YAML,
  ASSESS_WORKFLOW_YAML,
  assessment,
  blockOnAgentError,
  done,
  FakeGitHub,
  git,
  type Harness,
  harness,
  initRepo,
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

  it('tells a second review in a row the same verify commands passed', async () => {
    h = await harness({
      workflow: TEST_WORKFLOW_YAML.replace(
        '  - id: merge\n',
        '  - id: review2\n    name: 复审\n    kind: review\n    agent: reviewer\n    on_fail: implement\n  - id: merge\n',
      ),
    });
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');
    // The first review's task passed on the same commit, without commands of its own.
    const prompts = h.fake.calls.filter((c) => c.model === 'reviewer').map((c) => c.prompt);
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt).toContain('## 已通过的检查');
      expect(prompt).toContain('`grep -q ok feature.txt`');
    }
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

  it('leaves the home directory out of the commit message, which may be pushed', async () => {
    h = await harness();
    const file = join(homedir(), '.ares1', 'worktrees', 'run-x', 'feature.txt');
    h.scripts.coder = (ctx) => {
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return done(`写了 ${file}`);
    };
    const run = h.run(`改 ${file}`);
    const waiting = await h.waitStatus(run.id, 'waiting_approval');
    const message = git(waiting.worktreePath as string, 'log', '-1', '--format=%B');
    expect(message).toContain('改 ~/.ares1/worktrees/run-x/feature.txt');
    expect(message).toContain('写了 ~/.ares1/worktrees/run-x/feature.txt');
    expect(message).not.toContain(homedir());
    // The Run itself keeps the goal as it was given.
    expect(waiting.goal).toBe(`改 ${file}`);
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

  /** A Run blocked because main, checked out in the repo, has an uncommitted edit. */
  async function blockOnDirtyTarget(target: Harness): Promise<Run> {
    const run = target.run();
    await target.waitStatus(run.id, 'waiting_approval');
    writeFile(join(target.repoDir, 'README.md'), '# local edit\n');
    target.master.engine.approve(run.id);
    const blocked = await target.waitStatus(run.id, 'blocked');
    expect(blocked.blocked?.kind).toBe('target_dirty');
    await waitFor(() => target.master.engine.activeRunIds.length === 0, 'the Run to stop');
    return blocked;
  }

  it('goes on merging by itself once the changes on the target branch are gone', async () => {
    const sent: string[] = [];
    h = await harness({
      config: 'notify:\n  system: true\n',
      master: { notice: (title) => sent.push(title) },
    });
    const { store, engine } = h.master;
    const run = await blockOnDirtyTarget(h);
    expect(run.blocked?.message).toContain('README.md');
    expect(run.blocked?.message).toContain('提交或丢弃这些改动后，Run 会自动继续合并，不用重试');
    expect(sent.at(-1)).toContain('Run 卡住了');

    // The changes are still there: nothing changes, and nobody is notified again.
    const events = store.listEvents(run.id).length;
    const notices = sent.length;
    expect(await engine.checkDirtyTargets()).toEqual([]);
    expect(store.getRun(run.id)).toMatchObject({
      status: 'blocked',
      blocked: { kind: 'target_dirty' },
    });
    expect(store.listEvents(run.id)).toHaveLength(events);
    expect(sent).toHaveLength(notices);

    // Committed: main moved, so the merge stage syncs and checks again before it fast-forwards.
    git(h.repoDir, 'commit', '-q', '-am', 'local edit');
    expect(await engine.checkDirtyTargets()).toEqual([run.id]);
    await h.waitStatus(run.id, 'completed');
    expect(readFileSync(join(h.repoDir, 'README.md'), 'utf8')).toBe('# local edit\n');
    expect(readFileSync(join(h.repoDir, 'feature.txt'), 'utf8')).toBe('ok\n');
    const after = store.listEvents(run.id);
    expect(after.find((e) => e.type === 'merge.target_clean')?.data).toEqual({ target: 'main' });
    expect(after.some((e) => e.type === 'merge.synced')).toBe(true);
    expect(after.filter((e) => e.type === 'run.blocked')).toHaveLength(1);
    expect(after.some((e) => e.type === 'run.retry')).toBe(false);
    // Nothing is left to check.
    expect(await engine.checkDirtyTargets()).toEqual([]);
  });

  it('checks the target branch again by itself while a Run waits for it', async () => {
    h = await harness({ master: { dirtyTargetCheckMs: 20 } });
    const { store } = h.master;
    const run = await blockOnDirtyTarget(h);
    // Several checks find the changes still there and leave the Run as it is.
    const events = store.listEvents(run.id).length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(store.getRun(run.id).status).toBe('blocked');
    expect(store.listEvents(run.id)).toHaveLength(events);

    // Discarded: the next check moves it on, with no call from anyone.
    git(h.repoDir, 'checkout', '--', 'README.md');
    await h.waitStatus(run.id, 'completed');
    expect(existsSync(join(h.repoDir, 'feature.txt'))).toBe(true);
  });

  it('does not go on by itself while the work switch is off; switching it on checks again', async () => {
    h = await harness();
    const { store, engine } = h.master;
    const run = await blockOnDirtyTarget(h);
    git(h.repoDir, 'checkout', '--', 'README.md');

    engine.setWorking(false);
    expect(await engine.checkDirtyTargets()).toEqual([]);
    expect(store.getRun(run.id).status).toBe('blocked');
    expect(store.listEvents(run.id).some((e) => e.type === 'merge.target_clean')).toBe(false);

    engine.setWorking(true);
    await h.waitStatus(run.id, 'completed');
    expect(store.listEvents(run.id).some((e) => e.type === 'merge.target_clean')).toBe(true);
  });

  it('goes on at start when the changes were cleared while the Master was stopped', async () => {
    const first = await harness();
    const run = await blockOnDirtyTarget(first);
    await first.close();
    git(first.repoDir, 'checkout', '--', 'README.md');

    h = await harness({ home: first.home, repoDir: first.repoDir });
    await h.waitStatus(run.id, 'completed');
    expect(existsSync(join(h.repoDir, 'feature.txt'))).toBe(true);
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

  it('ends the Run as failed when setup commands fail, keeping the workspace', async () => {
    h = await harness({ setupCommands: ['echo 依赖装不上 && false'] });
    const run = h.run();
    const failed = await h.waitStatus(run.id, 'failed');
    expect(failed.blocked).toBeNull();
    expect(failed.finishedAt).toBeTruthy();
    expect(failed.error).toBe(
      '准备命令 `echo 依赖装不上 && false` 失败（退出码 1）。输出末尾：\n```\n依赖装不上\n\n```\nRun 结束，工作目录和分支已保留。',
    );
    expect(h.master.store.listEvents(run.id).map((e) => e.type)).not.toContain('run.blocked');
    expect(h.fake.calls).toEqual([]);
    // The workspace is kept and on record, like any failed Run's.
    const base = git(h.repoDir, 'rev-parse', 'main');
    expect(failed).toMatchObject({ baseCommit: base, headCommit: base });
    expect(existsSync(failed.worktreePath as string)).toBe(true);
    expect(git(h.repoDir, 'branch', '--list', failed.branch as string)).not.toBe('');
    // Nothing waits for a human: the next Run starts.
    await expect(h.master.engine.retry(run.id)).rejects.toThrow(/blocked/);
    h.master.store.updateRepo(h.repo.id, { setupCommands: [] });
    await h.waitStatus(h.run('下一个').id, 'waiting_approval');
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

/** TEST_WORKFLOW_YAML with an E2E command stage (`e2e`, lines of YAML) between review and merge. */
const withCommandStage = (e2e: string) =>
  TEST_WORKFLOW_YAML.replace(
    '  - id: merge\n',
    `  - id: e2e\n    name: E2E\n    kind: command\n${e2e}  - id: merge\n`,
  );

/**
 * Coding → docs (another agent stage) → E2E commands going back to coding → merge without
 * approval, with one rollback allowed.
 */
const commandOnFail = (e2eCommand: string, defaults = '') => `
id: dev
name: 测试流程
defaults:
  escalate:
    max_retries: 2
    on_agent_error: switch_agent
${defaults}  max_loops: 1
stages:
  - id: implement
    name: 编码
    kind: agent
    agent: coder
  - id: docs
    name: 文档
    kind: agent
    agent: coder2
  - id: e2e
    name: E2E
    kind: command
    on_fail: implement
    verify:
      commands: [${JSON.stringify(e2eCommand)}]
  - id: merge
    name: 合并
    kind: merge
`;

describe('engine: command stages', () => {
  const store = () => (h as Harness).master.store;
  const stagesOf = (runId: string) =>
    store()
      .listStageRuns(runId)
      .map((sr) => [sr.stageId, sr.status]);
  const stageRun = (runId: string, stageId: string, round = 1) =>
    store()
      .listStageRuns(runId)
      .find((sr) => sr.stageId === stageId && sr.round === round);
  const checksOf = (runId: string, stageId: string, round = 1) => {
    const id = stageRun(runId, stageId, round)?.id;
    return store()
      .listChecks(runId)
      .filter((c) => c.stageRunId === id);
  };
  const eventTypes = (runId: string) =>
    store()
      .listEvents(runId)
      .map((e) => e.type);

  it('runs its commands without an agent and without GitHub credentials, then goes on', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_master');
    const out = tmpDir('ares1-command-');
    h = await harness({
      workflow: withCommandStage(
        `    verify:\n      commands: [${JSON.stringify(`env > ${out}/e2e.env`)}, "grep -q ok feature.txt && echo e2e-ok && echo report > e2e-report.txt"]\n`,
      ),
    });
    const run = h.run();
    const waiting = await h.waitStatus(run.id, 'waiting_approval');
    expect(stagesOf(run.id)).toEqual([
      ['implement', 'passed'],
      ['review', 'passed'],
      ['e2e', 'passed'],
      ['merge', 'waiting_approval'],
    ]);
    // Only the coder and the reviewer ran; the command stage has no task.
    expect(h.fake.calls.map((c) => c.model)).toEqual(['coder', 'reviewer']);
    const e2e = stageRun(run.id, 'e2e');
    expect(store().listTasks(e2e?.id as string)).toEqual([]);
    const checks = checksOf(run.id, 'e2e');
    expect(checks.map((c) => [c.kind, c.name, c.passed, c.attemptId])).toEqual([
      ['command', `env > ${out}/e2e.env`, true, null],
      [
        'command',
        'grep -q ok feature.txt && echo e2e-ok && echo report > e2e-report.txt',
        true,
        null,
      ],
    ]);
    expect(checks[1]?.detail).toContain('e2e-ok');
    const log = join(h.master.paths.logsDir, run.id, `command-${e2e?.id}.log`);
    expect(readFileSync(log, 'utf8')).toContain('e2e-ok');
    // No GitHub credentials, like the verify commands.
    const env = readEnvFile(join(out, 'e2e.env'));
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBe(AGENT_GH_TOKEN);
    expect(env.GH_CONFIG_DIR).toBe(h.master.paths.agentGhConfigDir);
    // Nothing is committed, and what the commands left behind is not part of the work.
    const worktree = waiting.worktreePath as string;
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(waiting.headCommit);
    expect(existsSync(join(worktree, 'e2e-report.txt'))).toBe(false);
    expect(git(worktree, 'status', '--porcelain')).toBe('');
    expect(eventTypes(run.id)).toContain('command.discarded_changes');

    h.master.engine.approve(run.id);
    await h.waitStatus(run.id, 'completed');
    expect(git(h.repoDir, 'show', 'main:feature.txt')).toBe('ok');
    expect(git(h.repoDir, 'ls-tree', '--name-only', 'main')).not.toContain('e2e-report.txt');
  });

  it('drops commits the commands made; whether the stage passes is up to their exit codes', async () => {
    // Fails until the coder writes "fixed", committing a report either way.
    const command =
      'grep -q fixed feature.txt; s=$?; echo report > cmd.txt && git add -A && git -c user.name=cmd -c user.email=cmd@example.com commit -q -m cmd && exit $s';
    h = await harness({
      workflow: withCommandStage(`    verify:\n      commands: [${JSON.stringify(command)}]\n`),
    });
    let round = 0;
    const sawReport: boolean[] = [];
    h.scripts.coder = (ctx) => {
      round++;
      sawReport.push(existsSync(join(ctx.input.workdir, 'cmd.txt')));
      writeFile(join(ctx.input.workdir, 'feature.txt'), round === 1 ? 'ok\n' : 'ok fixed\n');
      return done();
    };
    const run = h.run();
    const waiting = await h.waitStatus(run.id, 'waiting_approval');
    expect(stagesOf(run.id)).toEqual([
      ['implement', 'passed'],
      ['review', 'passed'],
      ['e2e', 'failed'],
      ['implement', 'passed'],
      ['review', 'passed'],
      ['e2e', 'passed'],
      ['merge', 'waiting_approval'],
    ]);
    // The coder went on from its own commit, without the commands' one.
    expect(sawReport).toEqual([false, false]);
    const worktree = waiting.worktreePath as string;
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(waiting.headCommit);
    expect(git(worktree, 'symbolic-ref', '--short', 'HEAD')).toBe(waiting.branch);
    expect(existsSync(join(worktree, 'cmd.txt'))).toBe(false);

    const discarded = store()
      .listEvents(run.id)
      .filter((e) => e.type === 'command.discarded_changes')
      .map((e) => e.data);
    expect(discarded).toHaveLength(2);
    // The second time, on the coder's second commit, which is the one merged.
    expect(discarded[1]?.fromHead).toBe(waiting.headCommit);
    for (const data of discarded) {
      const commits = data.discardedCommits as string[];
      expect(commits).toHaveLength(1);
      expect(data).toEqual({
        stageId: 'e2e',
        fromHead: expect.any(String),
        toHead: commits[0],
        discardedCommits: commits,
        uncommitted: false,
      });
      expect(git(h.repoDir, 'log', '-1', '--format=%s', commits[0] as string)).toBe('cmd');
      expect(git(h.repoDir, 'rev-parse', `${commits[0]}^`)).toBe(data.fromHead);
    }

    h.master.engine.approve(run.id);
    await h.waitStatus(run.id, 'completed');
    expect(git(h.repoDir, 'show', 'main:feature.txt')).toBe('ok fixed');
    expect(git(h.repoDir, 'ls-tree', '--name-only', 'main')).not.toContain('cmd.txt');
    const merged = git(h.repoDir, 'log', '--format=%H', 'main').split('\n');
    for (const data of discarded) {
      expect(merged).not.toContain((data.discardedCommits as string[])[0]);
    }
  });

  it("runs the repo's verify commands when it names none, and passes when there are none", async () => {
    h = await harness({
      workflow: withCommandStage(''),
      verifyCommands: ['grep -q ok feature.txt'],
    });
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');
    expect(checksOf(run.id, 'e2e').map((c) => [c.name, c.passed])).toEqual([
      ['grep -q ok feature.txt', true],
    ]);
    expect(eventTypes(run.id)).not.toContain('stage.no_commands');

    store().updateRepo(h.repo.id, { verifyCommands: [] });
    const bare = h.run('下一个');
    await h.waitStatus(bare.id, 'waiting_approval');
    expect(stageRun(bare.id, 'e2e')?.status).toBe('passed');
    expect(checksOf(bare.id, 'e2e')).toEqual([]);
    expect(eventTypes(bare.id)).toContain('stage.no_commands');
  });

  it('goes back to the nearest agent stage with the failed command and its output', async () => {
    h = await harness({
      workflow: withCommandStage(
        '    verify:\n      commands: ["echo E2E 挂了：找不到按钮 && grep -q fixed feature.txt"]\n',
      ),
    });
    let round = 0;
    h.scripts.coder = (ctx) => {
      round++;
      writeFile(join(ctx.input.workdir, 'feature.txt'), round === 1 ? 'ok\n' : 'ok fixed\n');
      return done();
    };
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');
    expect(stagesOf(run.id)).toEqual([
      ['implement', 'passed'],
      ['review', 'passed'],
      ['e2e', 'failed'],
      ['implement', 'passed'],
      ['review', 'passed'],
      ['e2e', 'passed'],
      ['merge', 'waiting_approval'],
    ]);
    const failed = stageRun(run.id, 'e2e', 1);
    expect(failed?.failReason).toBe('check');
    expect(failed?.failFeedback).toBe(
      '检查命令 `echo E2E 挂了：找不到按钮 && grep -q fixed feature.txt` 未通过（退出码 1）。输出末尾：\n```\nE2E 挂了：找不到按钮\n\n```',
    );
    expect(checksOf(run.id, 'e2e', 1).map((c) => c.passed)).toEqual([false]);
    const rollback = store()
      .listEvents(run.id)
      .find((e) => e.type === 'stage.rollback');
    expect(rollback?.data).toEqual({ from: 'e2e', to: 'implement' });
    // No agent ran for the command stage; the coder got the failure as feedback.
    expect(h.fake.calls.map((c) => c.model)).toEqual(['coder', 'reviewer', 'coder', 'reviewer']);
    const prompt = h.fake.calls[2]?.prompt ?? '';
    expect(prompt).toContain('「E2E」没有通过');
    expect(prompt).toContain(
      '检查命令 `echo E2E 挂了：找不到按钮 && grep -q fixed feature.txt` 未通过',
    );
    expect(prompt).toContain('E2E 挂了：找不到按钮');
  });

  it('goes back to on_fail, and ends the Run once past max_loops (on_exhausted: fail)', async () => {
    h = await harness({ workflow: commandOnFail('echo 页面打不开 && false') });
    const run = h.run();
    const failed = await h.waitStatus(run.id, 'failed');
    // on_fail skips the nearer agent stage (docs): back to implement.
    const rollbacks = store()
      .listEvents(run.id)
      .filter((e) => e.type === 'stage.rollback')
      .map((e) => e.data);
    expect(rollbacks).toEqual([{ from: 'e2e', to: 'implement' }]);
    expect(stagesOf(run.id)).toEqual([
      ['implement', 'passed'],
      ['docs', 'passed'],
      ['e2e', 'failed'],
      ['implement', 'passed'],
      ['docs', 'passed'],
      ['e2e', 'failed'],
    ]);
    const coder = h.fake.calls.filter((c) => c.model === 'coder');
    expect(coder).toHaveLength(2);
    expect(coder[1]?.prompt).toContain('「E2E」没有通过');
    expect(coder[1]?.prompt).toContain('页面打不开');
    expect(failed.blocked).toBeNull();
    expect(failed.error).toContain(
      '阶段「编码」已执行 2 轮，超过回退上限 1，Run 结束（on_exhausted: fail），工作目录和分支已保留。最后一次「E2E」没有通过：\n检查命令 `echo 页面打不开 && false` 未通过（退出码 1）',
    );
    expect(failed.error).toContain('页面打不开');
    expect(eventTypes(run.id)).not.toContain('run.blocked');
  });

  it('with on_exhausted: human, waits at max_loops; a retry grants one more round', async () => {
    const marker = join(tmpDir('ares1-e2e-'), 'fixed');
    h = await harness({
      workflow: commandOnFail(`test -f ${marker}`, '    on_exhausted: human\n'),
    });
    const run = h.run();
    const blocked = await h.waitStatus(run.id, 'blocked');
    expect(blocked.blocked?.kind).toBe('max_loops');
    expect(blocked.blocked?.message).toContain('阶段 implement 已执行 2 轮，超过回退上限 1');
    expect(blocked.blocked?.message).toContain(`检查命令 \`test -f ${marker}\` 未通过`);

    writeFile(marker, '1\n');
    await h.master.engine.retry(run.id);
    await h.waitStatus(run.id, 'completed');
    expect(store().countStageRounds(run.id, 'implement')).toBe(3);
    expect(stageRun(run.id, 'e2e', 3)?.status).toBe('passed');
  });

  it('with a gate, waits for an approval once the commands pass; a rejection goes back', async () => {
    h = await harness({
      workflow: withCommandStage(
        '    gate: true\n    verify:\n      commands: ["grep -q ok feature.txt"]\n',
      ),
    });
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');
    const current = () => store().getStageRun(store().getRun(run.id).currentStageRunId as string);
    expect(current().stageId).toBe('e2e');
    expect(current().status).toBe('waiting_approval');
    // The commands ran before the approval.
    expect(checksOf(run.id, 'e2e').map((c) => c.passed)).toEqual([true]);
    expect(store().latestApproval(current().id)?.status).toBe('pending');

    // A rejection goes back to the nearest agent stage with the comment.
    h.master.engine.reject(run.id, 'E2E 截图里按钮颜色不对');
    await waitFor(
      () =>
        current().stageId === 'e2e' &&
        current().round === 2 &&
        current().status === 'waiting_approval',
      'second e2e approval',
    );
    expect(store().countStageRounds(run.id, 'implement')).toBe(2);
    const coder = h.fake.calls.filter((c) => c.model === 'coder');
    expect(coder[1]?.prompt).toContain('E2E 截图里按钮颜色不对');

    h.master.engine.approve(run.id);
    await waitFor(
      () => current().stageId === 'merge' && current().status === 'waiting_approval',
      'merge approval',
    );
    expect(stageRun(run.id, 'e2e', 2)?.status).toBe('passed');
  });

  it('runs its commands again after a restart', async () => {
    const marker = join(tmpDir('ares1-e2e-'), 'may-finish');
    const first = await harness({
      workflow: withCommandStage(
        `    verify:\n      commands: [${JSON.stringify(`test -f ${marker} || sleep 30; echo half > partial.txt; grep -q ok feature.txt`)}]\n`,
      ),
    });
    const run = first.run();
    const e2eExecuting = () => {
      const s = first.master.store;
      const id = s.getRun(run.id).currentStageRunId;
      const sr = id ? s.getStageRun(id) : undefined;
      return sr?.stageId === 'e2e' && sr.status === 'executing';
    };
    await waitFor(e2eExecuting, 'the command stage to start');
    // Stopped in the middle of the commands (a crash goes through the same recovery).
    await first.close();

    writeFile(marker, '1\n');
    h = await harness({ home: first.home, repoDir: first.repoDir });
    const waiting = await h.waitStatus(run.id, 'waiting_approval');
    expect(stagesOf(run.id)).toEqual([
      ['implement', 'passed'],
      ['review', 'passed'],
      ['e2e', 'passed'],
      ['merge', 'waiting_approval'],
    ]);
    expect(checksOf(run.id, 'e2e').map((c) => c.passed)).toEqual([true]);
    expect(existsSync(join(waiting.worktreePath as string, 'partial.txt'))).toBe(false);
    expect(h.fake.calls).toEqual([]);
  });
});

describe('engine: a reviewer does not change the work', () => {
  const store = () => (h as Harness).master.store;
  const discardedOf = (runId: string) =>
    store()
      .listEvents(runId)
      .filter((e) => e.type === 'review.changes_discarded')
      .map((e) => e.data);
  const reviewAttempt = (runId: string) =>
    store()
      .listRunAttempts(runId)
      .find((a) => a.agentId === 'reviewer')?.id;
  /** The worktree is on the Run's branch at the commit the coder made, with nothing else. */
  const expectCoderWork = (waiting: Run) => {
    const worktree = waiting.worktreePath as string;
    expect(git(worktree, 'symbolic-ref', '--short', 'HEAD')).toBe(waiting.branch);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(waiting.headCommit);
    expect(git(worktree, 'log', '--format=%s', `${waiting.baseCommit}..HEAD`)).toBe(
      '编码: 添加 feature.txt',
    );
    expect(git(worktree, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(worktree, 'feature.txt'), 'utf8')).toBe('ok\n');
  };
  const approveAndMerge = async (runId: string) => {
    h?.master.engine.approve(runId);
    await h?.waitStatus(runId, 'completed');
    const repoDir = (h as Harness).repoDir;
    expect(git(repoDir, 'show', 'main:feature.txt')).toBe('ok');
    expect(git(repoDir, 'ls-tree', '--name-only', 'main').split('\n')).toEqual([
      'README.md',
      'feature.txt',
    ]);
    return git(repoDir, 'log', '--format=%H', 'main').split('\n');
  };

  it('drops a commit the reviewer made, which is then not merged', async () => {
    h = await harness();
    let commit = '';
    h.scripts.reviewer = (ctx) => {
      const wd = ctx.input.workdir;
      writeFile(join(wd, 'feature.txt'), 'changed by the reviewer\n');
      writeFile(join(wd, 'reviewer.txt'), 'unreviewed\n');
      git(wd, 'add', '-A');
      git(wd, 'commit', '-q', '-m', 'reviewer');
      commit = git(wd, 'rev-parse', 'HEAD');
      return review();
    };
    const run = h.run();
    const waiting = await h.waitStatus(run.id, 'waiting_approval');
    expectCoderWork(waiting);
    expect(discardedOf(run.id)).toEqual([
      {
        attemptId: reviewAttempt(run.id),
        fromHead: waiting.headCommit,
        toHead: commit,
        discardedCommits: [commit],
        uncommitted: false,
      },
    ]);
    expect(await approveAndMerge(run.id)).not.toContain(commit);
  });

  it('drops what the reviewer left uncommitted', async () => {
    h = await harness();
    h.scripts.reviewer = (ctx) => {
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'changed by the reviewer\n');
      writeFile(join(ctx.input.workdir, 'reviewer.txt'), 'unreviewed\n');
      return review();
    };
    const run = h.run();
    const waiting = await h.waitStatus(run.id, 'waiting_approval');
    expectCoderWork(waiting);
    expect(discardedOf(run.id)).toEqual([
      {
        attemptId: reviewAttempt(run.id),
        fromHead: waiting.headCommit,
        toHead: waiting.headCommit,
        discardedCommits: [],
        uncommitted: true,
      },
    ]);
    await approveAndMerge(run.id);
  });

  it("switches back to the Run's branch when the reviewer checked out another one", async () => {
    h = await harness();
    let onRunBranch = '';
    let onOtherBranch = '';
    h.scripts.reviewer = (ctx) => {
      const wd = ctx.input.workdir;
      writeFile(join(wd, 'reviewer.txt'), 'unreviewed\n');
      git(wd, 'add', '-A');
      git(wd, 'commit', '-q', '-m', 'reviewer on the Run branch');
      onRunBranch = git(wd, 'rev-parse', 'HEAD');
      git(wd, 'checkout', '-q', '-b', 'reviewer-branch');
      writeFile(join(wd, 'other.txt'), 'elsewhere\n');
      git(wd, 'add', '-A');
      git(wd, 'commit', '-q', '-m', 'reviewer on another branch');
      onOtherBranch = git(wd, 'rev-parse', 'HEAD');
      writeFile(join(wd, 'left.txt'), 'uncommitted\n');
      return review();
    };
    const run = h.run();
    const waiting = await h.waitStatus(run.id, 'waiting_approval');
    expectCoderWork(waiting);
    expect(discardedOf(run.id)).toEqual([
      {
        attemptId: reviewAttempt(run.id),
        fromHead: waiting.headCommit,
        toHead: onRunBranch,
        discardedCommits: [onRunBranch],
        uncommitted: true,
        checkedOut: 'reviewer-branch',
      },
    ]);
    // What the reviewer committed on its own branch stays there, never merged.
    expect(git(h.repoDir, 'rev-parse', 'reviewer-branch')).toBe(onOtherBranch);
    const merged = await approveAndMerge(run.id);
    expect(merged).not.toContain(onRunBranch);
    expect(merged).not.toContain(onOtherBranch);
  });

  it('goes back to the Run branch from a detached HEAD, also when the review failed', async () => {
    h = await harness();
    let calls = 0;
    h.scripts.reviewer = (ctx) => {
      calls++;
      if (calls > 1) return review();
      const wd = ctx.input.workdir;
      writeFile(join(wd, 'reviewer.txt'), 'unreviewed\n');
      git(wd, 'add', '-A');
      git(wd, 'commit', '-q', '-m', 'reviewer');
      git(wd, 'checkout', '-q', '--detach', 'HEAD~1');
      return { status: 'failed', error: 'crashed' };
    };
    const run = h.run();
    const waiting = await h.waitStatus(run.id, 'waiting_approval');
    expectCoderWork(waiting);
    const discarded = discardedOf(run.id);
    expect(discarded).toHaveLength(1);
    expect(discarded[0]).toMatchObject({
      fromHead: waiting.headCommit,
      uncommitted: false,
      checkedOut: null,
    });
    expect(discarded[0]?.discardedCommits).toEqual([discarded[0]?.toHead]);
    expect(calls).toBe(2);
    await approveAndMerge(run.id);
  });

  describe('stopped in the middle of the review', () => {
    /** What the first reviewer committed on the Run's branch. */
    let committed = '';
    /**
     * The first reviewer commits on the Run's branch, then works on until it is stopped (or for
     * good, when its Master "crashes"); a later one passes, recording the commit it reviewed.
     */
    const reviewers = (h1: Harness) => {
      committed = '';
      const reviewed: string[] = [];
      h1.scripts.reviewer = async (ctx) => {
        const wd = ctx.input.workdir;
        writeFile(join(wd, 'feature.txt'), 'changed by the reviewer\n');
        writeFile(join(wd, 'reviewer.txt'), 'unreviewed\n');
        git(wd, 'add', '-A');
        git(wd, 'commit', '-q', '-m', 'reviewer');
        committed = git(wd, 'rev-parse', 'HEAD');
        await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
        return review();
      };
      return {
        reviewed,
        /** Installs the later reviewer on the Master that goes on with the Run. */
        next: (h2: Harness) => {
          h2.scripts.reviewer = (ctx) => {
            reviewed.push(git(ctx.input.workdir, 'rev-parse', 'HEAD'));
            return review();
          };
        },
      };
    };
    /** Starts a Run and waits until its reviewer has committed; returns the coder's commit. */
    const startReview = async (h1: Harness) => {
      const run = h1.run();
      await waitFor(() => committed !== '', 'the reviewer to commit');
      return { run, coded: h1.master.store.getRun(run.id).headCommit as string };
    };
    /** The review went back to the coder's commit, dropping the reviewer's. */
    const expectDropped = (runId: string, coded: string, extra: object = {}) => {
      expect(discardedOf(runId)).toEqual([
        {
          attemptId: reviewAttempt(runId),
          fromHead: coded,
          toHead: committed,
          discardedCommits: [committed],
          uncommitted: false,
          ...extra,
        },
      ]);
    };
    /**
     * The first reviewer, after its commit on the Run's branch, also checks out another branch
     * and commits there. Returns that commit, once made.
     */
    const switchesBranch = (h1: Harness, opts: { uncommitted?: boolean } = {}) => {
      const reviewer = h1.scripts.reviewer as Script;
      let commit = '';
      h1.scripts.reviewer = (ctx) => {
        const working = reviewer(ctx);
        const wd = ctx.input.workdir;
        git(wd, 'checkout', '-q', '-b', 'reviewer-branch');
        writeFile(join(wd, 'other.txt'), 'elsewhere\n');
        git(wd, 'add', '-A');
        git(wd, 'commit', '-q', '-m', 'reviewer on another branch');
        commit = git(wd, 'rev-parse', 'HEAD');
        if (opts.uncommitted) writeFile(join(wd, 'left.txt'), 'uncommitted\n');
        return working;
      };
      return () => commit;
    };
    /**
     * A git lock left in the worktree, as by a git process that died: nothing can be checked out
     * there until it goes. Returns its path.
     */
    const lockWorktree = (worktree: string) => {
      const lock = join(git(worktree, 'rev-parse', '--absolute-git-dir'), 'index.lock');
      writeFile(lock, '');
      return lock;
    };
    const deferredOf = (runId: string) =>
      store()
        .listEvents(runId)
        .filter((e) => e.type === 'review.discard_deferred')
        .map((e) => e.data);
    const reviewTask = (runId: string) =>
      store()
        .listRunAttempts(runId)
        .find((a) => a.agentId === 'reviewer')?.taskId;

    it('drops the commit the reviewer made when the Master restarts', async () => {
      const first = await harness();
      const { reviewed, next } = reviewers(first);
      const { run, coded } = await startReview(first);
      // An upgrade restarts the Master like this.
      await first.close();

      h = await harness({ home: first.home, repoDir: first.repoDir });
      next(h);
      expectDropped(run.id, coded);
      const waiting = await h.waitStatus(run.id, 'waiting_approval');
      expect(waiting.headCommit).toBe(coded);
      expectCoderWork(waiting);
      // The review done again saw the coder's work only.
      expect(reviewed).toEqual([coded]);
      expect(await approveAndMerge(run.id)).not.toContain(committed);
    });

    it('drops it after a crash, also when the reviewer checked out another branch', async () => {
      const first = await harness();
      const { reviewed, next } = reviewers(first);
      const otherCommit = switchesBranch(first, { uncommitted: true });
      const { run, coded } = await startReview(first);
      await waitFor(() => otherCommit() !== '', 'the reviewer to switch branches');
      const onOtherBranch = otherCommit();
      // A crash: the database still says "running" when the next Master opens it.
      expect(first.master.store.getRun(run.id).status).toBe('running');

      h = await harness({ home: first.home, repoDir: first.repoDir });
      next(h);
      expectDropped(run.id, coded, { uncommitted: true, checkedOut: 'reviewer-branch' });
      const waiting = await h.waitStatus(run.id, 'waiting_approval');
      expectCoderWork(waiting);
      expect(reviewed).toEqual([coded]);
      expect(git(h.repoDir, 'rev-parse', 'reviewer-branch')).toBe(onOtherBranch);
      expect(deferredOf(run.id)).toEqual([]);
      const merged = await approveAndMerge(run.id);
      expect(merged).not.toContain(committed);
      expect(merged).not.toContain(onOtherBranch);
      // The "crashed" first Master is left as is; its hanging fake reviewer never resolves.
    });

    it('puts it back before checking the worktree when that failed as the Master stopped', async () => {
      const first = await harness();
      const { reviewed, next } = reviewers(first);
      const otherCommit = switchesBranch(first);
      const { run, coded } = await startReview(first);
      await waitFor(() => otherCommit() !== '', 'the reviewer to switch branches');
      const onOtherBranch = otherCommit();
      const worktree = first.master.store.getRun(run.id).worktreePath as string;
      const lock = lockWorktree(worktree);
      // An upgrade stops the Master; switching back to the Run's branch fails meanwhile.
      await first.close();
      expect(git(worktree, 'symbolic-ref', '--short', 'HEAD')).toBe('reviewer-branch');
      rmSync(lock);

      h = await harness({ home: first.home, repoDir: first.repoDir });
      next(h);
      const waiting = await h.waitStatus(run.id, 'waiting_approval');
      expect(waiting.error).toBeNull();
      // The failure was recorded, and the Run put the worktree back before checking it, instead
      // of failing because it was not on the Run's branch.
      const deferred = deferredOf(run.id);
      expect(deferred).toEqual([
        { taskId: reviewTask(run.id), baseCommit: coded, error: expect.any(String) },
      ]);
      expect(deferred[0]?.error).toContain('index.lock');
      const types = store()
        .listEvents(run.id)
        .map((e) => e.type)
        .filter((type) => type.startsWith('review.'));
      expect(types).toEqual(['review.discard_deferred', 'review.changes_discarded']);
      expectDropped(run.id, coded, { checkedOut: 'reviewer-branch' });
      expectCoderWork(waiting);
      // The review ran again on the coder's work only.
      expect(reviewed).toEqual([coded]);
      expect(git(h.repoDir, 'rev-parse', 'reviewer-branch')).toBe(onOtherBranch);
      const merged = await approveAndMerge(run.id);
      expect(merged).not.toContain(committed);
      expect(merged).not.toContain(onOtherBranch);
    });

    it('ends the Run with the reason when the worktree cannot be put back then either', async () => {
      h = await harness();
      const { reviewed, next } = reviewers(h);
      const otherCommit = switchesBranch(h);
      const { run, coded } = await startReview(h);
      await waitFor(() => otherCommit() !== '', 'the reviewer to switch branches');
      next(h);
      const worktree = store().getRun(run.id).worktreePath as string;
      lockWorktree(worktree);
      const paused = await h.master.engine.pause(run.id);
      expect(paused.status).toBe('paused');
      const [deferred] = deferredOf(run.id);
      expect(deferred).toMatchObject({ taskId: reviewTask(run.id), baseCommit: coded });
      const error = deferred?.error as string;
      expect(error).toContain('index.lock');

      // The lock is still there when the Run goes on.
      h.master.engine.resume(run.id);
      const failed = await h.waitStatus(run.id, 'failed');
      expect(failed.error).toBe(
        `没能把工作目录放回 Run 的分支 ${failed.branch} 上评审开始时的提交：${error}\n` +
          `工作目录当前不在 Run 的分支 ${failed.branch} 上（现在是 reviewer-branch）\n` +
          'Run 结束，工作目录和分支已保留。',
      );
      expect(discardedOf(run.id)).toEqual([]);
      expect(reviewed).toEqual([]);
      expect(git(worktree, 'symbolic-ref', '--short', 'HEAD')).toBe('reviewer-branch');
    });

    it('drops it when the Run is paused, and the review starts again on resume', async () => {
      h = await harness();
      const { reviewed, next } = reviewers(h);
      const { run, coded } = await startReview(h);
      next(h);
      const paused = await h.master.engine.pause(run.id);
      expect(paused.status).toBe('paused');
      // Already while paused, the branch holds the coder's work only.
      const worktree = paused.worktreePath as string;
      expect(git(worktree, 'symbolic-ref', '--short', 'HEAD')).toBe(paused.branch);
      expect(git(worktree, 'rev-parse', 'HEAD')).toBe(coded);
      expect(git(worktree, 'status', '--porcelain')).toBe('');
      expectDropped(run.id, coded);

      h.master.engine.resume(run.id);
      const waiting = await h.waitStatus(run.id, 'waiting_approval');
      expectCoderWork(waiting);
      expect(reviewed).toEqual([coded]);
      expect(await approveAndMerge(run.id)).not.toContain(committed);
    });

    it('drops it before the review runs again when the worktree was gone meanwhile', async () => {
      const first = await harness();
      const { reviewed, next } = reviewers(first);
      const { run, coded } = await startReview(first);
      // A crash, and the worktree deleted before the next Master starts: nothing could be put back
      // then, and the worktree comes back from the branch with the reviewer's commit.
      const worktree = first.master.store.getRun(run.id).worktreePath as string;
      rmSync(worktree, { recursive: true, force: true });

      h = await harness({ home: first.home, repoDir: first.repoDir });
      next(h);
      const waiting = await h.waitStatus(run.id, 'waiting_approval');
      const types = store()
        .listEvents(run.id)
        .map((e) => e.type);
      expect(types.filter((type) => type === 'run.workspace_restored')).toHaveLength(1);
      expect(deferredOf(run.id)).toEqual([
        { taskId: reviewTask(run.id), baseCommit: coded, error: `工作目录 ${worktree} 不存在了` },
      ]);
      expectDropped(run.id, coded);
      expectCoderWork(waiting);
      expect(reviewed).toEqual([coded]);
      expect(await approveAndMerge(run.id)).not.toContain(committed);
    });
  });

  it('keeps the accepted work when a review that committed fails for good', async () => {
    h = await harness({ workflow: WAIT_WHEN_EXHAUSTED });
    const commits: string[] = [];
    h.scripts.reviewer = (ctx) => {
      const wd = ctx.input.workdir;
      writeFile(join(wd, 'reviewer.txt'), `unreviewed ${commits.length}\n`);
      git(wd, 'add', '-A');
      git(wd, 'commit', '-q', '-m', 'reviewer');
      commits.push(git(wd, 'rev-parse', 'HEAD'));
      return { finalMessage: '看起来没问题' };
    };
    const run = h.run();
    const blocked = await h.waitStatus(run.id, 'blocked');
    expect(blocked.blocked?.kind).toBe('task_failed');
    // The first try and both reworks, each dropped; the Run stays on the coder's commit.
    expect(commits).toHaveLength(3);
    expect(discardedOf(run.id).flatMap((d) => d.discardedCommits as string[])).toEqual(commits);
    expectCoderWork(blocked);

    h.scripts.reviewer = () => review();
    await h.master.engine.retry(run.id);
    const waiting = await h.waitStatus(run.id, 'waiting_approval');
    expect(waiting.headCommit).toBe(blocked.headCommit);
    expectCoderWork(waiting);
    const merged = await approveAndMerge(run.id);
    for (const commit of commits) expect(merged).not.toContain(commit);
  });
});

describe('engine: a program missing from the environment', () => {
  const MISSING = 'ares1-no-such-tool';

  /** Puts an executable `name` that succeeds in PATH: the program installed. */
  const install = (name: string) => {
    const bin = tmpDir('ares1-tool-');
    writeFile(join(bin, name), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, name), 0o755);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  };

  it('blocks on the environment instead of reworking, and only checks again once it is found', async () => {
    const sent: string[] = [];
    h = await harness({
      verifyCommands: [`${MISSING} --check`, 'grep -q ok feature.txt'],
      config: 'notify:\n  system: true\n',
      master: { notice: (title) => sent.push(title) },
    });
    const { store, engine } = h.master;
    const run = h.run();
    const blocked = await h.waitStatus(run.id, 'blocked');
    expect(blocked.blocked).toMatchObject({ kind: 'environment', missing: MISSING });
    expect(blocked.blocked?.message).toContain(
      `运行环境里找不到 \`${MISSING}\`：检查命令 \`${MISSING} --check\`的退出码是 127`,
    );
    expect(sent.at(-1)).toBe(`Run 卡住了：运行环境里找不到 ${MISSING}`);
    // No rework: the agent's work waits in the worktree for its checks.
    const [task] = store.listRunTasks(run.id) as [Task];
    expect(task).toMatchObject({ status: 'verifying', retries: 0 });
    expect(store.listAttempts(task.id).map((a) => a.outcome)).toEqual([null]);
    expect(readFileSync(join(blocked.worktreePath as string, 'feature.txt'), 'utf8')).toBe('ok\n');

    // Still missing: nothing changes, and nobody is notified again.
    const events = store.listEvents(run.id).length;
    expect(engine.checkEnvironment()).toEqual([]);
    expect(store.listEvents(run.id)).toHaveLength(events);
    expect(sent.filter((s) => s.includes('卡住'))).toHaveLength(1);

    install(MISSING);
    expect(engine.checkEnvironment()).toEqual([run.id]);
    await h.waitStatus(run.id, 'waiting_approval');
    // Only the checks ran again: one coder execution, which passed, and no rework or retry used.
    expect(h.fake.calls.filter((c) => c.model === 'coder')).toHaveLength(1);
    const after = store.getTask(task.id);
    expect(after).toMatchObject({ status: 'passed', retries: 0 });
    expect(store.listAttempts(task.id).map((a) => a.outcome)).toEqual(['passed']);
    expect(git(blocked.worktreePath as string, 'show', '--stat', 'HEAD')).toContain('feature.txt');
    const types = store.listEvents(run.id).map((e) => e.type);
    expect(types).toContain('environment.resumed');
    expect(types).toContain('task.verify_resumed');
    expect(types).not.toContain('run.retry');
  });

  it('goes on when the Master restarts', async () => {
    const first = await harness({ verifyCommands: [`${MISSING} --check`] });
    const run = first.run();
    await first.waitStatus(run.id, 'blocked');
    await first.close();

    install(MISSING);
    h = await harness({ home: first.home, repoDir: first.repoDir });
    await h.waitStatus(run.id, 'waiting_approval');
    expect(h.fake.calls.filter((c) => c.model === 'coder')).toEqual([]);
    const resumed = h.master.store
      .listEvents(run.id)
      .filter((e) => e.type === 'environment.resumed');
    expect(resumed.map((e) => e.data)).toEqual([{ reason: 'restart', missing: MISSING }]);
  });

  it('blocks rather than fails when a setup command is not found, and starts over once it is', async () => {
    h = await harness({ setupCommands: [`${MISSING} ci`] });
    const { store, engine } = h.master;
    const run = h.run();
    const blocked = await h.waitStatus(run.id, 'blocked');
    expect(blocked).toMatchObject({
      worktreePath: null,
      error: null,
      blocked: { kind: 'environment', missing: MISSING },
    });
    expect(blocked.blocked?.message).toContain(`准备命令 \`${MISSING} ci\``);
    expect(h.fake.calls).toEqual([]);
    // A retry by hand runs the setup again, which still cannot find it.
    await engine.retry(run.id);
    await waitFor(
      () => store.listEvents(run.id).filter((e) => e.type === 'run.blocked').length === 2,
      'the second block',
    );
    install(MISSING);
    expect(engine.checkEnvironment()).toEqual([run.id]);
    await h.waitStatus(run.id, 'waiting_approval');
  });

  it('runs a command stage again once the program is found', async () => {
    h = await harness({
      workflow: withCommandStage(`    verify:\n      commands: ["${MISSING} e2e"]\n`),
    });
    const run = h.run();
    const blocked = await h.waitStatus(run.id, 'blocked');
    expect(blocked.blocked).toMatchObject({ kind: 'environment', missing: MISSING });
    const e2e = h.master.store.listStageRuns(run.id).find((sr) => sr.stageId === 'e2e');
    expect(e2e?.status).toBe('executing');
    install(MISSING);
    expect(h.master.engine.checkEnvironment()).toEqual([run.id]);
    await h.waitStatus(run.id, 'waiting_approval');
    expect(h.fake.calls.map((c) => c.model)).toEqual(['coder', 'reviewer']);
  });

  it('says so in English', async () => {
    setLang('en');
    try {
      h = await harness({ verifyCommands: [`${MISSING} --check`] });
      const run = h.run();
      const blocked = await h.waitStatus(run.id, 'blocked');
      expect(blocked.blocked?.message).toContain(
        `\`${MISSING}\` is not found in the environment: the verify command \`${MISSING} --check\` exited with 127`,
      );
      expect(blocked.blocked?.message).not.toMatch(/[一-鿿]/);
      const event = h.master.store.listEvents(run.id).find((e) => e.type === 'run.blocked');
      expect(noticeFor(event as never, run.goal)?.title).toBe(
        `Run is stuck: ${MISSING} not found in the environment`,
      );
    } finally {
      setLang('zh');
    }
  });

  it('still reworks when the program is there and the 127 comes from inside it', async () => {
    h = await harness({ verifyCommands: [`sh -c 'grep -q ok feature.txt || ${MISSING}'`] });
    let calls = 0;
    h.scripts.coder = (ctx) => {
      writeFile(join(ctx.input.workdir, 'feature.txt'), ++calls === 1 ? 'wrong\n' : 'ok\n');
      return done();
    };
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');
    expect(calls).toBe(2);
    expect(h.master.store.listRunTasks(run.id)[0]?.retries).toBe(1);
  });

  describe('when the agent reports its task incomplete', () => {
    const incomplete = (summary = '检查命令找不到程序，做不完'): FakeOutcome => ({
      finalMessage: `\`\`\`json\n${JSON.stringify({ status: 'incomplete', summary })}\n\`\`\``,
    });
    /** A coder that gives up half done the first time and finishes afterwards. */
    const givesUpOnce = (first: () => void = () => {}): Script => {
      let calls = 0;
      return (ctx) => {
        if (++calls === 1) {
          first();
          writeFile(join(ctx.input.workdir, 'half.txt'), 'half\n');
          return incomplete();
        }
        writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
        return done();
      };
    };
    const types = (runId: string) =>
      (h as Harness).master.store.listEvents(runId).map((e) => e.type);

    it('blocks on the environment instead of reworking when a check cannot find its program, and the agent starts over once it is found', async () => {
      const sent: string[] = [];
      h = await harness({
        verifyCommands: ['grep -q ok feature.txt', `${MISSING} --check`],
        config: 'notify:\n  system: true\n',
        master: { notice: (title) => sent.push(title) },
      });
      h.scripts.coder = givesUpOnce();
      const { store, engine } = h.master;
      const run = h.run();
      const blocked = await h.waitStatus(run.id, 'blocked');
      expect(blocked.error).toBeNull();
      expect(blocked.blocked).toMatchObject({ kind: 'environment', missing: MISSING });
      expect(blocked.blocked?.stageRunId).toBe(blocked.currentStageRunId);
      expect(blocked.blocked?.message).toContain(
        `运行环境里找不到 \`${MISSING}\`：Agent 报告没有完成，而检查命令 \`${MISSING} --check\` 要用到的 \`${MISSING}\` 在 PATH 里找不到`,
      );
      expect(sent.at(-1)).toBe(`Run 卡住了：运行环境里找不到 ${MISSING}`);
      // Not a rework: the count is unchanged, and the task goes back to run its agent again.
      const [task] = store.listRunTasks(run.id) as [Task];
      expect(task).toMatchObject({ status: 'pending', retries: 0, pendingFeedback: null });
      expect(task.sessionId).toBeNull();
      expect(store.listAttempts(task.id).map((a) => a.outcome)).toEqual([null]);
      expect(types(run.id)).not.toContain('task.rework');
      expect(types(run.id)).toContain('task.discarded');
      // The half-done work is undone, and no check ran.
      const worktree = blocked.worktreePath as string;
      expect(existsSync(join(worktree, 'half.txt'))).toBe(false);
      expect(git(worktree, 'rev-parse', 'HEAD')).toBe(task.baseCommit);
      expect(store.listChecks(run.id).filter((c) => c.kind === 'command')).toEqual([]);

      // Still missing: nothing changes.
      expect(engine.checkEnvironment()).toEqual([]);
      expect(store.getRun(run.id).status).toBe('blocked');

      install(MISSING);
      expect(engine.checkEnvironment()).toEqual([run.id]);
      await h.waitStatus(run.id, 'waiting_approval');
      // The agent ran again from the start, with the task's prompt rather than a rework's.
      const coder = h.fake.calls.filter((c) => c.model === 'coder');
      expect(coder).toHaveLength(2);
      expect(coder[1]?.resumeSessionId).toBeUndefined();
      expect(coder[1]?.prompt).not.toContain('你报告任务没有完成');
      expect(store.getTask(task.id)).toMatchObject({ status: 'passed', retries: 0 });
      expect(store.listAttempts(task.id).map((a) => a.outcome)).toEqual([null, 'passed']);
      expect(git(worktree, 'show', '--stat', '--format=', 'HEAD')).not.toContain('half.txt');
      const after = types(run.id);
      expect(after).toContain('environment.resumed');
      expect(after).not.toContain('task.verify_resumed');
      expect(after).not.toContain('task.rework');
      expect(after).not.toContain('run.retry');
    });

    it('starts the agent over on a retry by hand too', async () => {
      h = await harness({ verifyCommands: [`${MISSING} --check`] });
      h.scripts.coder = givesUpOnce();
      const run = h.run();
      await h.waitStatus(run.id, 'blocked');
      install(MISSING);
      await h.master.engine.retry(run.id);
      await h.waitStatus(run.id, 'waiting_approval');
      expect(h.fake.calls.map((c) => c.model)).toEqual(['coder', 'coder', 'reviewer']);
      expect(h.master.store.listRunTasks(run.id)[0]?.retries).toBe(0);
      expect(types(run.id)).not.toContain('task.verify_resumed');
    });

    it("blocks with the Master's node as missing when that node is gone", async () => {
      let gone = false;
      const sentinel = join(tmpDir('ares1-marker-'), 'verified');
      h = await harness({
        verifyCommands: [`touch ${sentinel}`, 'grep -q ok feature.txt'],
        master: { nodeMissing: () => gone },
      });
      // nvm uninstalls the version the Master runs on while the agent works.
      h.scripts.coder = givesUpOnce(() => {
        gone = true;
      });
      const { store, engine } = h.master;
      const run = h.run();
      const blocked = await h.waitStatus(run.id, 'blocked');
      expect(blocked.blocked).toMatchObject({ kind: 'environment', missing: process.execPath });
      expect(blocked.blocked?.message).toContain(
        `Agent 报告没有完成，而 Master 正在用的 node（${process.execPath}）已经不存在了`,
      );
      const [task] = store.listRunTasks(run.id) as [Task];
      expect(task).toMatchObject({ status: 'pending', retries: 0 });
      expect(types(run.id)).not.toContain('task.rework');
      expect(existsSync(sentinel)).toBe(false);
      expect(existsSync(join(blocked.worktreePath as string, 'half.txt'))).toBe(false);

      // The restarted Master's node finds everything.
      gone = false;
      expect(engine.checkEnvironment()).toEqual([run.id]);
      await h.waitStatus(run.id, 'waiting_approval');
      expect(h.fake.calls.filter((c) => c.model === 'coder')).toHaveLength(2);
      expect(existsSync(sentinel)).toBe(true);
      expect(store.getTask(task.id)).toMatchObject({ status: 'passed', retries: 0 });
      expect(types(run.id)).not.toContain('task.verify_resumed');
    });

    it('still reworks with what the agent said when every check finds its program', async () => {
      h = await harness({ verifyCommands: ['cd . && true', 'grep -q ok feature.txt'] });
      h.scripts.coder = givesUpOnce();
      const run = h.run();
      await h.waitStatus(run.id, 'waiting_approval');
      const { store } = h.master;
      const [task] = store.listRunTasks(run.id) as [Task];
      expect(task.retries).toBe(1);
      expect(store.listAttempts(task.id).map((a) => a.outcome)).toEqual(['rework', 'passed']);
      const rework = store.listEvents(run.id).find((e) => e.type === 'task.rework');
      expect(String(rework?.data.feedback)).toContain('检查命令找不到程序，做不完');
      expect(types(run.id)).not.toContain('run.blocked');
      // A rework goes on with the agent's session and its work.
      const coder = h.fake.calls.filter((c) => c.model === 'coder');
      expect(coder[1]?.resumeSessionId).toBeTruthy();
    });

    it('says so in English', async () => {
      setLang('en');
      try {
        h = await harness({ verifyCommands: [`${MISSING} --check`] });
        h.scripts.coder = givesUpOnce();
        const run = h.run();
        const blocked = await h.waitStatus(run.id, 'blocked');
        expect(blocked.blocked?.message).toContain(
          `\`${MISSING}\` is not found in the environment: the agent reported its task incomplete, and \`${MISSING}\`, which the verify command \`${MISSING} --check\` needs, is not in PATH`,
        );
        expect(blocked.blocked?.message).not.toMatch(/[一-鿿]/);
      } finally {
        setLang('zh');
      }
    });
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

describe('engine: unavailable agents', () => {
  const eventData = (runId: string, type: string) =>
    (h as Harness).master.store
      .listEvents(runId)
      .filter((e) => e.type === type)
      .map((e) => e.data);
  /** Coding, review, then merging without approval: a Run that gets through completes. */
  const WORKFLOW = `
id: dev
defaults:
  escalate: { max_retries: 2, on_agent_error: switch_agent }
stages:
  - id: implement
    agent: coder
  - id: review
    kind: review
    agent: reviewer
    inputs: [diff]
    on_fail: implement
  - id: merge
    kind: merge
`;
  const AGENTS = `
agents:
  coder: { cli: fake, model: coder }
  reviewer: { cli: fake, model: reviewer }
  reviewer2: { cli: fake, model: reviewer2, cost: low }
`;
  /** agents.yaml once the reviewer is disabled, as when its entry fails validation. */
  const REVIEWER_DISABLED = AGENTS.replace(
    'model: reviewer }',
    'model: reviewer, enabled: false }',
  );
  /** agents.yaml once the reviewer is gone, as after a rename. */
  const REVIEWER_REMOVED = AGENTS.replace('  reviewer: { cli: fake, model: reviewer }\n', '');
  const scripts = (): Record<string, Script> => ({
    coder: (ctx) => {
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return done();
    },
    reviewer: () => review(),
    reviewer2: () => review(),
  });
  /**
   * agents.yaml becomes `agents` while the coder works, so the review stage that comes next,
   * already part of the Run, finds its agent changed.
   */
  const coderChangesAgents = (t: Harness, agents: string) => {
    t.scripts.coder = (ctx) => {
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      writeFile(join(t.home, 'agents.yaml'), agents);
      t.master.configWatcher.reload();
      return done();
    };
  };
  const reviewTask = (runId: string) =>
    (h as Harness).master.store.listRunTasks(runId).find((t) => t.title === 'review') as Task;

  it.each([
    ['disabled', REVIEWER_DISABLED],
    ['gone from agents.yaml', REVIEWER_REMOVED],
  ])('switches to an available agent when the agent is %s, and completes', async (_, agents) => {
    h = await harness({ agents: AGENTS, workflow: WORKFLOW, scripts: scripts() });
    coderChangesAgents(h, agents);
    const run = h.run();
    const completed = await h.waitStatus(run.id, 'completed');
    // The unavailable reviewer never ran; the cheaper of the others took over.
    expect(h.fake.calls.map((c) => c.model)).toEqual(['coder', 'reviewer2']);
    const task = reviewTask(run.id);
    expect(task.agentId).toBe('reviewer2');
    expect(eventData(run.id, 'task.agent_switched')).toEqual([
      {
        taskId: task.id,
        from: 'reviewer',
        to: 'reviewer2',
        reason: 'unavailable',
        unavailable: 'missing',
        error: 'Agent reviewer 不存在、未启用或没有对应的 Adapter',
      },
    ]);
    // Nothing was executed for it: no retry used up, no error counted.
    expect(task.retries).toBe(0);
    expect(eventData(run.id, 'task.retry_after_error')).toEqual([]);
    expect(h.master.store.listAttempts(task.id).map((a) => [a.agentId, a.outcome])).toEqual([
      ['reviewer2', 'passed'],
    ]);
    expect(completed.blocked).toBeNull();
  });

  it('ends the Run as failed, not blocked, when no agent can take over', async () => {
    h = await harness({
      agents: AGENTS.replace('  reviewer2: { cli: fake, model: reviewer2, cost: low }\n', ''),
      workflow: WORKFLOW,
      scripts: scripts(),
    });
    // The coder is disabled too, so nobody is left for the review.
    coderChangesAgents(h, 'agents:\n  coder: { cli: fake, model: coder, enabled: false }\n');
    const run = h.run();
    const failed = await h.waitStatus(run.id, 'failed');
    expect(failed.blocked).toBeNull();
    expect(failed.finishedAt).toBeTruthy();
    expect(failed.error).toBe(
      'Task「review」无法执行：Agent reviewer 不存在、未启用或没有对应的 Adapter。没有别的可用 Agent 能接手，Run 结束（on_agent_error: switch_agent），工作目录和分支已保留。',
    );
    expect(h.fake.calls.map((c) => c.model)).toEqual(['coder']);
    expect(eventData(run.id, 'task.agent_switched')).toEqual([]);
    expect(eventData(run.id, 'run.blocked')).toEqual([]);
    expect(h.master.store.listRunTasks(run.id).map((t) => t.status)).toEqual([
      'passed',
      'cancelled',
    ]);
    expect(h.master.store.listAttempts(reviewTask(run.id).id)).toEqual([]);
    // The worktree keeps the coder's work and the branch stays, for inspection.
    const worktree = failed.worktreePath as string;
    expect(readFileSync(join(worktree, 'feature.txt'), 'utf8')).toBe('ok\n');
    expect(git(h.repoDir, 'branch', '--list', failed.branch as string)).not.toBe('');
    await expect(h.master.engine.retry(run.id)).rejects.toThrow(/blocked/);
  });

  it('with on_agent_error: retry, ends the Run at once instead of switching', async () => {
    h = await harness({ agents: AGENTS, workflow: WORKFLOW, scripts: scripts() });
    coderChangesAgents(h, REVIEWER_DISABLED);
    const run = h.run('添加 feature.txt', {
      stages: { review: { escalate: { on_agent_error: 'retry' } } },
    });
    const failed = await h.waitStatus(run.id, 'failed');
    expect(failed.blocked).toBeNull();
    expect(failed.error).toContain('Agent reviewer 不存在、未启用或没有对应的 Adapter');
    expect(failed.error).toContain('Run 结束（on_agent_error: retry），工作目录和分支已保留');
    expect(h.fake.calls.map((c) => c.model)).toEqual(['coder']);
    expect(eventData(run.id, 'task.agent_switched')).toEqual([]);
  });

  it('with on_agent_error: human, still waits for a human, who can switch the agent', async () => {
    h = await harness({ agents: AGENTS, workflow: WORKFLOW, scripts: scripts() });
    coderChangesAgents(h, REVIEWER_DISABLED);
    const run = h.run('添加 feature.txt', {
      stages: { review: { escalate: { on_agent_error: 'human' } } },
    });
    const blocked = await h.waitStatus(run.id, 'blocked');
    const task = reviewTask(run.id);
    expect(blocked.blocked).toEqual({
      kind: 'agent_unavailable',
      message: 'Agent reviewer 不存在、未启用或没有对应的 Adapter',
      taskId: task.id,
    });
    expect(h.fake.calls.map((c) => c.model)).toEqual(['coder']);
    expect(eventData(run.id, 'task.agent_switched')).toEqual([]);
    await h.master.engine.retry(run.id, { agentId: 'reviewer2' });
    await h.waitStatus(run.id, 'completed');
    expect(h.fake.calls.map((c) => c.model)).toEqual(['coder', 'reviewer2']);
  });

  it('switches an assessment that cannot run read-only only to an agent that can', async () => {
    const scripts: Record<string, Script> = {
      assessor: () => assessment('ask', { questions: ['要兼容旧格式吗？'] }),
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
    const agents = (assessorCli: string) => `
agents:
  assessor: { cli: ${assessorCli}, model: assessor, tier: high }
  writer: { cli: fake-rw, model: writer, tier: high, cost: low }
  backup: { cli: fake, model: backup, tier: high }
  coder: { cli: fake, model: coder }
  reviewer: { cli: fake, model: reviewer }
`;
    h = await harness({
      agents: agents('fake'),
      workflow: ASSESS_WORKFLOW_YAML,
      scripts,
      master: { adapters: [fake, writeOnly] },
    });
    const run = h.run();
    await h.waitStatus(run.id, 'blocked');
    // While the Run waits for a reply, the assessor moves to a CLI that cannot run read-only.
    writeFile(join(h.home, 'agents.yaml'), agents('fake-rw'));
    h.master.configWatcher.reload();
    h.master.engine.reply(run.id, ['要兼容'], 'dashboard');
    await h.waitStatus(run.id, 'completed');
    // The cheaper writer cannot run read-only, so the backup takes over.
    expect(fake.calls.map((c) => c.model)).toEqual(['assessor', 'backup', 'coder', 'reviewer']);
    expect(eventData(run.id, 'task.agent_switched')).toEqual([
      {
        taskId: expect.any(String),
        from: 'assessor',
        to: 'backup',
        reason: 'unavailable',
        unavailable: 'read_only_unsupported',
        error: '需求评估要以只读方式运行，Agent assessor 的 CLI fake-rw 不支持',
      },
    ]);
  });

  describe('in English', () => {
    afterEach(() => setLang('zh'));

    it('says why the Run ended without Chinese', async () => {
      h = await harness({
        config: 'language: en\n',
        agents: AGENTS.replace('  reviewer2: { cli: fake, model: reviewer2, cost: low }\n', ''),
        workflow: WORKFLOW,
        scripts: scripts(),
      });
      coderChangesAgents(h, 'agents:\n  coder: { cli: fake, model: coder, enabled: false }\n');
      const failed = await h.waitStatus(h.run('Add feature.txt').id, 'failed');
      expect(failed.error).toBe(
        'Task "review" cannot run. Agent reviewer does not exist, is disabled or has no adapter. No other agent can take over, so the Run ended (on_agent_error: switch_agent); the working directory and branch are kept.',
      );
      expect(failed.error).not.toMatch(/[一-鿿]/);
    });

    it('says why the Run ended with on_agent_error: retry without Chinese', async () => {
      h = await harness({
        config: 'language: en\n',
        agents: AGENTS,
        workflow: WORKFLOW,
        scripts: scripts(),
      });
      coderChangesAgents(h, REVIEWER_REMOVED);
      const run = h.run('Add feature.txt', {
        stages: { review: { escalate: { on_agent_error: 'retry' } } },
      });
      const failed = await h.waitStatus(run.id, 'failed');
      expect(failed.error).toContain('Retrying the same agent cannot succeed');
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

describe('engine: Master internal errors', () => {
  /** Nothing of the Run is left executing: no task running or verifying, no attempt running. */
  const expectNothingRunning = (runId: string) => {
    const { store } = (h as Harness).master;
    for (const task of store.listRunTasks(runId)) {
      expect(['running', 'verifying']).not.toContain(task.status);
    }
    expect(store.listRunAttempts(runId, 'running')).toEqual([]);
  };
  /** A coder that writes its work, then finds the worktree's index locked by another git. */
  const lockingCoder: Script = (ctx) => {
    writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
    const gitDir = git(ctx.input.workdir, 'rev-parse', '--absolute-git-dir');
    writeFile(join(gitDir, 'index.lock'), '');
    return done();
  };

  it('ends the Run as failed when something throws while the agent runs', async () => {
    h = await harness();
    h.scripts.coder = () => {
      throw new Error('磁盘满了');
    };
    const run = h.run();
    const failed = await h.waitStatus(run.id, 'failed');
    expect(failed.blocked).toBeNull();
    expect(failed.finishedAt).toBeTruthy();
    expect(failed.error).toBe('Master 内部错误：磁盘满了\nRun 结束，工作目录和分支已保留。');
    const { store } = h.master;
    expect(store.listEvents(run.id).map((e) => e.type)).not.toContain('run.blocked');
    expectNothingRunning(run.id);
    expect(store.listRunTasks(run.id).map((t) => t.status)).toEqual(['cancelled']);
    const [attempt, ...more] = store.listRunAttempts(run.id);
    expect(more).toEqual([]);
    expect(attempt).toMatchObject({ status: 'interrupted', error: 'Master 内部错误：磁盘满了' });
    expect(attempt?.endedAt).toBeTruthy();
    // Not taken for an agent error: no retry, no other agent.
    expect(h.fake.calls.map((c) => c.model)).toEqual(['coder']);
    expect(existsSync(failed.worktreePath as string)).toBe(true);
    // Nothing waits for a human: the next Run starts.
    h.scripts.coder = (ctx) => {
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return done();
    };
    await h.waitStatus(h.run('下一个').id, 'waiting_approval');
  });

  it('ends the Run as failed when git fails while the task is checked, keeping the worktree', async () => {
    h = await harness();
    h.scripts.coder = lockingCoder;
    const run = h.run();
    const failed = await h.waitStatus(run.id, 'failed');
    expect(failed.error).toMatch(/^Master 内部错误：git add -A 失败：.*index\.lock/);
    expect(failed.error).toMatch(/\nRun 结束，工作目录和分支已保留。$/);
    expectNothingRunning(run.id);
    expect(h.master.store.listRunTasks(run.id).map((t) => t.status)).toEqual(['cancelled']);
    // The agent itself had finished.
    expect(h.master.store.listRunAttempts(run.id).map((a) => a.status)).toEqual(['completed']);
    // The worktree stays as it was, uncommitted work included.
    const worktree = failed.worktreePath as string;
    expect(readFileSync(join(worktree, 'feature.txt'), 'utf8')).toBe('ok\n');
  });

  it('still retries Runs that an internal error or a failed setup blocked before', async () => {
    h = await harness({ setupCommands: ['test -f setup-ok'] });
    const { store, engine } = h.master;
    // A Run blocked on its setup before it ended as failed instead: nothing recorded yet.
    store.setWorking(false);
    const setup = h.run('准备');
    store.updateRun(setup.id, {
      status: 'blocked',
      queuePos: null,
      blocked: { kind: 'setup_failed', message: '准备命令失败' },
    });
    store.setWorking(true);
    writeFile(join(h.repoDir, 'setup-ok'), '1\n');
    git(h.repoDir, 'add', '-A');
    git(h.repoDir, 'commit', '-q', '-m', 'add setup-ok');
    await engine.retry(setup.id);
    await h.waitStatus(setup.id, 'waiting_approval');
    await engine.cancel(setup.id);

    // A Run blocked on an internal error in the middle of its task, its half-done work left in
    // the worktree: the retry starts the task over from its base.
    const calls = h.fake.calls.length;
    h.scripts.coder = () => new Promise<FakeOutcome>(() => {});
    const error = h.run('内部错误');
    await waitFor(() => h?.fake.calls.length === calls + 1, 'the coder of the second Run');
    await engine.pause(error.id);
    const worktree = store.getRun(error.id).worktreePath as string;
    writeFile(join(worktree, 'half-done.txt'), 'x\n');
    const [task] = store.listRunTasks(error.id);
    store.updateRun(error.id, {
      status: 'blocked',
      blocked: { kind: 'error', message: 'Master 内部错误：磁盘满了', taskId: task?.id },
    });
    let leftOver: boolean | undefined;
    h.scripts.coder = (ctx) => {
      leftOver = existsSync(join(ctx.input.workdir, 'half-done.txt'));
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return done();
    };
    await engine.retry(error.id);
    await h.waitStatus(error.id, 'waiting_approval');
    expect(leftOver).toBe(false);
  });

  describe('in English', () => {
    afterEach(() => setLang('zh'));

    it('says "Master internal error" without Chinese', async () => {
      h = await harness({ config: 'language: en\n' });
      // Not a git error: git's own messages follow the system's locale.
      h.scripts.coder = () => {
        throw new Error('disk full');
      };
      const run = h.run('Add feature.txt');
      const failed = await h.waitStatus(run.id, 'failed');
      expect(failed.error).toBe(
        'Master internal error: disk full\nThe Run ended; the working directory and branch are kept.',
      );
      expect(h.master.store.listRunAttempts(run.id)[0]?.error).toBe(
        'Master internal error: disk full',
      );
      expectNothingRunning(run.id);

      h.master.store.updateRepo(h.repo.id, { setupCommands: ['echo no registry && false'] });
      const setup = await h.waitStatus(h.run('Add feature.txt').id, 'failed');
      expect(setup.error).toBe(
        'Setup command `echo no registry && false` failed (exit code 1). End of the output:\n```\nno registry\n\n```\nThe Run ended; the working directory and branch are kept.',
      );
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

  describe('across a Master restart', () => {
    const HOUR = 3_600_000;
    const master = { rateLimitWait: { firstMs: 600_000, maxMs: 600_000, marginMs: 60_000 } };

    /** A Run whose agent hit a limit the CLI says ends in an hour, waiting in the queue. */
    async function limitedRun(): Promise<{ first: Harness; run: Run; resetAt: number }> {
      const first = await harness({ workflow: WORKFLOW, master });
      h = first;
      const resetAt = Date.now() + HOUR;
      first.scripts.coder = () => limited(new Date(resetAt).toISOString());
      const run = first.run();
      await waitFor(() => eventData(run.id, 'task.rate_limited').length === 1, 'the rate limit');
      await first.waitStatus(run.id, 'queued');
      await waitFor(() => first.master.engine.activeRunIds.length === 0, 'the engine to be idle');
      return { first, run, resetAt };
    }

    it('waits on until the time it was given, then goes on', async () => {
      const { first, run, resetAt } = await limitedRun();
      const retryAt = new Date(resetAt + 60_000).toISOString();
      expect(eventData(run.id, 'task.rate_limited')[0]?.retryAt).toBe(retryAt);
      await first.close();

      let now = Date.now();
      h = await harness({
        workflow: WORKFLOW,
        home: first.home,
        repoDir: first.repoDir,
        master: { ...master, now: () => now },
      });
      h.scripts.coder = writeFeature;
      // The dashboard still shows when it goes on.
      expect(h.master.engine.rateLimited(h.master.store.getRun(run.id))).toEqual({
        agentId: 'coder',
        retryAt,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(h.fake.calls).toEqual([]);
      expect(h.master.store.getRun(run.id).status).toBe('queued');

      // Not before the reset time plus the margin.
      now = Date.parse(retryAt) - 1000;
      h.master.engine.kick();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(h.fake.calls).toEqual([]);
      expect(h.master.engine.rateLimited(h.master.store.getRun(run.id))?.retryAt).toBe(retryAt);

      now = Date.parse(retryAt) + 1000;
      h.master.engine.kick();
      const completed = await h.waitStatus(run.id, 'completed');
      expect(h.fake.calls.map((c) => c.model)).toEqual(['coder']);
      expect(h.master.engine.rateLimited(completed)).toBeNull();
    });

    it('no longer waits once the Run was paused and resumed', async () => {
      const { first, run } = await limitedRun();
      // With the work switch off the resumed Run stays in the queue until the restart.
      first.master.engine.setWorking(false);
      expect((await first.master.engine.pause(run.id)).status).toBe('paused');
      expect(first.master.engine.resume(run.id).status).toBe('queued');
      await first.close();

      h = await harness({ workflow: WORKFLOW, home: first.home, repoDir: first.repoDir, master });
      h.scripts.coder = writeFeature;
      expect(h.master.engine.rateLimited(h.master.store.getRun(run.id))).toBeNull();
      h.master.engine.setWorking(true);
      await h.waitStatus(run.id, 'completed');
      expect(h.fake.calls.map((c) => c.model)).toEqual(['coder']);
    });
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
  /** A Run over its budget waits for a human to raise it, instead of ending (the default). */
  const pausing = (workflow: string) =>
    workflow.replace(
      '    on_agent_error: switch_agent\n',
      '    on_agent_error: switch_agent\n    on_budget_exceeded: pause\n',
    );

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

  it('ends the Run as failed by default once the budget is spent, without waiting for anyone', async () => {
    h = await harness({ workflow: withBudget('  budget_usd: 1\n') });
    costly(h, 1.2);
    const run = h.run();
    const failed = await h.waitStatus(run.id, 'failed');
    expect(failed.blocked).toBeNull();
    expect(failed.finishedAt).toBeTruthy();
    expect(failed.error).toBe(
      '已花费 $1.20，超过预算 $1.00，Run 结束（on_budget_exceeded: abort），工作目录和分支已保留。',
    );
    // Soft limit: the execution that crossed the budget was checked; the rework never started.
    expect(h.fake.calls).toHaveLength(1);
    expect(h.master.store.listRunTasks(run.id).map((t) => t.status)).toEqual(['cancelled']);
    const events = h.master.store.listEvents(run.id);
    const exceeded = events.filter((e) => e.type === 'run.budget_exceeded');
    expect(exceeded.map((e) => e.data)).toEqual([
      { costUsd: expect.closeTo(1.2), budgetUsd: 1, action: 'abort' },
    ]);
    expect(events.some((e) => e.type === 'run.blocked')).toBe(false);
    // Kept for inspection, like a cancelled Run; nothing to raise the budget of.
    expect(existsSync(failed.worktreePath as string)).toBe(true);
    await expect(h.master.engine.retry(run.id, { budgetUsd: 5 })).rejects.toThrow(/blocked/);
    // Nothing waits for a human: the next Run starts.
    await h.waitStatus(h.run('下一个', { budget_usd: 10 }).id, 'waiting_approval');
  });

  it('blocks before the next execution once the budget is spent with on_budget_exceeded: pause; a higher budget continues', async () => {
    h = await harness({ workflow: pausing(withBudget('  budget_usd: 1\n')) });
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
    h = await harness({ workflow: pausing(withBudget('  budget_usd: 1\n')) });
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

  it('fails the Run when on_budget_exceeded is set to abort', async () => {
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
    const failed = await h.waitStatus(tight.id, 'failed');
    expect(failed.error).toContain('预算 $0.25');
  });

  it('a stage set to pause in the Run overrides waits there even though the default ends it', async () => {
    h = await harness({ workflow: withBudget('  budget_usd: 1\n') });
    costly(h, 1.2);
    const run = h.run('目标', {
      stages: { implement: { escalate: { on_budget_exceeded: 'pause' } } },
    });
    const blocked = await h.waitStatus(run.id, 'blocked');
    expect(blocked.blocked?.kind).toBe('budget');
    expect(h.master.store.getStageRun(blocked.currentStageRunId as string).stageId).toBe(
      'implement',
    );
  });

  describe('in English', () => {
    afterEach(() => setLang('zh'));

    it('says why a Run over budget ended without Chinese', async () => {
      h = await harness({ config: 'language: en\n', workflow: withBudget('  budget_usd: 1\n') });
      costly(h, 1.2);
      const failed = await h.waitStatus(h.run('Add feature.txt').id, 'failed');
      expect(failed.error).toBe(
        'Spent $1.20, over the budget of $1.00, so the Run ended (on_budget_exceeded: abort); the working directory and branch are kept.',
      );
      expect(failed.error).not.toMatch(/[一-鿿]/);
    });
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

describe('engine: merge conflicts', () => {
  /** Another Run's work lands on main: commit `content` to `file` there; returns the commit. */
  const commitOnMain = (repoDir: string, file: string, content: string): string => {
    writeFile(join(repoDir, file), content);
    git(repoDir, 'add', '-A');
    git(repoDir, 'commit', '-q', '-m', `main changes ${file}`);
    return git(repoDir, 'rev-parse', 'main');
  };
  const merging = (worktree: string) => {
    try {
      git(worktree, 'rev-parse', '-q', '--verify', 'MERGE_HEAD');
      return true;
    } catch {
      return false;
    }
  };
  const coderCalls = () => (h as Harness).fake.calls.filter((c) => c.model === 'coder');
  const eventsOf = (runId: string, type: string) =>
    (h as Harness).master.store.listEvents(runId).filter((e) => e.type === type);
  /** Merges without approval, so a Run goes from coding to merging on its own. */
  const noGate = { stages: { merge: { gate: false } } };
  /**
   * Once the Run waits for its merge approval, main moves on without touching the Run's files and
   * the worktree's index is locked, as by a git that got stuck: syncing main then fails with no
   * conflicted file.
   */
  const lockBeforeMerge = async (runId: string) => {
    const waiting = await (h as Harness).waitStatus(runId, 'waiting_approval');
    const worktree = waiting.worktreePath as string;
    const runHead = git(worktree, 'rev-parse', 'HEAD');
    const mainHead = commitOnMain((h as Harness).repoDir, 'other.txt', 'other\n');
    writeFile(join(git(worktree, 'rev-parse', '--absolute-git-dir'), 'index.lock'), '');
    return { worktree, runHead, mainHead };
  };
  /** The merge stage goes back to the review stage, which cannot change files. */
  const toReview = () =>
    TEST_WORKFLOW_YAML.replace(
      '    gate: true\n    on_reject: implement\n',
      '    gate: true\n    on_reject: implement\n    on_fail: review\n',
    );
  /**
   * Once the Run waits for its merge approval, main adds feature.txt with other content: merging
   * main into the Run's branch then conflicts.
   */
  const conflictBeforeMerge = async (runId: string) => {
    const waiting = await (h as Harness).waitStatus(runId, 'waiting_approval');
    const worktree = waiting.worktreePath as string;
    const runHead = git(worktree, 'rev-parse', 'HEAD');
    const mainHead = commitOnMain((h as Harness).repoDir, 'feature.txt', 'from main\n');
    return { worktree, branch: waiting.branch as string, runHead, mainHead };
  };
  /**
   * A Run an older Master blocked on a merge conflict no agent stage could resolve, as it did
   * before such a Run ended: approved for merging, then blocked before it went on.
   */
  const blockedOnConflict = async () => {
    const { engine, store } = (h as Harness).master;
    const run = (h as Harness).run();
    const ready = await conflictBeforeMerge(run.id);
    store.setWorking(false);
    engine.approve(run.id);
    store.updateRun(run.id, {
      status: 'blocked',
      queuePos: null,
      blocked: {
        kind: 'merge_conflict',
        message: '合并 main 的最新代码失败，Master 已放弃这次合并，工作目录保持原样。',
        stageRunId: store.listStageRuns(run.id).find((sr) => sr.stageId === 'merge')?.id,
      },
    });
    store.setWorking(true);
    return { run, ...ready };
  };

  it('goes back to coding, where the agent resolves the conflict, then merges both sides', async () => {
    h = await harness();
    const store = h.master.store;
    const run = h.run();
    const waiting = await h.waitStatus(run.id, 'waiting_approval');
    const worktree = waiting.worktreePath as string;
    const runHead = git(worktree, 'rev-parse', 'HEAD');
    // Another Run merged into main while this one waited for its approval.
    const mainHead = commitOnMain(h.repoDir, 'feature.txt', 'from main\n');
    const seen: string[] = [];
    h.scripts.coder = (ctx) => {
      const file = join(ctx.input.workdir, 'feature.txt');
      seen.push(readFileSync(file, 'utf8'));
      writeFile(file, 'ok\nfrom main\n');
      return done('解决了冲突');
    };

    h.master.engine.approve(run.id);
    const mergeRounds = () => store.listStageRuns(run.id).filter((s) => s.stageId === 'merge');
    await waitFor(
      () => mergeRounds().length === 2 && store.getRun(run.id).status === 'waiting_approval',
      'the second merge approval',
    );
    expect(store.listStageRuns(run.id).map((s) => [s.stageId, s.status, s.failReason])).toEqual([
      ['implement', 'passed', null],
      ['review', 'passed', null],
      ['merge', 'failed', 'conflict'],
      ['implement', 'passed', null],
      ['review', 'passed', null],
      ['merge', 'waiting_approval', null],
    ]);
    const failedMerge = mergeRounds()[0];
    expect(failedMerge?.failFeedback).toContain('这些文件有冲突：\n- feature.txt');
    expect(failedMerge?.failFeedback).toContain('同时保留本需求的改动');
    const rerun = store.listStageRuns(run.id)[3];
    expect(rerun?.feedback).toContain('- feature.txt');

    // The coding agent got the conflicts in the file, and was told about the merge.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^<<<<<<< /m);
    expect(seen[0]).toMatch(/^>>>>>>> /m);
    const call = coderCalls()[1];
    expect(call?.resumeSessionId).toBeUndefined();
    expect(call?.prompt).toContain('## 未完成的合并');
    expect(call?.prompt).toContain('- `feature.txt`');
    expect(call?.prompt).toContain('不要执行 git commit、git merge --abort、git reset');
    const checks = store.listChecks(run.id).filter((c) => c.stageRunId === rerun?.id);
    expect(checks.map((c) => [c.kind, c.name, c.passed, c.detail])).toContainEqual([
      'merge',
      '合并 main',
      true,
      '冲突已解决：feature.txt',
    ]);

    // The coding round's commit is the merge commit; the review compares against main's commit.
    expect(git(worktree, 'rev-parse', 'HEAD^1', 'HEAD^2').split('\n')).toEqual([runHead, mainHead]);
    expect(merging(worktree)).toBe(false);
    const reviewCall = h.fake.calls.filter((c) => c.model === 'reviewer')[1];
    expect(reviewCall?.prompt).toContain(`git diff ${mainHead}...HEAD`);
    expect(eventsOf(run.id, 'merge.synced').map((e) => e.data.targetHead)).toEqual([mainHead]);
    expect(eventsOf(run.id, 'run.blocked')).toEqual([]);

    h.master.engine.approve(run.id);
    await h.waitStatus(run.id, 'completed');
    expect(git(h.repoDir, 'show', 'main:feature.txt')).toBe('ok\nfrom main');
    expect(git(h.repoDir, 'rev-parse', 'main^2')).toBe(mainHead);
  });

  it('reworks while conflict markers are left in the files', async () => {
    h = await harness();
    const repoDir = h.repoDir;
    let calls = 0;
    h.scripts.coder = (ctx) => {
      calls++;
      const file = join(ctx.input.workdir, 'feature.txt');
      if (calls === 1) {
        writeFile(file, 'ok\n');
        commitOnMain(repoDir, 'feature.txt', 'from main\n');
      }
      // The second call leaves the conflict as it is: its markers still pass the check command.
      if (calls === 3) writeFile(file, 'ok\nfrom main\n');
      return done();
    };
    const run = h.run('目标', noGate);
    await h.waitStatus(run.id, 'completed');
    expect(git(h.repoDir, 'show', 'main:feature.txt')).toBe('ok\nfrom main');

    const [, left, fixed] = coderCalls();
    // The rework goes on in the same session with the merge still in progress.
    expect(fixed?.resumeSessionId).toBeTruthy();
    expect(fixed?.prompt).toContain('这些文件里还有冲突标记');
    expect(fixed?.prompt).toContain('feature.txt');
    const store = h.master.store;
    const attempts = store.listRunAttempts(run.id).filter((a) => a.agentId === 'coder');
    expect(attempts.map((a) => a.outcome)).toEqual(['passed', 'rework', 'passed']);
    const leftCheck = store
      .listChecks(run.id)
      .find((c) => c.attemptId === attempts[1]?.id && c.kind === 'merge');
    expect(leftCheck?.passed).toBe(false);
    expect(left?.prompt).toContain('## 未完成的合并');
    // Only one merge was started: the rework did not start it again.
    expect(eventsOf(run.id, 'merge.started')).toHaveLength(1);
  });

  it('ends the Run once the conflicts keep coming back past max_loops', async () => {
    h = await harness();
    const repoDir = h.repoDir;
    let n = 0;
    // Each round resolves the conflict, and each time another Run changes the same line on main.
    h.scripts.coder = (ctx) => {
      n++;
      writeFile(join(ctx.input.workdir, 'feature.txt'), `ok ${n}\n`);
      commitOnMain(repoDir, 'feature.txt', `from main ${n}\n`);
      return done();
    };
    const run = h.run('目标', { ...noGate, max_loops: 1 });
    const failed = await h.waitStatus(run.id, 'failed');
    const store = h.master.store;
    expect(store.countStageRounds(run.id, 'implement')).toBe(2);
    const merges = store.listStageRuns(run.id).filter((s) => s.stageId === 'merge');
    expect(merges.map((s) => s.failReason)).toEqual(['conflict', 'conflict']);
    expect(failed.error).toContain(
      '阶段「编码」已执行 2 轮，超过回退上限 1，Run 结束（on_exhausted: fail），工作目录和分支已保留。最后一次「合并」没有通过：\n',
    );
    expect(failed.error).toContain('- feature.txt');
    expect(eventsOf(run.id, 'run.blocked')).toEqual([]);
    // No merge is left half done in the kept worktree.
    const worktree = failed.worktreePath as string;
    expect(merging(worktree)).toBe(false);
    expect(git(worktree, 'status', '--porcelain')).toBe('');
  });

  it('with on_exhausted: human, waits at max_loops and a retry resolves the conflict again', async () => {
    h = await harness({ workflow: WAIT_WHEN_EXHAUSTED });
    const repoDir = h.repoDir;
    let n = 0;
    h.scripts.coder = (ctx) => {
      n++;
      writeFile(join(ctx.input.workdir, 'feature.txt'), `ok ${n}\n`);
      commitOnMain(repoDir, 'feature.txt', `from main ${n}\n`);
      return done();
    };
    const run = h.run('目标', { ...noGate, max_loops: 1 });
    const blocked = await h.waitStatus(run.id, 'blocked');
    expect(blocked.blocked?.kind).toBe('max_loops');
    expect(blocked.blocked?.message).toContain('- feature.txt');

    // main stops moving; the extra round merges it and resolves the conflict.
    h.scripts.coder = (ctx) => {
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return done();
    };
    await h.master.engine.retry(run.id);
    await h.waitStatus(run.id, 'completed');
    expect(h.master.store.countStageRounds(run.id, 'implement')).toBe(3);
    expect(git(h.repoDir, 'show', 'main:feature.txt')).toBe('ok');
    expect(git(h.repoDir, 'log', '-1', '--format=%P', 'main').split(' ')).toHaveLength(2);
  });

  it('a pause gives the merge up; the resumed round merges the latest main again', async () => {
    h = await harness();
    const repoDir = h.repoDir;
    let calls = 0;
    h.scripts.coder = async (ctx) => {
      calls++;
      const file = join(ctx.input.workdir, 'feature.txt');
      if (calls === 1) {
        writeFile(file, 'ok\n');
        commitOnMain(repoDir, 'feature.txt', 'from main\n');
        return done();
      }
      if (calls === 2) {
        writeFile(file, 'half resolved\n');
        await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
        return done();
      }
      expect(readFileSync(file, 'utf8')).toMatch(/^<<<<<<< /m);
      writeFile(file, 'ok\nfrom main\n');
      return done();
    };
    const run = h.run('目标', noGate);
    await waitFor(() => calls === 2, 'the coding agent to resolve the conflict');
    const worktree = h.master.store.getRun(run.id).worktreePath as string;
    expect(merging(worktree)).toBe(true);
    const task = h.master.store.listRunTasks(run.id).findLast((t) => t.title === '编码') as Task;

    await h.master.engine.pause(run.id);
    // Back to before the merge: no MERGE_HEAD, nothing uncommitted.
    expect(merging(worktree)).toBe(false);
    expect(git(worktree, 'status', '--porcelain')).toBe('');
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(task.baseCommit);

    // main moves on meanwhile; resuming merges what it is now.
    const latest = commitOnMain(repoDir, 'other.txt', 'other\n');
    h.master.engine.resume(run.id);
    await h.waitStatus(run.id, 'completed');
    expect(git(h.repoDir, 'show', 'main:feature.txt')).toBe('ok\nfrom main');
    expect(git(h.repoDir, 'show', 'main:other.txt')).toBe('other');
    const started = eventsOf(run.id, 'merge.started');
    expect(started).toHaveLength(2);
    expect(started[1]?.data.targetHead).toBe(latest);
    // The redo starts a fresh session: the worktree no longer has the stopped one's work.
    expect(coderCalls()[2]?.resumeSessionId).toBeUndefined();
  });

  it('a restart gives the merge up and the new Master merges and resolves it again', async () => {
    const first = await harness();
    const repoDir = first.repoDir;
    let calls = 0;
    first.scripts.coder = async (ctx) => {
      calls++;
      if (calls === 1) {
        writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
        commitOnMain(repoDir, 'feature.txt', 'from main\n');
        return done();
      }
      await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
      return done();
    };
    const run = first.run('目标', noGate);
    await waitFor(() => calls === 2, 'the coding agent to resolve the conflict');
    const worktree = first.master.store.getRun(run.id).worktreePath as string;
    expect(merging(worktree)).toBe(true);
    await first.close();
    expect(merging(worktree)).toBe(false);
    expect(git(worktree, 'status', '--porcelain')).toBe('');

    const resolve: Script = (ctx) => {
      const file = join(ctx.input.workdir, 'feature.txt');
      if (!/^<<<<<<< /m.test(readFileSync(file, 'utf8'))) throw new Error('no conflict to resolve');
      writeFile(file, 'ok\nfrom main\n');
      return done();
    };
    h = await harness({
      home: first.home,
      repoDir,
      scripts: { coder: resolve, reviewer: () => review() },
    });
    await h.waitStatus(run.id, 'completed');
    expect(git(repoDir, 'show', 'main:feature.txt')).toBe('ok\nfrom main');
  });

  it('ends the Run as failed when git fails to merge main without a conflict', async () => {
    h = await harness();
    const store = h.master.store;
    const run = h.run();
    const { worktree, runHead, mainHead } = await lockBeforeMerge(run.id);

    h.master.engine.approve(run.id);
    const failed = await h.waitStatus(run.id, 'failed');
    expect(failed.blocked).toBeNull();
    expect(failed.finishedAt).toBeTruthy();
    expect(failed.error).toMatch(/^合并 main 的最新代码失败：git .*merge .*失败：.*index\.lock/s);
    expect(failed.error).toMatch(/\nRun 结束，工作目录和分支已保留。$/);
    expect(eventsOf(run.id, 'run.blocked')).toEqual([]);
    const check = store.listChecks(run.id).find((c) => c.kind === 'merge');
    expect(check).toMatchObject({ name: '同步 main', passed: false });
    expect(check?.detail).toContain('index.lock');
    // Nothing went back to another stage, and nothing was merged.
    expect(store.listStageRuns(run.id).some((sr) => sr.failReason === 'conflict')).toBe(false);
    expect(git(h.repoDir, 'rev-parse', 'main')).toBe(mainHead);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(runHead);
    expect(existsSync(worktree)).toBe(true);
    // Nothing waits for a human: the next Run starts.
    await h.waitStatus(h.run('下一个').id, 'waiting_approval');
  });

  it('ends the Run as failed on a conflict no agent stage can resolve, waiting for nobody', async () => {
    h = await harness({ workflow: toReview() });
    const store = h.master.store;
    const run = h.run();
    const { worktree, branch, runHead, mainHead } = await conflictBeforeMerge(run.id);

    h.master.engine.approve(run.id);
    const failed = await h.waitStatus(run.id, 'failed');
    expect(failed.blocked).toBeNull();
    expect(failed.finishedAt).toBeTruthy();
    expect(failed.error).toBe(
      `合并 main 的最新代码（${mainHead.slice(0, 8)}）时，这些文件有冲突：\n- feature.txt\n合并阶段回退到的不是 Agent 阶段，没有 Agent 能解决这些冲突。\nRun 结束，工作目录和分支已保留；重做时会基于 main 的最新代码。`,
    );
    expect(eventsOf(run.id, 'run.blocked')).toEqual([]);
    const check = store.listChecks(run.id).find((c) => c.kind === 'merge');
    expect(check).toMatchObject({ name: '同步 main', passed: false });
    expect(check?.detail).toContain('- feature.txt');
    // Nothing went back to another stage, and the merge was given up: main did not move, and the
    // worktree is clean on the Run's commit, kept with its branch.
    expect(store.listStageRuns(run.id).some((sr) => sr.failReason === 'conflict')).toBe(false);
    expect(git(h.repoDir, 'rev-parse', 'main')).toBe(mainHead);
    expect(git(h.repoDir, 'show', 'main:feature.txt')).toBe('from main');
    expect(existsSync(worktree)).toBe(true);
    expect(git(worktree, 'status', '--porcelain')).toBe('');
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(runHead);
    expect(merging(worktree)).toBe(false);
    expect(git(h.repoDir, 'branch', '--list', branch)).not.toBe('');
    // Nothing to retry, and nothing waits for a human: the next Run starts.
    await expect(h.master.engine.retry(run.id)).rejects.toThrow(/blocked/);
    await h.waitStatus(h.run('下一个').id, 'waiting_approval');
  });

  it('still retries a Run an older Master blocked on a merge conflict, once merged by hand', async () => {
    h = await harness({ workflow: toReview() });
    const store = h.master.store;
    const { run, worktree } = await blockedOnConflict();
    expect(() => git(worktree, 'merge', '-q', 'main')).toThrow();
    writeFile(join(worktree, 'feature.txt'), 'ok\nfrom main\n');
    git(worktree, 'add', 'feature.txt');
    git(worktree, 'commit', '-q', '--no-edit');

    await h.master.engine.retry(run.id);
    await h.waitStatus(run.id, 'completed');
    expect(eventsOf(run.id, 'run.retry').map((e) => e.data.kind)).toEqual(['merge_conflict']);
    expect(git(h.repoDir, 'show', 'main:feature.txt')).toBe('ok\nfrom main');
    // The merge checked the human's commit before taking it.
    const mergeStage = store.listStageRuns(run.id).find((sr) => sr.stageId === 'merge');
    const checks = store.listChecks(run.id).filter((c) => c.stageRunId === mergeStage?.id);
    expect(checks.map((c) => [c.kind, c.passed])).toEqual([
      ['command', true],
      ['merge', true],
    ]);
  });

  it('ends a Run an older Master blocked on a merge conflict once a retry conflicts again', async () => {
    h = await harness({ workflow: toReview() });
    const { run, worktree, runHead, mainHead } = await blockedOnConflict();
    await h.master.engine.retry(run.id);
    const failed = await h.waitStatus(run.id, 'failed');
    expect(failed.blocked).toBeNull();
    expect(failed.error).toContain('这些文件有冲突：\n- feature.txt\n');
    expect(eventsOf(run.id, 'run.blocked')).toEqual([]);
    expect(git(h.repoDir, 'rev-parse', 'main')).toBe(mainHead);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(runHead);
  });

  it('still cancels a Run an older Master blocked on a merge conflict', async () => {
    h = await harness({ workflow: toReview() });
    const { run, worktree, mainHead } = await blockedOnConflict();
    const cancelled = await h.master.engine.cancel(run.id);
    expect(cancelled.status).toBe('cancelled');
    expect(existsSync(worktree)).toBe(true);
    expect(git(h.repoDir, 'rev-parse', 'main')).toBe(mainHead);
    await h.waitStatus(h.run('下一个').id, 'waiting_approval');
  });

  describe('in English', () => {
    afterEach(() => setLang('zh'));

    it('says what conflicted when no agent stage can resolve it without Chinese', async () => {
      h = await harness({ config: 'language: en\n', workflow: toReview() });
      const run = h.run('Add feature.txt');
      const { mainHead } = await conflictBeforeMerge(run.id);
      h.master.engine.approve(run.id);
      const failed = await h.waitStatus(run.id, 'failed');
      expect(failed.error).toBe(
        `Merging the latest main (${mainHead.slice(0, 8)}) ran into conflicts in these files:\n- feature.txt\nThe merge stage does not go back to an agent stage, so no agent can resolve them.\nThe Run ended; the working directory and branch are kept, and a redo starts from the latest main.`,
      );
      expect(failed.error).not.toMatch(/[一-鿿]/);
      const check = h.master.store.listChecks(run.id).find((c) => c.kind === 'merge');
      expect(check?.name).toBe('Sync main');
      expect(check?.detail).not.toMatch(/[一-鿿]/);
    });

    it('says why syncing main failed without Chinese of its own', async () => {
      h = await harness({ config: 'language: en\n' });
      const run = h.run('Add feature.txt');
      await lockBeforeMerge(run.id);
      h.master.engine.approve(run.id);
      const failed = await h.waitStatus(run.id, 'failed');
      const error = failed.error as string;
      const match =
        /^Merging the latest main failed: git .*? failed: ([\s\S]*)\nThe Run ended; the working directory and branch are kept\.$/.exec(
          error,
        );
      expect(match).not.toBeNull();
      // git's own message comes in the system's language; what the Master says around it is English.
      const gitSays = match?.[1] as string;
      expect(gitSays).toContain('index.lock');
      expect(error.replace(gitSays, '')).not.toMatch(/[一-鿿]/);
      const check = h.master.store.listChecks(run.id).find((c) => c.kind === 'merge');
      expect(check?.name).toBe('Sync main');
      expect(check?.detail?.replace(gitSays, '')).not.toMatch(/[一-鿿]/);
    });

    it('tells the agent about the merge and says what conflicted without Chinese', async () => {
      const englishWorkflow = TEST_WORKFLOW_YAML.replace('name: 测试流程', 'name: Test flow')
        .replace('name: 编码', 'name: Coding')
        .replace('name: 评审', 'name: Review')
        .replace('name: 合并', 'name: Merge');
      h = await harness({ config: 'language: en\n', workflow: englishWorkflow });
      const repoDir = h.repoDir;
      let calls = 0;
      h.scripts.coder = (ctx) => {
        calls++;
        const file = join(ctx.input.workdir, 'feature.txt');
        if (calls === 1) {
          writeFile(file, 'ok\n');
          commitOnMain(repoDir, 'feature.txt', 'from main\n');
        }
        if (calls === 3) writeFile(file, 'ok\nfrom main\n');
        return done('resolved');
      };
      const run = h.run('Add feature.txt', noGate);
      await h.waitStatus(run.id, 'completed');
      const store = h.master.store;
      const rounds = store.listStageRuns(run.id);
      const texts = [
        rounds.find((s) => s.failReason === 'conflict')?.failFeedback,
        rounds[3]?.feedback,
        coderCalls()[1]?.prompt,
        coderCalls()[2]?.prompt,
        ...store
          .listChecks(run.id)
          .filter((c) => c.kind === 'merge')
          .map((c) => `${c.name}: ${c.detail}`),
      ];
      expect(texts[0]).toContain('ran into conflicts in these files:\n- feature.txt');
      expect(texts[2]).toContain('## A merge in progress');
      expect(texts[3]).toContain('These files still have conflict markers');
      for (const text of texts) {
        expect(text).toBeTruthy();
        expect(text).not.toMatch(/[一-鿿]/);
      }
    });
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

describe('engine: Runs of different repos', () => {
  /** Merges without waiting for an approval, so a Run that goes ahead completes on its own. */
  const NO_GATE = { stages: { merge: { gate: false } } };

  /** Registers another repo, on a new git repo unless `path` is given. */
  const addRepo = (t: Harness, name: string, path = initRepo(), targetBranch = 'main') =>
    t.master.store.createRepo({
      name,
      path,
      targetBranch,
      verifyCommands: ['grep -q ok feature.txt'],
      setupCommands: [],
      mergeMode: 'direct',
    });

  const runIn = (t: Harness, repo: string, goal = '添加 feature.txt') =>
    t.master.engine.createRun({ repo, template: 'dev', goal, overrides: NO_GATE });

  /**
   * Writes feature.txt and a file of its own Run, so that a Run of a repo where an earlier Run
   * already merged feature.txt still changes something.
   */
  const coder: Script = (ctx) => {
    writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
    writeFile(join(ctx.input.workdir, `${basename(ctx.input.workdir)}.txt`), 'ok\n');
    return done();
  };

  /** Coders wait until the returned function is called (or they are stopped), then `coder`. */
  function slowCoder(t: Harness): () => void {
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.scripts.coder = async (ctx) => {
      const stopped = new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
      await Promise.race([released, stopped]);
      return ctx.signal.aborted ? done() : coder(ctx);
    };
    return release;
  }

  const status = (t: Harness, run: Run) => t.master.store.getRun(run.id).status;

  /** `run.status` changes as they happen, as `<runId>:<status>`. */
  function statusLog(t: Harness): string[] {
    const log: string[] = [];
    t.master.store.bus.on('event', (e) => {
      if (e.type === 'run.status') log.push(`${e.runId}:${e.data.status}`);
    });
    return log;
  }

  it('executes Runs of two repos at the same time, and both complete and merge', async () => {
    h = await harness();
    const t = h;
    const other = addRepo(t, 'other');
    const release = slowCoder(t);
    const first = runIn(t, 'demo');
    const second = runIn(t, 'other');
    await waitFor(() => t.fake.calls.length === 2, 'both coders to start');
    expect([status(t, first), status(t, second)]).toEqual(['running', 'running']);
    expect(t.master.engine.activeRunIds).toEqual([first.id, second.id]);

    release();
    await t.waitStatus(first.id, 'completed');
    await t.waitStatus(second.id, 'completed');
    expect(git(t.repoDir, 'show', 'main:feature.txt')).toBe('ok');
    expect(git(other.path, 'show', 'main:feature.txt')).toBe('ok');
    await waitFor(() => t.master.engine.activeRunIds.length === 0, 'the slots to be free');
  });

  it('still executes one Run of a repo at a time', async () => {
    h = await harness();
    const t = h;
    addRepo(t, 'other');
    const log = statusLog(t);
    const release = slowCoder(t);
    const first = runIn(t, 'demo');
    const second = runIn(t, 'demo', '第二个');
    const third = runIn(t, 'other');
    await waitFor(() => t.fake.calls.length === 2, 'two coders to start');
    expect(t.master.engine.activeRunIds).toEqual([first.id, third.id]);
    expect(status(t, second)).toBe('queued');

    release();
    await t.waitStatus(second.id, 'completed');
    await t.waitStatus(third.id, 'completed');
    // The second started only once the first of its repo was done.
    expect(log.indexOf(`${second.id}:running`)).toBeGreaterThan(
      log.indexOf(`${first.id}:completed`),
    );
    expect(git(t.repoDir, 'show', 'main:feature.txt')).toBe('ok');
  });

  it('shares one execution slot between repos registered on the same path', async () => {
    h = await harness();
    const t = h;
    git(t.repoDir, 'branch', 'release');
    // The same git repository through a symlink, merging into another branch.
    const link = join(tmpDir(), 'link');
    symlinkSync(t.repoDir, link);
    addRepo(t, 'release', link, 'release');
    const log = statusLog(t);
    const release = slowCoder(t);
    const first = runIn(t, 'demo');
    const second = runIn(t, 'release');
    await waitFor(() => t.fake.calls.length === 1, 'the first coder to start');
    // Kicking again starts nothing: the second waits for the slot of the same path.
    t.master.engine.kick();
    expect(status(t, second)).toBe('queued');
    expect(t.master.engine.activeRunIds).toEqual([first.id]);

    release();
    await t.waitStatus(first.id, 'completed');
    await t.waitStatus(second.id, 'completed');
    expect(log.indexOf(`${second.id}:running`)).toBeGreaterThan(
      log.indexOf(`${first.id}:completed`),
    );
    expect(git(t.repoDir, 'show', 'release:feature.txt')).toBe('ok');
  });

  it("pausing or cancelling a Run leaves the other repo's executing Run alone", async () => {
    h = await harness();
    const t = h;
    addRepo(t, 'other');
    const release = slowCoder(t);
    const first = runIn(t, 'demo');
    const second = runIn(t, 'other');
    await waitFor(() => t.fake.calls.length === 2, 'both coders to start');
    const attempts = (run: Run) => t.master.store.listRunAttempts(run.id).map((a) => a.status);

    await t.master.engine.pause(first.id);
    expect(status(t, first)).toBe('paused');
    expect(attempts(first)).toEqual(['stopped']);
    expect(status(t, second)).toBe('running');
    expect(attempts(second)).toEqual(['running']);
    expect(t.master.engine.activeRunIds).toEqual([second.id]);

    // Resumed, it gets its repo's slot back at once while the other still executes.
    t.master.engine.resume(first.id);
    await waitFor(() => t.fake.calls.length === 3, 'the resumed coder to start');
    expect(t.master.engine.activeRunIds).toEqual([second.id, first.id]);

    await t.master.engine.cancel(second.id);
    expect(status(t, second)).toBe('cancelled');
    expect(status(t, first)).toBe('running');
    expect(attempts(first)).toEqual(['stopped', 'running']);
    expect(t.master.engine.activeRunIds).toEqual([first.id]);

    release();
    await t.waitStatus(first.id, 'completed');
    expect(git(t.repoDir, 'show', 'main:feature.txt')).toBe('ok');
  });

  it('a graceful stop requeues every executing Run at the head of the queue in order', async () => {
    const first = await harness();
    const otherPath = initRepo();
    addRepo(first, 'other', otherPath);
    slowCoder(first);
    const a = runIn(first, 'demo', '第一个');
    const b = runIn(first, 'other', '第二个');
    // Queued behind the first, in the slot of its repo.
    const c = runIn(first, 'demo', '第三个');
    await waitFor(() => first.fake.calls.length === 2, 'both coders to start');
    // Nothing starts when the next Master opens, so that its queue can be looked at.
    first.master.engine.setWorking(false);
    await first.close();

    h = await harness({
      home: first.home,
      repoDir: first.repoDir,
      scripts: { coder, reviewer: () => review() },
    });
    const t = h;
    expect(t.master.store.queuedRuns().map((r) => r.id)).toEqual([a.id, b.id, c.id]);
    for (const run of [a, b]) {
      const events = t.master.store.listEvents(run.id).map((e) => e.type);
      expect(events).toContain('run.interrupted');
      expect(t.master.store.listRunAttempts(run.id).map((x) => x.status)).toEqual(['stopped']);
    }

    t.master.engine.setWorking(true);
    expect(t.master.engine.activeRunIds).toEqual([a.id, b.id]);
    for (const run of [a, b, c]) await t.waitStatus(run.id, 'completed');
    expect(git(t.repoDir, 'show', 'main:feature.txt')).toBe('ok');
    expect(git(otherPath, 'show', 'main:feature.txt')).toBe('ok');
  });
});

describe('engine: workspace consistency', () => {
  const eventsOf = (runId: string, type: string) =>
    (h as Harness).master.store.listEvents(runId).filter((e) => e.type === type);
  /** The Run waits for its merge approval; it is checked when the approval gives it the slot. */
  const waitingForMerge = async () => {
    const harnessed = h as Harness;
    const run = harnessed.run();
    const waiting = await harnessed.waitStatus(run.id, 'waiting_approval');
    return { run, worktree: waiting.worktreePath as string, branch: waiting.branch as string };
  };
  /** Ended as failed without waiting for a human: the next Run starts. */
  const expectNothingWaits = async (runId: string) => {
    const harnessed = h as Harness;
    expect(eventsOf(runId, 'run.blocked')).toEqual([]);
    await harnessed.waitStatus(harnessed.run('下一个').id, 'waiting_approval');
  };
  /**
   * A Run an older Master blocked on its worktree, as it did whenever the check failed: approved
   * for merging, then blocked before it went on.
   */
  const blockedOnWorkspace = async () => {
    const { engine, store } = (h as Harness).master;
    const ready = await waitingForMerge();
    store.setWorking(false);
    engine.approve(ready.run.id);
    store.updateRun(ready.run.id, {
      status: 'blocked',
      queuePos: null,
      blocked: {
        kind: 'workspace',
        message: '工作目录不存在了。重试会以工作目录当前的提交为准继续',
      },
    });
    store.setWorking(true);
    return ready;
  };

  it('brings a deleted worktree back from the branch and goes on, waiting for nobody', async () => {
    h = await harness();
    const { run, worktree, branch } = await waitingForMerge();
    const head = h.master.store.getRun(run.id).headCommit;
    rmSync(worktree, { recursive: true, force: true });
    h.master.engine.approve(run.id);
    const done = await h.waitStatus(run.id, 'completed');
    expect(eventsOf(run.id, 'run.workspace_restored').map((e) => e.data)).toEqual([
      { path: worktree, branch },
    ]);
    expect(eventsOf(run.id, 'run.blocked')).toEqual([]);
    expect(h.master.store.listEvents(run.id).some((e) => e.data.status === 'blocked')).toBe(false);
    // The records stay: the branch holds every commit the Master accepted.
    expect(done.headCommit).toBe(head);
    expect(git(h.repoDir, 'show', 'main:feature.txt')).toBe('ok');
  });

  it('ends the Run as failed when the history was reset by hand', async () => {
    h = await harness();
    const { run, worktree } = await waitingForMerge();
    const before = h.master.store.getRun(run.id);
    git(worktree, 'reset', '-q', '--hard', before.baseCommit as string);
    h.master.engine.approve(run.id);
    const failed = await h.waitStatus(run.id, 'failed');
    expect(failed.blocked).toBeNull();
    expect(failed.finishedAt).toBeTruthy();
    expect(failed.error).toBe(
      `工作目录的提交历史和记录不一致：Master 记录的最新提交 ${(before.headCommit as string).slice(0, 8)} 已不在当前分支上（可能被手动重置或改写过）\nRun 结束，工作目录和分支已保留。`,
    );
    // Nothing was merged, and the worktree is left as it was found.
    expect(failed.headCommit).toBe(before.headCommit);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(before.baseCommit);
    expect(git(h.repoDir, 'rev-parse', 'main')).toBe(before.baseCommit);
    expect(eventsOf(run.id, 'run.workspace_restored')).toEqual([]);
    await expectNothingWaits(run.id);
  });

  it('ends the Run as failed when the worktree is on another branch', async () => {
    h = await harness();
    const { run, worktree, branch } = await waitingForMerge();
    git(worktree, 'checkout', '-q', '-b', 'elsewhere');
    h.master.engine.approve(run.id);
    const failed = await h.waitStatus(run.id, 'failed');
    expect(failed.error).toBe(
      `工作目录当前不在 Run 的分支 ${branch} 上（现在是 elsewhere）\nRun 结束，工作目录和分支已保留。`,
    );
    await expectNothingWaits(run.id);
  });

  it('ends the Run as failed when the branch is gone with the worktree', async () => {
    h = await harness();
    const { run, worktree, branch } = await waitingForMerge();
    rmSync(worktree, { recursive: true, force: true });
    git(h.repoDir, 'worktree', 'prune');
    git(h.repoDir, 'branch', '-q', '-D', branch);
    h.master.engine.approve(run.id);
    const failed = await h.waitStatus(run.id, 'failed');
    expect(failed.error).toBe(
      `工作目录 ${worktree} 不存在了，Run 的分支 ${branch} 也不在了，无法恢复\nRun 结束。`,
    );
    expect(existsSync(worktree)).toBe(false);
    await expectNothingWaits(run.id);
  });

  it('ends the Run as failed when the worktree cannot be restored, keeping the branch', async () => {
    h = await harness();
    const { run, worktree, branch } = await waitingForMerge();
    rmSync(worktree, { recursive: true, force: true });
    git(h.repoDir, 'worktree', 'prune');
    // Checked out somewhere else, the branch cannot be checked out again where it was.
    const elsewhere = join(tmpDir(), 'elsewhere');
    git(h.repoDir, 'worktree', 'add', '-q', elsewhere, branch);
    h.master.engine.approve(run.id);
    const failed = await h.waitStatus(run.id, 'failed');
    const error = failed.error as string;
    expect(error.slice(0, error.indexOf('：') + 1)).toBe(
      `工作目录 ${worktree} 不存在了，从分支 ${branch} 恢复失败：`,
    );
    expect(error).toMatch(/恢复失败：git .*worktree add/);
    expect(error.slice(error.lastIndexOf('\n'))).toBe(`\nRun 结束，分支 ${branch} 已保留。`);
    expect(eventsOf(run.id, 'run.workspace_restored')).toEqual([]);
    await expectNothingWaits(run.id);
  });

  it('still retries a Run an older Master blocked on its worktree', async () => {
    h = await harness();
    const { run, worktree } = await blockedOnWorkspace();
    rmSync(worktree, { recursive: true, force: true });
    await h.master.engine.retry(run.id);
    // The retry itself brought the worktree back.
    expect(existsSync(worktree)).toBe(true);
    await h.waitStatus(run.id, 'completed');
    expect(eventsOf(run.id, 'run.retry').map((e) => e.data.kind)).toEqual(['workspace']);
    expect(git(h.repoDir, 'show', 'main:feature.txt')).toBe('ok');
  });

  it('a retry does nothing when the Run is cancelled while it restores the worktree', async () => {
    h = await harness();
    const { engine, store } = h.master;
    const { run, worktree } = await blockedOnWorkspace();
    rmSync(worktree, { recursive: true, force: true });
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
    const { run, worktree } = await blockedOnWorkspace();
    const base = store.getRun(run.id).baseCommit as string;
    git(worktree, 'reset', '-q', '--hard', base);

    const results = await Promise.allSettled([engine.retry(run.id), engine.retry(run.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(InvalidStateError);
    expect(String(rejected[0]?.reason)).toMatch(/这次重试没有生效/);

    // The human chose to continue from the worktree's current commit.
    const done = await h.waitStatus(run.id, 'completed');
    expect(done.headCommit).toBe(base);
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

  describe('in English', () => {
    afterEach(() => setLang('zh'));

    it('says why the worktree cannot be trusted without Chinese', async () => {
      h = await harness({ config: 'language: en\n' });
      const reset = await waitingForMerge();
      const before = h.master.store.getRun(reset.run.id);
      git(reset.worktree, 'reset', '-q', '--hard', before.baseCommit as string);
      h.master.engine.approve(reset.run.id);
      const diverged = await h.waitStatus(reset.run.id, 'failed');
      expect(diverged.error).toBe(
        `The working directory's history does not match the records: the latest commit the Master recorded, ${(before.headCommit as string).slice(0, 8)}, is no longer on the branch (it may have been reset or rewritten by hand)\nThe Run ended; the working directory and branch are kept.`,
      );

      const moved = await waitingForMerge();
      git(moved.worktree, 'checkout', '-q', '--detach');
      h.master.engine.approve(moved.run.id);
      const detached = await h.waitStatus(moved.run.id, 'failed');
      expect(detached.error).toBe(
        `The working directory is not on the Run's branch ${moved.branch} (it is on a detached HEAD)\nThe Run ended; the working directory and branch are kept.`,
      );

      const gone = await waitingForMerge();
      rmSync(gone.worktree, { recursive: true, force: true });
      git(h.repoDir, 'worktree', 'prune');
      git(h.repoDir, 'branch', '-q', '-D', gone.branch);
      h.master.engine.approve(gone.run.id);
      const missing = await h.waitStatus(gone.run.id, 'failed');
      expect(missing.error).toBe(
        `The working directory ${gone.worktree} is gone, and so is the Run's branch ${gone.branch}; it cannot be restored\nThe Run ended.`,
      );
      for (const error of [diverged.error, detached.error, missing.error]) {
        expect(error).not.toMatch(/[一-鿿]/);
      }
    });
  });
});

describe('engine: workspaces of superseded and exhausted attempts', () => {
  /** Coding → merge without approval; an agent error ends the Run as failed at once. */
  const WORKFLOW = `
id: dev
name: 测试流程
defaults:
  escalate:
    max_retries: 0
    on_agent_error: retry
stages:
  - id: implement
    name: 编码
    kind: agent
    agent: coder
  - id: merge
    name: 合并
    kind: merge
`;
  const CONFIG = `
github:
  repos:
    demo:
      template: dev
`;
  let gh: FakeGitHub;
  const start = async () => {
    gh = new FakeGitHub();
    h = await harness({ config: CONFIG, github: gh, workflow: WORKFLOW });
    return h;
  };

  /** The Runs of issue #n, oldest first. */
  const runsOf = (t: Harness, n: number) =>
    t.master.store
      .listRuns()
      .filter((r) => r.issue?.number === n)
      .reverse();
  const nth = (t: Harness, n: number, i: number) => {
    const run = runsOf(t, n)[i];
    if (!run) throw new Error(`no run ${i} for #${n}`);
    return run;
  };
  const eventData = (t: Harness, runId: string, type: string) =>
    t.master.store
      .listEvents(runId)
      .filter((e) => e.type === type)
      .map((e) => e.data);
  /** Redo the failed Runs of the issues, as if the longest wait before a redo had passed. */
  const redo = async (t: Harness) => {
    const { store } = t.master;
    for (const r of store.listRuns({ status: 'failed' })) {
      if (!r.finishedAt) continue;
      const ms = REDO_BACKOFF_MAX_HOURS * 3_600_000;
      store.updateRun(r.id, { finishedAt: new Date(Date.parse(r.finishedAt) - ms).toISOString() });
    }
    await t.master.issues.sync();
  };
  /** Completed, and done with what follows: the execution slot is free again. */
  const completed = async (t: Harness, runId: string) => {
    await t.waitStatus(runId, 'completed');
    await waitFor(() => t.master.engine.activeRunIds.length === 0, 'the execution slot');
    return t.master.store.getRun(runId);
  };
  /** Whether the Run's worktree and branch are still there. */
  const kept = (t: Harness, run: Run) => ({
    worktree: existsSync(run.worktreePath as string),
    branch: git(t.repoDir, 'branch', '--list', run.branch as string) !== '',
  });

  it("removes the worktrees and branches of an issue's failed attempts once a redo completes", async () => {
    const t = await start();
    const { engine, issues, store } = t.master;
    let coder: 'hang' | 'fail' | 'ok' = 'hang';
    t.scripts.coder = (ctx) => {
      if (coder === 'hang') return new Promise(() => {});
      if (coder === 'fail') return { status: 'failed', error: '模型额度用完了' };
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return done('写了 feature.txt');
    };

    // #1: a human cancels the first Run and starts the issue over with ares1:ready.
    gh.add({ title: '加 feature', body: '写 feature.txt', labels: [LABELS.ready] });
    await issues.poll();
    await waitFor(() => t.fake.calls.length === 1, 'the coder');
    await engine.cancel(nth(t, 1, 0).id);
    await issues.sync();
    coder = 'fail';
    gh.get(1).labels.push(LABELS.ready);
    // #2: another issue whose Run fails too, closed before it is redone.
    gh.add({ title: '另一个需求', labels: [LABELS.ready] });
    await issues.poll();
    const first = await t.waitStatus(nth(t, 1, 1).id, 'failed');
    const other = await t.waitStatus(nth(t, 2, 0).id, 'failed');
    // And a failed Run that does not come from an issue.
    const loose = await t.waitStatus(t.run('不是从 issue 来的').id, 'failed');
    await issues.sync();
    gh.get(2).state = 'closed';
    coder = 'ok';
    await redo(t);

    const second = nth(t, 1, 2);
    expect(second.issue?.attempt).toBe(2);
    const cancelled = store.getRun(nth(t, 1, 0).id);
    expect(cancelled.status).toBe('cancelled');
    for (const run of [first, other, loose, cancelled]) {
      expect(kept(t, run)).toEqual({ worktree: true, branch: true });
    }
    expect((await completed(t, second.id)).status).toBe('completed');

    // The failed attempt it superseded is gone, records and events kept.
    expect(kept(t, first)).toEqual({ worktree: false, branch: false });
    expect(git(t.repoDir, 'worktree', 'list', '--porcelain')).not.toContain(first.branch);
    expect(eventData(t, first.id, 'workspace.removed')).toEqual([
      {
        path: first.worktreePath,
        branch: first.branch,
        reason: 'superseded',
        supersededBy: second.id,
      },
    ]);
    expect(store.getRun(first.id)).toMatchObject({ status: 'failed', error: first.error });
    // The cancelled Run of the issue, another issue's and one not from an issue stay as they are.
    for (const run of [cancelled, other, loose]) {
      expect(kept(t, run)).toEqual({ worktree: true, branch: true });
      expect(eventData(t, run.id, 'workspace.removed')).toEqual([]);
    }
    // The completed Run's own workspace went once merged, as always.
    expect(eventData(t, second.id, 'workspace.removed')).toEqual([{}]);
    expect(git(t.repoDir, 'show', 'main:feature.txt')).toBe('ok');
  });

  it('records a failed attempt it cannot clean up and leaves the redo completed', async () => {
    const t = await start();
    const { issues, store } = t.master;
    let calls = 0;
    t.scripts.coder = (ctx) => {
      if (++calls === 1) return { status: 'failed', error: '模型额度用完了' };
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return done('写了 feature.txt');
    };
    gh.add({ title: '加 feature', labels: [LABELS.ready] });
    await issues.poll();
    const first = await t.waitStatus(nth(t, 1, 0).id, 'failed');
    // Its branch is checked out elsewhere too, so git refuses to delete it.
    const elsewhere = join(tmpDir(), 'elsewhere');
    git(t.repoDir, 'worktree', 'add', '-q', '-f', elsewhere, first.branch as string);
    await issues.sync();
    await redo(t);

    const second = nth(t, 1, 1);
    expect((await completed(t, second.id)).status).toBe('completed');
    expect(eventData(t, first.id, 'workspace.removed')).toEqual([]);
    expect(eventData(t, first.id, 'workspace.cleanup_failed')).toEqual([
      {
        reason: 'superseded',
        supersededBy: second.id,
        error: expect.stringContaining(`分支 ${first.branch}`),
      },
    ]);
    expect(kept(t, first)).toEqual({ worktree: false, branch: true });
    expect(store.getRun(first.id).status).toBe('failed');
    expect(eventData(t, second.id, 'run.status').at(-1)).toEqual({ status: 'completed' });
    await issues.sync();
    expect(gh.get(1)).toMatchObject({ state: 'closed', stateReason: 'completed' });
  });

  /** Fail every attempt the issue gets (`max_run_attempts`, 3 by default); oldest first. */
  const failAllAttempts = async (t: Harness, n: number, from: number): Promise<Run[]> => {
    const attempts: Run[] = [];
    for (let i = from; i < from + 3; i++) {
      attempts.push(await t.waitStatus(nth(t, n, i).id, 'failed'));
      await redo(t);
    }
    return attempts;
  };

  it("keeps only the last attempt's worktree and branch once an issue used up its attempts", async () => {
    const t = await start();
    const { engine, issues, store } = t.master;
    let coder: 'hang' | 'fail' = 'hang';
    t.scripts.coder = () => {
      if (coder === 'hang') return new Promise(() => {});
      return { status: 'failed', error: '模型额度用完了' };
    };

    // #1: a human cancels the first Run and starts the issue over with ares1:ready.
    gh.add({ title: '加 feature', labels: [LABELS.ready] });
    await issues.poll();
    await waitFor(() => t.fake.calls.length === 1, 'the coder');
    await engine.cancel(nth(t, 1, 0).id);
    await issues.sync();
    coder = 'fail';
    gh.get(1).labels.push(LABELS.ready);
    // #2: another issue whose Run fails too, closed before it is redone.
    gh.add({ title: '另一个需求', labels: [LABELS.ready] });
    await issues.poll();
    const other = await t.waitStatus(nth(t, 2, 0).id, 'failed');
    // And a failed Run that does not come from an issue.
    const loose = await t.waitStatus(t.run('不是从 issue 来的').id, 'failed');
    await issues.sync();
    gh.get(2).state = 'closed';
    const [first, second, last] = (await failAllAttempts(t, 1, 1)) as [Run, Run, Run];

    expect(last.issue?.attempt).toBe(3);
    expect(gh.get(1)).toMatchObject({ state: 'closed', stateReason: 'not_planned' });
    expect(eventData(t, last.id, 'issue.retries_exhausted')).toEqual([
      expect.objectContaining({ runIds: [first.id, second.id, last.id] }),
    ]);
    // The last attempt keeps its worktree and branch for a human to look at.
    expect(kept(t, last)).toEqual({ worktree: true, branch: true });
    expect(eventData(t, last.id, 'workspace.removed')).toEqual([]);
    // The earlier ones are gone, records, logs and artifacts kept.
    for (const run of [first, second]) {
      expect(kept(t, run)).toEqual({ worktree: false, branch: false });
      expect(git(t.repoDir, 'worktree', 'list', '--porcelain')).not.toContain(run.branch);
      expect(eventData(t, run.id, 'workspace.removed')).toEqual([
        {
          path: run.worktreePath,
          branch: run.branch,
          reason: 'retries_exhausted',
          keptRun: last.id,
        },
      ]);
      expect(store.getRun(run.id)).toMatchObject({ status: 'failed', error: run.error });
      const attempts = store.listRunAttempts(run.id);
      expect(attempts.length).toBeGreaterThan(0);
      for (const a of attempts) expect(existsSync(a.logPath)).toBe(true);
    }
    // The cancelled Run of the issue, another issue's and one not from an issue stay as they are.
    const cancelled = store.getRun(nth(t, 1, 0).id);
    expect(cancelled.status).toBe('cancelled');
    for (const run of [cancelled, other, loose]) {
      expect(kept(t, run)).toEqual({ worktree: true, branch: true });
      expect(eventData(t, run.id, 'workspace.removed')).toEqual([]);
    }
    // Even when named, they are not the issue's failed attempts.
    await engine.removeExhaustedAttempts(last.id, [cancelled.id, other.id, loose.id, last.id]);
    for (const run of [cancelled, other, loose, last]) {
      expect(kept(t, run)).toEqual({ worktree: true, branch: true });
    }

    // Catching up again: no second comment, nothing more removed or recorded.
    const comments = gh.get(1).comments.length;
    await issues.sync();
    await engine.removeExhaustedAttempts(last.id, [first.id, second.id]);
    expect(gh.get(1).comments).toHaveLength(comments);
    for (const run of [first, second]) {
      expect(eventData(t, run.id, 'workspace.removed')).toHaveLength(1);
      expect(eventData(t, run.id, 'workspace.cleanup_failed')).toEqual([]);
    }
  });

  it('records an earlier attempt it cannot clean up and still closes the issue once', async () => {
    const t = await start();
    const { issues, store } = t.master;
    t.scripts.coder = () => ({ status: 'failed', error: '模型额度用完了' });
    gh.add({ title: '加 feature', labels: [LABELS.ready] });
    await issues.poll();
    const first = await t.waitStatus(nth(t, 1, 0).id, 'failed');
    // Its branch is checked out elsewhere too, so git refuses to delete it.
    const elsewhere = join(tmpDir(), 'elsewhere');
    git(t.repoDir, 'worktree', 'add', '-q', '-f', elsewhere, first.branch as string);
    const [, second, last] = (await failAllAttempts(t, 1, 0)) as [Run, Run, Run];

    expect(eventData(t, first.id, 'workspace.removed')).toEqual([]);
    expect(eventData(t, first.id, 'workspace.cleanup_failed')).toEqual([
      {
        reason: 'retries_exhausted',
        keptRun: last.id,
        error: expect.stringContaining(`分支 ${first.branch}`),
      },
    ]);
    expect(kept(t, first)).toEqual({ worktree: false, branch: true });
    expect(store.getRun(first.id).status).toBe('failed');
    // The next one is removed all the same, the last one kept.
    expect(kept(t, second)).toEqual({ worktree: false, branch: false });
    expect(kept(t, last)).toEqual({ worktree: true, branch: true });

    const issue = gh.get(1);
    expect(issue).toMatchObject({ state: 'closed', stateReason: 'not_planned' });
    const exhausted = issue.comments.filter((c) => c.includes(RETRIES_EXHAUSTED_MARKER));
    expect(exhausted).toHaveLength(1);
    const comments = issue.comments.length;
    await issues.sync();
    expect(gh.get(1).comments).toHaveLength(comments);
    expect(eventData(t, first.id, 'workspace.cleanup_failed')).toHaveLength(1);
  });

  /** Close the Master and open another on the same home, repo and GitHub. */
  const restart = async (t: Harness) => {
    await t.close();
    h = await harness({
      config: CONFIG,
      github: gh,
      workflow: WORKFLOW,
      home: t.home,
      repoDir: t.repoDir,
    });
    return h;
  };
  const removedAtStart = (t: Harness, runIds: string[]) =>
    waitFor(
      () => runIds.every((id) => eventData(t, id, 'workspace.removed').length > 0),
      'the leftover workspaces to be removed',
    );

  it('removes at the next start the failed attempt a redo completed after, when the Master stopped first', async () => {
    const t = await start();
    const { engine, issues, store } = t.master;
    let calls = 0;
    t.scripts.coder = (ctx) => {
      if (++calls === 1) return { status: 'failed', error: '模型额度用完了' };
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return done('写了 feature.txt');
    };
    gh.add({ title: '加 feature', labels: [LABELS.ready] });
    await issues.poll();
    const first = await t.waitStatus(nth(t, 1, 0).id, 'failed');
    await issues.sync();
    // The Master stops the moment the redo completes, before it removes the earlier attempt.
    store.bus.on('event', (e) => {
      if (e.type === 'run.status' && e.data.status === 'completed') void engine.stop();
    });
    await redo(t);
    const second = await completed(t, nth(t, 1, 1).id);
    expect(second.status).toBe('completed');
    expect(kept(t, first)).toEqual({ worktree: true, branch: true });
    expect(eventData(t, first.id, 'workspace.removed')).toEqual([]);

    const next = await restart(t);
    await removedAtStart(next, [first.id]);
    expect(kept(next, first)).toEqual({ worktree: false, branch: false });
    expect(eventData(next, first.id, 'workspace.removed')).toEqual([
      {
        path: first.worktreePath,
        branch: first.branch,
        reason: 'superseded',
        supersededBy: second.id,
      },
    ]);
    expect(next.master.store.getRun(first.id)).toMatchObject({
      status: 'failed',
      error: first.error,
    });
  });

  it('keeps only the last attempt at the next start when the issue was caught up but nothing removed', async () => {
    const t = await start();
    const { engine, issues, store } = t.master;
    t.scripts.coder = () => ({ status: 'failed', error: '模型额度用完了' });
    // The Master stops right after the issue is caught up, before it removes anything.
    const removal = vi.spyOn(engine, 'removeExhaustedAttempts').mockResolvedValue();
    gh.add({ title: '加 feature', labels: [LABELS.ready] });
    await issues.poll();
    const [first, second, last] = (await failAllAttempts(t, 1, 0)) as [Run, Run, Run];
    expect(removal).toHaveBeenCalledTimes(1);
    expect(store.getRun(last.id).issueSynced).toBe('failed');
    expect(gh.get(1)).toMatchObject({ state: 'closed', stateReason: 'not_planned' });
    for (const run of [first, second, last]) {
      expect(kept(t, run)).toEqual({ worktree: true, branch: true });
    }

    const next = await restart(t);
    await removedAtStart(next, [first.id, second.id]);
    for (const run of [first, second]) {
      expect(kept(next, run)).toEqual({ worktree: false, branch: false });
      expect(eventData(next, run.id, 'workspace.removed')).toEqual([
        {
          path: run.worktreePath,
          branch: run.branch,
          reason: 'retries_exhausted',
          keptRun: last.id,
        },
      ]);
    }
    expect(kept(next, last)).toEqual({ worktree: true, branch: true });
    expect(eventData(next, last.id, 'workspace.removed')).toEqual([]);
  });

  it('removes the worktree of a Run terminated for a changed issue that was not removed then', async () => {
    const t = await start();
    const { engine, issues, store } = t.master;
    // Every Run keeps coding until it is stopped.
    let calls = 0;
    t.scripts.coder = () => {
      calls++;
      return new Promise(() => {});
    };
    // The Master stops after the comment, before it removes the old Run's worktree.
    const removal = vi.spyOn(engine, 'removeGoalChangedWorkspace').mockResolvedValue();
    gh.add({ title: '加 feature', body: '旧写法照旧能用', labels: [LABELS.ready] });
    await issues.poll();
    await waitFor(() => calls === 1, 'the coder');
    await issues.sync();
    const old = store.getRun(nth(t, 1, 0).id);
    gh.get(1).body = '不保留旧写法';
    await issues.poll();
    const changed = nth(t, 1, 1);
    expect(store.getRun(old.id).status).toBe('cancelled');
    expect(removal).toHaveBeenCalledWith(old.id, changed.id);
    expect(kept(t, old)).toEqual({ worktree: true, branch: true });
    // The new Run executes meanwhile.
    await waitFor(() => calls === 2, 'the new Run to code');
    const running = store.getRun(changed.id);
    expect(running.status).toBe('running');

    await engine.sweepLeftoverWorkspaces();
    expect(kept(t, old)).toEqual({ worktree: false, branch: false });
    expect(eventData(t, old.id, 'workspace.removed')).toEqual([
      { path: old.worktreePath, branch: old.branch, reason: 'goal_changed', newRun: changed.id },
    ]);
    // The executing Run is not touched.
    expect(store.getRun(changed.id).status).toBe('running');
    expect(kept(t, running)).toEqual({ worktree: true, branch: true });
    expect(eventData(t, changed.id, 'workspace.removed')).toEqual([]);
  });

  it('leaves Runs a human terminated, unfinished Runs and last attempts alone, and records each removal once', async () => {
    const t = await start();
    const { engine, issues, store } = t.master;
    let coder: 'hang' | 'fail' = 'fail';
    let hangs = 0;
    t.scripts.coder = () => {
      if (coder === 'fail') return { status: 'failed', error: '模型额度用完了' };
      hangs++;
      return new Promise(() => {});
    };

    // #1 uses up its attempts; the first one's branch is checked out elsewhere, so its removal
    // fails and is recorded.
    gh.add({ title: '用完重做次数', labels: [LABELS.ready] });
    await issues.poll();
    const blocked = await t.waitStatus(nth(t, 1, 0).id, 'failed');
    const elsewhere = join(tmpDir(), 'elsewhere');
    git(t.repoDir, 'worktree', 'add', '-q', '-f', elsewhere, blocked.branch as string);
    const [, , last] = (await failAllAttempts(t, 1, 0)) as [Run, Run, Run];
    expect(eventData(t, blocked.id, 'workspace.cleanup_failed')).toHaveLength(1);
    // #2: a human terminates its Run, then starts the issue over; the new Run fails, its redo
    // still to come.
    coder = 'hang';
    gh.add({ title: '人终止过', labels: [LABELS.ready] });
    await issues.poll();
    await waitFor(() => hangs === 1, 'the coder');
    const cancelled = await engine.cancel(nth(t, 2, 0).id);
    await issues.sync();
    coder = 'fail';
    gh.get(2).labels.push(LABELS.ready);
    await issues.poll();
    const pending = await t.waitStatus(nth(t, 2, 1).id, 'failed');
    await issues.sync();
    expect(store.getRun(pending.id).issue?.redo).toBe('pending');
    // #3 executes meanwhile.
    coder = 'hang';
    gh.add({ title: '还在做', labels: [LABELS.ready] });
    await issues.poll();
    await waitFor(() => hangs === 2, 'the coder of #3');
    const running = store.getRun(nth(t, 3, 0).id);
    expect(running.status).toBe('running');

    const untouched = [last, cancelled, pending, running];
    const counts = () =>
      [blocked, ...untouched].map((r) => [
        eventData(t, r.id, 'workspace.removed').length,
        eventData(t, r.id, 'workspace.cleanup_failed').length,
      ]);
    const check = () => {
      for (const run of untouched) {
        expect(kept(t, store.getRun(run.id))).toEqual({ worktree: true, branch: true });
        expect(eventData(t, run.id, 'workspace.removed')).toEqual([]);
        expect(eventData(t, run.id, 'workspace.cleanup_failed')).toEqual([]);
      }
      expect(store.getRun(running.id).status).toBe('running');
    };

    // Still checked out elsewhere: tried again, recorded again, nothing thrown.
    await engine.sweepLeftoverWorkspaces();
    expect(eventData(t, blocked.id, 'workspace.cleanup_failed')).toEqual([
      expect.objectContaining({ reason: 'retries_exhausted', keptRun: last.id }),
      {
        reason: 'retries_exhausted',
        keptRun: last.id,
        error: expect.stringContaining(`分支 ${blocked.branch}`),
      },
    ]);
    expect(eventData(t, blocked.id, 'workspace.removed')).toEqual([]);
    check();

    // Free again: removed this time.
    git(t.repoDir, 'worktree', 'remove', '--force', elsewhere);
    await engine.sweepLeftoverWorkspaces();
    expect(kept(t, blocked)).toEqual({ worktree: false, branch: false });
    expect(eventData(t, blocked.id, 'workspace.removed')).toEqual([
      {
        path: blocked.worktreePath,
        branch: blocked.branch,
        reason: 'retries_exhausted',
        keptRun: last.id,
      },
    ]);
    check();

    // Nothing left: calling it again records nothing more.
    const before = counts();
    await engine.sweepLeftoverWorkspaces();
    await engine.sweepLeftoverWorkspaces();
    expect(counts()).toEqual(before);
    check();
  });
});

describe('engine: planning: llm', () => {
  const eventData = (runId: string, type: string) =>
    (h as Harness).master.store
      .listEvents(runId)
      .filter((e) => e.type === type)
      .map((e) => e.data);
  /** Coding split into steps by its own agent, review, then merging without approval. */
  const PLANNED_WORKFLOW = `
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
    planning: llm
    instructions: 实现 {{goal}}
  - id: review
    name: 评审
    kind: review
    agent: reviewer
    inputs: [diff]
    on_fail: implement
  - id: merge
    name: 合并
    kind: merge
    on_reject: implement
`;
  /** What a planner reports: one step per title, each writing a file named after it. */
  const plan = (titles: string[]): FakeOutcome => ({
    finalMessage: `拆好了。\n\`\`\`json\n${JSON.stringify({
      tasks: titles.map((title) => ({ title, instructions: `写 ${title}.txt` })),
    })}\n\`\`\``,
  });
  /**
   * The coder: read-only it plans `titles`; otherwise it does the step its prompt names, writing
   * the file the step's instructions say and feature.txt, which the verify command looks for.
   */
  const planner = (titles: string[]): Script => {
    let calls = 0;
    return (ctx) => {
      if (ctx.input.readOnly) return plan(titles);
      calls++;
      const file = /写 (\S+\.txt)/.exec(ctx.input.prompt)?.[1] ?? 'unknown.txt';
      writeFile(join(ctx.input.workdir, file), `step ${calls}\n`);
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return done(`写了 ${file}`);
    };
  };
  const implementRounds = (runId: string) =>
    (h as Harness).master.store.listStageRuns(runId).filter((sr) => sr.stageId === 'implement');
  const tasksOf = (stageRunId: string) =>
    (h as Harness).master.store
      .listTasks(stageRunId)
      .map((task) => [task.kind, task.title, task.status]);

  it('plans read-only, then executes, checks and commits each step in order', async () => {
    h = await harness({
      workflow: PLANNED_WORKFLOW,
      scripts: { coder: planner(['a', 'b', 'c']), reviewer: () => review() },
    });
    const run = h.run();
    await h.waitStatus(run.id, 'completed');
    const store = h.master.store;

    // One read-only plan, then the three steps, each in a session of its own, then the review.
    expect(h.fake.calls.map((c) => [c.model, c.readOnly === true])).toEqual([
      ['coder', true],
      ['coder', false],
      ['coder', false],
      ['coder', false],
      ['reviewer', false],
    ]);
    const [planCall, ...stepCalls] = h.fake.calls;
    expect(planCall?.prompt).toContain('「任务拆分」Agent');
    expect(planCall?.prompt).toContain('## 阶段要求\n\n实现 添加 feature.txt');
    expect(planCall?.outputSchema).toEqual(PLAN_REPORT_JSON_SCHEMA);
    expect(planCall?.permission).toBe('safe');
    expect(stepCalls[0]?.prompt).toContain('## 当前阶段：编码\n\n实现 添加 feature.txt');
    expect(stepCalls[0]?.prompt).toContain('## 这一步：第 1 步（共 3 步）「a」');
    expect(stepCalls[1]?.prompt).toContain('1. a（已完成）\n2. b ← 这一步\n3. c');
    expect(stepCalls[2]?.prompt).toContain('这次只做这一步：\n\n写 c.txt');
    expect(stepCalls.slice(0, 3).map((c) => c.resumeSessionId)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);

    const [implement] = implementRounds(run.id) as [StageRun];
    expect(tasksOf(implement.id)).toEqual([
      ['plan', '拆分任务', 'passed'],
      ['work', 'a', 'passed'],
      ['work', 'b', 'passed'],
      ['work', 'c', 'passed'],
    ]);
    const [planTask, ...work] = store.listTasks(implement.id) as [Task, ...Task[]];
    expect(eventData(run.id, 'stage.planned')).toEqual([
      { stageId: 'implement', round: 1, taskId: planTask.id, tasks: ['a', 'b', 'c'] },
    ]);

    // The plan runs no verify command and commits nothing; each step does both on its own.
    const checks = store.listChecks(run.id);
    const checksOf = (task: Task) => {
      const ids = new Set(store.listAttempts(task.id).map((a) => a.id));
      return checks.filter((c) => c.attemptId && ids.has(c.attemptId)).map((c) => c.kind);
    };
    expect(checksOf(planTask)).toEqual(['plan']);
    expect(checks.find((c) => c.kind === 'plan')?.detail).toBe(
      '1. a\n\n写 a.txt\n\n2. b\n\n写 b.txt\n\n3. c\n\n写 c.txt',
    );
    expect(planTask.commitSha).toBeNull();
    for (const task of work) expect(checksOf(task)).toEqual(['result', 'command']);

    // One commit per step, in the plan's order, now on the target branch.
    const shas = work.map((task) => task.commitSha as string);
    expect(new Set(shas).size).toBe(3);
    expect(git(h.repoDir, 'rev-parse', `${shas[1]}^`)).toBe(shas[0]);
    expect(git(h.repoDir, 'rev-parse', `${shas[2]}^`)).toBe(shas[1]);
    expect(git(h.repoDir, 'log', '-1', '--format=%B', shas[1] as string)).toContain(
      '编码: 添加 feature.txt\n\n第 2/3 步：b\n\n写了 b.txt',
    );
    for (const file of ['a.txt', 'b.txt', 'c.txt', 'feature.txt']) {
      expect(git(h.repoDir, 'show', `main:${file}`)).toBeTruthy();
    }
  });

  it('retries a plan that does not match the format by on_agent_error, telling what was wrong', async () => {
    const good = planner(['a']);
    let plans = 0;
    h = await harness({
      workflow: PLANNED_WORKFLOW,
      scripts: {
        coder: (ctx) =>
          ctx.input.readOnly && ++plans === 1
            ? { finalMessage: '```json\n{"tasks": []}\n```' }
            : good(ctx),
        reviewer: () => review(),
      },
    });
    const run = h.run();
    await h.waitStatus(run.id, 'completed');
    const store = h.master.store;
    const [implement] = implementRounds(run.id) as [StageRun];
    const [planTask] = store.listTasks(implement.id) as [Task];
    expect(store.listAttempts(planTask.id).map((a) => a.outcome)).toEqual([
      'agent_error',
      'passed',
    ]);
    expect(eventData(run.id, 'task.retry_after_error')).toEqual([
      {
        taskId: planTask.id,
        agentId: 'coder',
        error: expect.stringMatching(/^JSON 结果不符合约定：tasks: /),
        attempt: 1,
        delayMs: 0,
      },
    ]);
    const retried = h.fake.calls.filter((c) => c.readOnly)[1];
    expect(retried?.prompt).toMatch(/## 上一次拆分没有完成\n\nJSON 结果不符合约定：tasks: /);
    expect(
      store
        .listChecks(run.id)
        .filter((c) => c.kind === 'plan')
        .map((c) => c.passed),
    ).toEqual([false, true]);
    expect(tasksOf(implement.id)).toEqual([
      ['plan', '拆分任务', 'passed'],
      ['work', 'a', 'passed'],
    ]);

    // A plan of a single step is the whole stage: prompted and committed as without a plan.
    const [stepCall] = h.fake.calls.filter((c) => c.model === 'coder' && !c.readOnly);
    expect(stepCall?.prompt).toContain('## 当前阶段：编码\n\n实现 添加 feature.txt');
    expect(stepCall?.prompt).not.toContain('## 这一步');
    expect(stepCall?.prompt).not.toContain('整个计划');
    const [, step] = store.listTasks(implement.id) as [Task, Task];
    const message = git(h.repoDir, 'log', '-1', '--format=%B', step.commitSha as string);
    expect(message.startsWith('编码: 添加 feature.txt\n\n写了 ')).toBe(true);
    expect(message).not.toContain('第 1/1 步');
  });

  it('creates no task from a plan that does not match the format', async () => {
    h = await harness({
      workflow: PLANNED_WORKFLOW,
      scripts: {
        coder: (ctx) => (ctx.input.readOnly ? { finalMessage: '拆不了' } : done()),
        reviewer: () => review(),
      },
    });
    const run = h.run('添加 feature.txt', blockOnAgentError());
    const blocked = await h.waitStatus(run.id, 'blocked');
    const [implement] = implementRounds(run.id) as [StageRun];
    const [planTask] = h.master.store.listTasks(implement.id) as [Task];
    expect(tasksOf(implement.id)).toEqual([['plan', '拆分任务', 'failed']]);
    expect(blocked.blocked).toEqual({
      kind: 'agent_error',
      message: 'Agent coder 运行出错：没有找到约定格式的 JSON 结果',
      taskId: planTask.id,
    });
    expect(eventData(run.id, 'stage.planned')).toEqual([]);

    // A human retries: planned again, told what was wrong.
    h.scripts.coder = planner(['a', 'b']);
    await h.master.engine.retry(run.id);
    await h.waitStatus(run.id, 'completed');
    expect(tasksOf(implement.id)).toEqual([
      ['plan', '拆分任务', 'passed'],
      ['work', 'a', 'passed'],
      ['work', 'b', 'passed'],
    ]);
    expect(h.fake.calls.filter((c) => c.readOnly)[1]?.prompt).toContain(
      '## 上一次拆分没有完成\n\n没有找到约定格式的 JSON 结果',
    );
  });

  it.each([
    ['stops', 'stopped'],
    ['crashes', 'interrupted'],
  ])(
    'plans again when the Master %s in the middle of planning, creating no task twice',
    async (how, status) => {
      const first = await harness({
        workflow: PLANNED_WORKFLOW,
        scripts: {
          coder: async (ctx) => {
            await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
            return plan(['never']);
          },
        },
      });
      const run = first.run();
      await waitFor(() => first.fake.calls.length === 1, 'the plan to start');
      // A crash leaves the database saying "running" when the next Master opens it.
      if (how === 'stops') await first.close();

      h = await harness({
        home: first.home,
        repoDir: first.repoDir,
        workflow: PLANNED_WORKFLOW,
        scripts: { coder: planner(['a', 'b']), reviewer: () => review() },
      });
      await h.waitStatus(run.id, 'completed');
      const [implement] = implementRounds(run.id) as [StageRun];
      expect(tasksOf(implement.id)).toEqual([
        ['plan', '拆分任务', 'passed'],
        ['work', 'a', 'passed'],
        ['work', 'b', 'passed'],
      ]);
      const [planTask] = h.master.store.listTasks(implement.id) as [Task];
      expect(h.master.store.listAttempts(planTask.id).map((a) => a.status)).toEqual([
        status,
        'completed',
      ]);
      expect(eventData(run.id, 'stage.planned')).toHaveLength(1);
    },
  );

  it('plans every round anew after the review sends the work back, with the review', async () => {
    let reviews = 0;
    h = await harness({
      workflow: PLANNED_WORKFLOW,
      scripts: {
        coder: planner(['a', 'b']),
        reviewer: () =>
          ++reviews === 1 ? review([{ severity: 'must', description: '少了 d.txt' }]) : review(),
      },
    });
    const run = h.run();
    await h.waitStatus(run.id, 'completed');
    const rounds = implementRounds(run.id);
    expect(rounds.map((sr) => sr.round)).toEqual([1, 2]);
    for (const sr of rounds) {
      expect(tasksOf(sr.id)).toEqual([
        ['plan', '拆分任务', 'passed'],
        ['work', 'a', 'passed'],
        ['work', 'b', 'passed'],
      ]);
    }
    expect(eventData(run.id, 'stage.planned').map((d) => d.round)).toEqual([1, 2]);
    const plans = h.fake.calls.filter((c) => c.readOnly);
    expect(plans).toHaveLength(2);
    expect(plans[0]?.prompt).not.toContain('## 上一轮被打回的原因');
    expect(plans[1]?.prompt).toContain('## 上一轮被打回的原因');
    expect(plans[1]?.prompt).toContain('少了 d.txt');
    // Each step of the new round gets the review too.
    const steps = h.fake.calls.filter((c) => c.model === 'coder' && !c.readOnly);
    expect(steps).toHaveLength(4);
    for (const call of steps.slice(0, 2)) expect(call.prompt).not.toContain('少了 d.txt');
    for (const call of steps.slice(2)) expect(call.prompt).toContain('少了 d.txt');
  });

  /**
   * The coder: read-only it plans `titles`, otherwise it writes feature.txt, wrong in the
   * executions numbered in `wrong` (from 1, the plan not counted), so the verify command sends
   * them back.
   */
  const failing = (titles: string[], wrong: (n: number) => boolean): Script => {
    let calls = 0;
    return (ctx) => {
      if (ctx.input.readOnly) return plan(titles);
      calls++;
      writeFile(join(ctx.input.workdir, 'feature.txt'), wrong(calls) ? 'wrong\n' : 'ok\n');
      return done();
    };
  };

  it("gives the scout each step's own rework, and the plan's apart", async () => {
    const steps = failing(['a', 'b'], (n) => n === 2);
    let plans = 0;
    h = await harness({
      workflow: PLANNED_WORKFLOW,
      scripts: {
        // The first plan is not in the format, so the plan is executed twice.
        coder: (ctx) =>
          ctx.input.readOnly && ++plans === 1
            ? { finalMessage: '```json\n{"tasks": []}\n```' }
            : steps(ctx),
        reviewer: () => review(),
      },
    });
    const run = h.run();
    await h.waitStatus(run.id, 'completed');

    const text = runDigest(h.master.store, h.repo.id);
    const lines = text.split('\n');
    const at = lines.indexOf('  编码第 1 轮：拆成 2 步');
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at, at + 3)).toEqual([
      '  编码第 1 轮：拆成 2 步',
      '    编码第 1 轮的拆分：执行 2 次，返工原因：Agent 出错 ×1',
      '    第 2/2 步「b」：执行 2 次，返工原因：`grep -q ok feature.txt` 未通过 ×1',
    ]);
    // The first step passed at once; the round's executions are not counted together.
    expect(text).not.toContain('第 1/2 步');
    expect(text).not.toContain('编码第 1 轮：执行');
    // A round of the review, not split, as before.
    expect(text).not.toContain('评审第 1 轮');
  });

  it('tells the scout which step failed and which the Run never reached', async () => {
    h = await harness({
      workflow: PLANNED_WORKFLOW,
      scripts: { coder: failing(['a', 'b', 'c'], (n) => n > 1), reviewer: () => review() },
    });
    const run = h.run();
    await h.waitStatus(run.id, 'failed');

    const lines = runDigest(h.master.store, h.repo.id).split('\n');
    const at = lines.indexOf('  编码第 1 轮：拆成 3 步');
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 1)).toEqual([
      '    第 2/3 步「b」：执行 3 次，返工原因：`grep -q ok feature.txt` 未通过 ×3',
      '    第 2/3 步「b」：失败',
      '    第 3/3 步「c」：Run 结束时还没执行到',
    ]);
  });

  it('tells the scout which step a cancel stopped in the middle of', async () => {
    const steps = planner(['a', 'b', 'c']);
    let executions = 0;
    h = await harness({
      workflow: PLANNED_WORKFLOW,
      scripts: {
        // The second step runs until the Run is cancelled.
        coder: async (ctx) => {
          if (!ctx.input.readOnly && ++executions === 2) {
            await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
            return done();
          }
          return steps(ctx);
        },
        reviewer: () => review(),
      },
    });
    const run = h.run();
    await waitFor(() => executions === 2, 'second step to start');
    await h.master.engine.cancel(run.id);

    const [implement] = implementRounds(run.id) as [StageRun];
    expect(tasksOf(implement.id)).toEqual([
      ['plan', '拆分任务', 'passed'],
      ['work', 'a', 'passed'],
      ['work', 'b', 'cancelled'],
      ['work', 'c', 'cancelled'],
    ]);
    const lines = runDigest(h.master.store, h.repo.id).split('\n');
    const at = lines.indexOf('  编码第 1 轮：拆成 3 步');
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 1, at + 3)).toEqual([
      '    第 2/3 步「b」：Run 结束时还没做完',
      '    第 3/3 步「c」：Run 结束时还没执行到',
    ]);
  });

  it('writes the steps in the digest in English', async () => {
    const english = PLANNED_WORKFLOW.replace('name: 测试流程', 'name: Test flow')
      .replace('name: 编码', 'name: Coding')
      .replace('name: 评审', 'name: Review')
      .replace('name: 合并', 'name: Merge')
      .replace('实现 {{goal}}', 'Implement {{goal}}');
    // Before the Run, so that the error the Run ends with is in English too.
    setLang('en');
    try {
      h = await harness({
        workflow: english,
        scripts: {
          coder: failing(['a', 'b', 'c'], (n) => n === 2 || n > 3),
          reviewer: () => review(),
        },
      });
      const run = h.run('Add feature.txt');
      await h.waitStatus(run.id, 'failed');

      const text = runDigest(h.master.store, h.repo.id);
      const lines = text.split('\n');
      const at = lines.indexOf('  Coding round 1: split into 3 steps');
      expect(at).toBeGreaterThan(0);
      expect(lines.slice(at + 1)).toEqual([
        '    Step 2/3 "b": 2 executions, reworked because of: `grep -q ok feature.txt` failed ×1',
        '    Step 3/3 "c": 3 executions, reworked because of: `grep -q ok feature.txt` failed ×3',
        '    Step 3/3 "c": failed',
      ]);
      expect(text).not.toMatch(/\p{Script=Han}/u);
    } finally {
      setLang('zh');
    }
  });

  it('switches a plan whose agent cannot run read-only to one that can; the steps keep the stage agent', async () => {
    const scripts: Record<string, Script> = {
      coder: planner(['a']),
      coder2: planner(['x']),
      reviewer: () => review(),
    };
    const fake = new FakeAdapter((ctx) => (scripts[ctx.input.model] as Script)(ctx));
    // A CLI that cannot run an agent read-only.
    const writeOnly: AgentAdapter = { cli: 'fake-rw', start: (input) => fake.start(input) };
    const agents = (coderCli: string) => `
agents:
  coder: { cli: ${coderCli}, model: coder }
  coder2: { cli: fake, model: coder2 }
  reviewer: { cli: fake, model: reviewer }
`;
    h = await harness({
      agents: agents('fake'),
      workflow: PLANNED_WORKFLOW,
      scripts,
      master: { adapters: [fake, writeOnly] },
    });
    h.master.engine.setWorking(false);
    const run = h.run();
    // Before the Run starts, the coder moves to a CLI that cannot run read-only.
    writeFile(join(h.home, 'agents.yaml'), agents('fake-rw'));
    h.master.configWatcher.reload();
    h.master.engine.setWorking(true);
    await h.waitStatus(run.id, 'completed');
    expect(fake.calls.map((c) => [c.model, c.readOnly === true])).toEqual([
      ['coder2', true],
      ['coder', false],
      ['reviewer', false],
    ]);
    expect(eventData(run.id, 'task.agent_switched')).toEqual([
      {
        taskId: expect.any(String),
        from: 'coder',
        to: 'coder2',
        reason: 'unavailable',
        unavailable: 'read_only_unsupported',
        error: '拆分任务要以只读方式运行，Agent coder 的 CLI fake-rw 不支持',
      },
    ]);
    const [implement] = implementRounds(run.id) as [StageRun];
    expect(
      h.master.store.listTasks(implement.id).map((task) => [task.kind, task.title, task.agentId]),
    ).toEqual([
      ['plan', '拆分任务', 'coder2'],
      ['work', 'x', 'coder'],
    ]);
  });
});
