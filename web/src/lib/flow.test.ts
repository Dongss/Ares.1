import { afterEach, describe, expect, it } from 'vitest';
import { TemplateSchema } from '../../../src/config/schema.js';
import { setLang } from '../../../src/i18n.js';
import type { StageRun } from '../../../src/store/types.js';
import { assessInDoubt, buildFlow, FLOW_STATUS, stageProgress } from './flow.js';

const template = TemplateSchema.parse({
  id: 'dev',
  defaults: { escalate: { max_retries: 3 } },
  stages: [
    { id: 'design', name: '设计', agent: 'planner', gate: true },
    { id: 'code', name: '编码', agent: 'coder', verify: { commands: ['npm test'] } },
    { id: 'review', name: '评审', kind: 'review', agent: 'reviewer' },
    { id: 'merge', name: '合并', kind: 'merge', gate: true, on_reject: 'design' },
  ],
});

const agents = [
  { id: 'planner', model: 'opus', effort: 'high' as const, args: [] },
  { id: 'coder', model: 'sonnet', args: ['--effort', 'xhigh'] },
  { id: 'reviewer', model: 'opus', args: [] },
];

describe('buildFlow', () => {
  const flow = buildFlow({ template, repoVerifyCommands: ['npm run lint'], agents });
  const stage = (id: string) => flow.find((s) => s.id === id);

  it('lists the stages in template order with their agent, model and effort', () => {
    expect(flow.map((s) => s.name)).toEqual(['设计', '编码', '评审', '合并']);
    expect(stage('design')?.agent).toEqual({
      id: 'planner',
      model: 'opus',
      effort: 'high',
      config: 'ok',
    });
    expect(stage('code')?.agent).toEqual({
      id: 'coder',
      model: 'sonnet',
      effort: 'xhigh',
      config: 'ok',
    });
    expect(stage('review')?.agent).toEqual({
      id: 'reviewer',
      model: 'opus',
      effort: null,
      config: 'ok',
    });
    expect(stage('merge')?.agent).toBeNull();
  });

  it('shows an agent missing from the configuration or disabled without model', () => {
    const [first] = buildFlow({ template, repoVerifyCommands: [], agents: [] });
    expect(first?.agent).toEqual({ id: 'planner', model: null, effort: null, config: 'missing' });
    const disabled = [{ ...agents[0], id: 'planner', model: 'opus', args: [], enabled: false }];
    const [off] = buildFlow({ template, repoVerifyCommands: [], agents: disabled });
    expect(off?.agent?.config).toBe('missing');
  });

  it('tells a configuration still loading or failed to load apart from a missing agent', () => {
    for (const state of ['loading', 'error'] as const) {
      const [first, , , merge] = buildFlow({ template, repoVerifyCommands: [], agents: state });
      expect(first?.agent).toEqual({ id: 'planner', model: null, effort: null, config: state });
      expect(merge?.agent).toBeNull();
    }
  });

  it('a merge stage without verify commands cannot fail', () => {
    const noChecks = buildFlow({ template, repoVerifyCommands: [], agents });
    const merge = noChecks.find((s) => s.id === 'merge');
    expect(merge).toMatchObject({ commands: [], onFail: null });
    expect(merge?.onReject).toEqual({ id: 'design', name: '设计' });
    // A review stage runs no commands either, but its reviewer can reject.
    expect(noChecks.find((s) => s.id === 'review')?.onFail).toEqual({ id: 'code', name: '编码' });
  });

  it('keeps max_retries 0', () => {
    const t = TemplateSchema.parse({
      id: 'no-retry',
      defaults: { escalate: { max_retries: 0 } },
      stages: [{ id: 'code', agent: 'coder' }],
    });
    expect(buildFlow({ template: t, repoVerifyCommands: [], agents })[0]?.maxRetries).toBe(0);
  });

  it('uses the stage verify commands, else the repo default; review runs none', () => {
    expect(stage('design')).toMatchObject({ commands: ['npm run lint'], commandsFromRepo: true });
    expect(stage('code')).toMatchObject({ commands: ['npm test'], commandsFromRepo: false });
    expect(stage('review')?.commands).toEqual([]);
    expect(stage('merge')?.commands).toEqual(['npm run lint']);
    expect(stage('code')?.maxRetries).toBe(3);
  });

  it('without a repo, shows the repo default instead of commands', () => {
    const noRepo = buildFlow({ template, repoVerifyCommands: null, agents });
    const at = (id: string) => noRepo.find((s) => s.id === id);
    expect(at('design')).toMatchObject({ commands: null, commandsFromRepo: true });
    expect(at('code')).toMatchObject({ commands: ['npm test'], commandsFromRepo: false });
    expect(at('review')?.commands).toEqual([]);
    // The repo default may have commands, so the merge stage may fail.
    expect(at('merge')).toMatchObject({ commands: null, onFail: { id: 'code', name: '编码' } });
  });

  it('resolves where a stage goes back to', () => {
    expect(stage('design')).toMatchObject({
      gate: true,
      onFail: null,
      onReject: { id: 'design', name: '设计' },
    });
    expect(stage('code')).toMatchObject({ gate: false, onFail: null, onReject: null });
    expect(stage('review')).toMatchObject({ onFail: { id: 'code', name: '编码' }, onReject: null });
    expect(stage('merge')).toMatchObject({
      onFail: { id: 'code', name: '编码' },
      onReject: { id: 'design', name: '设计' },
    });
  });

  it('applies the Run overrides of approval points', () => {
    const overrides = { stages: { design: { gate: false }, review: { gate: true } } };
    const changed = buildFlow({ template, overrides, repoVerifyCommands: [], agents });
    expect(changed.map((s) => s.gate)).toEqual([false, false, true, true]);
    expect(changed[0]?.onReject).toBeNull();
    expect(changed[2]?.onReject).toEqual({ id: 'code', name: '编码' });
  });
});

