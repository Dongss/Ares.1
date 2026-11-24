import { afterEach, describe, expect, it } from 'vitest';
import type { RunSummary } from '../../../src/api/types.js';
import { setLang } from '../../../src/i18n.js';
import type { AssessmentEntry, DiscussionEntry } from '../../../src/store/types.js';
import {
  assessmentHeadline,
  attentionCount,
  canCleanUpWorkspace,
  discussionItems,
  eventText,
  groupRuns,
  ignoredCommentsText,
  pageTitle,
  patchLineClass,
  rateLimitText,
  rawLogPrunedText,
  redoText,
  replyDeadlineOf,
  sizeText,
  splitPatch,
  untrustedIssueText,
  workspaceLines,
} from './runs.js';

function run(id: string, status: RunSummary['status'], extra: Partial<RunSummary> = {}) {
  return {
    id,
    repoId: 'repo-1',
    templateId: 'dev',
    templateName: 'dev',
    costUnknown: false,
    goal: id,
    overrides: {},
    status,
    queuePos: null,
    currentStageRunId: null,
    currentStage: null,
    branch: null,
    worktreePath: null,
    baseCommit: null,
    headCommit: null,
    issue: null,
    issueSynced: null,
    discussion: [],
    issueDiscussionSynced: 0,
    blocked: null,
    extraLoops: 0,
    error: null,
    costUsd: 0,
    createdAt: '2026-11-18T00:00:00.000Z',
    updatedAt: '2026-11-18T00:00:00.000Z',
    finishedAt: null,
    ...extra,
  } satisfies RunSummary;
}

describe('groupRuns', () => {
  it('puts what needs a human first and keeps the queue order', () => {
    const groups = groupRuns([
      run('q2', 'queued', { queuePos: 2 }),
      run('q1', 'queued', { queuePos: 1 }),
      run('a2', 'blocked', { updatedAt: '2026-11-18T02:00:00.000Z' }),
      run('a1', 'waiting_approval', { updatedAt: '2026-11-18T01:00:00.000Z' }),
      run('r', 'running'),
      run('p', 'paused'),
      run('old', 'completed', { finishedAt: '2026-11-18T01:00:00.000Z' }),
      run('new', 'failed', { finishedAt: '2026-11-18T03:00:00.000Z' }),
    ]);
    const ids = (list: RunSummary[]) => list.map((r) => r.id);
    expect(ids(groups.attention)).toEqual(['a1', 'a2']);
    expect(ids(groups.running)).toEqual(['r']);
    expect(ids(groups.queued)).toEqual(['q1', 'q2']);
    expect(ids(groups.paused)).toEqual(['p']);
    expect(ids(groups.finished)).toEqual(['new', 'old']);
  });

  it('limits the finished list', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      run(`f${i}`, 'completed', { finishedAt: new Date(2026, 0, 1, 0, i).toISOString() }),
    );
    expect(groupRuns(many).finished).toHaveLength(20);
    expect(groupRuns(many, 5).finished).toHaveLength(5);
  });

  it('counts runs waiting for a human', () => {
    expect(attentionCount([run('a', 'blocked'), run('b', 'running')])).toBe(1);
  });

  it('titles the tab with the name and slogan, and the number of runs waiting for a human', () => {
    expect(pageTitle(0)).toBe('战神一号 · 自举永动机');
    expect(pageTitle(2)).toBe('(2) 战神一号 · 自举永动机');
  });
});

const PATCH = `diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 same
-old
+new
diff --git a/b.txt b/b.txt
new file mode 100644
--- /dev/null
+++ b/b.txt
@@ -0,0 +1 @@
+hello
`;

describe('splitPatch', () => {
  it('splits a unified diff into files with counts', () => {
    const files = splitPatch(PATCH);
    expect(files.map((f) => [f.path, f.added, f.removed])).toEqual([
      ['a.txt', 1, 1],
      ['b.txt', 1, 0],
    ]);
    expect(files[1]?.lines.at(-1)).toBe('+hello');
  });

  it('handles an empty patch', () => {
    expect(splitPatch('')).toEqual([]);
  });

  it('classifies lines', () => {
    expect(patchLineClass('+added')).toBe('diff-add');
    expect(patchLineClass('-removed')).toBe('diff-del');
    expect(patchLineClass('+++ b/a.txt')).toBe('diff-meta');
    expect(patchLineClass('@@ -1 +1 @@')).toBe('diff-hunk');
    expect(patchLineClass(' context')).toBe('');
  });
});

