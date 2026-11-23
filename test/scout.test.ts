import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GhIssue } from '../src/github/client.js';
import { issueDigest, runDigest, scoutPrompt } from '../src/github/scout.js';
import { setLang } from '../src/i18n.js';
import type { Run, RunStatus } from '../src/store/types.js';
import type { UpgradeFailure } from '../src/upgrade/upgrader.js';
import {
  ASSESS_AGENTS_YAML,
  ASSESS_WORKFLOW_YAML,
  assessment,
  done,
  git,
  type Harness,
  harness,
  review,
  waitFor,
  writeFile,
} from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const digest = (hh: Harness) => runDigest(hh.master.store, hh.repo.id);

/** `min` minutes after the Run was created, as ISO. */
const later = (run: Pick<Run, 'createdAt'>, min: number) =>
  new Date(Date.parse(run.createdAt) + min * 60_000).toISOString();

/**
 * Moves the Run's status changes, in the order they were recorded, to the given minutes after
 * its creation; the statuses must be the ones recorded.
 */
function retimeStatuses(hh: Harness, run: Run, changes: [RunStatus, number][]): void {
  const store = hh.master.store;
  const statuses = store.listEvents(run.id).filter((e) => e.type === 'run.status');
  expect(statuses.map((e) => e.data.status)).toEqual(changes.map(([status]) => status));
  for (const [i, e] of statuses.entries()) {
    const min = changes[i]?.[1] ?? 0;
    store.db.prepare('UPDATE events SET ts = ? WHERE id = ?').run(later(run, min), e.id);
  }
}

/** Implement only, retrying agent errors, so a Run finishes without a merge approval. */
const IMPLEMENT_ONLY = `
id: dev
defaults:
  escalate: { max_retries: 3, on_agent_error: retry }
stages:
  - id: implement
    name: 编码
    agent: coder
`;

