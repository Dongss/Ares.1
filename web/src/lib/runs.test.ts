import { afterEach, describe, expect, it } from 'vitest';
import type { RunSummary } from '../../../src/api/types.js';
import { setLang } from '../../../src/i18n.js';
import {
  type AssessmentEntry,
  type DiscussionEntry,
  PR_CLOSE_REASONS,
  type RunIssue,
} from '../../../src/store/types.js';
import {
  assessmentDifficulty,
  assessmentHeadline,
  assessmentSize,
  attentionCount,
  canCleanUpWorkspace,
  conflictWaitParts,
  conflictWaitText,
  difficultyText,
  discussionItems,
  eventText,
  executingOfMaxText,
  groupRuns,
  ignoredCommentsText,
  issueReplyHint,
  latestPrRework,
  maxRunsWaitText,
  pageTitle,
  patchLineClass,
  prCancelHint,
  prName,
  prRetryHint,
  prReworkNote,
  prReworkReasonText,
  prSummary,
  prWaitHint,
  prWaitText,
  prWaitTitle,
  pullRequestRework,
  rateLimitText,
  rawLogPrunedText,
  redoText,
  replyDeadlineOf,
  runPlatform,
  runStatusBadge,
  sizeText,
  splitPatch,
  untrustedIssueText,
  waitingForPr,
  workspaceLines,
} from './runs.js';

function run(id: string, status: RunSummary['status'], extra: Partial<RunSummary> = {}) {
  return {
    id,
    repoId: 'repo-1',
    templateId: 'dev',
    templateName: 'dev',
    costUnknown: false,
    waitingForMaxRuns: false,
    waitingForConflict: null,
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
    mergeRemote: null,
    pr: null,
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
    expect(sizeText('S')).toEqual({
      label: '规模 S',
      meaning: '一处小改动，比如改一个函数、一段文字或一项配置',
    });
    expect(sizeText('M')).toEqual({ label: '规模 M', meaning: '不用拆分、一次就能做完的普通需求' });
    expect(sizeText('L')).toEqual({
      label: '规模 L',
      meaning: '要改多个模块、一次做完容易超时或返工的需求，可能先拆成几步，再一步一步做',
    });
    setLang('en');
    const english = (['S', 'M', 'L'] as const).map((size) => sizeText(size));
    // The meanings the assessment sized by, starting with a capital as they stand alone.
    expect(english).toEqual([
      {
        label: 'Size S',
        meaning: 'One small change, such as a function, a passage of text or a setting',
      },
      { label: 'Size M', meaning: 'An ordinary requirement done in one go, without splitting it' },
      {
        label: 'Size L',
        meaning:
          'Changes across several modules, likely to time out or need rework when done in one go, so it may be split into steps done one after another',
      },
    ]);
    expect(JSON.stringify(english)).not.toMatch(/[一-鿿]/);
  });

  it('shows the difficulty beside the size, with what it means', () => {
    expect(difficultyText(undefined)).toBeNull();
    expect(difficultyText('low')).toEqual({
      label: '难度 low',
      meaning: '局部的小改动，比如改一处文案、补测试',
    });
    expect(difficultyText('mid')).toEqual({ label: '难度 mid', meaning: '跨模块的行为改动' });
    expect(difficultyText('high')).toEqual({
      label: '难度 high',
      meaning: '涉及核心的状态机、git 操作、数据库迁移，或者对正确性要求很高的改动',
    });
    setLang('en');
    const english = (['low', 'mid', 'high'] as const).map((d) => difficultyText(d));
    // The meanings the assessment judged by, starting with a capital as they stand alone.
    expect(english).toEqual([
      {
        label: 'Difficulty low',
        meaning: 'A small, local change, such as rewording some text or adding tests',
      },
      { label: 'Difficulty mid', meaning: 'A change of behavior across modules' },
      {
        label: 'Difficulty high',
        meaning:
          'Changes to a core state machine, git operations or database migrations, or work that has to be exactly right',
      },
    ]);
    expect(JSON.stringify(english)).not.toMatch(/[一-鿿]/);
  });

  it('shows the difficulty candidates are picked by, none for a dropped requirement', () => {
    const difficulty = (...discussion: DiscussionEntry[]) => assessmentDifficulty({ discussion });
    expect(difficulty(assessed({ verdict: 'go', questions: [], difficulty: 'high' }))).toBe('high');
    // A drop gave a difficulty, but nothing runs for a dropped requirement.
    expect(difficulty(assessed({ verdict: 'drop', questions: [], difficulty: 'low' }))).toBe(
      undefined,
    );
    expect(
      difficulty(
        assessed({ verdict: 'go', questions: [], difficulty: 'mid' }),
        reply,
        assessed({ verdict: 'drop', questions: [], difficulty: 'mid' }),
      ),
    ).toBeUndefined();
    // Asking again after a go: the candidates are still picked by that go's difficulty.
    expect(
      difficulty(
        assessed({ verdict: 'go', questions: [], difficulty: 'low' }),
        reply,
        assessed({}),
      ),
    ).toBe('low');
    // A later go decides anew.
    expect(
      difficulty(
        assessed({ verdict: 'go', questions: [], difficulty: 'low' }),
        reply,
        assessed({ verdict: 'go', questions: [], difficulty: 'high' }),
      ),
    ).toBe('high');
    // An ask on its own decides nothing; no difficulty given, or no assessment at all.
    expect(difficulty(assessed({ difficulty: 'high' }))).toBeUndefined();
    expect(difficulty(assessed({ verdict: 'go', questions: [], size: 'M' }))).toBeUndefined();
    expect(difficulty()).toBeUndefined();
  });

  it('shows the size stages planning by size go by, none for a dropped requirement', () => {
    const size = (...discussion: DiscussionEntry[]) => assessmentSize({ discussion });
    expect(size(assessed({ verdict: 'go', questions: [], size: 'L' }))).toBe('L');
    // A drop gave a size, but nothing is planned for a dropped requirement.
    expect(size(assessed({ verdict: 'drop', questions: [], size: 'M' }))).toBeUndefined();
    expect(
      size(
        assessed({ verdict: 'go', questions: [], size: 'L' }),
        reply,
        assessed({ verdict: 'drop', questions: [], size: 'S' }),
      ),
    ).toBeUndefined();
    // Asking again after a go: the stages still go by that go's size.
    expect(size(assessed({ verdict: 'go', questions: [], size: 'M' }), reply, assessed({}))).toBe(
      'M',
    );
    // An ask on its own decides nothing, whatever size it gave.
    expect(size(assessed({ size: 'L' }))).toBeUndefined();
    // No size given, or no assessment at all.
    expect(size(assessed({ verdict: 'go', questions: [] }))).toBeUndefined();
    expect(size()).toBeUndefined();
  });
});

