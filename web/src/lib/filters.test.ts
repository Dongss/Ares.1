import { afterEach, describe, expect, it } from 'vitest';
import type { RunSummary } from '../../../src/api/types.js';
import { setLang } from '../../../src/i18n.js';
import type { RunStatus } from '../../../src/store/types.js';
import {
  countRunFilters,
  effectiveRunFilter,
  filterRuns,
  homeSections,
  parseRunListFilter,
  RUN_STATUS_FILTERS,
  runListHref,
} from './filters.js';
import { queueRanks } from './runs.js';

function run(
  id: string,
  status: RunStatus,
  repoId = 'repo-1',
  extra: Partial<RunSummary> = {},
): RunSummary {
  return {
    id,
    repoId,
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
  };
}

const ALL_STATUSES: RunStatus[] = [
  'queued',
  'running',
  'waiting_approval',
  'blocked',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'dropped',
];

describe('filterRuns', () => {
  const runs = [
    run('q', 'queued', 'repo-1'),
    run('r', 'running', 'repo-2'),
    run('w', 'waiting_approval', 'repo-1'),
    run('b', 'blocked', 'repo-2'),
    run('p', 'paused', 'repo-1'),
    run('c', 'completed', 'repo-2'),
    run('f', 'failed', 'repo-1'),
    run('x', 'cancelled', 'repo-2'),
    run('d', 'dropped', 'repo-1'),
  ];

  it('keeps order and groups statuses', () => {
    const ids = (status: 'all' | 'active' | 'attention' | 'completed' | 'dropped' | 'failed') =>
      filterRuns(runs, { status, repoId: null }).map((item) => item.id);
    expect(ids('all')).toEqual(['q', 'r', 'w', 'b', 'p', 'c', 'f', 'x', 'd']);
    expect(ids('active')).toEqual(['q', 'r']);
    expect(ids('attention')).toEqual(['w', 'b', 'p']);
    expect(ids('completed')).toEqual(['c']);
    expect(ids('failed')).toEqual(['f', 'x']);
    // Not doing it after the assessment is not a failure.
    expect(ids('dropped')).toEqual(['d']);
  });

  it('filters by repository together with status', () => {
    expect(
      filterRuns(runs, { status: 'attention', repoId: 'repo-1' }).map((item) => item.id),
    ).toEqual(['w', 'p']);
  });

  it('counts every status in exactly one group', () => {
    const counts = countRunFilters(ALL_STATUSES.map((status, i) => run(String(i), status)));
    expect(counts).toEqual({
      all: 9,
      active: 2,
      attention: 3,
      completed: 1,
      dropped: 1,
      failed: 2,
    });
    expect(countRunFilters(runs.filter((item) => item.repoId === 'repo-1')).all).toBe(5);
  });
});

describe('run list hash', () => {
  it('round-trips filters and omits defaults', () => {
    expect(runListHref({ status: 'all', repoId: null })).toBe('#/');
    expect(parseRunListFilter('#/')).toEqual({ status: 'all', repoId: null });
    expect(parseRunListFilter('')).toEqual({ status: 'all', repoId: null });
    const filter = { status: 'active' as const, repoId: 'repo/1' };
    expect(parseRunListFilter(runListHref(filter))).toEqual(filter);
    expect(runListHref({ status: 'failed', repoId: 'repo-2' })).toBe(
      '#/?status=failed&repo=repo-2',
    );
  });

  it('treats unknown values as no filter', () => {
    expect(parseRunListFilter('#/?status=nope&repo=')).toEqual({ status: 'all', repoId: null });
    expect(parseRunListFilter('#/?repo=repo-1&status=completed')).toEqual({
      status: 'completed',
      repoId: 'repo-1',
    });
  });

  it('hides a repository filter the page cannot offer', () => {
    const filter = { status: 'active' as const, repoId: 'repo-2' };
    expect(effectiveRunFilter(filter, ['repo-1'])).toEqual({ status: 'active', repoId: null });
    expect(effectiveRunFilter(filter, [])).toEqual({ status: 'active', repoId: null });
    expect(effectiveRunFilter(filter, ['repo-1', 'repo-9'])).toEqual({
      status: 'active',
      repoId: null,
    });
    expect(effectiveRunFilter(filter, ['repo-1', 'repo-2'])).toEqual(filter);
  });
});