describe('runDigest', () => {
  it('says there are no Runs yet', async () => {
    h = await harness();
    expect(digest(h)).toBe('（还没有 Run）');
  });

  it('shows stage rounds only when nothing had to be redone', async () => {
    h = await harness();
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');

    const lines = digest(h).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`- ${run.id}（等待审批，${run.createdAt.slice(0, 10)}）添加 feature.txt`);
    expect(lines[1]).toMatch(/^ {2}轮次：编码×1 评审×1 合并×1；费用 \$\d+\.\d\d$/);
    expect(digest(h)).not.toContain('返工原因');
  });

  it('splits the time of a finished Run into agent work and waiting for the approval', async () => {
    h = await harness();
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');
    h.master.engine.approve(run.id);
    await h.waitStatus(run.id, 'completed');
    // As a Run that waited most of a day for its merge approval. It was queued for a few
    // milliseconds only, when created and once approved: too short to be shown.
    const store = h.master.store;
    store.updateRun(run.id, { finishedAt: later(run, 957) });
    const attempts = store.listRunAttempts(run.id);
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    for (const [i, a] of attempts.entries()) {
      store.updateAttempt(a.id, {
        startedAt: later(run, 1 + 10 * i),
        endedAt: later(run, 11 + 10 * i),
      });
    }
    const [approval] = store.listApprovals(run.id);
    store.updateApproval(approval?.id ?? '', {
      createdAt: later(run, 60),
      decidedAt: later(run, 950),
    });

    const lines = digest(h).split('\n');
    expect(lines[1]).toMatch(
      new RegExp(
        `^ {2}轮次：编码×1 评审×1 合并×1；费用 \\$\\d+\\.\\d\\d，用时 957 分钟（Agent 执行 ${10 * attempts.length} 分钟，等审批 890 分钟）$`,
      ),
    );
  });

  it('shows no waiting for a Run that never waited for a human', async () => {
    h = await harness({ workflow: IMPLEMENT_ONLY });
    const run = h.run();
    await h.waitStatus(run.id, 'completed');
    const store = h.master.store;
    store.updateRun(run.id, { finishedAt: later(run, 12) });
    for (const a of store.listRunAttempts(run.id)) {
      store.updateAttempt(a.id, { startedAt: later(run, 1), endedAt: later(run, 11) });
    }

    const text = digest(h);
    expect(text).toContain('，用时 12 分钟（Agent 执行 10 分钟）');
    for (const part of ['排队', '等审批', '卡住等人', '暂停']) expect(text).not.toContain(part);
  });

  it('tells a Run that spent most of its time queued behind other Runs', async () => {
    h = await harness({ workflow: IMPLEMENT_ONLY });
    const run = h.run();
    await h.waitStatus(run.id, 'completed');
    const store = h.master.store;
    // Started 30 minutes after it was created, done 5 minutes later.
    retimeStatuses(h, run, [
      ['running', 30],
      ['completed', 35],
    ]);
    store.updateRun(run.id, { finishedAt: later(run, 35) });
    for (const a of store.listRunAttempts(run.id)) {
      store.updateAttempt(a.id, { startedAt: later(run, 30), endedAt: later(run, 35) });
    }

    expect(digest(h)).toContain('，用时 35 分钟（Agent 执行 5 分钟，排队 30 分钟）');
  });

  it('tells the time a Run was paused, and queued again once resumed', async () => {
    h = await harness({ workflow: IMPLEMENT_ONLY });
    let calls = 0;
    h.scripts.coder = async (ctx) => {
      calls++;
      if (calls === 1) {
        await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
        return done();
      }
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return done();
    };
    const run = h.run();
    await waitFor(() => calls === 1, 'agent to start');
    await h.master.engine.pause(run.id);
    h.master.engine.resume(run.id);
    await h.waitStatus(run.id, 'completed');
    const store = h.master.store;
    // Paused for 20 minutes, then queued behind another Run for 7.
    retimeStatuses(h, run, [
      ['running', 0],
      ['paused', 3],
      ['queued', 23],
      ['running', 30],
      ['completed', 40],
    ]);
    store.updateRun(run.id, { finishedAt: later(run, 40) });
    const [stopped, redone] = store.listRunAttempts(run.id);
    store.updateAttempt(stopped?.id ?? '', { startedAt: later(run, 0), endedAt: later(run, 3) });
    store.updateAttempt(redone?.id ?? '', { startedAt: later(run, 30), endedAt: later(run, 40) });

    expect(digest(h)).toContain('，用时 40 分钟（Agent 执行 13 分钟，排队 7 分钟，暂停 20 分钟）');
  });

  it('shows executions and rework reasons within a stage round', async () => {
    h = await harness();
    let calls = 0;
    h.scripts.coder = (ctx) => {
      calls++;
      writeFile(join(ctx.input.workdir, 'feature.txt'), calls === 1 ? 'wrong\n' : 'ok\n');
      return done();
    };
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');

    const text = digest(h);
    expect(text).toContain(
      '  编码第 1 轮：执行 2 次，返工原因：`grep -q ok feature.txt` 未通过 ×1',
    );
    // Still one round of the stage: the rework happened inside it.
    expect(text).toContain('轮次：编码×1 评审×1 合并×1');
    // The review passed on its first execution.
    expect(text).not.toContain('评审第 1 轮');
  });

  it('counts agent errors and bad results, in the order they happened', async () => {
    h = await harness({ workflow: IMPLEMENT_ONLY });
    let calls = 0;
    h.scripts.coder = (ctx) => {
      calls++;
      if (calls === 1) return { status: 'failed', error: 'boom' };
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      if (calls === 2 || calls === 3) return { finalMessage: '我做完了' };
      return done();
    };
    const run = h.run();
    await h.waitStatus(run.id, 'completed');

    expect(digest(h)).toContain(
      '  编码第 1 轮：执行 4 次，返工原因：Agent 出错 ×1、未按格式给出结果 ×2',
    );
  });

  it('counts executions that hit a quota or rate limit', async () => {
    h = await harness({
      workflow: IMPLEMENT_ONLY,
      master: { rateLimitWait: { firstMs: 5, maxMs: 5, marginMs: 0 } },
    });
    let calls = 0;
    h.scripts.coder = (ctx) => {
      calls++;
      if (calls === 1) return { status: 'failed', error: 'limit', errorKind: 'rate_limited' };
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      return done();
    };
    const run = h.run();
    await h.waitStatus(run.id, 'completed');

    expect(digest(h)).toContain('  编码第 1 轮：执行 2 次，返工原因：额度用尽或被限流 ×1');
  });

  it('tells apart the three kinds of bad results and counts each', async () => {
    h = await harness({ workflow: IMPLEMENT_ONLY.replace('max_retries: 3', 'max_retries: 5') });
    let calls = 0;
    h.scripts.coder = (ctx) => {
      calls++;
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      const report = (status: string) => ({
        finalMessage: `\`\`\`json\n${JSON.stringify({ status, summary: '还差一步' })}\n\`\`\``,
      });
      if (calls === 1 || calls === 4) return { finalMessage: '我做完了' };
      if (calls === 2) return report('incomplete');
      if (calls === 3) return { ...done(), permissionDenials: ['Bash: rm feature.txt'] };
      return done();
    };
    const run = h.run();
    await h.waitStatus(run.id, 'completed');

    const lines = digest(h).split('\n');
    const at = lines.indexOf(
      '  编码第 1 轮：执行 5 次，返工原因：未按格式给出结果 ×2、Agent 自称未完成 ×1、有操作被拒绝 ×1',
    );
    expect(at).toBeGreaterThan(0);
    // The denied operation itself, right below the rework reasons of its round.
    expect(lines[at + 1]).toBe('    - 被拒绝：Bash: rm feature.txt');
    expect(lines.filter((l) => l.includes('被拒绝：'))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('执行结果不合格');
  });

  it('lists the denied operations of a round on one line each, up to three of them', async () => {
    h = await harness({ workflow: IMPLEMENT_ONLY });
    const long = `Bash: echo ${'x'.repeat(300)}`;
    let calls = 0;
    h.scripts.coder = (ctx) => {
      calls++;
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      if (calls === 1) {
        return {
          ...done(),
          permissionDenials: ['Bash: git add -A &&\n  git commit -m "x"', long, 'Read: /etc/hosts'],
        };
      }
      if (calls === 2) {
        // The same commit again, only spaced differently, and two new operations.
        return {
          ...done(),
          permissionDenials: [
            'Bash: git add -A && git commit -m "x"',
            'Bash: git push',
            'Write: /tmp/x',
          ],
        };
      }
      return done();
    };
    const run = h.run();
    await h.waitStatus(run.id, 'completed');

    const lines = digest(h).split('\n');
    const at = lines.indexOf('  编码第 1 轮：执行 3 次，返工原因：有操作被拒绝 ×2');
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 1, at + 5)).toEqual([
      '    - 被拒绝：Bash: git add -A && git commit -m "x"',
      `    - 被拒绝：${long.slice(0, 120)}…`,
      '    - 被拒绝：Read: /etc/hosts',
      '    …另有 2 条',
    ]);
    expect(lines).toHaveLength(at + 5);
  });

  it('counts a review in the wrong format as a result not in the agreed format', async () => {
    h = await harness();
    let reviews = 0;
    h.scripts.reviewer = () => {
      reviews++;
      return reviews === 1 ? { finalMessage: '看起来没问题' } : review();
    };
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');

    expect(digest(h)).toContain('  评审第 1 轮：执行 2 次，返工原因：未按格式给出结果 ×1');
  });

  it('lists the must-fix issues of a failed review with their files, not the suggestions', async () => {
    h = await harness();
    let reviews = 0;
    h.scripts.reviewer = () => {
      reviews++;
      if (reviews > 1) return review();
      const issues = [
        { severity: 'must', file: 'src/a.ts', description: '没有处理空输入' },
        { severity: 'suggestion', file: 'src/b.ts', description: '变量名可以更清楚' },
        { severity: 'must', description: '缺少测试' },
      ];
      return { structured: { summary: '基本可以，有两处要改', issues } };
    };
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');

    const lines = digest(h).split('\n');
    const at = lines.findIndex((l) => l.startsWith('  评审第 1 轮未通过'));
    expect(lines.slice(at, at + 3)).toEqual([
      '  评审第 1 轮未通过：必须修改 2 条（另有建议 1 条）；总结：基本可以，有两处要改',
      '    - [src/a.ts] 没有处理空输入',
      '    - 缺少测试',
    ]);
    expect(lines.filter((l) => l.startsWith('    '))).toHaveLength(2);
    expect(lines.join('\n')).not.toContain('变量名可以更清楚');
    // The second round passed.
    expect(lines.join('\n')).not.toContain('评审第 2 轮');
  });

  it('keeps every must-fix issue when the review summary is long, up to five of them', async () => {
    h = await harness();
    const summary = `总体思路正确，${'细节说明'.repeat(150)}`;
    const descriptions = Array.from(
      { length: 7 },
      (_, i) => `第 ${i + 1} 个问题：${'要改'.repeat(20)}`,
    );
    let reviews = 0;
    h.scripts.reviewer = () => {
      reviews++;
      if (reviews > 1) return review();
      const issues = descriptions.map((description, i) => ({
        severity: 'must',
        file: `src/f${i + 1}.ts`,
        description,
      }));
      return {
        finalMessage: `评审完成。\n\`\`\`json\n${JSON.stringify({ summary, issues })}\n\`\`\``,
      };
    };
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');

    const lines = digest(h).split('\n');
    const at = lines.findIndex((l) => l.startsWith('  评审第 1 轮未通过'));
    expect(lines[at]?.startsWith('  评审第 1 轮未通过：必须修改 7 条；总结：总体思路正确，')).toBe(
      true,
    );
    expect(lines[at]?.endsWith('…')).toBe(true);
    expect(lines.slice(at + 1, at + 7)).toEqual([
      ...descriptions.slice(0, 5).map((d, i) => `    - [src/f${i + 1}.ts] ${d}`),
      '    …另有 2 条',
    ]);
  });

  it('keeps the text of a rejected approval as before', async () => {
    h = await harness();
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');
    const comment = `请把文件名改成 feature.md。${'理由'.repeat(200)}`;
    h.master.engine.reject(run.id, comment);
    await waitFor(
      () => h?.master.store.countStageRounds(run.id, 'merge') === 2,
      'second merge round',
    );
    await h.waitStatus(run.id, 'waiting_approval');

    expect(digest(h).split('\n')).toContain(`  合并第 1 轮审批被驳回：${comment.slice(0, 300)}…`);
  });

  it('keeps the text of failed checks as before', async () => {
    h = await harness({ verifyCommands: ['grep -q ok feature.txt', 'test ! -e broken.txt'] });
    h.scripts.coder = (ctx) => {
      writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
      rmSync(join(ctx.input.workdir, 'broken.txt'), { force: true });
      return done();
    };
    const run = h.run();
    await h.waitStatus(run.id, 'waiting_approval');
    // The target branch moves on with a commit that fails the checks once merged in.
    writeFile(join(h.repoDir, 'broken.txt'), 'x\n');
    git(h.repoDir, 'add', '-A');
    git(h.repoDir, 'commit', '-q', '-m', 'main moved');
    h.master.engine.approve(run.id);
    await waitFor(
      () => h?.master.store.countStageRounds(run.id, 'merge') === 2,
      'second merge round',
    );
    await h.waitStatus(run.id, 'waiting_approval');

    const failed = h.master.store.listStageRuns(run.id).find((sr) => sr.failReason === 'check');
    const feedback = (failed?.failFeedback ?? '').replace(/\s+/g, ' ').trim();
    expect(feedback).toContain('合并 main 的最新代码后，检查命令 `test ! -e broken.txt` 未通过');
    const expected = feedback.length > 300 ? `${feedback.slice(0, 300)}…` : feedback;
    expect(digest(h).split('\n')).toContain(`  合并第 1 轮检查未通过：${expected}`);
  });

  it('keeps the rework line short when a command is long', async () => {
    const long = `grep -q ok feature.txt # ${'x'.repeat(300)}`;
    h = await harness({ workflow: IMPLEMENT_ONLY, verifyCommands: [long] });
    let calls = 0;
    h.scripts.coder = (ctx) => {
      calls++;
      writeFile(join(ctx.input.workdir, 'feature.txt'), calls === 1 ? 'wrong\n' : 'ok\n');
      return done();
    };
    const run = h.run();
    await h.waitStatus(run.id, 'completed');

    const line = digest(h)
      .split('\n')
      .find((l) => l.includes('执行 2 次'));
    expect(line).toBeDefined();
    expect(line?.length).toBeLessThanOrEqual(2 + 200 + 1);
    expect(line?.endsWith('…')).toBe(true);
  });
});

