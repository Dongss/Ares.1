import type { KeptWorkspace } from '../../../src/api/types.js';
import { t } from '../../../src/i18n.js';
import { Badge, ConfirmButton, Empty, ErrorBox } from '../components/ui.js';
import { api } from '../lib/api.js';
import { formatTime, RUN_STATUS } from '../lib/format.js';
import { useAction, useReloadOn, useResource } from '../lib/hooks.js';
import { href } from '../lib/router.js';
import {
  groupWorkspaces,
  keptWorkspaceLines,
  noCleanupReason,
  showCleanup,
} from '../lib/workspaces.js';

/** Worktrees and branches finished Runs kept, by repo, each removable by hand. */
export function WorkspacesPage() {
  const kept = useResource(() => api.workspaces(), 'workspaces');
  useReloadOn(kept.reload, (e) => e.type === 'workspace.removed' || e.type === 'run.status');
  const groups = kept.data ? groupWorkspaces(kept.data) : [];

  return (
    <div className="workspaces">
      <h1>{t({ zh: '工作区', en: 'Workspaces' })}</h1>
      <p className="hint">
        {t({
          zh: '失败或已终止的 Run 会保留工作目录和分支，方便排查；每个工作目录都执行过准备命令（例如安装依赖），会占用磁盘，排查完可以在这里清理。正在进行的 Run 不在这里列出。',
          en: 'Failed or cancelled Runs keep their worktree and branch for investigation. Each worktree has run the setup commands (installing dependencies, for example) and takes disk space; clean it up here when you are done. Runs in progress are not listed here.',
        })}
      </p>
      <ErrorBox>{kept.error}</ErrorBox>
      {!kept.data ? (
        !kept.error && <Empty>{t({ zh: '加载中…', en: 'Loading…' })}</Empty>
      ) : groups.length === 0 ? (
        <Empty>{t({ zh: '没有保留的工作目录', en: 'No kept worktrees' })}</Empty>
      ) : (
        groups.map((group) => (
          <section className="section" key={group.repoId}>
            <h2>
              {group.repoName}
              <span className="count">{group.items.length}</span>
            </h2>
            <div className="run-list">
              {group.items.map((item) => (
                <WorkspaceCard key={item.run.id} item={item} onChanged={kept.reload} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

function WorkspaceCard({ item, onChanged }: { item: KeptWorkspace; onChanged: () => void }) {
  const { run } = item;
  const status = RUN_STATUS[run.status];
  const reason = noCleanupReason(item);
  return (
    <div className="workspace-card">
      <div className="run-card-top">
        <Badge tone={status.tone}>{status.label}</Badge>
        <a className="run-card-goal" href={href.run(run.id)}>
          {run.title || run.id}
        </a>
      </div>
      <div className="run-card-meta">
        <span>{run.id}</span>
        {run.finishedAt && (
          <span title={run.finishedAt}>
            {t({ zh: '结束于 ', en: 'Finished ' })}
            {formatTime(run.finishedAt)}
          </span>
        )}
      </div>
      <dl className="workspace-lines">
        {keptWorkspaceLines(item).map((line) => (
          <div key={line.label}>
            <dt>{line.label}</dt>
            <dd>
              <code>{line.value}</code>
              {line.removed && (
                <span className="muted">{t({ zh: '（已删除）', en: ' (deleted)' })}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {!item.recorded && (
        <p className="hint">
          {t({
            zh: '准备命令通过前建立的工作目录和分支，还没有记录到 Run 上。',
            en: 'A worktree and branch created before the setup commands passed; not yet recorded on the Run.',
          })}
        </p>
      )}
      {showCleanup(item) && <Cleanup runId={run.id} onChanged={onChanged} />}
      {reason && <p className="hint">{reason}</p>}
    </div>
  );
}

/** Same as the button on the Run detail page; the item drops off the list once removed. */
function Cleanup(props: { runId: string; onChanged: () => void }) {
  const action = useAction();
  return (
    <div className="workspace-cleanup">
      <div className="controls">
        <ConfirmButton
          label={t({ zh: '清理工作目录和分支', en: 'Clean up worktree and branch' })}
          confirmLabel={t({ zh: '确认清理', en: 'Confirm cleanup' })}
          disabled={action.busy}
          onConfirm={async () => {
            await action.run(() => api.cleanup(props.runId));
            props.onChanged();
          }}
        />
        <span className="hint">
          {t({
            zh: '分支上没有合并的提交会被删除，无法恢复；Run 的记录、日志和产物会保留。',
            en: "Unmerged commits on the branch are deleted for good; the Run's records, logs and artifacts are kept.",
          })}
        </span>
      </div>
      <ErrorBox>{action.error}</ErrorBox>
    </div>
  );
}
