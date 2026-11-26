// What the AI scout is asked and what it answers.

import { z } from 'zod';
import { brandName } from '../brand.js';
import {
  type AutoAcceptLimits,
  holdsScout,
  ITERATION_OPEN_STATUSES,
  iterationKind,
  iterationProgress,
  MAX_ITERATION_CHILDREN,
  PROPOSAL_SIZES,
  proposalAwaitingRedo,
  RISKS,
  sizeMeanings,
  unmetDependencies,
} from '../config/flow.js';
import {
  deniedOperations,
  parseReport,
  type ResultProblemKind,
  type ReviewReport,
  ReviewReportSchema,
  resultProblem,
  TaskReportSchema,
} from '../engine/contracts.js';
import {
  assessmentRounds,
  conclusionLabel,
  conclusionOf,
  humanReplies,
} from '../engine/discussion.js';
import { planSteps } from '../engine/plan.js';
import {
  type ConflictWaitSpan,
  conflictWaitSpans,
  minutes,
  type RunTimePart,
  type RunTimes,
  runTimePartLabels,
  runTimeParts,
  SHOWN_PART_MS,
  storedRunTimes,
  timeParts,
  type WorkSwitch,
  workSwitchesOf,
} from '../engine/times.js';
import type { HostAuthored, HostIssue } from '../host/code-host.js';
import { join, t } from '../i18n.js';
import type { Store } from '../store/store.js';
import {
  type Attempt,
  type CheckResult,
  type EventRow,
  type Iteration,
  type IterationChild,
  type IterationChildStatus,
  type IterationStatus,
  type Proposal,
  type Run,
  SCOUT_LEADS,
  type Scout,
  type ScoutGap,
  type ScoutProposal,
  type StageRun,
  type Task,
} from '../store/types.js';
import type { UpgradeFailure } from '../upgrade/upgrader.js';
import { executionSlot } from '../util.js';
import {
  FOOTER_MARKER,
  isRetriesExhaustedComment,
  isTrusted,
  LABELS,
  proposalSections,
  stripMarker,
} from './issues.js';
import { redactForGitHub } from './redact.js';

const CATEGORIES = ['bug', 'feature', 'improvement', 'docs', 'test', 'refactor'] as const;

/** What every requirement the scout writes is made of: a proposal, or a step of an iteration. */
const RequirementSchema = z.object({
  title: z.string().trim().min(1).max(120),
  category: z.enum(CATEGORIES),
  size: z.enum(PROPOSAL_SIZES),
  risk: z.enum(RISKS),
  why: z.string().trim().min(1),
  evidence: z.array(z.string().trim().min(1)).min(1),
  what: z.string().trim().min(1),
  acceptance: z.array(z.string().trim().min(1)).min(1),
});

/** A proposal of its own, outside any iteration, with the lead it follows. */
export const ProposalSchema = RequirementSchema.extend({ lead: z.enum(SCOUT_LEADS) });

/** A number in an iteration's plan or list of criteria, from 1. */
const NumberSchema = z.number().int().min(1);

/**
 * One step of a planned iteration: a requirement like a proposal, the completion criteria it
 * moves forward and the steps it depends on, by their numbers from 1 (a step's number is its
 * place in the plan); `closeout` marks the closing step that gathers the review suggestions.
 */
const PlannedChildSchema = RequirementSchema.extend({
  criteria: z.array(NumberSchema).default([]),
  dependsOn: z.array(NumberSchema).default([]),
  closeout: z.boolean().default(false),
});

/**
 * A new iteration as the scout plans it, when the repo has none under way: one larger goal,
 * what users can do once it is done, how to tell it is, what it leaves out, and its steps in the
 * order of their dependencies (see planProblems for the rules they follow).
 */
const PlannedIterationSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    goal: z.string().trim().min(1),
    readmeGoal: z.string().trim().min(1),
    criteria: z.array(z.string().trim().min(1)).min(1),
    outOfScope: z.array(z.string().trim().min(1)).default([]),
    children: z.array(PlannedChildSchema).min(1).max(MAX_ITERATION_CHILDREN),
  })
  .superRefine((plan, ctx) => {
    for (const { path, message } of planProblems(plan)) {
      ctx.addIssue({ code: 'custom', path, message });
    }
  });

/**
 * A step added to the plan of the iteration under way: numbered after the steps it has, it
 * depends on steps by their numbers in the plan; `replaces` is the number of the failed step it
 * takes over from, if any.
 */
const IterationAdditionSchema = RequirementSchema.extend({
  criteria: z.array(NumberSchema).default([]),
  dependsOn: z.array(NumberSchema).default([]),
  replaces: NumberSchema.nullish(),
});

/** A change to the plan of the iteration under way, with why (`note`). */
const IterationUpdateSchema = z.object({
  note: z.string().trim().min(1),
  add: z.array(IterationAdditionSchema).min(1).max(MAX_ITERATION_CHILDREN),
});

export type PlannedChild = z.infer<typeof PlannedChildSchema>;
export type PlannedIteration = z.infer<typeof PlannedIterationSchema>;
export interface IterationAddition
  extends Omit<z.infer<typeof IterationAdditionSchema>, 'replaces'> {
  /** The number of the failed or dropped step it replaces; missing when it replaces none. */
  replaces?: number;
}
export interface IterationUpdate {
  /** Why the plan changes; recorded on the iteration (a comment on its issue on GitHub). */
  note: string;
  /** The steps added, numbered after the plan's last one, in this order. */
  add: IterationAddition[];
}

/**
 * The children of a new iteration's record, as its scout planned them: each step numbered by its
 * place in the plan, not accepted yet (`planned`), with no Run and, until its source writes it
 * out, no issue or proposal.
 */
export function plannedChildren(plan: Pick<PlannedIteration, 'children'>): IterationChild[] {
  return plan.children.map((c, i) => ({
    title: c.title,
    category: c.category,
    size: c.size,
    risk: c.risk,
    why: c.why,
    evidence: [...c.evidence],
    what: c.what,
    acceptance: [...c.acceptance],
    position: i + 1,
    criteria: [...c.criteria],
    dependsOn: [...c.dependsOn],
    closeout: c.closeout,
    status: 'planned',
    runIds: [],
  }));
}

/** 「2、3」, numbers of steps or criteria as a list. */
const numberList = (numbers: readonly number[]) => join(numbers.map(String));

/** A rule of the plan a scout's iteration breaks: where, and what is wrong. */
interface PlanProblem {
  path: (string | number)[];
  message: string;
}

/**
 * What is wrong with a planned iteration, empty when nothing: a step may depend only on steps
 * before it (so a plan never has a cycle) and name only criteria the iteration has; at most one
 * step closes it out, and that one comes last, after every other step, and is not the only one.
 * The number of steps is limited by the schema (MAX_ITERATION_CHILDREN).
 */
export function planProblems(
  plan: Pick<PlannedIteration, 'criteria'> & {
    children: readonly Pick<PlannedChild, 'criteria' | 'dependsOn' | 'closeout'>[];
  },
): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const children = plan.children;
  for (const [i, child] of children.entries()) {
    const position = i + 1;
    const later = child.dependsOn.filter((n) => n >= position);
    if (later.length > 0) {
      problems.push({
        path: ['children', i, 'dependsOn'],
        message:
          position === 1
            ? t({
                zh: `第 1 个子项排在最前，不能依赖别的子项（写了 ${numberList(later)}）`,
                en: `step 1 comes first and cannot depend on other steps (it names ${numberList(later)})`,
              })
            : t({
                zh: `第 ${position} 个子项只能依赖排在它前面的子项（1 到 ${position - 1}），写了 ${numberList(later)}`,
                en: `step ${position} may depend only on steps before it (1 to ${position - 1}); it names ${numberList(later)}`,
              }),
      });
    }
    const unknown = child.criteria.filter((n) => n > plan.criteria.length);
    if (unknown.length > 0) {
      problems.push({
        path: ['children', i, 'criteria'],
        message: t({
          zh: `完成标准只有 ${plan.criteria.length} 条，第 ${position} 个子项写了 ${numberList(unknown)}`,
          en: `there ${plan.criteria.length === 1 ? 'is 1 completion criterion' : `are ${plan.criteria.length} completion criteria`}; step ${position} names ${numberList(unknown)}`,
        }),
      });
    }
  }
  const closeouts = children.flatMap((c, i) => (c.closeout ? [i] : []));
  if (closeouts.length > 1) {
    problems.push({
      path: ['children'],
      message: t({
        zh: `只能有一个收尾子项（closeout 为 true），现在有 ${closeouts.length} 个：第 ${numberList(closeouts.map((i) => i + 1))} 个`,
        en: `only one step may close the iteration out (closeout true); steps ${numberList(closeouts.map((i) => i + 1))} do`,
      }),
    });
    return problems;
  }
  const at = closeouts[0];
  if (at === undefined) return problems;
  if (children.length === 1) {
    problems.push({
      path: ['children'],
      message: t({
        zh: '除了收尾子项，迭代至少还要有一个子项',
        en: 'an iteration needs at least one step besides the closing one',
      }),
    });
    return problems;
  }
  if (at !== children.length - 1) {
    problems.push({
      path: ['children', at, 'closeout'],
      message: t({
        zh: `收尾子项要排在最后，现在是第 ${at + 1} 个，共 ${children.length} 个`,
        en: `the closing step must come last; it is step ${at + 1} of ${children.length}`,
      }),
    });
    return problems;
  }
  // Reached through the steps it depends on, directly or not: either way it starts last.
  const reached = new Set<number>();
  const next = [...(children[at]?.dependsOn ?? [])];
  for (let n = next.pop(); n !== undefined; n = next.pop()) {
    if (reached.has(n) || n > at) continue;
    reached.add(n);
    next.push(...(children[n - 1]?.dependsOn ?? []));
  }
  const missing = children.slice(0, at).flatMap((_, i) => (reached.has(i + 1) ? [] : [i + 1]));
  if (missing.length > 0) {
    problems.push({
      path: ['children', at, 'dependsOn'],
      message: t({
        zh: `收尾子项要依赖其余全部子项，还缺 ${numberList(missing)}`,
        en: `the closing step must depend on every other step; it misses ${numberList(missing)}`,
      }),
    });
  }
  return problems;
}

/**
 * A capability the project lacks for one of its README's goals, from the scout's gap analysis.
 * The scout serves every registered repo, each with the goals of its own README, so `goal` copies
 * the goal word for word from that README rather than coming from a fixed list: the dashboard
 * groups gaps by it.
 */
export const GapSchema = z.object({
  goal: z.string().trim().min(1).max(120),
  gap: z.string().trim().min(1),
  evidence: z.array(z.string().trim().min(1)).min(1),
});

export const ScoutReportSchema = z.object({
  gaps: z.array(GapSchema),
  proposals: z.array(ProposalSchema),
  iteration: PlannedIterationSchema.nullish(),
  iterationUpdate: IterationUpdateSchema.nullish(),
});

/** The scout's answer as the Master takes it. */
export interface ScoutReport {
  proposals: ScoutProposal[];
  gaps: ScoutGap[];
  /** A new iteration, planned while the repo has none under way; null for none. */
  iteration: PlannedIteration | null;
  /** A change to the plan of the iteration under way; null for none. */
  iterationUpdate: IterationUpdate | null;
}

/**
 * 「S：…；M：…；L：…」: what a proposal's size means, the same meanings a requirement assessment
 * sizes by (`sizeMeanings`), so the two judge a requirement alike.
 */
function sizeDescription(): string {
  const meanings = sizeMeanings();
  return PROPOSAL_SIZES.map((size) => `${size}${t({ zh: '：', en: ': ' })}${meanings[size]}`).join(
    t({ zh: '；', en: '; ' }),
  );
}

/** JSON schema of the scout's answer, its descriptions in the language in use. */
export function scoutReportJsonSchema() {
  return {
    type: 'object',
    required: ['gaps', 'proposals', 'iteration', 'iterationUpdate'],
    additionalProperties: false,
    properties: {
      gaps: {
        type: 'array',
        description: t({
          zh: '差距分析：对照 README.md 的目标，这个项目在能力层面还做不到的事，最重要的在前；没有就是空列表',
          en: "Gap analysis: what the project cannot do yet, as capabilities, measured against README.md's goals, most important first; an empty list if there is nothing",
        }),
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['goal', 'gap', 'evidence'],
          properties: {
            goal: {
              type: 'string',
              description: t({
                zh: '缺口挡住的是 README.md 里的哪个目标：一字不差地照抄 README.md 里这个目标的原文，同一个目标在每个缺口里写法相同',
                en: 'The goal in README.md this gap stands in the way of, copied word for word as README.md writes it; the same goal is written the same way in every gap',
              }),
            },
            gap: {
              type: 'string',
              description: t({
                zh: '缺什么能力：系统现在做不到什么',
                en: 'The missing capability: what the system cannot do now',
              }),
            },
            evidence: {
              type: 'array',
              items: { type: 'string' },
              description: t({
                zh: '限制这个能力的代码位置（文件:行号），或 README、文档中的段落',
                en: 'Where the code limits this capability (file:line), or passages of README or other documents',
              }),
            },
          },
        },
      },
      proposals: {
        type: 'array',
        description: t({
          zh: '迭代之外的提案：只放第 1 类问题和第 3 类明显缺陷，有进行中的迭代时只放第 1 类；没有就是空列表',
          en: 'Proposals outside any iteration: only problems of lead 1 and obvious bugs of lead 3, and only lead 1 while an iteration is under way; an empty list if there are none',
        }),
        items: {
          type: 'object',
          additionalProperties: false,
          required: [...REQUIREMENT_KEYS, 'lead'],
          properties: {
            ...requirementProperties(),
            lead: {
              enum: [...SCOUT_LEADS],
              description: t({
                zh: '它属于哪一类线索：problem 是第 1 类，让系统停转或空耗的问题；gap 是第 2 类，能力缺口（规划进迭代，不单独提）；defect 是第 3 类，明显的缺陷、测试缺口、文档和代码不一致的地方',
                en: 'The lead it follows: problem is lead 1, something that stops the system or makes it spin without progress; gap is lead 2, a missing capability (planned as an iteration, not proposed on its own); defect is lead 3, an obvious bug, a gap in tests, documents and code that disagree',
              }),
            },
          },
        },
      },
      iteration: {
        description: t({
          zh: '新迭代：仓库没有进行中的迭代时，围绕差距分析里最重要的一个缺口一次规划好；有进行中的迭代，或者没有值得规划的缺口时为 null',
          en: 'A new iteration, planned in one go around the most important gap of your gap analysis while the repo has none under way; null while one is under way, or when no gap is worth one',
        }),
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'goal', 'readmeGoal', 'criteria', 'outOfScope', 'children'],
            properties: {
              title: {
                type: 'string',
                description: t({
                  zh: '一句话标题，说清这个迭代做成什么',
                  en: 'One-line title saying what the iteration achieves',
                }),
              },
              goal: {
                type: 'string',
                description: t({
                  zh: '目标：做完之后，用户能做到以前做不到的什么事，用用户能感知的话写',
                  en: 'Goal: what users can do once it is done that they could not before, in words users would use',
                }),
              },
              readmeGoal: {
                type: 'string',
                description: t({
                  zh: '它推进的 README.md 目标，一字不差地照抄 README.md 的原文',
                  en: 'The goal of README.md it advances, copied word for word as README.md writes it',
                }),
              },
              criteria: {
                type: 'array',
                items: { type: 'string' },
                description: t({
                  zh: '完成标准：怎样算做成了，一条一条写，最好能演示；子项按序号（从 1 起）引用它们',
                  en: 'Completion criteria: how to tell it is done, one per item, ideally something to demonstrate; steps refer to them by number, from 1',
                }),
              },
              outOfScope: {
                type: 'array',
                items: { type: 'string' },
                description: t({
                  zh: '不做：有意留在这个迭代之外的事',
                  en: 'Out of scope: what the iteration leaves out on purpose',
                }),
              },
              children: {
                type: 'array',
                description: t({
                  zh: `计划：按依赖排好的子项，最多 ${MAX_ITERATION_CHILDREN} 个，最后一个是收尾子项；子项按在这里的位置从 1 编号`,
                  en: `The plan: its steps ordered by their dependencies, at most ${MAX_ITERATION_CHILDREN}, the closing step last; steps are numbered by their place here, from 1`,
                }),
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: [...REQUIREMENT_KEYS, 'criteria', 'dependsOn', 'closeout'],
                  properties: {
                    ...requirementProperties(),
                    criteria: criteriaProperty(),
                    dependsOn: {
                      type: 'array',
                      items: { type: 'integer' },
                      description: t({
                        zh: '它依赖的子项的序号，只能是排在它前面的；没有依赖就是空列表',
                        en: 'The numbers of the steps it depends on, only steps before it; an empty list if none',
                      }),
                    },
                    closeout: {
                      type: 'boolean',
                      description: t({
                        zh: '是不是收尾子项：整理本迭代各 Run 评审通过时留下的建议，排在最后，依赖其余全部子项；只有最后一个子项为 true',
                        en: "Whether it is the closing step, which goes through the suggestions reviews left when the iteration's Runs passed: it comes last and depends on every other step; true only for the last step",
                      }),
                    },
                  },
                },
              },
            },
          },
          { type: 'null' },
        ],
      },
      iterationUpdate: {
        description: t({
          zh: '调整进行中的迭代的计划：补上漏掉的子项，或者换个做法替换失败的子项；不用调整，或者没有进行中的迭代时为 null',
          en: 'A change to the plan of the iteration under way: a step the plan missed, or another approach replacing a step that failed; null when nothing needs to change, or no iteration is under way',
        }),
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['note', 'add'],
            properties: {
              note: {
                type: 'string',
                description: t({
                  zh: '为什么这样调整，会记在迭代上',
                  en: 'Why the plan changes; recorded on the iteration',
                }),
              },
              add: {
                type: 'array',
                description: t({
                  zh: '要追加的子项，序号接在计划里现有的最大序号后面',
                  en: "The steps to add, numbered on from the plan's highest number",
                }),
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: [...REQUIREMENT_KEYS, 'criteria', 'dependsOn', 'replaces'],
                  properties: {
                    ...requirementProperties(),
                    criteria: criteriaProperty(),
                    dependsOn: {
                      type: 'array',
                      items: { type: 'integer' },
                      description: t({
                        zh: '它依赖的子项在计划里的序号，只能是排在它前面的，不能是收尾子项；没有依赖就是空列表',
                        en: 'The numbers in the plan of the steps it depends on, only steps before it and not the closing step; an empty list if none',
                      }),
                    },
                    replaces: {
                      description: t({
                        zh: '它替换的失败（或被关成不做）的子项的序号；不是替换就是 null',
                        en: 'The number of the step that failed (or was dropped) it replaces; null if it replaces none',
                      }),
                      anyOf: [{ type: 'integer' }, { type: 'null' }],
                    },
                  },
                },
              },
            },
          },
          { type: 'null' },
        ],
      },
    },
  } as const;
}