describe('runDigest: requirement assessment', () => {
  const start = () => harness({ agents: ASSESS_AGENTS_YAML, workflow: ASSESS_WORKFLOW_YAML });

  it('shows rounds, replies, the questions asked and a conclusion with a changed requirement', async () => {
    h = await start();
    let n = 0;
    h.scripts.assessor = () =>
      ++n === 1
        ? assessment('ask', {
            summary: '没说 feature.txt 写什么',
            questions: ['feature.txt 的内容是什么？'],
            suggestions: ['写 ok'],
          })
        : assessment('go', {
            summary: '按回复修改了需求',
            revisedGoal: '添加 feature.txt，第一行 ok，第二行 B',
          });
    const run = h.run();
    await h.waitStatus(run.id, 'blocked');
    await h.master.engine.retry(run.id, { note: '写 ok，再加一行 B' });
    await h.waitStatus(run.id, 'completed');

    const lines = digest(h).split('\n');
    const at = lines.findIndex((l) => l.startsWith('  需求评估：'));
    expect(lines.slice(at)).toEqual([
      '  需求评估：评估 2 轮，人回复 1 次；结论：按讨论后修改的需求开工（需求在讨论后改过，上面的目标是原需求）',
      '    第 1 轮疑问：',
      '      - feature.txt 的内容是什么？',
    ]);
    // Still one round of the assessment stage, and nothing to redo.
    expect(lines[1]).toMatch(/^ {2}轮次：需求评估×1 编码×1 评审×1 合并×1；/);
    expect(lines[0]).toContain('）添加 feature.txt');
    // Neither the new requirement in full, nor the suggestions.
    expect(lines.join('\n')).not.toContain('第二行 B');
    expect(lines.join('\n')).not.toContain('写 ok');
  });

  it('shows a Run dropped after a human agreed, with the reason', async () => {
    h = await start();
    let n = 0;
    h.scripts.assessor = () =>
      ++n === 1
        ? assessment('drop', {
            summary: '和已有的 X 重复',
            questions: ['和已有的 X 重复，还要做吗？'],
          })
        : assessment('drop', { summary: '和 X 重复，人已同意不做' });
    const run = h.run();
    await h.waitStatus(run.id, 'blocked');

    // Taken as ask: a human has to confirm not doing it.
    expect(digest(h).split('\n').slice(2)).toEqual([
      '  需求评估：评估 1 轮，人回复 0 次；结论：评估认为不该做，等人确认',
      '    第 1 轮认为不该做：和已有的 X 重复',
      '      - 和已有的 X 重复，还要做吗？',
    ]);

    await h.master.engine.retry(run.id, { note: '同意，不做了' });
    await h.waitStatus(run.id, 'dropped');

    const lines = digest(h).split('\n');
    expect(lines[0]).toBe(`- ${run.id}（不做，${run.createdAt.slice(0, 10)}）添加 feature.txt`);
    expect(lines.slice(2)).toEqual([
      '  需求评估：评估 2 轮，人回复 1 次；结论：不做',
      '    第 1 轮认为不该做：和已有的 X 重复',
      '      - 和已有的 X 重复，还要做吗？',
      '    不做的理由：和 X 重复，人已同意不做',
    ]);
  });

  it('lists the questions of a Run blocked on the discussion once, up to three of them', async () => {
    h = await start();
    const long = `第二个问题：${'很长'.repeat(100)}`;
    const questions = ['第一个问题？', long, '第三个问题？', '第四个问题？', '第五个问题？'];
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let n = 0;
    h.scripts.assessor = async () => {
      if (++n === 1) return assessment('ask', { summary: '有几处不清楚', questions });
      await released;
      return assessment('go');
    };
    const run = h.run();
    await h.waitStatus(run.id, 'blocked');

    const text = digest(h);
    const lines = text.split('\n');
    expect(lines.slice(2)).toEqual([
      '  需求评估：评估 1 轮，人回复 0 次；结论：等人回复',
      '    第 1 轮疑问：',
      '      - 第一个问题？',
      `      - ${long.slice(0, 150)}…`,
      '      - 第三个问题？',
      '      …另有 2 条',
    ]);
    // The block message carries the same questions; they are not repeated.
    expect(text).not.toContain('卡住：');
    for (const q of ['第一个问题？', '第三个问题？']) expect(text.split(q)).toHaveLength(2);
    expect(text).not.toContain('第四个问题？');

    // Replied, and assessed again.
    await h.master.engine.retry(run.id, { note: '都按默认来' });
    await waitFor(() => n === 2, 'the second assessment');
    expect(digest(h)).toContain(
      '  需求评估：评估 1 轮，人回复 1 次；结论：还没有（人已回复，重新评估中）',
    );
    release?.();
    await h.waitStatus(run.id, 'completed');
    expect(digest(h)).toContain('  需求评估：评估 2 轮，人回复 1 次；结论：按原需求开工');
  });

  it('shows a Run that ended during the discussion as without a conclusion', async () => {
    h = await start();
    h.scripts.assessor = () => assessment('ask', { questions: ['要做成什么样？'] });
    const run = h.run();
    await h.waitStatus(run.id, 'blocked');
    await h.master.engine.cancel(run.id);
    await h.waitStatus(run.id, 'cancelled');

    expect(digest(h)).toContain(
      '  需求评估：评估 1 轮，人回复 0 次；结论：没有（Run 在讨论中结束）\n    第 1 轮疑问：\n      - 要做成什么样？',
    );
  });
});

