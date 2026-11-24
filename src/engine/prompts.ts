import { brandName } from '../brand.js';
import { difficultyMeanings, PROPOSAL_SIZES, sizeMeanings } from '../config/flow.js';
import type { AgentConfig, StageDef } from '../config/schema.js';
import { join, t } from '../i18n.js';
import {
  type AssessmentEntry,
  DIFFICULTIES,
  type DiscussionEntry,
  type FailedAttempt,
  type ReplyTimeoutEntry,
} from '../store/types.js';
import { MAX_PLAN_TASKS } from './contracts.js';
import {
  assessmentRounds,
  conclusionLabel,
  formatAssessment,
  formatReplyTimeout,
  hasHumanReply,
  pendingTimeout,
  verdictLabel,
  waitText,
} from './discussion.js';

export interface PromptContext {
  goal: string;
  stage: StageDef;
  /** Named inputs, e.g. an earlier stage's output. */
  inputs: { name: string; content: string }[];
  /** Why this stage round exists (rolled back from a later stage / rejected). */
  stageFeedback: string | null;
  verifyCommands: string[];
  /** Earlier Runs of the same issue that failed, oldest first; this Run redoes them. */
  earlierAttempts?: readonly FailedAttempt[];
}

/** How much of each earlier failure's error goes into a prompt. */
const MAX_EARLIER_ERROR = 2000;

/**
 * The earlier attempts at the same requirement and why they failed, so this one avoids the same
 * problems. The assessment is also asked to say how; its summary reaches coding and review.
 */
function earlierAttemptsSection(
  earlier: readonly FailedAttempt[] | undefined,
  role: 'assess' | 'task',
): string {
  if (!earlier || earlier.length === 0) return '';
  const n = earlier.length;
  const advice =
    role === 'assess'
      ? t({
          zh: '评估时想清楚这些失败的原因：需求本身有问题就指出来；需要换个做法才能避开，就把做法写进 summary，编码和评审会读到。',
          en: 'When assessing, work out why these attempts failed: if the requirement itself is the problem, say so; if another approach avoids the failures, write it in summary, which coding and review read.',
        })
      : t({
          zh: '动手前先想清楚这些失败的原因，换个做法避开同样的问题。',
          en: 'Before you start, work out why these attempts failed, and take an approach that avoids the same problems.',
        });
  const entries = earlier.map((f) => {
    const error =
      f.error.length > MAX_EARLIER_ERROR ? `${f.error.slice(0, MAX_EARLIER_ERROR)}…` : f.error;
    const head = t({
      zh: `### 第 ${f.attempt} 次（Run ${f.runId}${f.stage ? `，失败在「${f.stage}」阶段` : ''}）`,
      en: `### Attempt ${f.attempt} (Run ${f.runId}${f.stage ? `, failed in the "${f.stage}" stage` : ''})`,
    });
    return `${head}\n\n${error.trim()}`;
  });
  const intro = t({
    zh: `这个需求之前已经做过 ${n} 次，都失败了，这是第 ${n + 1} 次。每次失败的原因如下。${advice}`,
    en: `This requirement was attempted ${n === 1 ? 'once' : `${n} times`} before, and ${n === 1 ? 'it' : 'each'} failed; this is attempt ${n + 1}. Why each one failed is below. ${advice}`,
  });
  const heading = t({ zh: '## 之前的尝试', en: '## Earlier attempts' });
  return `${heading}\n\n${intro}\n\n${entries.join('\n\n')}\n\n`;
}

type AgentPermission = AgentConfig['permission'];

function taskReportFormat(): string {
  return t({
    zh: `## 输出格式

最后一条回复以一个 JSON 代码块结束：

\`\`\`json
{"status": "done", "summary": "一两句话说明做了什么"}
\`\`\`

- status 为 "done" 表示已完成；无法完成时为 "incomplete"，并在 summary 中说明原因。
- summary 用中文书写。`,
    en: `## Output format

End your last reply with a JSON code block:

\`\`\`json
{"status": "done", "summary": "one or two sentences on what you did"}
\`\`\`

- status is "done" when the task is complete; "incomplete" when it cannot be completed, with the reason in summary.
- Write the summary in English.`,
  });
}

function fill(template: string, goal: string): string {
  return template.replaceAll('{{goal}}', goal);
}

function inputsSection(inputs: PromptContext['inputs']): string {
  if (inputs.length === 0) return '';
  const heading = t({ zh: '## 参考资料', en: '## References' });
  return `${heading}\n\n${inputs.map((i) => `### ${i.name}\n\n${i.content}`).join('\n\n')}\n\n`;
}

/**
 * What the agent may do under its permission. Any denied operation fails the attempt and costs a
 * rework (see `resultProblem`), so the prompt says so up front.
 */
function permissionRules(permission: AgentPermission): string {
  if (permission === 'safe') {
    return t({
      zh: '- 你只能修改文件，不能执行命令（包括运行测试、构建和 git 命令）；执行命令会被拒绝，有操作被拒绝时这次结果不算通过，要返工。\n',
      en: '- You may only edit files, not run commands (including tests, builds and git commands); commands are denied, and when any operation is denied this result does not pass and has to be reworked.\n',
    });
  }
  return t({
    zh: "- 改文件请直接用编辑文件的工具，不要通过命令行运行内联脚本（例如 `python3 - <<'EOF'`、`node -e`、`sed -i`）来改文件或批量替换。这类命令可能被权限模式拒绝，有操作被拒绝时这次结果不算通过，要返工。\n",
    en: "- Edit files with the file-editing tools directly; do not change files or replace text in bulk by running inline scripts on the command line (such as `python3 - <<'EOF'`, `node -e`, `sed -i`). Such commands may be denied by the permission mode, and when any operation is denied this result does not pass and has to be reworked.\n",
  });
}

