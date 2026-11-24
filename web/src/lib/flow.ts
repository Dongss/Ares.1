import { agentEffort } from '../../../src/config/effort.js';
import {
  conflictTarget,
  effectiveStage,
  failTarget,
  replyTimeoutHours,
  rollbackTarget,
  runsAgent,
  runsNoCommands,
  stageAgentIds,
  stageVerifyCommands,
} from '../../../src/config/flow.js';
import type {
  AgentConfig,
  Escalate,
  RunOverrides,
  StageDef,
  WorkflowTemplate,
} from '../../../src/config/schema.js';
import { waitText } from '../../../src/engine/discussion.js';
import { t } from '../../../src/i18n.js';
import type { RunStatus, StageRun } from '../../../src/store/types.js';
import type { Tone } from './format.js';

// The flow chart of a workflow template: what each stage does and where it goes back to.
// The rules come from src/config/flow.ts, the same code the engine runs.

export interface FlowStageRef {
  id: string;
  name: string;
}

/** One agent a stage may run with, as its configuration has it. */
export interface FlowStageAgent {
  id: string;
  /** null when the agent's configuration is not known (`config` other than `ok`). */
  model: string | null;
  effort: string | null;
  tier: AgentConfig['tier'] | null;
  cost: AgentConfig['cost'] | null;
  /**
   * Whether the agent configuration is known: `ok` found and enabled, `missing` not configured
   * or disabled; `loading` / `error` while the configuration is not (yet) available.
   */
  config: AgentConfigState;
}

export interface FlowStage extends FlowStageRef {
  kind: StageDef['kind'];
  /**
   * Who may run the stage, in the template's order (`stageAgentIds`): its `agent_candidates`, or
   * its one `agent`. Empty where no agent runs (merge, placeholder and command stages).
   */
  agents: FlowStageAgent[];
  /**
   * The stage has `agent_candidates`: each round goes to the one `chooseStageAgent` picks by the
   * requirement's assessed difficulty (`candidatesRuleText`).
   */
  byDifficulty: boolean;
  /**
   * Verify commands the stage runs (none for review, assess and placeholder stages); null when
   * they are the repo default but no repo is given (`repoVerifyCommands: null`).
   */
  commands: string[] | null;
  /** The commands are the repo default, not the stage's own. */
  commandsFromRepo: boolean;
  /** Whether an agent stage splits its rounds into steps (`planning`); null for other stages. */
  planning: StageDef['planning'] | null;
  /** How many times a task is reworked before giving up (agent stages). */
  maxRetries: number;
  /** What happens once the reworks are used up: the Run fails, or waits for a human. */
  onExhausted: Required<Escalate>['on_exhausted'];
  /**
   * Assess stages: hours to wait for a reply to the questions before the assessment decides on
   * its own (0 = no wait, null = however long it takes). null for other stages.
   */
  replyTimeoutHours: number | null;
  /** Needs a human approval: after the stage, or before merging for merge stages. */
  gate: boolean;
  /**
   * Where the stage goes back to when its checks or review fail (`failTarget`). null for agent
   * stages, which rework their task instead, and for merge and command stages without commands,
   * which cannot fail.
   */
  onFail: FlowStageRef | null;
  /**
   * Merge stages: the agent stage that resolves a conflict with the target branch
   * (`conflictTarget`); null when a conflict ends the Run, and for other stages.
   */
  onConflict: FlowStageRef | null;
  /** Where the stage goes back to when the approval is rejected; null without a gate. */
  onReject: FlowStageRef | null;
}

export type AgentConfigState = 'ok' | 'missing' | 'loading' | 'error';

export interface FlowInput {
  template: WorkflowTemplate;
  overrides?: RunOverrides;
  /** The repo's default verify commands; null when the flow is not shown for a repo. */
  repoVerifyCommands: string[] | null;
  /** Configured agents; `loading` / `error` while the configuration is not available. */
  agents: FlowAgent[] | 'loading' | 'error';
}

type FlowAgent = Pick<AgentConfig, 'id' | 'model' | 'effort' | 'args' | 'tier' | 'cost'> & {
  enabled?: boolean;
};

