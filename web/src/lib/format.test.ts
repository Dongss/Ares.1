import { afterEach, describe, expect, it } from 'vitest';
import { setLang } from '../../../src/i18n.js';
import {
  agentOptionLabel,
  attemptAgentLabel,
  FAIL_REASON,
  formatAttemptCost,
  formatCost,
  formatDuration,
  formatRunCost,
  formatRunTime,
  formatTime,
  formatTokens,
  goalTitle,
  messageExcerpt,
  parseLines,
  RUN_STATUS,
  runTimePartTexts,
  stripAnsi,
} from './format.js';

describe('format helpers', () => {
  it('labels an attempt with its agent, model and effort', () => {
    const a = { agentId: 'claude-coder', model: 'opus', actualModel: null, effort: null };
    // configured model until the CLI reports the real one; no effort = CLI default
    expect(attemptAgentLabel(a)).toBe('claude-coder · opus · 默认 effort');
    expect(attemptAgentLabel({ ...a, actualModel: 'claude-opus-5-5', effort: 'high' })).toBe(
      'claude-coder · claude-opus-5-5 · high',
    );
    // recorded before models were tracked
    expect(attemptAgentLabel({ ...a, model: null })).toBe('claude-coder');
  });

  it('labels agents in pickers with model and effort', () => {
    expect(agentOptionLabel({ id: 'c', model: 'opus', effort: 'max', args: [] })).toBe(
      'c（opus · max）',
    );
    expect(agentOptionLabel({ id: 'c', model: 'opus', args: ['--effort', 'low'] })).toBe(
      'c（opus · low）',
    );
    expect(agentOptionLabel({ id: 'c', model: 'sonnet', args: [] })).toBe(
      'c（sonnet · 默认 effort）',
    );
  });

  it('formats costs', () => {
    expect(formatCost(0)).toBe('$0');
    expect(formatCost(null)).toBe('$0');
    expect(formatCost(0.0034)).toBe('$0.0034');
    expect(formatCost(1.234)).toBe('$1.23');
  });

  it('says when a cost is unknown instead of showing $0', () => {
    expect(formatAttemptCost({ costUsd: 0.25, status: 'completed' })).toBe('$0.25');
    expect(formatAttemptCost({ costUsd: null, status: 'completed' })).toBe('费用未知');
    expect(formatAttemptCost({ costUsd: null, status: 'running' })).toBe('');
    expect(formatRunCost(1.5, false)).toBe('$1.50');
    expect(formatRunCost(1.5, true)).toBe('$1.50 + 未知');
    expect(formatRunCost(0, true)).toBe('费用未知');
  });

  it('formats durations', () => {
    expect(formatDuration(12_400)).toBe('12 秒');
    expect(formatDuration(192_000)).toBe('3 分 12 秒');
    expect(formatDuration(3_900_000)).toBe('1 小时 5 分');
    expect(formatDuration(-5)).toBe('0 秒');
  });

  describe('run time', () => {
    const MIN = 60_000;
    const none = { agentMs: 0, queuedMs: 0, approvalMs: 0, blockedMs: 0, pausedMs: 0 };
    const createdAt = '2026-11-20T00:00:00.000Z';
    const at = (min: number) => new Date(Date.parse(createdAt) + min * MIN).toISOString();

    it('splits a finished run into the parts it was spent on, leaving out the empty ones', () => {
      const times = { ...none, totalMs: 951 * MIN, agentMs: 15 * MIN, approvalMs: 870 * MIN };
      expect(formatRunTime({ createdAt, finishedAt: at(951) }, times)).toBe(
        '15 小时 51 分（Agent 执行 15 分 0 秒、等审批 14 小时 30 分）',
      );
    });

    it('lists the parts in the same order as the scout, without those that show as 0 秒', () => {
      const times = {
        totalMs: 200 * MIN,
        pausedMs: 3 * MIN,
        blockedMs: 40_000,
        approvalMs: 2 * MIN,
        queuedMs: 12,
        agentMs: 90 * MIN + 400,
      };
      expect(runTimePartTexts(times)).toEqual([
        'Agent 执行 1 小时 30 分',
        '等审批 2 分 0 秒',
        '卡住等人 40 秒',
        '暂停 3 分 0 秒',
      ]);
      expect(runTimePartTexts({ ...times, queuedMs: 1_500 })[1]).toBe('排队 2 秒');
    });

    it('shows only the total when nothing has ended yet', () => {
      const times = { ...none, totalMs: null, queuedMs: 3 };
      expect(formatRunTime({ createdAt, finishedAt: null }, times, Date.parse(at(2)))).toBe(
        '2 分 0 秒',
      );
    });

    it('counts a run that goes on until now, listing the parts that ended', () => {
      const times = { ...none, totalMs: null, agentMs: 5 * MIN, approvalMs: 10 * MIN };
      expect(formatRunTime({ createdAt, finishedAt: null }, times, Date.parse(at(20)))).toBe(
        '20 分 0 秒（Agent 执行 5 分 0 秒、等审批 10 分 0 秒）',
      );
    });
  });

  it('shows only the clock for today, the date otherwise', () => {
    const now = new Date(2026, 10, 18, 20, 0, 0);
    expect(formatTime(new Date(2026, 10, 18, 14, 3, 21).toISOString(), now)).toBe('14:03:21');
    expect(formatTime(new Date(2026, 10, 17, 9, 5, 0).toISOString(), now)).toBe('11-17 09:05');
  });

  it('formats tokens', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_345)).toBe('12.3k');
    expect(formatTokens(2_500_000)).toBe('2.50M');
  });

  it('uses the first line of a goal as its title', () => {
    expect(goalTitle('  修复登录\n细节……')).toBe('修复登录');
    expect(goalTitle('a'.repeat(100), 10)).toBe(`${'a'.repeat(10)}…`);
  });

  it('splits commands one per line', () => {
    expect(parseLines(' npm ci \n\n npm test\n')).toEqual(['npm ci', 'npm test']);
  });

  it('keeps the details of a multi-line message, not just its first line', () => {
    const msg = 'Task「登录」返工 2 次后仍未通过验收。最后一次的问题：\n- 缺少测试\n\n- 类型错误';
    expect(messageExcerpt(msg)).toBe(
      'Task「登录」返工 2 次后仍未通过验收。最后一次的问题：\n- 缺少测试\n- 类型错误',
    );
  });

  it('shows the first details of long prose and marks omissions without extra lines', () => {
    const prose = ['标题', 'a', 'b', 'c', 'd', 'e'].join('\n');
    expect(messageExcerpt(prose, 3)).toBe('标题\na\nb …');
    const output = '检查命令 `npm test` 未通过（退出码 1）。输出末尾：\n```\nl1\nl2\nl3\nl4\n```';
    expect(messageExcerpt(output, 3)).toBe(
      '检查命令 `npm test` 未通过（退出码 1）。输出末尾：\n… l3\nl4',
    );
  });

  it('removes terminal color codes', () => {
    expect(stripAnsi('\u001b[2m   Start at \u001b[22m 15:49:10')).toBe('   Start at  15:49:10');
    expect(stripAnsi('\u001b]8;;https://x\u0007link\u001b]8;;\u0007')).toBe('link');
    expect(stripAnsi('50%\r100%')).toBe('100%');
  });

  // Real `npm test` output tail: vitest run by the engine (CI=1, FORCE_COLOR=0) still colors it.
  const vitestTail = [
    ' \u001b[31m❯\u001b[39m x.test.ts \u001b[2m(\u001b[22m\u001b[2m1 test\u001b[22m\u001b[2m | \u001b[22m\u001b[31m1 failed\u001b[39m\u001b[2m)\u001b[22m\u001b[32m 3\u001b[2mms\u001b[22m\u001b[39m',
    '\u001b[31m   \u001b[31m×\u001b[31m adds\u001b[39m\u001b[32m 3\u001b[2mms\u001b[22m\u001b[39m',
    '',
    '\u001b[31m⎯⎯⎯⎯⎯⎯⎯\u001b[39m\u001b[1m\u001b[41m Failed Tests 1 \u001b[49m\u001b[22m\u001b[31m⎯⎯⎯⎯⎯⎯⎯\u001b[39m',
    '',
    '\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m x.test.ts\u001b[2m > \u001b[22madds',
    '\u001b[31m\u001b[1mAssertionError\u001b[22m: expected 2 to be 3 // Object.is equality\u001b[39m',
    '',
    '\u001b[32m- Expected\u001b[39m',
    '\u001b[31m+ Received\u001b[39m',
    '',
    '\u001b[32m- 3\u001b[39m',
    '\u001b[31m+ 2\u001b[39m',
    '',
    '\u001b[36m \u001b[2m❯\u001b[22m x.test.ts:\u001b[2m3:17\u001b[22m\u001b[39m',
    "    \u001b[90m  1|\u001b[39m \u001b[35mimport\u001b[39m { expect\u001b[33m,\u001b[39m it } \u001b[35mfrom\u001b[39m \u001b[32m'vitest'\u001b[39m\u001b[33m;\u001b[39m",
    "    \u001b[90m  2|\u001b[39m \u001b[34mit\u001b[39m(\u001b[32m'adds'\u001b[39m\u001b[33m,\u001b[39m () \u001b[33m=>\u001b[39m {",
    '    \u001b[90m  3|\u001b[39m   \u001b[34mexpect\u001b[39m(\u001b[34m1\u001b[39m \u001b[33m+\u001b[39m \u001b[34m1\u001b[39m)\u001b[33m.\u001b[39m\u001b[34mtoBe\u001b[39m(\u001b[34m3\u001b[39m)\u001b[33m;\u001b[39m',
    '    \u001b[90m   |\u001b[39m                 \u001b[31m^\u001b[39m',
    '    \u001b[90m  4|\u001b[39m })\u001b[33m;\u001b[39m',
    '    \u001b[90m  5|\u001b[39m',
    '',
    '\u001b[31m\u001b[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯\u001b[22m\u001b[39m',
    '',
    '',
    '\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[31m1 failed\u001b[39m\u001b[22m\u001b[90m (1)\u001b[39m',
    '\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[31m1 failed\u001b[39m\u001b[22m\u001b[90m (1)\u001b[39m',
    '\u001b[2m   Start at \u001b[22m 15:49:10',
    '\u001b[2m   Duration \u001b[22m 83ms\u001b[2m (transform 60%, import 19%, tests 12%, worker 8%)\u001b[22m',
    '',
    'npm error Lifecycle script `test` failed with error:',
    'npm error code 1',
    'npm error path /repo',
    'npm error workspace ares1@0.1.0',
    'npm error location /repo',
    'npm error command failed',
    'npm error command sh -c vitest run',
  ].join('\n');
  // Same shape as formatCommandFailure().
  const commandFailure = `检查命令 \`npm test\` 未通过（退出码 1）。输出末尾：\n\`\`\`\n${vitestTail}\n\`\`\``;

  it('keeps the headline, the failed command and what failed in a task_failed message', () => {
    const msg = `Task「登录」返工 2 次后仍未通过验收。最后一次的问题：\n${commandFailure}`;
    const excerpt = messageExcerpt(msg);
    expect(excerpt).toBe(
      [
        'Task「登录」返工 2 次后仍未通过验收。最后一次的问题：',
        '检查命令 `npm test` 未通过（退出码 1）。输出末尾：',
        '… FAIL  x.test.ts > adds',
        'AssertionError: expected 2 to be 3 // Object.is equality',
        '… Test Files  1 failed (1)',
        'Tests  1 failed (1)',
      ].join('\n'),
    );
    expect(excerpt).not.toContain('\u001b');
  });

  it('keeps the failed command of a max_loops message caused by a merge check', () => {
    const msg = `阶段 coding 已执行 4 轮，超过回退上限 3。最后一次的原因：\n合并 main 的最新代码后，${commandFailure}`;
    const excerpt = messageExcerpt(msg).split('\n');
    expect(excerpt).toHaveLength(6);
    expect(excerpt[0]).toBe('阶段 coding 已执行 4 轮，超过回退上限 3。最后一次的原因：');
    expect(excerpt[1]).toBe(
      '合并 main 的最新代码后，检查命令 `npm test` 未通过（退出码 1）。输出末尾：',
    );
    expect(excerpt).toContain('Tests  1 failed (1)');
    expect(excerpt.join('\n')).not.toMatch(/Duration|Start at|npm error|⎯|\d\|/);
  });

  it('keeps the command line even when the budget is tight', () => {
    const msg = `Task「登录」返工 2 次后仍未通过验收。最后一次的问题：\n${commandFailure}`;
    expect(messageExcerpt(msg, 4)).toBe(
      [
        'Task「登录」返工 2 次后仍未通过验收。最后一次的问题：',
        '检查命令 `npm test` 未通过（退出码 1）。输出末尾：',
        '… Test Files  1 failed (1)',
        'Tests  1 failed (1)',
      ].join('\n'),
    );
  });

  it('treats only the outer fence pair as command output', () => {
    const msg = [
      '准备命令失败',
      '检查命令 `cat README.md` 未通过（退出码 1）。输出末尾：',
      '```',
      'error: first problem',
      '```',
      'a',
      'b',
      'c',
      'error: last problem',
      '```',
    ].join('\n');
    expect(messageExcerpt(msg, 4)).toBe(
      [
        '准备命令失败',
        '检查命令 `cat README.md` 未通过（退出码 1）。输出末尾：',
        'error: first problem',
        '… error: last problem',
      ].join('\n'),
    );
  });

  it('prefers must-fix review issues over suggestions', () => {
    // Same shape as engine.ts rollback() + formatReviewIssues().
    const msg = [
      '阶段 coding 已执行 4 轮，超过回退上限 3。最后一次的原因：',
      '评审结论：方向正确，但有缺陷',
      '1. [建议]（a.ts） 改名',
      '2. [建议]（b.ts） 加注释',
      '3. [必须修改]（c.ts） 空指针',
      '4. [建议]（d.ts） 拆函数',
      '5. [必须修改]（e.ts） 缺少测试',
      '6. [建议]（f.ts） 换算法',
    ].join('\n');
    expect(messageExcerpt(msg, 5)).toBe(
      [
        '阶段 coding 已执行 4 轮，超过回退上限 3。最后一次的原因：',
        '评审结论：方向正确，但有缺陷',
        '1. [建议]（a.ts） 改名',
        '… 3. [必须修改]（c.ts） 空指针',
        '… 5. [必须修改]（e.ts） 缺少测试 …',
      ].join('\n'),
    );
  });

  it('keeps multi-line issue descriptions with their issue', () => {
    const msg = [
      '阶段 coding 已执行 4 轮，超过回退上限 3。最后一次的原因：',
      '评审结论：有缺陷',
      '1. [建议]（a.ts） 改名',
      '例如 foo 改成 bar',
      '2. [必须修改]（c.ts） 空指针',
      '复现：传入 null',
      '3. [建议]（d.ts） 拆函数',
    ].join('\n');
    expect(messageExcerpt(msg, 4)).toBe(
      [
        '阶段 coding 已执行 4 轮，超过回退上限 3。最后一次的原因：',
        '评审结论：有缺陷',
        '… 2. [必须修改]（c.ts） 空指针',
        '复现：传入 null …',
      ].join('\n'),
    );
  });

  it('clips very long lines', () => {
    expect(messageExcerpt('x'.repeat(10), 4, 4)).toBe('xxxx…');
  });
});