/**
 * Everything the agent should know from GitHub is in its prompt, filtered by who wrote it; reading
 * issues itself would bring back what people the Master does not trust wrote. Agents get no
 * GitHub credentials either (`agentEnv`).
 */
function noGitHubRule(): string {
  return t({
    zh: '- 需求、讨论和 issue 的内容都已经写在这里，不要自己去 GitHub 读 issue 或评论（比如运行 `gh issue view`）。这里没有 GitHub 的登录凭据，这类命令也会失败。\n',
    en: '- The requirement, the discussion and what the issue says are all here already; do not read issues or comments on GitHub yourself (with `gh issue view`, for example). There are no GitHub credentials here, so such commands fail anyway.\n',
  });
}

/**
 * A merge the Master started in the worktree for the agent to finish: of the target branch's
 * latest commit, after merging the Run into it conflicted (`target`), or of a commit of the target
 * branch on GitHub that a Run the Master created for it merges in (`remote`).
 */
export interface MergeInProgress {
  source: 'target' | 'remote';
  /** The target branch's name. */
  target: string;
  /** The commit being merged in (MERGE_HEAD). */
  targetHead: string;
  /** Files that conflicted; empty when everything merged cleanly. */
  files: string[];
}

/** What a merge brings in, as prompts and checks name it. */
export function mergeSubject(merge: Pick<MergeInProgress, 'source' | 'target' | 'targetHead'>) {
  if (merge.source === 'target') return merge.target;
  const short = merge.targetHead.slice(0, 7);
  return t({
    zh: `GitHub 上 ${merge.target} 的提交 ${short}`,
    en: `commit ${short} from ${merge.target} on GitHub`,
  });
}

function mergeSection(merge: MergeInProgress | undefined): string {
  if (!merge) return '';
  if (merge.source === 'remote') return remoteMergeSection(merge);
  const files = merge.files.map((f) => `- \`${f}\``).join('\n');
  const conflicts =
    merge.files.length > 0
      ? t({
          zh: `下面这些文件有冲突，冲突的地方用 \`<<<<<<<\`、\`=======\`、\`>>>>>>>\` 标出来了：\n\n${files}\n\n解决每一处冲突：同时保留 ${merge.target} 的改动和本需求的改动，把两边的意图合在一起，并删掉所有冲突标记。冲突标记没清干净的话，这次结果不算通过，要返工。`,
          en: `These files have conflicts, marked with \`<<<<<<<\`, \`=======\` and \`>>>>>>>\`:\n\n${files}\n\nResolve every conflict: keep both the changes of ${merge.target} and those of this requirement, bringing together what each side meant, and remove every conflict marker. If any conflict marker is left, this result does not pass and has to be reworked.`,
        })
      : t({
          zh: `这次合并没有冲突，但 ${merge.target} 的新代码可能和本需求的改动配合不上，需要时一起调整。`,
          en: `This merge has no conflicts, but the new code of ${merge.target} may not fit the changes of this requirement; adjust them together where needed.`,
        });
  return t({
    zh: `## 未完成的合并

本需求的分支在合并进 ${merge.target} 时冲突了。Master 已经在工作目录里开始合并 ${merge.target} 的最新代码（git merge --no-commit），还没有提交。${conflicts}

- 不要执行 git commit、git merge --abort、git reset，也不要用 git checkout 丢掉哪一边的改动；改好文件就行，合并提交由 Master 完成。

`,
    en: `## A merge in progress

This requirement's branch conflicted when it was to be merged into ${merge.target}. The Master has started merging the latest code of ${merge.target} in the working directory (git merge --no-commit), without committing it. ${conflicts}

- Do not run git commit, git merge --abort or git reset, and do not throw away either side's changes with git checkout; just fix the files, and the Master makes the merge commit.

`,
  });
}

/** `mergeSection` for a Run that merges a commit of the target branch on GitHub. */
function remoteMergeSection(merge: MergeInProgress): string {
  const subject = mergeSubject(merge);
  const files = merge.files.map((f) => `- \`${f}\``).join('\n');
  const conflicts =
    merge.files.length > 0
      ? t({
          zh: `下面这些文件有冲突，冲突的地方用 \`<<<<<<<\`、\`=======\`、\`>>>>>>>\` 标出来了：\n\n${files}\n\n解决每一处冲突：两边的改动都要保留，本地 ${merge.target} 上的和 GitHub 上的都不能丢，把两边的意图合在一起，并删掉所有冲突标记。冲突标记没清干净的话，这次结果不算通过，要返工。`,
          en: `These files have conflicts, marked with \`<<<<<<<\`, \`=======\` and \`>>>>>>>\`:\n\n${files}\n\nResolve every conflict: keep the changes of both sides, those of the local ${merge.target} and those from GitHub, bringing together what each side meant, and remove every conflict marker. If any conflict marker is left, this result does not pass and has to be reworked.`,
        })
      : t({
          zh: '这次合并没有冲突，但合并后的代码通不过检查：两边的改动可能配合不上。修改代码，让两边的改动都保留下来，并且能一起工作。',
          en: 'This merge has no conflicts, but the merged code fails the checks: the changes of the two sides may not fit together. Change the code so that the changes of both sides stay and work together.',
        });
  return t({
    zh: `## 未完成的合并

这个 Run 要把 ${subject} 合并进本地的 ${merge.target}：两边已经分叉，Master 自己合并没有成功。Master 已经在工作目录里开始合并这个提交（git merge --no-ff --no-commit），还没有提交。${conflicts}

合并后，检查命令要能通过。

- 不要执行 git commit、git merge --abort、git reset，也不要用 git checkout 丢掉哪一边的改动；改好文件就行，合并提交由 Master 完成。

`,
    en: `## A merge in progress

This Run merges ${subject} into the local ${merge.target}: the two have diverged, and the Master could not merge them by itself. The Master has started merging that commit in the working directory (git merge --no-ff --no-commit), without committing it. ${conflicts}

After the merge, the check commands must pass.

- Do not run git commit, git merge --abort or git reset, and do not throw away either side's changes with git checkout; just fix the files, and the Master makes the merge commit.

`,
  });
}

