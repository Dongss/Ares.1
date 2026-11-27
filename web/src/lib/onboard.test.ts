import { afterEach, describe, expect, it } from 'vitest';
import type { RepoSourceView, RepoTrial, RepoTrialResult } from '../../../src/api/types.js';
import { REPO_SOURCE_DEFAULTS } from '../../../src/config/flow.js';
import { setLang } from '../../../src/i18n.js';
import {
  backToStepLabel,
  commandsWarning,
  detectsOnEntry,
  ONBOARD_STEPS,
  type OnboardState,
  onboardBack,
  onboardCanGoBack,
  onboardCloseNote,
  onboardDoneLead,
  onboardEntryHint,
  onboardMarkLabel,
  onboardNext,
  onboardNextSteps,
  onboardReminders,
  onboardStart,
  onboardStepHeading,
  onboardStepSummary,
  onboardSteps,
  onboardStepTitle,
  skipTrialWarning,
  sourceStepNote,
  trialFailure,
  trialKindLabel,
  trialOutcome,
  trialStepView,
} from './onboard.js';

afterEach(() => setLang('zh'));

const CJK = /[　-〿一-鿿＀-￯]/;

const saved = { setupCommands: ['npm ci'], verifyCommands: ['npm run build', 'npm test'] };

function trial(extra: Partial<RepoTrial> = {}): RepoTrial {
  return {
    repoId: 'repo-1',
    status: 'passed',
    branch: 'main',
    sha: 'abcdef1234567890',
    startedAt: '2026-11-27T10:00:00.000Z',
    endedAt: '2026-11-27T10:00:42.000Z',
    ...saved,
    results: [],
    error: null,
    log: null,
    ...extra,
  };
}

function result(extra: Partial<RepoTrialResult>): RepoTrialResult {
  return {
    kind: 'verify',
    command: 'npm test',
    ok: false,
    exitCode: 1,
    timedOut: false,
    durationMs: 1200,
    outputTail: 'boom',
    missingProgram: null,
    ...extra,
  };
}

/** A trial that ran `npm ci` and `npm run build`, then `last`. */
function failedAt(last: Partial<RepoTrialResult>): RepoTrial {
  return trial({
    status: 'failed',
    results: [
      result({ kind: 'setup', command: 'npm ci', ok: true, exitCode: 0 }),
      result({ command: 'npm run build', ok: true, exitCode: 0 }),
      result(last),
    ],
  });
}

const settings = {
  template: 'dev',
  scout: null,
  auto_accept: { max_risk: 'none' as const, max_size: 'L' as const, max_per_day: null },
  auto_merge: false,
  max_run_attempts: 3,
  daily_budget_usd: null,
};
const scout = {
  agent: 'claude-reviewer',
  auto: REPO_SOURCE_DEFAULTS.scout.auto,
  interval_minutes: 0,
  max_proposals: 5,
};
const github: RepoSourceView = {
  source: 'github',
  issuesRepo: 'me/demo',
  settings: { ...settings, push: false, deliver: 'push' },
};
const githubInferred: RepoSourceView = { ...github, issuesRepo: null };
const gitlab: RepoSourceView = {
  source: 'gitlab',
  host: 'gitlab.example.com',
  issuesRepo: 'team/demo',
  settings: { ...settings, scout, push: false, deliver: 'push' },
};
const backlog: RepoSourceView = { source: 'backlog', settings: { ...settings, scout } };

/** Walks the wizard forward from its start, each step ended as given. */
function walk(...ends: ('done' | 'skipped')[]): OnboardState {
  return ends.reduce((s, how) => onboardNext(s, how), onboardStart());
}

