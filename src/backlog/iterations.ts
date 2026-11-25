// Iterations, wherever their children come from (GitHub issues, or proposals of the local
// backlog): where each child stands as its Runs go, what an iteration cost and how long it took,
// the summary once every child is done, and the review suggestions its closing step goes
// through. Reads and writes the store only: the sources (src/github/bridge.ts,
// src/backlog/local.ts) find out whether each child's requirement is done and publish the texts
// this gives them. No agent is asked: the summary is put together from the Runs' records.

import { unmetDependencies } from '../config/flow.js';
import { minutes, storedRunTimes, workSwitchesOf } from '../engine/times.js';
import { oneLine, passedReviews, statusText, trustedGoal } from '../github/scout.js';
import { join, t } from '../i18n.js';
import type { Store } from '../store/store.js';
import {
  FINISHED_RUN_STATUSES,
  type Iteration,
  type IterationChild,
  type IterationChildStatus,
  type Run,
  type RunStatus,
} from '../store/types.js';

/**
 * The Runs that worked on a child, oldest first: on GitHub every Run created from its issue
 * (failed attempts, redos and Runs started over included); in the local backlog, the Run its
 * proposal became.
 */
export function childRuns(
  store: Store,
  iteration: Pick<Iteration, 'source' | 'issuesRepo'>,
  child: Pick<IterationChild, 'issue' | 'proposalId'>,
): Run[] {
  if (iteration.source === 'github') {
    return child.issue ? store.runsForIssue(iteration.issuesRepo, child.issue.number) : [];
  }
  if (!child.proposalId) return [];
  const runId = store.getProposal(child.proposalId).runId;
  return runId ? [store.getRun(runId)] : [];
}

/**
 * Whether a Run works on the child: one has not finished, or the latest failed and waits to be
 * redone (a failed Run of an issue with attempts left).
 */
function worksOn(runs: readonly Run[]): boolean {
  const latest = runs.at(-1);
  return (
    runs.some((r) => !FINISHED_RUN_STATUSES.includes(r.status)) ||
    (latest?.status === 'failed' && latest.issue?.redo === 'pending')
  );
}

/**
 * Record where the children of an accepted iteration stand now, each with the Runs that worked on
 * it (`childRuns`), and return the iteration as recorded then. `done` tells, by position, whether
 * the source has the child's requirement done (on GitHub: its issue closed as completed); a child
 * it says nothing about (no issue yet, or closed some other way) keeps its status. The others
 * are running while a Run works on them, else waiting while a child they depend on is not done
 * (`unmetDependencies`), else ready. Each status change records an `iteration.child_status` event
 * in the same transaction. Nothing is written when nothing changed.
 */
export function followChildren(
  store: Store,
  iterationId: string,
  repo: string,
  done: ReadonlyMap<number, boolean>,
): Iteration {
  return store.tx(() => {
    const latest = store.getIteration(iterationId);
    const runs = new Map(latest.children.map((c) => [c.position, childRuns(store, latest, c)]));
    const settled = new Map<number, IterationChildStatus>();
    for (const child of latest.children) {
      const isDone = done.get(child.position);
      if (isDone === undefined) continue;
      if (isDone) settled.set(child.position, 'done');
      else if (worksOn(runs.get(child.position) ?? [])) settled.set(child.position, 'running');
    }
    // A child the source says is not done is not, whatever it was before: the ones it holds back
    // wait for it.
    const placed = latest.children.map((c) =>
      done.get(c.position) === false && !settled.has(c.position)
        ? { ...c, status: 'ready' as const }
        : { ...c, status: settled.get(c.position) ?? c.status },
    );
    const next: IterationChild[] = placed.map((c, i) => {
      const before = latest.children[i] as IterationChild;
      const runIds = (runs.get(c.position) ?? []).map((r) => r.id);
      const status =
        done.get(c.position) === false && !settled.has(c.position)
          ? unmetDependencies(c, placed).length > 0
            ? 'waiting'
            : 'ready'
          : c.status;
      return {
        ...before,
        status,
        runIds: before.issue || before.proposalId ? runIds : before.runIds,
      };
    });
    const changed = next.filter((c, i) => {
      const before = latest.children[i] as IterationChild;
      return c.status !== before.status || c.runIds.join() !== before.runIds.join();
    });
    if (changed.length === 0) return latest;
    const updated = store.updateIteration(iterationId, { children: next });
    for (const [i, child] of next.entries()) {
      const before = latest.children[i] as IterationChild;
      if (child.status === before.status) continue;
      store.event(null, 'iteration.child_status', {
        repo,
        iterationId,
        ...(latest.issue ? { issue: latest.issue.number } : {}),
        position: child.position,
        ...(child.issue ? { child: child.issue.number } : {}),
        ...(child.proposalId ? { proposalId: child.proposalId } : {}),
        status: child.status,
        previous: before.status,
      });
    }
    return updated;
  });
}

