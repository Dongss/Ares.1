import { afterEach, describe, expect, it } from 'vitest';
import type { ProposalSource } from '../src/backlog/scouting.js';
import type { BacklogRepoConfig } from '../src/config/schema.js';
import { InvalidStateError } from '../src/engine/engine.js';
import type { IterationUpdate, PlannedIteration } from '../src/github/scout.js';
import { setLang } from '../src/i18n.js';
import { noticeFor } from '../src/notify/notice.js';
import { ConflictError, NotFoundError } from '../src/store/store.js';
import type { IterationChild, Proposal, Run } from '../src/store/types.js';
import { FakeGitHub, type Harness, harness, review, TEST_AGENTS_YAML, waitFor } from './helpers.js';

const AGENTS = `${TEST_AGENTS_YAML}
  scout:
    cli: fake
    model: scout
`;

interface ConfigOptions {
  /** Automatic scouting; off unless a test is about it. */
  auto?: boolean;
  maxRisk?: 'none' | 'low' | 'mid' | 'high';
  /** max_size; omitted = the default (L). */
  maxSize?: 'S' | 'M' | 'L';
  /** null = no daily limit. */
  maxPerDay?: number | null;
  /** daily_budget_usd; omitted = no limit. */
  budget?: number;
  /** auto_merge, on unless a test waits at the merge gate to hold Runs back. */
  autoMerge?: boolean;
}

/**
 * Only backlog.repos, no github section. auto_merge by default, so that the Runs of the test
 * template complete on their own.
 */
const config = (opts: ConfigOptions = {}) => {
  const maxPerDay = opts.maxPerDay === undefined ? null : opts.maxPerDay;
  return `
backlog:
  repos:
    demo:
      template: dev
      scout:
        agent: scout
        auto: ${opts.auto ?? false}
        max_proposals: 3
      auto_accept:
        max_risk: ${opts.maxRisk ?? 'low'}
${opts.maxSize === undefined ? '' : `        max_size: ${opts.maxSize}`}
${maxPerDay === null ? '' : `        max_per_day: ${maxPerDay}`}
      auto_merge: ${opts.autoMerge ?? true}
${opts.budget === undefined ? '' : `      daily_budget_usd: ${opts.budget}`}
`;
};

const proposal = (title: string, risk: 'low' | 'mid' | 'high', size: 'S' | 'M' | 'L' = 'S') => ({
  title,
  category: 'improvement',
  size,
  risk,
  lead: 'problem',
  why: `${title}的原因`,
  evidence: ['run_abc 返工了 3 轮'],
  what: `${title}的做法`,
  acceptance: ['测试通过'],
});

let h: Harness | undefined;
let gh: FakeGitHub;

/** A Master whose GitHub is fake, so that any call to it shows in `gh.calls`. */
async function start(cfg = config()): Promise<Harness> {
  gh = new FakeGitHub();
  h = await harness({ agents: AGENTS, config: cfg, github: gh });
  return h;
}

afterEach(async () => {
  await h?.close();
  h = undefined;
  setLang('zh');
});

/** Wait until the scout has ended, its temporary worktree deleted. */
async function scoutDone(t: Harness, id: string) {
  await waitFor(
    () => t.master.store.getScout(id).status !== 'running' && !t.master.scouting.running,
    'scout to finish',
  );
  return t.master.store.getScout(id);
}

/** A scout of demo started by hand, once it has ended. */
async function scoutByHand(t: Harness) {
  const scout = await t.master.backlog.startScout('demo', 'manual');
  return scoutDone(t, scout.id);
}

/** The repo's proposals, oldest first. */
const proposalsOf = (t: Harness): Proposal[] =>
  t.master.store.listProposals({ repoId: t.repo.id }).reverse();

/** The prompt of the latest scout. */
const lastScoutPrompt = (t: Harness) =>
  t.fake.calls.filter((c) => c.model === 'scout').at(-1)?.prompt ?? '';

const eventData = (t: Harness, type: string) =>
  t.master.store.listGlobalEventsOfType(type).map((e) => e.data);

const demoStatus = (t: Harness) => t.master.backlog.status().repos.find((r) => r.name === 'demo');