describe('the steps', () => {
  it('go register, commands, trial, source, then the last page', () => {
    expect(ONBOARD_STEPS).toEqual(['register', 'commands', 'trial', 'source']);
    let state = onboardStart();
    const visited = [state.at];
    for (let i = 0; i < 4; i++) {
      state = onboardNext(state);
      visited.push(state.at);
    }
    expect(visited).toEqual(['register', 'commands', 'trial', 'source', 'done']);
    expect(onboardNext(state)).toBe(state);
  });

  it('remember how each step ended', () => {
    const state = walk('done', 'done', 'skipped', 'skipped');
    expect(state.at).toBe('done');
    expect(state.ended).toEqual({
      register: 'done',
      commands: 'done',
      trial: 'skipped',
      source: 'skipped',
    });
  });

  it('go back to a step passed, never to registering', () => {
    const atTrial = walk('done', 'done');
    expect(atTrial.at).toBe('trial');
    expect(onboardCanGoBack(atTrial, 'register')).toBe(false);
    expect(onboardCanGoBack(atTrial, 'commands')).toBe(true);
    expect(onboardCanGoBack(atTrial, 'trial')).toBe(false);
    expect(onboardCanGoBack(atTrial, 'source')).toBe(false);
    expect(onboardBack(atTrial, 'register')).toBe(atTrial);
    expect(onboardBack(atTrial, 'source')).toBe(atTrial);
    expect(onboardBack(atTrial, 'commands').at).toBe('commands');

    const done = walk('done', 'done', 'done', 'done');
    expect(onboardCanGoBack(done, 'source')).toBe(true);
    expect(onboardCanGoBack(done, 'trial')).toBe(true);
    expect(onboardCanGoBack(onboardStart(), 'commands')).toBe(false);
  });

  it('go forward again one by one after going back, ending each step again', () => {
    const done = walk('done', 'done', 'done', 'done');
    let state = onboardBack(done, 'commands');
    expect(state.at).toBe('commands');
    state = onboardNext(state);
    expect(state.at).toBe('trial');
    state = onboardNext(state, 'skipped');
    expect(state.at).toBe('source');
    expect(state.ended.trial).toBe('skipped');
  });

  it('mark the steps passed, the current one and those ahead', () => {
    const marks = (s: OnboardState) => onboardSteps(s).map((i) => i.mark);
    expect(marks(onboardStart())).toEqual(['current', 'todo', 'todo', 'todo']);
    expect(marks(walk('done', 'done', 'skipped'))).toEqual(['done', 'done', 'skipped', 'current']);
    expect(marks(walk('done', 'done', 'skipped', 'done'))).toEqual([
      'done',
      'done',
      'skipped',
      'done',
    ]);
    // Steps passed before going back are ahead again.
    const back = onboardBack(walk('done', 'done', 'done', 'done'), 'commands');
    expect(marks(back)).toEqual(['done', 'current', 'todo', 'todo']);
    const items = onboardSteps(walk('done', 'done', 'done'));
    expect(items.map((i) => i.n)).toEqual([1, 2, 3, 4]);
    expect(items.map((i) => i.canGoBack)).toEqual([false, true, true, false]);
    expect(items.map((i) => i.title)).toEqual(['登记仓库', '检查命令', '试运行', '需求来源']);
  });

  it('say what each step is', () => {
    expect(onboardStepHeading('register')).toBe('第 1 步：登记仓库');
    expect(onboardStepHeading('source')).toBe('第 4 步：需求来源');
    expect(backToStepLabel('commands')).toBe('回到第 2 步');
    for (const step of ONBOARD_STEPS) expect(onboardStepSummary(step)).not.toBe('');
    expect(onboardStepSummary('trial')).toContain('不建 Run');
    expect(onboardStepSummary('source')).toContain('ares1:ready');
  });

  it('say that closing keeps the repo once it is registered', () => {
    expect(onboardCloseNote('register')).toBeNull();
    expect(onboardCloseNote('done')).toBeNull();
    for (const at of ['commands', 'trial', 'source'] as const) {
      expect(onboardCloseNote(at)).toContain('不会撤销');
    }
  });
});

describe('the commands step', () => {
  it('detects by itself only while the repo has no commands saved', () => {
    expect(detectsOnEntry({ verifyCommands: [], setupCommands: [] })).toBe(true);
    expect(detectsOnEntry({ verifyCommands: [' '], setupCommands: [] })).toBe(true);
    expect(detectsOnEntry({ verifyCommands: [], setupCommands: ['npm ci'] })).toBe(false);
    expect(detectsOnEntry(saved)).toBe(false);
  });

  it('warns while there is no verify command', () => {
    expect(commandsWarning('')).toContain('还没有检查命令');
    expect(commandsWarning('  \n \n')).toContain('还没有检查命令');
    expect(commandsWarning('npm test')).toBeNull();
  });
});

