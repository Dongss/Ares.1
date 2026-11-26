import { useState } from 'react';
import type { IterationChildView, IterationView } from '../../../src/api/types.js';
import { ITERATION_OPEN_STATUSES } from '../../../src/config/flow.js';
import { t } from '../../../src/i18n.js';
import { FailedAttempts, RestartAction } from '../components/Attempts.js';
import { IterationCard, IterationProgress } from '../components/IterationCard.js';
import { Badge, ConfirmButton, Empty, ErrorBox } from '../components/ui.js';
import { api } from '../lib/api.js';
import { formatDuration, formatRunCost, formatTime, RUN_STATUS } from '../lib/format.js';
import { useAction, useReloadOn, useResource } from '../lib/hooks.js';
import { CATEGORY, RISK } from '../lib/issues.js';
import {
  blockedHint,
  blockedText,
  canRejectIteration,
  childBadge,
  criteriaText,
  criterionSteps,
  decisionLabel,
  dependencyText,
  elapsedText,
  githubHint,
  ITERATION_STATUS,
  isOpen,
  iterationActions,
  iterationCostText,
  iterationsOutdatedBy,
  mergeIterations,
  overallKindText,
  pendingHint,
  RECENT_ITERATIONS,
  replacedText,
  runCountText,
  sortIterations,
  stepAttemptsText,
  stepName,
  wasAccepted,
} from '../lib/iterations.js';
import { proposalRedoText, restartHint } from '../lib/proposals.js';
import { href } from '../lib/router.js';

/** Every iteration not over (a repo has one at most) and the latest ones, each once. */
async function loadIterations(): Promise<IterationView[]> {
  const [open, recent] = await Promise.all([
    api.iterations({ status: ITERATION_OPEN_STATUSES }),
    api.iterations({ limit: RECENT_ITERATIONS }),
  ]);
  return mergeIterations(open, recent);
}

/** The iterations of every repo, or one of them (`id`) in full. */
export function IterationsPage({ id }: { id?: string }) {
  if (id !== undefined) return <IterationDetail key={id} id={id} />;
  return <IterationList />;
}

function IterationList() {
  const iterations = useResource(loadIterations, 'iterations');
  useReloadOn(iterations.reload, (e) => iterationsOutdatedBy(e.type));
  const list = iterations.data ? sortIterations(iterations.data) : undefined;
  return (
    <div className="iterations">
      <h1>{t({ zh: '迭代', en: 'Iterations' })}</h1>
      <p className="muted">
        {t({
          zh: '迭代是围绕一个完整大目标的一组需求：仓库没有进行中的迭代时，AI 侦察从差距分析里挑最重要的缺口，一次规划好目标、完成标准和按依赖排好的几步；整体采纳后按依赖开工，全部做完后写总结。',
          en: 'An iteration is a set of requirements around one larger goal: when a repo has no iteration under way, the AI scout picks the most important gap of its analysis and plans the goal, how to tell it is done and the steps in the order of their dependencies in one go; accepted as a whole, its steps start as their dependencies are done, and it is summed up once all are.',
        })}
      </p>
      <ErrorBox>{list ? iterations.error : undefined}</ErrorBox>
      {!list ? (
        iterations.error ? (
          <ErrorBox>{iterations.error}</ErrorBox>
        ) : (
          <Empty>{t({ zh: '加载中…', en: 'Loading…' })}</Empty>
        )
      ) : list.length === 0 ? (
        <Empty>
          {t({
            zh: (
              <>
                还没有迭代。配置了侦察的仓库空闲时，侦察会规划一个迭代；也可以在
                <a href={href.issues}>「需求」页</a>让 AI 找活。
              </>
            ),
            en: (
              <>
                No iterations yet. When a repo with a scout is idle, the scout plans one; you can
                also let the AI find work on the <a href={href.issues}>Issues</a> page.
              </>
            ),
          })}
        </Empty>
      ) : (
        <div className="run-list">
          {list.map((it) => (
            <IterationCard key={it.id} iteration={it} />
          ))}
        </div>
      )}
    </div>
  );
}