describe('canCleanUpWorkspace', () => {
  const left = { worktreeExists: true, branchExists: true };

  it('offers the cleanup for failed and cancelled runs that still have a workspace', () => {
    for (const status of ['failed', 'cancelled'] as const) {
      expect(canCleanUpWorkspace({ run: { status }, ...left })).toBe(true);
      // The worktree was deleted by hand but the branch is left, or the other way round.
      expect(canCleanUpWorkspace({ run: { status }, ...left, worktreeExists: false })).toBe(true);
      expect(canCleanUpWorkspace({ run: { status }, ...left, branchExists: false })).toBe(true);
    }
  });

  it('hides it once both are gone', () => {
    const gone = { worktreeExists: false, branchExists: false };
    expect(canCleanUpWorkspace({ run: { status: 'cancelled' }, ...gone })).toBe(false);
  });

  it('hides it for runs that are not failed or cancelled', () => {
    const others = [
      'queued',
      'running',
      'blocked',
      'waiting_approval',
      'paused',
      'completed',
    ] as const;
    for (const status of others) {
      expect(canCleanUpWorkspace({ run: { status }, ...left })).toBe(false);
    }
  });
});

describe('workspaceLines', () => {
  const workspace = { path: '/data/worktrees/run-1', branch: 'ares1/run-1' };
  const recorded = { branch: workspace.branch, worktreePath: workspace.path };
  const unrecorded = { branch: null, worktreePath: null };

  it('shows the recorded branch and worktree, marking the removed ones', () => {
    const both = { workspace, worktreeExists: true, branchExists: true };
    expect(workspaceLines({ run: recorded, ...both })).toEqual([
      { label: '分支', value: 'ares1/run-1', note: null },
      { label: '工作目录', value: '/data/worktrees/run-1', note: null },
    ]);
    const gone = { workspace, worktreeExists: false, branchExists: true };
    expect(workspaceLines({ run: recorded, ...gone }).map((l) => l.note)).toEqual([
      null,
      'removed',
    ]);
  });

  it('shows what a setup that has not passed left on disk', () => {
    const left = { workspace, worktreeExists: true, branchExists: true };
    expect(workspaceLines({ run: unrecorded, ...left })).toEqual([
      { label: '分支', value: 'ares1/run-1', note: 'unrecorded' },
      { label: '工作目录', value: '/data/worktrees/run-1', note: 'unrecorded' },
    ]);
    const branchOnly = { workspace, worktreeExists: false, branchExists: true };
    expect(workspaceLines({ run: unrecorded, ...branchOnly }).map((l) => l.label)).toEqual([
      '分支',
    ]);
  });

  it('labels the lines in English', () => {
    setLang('en');
    const both = { workspace, worktreeExists: true, branchExists: true };
    expect(workspaceLines({ run: recorded, ...both }).map((l) => l.label)).toEqual([
      'Branch',
      'Worktree',
    ]);
  });

  afterEach(() => setLang('zh'));

  it('shows nothing for a Run that has no workspace', () => {
    const none = { workspace, worktreeExists: false, branchExists: false };
    expect(workspaceLines({ run: unrecorded, ...none })).toEqual([]);
  });
});

