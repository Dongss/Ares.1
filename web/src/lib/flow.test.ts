import { afterEach, describe, expect, it } from 'vitest';
import { TemplateSchema } from '../../../src/config/schema.js';
import { setLang } from '../../../src/i18n.js';
import type { StageRun } from '../../../src/store/types.js';
import {
  type AgentConfigState,
  assessInDoubt,
  buildFlow,
  candidatesRuleText,
  FLOW_STATUS,
  type FlowStage,
  planningText,
  reworkText,
  serveText,
  stageProgress,
  tierCostText,
} from './flow.js';

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

type Level = 'low' | 'mid' | 'high';

/** A configured agent, tier and cost mid unless given. */
const agent = (
  id: string,
  model: string,
  extra: { effort?: 'high'; args?: string[]; tier?: Level; cost?: Level; enabled?: boolean } = {},
) => ({ id, model, args: [] as string[], tier: 'mid' as Level, cost: 'mid' as Level, ...extra });

const agents = [
  agent('planner', 'opus', { effort: 'high', tier: 'high', cost: 'high' }),
  agent('coder', 'sonnet', { args: ['--effort', 'xhigh'] }),
  agent('reviewer', 'opus'),
];

/** What the flow shows of an agent whose configuration is not known. */
const unknown = (id: string, config: AgentConfigState) => ({
  id,
  model: null,
  effort: null,
  tier: null,
  cost: null,
  config,
});