/**
 * Characters kept of the summary of each step a prompt lists: enough for what the step did and
 * the choices it made, while a plan of many steps keeps the prompt bounded.
 */
const MAX_STEP_SUMMARY = 400;

/** `text` trimmed, cut to `max` characters with an ellipsis. */
function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max).trimEnd()}…` : trimmed;
}

/** The summary a step's agent reported, cut to size, as listed with the step; '' when none. */
function stepResult(summary: string | null): string {
  if (!summary?.trim()) return '';
  const text = clip(summary, MAX_STEP_SUMMARY);
  return t({ zh: `结果：${text}`, en: `Result: ${text}` });
}

/** One step of a stage round's plan, with what came of it so far. */
export interface StepOutcome {
  title: string;
  /**
   * The summary of the step's last passing attempt, as its agent wrote it; null when the step
   * has not passed or said nothing.
   */
  summary: string | null;
}

/** A work task of a stage its plan split into steps (`planning: llm`): which step it is. */
export interface PlannedStep {
  /** Position among the plan's tasks, from 1. */
  index: number;
  /** How many steps the plan has. */
  total: number;
  /** All the plan's steps, in order; the ones before this step carry their summaries. */
  steps: StepOutcome[];
  /** What the plan says this step does. */
  instructions: string;
}

function stepSection(step: PlannedStep | undefined): string {
  if (!step) return '';
  const { total } = step;
  const title = step.steps[step.index - 1]?.title ?? '';
  const plan = step.steps
    .map((s, i) => {
      const n = i + 1;
      const head = `${n}. ${s.title}`;
      if (n < step.index) {
        // Indented under its item, every line of it, so a multi-line summary stays there.
        const result = stepResult(s.summary).replaceAll('\n', '\n   ');
        return `${head}${t({ zh: '（已完成）', en: ' (done)' })}${result ? `\n   ${result}` : ''}`;
      }
      if (n === step.index) return `${head}${t({ zh: ' ← 这一步', en: ' ← this step' })}`;
      return head;
    })
    .join('\n');
  return t({
    zh: `## 这一步：第 ${step.index} 步（共 ${total} 步）「${title}」

这个阶段的工作已经拆成按顺序执行的几步，每一步单独检查、单独提交。这次只做这一步：

${step.instructions.trim()}

整个计划：

${plan}

- 前面的步骤已经完成并提交，在它们的基础上继续。每一步下面的「结果」是做那一步的 Agent 完成后写的 summary，从中可以知道它实际做了什么、做了哪些取舍。
- 后面的步骤由之后的 Task 完成，现在不要做。
- 这一步做完后代码要处在可用的状态：能构建，检查能通过。

`,
    en: `## This step: step ${step.index} of ${total}, "${title}"

The work of this stage has been split into steps executed in order, each checked and committed on its own. This time, do only this step:

${step.instructions.trim()}

The whole plan:

${plan}

- The steps before this one are done and committed; build on them. The "Result" under each of them is the summary its agent wrote when done: what the step actually did and the choices it made.
- The steps after this one are left to later tasks; do not do them now.
- When this step is done, the code must be in a working state: it builds and the checks pass.

`,
  });
}

/**
 * First prompt of a task in an agent stage (or any attempt that starts a new session).
 * @param permission the running agent's permission: a "safe" agent cannot run commands, so it is
 *   not told to run the verify commands itself.
 * @param merge a merge of the target branch the Master started for the agent to resolve.
 * @param step the task's step when the stage's plan split it into several (`planning: llm`).
 */
export function taskPrompt(
  ctx: PromptContext,
  feedback: string | null,
  permission: AgentPermission,
  merge?: MergeInProgress,
  step?: PlannedStep,
): string {
  const stageName = ctx.stage.name ?? ctx.stage.id;
  const instructions = ctx.stage.instructions ? fill(ctx.stage.instructions, ctx.goal).trim() : '';
  const commands = join(ctx.verifyCommands.map((c) => `\`${c}\``));
  const checks =
    ctx.verifyCommands.length === 0
      ? ''
      : permission === 'safe'
        ? t({
            zh: `- 检查命令由 Master 在你完成后运行，全部通过才算完成：${commands}。你不需要也不能自己运行。\n`,
            en: `- The Master runs the verify commands after you finish, and the task is complete only when all of them pass: ${commands}. You need not and cannot run them yourself.\n`,
          })
        : t({
            zh: `- 完成后 Master 会运行以下检查命令，全部通过才算完成：${commands}。你可以先自己运行确认。\n`,
            en: `- When you finish, the Master runs these verify commands, and the task is complete only when all of them pass: ${commands}. You may run them yourself first to check.\n`,
          });
  const stageFeedback = ctx.stageFeedback
    ? t({
        zh: `## 上一轮被打回的原因\n\n${ctx.stageFeedback}\n\n`,
        en: `## Why the previous round was sent back\n\n${ctx.stageFeedback}\n\n`,
      })
    : '';
  const lastFeedback = feedback
    ? t({
        zh: `## 上一次尝试没有通过验收\n\n${feedback}\n\n`,
        en: `## The previous attempt did not pass\n\n${feedback}\n\n`,
      })
    : '';
  const rest = `${stepSection(step)}${inputsSection(ctx.inputs)}${earlierAttemptsSection(ctx.earlierAttempts, 'task')}${stageFeedback}${mergeSection(merge)}${lastFeedback}`;
  return t({
    zh: `你是${brandName()}调度的开发 Agent，正在仓库的一个独立工作目录（git worktree）中工作。

## 目标

${ctx.goal}

## 当前阶段：${stageName}

${instructions || '完成上面的目标。'}

${rest}## 要求

- 直接修改当前目录中的文件来完成任务。
- 不要执行 git commit、git push，也不要切换分支；提交由 Master 负责。
${noGitHubRule()}${permissionRules(permission)}${checks}
${taskReportFormat()}
`,
    en: `You are a development agent scheduled by ${brandName()}, working in a separate working directory of the repository (a git worktree).

## Goal

${ctx.goal}

## Current stage: ${stageName}

${instructions || 'Accomplish the goal above.'}

${rest}## Requirements

- Complete the task by editing the files in the current directory.
- Do not run git commit or git push, and do not switch branches; the Master makes the commits.
${noGitHubRule()}${permissionRules(permission)}${checks}
${taskReportFormat()}
`,
  });
}

