import { afterEach, describe, expect, it } from 'vitest';
import type { RepoDetection, RepoTrial, RepoTrialResult } from '../../../src/api/types.js';
import { setLang } from '../../../src/i18n.js';
import {
  type AddRepoForm,
  detectedBox,
  detectionNote,
  detectLabel,
  emptyServeForm,
  lacksVerify,
  missingProgramNote,
  newRepoInput,
  noServeNote,
  noVerifyBadge,
  noVerifyWarning,
  REPO_ORIGINS,
  registerLabel,
  repoOriginHint,
  repoOriginLabel,
  repoPatch,
  repoPathLabel,
  type ServeForm,
  serveFormBlank,
  serveFormInit,
  serveFormProblems,
  serveHint,
  serveInput,
  serveLabel,
  serveReadyPathHint,
  serveSummary,
  serveTimeoutHint,
  targetBranchPlaceholder,
  trialLabel,
  trialRowNote,
  trialRows,
  trialStatusBadge,
  trialSummary,
} from './repos.js';

afterEach(() => setLang('zh'));

function form(extra: Partial<AddRepoForm> = {}): AddRepoForm {
  return {
    origin: 'local',
    name: ' demo ',
    path: ' /tmp/demo ',
    url: ' git@example.com:me/demo.git ',
    targetBranch: ' ',
    verify: 'npm test\n\n npm run lint \n',
    setup: '',
    ...extra,
  };
}

describe('newRepoInput', () => {
  it('registers a local repo without a source, as before', () => {
    expect(newRepoInput(form())).toEqual({
      name: 'demo',
      path: '/tmp/demo',
      targetBranch: undefined,
      verifyCommands: ['npm test', 'npm run lint'],
      setupCommands: [],
    });
  });

  it('asks the Master to clone the trimmed address', () => {
    const input = newRepoInput(form({ origin: 'clone', targetBranch: ' dev ' }));
    expect(input.source).toEqual({ kind: 'clone', url: 'git@example.com:me/demo.git' });
    expect(input.targetBranch).toBe('dev');
  });

  it('asks the Master to make a new repo, without the address', () => {
    expect(newRepoInput(form({ origin: 'init' })).source).toEqual({ kind: 'init' });
  });
});

describe('register form texts', () => {
  it('names the three ways in both languages', () => {
    expect(REPO_ORIGINS.map(repoOriginLabel)).toEqual(['已有本地仓库', '从远端克隆', '新建空项目']);
    expect(registerLabel('clone', true)).toBe('正在克隆…');
    expect(registerLabel('clone', false)).toBe('登记');
    setLang('en');
    expect(REPO_ORIGINS.map(repoOriginLabel)).toEqual([
      'Existing local repo',
      'Clone from a remote',
      'New empty project',
    ]);
    const texts = REPO_ORIGINS.flatMap((origin) => [
      repoOriginLabel(origin),
      repoOriginHint(origin),
      repoPathLabel(origin),
      targetBranchPlaceholder(origin),
      registerLabel(origin, true),
      registerLabel(origin, false),
    ]);
    expect(texts.join('\n')).not.toMatch(/[一-鿿]/);
  });

  it('tells where the target branch comes from by default', () => {
    expect(targetBranchPlaceholder('clone')).toBe('默认：远端的默认分支');
    expect(targetBranchPlaceholder('init')).toBe('默认：main');
  });
});

describe('repos without verify commands', () => {
  it('are told apart by their verify commands only', () => {
    expect(lacksVerify({ verifyCommands: [] })).toBe(true);
    expect(lacksVerify({ verifyCommands: [' ', ''] })).toBe(true);
    expect(lacksVerify({ verifyCommands: ['npm test'] })).toBe(false);
  });

  it('get a badge and a warning in both languages', () => {
    expect(noVerifyBadge()).toBe('没有检查命令');
    expect(noVerifyWarning()).toContain('没有检查命令：Run 的改动不经检查就会进入评审和合并');
    setLang('en');
    expect(noVerifyBadge()).toBe('No verify commands');
    expect(noVerifyWarning()).toMatch(/^No verify commands: /);
    expect(`${noVerifyBadge()}\n${noVerifyWarning()}`).not.toMatch(/[一-鿿]/);
  });
});

describe('detecting commands on the edit form', () => {
  const detection = (verify: string[], setup: string[]): RepoDetection => ({
    branch: 'main',
    commit: '0123456789abcdef',
    verify,
    setup,
    serve: null,
    basis: ['Go：go.mod'],
  });

  it('fills a box with its suggestions and leaves one without as typed', () => {
    expect(detectedBox(['go build ./...', 'go test ./...'], 'make')).toBe(
      'go build ./...\ngo test ./...',
    );
    expect(detectedBox([], 'npm test\nnpm run lint')).toBe('npm test\nnpm run lint');
  });

  it('says what it read and what became of the boxes, in both languages', () => {
    const found = detection(['go test ./...'], ['go mod download']);
    expect(detectionNote(found)).toContain('目标分支 main（提交 01234567）');
    expect(detectionNote(found)).toContain('点「保存」才生效');
    expect(detectionNote(detection([], []))).toContain('没有可填的建议');
    expect(detectLabel(false)).toBe('按项目文件探测');
    setLang('en');
    const texts = [
      detectionNote(found),
      detectionNote(detection([], [])),
      detectLabel(false),
      detectLabel(true),
    ];
    expect(texts[0]).toContain('target branch main (commit 01234567)');
    expect(texts[1]).toContain('Nothing to suggest');
    expect(texts.join('\n')).not.toMatch(/[一-鿿]/);
  });
});

