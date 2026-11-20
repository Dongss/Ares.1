import { useEffect, useState } from 'react';
import { isCostUnknown } from '../../../src/api/cost.js';
import type { ConfigView, RunDetail } from '../../../src/api/types.js';
import { effectiveBudget } from '../../../src/config/flow.js';
import { t } from '../../../src/i18n.js';
import type {
  Approval,
  Attempt,
  BlockKind,
  CheckResult,
  StageRun,
  Task,
} from '../../../src/store/types.js';
import { AgentOutput } from '../components/AgentOutput.js';
import { DiffPanel } from '../components/DiffPanel.js';
import { FlowChart } from '../components/FlowChart.js';
import { Badge, Collapsible, ConfirmButton, Empty, ErrorBox, Pre } from '../components/ui.js';
import { api, urls } from '../lib/api.js';
import { newBudget, suggestedBudget } from '../lib/budget.js';
import { buildFlow, stageProgress } from '../lib/flow.js';
import {
  ATTEMPT_OUTCOME,
  ATTEMPT_STATUS,
  agentOptionLabel,
  attemptAgentLabel,
  BLOCK_KIND,
  FAIL_REASON,
  formatAttemptCost,
  formatCost,
  formatRunCost,
  formatRunTime,
  formatSpan,
  formatTime,
  formatTokens,
  goalTitle,
  RUN_STATUS,
  runTimePartTexts,
  STAGE_STATUS,
  shortSha,
  TASK_STATUS,
} from '../lib/format.js';
import { useAction, useReloadOn, useResource, useTick } from '../lib/hooks.js';
import {
  assessmentHeadline,
  canCleanUpWorkspace,
  discussionItems,
  eventText,
  ignoredCommentsText,
  rateLimitText,
  replyDeadlineOf,
  untrustedIssueText,
  workspaceLines,
} from '../lib/runs.js';

type Tab = 'progress' | 'diff' | 'events';
const tabs = (): { id: Tab; label: string }[] => [
  { id: 'progress', label: t({ zh: '进度', en: 'Progress' }) },
  { id: 'diff', label: t({ zh: '改动', en: 'Changes' }) },
  { id: 'events', label: t({ zh: '事件', en: 'Events' }) },
];