function IterationDetail({ id }: { id: string }) {
  const detail = useResource(() => api.iteration(id), id);
  useReloadOn(detail.reload, (e) => iterationsOutdatedBy(e.type));
  const it = detail.data;
  if (!it) {
    return detail.error ? (
      <ErrorBox>{detail.error}</ErrorBox>
    ) : (
      <Empty>{t({ zh: '加载中…', en: 'Loading…' })}</Empty>
    );
  }
  return (
    <div className="iteration-detail">
      <p>
        <a href={href.iterations}>{t({ zh: '← 全部迭代', en: '← All iterations' })}</a>
      </p>
      <ErrorBox>{detail.error}</ErrorBox>
      <IterationHeader iteration={it} onChanged={detail.reload} />
      {it.summary && (
        <section className="card">
          <h2>{t({ zh: '总结', en: 'Summary' })}</h2>
          <div className="iteration-summary">{it.summary}</div>
        </section>
      )}
      <section className="card">
        <div className="iteration-part">
          <h2>{t({ zh: '目标', en: 'Goal' })}</h2>
          <p className="iteration-para iteration-text">{it.goal}</p>
          <p className="iteration-para muted">
            {t({ zh: '对应 README 的目标：', en: 'Serves the README goal: ' })}
            {it.readmeGoal}
          </p>
        </div>
        <div className="iteration-part">
          <h2>{t({ zh: '完成标准', en: 'Completion criteria' })}</h2>
          {it.criteria.length === 0 ? (
            <p className="iteration-para muted">{t({ zh: '没有写。', en: 'None given.' })}</p>
          ) : (
            <ol className="iteration-criteria">
              {it.criteria.map((c, i) => {
                const steps = criterionSteps(it, i + 1);
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: criteria are numbered by place
                  <li key={i}>
                    <span className="iteration-text">{c}</span>
                    {steps && (
                      <span className="muted">{t({ zh: `（${steps}）`, en: ` (${steps})` })}</span>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
        {it.outOfScope.length > 0 && (
          <div className="iteration-part">
            <h2>{t({ zh: '不做', en: 'Out of scope' })}</h2>
            <ul className="iteration-criteria">
              {it.outOfScope.map((o, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a recorded list that never changes
                <li key={i} className="iteration-text">
                  {o}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      <section className="card">
        <h2>{t({ zh: '计划', en: 'Plan' })}</h2>
        {it.children.length === 0 ? (
          <p className="muted">{t({ zh: '计划里没有步骤。', en: 'The plan has no steps.' })}</p>
        ) : (
          <ol className="iteration-steps">
            {it.children.map((child) => (
              <IterationStep
                key={child.position}
                iteration={it}
                child={child}
                onChanged={detail.reload}
              />
            ))}
          </ol>
        )}
      </section>
      {it.notes.length > 0 && (
        <section className="card">
          <h2>{t({ zh: '计划调整', en: 'Changes to the plan' })}</h2>
          <ul className="iteration-notes">
            {it.notes.map((note, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: notes are only appended
              <li key={i}>
                <span className="muted" title={note.at}>
                  {formatTime(note.at)}
                  {note.scoutId ? ` · ${note.scoutId}` : ''}
                </span>
                <div className="iteration-text">{note.text}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function IterationHeader(props: { iteration: IterationView; onChanged: () => void }) {
  const { iteration: it } = props;
  const status = ITERATION_STATUS[it.status];
  const elapsed = elapsedText(it);
  const blocked = blockedText(it);
  const pending = pendingHint(it);
  const onGitHub = githubHint(it);
  return (
    <header className="card">
      <div className="run-title">
        <Badge tone={status.tone}>{status.label}</Badge>
        <h1>{it.title}</h1>
        {it.auto && it.decidedAt && (
          <Badge tone="active">{t({ zh: '已自动采纳', en: 'Auto-accepted' })}</Badge>
        )}
      </div>
      <IterationProgress iteration={it} />
      <dl className="meta">
        <div>
          <dt>{t({ zh: '仓库', en: 'Repo' })}</dt>
          <dd>{it.repo}</dd>
        </div>
        <div>
          <dt>{t({ zh: '在哪', en: 'Where' })}</dt>
          <dd>
            {it.issue ? (
              <a href={it.issue.url} target="_blank" rel="noreferrer">
                {it.issuesRepo}#{it.issue.number}
              </a>
            ) : it.source === 'local' ? (
              t({ zh: '本地提案池', en: 'Local backlog' })
            ) : (
              t({ zh: 'GitHub（迭代 issue 还没建好）', en: 'GitHub (no iteration issue yet)' })
            )}
          </dd>
        </div>
        <div>
          <dt>{t({ zh: '费用', en: 'Cost' })}</dt>
          <dd>
            {iterationCostText(it)}
            <span className="muted"> · {runCountText(it.totals.runs)}</span>
          </dd>
        </div>
        <div>
          <dt>{t({ zh: '用时', en: 'Time' })}</dt>
          <dd>
            {elapsed ?? '—'}
            {it.totals.agentMs > 0 && (
              <span className="muted">
                {t({
                  zh: ` · Agent 执行 ${formatDuration(it.totals.agentMs)}`,
                  en: ` · agents ran ${formatDuration(it.totals.agentMs)}`,
                })}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>{t({ zh: '规模', en: 'Size' })}</dt>
          <dd>{overallKindText(it)}</dd>
        </div>
        <div>
          <dt>{t({ zh: '规划', en: 'Planned' })}</dt>
          <dd title={it.createdAt}>
            {formatTime(it.createdAt)}
            {it.scoutId && <span className="muted"> · {it.scoutId}</span>}
          </dd>
        </div>
        {it.decidedAt && (
          <div>
            <dt>{decisionLabel(it)}</dt>
            <dd title={it.decidedAt}>{formatTime(it.decidedAt)}</dd>
          </div>
        )}
        {it.endedAt && wasAccepted(it) && (
          <div>
            <dt>{t({ zh: '结束', en: 'Ended' })}</dt>
            <dd title={it.endedAt}>{formatTime(it.endedAt)}</dd>
          </div>
        )}
      </dl>
      {blocked && (
        <div className="iteration-note iteration-note-danger">
          <div className="run-card-note-title">{blocked}</div>
          <div className="run-card-note-detail">{blockedHint(it)}</div>
        </div>
      )}
      {pending && it.source === 'local' && (
        <div className="iteration-note iteration-note-attention">{pending}</div>
      )}
      {onGitHub && (
        <p className="hint">
          {onGitHub}
          {it.issue && (
            <>
              {' '}
              <a href={it.issue.url} target="_blank" rel="noreferrer">
                {t({ zh: '打开迭代 issue', en: 'Open the iteration issue' })}
              </a>
            </>
          )}
        </p>
      )}
      <IterationActions iteration={it} onChanged={props.onChanged} />
    </header>
  );
}

/**
 * Deciding an iteration of the local backlog: a pending one is accepted, or rejected with a
 * reason the repo's next scouts are shown; an accepted one not over is cancelled.
 */
function IterationActions(props: { iteration: IterationView; onChanged: () => void }) {
  const { iteration: it, onChanged } = props;
  const action = useAction();
  const [reason, setReason] = useState('');
  const can = iterationActions(it);
  if (!can.decide && !can.cancel) return null;
  const done = async (call: () => Promise<unknown>) => {
    if ((await action.run(call)) !== undefined) {
      setReason('');
      onChanged();
    }
  };
  return (
    <>
      <div className="proposal-actions">
        {can.decide && (
          <>
            <button
              type="button"
              className="btn-primary"
              disabled={action.busy}
              onClick={() => done(() => api.acceptIteration(it.id))}
            >
              {t({ zh: '整体采纳', en: 'Accept as a whole' })}
            </button>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t({
                zh: '拒绝的理由（必填，之后的侦察会看到）',
                en: 'Reason to reject (required; later scouts see it)',
              })}
              aria-label={t({ zh: '拒绝的理由', en: 'Reason to reject' })}
            />
            <ConfirmButton
              label={t({ zh: '拒绝', en: 'Reject' })}
              confirmLabel={t({ zh: '确认拒绝', en: 'Confirm reject' })}
              disabled={action.busy || !canRejectIteration(it, reason)}
              onConfirm={() => {
                if (canRejectIteration(it, reason)) {
                  void done(() => api.rejectIteration(it.id, reason.trim()));
                }
              }}
            />
          </>
        )}
        {can.cancel && (
          <ConfirmButton
            label={t({ zh: '终止迭代', en: 'Cancel the iteration' })}
            confirmLabel={t({
              zh: '确认终止：停掉还没完成的步骤',
              en: 'Confirm: stop the steps not done',
            })}
            disabled={action.busy}
            onConfirm={() => void done(() => api.cancelIteration(it.id))}
          />
        )}
      </div>
      <ErrorBox>{action.error}</ErrorBox>
    </>
  );
}

/**
 * One step of the plan: where it stands, what it waits for or who replaced it, its issue (GitHub)
 * or proposal (local backlog), each Run that worked on it, and, folded, what it is about. In the
 * local backlog also which attempt it is at, when its failed Run is redone, why each attempt
 * failed, and, once it failed for good, starting it over.
 */
function IterationStep(props: {
  iteration: IterationView;
  child: IterationChildView;
  onChanged: () => void;
}) {
  const { iteration: it, child } = props;
  const status = childBadge(child);
  const dependency = dependencyText(child);
  const replaced = replacedText(child);
  const attempts = stepAttemptsText(child);
  const redo = proposalRedoText(child);
  return (
    <li className="iteration-step">
      <details>
        <summary>
          <span className="iteration-step-pos">{stepName(child.position)}</span>{' '}
          <Badge tone={status.tone}>{status.label}</Badge>{' '}
          <span className={replaced ? 'proposal-title iteration-replaced-title' : 'proposal-title'}>
            {child.title}
          </span>{' '}
          {child.closeout && (
            <>
              <Badge tone="neutral">{t({ zh: '收尾', en: 'Closing step' })}</Badge>{' '}
            </>
          )}
          <Badge tone={RISK[child.risk].tone}>{RISK[child.risk].label}</Badge>{' '}
          <span className="muted">
            {CATEGORY[child.category]} · {child.size}
          </span>
        </summary>
        <StepBody child={child} />
      </details>
      <div className="proposal-outcome">
        {child.issue ? (
          <a href={child.issue.url} target="_blank" rel="noreferrer">
            #{child.issue.number}
          </a>
        ) : child.proposalId ? (
          <span className="muted">
            {t({ zh: `提案 ${child.proposalId}`, en: `Proposal ${child.proposalId}` })}
          </span>
        ) : (
          it.source === 'github' &&
          isOpen(it) && (
            <span className="muted">{t({ zh: 'issue 还没建好', en: 'No issue yet' })}</span>
          )
        )}
        {dependency && (
          <span className={dependency.waiting ? 'text-attention' : 'muted'}>{dependency.text}</span>
        )}
        {replaced && <span className="muted">{replaced}</span>}
        {child.runs.map((run) => (
          <span key={run.id} className="iteration-run">
            <a href={href.run(run.id)}>Run {run.id}</a>{' '}
            <Badge tone={RUN_STATUS[run.status].tone}>{RUN_STATUS[run.status].label}</Badge>{' '}
            <span className="muted">{formatRunCost(run.costUsd, run.costUnknown)}</span>
          </span>
        ))}
        {attempts && <span className="muted">{attempts}</span>}
      </div>
      {redo && <div className="hint">{redo}</div>}
      <FailedAttempts failures={child.failures} />
      {child.restartable && child.proposalId && (
        <RestartAction
          proposalId={child.proposalId}
          hint={restartHint({ restartable: true, iterationId: it.id })}
          onRestarted={props.onChanged}
        />
      )}
    </li>
  );
}

/** What the scout wrote for a step: why, the evidence, what to do and the acceptance criteria. */
function StepBody({ child }: { child: IterationChildView }) {
  const list = (items: string[]) => (
    <ul>
      {items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a recorded list that never changes
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
  const criteria = criteriaText(child.criteria);
  return (
    <div className="proposal-body">
      {criteria && <p className="muted">{criteria}</p>}
      <h4>{t({ zh: '为什么', en: 'Why' })}</h4>
      <p>{child.why}</p>
      {child.evidence.length > 0 && (
        <>
          <h4>{t({ zh: '证据', en: 'Evidence' })}</h4>
          {list(child.evidence)}
        </>
      )}
      <h4>{t({ zh: '要做什么', en: 'What to do' })}</h4>
      <p>{child.what}</p>
      {child.acceptance.length > 0 && (
        <>
          <h4>{t({ zh: '验收标准', en: 'Acceptance criteria' })}</h4>
          {list(child.acceptance)}
        </>
      )}
    </div>
  );
}