describe('local backlog', () => {
  it('scouts by itself and runs the proposals auto-accept takes, without calling GitHub', async () => {
    const t = await start(config({ auto: true }));
    let n = 0;
    t.scripts.scout = () => ({
      structured: {
        gaps: [],
        proposals: n++ === 0 ? [proposal('低风险的', 'low'), proposal('高风险的', 'high')] : [],
      },
      costUsd: 0.5,
    });
    await t.master.backlog.poll();
    const [scout] = t.master.store.listScouts();
    if (!scout) throw new Error('no scout');
    expect(scout.trigger).toBe('auto');
    // No issues repo: nothing was resolved through gh.
    expect(scout.issuesRepo).toBe('');
    const done = await scoutDone(t, scout.id);
    expect(done.status).toBe('completed');

    const [low, high] = proposalsOf(t);
    if (!low || !high) throw new Error('no proposals');
    expect(low).toMatchObject({
      title: '低风险的',
      scoutId: scout.id,
      status: 'accepted',
      auto: true,
      decidedAt: expect.any(String),
    });
    expect(high).toMatchObject({
      title: '高风险的',
      status: 'pending',
      auto: false,
      runId: null,
      decidedAt: null,
    });
    // The scout's record says where each proposal went.
    expect(done.proposals.map((p) => p.local)).toEqual([
      { id: low.id, auto: true },
      { id: high.id, auto: false },
    ]);
    expect(lastScoutPrompt(t)).toContain('## 已有的本地提案');

    // The accepted one became a Run with the proposal's text as its goal, and it runs to the end.
    const runs = t.master.store.listRuns();
    expect(runs).toHaveLength(1);
    const run = runs[0] as Run;
    expect(low.runId).toBe(run.id);
    expect(run.issue).toBeNull();
    expect(run.goal.startsWith('低风险的\n\n### 为什么\n\n低风险的的原因')).toBe(true);
    expect(run.goal).toContain('- [ ] 测试通过');
    await t.waitStatus(run.id, 'completed');

    expect(eventData(t, 'proposal.auto_accepted')).toEqual([
      { repo: 'demo', proposalId: low.id, runId: run.id },
    ]);
    const [completed] = t.master.store.listGlobalEventsOfType('scout.completed');
    if (!completed) throw new Error('no scout.completed');
    expect(completed.data).toMatchObject({ created: 2, auto: 1, pending: 1, backlog: true });
    // The one left for a human is notified, to be decided on the dashboard.
    expect(noticeFor(completed, undefined)).toMatchObject({
      kind: 'proposals',
      title: '有提案等你决定：1 条',
      about: 'issues',
    });
    expect(noticeFor(completed, undefined)?.body).toContain('去看板的需求页上采纳或拒绝');

    const status = t.master.backlog.status();
    expect(status).toMatchObject({ enabled: true, pollMinutes: 5, lastError: null });
    expect(status.lastPollAt).toEqual(expect.any(String));
    expect(demoStatus(t)).toMatchObject({
      template: 'dev',
      problems: [],
      pendingProposals: 1,
      autoAccept: { maxRisk: 'low', maxSize: 'L', maxPerDay: null, usedToday: 1 },
      autoMerge: true,
      budget: { dailyUsd: null, spentToday: 0.5, reached: false },
    });

    // The one beyond auto-accept does not hold the scout back: the repo is idle, it scouts again.
    await t.master.backlog.poll();
    expect(t.master.store.listScouts()).toHaveLength(2);
    await scoutDone(t, t.master.store.listScouts()[0]?.id ?? '');
    expect(t.master.store.listProposals({ repoId: t.repo.id })).toHaveLength(2);

    expect(gh.calls).toEqual([]);
  });

  it('leaves proposals beyond auto-accept to a human, who accepts or rejects them', async () => {
    const t = await start();
    t.scripts.scout = () => ({
      structured: {
        gaps: [],
        proposals: [proposal('要人定的', 'high'), proposal('不想要的', 'mid', 'M')],
      },
    });
    await scoutByHand(t);
    const [wanted, unwanted] = proposalsOf(t);
    if (!wanted || !unwanted) throw new Error('no proposals');
    expect([wanted.status, unwanted.status]).toEqual(['pending', 'pending']);
    // Polls leave them to a human.
    await t.master.backlog.poll();
    expect(t.master.store.listRuns()).toHaveLength(0);
    expect(demoStatus(t)?.pendingProposals).toBe(2);
    expect(demoStatus(t)?.scout?.waiting?.reason).toBe('只在看板上手动触发');

    const accepted = t.master.backlog.accept(wanted.id);
    expect(accepted).toMatchObject({
      status: 'accepted',
      auto: false,
      runId: expect.any(String),
      decidedAt: expect.any(String),
    });
    const run = t.master.store.getRun(accepted.runId ?? '');
    expect(run.goal.startsWith('要人定的\n\n### 为什么')).toBe(true);
    expect(eventData(t, 'proposal.accepted')).toEqual([
      { repo: 'demo', proposalId: wanted.id, runId: run.id },
    ]);
    // Neither counts toward the day's auto-accepts.
    expect(eventData(t, 'proposal.auto_accepted')).toEqual([]);
    expect(demoStatus(t)?.autoAccept.usedToday).toBe(0);
    expect(() => t.master.backlog.accept(wanted.id)).toThrow(InvalidStateError);
    expect(() => t.master.backlog.accept(wanted.id)).toThrow(`提案 ${wanted.id} 已经采纳过了`);
    await t.waitStatus(run.id, 'completed');
    // Nor toward what the Master spent by itself.
    t.master.store.updateRun(run.id, { costUsd: 3 });
    expect(demoStatus(t)?.budget.spentToday).toBe(0);

    expect(() => t.master.backlog.reject(unwanted.id, ' \n ')).toThrow('拒绝提案时必须填写理由');
    const rejected = t.master.backlog.reject(unwanted.id, ' 太复杂，不划算 \n');
    expect(rejected).toMatchObject({
      status: 'rejected',
      rejectReason: '太复杂，不划算',
      runId: null,
      decidedAt: expect.any(String),
    });
    expect(eventData(t, 'proposal.rejected')).toEqual([
      { repo: 'demo', proposalId: unwanted.id, reason: '太复杂，不划算' },
    ]);
    expect(() => t.master.backlog.accept(unwanted.id)).toThrow(`提案 ${unwanted.id} 已经被拒绝了`);
    expect(() => t.master.backlog.reject(unwanted.id, '再拒一次')).toThrow(InvalidStateError);
    expect(() => t.master.backlog.accept('proposal_none')).toThrow(NotFoundError);
    expect(() => t.master.backlog.reject('proposal_none', '没有')).toThrow(NotFoundError);
    expect(demoStatus(t)?.pendingProposals).toBe(0);

    // The next scout is shown the accepted one with its Run, and the rejected one with the reason.
    t.scripts.scout = () => ({ structured: { gaps: [], proposals: [] } });
    await scoutByHand(t);
    const prompt = lastScoutPrompt(t);
    expect(prompt).toContain(`- ${wanted.id} 要人定的（Run ${run.id}：`);
    const rejectedPart = prompt.slice(prompt.indexOf('### 被拒绝'));
    expect(rejectedPart).toContain(`- ${unwanted.id} 不想要的\n  理由：太复杂，不划算`);

    expect(gh.calls).toEqual([]);
  });

  it('accepts nothing by itself while the work switch is off, and goes on once it is on', async () => {
    const t = await start();
    t.master.store.setWorking(false);
    t.scripts.scout = () => ({
      structured: { gaps: [], proposals: [proposal('先来的', 'low'), proposal('后来的', 'low')] },
    });
    const done = await scoutByHand(t);
    expect(done.proposals.map((p) => p.local?.auto)).toEqual([false, false]);
    expect(eventData(t, 'scout.completed')[0]).toMatchObject({ auto: 0, pending: 2 });
    await t.master.backlog.poll();
    expect(proposalsOf(t).map((p) => p.status)).toEqual(['pending', 'pending']);
    expect(t.master.store.listRuns()).toHaveLength(0);
    expect(demoStatus(t)?.scout?.waiting?.reason).toBe('工作开关已关闭');

    // Turning it on polls at once; the next poll comes after it.
    t.master.store.setWorking(true);
    await t.master.backlog.poll();
    const [first, second] = proposalsOf(t);
    expect([first?.status, second?.status]).toEqual(['accepted', 'accepted']);
    expect([first?.auto, second?.auto]).toEqual([true, true]);
    // Oldest first.
    expect(eventData(t, 'proposal.auto_accepted').map((d) => d.proposalId)).toEqual([
      first?.id,
      second?.id,
    ]);
    expect(t.master.store.listRuns()).toHaveLength(2);
    expect(gh.calls).toEqual([]);
  });

  it('auto-accepts no more than max_per_day a day', async () => {
    const t = await start(config({ maxPerDay: 1 }));
    t.scripts.scout = () => ({
      structured: {
        gaps: [],
        proposals: [proposal('一', 'low'), proposal('二', 'low'), proposal('三', 'low')],
      },
    });
    const done = await scoutByHand(t);
    expect(done.proposals.map((p) => p.local?.auto)).toEqual([true, false, false]);
    expect(eventData(t, 'scout.completed')[0]).toMatchObject({ created: 3, auto: 1, pending: 2 });
    await t.master.backlog.poll();
    expect(proposalsOf(t).map((p) => p.status)).toEqual(['accepted', 'pending', 'pending']);
    expect(demoStatus(t)?.autoAccept).toMatchObject({ maxPerDay: 1, usedToday: 1 });
    expect(t.master.store.listRuns()).toHaveLength(1);
  });

  it("stops auto-accepting once the day's budget is spent, the auto-accepted Runs counted", async () => {
    const t = await start(config({ budget: 5 }));
    t.scripts.scout = () => ({
      structured: { gaps: [], proposals: [proposal('一', 'low')] },
      costUsd: 1,
    });
    await scoutByHand(t);
    const [first] = proposalsOf(t);
    expect(first?.status).toBe('accepted');
    const run = await t.waitStatus(first?.runId ?? '', 'completed');
    // As if the Run had cost 4: with the scout's 1, the budget of 5 is spent.
    t.master.store.updateRun(run.id, { costUsd: 4 });
    expect(demoStatus(t)?.budget).toEqual({ dailyUsd: 5, spentToday: 5, reached: true });

    t.scripts.scout = () => ({
      structured: { gaps: [], proposals: [proposal('二', 'low')] },
      costUsd: 0,
    });
    await scoutByHand(t);
    await t.master.backlog.poll();
    const second = proposalsOf(t)[1];
    expect(second?.status).toBe('pending');

    // Under the budget again (as if the Run had cost nothing): the next poll accepts it.
    t.master.store.updateRun(run.id, { costUsd: 0 });
    await t.master.backlog.poll();
    expect(t.master.store.getProposal(second?.id ?? '').status).toBe('accepted');
  });

  it('skips repos that are misconfigured or not registered, with the reason', async () => {
    const t = await start(`
backlog:
  repos:
    demo:
      template: missing
      scout: { agent: scout }
    other:
      template: dev
      scout: { agent: scout }
`);
    await t.master.backlog.poll();
    const [demo, other] = t.master.backlog.status().repos;
    expect(demo?.problems).toEqual(['模板 missing 不存在或无效']);
    expect(demo?.scout?.waiting?.reason).toBe(
      'backlog.repos.demo 配置有误：模板 missing 不存在或无效',
    );
    expect(other?.problems).toEqual(['仓库 other 没有在看板上登记']);
    expect(other?.scout?.waiting?.reason).toBe('仓库 other 没有在看板上登记');
    expect(t.master.store.listScouts()).toHaveLength(0);
    await expect(t.master.backlog.startScout('other', 'manual')).rejects.toThrow(NotFoundError);
    await expect(t.master.backlog.startScout('nowhere', 'manual')).rejects.toThrow(
      'config.yaml 的 backlog.repos 里没有 nowhere',
    );
    expect(gh.calls).toEqual([]);
  });

  it('refuses to accept the proposals of a repo taken out of backlog.repos', async () => {
    const t = await start();
    t.scripts.scout = () => ({
      structured: { gaps: [], proposals: [proposal('高风险的', 'high')] },
    });
    await scoutByHand(t);
    const [p] = proposalsOf(t);
    await t.close();
    h = await harness({
      agents: AGENTS,
      config: 'backlog:\n  repos: {}\n',
      github: gh,
      home: t.home,
      repoDir: t.repoDir,
    });
    expect(() => h?.master.backlog.accept(p?.id ?? '')).toThrow(
      '仓库 demo 已经不在 config.yaml 的 backlog.repos 里，不能再采纳它的提案',
    );
    // Rejecting it still works, to clear it away.
    expect(h.master.backlog.reject(p?.id ?? '', '不做了').status).toBe('rejected');
  });

  it('speaks English without Chinese left', async () => {
    const t = await start(`language: en\n${config({ maxPerDay: 1 })}`);
    const english = (title: string, risk: 'low' | 'high') => ({
      ...proposal(title, risk),
      why: `Why: ${title}`,
      evidence: ['run_abc was reworked 3 times'],
      what: `How: ${title}`,
      acceptance: ['Tests pass'],
    });
    t.scripts.scout = () => ({
      structured: {
        gaps: [],
        proposals: [english('Add a cache', 'low'), english('Rewrite the engine', 'high')],
      },
    });
    await scoutByHand(t);
    const prompt = lastScoutPrompt(t);
    expect(prompt).toContain('## Existing local proposals');
    const [cache, rewrite] = proposalsOf(t);
    if (!cache || !rewrite) throw new Error('no proposals');
    expect(cache.status).toBe('accepted');
    const run = t.master.store.getRun(cache.runId ?? '');
    expect(run.goal.startsWith('Add a cache\n\n### Why')).toBe(true);
    const [completed] = t.master.store.listGlobalEventsOfType('scout.completed');
    if (!completed) throw new Error('no scout.completed');
    const notice = noticeFor(completed, undefined);
    expect(notice?.body).toContain("accept or reject them on the dashboard's Issues page");

    const errors: string[] = [];
    const caught = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        errors.push((err as Error).message);
      }
    };
    caught(() => t.master.backlog.accept(cache.id));
    caught(() => t.master.backlog.reject(rewrite.id, '  '));
    t.master.backlog.reject(rewrite.id, 'Too much for now');
    caught(() => t.master.backlog.accept(rewrite.id));
    caught(() => t.master.backlog.accept('proposal_none'));
    await t.master.backlog.startScout('nowhere', 'manual').catch((err: Error) => {
      errors.push(err.message);
    });
    expect(errors).toEqual([
      `Proposal ${cache.id} was accepted already`,
      'Rejecting a proposal needs a reason',
      `Proposal ${rewrite.id} was rejected already`,
      'Proposal proposal_none not found',
      'nowhere is not in backlog.repos of config.yaml',
    ]);

    t.master.store.setWorking(false);
    await t.master.backlog.poll();
    const waiting = demoStatus(t)?.scout?.waiting?.reason;
    expect(waiting).toBe('The work switch is off');

    const text = [prompt, notice?.title, notice?.body, waiting, ...errors].join('\n');
    expect(text).not.toMatch(/[一-鿿]/);
  });
});