/** Prompt for a rework attempt that resumes the previous session. */
export function reworkPrompt(feedback: string): string {
  return t({
    zh: `上一次的结果没有通过验收，请在当前改动的基础上继续修改。

## 问题

${feedback}

${taskReportFormat()}
`,
    en: `The previous result did not pass. Keep working on top of the current changes.

## Problems

${feedback}

${taskReportFormat()}
`,
  });
}

/** A step of the previous round of a stage, as the next round's plan reads it. */
export interface PreviousStep extends StepOutcome {
  /** What the plan said the step does; null when the round was not planned (the whole stage). */
  instructions: string | null;
  passed: boolean;
}

/**
 * The previous round of a stage with `planning: llm`, handed to the plan of the round after it
 * was sent back, so that the new plan only lists what has to change.
 */
export interface PreviousPlan {
  round: number;
  /** Its steps in order; a round that was not planned is its one task. */
  steps: PreviousStep[];
}

function previousPlanSection(previous: PreviousPlan | undefined): string {
  if (!previous || previous.steps.length === 0) return '';
  const n = previous.steps.length;
  const steps = previous.steps
    .map((s, i) => {
      const head = s.passed
        ? t({
            zh: `### 第 ${i + 1} 步：${s.title}（已通过）`,
            en: `### Step ${i + 1}: ${s.title} (passed)`,
          })
        : t({
            zh: `### 第 ${i + 1} 步：${s.title}（未通过）`,
            en: `### Step ${i + 1}: ${s.title} (did not pass)`,
          });
      const result = stepResult(s.summary);
      return [head, s.instructions?.trim(), result].filter(Boolean).join('\n\n');
    })
    .join('\n\n');
  // A step that did not pass may have been left uncommitted or rolled back (a failed command
  // stage, say), so the plan must not assume its changes are there.
  const failed = previous.steps.some((s) => !s.passed)
    ? t({
        zh: '未通过的步骤的改动不一定还在工作目录里：可能没有提交，也可能已经回滚，要以当前代码为准。',
        en: ' The changes of steps that did not pass may not be in the working directory: they may be uncommitted or rolled back, so go by the current code.',
      })
    : '';
  return t({
    zh: `## 上一轮的计划（第 ${previous.round} 轮）

这个阶段上一轮的计划共 ${n} 步，下面是每一步的说明、是否通过，以及做完后写的 summary（「结果」）。通过的步骤都已经提交，它们的改动都还在工作目录里：这一轮在这些代码的基础上修改，不是从头再做。${failed}

${steps}

这一轮只列出这次需要做的修改步骤：改正被打回的问题，补上没通过的步骤。已经通过、和打回原因无关的步骤不要重做，也不要再列进计划；要改的地方不多时只给一步。

`,
    en: `## The previous round's plan (round ${previous.round})

This stage's previous round had a plan of ${n === 1 ? 'one step' : `${n} steps`}. Below are each step's instructions, whether it passed, and the summary written when it was done ("Result"). The steps that passed are committed, and their changes are all still in the working directory: this round changes that code; it does not start over.${failed}

${steps}

In this round, list only the steps of the changes needed now: fixing the problems the round was sent back for, and finishing the steps that did not pass. Do not redo the steps that passed and have nothing to do with why the round was sent back, and do not list them in the plan again; when little has to change, give a single step.

`,
  });
}

/**
 * Prompt of a stage's plan (`planning: llm`): a read-only agent splits the stage into ordered
 * steps, each executed, checked and committed on its own (`PlanReportSchema`).
 * @param feedback what was wrong with the previous plan (its format, say), or a human's note.
 * @param previous from round 2 on, the stage's previous round step by step.
 */
