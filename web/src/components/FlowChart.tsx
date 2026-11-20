import { Fragment, type ReactNode } from 'react';
import { runsNoCommands } from '../../../src/config/flow.js';
import { t } from '../../../src/i18n.js';
import {
  type AgentConfigState,
  FLOW_STATUS,
  type FlowProgress,
  type FlowStage,
} from '../lib/flow.js';
import { Badge } from './ui.js';

/**
 * The stages of a workflow in order. With `progress`, each stage also shows its status
 * and rounds; stages that have started can be clicked (`onSelect`).
 */
export function FlowChart(props: {
  stages: FlowStage[];
  progress?: Record<string, FlowProgress>;
  onSelect?: (stage: FlowStage, progress: FlowProgress) => void;
}) {
  return (
    <ol className="flow" aria-label={t({ zh: '流程', en: 'Flow' })}>
      {props.stages.map((stage, i) => {
        const progress = props.progress?.[stage.id];
        const select = props.onSelect;
        const body = <FlowStageBody stage={stage} progress={progress} />;
        const className = `flow-stage flow-${progress?.status ?? 'plain'}`;
        return (
          <Fragment key={stage.id}>
            {i > 0 && <li className="flow-arrow" aria-hidden="true" />}
            <li className={className}>
              {select && progress?.latestStageRunId ? (
                <button
                  type="button"
                  className="flow-stage-body"
                  title={t({
                    zh: '查看这个阶段的执行记录',
                    en: 'See what ran in this stage',
                  })}
                  onClick={() => select(stage, progress)}
                >
                  {body}
                </button>
              ) : (
                <div className="flow-stage-body">{body}</div>
              )}
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}

function FlowStageBody({ stage, progress }: { stage: FlowStage; progress?: FlowProgress }) {
  const status = progress && FLOW_STATUS[progress.status];
  return (
    <>
      <span className="flow-head">
        <span className="flow-name">{stage.name}</span>
        {status && <Badge tone={status.tone}>{status.label}</Badge>}
        {progress && progress.rounds > 0 && (
          <span className="flow-rounds">
            {t({
              zh: `已跑 ${progress.rounds} 轮`,
              en: `${progress.rounds} ${progress.rounds === 1 ? 'round' : 'rounds'}`,
            })}
          </span>
        )}
      </span>
      {stage.kind === 'review' && (
        <Line label={kindLabel()}>{t({ zh: '评审', en: 'Review' })}</Line>
      )}
      {stage.kind === 'assess' && (
        <Line label={kindLabel()}>
          {t({ zh: '需求评估', en: 'Requirement assessment' })}
          <span className="flow-sub">
            {t({
              zh: '只读：需求合理就开工，有疑问先和人讨论',
              en: 'Read-only: starts when the requirement makes sense, discusses with a human when in doubt',
            })}
          </span>
        </Line>
      )}
      {stage.kind === 'merge' && (
        <Line label={kindLabel()}>
          {t({ zh: '合并到目标分支', en: 'Merge into the target branch' })}
        </Line>
      )}
      {stage.kind === 'placeholder' && (
        <Line label={kindLabel()}>
          {t({ zh: '占位', en: 'Placeholder' })}
          <span className="flow-sub">
            {t({
              zh: '暂未实现，执行到这一步直接通过',
              en: 'Not implemented yet; passes right away',
            })}
          </span>
        </Line>
      )}
      {stage.agent && (
        <Line label="Agent">
          {stage.agent.id}
          <span className="flow-sub">
            {stage.agent.config === 'ok'
              ? `${stage.agent.model ?? t({ zh: '默认模型', en: 'default model' })} · ${
                  stage.agent.effort ?? t({ zh: '默认 effort', en: 'default effort' })
                }`
              : agentConfigText(stage.agent.config)}
          </span>
        </Line>
      )}
      {!runsNoCommands(stage.kind) && (
        <Line label={t({ zh: '检查', en: 'Checks' })}>
          {stage.commands === null ? (
            <span className="flow-sub">
              {t({ zh: '仓库默认的检查命令', en: "The repo's default verify commands" })}
            </span>
          ) : stage.commands.length === 0 ? (
            <span className="flow-sub">{t({ zh: '无', en: 'None' })}</span>
          ) : (
            stage.commands.map((c) => (
              <code key={c} className="flow-command">
                {c}
              </code>
            ))
          )}
          {stage.commandsFromRepo && stage.commands !== null && stage.commands.length > 0 && (
            <span className="flow-sub">{t({ zh: '仓库默认', en: 'repo default' })}</span>
          )}
          {/* null: the repo default, which may have commands */}
          {stage.kind === 'merge' && stage.commands?.length !== 0 && (
            <span className="flow-sub">
              {t({
                zh: '目标分支有新提交时运行',
                en: 'Run when the target branch has new commits',
              })}
            </span>
          )}
        </Line>
      )}
      {stage.kind === 'agent' && (
        <Line label={failLabel()}>
          {stage.maxRetries > 0
            ? t({
                zh: `返工，最多 ${stage.maxRetries} 次，仍不通过时等人处理`,
                en: `Rework up to ${stage.maxRetries} ${stage.maxRetries === 1 ? 'time' : 'times'}, then wait for a human`,
              })
            : t({ zh: '不返工，直接等人处理', en: 'No rework: wait for a human' })}
        </Line>
      )}
      {stage.kind === 'assess' && (
        <Line label={t({ zh: '有疑问', en: 'In doubt' })}>
          {t({
            zh: '在 issue 或 Run 详情页讨论，回复后重新评估；你同意不做时 Run 结束',
            en: 'Discuss on the issue or the Run page and reassess after each reply; the Run ends if you agree to drop it',
          })}
        </Line>
      )}
      {stage.onFail && <Line label={failLabel()}>{backTo(stage.onFail.name)}</Line>}
      {stage.gate && (
        <Line label={t({ zh: '审批', en: 'Approval' })} tone="attention">
          {stage.kind === 'merge'
            ? t({ zh: '合并前人工审批', en: 'A human approves before merging' })
            : t({ zh: '完成后人工审批', en: 'A human approves when done' })}
        </Line>
      )}
      {stage.onReject && (
        <Line label={t({ zh: '驳回', en: 'Rejected' })}>{backTo(stage.onReject.name)}</Line>
      )}
    </>
  );
}

function kindLabel(): string {
  return t({ zh: '类型', en: 'Type' });
}

function failLabel(): string {
  return t({ zh: '不通过', en: 'Fails' });
}

function backTo(stage: string): string {
  return t({ zh: `回到「${stage}」`, en: `Back to "${stage}"` });
}

function agentConfigText(state: Exclude<AgentConfigState, 'ok'>): string {
  switch (state) {
    case 'missing':
      return t({ zh: 'Agent 不存在或未启用', en: 'The agent does not exist or is disabled' });
    case 'loading':
      return '…';
    case 'error':
      return t({ zh: '配置加载失败', en: 'Could not load the configuration' });
  }
}

function Line(props: { label: string; tone?: 'attention'; children: ReactNode }) {
  return (
    <span className={`flow-line ${props.tone ? `flow-line-${props.tone}` : ''}`}>
      <span className="flow-label">{props.label}</span>
      <span className="flow-value">{props.children}</span>
    </span>
  );
}