describe('queue rank across repositories', () => {
  it('keeps the global queue rank after a repository filter', () => {
    const runs = [
      run('a', 'queued', 'repo-a', { queuePos: 2 }),
      run('b', 'queued', 'repo-b', { queuePos: 1 }),
    ];
    const ranks = queueRanks(runs);
    const queued = homeSections(runs, { status: 'all', repoId: 'repo-a' }).find(
      (section) => section.id === 'queued',
    );
    expect(queued?.runs.map((item) => item.id)).toEqual(['a']);
    expect(queued?.runs.map((item) => ranks.get(item.id))).toEqual([2]);
    expect(ranks.get('b')).toBe(1);
  });
});

describe('homeSections', () => {
  const capNote = '仅显示最近 20 条，查看全部请点「已完成」或「失败或已终止」';

  function finished(count: number, status: RunStatus = 'completed', prefix = 'f') {
    return Array.from({ length: count }, (_, i) =>
      run(`${prefix}${i}`, status, 'repo-1', {
        finishedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      }),
    );
  }

  it('keeps empty dashboard groups and caps recent finishes', () => {
    const runs = [run('q', 'queued', 'repo-1', { queuePos: 1 }), ...finished(21)];
    const sections = homeSections(runs, { status: 'all', repoId: null });
    expect(sections.map((section) => [section.id, section.title])).toEqual([
      ['attention', '待我处理'],
      ['running', '正在执行'],
      ['queued', '排队中'],
      ['finished', '最近结束'],
    ]);
    expect(sections[0]?.runs).toEqual([]);
    expect(sections[0]?.emptyText).toBe('没有需要处理的事项。');
    expect(sections[0]?.highlight).toBe(true);
    expect(sections[1]?.emptyText).toBe('没有正在执行的 Run。');
    const recent = sections[3];
    expect(recent?.runs).toHaveLength(20);
    expect(recent?.runs[0]?.id).toBe('f20');
    expect(recent?.runs.at(-1)?.id).toBe('f1');
    expect(recent?.note).toBe(capNote);
  });

  it('omits the cap note when every finished run fits', () => {
    const sections = homeSections(finished(3), { status: 'all', repoId: null });
    expect(sections.find((section) => section.id === 'finished')?.note).toBeUndefined();
  });

  it('shows only the active groups that have runs', () => {
    const runs = [
      run('q', 'queued', 'repo-1', { queuePos: 1 }),
      run('c', 'completed', 'repo-1', { finishedAt: '2026-11-18T00:00:00.000Z' }),
    ];
    expect(
      homeSections(runs, { status: 'active', repoId: null }).map((section) => section.id),
    ).toEqual(['queued']);
    const both = homeSections([...runs, run('r', 'running')], { status: 'active', repoId: null });
    expect(both.map((section) => [section.id, section.runs.map((item) => item.id)])).toEqual([
      ['running', ['r']],
      ['queued', ['q']],
    ]);
  });

  it('splits 等我处理 into attention and paused', () => {
    const runs = [run('w', 'waiting_approval'), run('b', 'blocked'), run('p', 'paused')];
    const sections = homeSections(runs, { status: 'attention', repoId: null });
    expect(sections.map((section) => [section.id, section.runs.map((item) => item.id)])).toEqual([
      ['attention', ['w', 'b']],
      ['paused', ['p']],
    ]);
  });

  it('shows every matching finished run when a status is selected', () => {
    const runs = [
      ...finished(21),
      run('f', 'failed', 'repo-1', { finishedAt: '2026-11-18T00:00:00.000Z' }),
      run('x', 'cancelled', 'repo-1', { finishedAt: '2026-11-18T01:00:00.000Z' }),
    ];
    const done = homeSections(runs, { status: 'completed', repoId: null });
    expect(done).toHaveLength(1);
    expect(done[0]?.title).toBe('已完成');
    expect(done[0]?.runs).toHaveLength(21);
    expect(done[0]?.note).toBeUndefined();
    const bad = homeSections(runs, { status: 'failed', repoId: null });
    expect(bad[0]?.title).toBe('失败或已终止');
    expect(bad[0]?.runs.map((item) => item.id)).toEqual(['x', 'f']);
    expect(bad[0]?.note).toBeUndefined();
  });

  it('returns no sections when nothing matches', () => {
    expect(homeSections([run('c', 'completed')], { status: 'active', repoId: null })).toEqual([]);
  });

  describe('with concurrency.max_runs', () => {
    afterEach(() => setLang('zh'));
    const runs = [
      run('a', 'running', 'repo-a'),
      run('b', 'running', 'repo-b'),
      run('q', 'queued', 'repo-a', { queuePos: 1, waitingForMaxRuns: true }),
    ];
    const runningNote = (filter: Parameters<typeof homeSections>[1], maxRuns: number | null) =>
      homeSections(runs, filter, maxRuns).find((section) => section.id === 'running')?.note;

    it('notes the Runs executing across all repos against the limit', () => {
      expect(runningNote({ status: 'all', repoId: null }, 2)).toBe(
        '执行中 2 / 上限 2（concurrency.max_runs）',
      );
      expect(runningNote({ status: 'active', repoId: null }, 3)).toBe(
        '执行中 2 / 上限 3（concurrency.max_runs）',
      );
      // One repo's list still counts every repo's Runs, and says so.
      expect(runningNote({ status: 'all', repoId: 'repo-a' }, 2)).toBe(
        '所有仓库执行中 2 / 上限 2（concurrency.max_runs）',
      );
      // Also when none executes.
      expect(
        homeSections([run('q', 'queued')], { status: 'all', repoId: null }, 1).find(
          (section) => section.id === 'running',
        )?.note,
      ).toBe('执行中 0 / 上限 1（concurrency.max_runs）');
      // No limit: as before.
      expect(runningNote({ status: 'all', repoId: null }, null)).toBeUndefined();
    });

    it('notes it in English', () => {
      setLang('en');
      expect(runningNote({ status: 'all', repoId: null }, 3)).toBe(
        '2 of at most 3 executing (concurrency.max_runs)',
      );
      expect(runningNote({ status: 'all', repoId: 'repo-b' }, 3)).toBe(
        '2 of at most 3 executing across all repos (concurrency.max_runs)',
      );
    });
  });

  it('groups only the selected repository', () => {
    const runs = [
      run('a', 'running', 'repo-a'),
      run('b', 'running', 'repo-b'),
      run('c', 'paused', 'repo-a'),
    ];
    const sections = homeSections(runs, { status: 'all', repoId: 'repo-a' });
    expect(
      sections.find((section) => section.id === 'running')?.runs.map((item) => item.id),
    ).toEqual(['a']);
    expect(
      sections.find((section) => section.id === 'paused')?.runs.map((item) => item.id),
    ).toEqual(['c']);
  });
});

describe('in English', () => {
  afterEach(() => setLang('zh'));

  it('labels filters and sections in the language in use, read each time', () => {
    expect(RUN_STATUS_FILTERS[0].label).toBe('全部');
    setLang('en');
    expect(RUN_STATUS_FILTERS.map((f) => f.label)).toEqual([
      'All',
      'In progress',
      'Needs me',
      'Completed',
      'Dropped',
      'Failed or cancelled',
    ]);
    const runs = Array.from({ length: 21 }, (_, i) =>
      run(`f${i}`, 'completed', 'repo-1', {
        finishedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      }),
    );
    const sections = homeSections(runs, { status: 'all', repoId: null });
    expect(sections.map((section) => section.title)).toEqual([
      'Needs me',
      'Running',
      'Recently finished',
    ]);
    for (const section of sections) {
      expect(`${section.title} ${section.emptyText ?? ''} ${section.note ?? ''}`).not.toMatch(
        /[\u4e00-\u9fff]/,
      );
    }
    expect(sections[2]?.note).toContain('latest 20');
    expect(
      homeSections(runs, { status: 'completed', repoId: null }).map((section) => section.title),
    ).toEqual(['Completed']);
  });
});