/** The fields of every requirement the scout writes, a proposal or a step of an iteration. */
const REQUIREMENT_KEYS = [
  'title',
  'category',
  'size',
  'risk',
  'why',
  'evidence',
  'what',
  'acceptance',
] as const;

/** JSON schema of the fields of every requirement the scout writes (`REQUIREMENT_KEYS`). */
function requirementProperties() {
  return {
    title: {
      type: 'string',
      description: t({
        zh: '一句话标题，说清要做什么',
        en: 'One-line title saying what to do',
      }),
    },
    category: { enum: [...CATEGORIES] },
    size: {
      enum: [...PROPOSAL_SIZES],
      description: sizeDescription(),
    },
    risk: { enum: [...RISKS] },
    why: {
      type: 'string',
      description: t({
        zh: '为什么值得做：现在的问题和做了之后的好处',
        en: 'Why it is worth doing: the problem now and the benefit once done',
      }),
    },
    evidence: {
      type: 'array',
      items: { type: 'string' },
      description: t({
        zh: 'Run id、文件:行号、文档中的段落等可以核对的证据；补能力的可以是 README 的目标加上限制这个能力的代码位置',
        en: 'Verifiable evidence: Run ids, file:line, passages of documents; for adding a capability, a goal of README together with where the code limits the capability',
      }),
    },
    what: {
      type: 'string',
      description: t({
        zh: '要做什么，写到 Agent 能直接动手的程度',
        en: 'What to do, detailed enough for an agent to start right away',
      }),
    },
    acceptance: {
      type: 'array',
      items: { type: 'string' },
      description: t({ zh: '验收标准', en: 'Acceptance criteria' }),
    },
  } as const;
}

/** JSON schema of the completion criteria a step of an iteration moves forward. */
function criteriaProperty() {
  return {
    type: 'array',
    items: { type: 'integer' },
    description: t({
      zh: '它推进迭代的第几条完成标准（序号从 1 起）',
      en: "Which of the iteration's completion criteria it moves forward, by number from 1",
    }),
  } as const;
}

/** The error of a scout whose result breaks the contract, for `detail`. */
function contractError(detail: string): Error {
  return new Error(
    t({
      zh: `侦察结果不符合约定：${detail}`,
      en: `The scout's result does not follow the contract: ${detail}`,
    }),
  );
}

/**
 * The scout's answer, checked against the contract, a planned iteration's rules included
 * (`planProblems`); throws when it breaks them. An iteration or update left out counts as null.
 */
export function parseScoutReport(structured: unknown, finalMessage: string): ScoutReport {
  const parsed = parseReport(ScoutReportSchema, structured, finalMessage);
  if (!parsed.ok) throw contractError(parsed.error);
  const { proposals, gaps, iteration, iterationUpdate } = parsed.value;
  return {
    proposals,
    gaps,
    iteration: iteration ?? null,
    iterationUpdate: iterationUpdate
      ? {
          note: iterationUpdate.note,
          add: iterationUpdate.add.map(({ replaces, ...step }) =>
            replaces == null ? step : { ...step, replaces },
          ),
        }
      : null,
  };
}

/**
 * What is wrong with a change to the plan of the iteration under way (`children`, its plan;
 * `criteria`, how many completion criteria it has), empty when nothing. The steps added are
 * numbered after the plan's last one, in order; each may depend only on steps before it that are
 * not the closing one (which waits for the new steps instead), and name only criteria the
 * iteration has. A step may replace only one of the plan that failed or was dropped and was not
 * replaced yet, never the closing one, and only once. With the steps added and those replaced
 * left out, the plan has at most MAX_ITERATION_CHILDREN steps.
 */
export function updateProblems(
  update: IterationUpdate,
  plan: { criteria: readonly string[]; children: readonly IterationChild[] },
): string[] {
  const problems: string[] = [];
  const byPosition = new Map(plan.children.map((c) => [c.position, c]));
  const last = Math.max(0, ...plan.children.map((c) => c.position));
  const replaced = new Set<number>();
  for (const [i, step] of update.add.entries()) {
    const position = last + i + 1;
    const head = t({
      zh: `追加的第 ${i + 1} 个子项（序号 ${position}）`,
      en: `added step ${i + 1} (number ${position})`,
    });
    const later = step.dependsOn.filter((n) => n >= position);
    if (later.length > 0) {
      problems.push(
        t({
          zh: `${head}只能依赖排在它前面的子项（1 到 ${position - 1}），写了 ${numberList(later)}`,
          en: `${head} may depend only on steps before it (1 to ${position - 1}); it names ${numberList(later)}`,
        }),
      );
    }
    const closing = step.dependsOn.filter((n) => byPosition.get(n)?.closeout);
    if (closing.length > 0) {
      problems.push(
        t({
          zh: `${head}不能依赖收尾子项 ${numberList(closing)}：收尾子项会等新加的子项做完`,
          en: `${head} cannot depend on the closing step ${numberList(closing)}: the closing step waits for the steps added`,
        }),
      );
    }
    const unknown = step.criteria.filter((n) => n > plan.criteria.length);
    if (unknown.length > 0) {
      problems.push(
        t({
          zh: `完成标准只有 ${plan.criteria.length} 条，${head}写了 ${numberList(unknown)}`,
          en: `there ${plan.criteria.length === 1 ? 'is 1 completion criterion' : `are ${plan.criteria.length} completion criteria`}; ${head} names ${numberList(unknown)}`,
        }),
      );
    }
    if (step.replaces === undefined) continue;
    const old = byPosition.get(step.replaces);
    const why = !old
      ? t({ zh: '计划里没有这个序号', en: 'the plan has no such step' })
      : old.closeout
        ? t({ zh: '它是收尾子项', en: 'it is the closing step' })
        : old.replacedBy !== undefined || replaced.has(step.replaces)
          ? t({ zh: '它已经被换掉了', en: 'it was replaced already' })
          : old.status !== 'failed' && old.status !== 'dropped'
            ? t({ zh: '它没有失败，也没有被关成不做', en: 'it neither failed nor was dropped' })
            : null;
    if (why) {
      problems.push(
        t({
          zh: `${head}不能替换第 ${step.replaces} 个子项：${why}`,
          en: `${head} cannot replace step ${step.replaces}: ${why}`,
        }),
      );
    } else {
      replaced.add(step.replaces);
    }
  }
  const kept = plan.children.filter((c) => c.replacedBy === undefined && !replaced.has(c.position));
  const total = kept.length + update.add.length;
  if (total > MAX_ITERATION_CHILDREN) {
    problems.push(
      t({
        zh: `调整后计划里有 ${total} 个子项，最多 ${MAX_ITERATION_CHILDREN} 个`,
        en: `the plan would have ${total} steps; at most ${MAX_ITERATION_CHILDREN} are allowed`,
      }),
    );
  }
  return problems;
}

/** The scout's report as the Master takes it (see keptReport). */
export interface KeptReport {
  report: ScoutReport;
  /**
   * What is wrong with the change to the plan the scout gave, which was dropped for it; empty
   * when the change fits the plan, when there is none, or when there is no plan to change.
   */
  updateProblems: string[];
}

/**
 * The scout's report as the Master takes it, by whether the repo has an iteration under way
 * (`open`: pending, active or blocked, see ITERATION_OPEN_STATUSES). While one is, no other is
 * planned and only problems that stop the system are proposed (lead `problem`), so a new
 * iteration and every other proposal are dropped. A change to its plan that does not fit the plan
 * (`updateProblems`) is dropped too, and why is returned; the rest of the report still holds, so
 * the problems it found are filed all the same (a blocked iteration gets out only through a
 * change, and a scout failing for a bad one would leave it and those problems waiting). Without
 * one, gaps are what the scout plans an iteration for and polish waits for an iteration's closing
 * step, so only problems and obvious defects (leads `problem` and `defect`) are proposed; there
 * is no plan to change, so a change is dropped as a rule, not reported. Either way at most `max`
 * proposals are kept (`max_proposals`), out of those of the leads kept; the steps of an iteration
 * do not count toward it.
 */
export function keptReport(
  report: ScoutReport,
  open: Pick<Iteration, 'criteria' | 'children'> | null,
  max: number,
): KeptReport {
  if (!open) {
    const proposals = report.proposals.filter((p) => p.lead === 'problem' || p.lead === 'defect');
    return {
      report: { ...report, proposals: proposals.slice(0, max), iterationUpdate: null },
      updateProblems: [],
    };
  }
  const problems = report.iterationUpdate ? updateProblems(report.iterationUpdate, open) : [];
  return {
    report: {
      ...report,
      proposals: report.proposals.filter((p) => p.lead === 'problem').slice(0, max),
      iteration: null,
      iterationUpdate: problems.length > 0 ? null : report.iterationUpdate,
    },
    updateProblems: problems,
  };
}

/** `text` on one line, its whitespace collapsed, cut at `max` characters with an ellipsis. */
export const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

/** A Run's status in words, lower case: 「已完成」, "completed". */
export const statusText = (status: Run['status']) =>
  t<Record<Run['status'], string>>({
    zh: {
      queued: '排队中',
      running: '执行中',
      waiting_approval: '等待审批',
      blocked: '卡住',
      paused: '已暂停',
      completed: '已完成',
      failed: '失败',
      cancelled: '已终止',
      dropped: '不做',
    },
    en: {
      queued: 'queued',
      running: 'running',
      waiting_approval: 'waiting for approval',
      blocked: 'stuck',
      paused: 'paused',
      completed: 'completed',
      failed: 'failed',
      cancelled: 'cancelled',
      dropped: 'dropped',
    },
  })[status];

const failText = (reason: NonNullable<StageRun['failReason']>) =>
  t({
    zh: { check: '检查未通过', review: '评审未通过', rejected: '审批被驳回', conflict: '合并冲突' },
    en: {
      check: 'checks failed',
      review: 'review failed',
      rejected: 'approval rejected',
      conflict: 'merge conflict',
    },
  })[reason];

const resultText = (kind: ResultProblemKind) =>
  t<Record<ResultProblemKind, string>>({
    zh: {
      format: '未按格式给出结果',
      incomplete: 'Agent 自称未完成',
      denied: '有操作被拒绝',
    },
    en: {
      format: 'result not in the required format',
      incomplete: 'agent reported it was not done',
      denied: 'operations were denied',
    },
  })[kind];

/** 「：」, between a heading and what follows it on the same line. */
const colon = () => t({ zh: '：', en: ': ' });

/** 「…另有 3 条」, the count of items left out of a list. */
const moreText = (n: number) => t({ zh: `…另有 ${n} 条`, en: `…and ${n} more` });

/** Must-fix issues listed per failed review round; more are only counted. */
const MAX_MUST_ISSUES = 5;

/** Suggestions listed per passed review round; more are only counted. */
const MAX_SUGGESTIONS = 3;

/**
 * Characters kept of each review issue listed (must-fix or suggestion), its file included. This
 * line is the only text of the review the scout sees, and reviewers usually describe what they saw
 * first and how to fix it last, so a short cut drops exactly the fix. With at most
 * MAX_MUST_ISSUES and MAX_SUGGESTIONS listed per round, the prompt stays bounded.
 */
const REVIEW_ISSUE_CHARS = 400;

/** Denied operations listed per stage round (or step of it); more are only counted. */
const MAX_DENIED = 3;

/** Characters kept of a plan step's title on its lines. */
const STEP_TITLE_CHARS = 60;

/** Questions listed per assessment round; more are only counted. */
const MAX_QUESTIONS = 3;

/** Which kind of bad result a failed "result" check was, worked out again from the attempt. */
function resultKind(attempt: Attempt): ResultProblemKind {
  const report = parseReport(TaskReportSchema, attempt.structured, attempt.finalMessage ?? '');
  // An acceptable report in a failed check leaves denied operations as the only cause; they are
  // listed in the check's detail (see deniedOperations), not needed to tell the kind.
  return resultProblem(report, [])?.kind ?? 'denied';
}

/** The operations denied in an execution redone because of them, from its failed result check. */
function deniedIn(attempt: Attempt, failedChecks: CheckResult[]): string[] {
  const check = failedChecks.find((c) => c.kind === 'result');
  if (!check || resultKind(attempt) !== 'denied') return [];
  return deniedOperations(check.detail);
}

