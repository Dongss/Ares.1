import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { githubConfigKey } from '../src/config/load.js';
import type { GhIssue } from '../src/github/client.js';
import {
  COMMENT_MARKER,
  discussionComment,
  FOOTER_MARKER,
  goalFromIssue,
  isAutoAcceptable,
  isMasterComment,
  issueUpdate,
  LABELS,
  labelDefs,
  proposalBody,
  repliesAfterMaster,
  withStatusLabel,
} from '../src/github/issues.js';
import { filedProposal, proposalsHoldingScout } from '../src/github/scout.js';
import { setLang } from '../src/i18n.js';
import type { AssessmentEntry, Run, ScoutProposal } from '../src/store/types.js';
import {
  ASSESS_AGENTS_YAML,
  ASSESS_WORKFLOW_YAML,
  assessment,
  FakeGitHub,
  git,
  type Harness,
  harness,
  waitFor,
  writeFile,
} from './helpers.js';

const AGENTS = `${ASSESS_AGENTS_YAML}
  scout:
    cli: fake
    model: scout
`;

interface ConfigOptions {
  /** Automatic scouting; off unless a test is about it. */
  auto?: boolean;
  intervalHours?: number;
  maxRisk?: 'none' | 'low' | 'mid' | 'high';
  /** null = no daily limit. */
  maxPerDay?: number | null;
  autoMerge?: boolean;
  push?: boolean;
  /** null = no daily limit. */
  budget?: number | null;
  template?: string;
}

