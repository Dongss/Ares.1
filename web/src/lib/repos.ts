import type {
  RepoDetection,
  RepoInput,
  RepoTrial,
  RepoTrialResult,
  RepoTrialStatus,
} from '../../../src/api/types.js';
import { t } from '../../../src/i18n.js';
import type { Repo } from '../../../src/store/types.js';
import {
  formatDuration,
  formatSpan,
  formatTime,
  parseLines,
  shortSha,
  type Tone,
} from './format.js';

/**
 * Where the repo registered on the Repos page comes from: already on this machine, cloned by
 * the Master, or a new empty project the Master makes.
 */
export const REPO_ORIGINS = ['local', 'clone', 'init'] as const;
export type RepoOrigin = (typeof REPO_ORIGINS)[number];

export function repoOriginLabel(origin: RepoOrigin): string {
  switch (origin) {
    case 'local':
      return t({ zh: '已有本地仓库', en: 'Existing local repo' });
    case 'clone':
      return t({ zh: '从远端克隆', en: 'Clone from a remote' });
    case 'init':
      return t({ zh: '新建空项目', en: 'New empty project' });
  }
}

export function repoOriginHint(origin: RepoOrigin): string {
  switch (origin) {
    case 'local':
      return t({
        zh: '登记本机已有的 git 仓库，目标分支要已经存在。',
        en: 'Registers a git repo already on this machine; the target branch must exist.',
      });
    case 'clone':
      return t({
        zh: 'Master 用本机的 git 凭据把仓库克隆到下面的路径（不存在或为空的目录）再登记。地址可以是 https://、ssh://、user@host:path 或本机的绝对路径。',
        en: "The Master clones the repo with this machine's git credentials to the path below (missing or an empty directory), then registers it. The address may be https://, ssh://, user@host:path or an absolute path on this machine.",
      });
    case 'init':
      return t({
        zh: 'Master 在下面的路径（不存在或为空的目录）新建一个 git 仓库，在目标分支上做一次空的初始提交再登记。',
        en: 'The Master makes a new git repo at the path below (missing or an empty directory) with an empty first commit on the target branch, then registers it.',
      });
  }
}

export function repoPathLabel(origin: RepoOrigin): string {
  return origin === 'local'
    ? t({ zh: '本机路径（绝对路径）', en: 'Local path (absolute)' })
    : t({
        zh: '放到本机哪里（绝对路径，不存在或为空的目录）',
        en: 'Where on this machine (absolute path, missing or an empty directory)',
      });
}

export function targetBranchPlaceholder(origin: RepoOrigin): string {
  switch (origin) {
    case 'local':
      return t({ zh: '默认：当前检出的分支', en: 'Default: the branch checked out now' });
    case 'clone':
      return t({ zh: '默认：远端的默认分支', en: "Default: the remote's default branch" });
    case 'init':
      return t({ zh: '默认：main', en: 'Default: main' });
  }
}

/** The register button's text; `busy`: the request is under way (a clone may take a while). */
export function registerLabel(origin: RepoOrigin, busy: boolean): string {
  if (!busy) return t({ zh: '登记', en: 'Register' });
  switch (origin) {
    case 'local':
      return t({ zh: '登记中…', en: 'Registering…' });
    case 'clone':
      return t({ zh: '正在克隆…', en: 'Cloning…' });
    case 'init':
      return t({ zh: '正在新建…', en: 'Creating…' });
  }
}

/** What the human filled in on the register form, as typed. */
export interface AddRepoForm {
  origin: RepoOrigin;
  name: string;
  path: string;
  /** The address to clone; only read for `clone`. */
  url: string;
  targetBranch: string;
  /** Commands, one per line. */
  verify: string;
  setup: string;
}

/** The body of POST /api/repos for the form: trimmed, blank optional fields left out. */
export function newRepoInput(form: AddRepoForm): RepoInput {
  const input: RepoInput = {
    name: form.name.trim(),
    path: form.path.trim(),
    targetBranch: form.targetBranch.trim() || undefined,
    verifyCommands: parseLines(form.verify),
    setupCommands: parseLines(form.setup),
  };
  if (form.origin === 'clone') input.source = { kind: 'clone', url: form.url.trim() };
  if (form.origin === 'init') input.source = { kind: 'init' };
  return input;
}

