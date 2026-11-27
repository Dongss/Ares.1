import type {
  BacklogRepoStatus,
  BacklogStatus,
  ProposalView,
  ProposalWritten,
} from '../../../src/api/types.js';
import {
  authorDecides,
  isAutoAcceptable,
  proposalEditable,
  REQUIREMENT_ITEMS_MAX,
  REQUIREMENT_TEXT_MAX,
  REQUIREMENT_TITLE_MAX,
} from '../../../src/config/flow.js';
import { join, t } from '../../../src/i18n.js';
import type { FailedAttempt, ProposalStatus, ScoutProposal } from '../../../src/store/types.js';
import type { ProposalEdit, RequirementInput } from './api.js';
import { formatTime, type Tone } from './format.js';
import { type AcceptLimits, badge } from './issues.js';
import { redoText } from './runs.js';

// The local backlog on the Issues page: the proposals of the repos without GitHub
// (backlog.repos), by repo with the pending ones first, and what a human can do with each.
// Labels are getters, so they are picked in the language in use when read.

export const PROPOSAL_STATUS: Record<ProposalStatus, { readonly label: string; tone: Tone }> = {
  pending: badge('待处理', 'Pending', 'attention'),
  accepted: badge('已采纳', 'Accepted', 'success'),
  rejected: badge('已拒绝', 'Rejected', 'muted'),
  failed: badge('已失败', 'Failed', 'danger'),
};

/**
 * How many of the latest proposals the page loads besides the pending ones, which it loads all
 * of: decided proposals pile up for good, while only the pending ones still need a human.
 */
export const RECENT_PROPOSALS = 50;

/** Each proposal once, by id, as the first list that has it gives it. */
export function mergeProposals(...lists: readonly (readonly ProposalView[])[]): ProposalView[] {
  const byId = new Map<string, ProposalView>();
  for (const list of lists) {
    for (const p of list) if (!byId.has(p.id)) byId.set(p.id, p);
  }
  return [...byId.values()];
}

/** When a proposal last changed: when it was decided, or else proposed. */
const changedAt = (p: ProposalView) => Date.parse(p.decidedAt ?? p.createdAt);

/**
 * The pending proposals first, newest first, since only they wait for anyone; then the decided
 * ones, the most recently decided first.
 */
export function sortProposals(proposals: readonly ProposalView[]): ProposalView[] {
  const rank = (p: ProposalView) => (p.status === 'pending' ? 0 : 1);
  return [...proposals].sort((a, b) => rank(a) - rank(b) || changedAt(b) - changedAt(a));
}

/** One repo's part of the local backlog. */
export interface ProposalGroup {
  /** The repo's name as registered on the dashboard. */
  repo: string;
  /** The repo as backlog.repos has it; null once it was taken out (no proposal of it is accepted). */
  status: BacklogRepoStatus | null;
  proposals: ProposalView[];
}

/**
 * The proposals by repo: every repo of backlog.repos in its order, whether or not it has any,
 * then the repos taken out of it that still have proposals, by name. Each repo's proposals as
 * `sortProposals` orders them.
 */
export function proposalGroups(
  repos: readonly BacklogRepoStatus[],
  proposals: readonly ProposalView[],
): ProposalGroup[] {
  const sorted = sortProposals(proposals);
  const of = (name: string) => sorted.filter((p) => p.repo === name);
  const configured = new Set(repos.map((r) => r.name));
  const others = [...new Set(sorted.map((p) => p.repo))]
    .filter((name) => !configured.has(name))
    .sort((a, b) => a.localeCompare(b));
  return [
    ...repos.map((r) => ({ repo: r.name, status: r, proposals: of(r.name) })),
    ...others.map((name) => ({ repo: name, status: null, proposals: of(name) })),
  ];
}

/**
 * Why a pending proposal cannot be accepted now, as the Master would refuse it; null when it can,
 * and for decided ones, which are not accepted again.
 */
