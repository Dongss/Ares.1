import { z } from 'zod';
import { DEFAULT_LANG, LANGUAGES, t } from '../i18n.js';
import { isEffortArg } from './effort.js';
import { PROPOSAL_SIZES, RISKS } from './flow.js';

export { agentEffort } from './effort.js';

/**
 * A level, low < mid < high (`levelRank` in src/config/flow.ts): an agent's capability (`tier`)
 * and cost (`cost`); a requirement's difficulty (`DIFFICULTIES`) uses the same three values, so a
 * stage's `agent_candidates` are matched to it by tier.
 */
export const Level = z.enum(['low', 'mid', 'high']);

// ---------------------------------------------------------------------------
// config.yaml
// ---------------------------------------------------------------------------

/**
 * The AI scout of a repo: it reads the repo and its Run records and proposes requirements, as
 * issues labeled ares1:proposal on GitHub or as proposals in the local backlog.
 */
export const ScoutConfigSchema = z.strictObject({
  /** An agent of a CLI that can run read-only (claude-code, codex); it runs read-only. */
  agent: z.string().min(1),
  /** Scout on its own whenever the repo is idle; false = only from the dashboard. */
  auto: z.boolean().default(true),
  /** At least this many minutes between automatic scouts; 0 = no minimum. */
  interval_minutes: z.number().min(0).default(0),
  /** Proposals per scout; no automatic scout while this many proposals await triage. */
  max_proposals: z.number().int().min(1).max(20).default(5),
});
export type ScoutConfig = z.infer<typeof ScoutConfigSchema>;

/**
 * Proposals accepted without a human: on GitHub they are labeled ares1:ready, in the local
 * backlog a Run is created from them right away.
 */
export const AutoAcceptSchema = z.strictObject({
  /** Highest risk accepted automatically; none = every proposal waits for a human. */
  max_risk: z.enum(['none', ...RISKS]).default('none'),
  /**
   * Largest size accepted automatically, together with max_risk. L by default: a template whose
   * coding stage plans (planning: auto or llm) splits an L requirement into steps, so one Run
   * finishes it.
   */
  max_size: z.enum(PROPOSAL_SIZES).default('L'),
  /** Omitted = no daily limit. */
  max_per_day: z.number().int().min(1).optional(),
});
export type AutoAcceptConfig = z.infer<typeof AutoAcceptSchema>;

/**
 * What a repo's requirements are worked with, wherever they come from: GitHub issues
 * (`github.repos`) or the local backlog (`backlog.repos`). Both spread its shape, so the fields
 * read and validate the same in either.
 */
export const ProposalSourceSchema = z.strictObject({
  /**
   * Template of the Runs created from accepted requirements: issues labeled ares1:ready, or
   * accepted local proposals.
   */
  template: z.string().min(1),
  /** The AI scout that proposes requirements; omitted = no scouting. */
  scout: ScoutConfigSchema.optional(),
  auto_accept: AutoAcceptSchema.prefault({}),
  /** Runs from the repo's requirements merge without the merge approval. */
  auto_merge: z.boolean().default(false),
  /**
   * Spend of a day on what the Master does by itself (scouts, auto-accepted Runs, automatic
   * redos where failed Runs are redone) after which automatic scouting, auto-accepting and
   * redoing stop until the next day; omitted = no limit.
   */
  daily_budget_usd: z.number().positive().optional(),
  /**
   * Runs a requirement gets at most, the first included: a failed Run is redone automatically
   * until then; after that the issue is closed as not planned with the reasons, or the local
   * proposal is marked failed with them. 1 = never redone.
   */
  max_run_attempts: z.number().int().min(1).default(3),
});
/** The settings GitHub and local backlog repos share, for what works with either. */
export type ProposalSourceConfig = z.infer<typeof ProposalSourceSchema>;