/** Why one execution did not pass, from its failed checks. */
function reworkReasons(attempt: Attempt, failedChecks: CheckResult[]): string[] {
  if (attempt.outcome === 'agent_error') return [t({ zh: 'Agent 出错', en: 'agent error' })];
  if (attempt.outcome === 'rate_limited') {
    return [t({ zh: '额度用尽或被限流', en: 'out of quota or rate-limited' })];
  }
  const reasons = failedChecks.map((c) =>
    c.kind === 'command'
      ? t({ zh: `\`${c.name}\` 未通过`, en: `\`${c.name}\` failed` })
      : resultText(resultKind(attempt)),
  );
  // The only rework without a recorded check is a review in the wrong format.
  return reasons.length > 0 ? [...new Set(reasons)] : [resultText('format')];
}

/**
 * Executions within one stage round, or one step of it, when some of them had to be redone:
 * rework inside a stage (failed verify commands, bad output, agent errors, quota or rate limits)
 * never shows up in the stage rounds. The operations denied in them follow, one per line, so the
 * scout can tell what was refused. `indent` is the indent of the line.
 */
function reworkLines(
  head: string,
  attempts: Attempt[],
  failedChecks: Map<string, CheckResult[]>,
  indent = '  ',
): string[] {
  const counts = new Map<string, number>();
  const denied = new Set<string>();
  for (const a of attempts) {
    if (a.outcome !== 'rework' && a.outcome !== 'agent_error' && a.outcome !== 'rate_limited') {
      continue;
    }
    const checks = failedChecks.get(a.id) ?? [];
    for (const reason of reworkReasons(a, checks)) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    for (const operation of deniedIn(a, checks)) denied.add(oneLine(operation, 120));
  }
  if (counts.size === 0) return [];
  const reasons = join([...counts].map(([reason, n]) => `${reason} ×${n}`));
  const n = attempts.length;
  const line = t({
    zh: `${head}：执行 ${n} 次，返工原因：${reasons}`,
    en: `${head}: ${n} execution${n === 1 ? '' : 's'}, reworked because of: ${reasons}`,
  });
  const lines = [`${indent}${oneLine(line, 200)}`];
  const operations = [...denied];
  for (const operation of operations.slice(0, MAX_DENIED)) {
    lines.push(`${indent}  - ${t({ zh: '被拒绝：', en: 'Denied: ' })}${operation}`);
  }
  if (operations.length > MAX_DENIED) {
    lines.push(`${indent}  ${moreText(operations.length - MAX_DENIED)}`);
  }
  return lines;
}

/** 「编码第 2 轮」, a stage round as the digest names it. */
const roundName = (stageName: string, round: number) =>
  t({ zh: `${stageName}第 ${round} 轮`, en: `${stageName} round ${round}` });

/**
 * Why a step of a plan has not passed, or null when it passed or may still pass: it failed, or
 * the Run ended (terminated, or failed elsewhere) before the step was reached or done. Ending a
 * Run cancels its unfinished tasks, so a step's status alone does not tell the two apart; whether
 * it was executed does.
 */
function stepStatusText(task: Task, executions: number, runEnded: boolean): string | null {
  if (task.status === 'passed') return null;
  if (task.status === 'failed') return t({ zh: '失败', en: 'failed' });
  if (!runEnded) return null;
  return executions === 0
    ? t({ zh: 'Run 结束时还没执行到', en: 'not reached before the Run ended' })
    : t({ zh: 'Run 结束时还没做完', en: 'not done when the Run ended' });
}

/**
 * Rework within a stage round. A round its plan split into steps (`planSteps`) says how many,
 * then gives each step's own rework and each step that did not pass a line of its own, so the
 * scout sees how the split worked out and where it got stuck; rework of the plan itself counts
 * toward no step. Any other round counts all its executions together. `showTitles` says whether
 * the steps' titles may be shown: the plan wrote them from the goal.
 */
function roundReworkLines(
  run: Run,
  sr: StageRun,
  stageName: string,
  tasks: { task: Task; attempts: Attempt[] }[],
  failedChecks: Map<string, CheckResult[]>,
  showTitles: boolean,
): string[] {
  const round = roundName(stageName, sr.round);
  const steps = planSteps(tasks.map(({ task }) => task));
  if (steps.size === 0) {
    const attempts = tasks.flatMap((x) => x.attempts);
    return reworkLines(round, attempts, failedChecks);
  }
  const total = steps.size;
  const lines = [
    `  ${t({ zh: `${round}：拆成 ${total} 步`, en: `${round}: split into ${total} steps` })}`,
  ];
  for (const { task, attempts } of tasks) {
    const step = steps.get(task.id);
    if (!step) {
      const head = t({ zh: `${round}的拆分`, en: `${round} planning` });
      lines.push(...reworkLines(head, attempts, failedChecks, '    '));
      continue;
    }
    const name = showTitles ? oneLine(task.title, STEP_TITLE_CHARS) : '';
    const head = t({
      zh: `第 ${step.index}/${total} 步${name ? `「${name}」` : ''}`,
      en: `Step ${step.index}/${total}${name ? ` "${name}"` : ''}`,
    });
    lines.push(...reworkLines(head, attempts, failedChecks, '    '));
    const status = stepStatusText(task, attempts.length, run.finishedAt !== null);
    if (status) lines.push(`    ${head}${colon()}${status}`);
  }
  return lines;
}

/**
 * The review given in a stage round, as the last reviewer that finished gave it; null if none
 * finished or its report cannot be read.
 */
function reviewOf(attempts: Attempt[]): ReviewReport | null {
  const attempt = attempts.findLast((a) => a.outcome === 'passed');
  if (!attempt) return null;
  const parsed = parseReport(ReviewReportSchema, attempt.structured, attempt.finalMessage ?? '');
  return parsed.ok ? parsed.value : null;
}

/** 「    - [src/a.ts] 没有处理空输入」, a review issue on its own line under its round. */
function issueLine(issue: ReviewReport['issues'][number]): string {
  const where = issue.file ? `[${issue.file}] ` : '';
  return `    - ${oneLine(`${where}${issue.description}`, REVIEW_ISSUE_CHARS)}`;
}

/**
 * 「并行时合并冲突（同一仓库里同时在执行或先合并了的有 run-b）」, a merge conflict while other
 * Runs of the execution slot worked side by side with the Run (`parallelRuns`).
 */
const parallelConflictText = (runIds: string[]) =>
  t({
    zh: `并行时合并冲突（同一仓库里同时在执行或先合并了的有 ${join(runIds)}）`,
    en: `merge conflict while working side by side (${join(runIds)} of the same repo executed or merged meanwhile)`,
  });

/**
 * Why a stage round failed. A failed review lists each must-fix issue on its own line, so a long
 * review summary cannot crowd them out; suggestions are only counted. A merge conflict says which
 * Runs worked side by side with this one meanwhile (`parallel`), if any.
 */
function failLines(
  sr: StageRun,
  stageName: string,
  attempts: Attempt[],
  parallel: string[],
): string[] {
  if (!sr.failReason) return [];
  const head = `  ${roundName(stageName, sr.round)}`;
  const review = sr.failReason === 'review' ? reviewOf(attempts) : null;
  if (review) {
    const must = review.issues.filter((i) => i.severity === 'must');
    const suggestions = review.issues.length - must.length;
    const summary = oneLine(review.summary, 100);
    const lines = [
      t({
        zh: `${head}未通过：必须修改 ${must.length} 条${suggestions > 0 ? `（另有建议 ${suggestions} 条）` : ''}${summary ? `；总结：${summary}` : ''}`,
        en: `${head} failed: ${must.length} must-fix${suggestions > 0 ? ` (and ${suggestions} suggestion${suggestions === 1 ? '' : 's'})` : ''}${summary ? `; summary: ${summary}` : ''}`,
      }),
    ];
    for (const issue of must.slice(0, MAX_MUST_ISSUES)) lines.push(issueLine(issue));
    if (must.length > MAX_MUST_ISSUES) lines.push(`    ${moreText(must.length - MAX_MUST_ISSUES)}`);
    return lines;
  }
  const besideOthers = sr.failReason === 'conflict' && parallel.length > 0;
  const reason = besideOthers ? parallelConflictText(parallel) : failText(sr.failReason);
  if (!sr.failFeedback) {
    // Without feedback only a merge conflict beside other Runs is worth a line.
    return besideOthers ? [t({ zh: `${head}${reason}`, en: `${head}: ${reason}` })] : [];
  }
  const feedback = oneLine(sr.failFeedback, 300);
  return [
    t({
      zh: `${head}${reason}：${feedback}`,
      en: `${head}: ${reason}: ${feedback}`,
    }),
  ];
}

/** The suggestions a review left, as opposed to what it said must be fixed. */
const suggestionsOf = (review: ReviewReport | null) =>
  review?.issues.filter((i) => i.severity === 'suggestion') ?? [];

/** A review round of a Run that passed, as its last reviewer that finished gave it. */
export interface PassedReview {
  /** The review stage, by its id. */
  stageId: string;
  stageName: string;
  round: number;
  /** The reviewer's summary: its conclusion. */
  summary: string;
  /** What it left as suggestions: improvements beyond the goal and polish, left for later. */
  suggestions: ReviewReport['issues'];
}

/**
 * The review rounds of the Run that passed, in the order they ran; those whose report cannot be
 * read are left out. A round still executing or waiting for approval has not passed, even when
 * its reviewer already reported: it may yet fail, or the Run may end there.
 */
export function passedReviews(store: Store, run: Run): PassedReview[] {
  const reviews: PassedReview[] = [];
  for (const sr of store.listStageRuns(run.id)) {
    const stage = run.template.stages.find((s) => s.id === sr.stageId);
    if (stage?.kind !== 'review' || sr.status !== 'passed') continue;
    const attempts = store.listTasks(sr.id).flatMap((task) => store.listAttempts(task.id));
    const review = reviewOf(attempts);
    if (!review) continue;
    reviews.push({
      stageId: sr.stageId,
      stageName: stage.name ?? sr.stageId,
      round: sr.round,
      summary: review.summary,
      suggestions: suggestionsOf(review),
    });
  }
  return reviews;
}

/**
 * The suggestions of a review round that passed. Reviewers leave improvements beyond the goal and
 * polish of edge cases as suggestions on purpose, for later; they reach no issue, so unless the
 * scout sees them here nobody picks them up again. A round still executing or waiting for approval
 * has not passed, even when its reviewer already reported: it may yet fail, or the Run may end
 * there.
 */
function suggestionLines(sr: StageRun, stageName: string, attempts: Attempt[]): string[] {
  if (sr.status !== 'passed') return [];
  const suggestions = suggestionsOf(reviewOf(attempts));
  const n = suggestions.length;
  if (n === 0) return [];
  const head = `  ${roundName(stageName, sr.round)}`;
  const lines = [
    t({
      zh: `${head}通过，建议 ${n} 条：`,
      en: `${head} passed, ${n} suggestion${n === 1 ? '' : 's'}:`,
    }),
  ];
  for (const issue of suggestions.slice(0, MAX_SUGGESTIONS)) lines.push(issueLine(issue));
  if (n > MAX_SUGGESTIONS) lines.push(`    ${moreText(n - MAX_SUGGESTIONS)}`);
  return lines;
}

/** Where the requirement assessment stands, as it follows 「结论：」. */
function conclusionText(run: Run): string {
  const conclusion = conclusionOf(run.discussion);
  if (conclusion) {
    const label = conclusionLabel(conclusion);
    // The goal at the head of the Run's digest stays the original requirement.
    return conclusion.revisedGoal
      ? t({
          zh: `${label}（需求在讨论后改过，上面的目标是原需求）`,
          en: `${label} (the requirement was revised in the discussion; the goal above is the original one)`,
        })
      : label;
  }
  if (run.finishedAt) {
    return t({ zh: '没有（Run 在讨论中结束）', en: 'none (the Run ended during the discussion)' });
  }
  const last = run.discussion.at(-1);
  if (last?.role === 'human') {
    return t({
      zh: '还没有（人已回复，重新评估中）',
      en: 'not yet (a human replied; assessing again)',
    });
  }
  if (last?.role === 'timeout') {
    return t({
      zh: '还没有（没人回复，评估自己决定中）',
      en: 'not yet (nobody replied; the assessment is deciding on its own)',
    });
  }
  return assessmentRounds(run.discussion).at(-1)?.proposedDrop
    ? t({
        zh: '评估认为不该做，等人确认',
        en: 'the assessment thinks it should not be done; waiting for a human to confirm',
      })
    : t({ zh: '等人回复', en: 'waiting for a human reply' });
}

/**
 * The requirement assessment's discussion. Questions to a human say the requirement was unclear
 * or off course, yet neither rework nor failed rounds show them: an asking assessment passes its
 * execution and runs again in the same stage round once a human replied.
 */
function discussionLines(run: Run): string[] {
  if (run.discussion.length === 0) return [];
  const rounds = assessmentRounds(run.discussion);
  const replies = humanReplies(run.discussion).length;
  const timeouts = run.discussion.filter((e) => e.role === 'timeout').length;
  const n = rounds.length;
  const unanswered =
    timeouts > 0
      ? t({
          zh: `，没人回复 ${timeouts} 次`,
          en: `, ${timeouts} time${timeouts === 1 ? '' : 's'} nobody replied`,
        })
      : '';
  const lines = [
    t({
      zh: `  需求评估：评估 ${n} 轮，人回复 ${replies} 次${unanswered}；结论：${conclusionText(run)}`,
      en: `  Requirement assessment: ${n} round${n === 1 ? '' : 's'}, ${replies} human repl${replies === 1 ? 'y' : 'ies'}${unanswered}; conclusion: ${conclusionText(run)}`,
    }),
  ];
  for (const [i, round] of rounds.entries()) {
    if (round.verdict !== 'ask') continue;
    const summary = oneLine(round.summary, 150);
    lines.push(
      round.proposedDrop
        ? t({
            zh: `    第 ${i + 1} 轮认为不该做：${summary}`,
            en: `    Round ${i + 1} thinks it should not be done: ${summary}`,
          })
        : t({ zh: `    第 ${i + 1} 轮疑问：`, en: `    Round ${i + 1} questions:` }),
    );
    for (const question of round.questions.slice(0, MAX_QUESTIONS)) {
      lines.push(`      - ${oneLine(question, 150)}`);
    }
    if (round.questions.length > MAX_QUESTIONS) {
      lines.push(`      ${moreText(round.questions.length - MAX_QUESTIONS)}`);
    }
  }
  const conclusion = conclusionOf(run.discussion);
  if (conclusion?.verdict === 'drop') {
    lines.push(
      `    ${t({ zh: '不做的理由：', en: 'Reason for dropping it: ' })}${oneLine(conclusion.summary, 300)}`,
    );
  }
  return lines;
}

/**
 * How long a finished Run took, split so that queueing and waiting for a human are not taken for
 * slow agents: 「，用时 957 分钟（Agent 执行 40 分钟，排队 20 分钟，等审批 890 分钟）」; empty
 * while the Run has not finished.
 */
function tookText(times: RunTimes): string {
  if (times.totalMs === null) return '';
  const parts = timeParts(runTimeParts(times));
  const total = minutes(times.totalMs);
  return t({
    zh: `，用时 ${total} 分钟${parts.length > 0 ? `（${parts.join('，')}）` : ''}`,
    en: `, took ${total} min${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`,
  });
}

