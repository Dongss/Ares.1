import type { RepoSourceView, RepoTrial, RepoTrialResult } from '../../../src/api/types.js';
import { t } from '../../../src/i18n.js';
import type { Repo, RepoServe } from '../../../src/store/types.js';
import { parseLines } from './format.js';
import { GITHUB, hostLabel, type IssueHost, issuesUrl, newIssueUrl } from './issues.js';
import { lacksVerify, type TrialRow, trialRows } from './repos.js';
import { href } from './router.js';

// The wizard of the Repos page that brings a new project in, step by step: which step it is at,
// where it may go from there, and what each step says. The steps call the APIs the Repos page's
// cards use (registering, detecting, trying the commands, setting the requirements' source).

/** The wizard's steps, in order. */
export const ONBOARD_STEPS = ['register', 'commands', 'trial', 'source'] as const;
export type OnboardStep = (typeof ONBOARD_STEPS)[number];
/** Where the wizard is: a step, or the page after the last one. */
export type OnboardAt = OnboardStep | 'done';

/** How a step the wizard left ended. */
export type OnboardEnd = 'done' | 'skipped';

export interface OnboardState {
  at: OnboardAt;
  /**
   * How each step the wizard went through ended. Going back keeps the marks; the wizard goes
   * forward one step at a time, so every step after the one gone back to ends again before the
   * last page.
   */
  ended: Partial<Record<OnboardStep, OnboardEnd>>;
}

export function onboardStart(): OnboardState {
  return { at: 'register', ended: {} };
}

/** The step's 1-based number; the page after the last step counts as one more. */
function position(at: OnboardAt): number {
  return at === 'done' ? ONBOARD_STEPS.length + 1 : ONBOARD_STEPS.indexOf(at) + 1;
}

/** Ends the step the wizard is at, done or skipped, and moves to the next; the last page stays. */
export function onboardNext(state: OnboardState, how: OnboardEnd = 'done'): OnboardState {
  if (state.at === 'done') return state;
  const next = ONBOARD_STEPS[position(state.at)] ?? 'done';
  return { at: next, ended: { ...state.ended, [state.at]: how } };
}

/**
 * Whether the wizard may go back to `step`: one it has passed, except registering, since the repo
 * is registered by then and is not taken back.
 */
export function onboardCanGoBack(state: OnboardState, step: OnboardStep): boolean {
  return step !== 'register' && position(step) < position(state.at);
}

export function onboardBack(state: OnboardState, step: OnboardStep): OnboardState {
  return onboardCanGoBack(state, step) ? { ...state, at: step } : state;
}

export function onboardStepTitle(step: OnboardStep): string {
  switch (step) {
    case 'register':
      return t({ zh: '登记仓库', en: 'Register the repo' });
    case 'commands':
      return t({ zh: '检查命令', en: 'Commands' });
    case 'trial':
      return t({ zh: '试运行', en: 'Trial run' });
    case 'source':
      return t({ zh: '需求来源', en: 'Requirements source' });
  }
}

/** The heading of the step the wizard is at: its number and title. */
export function onboardStepHeading(step: OnboardStep): string {
  const n = position(step);
  return t({
    zh: `第 ${n} 步：${onboardStepTitle(step)}`,
    en: `Step ${n}: ${onboardStepTitle(step)}`,
  });
}