/** GitHub Issues as the backlog of one registered repo. */
export const GitHubRepoSchema = z.strictObject({
  /** "owner/name"; omitted = resolved by gh from the repo's remotes. */
  issues_repo: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, {
      error: () => t({ zh: '格式应为 owner/name', en: 'should be owner/name' }),
    })
    .optional(),
  ...ProposalSourceSchema.shape,
  /** Push the target branch to the GitHub repo after each merge. */
  push: z.boolean().default(false),
  /**
   * How a Run's work reaches GitHub. push: the merge stage fast-forwards the local target branch
   * and the target branch is pushed (with push: true). pr: for target branches that only take
   * pull requests (protected, or guarded by CI and reviews): the merge stage pushes the Run's
   * branch and opens a pull request to the target branch instead, and the Run completes once it
   * is merged on GitHub; the target branch itself is never pushed. pr needs push: true.
   */
  deliver: z.enum(['push', 'pr']).default('push'),
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

/**
 * The local backlog as the source of one registered repo's requirements: the scout's proposals
 * are kept by the Master, and accepted ones (on the dashboard, or by `auto_accept`) become Runs.
 * For repos without GitHub; nothing here calls GitHub.
 */
export const BacklogRepoSchema = z.strictObject({ ...ProposalSourceSchema.shape });
export type BacklogRepoConfig = z.infer<typeof BacklogRepoSchema>;

export const BacklogSchema = z.strictObject({
  /** How often to look at the local backlog for proposals to auto-accept and scouts to start. */
  poll_minutes: z.number().positive().default(5),
  /**
   * Keyed by the repo name registered on the dashboard. A repo takes its requirements from one
   * source only, so a name of `github.repos` is an error here.
   */
  repos: z.record(z.string(), BacklogRepoSchema).default({}),
});
export type BacklogConfig = z.infer<typeof BacklogSchema>;

/** Notifications POSTed to an address of the user's (ntfy, a Slack incoming webhook, ...). */
export const WebhookSchema = z.strictObject({
  /** Only http and https: the Master sends nothing anywhere else. */
  url: z
    .url({
      protocol: /^https?$/,
      error: () =>
        t({
          zh: '应为 http:// 或 https:// 开头的地址',
          en: 'should be an http:// or https:// URL',
        }),
    })
    // fetch refuses such URLs, and would put the whole address in its error message.
    .refine(
      (url) => {
        // An address that does not parse is already reported above.
        const parsed = URL.parse(url);
        return !parsed?.username && !parsed?.password;
      },
      {
        error: () =>
          t({
            zh: '地址里不能带用户名和密码，请放到 headers 的 Authorization 里',
            en: 'the address cannot carry a user name and password; put them in an Authorization header',
          }),
      },
    ),
  /** Extra request headers, e.g. for authorization; they override the defaults. */
  headers: z
    .record(
      // zod reports a bad key as an invalid key at its path, so no message of its own.
      z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
      // fetch would refuse it, with the value (maybe a token) in its error message.
      z.string().regex(/^[^\r\n\0]*$/, {
        error: () =>
          t({ zh: '请求头的值不能有换行', en: 'a header value cannot contain line breaks' }),
      }),
    )
    .default({}),
  /** json = { kind, title, body, text, ... }; text = "title\nbody" as plain text. */
  format: z.enum(['json', 'text']).default('json'),
});
export type WebhookConfig = z.infer<typeof WebhookSchema>;

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
  /** How many Runs execute at the same time. */
  concurrency: z
    .strictObject({
      /**
       * Runs of one repo (one execution slot: repos registered on the same path share it) that
       * execute at the same time, each in its own worktree. Their merges still go one at a time.
       */
      per_repo: z.number().int().min(1).default(1),
      /**
       * Runs of all repos together that execute at the same time, counted as `per_repo` counts
       * them (`roomUnderMaxRuns`). Omitted = no limit beyond `per_repo`.
       */
      max_runs: z.number().int().min(1).optional(),
    })
    .prefault({}),
  /** Omitted = no GitHub integration. */
  github: GitHubSchema.optional(),
  /** Omitted = no local backlog. */
  backlog: BacklogSchema.optional(),
  /** Notifications sent by the Master itself, when a human is needed. */
  notify: z
    .strictObject({
      /** System notifications of the platform the Master runs on. */
      system: z.boolean().default(false),
      /** Omitted = no webhook. Independent of `system`. */
      webhook: WebhookSchema.optional(),
    })
    .prefault({}),
  /** Upgrade the Master's own install directory when its git origin moves on. */
  upgrade: z.strictObject({ auto: z.boolean().default(false) }).prefault({}),
});
export type MasterConfig = z.infer<typeof MasterConfigSchema>;