describe('rate limits', () => {
  afterEach(() => setLang('zh'));
  // Local times, as the dashboard shows them.
  const now = new Date(2026, 10, 20, 9, 0, 0);
  const today = new Date(2026, 10, 20, 14, 5, 0).toISOString();
  const tomorrow = new Date(2026, 10, 21, 3, 30, 0).toISOString();
  const event = (data: Record<string, unknown>) => ({ type: 'task.rate_limited', data });

  it('says a queued Run waits for the limit across repos (concurrency.max_runs)', () => {
    expect(maxRunsWaitText(2)).toBe(
      '所有仓库执行中的 Run 已达上限（concurrency.max_runs: 2），等其中一个结束再开始',
    );
    // Before the configuration has loaded.
    expect(maxRunsWaitText(null)).toBe(
      '所有仓库执行中的 Run 已达上限（concurrency.max_runs），等其中一个结束再开始',
    );
    expect(executingOfMaxText(1, 3)).toBe('执行中 1 / 上限 3（concurrency.max_runs）');
    setLang('en');
    expect(maxRunsWaitText(2)).toBe(
      'The Runs executing across all repos are at the limit (concurrency.max_runs: 2); it starts once one of them ends',
    );
    expect(maxRunsWaitText(null)).not.toMatch(/[一-鿿]/);
    expect(executingOfMaxText(1, 3, true)).toBe(
      '1 of at most 3 executing across all repos (concurrency.max_runs)',
    );
  });

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

describe('waiting for a Run expected to change the same places', () => {
  afterEach(() => setLang('zh'));
  const event = (data: Record<string, unknown>) => ({ type: 'run.waiting_conflict', data });
  const many = ['src/a', 'src/b', 'src/c', 'docs', 'web'];

  it('names the Run and the paths, counting those past the first few', () => {
    expect(conflictWaitText({ runId: 'run-1', paths: ['src/engine', 'docs'] })).toBe(
      '等 Run run-1：预计改同一处（src/engine、docs）',
    );
    expect(conflictWaitText({ runId: 'run-1', paths: many })).toBe(
      '等 Run run-1：预计改同一处（src/a、src/b、src/c 等 5 处）',
    );
  });

  it('splits the text around the Run id, so that the id can be a link', () => {
    const wait = { runId: 'run-1', paths: ['src'] };
    const { before, after } = conflictWaitParts(wait);
    expect(`${before}run-1${after}`).toBe(conflictWaitText(wait));
    expect(before).not.toContain('run-1');
    expect(after).not.toContain('run-1');
  });

  it('words run.waiting_conflict events from their data, and no others', () => {
    expect(eventText(event({ stageId: 'assess', blockedBy: 'run-1', paths: ['src'] }))).toBe(
      '等 Run run-1：预计改同一处（src）。这个 Run 在队列里等，不占名额，等它合并或结束后接着做，不重新评估',
    );
    expect(eventText(event({ blockedBy: 'run-1' }))).toBeNull();
    expect(eventText(event({ blockedBy: 'run-1', paths: [] }))).toBeNull();
    expect(eventText(event({ blockedBy: 'run-1', paths: [1] }))).toBeNull();
    expect(eventText(event({ paths: ['src'] }))).toBeNull();
  });

  it('in English', () => {
    setLang('en');
    expect(conflictWaitText({ runId: 'run-1', paths: ['src/engine'] })).toBe(
      'Waiting for Run run-1: expected to change the same place (src/engine)',
    );
    expect(conflictWaitText({ runId: 'run-1', paths: many })).toBe(
      'Waiting for Run run-1: expected to change the same places (src/a, src/b, src/c and 2 more)',
    );
    const text = eventText(
      event({ stageId: 'assess', blockedBy: 'run-1', paths: ['src/engine', 'docs'] }),
    );
    expect(text).toBe(
      'Waiting for Run run-1: expected to change the same places (src/engine, docs). This Run waits in the queue, taking no place, and goes on once that one has merged or ended, without being assessed again',
    );
    expect(text).not.toMatch(/[一-鿿]/);
    const { before, after } = conflictWaitParts({ runId: 'run-1', paths: many });
    expect(`${before}${after}`).not.toMatch(/[一-鿿]/);
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

describe('a Run terminated because its iteration was closed', () => {
  afterEach(() => setLang('zh'));

  it('says why, in both languages', () => {
    const data = { repo: 'me/demo', issue: 22, iteration: 20 };
    expect(eventText({ type: 'run.iteration_closed', data })).toBe(
      '所属迭代 #20 被人关掉了，这个 Run 随之终止，它的 issue 关成不做',
    );
    expect(eventText({ type: 'run.iteration_closed', data: {} })).toBe(
      '所属迭代被人关掉了，这个 Run 随之终止，它的 issue 关成不做',
    );
    setLang('en');
    const english = eventText({ type: 'run.iteration_closed', data });
    expect(english).toBe(
      'Its iteration #20 was closed by a human, so this Run was terminated and its issue closed as not planned',
    );
    expect(english).not.toMatch(/[一-鿿]/);
  });

  it('says a local iteration was cancelled on the dashboard, in both languages', () => {
    const data = { repo: 'demo', iterationId: 'iteration-1' };
    expect(eventText({ type: 'run.iteration_cancelled', data })).toBe(
      '所属迭代被人在看板上终止了，这个 Run 随之终止',
    );
    setLang('en');
    const english = eventText({ type: 'run.iteration_cancelled', data });
    expect(english).toBe(
      'Its iteration was cancelled on the dashboard, so this Run was terminated',
    );
    expect(english).not.toMatch(/[一-鿿]/);
  });
});

describe('what a human did with a command on the issue', () => {
  afterEach(() => setLang('zh'));

  const by = (author: string | null) => ({ source: 'issue', author });
  const cases = [
    { type: 'approval.approved', data: { approvalId: 'a1', ...by('alice') } },
    { type: 'approval.rejected', data: { approvalId: 'a1', comment: '改名', ...by('alice') } },
    { type: 'run.retry', data: { kind: 'task_failed', note: '换个思路', ...by('alice') } },
    { type: 'run.retry', data: { kind: 'untrusted_issue', ...by('alice') } },
    { type: 'run.resumed', data: by('alice') },
    { type: 'run.status', data: { status: 'cancelled', ...by('alice') } },
  ];

  it('says who did what with which command, in both languages', () => {
    expect(cases.map((e) => eventText(e))).toEqual([
      '@alice 在 issue 上用 /ares1 approve 批准了',
      '@alice 在 issue 上用 /ares1 reject 驳回了',
      '@alice 在 issue 上用 /ares1 retry 重试了',
      '@alice 在 issue 上用 /ares1 confirm 确认了需求',
      '@alice 在 issue 上用 /ares1 resume 让暂停的 Run 继续',
      '@alice 在 issue 上用 /ares1 cancel 终止了 Run',
    ]);
    expect(eventText({ type: 'run.status', data: { status: 'cancelled', ...by(null) } })).toBe(
      '已删除的账号 在 issue 上用 /ares1 cancel 终止了 Run',
    );
    expect(eventText({ type: 'issue.commands_ignored', data: { count: 2 } })).toBe(
      'issue 上有 2 条命令的作者不是仓库成员，没有执行',
    );
    setLang('en');
    for (const author of ['alice', null]) {
      for (const e of cases) {
        const text = eventText({ ...e, data: { ...e.data, author } });
        expect(text).toMatch(author ? /^@alice / : /^A deleted account /);
        expect(text).not.toMatch(/[一-鿿]/);
      }
    }
    expect(eventText(cases[3] as (typeof cases)[number])).toBe(
      '@alice confirmed the requirement with /ares1 confirm on the issue',
    );
    expect(eventText({ type: 'issue.commands_ignored', data: { count: 1 } })).toBe(
      '1 command on the issue by non-members of the repo was not carried out',
    );
  });

  it('says nothing more of what was done on the dashboard or by the Master', () => {
    for (const e of cases) {
      expect(eventText({ ...e, data: { ...e.data, source: 'dashboard' } })).toBeNull();
    }
    expect(eventText({ type: 'run.status', data: { status: 'cancelled' } })).toBeNull();
    expect(eventText({ type: 'run.resumed', data: {} })).toBeNull();
    expect(
      eventText({ type: 'run.status', data: { status: 'running', ...by('alice') } }),
    ).toBeNull();
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

describe('a merge Run whose commit the target branch had already', () => {
  afterEach(() => setLang('zh'));
  const obsolete = {
    remote: '0123456789abcdef0123456789abcdef01234567',
    target: 'main',
    targetHead: 'fedcba9876543210fedcba9876543210fedcba98',
    stageId: 'implement',
  };

  it('words the event from its data', () => {
    expect(eventText({ type: 'run.merge_remote_obsolete', data: obsolete })).toBe(
      'main 已经有了这个 Run 要合并的 GitHub 提交 01234567（Master 自己合并了，或者别的 Run 合并了进去），没什么要合并的了：不再启动 Agent，Run 直接完成',
    );
    // Without the commit or the branch: only the data.
    expect(eventText({ type: 'run.merge_remote_obsolete', data: { target: 'main' } })).toBeNull();
    expect(
      eventText({ type: 'run.merge_remote_obsolete', data: { remote: obsolete.remote } }),
    ).toBeNull();
  });

  it('in English', () => {
    setLang('en');
    const text = eventText({ type: 'run.merge_remote_obsolete', data: obsolete });
    expect(text).toBe(
      'main has the commit 01234567 from GitHub this Run was to merge already (the Master merged it by itself, or another Run did), so nothing is left to merge: the Run completed without starting another agent',
    );
    expect(text).not.toMatch(/[一-鿿]/);
  });

  it("names GitLab for a Run of a GitLab repo's", () => {
    const event = { type: 'run.merge_remote_obsolete', data: obsolete };
    expect(eventText(event, undefined, 'gitlab')).toBe(
      'main 已经有了这个 Run 要合并的 GitLab 提交 01234567（Master 自己合并了，或者别的 Run 合并了进去），没什么要合并的了：不再启动 Agent，Run 直接完成',
    );
    setLang('en');
    const text = eventText(event, undefined, 'gitlab');
    expect(text).toContain('from GitLab this Run was to merge');
    expect(text).not.toMatch(/[一-鿿]/);
  });
});

describe('the code host a Run goes with', () => {
  afterEach(() => setLang('zh'));
  const issue = (platform?: 'gitlab'): RunIssue => ({
    repo: platform ? 'grp/sub/demo' : 'me/demo',
    number: 7,
    url: '',
    auto: false,
    ...(platform ? { platform } : {}),
  });
  const gitlab = { source: 'gitlab', host: 'gitlab.example.com', issuesRepo: 'grp/demo' } as const;

  it("is its issue's, else its repo's source, else GitHub", () => {
    expect(runPlatform({ issue: issue('gitlab') }, null)).toBe('gitlab');
    // The issue decides, whatever the repo's source says now.
    expect(runPlatform({ issue: issue() }, gitlab)).toBe('github');
    // A Run of no issue, such as one merging the target branch's new commits, goes by its repo.
    expect(runPlatform({ issue: null }, gitlab)).toBe('gitlab');
    expect(runPlatform({ issue: null }, { source: 'github', issuesRepo: null })).toBe('github');
    expect(runPlatform({ issue: null }, { source: 'backlog' })).toBe('github');
    expect(runPlatform({ issue: null }, null)).toBe('github');
  });

  it('says where to reply to the assessment, on GitHub or GitLab', () => {
    expect(issueReplyHint('github')).toBe(
      '可以直接在 issue 上回复（只认仓库成员的回复），Master 下次检查 GitHub 时会带着回复重新评估；也可以在这里回复。',
    );
    expect(issueReplyHint('gitlab')).toBe(
      '可以直接在 issue 上回复（只认仓库成员的回复），Master 下次检查 GitLab 时会带着回复重新评估；也可以在这里回复。',
    );
    setLang('en');
    const text = issueReplyHint('gitlab');
    expect(text).toBe(
      'You can reply on the issue (only replies by members of the repo count): the Master reassesses with your reply the next time it checks GitLab. Or reply here.',
    );
    expect(text).not.toMatch(/[一-鿿]/);
  });
});

describe('the agent a stage with agent_candidates picked', () => {
  afterEach(() => setLang('zh'));
  const selected = (data: Record<string, unknown>) => ({
    type: 'agent.selected',
    data: {
      stageId: 'implement',
      round: 1,
      taskId: 'task_1',
      agentId: 'coder',
      difficulty: 'mid',
      reason: 'fit',
      candidates: ['cheap', 'coder', 'strong'],
      ...data,
    },
  });
  const all = [
    selected({}),
    selected({ agentId: 'strong', difficulty: 'high', reason: 'highest', round: 2 }),
    selected({ agentId: 'cheap', difficulty: null, reason: 'first' }),
    selected({ agentId: 'cheap', difficulty: null, reason: 'unavailable' }),
  ];

  it('says who it picked and why', () => {
    expect(all.map((e) => eventText(e))).toEqual([
      '阶段 implement 第 1 轮：按难度 mid，从候选（cheap、coder、strong）里选了 coder：档次够用、成本最低',
      '阶段 implement 第 2 轮：按难度 high，候选（cheap、coder、strong）里没有档次够的，选了档次最高的 strong',
      '阶段 implement 第 1 轮：需求评估没有给出难度，用候选（cheap、coder、strong）里第一个能用的 cheap',
      '阶段 implement 第 1 轮：候选（cheap、coder、strong）都不能跑这个阶段，先交给第一个 cheap，之后按 on_agent_error 处理',
    ]);
  });

  it('shows only the data when it is not of that shape', () => {
    expect(eventText(selected({ reason: 'other' }))).toBeNull();
    expect(eventText(selected({ candidates: 'coder' }))).toBeNull();
    expect(eventText(selected({ agentId: undefined }))).toBeNull();
    // Picked by difficulty, yet none recorded.
    expect(eventText(selected({ difficulty: null }))).toBeNull();
    expect(eventText(selected({ difficulty: 'huge', reason: 'highest' }))).toBeNull();
  });

  it('in English', () => {
    setLang('en');
    const texts = all.map((e) => eventText(e));
    expect(texts).toEqual([
      'Stage implement, round 1: by difficulty mid, coder was picked from the candidates (cheap, coder, strong) as the cheapest whose tier is enough',
      'Stage implement, round 2: by difficulty high, none of the candidates (cheap, coder, strong) has a tier that high, so strong, the highest tier, was picked',
      'Stage implement, round 1: the assessment gave no difficulty, so cheap, the first usable of the candidates (cheap, coder, strong), was picked',
      'Stage implement, round 1: none of the candidates (cheap, coder, strong) can run this stage, so it goes to the first, cheap, and on_agent_error decides what follows',
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
      '评审中途停下时，没能丢掉评审者留下的改动、把工作目录放回评审开始时的提交；Run 再开始执行时先补做，再检查工作目录、重新评审',
    );
    expect(eventText({ type: 'review.changes_discarded', data: {} })).toBeNull();
  });

  it('in English', () => {
    setLang('en');
    const text = eventText(deferred);
    expect(text).toBe(
      'When the review stopped halfway, what the reviewer left could not be dropped to put the working directory back where the review started; the Run does it first when it next starts executing, before its working directory is checked and the review runs again',
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

describe('waiting for a pull request', () => {
  afterEach(() => setLang('zh'));
  const pr = { number: 12, url: 'https://github.com/me/demo/pull/12' };
  const issue = {
    repo: 'me/demo',
    number: 7,
    url: 'https://github.com/me/demo/issues/7',
    auto: false,
  } satisfies RunSummary['issue'];
  const waiting = (extra: Partial<RunSummary> = {}) =>
    run('w', 'blocked', {
      blocked: { kind: 'pr_open', message: 'checks passed', stageRunId: 'sr' },
      ...extra,
    });

  it('tells a Run waiting for its pull request from a stuck one', () => {
    expect(waitingForPr(waiting())).toBe(true);
    expect(waitingForPr(waiting({ pr }))).toBe(true);
    expect(
      waitingForPr(run('b', 'blocked', { blocked: { kind: 'merge_conflict', message: 'x' } })),
    ).toBe(false);
    // A pull request alone is not a wait: merged and completed, or closed and failed.
    expect(waitingForPr(run('c', 'completed', { pr }))).toBe(false);
    expect(waitingForPr(run('f', 'failed', { pr }))).toBe(false);
  });

  it('badges it as waiting for the PR rather than blocked', () => {
    expect(runStatusBadge(waiting({ pr }))).toEqual({ label: '等 PR 合并', tone: 'attention' });
    // A merge request for a Run of a GitLab issue.
    const onGitLab = { ...issue, platform: 'gitlab' as const };
    expect(runStatusBadge(waiting({ pr, issue: onGitLab }))).toEqual({
      label: '等 MR 合并',
      tone: 'attention',
    });
    expect(
      runStatusBadge(run('b', 'blocked', { blocked: { kind: 'budget', message: 'x' } })),
    ).toEqual({ label: '卡住', tone: 'danger' });
    expect(runStatusBadge(run('c', 'completed', { pr }))).toEqual({
      label: '已完成',
      tone: 'success',
    });
  });

  it('heads it with the PR number, or says the PR is about to be opened', () => {
    expect(prWaitTitle(waiting({ pr }))).toBe('等 PR 合并 #12');
    expect(prWaitTitle(waiting())).toBe('等 PR 合并：下次检查 GitHub 时推送分支、开 PR');
    expect(prWaitHint()).toBe('在 GitHub 上合并后 Run 自动完成；没合并就关掉，Run 失败');
  });

  it('explains what merging, asking for changes on or closing it does', () => {
    const lines = prWaitText(waiting({ pr, issue }), 'main');
    expect(lines[0]).toBe('检查已通过，Run 的分支已推送到 GitHub，PR #12 等着合并到 main。');
    expect(lines[1]).toContain('本地的 main 快进到合并后的提交，Run 完成，issue 关闭');
    expect(lines[2]).toBe(
      'PR 上受信任的人（仓库所有者、成员和协作者）要求修改、CI 检查全部结束且有失败的，或者和 main 冲突时，Master 下次检查 GitHub 时让 Run 带着这些反馈自动回去返工（回到合并阶段的 on_fail 指向的阶段，计入回退上限 max_loops），改好后推送到同一个 PR。其他人的评审不触发返工，也不交给 Agent。',
    );
    expect(lines[3]).toContain('Run 结束为失败；还有重做次数（max_run_attempts）时 issue 自动重做');
    expect(lines[4]).toContain('等待期间不占执行名额');
    expect(lines[4]).toContain(
      '终止 Run 后，Master 下次检查 GitHub 时会关掉这个 PR（已经合并的不动）',
    );
    // Before the PR is opened, and for a Run without an issue.
    const early = prWaitText(waiting(), 'main');
    expect(early[0]).toContain('Master 下次检查 GitHub 时推送 Run 的分支，开一个合并到 main 的 PR');
    expect(early[1]).not.toContain('issue');
    expect(early[2]).toContain('改好后推送到同一个 PR');
    expect(early[3]).toBe('PR 没合并就被关掉时，Run 结束为失败。');
  });

  it('sums up the PR of any Run that has one', () => {
    expect(prSummary(waiting({ pr }))).toEqual({ label: '#12', note: '（等合并）' });
    expect(prSummary(run('c', 'completed', { pr }))).toEqual({ label: '#12', note: '（已合并）' });
    expect(prSummary(run('f', 'failed', { pr }))).toEqual({ label: '#12', note: null });
    expect(prSummary(run('x', 'cancelled', { pr }))).toEqual({ label: '#12', note: null });
    expect(prSummary(waiting())).toBeNull();
    expect(prSummary(run('c', 'completed'))).toBeNull();
  });

  it('says a Run with a PR that neither waits for it nor finished is reworking, and why', () => {
    for (const status of ['queued', 'running', 'paused', 'waiting_approval'] as const) {
      expect(prSummary(run('r', status, { pr }))).toEqual({ label: '#12', note: '（返工中）' });
    }
    // Stopped at max_loops after reworks (on_exhausted: human): still in the rework.
    const stuck = run('b', 'blocked', { pr, blocked: { kind: 'max_loops', message: 'x' } });
    expect(prSummary(stuck)?.note).toBe('（返工中）');
    const rework = {
      number: 12,
      kinds: ['ci', 'review'] as const,
      reviewers: ['alice'],
      checks: [{ name: 'build', url: null }],
    };
    expect(prSummary(run('r', 'running', { pr }), { ...rework, kinds: [...rework.kinds] })).toEqual(
      { label: '#12', note: '（返工中：CI 检查没通过：build；@alice 要求修改）' },
    );
    // A rework of another pull request, or a Run waiting again, says nothing of it.
    expect(prSummary(run('r', 'running', { pr }), { ...rework, number: 3, kinds: ['ci'] })).toEqual(
      { label: '#12', note: '（返工中）' },
    );
    expect(prSummary(waiting({ pr }), { ...rework, kinds: ['ci'] })?.note).toBe('（等合并）');
  });

  it('words the events of a pull request from their data', () => {
    expect(eventText({ type: 'merge.pr_pending', data: { target: 'main', head: 'abc' } })).toBe(
      '检查已通过，这个仓库通过 PR 交付（deliver: pr）：不合并进本地的 main，等推送 Run 的分支、开 PR',
    );
    expect(
      eventText({
        type: 'github.pr_opened',
        data: { ...pr, head: 'ares1/run-1', base: 'main' },
      }),
    ).toBe('推送了 Run 的分支，PR #12 等着合并到 main');
    expect(
      eventText({
        type: 'github.pr_merged',
        data: { ...pr, mergeCommit: '0123456789abcdef0123456789abcdef01234567' },
      }),
    ).toBe('PR #12 在 GitHub 上合并了（合并提交 01234567），本地目标分支已快进');
    expect(eventText({ type: 'github.pr_merged', data: { ...pr, mergeCommit: null } })).toBe(
      'PR #12 在 GitHub 上合并了，本地目标分支已快进',
    );
    expect(eventText({ type: 'github.pr_closed', data: pr })).toBe(
      'PR #12 没合并就被关掉了，Run 结束为失败',
    );
    // Data not of that shape only shows itself.
    expect(eventText({ type: 'github.pr_closed', data: {} })).toBeNull();
    expect(eventText({ type: 'github.pr_opened', data: pr })).toBeNull();
    expect(eventText({ type: 'merge.pr_pending', data: {} })).toBeNull();
  });

  it('words what became of the pull request of a Run that ended unfinished', () => {
    const closed = (reason: unknown) =>
      eventText({ type: 'github.pr_closed_by_master', data: { ...pr, reason } });
    expect(closed('failed')).toBe(
      'Run 没做完就结束了（失败），PR #12 不会再更新：Master 关掉了它，并在 PR 上说明了原因',
    );
    expect(closed('cancelled')).toContain('（被终止）');
    expect(closed('issue_closed')).toContain('（issue 被关掉，Run 随之终止）');
    expect(closed('restarted')).toContain('（issue 的内容改了，按新内容重新开始）');
    expect(closed('dropped')).toContain('（需求评估决定不做）');
    expect(eventText({ type: 'github.pr_found_closed', data: { ...pr, state: 'merged' } })).toBe(
      'Run 没做完就结束了，它的 PR #12 在 GitHub 上已经合并，Master 没有动它',
    );
    expect(eventText({ type: 'github.pr_found_closed', data: { ...pr, state: 'closed' } })).toBe(
      'Run 没做完就结束了，它的 PR #12 在 GitHub 上已经关掉，不用 Master 再关',
    );
    // Data not of that shape only shows itself.
    expect(closed('lost')).toBeNull();
    expect(
      eventText({ type: 'github.pr_closed_by_master', data: { reason: 'failed' } }),
    ).toBeNull();
    expect(
      eventText({ type: 'github.pr_found_closed', data: { ...pr, state: 'open' } }),
    ).toBeNull();
    expect(eventText({ type: 'github.pr_found_closed', data: pr })).toBeNull();
  });

  const HEAD = '0123456789abcdef0123456789abcdef01234567';
  const BUILD = { name: 'build', url: 'https://github.com/me/demo/actions/runs/1' };
  /** The data of a github.pr_rework event, as the engine records it. */
  const reworkData = (extra: Record<string, unknown> = {}) => ({
    ...pr,
    head: HEAD,
    kinds: ['review'],
    reviewers: ['alice'],
    checks: [],
    ...extra,
  });

  it('words a rework of the pull request by its kinds, reviewers and failed checks', () => {
    const AFTER =
      '。Run 带着这些反馈回到合并阶段的 on_fail 指向的阶段（计入回退上限 max_loops，用完后按 on_exhausted 处理）';
    const SAME = '，改好后推送到同一个 PR';
    expect(eventText({ type: 'github.pr_rework', data: reworkData() })).toBe(
      `PR #12（提交 01234567）需要返工：@alice 要求修改${AFTER}${SAME}`,
    );
    expect(
      eventText({
        type: 'github.pr_rework',
        data: reworkData({ kinds: ['ci'], reviewers: [], checks: [BUILD, { name: 'lint' }] }),
      }),
    ).toBe(`PR #12（提交 01234567）需要返工：CI 检查没通过：build、lint${AFTER}${SAME}`);
    // Every kind at once, listed conflict first; the round gone back to merges the target first.
    expect(
      eventText({
        type: 'github.pr_rework',
        data: reworkData({
          kinds: ['review', 'ci', 'conflict'],
          reviewers: ['alice', null],
          checks: [BUILD],
        }),
      }),
    ).toBe(
      `PR #12（提交 01234567）需要返工：和目标分支冲突；CI 检查没通过：build；@alice、已删除的账号 要求修改${AFTER}；回到的是 Agent 阶段时，那一轮先合并目标分支、解决冲突${SAME}`,
    );
    // Without the head it says no commit.
    expect(eventText({ type: 'github.pr_rework', data: reworkData({ head: null }) })).toBe(
      `PR #12 需要返工：@alice 要求修改${AFTER}${SAME}`,
    );
    // Data not of that shape only shows itself.
    for (const bad of [
      {},
      reworkData({ number: '12' }),
      reworkData({ url: undefined }),
      reworkData({ kinds: [] }),
      reworkData({ kinds: ['review', 'lint'] }),
      reworkData({ kinds: 'review' }),
      reworkData({ reviewers: [1] }),
      reworkData({ reviewers: undefined }),
      reworkData({ checks: ['build'] }),
      reworkData({ checks: [{ url: BUILD.url }] }),
      reworkData({ checks: null }),
    ]) {
      expect(eventText({ type: 'github.pr_rework', data: bad })).toBeNull();
    }
  });

  it('names a few failed checks and counts the rest', () => {
    const checks = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => ({ name, url: null }));
    expect(prReworkReasonText({ kinds: ['ci'], reviewers: [], checks })).toBe(
      'CI 检查没通过：a、b、c、d、e 等 7 个',
    );
    expect(prReworkReasonText({ kinds: ['ci'], reviewers: [], checks: [] })).toBe('CI 检查没通过');
    expect(prReworkReasonText({ kinds: ['review'], reviewers: [], checks: [] })).toBe(
      '评审要求修改',
    );
  });

  it('reads the rework of the data of its event', () => {
    expect(
      pullRequestRework(reworkData({ kinds: ['review', 'conflict'], checks: [BUILD] })),
    ).toEqual({
      ...pr,
      head: HEAD,
      kinds: ['conflict', 'review'],
      reviewers: ['alice'],
      checks: [BUILD],
    });
    expect(pullRequestRework(reworkData({ checks: [{ name: 'lint', url: 3 }] }))?.checks).toEqual([
      { name: 'lint', url: null },
    ]);
    expect(pullRequestRework({})).toBeNull();
  });

  it('words the reworked commits pushed to the same pull request', () => {
    expect(eventText({ type: 'github.pr_updated', data: { ...pr, head: HEAD } })).toBe(
      '返工后的提交已推送到 PR #12（head 01234567），PR 接着等合并',
    );
    expect(eventText({ type: 'github.pr_updated', data: { ...pr, head: null } })).toBe(
      '返工后的提交已推送到 PR #12，PR 接着等合并',
    );
    expect(eventText({ type: 'github.pr_updated', data: { head: HEAD } })).toBeNull();
  });

  it('words a review by someone the Master does not trust, which changed nothing', () => {
    const ignored = { ...pr, head: HEAD, reviewer: 'mallory', association: 'NONE' };
    expect(eventText({ type: 'github.pr_review_ignored', data: ignored })).toBe(
      'PR #12 上 @mallory（NONE）要求修改，但不是仓库成员：评审已忽略，不触发返工，内容也不交给 Agent',
    );
    expect(
      eventText({
        type: 'github.pr_review_ignored',
        data: { ...ignored, reviewer: null, association: 'CONTRIBUTOR' },
      }),
    ).toBe(
      'PR #12 上 已删除的账号（CONTRIBUTOR）要求修改，但不是仓库成员：评审已忽略，不触发返工，内容也不交给 Agent',
    );
    for (const bad of [
      { ...ignored, reviewer: 3 },
      { ...ignored, reviewer: undefined },
      { ...ignored, association: undefined },
      { ...ignored, number: undefined },
    ]) {
      expect(eventText({ type: 'github.pr_review_ignored', data: bad })).toBeNull();
    }
  });

  it('finds the latest rework among the events, and words it for the pull request panel', () => {
    const now = new Date('2026-11-25T12:00:00');
    const at = (time: string) => new Date(`2026-11-25T${time}`).toISOString();
    expect(latestPrRework([])).toBeNull();
    const events = [
      { type: 'github.pr_opened', data: { ...pr, base: 'main' }, ts: at('09:00:00') },
      { type: 'github.pr_rework', data: reworkData(), ts: at('10:00:00') },
      { type: 'github.pr_updated', data: { ...pr, head: HEAD }, ts: at('10:30:00') },
      // Not of the shape: not counted.
      { type: 'github.pr_rework', data: reworkData({ kinds: [] }), ts: at('10:45:00') },
      {
        type: 'github.pr_rework',
        data: reworkData({ kinds: ['ci'], reviewers: [], checks: [BUILD] }),
        ts: at('11:00:00'),
      },
    ];
    const first = latestPrRework(events.slice(0, 3));
    expect(first).toEqual({ ...pullRequestRework(reworkData()), at: at('10:00:00'), count: 1 });
    const latest = latestPrRework(events);
    expect(latest).toMatchObject({ kinds: ['ci'], at: at('11:00:00'), count: 2 });

    expect(prReworkNote({ pr }, first, now)).toBe(
      '这个 PR 返工过 1 次（10:00:00）：@alice 要求修改。',
    );
    expect(prReworkNote({ pr }, latest, now)).toBe(
      '这个 PR 返工过 2 次，最近一次（11:00:00）：CI 检查没通过：build。',
    );
    expect(prReworkNote({ pr }, null, now)).toBeNull();
    expect(prReworkNote({ pr: null }, latest, now)).toBeNull();
    expect(prReworkNote({ pr: { ...pr, number: 13 } }, latest, now)).toBeNull();
  });

  it('in English', () => {
    setLang('en');
    expect(runStatusBadge(waiting({ pr })).label).toBe('Waiting for the PR to merge');
    expect(prWaitTitle(waiting({ pr }))).toBe('Waiting for PR #12 to merge');
    expect(prSummary(waiting({ pr }))?.note).toBe(' (awaiting merge)');
    const texts = [
      prWaitTitle(waiting()),
      prWaitHint(),
      ...prWaitText(waiting({ pr, issue }), 'main'),
      ...prWaitText(waiting(), 'main'),
      prSummary(run('c', 'completed', { pr }))?.note,
      eventText({ type: 'merge.pr_pending', data: { target: 'main' } }),
      eventText({ type: 'github.pr_opened', data: { ...pr, base: 'main' } }),
      eventText({ type: 'github.pr_merged', data: { ...pr, mergeCommit: 'abcdef1234' } }),
      eventText({ type: 'github.pr_merged', data: pr }),
      eventText({ type: 'github.pr_closed', data: pr }),
      ...PR_CLOSE_REASONS.map((reason) =>
        eventText({ type: 'github.pr_closed_by_master', data: { ...pr, reason } }),
      ),
      eventText({ type: 'github.pr_found_closed', data: { ...pr, state: 'merged' } }),
      eventText({ type: 'github.pr_found_closed', data: { ...pr, state: 'closed' } }),
    ];
    expect(texts[1]).toBe(
      'Merging it on GitHub completes the Run; closing it unmerged fails the Run',
    );
    for (const text of texts) {
      expect(text).toBeTruthy();
      expect(text).not.toMatch(/[一-鿿]/);
    }
  });

  it('words reworks in English', () => {
    setLang('en');
    const now = new Date('2026-11-25T12:00:00');
    const at = new Date('2026-11-25T11:00:00').toISOString();
    const every = reworkData({
      kinds: ['conflict', 'ci', 'review'],
      reviewers: ['alice', null],
      checks: [BUILD, { name: 'lint', url: null }],
    });
    expect(eventText({ type: 'github.pr_rework', data: every })).toBe(
      "PR #12 (commit 01234567) needs more work: a conflict with the target branch; failed checks: build, lint; changes requested by @alice, a deleted account. The Run goes back with this feedback to the stage the merge stage's on_fail names (counted toward max_loops; past them, on_exhausted decides); when that is an agent stage, its round starts by merging the target branch to resolve the conflict, and the changes are pushed to the same pull request",
    );
    expect(
      prReworkReasonText({ kinds: ['ci'], reviewers: [], checks: [{ name: 'build', url: null }] }),
    ).toBe('a failed check: build');
    expect(prSummary(run('r', 'running', { pr }))?.note).toBe(' (reworking)');
    const latest = latestPrRework([{ type: 'github.pr_rework', data: reworkData(), ts: at }]);
    expect(prSummary(run('r', 'running', { pr }), latest)?.note).toBe(
      ' (reworking: changes requested by @alice)',
    );
    expect(prReworkNote({ pr }, latest, now)).toBe(
      'This pull request was reworked once (11:00:00), for changes requested by @alice.',
    );
    expect(prReworkNote({ pr }, latest && { ...latest, count: 3 }, now)).toBe(
      'This pull request was reworked 3 times, most recently (11:00:00) for changes requested by @alice.',
    );
    const texts = [
      prWaitText(waiting({ pr, issue }), 'main')[2],
      eventText({ type: 'github.pr_rework', data: every }),
      eventText({ type: 'github.pr_rework', data: reworkData({ head: null }) }),
      prReworkReasonText({ kinds: ['ci'], reviewers: [], checks: [] }),
      prReworkReasonText({
        kinds: ['ci'],
        reviewers: [],
        checks: ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => ({ name, url: null })),
      }),
      prReworkReasonText({ kinds: ['review'], reviewers: [], checks: [] }),
      eventText({ type: 'github.pr_updated', data: { ...pr, head: HEAD } }),
      eventText({ type: 'github.pr_updated', data: pr }),
      eventText({
        type: 'github.pr_review_ignored',
        data: { ...pr, head: HEAD, reviewer: 'mallory', association: 'NONE' },
      }),
      eventText({
        type: 'github.pr_review_ignored',
        data: { ...pr, head: HEAD, reviewer: null, association: 'NONE' },
      }),
    ];
    expect(texts[7]).toBe(
      'The reworked commits were pushed to PR #12, which waits to be merged again',
    );
    expect(texts[8]).toBe(
      'The review by @mallory (NONE) asking for changes on PR #12 was ignored, as they are not a member of the repo: it triggers no rework, and its text goes to no agent',
    );
    expect(texts[4]).toBe('failed checks: a, b, c, d, e and 1 more');
    for (const text of texts) {
      expect(text).toBeTruthy();
      expect(text).not.toMatch(/[一-鿿]/);
    }
  });
});

describe('waiting for a merge request on GitLab', () => {
  afterEach(() => setLang('zh'));
  const mr = { number: 12, url: 'https://gitlab.com/my-group/demo/-/merge_requests/12' };
  const issue = {
    repo: 'my-group/demo',
    number: 7,
    url: 'https://gitlab.com/my-group/demo/-/issues/7',
    auto: false,
    platform: 'gitlab' as const,
  } satisfies RunSummary['issue'];
  const waiting = (extra: Partial<RunSummary> = {}) =>
    run('w', 'blocked', {
      blocked: { kind: 'pr_open', message: 'checks passed', stageRunId: 'sr' },
      ...extra,
    });
  const HEAD = '0123456789abcdef0123456789abcdef01234567';
  const JOB = { name: 'build', url: 'https://gitlab.com/my-group/demo/-/jobs/1' };
  /** The data of a github.pr_rework event, as the engine records it for a GitLab Run. */
  const reworkData = (extra: Record<string, unknown> = {}) => ({
    ...mr,
    head: HEAD,
    kinds: ['ci'],
    reviewers: [],
    checks: [JOB],
    platform: 'gitlab',
    ...extra,
  });

  it('names the merge request MR !N', () => {
    expect(prName(mr, 'gitlab')).toBe('MR !12');
    expect(prName(mr, 'github')).toBe('PR #12');
  });

  it('badges and heads it as waiting for the MR, by the issue or the given platform', () => {
    expect(runStatusBadge(waiting({ pr: mr, issue })).label).toBe('等 MR 合并');
    // A Run of no issue on a GitLab repo: the caller gives the repo's platform.
    expect(runStatusBadge(waiting({ pr: mr }), 'gitlab').label).toBe('等 MR 合并');
    expect(prWaitTitle(waiting({ pr: mr }), 'gitlab')).toBe('等 MR 合并 !12');
    expect(prWaitTitle(waiting(), 'gitlab')).toBe('等 MR 合并：下次检查 GitLab 时推送分支、开 MR');
    expect(prWaitHint('gitlab')).toBe('在 GitLab 上合并后 Run 自动完成；没合并就关掉，Run 失败');
  });

  it('explains what merging, asking for changes on or closing it on GitLab does', () => {
    const lines = prWaitText(waiting({ pr: mr, issue }), 'main', 'gitlab');
    expect(lines[0]).toBe('检查已通过，Run 的分支已推送到 GitLab，MR !12 等着合并到 main。');
    expect(lines[1]).toBe(
      '在 GitLab 上合并它（合并方式不限）后，Master 下次检查 GitLab 时把本地的 main 快进到合并后的提交，Run 完成，issue 关闭。',
    );
    expect(lines[2]).toBe(
      'MR 上受信任的人（项目里 Developer 及以上的成员，包括从群组继承的）要求修改、head 流水线结束且有失败的 job，或者和 main 冲突时，Master 下次检查 GitLab 时让 Run 带着这些反馈自动回去返工（回到合并阶段的 on_fail 指向的阶段，计入回退上限 max_loops），改好后推送到同一个 MR。其他人的评审不触发返工，也不交给 Agent。',
    );
    expect(lines[3]).toBe(
      'MR 没合并就被关掉时，Run 结束为失败；还有重做次数（max_run_attempts）时 issue 自动重做，重做的 Run 开新的 MR。',
    );
    expect(lines[4]).toContain(
      '终止 Run 后，Master 下次检查 GitLab 时会关掉这个 MR（已经合并的不动）',
    );
    const early = prWaitText(waiting(), 'main', 'gitlab');
    expect(early[0]).toContain('Master 下次检查 GitLab 时推送 Run 的分支，开一个合并到 main 的 MR');
    expect(early[3]).toBe('MR 没合并就被关掉时，Run 结束为失败。');
    for (const line of [...lines, ...early]) {
      expect(line).not.toMatch(/GitHub|PR\b/);
    }
  });

  it('says the Master closes it once the Run is cancelled', () => {
    expect(prCancelHint('gitlab')).toBe(
      '终止后，Master 下次检查 GitLab 时关掉这个 MR 并留言说明（已经合并的不动）。',
    );
    expect(prCancelHint('github')).toBe(
      '终止后，Master 下次检查 GitHub 时关掉这个 PR 并留言说明（已经合并的不动）。',
    );
  });

  it('says there is nothing to retry in the words of its code host, not both', () => {
    expect(prRetryHint('gitlab')).toBe(
      '不能重试：MR 合并后 Run 会完成；没合并就关掉，Run 会结束为失败。',
    );
    expect(prRetryHint('github')).toBe(
      '不能重试：PR 合并后 Run 会完成；没合并就关掉，Run 会结束为失败。',
    );
    setLang('en');
    try {
      expect(prRetryHint('gitlab')).toBe(
        'No retry here: merge the merge request and the Run completes; close it unmerged and the Run ends as failed.',
      );
      expect(prRetryHint('github')).toBe(
        'No retry here: merge the pull request and the Run completes; close it unmerged and the Run ends as failed.',
      );
    } finally {
      setLang('zh');
    }
  });

  it('sums it up as !N, with a failed pipeline as the reason of a rework', () => {
    expect(prSummary(waiting({ pr: mr }), null, 'gitlab')).toEqual({
      label: '!12',
      note: '（等合并）',
    });
    expect(prSummary(run('c', 'completed', { pr: mr }), null, 'gitlab')?.label).toBe('!12');
    const rework = { number: 12, kinds: ['ci' as const], reviewers: [], checks: [JOB] };
    expect(prSummary(run('r', 'running', { pr: mr }), rework, 'gitlab')).toEqual({
      label: '!12',
      note: '（返工中：流水线没通过：build）',
    });
    expect(prReworkReasonText({ kinds: ['ci'], reviewers: [], checks: [] }, 'gitlab')).toBe(
      '流水线没通过',
    );
  });

  it('words the reworks of the merge request for its panel', () => {
    const now = new Date('2026-11-25T12:00:00');
    const at = new Date('2026-11-25T11:00:00').toISOString();
    const latest = latestPrRework([{ type: 'github.pr_rework', data: reworkData(), ts: at }]);
    expect(prReworkNote({ pr: mr }, latest, now, 'gitlab')).toBe(
      '这个 MR 返工过 1 次（11:00:00）：流水线没通过：build。',
    );
    expect(prReworkNote({ pr: mr }, latest && { ...latest, count: 2 }, now, 'gitlab')).toBe(
      '这个 MR 返工过 2 次，最近一次（11:00:00）：流水线没通过：build。',
    );
  });

  it('words the events of a merge request by the platform in their data', () => {
    const gitlab = { ...mr, platform: 'gitlab' };
    // The merge stage's wait names no platform: the Run's says it.
    expect(
      eventText({ type: 'merge.pr_pending', data: { target: 'main' } }, undefined, 'gitlab'),
    ).toBe(
      '检查已通过，这个仓库通过 MR 交付（deliver: mr）：不合并进本地的 main，等推送 Run 的分支、开 MR',
    );
    const text = (type: string, data: Record<string, unknown>) =>
      eventText({ type, data: { ...gitlab, ...data } });
    expect(text('github.pr_opened', { base: 'main' })).toBe(
      '推送了 Run 的分支，MR !12 等着合并到 main',
    );
    expect(text('github.pr_merged', { mergeCommit: HEAD })).toBe(
      'MR !12 在 GitLab 上合并了（合并提交 01234567），本地目标分支已快进',
    );
    expect(text('github.pr_merged', { mergeCommit: null })).toBe(
      'MR !12 在 GitLab 上合并了，本地目标分支已快进',
    );
    expect(text('github.pr_closed', {})).toBe('MR !12 没合并就被关掉了，Run 结束为失败');
    expect(text('github.pr_closed_by_master', { reason: 'cancelled' })).toBe(
      'Run 没做完就结束了（被终止），MR !12 不会再更新：Master 关掉了它，并在 MR 上说明了原因',
    );
    expect(text('github.pr_found_closed', { state: 'merged' })).toBe(
      'Run 没做完就结束了，它的 MR !12 在 GitLab 上已经合并，Master 没有动它',
    );
    expect(text('github.pr_found_closed', { state: 'closed' })).toBe(
      'Run 没做完就结束了，它的 MR !12 在 GitLab 上已经关掉，不用 Master 再关',
    );
    expect(eventText({ type: 'github.pr_rework', data: reworkData() })).toBe(
      'MR !12（提交 01234567）需要返工：流水线没通过：build。Run 带着这些反馈回到合并阶段的 on_fail 指向的阶段（计入回退上限 max_loops，用完后按 on_exhausted 处理），改好后推送到同一个 MR',
    );
    expect(text('github.pr_updated', { head: HEAD })).toBe(
      '返工后的提交已推送到 MR !12（head 01234567），MR 接着等合并',
    );
    expect(text('github.pr_updated', { head: null })).toBe(
      '返工后的提交已推送到 MR !12，MR 接着等合并',
    );
    expect(
      text('github.pr_review_ignored', { head: HEAD, reviewer: 'rita', association: 'REPORTER' }),
    ).toBe(
      'MR !12 上 @rita（REPORTER）要求修改，但不是项目里 Developer 及以上的成员：评审已忽略，不触发返工，内容也不交给 Agent',
    );
    // An event of GitHub's, without the platform, stays GitHub's whatever the Run's.
    expect(eventText({ type: 'github.pr_closed', data: mr }, undefined, 'gitlab')).toBe(
      'PR #12 没合并就被关掉了，Run 结束为失败',
    );
  });

  it('in English', () => {
    setLang('en');
    const now = new Date('2026-11-25T12:00:00');
    const at = new Date('2026-11-25T11:00:00').toISOString();
    const gitlab = { ...mr, platform: 'gitlab' };
    expect(runStatusBadge(waiting({ pr: mr, issue })).label).toBe('Waiting for the MR to merge');
    expect(prWaitTitle(waiting({ pr: mr }), 'gitlab')).toBe('Waiting for MR !12 to merge');
    expect(prWaitHint('gitlab')).toBe(
      'Merging it on GitLab completes the Run; closing it unmerged fails the Run',
    );
    const lines = prWaitText(waiting({ pr: mr, issue }), 'main', 'gitlab');
    expect(lines[2]).toBe(
      "If someone the Master trusts (a member of the project from Developer up, also through its groups) asks for changes on it, its head pipeline finishes with failed jobs, or it conflicts with main, the Master sends the Run back to work on it with that feedback at its next GitLab check (to the stage the merge stage's on_fail names, counted toward max_loops), and the changes are pushed to the same merge request. Reviews by anyone else trigger no rework and go to no agent.",
    );
    const latest = latestPrRework([{ type: 'github.pr_rework', data: reworkData(), ts: at }]);
    expect(prReworkNote({ pr: mr }, latest, now, 'gitlab')).toBe(
      'This merge request was reworked once (11:00:00), for a failed pipeline job: build.',
    );
    expect(eventText({ type: 'github.pr_rework', data: reworkData() })).toBe(
      "MR !12 (commit 01234567) needs more work: a failed pipeline job: build. The Run goes back with this feedback to the stage the merge stage's on_fail names (counted toward max_loops; past them, on_exhausted decides), and the changes are pushed to the same merge request",
    );
    const event = (type: string, data: Record<string, unknown>) =>
      eventText({ type, data: { ...gitlab, ...data } });
    const texts = [
      prWaitTitle(waiting(), 'gitlab'),
      ...lines,
      ...prWaitText(waiting(), 'main', 'gitlab'),
      prCancelHint('gitlab'),
      prSummary(waiting({ pr: mr }), null, 'gitlab')?.note,
      prReworkReasonText({ kinds: ['ci'], reviewers: [], checks: [] }, 'gitlab'),
      prReworkReasonText(
        { kinds: ['ci'], reviewers: [], checks: [JOB, { name: 'lint', url: null }] },
        'gitlab',
      ),
      eventText({ type: 'merge.pr_pending', data: { target: 'main' } }, undefined, 'gitlab'),
      event('github.pr_opened', { base: 'main' }),
      event('github.pr_merged', { mergeCommit: HEAD }),
      event('github.pr_merged', {}),
      event('github.pr_closed', {}),
      ...PR_CLOSE_REASONS.map((reason) => event('github.pr_closed_by_master', { reason })),
      event('github.pr_found_closed', { state: 'merged' }),
      event('github.pr_found_closed', { state: 'closed' }),
      event('github.pr_updated', { head: HEAD }),
      event('github.pr_updated', {}),
      event('github.pr_review_ignored', { reviewer: 'rita', association: 'REPORTER' }),
    ];
    expect(texts.at(-1)).toBe(
      'The review by @rita (REPORTER) asking for changes on MR !12 was ignored, as they are not a member of the project from Developer up: it triggers no rework, and its text goes to no agent',
    );
    expect(
      eventText({ type: 'merge.pr_pending', data: { target: 'main' } }, undefined, 'gitlab'),
    ).toBe(
      "The checks passed and this repo delivers through merge requests (deliver: mr): nothing is merged into the local main; the Run's branch is to be pushed and a merge request opened",
    );
    for (const text of texts) {
      expect(text).toBeTruthy();
      expect(text).not.toMatch(/[一-鿿]/);
      expect(text).not.toMatch(/GitHub|pull request|PR #/);
    }
  });
});
