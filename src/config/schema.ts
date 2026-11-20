import { z } from 'zod';
import { DEFAULT_LANG, LANGUAGES, t } from '../i18n.js';
import { isEffortArg } from './effort.js';

export { agentEffort } from './effort.js';

/** Capability / cost level of an agent (later also the difficulty of a task). */
export const Level = z.enum(['low', 'mid', 'high']);

// ---------------------------------------------------------------------------
// config.yaml
// ---------------------------------------------------------------------------

/** Risk of a proposal, ordered; auto-accept takes everything up to a chosen level. */
export const RISKS = ['low', 'mid', 'high'] as const;
export type Risk = (typeof RISKS)[number];

/** GitHub Issues as the backlog of one registered repo. */
export const GitHubRepoSchema = z.strictObject({
  /** "owner/name"; omitted = resolved by gh from the repo's remotes. */
  issues_repo: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, {
      error: () => t({ zh: '格式应为 owner/name', en: 'should be owner/name' }),
    })
    .optional(),
  /** Template of the Runs created from issues labeled ares1:ready. */
  template: z.string().min(1),
  /** The AI scout that proposes issues; omitted = no scouting. */
  scout: z
    .strictObject({
      /** A claude-code agent; it runs with read-only tools. */
      agent: z.string().min(1),
      /** Scout on its own whenever the repo is idle; false = only from the dashboard. */
      auto: z.boolean().default(true),
      /** At least this many hours between automatic scouts; 0 = no minimum. */
      interval_hours: z.number().min(0).default(0),
      /** Proposals per scout; no automatic scout while this many proposals await triage. */
      max_proposals: z.number().int().min(1).max(20).default(5),
    })
    .optional(),
  /** Proposals labeled ares1:ready without a human. */
  auto_accept: z
    .strictObject({
      /** Highest risk accepted automatically; none = every proposal waits for a human. */
      max_risk: z.enum(['none', ...RISKS]).default('none'),
      /** Omitted = no daily limit. */
      max_per_day: z.number().int().min(1).optional(),
    })
    .prefault({}),
  /** Runs from issues merge without the merge approval. */
  auto_merge: z.boolean().default(false),
  /** Push the target branch to the GitHub repo after each merge. */
  push: z.boolean().default(false),
  /**
   * Spend of a day (scouts, auto-accepted Runs, automatic redos) after which automatic scouting,
   * auto-accepting and redoing stop until the next day; omitted = no limit.
   */
  daily_budget_usd: z.number().positive().optional(),
  /**
   * Runs an issue gets at most, the first included: a failed Run is redone automatically until
   * then; after that the issue is closed as not planned with the reasons. 1 = never redone.
   */
  max_run_attempts: z.number().int().min(1).default(3),
});
export type GitHubRepoConfig = z.infer<typeof GitHubRepoSchema>;

export const GitHubSchema = z.strictObject({
  /** gh account to act as (`gh auth token --user`); omitted = gh's active account. */
  account: z.string().min(1).optional(),
  /** How often to look for ares1:ready issues and catch up on issue updates. */
  poll_minutes: z.number().positive().default(5),
  /** Keyed by the repo name registered on the dashboard. */
  repos: z.record(z.string(), GitHubRepoSchema).default({}),
});
export type GitHubConfig = z.infer<typeof GitHubSchema>;

export const MasterConfigSchema = z.object({
  /**
   * Language of what the Master writes (issue comments, notifications, prompts to agents and
   * so what agents write back, default config files) and the dashboard's default language.
   */
  language: z.enum(LANGUAGES).default(DEFAULT_LANG),
  port: z.number().int().min(1).max(65535).default(4870),
  /** Override the executable used for a CLI, e.g. { "claude-code": "/opt/bin/claude" }. */
  bins: z.record(z.string(), z.string()).default({}),
  defaults: z
    .object({
      /** Upper bound for a single agent execution. */
      timeout_minutes: z.number().positive().default(60),
      /** Upper bound for a single verify / setup command. */
      command_timeout_minutes: z.number().positive().default(20),
    })
    .prefault({}),
  /** Omitted = no GitHub integration. */
  github: GitHubSchema.optional(),
  /** System notifications sent by the Master itself, when a human is needed. */
  notify: z.strictObject({ system: z.boolean().default(false) }).prefault({}),
  /** Upgrade the Master's own install directory when its git origin moves on. */
  upgrade: z.strictObject({ auto: z.boolean().default(false) }).prefault({}),
});
export type MasterConfig = z.infer<typeof MasterConfigSchema>;

// ---------------------------------------------------------------------------
// agents.yaml
// ---------------------------------------------------------------------------

/** Reasoning effort passed to the CLI (Claude Code: --effort). */
export const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof Effort>;

