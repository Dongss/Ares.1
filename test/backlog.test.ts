import { afterEach, describe, expect, it } from 'vitest';
import { InvalidStateError } from '../src/engine/engine.js';
import { setLang } from '../src/i18n.js';
import { noticeFor } from '../src/notify/notice.js';
import { NotFoundError } from '../src/store/store.js';
import type { Proposal, Run } from '../src/store/types.js';
import { FakeGitHub, type Harness, harness, TEST_AGENTS_YAML, waitFor } from './helpers.js';

const AGENTS = `${TEST_AGENTS_YAML}
  scout:
    cli: fake
    model: scout
`;

interface ConfigOptions {
  /** Automatic scouting; off unless a test is about it. */
  auto?: boolean;
  maxRisk?: 'none' | 'low' | 'mid' | 'high';
  /** null = no daily limit. */
  maxPerDay?: number | null;
  /** daily_budget_usd; omitted = no limit. */
  budget?: number;
}

/**
 * Only backlog.repos, no github section. auto_merge, so that the Runs of the test template
 * complete on their own.
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
${maxPerDay === null ? '' : `        max_per_day: ${maxPerDay}`}
      auto_merge: true
${opts.budget === undefined ? '' : `      daily_budget_usd: ${opts.budget}`}
`;
};

const proposal = (title: string, risk: 'low' | 'mid' | 'high', size: 'S' | 'M' | 'L' = 'S') => ({
  title,
  category: 'improvement',
  size,
  risk,
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
