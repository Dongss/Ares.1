import { afterEach, describe, expect, it } from 'vitest';
import type { GitHubRepoStatus, GitHubStatus, NotifyTestResult } from '../../../src/api/types.js';
import { TemplateSchema } from '../../../src/config/schema.js';
import { setLang } from '../../../src/i18n.js';
import {
  BLOCK_KIND,
  NOTICE_KINDS,
  type NoticeKind,
  noticeFor,
} from '../../../src/notify/notice.js';
import type { EventRow } from '../../../src/store/types.js';
import {
  ACTOR,
  acceptStep,
  autonomy,
  autonomyLevel,
  blockReasons,
  cycleSteps,
  dataPaths,
  GUIDE_SECTIONS,
  type GuideInput,
  guardrails,
  guideRepos,
  idleReasons,
  isGuideSection,
  issueFlow,
  iterationGuide,
  labelHelp,
  mergeNeedsApproval,
  noticeRows,
  notifyChannel,
  notifyTestLines,
  notifyTestUnavailable,
  runStages,
  scoutGuide,
  shellQuote,
  startCommand,
  stopCommand,
} from './guide.js';
import { GITHUB, type IssueHost } from './issues.js';

const template = TemplateSchema.parse({
  id: 'self-dev',
  name: '自举开发',
  stages: [
    {
      id: 'implement',
      name: '编码',
      agent: 'claude-coder',
      verify: { commands: ['npm run build', 'npm test', 'npm run lint'] },
    },
    { id: 'review', name: '评审', kind: 'review', agent: 'claude-reviewer' },
    { id: 'e2e', name: 'E2E', kind: 'placeholder' },
    { id: 'merge', name: '合并', kind: 'merge', gate: true },
  ],
});

const config = {
  templates: [template],
  repoTemplates: [],
  agents: [
    { id: 'claude-coder', model: 'opus', effort: 'xhigh' as const, args: [] },
    { id: 'claude-reviewer', model: 'opus', args: [] },
  ],
} as unknown as Parameters<typeof issueFlow>[0];

const scout: NonNullable<GitHubRepoStatus['scout']> = {
  agent: 'claude-reviewer',
  auto: true,
  intervalMinutes: 0,
  maxProposals: 5,
  running: false,
  lastAt: null,
  waiting: null,
};

/** Everything left to a human: no scout, every proposal accepted by hand, merge approved. */
const manualRepo: GitHubRepoStatus = {
  name: 'ares1',
  issuesRepo: 'me/ares1',
  template: 'self-dev',
  problems: [],
  scout: null,
  autoAccept: { maxRisk: 'none', maxSize: 'L', maxPerDay: null, usedToday: 0 },
  autoMerge: false,
  budget: { dailyUsd: null, spentToday: 0, reached: false },
  push: false,
  deliver: 'push',
  maxRunAttempts: 3,
};

/** Everything handed over: idle scouts, any risk and size accepted, merged, pushed, upgraded. */
const autoRepo: GitHubRepoStatus = {
  ...manualRepo,
  scout,
  autoAccept: { maxRisk: 'high', maxSize: 'L', maxPerDay: null, usedToday: 2 },
  autoMerge: true,
  budget: { dailyUsd: 20, spentToday: 3.2, reached: false },
  push: true,
};

/** Some of it: low risk up to size M accepted, merge still approved, pushed, no upgrades. */
const partialRepo: GitHubRepoStatus = {
  ...manualRepo,
  scout: { ...scout, intervalMinutes: 360 },
  autoAccept: { maxRisk: 'low', maxSize: 'M', maxPerDay: 3, usedToday: 1 },
  push: true,
};

const off: GuideInput['upgrade'] = { auto: false, installDir: null };
const on: GuideInput['upgrade'] = { auto: true, installDir: '/Users/me/ares1-stable' };

function input(github: GitHubRepoStatus | null, upgrade = off): GuideInput {
  return {
    github,
    host: GITHUB,
    pollMinutes: 5,
    perRepo: 1,
    maxRuns: null,
    flow: github ? issueFlow(config, github, ['npm test']) : null,
    targetBranch: 'main',
    upgrade,
  };
}

const byId = (i: GuideInput) => Object.fromEntries(cycleSteps(i).map((s) => [s.id, s]));

describe('the cycle', () => {
  it('lists the loop in order', () => {
    expect(cycleSteps(input(manualRepo)).map((s) => s.name)).toEqual([
      '侦察',
      '提 issue',
      '采纳',
      'Run',
      '推送到 GitHub',
      'Master 升级自己',
      '空闲时再侦察',
    ]);
  });

  it('leaves every step to you when nothing is handed over', () => {
    const steps = byId(input(manualRepo));
    for (const id of ['scout', 'propose', 'accept', 'push', 'upgrade', 'rescout']) {
      expect(steps[id]?.actors).toEqual(['human']);
    }
    expect(steps.accept?.text).toBe(
      '所有提案都由你来做：给要做的 issue 加 ares1:ready；不做的关闭为 not planned 并写一句理由',
    );
    expect(steps.push?.text).toBe(
      '由你来做：合并只到本地的目标分支（main），issue 照样关闭并注明，需要时自己 git push',
    );
    expect(steps.upgrade?.text).toContain('自动升级没开');
    // The Run is done by AI and the Master, with your approval before merging.
    expect(steps.run?.actors).toEqual(['ai', 'master', 'human']);
    expect(steps.run?.text).toContain('Master 每 5 分钟查一次带 ares1:ready 的 issue');
    expect(steps.run?.text).toContain('「自举开发」');
    expect(steps.run?.text).toContain(
      '每个仓库同一时间只执行一个 Run（concurrency.per_repo: 1），不同仓库的 Run 可以同时执行',
    );
    // More Runs of a repo at a time with concurrency.per_repo; they still merge one by one.
    expect(byId({ ...input(manualRepo), perRepo: 2 }).run?.text).toContain(
      '每个仓库同一时间最多执行 2 个 Run（concurrency.per_repo），各在自己的工作目录里做，合并时一个一个来',
    );
    // A limit across repos with concurrency.max_runs.
    expect(byId({ ...input(manualRepo), perRepo: 2, maxRuns: 3 }).run?.text).toContain(
      '合并时一个一个来；不同仓库的 Run 也可以同时执行，所有仓库合计最多 3 个（concurrency.max_runs）',
    );
    expect(byId({ ...input(manualRepo), maxRuns: 1 }).run?.text).toContain(
      '每个仓库同一时间只执行一个 Run（concurrency.per_repo: 1）；所有仓库合计同一时间只执行一个 Run（concurrency.max_runs: 1）',
    );
  });

  it('hands every step to the AI or the Master when everything is automatic', () => {
    const steps = byId(input(autoRepo, on));
    expect(steps.scout?.actors).toEqual(['ai']);
    expect(steps.scout?.text).toBe(
      'claude-reviewer 只读地看代码、文档和最近的 Run 记录，找值得做的事',
    );
    expect(steps.propose?.text).toContain('一次最多 5 条');
    // The scout's main output is an iteration, with at most MAX_ITERATION_CHILDREN steps.
    expect(steps.propose?.text).toContain(
      '没有进行中的迭代时，把最重要的能力缺口规划成一个迭代：一个带 ares1:iteration 的 issue（目标、完成标准、计划、不做）和最多 8 个按依赖排好的子 issue',
    );
    // max_risk high with the default max_size L: no proposal waits for a human.
    expect(steps.accept?.actors).toEqual(['master']);
    expect(steps.accept?.text).toBe(
      '所有提案自动采纳（加 ares1:ready 和 ares1:auto）；当天自动花费到 $20.00 后暂停，第二天自动继续采纳积压的提案',
    );
    expect(steps.run?.actors).toEqual(['ai', 'master']);
    expect(steps.push?.actors).toEqual(['master']);
    expect(steps.push?.text).toContain('推送到 GitHub');
    expect(steps.upgrade?.actors).toEqual(['master']);
    expect(steps.rescout?.actors).toEqual(['ai']);
    expect(steps.rescout?.text).toBe(
      '仓库没有在进行中的 Run 时（只等人的 Run 不挡），下次检查（每 5 分钟）就再侦察，参考新的 Run 记录和被拒的 issue',
    );
  });

  it('mixes the two when partly automatic', () => {
    const steps = byId(input(partialRepo));
    expect(steps.accept?.text).toBe(
      '风险低的 S、M 级提案自动采纳（加 ares1:ready 和 ares1:auto）；当天自动采纳满 3 条后暂停，第二天自动继续采纳积压的提案；L 级提案和风险中、高的提案由你来做：加 ares1:ready 或关闭',
    );
    expect(steps.run?.actors).toContain('human');
    expect(steps.push?.actors).toEqual(['master']);
    expect(steps.upgrade?.actors).toEqual(['human']);
    expect(steps.rescout?.text).toContain('两次至少隔 6 小时，');
    const short = byId(input({ ...partialRepo, scout: { ...scout, intervalMinutes: 15 } }));
    expect(short.rescout?.text).toContain('两次至少隔 15 分钟，');
  });

  it('says when scouting is manual, or the Master cannot upgrade itself', () => {
    const manualScout = { ...partialRepo, scout: { ...scout, auto: false } };
    const steps = byId(input(manualScout, { auto: true, installDir: null }));
    expect(steps.scout?.actors).toEqual(['ai']);
    expect(steps.scout?.text).toContain('只在你点「让 AI 找活」时进行');
    expect(steps.rescout?.actors).toEqual(['human']);
    expect(steps.rescout?.text).toContain('scout.auto: false');
    expect(steps.upgrade?.actors).toEqual(['human']);
    expect(steps.upgrade?.text).toContain('不是从稳定副本的构建（dist/cli.js）启动的');
  });

  it('works without GitHub or GitLab', () => {
    const steps = byId(input(null));
    expect(steps.scout?.text).toContain('还没有接入 GitHub 或 GitLab');
    expect(steps.propose?.text).toContain('提不了 issue');
    expect(steps.propose?.text).toContain('配置 github 或 gitlab');
    // Repos with neither have the local backlog, so none says requirements need GitHub.
    expect(steps.propose?.text).toContain('本地提案池');
    expect(steps.propose?.text).not.toContain('需求只从 GitHub issue 来');
    expect(steps.accept?.text).toBe(
      '由你来做：接入 GitHub 或 GitLab 后，给要做的 issue 加 ares1:ready',
    );
    expect(steps.run?.text).toContain('还没有接入 GitHub 或 GitLab，从 issue 建不了 Run');
    expect(steps.run?.text).toContain('本地提案池');
    expect(steps.push?.text).toBe('由你来做：合并只到本地的目标分支（main），需要时自己 git push');
    expect(runStages(input(null))).toBeNull();
  });

  it('names GitLab for a repo on GitLab', () => {
    const gitlab: IssueHost = { platform: 'gitlab', host: 'gitlab.example.com' };
    const onGitLab = (repo: GitHubRepoStatus): GuideInput => ({ ...input(repo), host: gitlab });
    const steps = byId(onGitLab(partialRepo));
    expect(steps.push?.name).toBe('推送到 GitLab');
    expect(steps.push?.text).toContain('合并后 Master 把目标分支（main）推送到 GitLab');
    const manual = byId(onGitLab({ ...manualRepo, scout: null }));
    expect(manual.propose?.text).toBe('你在 GitLab 上写 issue');
    // GitLab closes issues without a reason: the label marks the ones not planned.
    expect(manual.accept?.text).toBe(
      '所有提案都由你来做：给要做的 issue 加 ares1:ready；不做的加上 ares1:not-planned 标签后关闭，并写一句理由',
    );
    expect(autonomy(onGitLab(partialRepo)).auto).toContain('推送到 GitLab');
    expect(autonomy(onGitLab(manualRepo)).you).toContain('推送到 GitLab');
    for (const step of cycleSteps(onGitLab(autoRepo))) expect(step.text).not.toContain('GitHub');
  });

  it('chooses among the repos of both code hosts, GitHub first', () => {
    const status = (
      platform: 'github' | 'gitlab',
      repos: GitHubRepoStatus[],
      enabled = true,
    ): GitHubStatus => ({
      platform,
      host: platform === 'gitlab' ? 'gitlab.example.com' : null,
      enabled,
      account: null,
      pollMinutes: platform === 'gitlab' ? 2 : 5,
      lastPollAt: null,
      lastError: null,
      repos,
    });
    const web = { ...manualRepo, name: 'web' };
    const api = { ...partialRepo, name: 'api', issuesRepo: 'grp/sub/api' };
    const choices = guideRepos([status('github', [web]), status('gitlab', [api])]);
    expect(choices.map((c) => [c.key, c.status.name, c.host, c.pollMinutes])).toEqual([
      ['github:web', 'web', GITHUB, 5],
      ['gitlab:api', 'api', { platform: 'gitlab', host: 'gitlab.example.com' }, 2],
    ]);
    // A code host config.yaml has no section for offers nothing.
    expect(guideRepos([status('github', [web], false), status('gitlab', [api])])).toHaveLength(1);
    expect(guideRepos([status('github', []), status('gitlab', [], false)])).toEqual([]);
  });

  it('says when the template of the issues is missing', () => {
    const broken = { ...manualRepo, template: 'gone' };
    const i = input(broken);
    expect(i.flow).toBeNull();
    expect(byId(i).run?.text).toContain('模板「gone」不存在或无效');
  });
});