/** What the step does, under its heading in the wizard and in the Guide. */
export function onboardStepSummary(step: OnboardStep): string {
  switch (step) {
    case 'register':
      return t({
        zh: '登记本机已有的 git 仓库，或者让 Master 从远端克隆一个、新建一个空项目。登记好仓库就在列表里了，之后中途关掉向导也不会撤销。',
        en: 'Register a git repo already on this machine, or have the Master clone one from a remote or make a new empty project. Once registered, the repo stays in the list even if the wizard is closed halfway.',
      });
    case 'commands':
      return t({
        zh: 'Master 按目标分支上提交了的项目文件（package.json、pyproject.toml、manage.py、go.mod 等）建议准备命令和检查命令，填进输入框；也建议服务启动命令，点「采用建议」才填进「服务」一栏。检查、修改后保存到仓库。检查命令在每个 Task 完成后运行，全部通过才算验收通过；启动命令可空，要在流程里对跑起来的服务做检查（冒烟测试、E2E）时才填，写了 serve: true 的命令阶段用它为 Run 起服务。',
        en: 'The Master suggests the setup and verify commands from the project files committed on the target branch (package.json, pyproject.toml, manage.py, go.mod and the like) and fills them in; it suggests a service start command too, put in the Service boxes once you choose Use the suggestion. Check or change them, then save them to the repo. The verify commands run after each Task, which passes only when all of them pass. The start command is optional: fill it in to check a running service (smoke tests, E2E), which a command stage with serve: true then starts for each Run.',
      });
    case 'trial':
      return t({
        zh: '在目标分支当前的提交上，用 Run 的环境依次跑一遍准备命令、起服务（填了启动命令的话，就绪后马上停掉）、跑检查命令，不建 Run。没通过时写明是哪条命令或者服务、为什么，可以回到上一步改了再试；也可以跳过。',
        en: 'Runs the setup commands, starts the service if there is a start command (stopping it once it is ready) and runs the verify commands, once, on the commit the target branch is at, in the environment Runs use, without creating a Run. When something fails, it says which command, or the service, and why; go back a step to change them and try again, or skip it.',
      });
    case 'source':
      return t({
        zh: '选需求从哪来：GitHub 或 GitLab 上打了 ares1:ready 标签的 issue，或者 Master 自己保存的本地提案池；再选模板、侦察和自动采纳。Master 把它写进 config.yaml，马上生效。',
        en: 'Choose where requirements come from: issues labeled ares1:ready on GitHub or GitLab, or the local backlog the Master keeps itself; then the template, the scout and auto-accept. The Master writes it into config.yaml and puts it in use at once.',
      });
  }
}

/** Where a step stands in the wizard's row of steps. */
export type OnboardMark = 'done' | 'skipped' | 'current' | 'todo';

export interface OnboardStepItem {
  step: OnboardStep;
  n: number;
  title: string;
  mark: OnboardMark;
  /** It can be clicked to go back to it. */
  canGoBack: boolean;
}

/**
 * The wizard's row of steps: those passed with how they ended, the current one, and those still
 * ahead (including ones passed before going back, which the wizard goes through again).
 */
export function onboardSteps(state: OnboardState): OnboardStepItem[] {
  const at = position(state.at);
  return ONBOARD_STEPS.map((step) => {
    const n = position(step);
    const mark: OnboardMark =
      n === at ? 'current' : n > at ? 'todo' : (state.ended[step] ?? 'done');
    return {
      step,
      n,
      title: onboardStepTitle(step),
      mark,
      canGoBack: onboardCanGoBack(state, step),
    };
  });
}

export function onboardMarkLabel(mark: OnboardMark): string {
  switch (mark) {
    case 'done':
      return t({ zh: '已完成', en: 'Done' });
    case 'skipped':
      return t({ zh: '已跳过', en: 'Skipped' });
    case 'current':
      return t({ zh: '当前', en: 'Current' });
    case 'todo':
      return t({ zh: '未开始', en: 'Not yet' });
  }
}

/** What the Repos page says by its button that opens the wizard. */
export function onboardEntryHint(): string {
  return t({
    zh: '第一次接入一个项目？「接入新项目」按顺序带你登记仓库、填好检查命令和（要的话）服务启动命令、试运行一遍、设置需求从哪来，最后告诉你怎么开始。',
    en: 'Bringing a project in for the first time? "Bring in a new project" takes you through registering the repo, filling in its verify commands and, if it needs one, its service start command, trying them and setting where requirements come from, then tells you how to start.',
  });
}

/**
 * What closing the wizard leaves behind, said by its close button: the repo stays registered.
 * null before registering (nothing to leave) and on the last page (nothing left to do).
 */