describe('the trial step', () => {
  it('counts the latest trial only when it tried the saved commands', () => {
    expect(trialOutcome(undefined, saved)).toBe('none');
    expect(trialOutcome(null, saved)).toBe('none');
    expect(trialOutcome(trial(), saved)).toBe('passed');
    expect(trialOutcome(trial({ status: 'failed' }), saved)).toBe('failed');
    // Tried before the commands changed, or from the edit form.
    expect(trialOutcome(trial({ verifyCommands: ['npm test'] }), saved)).toBe('none');
    expect(trialOutcome(trial({ setupCommands: [] }), saved)).toBe('none');
    expect(trialOutcome(trial({ verifyCommands: ['npm test', 'npm run build'] }), saved)).toBe(
      'none',
    );
    // One under way blocks another, whatever it tries.
    expect(trialOutcome(trial({ status: 'running', setupCommands: [] }), saved)).toBe('running');
  });

  it('goes on only once the trial passed, and can be skipped otherwise', () => {
    const none = trialStepView('none', false);
    expect(none).toMatchObject({ startLabel: '试运行', canStart: true, canContinue: false });
    expect(none.skipWarning).toBe(skipTrialWarning());

    const running = trialStepView('running', false);
    expect(running).toMatchObject({ startLabel: '试运行中…', canStart: false, canContinue: false });
    expect(running.skipWarning).not.toBeNull();

    const failed = trialStepView('failed', false);
    expect(failed).toMatchObject({ startLabel: '再试一次', canStart: true, canContinue: false });
    expect(failed.note).toContain('回到第 2 步');
    expect(failed.skipWarning).not.toBeNull();

    const passed = trialStepView('passed', false);
    expect(passed).toMatchObject({ startLabel: '再试一次', canStart: true, canContinue: true });
    expect(passed.skipWarning).toBeNull();

    expect(trialStepView('none', true)).toMatchObject({ startLabel: '试运行中…', canStart: false });
  });

  it('says which command failed and why', () => {
    expect(trialFailure(trial())).toBeNull();
    expect(trialFailure(trial({ status: 'running' }))).toBeNull();

    const exit = trialFailure(failedAt({ command: 'npm test', exitCode: 2 }));
    expect(exit).toMatchObject({ kind: 'verify', command: 'npm test' });
    expect(exit?.reason).toBe('没通过：退出码 2。');
    expect(exit?.advice).toContain('回到第 2 步');

    const timedOut = trialFailure(failedAt({ exitCode: null, timedOut: true }));
    expect(timedOut?.reason).toBe('超时了。');
    expect(timedOut?.advice).toContain('command_timeout_minutes');

    const stopped = trialFailure(failedAt({ exitCode: null }));
    expect(stopped?.reason).toBe('被中止了。');
  });

  it('tells a missing program from a wrong command', () => {
    const missing = trialFailure(
      trial({
        status: 'failed',
        results: [
          result({ kind: 'setup', command: 'npm ci', exitCode: null, missingProgram: 'node' }),
        ],
      }),
    );
    expect(missing).toMatchObject({ kind: 'setup', command: 'npm ci' });
    expect(missing?.reason).toContain('找不到 node');
    expect(missing?.advice).toContain('不用改命令');
    expect(trialKindLabel('setup')).toBe('准备命令');
    expect(trialKindLabel('verify')).toBe('检查命令');
  });

  it('says why when no command is to blame', () => {
    const error = trialFailure(trial({ status: 'failed', error: '读不到目标分支 main' }));
    expect(error).toMatchObject({ kind: null, command: null });
    expect(error?.reason).toBe('试运行没能进行：读不到目标分支 main');
    expect(trialFailure(trial({ status: 'failed' }))?.reason).toBe('试运行没通过。');
  });
});

describe('the source step', () => {
  it('says when config.yaml has the repo already', () => {
    expect(sourceStepNote(null)).toContain('跳过');
    expect(sourceStepNote(github)).toContain('需求来源：GitHub');
    expect(sourceStepNote(gitlab)).toContain('GitLab（gitlab.example.com）');
    expect(sourceStepNote(backlog)).toContain('本地提案池');
  });
});