describe('delivering through pull requests', () => {
  afterEach(() => setLang('zh'));
  const prRepo: GitHubRepoStatus = { ...partialRepo, deliver: 'pr' };

  it('pushes the Run branch and opens a PR that a human merges', () => {
    const push = byId(input(prRepo)).push;
    expect(push?.name).toBe('推送并开 PR');
    expect(push?.actors).toEqual(['master', 'human']);
    expect(push?.text).toContain('Master 推送 Run 的分支、开一个合并到目标分支（main）的 PR');
    expect(push?.text).toContain('目标分支（main）本身 Master 从不推送');
    expect(push?.text).toContain(
      '仓库成员在 PR 上要求修改、CI 没过或和目标分支（main）冲突时，Run 自动回去返工（计入回退上限），改好后推送到同一个 PR',
    );
    // Without push the repo is disabled.
    const off = byId(input({ ...prRepo, push: false })).push;
    expect(off?.actors).toEqual(['human']);
    expect(off?.text).toContain('deliver: pr 要配 push: true');
  });

  it('leaves merging the PR to you', () => {
    expect(autonomy(input(prRepo)).auto).toContain('推送到 GitHub');
    expect(autonomy(input(prRepo)).you).toContain('在 GitHub 上合并 PR');
    expect(autonomy(input(partialRepo)).you).not.toContain('在 GitHub 上合并 PR');
  });

  it('says which branches are force-pushed', () => {
    const history = (repo: GitHubRepoStatus) =>
      guardrails(input(repo), true).find((g) => g.title === 'git 历史可回退')?.text;
    expect(history(prRepo)).toContain('目标分支从不强推；只有 ares1/ 开头的 Run 分支会强制推送');
    expect(history(partialRepo)).toContain('推送从不强推');
  });

  it('does not list waiting for a PR among the reasons a Run is stuck', () => {
    const reasons = blockReasons();
    expect(reasons).not.toContain('等 PR 合并');
    expect(reasons).toContain('合并冲突');
    expect(reasons).toHaveLength(Object.keys(BLOCK_KIND).length - 1);
  });

  it('in English', () => {
    setLang('en');
    const push = byId(input(prRepo)).push;
    expect(push?.name).toBe('Push and open a PR');
    expect(push?.text).toContain(
      "the Master pushes the Run's branch and opens a pull request into the target branch (main)",
    );
    expect(autonomy(input(prRepo)).you).toContain('Merging pull requests on GitHub');
    expect(blockReasons()).not.toContain('Waiting for the PR to merge');
    for (const text of blockReasons()) expect(text).not.toMatch(/[一-鿿]/);
  });
});

describe('delivering through merge requests on GitLab', () => {
  afterEach(() => setLang('zh'));
  const GITLAB: IssueHost = { platform: 'gitlab', host: 'gitlab.example.com' };
  const mrRepo: GitHubRepoStatus = {
    ...partialRepo,
    issuesRepo: 'my-group/ares1',
    deliver: 'mr',
  };
  const onGitLab = (repo: GitHubRepoStatus): GuideInput => ({ ...input(repo), host: GITLAB });

  it('pushes the Run branch and opens an MR that a human merges', () => {
    const push = byId(onGitLab(mrRepo)).push;
    expect(push?.name).toBe('推送并开 MR');
    expect(push?.actors).toEqual(['master', 'human']);
    expect(push?.text).toBe(
      '检查通过后 Master 推送 Run 的分支、开一个合并到目标分支（main）的 MR，正文用 Closes 关联 issue；你在 GitLab 上合并它之后，Master 把本地的目标分支（main）快进，Run 完成、issue 关闭；项目里 Developer 及以上的成员在 MR 上要求修改、流水线没过或和目标分支（main）冲突时，Run 自动回去返工（计入回退上限），改好后推送到同一个 MR；MR 没合并就被关掉时 Run 失败。目标分支（main）本身 Master 从不推送',
    );
    // Without push the repo is disabled.
    const off = byId(onGitLab({ ...mrRepo, push: false })).push;
    expect(off?.actors).toEqual(['human']);
    expect(off?.text).toBe('deliver: mr 要配 push: true：现在没开 push，这个仓库停用，先修好配置');
    // A GitLab repo that pushes: the push step as before.
    expect(byId(onGitLab({ ...mrRepo, deliver: 'push' })).push?.name).toBe('推送到 GitLab');
  });

  it('leaves merging the MR to you, and force-pushes only the Run branches', () => {
    expect(autonomy(onGitLab(mrRepo)).you).toContain('在 GitLab 上合并 MR');
    expect(autonomy(onGitLab(partialRepo)).you).not.toContain('在 GitLab 上合并 MR');
    const history = guardrails(onGitLab(mrRepo), true).find(
      (g) => g.title === 'git 历史可回退',
    )?.text;
    expect(history).toContain('只有 ares1/ 开头的 Run 分支会强制推送，让它的 MR 跟上它');
  });

  it('in English', () => {
    setLang('en');
    const i = onGitLab(mrRepo);
    const push = byId(i).push;
    expect(push?.name).toBe('Push and open an MR');
    expect(push?.text).toContain(
      "the Master pushes the Run's branch and opens a merge request into the target branch (main)",
    );
    expect(push?.text).toContain(
      'if a member of the project from Developer up asks for changes on it, its pipeline fails or it conflicts with the target branch (main)',
    );
    expect(autonomy(i).you).toContain('Merging merge requests on GitLab');
    const off = byId(onGitLab({ ...mrRepo, push: false })).push;
    expect(off?.text).toBe(
      'deliver: mr needs push: true: push is off, so the repo is disabled; fix the configuration first',
    );
    const history = guardrails(i, true).find((g) => g.title === 'Revertible git history')?.text;
    expect(history).toContain('to keep their merge requests up to date');
    for (const text of [push?.name, push?.text, off?.text, history, ...autonomy(i).you]) {
      expect(text).toBeTruthy();
      expect(text).not.toMatch(/[一-鿿]/);
      expect(text).not.toMatch(/GitHub|pull request|deliver: pr/);
    }
  });
});