export function planPrompt(
  ctx: PromptContext,
  feedback: string | null,
  previous?: PreviousPlan,
): string {
  const stageName = ctx.stage.name ?? ctx.stage.id;
  const instructions = ctx.stage.instructions ? fill(ctx.stage.instructions, ctx.goal).trim() : '';
  const requirements = instructions
    ? t({
        zh: `## 阶段要求\n\n${instructions}\n\n`,
        en: `## Stage instructions\n\n${instructions}\n\n`,
      })
    : '';
  const stageFeedback = ctx.stageFeedback
    ? t({
        zh: `## 上一轮被打回的原因\n\n这个阶段上一轮的工作被打回了，这一轮重新拆分。计划要覆盖下面的每一条问题：\n\n${ctx.stageFeedback}\n\n`,
        en: `## Why the previous round was sent back\n\nThis stage's previous round was sent back, and this round is planned anew. The plan must cover every problem below:\n\n${ctx.stageFeedback}\n\n`,
      })
    : '';
  const lastFeedback = feedback
    ? t({
        zh: `## 上一次拆分没有完成\n\n${feedback}\n\n`,
        en: `## The previous plan did not complete\n\n${feedback}\n\n`,
      })
    : '';
  const commands = join(ctx.verifyCommands.map((c) => `\`${c}\``));
  const checks =
    ctx.verifyCommands.length > 0
      ? t({
          zh: `Master 运行检查命令（${commands}），全部通过后单独提交`,
          en: `the Master runs the verify commands (${commands}) and commits it on its own once all of them pass`,
        })
      : t({ zh: 'Master 单独提交', en: 'the Master commits it on its own' });
  const rest = `${requirements}${inputsSection(ctx.inputs)}${earlierAttemptsSection(ctx.earlierAttempts, 'task')}${stageFeedback}${previousPlanSection(previous)}${lastFeedback}`;
  return t({
    zh: `你是${brandName()}的「任务拆分」Agent。阶段「${stageName}」开始之前，先把下面的目标拆成按顺序执行的几步。你只能读文件和搜索，不能修改任何文件，也不能执行命令。

## 目标

${ctx.goal}

${rest}## 怎么拆

- 先读 README.md 和 AGENTS.md（有 CLAUDE.md 的也读），了解项目的约定，再读和目标相关的代码，弄清要改哪些地方。
- 按依赖顺序排列：后面的步骤可以用前面步骤的成果，前面的步骤不能依赖后面的。
- 每一步由一个开发 Agent 单独完成，完成后 ${checks}。所以每一步做完，代码都要能构建、检查都能通过，不能留下半截的改动；测试和它覆盖的代码放在同一步。
- 每一步要小到一个 Agent 一次能做完，又要大到值得单独检查和提交。需求本来就小时只给一步，不要硬拆。最多 ${MAX_PLAN_TASKS} 步。
- title 是这一步的一句话标题；instructions 写清这一步要做什么、改哪些文件或模块、怎样算做完。做这一步的 Agent 会读到目标、阶段要求和整个计划，instructions 里不用重复它们。
${noGitHubRule()}
## 输出格式

最后一条回复以一个 JSON 代码块结束：

\`\`\`json
{"tasks": [{"title": "这一步的标题", "instructions": "这一步要做什么、怎样算做完"}]}
\`\`\`

- tasks 按执行顺序排列，1 到 ${MAX_PLAN_TASKS} 项。
- title 和 instructions 用中文书写。
`,
    en: `You are the planning agent of ${brandName()}. Before the stage "${stageName}" starts, split the goal below into steps executed in order. You may only read files and search; you may not modify any file or run commands.

## Goal

${ctx.goal}

${rest}## How to split

- First read README.md and AGENTS.md (and CLAUDE.md if there is one) to learn the project's conventions, then read the code related to the goal to work out what has to change.
- Order the steps by their dependencies: a later step may build on the earlier ones, an earlier step may not depend on a later one.
- A development agent does each step on its own, after which ${checks}. So after every step the code must build and the checks must pass, with no half-done changes left; tests go in the same step as the code they cover.
- Make each step small enough for one agent to finish in one go, and big enough to be worth checking and committing on its own. When the requirement is small to begin with, give a single step; do not split it for the sake of it. At most ${MAX_PLAN_TASKS} steps.
- title is a one-line title of the step; instructions say what the step does, which files or modules it changes and when it is done. The agent doing the step reads the goal, the stage instructions and the whole plan, so instructions need not repeat them.
${noGitHubRule()}
## Output format

End your last reply with a JSON code block:

\`\`\`json
{"tasks": [{"title": "the step's title", "instructions": "what the step does and when it is done"}]}
\`\`\`

- tasks are in the order they are executed, 1 to ${MAX_PLAN_TASKS} of them.
- Write title and instructions in English.
`,
  });
}

/** The review of this stage's previous round, handed to the next round's reviewer. */
export interface PreviousReview {
  round: number;
  text: string;
}

function previousReviewSection(previous: PreviousReview | undefined): string {
  if (!previous) return '';
  return t({
    zh: `## 上一轮评审的意见（第 ${previous.round} 轮）

上一轮评审提出了以下意见，编码阶段已经据此返工：

${previous.text.trim()}

请先逐条确认上一轮的「必须修改」是否已经解决：
- 没有解决的，继续列为 must；
- 已经解决的，不要再提；
- 在 summary 中说明上一轮的问题各自是否已解决。

确认完之后，再照常评审全部改动。

`,
    en: `## The previous review (round ${previous.round})

The previous review raised the following, and the coding stage has reworked accordingly:

${previous.text.trim()}

First check, one by one, whether the previous round's must-fix issues are resolved:
- unresolved ones stay listed as must;
- resolved ones are not raised again;
- say in summary whether each of the previous round's issues is resolved.

After that, review all the changes as usual.

`,
  });
}

/**
 * @param passedCommands verify commands that already passed on the code under review; the
 *   reviewer does not need to run them again.
 * @param previousReview from round 2 on, the previous round's review, so the reviewer first
 *   checks whether its must-fix issues were resolved.
 */