export function onboardCloseNote(at: OnboardAt): string | null {
  if (at === 'register' || at === 'done') return null;
  return t({
    zh: '仓库已经登记好了：现在关掉向导不会撤销，之后可以在仓库卡片上接着设置（「修改」「试运行」和需求来源后面的「设置」）。',
    en: 'The repo is registered: closing the wizard now does not undo that, and the rest can be set on its card later (Edit, Try the commands, and Set by its requirements).',
  });
}

/**
 * Whether the commands step detects the commands by itself as it opens: only while the repo has
 * no commands and no service saved, so nothing saved or typed is replaced (and a saved service
 * says the step was gone through already).
 */
export function detectsOnEntry(
  repo: Pick<Repo, 'verifyCommands' | 'setupCommands' | 'serve'>,
): boolean {
  return (
    repo.serve === null &&
    [...repo.verifyCommands, ...repo.setupCommands].every((c) => c.trim() === '')
  );
}

/** The warning under the verify commands as typed in the commands step; null when there are some. */
export function commandsWarning(verify: string): string | null {
  if (parseLines(verify).length > 0) return null;
  return t({
    zh: '还没有检查命令：可以先这样保存，但之后 Run 的改动不经检查就会进入评审和合并。新建的空项目还没有代码时，可以等有了代码再到仓库卡片上补。',
    en: "No verify commands yet: you can save like this, but then a Run's changes go to review and merge without any check. A new empty project without code yet can have them added on its card later.",
  });
}

/**
 * How the trial of the commands and service saved in the wizard went, by the repo's latest trial:
 * `none` when there is none, or it is over and tried other commands or another service (from
 * before they were changed, or from the edit form). One under way counts whatever it tries, since
 * no other can start meanwhile.
 */
export type TrialOutcome = 'none' | 'running' | 'passed' | 'failed';

export function trialOutcome(
  trial:
    | Pick<RepoTrial, 'status' | 'setupCommands' | 'verifyCommands' | 'serve'>
    | null
    | undefined,
  saved: Pick<Repo, 'setupCommands' | 'verifyCommands' | 'serve'>,
): TrialOutcome {
  if (!trial) return 'none';
  if (trial.status === 'running') return 'running';
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((c, i) => c === b[i]);
  if (!same(trial.setupCommands, saved.setupCommands)) return 'none';
  if (!same(trial.verifyCommands, saved.verifyCommands)) return 'none';
  if (!sameServe(trial.serve, saved.serve)) return 'none';
  return trial.status;
}

/** Two services alike: none, or the same start command, ready path and ready timeout. */
function sameServe(a: RepoServe | null, b: RepoServe | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.command === b.command &&
    a.readyPath === b.readyPath &&
    a.readyTimeoutSeconds === b.readyTimeoutSeconds
  );
}

/** What the trial step offers, by how the trial went. */
export interface TrialStepView {
  startLabel: string;
  canStart: boolean;
  /** Going on to the next step without skipping: only once the saved commands passed. */
  canContinue: boolean;
  /** What to do now. */
  note: string;
  /** Said by the skip button, which is there unless the trial passed; null when it passed. */
  skipWarning: string | null;
}

/** `busy`: a request to start a trial is under way. */
export function trialStepView(outcome: TrialOutcome, busy: boolean): TrialStepView {
  const startLabel =
    outcome === 'running' || busy
      ? t({ zh: '试运行中…', en: 'Trying…' })
      : outcome === 'none'
        ? t({ zh: '试运行', en: 'Try the commands' })
        : t({ zh: '再试一次', en: 'Try again' });
  const passed = outcome === 'passed';
  return {
    startLabel,
    canStart: !busy && outcome !== 'running',
    canContinue: passed,
    note: trialStepNote(outcome),
    skipWarning: passed ? null : skipTrialWarning(),
  };
}