describe('the accept step', () => {
  afterEach(() => setLang('zh'));

  const CJK = /[一-鿿]/;
  const withRisk = (
    maxRisk: GitHubRepoStatus['autoAccept']['maxRisk'],
    maxSize: GitHubRepoStatus['autoAccept']['maxSize'] = 'L',
  ): GitHubRepoStatus => ({
    ...autoRepo,
    autoAccept: { ...autoRepo.autoAccept, maxRisk, maxSize },
  });
  /** A rule that accepts every proposal, whatever the settings. */
  const all = () => true;

  it('leaves every proposal to you with max_risk: none', () => {
    for (const github of [withRisk('none'), withRisk('none', 'S')]) {
      const step = acceptStep(github);
      expect(step.actors).toEqual(['human']);
      expect(step.text.startsWith('所有提案都由你来做：')).toBe(true);
      expect(step.text).not.toContain('自动采纳');
    }
  });

  it('leaves only size L proposals to you with max_risk: high and max_size: M', () => {
    const step = acceptStep(withRisk('high', 'M'));
    expect(step.actors).toEqual(['master', 'human']);
    expect(step.text).toContain('S、M 级提案自动采纳');
    expect(step.text).toContain('；L 级提案由你来做：加 ares1:ready 或关闭');
    expect(step.text).not.toContain('其余');
  });

  it('is up to the Master alone when no proposal needs you', () => {
    // max_risk high with the default max_size L accepts every proposal.
    const step = acceptStep(withRisk('high'));
    expect(step.actors).toEqual(['master']);
    expect(step.text).toBe(
      '所有提案自动采纳（加 ares1:ready 和 ares1:auto）；当天自动花费到 $20.00 后暂停，第二天自动继续采纳积压的提案',
    );
    expect(step.text).not.toContain('由你来做');
    // The cycle and the summary of what is left to you follow the same rule.
    const i = input(withRisk('high'));
    expect(cycleSteps(i).find((s) => s.id === 'accept')).toEqual(step);
    expect(autonomy(i).auto).toContain('采纳所有提案');
    expect(autonomy(i).you.join()).not.toContain('采纳');
    // The rule is passed through: one that accepts everything does so even under max_risk none.
    expect(acceptStep(withRisk('none'), all)).toEqual(step);
    expect(autonomy(input(withRisk('none')), all).auto).toContain('采纳所有提案');
  });

  it('says the daily limits only pause it until the next day', () => {
    const both = {
      ...withRisk('low'),
      autoAccept: { maxRisk: 'low' as const, maxSize: 'L' as const, maxPerDay: 3, usedToday: 0 },
    };
    expect(acceptStep(both).text).toContain(
      '；当天自动采纳满 3 条或自动花费到 $20.00 后暂停，第二天自动继续采纳积压的提案；',
    );
    const noLimit = { ...withRisk('high', 'M'), budget: { ...autoRepo.budget, dailyUsd: null } };
    expect(acceptStep(noLimit).text).toBe(
      'S、M 级提案自动采纳（加 ares1:ready 和 ares1:auto）；L 级提案由你来做：加 ares1:ready 或关闭',
    );
    const noLimitAll = { ...withRisk('high'), budget: { ...autoRepo.budget, dailyUsd: null } };
    expect(acceptStep(noLimitAll).text).toBe('所有提案自动采纳（加 ares1:ready 和 ares1:auto）');
    for (const github of [both, noLimit, noLimitAll, withRisk('high')]) {
      expect(acceptStep(github).text).not.toContain('就停');
    }
  });

  it('words the same in English', () => {
    setLang('en');
    expect(acceptStep(withRisk('none')).text).toBe(
      'All proposals are up to you: label the issues to do with ares1:ready; close the others as not planned with a one-line reason',
    );
    expect(acceptStep(withRisk('high', 'M')).text).toBe(
      'Accepted automatically: size S or M proposals (labeled ares1:ready and ares1:auto); once automatic spending reaches $20.00 in a day, it pauses for the rest of the day and accepts the backlog by itself the next day. Up to you: size L proposals; add ares1:ready or close them',
    );
    const one = {
      ...withRisk('mid'),
      autoAccept: { maxRisk: 'mid' as const, maxSize: 'L' as const, maxPerDay: 1, usedToday: 0 },
    };
    expect(acceptStep(one).text).toContain(
      'once 1 proposal is accepted or automatic spending reaches $20.00 in a day,',
    );
    expect(acceptStep(one).text).toContain('Up to you: high-risk proposals;');
    const none = acceptStep(withRisk('high'));
    expect(none.actors).toEqual(['master']);
    expect(none.text).toBe(
      'Accepted automatically: all proposals (labeled ares1:ready and ares1:auto); once automatic spending reaches $20.00 in a day, it pauses for the rest of the day and accepts the backlog by itself the next day',
    );
    for (const github of [
      null,
      withRisk('none'),
      withRisk('low'),
      withRisk('mid'),
      withRisk('low', 'M'),
      withRisk('mid', 'S'),
      one,
    ]) {
      expect(acceptStep(github).text).not.toMatch(CJK);
    }
    expect(none.text).not.toMatch(CJK);
  });
});