describe('stageProgress', () => {
  const sr = (id: string, stageId: string, round: number, status: StageRun['status']) =>
    ({ id, stageId, round, status }) as StageRun;
  const runs = [
    sr('s1', 'code', 1, 'passed'),
    sr('s2', 'review', 1, 'failed'),
    sr('s3', 'code', 2, 'executing'),
  ];

  it('reports the latest round and how many rounds ran', () => {
    expect(stageProgress('code', runs)).toEqual({
      status: 'running',
      rounds: 2,
      latestStageRunId: 's3',
    });
    expect(stageProgress('review', runs)).toEqual({
      status: 'failed',
      rounds: 1,
      latestStageRunId: 's2',
    });
    expect(stageProgress('merge', runs)).toEqual({
      status: 'not_started',
      rounds: 0,
      latestStageRunId: null,
    });
  });

  it('maps stage round statuses', () => {
    expect(stageProgress('x', [sr('a', 'x', 1, 'pending')]).status).toBe('running');
    expect(stageProgress('x', [sr('a', 'x', 1, 'waiting_approval')]).status).toBe(
      'waiting_approval',
    );
    expect(stageProgress('x', [sr('a', 'x', 1, 'passed')]).status).toBe('passed');
  });

  it('shows an unfinished round of a halted Run as blocked, paused or cancelled', () => {
    expect(stageProgress('code', runs, 'running').status).toBe('running');
    expect(stageProgress('code', runs, 'blocked').status).toBe('blocked');
    expect(stageProgress('code', runs, 'paused').status).toBe('paused');
    expect(stageProgress('code', runs, 'cancelled').status).toBe('cancelled');
    // Finished rounds keep their own status.
    expect(stageProgress('review', runs, 'blocked').status).toBe('failed');
    const waiting = [sr('a', 'x', 1, 'waiting_approval')];
    expect(stageProgress('x', waiting, 'paused').status).toBe('waiting_approval');
  });
});

