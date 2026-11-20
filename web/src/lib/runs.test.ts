import { afterEach, describe, expect, it } from 'vitest';
import type { RunSummary } from '../../../src/api/types.js';
import { setLang } from '../../../src/i18n.js';
import type { AssessmentEntry, DiscussionEntry } from '../../../src/store/types.js';
import {
  assessmentHeadline,
  attentionCount,
  canCleanUpWorkspace,
  discussionItems,
  groupRuns,
  pageTitle,
  patchLineClass,
  splitPatch,
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
});