const config = (opts: ConfigOptions = {}) => {
  const maxPerDay = opts.maxPerDay === undefined ? 1 : opts.maxPerDay;
  return `
github:
  repos:
    demo:
      template: ${opts.template ?? 'dev'}
      scout:
        agent: scout
        auto: ${opts.auto ?? false}
        interval_hours: ${opts.intervalHours ?? 0}
        max_proposals: 3
      auto_accept:
        max_risk: ${opts.maxRisk ?? 'low'}
${maxPerDay === null ? '' : `        max_per_day: ${maxPerDay}`}
      auto_merge: ${opts.autoMerge ?? false}
      push: ${opts.push ?? false}
${opts.budget === null ? '' : `      daily_budget_usd: ${opts.budget ?? 20}`}
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

async function start(cfg = config(), workflow?: string): Promise<Harness> {
  gh = new FakeGitHub();
  h = await harness({ agents: AGENTS, config: cfg, github: gh, workflow });
  return h;
}

afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** Wait until the scout has ended, its temporary worktree deleted. */
async function scoutDone(t: Harness, id: string) {
  await waitFor(
    () => t.master.store.getScout(id).status !== 'running' && !t.master.issues.scoutRunning,
    'scout to finish',
  );
  return t.master.store.getScout(id);
}

const scoutDir = (t: Harness, id: string) => join(t.home, 'worktrees', 'scouts', id);

/** A new Master on the closed one's home and repo, as after a restart. */
async function restart(closed: Harness): Promise<Harness> {
  h = await harness({
    agents: AGENTS,
    config: config(),
    github: gh,
    home: closed.home,
    repoDir: closed.repoDir,
  });
  return h;
}

/** The repo's worktrees and local branches, and what is checked out and uncommitted in it. */
const repoState = (repoDir: string) => ({
  worktrees: git(repoDir, 'worktree', 'list', '--porcelain'),
  branches: git(repoDir, 'branch', '--list'),
  status: git(repoDir, 'status', '--porcelain'),
});

describe('issues: from ready issue to closed issue', () => {
  it('turns a ares1:ready issue into a Run and mirrors the Run on the issue', async () => {
    const t = await start();
    gh.add({
      title: '加 feature',
      body: `写 feature.txt\n\n${FOOTER_MARKER}\n---\n页脚`,
      labels: ['bug', LABELS.ready],
    });

    await t.master.issues.poll();
    const runs = t.master.store.listRuns();
    expect(runs).toHaveLength(1);
    const run = runs[0] as Run;
    expect(run.goal).toBe('#1 加 feature\n\n写 feature.txt');
    expect(run.issue).toEqual({
      repo: 'me/demo',
      number: 1,
      url: 'https://github.com/me/demo/issues/1',
      auto: false,
    });
    expect(gh.get(1).labels).toEqual(['bug', LABELS.running]);
    expect(gh.get(1).comments[0]).toContain(run.id);
    expect(gh.get(1).comments[0]?.startsWith('战神一号开始处理：Run')).toBe(true);
    expect(gh.labelDefs.has(LABELS.needsYou)).toBe(true);

    // Status changes reach the issue on their own.
    await t.waitStatus(run.id, 'waiting_approval');
    await waitFor(() => gh.get(1).labels.includes(LABELS.needsYou), 'needs-you label');
    expect(gh.get(1).labels).toEqual(['bug', LABELS.needsYou]);
    expect(gh.get(1).comments.at(-1)).toContain('等你审批：「合并」阶段');

    // As if the Run had been created and started 20 minutes ago, the agents worked 5 of them and
    // the approval has waited for 10. Its status changes so far move back with its creation, so
    // it was queued only for a moment.
    const store = t.master.store;
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const shift = Date.parse(run.createdAt) - Date.parse(ago(20));
    for (const e of store.listEvents(run.id)) {
      store.db
        .prepare('UPDATE events SET ts = ? WHERE id = ?')
        .run(new Date(Date.parse(e.ts) - shift).toISOString(), e.id);
    }
    store.updateRun(run.id, { createdAt: ago(20) });
    store.listRunAttempts(run.id).forEach((a, i) => {
      store.updateAttempt(
        a.id,
        i === 0 ? { startedAt: ago(19), endedAt: ago(14) } : { endedAt: a.startedAt },
      );
    });
    const [approval] = store.listApprovals(run.id);
    store.updateApproval(approval?.id ?? '', { createdAt: ago(10) });

    t.master.engine.approve(run.id);
    await t.waitStatus(run.id, 'completed');
    await waitFor(() => gh.get(1).state === 'closed', 'issue to close');
    expect(gh.get(1).labels).toEqual(['bug']);
    expect(gh.get(1).comments.at(-1)).toContain('已合并到本地 `main`');
    expect(gh.get(1).comments.at(-1)).toContain(
      '用时 20 分钟（其中 Agent 执行 5 分钟、等人 10 分钟）',
    );

    await t.master.issues.poll();
    expect(t.master.store.listRuns()).toHaveLength(1);
  });

  it('does not start a second Run while one is unfinished; a failed one can be redone', async () => {
    const t = await start();
    const coder = t.scripts.coder as NonNullable<typeof t.scripts.coder>;
    t.scripts.coder = () => new Promise(() => {});
    gh.add({ title: '一直不结束', labels: [LABELS.ready] });
    await t.master.issues.poll();
    const [first] = t.master.store.listRuns();
    if (!first) throw new Error('no run');
    await t.waitStatus(first.id, 'running');

    gh.get(1).labels.push(LABELS.ready);
    await t.master.issues.poll();
    expect(t.master.store.listRuns()).toHaveLength(1);
    expect(gh.get(1).labels).toEqual([LABELS.running]);

    await t.master.engine.cancel(first.id);
    await t.master.issues.sync();
    expect(gh.get(1).labels).toEqual([LABELS.failed]);
    expect(gh.get(1).comments.at(-1)).toContain('Run 已终止');

    t.scripts.coder = coder;
    gh.get(1).labels.push(LABELS.ready);
    await t.master.issues.poll();
    const runs = t.master.store.listRuns();
    expect(runs).toHaveLength(2);
    expect(gh.get(1).labels).toEqual([LABELS.running]);
  });

  it('keeps going when GitHub fails and reports the error once', async () => {
    const t = await start();
    gh.add({ title: 'x', labels: [LABELS.ready] });
    gh.failWith = 'GitHub 不可用';
    await t.master.issues.poll();
    await t.master.issues.poll();
    expect(t.master.issues.status().lastError?.message).toContain('GitHub 不可用');
    const count = t.master.store.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'github.error'")
      .get() as { n: number };
    expect(count.n).toBe(1);
    gh.failWith = null;
    await t.master.issues.poll();
    expect(t.master.issues.status().lastError).toBeNull();
    expect(t.master.store.listRuns()).toHaveLength(1);
  });
});

describe('issues: scout', () => {
  it('files proposals as issues and auto-accepts low-risk ones within the daily limit', async () => {
    const t = await start();
    gh.add({ title: '已有的需求' });
    const rejected = gh.add({ title: '被拒的需求', labels: [LABELS.proposal] });
    rejected.state = 'closed';
    rejected.stateReason = 'not_planned';
    rejected.comments.push('不需要，太复杂');
    t.scripts.scout = (ctx) => {
      expect(ctx.input.readOnly).toBe(true);
      return {
        structured: {
          proposals: [
            proposal('低风险的', 'low'),
            proposal('高风险的', 'high'),
            proposal('又一个低风险的', 'low', 'M'),
          ],
        },
        costUsd: 1.5,
      };
    };

    const scout = await t.master.issues.startScout('demo', 'manual');
    const done = await scoutDone(t, scout.id);
    expect(done.status).toBe('completed');
    expect(done.costUsd).toBe(1.5);
    expect(done.proposals.map((p) => p.issue?.number)).toEqual([3, 4, 5]);

    // Only the first low-risk one: high risk, and over today's limit of 1.
    expect(done.proposals.map((p) => p.issue?.auto)).toEqual([true, false, false]);
    expect(gh.get(4).labels).toEqual([LABELS.proposal]); // high risk
    expect(gh.get(5).labels).toEqual([LABELS.proposal]); // over today's limit of 1
    expect(gh.get(4).body).toContain('### 证据');
    expect(gh.get(4).body).toContain('加标签 `ares1:ready`');
    expect(gh.get(4).body).toContain('_由战神一号侦察提出（');
    expect(gh.get(3).body).toContain('_由战神一号侦察提出（');

    const prompt = t.fake.calls.at(-1)?.prompt ?? '';
    expect(prompt).toContain('#1 已有的需求');
    expect(prompt).toContain('不做：被拒的需求');
    expect(prompt).toContain('理由：不需要，太复杂');
    expect(prompt).toContain('最多 3 条');

    // The auto-accepted issue starts a Run right away.
    await waitFor(() => gh.get(3).labels.includes(LABELS.running), 'run from auto-accepted issue');
    const [run] = t.master.store.listRuns();
    expect(run?.issue).toMatchObject({ number: 3, auto: true });
    expect(gh.get(3).labels).toEqual([LABELS.proposal, LABELS.auto, LABELS.running]);
    expect(run?.goal.startsWith('#3 低风险的\n\n### 为什么')).toBe(true);
    expect(run?.goal).not.toContain('侦察提出');

    const status = t.master.issues.status().repos[0];
    expect(status?.autoAccept).toEqual({ maxRisk: 'low', maxPerDay: 1, usedToday: 1 });
    expect(status?.budget.spentToday).toBeGreaterThanOrEqual(1.5);
  });

  it('stops auto-accepting once the daily budget is spent', async () => {
    const t = await start(config({ maxPerDay: 5 }));
    t.scripts.scout = () => ({
      structured: { proposals: [proposal('低风险的', 'low')] },
      costUsd: 25,
    });
    const scout = await t.master.issues.startScout('demo', 'manual');
    await scoutDone(t, scout.id);
    expect(gh.get(1).labels).toEqual([LABELS.proposal]);
    expect(t.master.issues.status().repos[0]?.budget.reached).toBe(true);
  });

  it('scouts by itself when idle, but not while proposals wait for a human', async () => {
    const t = await start(config({ auto: true }));
    t.scripts.scout = () => ({ structured: { proposals: [] }, costUsd: 0.1 });
    for (const title of ['a', 'b', 'c']) gh.add({ title, labels: [LABELS.proposal] });
    await t.master.issues.poll();
    expect(t.master.store.listScouts()).toHaveLength(0);
    expect(t.master.issues.status().repos[0]?.scout?.waiting?.reason).toBe('有 3 条提案等你处理');

    gh.get(1).state = 'closed'; // a human rejected one
    await t.master.issues.poll();
    const [scout] = t.master.store.listScouts();
    expect(scout?.trigger).toBe('auto');
    await scoutDone(t, scout?.id ?? '');
  });

  /** Auto scouting files max_proposals (3) proposals of size L, then finds nothing more. */
  async function fileLargeProposals(maxRisk: 'none' | 'high') {
    const t = await start(config({ auto: true, maxRisk, maxPerDay: null }));
    let n = 0;
    t.scripts.scout = () => ({
      structured: {
        proposals: n++ === 0 ? ['甲', '乙', '丙'].map((title) => proposal(title, 'low', 'L')) : [],
      },
      costUsd: 0.1,
    });
    await t.master.issues.poll();
    await scoutDone(t, t.master.store.listScouts()[0]?.id ?? '');
    expect([1, 2, 3].map((i) => gh.get(i).labels)).toEqual([
      [LABELS.proposal],
      [LABELS.proposal],
      [LABELS.proposal],
    ]);
    await t.master.issues.poll();
    return t;
  }

  it('keeps scouting while only proposals beyond auto-accept wait for a human', async () => {
    const t = await fileLargeProposals('high');
    const scouts = t.master.store.listScouts();
    expect(scouts).toHaveLength(2);
    expect(scouts.every((s) => s.trigger === 'auto')).toBe(true);
    await scoutDone(t, scouts[0]?.id ?? '');
    // The proposals of size L are left for a human, and the scout goes on.
    expect(gh.get(1).labels).toEqual([LABELS.proposal]);
    expect(t.master.store.listRuns()).toHaveLength(0);
    await t.master.issues.poll();
    expect(t.master.store.listScouts()).toHaveLength(3);
    await scoutDone(t, t.master.store.listScouts()[0]?.id ?? '');
  });

  it('stops scouting on max_proposals waiting proposals when a human accepts them all', async () => {
    const t = await fileLargeProposals('none');
    expect(t.master.store.listScouts()).toHaveLength(1);
    expect(t.master.issues.status().repos[0]?.scout?.waiting?.reason).toBe('有 3 条提案等你处理');
  });

  it('scouts again right away while it keeps finding work', async () => {
    const t = await start(config({ auto: true }));
    let n = 0;
    t.scripts.scout = () => ({ structured: { proposals: [proposal(`需求 ${++n}`, 'mid')] } });
    await t.master.issues.poll();
    await scoutDone(t, t.master.store.listScouts()[0]?.id ?? '');
    await t.master.issues.poll();
    const scouts = t.master.store.listScouts();
    expect(scouts).toHaveLength(2);
    await scoutDone(t, scouts[0]?.id ?? '');
    expect(gh.issues.size).toBe(2);
  });

  it('scouts again right away after a scout that found nothing or failed', async () => {
    const t = await start(config({ auto: true }));
    let n = 0;
    t.scripts.scout = () =>
      ++n === 2
        ? { structured: { proposals: [{ title: '缺字段' }] } }
        : { structured: { proposals: [] } };
    await t.master.issues.poll();
    const first = await scoutDone(t, t.master.store.listScouts()[0]?.id ?? '');
    expect(first.status).toBe('completed');
    expect(first.proposals).toHaveLength(0);

    await t.master.issues.poll();
    const second = await scoutDone(t, t.master.store.listScouts()[0]?.id ?? '');
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('failed');

    await t.master.issues.poll();
    const scouts = t.master.store.listScouts();
    expect(scouts).toHaveLength(3);
    expect(scouts.every((s) => s.trigger === 'auto')).toBe(true);
    await scoutDone(t, scouts[0]?.id ?? '');
    expect(gh.issues.size).toBe(0);
  });

  it('waits interval_hours between automatic scouts', async () => {
    const t = await start(config({ auto: true, intervalHours: 2 }));
    let n = 0;
    t.scripts.scout = () =>
      ++n === 1
        ? { structured: { proposals: [{ title: '缺字段' }] } }
        : { structured: { proposals: [proposal('有活', 'mid')] } };
    await t.master.issues.poll();
    const failed = await scoutDone(t, t.master.store.listScouts()[0]?.id ?? '');
    expect(failed.status).toBe('failed');
    await t.master.issues.poll();
    expect(t.master.store.listScouts()).toHaveLength(1);
    let waiting = t.master.issues.status().repos[0]?.scout?.waiting;
    expect(waiting?.reason).toBe('离上次侦察不到设定的间隔');
    expect(waiting?.until).toBe(
      new Date(Date.parse(failed.startedAt) + 2 * 3_600_000).toISOString(),
    );

    // A scout started by hand also counts, and finding work does not shorten the wait.
    const manual = await t.master.issues.startScout('demo', 'manual');
    const found = await scoutDone(t, manual.id);
    expect(found.proposals).toHaveLength(1);
    await t.master.issues.poll();
    expect(t.master.store.listScouts()).toHaveLength(2);
    waiting = t.master.issues.status().repos[0]?.scout?.waiting;
    expect(waiting?.reason).toBe('离上次侦察不到设定的间隔');
    expect(waiting?.until).toBe(
      new Date(Date.parse(found.startedAt) + 2 * 3_600_000).toISOString(),
    );
  });

  it('waits for unfinished Runs of the repo before scouting', async () => {
    const t = await start(config({ auto: true }));
    t.scripts.coder = () => new Promise(() => {});
    const run = t.run();
    await t.waitStatus(run.id, 'running');
    await t.master.issues.poll();
    expect(t.master.store.listScouts()).toHaveLength(0);
    expect(t.master.issues.status().repos[0]?.scout?.waiting?.reason).toBe(
      '等 1 个未结束的 Run 做完',
    );
  });

  it('marks a scout with an unusable answer as failed', async () => {
    const t = await start();
    t.scripts.scout = () => ({ structured: { proposals: [{ title: '缺字段' }] } });
    const scout = await t.master.issues.startScout('demo', 'manual');
    const done = await scoutDone(t, scout.id);
    expect(done.status).toBe('failed');
    expect(done.error).toContain('侦察结果不符合约定');
    expect(gh.issues.size).toBe(0);
    await expect(t.master.issues.startScout('demo', 'manual')).resolves.toBeDefined();
  });

  it("reads the target branch's latest commit, not the main worktree, and leaves the repo as it was", async () => {
    const t = await start();
    const repoDir = t.repoDir;
    git(repoDir, 'checkout', '-q', '-b', 'wip');
    writeFile(join(repoDir, 'README.md'), '# 别的分支上的方向\n');
    git(repoDir, 'commit', '-q', '-am', 'wip');
    writeFile(join(repoDir, 'draft.txt'), '还没提交的半成品\n');
    const before = repoState(repoDir);
    const seen = { workdir: '', readme: '', draft: true };
    t.scripts.scout = (ctx) => {
      seen.workdir = ctx.input.workdir;
      seen.readme = readFileSync(join(ctx.input.workdir, 'README.md'), 'utf8');
      seen.draft = existsSync(join(ctx.input.workdir, 'draft.txt'));
      return { structured: { proposals: [] } };
    };

    const scout = await t.master.issues.startScout('demo', 'manual');
    const done = await scoutDone(t, scout.id);
    expect(done.status).toBe('completed');
    expect(seen.workdir).not.toBe(repoDir);
    expect(seen.workdir).toBe(scoutDir(t, scout.id));
    expect(seen.readme).toBe('# test\n'); // main's README, not wip's
    expect(seen.draft).toBe(false);

    expect(existsSync(scoutDir(t, scout.id))).toBe(false);
    expect(repoState(repoDir)).toEqual(before); // worktree gone, branches and changes untouched
    expect(git(repoDir, 'branch', '--show-current')).toBe('wip');
    expect(readFileSync(join(repoDir, 'README.md'), 'utf8')).toBe('# 别的分支上的方向\n');
  });

  it('deletes the temporary worktree when the scout fails', async () => {
    const t = await start();
    const before = repoState(t.repoDir);
    let workdir = '';
    t.scripts.scout = (ctx) => {
      workdir = ctx.input.workdir;
      return { structured: { proposals: [{ title: '缺字段' }] } };
    };
    const scout = await t.master.issues.startScout('demo', 'manual');
    const done = await scoutDone(t, scout.id);
    expect(done.status).toBe('failed');
    expect(workdir).toBe(scoutDir(t, scout.id));
    expect(existsSync(workdir)).toBe(false);
    expect(repoState(t.repoDir)).toEqual(before);
  });

  it('fails the scout when its temporary worktree cannot be created', async () => {
    const t = await start();
    git(t.repoDir, 'checkout', '-q', '-b', 'wip');
    git(t.repoDir, 'branch', '-q', '-D', 'main');
    const before = repoState(t.repoDir);
    const scout = await t.master.issues.startScout('demo', 'manual');
    const done = await scoutDone(t, scout.id);
    expect(done.status).toBe('failed');
    expect(done.error).toContain('在目标分支 main 上建侦察的临时工作目录失败');
    expect(t.fake.calls).toHaveLength(0);
    expect(existsSync(scoutDir(t, scout.id))).toBe(false);
    expect(repoState(t.repoDir)).toEqual(before);
  });

  it('deletes the temporary worktree when the Master stops during a scout', async () => {
    const first = await start();
    const before = repoState(first.repoDir);
    let workdir = '';
    first.scripts.scout = (ctx) => {
      workdir = ctx.input.workdir;
      return new Promise(() => {});
    };
    const scout = await first.master.issues.startScout('demo', 'manual');
    await waitFor(() => workdir !== '', 'scout to start');
    expect(existsSync(workdir)).toBe(true);
    expect(git(first.repoDir, 'worktree', 'list', '--porcelain')).toContain(scout.id);

    await first.close();
    expect(existsSync(workdir)).toBe(false);
    expect(repoState(first.repoDir)).toEqual(before);
    const second = await restart(first);
    expect(second.master.store.getScout(scout.id)).toMatchObject({
      status: 'interrupted',
      error: 'Master 在侦察过程中停止了',
    });
  });

  it('cleans up temporary worktrees a previous Master left behind', async () => {
    const first = await start();
    const before = repoState(first.repoDir);
    // A Master that died during a scout: the record still says running, the worktree is there.
    const scout = first.master.store.createScout({
      repoId: first.repo.id,
      issuesRepo: 'me/demo',
      trigger: 'manual',
      agentId: 'scout',
      model: 'scout',
      logPath: '',
    });
    const known = scoutDir(first, scout.id);
    const unknown = scoutDir(first, 'scout_without_record');
    for (const dir of [known, unknown]) {
      git(first.repoDir, 'worktree', 'add', '-q', '--detach', dir, 'main');
    }
    await first.close();

    const second = await restart(first);
    expect(second.master.store.getScout(scout.id).status).toBe('interrupted');
    expect(existsSync(known)).toBe(false);
    expect(existsSync(unknown)).toBe(false);
    expect(repoState(first.repoDir)).toEqual(before);
  });

  it('refuses a second scout of the same repo while one runs', async () => {
    const t = await start();
    t.scripts.scout = () => new Promise(() => {});
    await t.master.issues.startScout('demo', 'manual');
    await expect(t.master.issues.startScout('demo', 'manual')).rejects.toThrow('正在侦察');
  });

  it('accepts waiting proposals once the settings allow them', async () => {
    const t = await start(config({ maxPerDay: null }));
    t.scripts.scout = () => ({
      structured: {
        proposals: [
          proposal('中风险', 'mid'),
          proposal('高风险', 'high'),
          proposal('太大', 'low', 'L'),
        ],
      },
    });
    const scout = await t.master.issues.startScout('demo', 'manual');
    await scoutDone(t, scout.id);
    await t.master.issues.poll();
    expect(t.master.store.listRuns()).toHaveLength(0);

    writeFile(join(t.home, 'config.yaml'), config({ maxPerDay: null, maxRisk: 'high' }));
    t.master.configWatcher.reload();
    await t.master.issues.poll();
    expect(gh.get(1).labels).toEqual([LABELS.proposal, LABELS.auto, LABELS.running]);
    expect(gh.get(1).comments[0]).toContain('已自动采纳');
    expect(gh.get(2).labels).toEqual([LABELS.proposal, LABELS.auto, LABELS.running]);
    expect(gh.get(3).labels).toEqual([LABELS.proposal]); // size L always waits for a human
    expect(t.master.store.listRuns().map((r) => r.issue?.auto)).toEqual([true, true]);
    expect(t.master.store.getScout(scout.id).proposals.map((p) => p.issue?.auto)).toEqual([
      true,
      true,
      false,
    ]);
    expect(t.master.issues.status().repos[0]?.autoAccept.usedToday).toBe(2);
  });

  it('merges Runs from issues without approval when auto_merge is on', async () => {
    const t = await start(config({ autoMerge: true }));
    gh.add({ title: '加 feature', labels: [LABELS.ready] });
    await t.master.issues.poll();
    const [run] = t.master.store.listRuns();
    if (!run) throw new Error('no run');
    expect(run.overrides).toEqual({ stages: { merge: { gate: false } } });
    await t.waitStatus(run.id, 'completed');
    await t.master.issues.sync();
    expect(gh.get(1).state).toBe('closed');
  });

  it('pushes the target branch before closing the issue, and only when it moved', async () => {
    const t = await start(config({ autoMerge: true, push: true }));
    gh.add({ title: '加 feature', labels: [LABELS.ready] });
    await t.master.issues.poll();
    expect(gh.pushes).toEqual([git(t.repoDir, 'rev-parse', 'main')]); // first poll: once
    const [run] = t.master.store.listRuns();
    if (!run) throw new Error('no run');
    await t.waitStatus(run.id, 'completed');
    await t.master.issues.sync();
    const head = git(t.repoDir, 'rev-parse', 'main');
    expect(gh.pushes.at(-1)).toBe(head);
    expect(gh.get(1).state).toBe('closed');
    expect(gh.get(1).comments.at(-1)).toContain('并推送到 GitHub');
    const pushes = gh.pushes.length;
    await t.master.issues.poll();
    expect(gh.pushes).toHaveLength(pushes);
  });

  it('keeps the issue open while the push fails', async () => {
    const t = await start(config({ autoMerge: true, push: true }));
    gh.add({ title: '加 feature', labels: [LABELS.ready] });
    await t.master.issues.poll();
    const [run] = t.master.store.listRuns();
    if (!run) throw new Error('no run');
    gh.push = async () => {
      throw new Error('推送被拒绝');
    };
    await t.waitStatus(run.id, 'completed');
    await t.master.issues.sync();
    expect(gh.get(1).state).toBe('open');
    expect(t.master.issues.status().lastError?.message).toContain('推送被拒绝');
  });

  it('has no spending limit when daily_budget_usd is left out', async () => {
    const t = await start(config({ budget: null }));
    t.scripts.scout = () => ({ structured: { proposals: [proposal('x', 'low')] }, costUsd: 500 });
    const scout = await t.master.issues.startScout('demo', 'manual');
    await scoutDone(t, scout.id);
    expect(gh.get(1).labels).toContain(LABELS.auto);
    expect(t.master.issues.status().repos[0]?.budget).toEqual({
      dailyUsd: null,
      spentToday: 500,
      reached: false,
    });
  });

  it('does not scout while an upgrade of the Master waits', async () => {
    const t = await start(config({ auto: true }));
    t.master.engine.hold(true);
    await t.master.issues.poll();
    expect(t.master.store.listScouts()).toHaveLength(0);
    expect(t.master.issues.status().repos[0]?.scout?.waiting?.reason).toBe('等 Master 升级');
  });

  it('starts nothing while the work switch is off', async () => {
    const t = await start(config({ auto: true }));
    t.scripts.scout = () => ({ structured: { proposals: [] } });
    t.master.engine.setWorking(false);
    gh.add({ title: '加 feature', labels: [LABELS.ready] });
    const manual = t.run();
    await t.master.issues.poll();
    expect(t.master.store.getRun(manual.id).status).toBe('queued');
    expect(t.master.store.listRuns()).toHaveLength(1);
    expect(t.master.store.listScouts()).toHaveLength(0);
    expect(t.master.issues.status().repos[0]?.scout?.waiting?.reason).toBe('工作开关已关闭');

    const res = await t.master.app.request('/api/working', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on: true }),
    });
    expect(((await res.json()) as { working: boolean }).working).toBe(true);
    await t.waitStatus(manual.id, 'waiting_approval');
    // Turning it on looks at GitHub right away.
    await waitFor(() => t.master.store.listRuns().length === 2, 'run from the ready issue');
  });

  it('reports broken references in the github config', async () => {
    const t = await start(config({ template: 'nope' }));
    expect(t.master.config.errors[githubConfigKey('demo')]).toEqual(['模板 nope 不存在或无效']);
    expect(t.master.issues.status().repos[0]?.problems).toContain('模板 nope 不存在或无效');
    await expect(t.master.issues.startScout('demo', 'manual')).rejects.toThrow('配置有误');
  });

  it('serves status and scouts over the API', async () => {
    const t = await start();
    t.scripts.scout = () => ({ structured: { proposals: [proposal('x', 'mid')] } });
    const res = await t.master.app.request('/api/scouts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'demo' }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    await scoutDone(t, id);
    const list = (await (await t.master.app.request('/api/scouts')).json()) as { id: string }[];
    expect(list.map((s) => s.id)).toEqual([id]);
    const status = (await (await t.master.app.request('/api/github')).json()) as {
      enabled: boolean;
      repos: { name: string }[];
    };
    expect(status.enabled).toBe(true);
    expect(status.repos.map((r) => r.name)).toEqual(['demo']);
  });
});

describe('issues: requirement assessment', () => {
  const startAssessing = () => start(config(), ASSESS_WORKFLOW_YAML);
  /** The Run of issue #1, once it is created. */
  const runOf = (t: Harness) => {
    const [run] = t.master.store.listRuns();
    if (!run) throw new Error('no run');
    return run;
  };
  const assessorCalls = (t: Harness) => t.fake.calls.filter((c) => c.model === 'assessor');

  it('discusses on the issue: marked questions, replies picked up, the conclusion posted', async () => {
    const t = await startAssessing();
    gh.add({ title: '加 feature', body: '写 feature.txt', labels: [LABELS.ready] });
    t.scripts.assessor = (ctx) => {
      if (assessorCalls(t).length === 1) {
        return assessment('ask', {
          summary: '内容没说清',
          questions: ['feature.txt 写什么？'],
          suggestions: ['写 ok'],
        });
      }
      expect(ctx.input.prompt).toContain('### 人的回复（issue 上）\n\n写 ok，另加一行 B');
      expect(ctx.input.prompt).toContain('### 人的回复（issue 上）\n\n不要别的了');
      // The Master's own comments are not replies.
      expect(ctx.input.prompt).not.toContain('战神一号开始处理');
      expect(ctx.input.prompt).not.toContain(COMMENT_MARKER);
      return assessment('go', {
        summary: '按讨论修改',
        revisedGoal: '添加 feature.txt：第一行 ok，第二行 B',
      });
    };

    await t.master.issues.poll();
    const run = runOf(t);
    await t.waitStatus(run.id, 'blocked');
    await t.master.issues.sync();
    const issue = gh.get(1);
    expect(issue.labels).toEqual([LABELS.needsYou]);
    const asked = issue.comments.at(-1) ?? '';
    expect(asked).toContain('### 需求评估：有疑问，需要和你讨论');
    expect(asked).toContain('1. feature.txt 写什么？');
    expect(asked).toContain('- 写 ok');
    expect(asked).toContain('直接在这个 issue 下回复就行');
    // Every comment of the Master carries the marker; the blocked status adds no other comment.
    expect(issue.comments).toHaveLength(2);
    expect(issue.comments.every(isMasterComment)).toBe(true);

    // Only the Master's comments so far: nothing to reassess.
    await t.master.issues.poll();
    await t.master.issues.poll();
    expect(assessorCalls(t)).toHaveLength(1);
    expect(t.master.store.getRun(run.id).status).toBe('blocked');

    issue.comments.push('写 ok，另加一行 B', '不要别的了');
    await t.master.issues.poll();
    const completed = await t.waitStatus(run.id, 'completed');
    expect(assessorCalls(t)).toHaveLength(2);
    const kinds = completed.discussion.map((e) =>
      e.role === 'human' ? e.source : e.role === 'assessor' ? e.verdict : e.role,
    );
    expect(kinds).toEqual(['ask', 'issue', 'issue', 'go']);

    await t.master.issues.sync();
    expect(issue.state).toBe('closed');
    expect(issue.stateReason).toBe('completed');
    // The human's replies are not posted again; the conclusion comes before the merge comment.
    expect(issue.comments.filter((c) => c.includes('写 ok，另加一行 B'))).toHaveLength(1);
    const conclusion = issue.comments.at(-2) ?? '';
    expect(conclusion).toContain('### 需求评估结论：按讨论后修改的需求开工');
    expect(conclusion).toContain('添加 feature.txt：第一行 ok，第二行 B');
    expect(isMasterComment(conclusion)).toBe(true);
    expect(issue.comments.at(-1)).toContain('已合并到本地 `main`');
  });

  it('posts the conclusion of a first-round go: the original requirement', async () => {
    const t = await startAssessing();
    gh.add({ title: '加 feature', labels: [LABELS.ready] });
    t.scripts.assessor = () => assessment('go', { summary: '清楚，可以做' });
    await t.master.issues.poll();
    await t.waitStatus(runOf(t).id, 'completed');
    await t.master.issues.sync();
    const conclusion = gh.get(1).comments.find((c) => c.includes('需求评估结论')) ?? '';
    expect(conclusion).toContain('### 需求评估结论：按原需求开工');
    expect(conclusion).toContain('清楚，可以做');
  });

  it('closes the issue as not planned when the discussion ends in drop', async () => {
    const t = await startAssessing();
    gh.add({ title: '重复的需求', labels: ['bug', LABELS.ready] });
    t.scripts.assessor = () =>
      assessorCalls(t).length === 1
        ? assessment('drop', { summary: '和已有的 X 重复' })
        : assessment('drop', { summary: '和 X 重复，你已同意不做' });

    await t.master.issues.poll();
    const run = runOf(t);
    await t.waitStatus(run.id, 'blocked');
    await t.master.issues.sync();
    const issue = gh.get(1);
    // A first-round drop is only a proposal.
    expect(issue.state).toBe('open');
    expect(issue.comments.at(-1)).toContain('### 需求评估：认为不该做，请你确认');

    issue.comments.push('同意，不做了');
    await t.master.issues.poll();
    await t.waitStatus(run.id, 'dropped');
    await t.master.issues.sync();
    expect(issue.state).toBe('closed');
    expect(issue.stateReason).toBe('not_planned');
    expect(issue.labels).toEqual(['bug']);
    const conclusion = issue.comments.at(-1) ?? '';
    expect(conclusion).toContain('### 需求评估结论：不做');
    expect(conclusion).toContain('理由：和 X 重复，你已同意不做');
    expect(issue.comments.some((c) => c.includes('Run 失败了'))).toBe(false);
    // Closed and finished: a later poll starts nothing.
    await t.master.issues.poll();
    expect(t.master.store.listRuns()).toHaveLength(1);
  });

  it('mirrors a reply written on the dashboard to the issue', async () => {
    const t = await startAssessing();
    gh.add({ title: '加 feature', labels: [LABELS.ready] });
    t.scripts.assessor = () =>
      assessorCalls(t).length === 1
        ? assessment('ask', { questions: ['写什么？'] })
        : assessment('go');
    await t.master.issues.poll();
    const run = runOf(t);
    await t.waitStatus(run.id, 'blocked');
    await t.master.issues.sync();
    await t.master.engine.retry(run.id, { note: '写 ok' });
    await t.waitStatus(run.id, 'completed');
    await t.master.issues.sync();
    const comments = gh.get(1).comments;
    const reply = comments.find((c) => c.includes('在看板上回复了需求评估')) ?? '';
    expect(reply).toContain('> 写 ok');
    expect(isMasterComment(reply)).toBe(true);
    // Its own mirrored reply is not taken for a human's.
    expect(t.master.store.getRun(run.id).discussion.filter((e) => e.role === 'human')).toHaveLength(
      1,
    );
  });

  it('assesses issues proposed by the scout too', async () => {
    const t = await start(config(), ASSESS_WORKFLOW_YAML);
    t.scripts.scout = () => ({ structured: { proposals: [proposal('低风险的', 'low')] } });
    t.scripts.assessor = () => assessment('go');
    const scout = await t.master.issues.startScout('demo', 'manual');
    await scoutDone(t, scout.id);
    await waitFor(() => t.master.store.listRuns().length === 1, 'run from the proposal');
    await t.waitStatus(runOf(t).id, 'completed');
    expect(assessorCalls(t)[0]?.prompt).toContain('#1 低风险的');
  });
});

describe('issues: closed by a human', () => {
  /** The Run of issue #n, once it is created. */
  const runOf = (t: Harness, n = 1) => {
    const run = t.master.store.listRuns().find((r) => r.issue?.number === n);
    if (!run) throw new Error(`no run for #${n}`);
    return run;
  };
  const statusOf = (t: Harness, run: Run) => t.master.store.getRun(run.id).status;

  /** Close issue #n as a human does, with a last comment; returns the issue as they left it. */
  const closeByHuman = (n: number, reason: 'completed' | 'not_planned', comment: string) => {
    const issue = gh.get(n);
    issue.state = 'closed';
    issue.stateReason = reason;
    issue.comments.push(comment);
    return { issue: structuredClone(issue), callsAt: gh.calls.length };
  };

  /** The Master wrote nothing on the issue after the human closed it. */
  const expectLeftAlone = (n: number, closed: { issue: GhIssue; callsAt: number }) => {
    expect(gh.get(n)).toEqual(closed.issue);
    const write = new RegExp(`^(comment|setLabels|close) #${n}( |$)`);
    expect(gh.calls.slice(closed.callsAt).filter((c) => write.test(c))).toEqual([]);
  };

  it('terminates a queued Run when its issue is closed as not planned; no agent runs', async () => {
    const t = await start();
    t.master.engine.hold(true); // keeps the Run queued
    gh.add({ title: '加 feature', labels: [LABELS.ready] });
    await t.master.issues.poll();
    const run = runOf(t);
    expect(statusOf(t, run)).toBe('queued');

    const closed = closeByHuman(1, 'not_planned', '不做了，方向不对');
    await t.master.issues.poll();
    expect(statusOf(t, run)).toBe('cancelled');
    const events = t.master.store.listEvents(run.id).filter((e) => e.type === 'run.issue_closed');
    expect(events.map((e) => e.data)).toEqual([
      { repo: 'me/demo', issue: 1, stateReason: 'not_planned' },
    ]);

    t.master.engine.hold(false);
    await t.master.issues.sync();
    await t.master.issues.poll();
    expect(t.fake.calls).toHaveLength(0);
    expectLeftAlone(1, closed);
    expect(gh.get(1).comments.at(-1)).toBe('不做了，方向不对');
    expect(t.master.store.listRuns()).toHaveLength(1);
  });

  it('stops the agent of a running Run; the target branch does not move', async () => {
    const t = await start();
    const signals: AbortSignal[] = [];
    t.scripts.coder = (ctx) => {
      signals.push(ctx.signal);
      return new Promise(() => {});
    };
    gh.add({ title: '加 feature', labels: [LABELS.ready] });
    await t.master.issues.poll();
    const run = runOf(t);
    await waitFor(() => signals.length === 1, 'the coder to start');
    await t.master.issues.sync();
    const head = git(t.repoDir, 'rev-parse', 'main');

    const closed = closeByHuman(1, 'completed', '已经手动做完了');
    await t.master.issues.poll();
    expect(statusOf(t, run)).toBe('cancelled');
    expect(signals[0]?.aborted).toBe(true);
    expect(git(t.repoDir, 'rev-parse', 'main')).toBe(head);
    expect(t.fake.calls.map((c) => c.model)).toEqual(['coder']);

    await t.master.issues.sync();
    expectLeftAlone(1, closed);
  });

  it('terminates a Run waiting in the discussion; the automatic scout stops waiting for it', async () => {
    const t = await start(config({ auto: true }), ASSESS_WORKFLOW_YAML);
    t.scripts.assessor = () => assessment('ask', { questions: ['写什么？'] });
    t.scripts.scout = () => ({ structured: { proposals: [] } });
    gh.add({ title: '加 feature', labels: [LABELS.ready] });
    await t.master.issues.poll();
    const run = runOf(t);
    await t.waitStatus(run.id, 'blocked');
    await t.master.issues.poll();
    expect(gh.get(1).comments.at(-1)).toContain('### 需求评估：有疑问，需要和你讨论');
    expect(t.master.store.listScouts()).toHaveLength(0);
    expect(t.master.issues.status().repos[0]?.scout?.waiting?.reason).toBe(
      '等 1 个未结束的 Run 做完',
    );

    const closed = closeByHuman(1, 'not_planned', '不做了，用不上');
    await t.master.issues.poll();
    expect(statusOf(t, run)).toBe('cancelled');
    // The closing comment is not taken for a reply to the questions.
    expect(t.fake.calls.filter((c) => c.model === 'assessor')).toHaveLength(1);
    const [scout] = t.master.store.listScouts();
    expect(scout?.trigger).toBe('auto');
    await scoutDone(t, scout?.id ?? '');
    // The human's comment is still the reason the scout reads.
    expect(t.fake.calls.at(-1)?.prompt).toContain('不做：加 feature\n  理由：不做了，用不上');

    await t.master.issues.sync();
    expectLeftAlone(1, closed);
  });

  it('terminates with the work switch off too, and leaves Runs of open issues alone', async () => {
    const t = await start();
    gh.add({ title: '加 feature', labels: [LABELS.ready] });
    gh.add({ title: '另一个', labels: [LABELS.ready] });
    await t.master.issues.poll();
    const first = runOf(t, 1);
    const second = runOf(t, 2);
    await t.waitStatus(first.id, 'waiting_approval');
    await t.waitStatus(second.id, 'waiting_approval');
    t.master.engine.setWorking(false);
    await t.master.issues.sync();

    const closed = closeByHuman(1, 'not_planned', '不要了');
    await t.master.issues.poll();
    expect(statusOf(t, first)).toBe('cancelled');
    expect(statusOf(t, second)).toBe('waiting_approval');
    await t.master.issues.sync();
    expectLeftAlone(1, closed);
    expect(gh.get(2).state).toBe('open');
    expect(gh.get(2).labels).toEqual([LABELS.needsYou]);
  });

  it('leaves the Run as it is when the issue cannot be read', async () => {
    const t = await start();
    t.master.engine.hold(true);
    gh.add({ title: '加 feature', labels: [LABELS.ready] });
    await t.master.issues.poll();
    const run = runOf(t);
    closeByHuman(1, 'not_planned', '不做了');

    const getIssue = gh.getIssue.bind(gh);
    gh.getIssue = async () => {
      throw new Error('读不到 issue');
    };
    await t.master.issues.poll();
    expect(statusOf(t, run)).toBe('queued');
    expect(t.master.issues.status().lastError?.message).toContain('读不到 issue');

    gh.getIssue = getIssue;
    await t.master.issues.poll();
    expect(statusOf(t, run)).toBe('cancelled');
    expect(t.master.issues.status().lastError).toBeNull();
  });

  it('lets a Run that finished meanwhile be', async () => {
    const t = await start();
    t.master.engine.hold(true);
    gh.add({ title: '加 feature', labels: [LABELS.ready] });
    await t.master.issues.poll();
    const run = runOf(t);
    closeByHuman(1, 'not_planned', '不做了');

    const getIssue = gh.getIssue.bind(gh);
    gh.getIssue = async (repo, n) => {
      await t.master.engine.cancel(run.id); // finished while the issue was being read
      return getIssue(repo, n);
    };
    await t.master.issues.poll();
    expect(statusOf(t, run)).toBe('cancelled');
    expect(t.master.issues.status().lastError).toBeNull();
    expect(t.master.store.listEvents(run.id).some((e) => e.type === 'run.issue_closed')).toBe(
      false,
    );
  });
});