/**
 * Whether the Run's goal may go into a prompt: anything but the goal of an issue written by
 * someone the Master does not trust, before a human confirmed it.
 */
export function trustedGoal(run: Run): boolean {
  const untrusted = run.issue?.untrusted;
  return !untrusted || untrusted.confirmedAt !== null;
}

/**
 * Events the Master records on a Run it terminated on its own, by type, with the reason each
 * gives. A Master-initiated termination of a new kind adds its event here.
 */
const TERMINATION_REASONS: Record<string, (data: EventRow['data']) => string> = {
  'run.issue_closed': ({ stateReason }) => {
    if (stateReason === 'completed') {
      return t({ zh: 'issue 被人关闭（已完成）', en: 'the issue was closed as completed' });
    }
    if (stateReason === 'not_planned') {
      return t({ zh: 'issue 被人关闭为不做', en: 'the issue was closed as not planned' });
    }
    return t({ zh: 'issue 被人关闭', en: 'the issue was closed' });
  },
  'run.iteration_closed': ({ iteration }) =>
    typeof iteration === 'number'
      ? t({
          zh: `所属迭代 #${iteration} 被人关掉，issue 随之关成不做`,
          en: `its iteration #${iteration} was closed, and the issue closed as not planned with it`,
        })
      : t({
          zh: '所属迭代被人关掉，issue 随之关成不做',
          en: 'its iteration was closed, and the issue closed as not planned with it',
        }),
  'run.iteration_cancelled': () =>
    t({
      zh: '所属迭代被人在看板上终止，没做完的子项随之不做',
      en: 'its iteration was cancelled on the dashboard, and its steps not done dropped with it',
    }),
  'run.goal_changed': ({ newRun }) =>
    typeof newRun === 'string'
      ? t({
          zh: `issue 的标题或正文被人改了，已按新内容重开为 ${newRun}`,
          en: `the issue's title or body was edited, so it was started over from the new text as ${newRun}`,
        })
      : t({
          zh: 'issue 的标题或正文被人改了，已按新内容重开',
          en: `the issue's title or body was edited, so it was started over from the new text`,
        }),
};

/**
 * Why a cancelled Run was terminated: the reason of the last event the Master recorded when it
 * terminated the Run on its own, otherwise a human terminated it on the dashboard.
 */
function terminationReason(events: EventRow[]): string {
  const event = events.findLast((e) => Object.hasOwn(TERMINATION_REASONS, e.type));
  const reason = event && TERMINATION_REASONS[event.type];
  return reason
    ? reason(event.data)
    : t({ zh: '人在看板上终止', en: 'by a human on the dashboard' });
}

/** A stretch of time, in epoch milliseconds. */
interface Span {
  start: number;
  end: number;
}

const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

/**
 * How many of the Runs, given by their executions, executed at the same time as another of them
 * at least once.
 */
function overlappingRuns(executions: readonly Span[][]): number {
  return executions.filter((own, i) =>
    executions.some((other, j) => j !== i && own.some((a) => other.some((b) => overlaps(a, b)))),
  ).length;
}

/** The digest's first line: the limit on Runs side by side, and how many of them were. */
function parallelHead(perRepo: number, runs: number, overlapping: number): string {
  return t({
    zh: `concurrency.per_repo（同一仓库最多同时执行几个 Run）：${perRepo}；下面 ${runs} 个 Run 里，执行时间和别的 Run 有重叠的 ${overlapping} 个`,
    en: `concurrency.per_repo (how many Runs of a repo may execute at a time): ${perRepo}; ${overlapping} of the ${runs} Run${runs === 1 ? '' : 's'} below executed at the same time as another`,
  });
}

/** Overlapping paths listed on a Run's line of waits; more are only counted. */
const MAX_CONFLICT_PATHS = 3;

/**
 * 「为避开冲突等了 2 次，共 35 分钟（等 run-a，重叠路径 src/a、docs）」: the Run's waits for Runs it
 * overlaps (`waits`, from `conflictWaitSpans`), how long they took (`conflictWaitMs` of its times;
 * a wait still going on counts once it is over), the Runs waited for and the overlapping paths.
 * Empty without waits. `showPaths` says whether the paths may be shown: the assessment wrote them
 * from the goal.
 */
function conflictWaitLines(
  run: Run,
  waits: readonly ConflictWaitSpan[],
  waitedMs: number,
  showPaths: boolean,
): string[] {
  const n = waits.length;
  if (n === 0) return [];
  const runIds = join([...new Set(waits.map((w) => w.runId))]);
  const paths = showPaths ? [...new Set(waits.flatMap((w) => w.paths))] : [];
  const shown = paths.slice(0, MAX_CONFLICT_PATHS).map((p) => oneLine(p, 120));
  const more = paths.length > MAX_CONFLICT_PATHS ? moreText(paths.length - MAX_CONFLICT_PATHS) : '';
  const mins = minutes(waitedMs);
  const still = run.status === 'queued' && waits.at(-1)?.to === null;
  const counted = waitedMs >= SHOWN_PART_MS;
  return [
    t({
      zh: `  为避开冲突等了 ${n} 次${counted ? `，共 ${mins} 分钟` : ''}${still ? '，现在还在等' : ''}（等 ${runIds}${shown.length > 0 ? `，重叠路径 ${join(shown)}${more}` : ''}）`,
      en: `  Waited for an overlapping Run ${n} time${n === 1 ? '' : 's'}${counted ? `, ${mins} min in all` : ''}${still ? ', still waiting' : ''} (for ${runIds}${shown.length > 0 ? `; overlapping paths ${join(shown)}${more}` : ''})`,
    }),
  ];
}

/**
 * What the digest reads of the Runs of the repo's execution slot (`executionSlot`: the repo and
 * any other registered on the same path), each read once: their executions, and when their merges
 * passed.
 */
class SlotHistory {
  private runs: Run[] | undefined;
  private readonly executions = new Map<string, Span[]>();
  private readonly now = Date.now();

  constructor(
    private readonly store: Store,
    private readonly repoId: string,
  ) {}

  /** The Run's executions, each from start to end; one still going lasts until now. */
  executionsOf(runId: string): Span[] {
    let spans = this.executions.get(runId);
    if (!spans) {
      spans = this.store.listRunAttempts(runId).map((a) => ({
        start: Date.parse(a.startedAt),
        end: a.endedAt ? Date.parse(a.endedAt) : this.now,
      }));
      this.executions.set(runId, spans);
    }
    return spans;
  }

  /** When the Run's merge stage rounds passed, in epoch milliseconds. */
  mergesOf(run: Run): number[] {
    const merge = new Set(run.template.stages.filter((s) => s.kind === 'merge').map((s) => s.id));
    return this.store
      .listStageRuns(run.id)
      .filter((sr) => merge.has(sr.stageId) && sr.status === 'passed' && sr.endedAt)
      .map((sr) => Date.parse(sr.endedAt as string));
  }

  /** Every Run of the execution slot, across the repos registered on its path. */
  slotRuns(): Run[] {
    if (!this.runs) {
      const slot = executionSlot(this.store.getRepo(this.repoId).path);
      this.runs = this.store
        .listRepos()
        .filter((r) => r.id === this.repoId || executionSlot(r.path) === slot)
        .flatMap((r) => this.store.listRuns({ repoId: r.id }));
    }
    return this.runs;
  }

  /**
   * The other Runs of the slot that worked side by side with `run` between the start of its work
   * past the assessment (its first round of another stage; its creation without one) and the
   * merge conflict that failed the round `sr`: one executing within that time, or whose merge
   * passed within it, may have changed what the Run then conflicted with. Their ids, oldest
   * first.
   */
  parallelRuns(run: Run, stageRuns: readonly StageRun[], sr: StageRun): string[] {
    const kind = (stageId: string) => run.template.stages.find((s) => s.id === stageId)?.kind;
    const begun = stageRuns.find((r) => kind(r.stageId) !== 'assess')?.startedAt ?? run.createdAt;
    const window = { start: Date.parse(begun), end: Date.parse(sr.endedAt ?? sr.startedAt) };
    return this.slotRuns()
      .filter((other) => {
        if (other.id === run.id || Date.parse(other.createdAt) > window.end) return false;
        if (other.finishedAt && Date.parse(other.finishedAt) < window.start) return false;
        return (
          this.executionsOf(other.id).some((e) => overlaps(e, window)) ||
          this.mergesOf(other).some((at) => at >= window.start && at <= window.end)
        );
      })
      .map((other) => other.id)
      .reverse();
  }
}

/**
 * Recent Runs of the repo, with what went wrong in them: the scout's best evidence. It opens with
 * the repo's `concurrency.per_repo` at the time (`perRepo`) and how many of the Runs executed side
 * by side with another, so that the scout can weigh what working side by side costs in waits,
 * merge conflicts and rework against the time Runs spend queued.
 */
export function runDigest(store: Store, repoId: string, perRepo: number, limit = 15): string {
  const runs = store.listRuns({ repoId }).slice(0, limit);
  if (runs.length === 0) return t({ zh: '（还没有 Run）', en: '(no Runs yet)' });
  // Every finished Run's times need the whole record of the work switch: read it once, at the
  // first finished Run, rather than once per Run.
  let switches: WorkSwitch[] | undefined;
  const workSwitches = () => {
    switches ??= workSwitchesOf(store);
    return switches;
  };
  const slot = new SlotHistory(store, repoId);
  const overlapping = overlappingRuns(runs.map((run) => slot.executionsOf(run.id)));
  const head = parallelHead(perRepo, runs.length, overlapping);
  const digests = runs
    .map((run) => {
      const stageRuns = store.listStageRuns(run.id);
      const events = store.listEvents(run.id);
      const conflictWaits = conflictWaitSpans(events);
      const failedChecks = new Map<string, CheckResult[]>();
      for (const c of store.listChecks(run.id)) {
        if (c.passed || !c.attemptId) continue;
        failedChecks.set(c.attemptId, [...(failedChecks.get(c.attemptId) ?? []), c]);
      }
      const stage = (stageId: string) => run.template.stages.find((s) => s.id === stageId);
      const name = (stageId: string) => stage(stageId)?.name ?? stageId;
      const trusted = trustedGoal(run);
      const rounds = new Map<string, number>();
      for (const sr of stageRuns) rounds.set(sr.stageId, (rounds.get(sr.stageId) ?? 0) + 1);
      // A Run that waited for one it overlaps says how long, finished or not.
      const times =
        run.finishedAt || conflictWaits.length > 0
          ? storedRunTimes(store, run, workSwitches())
          : null;
      const took = times ? tookText(times) : '';
      const status = statusText(run.status);
      const date = run.createdAt.slice(0, 10);
      const goal = trusted
        ? oneLine(run.goal.split('\n')[0] ?? '', 100)
        : t({
            zh: `#${run.issue?.number}（issue 的作者不是仓库成员，也没有人确认过，内容不列出）`,
            en: `#${run.issue?.number} (written by someone who is not a member of the repo and confirmed by nobody, so not shown)`,
          });
      const roundList =
        [...rounds].map(([id, n]) => `${name(id)}×${n}`).join(' ') || t({ zh: '无', en: 'none' });
      const cost = `$${run.costUsd.toFixed(2)}`;
      // An automatic redo of the same issue after earlier Runs failed.
      const attempt = run.issue?.attempt ?? 1;
      const redo =
        attempt > 1 ? t({ zh: `，第 ${attempt} 次尝试`, en: `, attempt ${attempt}` }) : '';
      const lines = [
        t({
          zh: `- ${run.id}（${status}，${date}${redo}）${goal}`,
          en: `- ${run.id} (${status}, ${date}${redo}) ${goal}`,
        }),
        t({
          zh: `  轮次：${roundList}；费用 ${cost}${took}`,
          en: `  Rounds: ${roundList}; cost ${cost}${took}`,
        }),
      ];
      // Blocked on the discussion: its lines below say so and list the questions the block
      // message repeats. Waiting for a human to confirm an untrusted goal: the goal says so.
      if (
        run.blocked &&
        run.blocked.kind !== 'discussion' &&
        run.blocked.kind !== 'untrusted_issue'
      ) {
        lines.push(
          `  ${t({ zh: '卡住', en: 'Stuck' })}${colon()}${oneLine(run.blocked.message, 300)}`,
        );
      }
      if (run.error) {
        lines.push(`  ${t({ zh: '错误', en: 'Error' })}${colon()}${oneLine(run.error, 300)}`);
      }
      // Terminated is a strong lead: a human changed course, turned the requirement down, or it
      // was done some other way.
      if (run.status === 'cancelled') {
        const reason = terminationReason(events);
        lines.push(`  ${t({ zh: '终止', en: 'Terminated' })}${colon()}${reason}`);
      }
      lines.push(...discussionLines(run));
      lines.push(...conflictWaitLines(run, conflictWaits, times?.conflictWaitMs ?? 0, trusted));
      for (const sr of stageRuns) {
        const tasks = store
          .listTasks(sr.id)
          .map((task) => ({ task, attempts: store.listAttempts(task.id) }));
        const attempts = tasks.flatMap((x) => x.attempts);
        const parallel = sr.failReason === 'conflict' ? slot.parallelRuns(run, stageRuns, sr) : [];
        lines.push(...roundReworkLines(run, sr, name(sr.stageId), tasks, failedChecks, trusted));
        lines.push(...failLines(sr, name(sr.stageId), attempts, parallel));
        // Reviewers read the goal: from an untrusted one, their suggestions may carry its text.
        if (trusted && stage(sr.stageId)?.kind === 'review') {
          lines.push(...suggestionLines(sr, name(sr.stageId), attempts));
        }
      }
      return lines.join('\n');
    })
    .join('\n');
  return `${head}\n${digests}`;
}

/**
 * Existing issues, so the scout does not propose them again; rejections are counterexamples.
 * Anybody can open an issue or comment on a public repo, so only issues and comments written by
 * people the Master trusts (`isTrusted`, the Master itself included) are listed; `master` is the
 * login the Master acts as.
 *
 * `closed` are the latest closed issues; `notPlanned` are issues closed as not planned, however
 * old. Those not among `closed` get a section of their own, so that old rejections and their
 * reasons stay in sight without crowding the recent ones. `notPlanned` is null when they could
 * not be fetched: the scout is told that only the recent rejections are in sight.
 *
 * Open and done issues carry their next steps (see nextSteps), so that the scout proposes the
 * next step of a large capability once the one before it is done.
 */
export function issueDigest(
  open: HostIssue[],
  closed: HostIssue[],
  master: string | null,
  notPlanned: HostIssue[] | null = [],
): string {
  const recent = new Set(closed.map((i) => i.number));
  const older = (notPlanned ?? []).filter((i) => !recent.has(i.number));
  const trusted = <T extends HostAuthored>(items: T[]) => items.filter((i) => isTrusted(i, master));
  const labels = (i: HostIssue) => {
    const ours = i.labels.filter((l) => l.startsWith('ares1:'));
    return ours.length ? ` [${ours.join(', ')}]` : '';
  };
  const openLines = trusted(open).map(
    (i) => `- #${i.number}${labels(i)} ${i.title}${nextStepsLines(i.body)}`,
  );
  const closedLines = trusted(closed).map((i) => closedIssueLine(i, master));
  const olderLines = trusted(older).map((i) => closedIssueLine(i, master));
  const none = t({ zh: '（无）', en: '(none)' });
  const sections = [
    t({ zh: '### 未关闭', en: '### Open' }),
    openLines.join('\n') || none,
    '',
    t({ zh: '### 最近关闭', en: '### Recently closed' }),
    closedLines.join('\n') || none,
  ];
  if (!notPlanned) {
    sections.push(
      '',
      t({
        zh: '（更早被关闭为不做的 issue 这次没能取到，上面只列出了最近关闭的。更早被拒绝过的需求不在这里：提出的需求如果可能早就被拒绝过，要多加小心。）',
        en: '(Older issues closed as not planned could not be fetched this time; only the recently closed ones are listed above. Requirements turned down earlier are not here, so be careful with any proposal that may have been rejected before.)',
      }),
    );
  }
  // Nothing older (a young repo): no section saying so.
  if (olderLines.length) {
    sections.push(
      '',
      t({ zh: '### 更早被关闭为不做的', en: '### Older issues closed as not planned' }),
      olderLines.join('\n'),
    );
  }
  return sections.join('\n');
}