describe('placeholder stages', () => {
  it('show no agent and no checks, and never go back on failure', () => {
    const withPlaceholder = TemplateSchema.parse({
      id: 'p',
      stages: [
        { id: 'code', name: '编码', agent: 'coder' },
        { id: 'e2e', name: 'E2E', kind: 'placeholder' },
        { id: 'merge', name: '合并', kind: 'merge', gate: true },
      ],
    });
    const flow = buildFlow({
      template: withPlaceholder,
      repoVerifyCommands: ['npm test'],
      agents,
    });
    expect(flow[1]).toMatchObject({
      kind: 'placeholder',
      agent: null,
      commands: [],
      commandsFromRepo: false,
      onFail: null,
      gate: false,
      onReject: null,
    });
    const gated = buildFlow({
      template: withPlaceholder,
      overrides: { stages: { e2e: { gate: true } } },
      repoVerifyCommands: ['npm test'],
      agents,
    });
    expect(gated[1]?.onReject).toEqual({ id: 'code', name: '编码' });
  });
});

describe('assess stages', () => {
  it('show their agent, run no checks and never go back on failure', () => {
    const withAssess = TemplateSchema.parse({
      id: 'a',
      stages: [
        { id: 'assess', name: '需求评估', kind: 'assess', agent: 'reviewer' },
        { id: 'code', name: '编码', agent: 'coder', inputs: ['assessment'] },
        { id: 'merge', name: '合并', kind: 'merge' },
      ],
    });
    const flow = buildFlow({ template: withAssess, repoVerifyCommands: ['npm test'], agents });
    expect(flow[0]).toMatchObject({
      kind: 'assess',
      agent: { id: 'reviewer', model: 'opus', config: 'ok' },
      commands: [],
      commandsFromRepo: false,
      onFail: null,
      gate: false,
      onReject: null,
    });
    // An approval of the assessment, when rejected, assesses again.
    const gated = buildFlow({
      template: withAssess,
      overrides: { stages: { assess: { gate: true } } },
      repoVerifyCommands: ['npm test'],
      agents,
    });
    expect(gated[0]?.onReject).toEqual({ id: 'assess', name: '需求评估' });
  });

  it('say how long they wait for a reply before deciding on their own', () => {
    const waiting = (reply_timeout_hours?: number | null) =>
      buildFlow({
        template: TemplateSchema.parse({
          id: 'a',
          stages: [
            { id: 'assess', kind: 'assess', agent: 'reviewer', reply_timeout_hours },
            { id: 'code', agent: 'coder', inputs: ['assessment'] },
          ],
        }),
        repoVerifyCommands: [],
        agents,
      });
    expect(waiting().map((s) => s.replyTimeoutHours)).toEqual([24, null]);
    expect(waiting(0)[0]?.replyTimeoutHours).toBe(0);
    expect(waiting(null)[0]?.replyTimeoutHours).toBeNull();

    expect(assessInDoubt(24)).toBe(
      '在 issue 或 Run 详情页讨论，回复后重新评估；你同意不做时 Run 结束。24 小时内没人回复时由评估自己决定：写明假设后开工，或者不做',
    );
    expect(assessInDoubt(null)).toBe(
      '在 issue 或 Run 详情页讨论，回复后重新评估；你同意不做时 Run 结束',
    );
    expect(assessInDoubt(0)).toBe('不等人回复：评估自己决定，写明假设后开工，或者不做');
  });

  it('say so in English', () => {
    setLang('en');
    try {
      expect(assessInDoubt(1)).toContain('If nobody replies within 1 hour, the assessment decides');
      expect(assessInDoubt(0.25)).toContain('within 15 minutes');
      for (const hours of [24, 0, null]) expect(assessInDoubt(hours)).not.toMatch(/[一-鿿]/);
    } finally {
      setLang('zh');
    }
  });
});

describe('FLOW_STATUS', () => {
  afterEach(() => setLang('zh'));

  it('labels stage statuses in the language in use when read', () => {
    expect(FLOW_STATUS.waiting_approval.label).toBe('待审批');
    setLang('en');
    expect(FLOW_STATUS.waiting_approval).toMatchObject({
      label: 'Awaiting approval',
      tone: 'attention',
    });
    for (const s of Object.values(FLOW_STATUS)) expect(s.label).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
