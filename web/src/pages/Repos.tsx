import { type FormEvent, useState } from 'react';
import type { ConfigView, RepoDetection } from '../../../src/api/types.js';
import { REPO_WORKFLOWS_DIR } from '../../../src/config/flow.js';
import { t } from '../../../src/i18n.js';
import type { Repo } from '../../../src/store/types.js';
import { OnboardWizard } from '../components/OnboardWizard.js';
import {
  CommandList,
  CommandsFields,
  DetectionNote,
  detectHint,
  RegisterForm,
  ServeFields,
  ServeView,
  SourceSettings,
  TrialPanel,
} from '../components/RepoForms.js';
import { Badge, ConfirmButton, Empty, ErrorBox, TemplateProblems } from '../components/ui.js';
import { api } from '../lib/api.js';
import {
  repoSourceInfo,
  repoTemplateBadges,
  repoTemplateGroups,
  repoTemplateProblems,
} from '../lib/config.js';
import { parseLines, shortSha } from '../lib/format.js';
import { useAction } from '../lib/hooks.js';
import { onboardEntryHint } from '../lib/onboard.js';
import {
  detectedBox,
  detectLabel,
  lacksVerify,
  noVerifyBadge,
  noVerifyWarning,
  repoPatch,
  serveFormInit,
  serveFormProblems,
  serveLabel,
} from '../lib/repos.js';
import { href } from '../lib/router.js';

/** `config`: the configuration in use (reloaded by the app), for the templates repos keep. */
export function ReposPage(props: {
  repos: Repo[];
  config: ConfigView | undefined;
  onChanged: () => void;
}) {
  const { repos, config, onChanged } = props;
  const [onboarding, setOnboarding] = useState(false);
  return (
    <div className="repos">
      <div className="page-head">
        <h1>{t({ zh: '仓库', en: 'Repos' })}</h1>
        {!onboarding && (
          <button type="button" className="btn-primary" onClick={() => setOnboarding(true)}>
            {t({ zh: '接入新项目', en: 'Bring in a new project' })}
          </button>
        )}
      </div>
      {onboarding ? (
        <OnboardWizard config={config} onChanged={onChanged} onClose={() => setOnboarding(false)} />
      ) : (
        <p className="hint">{onboardEntryHint()}</p>
      )}
      {repos.length === 0 ? (
        <Empty>{t({ zh: '还没有登记仓库。', en: 'No repos registered yet.' })}</Empty>
      ) : (
        repos.map((repo) => (
          <RepoCard key={repo.id} repo={repo} config={config} onChanged={onChanged} />
        ))
      )}
      {!onboarding && (
        <RegisterForm
          className="card form"
          title={t({ zh: '登记仓库', en: 'Register a repo' })}
          commands
          onAdded={onChanged}
        />
      )}
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
            <CommandList commands={repo.verifyCommands} />
            {noVerify && <div className="hint text-attention">{noVerifyWarning()}</div>}
          </dd>
        </div>
        <div className="wide">
          <dt>{t({ zh: '准备命令', en: 'Setup commands' })}</dt>
          <dd>
            <CommandList commands={repo.setupCommands} />
          </dd>
        </div>
        <div className="wide">
          <dt>{serveLabel()}</dt>
          <dd>
            <ServeView serve={repo.serve} />
          </dd>
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

function EditRepo(props: { repo: Repo; onDone: () => void; onCancel: () => void }) {
  const { repo } = props;
  const [targetBranch, setTargetBranch] = useState(repo.targetBranch);
  const [verify, setVerify] = useState(repo.verifyCommands.join('\n'));
  const [setup, setSetup] = useState(repo.setupCommands.join('\n'));
  const [serve, setServe] = useState(() => serveFormInit(repo.serve));
  const [detection, setDetection] = useState<RepoDetection>();
  const action = useAction();
  const detecting = useAction();
  const serveProblems = serveFormProblems(serve);
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
    if (serveProblems.length > 0) return;
    const result = await action.run(() =>
      api.updateRepo(repo.id, repoPatch({ targetBranch, verify, setup, serve })),
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
          <span className="hint">{detectHint(repo.targetBranch)}</span>
        </div>
        <ErrorBox>{detecting.error}</ErrorBox>
        {detection && <DetectionNote detection={detection} />}
      </div>
      <CommandsFields verify={verify} setup={setup} onVerify={setVerify} onSetup={setSetup} />
      <TrialPanel
        repo={repo}
        commands={() => ({ setupCommands: parseLines(setup), verifyCommands: parseLines(verify) })}
        disabled={action.busy}
      />
      <ServeFields value={serve} onChange={setServe} disabled={action.busy} />
      <p className="hint">
        {t({
          zh: '修改对之后开始的 Task 和命令阶段生效。',
          en: 'Changes apply to Tasks and command stages started afterwards.',
        })}
      </p>
      <ErrorBox>{action.error}</ErrorBox>
      <div className="form-actions">
        <button
          type="submit"
          className="btn-primary"
          disabled={action.busy || serveProblems.length > 0}
        >
          {t({ zh: '保存', en: 'Save' })}
        </button>
        <button type="button" onClick={props.onCancel}>
          {t({ zh: '取消', en: 'Cancel' })}
        </button>
      </div>
    </form>
  );
}