describe('the Run stages', () => {
  afterEach(() => setLang('zh'));

  it('shows who does each stage, with the approval before merging', () => {
    expect(runStages(input(manualRepo))).toEqual([
      {
        id: 'implement',
        name: '编码',
        actors: ['ai'],
        note: 'claude-coder 执行，检查命令通过才算完成',
      },
      {
        id: 'review',
        name: '评审',
        actors: ['ai'],
        note: 'claude-reviewer 评审，有必须修改的问题就打回「编码」',
      },
      { id: 'e2e', name: 'E2E（占位）', actors: [], note: '暂未实现，直接通过' },
      {
        id: 'merge',
        name: '合并',
        actors: ['human', 'master'],
        note: '等你审批，批准后 Master 合并到 main',
      },
    ]);
    expect(mergeNeedsApproval(input(manualRepo))).toBe(true);
  });

  it('shows an assess stage before coding', () => {
    const withAssess = TemplateSchema.parse({
      ...template,
      stages: [
        { id: 'assess', name: '需求评估', kind: 'assess', agent: 'claude-reviewer' },
        ...template.stages,
      ],
    });
    const cfg = { ...config, templates: [withAssess] } as typeof config;
    const i = { ...input(manualRepo), flow: issueFlow(cfg, manualRepo, ['npm test']) };
    expect(runStages(i)?.[0]).toEqual({
      id: 'assess',
      name: '需求评估',
      actors: ['ai'],
      note: 'claude-reviewer 只读评估需求：合理就开工；有疑问在 issue 上和你讨论，你同意不做时关闭 issue；24 小时内没人回复就自己决定（写明假设后开工，或者不做）',
    });
  });

  it('words the assess stage after how long it waits for replies', () => {
    const noteWith = (reply_timeout_hours: number | null) => {
      const withAssess = TemplateSchema.parse({
        ...template,
        stages: [
          {
            id: 'assess',
            name: '需求评估',
            kind: 'assess',
            agent: 'claude-reviewer',
            reply_timeout_hours,
          },
          ...template.stages,
        ],
      });
      const cfg = { ...config, templates: [withAssess] } as typeof config;
      const i = { ...input(manualRepo), flow: issueFlow(cfg, manualRepo, ['npm test']) };
      return runStages(i)?.[0]?.note;
    };
    expect(noteWith(null)).toBe(
      'claude-reviewer 只读评估需求：合理就开工；有疑问在 issue 上和你讨论，你同意不做时关闭 issue',
    );
    expect(noteWith(0)).toBe(
      'claude-reviewer 只读评估需求：合理就开工；有疑问时不等人回复就自己决定（写明假设后开工，或者不做）',
    );
    expect(noteWith(0.5)).toContain('30 分钟内没人回复就自己决定');
  });

  it('shows a command stage run by the Master, and where a failure goes back to', () => {
    const e2eWith = (e2e: Record<string, unknown>, repoCommands: string[] = ['npm test']) => {
      const withCommand = TemplateSchema.parse({
        ...template,
        stages: template.stages.map((s) =>
          s.id === 'e2e' ? { id: 'e2e', name: 'E2E', kind: 'command', ...e2e } : s,
        ),
      });
      const cfg = { ...config, templates: [withCommand] } as typeof config;
      const i = { ...input(manualRepo), flow: issueFlow(cfg, manualRepo, repoCommands) };
      return runStages(i)?.find((s) => s.id === 'e2e');
    };
    expect(e2eWith({ verify: { commands: ['npx playwright test'] } })).toEqual({
      id: 'e2e',
      name: 'E2E',
      actors: ['master'],
      note: 'Master 运行命令（不调用 Agent），有命令失败就带着输出回到「编码」',
    });
    expect(e2eWith({ gate: true })).toEqual({
      id: 'e2e',
      name: 'E2E',
      actors: ['master', 'human'],
      note: 'Master 运行命令（不调用 Agent），有命令失败就带着输出回到「编码」，通过后等你审批',
    });
    expect(e2eWith({}, [])?.note).toBe('没有要运行的命令，直接通过');
    setLang('en');
    expect(e2eWith({ gate: true })?.note).toBe(
      'The Master runs commands (no agent); when one fails, it goes back to "编码" with the output; then waits for your approval',
    );
  });

  it('says an agent is picked by difficulty from the candidates of a stage', () => {
    const withCandidates = TemplateSchema.parse({
      ...template,
      stages: [
        { id: 'assess', name: '需求评估', kind: 'assess', agent_candidates: ['claude-reviewer'] },
        ...template.stages.map((s) =>
          s.id === 'implement'
            ? { ...s, agent: undefined, agent_candidates: ['cheap-coder', 'claude-coder'] }
            : s.id === 'review'
              ? { ...s, agent: undefined, agent_candidates: ['claude-reviewer', 'cheap-coder'] }
              : s,
        ),
      ],
    });
    const cfg = { ...config, templates: [withCandidates] } as typeof config;
    const i = { ...input(manualRepo), flow: issueFlow(cfg, manualRepo, ['npm test']) };
    const notes = runStages(i)?.map((s) => s.note);
    // One candidate: it is the one, with nothing to pick from.
    expect(notes?.[0]).toMatch(/^claude-reviewer 只读评估需求/);
    expect(notes?.[1]).toBe(
      '按难度从 cheap-coder、claude-coder 中选出的 Agent 执行，检查命令通过才算完成',
    );
    expect(notes?.[2]).toBe(
      '按难度从 claude-reviewer、cheap-coder 中选出的 Agent 评审，有必须修改的问题就打回「编码」',
    );
    expect(guardrails(i, true).find((g) => g.title === 'AI 评审')?.text).toBe(
      '按难度从 claude-reviewer、cheap-coder 中选出的 Agent 看每轮改动，有「必须修改」的问题就打回「编码」',
    );
    setLang('en');
    const english = runStages(i)?.map((s) => s.note);
    expect(english?.[1]).toBe(
      'The agent picked by difficulty from cheap-coder, claude-coder does the work; it is done only when the checks pass',
    );
    expect(guardrails(i, true).find((g) => g.title === 'AI review')?.text).toBe(
      'The agent picked by difficulty from claude-reviewer, cheap-coder looks at every round of changes and sends back anything that must change to "编码"',
    );
  });

  it('merges without approval with auto_merge, as the Master creates those Runs', () => {
    const merge = runStages(input(autoRepo))?.find((s) => s.id === 'merge');
    expect(merge).toEqual({
      id: 'merge',
      name: '合并',
      actors: ['master'],
      note: '不等审批，Master 直接合并到 main（auto_merge）',
    });
    expect(mergeNeedsApproval(input(autoRepo))).toBe(false);
  });
});

describe('autonomy', () => {
  it('sums up what happens by itself and what is left to you', () => {
    expect(autonomy(input(manualRepo))).toEqual({
      auto: ['编码', '评审'],
      you: ['找活（侦察）', '采纳提案', '合并前审批', '推送到 GitHub', '升级 Master'],
    });
    expect(autonomy(input(autoRepo, on))).toEqual({
      auto: [
        '编码',
        '评审',
        '找活（侦察）',
        '采纳所有提案',
        '合并',
        '推送到 GitHub',
        '升级 Master',
      ],
      you: [],
    });
    expect(
      autonomy(input({ ...autoRepo, autoAccept: { ...autoRepo.autoAccept, maxSize: 'M' } }, on)),
    ).toMatchObject({ you: ['采纳 L 级提案'] });
    expect(autonomy(input(partialRepo))).toEqual({
      auto: ['编码', '评审', '找活（侦察）', '采纳风险低的 S、M 级提案', '推送到 GitHub'],
      you: ['采纳 L 级提案和风险中、高的提案', '合并前审批', '升级 Master'],
    });
  });

  it('names the autonomy level', () => {
    expect(autonomyLevel(manualRepo)).toBe('L0');
    expect(autonomyLevel(partialRepo)).toBe('L1');
    expect(autonomyLevel(autoRepo)).toBe('L2');
    expect(autonomyLevel({ ...manualRepo, autoMerge: true })).toBeNull();
    expect(autonomyLevel(null)).toBeNull();
  });
});

describe('scoutGuide', () => {
  const now = new Date('2026-11-19T12:00:00');

  it('lists the conditions with the current settings', () => {
    const g = scoutGuide(input(autoRepo), now);
    expect(g.conditions).toContain(
      '今天侦察、自动采纳和自动重做的 Run 一共花费不到 $20.00（现在 $3.20）',
    );
    expect(g.conditions).toContain('不限间隔（interval_minutes: 0）');
    expect(g.conditions).toContain(
      '不在退避：侦察没找到需求或失败后先等 5 分钟，连续每多一次等待翻倍，最长 6 小时；有侦察找到了需求，或目标分支有了新提交，就不再等',
    );
    expect(g.conditions).toContain(
      '不在等侦察的 Agent 恢复额度：额度用尽或被限流不算失败，也不计入退避；CLI 给了额度重置时间就等到那时再多等 1 分钟，没给就按连续被限流的次数等 5、10、20、40 分钟，之后每次 1 小时',
    );
    expect(g.conditions).toContain(
      '仓库没有会自己往下走的 Run（排队、执行中、等评估回复且设了超时，或等目标分支上的改动清掉后自动合并）：手上的活做完了才找新活；只等人的 Run 不用等，算进下面的上限',
    );
    // Nothing is left to you, so nothing is said about proposals that do not hold it back.
    expect(g.conditions).toContain(
      '在自动采纳范围内、还没采纳的提案加上卡住等人的 Run 少于 5 个（max_proposals）',
    );
    expect(g.now).toBe('条件都满足，下次检查（每 5 分钟）时就会侦察。');
    expect(g.waiting).toBe(false);

    const p = scoutGuide(input(partialRepo), now);
    expect(p.conditions).toContain('距上次侦察满 6 小时（interval_minutes）');
    const interval = (intervalMinutes: number) =>
      scoutGuide(input({ ...partialRepo, scout: { ...scout, intervalMinutes } }), now).conditions;
    expect(interval(15)).toContain('距上次侦察满 15 分钟（interval_minutes）');
    expect(interval(90)).toContain('距上次侦察满 1 小时 30 分钟（interval_minutes）');
    expect(p.conditions).toContain('没设每日花费上限（daily_budget_usd），不受花费限制');
    expect(p.conditions).toContain(
      '在自动采纳范围内、还没采纳的提案加上卡住等人的 Run 少于 5 个（max_proposals）；L 级提案和风险中、高的提案留给你处理，不挡侦察',
    );

    // Without auto-accept every untriaged proposal counts.
    const m = scoutGuide(input({ ...manualRepo, scout }), now);
    expect(m.conditions).toContain('还没处理的提案加上卡住等人的 Run 少于 5 个（max_proposals）');
    expect(m.conditions.join('\n')).not.toContain('不挡侦察');
  });

  it('says why it does not scout right now', () => {
    const waiting = {
      ...autoRepo,
      scout: { ...scout, waiting: { reason: '有 5 条提案等你处理' } },
    };
    expect(scoutGuide(input(waiting), now)).toMatchObject({
      now: '现在没有侦察：有 5 条提案等你处理。',
      waiting: true,
    });
    const until = {
      ...autoRepo,
      scout: {
        ...scout,
        waiting: {
          reason: '离上次侦察不到设定的间隔',
          until: new Date('2026-11-19T18:00:00').toISOString(),
        },
      },
    };
    expect(scoutGuide(input(until), now).now).toBe(
      '现在没有侦察：离上次侦察不到设定的间隔（18:00:00 之后）。',
    );
    const running = { ...autoRepo, scout: { ...scout, running: true } };
    expect(scoutGuide(input(running), now).now).toBe('正在侦察。');
    const manual = { ...autoRepo, scout: { ...scout, auto: false } };
    expect(scoutGuide(input(manual), now).now).toContain('自动侦察没开');
  });

  it('says when it never scouts by itself', () => {
    expect(scoutGuide(input(manualRepo), now)).toEqual({
      conditions: [],
      now: '这个仓库没有配置侦察（scout），不会自己找活。',
      waiting: true,
    });
    expect(scoutGuide(input(null), now).now).toBe('还没有接入 GitHub 或 GitLab，不会自己找活。');
  });
});

