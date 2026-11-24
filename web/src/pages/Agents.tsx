import { t } from '../../../src/i18n.js';
import { Badge, Empty, ErrorBox } from '../components/ui.js';
import {
  type AgentPageRow,
  agentPageRow,
  agentStatus,
  agentTotals,
  isAgentPageEvent,
} from '../lib/agents.js';
import { api } from '../lib/api.js';
import { formatTime } from '../lib/format.js';
import { useReloadOn, useResource } from '../lib/hooks.js';
import { href } from '../lib/router.js';

/** Every agent with its executions, outcomes, cost and latest error. */
export function AgentsPage() {
  const agents = useResource(() => api.agents(), 'agents');
  useReloadOn(agents.reload, isAgentPageEvent, 500);
  const rows = agents.data?.map(agentPageRow) ?? [];

  return (
    <div className="agents-page">
      <h1>Agent</h1>
      <p className="hint">
        {t({
          zh: (
            <>
              agents.yaml 中的每个 Agent（含停用和无效的），以及已经不在配置中、但留有执行记录的
              Agent。数字统计全部历史记录；按时间范围、仓库和模型分开的花费见
              <a href={href.stats}>「统计」</a>页。费用未知的执行不算作 $0，显示为「+ 未知」。
            </>
          ),
          en: (
            <>
              Every agent in agents.yaml (disabled and invalid ones included), and agents no longer
              configured that left executions on record. The numbers cover the whole history; for
              spending by time range, repo and model see the <a href={href.stats}>Stats</a> page.
              Executions of unknown cost are not counted as $0 but shown as "+ unknown".
            </>
          ),
        })}
      </p>
      <ErrorBox>{agents.error}</ErrorBox>
      {!agents.data ? (
        !agents.error && <Empty>{t({ zh: '加载中…', en: 'Loading…' })}</Empty>
      ) : rows.length === 0 ? (
        <Empty>
          {t({
            zh: (
              <>
                没有配置 Agent，也没有执行记录（<a href={href.config}>查看配置</a>）。
              </>
            ),
            en: (
              <>
                No agents configured and no executions on record (
                <a href={href.config}>see the configuration</a>).
              </>
            ),
          })}
        </Empty>
      ) : (
        <div className={agents.loading ? 'card table-wrap reloading' : 'card table-wrap'}>
          <AgentTable rows={rows} totals={agentTotals(agents.data)} />
        </div>
      )}
      <div className="hint agents-notes">
        <p>
          {t({
            zh: '通过 / 返工 / 出错：每次执行的结论，比例只算有结论的执行。被停止（暂停、终止）或被 Master 重启中断的执行没有结论，单独注明。',
            en: 'Passed / rework / error: the outcome of each execution; the rates count only executions with an outcome. Executions that were stopped (paused, cancelled) or interrupted by a Master restart have none and are noted separately.',
          })}
        </p>
        <p>
          {t({
            zh: (
              <>
                最近一次错误：Run 中最近一次记录了错误的执行，不含被停止或中断的。侦察出错请在
                <a href={href.issues}>「需求」</a>页查看。
              </>
            ),
            en: (
              <>
                Latest error: the latest execution in a Run that recorded an error, not counting
                stopped or interrupted ones. For scout errors see the{' '}
                <a href={href.issues}>Issues</a> page.
              </>
            ),
          })}
        </p>
        <p>
          {t({
            zh: '冷却中：等 Agent 额度用尽后的冷却实现以后，再加上这一列。',
            en: 'Cooling down: this column comes once cooling down after an agent runs out of quota is implemented.',
          })}
        </p>
      </div>
    </div>
  );
}

function AgentTable(props: { rows: AgentPageRow[]; totals: ReturnType<typeof agentTotals> }) {
  const { rows, totals } = props;
  const dash = <span className="muted">—</span>;
  return (
    <table className="table agents-table">
      <thead>
        <tr>
          <th>Agent</th>
          <th>CLI</th>
          <th>{t({ zh: '模型', en: 'Model' })}</th>
          <th>effort</th>
          <th>{t({ zh: '状态', en: 'State' })}</th>
          <th className="num">{t({ zh: '执行次数', en: 'Executions' })}</th>
          <th className="num">{t({ zh: '通过 / 返工 / 出错', en: 'Passed / rework / error' })}</th>
          <th className="num">{t({ zh: 'Run 执行费用', en: 'Run cost' })}</th>
          <th className="num">{t({ zh: '侦察费用', en: 'Scout cost' })}</th>
          <th className="num">{t({ zh: '合计', en: 'Total' })}</th>
          <th>{t({ zh: '最近一次错误', en: 'Latest error' })}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const status = agentStatus(row.state);
          return (
            <tr key={row.id} className={row.state === 'enabled' ? undefined : 'row-off'}>
              <td>
                <code>{row.id}</code>
              </td>
              <td>{row.cli ?? dash}</td>
              <td>{row.model ?? dash}</td>
              <td>
                {row.effort ??
                  (row.defaultEffort ? (
                    <span className="muted">{t({ zh: '默认', en: 'default' })}</span>
                  ) : (
                    dash
                  ))}
              </td>
              <td>
                <Badge tone={status.tone}>{status.label}</Badge>
                {row.reason && (
                  <div className={row.state === 'invalid' ? 'text-danger hint' : 'hint'}>
                    {row.reason}
                  </div>
                )}
                {row.warnings.map((w) => (
                  <div key={w} className="text-attention hint">
                    {w}
                  </div>
                ))}
              </td>
              <td className="num">
                {row.attempts}
                {row.lastAt && (
                  <div className="hint" title={row.lastAt}>
                    {t({ zh: '最近使用 ', en: 'Last used ' })}
                    {formatTime(row.lastAt)}
                  </div>
                )}
              </td>
              <td className="num">
                {row.outcomes ?? dash}
                {row.rates && <div className="hint">{row.rates}</div>}
                {row.stopped && <div className="hint">{row.stopped}</div>}
              </td>
              <td className="num">{row.runCost ?? dash}</td>
              <td className="num">
                {row.scoutCost ?? dash}
                {row.scouts > 0 && <div className="hint">{scoutCount(row.scouts)}</div>}
              </td>
              <td className="num">{row.totalCost}</td>
              <td className="agents-error">
                {row.lastError ? (
                  <>
                    <div className="hint">
                      <span title={row.lastError.at}>{formatTime(row.lastError.at)}</span> ·{' '}
                      <a href={href.run(row.lastError.runId)}>{row.lastError.runId}</a>
                    </div>
                    <div className="agents-error-text text-danger" title={row.lastError.message}>
                      {row.lastError.text}
                    </div>
                  </>
                ) : (
                  dash
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr>
          <th className="agents-total" colSpan={5}>
            {t({ zh: '合计', en: 'Total' })}
          </th>
          <td className="num agents-total">{totals.attempts}</td>
          <td className="agents-total" />
          <td className="num agents-total">{totals.runCost}</td>
          <td className="num agents-total">
            {totals.scoutCost}
            {totals.scouts > 0 && <div className="hint">{scoutCount(totals.scouts)}</div>}
          </td>
          <td className="num agents-total">{totals.totalCost}</td>
          <td className="agents-total" />
        </tr>
      </tfoot>
    </table>
  );
}

/** The number of scouts, e.g. "3 scouts". */
function scoutCount(n: number): string {
  return t({ zh: `${n} 次侦察`, en: n === 1 ? '1 scout' : `${n} scouts` });
}