describe('scouting with iterations', () => {
  /** A step of a planned iteration as a scout writes it. */
  const plannedStep = (title: string, patch: Record<string, unknown> = {}) => ({
    ...proposal(title, 'low', 'M'),
    category: 'feature',
    criteria: [1],
    dependsOn: [],
    closeout: false,
    ...patch,
  });
  const { lead: _lead, ...requirement } = proposal('补上的一步', 'low');
  const ITERATION = {
    title: '不接 GitHub 的仓库也能永动',
    goal: '没有接 GitHub 的仓库，也能自己提需求、自己做完',
    readmeGoal: '永动',
    criteria: ['本地仓库能自己跑完一轮'],
    outOfScope: [],
    children: [
      plannedStep('本地提案池'),
      plannedStep('整理评审建议', { criteria: [], dependsOn: [1], closeout: true }),
    ],
  };
  const UPDATE = {
    note: '第 1 步失败了，换个做法',
    add: [{ ...requirement, criteria: [1], dependsOn: [], replaces: 1 }],
  };
  const LEADS = [
    proposal('卡住的 Run', 'low'),
    { ...proposal('能力缺口', 'low'), lead: 'gap' },
    { ...proposal('明显的缺陷', 'low'), lead: 'defect' },
    proposal('又一个卡住的', 'low'),
  ];

  /**
   * A source of the local backlog that records what the scout hands it: the proposals filed, the
   * iterations planned (kept as pending iterations of the store) and the changes to plans.
   */
  function recordingSource(t: Harness) {
    const filed: string[][] = [];
    const planned: PlannedIteration[] = [];
    const changes: { iteration: string; update: IterationUpdate }[] = [];
    const source: ProposalSource<BacklogRepoConfig> = {
      kind: 'local',
      configPath: (name) => `backlog.repos.${name}`,
      pollMinutes: () => 5,
      prepareScout: async () => '',
      known: async () => ({ issues: '（无）', github: null }),
      file: async (_scout, _repo, _cfg, proposals) => {
        filed.push(proposals.map((p) => p.title));
        return { created: proposals.length, auto: 0, pending: proposals.length };
      },
      fileIteration: async (scout, repo, _cfg, iteration) => {
        planned.push(iteration);
        const row = t.master.store.createIteration({
          repoId: repo.id,
          scoutId: scout.id,
          source: 'local',
          issuesRepo: '',
          title: iteration.title,
          goal: iteration.goal,
          readmeGoal: iteration.readmeGoal,
          criteria: iteration.criteria,
          outOfScope: iteration.outOfScope,
          children: [],
        });
        return { id: row.id, auto: false };
      },
      adjustIteration: async (_scout, _repo, _cfg, iteration, update) => {
        changes.push({ iteration: iteration.id, update });
      },
      holdingProposals: async () => 0,
    };
    return { source, filed, planned, changes };
  }

  /** A scout of demo through `source`, once it has ended. */
  async function scoutWith(t: Harness, source: ProposalSource<BacklogRepoConfig>) {
    const cfg = t.master.config.master.backlog?.repos.demo as BacklogRepoConfig;
    const scout = await t.master.scouting.startScout(source, t.repo, cfg, 'manual');
    return scoutDone(t, scout.id);
  }

  /** An iteration of demo under way, its first step failed. */
  function underWay(t: Harness) {
    const step = (position: number, patch: Partial<IterationChild>): IterationChild => ({
      ...plannedStep(`第 ${position} 步`),
      category: 'feature',
      size: 'M',
      risk: 'low',
      position,
      status: 'waiting',
      runIds: [],
      ...patch,
    });
    return t.master.store.createIteration({
      repoId: t.repo.id,
      scoutId: null,
      source: 'local',
      issuesRepo: '',
      title: '进行中的迭代',
      goal: '能做到一件新事',
      readmeGoal: '永动',
      criteria: ['能演示'],
      outOfScope: [],
      children: [
        step(1, { status: 'failed', proposalId: 'proposal-1' }),
        step(2, { dependsOn: [1], criteria: [], closeout: true, proposalId: 'proposal-2' }),
      ],
      status: 'blocked',
    });
  }

  it('plans an iteration without one under way, counted once among those waiting for a human', async () => {
    const t = await start();
    const { source, filed, planned, changes } = recordingSource(t);
    t.scripts.scout = () => ({
      structured: { gaps: [], proposals: LEADS, iteration: ITERATION, iterationUpdate: UPDATE },
    });
    const scout = await scoutWith(t, source);
    expect(scout.status).toBe('completed');
    expect(lastScoutPrompt(t)).toContain('## 规划迭代');
    expect(lastScoutPrompt(t)).not.toContain('## 进行中的迭代');
    // Every lead, up to max_proposals; the steps of the iteration do not count toward it.
    expect(filed).toEqual([['卡住的 Run', '能力缺口', '明显的缺陷']]);
    expect(scout.proposals.map((p) => p.lead)).toEqual(['problem', 'gap', 'defect']);
    expect(planned.map((p) => [p.title, p.children.length])).toEqual([
      ['不接 GitHub 的仓库也能永动', 2],
    ]);
    // No plan to change.
    expect(changes).toEqual([]);
    const [iteration] = t.master.store.listIterations({ repoId: t.repo.id });
    expect(eventData(t, 'scout.completed')).toEqual([
      expect.objectContaining({
        created: 3,
        auto: 0,
        pending: 4,
        iteration: { id: iteration?.id, auto: false },
      }),
    ]);
  });

  it('follows the iteration under way: problems only, no other iteration, its plan changed', async () => {
    const t = await start();
    const open = underWay(t);
    const { source, filed, planned, changes } = recordingSource(t);
    t.scripts.scout = () => ({
      structured: { gaps: [], proposals: LEADS, iteration: ITERATION, iterationUpdate: UPDATE },
    });
    const scout = await scoutWith(t, source);
    expect(scout.status).toBe('completed');
    const prompt = lastScoutPrompt(t);
    expect(prompt).toContain('## 进行中的迭代');
    expect(prompt).toContain('- 标题：进行中的迭代\n- 状态：受阻');
    expect(prompt).toContain('  1. proposal-1 第 1 步（失败；推进完成标准 1）');
    expect(prompt).not.toContain('## 规划迭代');
    expect(filed).toEqual([['卡住的 Run', '又一个卡住的']]);
    expect(planned).toEqual([]);
    expect(changes).toEqual([
      {
        iteration: open.id,
        update: {
          note: '第 1 步失败了，换个做法',
          add: [expect.objectContaining({ replaces: 1 })],
        },
      },
    ]);
    expect(eventData(t, 'scout.completed')).toEqual([
      expect.not.objectContaining({ iteration: expect.anything() }),
    ]);
  });

  it('fails a scout whose change does not fit the plan, filing nothing', async () => {
    const t = await start();
    underWay(t);
    const { source, filed, changes } = recordingSource(t);
    const update = { ...UPDATE, add: [{ ...UPDATE.add[0], replaces: 2 }] };
    t.scripts.scout = () => ({
      structured: { gaps: [], proposals: LEADS, iteration: null, iterationUpdate: update },
    });
    const scout = await scoutWith(t, source);
    expect(scout.status).toBe('failed');
    expect(scout.error).toBe(
      '侦察结果不符合约定：iterationUpdate: 追加的第 1 个子项（序号 3）不能替换第 2 个子项：它是收尾子项',
    );
    expect(filed).toEqual([]);
    expect(changes).toEqual([]);
  });
});