// ---------------------------------------------------------------------------
// agents.yaml
// ---------------------------------------------------------------------------

/**
 * Reasoning effort passed to the CLI (Claude Code: --effort; Codex: -c model_reasoning_effort,
 * which has the same names).
 */
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
     * "safe" = edits only, no commands (Codex cannot tell the two apart: loading warns).
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
  /**
   * When a task still fails after max_retries reworks, or a stage rolls back past max_loops:
   * `fail` ends the Run as failed (a Run from an issue is redone); `human` waits for a human.
   */
  on_exhausted: z.enum(['fail', 'human']).optional(),
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
   * command: the Master runs `verify.commands` (the repo's verify commands when not given) in the
   * Run's worktree, without an agent; when one fails, the stage goes back to `on_fail` (the
   * nearest earlier agent stage by default) with the command and the end of its output.
   */
  kind: z.enum(['agent', 'review', 'merge', 'placeholder', 'assess', 'command']).default('agent'),
  /** Agent, review and assess stages: the one agent that always does the stage's work. */
  agent: z.string().optional(),
  /**
   * Agent, review and assess stages, instead of `agent`: the agents to pick from by the
   * requirement's assessed difficulty when a round of the stage starts (`chooseStageAgent` in
   * src/config/flow.ts); switch_agent then switches only among them. Load rules are in
   * `validateTemplate` (src/config/load.ts).
   */
  agent_candidates: z.array(z.string()).optional(),
  /**
   * agent stages: `single` = the whole stage is one task; `llm` = every round, the stage's agent
   * first splits it, read-only, into ordered tasks, each then executed, checked and committed on
   * its own; `auto` = like `llm` when the Run's requirement assessment sized it L, otherwise like
   * `single` (`plansStage` in src/config/flow.ts).
   */
  planning: z.enum(['single', 'llm', 'auto']).default('single'),
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
  /** What to know about a valid entry, e.g. a setting its CLI cannot honor exactly. */
  warnings: string[];
}

/**
 * One template file, valid or not: in workflows/ of the home directory, or in a repo's
 * .ares1/workflows/ as committed on its target branch.
 */
export interface TemplateFile {
  /**
   * "workflows/<file>", or "<repo>:.ares1/workflows/<file>" for a repo's; also the key of its
   * problems in `errors` / `warnings`.
   */
  key: string;
  file: string;
  /** Absolute in the home directory; from the repo's root for a repo's file. */
  path: string;
  /** The YAML as written. */
  source: string;
  /**
   * Id of the template loaded from this file; null when the file is invalid (and no earlier
   * version stands in for it, see `lastGood`).
   */
  templateId: string | null;
  errors: string[];
  /**
   * Those of the template loaded from this file. What `lastGood` and `shadowed` say is told in the
   * configuration's `warnings` under `key`, not here.
   */
  warnings: string[];
  /**
   * Only a repo's file that failed to load this time while an earlier version of it had loaded:
   * that version is the template in use. `sha`: the commit it was read from; `errors`: why the
   * file as written failed.
   */
  lastGood?: { sha: string; source: string; errors: string[] };
  /**
   * Only a repo's file whose template id the home directory also has: the home one is used, so
   * this one has no effect.
   */
  shadowed?: boolean;
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
  conflictTarget,
  defaultRollbackTarget,
  type EffectiveStage,
  effectiveBudget,
  effectiveMaxLoops,
  effectiveStage,
  failTarget,
  loopsExhausted,
  replyTimeoutHours,
  rollbackTarget,
  SYSTEM_DEFAULTS,
  stageVerifyCommands,
} from './flow.js';