/** What an iteration used, over every Run of its children. */
export interface IterationTotals {
  /** How many Runs worked on its children, failed attempts included. */
  runs: number;
  /** What all of them cost. */
  costUsd: number;
  /** From its acceptance to its end, or to now while it goes on; null while not accepted. */
  elapsedMs: number | null;
  /** The agents' executions in all of them, each from start to end (`storedRunTimes`). */
  agentMs: number;
}

/**
 * What an iteration used: every Run of every child (`childRuns`), failed attempts and those of
 * replaced children included, as each of them cost money and time. `now` (epoch ms) ends the
 * time of an iteration that has not ended.
 */
export function iterationTotals(
  store: Store,
  iteration: Iteration,
  now = Date.now(),
): IterationTotals {
  const runs = iteration.children.flatMap((c) => childRuns(store, iteration, c));
  const switches = workSwitchesOf(store);
  const end = iteration.endedAt ? Date.parse(iteration.endedAt) : now;
  return {
    runs: runs.length,
    costUsd: runs.reduce((sum, r) => sum + r.costUsd, 0),
    elapsedMs: iteration.decidedAt ? Math.max(0, end - Date.parse(iteration.decidedAt)) : null,
    agentMs: runs.reduce((sum, r) => sum + storedRunTimes(store, r, switches).agentMs, 0),
  };
}

/** One Run of a child, as the summary lists it. */
export interface SummaryRun {
  id: string;
  status: RunStatus;
  costUsd: number;
}

/** One child, as the summary tells it. */
export interface SummaryChild {
  child: Pick<IterationChild, 'position' | 'title' | 'issue' | 'criteria' | 'replacedBy'>;
  /** Every Run that worked on it, oldest first. */
  runs: SummaryRun[];
  /**
   * The Run that got it done and what its reviews concluded (the latest round of each review
   * stage that passed); null when no Run completed it (closed as completed by a human).
   */
  doneBy: { runId: string; reviews: { stageName: string; summary: string }[] } | null;
}

export interface SummaryInput {
  goal: string;
  criteria: readonly string[];
  children: readonly SummaryChild[];
  totals: IterationTotals;
}

/** 「#12 标题」 on GitHub, the title alone in the local backlog. */
const childRef = (child: Pick<IterationChild, 'title' | 'issue'>) =>
  `${child.issue ? `#${child.issue.number} ` : ''}${oneLine(child.title, 120)}`;

/** 「3 小时 5 分钟」 / "3 h 5 min": a duration in whole minutes, at least one. */
export function durationText(ms: number): string {
  const total = minutes(ms);
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  const parts: [number, string, string][] = [
    [days, '天', 'd'],
    [hours, '小时', 'h'],
    [mins, '分钟', 'min'],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, zh, en]) => t({ zh: `${n} ${zh}`, en: `${n} ${en}` }))
    .join(' ');
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** 「评审结论：没问题」, what the reviews of the Run that got a child done concluded. */
function reviewText(reviews: readonly { stageName: string; summary: string }[]): string {
  if (reviews.length === 0) return t({ zh: '没有评审', en: 'not reviewed' });
  // The stage is named only when there are several to tell apart.
  const each = reviews.map((r) => {
    const summary = oneLine(r.summary, 300);
    if (reviews.length === 1) return summary;
    return t({ zh: `${r.stageName}：${summary}`, en: `${r.stageName}: ${summary}` });
  });
  return t({ zh: `评审结论：${each.join('；')}`, en: `review: ${each.join('; ')}` });
}