describe('format helpers in English', () => {
  afterEach(() => setLang('zh'));

  it('formats durations, costs and agent labels in English', () => {
    setLang('en');
    expect(formatDuration(5_000)).toBe('5s');
    expect(formatDuration(903_000)).toBe('15m 3s');
    expect(formatDuration(57_060_000)).toBe('15h 51m');
    expect(formatRunCost(0, true)).toBe('cost unknown');
    expect(formatRunCost(1.5, true)).toBe('$1.50 + unknown');
    expect(formatAttemptCost({ costUsd: null, status: 'completed' })).toBe('cost unknown');
    expect(agentOptionLabel({ id: 'c', model: 'opus', args: [] })).toBe(
      'c (opus · default effort)',
    );
    expect(
      attemptAgentLabel({ agentId: 'c', model: 'opus', actualModel: null, effort: null }),
    ).toBe('c · opus · default effort');
  });

  it('reads status labels in the language in use, not the one of import time', () => {
    expect(RUN_STATUS.waiting_approval.label).toBe('待审批');
    setLang('en');
    expect(RUN_STATUS.waiting_approval).toMatchObject({
      label: 'Awaiting approval',
      tone: 'attention',
    });
    expect(
      Object.values(RUN_STATUS)
        .map((s) => s.label)
        .join(' '),
    ).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('names every reason a stage round failed, in the language in use', () => {
    expect(FAIL_REASON.conflict).toBe('\u548c\u76ee\u6807\u5206\u652f\u51b2\u7a81');
    setLang('en');
    expect(FAIL_REASON.conflict).toBe('Conflicts with the target branch');
    expect(Object.values(FAIL_REASON).join(' ')).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('excerpts English command failures and review issues the same way', () => {
    const output =
      'Check command `npm test` failed (exit code 1). Output tail:\n```\nl1\nl2\nl3\nl4\n```';
    expect(messageExcerpt(output, 3)).toBe(
      'Check command `npm test` failed (exit code 1). Output tail:\n… l3\nl4',
    );
    const review = [
      'Review: needs work',
      '1. [suggestion] rename x',
      '2. [suggestion] rename y',
      '3. [must fix] (a.ts) missing test',
    ].join('\n');
    expect(messageExcerpt(review, 2)).toBe(
      'Review: needs work\n… 3. [must fix] (a.ts) missing test',
    );
  });
});