export function acceptBlocker(
  p: Pick<ProposalView, 'status' | 'repo'>,
  repo: Pick<BacklogRepoStatus, 'problems'> | null,
): string | null {
  if (p.status !== 'pending') return null;
  if (!repo) {
    return t({
      zh: `${p.repo} 已经不在 config.yaml 的 backlog.repos 里，不能再采纳它的提案；拒绝还可以`,
      en: `${p.repo} is no longer in backlog.repos of config.yaml, so its proposals cannot be accepted; they can still be rejected`,
    });
  }
  if (repo.problems.length > 0) {
    return t({
      zh: '这个仓库的配置有问题（见上面），改好之后才能采纳',
      en: 'The repo has problems (see above); fix them before accepting',
    });
  }
  return null;
}

/**
 * A pending proposal may be rejected once there is a reason, which the repo's next scouts are
 * shown so that they do not propose it again.
 */
export function canReject(p: Pick<ProposalView, 'status'>, reason: string): boolean {
  return p.status === 'pending' && reason.trim() !== '';
}

/** The mark of a proposal a human wrote (POST /api/proposals), beside its status. */
export function humanMark(p: Pick<ProposalView, 'author'>): string | null {
  return p.author === 'human' ? t({ zh: '人写的', en: 'Human-written' }) : null;
}

// ---- writing a requirement ----------------------------------------------------------

/**
 * What a human typed into the form that writes a requirement, or edits a pending proposal,
 * before it is sent.
 */
export interface RequirementDraft {
  title: string;
  what: string;
  /** Optional. */
  why: string;
  /** The evidence, one item per line; optional. */
  evidence: string;
  /** The acceptance criteria, one per line; optional. */
  acceptance: string;
  category: ScoutProposal['category'];
  size: ScoutProposal['size'];
  risk: ScoutProposal['risk'];
}

/** An empty form: feature, M and mid, what the Master takes when they are left out. */
export function emptyDraft(): RequirementDraft {
  return {
    title: '',
    what: '',
    why: '',
    evidence: '',
    acceptance: '',
    category: 'feature',
    size: 'M',
    risk: 'mid',
  };
}

/**
 * The mark a line of a list may start with, as people paste them: a bullet followed by a space
 * (`- `, `* `, `+ `) or `•`, a number (`1. `, `1) `, `1、`), and a task box (`[ ] `, `[x] `)
 * after either or alone. A bullet needs its space, so that 「-1 表示不限」 or 「1.5 秒内」 keep
 * their first character.
 */
const LIST_MARK = /^(?:[-*+](?:\s+|$)|•\s*|\d+(?:[.)](?:\s+|$)|、\s*))?(?:\[[ xX]\](?:\s+|$))?/;

/**
 * A list written one item per line (the evidence, the acceptance criteria), as the list sent: each
 * line trimmed and without the list mark it may start with (`- [ ] `, `- `, `1. `…), blank ones
 * dropped.
 */
export function lineItems(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(LIST_MARK, '').trim())
    .filter((item) => item !== '');
}

/**
 * Why the requirement cannot be written yet, as the Master would refuse it: the repo has problems
 * (shown above the form), there is no title or no what to do, or something is longer than the
 * Master takes. null when it can be sent.
 */
export function writeBlocker(
  repo: Pick<BacklogRepoStatus, 'problems'>,
  draft: RequirementDraft,
): string | null {
  if (repo.problems.length > 0) {
    return t({
      zh: '这个仓库的配置有问题（见上面），改好之后才能写需求',
      en: 'The repo has problems (see above); fix them before writing a requirement',
    });
  }
  return draftBlocker(draft);
}

/**
 * What is wrong with a draft, as the Master would refuse it, writing a requirement or editing a
 * proposal alike: no title or no what to do, too many items in a list, or something longer than
 * the Master takes. null when there is nothing.
 */