/** One candidate of a stage, as the configuration (`agents`) has it. */
function flowStageAgent(id: string, agents: FlowInput['agents']): FlowStageAgent {
  if (!Array.isArray(agents)) {
    return { id, model: null, effort: null, tier: null, cost: null, config: agents };
  }
  const agent = agents.find((a) => a.id === id && a.enabled !== false);
  if (!agent) return { id, model: null, effort: null, tier: null, cost: null, config: 'missing' };
  return {
    id,
    model: agent.model ?? null,
    effort: agentEffort(agent) ?? null,
    tier: agent.tier,
    cost: agent.cost,
    config: 'ok',
  };
}

export function buildFlow({
  template,
  overrides = {},
  repoVerifyCommands,
  agents,
}: FlowInput): FlowStage[] {
  const ref = (id: string): FlowStageRef => ({
    id,
    name: template.stages.find((s) => s.id === id)?.name ?? id,
  });
  return template.stages.map((def) => {
    const eff = effectiveStage(template, def.id, overrides);
    const runs = runsAgent(def.kind);
    const usesRepoDefault = !runsNoCommands(def.kind) && def.verify?.commands === undefined;
    const commands =
      usesRepoDefault && repoVerifyCommands === null
        ? null
        : stageVerifyCommands(def, repoVerifyCommands ?? []);
    // Without a repo, a merge or command stage on the repo default may have commands, so it may
    // fail.
    const failsTo =
      (def.kind === 'merge' || def.kind === 'command') && commands?.length === 0
        ? null
        : failTarget(template, def.id);
    const conflictTo = conflictTarget(template, def.id);
    return {
      id: def.id,
      name: def.name ?? def.id,
      kind: def.kind,
      agents: runs ? stageAgentIds(def).map((id) => flowStageAgent(id, agents)) : [],
      byDifficulty: runs && def.agent_candidates !== undefined,
      commands,
      commandsFromRepo: usesRepoDefault,
      planning: def.kind === 'agent' ? def.planning : null,
      maxRetries: eff.escalate.max_retries,
      onExhausted: eff.escalate.on_exhausted,
      replyTimeoutHours: def.kind === 'assess' ? replyTimeoutHours(def) : null,
      gate: eff.gate,
      onFail: failsTo === null ? null : ref(failsTo),
      onConflict: conflictTo === null ? null : ref(conflictTo),
      onReject: eff.gate ? ref(rollbackTarget(template, def.id, 'reject')) : null,
    };
  });
}

/**
 * What an agent stage does when a task fails its checks: rework up to `maxRetries` times, then
 * end the Run as failed or wait for a human (`on_exhausted`).
 */
export function reworkText(
  maxRetries: number,
  onExhausted: Required<Escalate>['on_exhausted'],
): string {
  const fail = onExhausted === 'fail';
  if (maxRetries === 0) {
    return fail
      ? t({
          zh: '不返工，Run 直接结束、标为失败（从 issue 来的会自动重做）',
          en: 'No rework: the Run ends as failed (a Run from an issue is redone)',
        })
      : t({ zh: '不返工，直接等人处理', en: 'No rework: wait for a human' });
  }
  const times = t({
    zh: `返工，最多 ${maxRetries} 次`,
    en: `Rework up to ${maxRetries} ${maxRetries === 1 ? 'time' : 'times'}`,
  });
  return fail
    ? t({
        zh: `${times}，仍不通过时 Run 结束、标为失败（从 issue 来的会自动重做）`,
        en: `${times}, then the Run ends as failed (a Run from an issue is redone)`,
      })
    : t({ zh: `${times}，仍不通过时等人处理`, en: `${times}, then wait for a human` });
}

/**
 * How an agent stage splits its rounds into steps (`planning`); null when it does not (`single`,
 * or a stage of another kind).
 */
export function planningText(planning: StageDef['planning'] | null): string | null {
  if (planning === 'llm') {
    return t({
      zh: '每一轮先由 Agent 只读地拆成几步，再一步一步做、检查和提交',
      en: 'Every round, the agent first splits it read-only into steps, each then done, checked and committed on its own',
    });
  }
  if (planning === 'auto') {
    return t({
      zh: '按需求规模：需求评估给出的规模为 L 时先拆成几步再一步一步做，S、M 或没有规模时一次做完',
      en: "By the requirement's size: split into steps done one by one when the assessment sized it L; done in one go for S, M or no size",
    });
  }
  return null;
}