describe('a trial of the commands', () => {
  const result = (
    kind: RepoTrialResult['kind'],
    command: string,
    extra: Partial<RepoTrialResult> = {},
  ): RepoTrialResult => ({
    kind,
    command,
    ok: true,
    exitCode: 0,
    timedOut: false,
    durationMs: 1500,
    outputTail: '',
    missingProgram: null,
    ...extra,
  });
  const trial = (extra: Partial<RepoTrial> = {}): RepoTrial => ({
    repoId: 'repo-1',
    status: 'running',
    branch: 'main',
    sha: '0123456789abcdef',
    startedAt: '2026-11-27T10:00:00.000Z',
    endedAt: null,
    setupCommands: ['npm ci'],
    verifyCommands: ['npm test', 'npm run lint'],
    results: [],
    error: null,
    log: null,
    ...extra,
  });
  const states = (t: RepoTrial) => trialRows(t).map((r) => `${r.kind}:${r.command}:${r.state}`);

  it('shows the command running, those waiting, and the results so far', () => {
    expect(states(trial())).toEqual([
      'setup:npm ci:running',
      'verify:npm test:waiting',
      'verify:npm run lint:waiting',
    ]);
    const going = trial({ results: [result('setup', 'npm ci')] });
    expect(states(going)).toEqual([
      'setup:npm ci:passed',
      'verify:npm test:running',
      'verify:npm run lint:waiting',
    ]);
    expect(trialRows(going)[0]?.result).toEqual(result('setup', 'npm ci'));
  });

  it('marks the commands after a failure as not run once it is over', () => {
    const failed = trial({
      status: 'failed',
      results: [
        result('setup', 'npm ci'),
        result('verify', 'npm test', { ok: false, exitCode: 1 }),
      ],
    });
    expect(states(failed)).toEqual([
      'setup:npm ci:passed',
      'verify:npm test:failed',
      'verify:npm run lint:skipped',
    ]);
    // A missing program: only its command has a result, wherever it is.
    const missing = trial({
      status: 'failed',
      results: [
        result('verify', 'npm run lint', { ok: false, exitCode: null, missingProgram: 'npm' }),
      ],
    });
    expect(states(missing)).toEqual([
      'setup:npm ci:skipped',
      'verify:npm test:skipped',
      'verify:npm run lint:failed',
    ]);
  });

  it('gives each result to its own command when one is listed twice or in both groups', () => {
    const twice = trial({
      status: 'passed',
      setupCommands: ['make'],
      verifyCommands: ['make', 'make'],
      results: [result('setup', 'make'), result('verify', 'make'), result('verify', 'make')],
    });
    expect(states(twice)).toEqual([
      'setup:make:passed',
      'verify:make:passed',
      'verify:make:passed',
    ]);
    expect(trialRows(trial({ setupCommands: [], verifyCommands: [] }))).toEqual([]);
  });

  it('says how each command went, in both languages', () => {
    const rows = trialRows(
      trial({
        status: 'failed',
        verifyCommands: ['a', 'b', 'c', 'd', 'e'],
        results: [
          result('setup', 'npm ci'),
          result('verify', 'a', { ok: false, exitCode: 2 }),
          result('verify', 'b', { ok: false, exitCode: null, timedOut: true }),
          result('verify', 'c', { ok: false, exitCode: null }),
          result('verify', 'd', { ok: false, exitCode: null, missingProgram: 'pnpm' }),
        ],
      }),
    );
    const notes = () => rows.map(trialRowNote);
    expect(notes()).toEqual([
      '通过（2 秒）',
      '退出码 2',
      '超时',
      '被中止',
      '找不到 pnpm',
      '没有运行',
    ]);
    expect(trialStatusBadge('failed')).toEqual({ label: '没通过', tone: 'danger' });
    expect(missingProgramNote('pnpm')).toContain('运行环境里找不到 `pnpm`');
    expect(trialLabel(false, true)).toBe('试运行表单里的命令');
    const now = Date.parse('2026-11-27T10:00:05.000Z');
    expect(trialSummary(trial(), now)).toContain('目标分支 main（提交 01234567）');
    expect(trialSummary(trial(), now)).toContain('已用 5 秒');

    setLang('en');
    const texts = [
      ...notes(),
      ...trialRows(trial()).map(trialRowNote),
      ...(['running', 'passed', 'failed'] as const).map((s) => trialStatusBadge(s).label),
      missingProgramNote('pnpm'),
      trialLabel(false, false),
      trialLabel(false, true),
      trialLabel(true, false),
      trialSummary(trial(), now),
      trialSummary(trial({ sha: null, status: 'failed', endedAt: '2026-11-27T10:01:05.000Z' })),
    ];
    expect(texts[0]).toBe('passed (2s)');
    expect(texts.at(-1)).toContain('target branch main · started at');
    expect(texts.at(-1)).toContain('took 1m 5s');
    expect(texts.join('\n')).not.toMatch(/[一-鿿]/);
  });
});