describe('requirement assessment', () => {
  afterEach(() => setLang('zh'));
  const at = '2026-11-19T00:00:00.000Z';
  const assessed = (patch: Partial<AssessmentEntry>): AssessmentEntry => ({
    role: 'assessor',
    verdict: 'ask',
    summary: '要先问清楚',
    questions: ['写什么？'],
    suggestions: [],
    revisedGoal: null,
    proposedDrop: false,
    stageRunId: 'sr',
    at,
    ...patch,
  });
  const reply: DiscussionEntry = { role: 'human', text: '写 ok', source: 'issue', at };
  const go = assessed({ verdict: 'go', summary: '可以做', questions: [], revisedGoal: '新需求' });

  it('heads the Run detail with where the assessment stands', () => {
    const headline = (discussion: DiscussionEntry[], status: RunSummary['status'] = 'running') =>
      assessmentHeadline({
        discussion,
        status,
        blocked: status === 'blocked' ? { kind: 'discussion', message: '' } : null,
      });
    expect(headline([])).toBeNull();
    expect(headline([assessed({})], 'blocked')).toMatchObject({
      label: '需求待讨论，等你回复',
      tone: 'attention',
    });
    expect(headline([assessed({}), reply])?.label).toBe('重新评估中');
    expect(headline([assessed({})], 'cancelled')?.label).toBe('没有结论');
    expect(headline([assessed({}), reply, go])).toMatchObject({
      label: '结论：按讨论后修改的需求开工',
      tone: 'success',
      conclusion: go,
    });
    expect(headline([assessed({ verdict: 'drop' })], 'dropped')?.label).toBe('结论：不做');
  });

  it('lists the discussion with rounds and where replies came from', () => {
    const items = discussionItems([assessed({ proposedDrop: true }), reply, go]);
    expect(items.map((i) => i.title)).toEqual([
      '第 1 轮评估：认为不该做，请人确认',
      '人的回复（issue 上）',
      '第 2 轮评估：按讨论后修改的需求开工',
    ]);
    expect(items[0]?.text).toContain('疑问和顾虑：\n1. 写什么？');
    expect(items[2]?.text).toContain('修改后的需求：\n\n新需求');
  });

  it('notes the comments of non-members that were not taken as replies', () => {
    const items = discussionItems([assessed({ ignoredComments: 2 }), reply, go]);
    expect(items[0]?.note).toBe('issue 上有 2 条非仓库成员的评论，没有当作回复，也不会交给 Agent');
    expect(items[1]?.note).toBeUndefined();
    expect(items[2]?.note).toBeUndefined();
    setLang('en');
    expect(ignoredCommentsText(1)).toBe(
      '1 comment on the issue by non-members of the repo was not taken as a reply and does not go to the agents',
    );
    expect(ignoredCommentsText(3)).toBe(
      '3 comments on the issue by non-members of the repo were not taken as replies and do not go to the agents',
    );
  });

  it('says who wrote an untrusted issue and whether its goal was confirmed', () => {
    const issue = (confirmedAt: string | null, author: string | null = 'stranger') => ({
      repo: 'me/demo',
      number: 3,
      url: '',
      auto: false,
      untrusted: { author, association: 'NONE', confirmedAt },
    });
    expect(untrustedIssueText(null)).toBeNull();
    expect(untrustedIssueText({ ...issue(null), untrusted: undefined })).toBeNull();
    expect(untrustedIssueText(issue(null))).toBe(
      'issue 的作者 @stranger（NONE）不是仓库成员：目标是建 Run 时 issue 的内容，要你确认后才交给 Agent。',
    );
    expect(untrustedIssueText(issue(at))).toContain('由人确认后才交给 Agent');
    setLang('en');
    expect(untrustedIssueText(issue(null, null))).toBe(
      "The issue's author a deleted account (NONE) is not a member of the repo: the goal is the issue as it was when the Run was created, and goes to the agents only once you confirm it.",
    );
    expect(untrustedIssueText(issue(at))).toMatch(
      /^The issue's author @stranger \(NONE\) is not a member of the repo: .*confirmed by a human at /,
    );
    expect(untrustedIssueText(issue(at))).not.toMatch(/[一-鿿]/);
  });

  const timeout: DiscussionEntry = { role: 'timeout', hours: 24, at };
  const alone = assessed({
    verdict: 'go',
    summary: '假设写 ok',
    questions: [],
    decidedAlone: true,
  });

  it('shows that nobody replied in time and the assessment decided on its own', () => {
    const items = discussionItems([assessed({}), timeout, alone]);
    expect(items.map((i) => i.title)).toEqual([
      '第 1 轮评估：需要讨论',
      '24 小时内没有人回复',
      '第 2 轮评估：没人回复，按评估的假设开工',
    ]);
    expect(items[1]).toMatchObject({ tone: 'muted', at });
    expect(items[1]?.text).toContain('下一轮由评估自己决定');
    expect(discussionItems([assessed({}), { ...timeout, hours: 0 }])[1]?.title).toBe('不等人回复');

    const headline = (discussion: DiscussionEntry[], status: RunSummary['status'] = 'running') =>
      assessmentHeadline({ discussion, status, blocked: null });
    expect(headline([assessed({}), timeout])).toMatchObject({
      label: '没人回复，评估自己决定中',
      tone: 'active',
    });
    expect(headline([assessed({}), timeout, alone])?.label).toBe(
      '结论：没人回复，按评估的假设开工',
    );
    expect(
      headline(
        [assessed({}), timeout, assessed({ verdict: 'drop', decidedAlone: true })],
        'dropped',
      )?.label,
    ).toBe('结论：没人回复，评估决定不做');
  });

  it('works out when a Run waiting for a reply stops waiting, as the engine does', () => {
    const detail = (
      reply_timeout_hours: number | null | undefined,
      discussion: DiscussionEntry[],
    ) =>
      ({
        run: {
          ...run('r', 'blocked'),
          blocked: { kind: 'discussion', message: '', taskId: 't', stageRunId: 'sr' },
          discussion,
          template: {
            id: 'dev',
            stages: [{ id: 'assess', kind: 'assess', reply_timeout_hours }],
          },
        },
        stageRuns: [{ id: 'sr', stageId: 'assess' }],
      }) as unknown as Parameters<typeof replyDeadlineOf>[0];
    const asked = Date.parse(at);
    expect(replyDeadlineOf(detail(undefined, [assessed({})]))).toBe(asked + 24 * 3_600_000);
    expect(replyDeadlineOf(detail(0.5, [assessed({})]))).toBe(asked + 1_800_000);
    expect(replyDeadlineOf(detail(null, [assessed({})]))).toBeNull();
    // Not waiting on these questions any more: a reply or a timeout came after them.
    expect(replyDeadlineOf(detail(24, [assessed({}), reply]))).toBeNull();
    const notBlocked = detail(24, [assessed({})]);
    notBlocked.run.status = 'running';
    expect(replyDeadlineOf(notBlocked)).toBeNull();
  });

  it('words the timeout in English', () => {
    setLang('en');
    try {
      const items = discussionItems([assessed({}), { ...timeout, hours: 1 }, alone]);
      expect(items[1]?.title).toBe('Nobody replied within 1 hour');
      expect(items[2]?.title).toBe(
        "Assessment round 2: Go ahead on the assessment's assumptions, as nobody replied",
      );
      // The assessment's own summary stays as the agent wrote it.
      const words = `${items[1]?.title}${items[1]?.text}${items[2]?.title}`;
      expect(words).not.toMatch(/[一-鿿]/);
    } finally {
      setLang('zh');
    }
  });

  it('shows the size beside the conclusion, with what it means', () => {
    expect(sizeText(undefined)).toBeNull();
    expect(sizeText('S')).toEqual({ label: '规模 S', meaning: '一处小改动' });
    expect(sizeText('M')).toEqual({ label: '规模 M', meaning: '一个 Run 能做完的普通需求' });
    expect(sizeText('L')).toEqual({
      label: '规模 L',
      meaning: '要改多个模块，一次做完容易超时或返工',
    });
    // The page shows the size of the conclusion it heads with.
    const sized = assessed({ verdict: 'go', questions: [], size: 'L' });
    expect(
      assessmentHeadline({ discussion: [sized], status: 'running', blocked: null }),
    ).toMatchObject({ conclusion: { size: 'L' } });
    setLang('en');
    const english = (['S', 'M', 'L'] as const).map((size) => sizeText(size));
    expect(english).toEqual([
      { label: 'Size S', meaning: 'One small change' },
      { label: 'Size M', meaning: 'An ordinary requirement one Run can finish' },
      {
        label: 'Size L',
        meaning: 'Changes across several modules, likely to time out or need rework in one go',
      },
    ]);
    expect(JSON.stringify(english)).not.toMatch(/[一-鿿]/);
  });
});