export function reviewPrompt(
  ctx: PromptContext,
  baseCommit: string,
  diffStat: string,
  passedCommands: string[] = [],
  previousReview?: PreviousReview,
): string {
  const instructions = ctx.stage.instructions ? fill(ctx.stage.instructions, ctx.goal).trim() : '';
  const passed = join(passedCommands.map((c) => `\`${c}\``));
  const checks =
    passedCommands.length > 0
      ? t({
          zh: `## 已通过的检查\n\nMaster 已经在当前代码上运行了以下检查命令，全部通过：${passed}。不需要重复运行它们，评审意见里也不要写「未运行」；需要验证某个具体行为时，可以只运行相关的单个测试。\n\n`,
          en: `## Checks that passed\n\nThe Master has already run these verify commands on the current code, and all of them passed: ${passed}. Do not run them again, and do not write "not run" in the review; to verify a specific behavior, you may run just the relevant single test.\n\n`,
        })
      : '';
  const requirements = instructions
    ? t({
        zh: `## 评审要求\n\n${instructions}\n\n`,
        en: `## Review instructions\n\n${instructions}\n\n`,
      })
    : '';
  const notes = ctx.stageFeedback
    ? t({
        zh: `## 补充说明\n\n${ctx.stageFeedback}\n\n`,
        en: `## Additional notes\n\n${ctx.stageFeedback}\n\n`,
      })
    : '';
  const rest = `${previousReviewSection(previousReview)}${checks}${inputsSection(ctx.inputs)}${notes}`;
  return t({
    zh: `你是${brandName()}调度的代码评审 Agent。请评审当前分支相对基线 commit ${baseCommit} 的全部改动（可以运行 \`git diff ${baseCommit}...HEAD\` 查看），判断改动是否达成目标、是否存在缺陷。

## 目标

${ctx.goal}

${requirements}## 改动概览

\`\`\`
${diffStat || '（没有改动）'}
\`\`\`

${rest}## 规则

- 只评审，不要修改任何文件，也不要执行 git commit 或 git push。
${noGitHubRule()}- 问题分两级：
  - must（必须修改）：只限以下情况——没有达成目标；有缺陷或破坏了已有功能；改动的行为缺少测试；违反仓库 AGENTS.md 中的约定。
  - suggestion（建议）：其他可以改进的地方，包括超出目标范围的改进、边缘情况的打磨、风格偏好。这些不影响合并，不要要求扩大改动范围。
- 没有问题时 issues 为空数组。
- summary 和每条问题的 description 都用中文书写。

## 输出格式

最后一条回复以一个 JSON 代码块结束：

\`\`\`json
{"summary": "总体评价", "issues": [{"severity": "must", "file": "src/x.ts", "description": "问题和修改建议"}]}
\`\`\`
`,
    en: `You are a code review agent scheduled by ${brandName()}. Review all the changes of the current branch against the base commit ${baseCommit} (run \`git diff ${baseCommit}...HEAD\` to see them), and judge whether they achieve the goal and whether they have defects.

## Goal

${ctx.goal}

${requirements}## Changes at a glance

\`\`\`
${diffStat || '(no changes)'}
\`\`\`

${rest}## Rules

- Only review; do not modify any file, and do not run git commit or git push.
${noGitHubRule()}- Issues come in two levels:
  - must (has to be fixed): only when the goal is not achieved; there is a defect or existing functionality is broken; changed behavior lacks tests; the repository's AGENTS.md conventions are violated.
  - suggestion: anything else that could be better, including improvements beyond the goal, polishing edge cases and style preferences. These do not block the merge; do not ask to widen the scope of the change.
- When there are no issues, issues is an empty array.
- Write summary and every issue's description in English.

## Output format

End your last reply with a JSON code block:

\`\`\`json
{"summary": "overall assessment", "issues": [{"severity": "must", "file": "src/x.ts", "description": "the problem and how to fix it"}]}
\`\`\`
`,
  });
}

// ---------------------------------------------------------------------------
// Requirement assessment
// ---------------------------------------------------------------------------

const numbered = (items: string[]) => items.map((q, i) => `${i + 1}. ${q}`).join('\n');
const bulleted = (items: string[]) => items.map((q) => `- ${q}`).join('\n');

/**
 * The discussion so far, oldest first, as the assessor and the later stages read it.
 * @param level heading level of each entry, to fit where it is embedded.
 */
export function formatDiscussion(discussion: readonly DiscussionEntry[], level = 3): string {
  const h = '#'.repeat(level);
  let round = 0;
  return discussion
    .map((e) => {
      if (e.role === 'human') {
        const head =
          e.source === 'issue'
            ? t({ zh: '人的回复（issue 上）', en: 'Human reply (on the issue)' })
            : t({ zh: '人的回复（看板上）', en: 'Human reply (on the dashboard)' });
        return `${h} ${head}\n\n${e.text.trim()}`;
      }
      if (e.role === 'timeout') {
        const { title, text } = formatReplyTimeout(e);
        return `${h} ${title}\n\n${text}`;
      }
      round++;
      const verdict = e.proposedDrop
        ? t({ zh: '认为不该做，请人确认', en: 'Should not be done; asks a human to confirm' })
        : verdictLabel(e.verdict);
      const head = t({
        zh: `第 ${round} 轮评估：${verdict}`,
        en: `Assessment round ${round}: ${verdict}`,
      });
      return `${h} ${head}\n\n${formatAssessment(e)}`;
    })
    .join('\n\n');
}

/**
 * How an assessment that goes ahead sizes the requirement (`size`, `REQUIREMENT_SIZES`), with the
 * meanings the scout's proposals use too (`sizeMeanings`). A stage with `planning: auto` splits
 * only an L into steps.
 */
function sizeRule(): string {
  const meanings = sizeMeanings();
  const last = PROPOSAL_SIZES.length - 1;
  const items = PROPOSAL_SIZES.map((size, i) => {
    const end = i === last ? t({ zh: '。', en: '.' }) : t({ zh: '；', en: ';' });
    return `- ${size}${t({ zh: '：', en: ': ' })}${meanings[size]}${end}`;
  });
  const head = t({
    zh: 'verdict 为 go 时还要给出 size，估计需求的规模，只能是 S、M、L 三个字母之一：',
    en: 'With verdict go, also give size, how big you judge the requirement, as one of the letters S, M and L:',
  });
  return [head, ...items].join('\n');
}

/**
 * How an assessment that goes ahead judges the requirement's difficulty (`difficulty`,
 * `DIFFICULTIES`), with the meanings the Run detail page shows too (`difficultyMeanings`): the
 * stages with `agent_candidates` pick the cheapest candidate whose tier is at least that.
 */
