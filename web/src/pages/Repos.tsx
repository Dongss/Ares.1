import { type FormEvent, useState } from 'react';
import { t } from '../../../src/i18n.js';
import type { Repo } from '../../../src/store/types.js';
import { ConfirmButton, Empty, ErrorBox } from '../components/ui.js';
import { api } from '../lib/api.js';
import { parseLines } from '../lib/format.js';
import { useAction } from '../lib/hooks.js';

export function ReposPage({ repos, onChanged }: { repos: Repo[]; onChanged: () => void }) {
  return (
    <div className="repos">
      <h1>{t({ zh: '仓库', en: 'Repos' })}</h1>
      {repos.length === 0 ? (
        <Empty>{t({ zh: '还没有登记仓库。', en: 'No repos registered yet.' })}</Empty>
      ) : (
        repos.map((repo) => <RepoCard key={repo.id} repo={repo} onChanged={onChanged} />)
      )}
      <AddRepo onAdded={onChanged} />
    </div>
  );
}

function RepoCard({ repo, onChanged }: { repo: Repo; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const action = useAction();

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
      </div>
      <dl className="meta">
        <div>
          <dt>{t({ zh: '目标分支', en: 'Target branch' })}</dt>
          <dd>
            <code>{repo.targetBranch}</code>
          </dd>
        </div>
        <div className="wide">
          <dt>{t({ zh: '检查命令', en: 'Verify commands' })}</dt>
          <dd>{commandList(repo.verifyCommands)}</dd>
        </div>
        <div className="wide">
          <dt>{t({ zh: '准备命令', en: 'Setup commands' })}</dt>
          <dd>{commandList(repo.setupCommands)}</dd>
        </div>
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
  const action = useAction();
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
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [targetBranch, setTargetBranch] = useState('');
  const [verify, setVerify] = useState('');
  const [setup, setSetup] = useState('');
  const action = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const repo = await action.run(() =>
      api.createRepo({
        name: name.trim(),
        path: path.trim(),
        targetBranch: targetBranch.trim() || undefined,
        verifyCommands: parseLines(verify),
        setupCommands: parseLines(setup),
      }),
    );
    if (repo) {
      setName('');
      setPath('');
      setTargetBranch('');
      setVerify('');
      setSetup('');
      onAdded();
    }
  };
  return (
    <form className="card form" onSubmit={submit}>
      <h2>{t({ zh: '登记仓库', en: 'Register a repo' })}</h2>
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
            placeholder={t({
              zh: '默认：当前检出的分支',
              en: 'Default: the branch checked out now',
            })}
          />
        </label>
      </div>
      <label className="field">
        <span>{t({ zh: '本机路径（绝对路径）', en: 'Local path (absolute)' })}</span>
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
          {t({ zh: '登记', en: 'Register' })}
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