function trialStepNote(outcome: TrialOutcome): string {
  switch (outcome) {
    case 'none':
      return t({
        zh: '还没试过刚保存的命令和服务。试运行通过了才能进入下一步，也可以跳过。',
        en: 'The commands and service just saved have not been tried yet. The next step opens once they pass; you can also skip it.',
      });
    case 'running':
      return t({
        zh: '试运行中，跑完一条刷新一条。可以等它跑完，也可以先跳过。',
        en: 'Trying them; each command, and the service, shows as soon as it is done. Wait for it, or skip ahead.',
      });
    case 'passed':
      return t({
        zh: '全部通过，接下来设置需求从哪来。',
        en: 'All passed. Next, set where requirements come from.',
      });
    case 'failed':
      return t({
        zh: '改好再试：命令或者服务设置写错了就回到第 2 步改；是环境或目标分支的问题，修好后直接再试一次。',
        en: 'Fix it and try again: go back to step 2 if a command or the service settings are wrong; if it is the environment or the target branch, fix that and just try again.',
      });
  }
}

/** What skipping the trial risks, by the skip button and on the last page when it was skipped. */
export function skipTrialWarning(): string {
  return t({
    zh: '不试运行的话，命令写错了、程序没装、服务起不来或者目标分支本身就过不了，要等第一个 Run 编码完才会发现，然后一轮轮返工白花钱。以后可以随时在仓库卡片上点「试运行」。',
    en: "Without a trial, a wrong command, a missing program, a service that does not come up or a target branch that fails on its own only shows once the first Run has done its coding, and then rework after rework costs money for nothing. You can try the commands on the repo's card any time later.",
  });
}

/** What a trial's failure is about: a command of its kind, or its service's start command. */
export type TrialFailureKind = TrialRow['kind'] | 'serve';

/** Why a trial did not pass, as the trial step tells it. */
export interface TrialFailure {
  /**
   * The command that did not pass, and its kind (`serve`: the start command of a service that did
   * not become ready); null when the trial stopped for another reason.
   */
  kind: TrialFailureKind | null;
  command: string | null;
  /** What went wrong, said after the command (or alone without one). */
  reason: string;
  /** What to do about it. */
  advice: string;
}

/**
 * Why the trial failed, the first thing that went wrong in the order the trial goes: a setup
 * command, then the service not becoming ready, then a verify command (which run whether the
 * service did or not); else why it could not go on. null unless it failed.
 */
export function trialFailure(
  trial: Pick<
    RepoTrial,
    'status' | 'setupCommands' | 'verifyCommands' | 'results' | 'serve' | 'serviceResult' | 'error'
  >,
): TrialFailure | null {
  if (trial.status !== 'failed') return null;
  const rows = trialRows(trial);
  const failed = (kind: TrialRow['kind']): TrialFailure | null => {
    const row = rows.find((r) => r.kind === kind && r.state === 'failed');
    return row?.result ? commandFailure(row, row.result) : null;
  };
  const first = failed('setup') ?? serviceFailure(trial) ?? failed('verify');
  if (first) return first;
  return {
    kind: null,
    command: null,
    reason: trial.error
      ? t({ zh: `试运行没能进行：${trial.error}`, en: `The trial could not go on: ${trial.error}` })
      : t({ zh: '试运行没通过。', en: 'The trial failed.' }),
    advice: t({
      zh: '这不是哪条命令的问题（比如目标分支读不到）。处理好之后再试一次。',
      en: 'No command is to blame (the target branch could not be read, say). Sort that out and try again.',
    }),
  };
}