export function RunDetailPage(props: {
  id: string;
  config: ConfigView | undefined;
  /** Why the configuration failed to load, while there is none. */
  configError?: string;
}) {
  const { id, config } = props;
  const detail = useResource(() => api.run(id), id);
  useReloadOn(detail.reload, (e) => e.runId === id);
  const [tab, setTab] = useState<Tab>('progress');
  const [commit, setCommit] = useState<string>();
  /** A stage round to scroll to in the timeline; `n` makes a repeated click scroll again. */
  const [focus, setFocus] = useState<{ stageRunId: string; n: number }>();
  useTick(1000, detail.data?.run.status === 'running');
  useEffect(() => {
    if (!focus) return;
    document
      .getElementById(stageRunAnchor(focus.stageRunId))
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focus]);

  const d = detail.data;
  if (!d) {
    return detail.error ? (
      <ErrorBox>{detail.error}</ErrorBox>
    ) : (
      <Empty>{t({ zh: '加载中…', en: 'Loading…' })}</Empty>
    );
  }

  return (
    <div className="run-detail">
      <RunHeader detail={d} onChanged={detail.reload} />
      <RunFlow
        detail={d}
        config={config}
        configError={props.configError}
        onSelect={(stageRunId) => {
          setTab('progress');
          setFocus((f) => ({ stageRunId, n: (f?.n ?? 0) + 1 }));
        }}
      />
      <AssessmentCard detail={d} />
      <RunActions detail={d} config={config} onChanged={detail.reload} />
      <nav className="tabs">
        {tabs().map((item) => (
          <button
            key={item.id}
            type="button"
            className={tab === item.id ? 'tab active' : 'tab'}
            aria-pressed={tab === item.id}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      {tab === 'progress' && (
        <Timeline
          detail={d}
          onShowCommit={(sha) => {
            setCommit(sha);
            setTab('diff');
          }}
        />
      )}
      {tab === 'diff' && (
        <DiffPanel runId={id} commit={commit} onShowAll={() => setCommit(undefined)} />
      )}
      {tab === 'events' && <EventsPanel runId={id} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header and actions
// ---------------------------------------------------------------------------

function stageName(detail: RunDetail, stageId: string): string {
  return detail.run.template.stages.find((s) => s.id === stageId)?.name ?? stageId;
}

function RunHeader({ detail, onChanged }: { detail: RunDetail; onChanged: () => void }) {
  const { run, repo, stageRuns } = detail;
  const status = RUN_STATUS[run.status];
  const current = stageRuns.find((s) => s.id === run.currentStageRunId);
  const multiLine = run.goal.trim().includes('\n');
  const budget = effectiveBudget(run.template, run.overrides);
  const untrusted = untrustedIssueText(run.issue);
  return (
    <header className="card run-header">
      <div className="run-title">
        <Badge tone={status.tone}>{status.label}</Badge>
        <h1>{goalTitle(run.goal, 200)}</h1>
      </div>
      {untrusted && <div className="warn-box">{untrusted}</div>}
      {multiLine && <div className="goal">{run.goal.trim()}</div>}
      <dl className="meta">
        <div>
          <dt>{t({ zh: '仓库', en: 'Repo' })}</dt>
          <dd>
            {repo.name} → {repo.targetBranch}
          </dd>
        </div>
        <div>
          <dt>{t({ zh: '模板', en: 'Template' })}</dt>
          <dd>{run.template.name ?? run.templateId}</dd>
        </div>
        {run.issue && (
          <div>
            <dt>{t({ zh: '来自 issue', en: 'From issue' })}</dt>
            <dd>
              <a href={run.issue.url} target="_blank" rel="noreferrer">
                {run.issue.repo}#{run.issue.number}
              </a>
              {run.issue.auto ? t({ zh: '（自动采纳）', en: ' (auto-accepted)' }) : ''}
              {(run.issue.attempt ?? 1) > 1
                ? t({
                    zh: `，失败后自动重做的第 ${run.issue.attempt} 次尝试`,
                    en: `, attempt ${run.issue.attempt}: redone after earlier Runs failed`,
                  })
                : ''}
            </dd>
          </div>
        )}
        <div>
          <dt>{t({ zh: '当前阶段', en: 'Current stage' })}</dt>
          <dd>
            {current && !run.finishedAt
              ? `${stageName(detail, current.stageId)}${
                  current.round > 1
                    ? t({ zh: `（第 ${current.round} 轮）`, en: ` (round ${current.round})` })
                    : ''
                }`
              : '—'}
          </dd>
        </div>
        <div>
          <dt>{t({ zh: '费用', en: 'Cost' })}</dt>
          <dd>
            {formatRunCost(run.costUsd, detail.attempts.some(isCostUnknown))}
            {budget !== undefined && (
              <span className="muted">
                {t({
                  zh: ` / 预算 ${formatCost(budget)}`,
                  en: ` / budget ${formatCost(budget)}`,
                })}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>{t({ zh: '创建', en: 'Created' })}</dt>
          <dd title={run.createdAt}>{formatTime(run.createdAt)}</dd>
        </div>
        {/* When split, the time takes a whole row rather than wrapping in a narrow column. */}
        <div className={runTimePartTexts(detail.times).length > 0 ? 'wide' : undefined}>
          <dt>{t({ zh: '耗时', en: 'Time' })}</dt>
          <dd>{formatRunTime(run, detail.times)}</dd>
        </div>
        {workspaceLines(detail).map((line) => (
          <div className="wide" key={line.label}>
            <dt>{line.label}</dt>
            <dd>
              <code>{line.value}</code>
              {line.note === 'removed' && (
                <span className="muted">{t({ zh: '（已删除）', en: ' (removed)' })}</span>
              )}
              {line.note === 'unrecorded' && (
                <span
                  className="muted"
                  title={t({
                    zh: '准备命令通过前工作目录和分支已经建好，但还没有记录到 Run 上',
                    en: 'The worktree and branch were created before the setup commands passed, and are not recorded on the Run yet',
                  })}
                >
                  {t({
                    zh: '（准备命令通过前建立）',
                    en: ' (created before the setup commands passed)',
                  })}
                </span>
              )}
            </dd>
          </div>
        ))}
        {canCleanUpWorkspace(detail) && <WorkspaceCleanup runId={run.id} onChanged={onChanged} />}
      </dl>
    </header>
  );
}

/** Remove the worktree and branch a failed / cancelled Run kept for inspection. */
function WorkspaceCleanup(props: { runId: string; onChanged: () => void }) {
  const action = useAction();
  return (
    <div className="wide">
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
            en: "Commits on the branch that were not merged are deleted for good; the Run's records, logs and artifacts are kept.",
          })}
        </span>
      </div>
      <ErrorBox>{action.error}</ErrorBox>
    </div>
  );
}

const stageRunAnchor = (stageRunId: string) => `stage-run-${stageRunId}`;

/** The template's stages with their progress in this Run; click one to jump to its latest round. */
function RunFlow(props: {
  detail: RunDetail;
  config: ConfigView | undefined;
  configError: string | undefined;
  onSelect: (stageRunId: string) => void;
}) {
  const { run, repo, stageRuns } = props.detail;
  const stages = buildFlow({
    template: run.template,
    overrides: run.overrides,
    repoVerifyCommands: repo.verifyCommands,
    agents: props.config?.agents ?? (props.configError === undefined ? 'loading' : 'error'),
  });
  const progress = Object.fromEntries(
    stages.map((s) => [s.id, stageProgress(s.id, stageRuns, run.status)]),
  );
  return (
    <section className="card run-flow">
      <h2>{t({ zh: '流程', en: 'Flow' })}</h2>
      <FlowChart
        stages={stages}
        progress={progress}
        onSelect={(_, p) => p.latestStageRunId && props.onSelect(p.latestStageRunId)}
      />
    </section>
  );
}

function RunActions(props: {
  detail: RunDetail;
  config: ConfigView | undefined;
  onChanged: () => void;
}) {
  const { run } = props.detail;
  const action = useAction();
  const act = async (fn: () => Promise<unknown>) => {
    await action.run(fn);
    props.onChanged();
  };
  const finished = run.finishedAt !== null;
  const pausable = ['running', 'queued', 'waiting_approval'].includes(run.status);

  return (
    <div className="run-actions">
      {run.status === 'waiting_approval' && (
        <ApprovalPanel detail={props.detail} onChanged={props.onChanged} />
      )}
      {run.status === 'blocked' && run.blocked?.kind === 'discussion' && (
        <DiscussionPanel detail={props.detail} onChanged={props.onChanged} />
      )}
      {run.status === 'blocked' && run.blocked?.kind === 'untrusted_issue' && (
        <ConfirmGoalPanel detail={props.detail} onChanged={props.onChanged} />
      )}
      {run.status === 'blocked' &&
        run.blocked &&
        run.blocked.kind !== 'discussion' &&
        run.blocked.kind !== 'untrusted_issue' && (
          <BlockedPanel detail={props.detail} config={props.config} onChanged={props.onChanged} />
        )}
      {run.status === 'failed' && run.error && <ErrorBox>{run.error}</ErrorBox>}
      {run.status === 'queued' && props.detail.rateLimited && (
        <div className="panel">
          <h2>{rateLimitText(props.detail.rateLimited)}</h2>
          <p>
            {t({
              zh: '这不算出错，不消耗重试次数，也不用人处理：执行槽先让给其他 Run，到时间后从同一个 Task 接着做。想马上再试，可以暂停后再恢复。',
              en: 'This is not an error: it uses up no retries and needs no human. The execution slot goes to other Runs meanwhile, and the same Task carries on at that time. To try again right away, pause and resume the Run.',
            })}
          </p>
        </div>
      )}
      {!finished && (
        <div className="controls">
          {pausable && (
            <button
              type="button"
              disabled={action.busy}
              onClick={() => act(() => api.pause(run.id))}
            >
              {t({ zh: '暂停', en: 'Pause' })}
            </button>
          )}
          {run.status === 'paused' && (
            <button
              type="button"
              className="btn-primary"
              disabled={action.busy}
              onClick={() => act(() => api.resume(run.id))}
            >
              {t({ zh: '恢复', en: 'Resume' })}
            </button>
          )}
          <ConfirmButton
            label={t({ zh: '终止', en: 'Cancel' })}
            confirmLabel={t({ zh: '确认终止', en: 'Confirm cancel' })}
            disabled={action.busy}
            onConfirm={() => act(() => api.cancel(run.id))}
          />
          <span className="hint">
            {run.status === 'paused' &&
              t({
                zh: '恢复后排到队首，重做被打断的 Task。',
                en: 'Resuming puts it first in the queue and redoes the interrupted Task. ',
              })}
            {pausable &&
              t({
                zh: '暂停会立即停止 Agent、丢弃未提交的改动，恢复后重做当前 Task。',
                en: 'Pausing stops the agent at once and discards uncommitted changes; resuming redoes the current Task. ',
              })}
            {t({
              zh: '终止后保留工作目录和分支，可再手动清理。',
              en: 'Cancelling keeps the worktree and branch, which you can clean up afterwards.',
            })}
          </span>
        </div>
      )}
      <ErrorBox>{action.error}</ErrorBox>
    </div>
  );
}

function ApprovalPanel({ detail, onChanged }: { detail: RunDetail; onChanged: () => void }) {
  const { run, repo, stageRuns } = detail;
  const sr = stageRuns.find((s) => s.id === run.currentStageRunId);
  const def = run.template.stages.find((s) => s.id === sr?.stageId);
  const [comment, setComment] = useState('');
  const action = useAction();
  const decide = async (approve: boolean) => {
    const result = await action.run(() =>
      approve ? api.approve(run.id, comment) : api.reject(run.id, comment),
    );
    if (result) {
      setComment('');
      onChanged();
    }
  };
  return (
    <div className="panel panel-attention">
      <h2>
        {t({ zh: '等待审批：', en: 'Awaiting approval: ' })}
        {def?.name ?? sr?.stageId}
      </h2>
      <p>
        {def?.kind === 'merge'
          ? t({
              zh: `批准后合并到 ${repo.targetBranch}。`,
              en: `Approving merges into ${repo.targetBranch}. `,
            })
          : t({ zh: '批准后进入下一阶段。', en: 'Approving moves on to the next stage. ' })}
        {t({
          zh: '可以先在「改动」里看 diff。驳回时必须填写意见，意见会作为返工要求交给 Agent。',
          en: 'You can review the diff under "Changes" first. Rejecting needs a comment, which goes to the agent as what to rework.',
        })}
      </p>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={3}
        placeholder={t({
          zh: '审批意见（驳回时必填）',
          en: 'Comment (required to reject)',
        })}
        aria-label={t({ zh: '审批意见', en: 'Approval comment' })}
      />
      <div className="form-actions">
        <button
          type="button"
          className="btn-primary"
          disabled={action.busy}
          onClick={() => decide(true)}
        >
          {t({ zh: '批准', en: 'Approve' })}
        </button>
        <button
          type="button"
          className="btn-danger"
          disabled={action.busy || !comment.trim()}
          onClick={() => decide(false)}
        >
          {t({ zh: '驳回', en: 'Reject' })}
        </button>
      </div>
      <ErrorBox>{action.error}</ErrorBox>
    </div>
  );
}

/** What a retry does for each kind of block, in the language in use. */
function retryHint(kind: BlockKind): string {
  const hints: Record<BlockKind, Record<'zh' | 'en', string>> = {
    task_failed: {
      zh: '重试会从这个 Task 开始前的提交重做，返工次数清零。可以换一个 Agent，或补充说明。',
      en: 'Retrying redoes this Task from the commit before it started, with the rework count reset. You can switch to another agent or add a note.',
    },
    agent_error: {
      zh: '重试会从这个 Task 开始前的提交重做，出错后的自动重试次数重新算。可以换一个 Agent，或补充说明。',
      en: 'Retrying redoes this Task from the commit before it started, and the automatic retries after errors start over. You can switch to another agent or add a note.',
    },
    agent_unavailable: {
      zh: '确认 Agent 可用后重试。',
      en: 'Make sure the agent is available, then retry.',
    },
    max_loops: {
      zh: '重试会再允许回退一次，然后继续执行。',
      en: 'Retrying allows one more loop back, then carries on.',
    },
    merge_conflict: {
      zh: 'Master 已放弃这次合并，工作目录里没有冲突可解决。先在工作目录里运行 git merge <目标分支>，解决冲突后 git add 并 git commit，再重试（重试时没提交的改动会被丢弃）；不想要这个 Run 了就终止。',
      en: 'The Master gave up this merge, so there is no conflict to resolve in the worktree. Run git merge <target branch> in the worktree, resolve the conflicts, git add and git commit, then retry (uncommitted changes are discarded on retry). Cancel the Run if you no longer want it.',
    },
    target_dirty: {
      zh: '先提交或清理目标分支所在目录中的改动，再重试。',
      en: 'Commit or clean up the changes in the directory of the target branch, then retry.',
    },
    setup_failed: {
      zh: '重试会重新创建工作目录并执行准备命令。',
      en: 'Retrying recreates the worktree and runs the setup commands again.',
    },
    workspace: {
      zh: '重试会以工作目录当前的提交为准继续（工作目录被删除时，从 Run 的分支重新创建）；不想要这些改动就终止这个 Run。',
      en: "Retrying carries on from the worktree's current commit (recreated from the Run's branch if the worktree was deleted). Cancel the Run if you do not want these changes.",
    },
    budget: {
      zh: '填一个高于已花费金额的新预算后重试，Run 从停下的地方接着执行（Task 和工作目录不变）；不想再花钱就终止这个 Run。',
      en: 'Enter a new budget above what has been spent and retry; the Run carries on where it stopped (same Task and worktree). Cancel the Run if you do not want to spend more.',
    },
    discussion: {
      zh: '回复评估提出的疑问后，评估会带着讨论重新进行。',
      en: 'Once you answer the questions of the assessment, it runs again with the discussion.',
    },
    untrusted_issue: {
      zh: '读过目标、确认可以交给 Agent 后，Run 从头开始。',
      en: 'Once you have read the goal and confirmed it can go to the agents, the Run starts from the beginning.',
    },
    error: {
      zh: '重试会从出错的 Task 开始前的提交重做。',
      en: 'Retrying redoes the failed Task from the commit before it started.',
    },
  };
  return t(hints[kind]);
}

/**
 * The requirement assessment waits for a reply: the reply goes into the discussion and the
 * assessment runs again (POST /retry with a note).
 */
function DiscussionPanel({ detail, onChanged }: { detail: RunDetail; onChanged: () => void }) {
  const { run } = detail;
  const [reply, setReply] = useState('');
  const action = useAction();
  if (!run.blocked) return null;
  const deadline = replyDeadlineOf(detail);
  const asked = run.discussion.at(-1);
  const ignored = asked?.role === 'assessor' ? (asked.ignoredComments ?? 0) : 0;
  const send = async () => {
    const result = await action.run(() => api.retry(run.id, { note: reply.trim() }));
    if (result) {
      setReply('');
      onChanged();
    }
  };
  return (
    <div className="panel panel-attention">
      <h2>
        {t({
          zh: '需求待讨论：等你回复',
          en: 'Requirement under discussion: waiting for your reply',
        })}
      </h2>
      <Pre>{run.blocked.message}</Pre>
      {ignored > 0 && <p className="warn-box">{ignoredCommentsText(ignored)}</p>}
      <p className="hint">
        {run.issue
          ? t({
              zh: '可以直接在 issue 上回复（只认仓库成员的回复），Master 下次检查 GitHub 时会带着回复重新评估；也可以在这里回复。',
              en: 'You can reply on the issue (only replies by members of the repo count): the Master reassesses with your reply the next time it checks GitHub. Or reply here. ',
            })
          : t({
              zh: '回复后评估会带着讨论重新进行，讨论可以有多轮。',
              en: 'After your reply the assessment runs again with the discussion, which can take several rounds. ',
            })}
        {t({
          zh: '同意不做也请回复说明，评估会给出「不做」的结论，Run 结束（不算失败）。',
          en: 'If you agree not to do it, say so too: the assessment concludes "drop" and the Run ends (not as a failure).',
        })}
        {deadline !== null &&
          t({
            zh: `到 ${formatTime(new Date(deadline).toISOString())} 还没有人回复的话，评估会自己决定：写明做了哪些假设后开工，或者给出不做的结论。`,
            en: ` If nobody replies by ${formatTime(new Date(deadline).toISOString())}, the assessment decides on its own: it goes ahead with its assumptions written down, or concludes not to do it.`,
          })}
      </p>
      <label className="field">
        <span>
          {t({
            zh: '你的回复（会交给评估 Agent）',
            en: 'Your reply (goes to the assessment agent)',
          })}
        </span>
        <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={4} />
      </label>
      <div className="form-actions">
        <button
          type="button"
          className="btn-primary"
          disabled={action.busy || !reply.trim()}
          onClick={send}
        >
          {t({ zh: '回复并重新评估', en: 'Reply and reassess' })}
        </button>
      </div>
      <ErrorBox>{action.error}</ErrorBox>
    </div>
  );
}

/**
 * The Run's goal was written by someone the Master does not trust: nothing runs until a human
 * read it and confirmed it can go to the agents (POST /retry). Cancelling is in the controls.
 */
function ConfirmGoalPanel({ detail, onChanged }: { detail: RunDetail; onChanged: () => void }) {
  const { run } = detail;
  const action = useAction();
  if (!run.blocked) return null;
  const confirm = async () => {
    if (await action.run(() => api.retry(run.id, {}))) onChanged();
  };
  return (
    <div className="panel panel-attention">
      <h2>{BLOCK_KIND.untrusted_issue}</h2>
      <Pre>{run.blocked.message}</Pre>
      <p className="hint">{retryHint('untrusted_issue')}</p>
      <div className="form-actions">
        <ConfirmButton
          label={t({ zh: '确认并开始', en: 'Confirm and start' })}
          confirmLabel={t({
            zh: '已读过目标，交给 Agent',
            en: 'I have read the goal: hand it to the agents',
          })}
          disabled={action.busy}
          onConfirm={confirm}
        />
      </div>
      <ErrorBox>{action.error}</ErrorBox>
    </div>
  );
}

/** The requirement assessment of the Run: its conclusion and the discussion that led there. */
function AssessmentCard({ detail }: { detail: RunDetail }) {
  const { run } = detail;
  const headline = assessmentHeadline(run);
  if (!headline) return null;
  const { conclusion } = headline;
  const items = discussionItems(run.discussion);
  return (
    <section className="card assessment">
      <div className="stage-head">
        <h2>{t({ zh: '需求评估', en: 'Requirement assessment' })}</h2>
        <Badge tone={headline.tone}>{headline.label}</Badge>
      </div>
      {conclusion && <div className="assessment-summary">{conclusion.summary}</div>}
      {conclusion?.revisedGoal && (
        <Collapsible
          title={t({
            zh: '修改后的需求（编码和评审以它为准）',
            en: 'Revised requirement (coding and review follow it)',
          })}
          defaultOpen
        >
          <Pre>{conclusion.revisedGoal}</Pre>
        </Collapsible>
      )}
      <Collapsible
        title={t({
          zh: `讨论记录（${items.length} 条）`,
          en: `Discussion (${items.length} ${items.length === 1 ? 'entry' : 'entries'})`,
        })}
        defaultOpen={!conclusion}
      >
        <ol className="discussion">
          {items.map((item) => (
            <li key={`${item.at}-${item.title}`} className="discussion-item">
              <div className="discussion-head">
                <Badge tone={item.tone}>{item.title}</Badge>
                <span className="muted">{formatTime(item.at)}</span>
              </div>
              <Pre>{item.text}</Pre>
              {item.note && <p className="hint">{item.note}</p>}
            </li>
          ))}
        </ol>
      </Collapsible>
    </section>
  );
}

function BlockedPanel(props: {
  detail: RunDetail;
  config: ConfigView | undefined;
  onChanged: () => void;
}) {
  const { run, tasks } = props.detail;
  const info = run.blocked;
  const task = info?.taskId ? tasks.find((x) => x.id === info.taskId) : undefined;
  const [agentId, setAgentId] = useState(task?.agentId ?? '');
  const [note, setNote] = useState('');
  const [budgetText, setBudgetText] = useState(() => suggestedBudget(run.costUsd));
  const action = useAction();
  if (!info) return null;
  const agents = props.config?.agents ?? [];
  const askBudget = info.kind === 'budget';
  const budget = askBudget ? newBudget(budgetText, run.costUsd) : undefined;

  const retry = async () => {
    const result = await action.run(() =>
      api.retry(run.id, {
        agentId: task && agentId && agentId !== task.agentId ? agentId : undefined,
        note: task && note.trim() ? note.trim() : undefined,
        budgetUsd: budget?.ok ? budget.value : undefined,
      }),
    );
    if (result) {
      setNote('');
      props.onChanged();
    }
  };

  return (
    <div className="panel panel-danger">
      <h2>
        {t({ zh: '卡住了：', en: 'Blocked: ' })}
        {BLOCK_KIND[info.kind]}
      </h2>
      <Pre>{info.message}</Pre>
      <p className="hint">{retryHint(info.kind)}</p>
      {task && (
        <div className="form-row">
          <label className="field">
            <span>{t({ zh: '重试用的 Agent', en: 'Agent for the retry' })}</span>
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {agentOptionLabel(a)}
                  {a.id === task.agentId ? t({ zh: ' · 当前', en: ' · current' }) : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {task && (
        <label className="field">
          <span>
            {t({
              zh: '补充说明（可选，会交给 Agent）',
              en: 'Note (optional, goes to the agent)',
            })}
          </span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
        </label>
      )}
      {askBudget && (
        <div className="form-row">
          <label className="field">
            <span>{t({ zh: '新的预算（美元）', en: 'New budget (USD)' })}</span>
            <input
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={budgetText}
              onChange={(e) => setBudgetText(e.target.value)}
            />
            <small className="hint">
              {t({
                zh: `已花费 ${formatCost(run.costUsd)}`,
                en: `Spent ${formatCost(run.costUsd)}`,
              })}
              {budget && !budget.ok ? t({ zh: `；${budget.error}`, en: `; ${budget.error}` }) : ''}
            </small>
          </label>
        </div>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="btn-primary"
          disabled={action.busy || (budget !== undefined && !budget.ok)}
          onClick={retry}
        >
          {t({ zh: '重试', en: 'Retry' })}
        </button>
      </div>
      <ErrorBox>{action.error}</ErrorBox>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Progress timeline: stage rounds → tasks → attempts → checks and output
// ---------------------------------------------------------------------------

function Timeline({
  detail,
  onShowCommit,
}: {
  detail: RunDetail;
  onShowCommit: (sha: string) => void;
}) {
  const setupChecks = detail.checks.filter((c) => !c.stageRunId && !c.attemptId);
  if (detail.stageRuns.length === 0 && setupChecks.length === 0) {
    return (
      <Empty>
        {detail.run.status === 'queued'
          ? t({ zh: '排队中，还没有开始。', en: 'Queued, not started yet.' })
          : t({ zh: '还没有开始。', en: 'Not started yet.' })}
      </Empty>
    );
  }
  return (
    <div className="timeline">
      {setupChecks.length > 0 && (
        <section className="card stage">
          <div className="stage-head">
            <h3>{t({ zh: '准备工作目录', en: 'Set up the worktree' })}</h3>
          </div>
          <CheckList checks={setupChecks} />
        </section>
      )}
      {detail.stageRuns.map((sr) => (
        <StageBlock key={sr.id} detail={detail} sr={sr} onShowCommit={onShowCommit} />
      ))}
    </div>
  );
}

function StageBlock(props: {
  detail: RunDetail;
  sr: StageRun;
  onShowCommit: (sha: string) => void;
}) {
  const { detail, sr } = props;
  const status = STAGE_STATUS[sr.status];
  const tasks = detail.tasks.filter((x) => x.stageRunId === sr.id);
  const checks = detail.checks.filter((c) => c.stageRunId === sr.id && !c.attemptId);
  const approvals = detail.approvals.filter((a) => a.stageRunId === sr.id);
  const artifacts = detail.artifacts.filter((a) => a.stageRunId === sr.id);
  const kind = detail.run.template.stages.find((s) => s.id === sr.stageId)?.kind;
  const placeholder = kind === 'placeholder';
  return (
    <section id={stageRunAnchor(sr.id)} className={`card stage stage-${sr.status}`}>
      <div className="stage-head">
        <h3>
          {stageName(detail, sr.stageId)}
          {sr.round > 1 && (
            <span className="round">{t({ zh: `第 ${sr.round} 轮`, en: `Round ${sr.round}` })}</span>
          )}
        </h3>
        <Badge tone={status.tone}>{status.label}</Badge>
        {sr.failReason && <span className="fail-reason">{FAIL_REASON[sr.failReason]}</span>}
        <span className="muted">
          {formatTime(sr.startedAt)} · {formatSpan(sr.startedAt, sr.endedAt)}
        </span>
      </div>
      {placeholder && (
        <p className="hint">
          {t({
            zh: '占位阶段，暂未实现，执行到这一步直接通过。',
            en: 'A placeholder stage, not implemented yet: it passes as soon as it is reached.',
          })}
        </p>
      )}
      {kind === 'assess' && (
        <p className="hint">
          {t({
            zh: '只读地评估需求；结论和讨论记录见上方「需求评估」，评估结果存为产物 assessment。',
            en: 'Assesses the requirement read-only; see "Requirement assessment" above for the conclusion and discussion. The result is saved as the artifact assessment.',
          })}
        </p>
      )}
      {sr.feedback && (
        <Collapsible title={t({ zh: '这一轮要处理的反馈', en: 'Feedback for this round' })}>
          <Pre>{sr.feedback}</Pre>
        </Collapsible>
      )}
      {tasks.map((task) => (
        <TaskBlock key={task.id} detail={detail} task={task} onShowCommit={props.onShowCommit} />
      ))}
      {checks.length > 0 && <CheckList checks={checks} />}
      {approvals.map((a) => (
        <ApprovalLine key={a.id} approval={a} />
      ))}
      {sr.failReason === 'check' && sr.failFeedback && (
        <Collapsible title={t({ zh: '没有通过的原因', en: 'Why it did not pass' })} defaultOpen>
          <Pre>{sr.failFeedback}</Pre>
        </Collapsible>
      )}
      {artifacts.length > 0 && (
        <div className="artifacts">
          {t({ zh: '产物：', en: 'Artifacts: ' })}
          {artifacts.map((a) => (
            <a
              key={a.id}
              href={urls.artifact(detail.run.id, a.id)}
              target="_blank"
              rel="noreferrer"
            >
              {a.name}
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

function TaskBlock(props: { detail: RunDetail; task: Task; onShowCommit: (sha: string) => void }) {
  const { detail, task } = props;
  const status = TASK_STATUS[task.status];
  const attempts = detail.attempts.filter((a) => a.taskId === task.id);
  const commit = task.commitSha;
  return (
    <div className="task">
      <div className="task-head">
        <span className="task-title">{task.title}</span>
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className="muted">{task.agentId}</span>
        {task.retries > 0 && (
          <span className="muted">
            {t({
              zh: `已返工 ${task.retries} 次`,
              en: `Reworked ${task.retries} ${task.retries === 1 ? 'time' : 'times'}`,
            })}
          </span>
        )}
        {commit && (
          <button type="button" className="link" onClick={() => props.onShowCommit(commit)}>
            {t({ zh: '提交', en: 'Commit' })} {shortSha(commit)}
          </button>
        )}
      </div>
      {task.status === 'pending' && task.pendingFeedback && (
        <Collapsible title={t({ zh: '下次执行要处理的问题', en: 'Issues for the next execution' })}>
          <Pre>{task.pendingFeedback}</Pre>
        </Collapsible>
      )}
      {attempts.map((a, i) => (
        <AttemptBlock
          key={a.id}
          attempt={a}
          checks={detail.checks.filter((c) => c.attemptId === a.id)}
          latest={i === attempts.length - 1}
        />
      ))}
    </div>
  );
}

function AttemptBlock(props: { attempt: Attempt; checks: CheckResult[]; latest: boolean }) {
  const { attempt, checks } = props;
  const status = ATTEMPT_STATUS[attempt.status];
  const outcome = attempt.outcome ? ATTEMPT_OUTCOME[attempt.outcome] : undefined;
  const live = attempt.status === 'running';
  const passed = checks.filter((c) => c.passed).length;
  // Open what a human most likely wants to read: live output, review comments, the last failure.
  const notable =
    props.latest &&
    (checks.some((c) => c.kind === 'review' || c.kind === 'assess' || !c.passed) ||
      !!attempt.error);
  return (
    <Collapsible
      defaultOpen={live || notable}
      className="attempt"
      title={
        <span className="attempt-title">
          <span>{t({ zh: `第 ${attempt.seq} 次执行`, en: `Execution ${attempt.seq}` })}</span>
          <span className="muted">{attemptAgentLabel(attempt)}</span>
          <Badge tone={status.tone}>{status.label}</Badge>
          {outcome && <Badge tone={outcome.tone}>{outcome.label}</Badge>}
          {checks.length > 0 && (
            <span className={passed === checks.length ? 'muted' : 'text-danger'}>
              {t({ zh: '检查', en: 'Checks' })} {passed}/{checks.length}
            </span>
          )}
          <span className="muted">
            {[formatSpan(attempt.startedAt, attempt.endedAt), formatAttemptCost(attempt)]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
      }
    >
      {attempt.error && <ErrorBox>{attempt.error}</ErrorBox>}
      {checks.length > 0 && <CheckList checks={checks} />}
      <AgentOutput attemptId={attempt.id} live={live} />
      <div className="attempt-links">
        <a href={urls.log(attempt.id)} target="_blank" rel="noreferrer">
          {t({ zh: '原始日志', en: 'Raw log' })}
        </a>
        <a href={urls.log(attempt.id, true)}>{t({ zh: '下载', en: 'Download' })}</a>
        <span className="muted">
          {t({
            zh: `tokens：输入 ${formatTokens(attempt.inputTokens)} · 输出 ${formatTokens(attempt.outputTokens)} · 缓存 ${formatTokens(attempt.cachedTokens)}`,
            en: `tokens: input ${formatTokens(attempt.inputTokens)} · output ${formatTokens(attempt.outputTokens)} · cached ${formatTokens(attempt.cachedTokens)}`,
          })}
        </span>
        {attempt.sessionId && (
          <span className="muted">
            {t({ zh: '会话', en: 'Session' })} <code>{attempt.sessionId}</code>
          </span>
        )}
      </div>
      <Collapsible title={t({ zh: '发给 Agent 的提示词', en: 'Prompt sent to the agent' })}>
        <Pre>{attempt.prompt}</Pre>
      </Collapsible>
    </Collapsible>
  );
}

function CheckList({ checks }: { checks: CheckResult[] }) {
  return (
    <ul className="checks">
      {checks.map((c) => (
        <li key={c.id} className={c.passed ? 'check-pass' : 'check-fail'}>
          <Collapsible
            defaultOpen={c.kind === 'review' || c.kind === 'assess' || !c.passed}
            title={
              <span>
                <span
                  className="check-icon"
                  title={
                    c.passed
                      ? t({ zh: '通过', en: 'Passed' })
                      : t({ zh: '未通过', en: 'Not passed' })
                  }
                >
                  {c.passed ? '✓' : '✗'}
                </span>
                {c.kind === 'command' ? (
                  <>
                    {t({ zh: '检查命令', en: 'Check command' })} <code>{c.name}</code>
                  </>
                ) : (
                  c.name
                )}
              </span>
            }
          >
            <Pre>{c.detail || t({ zh: '（没有输出）', en: '(no output)' })}</Pre>
          </Collapsible>
        </li>
      ))}
    </ul>
  );
}

function ApprovalLine({ approval }: { approval: Approval }) {
  const label =
    approval.status === 'pending'
      ? t({ zh: '等待审批', en: 'pending' })
      : approval.status === 'approved'
        ? t({ zh: '已批准', en: 'approved' })
        : t({ zh: '已驳回', en: 'rejected' });
  return (
    <div className={`approval approval-${approval.status}`}>
      {t({ zh: `审批：${label}`, en: `Approval: ${label}` })}
      {approval.comment
        ? t({ zh: `，意见：${approval.comment}`, en: `, comment: ${approval.comment}` })
        : ''}
      <span className="muted"> · {formatTime(approval.decidedAt ?? approval.createdAt)}</span>
    </div>
  );
}

function EventsPanel({ runId }: { runId: string }) {
  const events = useResource(() => api.runEvents(runId), runId);
  useReloadOn(events.reload, (e) => e.runId === runId, 500);
  if (events.error) return <ErrorBox>{events.error}</ErrorBox>;
  if (!events.data) return <Empty>{t({ zh: '加载中…', en: 'Loading…' })}</Empty>;
  return (
    <div className="card">
      <table className="events">
        <tbody>
          {events.data.map((e) => {
            const text = eventText(e);
            return (
              <tr key={e.id}>
                <td className="muted">{formatTime(e.ts)}</td>
                <td>
                  <code>{e.type}</code>
                </td>
                <td>
                  {text && <div className="event-text">{text}</div>}
                  <code className="event-data">
                    {Object.keys(e.data).length > 0 ? JSON.stringify(e.data) : ''}
                  </code>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