describe('the service boxes of the edit form', () => {
  const serve = (extra: Partial<ServeForm> = {}): ServeForm => ({
    command: ' npm start ',
    readyPath: ' /health ',
    readyTimeoutSeconds: ' 30 ',
    ...extra,
  });

  it('start from the saved service, or blank without one', () => {
    expect(
      serveFormInit({ command: 'npm start', readyPath: '/health', readyTimeoutSeconds: 30 }),
    ).toEqual({ command: 'npm start', readyPath: '/health', readyTimeoutSeconds: '30' });
    expect(serveFormInit(null)).toEqual(emptyServeForm());
    expect(serveFormBlank(emptyServeForm())).toBe(true);
    expect(serveFormBlank(serve({ command: ' ', readyPath: '', readyTimeoutSeconds: '' }))).toBe(
      true,
    );
    expect(serveFormBlank(serve({ command: '', readyPath: '', readyTimeoutSeconds: '30' }))).toBe(
      false,
    );
  });

  it('send the trimmed settings', () => {
    expect(serveInput(serve())).toEqual({
      command: 'npm start',
      readyPath: '/health',
      readyTimeoutSeconds: 30,
    });
  });

  it('send the defaults for a blank ready path or timeout', () => {
    expect(serveInput(serve({ readyPath: ' ', readyTimeoutSeconds: '' }))).toEqual({
      command: 'npm start',
      readyPath: '/',
      readyTimeoutSeconds: 120,
    });
  });

  it('send null, which removes the service, without a start command', () => {
    expect(serveInput(serve({ command: '  ' }))).toBeNull();
    expect(serveInput(emptyServeForm())).toBeNull();
  });

  it('check the ready path and timeout by the rules of the API', () => {
    expect(serveFormProblems(serve())).toEqual([]);
    expect(serveFormProblems(serve({ readyPath: '', readyTimeoutSeconds: '' }))).toEqual([]);
    expect(serveFormProblems(serve({ readyTimeoutSeconds: '1' }))).toEqual([]);
    expect(serveFormProblems(serve({ readyTimeoutSeconds: '3600' }))).toEqual([]);
    expect(serveFormProblems(serve({ readyPath: 'health' }))).toEqual(['就绪路径必须以 / 开头']);
    for (const readyTimeoutSeconds of ['0', '3601', '1.5', '-1', 'abc', '1e3']) {
      expect(serveFormProblems(serve({ readyTimeoutSeconds }))).toEqual([
        '就绪超时必须是 1 到 3600 之间的整数（秒）',
      ]);
    }
    expect(serveFormProblems(serve({ readyPath: 'x', readyTimeoutSeconds: '0' }))).toHaveLength(2);
  });

  it('have nothing to check without a start command: the other boxes are not sent', () => {
    expect(
      serveFormProblems(serve({ command: '', readyPath: 'x', readyTimeoutSeconds: '0' })),
    ).toEqual([]);
  });

  it('go into the PATCH body with the rest of the edit form', () => {
    expect(
      repoPatch({
        targetBranch: ' main ',
        verify: 'npm test\n\n',
        setup: ' npm ci ',
        serve: serve(),
      }),
    ).toEqual({
      targetBranch: 'main',
      verifyCommands: ['npm test'],
      setupCommands: ['npm ci'],
      serve: { command: 'npm start', readyPath: '/health', readyTimeoutSeconds: 30 },
    });
    expect(
      repoPatch({ targetBranch: 'main', verify: '', setup: '', serve: emptyServeForm() }).serve,
    ).toBeNull();
  });

  it('are described in both languages', () => {
    expect(serveLabel()).toBe('服务启动命令');
    expect(serveSummary({ readyPath: '/health', readyTimeoutSeconds: 30 })).toBe(
      '就绪路径 /health，最多等 30 秒',
    );
    expect(serveTimeoutHint()).toContain('1–3600');
    expect(noServeNote()).toMatch(/^无/);
    setLang('en');
    expect(serveSummary({ readyPath: '/', readyTimeoutSeconds: 1 })).toBe(
      'ready at /, within 1 second',
    );
    expect(serveSummary({ readyPath: '/', readyTimeoutSeconds: 120 })).toBe(
      'ready at /, within 120 seconds',
    );
    const texts = [
      serveLabel(),
      serveHint(),
      serveReadyPathHint(),
      serveTimeoutHint(),
      noServeNote(),
      ...serveFormProblems(serve({ readyPath: 'x', readyTimeoutSeconds: '0' })),
    ];
    expect(texts.at(-2)).toBe('The ready path must start with /');
    expect(texts.join('\n')).not.toMatch(/[一-鿿]/);
  });
});