function difficultyRule(): string {
  const meanings = difficultyMeanings();
  const last = DIFFICULTIES.length - 1;
  const items = DIFFICULTIES.map((level, i) => {
    const end = i === last ? t({ zh: '。', en: '.' }) : t({ zh: '；', en: ';' });
    return `- ${level}${t({ zh: '：', en: ': ' })}${meanings[level]}${end}`;
  });
  const head = t({
    zh: 'verdict 为 go 时还要给出 difficulty，估计需求的难度，只能是 low、mid、high 三者之一。后面的阶段按难度从候选 Agent 里挑档次够用、费用最低的一个：估低了可能做不好，估高了会多花钱。',
    en: 'With verdict go, also give difficulty, how hard you judge the requirement, as one of low, mid and high. Later stages go by it to pick, among their candidate agents, the cheapest one capable enough: too low and the work may not be done well, too high and it costs more than it needs to.',
  });
  return [head, ...items].join('\n');
}

/**
 * The conclusion and output format of the round after nobody replied in time: go with the
 * assumptions written down, or drop; asking again is not accepted (`assessmentProblem`).
 */
function decideAloneConclusion(timeout: ReplyTimeoutEntry): string {
  const why =
    timeout.hours === 0
      ? t({ zh: '这个阶段不等人回复', en: 'This stage does not wait for replies' })
      : t({
          zh: `上面的疑问 ${waitText(timeout.hours)}内没有人回复`,
          en: `Nobody replied to the questions above within ${waitText(timeout.hours)}`,
        });
  return t({
    zh: `## 结论

${why}，这一轮由你自己决定，不能再给 ask。verdict 二选一：
- go（开工）：按你认为最合理的理解开工。summary 写评估意见，并逐条写明你对之前的疑问做了哪些假设；后面的编码和评审会读到 summary，按这些假设去做。不要写 revisedGoal。
- drop（不做）：认为不该做时给出，summary 写明理由。

${sizeRule()}

${difficultyRule()}

summary 用中文书写。

## 输出格式

最后一条回复以一个 JSON 代码块结束：

\`\`\`json
{"verdict": "go", "size": "M", "difficulty": "mid", "summary": "评估意见，以及对每个疑问做了什么假设"}
\`\`\`
`,
    en: `## Conclusion

${why}, so you decide this round on your own, and ask is not allowed. Pick one verdict:
- go: start on what you think is the most sensible reading. Write your assessment in summary, and for each of the earlier questions the assumption you made; coding and review read summary and go by these assumptions. Do not write revisedGoal.
- drop: when you think it should not be done; give the reasons in summary.

${sizeRule()}

${difficultyRule()}

Write summary in English.

## Output format

End your last reply with a JSON code block:

\`\`\`json
{"verdict": "go", "size": "M", "difficulty": "mid", "summary": "your assessment, and the assumption made for each question"}
\`\`\`
`,
  });
}

/**
 * Prompt of a requirement assessment: read-only, ends with go / ask / drop. After nobody replied
 * in time (the discussion ends with a timeout), only go / drop.
 */
