import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProposalSource } from '../src/backlog/scouting.js';
import { REDO_BACKOFF_MAX_HOURS } from '../src/config/flow.js';
import type { BacklogRepoConfig } from '../src/config/schema.js';
import { InvalidInputError, InvalidStateError } from '../src/engine/engine.js';
import { type IterationUpdate, type PlannedIteration, proposalGoal } from '../src/github/scout.js';
import { setLang } from '../src/i18n.js';
import { noticeFor } from '../src/notify/notice.js';
import { ConflictError, NotFoundError } from '../src/store/store.js';
import type { IterationChild, Proposal, Run } from '../src/store/types.js';
import {
  done,
  FakeGitHub,
  git,
  type Harness,
  harness,
  review,
  type Script,
  TEST_AGENTS_YAML,
  waitFor,
  writeFile,
} from './helpers.js';

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
  /** max_run_attempts; omitted = the default (3). */
  maxAttempts?: number;
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
${opts.maxAttempts === undefined ? '' : `      max_run_attempts: ${opts.maxAttempts}`}
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
    expect(prompt).toContain(`- ${wanted.id} 要人定的（侦察提的，Run ${run.id}：`);
    const rejectedPart = prompt.slice(prompt.indexOf('### 被拒绝'));
    expect(rejectedPart).toContain(`- ${unwanted.id} 不想要的（侦察提的）\n  理由：太复杂，不划算`);

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

  it('never auto-accepts the draft a human keeps, within auto-accept or not', async () => {
    const t = await start(config({ maxRisk: 'high' }));
    const store = t.master.store;
    const draft = t.master.backlog.write('demo', {
      title: '人存着的',
      what: '以后再做',
      risk: 'low',
      size: 'S',
      start: false,
    });
    expect(draft).toMatchObject({ author: 'human', scoutId: null, status: 'pending' });
    // A scout's proposal of the same kind, left while the work switch was off.
    const scouts = store.createProposal({
      ...proposal('侦察提的', 'low'),
      category: 'improvement',
      repoId: t.repo.id,
      scoutId: null,
    });
    await t.master.backlog.poll();
    expect(store.getProposal(scouts.id)).toMatchObject({ status: 'accepted', auto: true });
    expect(store.getProposal(draft.id)).toMatchObject({ status: 'pending', runId: null });
    expect(eventData(t, 'proposal.auto_accepted').map((d) => d.proposalId)).toEqual([scouts.id]);
    expect(store.listRuns()).toHaveLength(1);
    // Still waiting for its author on the dashboard.
    expect(demoStatus(t)?.pendingProposals).toBe(1);
    // Started when its author accepts it.
    expect(t.master.backlog.accept(draft.id)).toMatchObject({ status: 'accepted', auto: false });
    expect(eventData(t, 'proposal.accepted').map((d) => d.proposalId)).toEqual([draft.id]);
    expect(demoStatus(t)?.autoAccept.usedToday).toBe(1);
    expect(gh.calls).toEqual([]);
  });

  it('does not count the drafts a human keeps among the proposals that hold the automatic scout back', async () => {
    // Without auto-accept every proposal of a scout left pending holds it back.
    const t = await start(config({ auto: true, maxRisk: 'none' }));
    const store = t.master.store;
    for (const title of ['一', '二', '三']) {
      t.master.backlog.write('demo', { title: `人写的${title}`, what: '以后再做', start: false });
    }
    t.scripts.scout = () => ({
      structured: {
        gaps: [],
        proposals: [proposal('甲', 'high'), proposal('乙', 'high'), proposal('丙', 'high')],
      },
    });
    // Three drafts, max_proposals 3: the scout starts all the same.
    await t.master.backlog.poll();
    const [scout] = store.listScouts();
    if (!scout) throw new Error('the drafts held the scout back');
    await scoutDone(t, scout.id);
    // The scout was shown them, so that it does not propose them again.
    const pendingPart = lastScoutPrompt(t).slice(lastScoutPrompt(t).indexOf('### 等人决定'));
    // Marked as a human's: the human's direction.
    expect(pendingPart).toContain('人写的一（人写的）');
    expect(store.listProposals({ repoId: t.repo.id, status: 'pending' })).toHaveLength(6);
    // The scout's three hold it back now; the drafts are not counted with them.
    await t.master.backlog.poll();
    expect(store.listScouts()).toHaveLength(1);
    expect(demoStatus(t)?.scout?.waiting?.reason).toBe('有 3 条提案等你处理');
    expect(demoStatus(t)?.pendingProposals).toBe(6);
    expect(store.listRuns()).toHaveLength(0);
    expect(gh.calls).toEqual([]);
  });

  it("refuses a human's requirement for a repo it cannot take, without writing it", async () => {
    const t = await start(`
github:
  repos:
    hub:
      template: dev
${config()}
    other:
      template: dev
`);
    const write = (name: string) => () =>
      t.master.backlog.write(name, { title: '一个需求', what: '要做的事' });
    expect(write('hub')).toThrow(ConflictError);
    expect(write('hub')).toThrow('仓库 hub 的需求来自 GitHub');
    expect(write('nowhere')).toThrow(NotFoundError);
    expect(write('other')).toThrow('仓库 other 没有在看板上登记');
    expect(() => t.master.backlog.write('demo', { title: ' \n', what: '要做的事' })).toThrow(
      '需求的标题和要做什么都不能为空',
    );
    // A blank title or what to do is a wrong request, answered with 400 whoever calls this.
    expect(() => t.master.backlog.write('demo', { title: '一个需求', what: ' ' })).toThrow(
      InvalidInputError,
    );
    expect(t.master.store.listProposals()).toEqual([]);
    expect(eventData(t, 'proposal.created')).toEqual([]);
  });

  it('refuses an edit that blanks the title or what to do as a wrong request, keeping the proposal', async () => {
    const t = await start(config());
    const draft = t.master.backlog.write('demo', {
      title: '一个需求',
      what: '要做的事',
      start: false,
    });
    expect(() => t.master.backlog.edit(draft.id, { title: ' \n ' })).toThrow(InvalidInputError);
    expect(() => t.master.backlog.edit(draft.id, { what: '' })).toThrow(
      '需求的标题和要做什么都不能为空',
    );
    expect(() => t.master.backlog.reject(draft.id, ' ')).toThrow(InvalidInputError);
    expect(t.master.store.getProposal(draft.id)).toEqual(draft);
    expect(eventData(t, 'proposal.edited')).toEqual([]);
    // A decided one is refused for its state instead.
    t.master.backlog.reject(draft.id, '不做了');
    expect(() => t.master.backlog.edit(draft.id, { title: '改' })).toThrow(ConflictError);
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

/** Coding, then merging without approval; an agent error ends the Run as failed at once. */
const REDO_WORKFLOW = `
id: dev
name: 测试流程
defaults:
  escalate:
    max_retries: 0
    on_agent_error: retry
stages:
  - id: implement
    name: 编码
    kind: agent
    agent: coder
  - id: merge
    name: 合并
    kind: merge
`;

/**
 * A coder that errors on the calls listed (counted from 1) and otherwise writes feature.txt at a
 * cost of $2. `error`: what it says when it errors.
 */
const coderFailingOn = (
  failing: number[],
  error = (n: number) => `第 ${n} 次：模型额度用完了`,
): Script => {
  let calls = 0;
  return (ctx) => {
    calls++;
    if (failing.includes(calls)) return { status: 'failed', error: error(calls) };
    writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
    return { ...done('写了 feature.txt'), costUsd: 2 };
  };
};

/**
 * As if `ms` had passed since the failed Runs ended (by default the longest wait before a redo):
 * they ended that much earlier.
 */
const elapseRedoWait = (t: Harness, ms = REDO_BACKOFF_MAX_HOURS * 3_600_000) => {
  const store = t.master.store;
  for (const r of store.listRuns({ status: 'failed' })) {
    if (!r.finishedAt) continue;
    store.updateRun(r.id, {
      finishedAt: new Date(Date.parse(r.finishedAt) - ms).toISOString(),
    });
  }
};

describe('local backlog: redo after a failure', () => {
  async function startRedo(
    cfg: string,
    failing: number[],
    workflow = REDO_WORKFLOW,
  ): Promise<Harness> {
    gh = new FakeGitHub();
    h = await harness({ agents: AGENTS, config: cfg, github: gh, workflow });
    h.scripts.coder = coderFailingOn(failing);
    h.scripts.scout = () => ({ structured: { gaps: [], proposals: [] } });
    return h;
  }

  /** A proposal beyond auto-accept, accepted by a human: its Run starts at once. */
  const acceptByHand = (t: Harness, title = '加 feature', p = proposal(title, 'high')) => {
    const row = t.master.store.createProposal({
      ...p,
      category: 'improvement',
      repoId: t.repo.id,
      scoutId: null,
    });
    return t.master.backlog.accept(row.id);
  };

  /** The latest Run of the proposal. */
  const latestRun = (t: Harness, id: string) =>
    t.master.store.getRun(t.master.store.getProposal(id).runId ?? '');

  const coderPrompts = (t: Harness) =>
    t.fake.calls.filter((c) => c.model === 'coder').map((c) => c.prompt);

  /** Today's automatic spending is $5 already: a scout cost that much. Returns the scout. */
  const spendToday = (t: Harness) => {
    const store = t.master.store;
    const scout = store.createScout({
      repoId: t.repo.id,
      issuesRepo: '',
      trigger: 'auto',
      agentId: 'scout',
      model: 'scout',
      logPath: '',
    });
    return store.updateScout(scout.id, {
      status: 'completed',
      costUsd: 5,
      endedAt: new Date().toISOString(),
    });
  };
  /** As on the next day: the scout's spend is yesterday's. */
  const nextDay = (t: Harness, scoutId: string) =>
    t.master.store.updateScout(scoutId, {
      startedAt: new Date(Date.now() - 86_400_000).toISOString(),
    });

  it('redoes a failed Run once the wait is over, its goal telling why the first attempt failed', async () => {
    const t = await startRedo(config({ auto: true }), [1]);
    const store = t.master.store;
    const p = acceptByHand(t);
    const first = await t.waitStatus(p.runId ?? '', 'failed');
    // As if the failed attempt had cost something: a human accepted it, so it does not count.
    store.updateRun(first.id, { costUsd: 1 });
    await t.master.backlog.poll();

    // Recorded, but not redone right away: the first failure waits poll_minutes (5).
    expect(store.listRuns()).toHaveLength(1);
    const failure = {
      runId: first.id,
      attempt: 1,
      stage: '编码',
      error: expect.stringContaining('第 1 次：模型额度用完了'),
    };
    expect(store.getProposal(p.id)).toMatchObject({
      status: 'accepted',
      runId: first.id,
      attempt: 1,
      redo: 'pending',
      failures: [failure],
    });
    const redoAt = Date.parse(first.finishedAt ?? '') + 5 * 60_000;
    expect(eventData(t, 'proposal.redo_scheduled')).toEqual([
      {
        repo: 'demo',
        proposalId: p.id,
        runId: first.id,
        attempt: 2,
        maxAttempts: 3,
        redoAt: new Date(redoAt).toISOString(),
      },
    ]);
    // The automatic scout waits for the redo, as its result changes what is worth doing next.
    expect(demoStatus(t)?.scout?.waiting?.reason).toBe('有 1 条提案在等重做');
    expect(store.listScouts()).toHaveLength(0);
    // A poll before the wait is over changes nothing, and records nothing twice.
    await t.master.backlog.poll();
    expect(store.listRuns()).toHaveLength(1);
    expect(eventData(t, 'proposal.redo_scheduled')).toHaveLength(1);

    elapseRedoWait(t);
    await t.master.backlog.poll();
    const second = latestRun(t, p.id);
    expect(second.id).not.toBe(first.id);
    expect(store.listRuns()).toHaveLength(2);
    expect(store.getProposal(p.id)).toMatchObject({
      status: 'accepted',
      runId: second.id,
      attempt: 2,
      redo: null,
      failures: [failure],
    });
    expect(second.issue).toBeNull();
    // The goal is the proposal's text, then why the earlier attempt failed.
    expect(second.goal.startsWith(proposalGoal(p))).toBe(true);
    expect(second.goal).toContain('## 之前的尝试');
    expect(second.goal).toContain('这个需求之前已经做过 1 次，都失败了，这是第 2 次。');
    expect(second.goal).toContain(`### 第 1 次（Run ${first.id}，失败在「编码」阶段）`);
    expect(second.goal).toContain('第 1 次：模型额度用完了');
    expect(eventData(t, 'proposal.redone')).toEqual([
      {
        repo: 'demo',
        proposalId: p.id,
        runId: second.id,
        failedRunId: first.id,
        attempt: 2,
        maxAttempts: 3,
      },
    ]);
    expect(demoStatus(t)?.scout?.waiting?.reason).toBe('等 1 个未结束的 Run 做完');

    await t.waitStatus(second.id, 'completed');
    // The second attempt's agent read why the first one failed; the first one's did not.
    const [firstPrompt, secondPrompt] = coderPrompts(t);
    expect(firstPrompt).not.toContain('之前的尝试');
    expect(secondPrompt).toContain('## 之前的尝试');
    expect(secondPrompt).toContain('第 1 次：模型额度用完了');
    // The redo counts toward today's automatic spending; the attempt a human accepted does not.
    expect(demoStatus(t)?.budget.spentToday).toBe(2);
    // Nothing is left to redo.
    expect(store.proposalsWithFailedRun(t.repo.id)).toEqual([]);
    expect(gh.calls).toEqual([]);
  });

  it('redoes the Run of a requirement a human wrote until max_run_attempts is used up', async () => {
    const t = await startRedo(config({ maxAttempts: 2 }), [1, 2]);
    const store = t.master.store;
    const p = t.master.backlog.write('demo', {
      title: '人写的需求',
      what: '写一个 feature.txt',
      acceptance: ['有 feature.txt'],
    });
    expect(p).toMatchObject({ author: 'human', status: 'accepted', auto: false, attempt: 1 });
    const first = await t.waitStatus(p.runId ?? '', 'failed');
    expect(first.goal).toBe(proposalGoal(p));
    await t.master.backlog.poll();
    expect(store.getProposal(p.id)).toMatchObject({ status: 'accepted', redo: 'pending' });
    expect(eventData(t, 'proposal.redo_scheduled')).toMatchObject([
      { proposalId: p.id, attempt: 2, maxAttempts: 2 },
    ]);

    elapseRedoWait(t);
    await t.master.backlog.poll();
    const second = latestRun(t, p.id);
    expect(second.id).not.toBe(first.id);
    expect(second.goal.startsWith(proposalGoal(p))).toBe(true);
    expect(second.goal).toContain('第 1 次：模型额度用完了');
    expect(store.getProposal(p.id)).toMatchObject({ attempt: 2, redo: null });
    await t.waitStatus(second.id, 'failed');
    // No attempts left: the requirement failed, with every reason.
    await t.master.backlog.poll();
    expect(store.getProposal(p.id)).toMatchObject({
      author: 'human',
      status: 'failed',
      redo: 'exhausted',
      attempt: 2,
    });
    expect(store.getProposal(p.id).failures.map((f) => f.runId)).toEqual([first.id, second.id]);
    expect(eventData(t, 'proposal.failed')).toMatchObject([{ proposalId: p.id, attempts: 2 }]);
    expect(store.listRuns()).toHaveLength(2);
    expect(gh.calls).toEqual([]);
  });

  it('gives the proposal up once max_run_attempts is used up, with every reason', async () => {
    const t = await startRedo(config({ maxAttempts: 2 }), [1, 2]);
    const store = t.master.store;
    const p = acceptByHand(t);
    const first = await t.waitStatus(p.runId ?? '', 'failed');
    await t.master.backlog.poll();
    elapseRedoWait(t);
    await t.master.backlog.poll();
    const second = await t.waitStatus(latestRun(t, p.id).id, 'failed');
    expect(second.goal).toContain('第 1 次：模型额度用完了');
    // No attempts left: given up at once, nothing to wait for.
    await t.master.backlog.poll();

    const failures = [
      {
        runId: first.id,
        attempt: 1,
        stage: '编码',
        error: expect.stringContaining('第 1 次：模型额度用完了'),
      },
      {
        runId: second.id,
        attempt: 2,
        stage: '编码',
        error: expect.stringContaining('第 2 次：模型额度用完了'),
      },
    ];
    expect(store.getProposal(p.id)).toMatchObject({
      status: 'failed',
      runId: second.id,
      attempt: 2,
      redo: 'exhausted',
      failures,
    });
    expect(eventData(t, 'proposal.failed')).toEqual([
      {
        repo: 'demo',
        proposalId: p.id,
        runId: second.id,
        attempts: 2,
        maxAttempts: 2,
        failures,
      },
    ]);
    expect(eventData(t, 'proposal.redo_scheduled')).toHaveLength(1);
    // Never redone again, however long it waits.
    elapseRedoWait(t);
    await t.master.backlog.poll();
    expect(store.listRuns()).toHaveLength(2);
    expect(store.listProposals({ repoId: t.repo.id, status: 'failed' })).toHaveLength(1);
    expect(() => t.master.backlog.accept(p.id)).toThrow(
      `提案 ${p.id} 已经采纳过，Run 失败 2 次后不再重做了`,
    );
    expect(() => t.master.backlog.reject(p.id, '不做了')).toThrow(InvalidStateError);

    // The scout reads it as given up after failures, with every reason, not as a rejection.
    await scoutByHand(t);
    const prompt = lastScoutPrompt(t);
    const given = prompt.slice(prompt.indexOf('### 多次失败后放弃（不是人拒绝的）'));
    expect(given).toContain(`- ${p.id} 加 feature（侦察提的，失败 2 次）`);
    expect(given).toContain(`  第 1 次（Run ${first.id}，失败在「编码」阶段）：`);
    expect(given).toContain(`  第 2 次（Run ${second.id}，失败在「编码」阶段）：`);
    expect(given).toContain('第 2 次：模型额度用完了');
    expect(prompt.slice(prompt.indexOf('### 被拒绝'))).not.toContain(
      `${p.id} 加 feature（侦察提的）\n`,
    );
  });

  it('starts a failed proposal over by hand: attempts from 1, told why, redone again', async () => {
    // Its first two Runs use up the attempts; the one it is started over with fails too.
    const t = await startRedo(config({ maxAttempts: 2, budget: 5 }), [1, 2, 3]);
    const store = t.master.store;
    const p = acceptByHand(t);
    const first = await t.waitStatus(p.runId ?? '', 'failed');
    await t.master.backlog.poll();
    elapseRedoWait(t);
    await t.master.backlog.poll();
    const second = await t.waitStatus(latestRun(t, p.id).id, 'failed');
    await t.master.backlog.poll();
    expect(store.getProposal(p.id)).toMatchObject({ status: 'failed', attempt: 2 });

    // A human's decision: the day's budget, spent already, does not hold it back.
    const scout = spendToday(t);
    const restarted = await t.master.backlog.restart(p.id);
    const third = latestRun(t, p.id);
    expect(third.id).not.toBe(second.id);
    expect(restarted).toMatchObject({
      status: 'accepted',
      runId: third.id,
      attempt: 1,
      redo: null,
      failures: [
        expect.objectContaining({ runId: first.id, attempt: 1 }),
        expect.objectContaining({ runId: second.id, attempt: 2 }),
      ],
    });
    expect(third.goal).toContain(`### 第 1 次（Run ${first.id}，失败在「编码」阶段）`);
    expect(third.goal).toContain(`### 第 2 次（Run ${second.id}，失败在「编码」阶段）`);
    expect(eventData(t, 'proposal.restarted')).toEqual([
      {
        repo: 'demo',
        proposalId: p.id,
        runId: third.id,
        failedRunId: second.id,
        attempts: 2,
        maxAttempts: 2,
      },
    ]);
    // Started over once: nothing more to start over until it fails for good again.
    await expect(t.master.backlog.restart(p.id)).rejects.toThrow(
      `提案 ${p.id} 没有失败：只有 Run 用完尝试次数、标为已失败的提案能重新开始`,
    );

    // It failed again, as its first attempt: to be redone, an automatic redo again, which waits
    // for the day's budget.
    await t.waitStatus(third.id, 'failed');
    await t.master.backlog.poll();
    expect(store.getProposal(p.id)).toMatchObject({ status: 'accepted', redo: 'pending' });
    expect(eventData(t, 'proposal.redo_scheduled').at(-1)).toMatchObject({
      runId: third.id,
      attempt: 2,
      maxAttempts: 2,
    });
    elapseRedoWait(t);
    await t.master.backlog.poll();
    expect(latestRun(t, p.id).id).toBe(third.id);
    nextDay(t, scout.id);
    await t.master.backlog.poll();
    const fourth = latestRun(t, p.id);
    expect(fourth.id).not.toBe(third.id);
    await t.waitStatus(fourth.id, 'completed');
    expect(store.getProposal(p.id)).toMatchObject({
      status: 'accepted',
      attempt: 2,
      failures: [
        expect.objectContaining({ runId: first.id, attempt: 1 }),
        expect.objectContaining({ runId: second.id, attempt: 2 }),
        expect.objectContaining({ runId: third.id, attempt: 1 }),
      ],
    });
    // Its new Runs are told why every earlier attempt failed, those before it was started over too.
    expect(fourth.goal).toContain(`Run ${second.id}`);
    expect(fourth.goal).toContain(`Run ${third.id}`);
  });

  it('does not start over a proposal that has not failed', async () => {
    const t = await startRedo(config(), []);
    const store = t.master.store;
    const pending = store.createProposal({
      ...proposal('待处理', 'high'),
      category: 'improvement',
      repoId: t.repo.id,
      scoutId: null,
    });
    await expect(t.master.backlog.restart(pending.id)).rejects.toThrow(
      `提案 ${pending.id} 还没有采纳，不用重新开始`,
    );
    store.updateProposal(pending.id, { status: 'rejected', rejectReason: '不要' });
    await expect(t.master.backlog.restart(pending.id)).rejects.toThrow(
      `提案 ${pending.id} 已经被拒绝了，不能重新开始`,
    );
    await expect(t.master.backlog.restart('proposal_none')).rejects.toThrow(NotFoundError);
    expect(store.listRuns()).toEqual([]);
    expect(eventData(t, 'proposal.restarted')).toEqual([]);
  });

  it('gives up at the first failure with max_run_attempts: 1', async () => {
    const t = await startRedo(config({ maxAttempts: 1 }), [1]);
    const p = acceptByHand(t);
    await t.waitStatus(p.runId ?? '', 'failed');
    await t.master.backlog.poll();
    expect(t.master.store.getProposal(p.id)).toMatchObject({ status: 'failed', attempt: 1 });
    expect(eventData(t, 'proposal.failed')[0]).toMatchObject({ attempts: 1, maxAttempts: 1 });
    expect(eventData(t, 'proposal.redo_scheduled')).toEqual([]);
  });

  it('does not redo a Run a human terminated, nor give its proposal up', async () => {
    const t = await startRedo(config(), []);
    t.scripts.coder = async (ctx) => {
      await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
      return done();
    };
    const p = acceptByHand(t);
    const run = p.runId ?? '';
    await waitFor(() => t.fake.calls.length === 1, 'the agent to start');
    expect((await t.master.engine.cancel(run)).status).toBe('cancelled');
    elapseRedoWait(t);
    await t.master.backlog.poll();
    expect(t.master.store.getProposal(p.id)).toMatchObject({
      status: 'accepted',
      runId: run,
      attempt: 1,
      redo: null,
      failures: [],
    });
    expect(t.master.store.listRuns()).toHaveLength(1);
    expect(eventData(t, 'proposal.redo_scheduled')).toEqual([]);
    expect(eventData(t, 'proposal.failed')).toEqual([]);
  });

  it("waits for the next day once the day's budget is spent, and for the work switch", async () => {
    const t = await startRedo(config({ budget: 5 }), [1]);
    const store = t.master.store;
    const scout = spendToday(t);
    const p = acceptByHand(t);
    await t.waitStatus(p.runId ?? '', 'failed');
    // Recorded all the same: only the redo waits.
    await t.master.backlog.poll();
    expect(store.getProposal(p.id).redo).toBe('pending');
    elapseRedoWait(t);
    await t.master.backlog.poll();
    expect(store.listRuns()).toHaveLength(1);
    expect(store.getProposal(p.id)).toMatchObject({ redo: 'pending', attempt: 1 });

    // The next day the budget is back, but the work switch is off.
    nextDay(t, scout.id);
    store.setWorking(false);
    await t.master.backlog.poll();
    expect(store.listRuns()).toHaveLength(1);

    // Turned on, it polls at once and redoes the proposal; the next poll finds nothing more.
    store.setWorking(true);
    await t.master.backlog.poll();
    expect(store.listRuns()).toHaveLength(2);
    expect(store.getProposal(p.id)).toMatchObject({ attempt: 2, redo: null });
    expect(eventData(t, 'proposal.redone')).toHaveLength(1);
  });

  it('redoes as recorded once the Master restarted', async () => {
    const t = await startRedo(config(), [1]);
    const p = acceptByHand(t);
    const first = await t.waitStatus(p.runId ?? '', 'failed');
    // The Master stops before any poll saw the failure.
    await t.close();
    h = await harness({
      agents: AGENTS,
      config: config(),
      github: gh,
      home: t.home,
      repoDir: t.repoDir,
      workflow: REDO_WORKFLOW,
    });
    const after = h;
    const store = after.master.store;
    await after.master.backlog.poll();
    expect(store.getProposal(p.id)).toMatchObject({ redo: 'pending', attempt: 1 });
    expect(store.listRuns()).toHaveLength(1);

    // Again, while it waits: what it recorded holds.
    await after.close();
    h = await harness({
      agents: AGENTS,
      config: config(),
      github: gh,
      home: t.home,
      repoDir: t.repoDir,
      workflow: REDO_WORKFLOW,
    });
    const again = h;
    elapseRedoWait(again);
    await again.master.backlog.poll();
    const second = latestRun(again, p.id);
    expect(second.id).not.toBe(first.id);
    expect(second.goal).toContain(`### 第 1 次（Run ${first.id}，失败在「编码」阶段）`);
    await again.waitStatus(second.id, 'completed');
    expect(again.master.store.listGlobalEventsOfType('proposal.redo_scheduled')).toHaveLength(1);
    expect(again.master.store.listGlobalEventsOfType('proposal.redone')).toHaveLength(1);
  });

  /** Whether the Run's worktree and branch are still there. */
  const kept = (t: Harness, run: Run) => ({
    worktree: existsSync(run.worktreePath as string),
    branch: git(t.repoDir, 'branch', '--list', run.branch as string) !== '',
  });
  const gone = { worktree: false, branch: false };
  const there = { worktree: true, branch: true };
  /** The data of the Run's `workspace.removed` events. */
  const removals = (t: Harness, runId: string) =>
    t.master.store
      .listEvents(runId)
      .filter((e) => e.type === 'workspace.removed')
      .map((e) => e.data);
  /** What `workspace.removed` records for an attempt of proposal `p` removed for `why`. */
  const removedFor = (run: Run, p: Proposal, why: Record<string, string>) => ({
    path: run.worktreePath,
    branch: run.branch,
    ...why,
    proposalId: p.id,
  });

  it('removes the worktree and branch of the failed attempt once its redo completes', async () => {
    const t = await startRedo(config(), [1]);
    const p = acceptByHand(t);
    const first = await t.waitStatus(p.runId ?? '', 'failed');
    await t.master.backlog.poll();
    elapseRedoWait(t);
    await t.master.backlog.poll();
    const second = latestRun(t, p.id);
    expect(second.id).not.toBe(first.id);
    expect(kept(t, first)).toEqual(there);

    await t.waitStatus(second.id, 'completed');
    await waitFor(() => removals(t, first.id).length > 0, 'the failed attempt to be removed');
    expect(kept(t, first)).toEqual(gone);
    expect(git(t.repoDir, 'worktree', 'list', '--porcelain')).not.toContain(first.branch);
    expect(removals(t, first.id)).toEqual([
      removedFor(first, p, { reason: 'superseded', supersededBy: second.id }),
    ]);
    // Its records stay.
    expect(t.master.store.getRun(first.id)).toMatchObject({ status: 'failed', error: first.error });
    // Nothing is recorded twice: neither by a poll nor by the sweep.
    await t.master.backlog.poll();
    await t.master.engine.sweepLeftoverWorkspaces();
    expect(removals(t, first.id)).toHaveLength(1);
  });

  it('keeps only the last attempt once the attempts are used up, the newest after a restart', async () => {
    const t = await startRedo(config({ maxAttempts: 2 }), [1, 2, 3, 4]);
    const store = t.master.store;
    const p = acceptByHand(t);
    /** Both Runs of the proposal's round, once they failed and the proposal is given up. */
    const failRound = async (): Promise<[Run, Run]> => {
      const a = await t.waitStatus(latestRun(t, p.id).id, 'failed');
      await t.master.backlog.poll();
      elapseRedoWait(t);
      await t.master.backlog.poll();
      const b = await t.waitStatus(latestRun(t, p.id).id, 'failed');
      expect(b.id).not.toBe(a.id);
      await t.master.backlog.poll();
      expect(store.getProposal(p.id)).toMatchObject({ status: 'failed', redo: 'exhausted' });
      return [a, b];
    };

    // Removed at the poll that gives the proposal up.
    const [first, second] = await failRound();
    expect(kept(t, first)).toEqual(gone);
    expect(removals(t, first.id)).toEqual([
      removedFor(first, p, { reason: 'retries_exhausted', keptRun: second.id }),
    ]);
    expect(kept(t, second)).toEqual(there);
    expect(removals(t, second.id)).toEqual([]);

    // Started over and given up again: the earlier round's last attempt is not the last any more.
    await t.master.backlog.restart(p.id);
    const [third, fourth] = await failRound();
    for (const run of [second, third]) {
      expect(kept(t, run)).toEqual(gone);
      expect(removals(t, run.id)).toEqual([
        removedFor(run, p, { reason: 'retries_exhausted', keptRun: fourth.id }),
      ]);
    }
    expect(kept(t, fourth)).toEqual(there);

    // Started over again and done: the last failed attempt goes too.
    await t.master.backlog.restart(p.id);
    const fifth = await t.waitStatus(latestRun(t, p.id).id, 'completed');
    await waitFor(() => removals(t, fourth.id).length > 0, 'the last attempt to be removed');
    expect(kept(t, fourth)).toEqual(gone);
    expect(removals(t, fourth.id)).toEqual([
      removedFor(fourth, p, { reason: 'superseded', supersededBy: fifth.id }),
    ]);
    // Those removed before are not recorded again.
    for (const run of [first, second, third]) expect(removals(t, run.id)).toHaveLength(1);
  });

  it('never removes a Run a human terminated, nor the last failed attempt before it', async () => {
    const t = await startRedo(config(), []);
    let calls = 0;
    t.scripts.coder = async (ctx) => {
      if (++calls === 1) return { status: 'failed', error: '模型额度用完了' };
      await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
      return done();
    };
    const p = acceptByHand(t);
    const first = await t.waitStatus(p.runId ?? '', 'failed');
    await t.master.backlog.poll();
    elapseRedoWait(t);
    await t.master.backlog.poll();
    const second = latestRun(t, p.id);
    await waitFor(() => calls === 2, 'the redo to code');
    expect((await t.master.engine.cancel(second.id)).status).toBe('cancelled');
    const cancelled = t.master.store.getRun(second.id);
    expect(kept(t, cancelled)).toEqual(there);

    await t.master.backlog.poll();
    await t.master.engine.removeProposalAttempts(p.id);
    await t.master.engine.sweepLeftoverWorkspaces();
    for (const run of [first, cancelled]) {
      expect(kept(t, run)).toEqual(there);
      expect(removals(t, run.id)).toEqual([]);
    }
    expect(t.master.store.getProposal(p.id)).toMatchObject({ status: 'accepted', redo: null });
  });

  it('removes at the next start what the Master stopped before removing', async () => {
    // A's first Run fails and its redo completes; B's two Runs use up its attempts.
    const t = await startRedo(config({ maxAttempts: 2 }), [1, 3, 4]);
    const store = t.master.store;
    // The Master stops each time before it removes anything.
    const removal = vi.spyOn(t.master.engine, 'removeProposalAttempts').mockResolvedValue();
    const a = acceptByHand(t, '加 feature');
    const a1 = await t.waitStatus(a.runId ?? '', 'failed');
    await t.master.backlog.poll();
    elapseRedoWait(t);
    await t.master.backlog.poll();
    const a2 = await t.waitStatus(latestRun(t, a.id).id, 'completed');
    const b = acceptByHand(t, '加 cache');
    const b1 = await t.waitStatus(b.runId ?? '', 'failed');
    await t.master.backlog.poll();
    elapseRedoWait(t);
    await t.master.backlog.poll();
    const b2 = await t.waitStatus(latestRun(t, b.id).id, 'failed');
    await t.master.backlog.poll();
    expect(store.getProposal(b.id).redo).toBe('exhausted');
    expect(removal.mock.calls).toEqual([[a.id], [b.id]]);
    for (const run of [a1, b1, b2]) expect(kept(t, run)).toEqual(there);

    await t.close();
    h = await harness({
      agents: AGENTS,
      config: config({ maxAttempts: 2 }),
      github: gh,
      home: t.home,
      repoDir: t.repoDir,
      workflow: REDO_WORKFLOW,
    });
    const next = h;
    await waitFor(
      () => [a1, b1].every((run) => removals(next, run.id).length > 0),
      'the leftover workspaces to be removed',
    );
    expect(kept(next, a1)).toEqual(gone);
    expect(removals(next, a1.id)).toEqual([
      removedFor(a1, a, { reason: 'superseded', supersededBy: a2.id }),
    ]);
    expect(kept(next, b1)).toEqual(gone);
    expect(removals(next, b1.id)).toEqual([
      removedFor(b1, b, { reason: 'retries_exhausted', keptRun: b2.id }),
    ]);
    expect(kept(next, b2)).toEqual(there);
    expect(removals(next, b2.id)).toEqual([]);
  });

  it('speaks English without Chinese left', async () => {
    const workflow = REDO_WORKFLOW.replace('测试流程', 'Test flow')
      .replace('编码', 'Coding')
      .replace('合并', 'Merge');
    const t = await startRedo(
      `language: en\n${config({ auto: true, maxAttempts: 2 })}`,
      [1, 2],
      workflow,
    );
    t.scripts.coder = coderFailingOn([1, 2], (n) => `attempt ${n}: out of quota`);
    const english = {
      ...proposal('Add a cache', 'high'),
      why: 'Why: a cache',
      evidence: ['run_abc was reworked 3 times'],
      what: 'How: a cache',
      acceptance: ['Tests pass'],
    };
    const p = acceptByHand(t, 'Add a cache', english);
    const first = await t.waitStatus(p.runId ?? '', 'failed');
    await t.master.backlog.poll();
    const waiting = demoStatus(t)?.scout?.waiting?.reason;
    expect(waiting).toBe('1 proposal waiting to be redone');
    elapseRedoWait(t);
    await t.master.backlog.poll();
    const second = latestRun(t, p.id);
    expect(second.goal).toContain('## Earlier attempts');
    expect(second.goal).toContain(
      'This requirement was attempted once before, and it failed; this is attempt 2.',
    );
    expect(second.goal).toContain(`### Attempt 1 (Run ${first.id}, failed in the "Coding" stage)`);
    await t.waitStatus(second.id, 'failed');
    // Given up: the repo is idle again, so the automatic scout starts.
    await t.master.backlog.poll();
    let refused = '';
    try {
      t.master.backlog.accept(p.id);
    } catch (err) {
      refused = (err as Error).message;
    }
    expect(refused).toBe(
      `Proposal ${p.id} was accepted already, and given up after its Runs failed 2 times`,
    );
    const [scout] = t.master.store.listScouts();
    if (!scout) throw new Error('no scout');
    await scoutDone(t, scout.id);
    const prompt = lastScoutPrompt(t);
    const given = prompt.slice(
      prompt.indexOf('### Given up after repeated failures (not rejected by a human)'),
    );
    expect(given).toContain(`- ${p.id} Add a cache (proposed by a scout; failed 2 times)`);
    expect(given).toContain(`  Attempt 2 (Run ${second.id}, failed in the "Coding" stage): `);

    const text = [second.goal, waiting, refused, given].join('\n');
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
    // Problems and defects, up to max_proposals: a gap is planned as an iteration, not proposed
    // on its own. The steps of the iteration do not count toward max_proposals.
    expect(filed).toEqual([['卡住的 Run', '明显的缺陷', '又一个卡住的']]);
    expect(scout.proposals.map((p) => p.lead)).toEqual(['problem', 'defect', 'problem']);
    expect(planned.map((p) => [p.title, p.children.length])).toEqual([
      ['不接 GitHub 的仓库也能永动', 2],
    ]);
    // No plan to change: the change is dropped as a rule, not as one that does not fit.
    expect(changes).toEqual([]);
    expect(eventData(t, 'scout.update_dropped')).toEqual([]);
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
    // The change fits the plan: nothing dropped.
    expect(eventData(t, 'scout.update_dropped')).toEqual([]);
  });

  it('drops a change that does not fit the plan, saying why, and files the problems all the same', async () => {
    const t = await start();
    underWay(t);
    const { source, filed, changes } = recordingSource(t);
    const update = { ...UPDATE, add: [{ ...UPDATE.add[0], replaces: 2 }] };
    t.scripts.scout = () => ({
      structured: { gaps: [], proposals: LEADS, iteration: null, iterationUpdate: update },
    });
    const scout = await scoutWith(t, source);
    expect(scout.status).toBe('completed');
    expect(scout.error).toBeNull();
    expect(filed).toEqual([['卡住的 Run', '又一个卡住的']]);
    expect(changes).toEqual([]);
    expect(eventData(t, 'scout.update_dropped')).toEqual([
      {
        scoutId: scout.id,
        repo: 'demo',
        problems: ['追加的第 1 个子项（序号 3）不能替换第 2 个子项：它是收尾子项'],
      },
    ]);
    expect(eventData(t, 'scout.completed')).toEqual([
      expect.objectContaining({ scoutId: scout.id, created: 2 }),
    ]);
    expect(eventData(t, 'scout.failed')).toEqual([]);
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
      `- ${firstProposal.id} 第一步（侦察提的，Run ${first.id}：已完成，自动采纳，所属迭代 ${filed.id} 已完成）`,
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
      '迭代的第 1 步没有做成（Run 用完重做次数后仍然失败、被终止，或需求评估结论为不做），依赖它的子项开不了工。侦察下次会换个做法补一个子项替换它；也可以在看板上终止这个迭代，不做剩下的',
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
    expect(() => t.master.backlog.rejectIteration(filed.id, '')).toThrow(InvalidInputError);
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
      `- ${filed.id} 迭代「本地仓库也能永动」（侦察提的，子项：第一步、第二步、收尾）\n  理由：现在不做本地仓库`,
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

  /**
   * A Master whose Runs code then merge (REDO_WORKFLOW), the coder failing on the calls listed;
   * the iteration `iteration` planned and filed, auto-accepted, its scouts finding nothing after.
   */
  async function plannedFailing(cfg: string, failing: number[], iteration: unknown) {
    gh = new FakeGitHub();
    h = await harness({ agents: AGENTS, config: cfg, github: gh, workflow: REDO_WORKFLOW });
    h.scripts.coder = coderFailingOn(failing);
    const filed = await planned(h, iteration);
    h.scripts.scout = () => ({ structured: { gaps: [], proposals: [] } });
    expect(filed.status).toBe('active');
    return { t: h, filed };
  }

  /** The statuses a step went through, as its `iteration.child_status` events tell. */
  const stepHistory = (t: Harness, position: number) =>
    eventData(t, 'iteration.child_status')
      .filter((d) => d.position === position)
      .map((d) => d.status);

  it('redoes a step whose Run failed: the iteration goes on, never blocked, and is summed up', async () => {
    // The first Run of each step fails.
    const { t, filed } = await plannedFailing(
      config({ auto: true }),
      [1, 3],
      plan([step('第一步'), step('收尾', { criteria: [], dependsOn: [1], closeout: true })]),
    );
    const store = t.master.store;
    const first = await t.waitStatus(runOfStep(t, filed.id, 1).id, 'failed');
    await t.master.backlog.poll();

    // Recorded and waiting for its redo: the step goes on, nothing blocks, nothing else starts.
    const [p1] = stepProposals(t, filed.id);
    expect(p1).toMatchObject({
      status: 'accepted',
      runId: first.id,
      attempt: 1,
      redo: 'pending',
      failures: [expect.objectContaining({ runId: first.id, attempt: 1, stage: '编码' })],
    });
    expect(eventData(t, 'proposal.redo_scheduled')).toEqual([
      expect.objectContaining({ proposalId: p1?.id, runId: first.id, attempt: 2, maxAttempts: 3 }),
    ]);
    expect(iterationOf(t, filed.id).status).toBe('active');
    expect(statuses(t, filed.id)).toEqual(['running', 'waiting']);
    expect(store.listRuns()).toHaveLength(1);
    // The automatic scout waits for the redo, as for one of a proposal of its own.
    expect(demoStatus(t)?.scout?.waiting?.reason).toBe('有 1 条提案在等重做');
    await t.master.backlog.poll();
    expect(statuses(t, filed.id)).toEqual(['running', 'waiting']);
    expect(store.listRuns()).toHaveLength(1);

    elapseRedoWait(t);
    await t.master.backlog.poll();
    const second = runOfStep(t, filed.id, 1);
    expect(second.id).not.toBe(first.id);
    expect(second.goal).toContain(`### 第 1 次（Run ${first.id}，失败在「编码」阶段）`);
    expect(stepProposals(t, filed.id)[0]).toMatchObject({ attempt: 2, redo: null });
    expect(eventData(t, 'proposal.redone')).toEqual([
      expect.objectContaining({ proposalId: p1?.id, runId: second.id, failedRunId: first.id }),
    ]);
    // The step lists every Run that worked on it, the failed one included.
    expect(iterationOf(t, filed.id).children[0]?.runIds).toEqual([first.id, second.id]);
    await t.waitStatus(second.id, 'completed');

    // The closing step starts with the review suggestions; its first Run fails too, and its redo
    // goes by the text it was given, the suggestions once.
    await t.master.backlog.poll();
    expect(statuses(t, filed.id)).toEqual(['done', 'running']);
    const closing = stepProposals(t, filed.id)[1] as Proposal;
    expect(closing.what).toContain('收尾的做法\n\n### 本迭代评审留下的建议');
    const third = await t.waitStatus(runOfStep(t, filed.id, 2).id, 'failed');
    await t.master.backlog.poll();
    expect(statuses(t, filed.id)).toEqual(['done', 'running']);
    elapseRedoWait(t);
    await t.master.backlog.poll();
    const fourth = runOfStep(t, filed.id, 2);
    expect(fourth.id).not.toBe(third.id);
    expect(fourth.goal.split('### 本迭代评审留下的建议')).toHaveLength(2);
    expect(fourth.goal).toContain(`### 第 1 次（Run ${third.id}，失败在「编码」阶段）`);
    expect(stepProposals(t, filed.id)[1]?.what).toBe(closing.what);
    await t.waitStatus(fourth.id, 'completed');

    // Every step done: summed up and done, the failed attempts counted.
    await t.master.backlog.poll();
    const done = iterationOf(t, filed.id);
    expect(done).toMatchObject({ status: 'done', summaryPosted: true });
    expect(done.children.map((c) => [c.status, c.runIds])).toEqual([
      ['done', [first.id, second.id]],
      ['done', [third.id, fourth.id]],
    ]);
    expect(done.summary).toContain('## 迭代完成');
    expect(done.summary).toContain('完成了全部 2 个子项');
    expect(done.summary).toContain('- 总费用：$4.00，共 4 个 Run');
    expect(eventData(t, 'iteration.completed')).toEqual([
      { repo: 'demo', iterationId: filed.id, backlog: true, costUsd: 4, runs: 4 },
    ]);
    // Never blocked, never failed on the way.
    expect(eventData(t, 'iteration.blocked')).toEqual([]);
    expect(stepHistory(t, 1)).toEqual(['running', 'done']);
    expect(stepHistory(t, 2)).toEqual(['ready', 'running', 'done']);
    expect(gh.calls).toEqual([]);
  });

  it('blocks the iteration once a step used up its attempts, the step failed', async () => {
    const { t, filed } = await plannedFailing(
      config({ maxAttempts: 2 }),
      [1, 2],
      plan([step('第一步'), step('第二步', { dependsOn: [1] })]),
    );
    const store = t.master.store;
    const first = await t.waitStatus(runOfStep(t, filed.id, 1).id, 'failed');
    await t.master.backlog.poll();
    expect(statuses(t, filed.id)).toEqual(['running', 'waiting']);
    elapseRedoWait(t);
    await t.master.backlog.poll();
    const second = await t.waitStatus(runOfStep(t, filed.id, 1).id, 'failed');
    expect(second.id).not.toBe(first.id);
    // No attempts left: given up at once, which blocks the iteration.
    await t.master.backlog.poll();

    const [p1, p2] = stepProposals(t, filed.id);
    expect(p1).toMatchObject({
      status: 'failed',
      runId: second.id,
      attempt: 2,
      redo: 'exhausted',
      failures: [
        expect.objectContaining({ runId: first.id, attempt: 1 }),
        expect.objectContaining({ runId: second.id, attempt: 2 }),
      ],
    });
    expect(eventData(t, 'proposal.failed')).toEqual([
      expect.objectContaining({
        proposalId: p1?.id,
        runId: second.id,
        attempts: 2,
        maxAttempts: 2,
      }),
    ]);
    const blocked = iterationOf(t, filed.id);
    expect(blocked.status).toBe('blocked');
    expect(blocked.children.map((c) => [c.status, c.runIds])).toEqual([
      ['failed', [first.id, second.id]],
      ['waiting', []],
    ]);
    expect(eventData(t, 'iteration.blocked')).toEqual([
      {
        repo: 'demo',
        iterationId: filed.id,
        backlog: true,
        position: 1,
        proposalId: p1?.id,
        reason: 'failed',
      },
    ]);
    // Running from its first Run until it was given up, never failed in between.
    expect(stepHistory(t, 1)).toEqual(['running', 'failed']);

    // Never redone again, however long it waits; the step depending on it waits.
    elapseRedoWait(t);
    await t.master.backlog.poll();
    expect(store.listRuns()).toHaveLength(2);
    expect(store.getProposal(p2?.id ?? '').runId).toBeNull();
    expect(eventData(t, 'iteration.blocked')).toHaveLength(1);
    expect(eventData(t, 'proposal.redone')).toHaveLength(1);
  });

  it('starts a step given up over by hand: the iteration goes on, and is done', async () => {
    // Two independent steps and a closing one; the first Run of each of the two fails, and with
    // max_run_attempts: 1 each is given up at once.
    const { t, filed } = await plannedFailing(
      config({ maxAttempts: 1 }),
      [1, 2],
      plan([
        step('第一步'),
        step('第二步'),
        step('收尾', { criteria: [], dependsOn: [1, 2], closeout: true }),
      ]),
    );
    const store = t.master.store;
    const first = await t.waitStatus(runOfStep(t, filed.id, 1).id, 'failed');
    const second = await t.waitStatus(runOfStep(t, filed.id, 2).id, 'failed');
    await t.master.backlog.poll();
    expect(iterationOf(t, filed.id).status).toBe('blocked');
    expect(statuses(t, filed.id)).toEqual(['failed', 'failed', 'waiting']);
    const [p1, p2, p3] = stepProposals(t, filed.id);
    if (!p1 || !p2 || !p3) throw new Error('no steps');

    // The first started over: running again, but the second still blocks the iteration.
    await t.master.backlog.restart(p1.id);
    const again = runOfStep(t, filed.id, 1);
    expect(again.id).not.toBe(first.id);
    expect(again.goal).toContain(`### 第 1 次（Run ${first.id}，失败在「编码」阶段）`);
    expect(store.getProposal(p1.id)).toMatchObject({ status: 'accepted', attempt: 1, redo: null });
    let iteration = iterationOf(t, filed.id);
    expect(iteration.status).toBe('blocked');
    expect(iteration.children.map((c) => [c.status, c.runIds])).toEqual([
      ['running', [first.id, again.id]],
      ['failed', [second.id]],
      ['waiting', []],
    ]);
    expect(eventData(t, 'iteration.unblocked')).toEqual([]);

    // The second started over too: nothing blocks it any more.
    await t.master.backlog.restart(p2.id);
    const secondAgain = runOfStep(t, filed.id, 2);
    iteration = iterationOf(t, filed.id);
    expect(iteration.status).toBe('active');
    expect(statuses(t, filed.id)).toEqual(['running', 'running', 'waiting']);
    expect(eventData(t, 'iteration.unblocked')).toEqual([
      { repo: 'demo', iterationId: filed.id, backlog: true },
    ]);
    expect(eventData(t, 'proposal.restarted')).toEqual([
      expect.objectContaining({ proposalId: p1.id, runId: again.id, iterationId: filed.id }),
      expect.objectContaining({ proposalId: p2.id, runId: secondAgain.id, iterationId: filed.id }),
    ]);
    expect(stepHistory(t, 1)).toEqual(['running', 'failed', 'running']);

    // Both done, the closing step starts, and the iteration is done once it is.
    await t.waitStatus(again.id, 'completed');
    await t.waitStatus(secondAgain.id, 'completed');
    await t.master.backlog.poll();
    const closing = runOfStep(t, filed.id, 3);
    await t.waitStatus(closing.id, 'completed');
    await t.master.backlog.poll();
    const done = iterationOf(t, filed.id);
    expect(done.status).toBe('done');
    expect(done.children.map((c) => [c.status, c.runIds])).toEqual([
      ['done', [first.id, again.id]],
      ['done', [second.id, secondAgain.id]],
      ['done', [closing.id]],
    ]);
    // Neither a step done nor a step of an iteration over may be started over.
    await expect(t.master.backlog.restart(p1.id)).rejects.toThrow(
      `提案 ${p1.id} 没有失败：只有 Run 用完尝试次数、标为已失败的提案能重新开始`,
    );
    expect(gh.calls).toEqual([]);
  });

  it('does not start over a step its iteration no longer wants', async () => {
    const { t, filed } = await plannedFailing(
      config({ maxAttempts: 1 }),
      [1],
      plan([step('第一步'), step('第二步', { dependsOn: [1] })]),
    );
    const store = t.master.store;
    await t.waitStatus(runOfStep(t, filed.id, 1).id, 'failed');
    await t.master.backlog.poll();
    const [p1] = stepProposals(t, filed.id);
    if (!p1) throw new Error('no steps');
    expect(p1.status).toBe('failed');

    // Replaced by a scout: the new approach goes on instead.
    const children = iterationOf(t, filed.id).children.map((c) =>
      c.position === 1 ? { ...c, replacedBy: 3 } : c,
    );
    store.updateIteration(filed.id, { children });
    await expect(t.master.backlog.restart(p1.id)).rejects.toThrow(
      `提案 ${p1.id} 这一步已经由第 3 步换个做法接替，不能再重新开始`,
    );
    // Cancelled by a human: nothing of it is wanted any more.
    await t.master.backlog.cancelIteration(filed.id);
    await expect(t.master.backlog.restart(p1.id)).rejects.toThrow(
      `提案 ${p1.id} 所在的迭代 ${filed.id} 已经结束了，不能再重新开始它`,
    );
    expect(store.listRuns()).toHaveLength(1);
    expect(eventData(t, 'proposal.restarted')).toEqual([]);
  });

  it('terminates the Run it created when the step can no longer be started over by then', async () => {
    const { t, filed } = await plannedFailing(
      config({ maxAttempts: 1 }),
      [1],
      plan([step('第一步'), step('第二步', { dependsOn: [1] })]),
    );
    const store = t.master.store;
    const first = await t.waitStatus(runOfStep(t, filed.id, 1).id, 'failed');
    await t.master.backlog.poll();
    const [p1] = stepProposals(t, filed.id);
    if (!p1) throw new Error('no steps');
    expect(p1.status).toBe('failed');
    const before = iterationOf(t, filed.id);

    // The iteration ends while the Run is being created, after the proposal was checked.
    const endIt = (e: { type: string }) => {
      if (e.type === 'run.created') store.updateIteration(filed.id, { status: 'cancelled' });
    };
    store.bus.on('event', endIt);
    try {
      await expect(t.master.backlog.restart(p1.id)).rejects.toThrow(
        `提案 ${p1.id} 所在的迭代 ${filed.id} 已经结束了，不能再重新开始它`,
      );
    } finally {
      store.bus.off('event', endIt);
    }
    // Nothing recorded on the proposal or the steps, and the Run no proposal leads to stopped.
    expect(store.getProposal(p1.id)).toMatchObject({ status: 'failed', runId: first.id });
    expect(iterationOf(t, filed.id).children).toEqual(before.children);
    expect(eventData(t, 'proposal.restarted')).toEqual([]);
    const orphan = store.listRuns().find((r) => r.id !== first.id);
    expect(orphan?.status).toBe('cancelled');
  });

  it.each([
    { seen: true, when: 'while it waits for its redo' },
    { seen: false, when: 'before its failure was seen' },
  ])('does not redo the failed step of an iteration cancelled $when', async ({ seen }) => {
    const { t, filed } = await plannedFailing(
      config(),
      [1],
      plan([step('第一步'), step('第二步', { dependsOn: [1] })]),
    );
    const store = t.master.store;
    const first = await t.waitStatus(runOfStep(t, filed.id, 1).id, 'failed');
    if (seen) {
      await t.master.backlog.poll();
      expect(stepProposals(t, filed.id)[0]?.redo).toBe('pending');
    }
    const cancelled = await t.master.backlog.cancelIteration(filed.id);
    expect(cancelled.children.map((c) => c.status)).toEqual(['dropped', 'dropped']);

    // The wait is over, but nobody wants the step any more: neither redone nor given up.
    elapseRedoWait(t);
    await t.master.backlog.poll();
    await t.master.backlog.poll();
    expect(store.listRuns()).toHaveLength(1);
    const [p1] = stepProposals(t, filed.id);
    expect(p1).toMatchObject({
      status: 'accepted',
      runId: first.id,
      attempt: 1,
      redo: seen ? 'pending' : null,
    });
    expect(eventData(t, 'proposal.redo_scheduled')).toHaveLength(seen ? 1 : 0);
    expect(eventData(t, 'proposal.redone')).toEqual([]);
    expect(eventData(t, 'proposal.failed')).toEqual([]);
    expect(eventData(t, 'iteration.blocked')).toEqual([]);
    expect(statuses(t, filed.id)).toEqual(['dropped', 'dropped']);
    // The scout reads the step as ended with its iteration, not as waiting for a redo.
    await scoutByHand(t);
    expect(lastScoutPrompt(t)).toContain(
      `- ${p1?.id} 第一步（侦察提的，Run ${first.id}：失败，自动采纳，所属迭代 ${filed.id} 已被人终止）`,
    );
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
      `- ${filed.id} iteration "Local repos run on their own" (proposed by a scout; steps: First, Second)\n  Reason: Not now`,
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