describe('the last page', () => {
  it('has GitHub repos label an issue, linking to a new one', () => {
    expect(onboardDoneLead('demo', github)).toBe('demo 接入好了，需求来源：GitHub。接下来：');
    const steps = onboardNextSteps('demo', github);
    expect(steps[0]?.text).toContain('ares1:ready');
    expect(steps[0]?.link).toEqual({
      href: 'https://github.com/me/demo/issues/new?labels=ares1%3Aready',
      label: '在 GitHub 上新建 issue',
      external: true,
    });
    expect(steps[1]?.link?.href).toBe(
      `https://github.com/me/demo/issues?q=${encodeURIComponent('is:issue is:open')}`,
    );
    // No scout: going back to choose one.
    expect(steps[2]).toMatchObject({ link: null, back: 'source' });
    expect(steps[2]?.text).toContain('侦察 Agent');
  });

  it('sends GitHub repos without issues_repo to the Issues page', () => {
    const steps = onboardNextSteps('demo', githubInferred);
    expect(steps[0]?.link).toEqual({ href: '#/issues', label: '去「需求」页', external: false });
    expect(steps).toHaveLength(2);
  });

  it('has GitLab repos label an issue on their GitLab, or scout by hand', () => {
    const steps = onboardNextSteps('demo', gitlab);
    expect(steps[0]?.text).toContain('GitLab（gitlab.example.com）');
    expect(steps[0]?.link?.href).toMatch(
      /^https:\/\/gitlab\.example\.com\/team\/demo\/-\/issues\/new\?/,
    );
    const last = steps[steps.length - 1];
    expect(last?.text).toContain('让 AI 找活');
    expect(last?.text).toContain('自动侦察');
    expect(last?.link).toEqual({ href: '#/issues', label: '去「需求」页', external: false });
  });

  it('has local backlog repos write a requirement, or scout by hand', () => {
    expect(onboardDoneLead('demo', backlog)).toContain('本地提案池');
    const steps = onboardNextSteps('demo', backlog);
    expect(steps).toHaveLength(2);
    expect(steps[0]?.text).toContain('写需求');
    expect(steps[0]?.link?.href).toBe('#/issues');
    expect(steps[1]?.text).toContain('让 AI 找活');
    const manual = onboardNextSteps('demo', {
      ...backlog,
      settings: { ...settings, scout: { ...scout, auto: false } },
    });
    expect(manual[1]?.text).not.toContain('自动侦察');
  });

  it('has nothing to start without a source, and says so', () => {
    expect(onboardNextSteps('demo', null)).toEqual([]);
    expect(onboardDoneLead('demo', null)).toContain('还不会有 Run');
  });

  it('reminds of what was left out, each with the step to go back to', () => {
    expect(onboardReminders({ repo: saved, trial: 'done', source: github })).toEqual([]);
    const all = onboardReminders({
      repo: { verifyCommands: [] },
      trial: 'skipped',
      source: null,
    });
    expect(all.map((r) => r.step)).toEqual(['commands', 'trial', 'source']);
    expect(all[0]?.text).toContain('没有检查命令');
    expect(all[1]?.text).toContain('试运行跳过了');
    expect(all[1]?.text).toContain(skipTrialWarning());
    expect(all[2]?.text).toContain('没有需求来源');
  });
});

describe('in English', () => {
  it('leaves no Chinese', () => {
    setLang('en');
    const texts: string[] = [onboardEntryHint(), skipTrialWarning()];
    for (const step of ONBOARD_STEPS) {
      texts.push(
        onboardStepTitle(step),
        onboardStepHeading(step),
        onboardStepSummary(step),
        backToStepLabel(step),
        onboardCloseNote(step) ?? '',
      );
    }
    for (const mark of ['done', 'skipped', 'current', 'todo'] as const) {
      texts.push(onboardMarkLabel(mark));
    }
    texts.push(...onboardSteps(walk('done', 'skipped')).map((i) => i.title));
    texts.push(commandsWarning('') ?? '');
    for (const outcome of ['none', 'running', 'passed', 'failed'] as const) {
      const view = trialStepView(outcome, false);
      texts.push(view.startLabel, view.note, view.skipWarning ?? '');
    }
    const failures = [
      failedAt({ exitCode: 2 }),
      failedAt({ exitCode: null, timedOut: true }),
      failedAt({ exitCode: null }),
      failedAt({ exitCode: null, missingProgram: 'node' }),
      trial({ status: 'failed', error: 'cannot read the target branch main' }),
      trial({ status: 'failed' }),
    ];
    for (const f of failures) {
      const failure = trialFailure(f);
      texts.push(failure?.reason ?? '', failure?.advice ?? '');
    }
    texts.push(trialKindLabel('setup'), trialKindLabel('verify'));
    for (const source of [github, githubInferred, gitlab, backlog, null]) {
      texts.push(sourceStepNote(source), onboardDoneLead('demo', source));
      for (const step of onboardNextSteps('demo', source)) {
        texts.push(step.text, step.link?.label ?? '');
      }
    }
    for (const r of onboardReminders({
      repo: { verifyCommands: [] },
      trial: 'skipped',
      source: null,
    })) {
      texts.push(r.text);
    }
    for (const text of texts) expect(text).not.toMatch(CJK);

    expect(onboardStepHeading('trial')).toBe('Step 3: Trial run');
    expect(trialFailure(failedAt({ exitCode: 2 }))?.reason).toBe('failed with exit code 2.');
    expect(onboardDoneLead('demo', backlog)).toBe(
      'demo is in, its requirements coming from the local backlog. Next:',
    );
    expect(onboardNextSteps('demo', github)[0]?.link?.label).toBe('New issue on GitHub');
  });
});