/**
 * The summary of an iteration once every child is done, in the language in use: what it
 * achieved (its goal, and the children done), each completion criterion with the children that
 * advanced it (by `criteria`), the Run that got each done and what its reviews concluded, every
 * Run used, and what it all cost and took. Pure: `iterationSummary` gathers the input.
 */
export function iterationSummaryText(input: SummaryInput): string {
  const counted = input.children.filter((c) => c.child.replacedBy === undefined);
  const lines: string[] = [
    t({ zh: '## 迭代完成', en: '## Iteration done' }),
    '',
    t({ zh: '### 做成了什么', en: '### What it achieved' }),
    '',
    input.goal.trim(),
    '',
    t({
      zh: `完成了全部 ${counted.length} 个子项：`,
      en: `All ${counted.length} step${counted.length === 1 ? '' : 's'} done:`,
    }),
    '',
    ...counted.map((c) => `- ${childRef(c.child)}`),
    '',
    t({ zh: '### 对照完成标准', en: '### Against the completion criteria' }),
    '',
  ];
  for (const [i, criterion] of input.criteria.entries()) {
    lines.push(`${i + 1}. ${oneLine(criterion, 500)}`);
    const advancing = counted.filter((c) => c.child.criteria.includes(i + 1));
    if (advancing.length === 0) {
      lines.push(
        `   - ${t({ zh: '没有子项写明推进这一条', en: 'No step was planned to advance it' })}`,
      );
    }
    for (const c of advancing) {
      const how = c.doneBy
        ? t({
            zh: `${c.doneBy.runId}，${reviewText(c.doneBy.reviews)}`,
            en: `${c.doneBy.runId}, ${reviewText(c.doneBy.reviews)}`,
          })
        : t({ zh: '没有 Run 完成它', en: 'no Run completed it' });
      lines.push(
        t({
          zh: `   - ${childRef(c.child)}：${how}`,
          en: `   - ${childRef(c.child)}: ${how}`,
        }),
      );
    }
  }
  lines.push('', t({ zh: '### 用到的 Run', en: '### Runs used' }), '');
  for (const c of input.children) {
    const runs =
      c.runs.length > 0
        ? join(
            c.runs.map((r) =>
              t({
                zh: `${r.id}（${statusText(r.status)}，${usd(r.costUsd)}）`,
                en: `${r.id} (${statusText(r.status)}, ${usd(r.costUsd)})`,
              }),
            ),
          )
        : t({ zh: '没有', en: 'none' });
    const replaced =
      c.child.replacedBy === undefined
        ? ''
        : t({
            zh: `（已被第 ${c.child.replacedBy} 步替换）`,
            en: ` (replaced by step ${c.child.replacedBy})`,
          });
    lines.push(
      t({
        zh: `- ${childRef(c.child)}${replaced}：${runs}`,
        en: `- ${childRef(c.child)}${replaced}: ${runs}`,
      }),
    );
  }
  const { totals } = input;
  const took =
    totals.elapsedMs === null
      ? t({
          zh: `- 用时：Agent 执行 ${durationText(totals.agentMs)}`,
          en: `- Time: agents worked ${durationText(totals.agentMs)}`,
        })
      : t({
          zh: `- 用时：从采纳到完成 ${durationText(totals.elapsedMs)}，其中 Agent 执行 ${durationText(totals.agentMs)}`,
          en: `- Time: ${durationText(totals.elapsedMs)} from acceptance to done, of which agents worked ${durationText(totals.agentMs)}`,
        });
  lines.push(
    '',
    t({ zh: '### 费用和用时', en: '### Cost and time' }),
    '',
    t({
      zh: `- 总费用：${usd(totals.costUsd)}，共 ${totals.runs} 个 Run（失败的尝试也算在内）`,
      en: `- Total cost: ${usd(totals.costUsd)} over ${totals.runs} Run${totals.runs === 1 ? '' : 's'} (failed attempts included)`,
    }),
    took,
  );
  return lines.join('\n');
}

/**
 * The latest round of each review stage of the Run that passed (`passedReviews`): an earlier one
 * was about work redone since.
 */
function latestPassedReviews(store: Store, run: Run) {
  const byStage = new Map<string, ReturnType<typeof passedReviews>[number]>();
  for (const review of passedReviews(store, run)) byStage.set(review.stageId, review);
  return [...byStage.values()];
}