/**
 * A closed issue in the scout's list: done, rejected by a human with the reason, or closed by
 * the Master after every attempt failed. Only comments by people the Master trusts count.
 */
function closedIssueLine(i: HostIssue, master: string | null): string {
  const comments = i.comments.filter((c) => isTrusted(c, master)).map((c) => c.body);
  // Closed by the Master after every attempt failed: not a human's rejection.
  const exhausted = comments.findLast(isRetriesExhaustedComment);
  if (i.stateReason === 'not_planned' && exhausted && exhausted === comments.at(-1)) {
    const head = t({
      zh: '多次失败后关闭（不是人拒绝的）',
      en: 'Closed after repeated failures (not rejected by a human)',
    });
    const reasons = `${t({ zh: '失败原因', en: 'Failures' })}${colon()}${oneLine(stripMarker(exhausted), 800)}`;
    return `- #${i.number} ${head}${colon()}${i.title}\n  ${reasons}`;
  }
  if (i.stateReason === 'not_planned') {
    const last = comments.at(-1);
    const reason = last && stripMarker(last);
    const why = reason
      ? `\n  ${t({ zh: '理由', en: 'Reason' })}${colon()}${oneLine(reason, 300)}`
      : '';
    return `- #${i.number} ${t({ zh: '不做', en: 'Not planned' })}${colon()}${i.title}${why}`;
  }
  return `- #${i.number} ${t({ zh: '已完成', en: 'Done' })}${colon()}${i.title}${nextStepsLines(i.body)}`;
}

/** Characters kept of the next steps an issue lists, in the scout's list of issues. */
const NEXT_STEPS_CHARS = 600;

/**
 * The line that opens the next steps: a heading, a line of its own (bold or not, a colon after it
 * or not), or the name, a colon and the first step on the same line. Both names count whatever
 * the language in use: the issue may have been written in either.
 */