/**
 * How a stage with `agent_candidates` picks the agent of a round, as `chooseStageAgent` does in
 * the engine.
 */
export function candidatesRuleText(): string {
  return t({
    zh: '按需求评估给出的难度，挑档次够用、成本最低的；没有够档次的就挑档次最高的；没有难度时用第一个',
    en: 'By the difficulty the assessment gave: the cheapest whose tier is enough, else the highest tier; the first one when there is no difficulty',
  });
}

/** 「档次 high · 成本 mid」: an agent's tier and cost as agents.yaml gives them. */
export function tierCostText(agent: Pick<FlowStageAgent, 'tier' | 'cost'>): string | null {
  if (agent.tier === null || agent.cost === null) return null;
  return t({
    zh: `档次 ${agent.tier} · 成本 ${agent.cost}`,
    en: `tier ${agent.tier} · cost ${agent.cost}`,
  });
}

/**
 * What an assess stage does when it has questions: discuss with a human, and decide on its own
 * once nobody replied within `replyTimeoutHours`.
 */
export function assessInDoubt(replyTimeoutHours: number | null): string {
  const discuss = t({
    zh: '在 issue 或 Run 详情页讨论，回复后重新评估；你同意不做时 Run 结束',
    en: 'Discuss on the issue or the Run page and reassess after each reply; the Run ends if you agree to drop it',
  });
  if (replyTimeoutHours === null) return discuss;
  if (replyTimeoutHours === 0) {
    return t({
      zh: '不等人回复：评估自己决定，写明假设后开工，或者不做',
      en: 'No wait for replies: the assessment decides on its own, going ahead on written-down assumptions or dropping it',
    });
  }
  const wait = waitText(replyTimeoutHours);
  return t({
    zh: `${discuss}。${wait}内没人回复时由评估自己决定：写明假设后开工，或者不做`,
    en: `${discuss}. If nobody replies within ${wait}, the assessment decides on its own: it goes ahead on written-down assumptions, or drops it`,
  });
}

export type FlowStatus =
  | 'not_started'
  | 'running'
  | 'blocked'
  | 'paused'
  | 'cancelled'
  | 'waiting_approval'
  | 'passed'
  | 'failed';

/** A badge whose label is picked in the language in use when read, not at import. */
function badge(zh: string, en: string, tone: Tone): { readonly label: string; tone: Tone } {
  return {
    get label() {
      return t({ zh, en });
    },
    tone,
  };
}

export const FLOW_STATUS: Record<FlowStatus, { readonly label: string; tone: Tone }> = {
  not_started: badge('未开始', 'Not started', 'muted'),
  running: badge('进行中', 'Running', 'active'),
  blocked: badge('卡住', 'Stuck', 'danger'),
  paused: badge('已暂停', 'Paused', 'muted'),
  cancelled: badge('已终止', 'Cancelled', 'muted'),
  waiting_approval: badge('待审批', 'Awaiting approval', 'attention'),
  passed: badge('已通过', 'Passed', 'success'),
  failed: badge('未通过', 'Failed', 'danger'),
};

export interface FlowProgress {
  /** Status of the latest round. */
  status: FlowStatus;
  rounds: number;
  /** The latest round, to jump to in the timeline. */
  latestStageRunId: string | null;
}

/** What an unfinished stage round shows while the Run is not actually running. */
const HALTED: Partial<Record<RunStatus, FlowStatus>> = {
  blocked: 'blocked',
  paused: 'paused',
  cancelled: 'cancelled',
};

/**
 * Progress of one stage from the Run's stage rounds. An unfinished round of a blocked, paused
 * or cancelled Run shows that instead of 「进行中」.
 */
export function stageProgress(
  stageId: string,
  stageRuns: StageRun[],
  runStatus?: RunStatus,
): FlowProgress {
  const rounds = stageRuns.filter((sr) => sr.stageId === stageId);
  const latest = rounds.reduce<StageRun | undefined>(
    (a, b) => (a && a.round >= b.round ? a : b),
    undefined,
  );
  if (!latest) return { status: 'not_started', rounds: 0, latestStageRunId: null };
  const status: FlowStatus =
    latest.status === 'pending' || latest.status === 'executing'
      ? ((runStatus && HALTED[runStatus]) ?? 'running')
      : latest.status;
  return { status, rounds: rounds.length, latestStageRunId: latest.id };
}