describe('notifications', () => {
  afterEach(() => setLang('zh'));
  const ev = (type: string, data: Record<string, unknown> = {}, runId: string | null = 'r') =>
    ({ id: 1, runId, ts: '2026-11-19T00:00:00.000Z', type, data }) satisfies EventRow;

  it('lists the kinds of src/notify/notice.ts, each with what to do', () => {
    const rows = noticeRows();
    expect(rows.map((r) => r.kind)).toEqual(Object.keys(NOTICE_KINDS));
    for (const row of rows) {
      expect(row.label).toBe(NOTICE_KINDS[row.kind].label);
      expect(row.handle.length).toBeGreaterThan(0);
    }
  });

  it('describes the notifications the rules actually send', () => {
    const samples: [NoticeKind, EventRow][] = [
      ['approval', ev('approval.requested')],
      ['discussion', ev('run.blocked', { kind: 'discussion' })],
      ['blocked', ev('run.blocked', { kind: 'merge_conflict' })],
      ['failed', ev('run.status', { status: 'failed' })],
      ['proposals', ev('scout.completed', { pending: 2 }, null)],
      [
        'iteration',
        ev('iteration.blocked', { repo: 'demo', issue: 1, child: 2, reason: 'failed' }, null),
      ],
      ['scout', ev('scout.failed', { repo: 'demo', message: 'x', streak: 3 }, null)],
      ['github', ev('github.error', { message: 'x' }, null)],
      ['pull', ev('github.diverged', { repo: 'demo', local: 'a', remote: 'b' }, null)],
      ['upgrade', ev('upgrade.failed', { message: 'x' }, null)],
    ];
    expect(samples.map(([kind]) => kind).sort()).toEqual(Object.keys(NOTICE_KINDS).sort());
    for (const [kind, event] of samples) {
      const notice = noticeFor(event, 'goal');
      expect(notice?.kind).toBe(kind);
      // The title is the label the guide shows, then the detail if any.
      expect(notice?.title.startsWith(NOTICE_KINDS[kind].label)).toBe(true);
    }
    expect(noticeFor(ev('run.blocked', { kind: 'merge_conflict' }), 'g')?.title).toBe(
      'Run 卡住了：合并冲突',
    );
    // Questions about the requirement wait for a reply; the Run is not broken.
    expect(noticeFor(ev('run.blocked', { kind: 'discussion' }), 'g')?.title).toBe(
      '需求待讨论，等你回复',
    );
    expect(noticeFor(ev('scout.completed', { pending: 2 }, null), 'g')?.title).toBe(
      '有提案等你决定：2 条',
    );
  });

  it('explains ares1:auto by the auto_accept setting', () => {
    const auto = (a: GitHubRepoStatus['autoAccept'] | null) =>
      labelHelp(a).find(([label]) => label === 'ares1:auto')?.[1];
    expect(auto(partialRepo.autoAccept)).toContain(
      '现在是风险低的 S、M 级提案（max_risk: low，max_size: M）',
    );
    expect(auto(autoRepo.autoAccept)).toContain('现在是所有提案（max_risk: high，max_size: L）');
    expect(auto(manualRepo.autoAccept)).toContain('现在自动采纳关闭');
    expect(auto(null)).toContain('由 max_risk 和 max_size 决定');
    expect(labelHelp(null).map(([label]) => label)).toEqual([
      'ares1:proposal',
      'ares1:iteration',
      'ares1:ready',
      'ares1:running',
      'ares1:needs-you',
      'ares1:failed',
      'ares1:not-planned',
      'ares1:auto',
    ]);
    // GitLab closes issues without a reason: the label tells not planned from done.
    const notPlanned = labelHelp(null).find(([label]) => label === 'ares1:not-planned')?.[1];
    expect(notPlanned).toContain('GitLab 关闭 issue 时不带原因');
    expect(notPlanned).toContain('只关闭不加的会被当成已经完成');
    expect(labelHelp(null).find(([label]) => label === 'ares1:proposal')?.[1]).toContain(
      'GitLab 上关闭时加上 ares1:not-planned',
    );
  });

  it('explains ares1:iteration: accepted and closed as a whole, never a Run itself', () => {
    const iteration = labelHelp(null).find(([label]) => label === 'ares1:iteration')?.[1];
    expect(iteration).toContain('给它加 ares1:ready 就整批采纳，子 issue 按依赖顺序开工');
    expect(iteration).toContain('关掉它，还没完成的子 issue 一起终止并关成不做');
    expect(iteration).toContain('它自己从不建 Run，子 issue 都完成后 Master 发总结并关掉它');
  });

  it('says how iterations go in the scout section', () => {
    const lines = iterationGuide();
    expect(lines).toHaveLength(5);
    const all = lines.join('\n');
    // Planning: the most important gap, at most MAX_ITERATION_CHILDREN steps, closing step last.
    expect(all).toContain('从差距分析里选最重要的一个缺口');
    expect(all).toContain('最多 8 个，最后一个是整理评审建议的「收尾」');
    expect(all).toContain('带 ares1:iteration 的 issue');
    // Accepted as a whole, counted once.
    expect(all).toContain(
      '自动采纳取子项里最高的风险和最大的大小来判断，在每天的自动采纳条数里只算一次',
    );
    // The dependency gate, the summary, blocked and cancelled.
    expect(all).toContain('一个子项依赖的子项都以完成关闭后，才为它建 Run');
    expect(all).toContain('Master 发一份总结（对照完成标准、用了哪些 Run、总费用和用时）');
    expect(all).toContain('迭代就停在「受阻」并通知你');
    expect(all).toContain('还没完成的子项一起终止');
    // The scout while one is under way.
    expect(all).toContain('只提让系统停转或空耗的问题');
    expect(all).toContain('评审通过时留下的建议不单独成 issue');
  });

  it('says which channel sends them', () => {
    expect(notifyChannel(true)).toContain('Master 直接发系统通知');
    expect(notifyChannel(false)).toContain('浏览器');
  });

  it('says which platforms send system notifications and what Linux needs', () => {
    for (const on of [true, false]) {
      expect(notifyChannel(on)).toContain('macOS 用通知中心');
      expect(notifyChannel(on)).toContain('notify-send');
      expect(notifyChannel(on)).toContain('libnotify');
    }
    // Where the Master cannot send them, the browser still does.
    expect(notifyChannel(false)).toContain('其他平台不支持，仍由浏览器发通知');
  });

  it('says a webhook is set, or how to be reached away from this machine', () => {
    for (const system of [true, false]) {
      expect(notifyChannel(system, true)).toContain(
        '已配置 webhook（config.yaml 的 notify.webhook），需要人处理时 Master 也会 POST 到配置的地址',
      );
      expect(notifyChannel(system, false)).toContain('配 notify.webhook');
      expect(notifyChannel(system, false)).not.toContain('已配置 webhook');
    }
    // The browser's notifications are still offered next to the webhook.
    expect(notifyChannel(false, true)).toContain('现在由浏览器发通知');
    setLang('en');
    for (const [system, webhook] of [
      [true, true],
      [false, false],
    ] as const) {
      const text = notifyChannel(system, webhook);
      expect(text).toContain(webhook ? 'A webhook is set' : 'set notify.webhook');
      expect(text).not.toMatch(/[一-鿿]/);
    }
  });
});

