import { type ReactNode, useState } from 'react';
import type { StatsView } from '../../../src/api/types.js';
import { t } from '../../../src/i18n.js';
import type { Repo } from '../../../src/store/types.js';
import { Collapsible, Empty, ErrorBox } from '../components/ui.js';
import { api } from '../lib/api.js';
import { formatCost, formatDuration, formatTokens } from '../lib/format.js';
import { useReloadOn, useResource } from '../lib/hooks.js';
import {
  agentLabel,
  average,
  blockRows,
  blockWait,
  type CostBar,
  costBars,
  costBarsTitle,
  effectiveStatsFilter,
  formatPerRun,
  labeledBars,
  niceCeil,
  runGroups,
  STATS_RANGES,
  type StatsFilter,
  share,
  statsHref,
  tokenRows,
  unknownCostText,
  useStatsFilter,
} from '../lib/stats.js';

/** Totals over a time range, summed by the Master. */
export function StatsPage({ repos }: { repos: Repo[] }) {
  const filter = effectiveStatsFilter(
    useStatsFilter(),
    repos.map((r) => r.id),
  );
  const stats = useResource(() => api.stats(filter), statsHref(filter));
  // Anything a Run or a scout records may change the figures.
  useReloadOn(stats.reload, (e) => e.runId !== null || e.type.startsWith('scout.'), 1000);

  return (
    <div className="stats">
      <h1>{t({ zh: '统计', en: 'Stats' })}</h1>
      <StatsFilters filter={filter} repos={repos} />
      <ErrorBox>{stats.error}</ErrorBox>
      {stats.data ? (
        <div className={stats.loading ? 'stats-body reloading' : 'stats-body'}>
          <Overview stats={stats.data} />
          <Cost stats={stats.data} />
          <Tokens stats={stats.data} />
          <Time stats={stats.data} />
          <Quality stats={stats.data} />
          <p className="hint">
            {t({
              zh: '统计口径：Run 和 Task 按创建时间、Agent 执行和侦察按开始时间、审批按发起时间、卡住按卡住的时间落在范围内计算；完成的 Run 的用时和花费、每个 Run 的平均轮次和打回次数，按范围内创建的 Run 的全过程计算。',
              en: 'What is counted: Runs and Tasks by when they were created, agent executions and scouts by when they started, approvals by when they were requested, and blocks by when they happened, within the range. Time and cost of completed Runs, and average rounds and send-backs per Run, cover the whole life of the Runs created within the range.',
            })}
          </p>
        </div>
      ) : (
        !stats.error && <Empty>{t({ zh: '加载中…', en: 'Loading…' })}</Empty>
      )}
    </div>
  );
}