/**
 * The summary of an iteration whose children are all done (`iterationSummaryText`), from the
 * store: each child's Runs (`childRuns`), the last of them that completed with its reviews, and
 * the totals as of `now` (epoch ms).
 */
export function iterationSummary(store: Store, iteration: Iteration, now = Date.now()): string {
  const children = iteration.children.map((child): SummaryChild => {
    const runs = childRuns(store, iteration, child);
    const completed = runs.findLast((r) => r.status === 'completed');
    return {
      child,
      runs: runs.map((r) => ({ id: r.id, status: r.status, costUsd: r.costUsd })),
      doneBy: completed
        ? {
            runId: completed.id,
            reviews: latestPassedReviews(store, completed).map((r) => ({
              stageName: r.stageName,
              summary: r.summary,
            })),
          }
        : null,
    };
  });
  return iterationSummaryText({
    goal: iteration.goal,
    criteria: iteration.criteria,
    children,
    totals: iterationTotals(store, iteration, now),
  });
}

/** Suggestions listed in the closing step's requirement; more are only counted. */
const MAX_CLOSEOUT_SUGGESTIONS = 40;

/**
 * Characters kept of each suggestion listed. The closing step works from them, and reviewers
 * usually describe what they saw first and how to fix it last: more is kept than in the scout's
 * digest, where they are only leads.
 */
const CLOSEOUT_SUGGESTION_CHARS = 800;

/**
 * The review suggestions an iteration's closing step goes through, as a Markdown section added to
 * its requirement before its Run is created: what reviewers left as suggestions when the Runs of
 * the iteration's other children passed review, instead of issues of their own. Only Runs that
 * completed count (a failed one's work never reached the target branch, so its suggestions are
 * about code that is not there), each by the latest passed round of each review stage. Runs
 * whose goal is not trusted are left out (`trustedGoal`): reviewers read the goal, and their
 * suggestions may carry its text into this Run's prompt. Says so when none were left.
 */
export function closeoutSuggestions(
  store: Store,
  iteration: Iteration,
  closeout: Pick<IterationChild, 'position'>,
): string {
  const lines: string[] = [];
  let listed = 0;
  let more = 0;
  for (const child of iteration.children) {
    if (child.position === closeout.position || child.closeout) continue;
    for (const run of childRuns(store, iteration, child)) {
      if (run.status !== 'completed' || !trustedGoal(run)) continue;
      for (const review of latestPassedReviews(store, run)) {
        if (review.suggestions.length === 0) continue;
        const round = t({
          zh: `${run.id}，${review.stageName}第 ${review.round} 轮`,
          en: `${run.id}, ${review.stageName} round ${review.round}`,
        });
        lines.push(
          t({
            zh: `- ${childRef(child)}（${round}）`,
            en: `- ${childRef(child)} (${round})`,
          }),
        );
        for (const s of review.suggestions) {
          if (listed >= MAX_CLOSEOUT_SUGGESTIONS) {
            more++;
            continue;
          }
          listed++;
          const where = s.file ? `[${s.file}] ` : '';
          lines.push(`  - ${oneLine(`${where}${s.description}`, CLOSEOUT_SUGGESTION_CHARS)}`);
        }
      }
    }
  }
  const head = [
    t({ zh: '### 本迭代评审留下的建议', en: '### Review suggestions of this iteration' }),
    '',
  ];
  if (listed === 0 && more === 0) {
    return [
      ...head,
      t({
        zh: '本迭代其他子项的 Run 评审通过时没有留下建议。',
        en: "The reviews of this iteration's other steps left no suggestions when they passed.",
      }),
    ].join('\n');
  }
  if (more > 0) {
    lines.push(
      t({
        zh: `- …另有 ${more} 条没有列出`,
        en: `- …and ${more} more not listed`,
      }),
    );
  }
  return [
    ...head,
    t({
      zh: '本迭代其他子项的 Run 评审通过时留下了下面这些建议。逐条判断：值得做的就做；不值得做或已经不适用的，在结果里说明理由。',
      en: "The reviews of this iteration's other steps left these suggestions when they passed. Judge each one: do those worth doing, and for those that are not, or no longer apply, say why in your result.",
    }),
    '',
    ...lines,
  ].join('\n');
}
