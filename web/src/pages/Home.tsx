import type { ReactNode } from 'react';
import type { RunSummary } from '../../../src/api/types.js';
import { t } from '../../../src/i18n.js';
import type { Repo } from '../../../src/store/types.js';
import { Badge, Empty } from '../components/ui.js';
import {
  countRunFilters,
  effectiveRunFilter,
  filterRuns,
  homeSections,
  RUN_STATUS_FILTERS,
  type RunListFilter,
  type RunStatusFilter,
  runListHref,
  useRunListFilter,
} from '../lib/filters.js';
import {
  BLOCK_KIND,
  formatRunCost,
  formatSpan,
  formatTime,
  goalTitle,
  messageExcerpt,
} from '../lib/format.js';
import { useTick } from '../lib/hooks.js';
import { href } from '../lib/router.js';
import {
  conflictWaitText,
  maxRunsWaitText,
  prWaitHint,
  prWaitTitle,
  queueRanks,
  runStatusBadge,
  waitingForPr,
} from '../lib/runs.js';

export function HomePage({
  runs,
  repos,
  maxRuns,
}: {
  runs: RunSummary[];
  repos: Repo[];
  /** config.yaml's `concurrency.max_runs`; null = no limit, or the configuration is not loaded. */
  maxRuns: number | null;
}) {
  const filter = effectiveRunFilter(
    useRunListFilter(),
    repos.map((repo) => repo.id),
  );
  const counts = countRunFilters(filterRuns(runs, { status: 'all', repoId: filter.repoId }));
  const sections = homeSections(runs, filter, maxRuns);
  // The queue is global. Ranks come from every run, not the filtered list.
  const ranks = queueRanks(runs);
  const repoName = (id: string) => repos.find((r) => r.id === id)?.name ?? id;
  useTick(
    1000,
    sections.some((section) => section.id === 'running' && section.runs.length > 0),
  );

  if (runs.length === 0) {
    return (
      <Empty>
        {t({
          zh: (
            <>
              还没有 Run。Run 只从 GitHub issue 来：
              {repos.length === 0 ? (
                <>
                  先<a href={href.repos}>登记仓库</a>，再
                </>
              ) : null}
              在 GitHub 提 issue 并加上 <code>ares1:ready</code>。接入情况和 issue 见
              <a href={href.issues}>「需求」页</a>。
            </>
          ),
          en: (
            <>
              No Runs yet. Runs only come from GitHub issues:{' '}
              {repos.length === 0 ? (
                <>
                  <a href={href.repos}>register a repo</a>, then{' '}
                </>
              ) : null}
              open an issue on GitHub labeled <code>ares1:ready</code>. The GitHub connection and
              issues are on the <a href={href.issues}>Issues</a> page.
            </>
          ),
        })}
      </Empty>
    );
  }

  const card = (run: RunSummary, extra?: ReactNode) => (
    <RunCard
      key={run.id}
      run={run}
      repo={repoName(run.repoId)}
      extra={extra}
      after={waitingForPr(run) ? <PrWaitNote run={run} /> : undefined}
    />
  );

  return (
    <div className="home">
      <RunFilters filter={filter} counts={counts} repos={repos} />
      {sections.length === 0 ? (
        <Empty>{t({ zh: '没有符合条件的 Run。', en: 'No Runs match.' })}</Empty>
      ) : (
        sections.map((section) => (
          <Section
            key={section.id}
            title={section.title}
            count={section.runs.length}
            highlight={section.highlight}
            note={section.note}
          >
            {section.runs.length === 0 ? (
              <Empty>{section.emptyText}</Empty>
            ) : (
              section.runs.map((run) =>
                card(
                  run,
                  section.id === 'queued'
                    ? queueExtra(run, ranks.get(run.id), maxRuns)
                    : section.id === 'attention'
                      ? attentionExtra(run)
                      : undefined,
                ),
              )
            )}
          </Section>
        ))
      )}
    </div>
  );
}

function queueExtra(run: RunSummary, rank: number | undefined, maxRuns: number | null): ReactNode {
  if (rank === undefined) return null;
  const place = t({ zh: `第 ${rank} 个执行`, en: `#${rank} in line` });
  if (!run.waitingForMaxRuns && !run.waitingForConflict) {
    return <div className="run-card-note">{place}</div>;
  }
  // Text only: the card is a link, and the Run waited for is linked from the Run's page.
  return (
    <div className="run-card-note">
      <div className="run-card-note-title">{place}</div>
      {run.waitingForConflict && (
        <div className="run-card-note-detail">{conflictWaitText(run.waitingForConflict)}</div>
      )}
      {run.waitingForMaxRuns && (
        <div className="run-card-note-detail">{maxRunsWaitText(maxRuns)}</div>
      )}
    </div>
  );
}

/**
 * A Run waiting for its pull request: 「等 PR 合并 #N」 linking to it on GitHub. Rendered after the
 * card's link to the Run, since a link cannot sit inside another.
 */
