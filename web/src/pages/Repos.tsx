import { type FormEvent, useState } from 'react';
import type {
  ConfigView,
  RepoDetection,
  RepoTrial,
  RepoTrialInput,
} from '../../../src/api/types.js';
import { changeRequestTerms, REPO_WORKFLOWS_DIR } from '../../../src/config/flow.js';
import { t } from '../../../src/i18n.js';
import type { Repo } from '../../../src/store/types.js';
import {
  Badge,
  Collapsible,
  ConfirmButton,
  Empty,
  ErrorBox,
  Pre,
  TemplateProblems,
} from '../components/ui.js';
import { api } from '../lib/api.js';
import {
  repoSourceInfo,
  repoTemplateBadges,
  repoTemplateGroups,
  repoTemplateProblems,
} from '../lib/config.js';
import { parseLines, shortSha } from '../lib/format.js';
import { useAction, useReloadOn, useResource, useTick } from '../lib/hooks.js';
import {
  detectedBox,
  detectionNote,
  detectLabel,
  lacksVerify,
  missingProgramNote,
  newRepoInput,
  noVerifyBadge,
  noVerifyWarning,
  REPO_ORIGINS,
  type RepoOrigin,
  registerLabel,
  repoOriginHint,
  repoOriginLabel,
  repoPathLabel,
  type TrialRow,
  targetBranchPlaceholder,
  trialLabel,
  trialRowNote,
  trialRows,
  trialStatusBadge,
  trialSummary,
} from '../lib/repos.js';
import { href } from '../lib/router.js';
import {
  MAX_RISKS,
  MAX_SIZES,
  type MaxRisk,
  maxRiskLabel,
  noScoutAgentNote,
  SOURCE_PLATFORMS,
  type SourceForm,
  type SourceSaveFailure,
  scoutAgentLabel,
  scoutAgentOptions,
  sourceFormInit,
  sourceFormProblems,
  sourcePlatformHint,
  sourcePlatformLabel,
  sourceRequest,
  sourceSaveFailure,
  sourceTemplateOptions,
  templateOptionLabel,
} from '../lib/source.js';

/** `config`: the configuration in use (reloaded by the app), for the templates repos keep. */
export function ReposPage(props: {
  repos: Repo[];
  config: ConfigView | undefined;
  onChanged: () => void;
}) {
  const { repos, config, onChanged } = props;
  return (
    <div className="repos">
      <h1>{t({ zh: '仓库', en: 'Repos' })}</h1>
      {repos.length === 0 ? (
        <Empty>{t({ zh: '还没有登记仓库。', en: 'No repos registered yet.' })}</Empty>
      ) : (
        repos.map((repo) => (
          <RepoCard key={repo.id} repo={repo} config={config} onChanged={onChanged} />
        ))
      )}
      <AddRepo onAdded={onChanged} />
    </div>
  );
}