function draftBlocker(draft: RequirementDraft): string | null {
  const title = draft.title.trim();
  if (title === '') return t({ zh: '先写标题', en: 'Write a title first' });
  if (title.length > REQUIREMENT_TITLE_MAX) {
    return t({
      zh: `标题最多 ${REQUIREMENT_TITLE_MAX} 个字`,
      en: `A title has at most ${REQUIREMENT_TITLE_MAX} characters`,
    });
  }
  const what = draft.what.trim();
  if (what === '') return t({ zh: '写清楚要做什么', en: 'Say what to do' });
  const tooLong = (field: string) =>
    t({
      zh: `${field}最多 ${REQUIREMENT_TEXT_MAX} 个字`,
      en: `${field} has at most ${REQUIREMENT_TEXT_MAX} characters`,
    });
  if (what.length > REQUIREMENT_TEXT_MAX) {
    return tooLong(t({ zh: '「要做什么」', en: '"What to do"' }));
  }
  if (draft.why.trim().length > REQUIREMENT_TEXT_MAX) {
    return tooLong(t({ zh: '「为什么」', en: '"Why"' }));
  }
  const evidence = lineItems(draft.evidence);
  if (evidence.length > REQUIREMENT_ITEMS_MAX) {
    return t({
      zh: `证据最多 ${REQUIREMENT_ITEMS_MAX} 条`,
      en: `At most ${REQUIREMENT_ITEMS_MAX} items of evidence`,
    });
  }
  if (evidence.some((item) => item.length > REQUIREMENT_TEXT_MAX)) {
    return tooLong(t({ zh: '每条证据', en: 'Each item of evidence' }));
  }
  const items = lineItems(draft.acceptance);
  if (items.length > REQUIREMENT_ITEMS_MAX) {
    return t({
      zh: `验收标准最多 ${REQUIREMENT_ITEMS_MAX} 条`,
      en: `At most ${REQUIREMENT_ITEMS_MAX} acceptance criteria`,
    });
  }
  if (items.some((item) => item.length > REQUIREMENT_TEXT_MAX)) {
    return tooLong(t({ zh: '每条验收标准', en: 'Each acceptance criterion' }));
  }
  return null;
}

/** A draft's texts as the Master takes them: trimmed, the title on one line, lists split. */
function tidied(draft: RequirementDraft) {
  return {
    title: draft.title.replace(/\s+/g, ' ').trim(),
    what: draft.what.trim(),
    why: draft.why.trim(),
    evidence: lineItems(draft.evidence),
    acceptance: lineItems(draft.acceptance),
    category: draft.category,
    size: draft.size,
    risk: draft.risk,
  };
}

/**
 * The request that writes the draft into `repo`'s local backlog: the texts trimmed, the
 * evidence and acceptance criteria as lists (`lineItems`), and what is left blank left out.
 * `start`: accept it at once, or keep it pending for the human to start.
 */
export function requirementInput(
  repo: string,
  draft: RequirementDraft,
  start: boolean,
): RequirementInput {
  const { why, evidence, acceptance } = tidied(draft);
  return {
    repo,
    title: draft.title.trim(),
    what: draft.what.trim(),
    ...(why ? { why } : {}),
    ...(evidence.length > 0 ? { evidence } : {}),
    ...(acceptance.length > 0 ? { acceptance } : {}),
    category: draft.category,
    size: draft.size,
    risk: draft.risk,
    start,
  };
}

// ---- editing a pending proposal ------------------------------------------------------

/**
 * Why a proposal that may be edited (`proposalEditable`) cannot be now, as the Master would
 * refuse it: its repo left backlog.repos, or has problems. null when it can, and for one that may
 * not be edited at all.
 */
export function editBlocker(
  p: Pick<ProposalView, 'status' | 'iterationId' | 'repo'>,
  repo: Pick<BacklogRepoStatus, 'problems'> | null,
): string | null {
  if (!proposalEditable(p)) return null;
  if (!repo) {
    return t({
      zh: `${p.repo} 已经不在 config.yaml 的 backlog.repos 里，不能再修改它的提案；拒绝还可以`,
      en: `${p.repo} is no longer in backlog.repos of config.yaml, so its proposals cannot be edited; they can still be rejected`,
    });
  }
  if (repo.problems.length > 0) {
    return t({
      zh: '这个仓库的配置有问题（见上面），改好之后才能修改提案',
      en: 'The repo has problems (see above); fix them before editing a proposal',
    });
  }
  return null;
}

/**
 * The form to edit a proposal, filled with what it says now: the evidence and the acceptance
 * criteria one per line.
 */
