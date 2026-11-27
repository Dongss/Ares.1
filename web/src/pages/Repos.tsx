import { type FormEvent, useState } from 'react';
import type { ConfigView, RepoDetection } from '../../../src/api/types.js';
import { REPO_WORKFLOWS_DIR } from '../../../src/config/flow.js';
import { t } from '../../../src/i18n.js';
import type { Repo } from '../../../src/store/types.js';
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
import {
  detectedBox,
  detectionNote,
  detectLabel,
  lacksVerify,
  newRepoInput,
  noVerifyBadge,
  noVerifyWarning,
  REPO_ORIGINS,
  type RepoOrigin,
  registerLabel,
  repoOriginHint,
  repoOriginLabel,
  repoPathLabel,
  targetBranchPlaceholder,
} from '../lib/repos.js';
import { href } from '../lib/router.js';

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