function RepoCard(props: { repo: Repo; config: ConfigView | undefined; onChanged: () => void }) {
  const { repo, config, onChanged } = props;
  const [editing, setEditing] = useState(false);
  const [settingSource, setSettingSource] = useState(false);
  const action = useAction();
  const noVerify = lacksVerify(repo);

  if (editing) {
    return (
      <EditRepo
        repo={repo}
        onDone={() => {
          setEditing(false);
          onChanged();
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <section className="card repo">
      <div className="repo-head">
        <h2>{repo.name}</h2>
        <code className="muted">{repo.path}</code>
        {noVerify && <Badge tone="attention">{noVerifyBadge()}</Badge>}
      </div>
      <dl className="meta">
        <div>
          <dt>{t({ zh: '目标分支', en: 'Target branch' })}</dt>
          <dd>
            <code>{repo.targetBranch}</code>
          </dd>
        </div>
        {config && (
          <div>
            <dt>{t({ zh: '需求来源', en: 'Requirements from' })}</dt>
            <dd>
              <RequirementSource repo={repo.name} config={config} />
              {!settingSource && (
                <>
                  {' '}
                  <button type="button" className="link" onClick={() => setSettingSource(true)}>
                    {t({ zh: '设置', en: 'Set' })}
                  </button>
                </>
              )}
            </dd>
          </div>
        )}
        <div className="wide">
          <dt>{t({ zh: '检查命令', en: 'Verify commands' })}</dt>
          <dd>
            {commandList(repo.verifyCommands)}
            {noVerify && <div className="hint text-attention">{noVerifyWarning()}</div>}
          </dd>
        </div>
        <div className="wide">
          <dt>{t({ zh: '准备命令', en: 'Setup commands' })}</dt>
          <dd>{commandList(repo.setupCommands)}</dd>
        </div>
        {config && (
          <div className="wide">
            <dt>{t({ zh: '自带的流程模板', en: 'Its own workflow templates' })}</dt>
            <dd>
              <OwnTemplates repo={repo.name} config={config} />
            </dd>
          </div>
        )}
      </dl>
      {config && settingSource && (
        <SourceSettings
          repo={repo}
          config={config}
          onSaved={() => {
            setSettingSource(false);
            onChanged();
          }}
          onCancel={() => setSettingSource(false)}
        />
      )}
      <TrialPanel repo={repo} />
      <div className="form-actions">
        <button type="button" onClick={() => setEditing(true)}>
          {t({ zh: '修改', en: 'Edit' })}
        </button>
        <ConfirmButton
          label={t({ zh: '移除', en: 'Remove' })}
          confirmLabel={t({ zh: '确认移除', en: 'Confirm removal' })}
          disabled={action.busy}
          onConfirm={async () => {
            if ((await action.run(() => api.deleteRepo(repo.id))) !== undefined) onChanged();
          }}
        />
      </div>
      <ErrorBox>{action.error}</ErrorBox>
    </section>
  );
}

/**
 * Where the repo's requirements come from by config.yaml: GitHub or GitLab (with its host) and a
 * link to the issues there, the local backlog, or none, which keeps it from getting Runs.
 */
function RequirementSource({ repo, config }: { repo: string; config: ConfigView }) {
  const source = repoSourceInfo(config, repo);
  return (
    <>
      <a href={href.issues}>{source.label}</a>
      {source.issuesRepo &&
        (source.url ? (
          <>
            {' · '}
            <a href={source.url} target="_blank" rel="noreferrer">
              {source.issuesRepo}
            </a>
          </>
        ) : (
          ` · ${source.issuesRepo}`
        ))}
      {source.hint && <div className="hint">{source.hint}</div>}
    </>
  );
}

/**
 * The form that sets where the repo's requirements come from, opened in its card: the Master
 * rewrites the repo's entry in config.yaml and reloads it. Each field is named after its key there.
 */
function SourceSettings(props: {
  repo: Repo;
  config: ConfigView;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { repo, config } = props;
  const [initial] = useState(() => sourceFormInit(config, repo.name));
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<SourceSaveFailure>();
  const set = <K extends keyof SourceForm>(key: K, value: SourceForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  // What is set now stays offered even when it is no longer valid, so the form shows it.
  const templates = sourceTemplateOptions(config, repo.name, initial.template);
  const scoutAgents = scoutAgentOptions(config, initial.scoutAgent || undefined);
  const noScoutAgent = noScoutAgentNote(config);
  const problems = sourceFormProblems(form, scoutAgents);
  const host = form.platform === 'github' || form.platform === 'gitlab' ? form.platform : null;
  const terms = changeRequestTerms(host ?? undefined);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problems.length > 0) return;
    setBusy(true);
    setFailure(undefined);
    let failed: SourceSaveFailure | undefined;
    try {
      await api.setRepoSource(repo.id, sourceRequest(form));
    } catch (err) {
      failed = sourceSaveFailure(err);
    }
    setBusy(false);
    if (failed) setFailure(failed);
    else props.onSaved();
  };

  return (
    <form className="source-form" onSubmit={submit}>
      <h3>{t({ zh: '设置需求来源', en: 'Where requirements come from' })}</h3>
      <fieldset className="field choice-group" disabled={busy}>
        <legend>{t({ zh: '平台', en: 'Platform' })}</legend>
        {SOURCE_PLATFORMS.map((p) => (
          <label key={p} className="choice">
            <input
              type="radio"
              name={`source-${repo.id}`}
              value={p}
              checked={form.platform === p}
              onChange={() => set('platform', p)}
            />
            {sourcePlatformLabel(p)}
          </label>
        ))}
        <p className="hint">{sourcePlatformHint(form.platform)}</p>
      </fieldset>

      {form.platform !== 'none' && (
        <fieldset className="source-fields" disabled={busy}>
          {host && (
            <label className="field">
              <span>
                <code>issues_repo</code>
                {host === 'github'
                  ? t({ zh: '（可选）', en: ' (optional)' })
                  : t({ zh: '（必填）', en: ' (required)' })}
                <span className="hint">
                  {' '}
                  {host === 'github'
                    ? t({
                        zh: 'issue 所在的仓库，留空就由 gh 按仓库的远端推断',
                        en: "The repo the issues are in; left empty, gh works it out from the repo's remotes",
                      })
                    : t({
                        zh: 'issue 所在的项目，按链接里的路径写',
                        en: 'The project the issues are in, by the path in its link',
                      })}
                </span>
              </span>
              <input
                value={form.issuesRepo}
                onChange={(e) => set('issuesRepo', e.target.value)}
                placeholder={host === 'github' ? 'owner/name' : 'group/name'}
                required={host === 'gitlab'}
              />
            </label>
          )}

          <label className="field">
            <span>
              {t({ zh: '模板', en: 'Template' })} <code>template</code>
              <span className="hint">
                {' '}
                {t({
                  zh: '需求建成的 Run 用的流程模板',
                  en: 'The workflow template of the Runs created from requirements',
                })}
              </span>
            </span>
            <select
              value={form.template}
              onChange={(e) => set('template', e.target.value)}
              required
            >
              {templates.length === 0 && (
                <option value="">{t({ zh: '没有可用的模板', en: 'No template to use' })}</option>
              )}
              {templates.map((o) => (
                <option key={o.id} value={o.id}>
                  {templateOptionLabel(o)}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="source-group">
            <legend>
              {t({ zh: '侦察', en: 'Scout' })} <code>scout</code>
            </legend>
            <label className="field">
              <span>
                <code>agent</code>
                <span className="hint">
                  {' '}
                  {t({
                    zh: 'AI 侦察读仓库和 Run 记录、提出需求，要以只读方式运行',
                    en: 'The AI scout reads the repo and its Run records and proposes requirements; it runs read-only',
                  })}
                </span>
              </span>
              <select value={form.scoutAgent} onChange={(e) => set('scoutAgent', e.target.value)}>
                <option value="">{t({ zh: '不侦察', en: 'No scouting' })}</option>
                {scoutAgents.map((o) => (
                  <option key={o.id} value={o.id}>
                    {scoutAgentLabel(o)}
                  </option>
                ))}
              </select>
            </label>
            {noScoutAgent && <p className="hint text-attention">{noScoutAgent}</p>}
            {form.scoutAgent && (
              <div className="source-row">
                <label className="choice">
                  <input
                    type="checkbox"
                    checked={form.scoutAuto}
                    onChange={(e) => set('scoutAuto', e.target.checked)}
                  />
                  <span>
                    <code>auto</code>{' '}
                    {t({
                      zh: '仓库空闲时自动侦察（关掉就只能手动侦察）',
                      en: 'Scout by itself when the repo is idle (off: only by hand)',
                    })}
                  </span>
                </label>
                <label className="field">
                  <span>
                    <code>interval_minutes</code>
                    <span className="hint">
                      {' '}
                      {t({
                        zh: '两次自动侦察至少隔几分钟',
                        en: 'Minutes at least between automatic scouts',
                      })}
                    </span>
                  </span>
                  <input
                    type="number"
                    value={form.scoutIntervalMinutes}
                    onChange={(e) => set('scoutIntervalMinutes', e.target.value)}
                    min={0}
                    step="any"
                  />
                </label>
                <label className="field">
                  <span>
                    <code>max_proposals</code>
                    <span className="hint">
                      {' '}
                      {t({
                        zh: '每次最多提几条（1–20）',
                        en: 'Proposals per scout at most (1–20)',
                      })}
                    </span>
                  </span>
                  <input
                    type="number"
                    value={form.scoutMaxProposals}
                    onChange={(e) => set('scoutMaxProposals', e.target.value)}
                    min={1}
                    max={20}
                    step={1}
                  />
                </label>
              </div>
            )}
          </fieldset>

          <fieldset className="source-group">
            <legend>
              {t({ zh: '自动采纳', en: 'Auto-accept' })} <code>auto_accept</code>
            </legend>
            <div className="source-row">
              <label className="field">
                <span>
                  <code>max_risk</code>
                </span>
                <select
                  value={form.maxRisk}
                  onChange={(e) => set('maxRisk', e.target.value as MaxRisk)}
                >
                  {MAX_RISKS.map((r) => (
                    <option key={r} value={r}>
                      {maxRiskLabel(r)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>
                  <code>max_size</code>
                </span>
                <select
                  value={form.maxSize}
                  onChange={(e) => set('maxSize', e.target.value as SourceForm['maxSize'])}
                >
                  {MAX_SIZES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>
                  <code>max_per_day</code>
                </span>
                <input
                  type="number"
                  value={form.maxPerDay}
                  onChange={(e) => set('maxPerDay', e.target.value)}
                  min={1}
                  step={1}
                  placeholder={t({ zh: '不限', en: 'No limit' })}
                />
              </label>
            </div>
            <p className="hint">
              {t({
                zh: '风险和大小都不超过这里的提案不等人采纳，直接开工；max_per_day 是每天最多自动采纳几条。',
                en: 'Proposals within both the risk and the size here are accepted without waiting for a human; max_per_day caps how many a day.',
              })}
            </p>
          </fieldset>

          <div className="source-row">
            <label className="choice">
              <input
                type="checkbox"
                checked={form.autoMerge}
                onChange={(e) => set('autoMerge', e.target.checked)}
              />
              <span>
                <code>auto_merge</code> {t({ zh: '合并不等人批准', en: 'Merge without approval' })}
              </span>
            </label>
            <label className="field">
              <span>
                <code>max_run_attempts</code>
                <span className="hint">
                  {' '}
                  {t({ zh: '一个需求最多做几次', en: 'Runs a requirement gets at most' })}
                </span>
              </span>
              <input
                type="number"
                value={form.maxRunAttempts}
                onChange={(e) => set('maxRunAttempts', e.target.value)}
                min={1}
                step={1}
              />
            </label>
            <label className="field">
              <span>
                <code>daily_budget_usd</code>
                <span className="hint">
                  {' '}
                  {t({
                    zh: '自动做的事每天最多花多少美元',
                    en: 'USD a day at most on what the Master does by itself',
                  })}
                </span>
              </span>
              <input
                type="number"
                value={form.dailyBudgetUsd}
                onChange={(e) => set('dailyBudgetUsd', e.target.value)}
                min={0}
                step="any"
                placeholder={t({ zh: '不限', en: 'No limit' })}
              />
            </label>
          </div>

          {host && (
            <div className="source-row">
              <label className="choice">
                <input
                  type="checkbox"
                  checked={form.push}
                  onChange={(e) => set('push', e.target.checked)}
                />
                <span>
                  <code>push</code>{' '}
                  {t({
                    zh: `合并后把目标分支推送到 ${terms.host}`,
                    en: `Push the target branch to ${terms.host} after each merge`,
                  })}
                </span>
              </label>
              <label className="field">
                <span>
                  <code>deliver</code>
                </span>
                <select
                  value={form.byRequest ? terms.deliver : 'push'}
                  onChange={(e) => set('byRequest', e.target.value !== 'push')}
                >
                  <option value="push">
                    {t({
                      zh: 'push：在本地合并进目标分支',
                      en: 'push: merge into the target branch locally',
                    })}
                  </option>
                  <option value={terms.deliver}>
                    {t({
                      zh: `${terms.deliver}：开 ${terms.short}，在 ${terms.host} 上合并`,
                      en: `${terms.deliver}: open a ${terms.long} and merge it on ${terms.host}`,
                    })}
                  </option>
                </select>
              </label>
            </div>
          )}
        </fieldset>
      )}

      <p className="hint">
        {t({
          zh: '保存后 Master 改写 config.yaml 里这个仓库的条目并马上生效，文件里其余的内容和注释原样保留；和手改 config.yaml 效果相同。和默认值一样的项不写进文件。',
          en: "Saving has the Master rewrite this repo's entry in config.yaml and put it in use at once; the rest of the file and its comments stay as they are, the same as editing config.yaml by hand. Settings equal to the defaults are left out of the file.",
        })}
      </p>
      {problems.length > 0 && (
        <ul className="source-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <ErrorBox>
        {failure && (
          <>
            {failure.error}
            {failure.problems.length > 0 && (
              <ul>
                {failure.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </ErrorBox>
      <div className="form-actions">
        <button type="submit" className="btn-primary" disabled={busy || problems.length > 0}>
          {busy ? t({ zh: '保存中…', en: 'Saving…' }) : t({ zh: '保存', en: 'Save' })}
        </button>
        <button type="button" onClick={props.onCancel} disabled={busy}>
          {t({ zh: '取消', en: 'Cancel' })}
        </button>
      </div>
    </form>
  );
}

/** The templates the repo keeps on its target branch, what became of them, and their problems. */
function OwnTemplates({ repo, config }: { repo: string; config: ConfigView }) {
  const group = repoTemplateGroups(config).find((g) => g.repo === repo);
  if (!group) {
    return (
      <span className="muted">
        {t({
          zh: `无（可以在目标分支的 ${REPO_WORKFLOWS_DIR}/ 里放模板）`,
          en: `None (templates can be kept in ${REPO_WORKFLOWS_DIR}/ on the target branch)`,
        })}
      </span>
    );
  }
  return (
    <>
      <span className="commands">
        {group.cards.map((card) => (
          <span key={card.key}>
            <code>{card.template?.id ?? card.file}</code>{' '}
            {repoTemplateBadges(card).map((b) => (
              <Badge key={b.label} tone={b.tone}>
                {b.label}
              </Badge>
            ))}
          </span>
        ))}
      </span>
      <TemplateProblems problems={repoTemplateProblems(config, repo)} />
      <div className="hint">
        {t({
          zh: `读自目标分支 ${group.branch} 上的 ${REPO_WORKFLOWS_DIR}/（提交 ${shortSha(group.sha)}），`,
          en: `Read from ${REPO_WORKFLOWS_DIR}/ on the target branch ${group.branch} (commit ${shortSha(group.sha)}); `,
        })}
        <a href={href.config}>{t({ zh: '在配置页查看', en: 'see them on the Config page' })}</a>
      </div>
    </>
  );
}

/**
 * The trial button and the repo's latest trial: each command's state, with the end of the output
 * of the one that failed. `commands`: the commands of the edit form to try instead of the saved
 * ones (nothing is saved); omitted on the card, which tries the saved ones.
 */
function TrialPanel(props: { repo: Repo; commands?: () => RepoTrialInput; disabled?: boolean }) {
  const { repo } = props;
  const trial = useResource(() => api.repoTrial(repo.id), `trial:${repo.id}`);
  useReloadOn(
    trial.reload,
    () => false,
    200,
    (n) => n.type === 'repo.trial' && n.repoId === repo.id,
  );
  const action = useAction();
  const running = trial.data?.status === 'running';
  const now = useTick(1000, running);
  const start = async () => {
    const started = await action.run(() => api.tryRepo(repo.id, props.commands?.()));
    if (started) trial.reload();
  };
  const form = props.commands !== undefined;
  return (
    <div className="trial">
      <div className="detect-row">
        <button type="button" onClick={start} disabled={action.busy || running || props.disabled}>
          {trialLabel(running || action.busy, form)}
        </button>
        <span className="hint">
          {form
            ? t({
                zh: `用输入框里的命令（不保存）在已保存的目标分支 ${repo.targetBranch} 当前的提交上依次跑准备命令和检查命令，和 Run 用的环境一样，不建 Run`,
                en: `Runs the setup and then the verify commands in the boxes (without saving them) on the commit the saved target branch ${repo.targetBranch} is at, in the environment Runs use; no Run is created`,
              })
            : t({
                zh: `在目标分支 ${repo.targetBranch} 当前的提交上依次跑准备命令和检查命令，和 Run 用的环境一样，不建 Run、什么都不改`,
                en: `Runs the setup and then the verify commands on the commit the target branch ${repo.targetBranch} is at, in the environment Runs use; no Run is created and nothing changes`,
              })}
        </span>
      </div>
      <ErrorBox>{action.error ?? trial.error}</ErrorBox>
      {trial.data && <TrialResult trial={trial.data} now={now} />}
    </div>
  );
}

function TrialResult({ trial, now }: { trial: RepoTrial; now: number }) {
  const badge = trialStatusBadge(trial.status);
  const rows = trialRows(trial);
  return (
    <div className="trial-result">
      <div className="trial-head">
        <Badge tone={badge.tone}>{badge.label}</Badge>
        <span className="hint">{trialSummary(trial, now)}</span>
      </div>
      <ErrorBox>{trial.error}</ErrorBox>
      {rows.length === 0 ? (
        <p className="hint">
          {t({
            zh: '没有准备命令，也没有检查命令，没什么可跑的。',
            en: 'There are no setup or verify commands: nothing to run.',
          })}
        </p>
      ) : (
        <ul className="checks">
          {rows.map((row, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: the same command may be listed twice
              key={i}
              className={`trial-${row.state} ${row.state === 'failed' ? 'check-fail' : row.state === 'passed' ? 'check-pass' : ''}`}
            >
              <TrialRowView row={row} />
            </li>
          ))}
        </ul>
      )}
      {trial.log && (
        <p className="hint">
          {t({ zh: '完整输出：', en: 'Full output: ' })}
          <code>{trial.log}</code>
        </p>
      )}
    </div>
  );
}

function TrialRowView({ row }: { row: TrialRow }) {
  const icon = { passed: '✓', failed: '✗', running: '…', waiting: '·', skipped: '–' }[row.state];
  const title = (
    <span>
      <span className="check-icon">{icon}</span>
      {row.kind === 'setup' ? setupLabel() : verifyLabel()} <code>{row.command}</code>{' '}
      <span className="muted">{trialRowNote(row)}</span>
    </span>
  );
  const result = row.result;
  if (row.state !== 'failed' || !result) return <div className="trial-row">{title}</div>;
  if (result.missingProgram) {
    return (
      <div className="trial-row">
        {title}
        <div className="hint text-attention">{missingProgramNote(result.missingProgram)}</div>
      </div>
    );
  }
  return (
    <Collapsible title={title}>
      <Pre>{result.outputTail || t({ zh: '（没有输出）', en: '(no output)' })}</Pre>
    </Collapsible>
  );
}

function commandList(commands: string[]) {
  if (commands.length === 0) return <span className="muted">{t({ zh: '无', en: 'None' })}</span>;
  return (
    <span className="commands">
      {commands.map((c) => (
        <code key={c}>{c}</code>
      ))}
    </span>
  );
}

function verifyHint(): string {
  return t({
    zh: '每个 Task 完成后执行，全部通过才算验收通过（模板阶段没有设置时使用）',
    en: 'Run after each Task; it passes only when all of them pass (used when the template stage sets none)',
  });
}

function setupHint(): string {
  return t({
    zh: '每个 Run 创建工作目录后执行一次，例如 npm ci',
    en: 'Run once after each Run creates its working directory, e.g. npm ci',
  });
}

function verifyLabel(): string {
  return t({ zh: '检查命令', en: 'Verify commands' });
}

function setupLabel(): string {
  return t({ zh: '准备命令', en: 'Setup commands' });
}

function EditRepo(props: { repo: Repo; onDone: () => void; onCancel: () => void }) {
  const { repo } = props;
  const [targetBranch, setTargetBranch] = useState(repo.targetBranch);
  const [verify, setVerify] = useState(repo.verifyCommands.join('\n'));
  const [setup, setSetup] = useState(repo.setupCommands.join('\n'));
  const [detection, setDetection] = useState<RepoDetection>();
  const action = useAction();
  const detecting = useAction();
  // Fills the boxes only; the human checks them and saves.
  const detect = async () => {
    const found = await detecting.run(() => api.detectRepo(repo.id));
    if (!found) return;
    setVerify((typed) => detectedBox(found.verify, typed));
    setSetup((typed) => detectedBox(found.setup, typed));
    setDetection(found);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const result = await action.run(() =>
      api.updateRepo(repo.id, {
        targetBranch: targetBranch.trim(),
        verifyCommands: parseLines(verify),
        setupCommands: parseLines(setup),
      }),
    );
    if (result) props.onDone();
  };
  return (
    <form className="card form" onSubmit={submit}>
      <h2>{t({ zh: `修改 ${repo.name}`, en: `Edit ${repo.name}` })}</h2>
      <label className="field">
        <span>{t({ zh: '目标分支', en: 'Target branch' })}</span>
        <input value={targetBranch} onChange={(e) => setTargetBranch(e.target.value)} required />
      </label>
      <div className="detect">
        <div className="detect-row">
          <button type="button" onClick={detect} disabled={detecting.busy || action.busy}>
            {detectLabel(detecting.busy)}
          </button>
          <span className="hint">
            {t({
              zh: `看已保存的目标分支 ${repo.targetBranch} 上提交了的 package.json、pyproject.toml、go.mod、Cargo.toml、Makefile 等文件，建议该填的命令`,
              en: `Suggests the commands from the package.json, pyproject.toml, go.mod, Cargo.toml, Makefile and the like committed on the saved target branch ${repo.targetBranch}`,
            })}
          </span>
        </div>
        <ErrorBox>{detecting.error}</ErrorBox>
        {detection && (
          <div className="hint">
            <p>{detectionNote(detection)}</p>
            <ul>
              {detection.basis.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <CommandsField
        label={verifyLabel()}
        hint={verifyHint()}
        value={verify}
        onChange={setVerify}
      />
      <CommandsField label={setupLabel()} hint={setupHint()} value={setup} onChange={setSetup} />
      <TrialPanel
        repo={repo}
        commands={() => ({ setupCommands: parseLines(setup), verifyCommands: parseLines(verify) })}
        disabled={action.busy}
      />
      <p className="hint">
        {t({
          zh: '修改对之后开始的 Task 生效。',
          en: 'Changes apply to Tasks started afterwards.',
        })}
      </p>
      <ErrorBox>{action.error}</ErrorBox>
      <div className="form-actions">
        <button type="submit" className="btn-primary" disabled={action.busy}>
          {t({ zh: '保存', en: 'Save' })}
        </button>
        <button type="button" onClick={props.onCancel}>
          {t({ zh: '取消', en: 'Cancel' })}
        </button>
      </div>
    </form>
  );
}

function AddRepo({ onAdded }: { onAdded: () => void }) {
  const [origin, setOrigin] = useState<RepoOrigin>('local');
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [url, setUrl] = useState('');
  const [targetBranch, setTargetBranch] = useState('');
  const [verify, setVerify] = useState('');
  const [setup, setSetup] = useState('');
  const action = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const input = newRepoInput({ origin, name, path, url, targetBranch, verify, setup });
    const repo = await action.run(() => api.createRepo(input));
    if (repo) {
      setName('');
      setPath('');
      setUrl('');
      setTargetBranch('');
      setVerify('');
      setSetup('');
      onAdded();
    }
  };
  return (
    <form className="card form" onSubmit={submit}>
      <h2>{t({ zh: '登记仓库', en: 'Register a repo' })}</h2>
      <fieldset className="field choice-group" disabled={action.busy}>
        <legend>{t({ zh: '仓库从哪来', en: 'Where the repo comes from' })}</legend>
        {REPO_ORIGINS.map((o) => (
          <label key={o} className="choice">
            <input
              type="radio"
              name="repo-origin"
              value={o}
              checked={origin === o}
              onChange={() => setOrigin(o)}
            />
            {repoOriginLabel(o)}
          </label>
        ))}
        <p className="hint">{repoOriginHint(origin)}</p>
      </fieldset>
      {origin === 'clone' && (
        <label className="field">
          <span>{t({ zh: '远端地址', en: 'Remote address' })}</span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="git@github.com:me/my-repo.git"
            required
          />
        </label>
      )}
      <div className="form-row">
        <label className="field">
          <span>{t({ zh: '名称', en: 'Name' })}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ares1"
            required
          />
        </label>
        <label className="field">
          <span>{t({ zh: '目标分支（可选）', en: 'Target branch (optional)' })}</span>
          <input
            value={targetBranch}
            onChange={(e) => setTargetBranch(e.target.value)}
            placeholder={targetBranchPlaceholder(origin)}
          />
        </label>
      </div>
      <label className="field">
        <span>{repoPathLabel(origin)}</span>
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/Users/me/workspace/my-repo"
          required
        />
      </label>
      <CommandsField
        label={verifyLabel()}
        hint={verifyHint()}
        value={verify}
        onChange={setVerify}
      />
      <CommandsField label={setupLabel()} hint={setupHint()} value={setup} onChange={setSetup} />
      <ErrorBox>{action.error}</ErrorBox>
      <div className="form-actions">
        <button type="submit" className="btn-primary" disabled={action.busy}>
          {registerLabel(origin, action.busy)}
        </button>
      </div>
    </form>
  );
}

function CommandsField(props: {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>
        {props.label}
        {t({ zh: '（每行一条）', en: ' (one per line)' })}
        <span className="hint"> {props.hint}</span>
      </span>
      <textarea
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        rows={3}
        className="mono"
      />
    </label>
  );
}