describe('rate limits', () => {
  afterEach(() => setLang('zh'));
  // Local times, as the dashboard shows them.
  const now = new Date(2026, 10, 20, 9, 0, 0);
  const today = new Date(2026, 10, 20, 14, 5, 0).toISOString();
  const tomorrow = new Date(2026, 10, 21, 3, 30, 0).toISOString();
  const event = (data: Record<string, unknown>) => ({ type: 'task.rate_limited', data });

  it('says which agent hit the limit and when the Run goes on', () => {
    expect(rateLimitText({ agentId: 'coder', retryAt: today }, now)).toBe(
      'Agent coder 额度用尽或被限流，预计 14:05:00 继续',
    );
    expect(rateLimitText({ agentId: 'coder', retryAt: tomorrow }, now)).toBe(
      'Agent coder 额度用尽或被限流，预计 11-21 03:30 继续',
    );
  });

  it('says when the issue of a failed Run is redone, and as which attempt', () => {
    expect(redoText(today, 1, now)).toBe('预计 14:05:00 自动重做，开始第 2 次尝试');
    expect(redoText(tomorrow, 2, now)).toBe('预计 11-21 03:30 自动重做，开始第 3 次尝试');
    // The wait is over, but the budget or the work switch still holds it.
    const past = new Date(2026, 10, 20, 8, 0, 0).toISOString();
    expect(redoText(past, 1, now)).toBe('下一次检查时自动重做，开始第 2 次尝试');
    setLang('en');
    expect(redoText(today, 1, now)).toBe('To be redone automatically at 14:05:00, as attempt 2');
    expect(redoText(past, 1, now)).toBe(
      'To be redone automatically at the next check, as attempt 2',
    );
  });

  it('words task.rate_limited events from their data, and no others', () => {
    const data = { taskId: 't', agentId: 'coder', retryAt: today, delayMs: 1, resetAt: null };
    expect(eventText(event(data), now)).toBe('Agent coder 额度用尽或被限流，预计 14:05:00 继续');
    expect(eventText(event({ taskId: 't' }), now)).toBeNull();
    expect(eventText({ type: 'task.passed', data: { taskId: 't' } }, now)).toBeNull();
  });

  it('in English', () => {
    setLang('en');
    const text = eventText(event({ agentId: 'coder', retryAt: today }), now);
    expect(text).toBe(
      'Agent coder is out of quota or rate-limited; expected to continue at 14:05:00',
    );
    expect(text).not.toMatch(/[一-鿿]/);
  });
});