describe('the test notification', () => {
  afterEach(() => setLang('zh'));
  const CJK = /[一-鿿]/;

  const off = { enabled: false, ok: false, reason: null };
  const result = (
    system: Partial<NotifyTestResult['system']>,
    webhook: Partial<NotifyTestResult['webhook']>,
  ): NotifyTestResult => ({
    system: { ...off, supported: true, ...system },
    webhook: { ...off, status: null, ...webhook },
  });
  const lines = (r: NotifyTestResult) =>
    notifyTestLines(r).map((l) => [l.channel, l.label, l.tone, l.text]);

  it('can be sent only through a channel of the Master', () => {
    expect(notifyTestUnavailable(true, false)).toBeNull();
    expect(notifyTestUnavailable(false, true)).toBeNull();
    expect(notifyTestUnavailable(true, true)).toBeNull();
    const why = notifyTestUnavailable(false, false);
    expect(why).toContain('notify.system');
    expect(why).toContain('notify.webhook');
    setLang('en');
    expect(notifyTestUnavailable(false, false)).toContain('nothing to test');
    expect(notifyTestUnavailable(false, false)).not.toMatch(CJK);
  });

  it('tells how each channel went', () => {
    expect(
      lines(result({ enabled: true, ok: true }, { enabled: true, ok: true, status: 200 })),
    ).toEqual([
      [
        'system',
        '系统通知',
        'success',
        '已交给系统显示；没看到的话，检查系统的通知设置（勿扰、专注模式、是否允许通知）',
      ],
      ['webhook', 'webhook', 'success', '对方已接收（HTTP 200）'],
    ]);
    expect(
      lines(
        result(
          {
            enabled: true,
            reason: '找不到 notify-send，Linux 上需要安装 libnotify（提供 notify-send）',
          },
          { enabled: true, status: 500, reason: 'HTTP 500 Internal Server Error' },
        ),
      ),
    ).toEqual([
      [
        'system',
        '系统通知',
        'danger',
        '发送失败：找不到 notify-send，Linux 上需要安装 libnotify（提供 notify-send）',
      ],
      ['webhook', 'webhook', 'danger', '发送失败：HTTP 500 Internal Server Error'],
    ]);
    expect(lines(result({}, {}))).toEqual([
      ['system', '系统通知', 'muted', '没有打开（config.yaml 的 notify.system）'],
      ['webhook', 'webhook', 'muted', '没有配置（config.yaml 的 notify.webhook）'],
    ]);
    expect(lines(result({ supported: false }, {}))[0]?.[3]).toBe(
      'Master 所在的平台不支持（只支持 macOS、Linux）',
    );
  });

  it('tells it in English without Chinese', () => {
    setLang('en');
    const all = [
      result({ enabled: true, ok: true }, { enabled: true, ok: true, status: 204 }),
      result(
        { enabled: true, reason: 'exit code 1: execution error' },
        { enabled: true, reason: 'fetch failed (ECONNREFUSED)' },
      ),
      result({}, {}),
      result({ supported: false }, {}),
    ].flatMap(lines);
    for (const line of all) expect(line.join(' ')).not.toMatch(CJK);
    expect(all.map((l) => l[3])).toEqual([
      "Handed to the system to show; if you did not see it, check the system's notification settings (Do Not Disturb, Focus, permissions)",
      'Accepted (HTTP 204)',
      'Failed: exit code 1: execution error',
      'Failed: fetch failed (ECONNREFUSED)',
      'Off (notify.system in config.yaml)',
      'Not set (notify.webhook in config.yaml)',
      "Not supported on the Master's platform (only macOS and Linux)",
      'Not set (notify.webhook in config.yaml)',
    ]);
    expect(all.slice(0, 2).map((l) => l[1])).toEqual(['System notification', 'Webhook']);
  });
});

describe('guardrails', () => {
  const rail = (i: GuideInput, title: string) => guardrails(i, true).find((g) => g.title === title);

  it('reads the checks, review and approvals from the template', () => {
    const i = input(manualRepo);
    expect(rail(i, '检查命令')?.text).toContain('npm run build、npm test、npm run lint');
    expect(rail(i, 'AI 评审')).toMatchObject({ on: true });
    expect(rail(i, 'AI 评审')?.text).toContain('claude-reviewer');
    expect(rail(i, '合并前审批')).toMatchObject({ on: true });
    expect(rail(i, 'Run 预算')).toMatchObject({ on: false });
    expect(rail(i, '每日花费上限')).toMatchObject({ on: false });
    expect(rail(i, '升级失败自动回退')).toMatchObject({ on: false });
    expect(rail(i, '工作开关')?.text).toContain('现在：工作中');
    expect(rail(i, 'git 历史可回退')).toMatchObject({ on: true });
  });

  it('follows the automatic settings', () => {
    const i = input(autoRepo, on);
    expect(rail(i, '合并前审批')).toMatchObject({ on: false });
    expect(rail(i, '合并前审批')?.text).toContain('auto_merge 打开');
    expect(rail(i, '每日花费上限')).toMatchObject({ on: true });
    expect(rail(i, '每日花费上限')?.text).toContain('$20.00，今天已花 $3.20');
    expect(rail(i, '升级失败自动回退')).toMatchObject({ on: true });
  });

  it('says how long a failed Run waits before it is redone', () => {
    expect(rail(input(manualRepo), '失败后重做的次数上限')?.text).toBe(
      '从 issue 来的 Run 失败后自动重做，带上之前的失败原因；重做前先等 5 分钟，每失败一次等待翻倍，最长 2 小时，免得一时的 API 或网络故障很快用完次数；一个 issue 最多跑 3 次（max_run_attempts），用完后关闭为 not planned，并写明每次失败的原因',
    );
    setLang('en');
    try {
      const text = rail({ ...input(manualRepo), pollMinutes: 1 }, 'Limit on redoing failed Runs');
      expect(text?.text).toContain(
        'the redo waits 1 minute first, twice as long after each further failure, up to 2 hours',
      );
      expect(text?.text).not.toMatch(/[一-鿿]/);
    } finally {
      setLang('zh');
    }
  });

  it("finds the repo's template as the Master does: the home directory's, else the repo's own", () => {
    const own = TemplateSchema.parse({ ...template, id: 'own', name: '仓库自带的流程' });
    // The templates the repo "ares1" keeps.
    const keeps = (templates: (typeof template)[]): typeof config => ({
      ...config,
      repoTemplates: [{ repo: 'ares1', branch: 'main', sha: 'abc', templates, files: [] }],
    });
    const cfg = keeps([own]);
    const ownRepo = { ...manualRepo, template: 'own' };

    const flow = issueFlow(cfg, ownRepo, null);
    expect(flow).toMatchObject({ templateName: '仓库自带的流程', templateSource: 'repo' });
    expect(byId({ ...input(ownRepo), flow }).run?.text).toContain(
      '按模板「仓库自带的流程」（仓库自带的，在目标分支的 .ares1/workflows/ 里）建 Run',
    );
    // Another repo does not see it.
    expect(issueFlow(cfg, { ...ownRepo, name: 'other' }, null)).toBeNull();
    // The home directory's of the same id wins.
    expect(issueFlow(keeps([{ ...own, id: 'self-dev' }]), manualRepo, null)).toMatchObject({
      templateName: '自举开发',
      templateSource: 'home',
    });
    expect(byId(input(manualRepo)).run?.text).not.toContain('仓库自带');

    setLang('en');
    try {
      const text = byId({ ...input(ownRepo), flow: issueFlow(cfg, ownRepo, null) }).run?.text;
      expect(text).toContain(
        `with the template "仓库自带的流程" (the repo's own, in .ares1/workflows/ on the target branch)`,
      );
    } finally {
      setLang('zh');
    }
  });

  it('tells a template without a merge approval from auto_merge', () => {
    const ungated = TemplateSchema.parse({
      ...template,
      stages: template.stages.map((st) => (st.kind === 'merge' ? { ...st, gate: false } : st)),
    });
    const i: GuideInput = {
      ...input(manualRepo),
      flow: issueFlow({ ...config, templates: [ungated] }, manualRepo, null),
    };
    expect(rail(i, '合并前审批')).toMatchObject({
      on: false,
      text: '没有：模板「自举开发」的合并阶段没设审批，检查和评审通过后直接合并',
    });
  });

  it('shows the Run budget of the template', () => {
    const budgeted = TemplateSchema.parse({ ...template, defaults: { budget_usd: 5 } });
    const i: GuideInput = {
      ...input(manualRepo),
      flow: issueFlow({ ...config, templates: [budgeted] }, manualRepo, null),
    };
    expect(i.flow?.budgetPauses).toBe(false);
    expect(rail(i, 'Run 预算')).toMatchObject({ on: true });
    // By default a Run over budget ends as failed and nothing waits for you.
    expect(rail(i, 'Run 预算')?.text).toBe(
      '每个 Run 最多花 $5.00（模板的 budget_usd），超出后不再开始新的执行，Run 结束、标为失败，从 issue 来的会自动重做',
    );
  });

  it('says a Run over budget waits for you only where on_budget_exceeded is pause', () => {
    const withEscalate = (defaults: object, stage: Record<string, object> = {}) =>
      TemplateSchema.parse({
        ...template,
        defaults: { budget_usd: 5, ...defaults },
        stages: template.stages.map((st) => ({ ...st, ...(stage[st.id] ?? {}) })),
      });
    const flowOf = (tpl: typeof template) =>
      issueFlow({ ...config, templates: [tpl] }, manualRepo, null);
    const pause = { escalate: { on_budget_exceeded: 'pause' } };
    const abort = { escalate: { on_budget_exceeded: 'abort' } };

    const paused = flowOf(withEscalate(pause));
    expect(paused?.budgetPauses).toBe(true);
    const i: GuideInput = { ...input(manualRepo), flow: paused };
    expect(rail(i, 'Run 预算')?.text).toBe(
      '每个 Run 最多花 $5.00（模板的 budget_usd），超出后不再开始新的执行，卡住等你调高预算（on_budget_exceeded: pause）',
    );
    // A stage that runs an agent decides as well, over the template's defaults.
    expect(flowOf(withEscalate({}, { review: pause }))?.budgetPauses).toBe(true);
    expect(flowOf(withEscalate(pause, { implement: abort, review: abort }))?.budgetPauses).toBe(
      false,
    );
    // No agent runs in merge and placeholder stages, so the budget is never checked there.
    expect(flowOf(withEscalate({}, { e2e: pause, merge: pause }))?.budgetPauses).toBe(false);
    expect(flowOf(withEscalate(abort))?.budgetPauses).toBe(false);
  });

  it('leaves out the GitHub ones without GitHub', () => {
    const i = input(null);
    expect(rail(i, '合并前审批')).toBeUndefined();
    expect(rail(i, '每日花费上限')).toBeUndefined();
    expect(rail(i, '检查命令')).toBeDefined();
  });
});