/**
 * The repo has no verify commands: a Run's changes then go to review and merge unchecked (a
 * template stage's own `verify.commands` aside, which this does not look at).
 */
export function lacksVerify(repo: Pick<Repo, 'verifyCommands'>): boolean {
  return repo.verifyCommands.every((command) => command.trim() === '');
}

/** The badge on the card of a repo without verify commands. */
export function noVerifyBadge(): string {
  return t({ zh: '没有检查命令', en: 'No verify commands' });
}

/** Why that badge matters, next to the empty verify commands. */
export function noVerifyWarning(): string {
  return t({
    zh: '没有检查命令：Run 的改动不经检查就会进入评审和合并。点「修改」可以按项目文件探测该填什么。',
    en: "No verify commands: a Run's changes go to review and merge without any check. Choose Edit to detect them from the project files.",
  });
}

/**
 * A commands box of the edit form once detected: the suggested commands, one per line; what was
 * typed when there is no suggestion for it. Nothing is saved.
 */
export function detectedBox(suggested: readonly string[], typed: string): string {
  return suggested.length > 0 ? suggested.join('\n') : typed;
}

/** What the edit form says after detecting: what was read, and what became of the boxes. */
export function detectionNote(detection: RepoDetection): string {
  const read = t({
    zh: `读自目标分支 ${detection.branch}（提交 ${shortSha(detection.commit)}）已提交的文件。`,
    en: `Read from the files committed on the target branch ${detection.branch} (commit ${shortSha(detection.commit)}).`,
  });
  if (detection.verify.length === 0 && detection.setup.length === 0) {
    return `${read}${t({
      zh: '没有可填的建议，输入框没有改动。',
      en: ' Nothing to suggest; the boxes are left as they were.',
    })}`;
  }
  return `${read}${t({
    zh: '建议已填进下面的输入框（没有建议的那一栏不动），检查无误后点「保存」才生效。',
    en: ' The suggestions are in the boxes below (a box without one is left as it was); they take effect once you check them and choose Save.',
  })}`;
}

/** The detect button's text; `busy`: the request is under way. */
export function detectLabel(busy: boolean): string {
  return busy
    ? t({ zh: '探测中…', en: 'Detecting…' })
    : t({ zh: '按项目文件探测', en: 'Detect from project files' });
}

/** Where a command of a trial is, as its row on the dashboard shows it. */
export type TrialRowState = 'passed' | 'failed' | 'running' | 'waiting' | 'skipped';

/** One command of a trial, run or not: its result once it has one. */
export interface TrialRow {
  kind: RepoTrialResult['kind'];
  command: string;
  state: TrialRowState;
  result: RepoTrialResult | null;
}

/**
 * Every command a trial tries, setup commands first, each with its result when it has one.
 * While the trial runs, the first without a result is the one running and the rest wait; once
 * it is over, those without a result were not run (an earlier command failed, or a missing
 * program kept all of them from running). A result goes to the first command of its kind with
 * its text that has none yet.
 */
export function trialRows(
  trial: Pick<RepoTrial, 'status' | 'setupCommands' | 'verifyCommands' | 'results'>,
): TrialRow[] {
  const rows: TrialRow[] = [
    ...trial.setupCommands.map((command) => ({ kind: 'setup' as const, command })),
    ...trial.verifyCommands.map((command) => ({ kind: 'verify' as const, command })),
  ].map((c) => ({ ...c, state: 'waiting' as TrialRowState, result: null }));
  for (const result of trial.results) {
    const row = rows.find(
      (r) => r.result === null && r.kind === result.kind && r.command === result.command,
    );
    if (row) {
      row.result = result;
      row.state = result.ok ? 'passed' : 'failed';
    }
  }
  let next = trial.status === 'running';
  for (const row of rows) {
    if (row.result) continue;
    if (trial.status !== 'running') row.state = 'skipped';
    else if (next) {
      row.state = 'running';
      next = false;
    }
  }
  return rows;
}