describe('scoutPrompt', () => {
  const prompt = scoutPrompt({
    repoName: 'demo',
    max: 3,
    runs: '（还没有 Run）',
    issues: '（无）',
  });

  it('introduces the project by its display name, not the technical one', () => {
    expect(prompt.startsWith('你是战神一号的「侦察」：')).toBe(true);
    expect(prompt).not.toContain('ares1');
  });

  it("sends the scout to README.md's goals, the basis for every decision, and AGENTS.md", () => {
    expect(prompt).toContain('读 README.md 和 AGENTS.md');
    expect(prompt).toContain('README.md 写着项目的目标，是一切决定的依据');
    expect(prompt).toContain('提案要服务于 README.md 里的目标');
    expect(prompt).toContain('README.md 里的目标还没达到的地方');
    expect(prompt).not.toContain('当前方向');
  });

  it('names no other documents: the old design docs under docs/ are gone', () => {
    const docs = new Set(prompt.match(/[\w.-]+\.md\b/g));
    expect([...docs].sort()).toEqual(['AGENTS.md', 'CLAUDE.md', 'README.md']);
    expect(prompt).not.toContain('docs/');
    expect(prompt).not.toContain('里程碑');
    expect(prompt).not.toContain('非目标');
  });

  it('fills in the repo, the limit, the Runs and the issues', () => {
    expect(prompt).toContain('为仓库 demo 找出');
    expect(prompt).toContain('最多 3 条');
    expect(prompt).toContain('## 最近的 Run\n（还没有 Run）');
    expect(prompt).toContain('## 已有的 issue\n（无）');
  });
});