describe('idleReasons', () => {
  const now = new Date('2026-11-19T12:00:00');
  const base = { working: true, upgrade: undefined, attention: 0, github: autoRepo };

  it('is empty when nothing is in the way', () => {
    expect(idleReasons(base, now)).toEqual([]);
  });

  it('names the work switch, the upgrade, Runs waiting for you and the scout', () => {
    const offRepo = {
      ...autoRepo,
      scout: { ...scout, waiting: { reason: '工作开关已关闭' } },
    };
    // The scout waiting for the switch is not said twice.
    expect(idleReasons({ ...base, working: false, github: offRepo }, now)).toEqual([
      '已停工：点顶栏的「已停工」开工。',
    ]);
    const newVersion = { current: 'aaaaaaa', latest: 'bbbbbbb' };
    expect(
      idleReasons(
        {
          ...base,
          upgrade: { state: 'waiting', message: '等正在执行的工作做完再升级', ...newVersion },
        },
        now,
      ),
    ).toEqual(['Master 在等升级或正在升级，这期间不开始新的工作（等正在执行的工作做完再升级）。']);
    expect(
      idleReasons(
        { ...base, upgrade: { state: 'upgrading', message: 'aaaaaaa → bbbbbbb', ...newVersion } },
        now,
      ),
    ).toEqual(['Master 在等升级或正在升级，这期间不开始新的工作（aaaaaaa → bbbbbbb）。']);
    const busy = {
      ...autoRepo,
      scout: { ...scout, waiting: { reason: '等 1 个未结束的 Run 做完' } },
    };
    const stuck =
      '有 1 个 Run 在等你审批或卡住了：它们不算在正在执行的 Run 里（每个仓库最多同时执行 concurrency.per_repo 个），排队的 Run 照常开始；只等人的 Run 不挡自动侦察，但和等你处理的提案一起计入上限（max_proposals），攒满后不再侦察。到首页「待我处理」处理。';
    expect(idleReasons({ ...base, attention: 1 }, now)).toEqual([stuck]);
    // Runs waiting for you no longer hold the scout: what it waits for is said on its own.
    expect(idleReasons({ ...base, attention: 1, github: busy }, now)).toEqual([
      stuck,
      '自动侦察在等：等 1 个未结束的 Run 做完。',
    ]);
    const full = {
      ...autoRepo,
      scout: { ...scout, waiting: { reason: '有 4 条提案、1 个卡住的 Run 等你处理' } },
    };
    expect(idleReasons({ ...base, attention: 1, github: full }, now)).toEqual([
      stuck,
      '自动侦察在等：有 4 条提案、1 个卡住的 Run 等你处理。',
    ]);
  });

  it('does not blame the upgrade when stopped: the upgrader just says 「已停工」 then', () => {
    const offRepo = { ...autoRepo, scout: { ...scout, waiting: { reason: '工作开关已关闭' } } };
    const stopped = { state: 'waiting', message: '已停工' } as const;
    // Stale versions from an earlier check, or none at all.
    for (const versions of [
      { current: 'aaaaaaa', latest: 'bbbbbbb' },
      { current: 'aaaaaaa', latest: 'aaaaaaa' },
      { current: null, latest: null },
    ]) {
      expect(
        idleReasons(
          { ...base, working: false, upgrade: { ...stopped, ...versions }, github: offRepo },
          now,
        ),
      ).toEqual(['已停工：点顶栏的「已停工」开工。']);
    }
    // Not known to be stopped: no new version means nothing to wait for.
    expect(
      idleReasons(
        { ...base, working: undefined, upgrade: { ...stopped, current: null, latest: null } },
        now,
      ),
    ).toEqual([]);
  });
});

describe('running the Master', () => {
  afterEach(() => setLang('zh'));

  it('quotes paths only when needed', () => {
    expect(shellQuote('/Users/me/.ares1')).toBe('/Users/me/.ares1');
    expect(shellQuote('/Users/me/my dir')).toBe(`'/Users/me/my dir'`);
    expect(shellQuote(`/a/it's`)).toBe(`'/a/it'\\''s'`);
  });

  it('starts from the install directory, logging to master.out', () => {
    expect(startCommand('/Users/me/ares1-stable', '/Users/me/.ares1')).toBe(
      'cd /Users/me/ares1-stable\nnohup node dist/cli.js --home /Users/me/.ares1 >> /Users/me/.ares1/master.out 2>&1 &',
    );
    expect(startCommand(null, '/h')).toContain('cd <稳定副本目录>');
    expect(stopCommand('/Users/me/.ares1')).toBe(`pkill -f 'dist/cli.js --home /Users/me/.ares1'`);
  });

  it('lists the data and log files under the home directory', () => {
    const paths = dataPaths('/h/').map((p) => p.path);
    expect(paths).toContain('/h/data/ares1.db');
    expect(paths).toContain('/h/master.out');
    expect(paths).toContain('/h/upgrade.log');
    expect(paths).toContain('/h/keepalive.log');
    expect(paths).toContain('/h/webhook.curl');
  });

  it('says how long the raw agent output is kept', () => {
    const logs = dataPaths('/h/').find((p) => p.path === '/h/data/logs/');
    expect(logs?.what).toContain('30 天后自动删掉原始输出');
    setLang('en');
    const en = dataPaths('/h/').find((p) => p.path === '/h/data/logs/');
    expect(en?.what).toContain('deleted automatically 30 days after its Run or scout ended');
  });
});

describe('sections', () => {
  it('have ids and titles', () => {
    expect(GUIDE_SECTIONS.map((s) => s.id)).toEqual([
      'intro',
      'cycle',
      'scout',
      'you',
      'notify',
      'labels',
      'guards',
      'faq',
    ]);
    for (const s of GUIDE_SECTIONS) expect(s.title).not.toBe('');
    expect(isGuideSection('labels')).toBe(true);
    expect(isGuideSection('nope')).toBe(false);
  });
});