export function draftOf(
  p: Pick<
    ProposalView,
    'title' | 'what' | 'why' | 'evidence' | 'acceptance' | 'category' | 'size' | 'risk'
  >,
): RequirementDraft {
  return {
    title: p.title,
    what: p.what,
    why: p.why,
    evidence: p.evidence.join('\n'),
    acceptance: p.acceptance.join('\n'),
    category: p.category,
    size: p.size,
    risk: p.risk,
  };
}

/**
 * The request that edits a proposal: only the fields whose value, as the Master takes it
 * (`tidied`), differs from the form as it was opened (`before`, `draftOf` the proposal), so that
 * a field left alone is kept exactly as it was. Empty when nothing changed.
 */
export function proposalEdit(before: RequirementDraft, draft: RequirementDraft): ProposalEdit {
  const was = tidied(before);
  const now = tidied(draft);
  const same = (a: string | string[], b: string | string[]) =>
    JSON.stringify(a) === JSON.stringify(b);
  return Object.fromEntries(
    (Object.keys(now) as (keyof typeof now)[])
      .filter((field) => !same(now[field], was[field]))
      .map((field) => [field, now[field]]),
  ) as ProposalEdit;
}

/**
 * Why the edit cannot be saved yet: what `writeBlocker` says of a draft, or nothing was changed.
 * null when it can be sent.
 */
export function saveEditBlocker(before: RequirementDraft, draft: RequirementDraft): string | null {
  const wrong = draftBlocker(draft);
  if (wrong !== null) return wrong;
  if (Object.keys(proposalEdit(before, draft)).length === 0) {
    return t({ zh: '还没有改动', en: 'Nothing changed yet' });
  }
  return null;
}

/** The mark of a proposal a human edited before it was decided, beside its status. */
export function editedMark(p: Pick<ProposalView, 'editedAt'>): string | null {
  return p.editedAt ? t({ zh: '改过', en: 'Edited' }) : null;
}

/** When a human last edited it, for the mark's tooltip; null for one never edited. */
export function editedAtText(p: Pick<ProposalView, 'editedAt'>, now = new Date()): string | null {
  if (!p.editedAt) return null;
  const at = formatTime(p.editedAt, now);
  return t({ zh: `${at} 有人改过这条提案`, en: `Edited by a human ${at}` });
}

/**
 * What became of a proposal just edited, shown once the form folds up: kept pending as edited,
 * or accepted at once since the edit put it within auto-accept.
 */
export function editedResultText(p: Pick<ProposalView, 'status' | 'auto' | 'runId'>): string {
  if (p.status === 'accepted' && p.auto) {
    return p.runId
      ? t({
          zh: `改好了；改过之后在自动采纳范围内，已经自动采纳，建了 Run ${p.runId}`,
          en: `Saved; the edit put it within auto-accept, so it was accepted automatically and Run ${p.runId} was created`,
        })
      : t({
          zh: '改好了；改过之后在自动采纳范围内，已经自动采纳',
          en: 'Saved; the edit put it within auto-accept, so it was accepted automatically',
        });
  }
  return t({ zh: '改好了', en: 'Saved' });
}

/**
 * What became of a requirement just written, shown once the form folds up: started with its Run,
 * or kept pending below for the human to accept.
 */
export function writtenText(written: Pick<ProposalWritten, 'proposal' | 'run'>): string {
  const title = written.proposal.title;
  if (written.run) {
    return t({
      zh: `写好了「${title}」，Run ${written.run.id} 已经建好开工`,
      en: `Wrote "${title}"; Run ${written.run.id} was created to work on it`,
    });
  }
  return t({
    zh: `写好了「${title}」，先存在下面的提案里；想开工时点「采纳」`,
    en: `Wrote "${title}" and kept it in the proposals below; accept it when you want it started`,
  });
}

/**
 * What a pending proposal waits for: auto-accept takes it at a later poll (it was left today
 * because the count or the budget was used up, or the work switch was off), or a human decides;
 * a human's own draft (`authorDecides`) waits for them whatever its kind. null for decided
 * proposals, and without auto-accept settings (the repo left backlog.repos).
 */