describe('scoutPrompt: failed upgrade of the Master', () => {
  afterEach(() => setLang('zh'));

  const failure = (detail: string | null = null): UpgradeFailure => ({
    from: 'a'.repeat(40),
    to: 'b'.repeat(40),
    message: '拉取或构建 bbbbbbb 失败，已回退到 aaaaaaa',
    detail,
    at: '2026-11-20T08:00:00.000Z',
  });
  const prompt = (upgrade?: UpgradeFailure | null) =>
    scoutPrompt({ repoName: 'demo', max: 3, runs: '（还没有 Run）', issues: '（无）', upgrade });

  it('leaves the prompt as it was without a failed upgrade', () => {
    expect(prompt(null)).toBe(prompt());
    expect(prompt()).not.toContain('自动升级失败');
  });

  it('lists the failed commit, the message and the end of the output before the Runs', () => {
    const detail = `npm ERR! in ${join(homedir(), 'ares1-stable')}\nsrc/a.ts(3,1): error TS1005`;
    const text = prompt(failure(detail));
    const section = text.slice(
      text.indexOf('## Master 自动升级失败'),
      text.indexOf('## 最近的 Run'),
    );
    expect(section).toContain(`2026-11-20 它尝试升级到目标分支上的提交 ${'b'.repeat(40)}，失败了`);
    expect(section).toContain('已回退到 aaaaaaa 继续运行');
    expect(section).toContain('- 失败消息：拉取或构建 bbbbbbb 失败，已回退到 aaaaaaa');
    expect(section).toContain(
      '- 输出末尾：\n```\nnpm ERR! in ~/ares1-stable\nsrc/a.ts(3,1): error TS1005\n```',
    );
    expect(section).toContain('修复它是最高优先级');
    expect(section).toContain('网络、npm 源、磁盘空间这类环境问题');
    // Proposals go to GitHub: no home directory.
    expect(text).not.toContain(homedir());
  });

  it('keeps a fence inside the output from ending the code block', () => {
    const text = prompt(failure('before\n```\nafter'));
    expect(text).toContain('````\nbefore\n```\nafter\n````');
  });

  it('says when the output was not recorded', () => {
    expect(prompt(failure())).toContain('- 输出末尾：没有记下。');
  });

  it('has the section in English, with no Chinese left but the output itself', () => {
    setLang('en');
    const text = scoutPrompt({
      repoName: 'demo',
      max: 3,
      runs: '(no Runs yet)',
      issues: '',
      upgrade: {
        ...failure('npm ERR! code ELIFECYCLE'),
        message: 'Pulling or building bbbbbbb failed; rolled back to aaaaaaa',
      },
    });
    expect(text).not.toMatch(/[一-鿿]/);
    expect(text).toContain("## The Master's automatic upgrade failed\n");
    expect(text).toContain(`On 2026-11-20 it tried to upgrade to commit ${'b'.repeat(40)}`);
    expect(text).toContain('- Failure message: Pulling or building bbbbbbb failed');
    expect(text).toContain('- End of the output:\n```\nnpm ERR! code ELIFECYCLE\n```');
    expect(text).toContain('fixing it comes first');
    expect(text.indexOf('automatic upgrade failed')).toBeLessThan(text.indexOf('## Recent Runs'));
  });
});

