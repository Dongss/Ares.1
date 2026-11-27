import type {
  RepoDetection,
  RepoInput,
  RepoPatchInput,
  RepoServeInput,
  RepoTrial,
  RepoTrialResult,
  RepoTrialStatus,
} from '../../../src/api/types.js';
import {
  REPO_SERVE_DEFAULTS,
  REPO_SERVE_TIMEOUT_SECONDS,
  serveReadyPathValid,
  serveReadyTimeoutValid,
} from '../../../src/config/flow.js';
import { t } from '../../../src/i18n.js';
import type { Repo, RepoServe } from '../../../src/store/types.js';
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

export function verifyLabel(): string {
  return t({ zh: '检查命令', en: 'Verify commands' });
}

export function setupLabel(): string {
  return t({ zh: '准备命令', en: 'Setup commands' });
}

/** What the verify commands are for, by their box. */
export function verifyHint(): string {
  return t({
    zh: '每个 Task 完成后执行，全部通过才算验收通过（模板阶段没有设置时使用）',
    en: 'Run after each Task; it passes only when all of them pass (used when the template stage sets none)',
  });
}

/** What the setup commands are for, by their box. */
export function setupHint(): string {
  return t({
    zh: '每个 Run 创建工作目录后执行一次，例如 npm ci',
    en: 'Run once after each Run creates its working directory, e.g. npm ci',
  });
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

/**
 * What the edit form says after detecting: what was read, and what became of the boxes. The
 * suggested start command is not put in the service boxes: they may hold a service saved on
 * purpose, so the human adopts it there (`adoptServeSuggestion`).
 */
export function detectionNote(detection: RepoDetection): string {
  const read = t({
    zh: `读自目标分支 ${detection.branch}（提交 ${shortSha(detection.commit)}）已提交的文件。`,
    en: `Read from the files committed on the target branch ${detection.branch} (commit ${shortSha(detection.commit)}).`,
  });
  const commands = detection.verify.length > 0 || detection.setup.length > 0;
  if (!commands && !detection.serve) {
    return `${read}${t({
      zh: '没有可填的建议，输入框没有改动。',
      en: ' Nothing to suggest; the boxes are left as they were.',
    })}`;
  }
  const boxes = commands
    ? t({
        zh: '建议已填进下面的输入框（没有建议的那一栏不动），检查无误后点「保存」才生效。',
        en: ' The suggestions are in the boxes below (a box without one is left as it was); they take effect once you check them and choose Save.',
      })
    : t({
        zh: '准备命令和检查命令没有可填的建议，输入框没有改动。',
        en: ' No setup or verify commands to suggest; their boxes are left as they were.',
      });
  if (!detection.serve) return `${read}${boxes}`;
  const adopt = adoptSuggestionLabel();
  return `${read}${boxes}${t({
    zh: `建议的启动命令不会自动填进「服务」一栏，要用就点那里的「${adopt}」，同样保存后才生效。`,
    en: ` The suggested start command is not put in the Service boxes by itself: choose ${adopt} there to use it, and Save as well.`,
  })}`;
}

/** The suggested service of a detection: the start command, its ready path and why. */
export type ServeSuggestion = NonNullable<RepoDetection['serve']>;

/** The button by a suggested start command that puts it in the service boxes. */
export function adoptSuggestionLabel(): string {
  return t({ zh: '采用建议', en: 'Use the suggestion' });
}

/**
 * The service boxes with the suggested start command and ready path in them; the ready timeout
 * stays as typed, the suggestion having none (the default is left to it).
 */
export function adoptServeSuggestion(
  form: ServeForm,
  suggestion: Pick<ServeSuggestion, 'command' | 'readyPath'>,
): ServeForm {
  return { ...form, command: suggestion.command, readyPath: suggestion.readyPath };
}

/**
 * Whether the service boxes hold the suggestion already, so that adopting it would change
 * nothing: the same start command and ready path once trimmed, a blank ready path being the
 * default one.
 */
export function serveSuggestionAdopted(
  form: ServeForm,
  suggestion: Pick<ServeSuggestion, 'command' | 'readyPath'>,
): boolean {
  return (
    form.command.trim() === suggestion.command &&
    (form.readyPath.trim() || REPO_SERVE_DEFAULTS.readyPath) === suggestion.readyPath
  );
}

/** What the service boxes say when detecting suggested no start command. */
export function noServeSuggestionNote(): string {
  return t({
    zh: '按项目文件探测没有建议启动命令，原因见上面探测结果的最后一条。',
    en: 'Detecting from the project files suggested no start command; the last line of what it found above says why.',
  });
}

/** The detect button's text; `busy`: the request is under way. */
export function detectLabel(busy: boolean): string {
  return busy
    ? t({ zh: '探测中…', en: 'Detecting…' })
    : t({ zh: '按项目文件探测', en: 'Detect from project files' });
}

/**
 * The service boxes of the edit form, as typed. A blank ready path or timeout takes the
 * default (`REPO_SERVE_DEFAULTS`), which the boxes show as their placeholders.
 */
export interface ServeForm {
  command: string;
  readyPath: string;
  /** Whole seconds. */
  readyTimeoutSeconds: string;
}

/** The service boxes for the repo's saved service; all blank when it has none. */
export function serveFormInit(serve: RepoServe | null): ServeForm {
  if (!serve) return emptyServeForm();
  return {
    command: serve.command,
    readyPath: serve.readyPath,
    readyTimeoutSeconds: String(serve.readyTimeoutSeconds),
  };
}

/** The service boxes cleared: saved like this, the repo has no service. */
export function emptyServeForm(): ServeForm {
  return { command: '', readyPath: '', readyTimeoutSeconds: '' };
}

/** Whether every service box is blank, so that clearing them would change nothing. */
export function serveFormBlank(form: ServeForm): boolean {
  return [form.command, form.readyPath, form.readyTimeoutSeconds].every((v) => v.trim() === '');
}

/** A typed ready timeout: the default when blank, NaN when it is not a whole number. */
function typedTimeout(typed: string): number {
  const s = typed.trim();
  if (s === '') return REPO_SERVE_DEFAULTS.readyTimeoutSeconds;
  return /^\d+$/.test(s) ? Number(s) : Number.NaN;
}

/**
 * What keeps the service boxes from being saved, one line each, by the rules the API checks.
 * None without a start command: saving then removes the service, and the other two boxes are
 * not sent.
 */
export function serveFormProblems(form: ServeForm): string[] {
  if (form.command.trim() === '') return [];
  const problems: string[] = [];
  const path = form.readyPath.trim();
  if (path !== '' && !serveReadyPathValid(path)) {
    problems.push(t({ zh: '就绪路径必须以 / 开头', en: 'The ready path must start with /' }));
  }
  if (!serveReadyTimeoutValid(typedTimeout(form.readyTimeoutSeconds))) {
    const { min, max } = REPO_SERVE_TIMEOUT_SECONDS;
    problems.push(
      t({
        zh: `就绪超时必须是 ${min} 到 ${max} 之间的整数（秒）`,
        en: `The ready timeout must be a whole number of seconds from ${min} to ${max}`,
      }),
    );
  }
  return problems;
}

/**
 * `serve` of PATCH /api/repos/:id for the service boxes: null, which removes the service, without
 * a start command; blank boxes take the defaults. For boxes without problems (`serveFormProblems`).
 */
export function serveInput(form: ServeForm): RepoServeInput | null {
  const command = form.command.trim();
  if (command === '') return null;
  return {
    command,
    readyPath: form.readyPath.trim() || REPO_SERVE_DEFAULTS.readyPath,
    readyTimeoutSeconds: typedTimeout(form.readyTimeoutSeconds),
  };
}

/** What the edit form of a repo holds, as typed. */
export interface EditRepoForm {
  targetBranch: string;
  /** Commands, one per line. */
  verify: string;
  setup: string;
  serve: ServeForm;
}

/** The body of PATCH /api/repos/:id for the edit form: every setting it shows, trimmed. */
export function repoPatch(form: EditRepoForm): RepoPatchInput {
  return {
    targetBranch: form.targetBranch.trim(),
    verifyCommands: parseLines(form.verify),
    setupCommands: parseLines(form.setup),
    serve: serveInput(form.serve),
  };
}

export function serveLabel(): string {
  return t({ zh: '服务启动命令', en: 'Service start command' });
}

/** What the start command is for, by its box. */
export function serveHint(): string {
  return t({
    zh: '写了 serve: true 的命令阶段先在 Run 的工作目录里运行它起服务，等服务就绪再跑命令，命令跑完停掉。服务要监听环境变量 PORT 给的端口；留空就是不起服务',
    en: "A command stage with serve: true first runs it in the Run's working directory to start the service, runs its commands once the service is ready, and stops it after them. The service must listen on the port in the PORT environment variable; leave it empty for no service",
  });
}

/** What the ready path is for, by its box. */
export function serveReadyPathHint(): string {
  return t({
    zh: '对这个路径的请求收到状态码小于 500 的响应就算就绪',
    en: 'The service is ready once a request to this path gets an answer with a status below 500',
  });
}

/** What the ready timeout is for, by its box. */
export function serveTimeoutHint(): string {
  const { min, max } = REPO_SERVE_TIMEOUT_SECONDS;
  return t({
    zh: `这么久还没就绪，阶段就按命令失败处理（${min}–${max}）`,
    en: `Not ready by then, the stage fails as a failed command would (${min}–${max})`,
  });
}

/** How a repo's card describes its saved service, after the start command. */
export function serveSummary(serve: Pick<RepoServe, 'readyPath' | 'readyTimeoutSeconds'>): string {
  const n = serve.readyTimeoutSeconds;
  return t({
    zh: `就绪路径 ${serve.readyPath}，最多等 ${n} 秒`,
    en: `ready at ${serve.readyPath}, within ${n} ${n === 1 ? 'second' : 'seconds'}`,
  });
}

/** What a repo's card says when it has no service. */
export function noServeNote(): string {
  return t({
    zh: '无（写了 serve: true 的命令阶段不起服务，命令照常运行）',
    en: 'None (a command stage with serve: true starts no service and runs its commands as usual)',
  });
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
 * its text that has none yet. The service, which `trialServiceView` shows, comes between the
 * setup and the verify commands: while it is still to start or starting, no verify command runs.
 */
export function trialRows(
  trial: Pick<
    RepoTrial,
    'status' | 'setupCommands' | 'verifyCommands' | 'results' | 'serve' | 'serviceResult'
  >,
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
  const servicePending = trial.serve !== null && trial.serviceResult === null;
  let next = trial.status === 'running';
  for (const row of rows) {
    if (row.kind === 'verify' && servicePending) next = false;
    if (row.result) continue;
    if (trial.status !== 'running') row.state = 'skipped';
    else if (next) {
      row.state = 'running';
      next = false;
    }
  }
  return rows;
}

/**
 * Where a trial's service is: `none`, no start command to try; `waiting` for the setup commands;
 * `starting`, waiting for it to answer; `ready`, it answered (and was stopped); not ready by its
 * timeout (`timeout`), ended before it was (`exited`), or stopped with the Master (`aborted`);
 * `skipped`, never started (a setup command failed, or the trial ended before it got there).
 */
export type TrialServiceState =
  | 'none'
  | 'waiting'
  | 'starting'
  | 'ready'
  | 'timeout'
  | 'exited'
  | 'aborted'
  | 'skipped';

/** A trial's service as its row between the setup and the verify commands shows it. */
export interface TrialServiceView {
  state: TrialServiceState;
  /** How its row looks: as a command's row in the same state would. */
  row: TrialRowState;
  /** The start command tried; null without one. */
  command: string | null;
  /** What its row says after the start command. */
  note: string;
  /** The end of its output, once it answered or was given up on; null before. */
  outputTail: string | null;
}

/** The name of a trial's service row, before its start command. */
export function trialServiceLabel(): string {
  return t({ zh: '服务', en: 'Service' });
}

/** How a trial's service went, or where it is while the trial runs. */
export function trialServiceView(
  trial: Pick<RepoTrial, 'status' | 'setupCommands' | 'results' | 'serve' | 'serviceResult'>,
): TrialServiceView {
  const { serve } = trial;
  if (!serve) {
    return {
      state: 'none',
      row: 'skipped',
      command: null,
      note: t({ zh: '没有启动命令，不试服务', en: 'no start command, so no service to try' }),
      outputTail: null,
    };
  }
  const seconds = serve.readyTimeoutSeconds;
  const view = (state: TrialServiceState, row: TrialRowState, note: string): TrialServiceView => ({
    state,
    row,
    command: serve.command,
    note,
    outputTail: trial.serviceResult?.outputTail ?? null,
  });
  const r = trial.serviceResult;
  if (r?.ok) {
    const took = formatDuration(r.durationMs);
    return view(
      'ready',
      'passed',
      t({
        zh: `已就绪：${r.url ?? ''}，用时 ${took}，随后已停掉`,
        en: `ready at ${r.url ?? ''} after ${took}, then stopped`,
      }),
    );
  }
  if (r) {
    switch (r.reason) {
      case 'timeout':
        return view(
          'timeout',
          'failed',
          t({
            zh: `超时：${seconds} 秒内没有就绪`,
            en: `timed out: not ready within ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`,
          }),
        );
      case 'aborted':
        return view(
          'aborted',
          'failed',
          t({ zh: '被中止（Master 停止了）', en: 'stopped (the Master stopped)' }),
        );
      default:
        return view(
          'exited',
          'failed',
          r.exitCode === null
            ? t({ zh: '进程提前退出', en: 'exited before it was ready' })
            : t({
                zh: `进程提前退出（退出码 ${r.exitCode}）`,
                en: `exited before it was ready (exit code ${r.exitCode})`,
              }),
        );
    }
  }
  // Not started yet: the trial runs it once every setup command passed, never after a failure.
  if (trial.results.some((result) => !result.ok)) {
    return view(
      'skipped',
      'skipped',
      trial.results.some((result) => result.kind === 'setup' && !result.ok)
        ? t({ zh: '没有运行（准备命令没通过）', en: 'not run (a setup command failed)' })
        : t({ zh: '没有运行', en: 'not run' }),
    );
  }
  if (trial.status !== 'running') {
    return view('skipped', 'skipped', t({ zh: '没有运行', en: 'not run' }));
  }
  const setupPassed = trial.results.filter((result) => result.kind === 'setup').length;
  if (setupPassed < trial.setupCommands.length) {
    return view(
      'waiting',
      'waiting',
      t({ zh: '等准备命令通过后起服务', en: 'starts once the setup commands pass' }),
    );
  }
  return view(
    'starting',
    'running',
    t({
      zh: `起服务中…（最多等 ${seconds} 秒就绪）`,
      en: `starting… (ready within ${seconds} ${seconds === 1 ? 'second' : 'seconds'} at most)`,
    }),
  );
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

/**
 * The trial button's text; `form`: it tries the commands and service of the edit form, not the
 * saved ones.
 */
export function trialLabel(running: boolean, form: boolean): string {
  if (running) return t({ zh: '试运行中…', en: 'Trying…' });
  return form
    ? t({ zh: '试运行表单里的命令和服务', en: 'Try the commands and service in the form' })
    : t({ zh: '试运行', en: 'Try the commands' });
}

/**
 * What the trial button does, by it: on the commit the saved target branch `branch` is at, the
 * setup commands, the service started and stopped once it answers, then the verify commands.
 * `form`: those of the edit form, unsaved; else the saved ones.
 */
export function trialHint(branch: string, form: boolean): string {
  return form
    ? t({
        zh: `用表单里的命令和服务设置（不保存），在已保存的目标分支 ${branch} 当前的提交上依次跑准备命令、起服务（就绪后马上停掉）、跑检查命令，和 Run 用的环境一样，不建 Run；服务一栏没有启动命令时不试服务`,
        en: `Runs the setup commands, starts the service (stopping it once it is ready) and runs the verify commands of the form (without saving them) on the commit the saved target branch ${branch} is at, in the environment Runs use; no Run is created, and no service is tried without a start command in the Service boxes`,
      })
    : t({
        zh: `在目标分支 ${branch} 当前的提交上依次跑准备命令、起登记的服务（有的话，就绪后马上停掉）、跑检查命令，和 Run 用的环境一样，不建 Run、什么都不改`,
        en: `Runs the setup commands, starts the registered service if there is one (stopping it once it is ready) and runs the verify commands on the commit the target branch ${branch} is at, in the environment Runs use; no Run is created and nothing changes`,
      });
}

/** What a trial says when it has nothing to try. */
export function trialNothingNote(): string {
  return t({
    zh: '没有准备命令、检查命令，也没有启动命令，没什么可跑的。',
    en: 'There are no setup, verify or start commands: nothing to run.',
  });
}