export function pendingText(
  p: Pick<ProposalView, 'status' | 'risk' | 'size' | 'author'>,
  auto: AcceptLimits | null,
): string | null {
  if (p.status !== 'pending' || !auto) return null;
  if (authorDecides(p)) {
    return t({
      zh: '你写下先存着的需求：不会自动采纳，也不挡自动侦察；想开工就采纳，不做了就拒绝',
      en: 'A requirement you wrote and kept for later: it is never accepted automatically and does not hold the automatic scout back; accept it to start, or reject it',
    });
  }
  return isAutoAcceptable(p, { max_risk: auto.maxRisk, max_size: auto.maxSize })
    ? t({
        zh: '在自动采纳范围内，还没采纳（今天的自动采纳条数或预算用完了，或者工作开关关着），之后的检查会自动采纳；也可以现在就采纳',
        en: "Within auto-accept but not accepted yet (today's auto-accept count or budget was used up, or the work switch was off); a later check accepts it by itself, or accept it now",
      })
    : t({
        zh: '超出自动采纳的范围，等你采纳或拒绝',
        en: 'Beyond auto-accept, so it waits for you to accept or reject it',
      });
}

/** 「2 条待处理、3 条已采纳」 / "2 pending, 3 accepted"; null without proposals. */
export function proposalCountsText(
  proposals: readonly Pick<ProposalView, 'status'>[],
): string | null {
  const count = (s: ProposalStatus) => proposals.filter((p) => p.status === s).length;
  const pending = count('pending');
  const accepted = count('accepted');
  const rejected = count('rejected');
  const failed = count('failed');
  const parts = [
    pending > 0 ? t({ zh: `${pending} 条待处理`, en: `${pending} pending` }) : null,
    accepted > 0 ? t({ zh: `${accepted} 条已采纳`, en: `${accepted} accepted` }) : null,
    rejected > 0 ? t({ zh: `${rejected} 条已拒绝`, en: `${rejected} rejected` }) : null,
    failed > 0 ? t({ zh: `${failed} 条已失败`, en: `${failed} failed` }) : null,
  ].filter((s): s is string => s !== null);
  return parts.length > 0 ? join(parts) : null;
}

/**
 * 「第 2/3 次尝试」 / "Attempt 2 of 3": which attempt the latest Run is, of how many it gets
 * (`max`, the API's `maxAttempts`; without it, null, only which: 「第 2 次尝试」).
 */
export function attemptText(attempt: number, max: number | null): string {
  return t({
    zh: `第 ${attempt}${max === null ? '' : `/${max}`} 次尝试`,
    en: `Attempt ${attempt}${max === null ? '' : ` of ${max}`}`,
  });
}

/** What the attempt texts read of a proposal, or of a step of an iteration (its proposal's). */
export interface AttemptsOf {
  /** Which attempt its latest Run is; null for a step without a proposal (GitHub). */
  attempt: number | null;
  /** How many Runs it gets in all; null once its repo left backlog.repos. */
  maxAttempts: number | null;
  failures: readonly Pick<FailedAttempt, 'attempt'>[];
}

/**
 * Whether a proposal, or a step's proposal, has been through more than one Run, or its only one
 * failed: only then is it worth telling which attempt it is at.
 */
function triedAgain(p: AttemptsOf): p is AttemptsOf & { attempt: number } {
  return p.attempt !== null && (p.attempt > 1 || p.failures.length > 0);
}

/**
 * Where the attempts at an accepted or failed proposal (a step of an iteration included) stand:
 * 「第 2/3 次尝试」 while a redo works on it or waits, or 「失败 3 次，达到尝试次数上限，不再自动
 * 重做」 once it failed (「重新开始后又失败 3 次…」 when it failed before it was started over, its
 * attempts counted from 1 again). null for one not decided or rejected, and for an accepted one
 * whose first Run has not failed.
 */