describe('issues: texts', () => {
  const run = (patch: Partial<Run>): Run =>
    ({
      id: 'run_1',
      status: 'running',
      blocked: null,
      error: null,
      costUsd: 1.234,
      headCommit: 'abcdef1234567',
      createdAt: '2026-11-19T00:00:00.000Z',
      finishedAt: null,
      ...patch,
    }) as Run;
  const ctx = { dashboardUrl: 'http://127.0.0.1:4870', targetBranch: 'main' };

  it('tells a human reply from the Master by the marker', () => {
    const master = (text: string) => `${text}\n\n${COMMENT_MARKER}`;
    expect(repliesAfterMaster(['早先的讨论'])).toEqual([]);
    expect(
      repliesAfterMaster([
        '早先的讨论',
        master('疑问 1'),
        '回复 1',
        master('疑问 2'),
        '回复 2',
        '  ',
      ]),
    ).toEqual(['回复 2']);
    expect(repliesAfterMaster([master('疑问'), master('看板上的回复')])).toEqual([]);
  });

  it('words the assessment on the issue', () => {
    const entry = (patch: Partial<AssessmentEntry>): AssessmentEntry => ({
      role: 'assessor',
      verdict: 'go',
      summary: '理由',
      questions: [],
      suggestions: [],
      revisedGoal: null,
      proposedDrop: false,
      stageRunId: 'sr',
      at: '2026-11-19T00:00:00.000Z',
      ...patch,
    });
    const dc = {
      dashboardUrl: 'http://127.0.0.1:4870',
      runId: 'run_1',
      pollMinutes: 5,
      replyTimeoutHours: 24,
    };
    const asked = discussionComment(entry({ verdict: 'ask', questions: ['Q'] }), dc);
    expect(asked).toContain('每 5 分钟');
    // How long the questions wait, and what happens then.
    expect(asked).toContain('24 小时内没有人回复的话，评估会自己决定');
    const forever = { ...dc, replyTimeoutHours: null };
    expect(discussionComment(entry({ verdict: 'ask', questions: ['Q'] }), forever)).not.toContain(
      '没有人回复',
    );
    const noWait = discussionComment(entry({ verdict: 'ask', questions: ['Q'] }), {
      ...dc,
      replyTimeoutHours: 0,
    });
    expect(noWait).toContain('不等回复，评估接着自己决定');
    expect(noWait).not.toContain('直接在这个 issue 下回复就行');
    expect(discussionComment(entry({ revisedGoal: '新需求' }), dc)).toContain(
      '需求评估结论：按讨论后修改的需求开工',
    );
    expect(discussionComment(entry({ verdict: 'drop' }), dc)).toContain('需求评估结论：不做');
    // Nobody replied in time: said on the issue, and the conclusion says the assessment decided.
    const timeout = { role: 'timeout', hours: 24, at: '' } as const;
    expect(discussionComment(timeout, dc)).toContain(
      '### 需求评估：24 小时内没有人回复，由评估自己决定',
    );
    expect(discussionComment({ ...timeout, hours: 0 }, dc)).toContain(
      '### 需求评估：不等回复，由评估自己决定',
    );
    expect(discussionComment(entry({ decidedAlone: true }), dc)).toContain(
      '### 需求评估结论：没人回复，按评估的假设开工',
    );
    const droppedAlone = discussionComment(entry({ verdict: 'drop', decidedAlone: true }), dc);
    expect(droppedAlone).toContain('### 需求评估结论：没人回复，评估决定不做');
    expect(droppedAlone).toContain('理由：理由');
    const reply = { role: 'human', text: 'x', at: '' } as const;
    expect(discussionComment({ ...reply, source: 'issue' }, dc)).toBeNull();
    expect(discussionComment({ ...reply, source: 'dashboard' }, dc)).toContain('> x');
    // The questions wait on the issue; the dropped Run closes it as not planned.
    expect(
      issueUpdate(run({ status: 'blocked', blocked: { kind: 'discussion', message: 'Q' } }), ctx),
    ).toEqual({ label: LABELS.needsYou, comment: null, close: null });
    expect(issueUpdate(run({ status: 'dropped' }), ctx)).toEqual({
      label: null,
      comment: null,
      close: 'not_planned',
    });
  });

  it('keeps one status label and every other label', () => {
    expect(withStatusLabel(['bug', LABELS.proposal, LABELS.ready], LABELS.running)).toEqual([
      'bug',
      LABELS.proposal,
      LABELS.running,
    ]);
    expect(withStatusLabel([LABELS.needsYou, LABELS.auto], null)).toEqual([LABELS.auto]);
  });

  it('builds the goal without the footer', () => {
    expect(goalFromIssue({ number: 7, title: 'T', body: '' })).toBe('#7 T');
    expect(goalFromIssue({ number: 7, title: 'T', body: `正文\n${FOOTER_MARKER}\n脚注` })).toBe(
      '#7 T\n\n正文',
    );
  });

  it('auto-accepts up to the configured risk, and only what fits one Run', () => {
    expect(isAutoAcceptable({ risk: 'low', size: 'M' }, 'low')).toBe(true);
    expect(isAutoAcceptable({ risk: 'mid', size: 'S' }, 'low')).toBe(false);
    expect(isAutoAcceptable({ risk: 'high', size: 'S' }, 'high')).toBe(true);
    expect(isAutoAcceptable({ risk: 'low', size: 'L' }, 'high')).toBe(false);
    expect(isAutoAcceptable({ risk: 'low', size: 'S' }, 'none')).toBe(false);
  });

  it('counts toward max_proposals only the proposals auto-accept would take, or all without it', () => {
    const issue = (number: number, labels: string[] = [LABELS.proposal]): GhIssue => ({
      number,
      title: `#${number}`,
      body: '',
      state: 'open',
      stateReason: null,
      labels,
      url: '',
      comments: [],
    });
    const filed = (
      number: number,
      risk: 'low' | 'mid' | 'high',
      size: 'S' | 'M' | 'L',
    ): ScoutProposal => ({
      ...proposal(`#${number}`, risk, size),
      category: 'improvement',
      issue: { number, url: '', auto: false },
    });
    const scouts = [
      { proposals: [filed(1, 'low', 'S'), filed(2, 'low', 'L')] },
      { proposals: [filed(3, 'mid', 'M'), filed(4, 'high', 'S'), filed(5, 'low', 'M')] },
    ];
    const open = [
      issue(1), // low S: auto-accept takes it once the daily limit allows
      issue(2), // size L: left for a human
      issue(3), // mid: beyond max_risk low
      issue(4), // high
      issue(5, [LABELS.proposal, LABELS.ready]), // accepted already
      issue(6), // no scout record: counts, to stay safe
      issue(7, ['bug']), // not a proposal
    ];
    const numbers = (maxRisk: 'none' | 'low' | 'mid' | 'high') =>
      proposalsHoldingScout(open, scouts, maxRisk).map((i) => i.number);
    expect(numbers('none')).toEqual([1, 2, 3, 4, 6]);
    expect(numbers('low')).toEqual([1, 6]);
    expect(numbers('mid')).toEqual([1, 3, 6]);
    expect(numbers('high')).toEqual([1, 3, 4, 6]);
    expect(filedProposal(scouts, 4)?.proposal).toBe(scouts[1]?.proposals[1]);
    expect(filedProposal(scouts, 6)).toBeNull();
  });

  it('says on the issue what happened to the Run', () => {
    expect(issueUpdate(run({ status: 'running' }), ctx)).toEqual({
      label: LABELS.running,
      comment: null,
      close: null,
    });
    const blocked = issueUpdate(
      run({ status: 'blocked', blocked: { kind: 'task_failed', message: '测试没过' } }),
      ctx,
    );
    expect(blocked.label).toBe(LABELS.needsYou);
    expect(blocked.comment).toContain('> 测试没过');
    const completed = run({ status: 'completed', finishedAt: '2026-11-19T00:12:00.000Z' });
    const min = 60_000;
    const none = { agentMs: 0, queuedMs: 0, approvalMs: 0, blockedMs: 0, pausedMs: 0 };
    const done = issueUpdate(completed, {
      ...ctx,
      times: {
        ...none,
        totalMs: 15 * min,
        agentMs: 4 * min,
        approvalMs: 6 * min,
        blockedMs: min,
        pausedMs: 3 * min,
      },
    });
    expect(done).toMatchObject({ label: null, close: 'completed' });
    expect(done.comment).toContain('`abcdef1`');
    // Waiting for the approval, for the block and for a resume count as waiting for a human.
    expect(done.comment).toContain(
      '费用 $1.23 · 用时 15 分钟（其中 Agent 执行 4 分钟、等人 10 分钟）',
    );
    // A Run that never waited for a human: no waiting part.
    const fast = issueUpdate(completed, {
      ...ctx,
      times: { ...none, totalMs: 12 * min, agentMs: 10 * min },
    });
    expect(fast.comment).toContain('费用 $1.23 · 用时 12 分钟（其中 Agent 执行 10 分钟）\n');
    expect(fast.comment).not.toContain('等人');
    expect(fast.comment).not.toContain('排队');
    // A Run that spent most of its time queued behind other Runs: the queue is told apart.
    const queued = issueUpdate(completed, {
      ...ctx,
      times: { ...none, totalMs: 951 * min, agentMs: 15 * min, queuedMs: 930 * min },
    });
    expect(queued.comment).toContain(
      '费用 $1.23 · 用时 951 分钟（其中 Agent 执行 15 分钟、排队 930 分钟）\n',
    );
    const both = issueUpdate(completed, {
      ...ctx,
      times: {
        ...none,
        totalMs: 60 * min,
        agentMs: 10 * min,
        queuedMs: 20 * min,
        pausedMs: 30 * min,
      },
    });
    expect(both.comment).toContain(
      '用时 60 分钟（其中 Agent 执行 10 分钟、排队 20 分钟、等人 30 分钟）',
    );
    expect(issueUpdate(run({ status: 'failed', error: '炸了' }), ctx).label).toBe(LABELS.failed);
  });

  describe('in English', () => {
    afterEach(() => setLang('zh'));
    const cjk = /[\u4e00-\u9fff]/;

    it('says on the issue what happened to the Run', () => {
      setLang('en');
      const completed = run({ status: 'completed', finishedAt: '2026-11-19T00:12:00.000Z' });
      const none = { agentMs: 0, queuedMs: 0, approvalMs: 0, blockedMs: 0, pausedMs: 0 };
      const done = issueUpdate(completed, { ...ctx, times: { ...none, totalMs: 12 * 60_000 } });
      expect(done.comment).toBe(
        'Merged into the local `main` (`abcdef1`); the code shows on GitHub once it is pushed.' +
          '\n\ncost $1.23 · took 12 min\n\nDashboard: http://127.0.0.1:4870/#/runs/run_1',
      );
      const failed = issueUpdate(run({ status: 'failed', error: 'boom' }), ctx);
      expect(failed.comment).toBe(
        'The Run failed:\n\n> boom\n\nTo redo it, add the `ares1:ready` label again.' +
          '\n\nDashboard: http://127.0.0.1:4870/#/runs/run_1',
      );
    });

    it('writes proposals and label descriptions in English; labels stay the same', () => {
      setLang('en');
      const body = proposalBody(
        {
          title: 'Add a thing',
          category: 'feature',
          size: 'S',
          risk: 'mid',
          why: 'Because.',
          evidence: ['src/a.ts:1'],
          what: 'Do it.',
          acceptance: ['It works'],
        },
        'scout_1',
        false,
      );
      expect(body).not.toMatch(cjk);
      expect(body).toContain('### Acceptance criteria\n\n- [ ] It works');
      expect(body).toContain('Category: feature · Size: S · Risk: medium');
      expect(body).toContain('To accept, add the label `ares1:ready`');
      const defs = labelDefs();
      expect(defs.map((d) => d.name)).toEqual(Object.values(LABELS));
      for (const d of defs) expect(d.description).not.toMatch(cjk);
    });
  });
});