const NEXT_STEPS_HEAD =
  /^(?:#{1,6}[ \t]+)?(?:\*\*|__)?(?:后续步骤|next steps)(?:\*\*|__)?[ \t]*(?:[:：](?:\*\*|__)?[ \t]*(.*))?$/i;

/** The level of a Markdown heading; 0 for any other line. */
const headingLevel = (line: string) => /^ {0,3}(#{1,6})(?:[ \t]|$)/.exec(line)?.[1]?.length ?? 0;

/**
 * The 「后续步骤」/"Next steps" of an issue's body, one string per line: the steps a scout left
 * for later when it proposed only the first step of a large capability (a human may write them
 * too). They run from the line that opens them (see NEXT_STEPS_HEAD) to the next heading (of the
 * same level or higher when that line is a heading itself) or the end of the body, the proposal's
 * footer left out; at most NEXT_STEPS_CHARS characters. Empty when there are none.
 */
export function nextSteps(body: string): string[] {
  const cut = body.indexOf(FOOTER_MARKER);
  const lines = (cut >= 0 ? body.slice(0, cut) : body).split(/\r?\n/);
  const start = lines.findIndex((l) => NEXT_STEPS_HEAD.test(l.trim()));
  if (start < 0) return [];
  const head = lines[start] as string;
  const level = headingLevel(head);
  const steps = [NEXT_STEPS_HEAD.exec(head.trim())?.[1] ?? ''];
  for (const line of lines.slice(start + 1)) {
    const next = headingLevel(line);
    if (next > 0 && (level === 0 || next <= level)) break;
    steps.push(line);
  }
  const kept: string[] = [];
  let left = NEXT_STEPS_CHARS;
  for (const step of steps.map((s) => s.trimEnd()).filter((s) => s.trim())) {
    if (step.length > left) {
      kept.push(`${step.slice(0, left)}…`);
      break;
    }
    kept.push(step);
    left -= step.length;
  }
  return kept;
}

/**
 * The next steps of an issue's body, or of a local proposal's what, under its line in the scout's
 * list, so that a later scout goes on with the next step once this one is done; empty when it
 * lists none. Only issues by people the Master trusts reach here.
 */
function nextStepsLines(body: string): string {
  const steps = nextSteps(body);
  if (steps.length === 0) return '';
  const head = `\n  ${t({ zh: '后续步骤：', en: 'Next steps:' })}`;
  return `${head}${steps.map((s) => `\n    ${s}`).join('')}`;
}

/** Local proposals listed per section of the scout's list; more are only counted. */
const MAX_LOCAL_PENDING = 100;
const MAX_LOCAL_ACCEPTED = 50;
/** Rejections stay counterexamples however old, as issues closed as not planned do. */
const MAX_LOCAL_REJECTED = 300;
/** Proposals given up after repeated failures, newest first. */
const MAX_LOCAL_FAILED = 50;

/** What the scout's list of local proposals reads of the Run an accepted one became. */
export type ProposalRun = Pick<Run, 'status' | 'error' | 'discussion'>;

/** A section of the list: its lines, at most `max` of them, the rest only counted. */
function digestSection(heading: string, lines: string[], max: number): string {
  if (lines.length === 0) return `${heading}\n${t({ zh: '（无）', en: '(none)' })}`;
  const shown = lines.slice(0, max);
  if (lines.length > max) shown.push(moreText(lines.length - max));
  return `${heading}\n${shown.join('\n')}`;
}

/** What the scout's list of local proposals reads of the iteration a proposal is a step of. */
export type ProposalIteration = Pick<Iteration, 'id' | 'title' | 'status' | 'children'>;

/**
 * How the iteration a listed proposal was a step of ended: done, or cancelled by a human. Null
 * when it is not a step of one; the steps of an iteration still open are not listed at all.
 */
function endedIterationPart(iteration: ProposalIteration | undefined): string | null {
  if (iteration?.status === 'done') {
    return t({
      zh: `所属迭代 ${iteration.id} 已完成`,
      en: `its iteration ${iteration.id} is done`,
    });
  }
  if (iteration?.status === 'cancelled') {
    return t({
      zh: `所属迭代 ${iteration.id} 已被人终止`,
      en: `its iteration ${iteration.id} was cancelled by a human`,
    });
  }
  return null;
}

/**
 * An accepted proposal: the Run it became and how that stands, whether it was accepted without a
 * human, the iteration it was a step of once that ended (done, or cancelled by a human, when a
 * step without a Run never got one); why the Run failed or why its assessment dropped the
 * requirement, which the Run digest no longer shows once the Run is old; and its next steps.
 */
function acceptedProposalLine(
  p: Proposal,
  run: ProposalRun | undefined,
  iteration: ProposalIteration | undefined,
): string {
  const parts: string[] = [];
  if (p.runId) {
    parts.push(run ? `Run ${p.runId}${colon()}${statusText(run.status)}` : `Run ${p.runId}`);
  }
  if (p.attempt > 1) {
    parts.push(t({ zh: `第 ${p.attempt} 次尝试`, en: `attempt ${p.attempt}` }));
  }
  // A step of an iteration that ended is not redone, whatever it waited for.
  if (proposalAwaitingRedo(p, iteration)) {
    parts.push(t({ zh: '等自动重做', en: 'waiting to be redone automatically' }));
  }
  if (p.auto) parts.push(t({ zh: '自动采纳', en: 'accepted automatically' }));
  const ended = endedIterationPart(iteration);
  if (ended) parts.push(ended);
  const about = parts.length
    ? t({ zh: `（${parts.join('，')}）`, en: ` (${parts.join('; ')})` })
    : '';
  const lines = [`- ${p.id} ${oneLine(p.title, 120)}${about}`];
  const dropped = run?.status === 'dropped' ? conclusionOf(run.discussion) : null;
  if (dropped) {
    const reason = oneLine(dropped.summary, 300);
    lines.push(
      `  ${t({ zh: '需求评估结论为不做，理由', en: 'The assessment dropped it; reason' })}${colon()}${reason}`,
    );
  }
  if (run?.status === 'failed' && run.error) {
    lines.push(
      `  ${t({ zh: '失败原因', en: 'Why it failed' })}${colon()}${oneLine(run.error, 300)}`,
    );
  }
  return `${lines.join('\n')}${nextStepsLines(p.what)}`;
}

/**
 * A proposal given up after its Runs failed `max_run_attempts` times: how many times, whether it
 * was accepted without a human, the iteration it was a step of and how that ended, so the scout
 * can tell a step left behind from a requirement of its own; then each attempt with its Run, the
 * stage it failed in and why.
 */
function failedProposalLine(p: Proposal, iteration: ProposalIteration | undefined): string {
  const n = p.failures.length;
  const parts = [t({ zh: `失败 ${n} 次`, en: `failed ${n === 1 ? 'once' : `${n} times`}` })];
  if (p.auto) parts.push(t({ zh: '自动采纳', en: 'accepted automatically' }));
  const ended = endedIterationPart(iteration);
  if (ended) parts.push(ended);
  const about = t({ zh: `（${parts.join('，')}）`, en: ` (${parts.join('; ')})` });
  const attempts = p.failures.map((f) => {
    const head = t({
      zh: `第 ${f.attempt} 次（Run ${f.runId}${f.stage ? `，失败在「${f.stage}」阶段` : ''}）`,
      en: `Attempt ${f.attempt} (Run ${f.runId}${f.stage ? `, failed in the "${f.stage}" stage` : ''})`,
    });
    return `  ${head}${colon()}${oneLine(f.error, 300)}`;
  });
  return [`- ${p.id} ${oneLine(p.title, 120)}${about}`, ...attempts].join('\n');
}

/**
 * The repo's local proposals (backlog.repos), so the scout does not propose them again: those
 * waiting for a human, those accepted with the Run each became (`runOf`, undefined when it is not
 * known), the rejected ones with the human's reason, as counterexamples, and, when there are any,
 * those given up after their Runs failed every attempt, with why each attempt failed. Pending and
 * accepted proposals carry their next steps (see nextSteps), so that the scout proposes the next
 * step of a large capability once the one before it is done. `proposals` are newest first; every
 * one was written by a scout of the Master and decided on its dashboard, so all of them are
 * trusted. `iterations` are the repo's: the steps of the one under way are left out, as the
 * iteration's own digest lists them (`iterationDigest`); the steps of one rejected as a whole make
 * one entry, the iteration with the titles of its steps and the reason; the steps of one that
 * ended are listed as the accepted or failed proposals they are, with how it ended.
 */
export function localProposalDigest(
  proposals: readonly Proposal[],
  runOf?: (runId: string) => ProposalRun | undefined,
  iterations: readonly ProposalIteration[] = [],
): string {
  const byId = new Map(iterations.map((it) => [it.id, it]));
  const iterationOf = (p: Proposal) => (p.iterationId ? byId.get(p.iterationId) : undefined);
  const listed = proposals.filter((p) => {
    const it = iterationOf(p);
    return !it || !ITERATION_OPEN_STATUSES.includes(it.status);
  });
  const of = (status: Proposal['status']) => listed.filter((p) => p.status === status);
  const pending = of('pending').map(
    (p) => `- ${p.id} ${oneLine(p.title, 120)}${nextStepsLines(p.what)}`,
  );
  const accepted = of('accepted').map((p) =>
    acceptedProposalLine(p, p.runId ? runOf?.(p.runId) : undefined, iterationOf(p)),
  );
  const reasonLine = (reason: string | null | undefined) => {
    const why = reason?.trim();
    return why ? `\n  ${t({ zh: '理由', en: 'Reason' })}${colon()}${oneLine(why, 300)}` : '';
  };
  const rejected: string[] = [];
  const rejectedIterations = new Set<string>();
  for (const p of of('rejected')) {
    const it = iterationOf(p);
    if (!it) {
      rejected.push(`- ${p.id} ${oneLine(p.title, 120)}${reasonLine(p.rejectReason)}`);
      continue;
    }
    // Rejected as a whole: one entry, where its newest step would be.
    if (rejectedIterations.has(it.id)) continue;
    rejectedIterations.add(it.id);
    const steps = proposals
      .filter((s) => s.iterationId === it.id)
      .reverse()
      .map((s) => oneLine(s.title, 80));
    rejected.push(
      `- ${it.id} ${t({
        zh: `迭代「${oneLine(it.title, 120)}」（子项：${join(steps)}）`,
        en: `iteration "${oneLine(it.title, 120)}" (steps: ${join(steps)})`,
      })}${reasonLine(p.rejectReason)}`,
    );
  }
  const failed = of('failed').map((p) => failedProposalLine(p, iterationOf(p)));
  return [
    digestSection(
      t({ zh: '### 等人决定', en: '### Waiting for a human' }),
      pending,
      MAX_LOCAL_PENDING,
    ),
    digestSection(t({ zh: '### 已采纳', en: '### Accepted' }), accepted, MAX_LOCAL_ACCEPTED),
    digestSection(t({ zh: '### 被拒绝', en: '### Rejected' }), rejected, MAX_LOCAL_REJECTED),
    ...(failed.length > 0
      ? [
          digestSection(
            t({
              zh: '### 多次失败后放弃（不是人拒绝的）',
              en: '### Given up after repeated failures (not rejected by a human)',
            }),
            failed,
            MAX_LOCAL_FAILED,
          ),
        ]
      : []),
  ].join('\n\n');
}

const iterationStatusText = (status: IterationStatus) =>
  t<Record<IterationStatus, string>>({
    zh: {
      pending: '等人采纳',
      active: '进行中',
      blocked: '受阻：有子项失败或被关成不做，还没有子项替换它',
      done: '已完成',
      cancelled: '不做',
    },
    en: {
      pending: 'waiting for a human to accept it',
      active: 'under way',
      blocked: 'blocked: a step failed or was dropped, and no step replaced it yet',
      done: 'done',
      cancelled: 'turned down',
    },
  })[status];

const childStatusText = (status: IterationChildStatus) =>
  t<Record<IterationChildStatus, string>>({
    zh: {
      planned: '等迭代被采纳',
      waiting: '等依赖',
      ready: '可以开工',
      running: '进行中',
      done: '已完成',
      failed: '失败',
      dropped: '不做',
    },
    en: {
      planned: 'waiting for the iteration to be accepted',
      waiting: 'waiting for its dependencies',
      ready: 'ready to start',
      running: 'in progress',
      done: 'done',
      failed: 'failed',
      dropped: 'dropped',
    },
  })[status];

/**
 * Why a step of an iteration that failed or was dropped did not get done, from its last Run that
 * says: the Run's error, or the assessment's reason for dropping the requirement. Empty when no
 * Run says.
 */
function childFailureLines(
  child: IterationChild,
  runOf: (runId: string) => ProposalRun | undefined,
) {
  if (child.status !== 'failed' && child.status !== 'dropped') return [];
  for (const runId of [...child.runIds].reverse()) {
    const run = runOf(runId);
    const dropped = run?.status === 'dropped' ? conclusionOf(run.discussion) : null;
    if (dropped) {
      const reason = oneLine(dropped.summary, 300);
      return [
        `     ${t({ zh: '需求评估结论为不做，理由', en: 'The assessment dropped it; reason' })}${colon()}${reason}`,
      ];
    }
    if (run?.status === 'failed' && run.error) {
      return [
        `     ${t({ zh: '失败原因', en: 'Why it failed' })}${colon()}${oneLine(run.error, 300)}`,
      ];
    }
  }
  return [];
}

/**
 * One step of an iteration in its digest: its number in the plan, its issue (or proposal of the
 * local backlog) and title, then whether it closes the iteration out, where it stands (for one
 * waiting, the steps it still waits for), the step that replaced it, the steps it depends on and
 * the criteria it moves forward, and its Runs with how each stands; why it failed on a line of
 * its own.
 */
function childLines(
  child: IterationChild,
  children: readonly IterationChild[],
  runOf: (runId: string) => ProposalRun | undefined,
): string[] {
  const ref = child.issue
    ? `#${child.issue.number} `
    : child.proposalId
      ? `${child.proposalId} `
      : '';
  const unmet = child.status === 'waiting' ? unmetDependencies(child, children) : [];
  const parts = child.closeout ? [t({ zh: '收尾', en: 'closing step' })] : [];
  parts.push(
    unmet.length > 0
      ? t({
          zh: `还在等 ${numberList(unmet)}`,
          en: `still waiting for ${numberList(unmet)}`,
        })
      : childStatusText(child.status),
  );
  if (child.replacedBy !== undefined) {
    parts.push(t({ zh: `已被 ${child.replacedBy} 替换`, en: `replaced by ${child.replacedBy}` }));
  }
  if (child.dependsOn.length > 0) {
    parts.push(
      t({
        zh: `依赖 ${numberList(child.dependsOn)}`,
        en: `depends on ${numberList(child.dependsOn)}`,
      }),
    );
  }
  if (child.criteria.length > 0) {
    parts.push(
      t({
        zh: `推进完成标准 ${numberList(child.criteria)}`,
        en: `advances criteria ${numberList(child.criteria)}`,
      }),
    );
  }
  if (child.runIds.length > 0) {
    const runs = child.runIds.map((id) => {
      const run = runOf(id);
      return run
        ? t({ zh: `${id}（${statusText(run.status)}）`, en: `${id} (${statusText(run.status)})` })
        : id;
    });
    parts.push(`Run ${join(runs)}`);
  }
  const about = t({ zh: `（${parts.join('；')}）`, en: ` (${parts.join('; ')})` });
  return [
    `  ${child.position}. ${ref}${oneLine(child.title, 120)}${about}`,
    ...childFailureLines(child, runOf),
  ];
}

/**
 * The iteration under way, for the scout's prompt: its title, where it stands, its goal with the
 * README goal it serves, its completion criteria, what it leaves out, how far it got, each step
 * by its number in the plan (see childLines) and the changes scouts made to the plan so far.
 * `runOf` gives what is known of a Run of its steps, undefined when nothing is. Every part of it
 * was written by a scout of the Master, so all of it is trusted.
 */
export function iterationDigest(
  iteration: Iteration,
  runOf: (runId: string) => ProposalRun | undefined,
): string {
  const progress = iterationProgress(iteration.children);
  const number = iteration.issue?.number;
  const issue = number ? t({ zh: `（#${number}）`, en: ` (#${number})` }) : '';
  const none = t({ zh: '（没有写）', en: '(none given)' });
  const lines = [
    `- ${t({ zh: '标题', en: 'Title' })}${colon()}${oneLine(iteration.title, 120)}${issue}`,
    `- ${t({ zh: '状态', en: 'Status' })}${colon()}${iterationStatusText(iteration.status)}`,
    `- ${t({ zh: '目标', en: 'Goal' })}${colon()}${oneLine(iteration.goal, 500)}`,
    `- ${t({ zh: '对应 README 的目标', en: 'README goal it serves' })}${colon()}${oneLine(iteration.readmeGoal, 300)}`,
    `- ${t({ zh: '完成标准：', en: 'Completion criteria:' })}`,
    ...iteration.criteria.map((c, i) => `  ${i + 1}. ${oneLine(c, 300)}`),
    `- ${t({ zh: '不做', en: 'Out of scope' })}${colon()}${
      iteration.outOfScope.length > 0
        ? join(iteration.outOfScope.map((o) => oneLine(o, 200)))
        : none
    }`,
    `- ${t({
      zh: `进度：完成 ${progress.done} 个子项，共 ${progress.total} 个`,
      en: `Progress: ${progress.done} of ${progress.total} step${progress.total === 1 ? '' : 's'} done`,
    })}`,
    `- ${t({ zh: '子项（按计划里的序号）：', en: 'Steps (by their numbers in the plan):' })}`,
    ...iteration.children.flatMap((child) => childLines(child, iteration.children, runOf)),
  ];
  if (iteration.notes.length > 0) {
    lines.push(`- ${t({ zh: '计划的调整：', en: 'Changes to the plan:' })}`);
    for (const note of iteration.notes) {
      lines.push(`  - ${note.at.slice(0, 10)}${colon()}${oneLine(note.text, 300)}`);
    }
  }
  return lines.join('\n');
}

/**
 * The goal of a Run created from a local proposal: its title, then why, the evidence, what to do
 * and the acceptance criteria, as the issue of a proposal reads (`proposalSections`).
 */
export function proposalGoal(
  p: Pick<Proposal, 'title' | 'why' | 'evidence' | 'what' | 'acceptance'>,
): string {
  return `${p.title}\n\n${proposalSections(p)}`;
}

/** Proposals a human still has to look at. */
export function untriaged(open: HostIssue[]): HostIssue[] {
  const decided: string[] = [LABELS.ready, LABELS.running, LABELS.needsYou, LABELS.failed];
  return open.filter(
    (i) => i.labels.includes(LABELS.proposal) && !i.labels.some((l) => decided.includes(l)),
  );
}

/** The scout that filed an issue, and the proposal (the stored object) the issue came from. */
export function filedProposal<S extends Pick<Scout, 'proposals'>>(
  scouts: S[],
  issue: number,
): { scout: S; proposal: ScoutProposal } | null {
  for (const scout of scouts) {
    const proposal = scout.proposals.find((p) => p.issue?.number === issue);
    if (proposal) return { scout, proposal };
  }
  return null;
}

/**
 * Untriaged proposals that hold the automatic scout back once there are `max_proposals` of them,
 * by `holdsScout`: an issue without a scout record is of an unknown kind. An iteration waits for
 * a human as a whole: its issue counts once, as the kind auto-accept judges it by
 * (`iterationKind`), and the issues of its children, which it accepts with it, do not count.
 * `iterations`: the repo's, with their issues and their children's.
 */
export function proposalsHoldingScout(
  open: HostIssue[],
  scouts: Pick<Scout, 'proposals'>[],
  limits: AutoAcceptLimits,
  iterations: readonly Pick<Iteration, 'issue' | 'children'>[] = [],
): HostIssue[] {
  const byIssue = new Map(
    iterations.flatMap((it) => (it.issue ? [[it.issue.number, it] as const] : [])),
  );
  const children = new Set(
    iterations.flatMap((it) => it.children.flatMap((c) => (c.issue ? [c.issue.number] : []))),
  );
  return untriaged(open).filter((issue) => {
    if (children.has(issue.number)) return false;
    const iteration = byIssue.get(issue.number);
    if (iteration) return holdsScout(iterationKind(iteration.children), limits);
    return holdsScout(filedProposal(scouts, issue.number)?.proposal ?? null, limits);
  });
}

/**
 * Where a repo's requirements are, as the scout's prompt says it: GitHub issues, or the local
 * backlog of a repo without GitHub (backlog.repos), where proposals stay in the Master and are
 * accepted on the dashboard.
 */
export type ScoutSource = 'github' | 'local';

interface ScoutPromptInput {
  repoName: string;
  /** Where proposals go and the requirements there are come from; github when omitted. */
  source?: ScoutSource;
  /** At most this many proposals outside an iteration (`max_proposals`). */
  max: number;
  runs: string;
  /** The requirements there are: `issueDigest` on GitHub, `localProposalDigest` otherwise. */
  issues: string;
  /**
   * Whether the repo's template splits an L requirement into steps done in one Run
   * (`templateSplits`). Then what one Run finishes that way is one step of an iteration of size
   * L, not several; without it, steps are kept to S or M where they can be.
   */
  splits: boolean;
  /**
   * Whether an iteration with a step of size L is accepted without a human when its risk is
   * within `max_risk` (`autoAcceptsL`): auto-accept judges an iteration as a whole.
   */
  autoAcceptsL: boolean;
  /**
   * The Master's last failed upgrade, given only to the scout of the Master's own repo while no
   * upgrade has succeeded since.
   */
  upgrade?: UpgradeFailure | null;
  /**
   * The repo's iteration under way, pending, active or blocked (`iterationDigest`); null or
   * missing while it has none. Without one, the scout's main output is a new iteration, besides
   * proposals of problems and obvious bugs; with one, it plans no other, proposes only problems
   * that stop the system, and judges whether the plan needs to change.
   */
  iteration?: string | null;
}

/**
 * The scout's prompt, in the language in use. Both languages are built from the same sections in
 * the same order, so they say the same; which sections there are depends on whether the repo has
 * an iteration under way (`iteration`).
 */
export function scoutPrompt(input: ScoutPromptInput): string {
  const source = input.source ?? 'github';
  const sections = input.iteration
    ? [
        followingIntro(input, source),
        directionSection(),
        gapSection(source),
        openIterationSection(input.iteration),
        followingLeads(input),
        changingPlanSection(source),
        followingProposals(input),
        requirementsSection(source),
      ]
    : [
        planningIntro(input, source),
        directionSection(),
        gapSection(source),
        planningLeads(input),
        planningSection(input, source),
        planningProposals(input),
        requirementsSection(source),
      ];
  const runs = t({ zh: '## 最近的 Run', en: '## Recent Runs' });
  return `${sections.join('\n\n')}\n\n${upgradeSection(input.upgrade, source)}${runs}\n${input.runs}\n\n${existingHeading(source)}\n${input.issues}\n`;
}

/** `text` as a Markdown code block, fenced with more backticks than any run of them inside. */
function codeBlock(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

/**
 * The section on the Master's failed upgrade, followed by a blank line; empty without one. The
 * proposals may go to GitHub, so paths under the home directory are left out of what the script
 * recorded, as they are from everything the Master publishes. A failure of the environment (no
 * node or npm) says nothing about the code and is retried by the Master, so the scout is told not
 * to spend a proposal on it rather than to put fixing it first.
 */
function upgradeSection(failure: UpgradeFailure | null | undefined, source: ScoutSource): string {
  if (!failure) return '';
  const unknown = t({ zh: '（不知道是哪个）', en: '(unknown)' });
  const to = failure.to || unknown;
  const toShort = failure.to ? failure.to.slice(0, 7) : unknown;
  const from = failure.from ? failure.from.slice(0, 7) : unknown;
  const date = failure.at.slice(0, 10);
  const message = oneLine(redactForGitHub(failure.message), 300);
  const output = failure.detail
    ? `${t({ zh: '- 输出末尾：', en: '- End of the output:' })}\n${codeBlock(redactForGitHub(failure.detail))}`
    : t({ zh: '- 输出末尾：没有记下。', en: '- End of the output: not recorded.' });
  const title = failure.env
    ? t({
        zh: '## Master 自动升级因运行环境失败',
        en: "## The Master's automatic upgrade failed because of the environment",
      })
    : t({ zh: '## Master 自动升级失败', en: "## The Master's automatic upgrade failed" });
  const facts = t({
    zh: `${brandName()}的 Master 就是从这个仓库构建的：它运行在这个仓库的一份克隆（稳定副本）里，目标分支有新提交时自动升级（\`npm ci\`、\`npm run build\`，再启动新版本，检查它能否响应，并观察几分钟，看它会不会出错退出）。${date} 它尝试升级到目标分支上的提交 ${to}，失败了，已回退到 ${from} 继续运行。
- 失败消息：${message}
${output}`,
    en: `The Master of ${brandName()} is built from this repo: it runs in a clone of it (the stable copy) and upgrades itself when the target branch gets new commits (\`npm ci\`, \`npm run build\`, then it starts the new version, checks that it responds and watches it for a few minutes in case it exits with an error). On ${date} it tried to upgrade to commit ${to} on the target branch and failed; it rolled back to ${from} and keeps running that.
- Failure message: ${message}
${output}`,
  });
  const advice = failure.env ? envFailureAdvice(source) : codeFailureAdvice(toShort, source);
  return `${title}\n${facts}\n\n${advice}\n\n`;
}

/** What the scout does about an upgrade that failed for the environment, not for the code. */
function envFailureAdvice(source: ScoutSource): string {
  const covered = t({
    zh: source === 'local' ? '已有的提案已经覆盖时' : '已有的 issue 已经覆盖时',
    en: source === 'local' ? 'an existing proposal' : 'an existing issue',
  });
  return t({
    zh: `这次失败出在运行环境（比如稳定副本所在的机器上找不到能用的 node 或 npm），和这个提交的代码无关。Master 不会把这个提交记成失败过，会等一段时间后自己再试，环境好了升级就会成功。所以不要为此提代码修复，也不要把它排在上面的线索前面。
- 只有输出表明仓库里的脚本（比如 \`scripts/find-node.sh\`、\`scripts/self-upgrade.sh\`）本身有缺陷时，比如机器上明明装着合适的 node 却没有找到，才提修复：先核对问题在现在的代码里是否还在，${covered}不要重复提。`,
    en: `This failure is the environment's (for example, no usable node or npm on the machine of the stable copy), not the code's in that commit. The Master does not count the commit as failed: it waits a while and tries again by itself, and the upgrade succeeds once the environment is fixed. So do not propose a code fix for it, and do not put it before the leads above.
- Propose a fix only if the output shows a defect in a script of the repo itself (such as \`scripts/find-node.sh\` or \`scripts/self-upgrade.sh\`), for example that it missed a suitable node installed on the machine: check first whether the problem is still in the code as it is now, and do not propose it again if ${covered} covers it.`,
  });
}

/** What the scout does about an upgrade that failed for any other reason: fix it first. */
function codeFailureAdvice(toShort: string, source: ScoutSource): string {
  const existing = t({
    zh: source === 'local' ? '已有的提案里' : '已有的 issue 里',
    en: source === 'local' ? 'the existing proposals' : 'the existing issues',
  });
  return t({
    zh: `这很可能说明目标分支上的代码在稳定副本里无法构建、启动，或者启动后不久就出错退出。修好之前，每次升级都会失败，Master 一直停在旧版本上，系统的自我进化也就停了，所以修复它是最高优先级，排在上面所有线索之前：根据上面的输出和代码找出原因，把修复作为第一条提案，在证据里写上失败的提交和输出中的关键行。
- 如果输出表明是网络、npm 源、磁盘空间这类环境问题，而不是代码的问题，就不要硬提代码修复。
- 你读到的目标分支可能已经比 ${toShort} 新：先核对问题在现在的代码里是否还在，已经修好的不要再提。
- ${existing}已经有针对这个失败的修复时，不要重复提。`,
    en: `Most likely the code on the target branch cannot be built or started in the stable copy, or exits with an error soon after it starts. Until that is fixed, every upgrade fails, the Master stays on the old version, and the system stops evolving, so fixing it comes first, before all the leads above: find the cause from the output and the code, make the fix your first proposal, and cite the failed commit and the key lines of the output in its evidence.
- If the output shows a problem of the environment, such as the network, the npm registry or disk space, rather than of the code, do not force a code fix.
- The target branch you read may be newer than ${toShort}: check first whether the problem is still in the code as it is now, and do not propose a fix for one already fixed.
- Do not propose a fix again if one for this failure is among ${existing}.`,
  });
}

/**
 * The Master's failed upgrade among the problems that stop the system, when its section below
 * asks to fix it first; a failure of the environment is retried by the Master and is no such lead.
 */
function upgradeLead(failure: UpgradeFailure | null | undefined): string {
  if (!failure || failure.env) return '';
  return t({
    zh: '，以及下面的「Master 自动升级失败」',
    en: ", and the Master's failed upgrade below",
  });
}

/** A part of a Run's time, named as the dashboard and the Run summaries name it. */
const part = (p: RunTimePart) => runTimePartLabels()[p];

/**
 * How auto-accept judges an iteration, as a whole by the highest risk and the largest size of its
 * steps, and whether a step of size L keeps it from being accepted automatically.
 */
function autoAcceptText(autoAcceptsL: boolean): string {
  const whole = t({
    zh: '迭代按整体自动采纳：取子项里最高的风险和最大的大小，和自动采纳的设置比较。',
    en: 'Auto-accept judges an iteration as a whole, by the highest risk and the largest size among its steps.',
  });
  const l = autoAcceptsL
    ? t({
        zh: '风险在自动采纳范围内时，有 L 子项的迭代也会被自动采纳。',
        en: 'An iteration with steps of size L is accepted automatically too when its risk is within what auto-accept takes.',
      })
    : t({
        zh: '有一个子项是 L，整个迭代就不会被自动采纳，要等人采纳。',
        en: 'A single step of size L keeps the whole iteration from being accepted automatically: it waits for a human.',
      });
  return t({ zh: `${whole}${l}`, en: `${whole} ${l}` });
}

/**
 * How large a step of an iteration is, by whether the repo's template splits an L requirement in
 * one Run: then what one Run finishes that way is one step of size L, since every extra step costs
 * its own assessment, review, merge and upgrade; otherwise steps are kept to S or M.
 */
function stepSizeText(splits: boolean): string {
  return splits
    ? t({
        zh: '这个仓库用的模板能拆分大需求：size 为 L 的需求，在编码阶段会先拆成几步，再一步一步做、一步一步检查，一个 Run 就能做完。一个 Run 这样能做完的，作为一个子项，size 标 L，不要拆成几个子项：每多一个子项，就多一轮评估、评审、合并和升级。',
        en: 'The template this repo uses can split large requirements: a requirement of size L is broken down in the coding stage, then done and checked piece by piece, all in one Run. What one Run can finish that way is one step of size L; do not make several steps of it: every extra step costs another round of assessment, review, merge and upgrade.',
      })
    : t({
        zh: '这个仓库用的模板不拆分需求：每个子项都整个交给一个 Run 一次做完，size 尽量是 S 或 M；一个 Run 做不完的，拆成有先后的几个子项。',
        en: 'The template this repo uses does not split requirements: each step goes to one Run as a whole, done in one go, so keep steps to size S or M where you can; split what one Run cannot finish into several steps in order.',
      });
}

// The parts of the prompt that depend on where the repo's requirements are (`ScoutSource`): on
// GitHub, proposals become issues and the requirements there are are issues, open or closed; in
// the local backlog, proposals stay in the Master, waiting for a human, accepted or rejected.

/** What becomes of a proposal. */
function proposalFate(source: ScoutSource): string {
  return source === 'local'
    ? t({
        zh: '提案会存进 Master 的本地提案池，在看板上被采纳（或按自动采纳的设置采纳）后由 Agent 按「编码 → 评审 → 合并」完成。',
        en: `Each proposal goes into the Master's local backlog; once accepted on the dashboard (or under the auto-accept setting), agents carry it out through "code → review → merge".`,
      })
    : t({
        zh: '提案会成为 GitHub issue，被采纳后由 Agent 按「编码 → 评审 → 合并」完成。',
        en: 'Each proposal becomes a GitHub issue; once accepted, agents carry it out through "code → review → merge".',
      });
}

/** That gaps some requirement already works on are listed too. */
function coveredGapsText(source: ScoutSource): string {
  return source === 'local'
    ? t({
        zh: '已经有提案在做的缺口也照样列出。',
        en: 'List gaps that existing proposals already work on as well.',
      })
    : t({
        zh: '已经有 issue 在做的缺口也照样列出。',
        en: 'List gaps that existing issues already work on as well.',
      });
}

/** What becomes of an iteration. */
function iterationFate(source: ScoutSource): string {
  return source === 'local'
    ? t({
        zh: '迭代会存进 Master 的本地提案池，它的每个子项各成为一条提案；迭代在看板上整个一起采纳（或按自动采纳的设置采纳），子项按依赖顺序开工，全部完成后 Master 写一份总结。',
        en: "An iteration goes into the Master's local backlog, each of its steps as a proposal of its own; it is accepted as a whole on the dashboard (or under the auto-accept setting), its steps start in the order of their dependencies, and once all of them are done the Master writes a summary.",
      })
    : t({
        zh: '迭代会成为一个 GitHub issue，写明目标、完成标准、计划和不做的事，它的每个子项各成为一个 issue；迭代整个一起采纳，子项按依赖顺序开工，全部完成后 Master 发一份总结。',
        en: 'An iteration becomes a GitHub issue stating its goal, completion criteria, plan and what it leaves out, and each of its steps becomes an issue of its own; the iteration is accepted as a whole, its steps start in the order of their dependencies, and once all of them are done the Master posts a summary.',
      });
}

/** Where the reason for a change to an iteration's plan ends up. */
function noteFate(source: ScoutSource): string {
  return source === 'local'
    ? t({
        zh: '会记在迭代上，在看板上能看到。',
        en: 'it is recorded on the iteration, where the dashboard shows it.',
      })
    : t({
        zh: '会作为评论发在迭代的 issue 上。',
        en: "it is posted as a comment on the iteration's issue.",
      });
}

/** What to do about a gap some requirement already works on, when choosing the iteration's. */
function takenGapText(source: ScoutSource): string {
  return source === 'local'
    ? t({
        zh: '缺口已经有提案在做（还在等人决定，或已采纳、Run 还没完成）时，换一个缺口；那条提案覆盖面很大、没有拆过、还在等人决定时，可以围绕它规划迭代，在相关子项的 why 里注明对应哪条提案（写上它的 id），这不算重复。',
        en: 'When a proposal already works on a gap (still waiting for a human, or accepted with its Run not completed yet), take another gap; when that proposal covers a lot, was never split and is still waiting for a human, you may plan the iteration around it, saying in the why of the steps concerned which proposal they stand for (with its id); that is not a duplicate.',
      })
    : t({
        zh: '缺口已经有未关闭的 issue 在做时，换一个缺口；那个 issue 覆盖面很大、没有拆过、还在等人采纳时，可以围绕它规划迭代，在相关子项的 why 里注明对应哪条 issue，这不算重复。',
        en: 'When an open issue already works on a gap, take another gap; when that issue covers a lot, was never split and is still waiting for a human to accept it, you may plan the iteration around it, saying in the why of the steps concerned which issue they stand for; that is not a duplicate.',
      });
}

/**
 * The next steps earlier scouts left when they split a large capability into a series of
 * requirements: material for planning an iteration once the step before them was merged, no
 * longer the next single proposal, and not to plan with before.
 */
function nextStepsText(source: ScoutSource): string {
  return source === 'local'
    ? t({
        zh: '- 下面已有的本地提案里列着「后续步骤」的，是以前把一个大能力拆成一串提案时留下的剩余步骤。已采纳、Run 已完成的提案的后续步骤，可以当作规划迭代的素材：把剩下的步骤作为一个迭代重新设计，不要再提接着某条提案往下做的单条提案。还在等人决定或 Run 还没完成的提案列着的后续步骤，要等它合并后才能做，不要拿来规划。',
        en: '- Among the existing local proposals below, those listing "Next steps" hold what is left of a large capability once split into a series of proposals. The next steps of a proposal that was accepted and whose Run completed are material for planning an iteration: design what is left anew as one iteration, and no longer propose single proposals that follow on from one. The next steps of a proposal still waiting for a human, or whose Run has not completed, can only be done once it is merged: do not plan with them.',
      })
    : t({
        zh: '- 下面已有的 issue 里列着「后续步骤」的，是以前把一个大能力拆成一串 issue 时留下的剩余步骤。已完成的 issue 的后续步骤，可以当作规划迭代的素材：把剩下的步骤作为一个迭代重新设计，不要再提「接着 #X」式的单条提案。还没关闭的 issue 列着的后续步骤，要等它合并后才能做，不要拿来规划。',
        en: '- Among the existing issues below, those listing "Next steps" hold what is left of a large capability once split into a series of issues. The next steps of a done issue are material for planning an iteration: design what is left anew as one iteration, and no longer propose single "follows #X" proposals. The next steps of an issue still open can only be done once it is merged: do not plan with them.',
      });
}

/** Not proposing what there is already, and the rejections as counterexamples. */
function duplicatesText(source: ScoutSource): string {
  return source === 'local'
    ? t({
        zh: '- 不要和下面已有的本地提案重复，包括已采纳的和被拒绝的。被拒绝的提案是反例，注意其中的理由，不要换个说法再提；已采纳、但需求评估结论为不做的，也一样。',
        en: '- Do not duplicate the existing local proposals below, including accepted and rejected ones. Rejected proposals are counterexamples: note their reasons and do not propose them again in other words; the same goes for accepted ones the requirement assessment dropped.',
      })
    : t({
        zh: '- 不要和下面已有的 issue 重复，包括已关闭的。被关闭为「不做」的 issue 是反例，注意其中的理由，不要换个说法再提。',
        en: '- Do not duplicate the existing issues below, including closed ones. Issues closed as not planned are counterexamples: note their reasons and do not propose them again in other words.',
      });
}

/** Requirements whose Runs failed: no human turned them down. */
function failedRequirementsText(source: ScoutSource): string {
  return source === 'local'
    ? t({
        zh: '- 已采纳、但 Run 失败了的提案，以及「多次失败后放弃」的提案不一样：它不是人拒绝的，需求本身可能仍然需要。可以根据其中的失败原因换个思路重新提案（比如拆小、先补上缺的能力、换一种做法），在 why 里说明和上次的不同；不要原样再提。还在等自动重做的不要再提，重做的结果出来之前，它还在做。',
        en: '- Accepted proposals whose Run failed, and proposals "given up after repeated failures", are different: no human rejected them, and the requirement may well still be wanted. You may propose them again with another approach based on the failures (e.g. split them up, first add a missing capability, do it another way), saying in why what is different this time; do not propose them again as they were. Do not propose one still waiting to be redone automatically: until its redo is over, it is still being worked on.',
      })
    : t({
        zh: '- 「多次失败后关闭」的 issue 不一样：它不是人拒绝的，而是 Run 尝试了几次都失败了，需求本身可能仍然需要。可以根据其中的失败原因换个思路重新提案（比如拆小、先补上缺的能力、换一种做法），在 why 里说明和上次的不同；不要原样再提。',
        en: '- Issues "closed after repeated failures" are different: no human rejected them; their Runs failed attempt after attempt, and the requirement may well still be wanted. You may propose them again with another approach based on the failures (e.g. split them up, first add a missing capability, do it another way), saying in why what is different this time; do not propose them again as they were.',
      });
}

/** The heading of the requirements there are. */
function existingHeading(source: ScoutSource): string {
  return source === 'local'
    ? t({ zh: '## 已有的本地提案', en: '## Existing local proposals' })
    : t({ zh: '## 已有的 issue', en: '## Existing issues' });
}

// The sections of the scout's prompt, each in the language in use. Without an iteration under
// way: planning intro, direction, gap analysis, leads, planning an iteration, proposals outside
// it, requirements. With one: following intro, direction, gap analysis, the iteration under way,
// the lead left, changing the plan, proposals, requirements.

/** The intro while the repo has no iteration under way: its main output is a new one. */
function planningIntro(input: ScoutPromptInput, source: ScoutSource): string {
  return t({
    zh: `你是${brandName()}的「侦察」：为仓库 ${input.repoName} 找出接下来最值得做的事。这次的主要产出是一个「迭代」：围绕一个完整的大目标，一次规划好、成批交付的一组需求，做完之后人能看出这一轮做成了什么。${iterationFate(source)}另外，需要马上处理的问题写成单独的提案。${proposalFate(source)}你只能读代码和文档，不能修改任何文件。`,
    en: `You are the scout of ${brandName()}: find what is most worth doing next in the repo ${input.repoName}. Your main output this time is an iteration: a set of requirements around one complete, larger goal, planned in one go and delivered together, so that once it is done people can see what the round achieved. ${iterationFate(source)} Besides, problems that need attention right away become proposals of their own. ${proposalFate(source)} You may only read code and documents; you must not change any file.`,
  });
}

/** The intro while the repo has an iteration under way: no other, only problems and its plan. */
function followingIntro(input: ScoutPromptInput, source: ScoutSource): string {
  return t({
    zh: `你是${brandName()}的「侦察」：为仓库 ${input.repoName} 找出接下来最值得做的事。这个仓库有一个进行中的迭代（见下面「进行中的迭代」），它结束之前不规划新的迭代，也不提迭代之外的能力需求。这次只做两件事：把让系统停转或空耗的问题写成提案；判断迭代的计划要不要调整。差距分析照常做，留给下一个迭代用。${proposalFate(source)}你只能读代码和文档，不能修改任何文件。`,
    en: `You are the scout of ${brandName()}: find what is most worth doing next in the repo ${input.repoName}. The repo has an iteration under way (see "The iteration under way" below): until it is over, no other iteration is planned and no capability outside it is proposed. This time you do two things only: propose the problems that stop the system or make it spin without progress, and judge whether the iteration's plan needs to change. Do the gap analysis as usual, for the next iteration. ${proposalFate(source)} You may only read code and documents; you must not change any file.`,
  });
}

function directionSection(): string {
  return t({
    zh: `## 先弄清方向
- 读 README.md 和 AGENTS.md（有 CLAUDE.md 的也读）。README.md 写着项目的目标，是一切决定的依据；AGENTS.md 写着目录结构、命令和约定。
- 迭代和提案都要服务于 README.md 里的目标，不提和目标无关或背离目标的事。`,
    en: `## First, get the direction
- Read README.md and AGENTS.md (and CLAUDE.md if there is one). README.md states the project's goals and is the basis for every decision. AGENTS.md describes the layout, commands and conventions.
- Iterations and proposals must serve the goals in README.md; do not propose anything unrelated to them or against them.`,
  });
}

function gapSection(source: ScoutSource): string {
  return t({
    zh: `## 先做差距分析
规划和提案之前，先按 README.md 的原文列出它写的目标（只用来对照，不写进结果），再对照其中的每个目标，在能力层面列出这个项目现在还做不到什么，写进结果的 gaps。要看的是缺了哪些能力，不是零碎的缺陷：比如能对接哪些外部工具和服务、能做多大的任务、能不能并行、能服务什么样的用户、场景和需求来源、出了问题能不能自己恢复。代码里定义了却没有实现的选项、只支持一种情况的地方、写死的上限，往往就是缺口。
- 每个缺口写明：goal 是上面列出的哪个目标，一字不差地照抄 README.md 里这个目标的原文，同一个目标在每个缺口里写法相同；gap 是缺什么能力，evidence 是限制这个能力的代码位置（文件:行号）或 README、文档里的段落。
- 最重要的缺口放在最前：越是挡住目标、越多事情依赖它，越重要。${coveredGapsText(source)}
- 认真对照每个目标后仍然找不到缺口，gaps 才是空列表。`,
    en: `## First, a gap analysis
Before planning or proposing anything, list the goals README.md states, in its own words (only to go by, not part of your answer); then go through each of them and list, as capabilities, what the project cannot do yet; put them in the gaps of your answer. Look for missing capabilities, not scattered bugs: for example which outside tools and services it can work with, how large a task it can take on, whether it can do things in parallel, what users, situations and sources of requirements it can serve, and whether it can recover by itself when something goes wrong. Options defined in the code but never implemented, places that support only one case, and hard-coded limits are often gaps.
- For each gap, give goal: one of the goals you listed, copied word for word as README.md writes it, and written the same way in every gap of that goal; gap: the missing capability; evidence: where the code limits this capability (file:line), or passages of README or other documents.
- Put the most important gaps first: the more a gap stands in the way of a goal and the more depends on it, the more important it is. ${coveredGapsText(source)}
- Leave gaps empty only if you find none after carefully going through every goal.`,
  });
}

/** Lead 1, the problems that stop the system or make it spin without progress. */
function problemLead(input: ScoutPromptInput): string {
  return t({
    zh: `1. 让系统停转或空耗的问题：下面附的最近 Run 里卡住、失败、反复返工、评审反复提同类意见、费用或 Agent 执行用时异常的${upgradeLead(input.upgrade)}。用时里「${part('stoppedMs')}」「${part('approvalMs')}」「${part('blockedMs')}」「${part('pausedMs')}」的部分是在等人处理，「${part('queuedMs')}」的部分是在等别的 Run 做完（也包括等升级、Master 没运行的时候），「${part('conflictWaitMs')}」和排队一样是在等别的 Run（避开和它改同一处的 Run，免得合并时冲突），都不说明 Agent 慢。摘要开头写着当时的 concurrency.per_repo 和有几个 Run 并行执行过：per_repo 为 1、排队时间远多于 Agent 执行时间、并行带来的错开等待和「并行时合并冲突」又很少时，可以建议人调大 per_repo，并写明依据。per_repo 由用户在自己数据目录的 config.yaml 里设置，不在仓库里：侦察只提建议，不改用户的配置。需求评估提了疑问、需求在讨论后改过或结论为不做，说明这条需求没写清楚或方向有偏差：留意其中的疑问和理由，新提案不要再犯。`,
    en: `1. Problems that stop the system or make it spin without progress: Runs below that got stuck, failed, needed rework again and again, drew the same kind of review comments again and again, or took unusual cost or agent time${upgradeLead(input.upgrade)}. In the times, "${part('stoppedMs')}", "${part('approvalMs')}", "${part('blockedMs')}" and "${part('pausedMs')}" are time spent waiting for a human; "${part('queuedMs')}" is time spent waiting for other Runs to finish (including while an upgrade is pending or the Master is not running), and "${part('conflictWaitMs')}" is waiting for another Run just like the queue (keeping clear of a Run that changes the same place, so that the two do not conflict at the merge): none of these mean the agents were slow. The digest of the Runs opens with concurrency.per_repo at the time and how many Runs executed side by side: when per_repo is 1, the Runs spent far more time queued than executing, and working side by side brought few waits for overlapping Runs and few merge conflicts, you may suggest that a human raise per_repo, giving your grounds. per_repo is set by the user in config.yaml in their own data directory, not in the repo: the scout only suggests it and does not change the user's configuration. When the requirement assessment asked questions, the requirement was revised in the discussion, or the conclusion was to drop it, the requirement was unclear or off course: note the questions and reasons, and do not repeat those mistakes in new proposals.`,
  });
}

/** The leads while no iteration is under way: gaps become the iteration, polish no proposal. */
function planningLeads(input: ScoutPromptInput): string {
  return t({
    zh: `## 线索（按优先级从高到低）
${problemLead(input)}
2. 差距分析里最重要的能力缺口：规划成迭代（见下面「规划迭代」），不单独提案。
3. 明显的缺陷和测试缺口，README.md、AGENTS.md 和代码不一致的地方，代码里的 TODO。
4. 评审建议和对最近改动的修饰：不单独提案。评审通过时给的建议是评审有意留到以后的改进，由迭代最后的「收尾」子项统一整理，内容由 Master 在它开工前填入；迭代之外也不为它们单独提案。`,
    en: `## Leads (highest priority first)
${problemLead(input)}
2. The most important capability gaps from your gap analysis: plan them as an iteration (see "Planning an iteration" below), not as proposals of their own.
3. Obvious bugs and gaps in tests, places where README.md, AGENTS.md and the code disagree, TODOs in the code.
4. Review suggestions and polish of recent changes: no proposals of their own. The suggestions given by a review that passed are improvements the reviewer left for later on purpose; the closing step at the end of an iteration goes through them all, its content filled in by the Master before it starts. Outside an iteration, do not propose them on their own either.`,
  });
}

/** The only lead while an iteration is under way: problems, a blocked iteration included. */
function followingLeads(input: ScoutPromptInput): string {
  return t({
    zh: `## 线索
${problemLead(input)}进行中的迭代受阻（有子项失败或被关成不做）也算这一类：在下面「调整计划」里换个做法重新安排这一步；失败暴露出系统本身的问题时，再为它提一条提案。
能力缺口、明显的缺陷、评审建议和修饰这次都不提：能力缺口留给下一个迭代，评审建议由迭代的「收尾」子项整理。`,
    en: `## Leads
${problemLead(input)} An iteration under way that is blocked (a step failed or was dropped) belongs here too: plan that step again another way under "Changing the plan" below, and when the failure shows a problem of the system itself, propose a fix for that as well.
Leave capability gaps, obvious bugs, review suggestions and polish alone this time: capability gaps wait for the next iteration, and the iteration's closing step goes through the review suggestions.`,
  });
}

/** How to plan a new iteration, the main output while the repo has none under way. */
function planningSection(input: ScoutPromptInput, source: ScoutSource): string {
  const max = MAX_ITERATION_CHILDREN;
  return t({
    zh: `## 规划迭代
仓库现在没有进行中的迭代，这次的主要产出是一个新迭代，写进结果的 iteration：
- 从差距分析里选最重要的一个缺口，一次把整个迭代设计好。${takenGapText(source)}
- goal 用用户能感知的话写：做完之后，用户能做到以前做不到的什么事；readmeGoal 是它推进的 README.md 目标，一字不差地照抄原文。
- criteria 写怎样算做成了，一条一条写，最好每条都能演示；outOfScope 写有意不做的事，划清范围。
- children 是计划：按依赖排好的子项，数量按需要来，最多 ${max} 个；需要更多就缩小目标，剩下的留给下一个迭代。每个子项像一条提案那样写，另外写明 criteria（它推进第几条完成标准）和 dependsOn（它依赖的子项的序号，只能写排在它前面的）。子项按在 children 里的位置从 1 编号。没有依赖关系的子项会同时开工，所以只写真正的依赖。
- 每个子项都能单独合并，合并后系统照常可用，并且实际推进了这个迭代，不能只是空壳（比如只加了配置项、类型或接口，却没有实际行为）。
- ${stepSizeText(input.splits)}
- 最后一个子项是「收尾」：closeout 为 true，dependsOn 写上其余全部子项，用来整理本迭代各 Run 评审通过时留下的建议。建议的具体内容由 Master 在它开工前填入，what 里说明这一点就行。其余子项的 closeout 都是 false。
- ${autoAcceptText(input.autoAcceptsL)}
${nextStepsText(source)}
- 差距分析里没有值得规划成迭代的缺口时，iteration 写 null。`,
    en: `## Planning an iteration
The repo has no iteration under way, so your main output this time is a new one, in iteration of your answer:
- Take the most important gap from your gap analysis and design the whole iteration in one go. ${takenGapText(source)}
- Write goal in words users would use: what they can do once it is done that they could not before; readmeGoal is the goal of README.md it advances, copied word for word.
- In criteria, write how to tell it is done, one per item, ideally each something to demonstrate; in outOfScope, what it leaves out on purpose, to draw its bounds.
- children is the plan: its steps ordered by their dependencies, as many as it takes, at most ${max}; if it takes more, narrow the goal and leave the rest for the next iteration. Write each step like a proposal, and add criteria (which completion criteria it moves forward) and dependsOn (the numbers of the steps it depends on, only steps before it). Steps are numbered by their place in children, from 1. Steps that do not depend on each other start side by side, so list only real dependencies.
- Each step must be mergeable on its own, leave the system working as usual once merged, and actually advance the iteration, not be an empty shell (for example a config option, a type or an interface without any real behavior).
- ${stepSizeText(input.splits)}
- The last step is the closing step: closeout true, and dependsOn listing every other step; it goes through the suggestions reviews left when the iteration's Runs passed. The Master fills in the suggestions before it starts, so what only needs to say so. Every other step has closeout false.
- ${autoAcceptText(input.autoAcceptsL)}
${nextStepsText(source)}
- If your gap analysis found no gap worth an iteration, set iteration to null.`,
  });
}

/** The proposals besides a new iteration: problems and obvious bugs only. */
function planningProposals(input: ScoutPromptInput): string {
  return t({
    zh: `## 迭代之外的提案
需要马上处理、不能等进迭代的问题写进结果的 proposals，lead 写它属于哪一类线索：
- 只提第 1 类问题（lead 为 problem）和第 3 类明显的缺陷（lead 为 defect）。第 1 类优先：有就先提；条数上限放不下时，以第 1 类为先。
- 能力缺口规划进迭代，不单独提案；也不提评审建议和修饰。
- 最多 ${input.max} 条，宁缺毋滥；没有值得提的就返回空列表。同一类里价值高的在前。
- 每条要能独立完成、独立合并，一个 Run 能做完。`,
    en: `## Proposals outside the iteration
Problems that need attention right away and cannot wait for an iteration go in proposals of your answer, with lead saying which lead each follows:
- Propose only problems of lead 1 (lead problem) and obvious bugs of lead 3 (lead defect). Lead 1 comes first: propose those before anything else, and when the limit leaves no room for more, they take it.
- Capability gaps are planned as an iteration, not proposed on their own; do not propose review suggestions or polish either.
- At most ${input.max}, and only ones that are worth it; return an empty list if nothing is. The more valuable first within each lead.
- Each proposal must be doable and mergeable on its own, within one Run.`,
  });
}

/** The iteration under way, its digest (`iterationDigest`) as the scout reads it. */
function openIterationSection(digest: string): string {
  return t({
    zh: `## 进行中的迭代
下面是这个仓库进行中的迭代：目标、完成标准、各子项的状态和它们的 Run。子项按计划里的序号列出，调整计划时用这些序号。
${digest}`,
    en: `## The iteration under way
The repo's iteration under way: its goal, completion criteria, and where each step stands with its Runs. Steps are listed by their numbers in the plan; a change to the plan refers to them by these numbers.
${digest}`,
  });
}

/** How to judge whether the plan of the iteration under way changes, and how to change it. */
function changingPlanSection(source: ScoutSource): string {
  const max = MAX_ITERATION_CHILDREN;
  return t({
    zh: `## 调整计划
根据已经做完的子项和它们的 Run，判断迭代的计划要不要调整。要调整就写进结果的 iterationUpdate；不用调整就写 null，不要为调整而调整：
- 有子项失败或被关成不做、迭代因此受阻时，换个做法重新安排这一步：在 add 里写一个新子项，replaces 写被换掉的子项的序号。新做法要针对失败原因（比如拆小、先补上缺的能力、换一种做法），在 why 里说明和上次的不同。
- 做完的子项暴露出计划漏掉的一步时，在 add 里补上它，replaces 写 null。
- 新子项接在计划里现有的最大序号后面编号；dependsOn 用计划里的序号，只能写排在它前面的，不要写收尾子项：收尾子项会等新加的子项都做完再开工。criteria 写它推进第几条完成标准。
- 加上新子项、去掉被换掉的之后，计划里最多 ${max} 个子项。
- note 写为什么这样调整，${noteFate(source)}`,
    en: `## Changing the plan
Judge from the steps done so far and their Runs whether the iteration's plan needs to change. If it does, put the change in iterationUpdate of your answer; otherwise set it to null, and do not change the plan for the sake of it:
- When a step failed or was dropped and the iteration is blocked by it, plan that step again another way: add a new step in add, with replaces set to the number of the step it replaces. The new approach must address why the old one failed (e.g. split it up, first add a missing capability, do it another way); say in why what is different this time.
- When the steps done so far show a step the plan missed, add it in add, with replaces set to null.
- New steps are numbered on from the plan's highest number; dependsOn uses numbers in the plan, only of steps before it, and never the closing step: the closing step waits until the steps added are done. criteria says which completion criteria it moves forward.
- With the new steps added and the replaced ones left out, the plan has at most ${max} steps.
- In note, say why the plan changes; ${noteFate(source)}`,
  });
}

/** The proposals while an iteration is under way: problems only. */
function followingProposals(input: ScoutPromptInput): string {
  return t({
    zh: `## 提案
- 写进结果的 proposals 只放第 1 类问题，lead 都是 problem；最多 ${input.max} 条，宁缺毋滥，没有就返回空列表。
- 迭代进行中不规划新的迭代（iteration 写 null），不提迭代之外的能力需求，也不单独提明显的缺陷、评审建议或修饰：这些都会被丢掉。
- 每条要能独立完成、独立合并，一个 Run 能做完。`,
    en: `## Proposals
- Put only problems of lead 1 in proposals of your answer, each with lead problem; at most ${input.max}, and only ones that are worth it; return an empty list if nothing is.
- While the iteration is under way, plan no new iteration (set iteration to null), propose no capability outside it, and propose no obvious bugs, review suggestions or polish on their own: all of these are dropped.
- Each proposal must be doable and mergeable on its own, within one Run.`,
  });
}

function requirementsSection(source: ScoutSource): string {
  return t({
    zh: `## 要求
- 子项和提案都要有能核对的证据：Run id、文件:行号、README 或 AGENTS.md 中的段落。补能力的不需要有出错的 Run：README.md 里的目标加上限制这个能力的代码位置就是证据。拿不出证据的不要提。
${duplicatesText(source)}
${failedRequirementsText(source)}
- risk 的含义：
  - low：只涉及文档、测试、看板展示，或不改变行为的重构；
  - mid：改变行为，但影响范围清楚；
  - high：涉及数据库迁移、合并或回滚等 git 操作、Agent 权限、配置格式、对外发布，或者改动 .ares1/ 下的文件（仓库自己的开发流程）。
- 用中文写。不要写本机的绝对路径，也不要写任何个人信息。`,
    en: `## Requirements
- Every step and proposal needs verifiable evidence: Run ids, file:line, passages of README or AGENTS.md. Adding a capability needs no failed Run: a goal in README.md together with where the code limits the capability is evidence. Do not propose anything you cannot back with evidence.
${duplicatesText(source)}
${failedRequirementsText(source)}
- What risk means:
  - low: only documentation, tests, how the dashboard shows things, or refactoring without behavior change;
  - mid: changes behavior, with a clear scope;
  - high: database migrations, git operations such as merging or rollback, agent permissions, the configuration format, publishing anything outside, or changes to files under .ares1/ (the repo's own development workflow).
- Write in English. Do not write absolute paths of this machine or any personal information.`,
  });
}