/** Why the service of the trial did not become ready; null when it did or was not started. */
function serviceFailure(trial: Pick<RepoTrial, 'serve' | 'serviceResult'>): TrialFailure | null {
  const { serve, serviceResult: r } = trial;
  if (!serve || !r || r.ok) return null;
  const at = { kind: 'serve' as const, command: serve.command };
  switch (r.reason) {
    case 'timeout': {
      const n = serve.readyTimeoutSeconds;
      return {
        ...at,
        reason: t({
          zh: `超时了：${n} 秒内服务没有就绪。`,
          en: `timed out: the service was not ready within ${n} ${n === 1 ? 'second' : 'seconds'}.`,
        }),
        advice: t({
          zh: `展开上面服务那一行看日志末尾。服务要监听环境变量 PORT 给的端口（比如 vite 要加 --port $PORT），只听自己默认端口的话 Master 等不到它；对就绪路径 ${serve.readyPath} 的请求要收到状态码小于 500 的响应。启动确实慢就回到第 2 步调大就绪超时；启动命令或就绪路径不对，也回到第 2 步改。`,
          en: `Open the service row above to see the end of its log. The service must listen on the port in the PORT environment variable (vite needs --port $PORT, say): the Master never sees one listening on its own default port. And a request to the ready path ${serve.readyPath} must get an answer with a status below 500. If it really starts that slowly, go back to step 2 and raise the ready timeout; go back there too if the start command or the ready path is wrong.`,
        }),
      };
    }
    case 'aborted':
      return {
        ...at,
        reason: t({ zh: '被中止了。', en: 'was stopped.' }),
        advice: t({
          zh: '服务被停掉了（比如 Master 停止了），不一定是启动命令的问题，再试一次。',
          en: "The service was stopped (when the Master stops, say), which need not be the start command's fault; try again.",
        }),
      };
    default:
      return {
        ...at,
        reason:
          r.exitCode === null
            ? t({
                zh: '在服务就绪之前就退出了。',
                en: 'exited before the service was ready.',
              })
            : t({
                zh: `在服务就绪之前就退出了（退出码 ${r.exitCode}）。`,
                en: `exited before the service was ready (exit code ${r.exitCode}).`,
              }),
        advice: t({
          zh: '展开上面服务那一行看日志末尾。启动命令要一直在前台运行到被停掉，不能把服务放到后台就退出（不要加 &，也不要用守护进程模式）；服务要监听环境变量 PORT 给的端口，写死的端口被占用也会让它退出。启动命令写错了就回到第 2 步改；是项目在目标分支上本身起不来，先修好再试一次。',
          en: 'Open the service row above to see the end of its log. The start command must keep running in the foreground until it is stopped, not put the service in the background and exit (no trailing &, no daemon mode); and the service must listen on the port in the PORT environment variable, as a fixed port already taken makes it exit too. If the start command is wrong, go back to step 2 and change it; if the project does not start on the target branch as it is, fix that first and try again.',
        }),
      };
  }
}

/** Why a command of the trial did not pass: its row, and its result. */
function commandFailure(row: TrialRow, r: RepoTrialResult): TrialFailure {
  const at = { kind: row.kind, command: row.command };
  if (r.missingProgram) {
    return {
      ...at,
      reason: t({
        zh: `没能运行：运行环境里找不到 ${r.missingProgram}。`,
        en: `could not run: ${r.missingProgram} is not found in the environment.`,
      }),
      advice: t({
        zh: `这是 Master 运行环境的问题，不是命令写错了：装好 ${r.missingProgram}，或者让 Master 的 PATH 里能找到它（比如换 Node 版本后重启 Master），再试一次，不用改命令。`,
        en: `That is a problem of the Master's environment, not a wrong command: install ${r.missingProgram} or make the Master's PATH find it (restart the Master after switching Node versions, say), then try again without changing the commands.`,
      }),
    };
  }
  if (r.timedOut) {
    return {
      ...at,
      reason: t({ zh: '超时了。', en: 'timed out.' }),
      advice: t({
        zh: '展开上面这条命令看输出末尾卡在哪里。命令在等输入或者不会自己结束（比如进了 watch 模式）的话，回到第 2 步换一条；确实要跑这么久，就调大 config.yaml 的 defaults.command_timeout_minutes。',
        en: 'Open the command above to see where its output stops. If it waits for input or never ends by itself (a watch mode, say), go back to step 2 and change it; if it really takes that long, raise defaults.command_timeout_minutes in config.yaml.',
      }),
    };
  }
  if (r.exitCode === null) {
    return {
      ...at,
      reason: t({ zh: '被中止了。', en: 'was stopped.' }),
      advice: t({
        zh: '命令被终止了（比如 Master 停止了），不一定是命令的问题，再试一次。',
        en: 'The command was killed (when the Master stops, say), which need not be its fault; try again.',
      }),
    };
  }
  return {
    ...at,
    reason: t({
      zh: `没通过：退出码 ${r.exitCode}。`,
      en: `failed with exit code ${r.exitCode}.`,
    }),
    advice: t({
      zh: '展开上面这条命令看输出末尾。命令写错了（比如脚本名不对）就回到第 2 步改；是项目在目标分支上本身就过不了，先修好再试一次。',
      en: 'Open the command above to see the end of its output. If the command is wrong (a script name, say), go back to step 2 and change it; if the project fails on the target branch as it is, fix that first and try again.',
    }),
  };
}