export const AgentSchema = z
  .strictObject({
    /** Which adapter runs this agent, e.g. "claude-code". */
    cli: z.string().min(1),
    model: z.string().min(1),
    /** Omitted = let the CLI use its own default. */
    effort: Effort.optional(),
    tier: Level.default('mid'),
    cost: Level.default('mid'),
    tags: z.array(z.string()).default([]),
    enabled: z.boolean().default(true),
    /**
     * "full" = the agent may run commands (Claude Code's auto mode may still deny some);
     * "safe" = edits only, no commands.
     */
    permission: z.enum(['full', 'safe']).default('full'),
    /** Extra CLI arguments appended as-is. */
    args: z.array(z.string()).default([]),
    /** USD per million tokens, used when the CLI does not report cost. */
    price: z.strictObject({ input: z.number().min(0), output: z.number().min(0) }).optional(),
    timeout_minutes: z.number().positive().optional(),
  })
  .superRefine((agent, ctx) => {
    if (agent.effort && agent.args.some(isEffortArg)) {
      ctx.addIssue({
        code: 'custom',
        path: ['effort'],
        message: t({
          zh: 'effort 与 args 里的 --effort 不能同时配置，请只保留 effort',
          en: 'effort and --effort in args cannot both be set; keep only effort',
        }),
      });
    }
  });
export type AgentConfig = z.infer<typeof AgentSchema> & { id: string };

export const AgentsFileSchema = z.strictObject({
  agents: z.record(z.string(), z.unknown()).default({}),
});

// ---------------------------------------------------------------------------
// workflows/*.yaml
// ---------------------------------------------------------------------------

export const EscalateSchema = z.strictObject({
  max_retries: z.number().int().min(0).optional(),
  on_agent_error: z.enum(['retry', 'switch_agent', 'human']).optional(),
  on_budget_exceeded: z.enum(['pause', 'abort']).optional(),
});
export type Escalate = z.infer<typeof EscalateSchema>;

export const StageSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/, {
    error: () =>
      t({
        zh: '阶段 id 只能包含小写字母、数字、- 和 _',
        en: 'a stage id may only contain lowercase letters, digits, - and _',
      }),
  }),
  name: z.string().optional(),
  /**
   * placeholder: a step not implemented yet; shown in the flow and passed without doing anything.
   * assess: a read-only agent judges the requirement before any work (go / ask / drop).
   */
  kind: z.enum(['agent', 'review', 'merge', 'placeholder', 'assess']).default('agent'),
  agent: z.string().optional(),
  agent_candidates: z.array(z.string()).optional(),
  planning: z.enum(['single', 'llm']).default('single'),
  instructions: z.string().optional(),
  inputs: z.array(z.string()).default([]),
  outputs: z.array(z.string()).default([]),
  verify: z
    .strictObject({
      commands: z.array(z.string()).optional(),
      llm_check: z.boolean().optional(),
    })
    .optional(),
  escalate: EscalateSchema.optional(),
  gate: z.boolean().default(false),
  on_fail: z.string().optional(),
  on_reject: z.string().optional(),
  timeout_minutes: z.number().positive().optional(),
  /**
   * assess stages: how many hours to wait for a human to reply to the questions before the
   * assessment decides on its own (go with its assumptions, or drop). 0 = do not wait; null =
   * wait however long it takes; omitted = the system default (`replyTimeoutHours`).
   */
  reply_timeout_hours: z.number().min(0).nullable().optional(),
});
export type StageDef = z.infer<typeof StageSchema>;

export const TemplateSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  name: z.string().optional(),
  description: z.string().optional(),
  defaults: z
    .strictObject({
      escalate: EscalateSchema.optional(),
      max_loops: z.number().int().min(0).optional(),
      budget_usd: z.number().positive().optional(),
    })
    .optional(),
  stages: z.array(StageSchema).min(1),
});
export type WorkflowTemplate = z.infer<typeof TemplateSchema>;

// ---------------------------------------------------------------------------
// What was loaded, entry by entry (shown read-only on the dashboard's config page)
// ---------------------------------------------------------------------------

/** A configuration file as read from disk; `source` is null when the file does not exist. */
export interface SourceFile {
  path: string;
  source: string | null;
}

/** One entry of agents.yaml, whether it is in use or not. */
export interface AgentEntry {
  id: string;
  /** `enabled`: in use; `disabled`: `enabled: false`; `invalid`: failed validation, not used. */
  state: 'enabled' | 'disabled' | 'invalid';
  /** The parsed configuration; null when the entry does not match the schema. */
  config: AgentConfig | null;
  /** `cli` / `model` as written, to recognize an entry whose `config` is null. */
  rawCli: string | null;
  rawModel: string | null;
  /** Why the entry is invalid. */
  errors: string[];
}

/** One file in workflows/, valid or not. */
export interface TemplateFile {
  /** "workflows/<file>", also the key of its problems in `errors` / `warnings`. */
  key: string;
  file: string;
  path: string;
  /** The YAML as written. */
  source: string;
  /** Id of the template loaded from this file; null when the file is invalid. */
  templateId: string | null;
  errors: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Run overrides: settings resolve system default → template → run override
// ---------------------------------------------------------------------------

export const RunOverridesSchema = z.strictObject({
  stages: z
    .record(
      z.string(),
      z.strictObject({
        gate: z.boolean().optional(),
        escalate: EscalateSchema.optional(),
      }),
    )
    .optional(),
  max_loops: z.number().int().min(0).optional(),
  budget_usd: z.number().positive().optional(),
});
export type RunOverrides = z.infer<typeof RunOverridesSchema>;

// Rules on top of these types (effective settings, rollback targets) live in flow.ts, which the
// dashboard imports too.
export {
  defaultRollbackTarget,
  type EffectiveStage,
  effectiveBudget,
  effectiveMaxLoops,
  effectiveStage,
  failTarget,
  replyTimeoutHours,
  rollbackTarget,
  SYSTEM_DEFAULTS,
  stageVerifyCommands,
} from './flow.js';