describe('a program missing from the environment', () => {
  afterEach(() => setLang('zh'));
  const blocked = { type: 'run.blocked', data: { kind: 'environment', missing: 'npm' } };

  it('words the block and the resumption from their data', () => {
    expect(eventText(blocked)).toBe(
      '运行环境里找不到 npm：命令没能运行，这不是代码的问题，不返工，也不消耗返工和重做次数；找到它或 Master 重启后自动接着做',
    );
    expect(
      eventText({ type: 'environment.resumed', data: { reason: 'found', missing: 'npm' } }),
    ).toBe('运行环境里又能找到 npm 了，自动接着做');
    expect(
      eventText({ type: 'environment.resumed', data: { reason: 'restart', missing: 'npm' } }),
    ).toBe('Master 重启了，在新的运行环境里重新运行之前因为找不到 npm 没能运行的命令');
    // Other blocks only show their data.
    expect(eventText({ type: 'run.blocked', data: { kind: 'budget' } })).toBeNull();
  });

  it('in English', () => {
    setLang('en');
    const texts = [
      eventText(blocked),
      eventText({ type: 'environment.resumed', data: { reason: 'found', missing: 'npm' } }),
      eventText({ type: 'environment.resumed', data: { reason: 'restart' } }),
      eventText({ type: 'task.verify_resumed', data: {} }),
    ];
    expect(texts[0]).toBe(
      'npm not found in the environment: the commands could not run, which is no fault of the code, so there is no rework and no rework or redo is used up; the Run goes on by itself once it is found or the Master restarts',
    );
    expect(texts[1]).toBe('npm is found in the environment again, so the Run goes on by itself');
    for (const text of texts) expect(text).not.toMatch(/[一-鿿]/);
  });
});