describe('buildFlow', () => {
  const flow = buildFlow({ template, repoVerifyCommands: ['npm run lint'], agents });
  const stage = (id: string) => flow.find((s) => s.id === id);

  it('lists the stages in template order with their agent, model, effort, tier and cost', () => {
    expect(flow.map((s) => s.name)).toEqual(['设计', '编码', '评审', '合并']);
    expect(stage('design')?.agents).toEqual([
      { id: 'planner', model: 'opus', effort: 'high', tier: 'high', cost: 'high', config: 'ok' },
    ]);
    expect(stage('code')?.agents).toEqual([
      { id: 'coder', model: 'sonnet', effort: 'xhigh', tier: 'mid', cost: 'mid', config: 'ok' },
    ]);
    expect(stage('review')?.agents).toEqual([
      { id: 'reviewer', model: 'opus', effort: null, tier: 'mid', cost: 'mid', config: 'ok' },
    ]);
    expect(stage('merge')?.agents).toEqual([]);
    // One agent each: none of them picks by difficulty.
    expect(flow.map((s) => s.byDifficulty)).toEqual([false, false, false, false]);
  });

  it('shows an agent missing from the configuration or disabled without model', () => {
    const [first] = buildFlow({ template, repoVerifyCommands: [], agents: [] });
    expect(first?.agents).toEqual([unknown('planner', 'missing')]);
    const disabled = [agent('planner', 'opus', { enabled: false })];
    const [off] = buildFlow({ template, repoVerifyCommands: [], agents: disabled });
    expect(off?.agents).toEqual([unknown('planner', 'missing')]);
  });

  it('tells a configuration still loading or failed to load apart from a missing agent', () => {
    for (const state of ['loading', 'error'] as const) {
      const [first, , , merge] = buildFlow({ template, repoVerifyCommands: [], agents: state });
      expect(first?.agents).toEqual([unknown('planner', state)]);
      expect(merge?.agents).toEqual([]);
    }
  });

  it('a merge stage sends a conflict back to the agent stage it fails to', () => {
    expect(stage('merge')?.onConflict).toEqual({ id: 'code', name: '编码' });
    // Without verify commands a conflict still goes back there.
    const noChecks = buildFlow({ template, repoVerifyCommands: [], agents });
    expect(noChecks.find((s) => s.id === 'merge')?.onConflict).toEqual({
      id: 'code',
      name: '编码',
    });
    for (const id of ['design', 'code', 'review']) expect(stage(id)?.onConflict).toBeNull();
    // A stage that cannot change files cannot resolve it: a human does.
    const toReview = TemplateSchema.parse({
      ...template,
      stages: template.stages.map((s) => (s.id === 'merge' ? { ...s, on_fail: 'review' } : s)),
    });
    const merge = buildFlow({ template: toReview, repoVerifyCommands: [], agents }).find(
      (s) => s.id === 'merge',
    );
    expect(merge?.onConflict).toBeNull();
  });

  it('a merge stage without verify commands cannot fail its checks', () => {
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

  it('says what happens once the reworks are used up', () => {
    // By default the Run fails; a stage or Run override can make it wait for a human.
    expect(stage('code')?.onExhausted).toBe('fail');
    const waits = buildFlow({
      template,
      overrides: { stages: { code: { escalate: { on_exhausted: 'human' } } } },
      repoVerifyCommands: [],
      agents,
    });
    expect(waits.map((s) => s.onExhausted)).toEqual(['fail', 'human', 'fail', 'fail']);

    expect(reworkText(3, 'fail')).toBe(
      '返工，最多 3 次，仍不通过时 Run 结束、标为失败（从 issue 来的会自动重做）',
    );
    expect(reworkText(3, 'human')).toBe('返工，最多 3 次，仍不通过时等人处理');
    expect(reworkText(0, 'fail')).toBe('不返工，Run 直接结束、标为失败（从 issue 来的会自动重做）');
    expect(reworkText(0, 'human')).toBe('不返工，直接等人处理');
  });

  it('says what happens once the reworks are used up in English', () => {
    setLang('en');
    try {
      expect(reworkText(1, 'fail')).toBe(
        'Rework up to 1 time, then the Run ends as failed (a Run from an issue is redone)',
      );
      expect(reworkText(2, 'human')).toBe('Rework up to 2 times, then wait for a human');
      for (const n of [0, 1, 2]) {
        for (const mode of ['fail', 'human'] as const) {
          expect(reworkText(n, mode)).not.toMatch(/[一-鿿]/);
        }
      }
    } finally {
      setLang('zh');
    }
  });

  it('shows how agent stages split their rounds into steps', () => {
    const planned = TemplateSchema.parse({
      id: 'planned',
      stages: [
        { id: 'assess', kind: 'assess', agent: 'reviewer' },
        { id: 'single', agent: 'coder' },
        { id: 'llm', agent: 'coder', planning: 'llm' },
        { id: 'auto', agent: 'coder', planning: 'auto' },
        { id: 'merge', kind: 'merge' },
      ],
    });
    const flow = buildFlow({ template: planned, repoVerifyCommands: [], agents });
    expect(flow.map((s) => s.planning)).toEqual([null, 'single', 'llm', 'auto', null]);
    expect(flow.map((s) => planningText(s.planning))).toEqual([
      null,
      null,
      '每一轮先由 Agent 只读地拆成几步，再一步一步做、检查和提交',
      '按需求规模：需求评估给出的规模为 L 时先拆成几步再一步一步做，S、M 或没有规模时一次做完',
      null,
    ]);
    setLang('en');
    try {
      for (const planning of ['llm', 'auto'] as const) {
        expect(planningText(planning)).toMatch(/^(Every round|By the requirement's size)/);
        expect(planningText(planning)).not.toMatch(/[一-鿿]/);
      }
    } finally {
      setLang('zh');
    }
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

describe('stages with agent_candidates', () => {
  afterEach(() => setLang('zh'));

  const withCandidates = TemplateSchema.parse({
    id: 'by-difficulty',
    stages: [
      { id: 'assess', kind: 'assess', agent_candidates: ['reviewer', 'planner'] },
      { id: 'code', agent_candidates: ['cheap', 'coder', 'planner'] },
      { id: 'review', kind: 'review', agent_candidates: ['reviewer'] },
      { id: 'merge', kind: 'merge' },
    ],
  });
  const all = [...agents, agent('cheap', 'haiku', { tier: 'low', cost: 'low' })];

  it('lists the candidates in the template order, with model, effort, tier and cost', () => {
    const flow = buildFlow({ template: withCandidates, repoVerifyCommands: [], agents: all });
    expect(flow.map((s) => s.agents.map((a) => a.id))).toEqual([
      ['reviewer', 'planner'],
      ['cheap', 'coder', 'planner'],
      ['reviewer'],
      [],
    ]);
    // Even one candidate picks by difficulty: there is nothing else to pick.
    expect(flow.map((s) => s.byDifficulty)).toEqual([true, true, true, false]);
    expect(flow[1]?.agents).toEqual([
      { id: 'cheap', model: 'haiku', effort: null, tier: 'low', cost: 'low', config: 'ok' },
      { id: 'coder', model: 'sonnet', effort: 'xhigh', tier: 'mid', cost: 'mid', config: 'ok' },
      { id: 'planner', model: 'opus', effort: 'high', tier: 'high', cost: 'high', config: 'ok' },
    ]);
  });

  it('marks each candidate missing or disabled on its own', () => {
    const some = [
      agent('coder', 'sonnet'),
      agent('planner', 'opus', { tier: 'high', enabled: false }),
    ];
    const [, code] = buildFlow({ template: withCandidates, repoVerifyCommands: [], agents: some });
    expect(code?.agents.map((a) => [a.id, a.config])).toEqual([
      ['cheap', 'missing'],
      ['coder', 'ok'],
      ['planner', 'missing'],
    ]);
    expect(code?.agents[2]).toEqual(unknown('planner', 'missing'));
  });

  it('shows every candidate loading or failed to load with the configuration', () => {
    for (const state of ['loading', 'error'] as const) {
      const [, code] = buildFlow({
        template: withCandidates,
        repoVerifyCommands: [],
        agents: state,
      });
      expect(code?.agents).toEqual(['cheap', 'coder', 'planner'].map((id) => unknown(id, state)));
    }
  });

  it('says how a round picks among them, and each tier and cost', () => {
    expect(candidatesRuleText()).toBe(
      '按需求评估给出的难度，挑档次够用、成本最低的；没有够档次的就挑档次最高的；没有难度时用第一个',
    );
    expect(tierCostText({ tier: 'high', cost: 'low' })).toBe('档次 high · 成本 low');
    expect(tierCostText(unknown('x', 'missing'))).toBeNull();
    setLang('en');
    expect(candidatesRuleText()).toBe(
      'By the difficulty the assessment gave: the cheapest whose tier is enough, else the highest tier; the first one when there is no difficulty',
    );
    expect(tierCostText({ tier: 'mid', cost: 'high' })).toBe('tier mid · cost high');
    expect(`${candidatesRuleText()}${tierCostText({ tier: 'mid', cost: 'mid' })}`).not.toMatch(
      /[一-鿿]/,
    );
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
      agents: [],
      byDifficulty: false,
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

describe('command stages', () => {
  const withCommand = (e2e: Record<string, unknown>) =>
    TemplateSchema.parse({
      id: 'c',
      stages: [
        { id: 'code', name: '编码', agent: 'coder' },
        { id: 'review', name: '评审', kind: 'review', agent: 'reviewer' },
        { id: 'e2e', name: 'E2E', kind: 'command', ...e2e },
        { id: 'merge', name: '合并', kind: 'merge', gate: true },
      ],
    });

  it('show their commands and no agent, and go back to the nearest agent stage', () => {
    const template = withCommand({ verify: { commands: ['npx playwright test'] } });
    const [, , e2e] = buildFlow({ template, repoVerifyCommands: ['npm test'], agents });
    expect(e2e).toMatchObject({
      kind: 'command',
      agents: [],
      byDifficulty: false,
      commands: ['npx playwright test'],
      commandsFromRepo: false,
      onFail: { id: 'code', name: '编码' },
      onConflict: null,
      gate: false,
      onReject: null,
    });
  });

  it('go back to on_fail, and on_reject when their approval is rejected', () => {
    const template = withCommand({ on_fail: 'review', gate: true, on_reject: 'review' });
    const [, , e2e] = buildFlow({ template, repoVerifyCommands: ['npm test'], agents });
    expect(e2e).toMatchObject({
      commands: ['npm test'],
      commandsFromRepo: true,
      onFail: { id: 'review', name: '评审' },
      gate: true,
      onReject: { id: 'review', name: '评审' },
    });
  });

  it('say when they start a service for their commands', () => {
    const serving = withCommand({ serve: true });
    const [code, , e2e] = buildFlow({
      template: serving,
      repoVerifyCommands: ['npm test'],
      agents,
    });
    expect(e2e?.serve).toBe(true);
    expect(code?.serve).toBe(false);
    expect(serveText(e2e as FlowStage)).toBe(
      '先用仓库登记的启动命令起服务，命令里用 $PORT 和 $ARES1_SERVICE_URL 访问它，阶段结束后停掉',
    );
    // Without commands it passes without starting the service; with the repo default unknown
    // it may have some.
    const [, , none] = buildFlow({ template: serving, repoVerifyCommands: [], agents });
    expect(serveText(none as FlowStage)).toBeNull();
    const [, , unknown] = buildFlow({ template: serving, repoVerifyCommands: null, agents });
    expect(serveText(unknown as FlowStage)).not.toBeNull();
    for (const serve of [false, undefined]) {
      const [, , plain] = buildFlow({
        template: withCommand(serve === undefined ? {} : { serve }),
        repoVerifyCommands: ['npm test'],
        agents,
      });
      expect(plain?.serve).toBe(false);
      expect(serveText(plain as FlowStage)).toBeNull();
    }
    setLang('en');
    try {
      const text = serveText(e2e as FlowStage);
      expect(text).toMatch(/^First starts the service/);
      expect(text).not.toMatch(/[一-鿿]/);
    } finally {
      setLang('zh');
    }
  });

  it('cannot fail without commands; without a repo the default may have some', () => {
    const template = withCommand({});
    const [, , none] = buildFlow({ template, repoVerifyCommands: [], agents });
    expect(none).toMatchObject({ commands: [], commandsFromRepo: true, onFail: null });
    const [, , unknown] = buildFlow({ template, repoVerifyCommands: null, agents });
    expect(unknown).toMatchObject({
      commands: null,
      commandsFromRepo: true,
      onFail: { id: 'code', name: '编码' },
    });
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
      agents: [{ id: 'reviewer', model: 'opus', config: 'ok' }],
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
