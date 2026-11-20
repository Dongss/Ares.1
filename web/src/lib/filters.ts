import type { RunSummary } from '../../../src/api/types.js';
import { t } from '../../../src/i18n.js';
import { FINISHED_RUN_STATUSES, type RunStatus } from '../../../src/store/types.js';
import { useLocationHash } from './router.js';
import { FINISHED_PREVIEW_LIMIT, groupRuns } from './runs.js';

/**
 * Status groups for the home Run list. The "needs me" group includes paused runs;
 * the tab badge still counts only approvals and blocked runs (`attentionCount`).
 * Labels are getters, so they are in the language in use when read.
 */
export const RUN_STATUS_FILTERS = [
  {
    id: 'all',
    get label() {
      return t({ zh: '全部', en: 'All' });
    },
  },
  {
    id: 'active',
    get label() {
      return t({ zh: '进行中', en: 'In progress' });
    },
  },
  {
    id: 'attention',
    get label() {
      return t({ zh: '等我处理', en: 'Needs me' });
    },
  },
  {
    id: 'completed',
    get label() {
      return t({ zh: '已完成', en: 'Completed' });
    },
  },
  {
    id: 'dropped',
    get label() {
      return t({ zh: '不做', en: 'Dropped' });
    },
  },
  {
    id: 'failed',
    get label() {
      return t({ zh: '失败或已终止', en: 'Failed or cancelled' });
    },
  },
] as const;

export type RunStatusFilter = (typeof RUN_STATUS_FILTERS)[number]['id'];

/** Run statuses in each status filter (also the groups of the statistics page). */
export const RUN_STATUS_GROUPS: Record<Exclude<RunStatusFilter, 'all'>, readonly RunStatus[]> = {
  active: ['queued', 'running'],
  attention: ['waiting_approval', 'blocked', 'paused'],
  completed: ['completed'],
  /** Ended by the requirement assessment; not a failure. */
  dropped: ['dropped'],
  failed: ['failed', 'cancelled'],
};

export interface RunListFilter {
  status: RunStatusFilter;
  /** Null means every repository. */
  repoId: string | null;
}

export function parseRunListFilter(hash: string): RunListFilter {
  const queryAt = hash.indexOf('?');
  if (queryAt === -1) return { status: 'all', repoId: null };
  const params = new URLSearchParams(hash.slice(queryAt + 1));
  const statusRaw = params.get('status');
  const status = RUN_STATUS_FILTERS.some((item) => item.id === statusRaw)
    ? (statusRaw as RunStatusFilter)
    : 'all';
  const repoId = params.get('repo') || null;
  return { status, repoId };
}

/** Hash URL that restores `filter` after a refresh. Defaults are omitted. */
export function runListHref(filter: RunListFilter): string {
  const params = new URLSearchParams();
  if (filter.status !== 'all') params.set('status', filter.status);
  if (filter.repoId) params.set('repo', filter.repoId);
  const query = params.toString();
  return query ? `#/?${query}` : '#/';
}

/**
 * Drop a repository filter the page cannot show: a single registered repo, or an id
 * that is not registered.
 */
export function effectiveRunFilter(
  filter: RunListFilter,
  repoIds: readonly string[],
): RunListFilter {
  const repoId =
    repoIds.length > 1 && filter.repoId !== null && repoIds.includes(filter.repoId)
      ? filter.repoId
      : null;
  return { status: filter.status, repoId };
}

export function filterRuns(runs: readonly RunSummary[], filter: RunListFilter): RunSummary[] {
  return runs.filter((run) => {
    if (filter.repoId !== null && run.repoId !== filter.repoId) return false;
    if (filter.status === 'all') return true;
    return RUN_STATUS_GROUPS[filter.status].includes(run.status);
  });
}

/** Counts for each status chip. Pass repository-scoped runs so the numbers match that repo. */
export function countRunFilters(runs: readonly RunSummary[]): Record<RunStatusFilter, number> {
  const counts: Record<RunStatusFilter, number> = {
    all: runs.length,
    active: 0,
    attention: 0,
    completed: 0,
    dropped: 0,
    failed: 0,
  };
  const groups = Object.keys(RUN_STATUS_GROUPS) as (keyof typeof RUN_STATUS_GROUPS)[];
  for (const run of runs) {
    for (const id of groups) {
      if (RUN_STATUS_GROUPS[id].includes(run.status)) counts[id] += 1;
    }
  }
  return counts;
}

export function useRunListFilter(): RunListFilter {
  return parseRunListFilter(useLocationHash());
}

export interface HomeSection {
  id: 'attention' | 'running' | 'queued' | 'paused' | 'finished';
  title: string;
  runs: RunSummary[];
  /** Shown when the section is visible but has no runs (the dashboard). */
  emptyText?: string;
  highlight?: boolean;
  /** Set when the recently finished section hides older finished runs. */
  note?: string;
}

function finishedCapNote(): string {
  return t({
    zh: `仅显示最近 ${FINISHED_PREVIEW_LIMIT} 条，查看全部请点「已完成」或「失败或已终止」`,
    en: `Only the latest ${FINISHED_PREVIEW_LIMIT} are shown; click "Completed" or "Failed or cancelled" to see all`,
  });
}

/**
 * Sections the home list shows for `filter`.
 * An empty array means nothing matches. "All" keeps the dashboard groups and the
 * default finished cap; one status shows only that group, with every finished run.
 */
export function homeSections(runs: readonly RunSummary[], filter: RunListFilter): HomeSection[] {
  const visible = filterRuns(runs, filter);
  if (visible.length === 0) return [];
  // "All" uses groupRuns' default cap; a status filter shows every finished run.
  const groups = filter.status === 'all' ? groupRuns(visible) : groupRuns(visible, visible.length);
  const dashboard = filter.status === 'all';
  const sections: HomeSection[] = [];

  if (dashboard || (filter.status === 'attention' && groups.attention.length > 0)) {
    sections.push({
      id: 'attention',
      title: t({ zh: '待我处理', en: 'Needs me' }),
      runs: groups.attention,
      emptyText: t({ zh: '没有需要处理的事项。', en: 'Nothing needs you.' }),
      highlight: true,
    });
  }
  if (dashboard || (filter.status === 'active' && groups.running.length > 0)) {
    sections.push({
      id: 'running',
      title: t({ zh: '正在执行', en: 'Running' }),
      runs: groups.running,
      emptyText: t({ zh: '没有正在执行的 Run。', en: 'No Run is running.' }),
    });
  }
  if ((dashboard || filter.status === 'active') && groups.queued.length > 0) {
    sections.push({ id: 'queued', title: t({ zh: '排队中', en: 'Queued' }), runs: groups.queued });
  }
  if ((dashboard || filter.status === 'attention') && groups.paused.length > 0) {
    sections.push({ id: 'paused', title: t({ zh: '已暂停', en: 'Paused' }), runs: groups.paused });
  }
  const finishedFilter =
    filter.status === 'completed' || filter.status === 'dropped' || filter.status === 'failed';
  if (groups.finished.length > 0 && (dashboard || finishedFilter)) {
    const recent = t({ zh: '最近结束', en: 'Recently finished' });
    const title = finishedFilter
      ? (RUN_STATUS_FILTERS.find((f) => f.id === filter.status)?.label ?? recent)
      : recent;
    const finishedTotal = visible.filter((run) =>
      FINISHED_RUN_STATUSES.includes(run.status),
    ).length;
    sections.push({
      id: 'finished',
      title,
      runs: groups.finished,
      note: dashboard && finishedTotal > groups.finished.length ? finishedCapNote() : undefined,
    });
  }
  return sections;
}
