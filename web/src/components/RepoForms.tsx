import { type FormEvent, useId, useState } from 'react';
import type {
  ConfigView,
  RepoDetection,
  RepoTrial,
  RepoTrialInput,
} from '../../../src/api/types.js';
import {
  changeRequestTerms,
  REPO_SERVE_DEFAULTS,
  REPO_SERVE_TIMEOUT_SECONDS,
} from '../../../src/config/flow.js';
import { t } from '../../../src/i18n.js';
import type { Repo, RepoServe } from '../../../src/store/types.js';
import { api } from '../lib/api.js';
import { useAction, useReloadOn, useResource, useTick } from '../lib/hooks.js';
import {
  detectionNote,
  emptyServeForm,
  missingProgramNote,
  newRepoInput,
  noServeNote,
  REPO_ORIGINS,
  type RepoOrigin,
  registerLabel,
  repoOriginHint,
  repoOriginLabel,
  repoPathLabel,
  type ServeForm,
  serveFormBlank,
  serveFormProblems,
  serveHint,
  serveLabel,
  serveReadyPathHint,
  serveSummary,
  serveTimeoutHint,
  setupHint,
  setupLabel,
  type TrialRow,
  targetBranchPlaceholder,
  trialLabel,
  trialRowNote,
  trialRows,
  trialStatusBadge,
  trialSummary,
  verifyHint,
  verifyLabel,
} from '../lib/repos.js';
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
import { Badge, Collapsible, ErrorBox, Pre } from './ui.js';

// The pieces of the Repos page that its cards and the wizard bringing a new project in share:
// registering a repo, its commands, its service, trying the commands, and where its requirements
// come from.

/** A repo's commands, one `code` each; 「None」 without any. */
export function CommandList({ commands }: { commands: string[] }) {
  if (commands.length === 0) return <span className="muted">{t({ zh: '无', en: 'None' })}</span>;
  return (
    <span className="commands">
      {commands.map((c) => (
        <code key={c}>{c}</code>
      ))}
    </span>
  );
}