export function attemptsText(p: Pick<ProposalView, 'status'> & AttemptsOf): string | null {
  if (p.status === 'failed') {
    const n = p.attempt ?? p.failures.length;
    return p.failures.length > n
      ? t({
          zh: `重新开始后又失败 ${n} 次，达到尝试次数上限（max_run_attempts），不再自动重做`,
          en: `Failed ${n === 1 ? 'once more' : `${n} more times`} after being started over, the most attempts it gets (max_run_attempts); not redone any more`,
        })
      : t({
          zh: `失败 ${n} 次，达到尝试次数上限（max_run_attempts），不再自动重做`,
          en: `Failed ${n === 1 ? 'once' : `${n} times`}, the most attempts it gets (max_run_attempts); not redone any more`,
        });
  }
  if (p.status !== 'accepted' || !triedAgain(p)) return null;
  return attemptText(p.attempt, p.maxAttempts);
}

/**
 * When the failed Run of a proposal (or a step's) waiting to be redone is redone (`redoText`, as
 * on a Run's page): 「预计 14:05 自动重做，开始第 2 次尝试」; null when it does not wait.
 */
export function proposalRedoText(
  p: { redoAt: string | null; attempt: number | null },
  now = new Date(),
): string | null {
  return p.redoAt && p.attempt !== null ? redoText(p.redoAt, p.attempt, now) : null;
}

/** 「第 1 次，失败在「编码」阶段」: which attempt failed, and in which stage if any. */
export function failureLabel(f: Pick<FailedAttempt, 'attempt' | 'stage'>): string {
  return labelIn(f, 1);
}

/**
 * The label of each failed attempt, oldest first, as `failureLabel` gives it; once a human started
 * the proposal over, its attempts counted from 1 again, the later ones tell their round:
 * 「第 2 轮第 1 次，失败在「编码」阶段」. A new round begins wherever the attempt does not go up.
 */
export function failureLabels(
  failures: readonly Pick<FailedAttempt, 'attempt' | 'stage'>[],
): string[] {
  let round = 1;
  return failures.map((f, i) => {
    const before = failures[i - 1];
    if (before && f.attempt <= before.attempt) round += 1;
    return labelIn(f, round);
  });
}

function labelIn(f: Pick<FailedAttempt, 'attempt' | 'stage'>, round: number): string {
  const which =
    round > 1
      ? t({ zh: `第 ${round} 轮第 ${f.attempt} 次`, en: `Round ${round}, attempt ${f.attempt}` })
      : t({ zh: `第 ${f.attempt} 次`, en: `Attempt ${f.attempt}` });
  return f.stage
    ? t({
        zh: `${which}，失败在「${f.stage}」阶段`,
        en: `${which}, failed in the "${f.stage}" stage`,
      })
    : which;
}

/** 「失败的尝试（3 次）及原因」: the heading of the failures folded under a proposal or a step. */
export function failuresHeading(n: number): string {
  return t({ zh: `失败的尝试（${n} 次）及原因`, en: `Failed attempts (${n}) and why` });
}

/**
 * What starting a failed proposal over does, beside its button: for one of its own, or a step
 * (`iterationId`) whose iteration goes on again unless another step still blocks it. null unless
 * it may be started over (`restartable`).
 */
export function restartHint(
  p: Pick<ProposalView, 'restartable'> & { iterationId: string | null },
): string | null {
  if (!p.restartable) return null;
  const common = t({
    zh: '不再自动重做了。修好原因后可以重新开始：次数从头算，马上建一个新的 Run，它会看到之前每次失败的原因',
    en: 'It is not redone automatically any more. Once the cause is fixed, start it over: its attempts count from 1 again, and a new Run is created at once, told why each earlier attempt failed',
  });
  return p.iterationId === null
    ? common
    : t({
        zh: `${common}；迭代没有别的步骤卡住时回到进行中`,
        en: `${common}; the iteration goes on again unless another step still blocks it`,
      });
}

/**
 * Why a failed proposal cannot be started over now, as the Master would refuse it: its repo left
 * backlog.repos, or has problems. null when it can, and for one that may not be started over at
 * all (`restartable` false). `problemsShown`: the page shows the repo's problems above the
 * proposal, so they are only pointed to; otherwise they are spelled out.
 */