describe('in English', () => {
  afterEach(() => setLang('zh'));

  const CJK = /[\u4e00-\u9fff]/;
  const enTemplate = TemplateSchema.parse({
    id: 'self-dev',
    name: 'Self-dev',
    stages: [
      { id: 'assess', name: 'Assess', kind: 'assess', agent: 'claude-reviewer' },
      {
        id: 'implement',
        name: 'Code',
        agent: 'claude-coder',
        verify: { commands: ['npm run build', 'npm test'] },
      },
      { id: 'review', name: 'Review', kind: 'review', agent: 'claude-reviewer' },
      { id: 'e2e', name: 'E2E', kind: 'placeholder' },
      { id: 'merge', name: 'Merge', kind: 'merge', gate: true },
    ],
  });
  const enConfig = { ...config, templates: [enTemplate] } as typeof config;
  const inputEn = (github: GitHubRepoStatus | null, upgrade = off): GuideInput => ({
    ...input(github, upgrade),
    flow: github ? issueFlow(enConfig, github, ['npm test']) : null,
  });
  const repos = [
    null,
    manualRepo,
    partialRepo,
    autoRepo,
    { ...autoRepo, deliver: 'pr' as const },
    { ...manualRepo, deliver: 'pr' as const },
    { ...autoRepo, deliver: 'mr' as const },
    { ...manualRepo, deliver: 'mr' as const },
  ];

  it('words the loop, its stages and what is left to you without Chinese', () => {
    setLang('en');
    const gitlab: IssueHost = { platform: 'gitlab', host: 'gitlab.example.com' };
    for (const github of repos) {
      for (const [upgrade, host] of [
        [off, GITHUB],
        [on, GITHUB],
        [{ auto: true, installDir: null }, GITHUB],
        [off, gitlab],
      ] as const) {
        const i = { ...inputEn(github, upgrade), host };
        for (const step of cycleSteps(i)) {
          expect(step.name).not.toMatch(CJK);
          expect(step.text).not.toMatch(CJK);
        }
        for (const stage of runStages(i) ?? []) expect(stage.note).not.toMatch(CJK);
        const { auto, you } = autonomy(i);
        for (const text of [...auto, ...you]) expect(text).not.toMatch(CJK);
        for (const g of guardrails(i, true)) {
          expect(g.title).not.toMatch(CJK);
          expect(g.text).not.toMatch(CJK);
        }
      }
    }
    const steps = byId(inputEn(partialRepo));
    expect(steps.accept?.text).toBe(
      'Accepted automatically: low-risk proposals of size S or M (labeled ares1:ready and ares1:auto); once 3 proposals are accepted in a day, it pauses for the rest of the day and accepts the backlog by itself the next day. Up to you: size L proposals and medium- or high-risk proposals; add ares1:ready or close them',
    );
    expect(steps.push?.text).toContain('pushes the target branch (main) to GitHub');
    const onGitLab = byId({ ...inputEn(manualRepo), host: gitlab });
    expect(onGitLab.push?.name).toBe('Push to GitLab');
    expect(onGitLab.propose?.text).toBe('You write issues on GitLab');
    expect(onGitLab.accept?.text).toBe(
      'All proposals are up to you: label the issues to do with ares1:ready; close the others with the ares1:not-planned label and a one-line reason',
    );
    expect(byId(inputEn(null)).scout?.text).toBe(
      'Neither GitHub nor GitLab is set up yet, so there is no AI scout: you decide what to do',
    );
    expect(steps.run?.text).toContain(
      'each repo executes one Run at a time (concurrency.per_repo: 1), while Runs of different repos can execute side by side',
    );
    const parallel = byId({ ...inputEn(partialRepo), perRepo: 3 }).run?.text;
    expect(parallel).toContain(
      'each repo executes up to 3 Runs at a time (concurrency.per_repo), each in its own working directory, and they merge one at a time',
    );
    expect(parallel).not.toMatch(CJK);
    const limited = byId({ ...inputEn(partialRepo), perRepo: 3, maxRuns: 4 }).run?.text;
    expect(limited).toContain(
      'they merge one at a time; Runs of different repos can execute side by side too, up to 4 in all (concurrency.max_runs)',
    );
    expect(limited).not.toMatch(CJK);
    const one = byId({ ...inputEn(partialRepo), maxRuns: 1 }).run?.text;
    expect(one).toContain(
      'each repo executes one Run at a time (concurrency.per_repo: 1); only one Run executes at a time across all repos (concurrency.max_runs: 1)',
    );
    expect(one).not.toMatch(CJK);
    expect(runStages(inputEn(manualRepo))?.find((s) => s.id === 'e2e')?.name).toBe(
      'E2E (placeholder)',
    );
    expect(autonomy(inputEn(autoRepo, on))).toMatchObject({
      auto: expect.arrayContaining(['Accepting all proposals']),
      you: [],
    });
    expect(
      autonomy(inputEn({ ...autoRepo, autoAccept: { ...autoRepo.autoAccept, maxSize: 'M' } }, on)),
    ).toMatchObject({
      auto: expect.arrayContaining(['Accepting size S or M proposals']),
      you: ['Accepting size L proposals'],
    });
    const checks = guardrails(inputEn(manualRepo), true).find((g) => g.title === 'Checks');
    expect(checks?.text).toContain('npm run build, npm test run');
  });

  it('words the Run budget without Chinese, whether a Run over it ends or waits', () => {
    setLang('en');
    const texts = [{}, { escalate: { on_budget_exceeded: 'pause' } }].map((escalate) => {
      const budgeted = TemplateSchema.parse({
        ...enTemplate,
        defaults: { budget_usd: 5, ...escalate },
      });
      const i: GuideInput = {
        ...inputEn(manualRepo),
        flow: issueFlow({ ...enConfig, templates: [budgeted] }, manualRepo, null),
      };
      return guardrails(i, true).find((g) => g.title === 'Run budget')?.text ?? '';
    });
    expect(texts[0]).toBe(
      "Each Run spends at most $5.00 (the template's budget_usd); beyond that no new execution starts, the Run ends as failed, and a Run from an issue is redone automatically",
    );
    expect(texts[1]).toBe(
      "Each Run spends at most $5.00 (the template's budget_usd); beyond that no new execution starts, and it is blocked until you raise the budget (on_budget_exceeded: pause)",
    );
    for (const text of texts) expect(text).not.toMatch(CJK);
  });

  it('names the sections, the actors and the labels in English', () => {
    setLang('en');
    expect(GUIDE_SECTIONS.map((s) => s.title)).toEqual([
      'What this is',
      'The loop',
      'When it finds work by itself',
      'What you do',
      'When you are notified',
      'What the labels mean',
      'Guardrails',
      'FAQ',
    ]);
    expect(Object.values(ACTOR).map((a) => a.label)).toEqual(['AI', 'Master (auto)', 'Up to you']);
    for (const accept of [
      null,
      manualRepo.autoAccept,
      partialRepo.autoAccept,
      autoRepo.autoAccept,
    ]) {
      for (const [, text] of labelHelp(accept)) expect(text).not.toMatch(CJK);
    }
    const autoLabel = (a: GitHubRepoStatus['autoAccept'] | null) =>
      labelHelp(a).find(([label]) => label === 'ares1:auto')?.[1];
    expect(autoLabel(null)).toContain('max_risk and max_size decide');
    expect(autoLabel(partialRepo.autoAccept)).toContain(
      'now low-risk proposals of size S or M (max_risk: low, max_size: M)',
    );
    expect(autoLabel(autoRepo.autoAccept)).toContain(
      'now all proposals (max_risk: high, max_size: L)',
    );
    expect(labelHelp(null).find(([label]) => label === 'ares1:iteration')?.[1]).toContain(
      'Add ares1:ready to it to accept it as a whole',
    );
    const iterations = iterationGuide();
    expect(iterations).toHaveLength(5);
    for (const line of iterations) expect(line).not.toMatch(CJK);
    expect(iterations.join('\n')).toContain('at most 8, the last one the closing step');
    for (const row of noticeRows()) expect(row.handle).not.toMatch(CJK);
    expect(notifyChannel(true)).not.toMatch(CJK);
    expect(notifyChannel(false)).not.toMatch(CJK);
    expect(notifyChannel(true)).toContain('notify-send on Linux');
    expect(notifyChannel(false)).toContain('other platforms are not supported');
    for (const p of dataPaths('/h')) expect(p.what).not.toMatch(CJK);
    expect(startCommand(null, '/h')).toContain('cd <stable copy directory>');
  });

  it('says when and why it scouts, in English', () => {
    setLang('en');
    const now = new Date('2026-11-19T12:00:00');
    for (const github of [...repos, { ...manualRepo, scout }]) {
      const g = scoutGuide(inputEn(github), now);
      for (const text of [...g.conditions, g.now]) expect(text).not.toMatch(CJK);
    }
    expect(scoutGuide(inputEn(autoRepo), now).now).toBe(
      'All conditions are met; it scouts at the next check (every 5 minutes).',
    );
    expect(scoutGuide(inputEn(autoRepo), now).conditions).toContain(
      'Not backing off: after a scout finds nothing or fails it waits 5 minutes, twice as long for each further one in a row, up to 6 hours; a scout that finds work, or a new commit on the target branch, ends the wait',
    );
    expect(scoutGuide(inputEn(autoRepo), now).conditions).toContain(
      "Not waiting for the scout's agent's quota: running out of quota or being rate-limited is no failure and does not count toward the back-off; it waits until the reset time the CLI gave plus 1 minute, or without one 5, 10, 20, 40 minutes for the limits in a row, then every hour",
    );
    expect(
      scoutGuide({ ...inputEn(autoRepo), pollMinutes: 1 }, now).conditions.join('\n'),
    ).toContain('waits 1 minute,');
    const interval = (intervalMinutes: number) =>
      scoutGuide(inputEn({ ...partialRepo, scout: { ...scout, intervalMinutes } }), now);
    expect(interval(0).conditions).toContain('No minimum interval (interval_minutes: 0)');
    for (const [minutes, text] of [
      [1, '1 minute'],
      [15, '15 minutes'],
      [360, '6 hours'],
      [90, '1 hour 30 minutes'],
    ] as const) {
      const g = interval(minutes);
      expect(g.conditions).toContain(`At least ${text} since the last scout (interval_minutes)`);
      for (const c of g.conditions) expect(c).not.toMatch(CJK);
    }
    const steps = byId(inputEn({ ...partialRepo, scout: { ...scout, intervalMinutes: 90 } }));
    expect(steps.rescout?.text).toContain(', at least 1 hour 30 minutes apart,');
    expect(steps.rescout?.text).not.toMatch(CJK);
  });

  it("recognizes the scout's reasons in the Master's language, whatever the dashboard's", () => {
    setLang('en');
    const now = new Date('2026-11-19T12:00:00');
    const base = { working: true, upgrade: undefined, attention: 0, github: autoRepo };
    const waitingFor = (reason: string) => ({
      ...autoRepo,
      scout: { ...scout, waiting: { reason } },
    });
    const stopped = ['Stopped: click "Stopped" in the top bar to start working.'];
    for (const reason of ['工作开关已关闭', 'The work switch is off']) {
      expect(idleReasons({ ...base, working: false, github: waitingFor(reason) }, now)).toEqual(
        stopped,
      );
    }
    const stuck = idleReasons({ ...base, attention: 2 }, now);
    expect(stuck).toEqual([
      '2 Runs are waiting for your approval or blocked: they do not count among the executing Runs (up to concurrency.per_repo per repo), so queued Runs still start. Runs waiting only for you do not hold the automatic scout back, but count toward its limit (max_proposals) together with the proposals waiting for you, and it stops scouting once that is reached. Handle them under "Needs me" on the home page.',
    ]);
    expect(stuck.join('\n')).not.toMatch(/[一-鿿]/);
    expect(idleReasons({ ...base, github: waitingFor('5 proposals await you') }, now)).toEqual([
      'Automatic scouting is waiting: 5 proposals await you.',
    ]);
  });
});