describe('superseded workspaces', () => {
  afterEach(() => setLang('zh'));
  const superseded = { reason: 'superseded', supersededBy: 'run_ok' };

  it('words the removal of a failed attempt and its failure from their data', () => {
    const removed = { path: '/w/run_a', branch: 'ares1/run_a', ...superseded };
    expect(eventText({ type: 'workspace.removed', data: removed })).toBe(
      '同一 issue 的 Run run_ok 已完成，自动删掉了这次失败留下的工作目录和分支',
    );
    expect(
      eventText({ type: 'workspace.cleanup_failed', data: { ...superseded, error: 'x' } }),
    ).toBe(
      '同一 issue 的 Run run_ok 已完成，但没能自动删掉这次失败留下的工作目录和分支，请在「工作区」页手动清理',
    );
    // Removed by hand or after a merge: only the data.
    const manual = { path: '/w/run_a', branch: 'ares1/run_a', manual: true };
    expect(eventText({ type: 'workspace.removed', data: manual })).toBeNull();
    expect(eventText({ type: 'workspace.removed', data: {} })).toBeNull();
  });

  it('in English', () => {
    setLang('en');
    const removed = eventText({ type: 'workspace.removed', data: superseded });
    expect(removed).toBe(
      'Run run_ok of the same issue completed, so the working directory and branch this failed Run kept were removed automatically',
    );
    const failed = eventText({ type: 'workspace.cleanup_failed', data: superseded });
    expect(failed).toBe(
      'Run run_ok of the same issue completed, but the working directory and branch this failed Run kept could not be removed automatically; clean them up by hand on the Workspaces page',
    );
    for (const text of [removed, failed]) expect(text).not.toMatch(/[一-鿿]/);
  });
});

describe('workspaces of attempts before the last when an issue used up its attempts', () => {
  afterEach(() => setLang('zh'));
  const exhausted = { reason: 'retries_exhausted', keptRun: 'run_last' };

  it('words the removal of an earlier attempt and its failure from their data', () => {
    const removed = { path: '/w/run_a', branch: 'ares1/run_a', ...exhausted };
    expect(eventText({ type: 'workspace.removed', data: removed })).toBe(
      'issue 用完了重做次数，只保留最后一次尝试 run_last 的工作目录和分支，自动删掉了这次的',
    );
    expect(
      eventText({ type: 'workspace.cleanup_failed', data: { ...exhausted, error: 'x' } }),
    ).toBe(
      'issue 用完了重做次数，只保留最后一次尝试 run_last 的工作目录和分支，但没能自动删掉这次的，请在「工作区」页手动清理',
    );
    // Without the kept Run: only the data.
    const partial = { reason: 'retries_exhausted' };
    expect(eventText({ type: 'workspace.removed', data: partial })).toBeNull();
  });

  it('in English', () => {
    setLang('en');
    const removed = eventText({ type: 'workspace.removed', data: exhausted });
    expect(removed).toBe(
      "The issue used up its attempts, so only the last one, Run run_last, keeps its working directory and branch; this Run's were removed automatically",
    );
    const failed = eventText({
      type: 'workspace.cleanup_failed',
      data: { ...exhausted, error: 'x' },
    });
    expect(failed).toBe(
      "The issue used up its attempts, so only the last one, Run run_last, keeps its working directory and branch, but this Run's could not be removed automatically; clean them up by hand on the Workspaces page",
    );
    for (const text of [removed, failed]) expect(text).not.toMatch(/[一-鿿]/);
  });
});