export function restartBlocker(
  p: Pick<ProposalView, 'restartable' | 'repo'>,
  repo: Pick<BacklogRepoStatus, 'problems'> | null,
  problemsShown = true,
): string | null {
  if (!p.restartable) return null;
  if (!repo) {
    return t({
      zh: `${p.repo} 已经不在 config.yaml 的 backlog.repos 里，不能再重新开始它的提案`,
      en: `${p.repo} is no longer in backlog.repos of config.yaml, so its proposals cannot be started over`,
    });
  }
  if (repo.problems.length === 0) return null;
  if (problemsShown) {
    return t({
      zh: '这个仓库的配置有问题（见上面），改好之后才能重新开始',
      en: 'The repo has problems (see above); fix them before starting it over',
    });
  }
  // The problems come from the Master, in its language; only the separator follows the page's.
  const problems = repo.problems.join(t({ zh: '；', en: '; ' }));
  return t({
    zh: `${p.repo} 的配置有问题，改好之后才能重新开始：${problems}`,
    en: `${p.repo} has problems; fix them before starting it over: ${problems}`,
  });
}

/**
 * Why a failed step of an iteration of the local backlog cannot be started over now, as
 * `restartBlocker` says of a proposal of `repo` (the iteration's), the repo's problems spelled
 * out: the iteration's page does not show them. null while the local backlog's status is not
 * known (`backlog` undefined), so that the button is not held back on a guess; the Master still
 * refuses what it must.
 */
export function stepRestartBlocker(
  step: Pick<ProposalView, 'restartable'>,
  repo: string,
  backlog: Pick<BacklogStatus, 'repos'> | undefined,
): string | null {
  if (!backlog) return null;
  const status = backlog.repos.find((r) => r.name === repo) ?? null;
  return restartBlocker({ restartable: step.restartable, repo }, status, false);
}

/** The button that starts a failed proposal (or step) over, and what confirming it says. */
export function restartLabels(): { label: string; confirm: string } {
  return {
    label: t({ zh: '重新开始', en: 'Start over' }),
    confirm: t({
      zh: '确认重新开始：次数从头算，马上建 Run',
      en: 'Confirm: count from 1 again and create a Run now',
    }),
  };
}

/**
 * How and when a proposal was decided: 「11-20 09:30 自动采纳」 / "Accepted automatically
 * 11-20 09:30"; null while pending.
 */
export function decidedText(
  p: Pick<ProposalView, 'status' | 'auto' | 'decidedAt'>,
  now = new Date(),
): string | null {
  if (p.status === 'pending') return null;
  const at = p.decidedAt ? formatTime(p.decidedAt, now) : null;
  if (p.status === 'rejected') {
    return at ? t({ zh: `${at} 拒绝`, en: `Rejected ${at}` }) : t({ zh: '拒绝', en: 'Rejected' });
  }
  if (p.auto) {
    return at
      ? t({ zh: `${at} 自动采纳`, en: `Accepted automatically ${at}` })
      : t({ zh: '自动采纳', en: 'Accepted automatically' });
  }
  return at ? t({ zh: `${at} 采纳`, en: `Accepted ${at}` }) : t({ zh: '采纳', en: 'Accepted' });
}

/**
 * Where a scout's proposal went: an issue on GitHub, or the local backlog (`auto`: accepted
 * without a human); `where` null when it was filed nowhere (it failed, or the scout is cut short).
 */
export function scoutProposalFiled(p: Pick<ScoutProposal, 'issue' | 'local'>): {
  where: 'issue' | 'local' | null;
  auto: boolean;
} {
  if (p.issue) return { where: 'issue', auto: p.issue.auto };
  if (p.local) return { where: 'local', auto: p.local.auto };
  return { where: null, auto: false };
}

/**
 * The live events after which the local backlog on the page is out of date: proposals filed,
 * accepted, rejected, redone, failed or started over, on their own or with their iteration,
 * scouts, Runs created or changing status (an accepted proposal shows its Run's status), and
 * configuration reloads (backlog.repos changed).
 */
export function backlogOutdatedBy(type: string): boolean {
  return (
    type.startsWith('proposal.') ||
    type.startsWith('iteration.') ||
    type.startsWith('scout.') ||
    type.startsWith('config.') ||
    type === 'run.created' ||
    type === 'run.status'
  );
}