/** The badge of a trial's status. */
export function trialStatusBadge(status: RepoTrialStatus): { label: string; tone: Tone } {
  switch (status) {
    case 'running':
      return { label: t({ zh: '试运行中', en: 'Trying' }), tone: 'active' };
    case 'passed':
      return { label: t({ zh: '全部通过', en: 'All passed' }), tone: 'success' };
    case 'failed':
      return { label: t({ zh: '没通过', en: 'Failed' }), tone: 'danger' };
  }
}

/** What a command's row says after its command: how it went, or that it has not run. */
export function trialRowNote(row: TrialRow): string {
  const r = row.result;
  switch (row.state) {
    case 'running':
      return t({ zh: '运行中…', en: 'running…' });
    case 'waiting':
      return t({ zh: '等待', en: 'waiting' });
    case 'skipped':
      return t({ zh: '没有运行', en: 'not run' });
    case 'passed':
      return t({
        zh: `通过（${formatDuration(r?.durationMs ?? 0)}）`,
        en: `passed (${formatDuration(r?.durationMs ?? 0)})`,
      });
    case 'failed':
      if (r?.missingProgram) {
        return t({ zh: `找不到 ${r.missingProgram}`, en: `${r.missingProgram} not found` });
      }
      if (r?.timedOut) return t({ zh: '超时', en: 'timed out' });
      if (r?.exitCode === null || r?.exitCode === undefined) {
        return t({ zh: '被中止', en: 'stopped' });
      }
      return t({ zh: `退出码 ${r.exitCode}`, en: `exit code ${r.exitCode}` });
  }
}

/**
 * Why a command could not find its program (`missingProgram`): the Master's environment, not
 * the repo, and what to do about it.
 */
export function missingProgramNote(program: string): string {
  return t({
    zh: `运行环境里找不到 \`${program}\`。这是 Master 运行环境的问题，不是仓库的问题：装好 ${program}，或者让 Master 的 PATH 里能找到它（比如换 Node 版本后重启 Master），再试一次。Run 遇到这种情况会停下来等环境修好，不返工、不消耗重做次数。`,
    en: `\`${program}\` is not found in the environment. That is a problem of the Master's environment, not of the repo: install ${program} or make the Master's PATH find it (restart the Master after switching Node versions, say), then try again. A Run that meets it waits for the environment to be fixed, without rework or using up a redo.`,
  });
}

/**
 * The line under a trial's badge: the commit tried, and when it started or how long it took
 * (`now` for a trial under way).
 */
export function trialSummary(
  trial: Pick<RepoTrial, 'branch' | 'sha' | 'startedAt' | 'endedAt' | 'status'>,
  now = Date.now(),
): string {
  const where = trial.sha
    ? t({
        zh: `目标分支 ${trial.branch}（提交 ${shortSha(trial.sha)}）`,
        en: `target branch ${trial.branch} (commit ${shortSha(trial.sha)})`,
      })
    : t({ zh: `目标分支 ${trial.branch}`, en: `target branch ${trial.branch}` });
  const span = formatSpan(trial.startedAt, trial.endedAt, now);
  const when =
    trial.status === 'running'
      ? t({
          zh: `${formatTime(trial.startedAt)} 开始，已用 ${span}`,
          en: `started at ${formatTime(trial.startedAt)}, ${span} so far`,
        })
      : t({
          zh: `${formatTime(trial.startedAt)} 开始，用时 ${span}`,
          en: `started at ${formatTime(trial.startedAt)}, took ${span}`,
        });
  return `${where} · ${when}`;
}

/** The trial button's text; `form`: it tries the commands of the edit form, not the saved ones. */
export function trialLabel(running: boolean, form: boolean): string {
  if (running) return t({ zh: '试运行中…', en: 'Trying…' });
  return form
    ? t({ zh: '试运行表单里的命令', en: 'Try the commands in the form' })
    : t({ zh: '试运行', en: 'Try the commands' });
}