describe('scout in English', () => {
  afterEach(() => setLang('zh'));

  it('asks in English for proposals written in English, serving the README goals', () => {
    setLang('en');
    const prompt = scoutPrompt({ repoName: 'demo', max: 3, runs: '(no Runs yet)', issues: '' });
    expect(prompt.startsWith('You are the scout of Ares.1: ')).toBe(true);
    expect(prompt).not.toMatch(/[\u4e00-\u9fff]/);
    expect(prompt).toContain('Proposals must serve the goals in README.md');
    expect(prompt).toContain('Write in English.');
    expect(prompt).toContain('At most 3,');
    expect(prompt).toContain('## Recent Runs\n(no Runs yet)');
  });

  it('lists existing issues in English', () => {
    setLang('en');
    const issue = (number: number, title: string, extra: Partial<GhIssue> = {}): GhIssue => ({
      number,
      title,
      body: '',
      state: 'closed',
      stateReason: 'completed',
      labels: [],
      url: '',
      author: 'me',
      authorAssociation: 'OWNER',
      comments: [],
      ...extra,
    });
    const reason = { body: 'Out of scope', author: 'me', authorAssociation: 'OWNER' };
    const digest = issueDigest(
      [issue(1, 'Open one', { state: 'open', stateReason: null, labels: ['ares1:proposal'] })],
      [
        issue(2, 'Rejected', { stateReason: 'not_planned', comments: [reason] }),
        issue(3, 'Finished'),
      ],
      'me',
    );
    expect(digest).toBe(
      [
        '### Open',
        '- #1 [ares1:proposal] Open one',
        '',
        '### Recently closed',
        '- #2 Not planned: Rejected\n  Reason: Out of scope',
        '- #3 Done: Finished',
      ].join('\n'),
    );
  });
});