describe('a Run started over because its issue changed', () => {
  afterEach(() => setLang('zh'));
  const changed = { repo: 'me/demo', issue: 7, newRun: 'run_new' };
  const goalChanged = { reason: 'goal_changed', newRun: 'run_new' };

  it('words the termination and the removal of its workspace from their data', () => {
    expect(eventText({ type: 'run.goal_changed', data: changed })).toBe(
      'issue 的标题或正文改了，这次 Run 按的是旧内容，已自动终止；按新内容开始了 Run run_new',
    );
    const removed = { path: '/w/run_a', branch: 'ares1/run_a', ...goalChanged };
    expect(eventText({ type: 'workspace.removed', data: removed })).toBe(
      'issue 改过后由 Run run_new 按新内容重做，自动删掉了这次 Run 的工作目录和分支',
    );
    expect(
      eventText({ type: 'workspace.cleanup_failed', data: { ...goalChanged, error: 'x' } }),
    ).toBe(
      'issue 改过后由 Run run_new 按新内容重做，但没能自动删掉这次 Run 的工作目录和分支，请在「工作区」页手动清理',
    );
    // Without the new Run: only the data.
    expect(eventText({ type: 'run.goal_changed', data: { repo: 'me/demo', issue: 7 } })).toBeNull();
    expect(eventText({ type: 'workspace.removed', data: { reason: 'goal_changed' } })).toBeNull();
  });

  it('in English', () => {
    setLang('en');
    const texts = [
      eventText({ type: 'run.goal_changed', data: changed }),
      eventText({ type: 'workspace.removed', data: goalChanged }),
      eventText({ type: 'workspace.cleanup_failed', data: { ...goalChanged, error: 'x' } }),
    ];
    expect(texts).toEqual([
      "The issue's title or body changed, so this Run, which worked from the old text, was terminated automatically; Run run_new started on the new one",
      "Run run_new redoes the changed issue from the start, so this Run's working directory and branch were removed automatically",
      "Run run_new redoes the changed issue from the start, but this Run's working directory and branch could not be removed automatically; clean them up by hand on the Workspaces page",
    ]);
    for (const text of texts) expect(text).not.toMatch(/[一-鿿]/);
  });
});

describe('a review stopped halfway whose work could not be put back', () => {
  afterEach(() => setLang('zh'));
  const deferred = {
    type: 'review.discard_deferred',
    data: { taskId: 'task_r', baseCommit: 'abc123', error: 'git checkout failed' },
  };

  it('says the Run puts it back before its worktree is checked', () => {
    expect(eventText(deferred)).toBe(
      '评审中途停下时，没能丢掉评审者留下的改动、把工作目录放回评审开始时的提交；Run 再拿到执行位时先补做，再检查工作目录、重新评审',
    );
    expect(eventText({ type: 'review.changes_discarded', data: {} })).toBeNull();
  });

  it('in English', () => {
    setLang('en');
    const text = eventText(deferred);
    expect(text).toBe(
      'When the review stopped halfway, what the reviewer left could not be dropped to put the working directory back where the review started; the Run does it first when it next gets the execution slot, before its working directory is checked and the review runs again',
    );
    expect(text).not.toMatch(/[一-鿿]/);
  });
});

describe('raw logs past retention', () => {
  afterEach(() => setLang('zh'));
  const now = new Date('2026-12-31T00:00:00.000Z');
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

  it('says the raw logs are gone once the Run ended over 30 days ago', () => {
    const old = run('old', 'completed', { finishedAt: daysAgo(31) });
    expect(rawLogPrunedText(old, now)).toBe('原始日志已超过保留期（Run 结束 30 天后）被删除');
    expect(rawLogPrunedText(run('recent', 'failed', { finishedAt: daysAgo(1) }), now)).toBeNull();
    // Not finished, however old: the raw logs stay.
    for (const status of ['running', 'blocked', 'waiting_approval', 'paused'] as const) {
      expect(rawLogPrunedText(run(status, status, { finishedAt: daysAgo(90) }), now)).toBeNull();
    }
  });

  it('in English', () => {
    setLang('en');
    const text = rawLogPrunedText(run('old', 'cancelled', { finishedAt: daysAgo(40) }), now);
    expect(text).toBe('The raw log was deleted once past retention (30 days after the Run ended)');
    expect(text).not.toMatch(/[一-鿿]/);
  });
});