export function assessPrompt(
  ctx: PromptContext,
  discussion: readonly DiscussionEntry[],
  feedback: string | null,
): string {
  const instructions = ctx.stage.instructions ? fill(ctx.stage.instructions, ctx.goal).trim() : '';
  const replied = hasHumanReply(discussion);
  const timeout = pendingTimeout(discussion);
  const history =
    discussion.length > 0
      ? t({
          zh: `## 讨论记录\n\n之前的评估和人的回复，从早到晚。人已经回答的问题不要再问；人的回复和原需求不一致时，以人的回复为准。\n\n${formatDiscussion(discussion)}\n\n`,
          en: `## Discussion so far\n\nEarlier assessments and the human's replies, oldest first. Do not ask again what the human has already answered; where a reply differs from the original requirement, the reply wins.\n\n${formatDiscussion(discussion)}\n\n`,
        })
      : '';
  const requirements = instructions
    ? t({
        zh: `## 评估要求\n\n${instructions}\n\n`,
        en: `## Assessment instructions\n\n${instructions}\n\n`,
      })
    : '';
  const notes = ctx.stageFeedback
    ? t({
        zh: `## 补充说明\n\n${ctx.stageFeedback}\n\n`,
        en: `## Additional notes\n\n${ctx.stageFeedback}\n\n`,
      })
    : '';
  const lastFeedback = feedback
    ? t({
        zh: `## 上一次评估没有完成\n\n${feedback}\n\n`,
        en: `## The previous assessment did not complete\n\n${feedback}\n\n`,
      })
    : '';
  const earlier = earlierAttemptsSection(ctx.earlierAttempts, 'assess');
  const rest = `${requirements}${earlier}${history}${inputsSection(ctx.inputs)}${notes}${lastFeedback}`;
  const intro = t({
    zh: `你是${brandName()}的「需求评估」Agent。Run 开始编码之前，先判断下面这个需求是否合理、能不能开工。你只能读文件和搜索，不能修改任何文件，也不能执行命令。

## 需求

${ctx.goal}

## 怎么评估

- 先读 README.md 和 AGENTS.md（有 CLAUDE.md 的也读），了解项目是什么、有哪些约定；README 里写的目标是判断一切的依据。再读和需求相关的代码。
- 逐项判断：
  1. 是否服务于 README 的目标；
  2. 是否和已有功能重复或冲突；
  3. 描述是否清楚，验收标准能否检验；
  4. 一个 Run（编码 → 评审 → 合并）能否做完；
  5. 有没有明显更好的做法。
- 只有真正影响能否做好的问题才需要问人；细节自己按最合理的方式定下来，写进 summary，不要为它们打扰人。
${noGitHubRule()}
${rest}`,
    en: `You are the requirement assessment agent of ${brandName()}. Before a Run starts coding, judge whether the requirement below is sound and ready to start. You may only read files and search; you may not modify any file or run commands.

## Requirement

${ctx.goal}

## How to assess

- First read README.md and AGENTS.md (and CLAUDE.md if there is one) to learn what the project is and its conventions; the goals in the README are the basis for every judgement. Then read the code related to the requirement.
- Judge each of these:
  1. whether it serves the README's goals;
  2. whether it duplicates or conflicts with existing functionality;
  3. whether it is described clearly, with acceptance criteria that can be checked;
  4. whether one Run (coding → review → merge) can finish it;
  5. whether there is a clearly better approach.
- Ask the human only about what really decides whether it can be done well; settle details yourself in the most sensible way and write them in summary instead of bothering the human with them.
${noGitHubRule()}
${rest}`,
  });
  if (timeout) return `${intro}${decideAloneConclusion(timeout)}`;
  return `${intro}${t({
    zh: `## 结论

verdict 三选一：
- go（开工）：可以开始编码。summary 写评估意见，包括你替人定下的细节。${replied ? '讨论后需求有修改或补充时，在 revisedGoal 里写修改后的完整需求（要能替代原需求，包括验收标准，后面的编码和评审以它为准）；没有修改就不写 revisedGoal。' : '还没有和人讨论过，不要写 revisedGoal：需求要改就先 ask。'}
- ask（需要讨论）：有疑问或顾虑，要人回答或确认。questions 列出疑问和顾虑，suggestions 写建议怎么改。认为不该做时也给 ask，在 summary 里写明理由，并在 questions 里请人确认是否不做。
- drop（不做）：${replied ? '只有讨论记录里人已经同意不做时才能给出，summary 写明理由。' : '还没有和人讨论过，不能给出 drop；认为不该做就给 ask。'}

${sizeRule()}

${difficultyRule()}

summary、questions、suggestions 和 revisedGoal 都用中文书写。

## 输出格式

最后一条回复以一个 JSON 代码块结束，例如：

\`\`\`json
{"verdict": "ask", "summary": "评估意见", "questions": ["疑问或顾虑"], "suggestions": ["建议怎么改"]}
\`\`\`

go 时写成 \`{"verdict": "go", "size": "M", "difficulty": "mid", "summary": "评估意见"}\` 这样。
`,
    en: `## Conclusion

Pick one verdict:
- go: coding can start. Write your assessment in summary, including the details you settled for the human. ${replied ? 'When the discussion changed or added to the requirement, write the complete revised requirement in revisedGoal (it must be able to replace the original, acceptance criteria included; coding and review go by it); without changes, leave revisedGoal out.' : 'There has been no discussion with the human yet, so do not write revisedGoal: if the requirement should change, ask first.'}
- ask: there are questions or concerns for the human to answer or confirm. List them in questions, and how you suggest changing it in suggestions. Also give ask when you think it should not be done, with the reasons in summary and a question asking the human to confirm dropping it.
- drop: ${replied ? 'only when the human has agreed in the discussion not to do it; give the reasons in summary.' : 'not allowed before any discussion with the human; give ask when you think it should not be done.'}

${sizeRule()}

${difficultyRule()}

Write summary, questions, suggestions and revisedGoal in English.

## Output format

End your last reply with a JSON code block, for example:

\`\`\`json
{"verdict": "ask", "summary": "your assessment", "questions": ["a question or concern"], "suggestions": ["how to change it"]}
\`\`\`

With go, it looks like \`{"verdict": "go", "size": "M", "difficulty": "mid", "summary": "your assessment"}\`.
`,
  })}`;
}

/**
 * The `assessment` artifact of a round: what the later stages read with `inputs: [assessment]`
 * (embedded under a level-3 heading). A go after a discussion carries the discussion, so the
 * answers reach the coder and the reviewer.
 */
export function assessmentArtifact(
  entry: AssessmentEntry,
  /** The discussion before this round. */
  earlier: readonly DiscussionEntry[],
): string {
  const head =
    entry.verdict === 'ask'
      ? entry.proposedDrop
        ? t({
            zh: '需求评估：认为不该做，等人确认',
            en: 'Requirement assessment: should not be done, waiting for a human to confirm',
          })
        : t({ zh: '需求评估：需要讨论', en: 'Requirement assessment: needs discussion' })
      : t({
          zh: `需求评估结论：${conclusionLabel(entry)}`,
          en: `Requirement assessment conclusion: ${conclusionLabel(entry)}`,
        });
  const parts = [head, entry.summary];
  if (entry.questions.length > 0) {
    const questions = numbered(entry.questions);
    parts.push(
      t({ zh: `疑问和顾虑：\n${questions}`, en: `Questions and concerns:\n${questions}` }),
    );
  }
  if (entry.suggestions.length > 0) {
    const suggestions = bulleted(entry.suggestions);
    parts.push(t({ zh: `建议：\n${suggestions}`, en: `Suggestions:\n${suggestions}` }));
  }
  if (entry.revisedGoal) {
    parts.push(
      t({
        zh: `修改后的需求（以它为准，替代「目标」中的原需求）：\n\n${entry.revisedGoal}`,
        en: `Revised requirement (it holds, replacing the original requirement under "Goal"):\n\n${entry.revisedGoal}`,
      }),
    );
  }
  if (entry.verdict === 'go' && assessmentRounds(earlier).length > 0) {
    const history = formatDiscussion(earlier, 4);
    parts.push(t({ zh: `讨论记录：\n\n${history}`, en: `Discussion:\n\n${history}` }));
  }
  return `${parts.join('\n\n')}\n`;
}