/** What a failure's command is, before it: which kind of command, or the start command. */
export function trialKindLabel(kind: TrialFailureKind): string {
  switch (kind) {
    case 'setup':
      return t({ zh: '准备命令', en: 'The setup command' });
    case 'verify':
      return t({ zh: '检查命令', en: 'The verify command' });
    case 'serve':
      return t({ zh: '启动命令', en: 'The start command' });
  }
}

/**
 * What the source step says over its form: the repo may have an entry in config.yaml already
 * (written by hand before registering), which the form starts from.
 */
export function sourceStepNote(current: RepoSourceView | null): string {
  if (!current) {
    return t({
      zh: '选好后点「保存」；也可以先跳过，以后在仓库卡片上需求来源后面点「设置」。没有需求来源的仓库不会有 Run。',
      en: "Choose and save, or skip for now and use Set by the repo card's requirements later. A repo without a source of requirements gets no Runs.",
    });
  }
  return t({
    zh: `config.yaml 里已经有这个仓库的条目（需求来源：${sourceName(current)}），表单按它填好了；不用改的话可以直接跳过。`,
    en: `config.yaml has an entry for this repo already, its requirements coming from ${sourceName(current)}; the form starts from it, and this step can be skipped if it needs no change.`,
  });
}

type HostSourceView = Extract<RepoSourceView, { source: 'github' | 'gitlab' }>;

function sourceHost(source: HostSourceView): IssueHost {
  return source.source === 'gitlab' ? { platform: 'gitlab', host: source.host } : GITHUB;
}

/** Where the requirements come from, as said in a sentence. */
function sourceName(source: RepoSourceView): string {
  return source.source === 'backlog'
    ? t({ zh: '本地提案池', en: 'the local backlog' })
    : hostLabel(sourceHost(source));
}

/** The line that opens the last page. */
export function onboardDoneLead(repo: string, source: RepoSourceView | null): string {
  if (!source) {
    return t({
      zh: `${repo} 登记好了，但还没有需求来源，所以还不会有 Run。`,
      en: `${repo} is registered, but it has no source of requirements yet, so it gets no Runs.`,
    });
  }
  return t({
    zh: `${repo} 接入好了，需求来源：${sourceName(source)}。接下来：`,
    en: `${repo} is in, its requirements coming from ${sourceName(source)}. Next:`,
  });
}

/** A link of the last page: to a page of the dashboard, or out to the code host. */
export interface OnboardLink {
  href: string;
  label: string;
  external: boolean;
}

export interface OnboardNextStep {
  text: string;
  link: OnboardLink | null;
  /** The wizard's step it takes going back to, when it does. */
  back?: OnboardStep;
}

function issuesPageLink(): OnboardLink {
  return {
    href: href.issues,
    label: t({ zh: '去「需求」页', en: 'Go to Issues' }),
    external: false,
  };
}

/**
 * What to do once the wizard is through, by where the repo's requirements come from: on GitHub or
 * GitLab, label an issue ares1:ready; on the local backlog, write one on the Issues page; with a
 * scout, have it find work on the Issues page. None without a source.
 */
