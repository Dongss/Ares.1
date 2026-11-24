import { useEffect } from 'react';
import type { ConfigView } from '../../../src/api/types.js';
import { REPO_WORKFLOWS_DIR } from '../../../src/config/flow.js';
import type { SourceFile } from '../../../src/config/schema.js';
import { join, LANG_NAMES, t } from '../../../src/i18n.js';
import { FlowChart } from '../components/FlowChart.js';
import { Badge, Collapsible, Empty, ErrorBox, Pre } from '../components/ui.js';
import {
  AGENT_STATE,
  type AgentRow,
  agentRows,
  configFileWarnings,
  type RepoTemplateCard,
  type RepoTemplateGroup,
  repoTemplateBadges,
  repoTemplateGroups,
  repoTemplateNotes,
  type TemplateCard,
  templateAnchor,
  templateCards,
} from '../lib/config.js';
import { buildFlow } from '../lib/flow.js';
import { formatTime, shortSha } from '../lib/format.js';

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
  const repoGroups = repoTemplateGroups(config);
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
          {t({ zh: '仓库自带的模板', en: 'Templates kept in repos' })}
          <span className="count">{repoGroups.reduce((n, g) => n + g.cards.length, 0)}</span>
        </h2>
        <p className="hint">
          {t({
            zh: (
              <>
                登记的仓库可以在目标分支的 <code>{REPO_WORKFLOWS_DIR}/*.yaml</code>{' '}
                里放模板，格式和数据目录的一样，跟着代码一起演进。
                {`只读目标分支上已提交的内容，分支前进后自动重新加载；只有这个仓库的 Run 能用。`}
                仓库用的模板（<code>github.repos</code> 的 <code>template</code>
                ）先在数据目录里找，找不到才用仓库自带的，所以两边有同一个 id
                时用数据目录的。文件加载失败时继续用上次加载成功的版本。
              </>
            ),
            en: (
              <>
                A registered repo can keep templates in <code>{REPO_WORKFLOWS_DIR}/*.yaml</code> on
                its target branch, written as in the home directory, so that they evolve with the
                code. Only what is committed on the target branch is read, again whenever the branch
                moves; only that repo's Runs can use them. The template a repo uses (
                <code>template</code> under <code>github.repos</code>) is looked up in the home
                directory first, and in the repo's own only when it is not there, so the home
                directory's wins when both have the same id. A file that fails to load keeps the
                version that last loaded.
              </>
            ),
          })}
        </p>
        {repoGroups.length === 0 && (
          <Empty>
            {t({
              zh: '登记的仓库都没有自带模板。',
              en: 'No registered repo keeps templates of its own.',
            })}
          </Empty>
        )}
        {repoGroups.map((group) => (
          <RepoTemplatesView key={group.repo} group={group} config={config} />
        ))}
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

/** The templates one repo keeps, each card marked with what became of its file. */
function RepoTemplatesView({ group, config }: { group: RepoTemplateGroup; config: ConfigView }) {
  return (
    <div className="config-repo-templates">
      <h3 className="config-repo-head">
        {group.repo}
        <span className="muted">
          {t({ zh: '目标分支 ', en: 'target branch ' })}
          <code>{group.branch}</code>
          {t({ zh: '，提交 ', en: ', commit ' })}
          <code>{shortSha(group.sha)}</code>
        </span>
      </h3>
      {group.cards.map((card) => (
        <RepoTemplateCardView key={card.key} card={card} config={config} />
      ))}
    </div>
  );
}

function RepoTemplateCardView({ card, config }: { card: RepoTemplateCard; config: ConfigView }) {
  const template = card.template;
  const notes = repoTemplateNotes(card);
  // Why nothing loaded from the file, or why the file as on the branch is not the version in use.
  const errors = card.lastGood?.errors ?? card.errors;
  const flow = template && buildFlow({ template, repoVerifyCommands: null, agents: config.agents });
  return (
    <section className={`card config-template config-template-${card.state}`}>
      <div className="config-template-head">
        <h3>{template ? (template.name ?? template.id) : card.file}</h3>
        {template && <code className="muted">{template.id}</code>}
        {repoTemplateBadges(card).map((b) => (
          <Badge key={b.label} tone={b.tone}>
            {b.label}
          </Badge>
        ))}
      </div>
      {template?.description && <p className="config-template-desc">{template.description}</p>}
      <SourceLine path={card.path} />
      {notes.length > 0 && (
        <div className="warn-box">
          {notes.map((n) => (
            <div key={n}>{n}</div>
          ))}
        </div>
      )}
      {errors.length > 0 && (
        <ErrorBox>
          {errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </ErrorBox>
      )}
      {card.warnings.length > 0 && (
        <div className="warn-box">
          {card.warnings.map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>
      )}
      {flow && <FlowChart stages={flow} />}
      {card.lastGood && (
        <Collapsible
          title={t({
            zh: `在用的版本（提交 ${shortSha(card.lastGood.sha)}）`,
            en: `The version in use (commit ${shortSha(card.lastGood.sha)})`,
          })}
        >
          <Pre>{card.lastGood.source}</Pre>
        </Collapsible>
      )}
      <Collapsible
        title={
          card.lastGood
            ? t({ zh: '目标分支上的 YAML（加载失败）', en: 'YAML on the target branch (fails)' })
            : t({ zh: 'YAML 原文', en: 'YAML source' })
        }
      >
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