describe('iterations of the local backlog', () => {
  type Kind = { risk: 'low' | 'mid' | 'high'; size: 'S' | 'M' | 'L' };
  /** A step of a planned iteration as a scout writes it: a requirement, without a lead. */
  const step = (title: string, patch: Record<string, unknown> = {}) => ({
    title,
    size: 'M',
    risk: 'low',
    evidence: ['run_abc 返工了 3 轮'],
    acceptance: ['测试通过'],
    category: 'feature',
    why: `${title}的原因`,
    what: `${title}的做法`,
    criteria: [1],
    dependsOn: [],
    closeout: false,
    ...patch,
  });
  /** An iteration as a scout plans it: `steps` in order. */
  const plan = (steps: ReturnType<typeof step>[]) => ({
    title: '本地仓库也能永动',
    goal: '没有接 GitHub 的仓库，也能自己提需求、自己做完',
    readmeGoal: '永动',
    criteria: ['本地仓库能自己跑完一轮'],
    outOfScope: ['GitLab'],
    children: steps,
  });
  /** Three steps: the second waits for the first, the closing one for both. */
  const THREE = plan([
    step('第一步'),
    step('第二步', { dependsOn: [1] }),
    step('收尾', { criteria: [], dependsOn: [1, 2], closeout: true }),
  ]);

  /** A scout of demo by hand whose agent plans `iteration`; the iteration once filed. */
  async function planned(t: Harness, iteration: unknown, proposals: unknown[] = []) {
    t.scripts.scout = () => ({ structured: { gaps: [], proposals, iteration } });
    const scout = await scoutByHand(t);
    expect(scout.status).toBe('completed');
    const [filed] = t.master.store.listIterations({ repoId: t.repo.id });
    if (!filed) throw new Error('no iteration');
    return filed;
  }

  const iterationOf = (t: Harness, id: string) => t.master.store.getIteration(id);
  /** The proposal of each step, in the order of the plan. */
  const stepProposals = (t: Harness, id: string) =>
    iterationOf(t, id).children.map((c) => t.master.store.getProposal(c.proposalId ?? ''));
  const statuses = (t: Harness, id: string) => iterationOf(t, id).children.map((c) => c.status);
  /** The Run of a step's proposal; throws when it has none. */
  const runOfStep = (t: Harness, id: string, position: number) => {
    const runId = stepProposals(t, id)[position - 1]?.runId;
    if (!runId) throw new Error(`step ${position} has no Run`);
    return t.master.store.getRun(runId);
  };

  it('files the iteration a scout plans: a proposal per step with its dependencies, decided as a whole', async () => {
    // The closing step is of mid risk: the iteration waits for a human.
    const t = await start();
    const mid = plan([
      step('第一步'),
      step('第二步', { dependsOn: [1] }),
      step('收尾', { risk: 'mid', criteria: [], dependsOn: [1, 2], closeout: true }),
    ]);
    const filed = await planned(t, mid, [proposal('卡住的 Run', 'high')]);
    expect(filed).toMatchObject({
      source: 'local',
      issuesRepo: '',
      issue: null,
      status: 'pending',
      auto: false,
      title: '本地仓库也能永动',
      criteria: ['本地仓库能自己跑完一轮'],
      outOfScope: ['GitLab'],
    });
    const [first, second, closing] = stepProposals(t, filed.id);
    if (!first || !second || !closing) throw new Error('no proposals');
    expect(filed.children.map((c) => [c.position, c.dependsOn, c.status, c.proposalId])).toEqual([
      [1, [], 'planned', first.id],
      [2, [1], 'planned', second.id],
      [3, [1, 2], 'planned', closing.id],
    ]);
    // Each step a pending proposal of the iteration, depending on the proposals of its steps.
    expect([first, second, closing].map((p) => [p.title, p.status, p.iterationId])).toEqual([
      ['第一步', 'pending', filed.id],
      ['第二步', 'pending', filed.id],
      ['收尾', 'pending', filed.id],
    ]);
    expect([first.dependsOn, second.dependsOn, closing.dependsOn]).toEqual([
      [],
      [first.id],
      [first.id, second.id],
    ]);
    expect(t.master.store.listRuns()).toEqual([]);
    // Waiting for a human as one, beside the proposal of its own; its steps do not count.
    expect(eventData(t, 'scout.completed')[0]).toMatchObject({
      created: 1,
      auto: 0,
      pending: 2,
      iteration: { id: filed.id, auto: false },
      backlog: true,
    });
    expect(demoStatus(t)?.pendingProposals).toBe(2);
    // Auto-accept leaves it: its riskiest step is beyond max_risk.
    await t.master.backlog.poll();
    expect(iterationOf(t, filed.id).status).toBe('pending');

    // A step is never decided on its own.
    const whole = `提案 ${second.id} 是迭代 ${filed.id} 的子项，要和迭代一起整体采纳或拒绝`;
    expect(() => t.master.backlog.accept(second.id)).toThrow(ConflictError);
    expect(() => t.master.backlog.accept(second.id)).toThrow(whole);
    expect(() => t.master.backlog.reject(second.id, '不要')).toThrow(whole);
    // Nor cancelled before it is accepted.
    await expect(t.master.backlog.cancelIteration(filed.id)).rejects.toThrow(
      `迭代 ${filed.id} 还没有采纳，要拒绝它（填写理由），而不是终止`,
    );

    // The next scout follows it, its steps listed once, in the iteration's digest.
    t.scripts.scout = () => ({ structured: { gaps: [], proposals: [] } });
    await scoutByHand(t);
    const prompt = lastScoutPrompt(t);
    expect(prompt).toContain('## 进行中的迭代');
    expect(prompt).toContain(`  1. ${first.id} 第一步（等迭代被采纳；推进完成标准 1）`);
    expect(prompt.split(second.id)).toHaveLength(2);

    // A human accepts it: every step with it, only the first one becomes a Run.
    const accepted = t.master.backlog.acceptIteration(filed.id);
    expect(accepted).toMatchObject({
      status: 'active',
      auto: false,
      decidedAt: expect.any(String),
    });
    expect(stepProposals(t, filed.id).map((p) => [p.status, p.auto])).toEqual([
      ['accepted', false],
      ['accepted', false],
      ['accepted', false],
    ]);
    expect(statuses(t, filed.id)).toEqual(['running', 'waiting', 'waiting']);
    expect(t.master.store.listRuns()).toHaveLength(1);
    expect(runOfStep(t, filed.id, 1).goal.startsWith('第一步\n\n### 为什么\n\n第一步的原因')).toBe(
      true,
    );
    expect(eventData(t, 'iteration.accepted')).toEqual([
      { repo: 'demo', iterationId: filed.id, backlog: true },
    ]);
    // Not an auto-accept: today's count stays.
    expect(demoStatus(t)?.autoAccept.usedToday).toBe(0);
    expect(() => t.master.backlog.acceptIteration(filed.id)).toThrow(
      `迭代 ${filed.id} 已经采纳过了`,
    );
    expect(() => t.master.backlog.rejectIteration(filed.id, '不要了')).toThrow(
      `迭代 ${filed.id} 已经采纳了，不能再拒绝；不想做剩下的，就终止它`,
    );
    expect(() => t.master.backlog.acceptIteration('iteration_none')).toThrow(NotFoundError);
    expect(gh.calls).toEqual([]);
  });

  it.each<{ steps: Kind[]; auto: boolean }>([
    // The riskiest step is mid and the largest M: within max_risk mid and max_size M.
    {
      steps: [
        { risk: 'low', size: 'S' },
        { risk: 'mid', size: 'M' },
      ],
      auto: true,
    },
    // A step of size L, of low risk.
    {
      steps: [
        { risk: 'low', size: 'S' },
        { risk: 'low', size: 'L' },
      ],
      auto: false,
    },
    // A step of high risk, of size S.
    {
      steps: [
        { risk: 'high', size: 'S' },
        { risk: 'low', size: 'S' },
      ],
      auto: false,
    },
  ])(
    'auto-accepts an iteration as a whole by its riskiest and largest step: $steps.0.risk $steps.0.size, $steps.1.risk $steps.1.size → $auto',
    async ({ steps, auto }) => {
      const t = await start(config({ maxRisk: 'mid', maxSize: 'M' }));
      const filed = await planned(
        t,
        plan(steps.map((k, i) => step(`第 ${i + 1} 步`, { ...k }))),
        // A proposal of its own within the limits is taken either way.
        [proposal('卡住的 Run', 'low')],
      );
      expect(filed.status).toBe(auto ? 'active' : 'pending');
      expect(filed.auto).toBe(auto);
      expect(stepProposals(t, filed.id).map((p) => [p.status, p.auto])).toEqual(
        auto
          ? [
              ['accepted', true],
              ['accepted', true],
            ]
          : [
              ['pending', false],
              ['pending', false],
            ],
      );
      // Counted once however many steps it has.
      expect(eventData(t, 'iteration.auto_accepted')).toEqual(
        auto ? [{ repo: 'demo', iterationId: filed.id, backlog: true }] : [],
      );
      expect(demoStatus(t)?.autoAccept.usedToday).toBe(auto ? 2 : 1);
      // Both steps are independent: both became Runs.
      expect(t.master.store.listRuns()).toHaveLength(auto ? 3 : 1);
      expect(eventData(t, 'scout.completed')[0]).toMatchObject({
        pending: auto ? 0 : 1,
        iteration: { id: filed.id, auto },
      });
      // A poll judges it the same way.
      await t.master.backlog.poll();
      expect(iterationOf(t, filed.id).status).toBe(auto ? 'active' : 'pending');
    },
  );

  it('auto-accepts an iteration left waiting while the work switch was off, once it is on', async () => {
    const t = await start();
    t.master.store.setWorking(false);
    const filed = await planned(t, THREE);
    expect(filed.status).toBe('pending');
    expect(eventData(t, 'scout.completed')[0]).toMatchObject({ pending: 1 });
    await t.master.backlog.poll();
    expect(iterationOf(t, filed.id).status).toBe('pending');
    expect(t.master.store.listRuns()).toEqual([]);
    t.master.store.setWorking(true);
    await t.master.backlog.poll();
    expect(iterationOf(t, filed.id)).toMatchObject({ status: 'active', auto: true });
    expect(stepProposals(t, filed.id).map((p) => [p.status, p.auto])).toEqual([
      ['accepted', true],
      ['accepted', true],
      ['accepted', true],
    ]);
    expect(eventData(t, 'iteration.auto_accepted')).toHaveLength(1);
    // Only the first step: the others wait for it.
    expect(t.master.store.listRuns()).toHaveLength(1);
  });

  it('starts each step once the steps it depends on completed, and sums the iteration up', async () => {
    // Runs wait at the merge gate until approved, so that each step's Run ends when told.
    const t = await start(config({ autoMerge: false }));
    t.scripts.reviewer = () =>
      review([{ severity: 'suggestion', description: '把魔法数字提成常量' }]);
    const filed = await planned(t, THREE);
    expect(filed).toMatchObject({ status: 'active', auto: true });
    expect(statuses(t, filed.id)).toEqual(['running', 'waiting', 'waiting']);
    const first = runOfStep(t, filed.id, 1);
    await t.waitStatus(first.id, 'waiting_approval');
    // The first has not completed: no Run for the others.
    await t.master.backlog.poll();
    expect(stepProposals(t, filed.id).map((p) => p.runId)).toEqual([first.id, null, null]);
    expect(t.master.store.listRuns()).toHaveLength(1);

    t.master.engine.approve(first.id);
    await t.waitStatus(first.id, 'completed');
    await t.master.backlog.poll();
    expect(statuses(t, filed.id)).toEqual(['done', 'running', 'waiting']);
    const second = runOfStep(t, filed.id, 2);
    await t.waitStatus(second.id, 'waiting_approval');
    t.master.engine.approve(second.id);
    await t.waitStatus(second.id, 'completed');

    // The closing step gets the suggestions the other steps' reviews left, before its Run.
    await t.master.backlog.poll();
    expect(statuses(t, filed.id)).toEqual(['done', 'done', 'running']);
    const closing = stepProposals(t, filed.id)[2] as Proposal;
    expect(closing.what).toContain('收尾的做法\n\n### 本迭代评审留下的建议');
    expect(closing.what).toContain(`- 第一步（${first.id}，评审第 1 轮）\n  - 把魔法数字提成常量`);
    expect(closing.what).toContain(`- 第二步（${second.id}，评审第 1 轮）`);
    const third = runOfStep(t, filed.id, 3);
    expect(third.goal).toContain('### 本迭代评审留下的建议');
    await t.waitStatus(third.id, 'waiting_approval');
    t.master.engine.approve(third.id);
    await t.waitStatus(third.id, 'completed');

    // Every step done: summed up and done.
    t.master.store.updateRun(first.id, { costUsd: 1.5 });
    await t.master.backlog.poll();
    const done = iterationOf(t, filed.id);
    expect(done).toMatchObject({
      status: 'done',
      summaryPosted: true,
      endedAt: expect.any(String),
    });
    expect(done.children.map((c) => [c.status, c.runIds])).toEqual([
      ['done', [first.id]],
      ['done', [second.id]],
      ['done', [third.id]],
    ]);
    expect(done.summary).toContain('## 迭代完成');
    expect(done.summary).toContain('完成了全部 3 个子项');
    expect(done.summary).toContain(`   - 第一步：${first.id}，评审结论：有问题`);
    expect(done.summary).toContain('- 总费用：$1.50，共 3 个 Run');
    expect(eventData(t, 'iteration.completed')).toEqual([
      { repo: 'demo', iterationId: filed.id, backlog: true, costUsd: 1.5, runs: 3 },
    ]);
    // The scouts follow every step's change.
    expect(
      eventData(t, 'iteration.child_status').map((d) => [d.position, d.status, d.backlog]),
    ).toContainEqual([3, 'done', true]);
    // Polled again: nothing more.
    await t.master.backlog.poll();
    expect(eventData(t, 'iteration.completed')).toHaveLength(1);

    // The next scout plans a new one; the steps are listed as accepted, with how it ended.
    t.scripts.scout = () => ({ structured: { gaps: [], proposals: [] } });
    await scoutByHand(t);
    const prompt = lastScoutPrompt(t);
    expect(prompt).toContain('## 规划迭代');
    const firstProposal = stepProposals(t, filed.id)[0] as Proposal;
    expect(prompt).toContain(
      `- ${firstProposal.id} 第一步（Run ${first.id}：已完成，自动采纳，所属迭代 ${filed.id} 已完成）`,
    );
    expect(gh.calls).toEqual([]);
  });

  it('blocks the iteration once a step’s Run does not complete, notified once; a scout replaces the step', async () => {
    const t = await start(config({ autoMerge: false }));
    const two = plan([step('第一步'), step('第二步', { dependsOn: [1] })]);
    const filed = await planned(t, two);
    const first = runOfStep(t, filed.id, 1);
    await t.waitStatus(first.id, 'waiting_approval');
    await t.master.engine.cancel(first.id);
    await t.master.backlog.poll();
    expect(iterationOf(t, filed.id).status).toBe('blocked');
    expect(statuses(t, filed.id)).toEqual(['failed', 'waiting']);
    const [firstProposal, secondProposal] = stepProposals(t, filed.id);
    const blocked = t.master.store.listGlobalEventsOfType('iteration.blocked');
    expect(blocked.map((e) => e.data)).toEqual([
      {
        repo: 'demo',
        iterationId: filed.id,
        backlog: true,
        position: 1,
        proposalId: firstProposal?.id,
        reason: 'failed',
      },
    ]);
    const notice = noticeFor(blocked[0] as (typeof blocked)[number], undefined);
    expect(notice).toMatchObject({ kind: 'iteration', title: '迭代受阻：demo', about: 'issues' });
    expect(notice?.body).toBe(
      '迭代的第 1 步没有做成（Run 失败、被终止，或需求评估结论为不做），依赖它的子项开不了工。侦察下次会换个做法补一个子项替换它；也可以在看板上终止这个迭代，不做剩下的',
    );
    // Once each time it gets blocked; the step depending on it waits.
    await t.master.backlog.poll();
    expect(t.master.store.listGlobalEventsOfType('iteration.blocked')).toHaveLength(1);
    expect(secondProposal?.runId).toBeNull();

    // The next scout replaces the step that failed: the new one starts at once, the second step
    // waits for it instead.
    const { lead: _lead, ...requirement } = proposal('换个做法的第一步', 'low');
    t.scripts.scout = () => ({
      structured: {
        gaps: [],
        proposals: [],
        iterationUpdate: {
          note: '第一步的 Run 被终止了，换个做法',
          add: [{ ...requirement, criteria: [1], dependsOn: [], replaces: 1 }],
        },
      },
    });
    await scoutByHand(t);
    const adjusted = iterationOf(t, filed.id);
    expect(adjusted.status).toBe('active');
    expect(adjusted.notes.map((n) => n.text)).toEqual(['第一步的 Run 被终止了，换个做法']);
    expect(adjusted.children.map((c) => [c.position, c.status, c.replacedBy, c.dependsOn])).toEqual(
      [
        [1, 'failed', 3, []],
        [2, 'waiting', undefined, [1]],
        [3, 'running', undefined, []],
      ],
    );
    const replacing = stepProposals(t, filed.id)[2] as Proposal;
    expect(replacing).toMatchObject({
      title: '换个做法的第一步',
      status: 'accepted',
      auto: true,
      iterationId: filed.id,
      runId: expect.any(String),
    });
    // The second step's proposal now depends on the step that replaced the first.
    expect(t.master.store.getProposal(secondProposal?.id ?? '').dependsOn).toEqual([replacing.id]);
    expect(eventData(t, 'iteration.unblocked')).toEqual([
      { repo: 'demo', iterationId: filed.id, backlog: true },
    ]);
    expect(eventData(t, 'iteration.adjusted')).toEqual([
      expect.objectContaining({
        iterationId: filed.id,
        added: [3],
        replaced: [{ position: 1, by: 3 }],
      }),
    ]);
    const third = runOfStep(t, filed.id, 3);
    await t.waitStatus(third.id, 'waiting_approval');
    t.master.engine.approve(third.id);
    await t.waitStatus(third.id, 'completed');
    await t.master.backlog.poll();
    expect(statuses(t, filed.id)).toEqual(['failed', 'running', 'done']);
  });

  it('rejects a pending iteration as a whole with a reason the next scouts are shown', async () => {
    const t = await start(config({ maxRisk: 'none' }));
    const filed = await planned(t, THREE);
    expect(() => t.master.backlog.rejectIteration(filed.id, ' \n ')).toThrow(
      '拒绝迭代时必须填写理由',
    );
    const rejected = t.master.backlog.rejectIteration(filed.id, ' 现在不做本地仓库 \n');
    expect(rejected).toMatchObject({
      status: 'cancelled',
      decidedAt: expect.any(String),
      endedAt: expect.any(String),
    });
    expect(rejected.children.map((c) => c.status)).toEqual(['dropped', 'dropped', 'dropped']);
    expect(stepProposals(t, filed.id).map((p) => [p.status, p.rejectReason])).toEqual([
      ['rejected', '现在不做本地仓库'],
      ['rejected', '现在不做本地仓库'],
      ['rejected', '现在不做本地仓库'],
    ]);
    expect(eventData(t, 'iteration.cancelled')).toEqual([
      {
        repo: 'demo',
        iterationId: filed.id,
        backlog: true,
        dropped: [1, 2, 3],
        pending: true,
        reason: '现在不做本地仓库',
      },
    ]);
    expect(t.master.store.listRuns()).toEqual([]);
    expect(demoStatus(t)?.pendingProposals).toBe(0);
    expect(() => t.master.backlog.acceptIteration(filed.id)).toThrow(`迭代 ${filed.id} 已经不做了`);
    expect(() => t.master.backlog.rejectIteration(filed.id, '再拒')).toThrow(InvalidStateError);
    await expect(t.master.backlog.cancelIteration(filed.id)).rejects.toThrow(
      `迭代 ${filed.id} 已经不做了`,
    );

    // The next scout plans anew, shown the iteration once, with the reason.
    t.scripts.scout = () => ({ structured: { gaps: [], proposals: [] } });
    await scoutByHand(t);
    const prompt = lastScoutPrompt(t);
    expect(prompt).toContain('## 规划迭代');
    const rejectedPart = prompt.slice(prompt.indexOf('### 被拒绝'));
    expect(rejectedPart).toContain(
      `- ${filed.id} 迭代「本地仓库也能永动」（子项：第一步、第二步、收尾）\n  理由：现在不做本地仓库`,
    );
    expect(rejectedPart).not.toContain(stepProposals(t, filed.id)[0]?.id ?? '');
  });

  it('cancels an accepted iteration: the Runs of its steps not done are terminated, the steps dropped', async () => {
    const t = await start(config({ autoMerge: false }));
    const filed = await planned(t, THREE);
    const first = runOfStep(t, filed.id, 1);
    await t.waitStatus(first.id, 'waiting_approval');
    const cancelled = await t.master.backlog.cancelIteration(filed.id);
    expect(cancelled).toMatchObject({ status: 'cancelled', endedAt: expect.any(String) });
    expect(cancelled.children.map((c) => c.status)).toEqual(['dropped', 'dropped', 'dropped']);
    expect(t.master.store.getRun(first.id).status).toBe('cancelled');
    expect(t.master.store.listEvents(first.id).map((e) => e.type)).toContain(
      'run.iteration_cancelled',
    );
    expect(eventData(t, 'iteration.cancelled')).toEqual([
      {
        repo: 'demo',
        iterationId: filed.id,
        backlog: true,
        dropped: [1, 2, 3],
        pending: false,
      },
    ]);
    // Polls neither take the Run's end for a failure nor start the other steps.
    await t.master.backlog.poll();
    expect(t.master.store.listGlobalEventsOfType('iteration.blocked')).toEqual([]);
    expect(stepProposals(t, filed.id).map((p) => p.runId)).toEqual([first.id, null, null]);
    expect(statuses(t, filed.id)).toEqual(['dropped', 'dropped', 'dropped']);
    await expect(t.master.backlog.cancelIteration(filed.id)).rejects.toThrow(
      `迭代 ${filed.id} 已经不做了`,
    );
    // The next scout reads the steps as ended with it.
    t.scripts.scout = () => ({ structured: { gaps: [], proposals: [] } });
    await scoutByHand(t);
    expect(lastScoutPrompt(t)).toContain(`所属迭代 ${filed.id} 已被人终止`);
    expect(lastScoutPrompt(t)).toContain('终止：所属迭代被人在看板上终止，没做完的子项随之不做');
  });

  it('speaks English without Chinese left', async () => {
    const t = await start(`language: en\n${config({ maxRisk: 'none' })}`);
    const english = (title: string, patch: Record<string, unknown> = {}) =>
      step(title, {
        why: `Why: ${title}`,
        evidence: ['run_abc was reworked 3 times'],
        what: `How: ${title}`,
        acceptance: ['Tests pass'],
        ...patch,
      });
    const filed = await planned(t, {
      ...plan([english('First'), english('Second', { dependsOn: [1] })]),
      title: 'Local repos run on their own',
      goal: 'A repo without GitHub proposes and finishes its own work',
      readmeGoal: 'Perpetual motion',
      criteria: ['A local repo finishes a round by itself'],
      outOfScope: [],
    });
    const [, second] = stepProposals(t, filed.id);
    const errors: string[] = [];
    const caught = async (fn: () => unknown) => {
      try {
        await fn();
      } catch (err) {
        errors.push((err as Error).message);
      }
    };
    await caught(() => t.master.backlog.accept(second?.id ?? ''));
    await caught(() => t.master.backlog.cancelIteration(filed.id));
    await caught(() => t.master.backlog.rejectIteration(filed.id, ' '));
    t.master.backlog.rejectIteration(filed.id, 'Not now');
    await caught(() => t.master.backlog.acceptIteration(filed.id));
    expect(errors).toEqual([
      `Proposal ${second?.id} is a step of iteration ${filed.id}: accept or reject the iteration as a whole`,
      `Iteration ${filed.id} is not accepted yet: reject it, with a reason, rather than cancel it`,
      'Rejecting an iteration needs a reason',
      `Iteration ${filed.id} was turned down already`,
    ]);
    t.scripts.scout = () => ({ structured: { gaps: [], proposals: [] } });
    await scoutByHand(t);
    const prompt = lastScoutPrompt(t);
    expect(prompt).toContain(
      `- ${filed.id} iteration "Local repos run on their own" (steps: First, Second)\n  Reason: Not now`,
    );
    const notice = noticeFor(
      {
        id: 1,
        runId: null,
        type: 'iteration.blocked',
        data: { repo: 'demo', iterationId: filed.id, backlog: true, position: 2, reason: 'failed' },
        ts: new Date().toISOString(),
      },
      undefined,
    );
    expect(notice?.body).toContain('Step 2 of the iteration was not done');
    const text = [prompt, notice?.title, notice?.body, ...errors].join('\n');
    expect(text).not.toMatch(/[一-鿿]/);
  });
});
