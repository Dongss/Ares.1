import { afterEach, describe, expect, it } from 'vitest';
import type {
  RepoDetection,
  RepoTrial,
  RepoTrialResult,
  RepoTrialService,
} from '../../../src/api/types.js';
import { setLang } from '../../../src/i18n.js';
import {
  type AddRepoForm,
  adoptServeSuggestion,
  adoptSuggestionLabel,
  detectedBox,
  detectionNote,
  detectLabel,
  emptyServeForm,
  lacksVerify,
  missingProgramNote,
  newRepoInput,
  noServeNote,
  noServeSuggestionNote,
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
  serveSuggestionAdopted,
  serveSummary,
  serveTimeoutHint,
  targetBranchPlaceholder,
  trialHint,
  trialLabel,
  trialNothingNote,
  trialRowNote,
  trialRows,
  trialServiceLabel,
  trialServiceView,
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
  const suggested = {
    command: 'npm run dev',
    readyPath: '/',
    basis: 'Node：package.json 的 scripts 里有 dev',
  };
  const detection = (
    verify: string[],
    setup: string[],
    serve: RepoDetection['serve'] = null,
  ): RepoDetection => ({
    branch: 'main',
    commit: '0123456789abcdef',
    verify,
    setup,
    serve,
    basis: ['Go：go.mod'],
  });

  it('tells the human to adopt a suggested start command, which fills no box by itself', () => {
    const both = detectionNote(detection(['npm test'], ['npm ci'], suggested));
    expect(both).toContain('点「保存」才生效');
    expect(both).toContain('建议的启动命令不会自动填进「服务」一栏，要用就点那里的「采用建议」');
    const serveOnly = detectionNote(detection([], [], suggested));
    expect(serveOnly).toContain('准备命令和检查命令没有可填的建议');
    expect(serveOnly).toContain('「采用建议」');
    expect(serveOnly).not.toContain('。没有可填的建议');
    // Without one, it is not mentioned.
    expect(detectionNote(detection(['npm test'], []))).not.toContain('启动命令');
    expect(detectionNote(detection([], []))).not.toContain('启动命令');
    expect(adoptSuggestionLabel()).toBe('采用建议');
    expect(noServeSuggestionNote()).toContain('没有建议启动命令');
    setLang('en');
    const texts = [
      detectionNote(detection(['npm test'], ['npm ci'], suggested)),
      detectionNote(detection([], [], suggested)),
      adoptSuggestionLabel(),
      noServeSuggestionNote(),
    ];
    expect(texts[0]).toContain('choose Use the suggestion there');
    expect(texts[1]).toContain('No setup or verify commands to suggest');
    expect(texts.join('\n')).not.toMatch(/[一-鿿]/);
  });

  it('puts a suggested start command and ready path in the service boxes, keeping the timeout', () => {
    const typed: ServeForm = {
      command: 'node x.js',
      readyPath: '/health',
      readyTimeoutSeconds: '30',
    };
    expect(adoptServeSuggestion(typed, suggested)).toEqual({
      command: 'npm run dev',
      readyPath: '/',
      readyTimeoutSeconds: '30',
    });
    expect(adoptServeSuggestion(emptyServeForm(), suggested)).toEqual({
      command: 'npm run dev',
      readyPath: '/',
      readyTimeoutSeconds: '',
    });
    expect(typed.command).toBe('node x.js');
  });

  it('knows when the service boxes hold the suggestion already', () => {
    const form = (command: string, readyPath: string): ServeForm => ({
      command,
      readyPath,
      readyTimeoutSeconds: '45',
    });
    expect(serveSuggestionAdopted(form('npm run dev', '/'), suggested)).toBe(true);
    expect(serveSuggestionAdopted(form(' npm run dev ', ' / '), suggested)).toBe(true);
    // A blank ready path is the default one, which is what is suggested.
    expect(serveSuggestionAdopted(form('npm run dev', ''), suggested)).toBe(true);
    expect(serveSuggestionAdopted(form('npm run dev', '/health'), suggested)).toBe(false);
    expect(serveSuggestionAdopted(form('npm start', '/'), suggested)).toBe(false);
    expect(serveSuggestionAdopted(emptyServeForm(), suggested)).toBe(false);
    expect(
      serveSuggestionAdopted(form('npm run dev', ''), { ...suggested, readyPath: '/health' }),
    ).toBe(false);
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
    serve: null,
    results: [],
    serviceResult: null,
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
    expect(trialLabel(false, true)).toBe('试运行表单里的命令和服务');
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

  it('runs no verify command while the service is still to start or starting', () => {
    const serve = { command: 'npm run dev', readyPath: '/', readyTimeoutSeconds: 120 };
    const starting = trial({ serve, results: [result('setup', 'npm ci')] });
    expect(states(starting)).toEqual([
      'setup:npm ci:passed',
      'verify:npm test:waiting',
      'verify:npm run lint:waiting',
    ]);
    expect(states(trial({ serve }))).toEqual([
      'setup:npm ci:running',
      'verify:npm test:waiting',
      'verify:npm run lint:waiting',
    ]);
    // Once it answered or was given up on, the verify commands run.
    const answered = trial({
      serve,
      results: [result('setup', 'npm ci')],
      serviceResult: {
        ok: false,
        reason: 'timeout',
        exitCode: null,
        url: null,
        port: 4000,
        durationMs: 120_000,
        outputTail: '',
      },
    });
    expect(states(answered)).toEqual([
      'setup:npm ci:passed',
      'verify:npm test:running',
      'verify:npm run lint:waiting',
    ]);
  });
});

describe('the service of a trial', () => {
  const serve = { command: 'npm run dev', readyPath: '/', readyTimeoutSeconds: 30 };
  const passed = (command: string): RepoTrialResult => ({
    kind: 'setup',
    command,
    ok: true,
    exitCode: 0,
    timedOut: false,
    durationMs: 1000,
    outputTail: '',
    missingProgram: null,
  });
  const service = (extra: Partial<RepoTrialService>): RepoTrialService => ({
    ok: false,
    reason: 'exited',
    exitCode: 1,
    url: null,
    port: 53817,
    durationMs: 2400,
    outputTail: 'Error: listen EADDRINUSE',
    ...extra,
  });
  const trial = (
    extra: Partial<
      Pick<RepoTrial, 'status' | 'setupCommands' | 'results' | 'serve' | 'serviceResult'>
    > = {},
  ) => ({
    status: 'running' as RepoTrial['status'],
    setupCommands: ['npm ci', 'npm run build'],
    results: [] as RepoTrialResult[],
    serve: serve as RepoTrial['serve'],
    serviceResult: null as RepoTrialService | null,
    ...extra,
  });
  const ready = service({
    ok: true,
    reason: null,
    exitCode: null,
    url: 'http://127.0.0.1:53817',
    outputTail: 'listening',
  });
  const setupDone = [passed('npm ci'), passed('npm run build')];

  it('is not tried without a start command', () => {
    const view = trialServiceView(trial({ serve: null }));
    expect(view).toEqual({
      state: 'none',
      row: 'skipped',
      command: null,
      note: '没有启动命令，不试服务',
      outputTail: null,
    });
    expect(trialServiceView(trial({ serve: null, status: 'passed' })).state).toBe('none');
  });

  it('waits for the setup commands, then starts', () => {
    expect(trialServiceView(trial())).toMatchObject({
      state: 'waiting',
      row: 'waiting',
      command: 'npm run dev',
      note: '等准备命令通过后起服务',
      outputTail: null,
    });
    expect(trialServiceView(trial({ results: [passed('npm ci')] })).state).toBe('waiting');
    expect(trialServiceView(trial({ results: setupDone }))).toMatchObject({
      state: 'starting',
      row: 'running',
      note: '起服务中…（最多等 30 秒就绪）',
    });
    // Without setup commands it starts at once.
    expect(trialServiceView(trial({ setupCommands: [] })).state).toBe('starting');
  });

  it('says where it was ready and how long it took', () => {
    const view = trialServiceView(
      trial({ status: 'passed', results: setupDone, serviceResult: ready }),
    );
    expect(view).toEqual({
      state: 'ready',
      row: 'passed',
      command: 'npm run dev',
      note: '已就绪：http://127.0.0.1:53817，用时 2 秒，随后已停掉',
      outputTail: 'listening',
    });
    // The verify commands may still run after it.
    expect(trialServiceView(trial({ results: setupDone, serviceResult: ready })).state).toBe(
      'ready',
    );
  });

  it('tells a timeout from an early exit, with the end of its output', () => {
    const timedOut = trialServiceView(
      trial({
        status: 'failed',
        results: setupDone,
        serviceResult: service({ reason: 'timeout', exitCode: null, durationMs: 30_000 }),
      }),
    );
    expect(timedOut).toMatchObject({
      state: 'timeout',
      row: 'failed',
      note: '超时：30 秒内没有就绪',
      outputTail: 'Error: listen EADDRINUSE',
    });
    const exited = trialServiceView(
      trial({ status: 'failed', results: setupDone, serviceResult: service({}) }),
    );
    expect(exited).toMatchObject({
      state: 'exited',
      row: 'failed',
      note: '进程提前退出（退出码 1）',
    });
    const signalled = trialServiceView(
      trial({ status: 'failed', results: setupDone, serviceResult: service({ exitCode: null }) }),
    );
    expect(signalled.note).toBe('进程提前退出');
    const aborted = trialServiceView(
      trial({
        status: 'failed',
        results: setupDone,
        serviceResult: service({ reason: 'aborted', exitCode: null, outputTail: '' }),
      }),
    );
    expect(aborted).toMatchObject({
      state: 'aborted',
      row: 'failed',
      note: '被中止（Master 停止了）',
      outputTail: '',
    });
  });

  it('is not run after a setup command failed, or when the trial ended before it', () => {
    const failedSetup = [passed('npm ci'), { ...passed('npm run build'), ok: false, exitCode: 2 }];
    for (const status of ['running', 'failed'] as const) {
      expect(trialServiceView(trial({ status, results: failedSetup }))).toMatchObject({
        state: 'skipped',
        row: 'skipped',
        note: '没有运行（准备命令没通过）',
        outputTail: null,
      });
    }
    // The target branch could not be read, say.
    expect(trialServiceView(trial({ status: 'failed' }))).toMatchObject({
      state: 'skipped',
      note: '没有运行',
    });
    // A missing program keeps every command from running.
    const missing = {
      ...passed('npm test'),
      kind: 'verify' as const,
      ok: false,
      exitCode: null,
      missingProgram: 'npm',
    };
    expect(trialServiceView(trial({ status: 'failed', results: [missing] })).note).toBe('没有运行');
  });

  it('is described in both languages', () => {
    expect(trialServiceLabel()).toBe('服务');
    expect(trialHint('main', false)).toContain('起登记的服务');
    expect(trialHint('main', true)).toContain('用表单里的命令和服务设置（不保存）');
    expect(trialNothingNote()).toContain('也没有启动命令');
    setLang('en');
    const views = [
      trial({ serve: null }),
      trial(),
      trial({ results: setupDone }),
      trial({ results: setupDone, serviceResult: ready }),
      trial({ results: setupDone, serviceResult: service({ reason: 'timeout', exitCode: null }) }),
      trial({ results: setupDone, serviceResult: service({}) }),
      trial({ results: setupDone, serviceResult: service({ exitCode: null }) }),
      trial({ results: setupDone, serviceResult: service({ reason: 'aborted', exitCode: null }) }),
      trial({ status: 'failed', results: [{ ...passed('npm ci'), ok: false, exitCode: 1 }] }),
      trial({ status: 'failed' }),
    ].map((t) => trialServiceView(t).note);
    expect(views).toEqual([
      'no start command, so no service to try',
      'starts once the setup commands pass',
      'starting… (ready within 30 seconds at most)',
      'ready at http://127.0.0.1:53817 after 2s, then stopped',
      'timed out: not ready within 30 seconds',
      'exited before it was ready (exit code 1)',
      'exited before it was ready',
      'stopped (the Master stopped)',
      'not run (a setup command failed)',
      'not run',
    ]);
    expect(
      trialServiceView(
        trial({
          serve: { ...serve, readyTimeoutSeconds: 1 },
          serviceResult: service({ reason: 'timeout', exitCode: null }),
        }),
      ).note,
    ).toBe('timed out: not ready within 1 second');
    const texts = [
      ...views,
      trialServiceLabel(),
      trialHint('main', false),
      trialHint('main', true),
      trialNothingNote(),
    ];
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
