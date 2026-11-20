import { t } from '../../../src/i18n.js';
import { api } from '../lib/api.js';
import { shortSha } from '../lib/format.js';
import { useReloadOn, useResource } from '../lib/hooks.js';
import { patchLineClass, splitPatch } from '../lib/runs.js';
import { Collapsible, Empty, ErrorBox, Pre } from './ui.js';

/** The Run's changes against its target branch, or a single task commit. */
export function DiffPanel(props: { runId: string; commit?: string; onShowAll: () => void }) {
  const { runId, commit } = props;
  const diff = useResource(() => api.diff(runId, commit), `${runId}:${commit ?? ''}`);
  useReloadOn(diff.reload, (e) => e.runId === runId && !commit, 1000);

  if (diff.error) return <ErrorBox>{diff.error}</ErrorBox>;
  if (diff.data === undefined) return <Empty>{t({ zh: '加载中…', en: 'Loading…' })}</Empty>;
  if (diff.data === null) {
    return (
      <Empty>
        {t({
          zh: '还没有创建工作目录，没有改动。',
          en: 'No worktree has been created yet, so there are no changes.',
        })}
      </Empty>
    );
  }

  const { base, head, stat, patch, truncated } = diff.data;
  const files = splitPatch(patch);
  return (
    <div className="diff-panel">
      <div className="diff-head">
        {commit ? (
          <>
            <span>
              {t({
                zh: (
                  <>
                    提交 <code>{shortSha(commit)}</code> 的改动
                  </>
                ),
                en: (
                  <>
                    Changes of commit <code>{shortSha(commit)}</code>
                  </>
                ),
              })}
            </span>
            <button type="button" onClick={props.onShowAll}>
              {t({ zh: '查看全部改动', en: 'Show all changes' })}
            </button>
          </>
        ) : (
          <span>
            {t({
              zh: '相对目标分支的全部改动：',
              en: 'All changes against the target branch: ',
            })}
            <code>{shortSha(base)}</code> → <code>{shortSha(head)}</code>
          </span>
        )}
      </div>
      {files.length === 0 ? (
        <Empty>{t({ zh: '没有改动。', en: 'No changes.' })}</Empty>
      ) : (
        <>
          <Pre className="diff-stat">{stat}</Pre>
          {truncated && (
            <ErrorBox>
              {t({
                zh: '改动太大，下面只显示了前一部分。',
                en: 'The changes are too large; only the first part is shown below.',
              })}
            </ErrorBox>
          )}
          {files.map((file) => (
            <Collapsible
              key={file.path}
              defaultOpen={files.length <= 20}
              className="diff-file"
              title={
                <span className="diff-file-title">
                  <code>{file.path}</code>
                  <span className="diff-add-count">+{file.added}</span>
                  <span className="diff-del-count">-{file.removed}</span>
                </span>
              }
            >
              <pre className="diff">
                {file.lines.map((line, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: lines of a static text block
                  <div key={i} className={patchLineClass(line)}>
                    {line || ' '}
                  </div>
                ))}
              </pre>
            </Collapsible>
          ))}
        </>
      )}
    </div>
  );
}
