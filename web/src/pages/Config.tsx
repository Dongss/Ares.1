import { useEffect } from 'react';
import type { ConfigView } from '../../../src/api/types.js';
import type { SourceFile } from '../../../src/config/schema.js';
import { join, LANG_NAMES, t } from '../../../src/i18n.js';
import { FlowChart } from '../components/FlowChart.js';
import { Badge, Collapsible, Empty, ErrorBox, Pre } from '../components/ui.js';
import {
  AGENT_STATE,
  type AgentRow,
  agentRows,
  configFileWarnings,
  type TemplateCard,
  templateAnchor,
  templateCards,
} from '../lib/config.js';
import { buildFlow } from '../lib/flow.js';
import { formatTime } from '../lib/format.js';

/** Read-only view of the Master's configuration files. */
export function ConfigPage(props: {
  config: ConfigView | undefined;
  error: string | undefined;
  /** Template to scroll to. */
  target?: string;
}) {
  const { config, target } = props;
  const loaded = config !== undefined;

  useEffect(() => {
    if (loaded && target) {
      document.getElementById(templateAnchor(target))?.scrollIntoView({ block: 'start' });
    }
  }, [loaded, target]);

  if (!config) {
    return props.error ? (
      <ErrorBox>{props.error}</ErrorBox>
    ) : (
      <Empty>{t({ zh: '加载中…', en: 'Loading…' })}</Empty>
    );
  }
  const { valid, invalid } = templateCards(config);
  const agents = agentRows(config);
  const fileErrors = config.errors['agents.yaml'];
  const configWarnings = configFileWarnings(config);

  return (
    <div className="config-page">
      <h1>{t({ zh: '配置', en: 'Configuration' })}</h1>
      <p className="hint">
        {t({
          zh: (
            <>
              配置文件在 <code>{config.dir}</code>：<code>config.yaml</code>、
              <code>agents.yaml</code> 和 <code>workflows/*.yaml</code>
              。这里只读；修改文件后自动重新加载（端口和 CLI 路径要重启 Master 才生效）。新建的 Run
              用新模板，已创建的 Run 仍用创建时的模板；Agent 设置从下一次执行起生效。 当前配置加载于{' '}
              {formatTime(config.loadedAt)}。
            </>
          ),
          en: (
            <>
              The configuration files are in <code>{config.dir}</code>: <code>config.yaml</code>,{' '}
              <code>agents.yaml</code> and <code>workflows/*.yaml</code>. This page is read-only;
              the files reload by themselves when changed (the port and CLI paths need a Master
              restart). New Runs use the new templates, while existing Runs keep the template they
              were created with; agent settings apply from the next execution. The configuration in
              use was loaded at {formatTime(config.loadedAt)}.
            </>
          ),
        })}
      </p>

      <section className="section">
        <h2>
          {t({ zh: 'Workflow 模板', en: 'Workflow templates' })}
          <span className="count">{valid.length}</span>
        </h2>
        {valid.length === 0 && (
          <Empty>{t({ zh: '没有可用的模板。', en: 'No usable templates.' })}</Empty>
        )}
        {valid.map((card) => (
          <TemplateCardView
            key={card.key}
            card={card}
            config={config}
            targeted={card.template?.id === target}
          />
        ))}
        {invalid.length > 0 && (
          <>
            <h2 className="text-danger">
              {t({ zh: '无效的模板文件', en: 'Invalid template files' })}
              <span className="count">{invalid.length}</span>
            </h2>
            {invalid.map((card) => (
              <InvalidTemplateCard key={card.key} card={card} />
            ))}
          </>
        )}
      </section>

      <section className="section">
        <h2>
          Agent<span className="count">{agents.length}</span>
        </h2>
        <div className="card">
          <SourceLine path={config.agentsFile.path} />
          {fileErrors && (
            <ErrorBox>
              {t({ zh: 'agents.yaml 无效：', en: 'agents.yaml is invalid: ' })}
              {fileErrors.join(t({ zh: '；', en: '; ' }))}
            </ErrorBox>
          )}
          {agents.length === 0 ? (
            <Empty>{t({ zh: '没有配置 Agent。', en: 'No agents configured.' })}</Empty>
          ) : (
            <AgentTable rows={agents} />
          )}
          <SourceView
            title={t({ zh: 'agents.yaml 原文', en: 'agents.yaml source' })}
            file={config.agentsFile}
          />
        </div>
      </section>

      <section className="section">
        <h2>{t({ zh: '全局配置', en: 'Global configuration' })}</h2>
        <div className="card">
          <SourceLine path={config.configFile.path} />
          <p className="hint">
            {t({
              zh: `语言（language）：${LANG_NAMES[config.language]}。Master 写的 issue 评论、通知和给 Agent 的提示词都用它，也是看板的默认语言；看板右上角可以为这个浏览器单独切换。`,
              en: `Language (language): ${LANG_NAMES[config.language]}. The Master writes issue comments, notifications and prompts to agents in it, and it is the dashboard's default; the switch at the top right changes the dashboard for this browser only.`,
            })}
          </p>
          {configWarnings.length > 0 && (
            <div className="warn-box">
              {configWarnings.map((w) => (
                <div key={w}>{w}</div>
              ))}
            </div>
          )}
          <SourceView
            title={t({ zh: 'config.yaml 原文', en: 'config.yaml source' })}
            file={config.configFile}
          />
        </div>
      </section>
    </div>
  );
}

function TemplateCardView(props: { card: TemplateCard; config: ConfigView; targeted: boolean }) {
  const { card, config } = props;
  const template = card.template;
  if (!template) return null;
  const flow = buildFlow({ template, repoVerifyCommands: null, agents: config.agents });
  return (
    <section
      id={templateAnchor(template.id)}
      className={`card config-template ${props.targeted ? 'config-template-target' : ''}`}
    >
      <div className="config-template-head">
        <h3>{template.name ?? template.id}</h3>
        <code className="muted">{template.id}</code>
      </div>
      {template.description && <p className="config-template-desc">{template.description}</p>}
      <SourceLine path={card.path} />
      {card.warnings.length > 0 && (
        <div className="warn-box">
          {card.warnings.map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>
      )}
      <FlowChart stages={flow} />
      <Collapsible title={t({ zh: 'YAML 原文', en: 'YAML source' })}>
        <Pre>{card.source}</Pre>
      </Collapsible>
    </section>
  );
}

function InvalidTemplateCard({ card }: { card: TemplateCard }) {
  return (
    <section className="card config-template">
      <div className="config-template-head">
        <h3>{card.file}</h3>
        <Badge tone="danger">{t({ zh: '无效，未加载', en: 'Invalid, not loaded' })}</Badge>
      </div>
      <SourceLine path={card.path} />
      <ErrorBox>
        {card.errors.map((e) => (
          <div key={e}>{e}</div>
        ))}
      </ErrorBox>
      <Collapsible title={t({ zh: 'YAML 原文', en: 'YAML source' })}>
        <Pre>{card.source}</Pre>
      </Collapsible>
    </section>
  );
}

function AgentTable({ rows }: { rows: AgentRow[] }) {
  const dash = <span className="muted">—</span>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>id</th>
            <th>CLI</th>
            <th>{t({ zh: '模型', en: 'Model' })}</th>
            <th>effort</th>
            <th>{t({ zh: '能力 / 成本', en: 'Tier / cost' })}</th>
            <th>{t({ zh: '标签', en: 'Tags' })}</th>
            <th>{t({ zh: '状态', en: 'State' })}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const state = AGENT_STATE[row.state];
            const valid = row.state !== 'invalid';
            return (
              <tr key={row.id} className={row.state === 'enabled' ? undefined : 'row-off'}>
                <td>
                  <code>{row.id}</code>
                </td>
                <td>{row.cli ?? dash}</td>
                <td>{row.model ?? dash}</td>
                <td>
                  {row.effort ??
                    (valid ? (
                      <span className="muted">{t({ zh: '默认', en: 'Default' })}</span>
                    ) : (
                      dash
                    ))}
                </td>
                <td>{row.tier && row.cost ? `${row.tier} / ${row.cost}` : dash}</td>
                <td>{row.tags.length > 0 ? join(row.tags) : dash}</td>
                <td>
                  <Badge tone={state.tone}>{state.label}</Badge>
                  {row.reason && (
                    <div className={row.state === 'invalid' ? 'text-danger hint' : 'hint'}>
                      {row.reason}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SourceLine({ path }: { path: string }) {
  return (
    <p className="hint">
      {t({ zh: '来源：', en: 'Source: ' })}
      <code>{path}</code>
    </p>
  );
}

function SourceView({ title, file }: { title: string; file: SourceFile }) {
  if (file.source === null) {
    return <p className="hint">{t({ zh: '文件不存在。', en: 'The file does not exist.' })}</p>;
  }
  return (
    <Collapsible title={title}>
      <Pre>{file.source}</Pre>
    </Collapsible>
  );
}