export function CommandsField(props: {
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

/** The verify commands' box, then the setup commands'. */
export function CommandsFields(props: {
  verify: string;
  setup: string;
  onVerify: (value: string) => void;
  onSetup: (value: string) => void;
}) {
  return (
    <>
      <CommandsField
        label={verifyLabel()}
        hint={verifyHint()}
        value={props.verify}
        onChange={props.onVerify}
      />
      <CommandsField
        label={setupLabel()}
        hint={setupHint()}
        value={props.setup}
        onChange={props.onSetup}
      />
    </>
  );
}

/** A repo's saved service as its card shows it: the start command and its ready settings. */
export function ServeView({ serve }: { serve: RepoServe | null }) {
  if (!serve) return <span className="muted">{noServeNote()}</span>;
  return (
    <>
      <span className="commands">
        <code>{serve.command}</code>
      </span>
      <div className="hint">{serveSummary(serve)}</div>
    </>
  );
}

/**
 * The service boxes of the edit form: the start command, its ready path and timeout, what keeps
 * them from being saved, and a button that clears them (saved cleared, the repo has no service).
 */
export function ServeFields(props: {
  value: ServeForm;
  onChange: (value: ServeForm) => void;
  disabled?: boolean;
}) {
  const { value, onChange } = props;
  const set = <K extends keyof ServeForm>(key: K, v: ServeForm[K]) =>
    onChange({ ...value, [key]: v });
  const problems = serveFormProblems(value);
  return (
    <fieldset className="serve-fields" disabled={props.disabled}>
      <legend>{t({ zh: '服务', en: 'Service' })}</legend>
      <label className="field">
        <span>
          {serveLabel()}
          {t({ zh: '（可选）', en: ' (optional)' })}
          <span className="hint"> {serveHint()}</span>
        </span>
        <input
          className="mono"
          value={value.command}
          onChange={(e) => set('command', e.target.value)}
          placeholder="npm start"
        />
      </label>
      <div className="serve-row">
        <label className="field">
          <span>
            {t({ zh: '就绪路径', en: 'Ready path' })}
            <span className="hint"> {serveReadyPathHint()}</span>
          </span>
          <input
            className="mono"
            value={value.readyPath}
            onChange={(e) => set('readyPath', e.target.value)}
            placeholder={REPO_SERVE_DEFAULTS.readyPath}
          />
        </label>
        <label className="field">
          <span>
            {t({ zh: '就绪超时（秒）', en: 'Ready timeout (seconds)' })}
            <span className="hint"> {serveTimeoutHint()}</span>
          </span>
          <input
            type="number"
            value={value.readyTimeoutSeconds}
            onChange={(e) => set('readyTimeoutSeconds', e.target.value)}
            min={REPO_SERVE_TIMEOUT_SECONDS.min}
            max={REPO_SERVE_TIMEOUT_SECONDS.max}
            step={1}
            placeholder={String(REPO_SERVE_DEFAULTS.readyTimeoutSeconds)}
          />
        </label>
      </div>
      {problems.length > 0 && (
        <ul className="serve-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="form-actions">
        <button
          type="button"
          onClick={() => onChange(emptyServeForm())}
          disabled={serveFormBlank(value)}
        >
          {t({ zh: '清空', en: 'Clear' })}
        </button>
        <span className="hint">
          {t({
            zh: '清空后保存，就去掉这个仓库的服务启动命令',
            en: "Clear and save to remove the repo's service start command",
          })}
        </span>
      </div>
    </fieldset>
  );
}

/**
 * The form that registers a repo (POST /api/repos): already on this machine, cloned or made new.
 * `commands`: it asks for the repo's commands too (the wizard asks for them in a step of their
 * own). `title`: the heading over it, none when omitted.
 */
export function RegisterForm(props: {
  className: string;
  title?: string;
  commands: boolean;
  onAdded: (repo: Repo) => void;
}) {
  const [origin, setOrigin] = useState<RepoOrigin>('local');
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [url, setUrl] = useState('');
  const [targetBranch, setTargetBranch] = useState('');
  const [verify, setVerify] = useState('');
  const [setup, setSetup] = useState('');
  const action = useAction();
  const radios = useId();
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
      props.onAdded(repo);
    }
  };
  return (
    <form className={props.className} onSubmit={submit}>
      {props.title && <h2>{props.title}</h2>}
      <fieldset className="field choice-group" disabled={action.busy}>
        <legend>{t({ zh: '仓库从哪来', en: 'Where the repo comes from' })}</legend>
        {REPO_ORIGINS.map((o) => (
          <label key={o} className="choice">
            <input
              type="radio"
              name={radios}
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
      {props.commands && (
        <CommandsFields verify={verify} setup={setup} onVerify={setVerify} onSetup={setSetup} />
      )}
      <ErrorBox>{action.error}</ErrorBox>
      <div className="form-actions">
        <button type="submit" className="btn-primary" disabled={action.busy}>
          {registerLabel(origin, action.busy)}
        </button>
      </div>
    </form>
  );
}

/** What detecting the commands read, what became of the boxes, and why it suggests them. */
export function DetectionNote({ detection }: { detection: RepoDetection }) {
  return (
    <div className="hint">
      <p>{detectionNote(detection)}</p>
      <ul>
        {detection.basis.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

/** Says what the detect button reads: the files committed on the saved target branch. */
export function detectHint(branch: string): string {
  return t({
    zh: `看已保存的目标分支 ${branch} 上提交了的 package.json、pyproject.toml、go.mod、Cargo.toml、Makefile 等文件，建议该填的命令`,
    en: `Suggests the commands from the package.json, pyproject.toml, go.mod, Cargo.toml, Makefile and the like committed on the saved target branch ${branch}`,
  });
}

/**
 * The repo's latest trial, reloaded as it goes, and starting a new one. `trial`: null when it
 * has not been tried since the Master started, undefined while loading.
 */
export function useTrial(repoId: string) {
  const trial = useResource(() => api.repoTrial(repoId), `trial:${repoId}`);
  useReloadOn(
    trial.reload,
    () => false,
    200,
    (n) => n.type === 'repo.trial' && n.repoId === repoId,
  );
  const action = useAction();
  const running = trial.data?.status === 'running';
  const now = useTick(1000, running);
  /** `commands`: the commands to try instead of the saved ones (nothing is saved). */
  const start = async (commands?: RepoTrialInput) => {
    const started = await action.run(() => api.tryRepo(repoId, commands));
    if (started) trial.reload();
  };
  return {
    trial: trial.data,
    error: action.error ?? trial.error,
    busy: action.busy,
    running,
    now,
    start,
  };
}

/**
 * The trial button and the repo's latest trial: each command's state, with the end of the output
 * of the one that failed. `commands`: the commands of the edit form to try instead of the saved
 * ones (nothing is saved); omitted on the card, which tries the saved ones.
 */
export function TrialPanel(props: {
  repo: Repo;
  commands?: () => RepoTrialInput;
  disabled?: boolean;
}) {
  const { repo } = props;
  const trial = useTrial(repo.id);
  const form = props.commands !== undefined;
  return (
    <div className="trial">
      <div className="detect-row">
        <button
          type="button"
          onClick={() => trial.start(props.commands?.())}
          disabled={trial.busy || trial.running || props.disabled}
        >
          {trialLabel(trial.running || trial.busy, form)}
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
      <ErrorBox>{trial.error}</ErrorBox>
      {trial.trial && <TrialResult trial={trial.trial} now={trial.now} />}
    </div>
  );
}

export function TrialResult({ trial, now }: { trial: RepoTrial; now: number }) {
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

/**
 * The form that sets where the repo's requirements come from: the Master rewrites the repo's
 * entry in config.yaml and reloads it. Each field is named after its key there. `onSaved` gets
 * the configuration the Master answers with, the repo's new source in it. `cancelLabel`: the
 * text of the button that leaves without saving; `heading`: whether the form says what it is
 * (false where the page around it says so already).
 */
export function SourceSettings(props: {
  repo: Repo;
  config: ConfigView;
  onSaved: (config: ConfigView) => void;
  onCancel: () => void;
  cancelLabel?: string;
  heading?: boolean;
}) {
  const { repo, config } = props;
  const [initial] = useState(() => sourceFormInit(config, repo.name));
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<SourceSaveFailure>();
  const radios = useId();
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
    let saved: ConfigView | undefined;
    try {
      saved = await api.setRepoSource(repo.id, sourceRequest(form));
    } catch (err) {
      failed = sourceSaveFailure(err);
    }
    setBusy(false);
    if (failed) setFailure(failed);
    else if (saved) props.onSaved(saved);
  };

  return (
    <form className="source-form" onSubmit={submit}>
      {props.heading !== false && (
        <h3>{t({ zh: '设置需求来源', en: 'Where requirements come from' })}</h3>
      )}
      <fieldset className="field choice-group" disabled={busy}>
        <legend>{t({ zh: '平台', en: 'Platform' })}</legend>
        {SOURCE_PLATFORMS.map((p) => (
          <label key={p} className="choice">
            <input
              type="radio"
              name={radios}
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
          {props.cancelLabel ?? t({ zh: '取消', en: 'Cancel' })}
        </button>
      </div>
    </form>
  );
}