export function onboardNextSteps(repo: string, source: RepoSourceView | null): OnboardNextStep[] {
  if (!source) return [];
  const steps: OnboardNextStep[] = [];
  if (source.source !== 'backlog') {
    const host = sourceHost(source);
    const where = hostLabel(host);
    steps.push({
      text: t({
        zh: `在 ${where} 上给要做的 issue 打上 ares1:ready 标签，或者新建一个带这个标签的：Master 下次检查 ${where} 时把它建成 Run。`,
        en: `Label an issue to be done ares1:ready on ${where}, or open a new one with that label: the Master turns it into a Run the next time it checks ${where}.`,
      }),
      link: source.issuesRepo
        ? {
            href: newIssueUrl(host, source.issuesRepo, 'ares1:ready'),
            label: t({ zh: `在 ${where} 上新建 issue`, en: `New issue on ${where}` }),
            external: true,
          }
        : issuesPageLink(),
    });
    if (source.issuesRepo) {
      steps.push({
        text: t({
          zh: '已经有的 issue 在这里，挑要做的打上标签。',
          en: 'The issues already there: label the ones to be done.',
        }),
        link: {
          href: issuesUrl(host, source.issuesRepo),
          label: t({ zh: `${where} 上的 issue`, en: `Issues on ${where}` }),
          external: true,
        },
      });
    }
  } else {
    steps.push({
      text: t({
        zh: `去「需求」页，在 ${repo} 的卡片上点「写需求」，把要做的事写进去，马上开工或者先存着。`,
        en: `On the Issues page, choose "Write a requirement" on the card of ${repo} and write down what is to be done, to start at once or keep for later.`,
      }),
      link: issuesPageLink(),
    });
  }
  const scout = source.settings.scout;
  if (scout) {
    const auto = scout.auto
      ? t({
          zh: '设成了自动侦察，仓库空闲时它也会自己去找。',
          en: 'Scouting is automatic too, so it also looks by itself when the repo is idle.',
        })
      : '';
    steps.push({
      text: t({
        zh: `也可以让 AI 找活：在「需求」页 ${repo} 下点「让 AI 找活」手动侦察，AI 读代码、文档和 Run 记录后提需求，等你采纳（在自动采纳范围内的直接开工）。${auto}`,
        en: `Or have the AI find work: choose "Let the AI find work" under ${repo} on the Issues page to scout by hand. It reads the code, the docs and past Runs and proposes requirements for you to accept (those within auto-accept start at once).${auto ? ` ${auto}` : ''}`,
      }),
      link: issuesPageLink(),
    });
  } else {
    steps.push({
      text: t({
        zh: '想让 AI 读代码自己找活，回到第 4 步给它选一个侦察 Agent（scout.agent）。',
        en: 'To have the AI read the code and find work itself, go back to step 4 and choose a scout agent (scout.agent).',
      }),
      link: null,
      back: 'source',
    });
  }
  return steps;
}

/** Something the last page warns about, with the step that sees to it. */
export interface OnboardReminder {
  step: OnboardStep;
  text: string;
}

/**
 * What the last page warns about: no verify commands, the trial skipped, no source of
 * requirements. `trial`: how the trial step ended.
 */
export function onboardReminders(input: {
  repo: Pick<Repo, 'verifyCommands'>;
  trial: OnboardEnd | undefined;
  source: RepoSourceView | null;
}): OnboardReminder[] {
  const reminders: OnboardReminder[] = [];
  if (lacksVerify(input.repo)) {
    reminders.push({
      step: 'commands',
      text: t({
        zh: '没有检查命令：Run 的改动不经检查就会进入评审和合并。',
        en: "No verify commands: a Run's changes go to review and merge without any check.",
      }),
    });
  }
  if (input.trial === 'skipped') {
    reminders.push({
      step: 'trial',
      text: `${t({ zh: '试运行跳过了。', en: 'The trial was skipped.' })} ${skipTrialWarning()}`,
    });
  }
  if (!input.source) {
    reminders.push({
      step: 'source',
      text: t({
        zh: '没有需求来源：这个仓库不会有 Run，也不会侦察。',
        en: 'No source of requirements: the repo gets no Runs and no scouts.',
      }),
    });
  }
  return reminders;
}

/** The button of a reminder that goes back to the step that sees to it. */
export function backToStepLabel(step: OnboardStep): string {
  const n = position(step);
  return t({ zh: `回到第 ${n} 步`, en: `Back to step ${n}` });
}