function PrWaitNote({ run }: { run: RunSummary }) {
  return (
    <div className="run-card-note run-card-after">
      <div className="run-card-note-title">
        {run.pr ? (
          <a href={run.pr.url} target="_blank" rel="noreferrer">
            {prWaitTitle(run)}
          </a>
        ) : (
          prWaitTitle(run)
        )}
      </div>
      <div className="run-card-note-detail">{prWaitHint()}</div>
    </div>
  );
}

function attentionExtra(run: RunSummary): ReactNode {
  // Said after the card's link (PrWaitNote), with the link to the pull request.
  if (waitingForPr(run)) return null;
  if (run.status === 'waiting_approval') {
    return (
      <div className="run-card-note">
        {t({ zh: '等待审批：', en: 'Waiting for approval: ' })}
        {run.currentStage?.name ?? ''}
      </div>
    );
  }
  if (run.blocked) {
    return (
      <div className="run-card-note" title={run.blocked.message}>
        <div className="run-card-note-title">
          {run.blocked.kind === 'discussion'
            ? t({
                zh: '需求待讨论，等你回复',
                en: 'Requirement under discussion, waiting for your reply',
              })
            : run.blocked.kind === 'untrusted_issue'
              ? BLOCK_KIND.untrusted_issue
              : t({
                  zh: `卡住：${BLOCK_KIND[run.blocked.kind]}`,
                  en: `Stuck: ${BLOCK_KIND[run.blocked.kind]}`,
                })}
        </div>
        <div className="run-card-note-detail">{messageExcerpt(run.blocked.message)}</div>
      </div>
    );
  }
  return <div className="run-card-note">{t({ zh: '卡住了', en: 'Stuck' })}</div>;
}

function RunFilters(props: {
  filter: RunListFilter;
  counts: Record<RunStatusFilter, number>;
  repos: Repo[];
}) {
  const { filter, counts, repos } = props;
  return (
    <div className="run-filters">
      <nav className="filter-row" aria-label={t({ zh: '按状态筛选', en: 'Filter by status' })}>
        {RUN_STATUS_FILTERS.map((item) => (
          <a
            key={item.id}
            href={runListHref({ status: item.id, repoId: filter.repoId })}
            className={filter.status === item.id ? 'filter-chip active' : 'filter-chip'}
            aria-current={filter.status === item.id ? 'page' : undefined}
          >
            {item.label}
            <span className="filter-count">{counts[item.id]}</span>
          </a>
        ))}
      </nav>
      {repos.length > 1 && (
        <nav className="filter-row" aria-label={t({ zh: '按仓库筛选', en: 'Filter by repo' })}>
          <a
            href={runListHref({ status: filter.status, repoId: null })}
            className={filter.repoId === null ? 'filter-chip active' : 'filter-chip'}
            aria-current={filter.repoId === null ? 'page' : undefined}
          >
            {t({ zh: '全部仓库', en: 'All repos' })}
          </a>
          {repos.map((repo) => (
            <a
              key={repo.id}
              href={runListHref({ status: filter.status, repoId: repo.id })}
              className={filter.repoId === repo.id ? 'filter-chip active' : 'filter-chip'}
              aria-current={filter.repoId === repo.id ? 'page' : undefined}
            >
              {repo.name}
            </a>
          ))}
        </nav>
      )}
    </div>
  );
}

function Section(props: {
  title: string;
  count: number;
  highlight?: boolean;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className={`section ${props.highlight && props.count > 0 ? 'section-highlight' : ''}`}>
      <h2>
        {props.title}
        {props.count > 0 && <span className="count">{props.count}</span>}
        {props.note && <span className="hint section-note">{props.note}</span>}
      </h2>
      <div className="run-list">{props.children}</div>
    </section>
  );
}

function RunCard(props: {
  run: RunSummary;
  repo: string;
  /** Inside the link to the Run. */
  extra?: ReactNode;
  /** Below it, outside the link: for content with links of its own. */
  after?: ReactNode;
}) {
  const { run, repo, extra, after } = props;
  const status = runStatusBadge(run);
  const finished = run.finishedAt !== null;
  return (
    <div className="run-card">
      <a className="run-card-link" href={href.run(run.id)}>
        <div className="run-card-top">
          <Badge tone={status.tone}>{status.label}</Badge>
          <span className="run-card-goal">{goalTitle(run.goal)}</span>
        </div>
        <div className="run-card-meta">
          <span>{repo}</span>
          {run.issue && <span>issue #{run.issue.number}</span>}
          <span>{run.templateName}</span>
          {run.currentStage && !finished && (
            <span>
              {run.currentStage.name}
              {run.currentStage.round > 1
                ? t({
                    zh: `（第 ${run.currentStage.round} 轮）`,
                    en: ` (round ${run.currentStage.round})`,
                  })
                : ''}
            </span>
          )}
          <span>{formatRunCost(run.costUsd, run.costUnknown)}</span>
          <span title={run.createdAt}>
            {formatTime(run.createdAt)}
            {run.status === 'running' || finished
              ? ` · ${formatSpan(run.createdAt, run.finishedAt)}`
              : ''}
          </span>
        </div>
        {extra}
      </a>
      {after}
    </div>
  );
}