function StatsFilters({ filter, repos }: { filter: StatsFilter; repos: Repo[] }) {
  return (
    <div className="run-filters">
      <nav className="filter-row" aria-label={t({ zh: '时间范围', en: 'Time range' })}>
        {STATS_RANGES.map((r) => (
          <a
            key={r.id}
            href={statsHref({ range: r.id, repoId: filter.repoId })}
            className={filter.range === r.id ? 'filter-chip active' : 'filter-chip'}
            aria-current={filter.range === r.id ? 'page' : undefined}
          >
            {r.label}
          </a>
        ))}
      </nav>
      {repos.length > 1 && (
        <nav className="filter-row" aria-label={t({ zh: '按仓库筛选', en: 'Filter by repo' })}>
          <a
            href={statsHref({ range: filter.range, repoId: null })}
            className={filter.repoId === null ? 'filter-chip active' : 'filter-chip'}
            aria-current={filter.repoId === null ? 'page' : undefined}
          >
            {t({ zh: '全部仓库', en: 'All repos' })}
          </a>
          {repos.map((repo) => (
            <a
              key={repo.id}
              href={statsHref({ range: filter.range, repoId: repo.id })}
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="section stats-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Tile(props: { label: string; value: ReactNode; children?: ReactNode }) {
  return (
    <div className="stat-tile">
      <div className="stat-label">{props.label}</div>
      <div className="stat-value">{props.value}</div>
      {props.children && <div className="stat-detail">{props.children}</div>}
    </div>
  );
}

const durationOrDash = (ms: number | null) => (ms === null ? '—' : formatDuration(ms));

/** "1 time" / "3 times" in English. */
const times = (n: number) => `${n} ${n === 1 ? 'time' : 'times'}`;

/** Label of scouts in the cost tables and chart. */
const scoutsLabel = () => t({ zh: '侦察', en: 'Scouts' });

function Overview({ stats }: { stats: StatsView }) {
  const { runs, scouts } = stats;
  return (
    <Section title={t({ zh: '总览', en: 'Overview' })}>
      <div className="stat-grid">
        <Tile label="Run" value={runs.total}>
          {runGroups(runs.byStatus).map((g) => (
            <span key={g.id}>
              {g.label} {g.count}
            </span>
          ))}
        </Tile>
        <Tile label="Task" value={stats.tasks} />
        <Tile label={t({ zh: 'Agent 执行', en: 'Agent executions' })} value={stats.attempts}>
          <span>{t({ zh: '不含侦察', en: 'Scouts not included' })}</span>
        </Tile>
        <Tile
          label={t({ zh: '从 issue 建的 Run', en: 'Runs from issues' })}
          value={runs.fromIssues}
        >
          <span>
            {t({ zh: `自动采纳 ${runs.autoAccepted}`, en: `Auto-accepted ${runs.autoAccepted}` })}
          </span>
          <span>
            {t({
              zh: `已完成并关闭 ${runs.issuesClosed}`,
              en: `Completed and closed ${runs.issuesClosed}`,
            })}
          </span>
        </Tile>
        <Tile label={scoutsLabel()} value={scouts.total}>
          <span>
            {t({ zh: `提出提案 ${scouts.proposals}`, en: `Proposals ${scouts.proposals}` })}
          </span>
          <span>
            {t({
              zh: `自动采纳 ${scouts.autoAccepted}`,
              en: `Auto-accepted ${scouts.autoAccepted}`,
            })}
          </span>
        </Tile>
      </div>
    </Section>
  );
}

function Cost({ stats }: { stats: StatsView }) {
  const { cost, runs } = stats;
  const total = cost.runsUsd + cost.scoutsUsd;
  const perRun = average(runs.completed.costUsd, runs.completed.count);
  const unknown = unknownCostText(cost);
  return (
    <Section title={t({ zh: '花费', en: 'Cost' })}>
      <div className="stat-grid">
        <Tile label={t({ zh: '总花费', en: 'Total cost' })} value={formatCost(total)}>
          <span>Run {formatCost(cost.runsUsd)}</span>
          <span>
            {scoutsLabel()} {formatCost(cost.scoutsUsd)}
          </span>
        </Tile>
        <Tile
          label={t({ zh: '平均每个完成的 Run', en: 'Average per completed Run' })}
          value={perRun === null ? '—' : formatCost(perRun)}
        >
          <span>
            {t({
              zh: `完成 ${runs.completed.count} 个`,
              en: `${runs.completed.count} completed`,
            })}
          </span>
        </Tile>
      </div>
      {unknown && (
        <p className="hint">
          {t({
            zh: `${unknown}（如 cursor-agent 没有配置单价）。`,
            en: `${unknown} (e.g. cursor-agent without a configured price).`,
          })}
        </p>
      )}
      <CostChart bars={costBars(stats)} />
      <div className="stats-tables">
        <div className="card table-wrap">
          <h3>{t({ zh: '按 Agent', en: 'By agent' })}</h3>
          {stats.agents.length === 0 ? (
            <div className="muted">{t({ zh: '没有执行记录。', en: 'No executions.' })}</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t({ zh: 'Agent · 模型', en: 'Agent · model' })}</th>
                  <th className="num">{t({ zh: 'Run 中执行', en: 'In Runs' })}</th>
                  <th className="num">{scoutsLabel()}</th>
                  <th className="num">{t({ zh: '花费', en: 'Cost' })}</th>
                  <th className="num">{t({ zh: '占比', en: 'Share' })}</th>
                </tr>
              </thead>
              <tbody>
                {stats.agents.map((a) => (
                  <tr key={`${a.agentId}\n${a.model ?? ''}`}>
                    <td>{agentLabel(a)}</td>
                    <td className="num">{a.attempts}</td>
                    <td className="num">{a.scouts}</td>
                    <td className="num">
                      {formatCost(a.costUsd)}
                      {a.costUnknown > 0 && (
                        <div className="hint">
                          {t({
                            zh: `${a.costUnknown} 次费用未知`,
                            en: `${a.costUnknown} of unknown cost`,
                          })}
                        </div>
                      )}
                    </td>
                    <td className="num">{share(a.costUsd, total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card table-wrap">
          <h3>{t({ zh: '按仓库', en: 'By repo' })}</h3>
          {cost.byRepo.length === 0 ? (
            <div className="muted">{t({ zh: '没有执行记录。', en: 'No executions.' })}</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t({ zh: '仓库', en: 'Repo' })}</th>
                  <th className="num">Run</th>
                  <th className="num">{scoutsLabel()}</th>
                  <th className="num">{t({ zh: '合计', en: 'Total' })}</th>
                </tr>
              </thead>
              <tbody>
                {cost.byRepo.map((r) => (
                  <tr key={r.repoId}>
                    <td>{r.repo}</td>
                    <td className="num">{formatCost(r.runsUsd)}</td>
                    <td className="num">{formatCost(r.scoutsUsd)}</td>
                    <td className="num">{formatCost(r.runsUsd + r.scoutsUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Section>
  );
}

/** Cost per day (or per week / month on long ranges): Run and scout costs stacked. */
function CostChart({ bars }: { bars: CostBar[] }) {
  const [active, setActive] = useState<number | null>(null);
  const max = niceCeil(Math.max(0, ...bars.map((b) => b.totalUsd)));
  const labeled = labeledBars(bars.length);
  return (
    <figure className="card cost-chart">
      <figcaption className="chart-head">
        <span>{costBarsTitle(bars)}</span>
        <span className="chart-legend">
          <span>
            <i className="key key-runs" aria-hidden="true" />
            Run
          </span>
          <span>
            <i className="key key-scouts" aria-hidden="true" />
            {scoutsLabel()}
          </span>
        </span>
      </figcaption>
      {max === 0 ? (
        <div className="muted">
          {t({ zh: '这段时间没有花费。', en: 'No cost in this period.' })}
        </div>
      ) : (
        <div className="chart-plot">
          <div className="chart-axis" aria-hidden="true">
            <span style={{ bottom: '100%' }}>{formatCost(max)}</span>
            <span style={{ bottom: '50%' }}>{formatCost(max / 2)}</span>
            <span style={{ bottom: '0%' }}>{formatCost(0)}</span>
          </div>
          <div className="chart-body">
            <div className="chart-grid" aria-hidden="true">
              <i style={{ bottom: '100%' }} />
              <i style={{ bottom: '50%' }} />
              <i style={{ bottom: '0%' }} />
            </div>
            <div className="chart-cols">
              {bars.map((b, i) => (
                <ChartColumn
                  key={b.from}
                  bar={b}
                  max={max}
                  label={labeled.has(i)}
                  active={active === i}
                  tipSide={i < bars.length / 2 ? 'left' : 'right'}
                  onActive={(on) => setActive(on ? i : null)}
                />
              ))}
            </div>
          </div>
        </div>
      )}
      {max > 0 && (
        <Collapsible title={t({ zh: '明细', en: 'Details' })}>
          <table className="table">
            <thead>
              <tr>
                <th>{t({ zh: '日期', en: 'Date' })}</th>
                <th className="num">Run</th>
                <th className="num">{scoutsLabel()}</th>
                <th className="num">{t({ zh: '合计', en: 'Total' })}</th>
              </tr>
            </thead>
            <tbody>
              {[...bars].reverse().map((b) => (
                <tr key={b.from}>
                  <td>{b.label}</td>
                  <td className="num">{formatCost(b.runsUsd)}</td>
                  <td className="num">{formatCost(b.scoutsUsd)}</td>
                  <td className="num">{formatCost(b.totalUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Collapsible>
      )}
    </figure>
  );
}

/** One column: hover or keyboard focus shows its figures. */
function ChartColumn(props: {
  bar: CostBar;
  max: number;
  /** Show the day below the column. */
  label: boolean;
  active: boolean;
  tipSide: 'left' | 'right';
  onActive: (on: boolean) => void;
}) {
  const { bar: b, max, onActive } = props;
  return (
    <button
      type="button"
      className={props.active ? 'chart-col active' : 'chart-col'}
      aria-label={t({
        zh: `${b.label}：合计 ${formatCost(b.totalUsd)}，Run ${formatCost(b.runsUsd)}，侦察 ${formatCost(b.scoutsUsd)}`,
        en: `${b.label}: total ${formatCost(b.totalUsd)}, Runs ${formatCost(b.runsUsd)}, scouts ${formatCost(b.scoutsUsd)}`,
      })}
      onMouseEnter={() => onActive(true)}
      onMouseLeave={() => onActive(false)}
      onFocus={() => onActive(true)}
      onBlur={() => onActive(false)}
    >
      <span className="chart-bar">
        {b.totalUsd > 0 && (
          <span className="chart-stack" style={{ height: `${(b.totalUsd / max) * 100}%` }}>
            {b.scoutsUsd > 0 && (
              <span className="seg seg-scouts" style={{ flexGrow: b.scoutsUsd }} />
            )}
            {b.runsUsd > 0 && <span className="seg seg-runs" style={{ flexGrow: b.runsUsd }} />}
          </span>
        )}
      </span>
      <span className="chart-x">{props.label ? b.label : ''}</span>
      {props.active && (
        <span className={`chart-tip tip-${props.tipSide}`} aria-hidden="true">
          <span>
            <strong>{formatCost(b.totalUsd)}</strong> <span className="muted">{b.label}</span>
          </span>
          <span>
            <i className="key-line key-runs" />
            {formatCost(b.runsUsd)} <span className="muted">Run</span>
          </span>
          <span>
            <i className="key-line key-scouts" />
            {formatCost(b.scoutsUsd)} <span className="muted">{scoutsLabel()}</span>
          </span>
        </span>
      )}
    </button>
  );
}

function Tokens({ stats }: { stats: StatsView }) {
  const rows = tokenRows(stats.agents);
  return (
    <Section title="Token">
      <div className="stat-grid">
        <Tile label={t({ zh: '输入', en: 'Input' })} value={formatTokens(stats.tokens.input)} />
        <Tile label={t({ zh: '输出', en: 'Output' })} value={formatTokens(stats.tokens.output)} />
        <Tile
          label={t({ zh: '缓存命中', en: 'Cache hits' })}
          value={formatTokens(stats.tokens.cached)}
        />
      </div>
      {rows.length > 0 && (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t({ zh: 'Agent · 模型', en: 'Agent · model' })}</th>
                <th className="num">{t({ zh: '输入', en: 'Input' })}</th>
                <th className="num">{t({ zh: '输出', en: 'Output' })}</th>
                <th className="num">{t({ zh: '缓存命中', en: 'Cache hits' })}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={`${a.agentId}\n${a.model ?? ''}`}>
                  <td>{agentLabel(a)}</td>
                  <td className="num">{formatTokens(a.inputTokens)}</td>
                  <td className="num">{formatTokens(a.outputTokens)}</td>
                  <td className="num">{formatTokens(a.cachedTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint">
        {t({
          zh: '只统计 Run 中的 Agent 执行，侦察不记录 token。',
          en: 'Only agent executions in Runs are counted; scouts do not record tokens.',
        })}
      </p>
    </Section>
  );
}

function Time({ stats }: { stats: StatsView }) {
  const { time, runs } = stats;
  const blocked = blockWait(stats.blocks);
  return (
    <Section title={t({ zh: '时间', en: 'Time' })}>
      <div className="stat-grid">
        <Tile
          label={t({ zh: 'Agent 执行总时长', en: 'Agent execution time' })}
          value={formatDuration(time.attemptsMs)}
        >
          <span>
            {t({
              zh: `另有侦察 ${formatDuration(time.scoutsMs)}`,
              en: `Plus scouts ${formatDuration(time.scoutsMs)}`,
            })}
          </span>
        </Tile>
        <Tile
          label={t({ zh: '完成的 Run 平均用时', en: 'Average time of completed Runs' })}
          value={durationOrDash(runs.completed.avgMs)}
        >
          <span>
            {t({
              zh: `中位数 ${durationOrDash(runs.completed.medianMs)}`,
              en: `Median ${durationOrDash(runs.completed.medianMs)}`,
            })}
          </span>
          <span>{t({ zh: '从创建到结束', en: 'From creation to finish' })}</span>
        </Tile>
        <Tile
          label={t({ zh: '等审批', en: 'Waiting for approval' })}
          value={formatDuration(time.approvals.waitMs)}
        >
          <span>
            {t({
              zh: `已处理的审批 ${time.approvals.count} 次，从发起到处理`,
              en: `${time.approvals.count} handled ${time.approvals.count === 1 ? 'approval' : 'approvals'}, from request to decision`,
            })}
          </span>
        </Tile>
        <Tile
          label={t({ zh: '卡住后等人', en: 'Waiting for a human when blocked' })}
          value={formatDuration(blocked.waitMs)}
        >
          <span>
            {t({
              zh: `已处理的卡住 ${blocked.count} 次，从卡住到重试或终止`,
              en: `${blocked.count} handled ${blocked.count === 1 ? 'block' : 'blocks'}, from blocking to retry or cancel`,
            })}
          </span>
        </Tile>
      </div>
    </Section>
  );
}

function Quality({ stats }: { stats: StatsView }) {
  const q = stats.quality;
  const per = (n: number) => formatPerRun(n, q.runs);
  const blocks = blockRows(stats.blocks);
  return (
    <Section title={t({ zh: '质量', en: 'Quality' })}>
      <div className="stat-grid">
        <Tile
          label={t({ zh: '平均编码轮次', en: 'Average coding rounds' })}
          value={per(q.agentRounds)}
        >
          <span>
            {t({
              zh: `Agent 阶段共 ${q.agentRounds} 轮`,
              en: `${q.agentRounds} ${q.agentRounds === 1 ? 'round' : 'rounds'} in agent stages`,
            })}
          </span>
        </Tile>
        <Tile
          label={t({ zh: '平均评审打回', en: 'Average review send-backs' })}
          value={per(q.reviewFails)}
        >
          <span>{t({ zh: `共 ${q.reviewFails} 次`, en: `${times(q.reviewFails)} in all` })}</span>
        </Tile>
        <Tile
          label={t({ zh: '平均检查未通过', en: 'Average failed checks' })}
          value={per(q.checkFails)}
        >
          <span>
            {t({
              zh: `评审、合并阶段共 ${q.checkFails} 次`,
              en: `${times(q.checkFails)} in review and merge stages`,
            })}
          </span>
        </Tile>
        <Tile
          label={t({ zh: '平均审批驳回', en: 'Average rejected approvals' })}
          value={per(q.rejections)}
        >
          <span>{t({ zh: `共 ${q.rejections} 次`, en: `${times(q.rejections)} in all` })}</span>
        </Tile>
        <Tile label={t({ zh: '平均执行返工', en: 'Average reworks' })} value={per(q.reworks)}>
          <span>
            {t({
              zh: `执行结果被打回重做共 ${q.reworks} 次`,
              en: `Results sent back for rework ${times(q.reworks)}`,
            })}
          </span>
        </Tile>
      </div>
      <p className="hint">
        {t({
          zh: `平均值按范围内创建的 ${q.runs} 个 Run 计算。`,
          en: `Averages are over the ${q.runs} ${q.runs === 1 ? 'Run' : 'Runs'} created within the range.`,
        })}
      </p>
      <div className="card table-wrap">
        <h3>
          {t({
            zh: `卡住 ${blocks.reduce((n, b) => n + b.count, 0)} 次`,
            en: `Blocked ${times(blocks.reduce((n, b) => n + b.count, 0))}`,
          })}
        </h3>
        {blocks.length === 0 ? (
          <div className="muted">{t({ zh: '没有卡住过。', en: 'Never blocked.' })}</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t({ zh: '原因', en: 'Reason' })}</th>
                <th className="num">{t({ zh: '次数', en: 'Count' })}</th>
                <th className="num">{t({ zh: '已处理', en: 'Handled' })}</th>
                <th className="num">
                  {t({ zh: '等人处理的时长', en: 'Time waiting for a human' })}
                </th>
              </tr>
            </thead>
            <tbody>
              {blocks.map((b) => (
                <tr key={b.kind}>
                  <td>{b.label}</td>
                  <td className="num">{b.count}</td>
                  <td className="num">{b.handled}</td>
                  <td className="num">{formatDuration(b.waitMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Section>
  );
}
