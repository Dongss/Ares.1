import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { type ProposalSize, type Risk, repoDeliversByPr } from '../../../src/config/flow.js';
import { BacklogSchema, GitHubSchema, GitLabSchema } from '../../../src/config/schema.js';
import { setLang } from '../../../src/i18n.js';
import {
  acceptRanges,
  autoAcceptText,
  backlogExample,
  budgetText,
  CATEGORY,
  deliveryText,
  GITHUB,
  gapsByGoal,
  gapsHeading,
  githubExample,
  gitlabExample,
  hostLabel,
  issuesUrl,
  issueUrl,
  newIssueUrl,
  platformName,
  proposalKindsText,
  RISK,
  SCOUT_STATUS,
  scoutGoalBlocker,
  scoutGoalText,
  scoutPlan,
  scoutWaitText,
  upgradeText,
} from './issues.js';

describe('links to a code host', () => {
  afterEach(() => setLang('zh'));
  const gitlab = { platform: 'gitlab', host: 'gitlab.example.com:8443' } as const;

  it('links to open issues on GitHub, with a label', () => {
    expect(issuesUrl(GITHUB, 'me/demo')).toBe(
      'https://github.com/me/demo/issues?q=is%3Aissue%20is%3Aopen',
    );
    expect(issuesUrl(GITHUB, 'me/demo', 'ares1:proposal')).toBe(
      'https://github.com/me/demo/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22ares1%3Aproposal%22',
    );
    expect(newIssueUrl(GITHUB, 'me/demo', 'ares1:ready')).toBe(
      'https://github.com/me/demo/issues/new?labels=ares1%3Aready',
    );
    expect(issueUrl(GITHUB, 'me/demo', 12)).toBe('https://github.com/me/demo/issues/12');
  });

  it('links to open issues on GitLab, by its host and the project path with subgroups', () => {
    expect(issuesUrl(gitlab, 'grp/sub/demo')).toBe(
      'https://gitlab.example.com:8443/grp/sub/demo/-/issues?state=opened',
    );
    expect(issuesUrl(gitlab, 'grp/sub/demo', 'ares1:proposal')).toBe(
      'https://gitlab.example.com:8443/grp/sub/demo/-/issues?state=opened&label_name[]=ares1%3Aproposal',
    );
    expect(issueUrl(gitlab, 'grp/sub/demo', 12)).toBe(
      'https://gitlab.example.com:8443/grp/sub/demo/-/issues/12',
    );
    // gitlab.com when the status gives no host.
    expect(issueUrl({ platform: 'gitlab', host: null }, 'grp/demo', 3)).toBe(
      'https://gitlab.com/grp/demo/-/issues/3',
    );
  });

  it('opens a new GitLab issue with the label added by a quick action', () => {
    const url = newIssueUrl(gitlab, 'grp/sub/demo', 'ares1:ready');
    expect(url).toBe(
      'https://gitlab.example.com:8443/grp/sub/demo/-/issues/new?issue[description]=%2Flabel%20~%22ares1%3Aready%22',
    );
    expect(new URL(url).searchParams.get('issue[description]')).toBe('/label ~"ares1:ready"');
  });

  it('names the platform, GitLab with its host, in both languages', () => {
    expect(platformName('github')).toBe('GitHub');
    expect(platformName('gitlab')).toBe('GitLab');
    expect(hostLabel(GITHUB)).toBe('GitHub');
    expect(hostLabel(gitlab)).toBe('GitLab（gitlab.example.com:8443）');
    expect(hostLabel({ platform: 'gitlab', host: null })).toBe('GitLab（gitlab.com）');
    setLang('en');
    expect(hostLabel(gitlab)).toBe('GitLab (gitlab.example.com:8443)');
  });
});

describe('config.yaml examples', () => {
  afterEach(() => setLang('zh'));

  it('are valid sections of config.yaml in both languages', () => {
    for (const lang of ['zh', 'en'] as const) {
      setLang(lang);
      const github = GitHubSchema.parse(parseYaml(githubExample()).github);
      expect(github.repos['my-repo']).toMatchObject({ template: 'self-dev', push: false });
      const gitlab = GitLabSchema.parse(parseYaml(gitlabExample()).gitlab);
      expect(gitlab).toMatchObject({ host: 'gitlab.com', poll_minutes: 5 });
      expect(gitlab.repos['my-repo']).toMatchObject({
        issues_repo: 'my-group/my-repo',
        template: 'self-dev',
        deliver: 'push',
      });
      const backlog = BacklogSchema.parse(parseYaml(backlogExample()).backlog);
      expect(Object.keys(backlog.repos)).toEqual(['my-local-repo']);
      // Each section shows its own way of delivering through change requests, commented out.
      expect(githubExample()).toContain('# deliver: pr');
      expect(gitlabExample()).toContain('# deliver: mr');
      expect(gitlabExample()).not.toContain('deliver: pr');
    }
  });

  it('say in English that a repo has one source, with no Chinese left', () => {
    setLang('en');
    expect(gitlabExample()).toContain('not one of github.repos or backlog.repos');
    expect(backlogExample()).toContain('not one of github.repos or gitlab.repos');
    for (const text of [githubExample(), gitlabExample(), backlogExample()]) {
      expect(text).not.toMatch(/[一-鿿]/);
    }
  });
});

describe('issues display', () => {
  it('describes the scout plan and why it waits', () => {
    const scout = {
      agent: 'a',
      auto: true,
      intervalMinutes: 0,
      maxProposals: 5,
      running: false,
      lastAt: null,
      waiting: null,
      openIteration: null,
    };
    expect(scoutPlan(scout)).toBe('没有在进行中的 Run 时自动侦察（只等人的 Run 不挡）');
    expect(scoutPlan({ ...scout, intervalMinutes: 360 })).toBe(
      '没有在进行中的 Run 时自动侦察（只等人的 Run 不挡），至少间隔 6 小时',
    );
    expect(scoutPlan({ ...scout, intervalMinutes: 15 })).toMatch(/，至少间隔 15 分钟$/);
    expect(scoutPlan({ ...scout, intervalMinutes: 90 })).toMatch(/，至少间隔 1 小时 30 分钟$/);
    expect(scoutPlan({ ...scout, auto: false })).toBe('只在这里手动触发');
    const now = new Date('2026-11-19T12:00:00');
    expect(scoutWaitText(null, now)).toBeNull();
    expect(scoutWaitText({ reason: '有 5 条提案等你处理' }, now)).toBe('有 5 条提案等你处理');
    expect(
      scoutWaitText(
        {
          reason: '离上次侦察不到设定的间隔',
          until: new Date('2026-11-19T18:00:00').toISOString(),
        },
        now,
      ),
    ).toBe('离上次侦察不到设定的间隔（18:00:00 之后）');
    expect(
      scoutWaitText(
        {
          reason: '侦察遇到额度用尽或限流，等额度恢复',
          until: new Date('2026-11-20T09:01:00').toISOString(),
        },
        now,
      ),
    ).toBe('侦察遇到额度用尽或限流，等额度恢复（11-20 09:01 之后）');
  });

  it("says why a scout takes no direction while an iteration is under way, and shows a scout's", () => {
    expect(scoutGoalBlocker({ openIteration: null })).toBeNull();
    const blocker = scoutGoalBlocker({ openIteration: { id: 'it-1', title: '导出报表' } });
    expect(blocker).toContain('迭代「导出报表」进行中');
    expect(blocker).toContain('等它完成或终止它');
    expect(scoutGoalText(null)).toBeNull();
    expect(scoutGoalText('支持导出报表')).toBe('方向：支持导出报表');
  });

  it('shows a scout whose agent ran out of quota apart from a failed one', () => {
    expect(SCOUT_STATUS.rate_limited).toMatchObject({ label: '额度用尽/限流', tone: 'attention' });
    expect(SCOUT_STATUS.failed.tone).toBe('danger');
  });

  it('describes limits', () => {
    expect(budgetText({ dailyUsd: 20, spentToday: 3.2, reached: false })).toBe('$3.20 / $20.00');
    expect(budgetText({ dailyUsd: 20, spentToday: 21, reached: true })).toContain('已达上限');
    expect(budgetText({ dailyUsd: null, spentToday: 21, reached: false })).toBe(
      '$21.00（不设上限）',
    );
    expect(autoAcceptText({ maxRisk: 'none', maxSize: 'L', maxPerDay: null, usedToday: 0 })).toBe(
      '关闭：提案都由你采纳',
    );
    expect(autoAcceptText({ maxRisk: 'high', maxSize: 'L', maxPerDay: null, usedToday: 3 })).toBe(
      '所有提案；不限条数，今天 3 条',
    );
    expect(autoAcceptText({ maxRisk: 'high', maxSize: 'M', maxPerDay: null, usedToday: 3 })).toBe(
      'S、M 级提案；不限条数，今天 3 条',
    );
    expect(autoAcceptText({ maxRisk: 'low', maxSize: 'L', maxPerDay: 2, usedToday: 1 })).toBe(
      '风险低的提案；每天最多 2 条，今天 1 条',
    );
  });

  it('words which proposals auto-accept takes and which it leaves to you, by the rule', () => {
    const ranges = (maxRisk: Risk | 'none', maxSize: ProposalSize = 'L') =>
      acceptRanges({ maxRisk, maxSize });
    expect(ranges('none')).toEqual({ auto: null, human: '所有提案' });
    expect(ranges('none', 'S')).toEqual({ auto: null, human: '所有提案' });
    expect(ranges('low')).toEqual({ auto: '风险低的提案', human: '风险中、高的提案' });
    expect(ranges('mid')).toEqual({ auto: '风险低、中的提案', human: '风险高的提案' });
    expect(ranges('high')).toEqual({ auto: '所有提案', human: null });
    expect(ranges('high', 'M')).toEqual({ auto: 'S、M 级提案', human: 'L 级提案' });
    expect(ranges('low', 'M')).toEqual({
      auto: '风险低的 S、M 级提案',
      human: 'L 级提案和风险中、高的提案',
    });
    expect(ranges('mid', 'S')).toEqual({
      auto: '风险低、中的 S 级提案',
      human: 'M、L 级提案和风险高的提案',
    });
    expect(acceptRanges({ maxRisk: 'none', maxSize: 'L' }, () => true)).toEqual({
      auto: '所有提案',
      human: null,
    });
    // Whatever is left after whole sizes and risks is worded by risk.
    expect(
      proposalKindsText([
        { risk: 'high', size: 'S' },
        { risk: 'high', size: 'M' },
        { risk: 'high', size: 'L' },
        { risk: 'low', size: 'M' },
        { risk: 'mid', size: 'S' },
      ]),
    ).toBe('风险高的提案、风险低的 M 级提案和风险中的 S 级提案');
    expect(proposalKindsText([])).toBeNull();
  });

  it('describes the upgrade state', () => {
    const base = {
      auto: true,
      installDir: '/x',
      current: 'aaaaaaa1',
      latest: 'aaaaaaa1',
      message: null,
      checkedAt: null,
    };
    expect(upgradeText({ ...base, state: 'up_to_date' })).toBe('已是最新（aaaaaaa）');
    expect(
      upgradeText({
        ...base,
        state: 'waiting',
        latest: 'bbbbbbb2',
        message: '等正在执行的工作做完再升级',
      }),
    ).toBe('有新版本，等待中（aaaaaaa → bbbbbbb）：等正在执行的工作做完再升级');
  });
});

describe("a scout's gap analysis", () => {
  afterEach(() => setLang('zh'));

  const gaps = [
    { goal: '永动', gap: '同一时间只跑一个 Run', evidence: ['src/engine/engine.ts:421'] },
    { goal: '适用于构建任何项目', gap: '内置的 CLI 只有两种', evidence: ['src/master.ts'] },
    { goal: ' 永动 ', gap: '模板的 planning: llm 没有实现', evidence: ['a.ts:1', 'b.ts:2'] },
  ];

  it('groups the gaps by goal, in the order the goals first come', () => {
    expect(gapsByGoal(gaps)).toEqual([
      { goal: '永动', gaps: [gaps[0], gaps[2]] },
      { goal: '适用于构建任何项目', gaps: [gaps[1]] },
    ]);
    expect(gapsByGoal([])).toEqual([]);
  });

  it('puts goals differing only in whitespace or trailing punctuation in one group', () => {
    const gap = (goal: string, text: string) => ({ goal, gap: text, evidence: ['a.ts:1'] });
    const loose = [
      gap(' 适用于构建 任何项目', 'a'),
      gap('Can build any project', 'b'),
      gap('适用于构建任何项目。', 'c'),
      gap('Can build  any project.', 'd'),
      gap('适用于构建　任何项目；', 'e'),
      gap('Can build any project!?', 'f'),
      gap('永动', 'g'),
      gap('永动机', 'h'),
      gap('can build any project', 'i'),
    ];
    expect(gapsByGoal(loose)).toEqual([
      // Headed by the first gap's goal, trimmed; gaps keep their order.
      { goal: '适用于构建 任何项目', gaps: [loose[0], loose[2], loose[4]] },
      { goal: 'Can build any project', gaps: [loose[1], loose[3], loose[5]] },
      // No merging by meaning or case.
      { goal: '永动', gaps: [loose[6]] },
      { goal: '永动机', gaps: [loose[7]] },
      { goal: 'can build any project', gaps: [loose[8]] },
    ]);
    expect(gapsHeading(loose)).toBe('差距分析：9 个缺口，涉及 5 个目标');
  });

  it('heads it with the counts, and tells a scout without one from one that found nothing', () => {
    expect(gapsHeading(gaps)).toBe('差距分析：3 个缺口，涉及 2 个目标');
    expect(gapsHeading([])).toBe('差距分析：没有找到能力缺口');
    expect(gapsHeading(null)).toBeNull();
  });

  it('says so in English, with one gap or more', () => {
    setLang('en');
    expect(gapsHeading(gaps)).toBe('Gap analysis: 3 gaps across 2 goals');
    expect(gapsHeading(gaps.slice(0, 1))).toBe('Gap analysis: 1 gap across 1 goal');
    expect(gapsHeading([])).toBe('Gap analysis: no capability gaps found');
  });
});

describe('issues display in English', () => {
  afterEach(() => setLang('zh'));

  const cjk = /[\u4e00-\u9fff]/;
  const scout = {
    agent: 'a',
    auto: true,
    intervalMinutes: 60,
    maxProposals: 5,
    running: false,
    lastAt: null,
    waiting: null,
    openIteration: null,
  };

  it("says in English why a scout takes no direction now, and shows a scout's", () => {
    setLang('en');
    const blocker = scoutGoalBlocker({ openIteration: { id: 'it-1', title: 'Export reports' } });
    expect(blocker).toBe(
      'The iteration "Export reports" is under way: until it is over, a scout plans no other iteration and only proposes problems, so it takes no direction. Give one once the iteration is done or cancelled; a scout started now goes without.',
    );
    expect(scoutGoalText('Export reports')).toBe('Direction: Export reports');
    for (const text of [blocker, scoutGoalText('Export reports')]) {
      expect(text).not.toMatch(cjk);
    }
  });

  it('describes the scout plan, limits and the upgrade state in English', () => {
    setLang('en');
    expect(scoutPlan(scout)).toBe(
      'Scouts by itself when no Run is in progress (Runs waiting only for you do not hold it back), at least 1 hour apart',
    );
    expect(scoutPlan({ ...scout, intervalMinutes: 360 })).toContain('at least 6 hours apart');
    expect(scoutPlan({ ...scout, intervalMinutes: 1 })).toMatch(/, at least 1 minute apart$/);
    expect(scoutPlan({ ...scout, intervalMinutes: 15 })).toMatch(/, at least 15 minutes apart$/);
    expect(scoutPlan({ ...scout, intervalMinutes: 90 })).toMatch(
      /, at least 1 hour 30 minutes apart$/,
    );
    for (const intervalMinutes of [0, 1, 15, 60, 90, 360]) {
      expect(scoutPlan({ ...scout, intervalMinutes })).not.toMatch(cjk);
    }
    expect(scoutPlan({ ...scout, auto: false })).toBe('Only when started here');
    expect(budgetText({ dailyUsd: null, spentToday: 21, reached: false })).toBe(
      '$21.00 (no limit)',
    );
    expect(budgetText({ dailyUsd: 20, spentToday: 21, reached: true })).toContain('limit reached');
    expect(autoAcceptText({ maxRisk: 'none', maxSize: 'L', maxPerDay: null, usedToday: 0 })).toBe(
      'Off: you accept every proposal',
    );
    expect(autoAcceptText({ maxRisk: 'low', maxSize: 'L', maxPerDay: 2, usedToday: 1 })).toBe(
      'low-risk proposals; at most 2 a day, 1 today',
    );
    expect(autoAcceptText({ maxRisk: 'low', maxSize: 'M', maxPerDay: 2, usedToday: 1 })).toBe(
      'low-risk proposals of size S or M; at most 2 a day, 1 today',
    );
    const ranges = (maxRisk: Risk | 'none', maxSize: ProposalSize = 'L') =>
      acceptRanges({ maxRisk, maxSize });
    expect(ranges('none')).toEqual({ auto: null, human: 'all proposals' });
    expect(ranges('low')).toEqual({
      auto: 'low-risk proposals',
      human: 'medium- or high-risk proposals',
    });
    expect(ranges('mid')).toEqual({
      auto: 'low- or medium-risk proposals',
      human: 'high-risk proposals',
    });
    expect(ranges('high')).toEqual({ auto: 'all proposals', human: null });
    expect(ranges('low', 'M')).toEqual({
      auto: 'low-risk proposals of size S or M',
      human: 'size L proposals and medium- or high-risk proposals',
    });
    expect(ranges('mid', 'M')).toEqual({
      auto: 'low- or medium-risk proposals of size S or M',
      human: 'size L proposals and high-risk proposals',
    });
    expect(ranges('high', 'M')).toEqual({
      auto: 'size S or M proposals',
      human: 'size L proposals',
    });
    expect(ranges('mid', 'S')).toEqual({
      auto: 'low- or medium-risk proposals of size S',
      human: 'size M or L proposals and high-risk proposals',
    });
    expect(acceptRanges({ maxRisk: 'none', maxSize: 'L' }, () => true)).toEqual({
      auto: 'all proposals',
      human: null,
    });
    expect(
      upgradeText({
        auto: true,
        installDir: '/x',
        current: 'aaaaaaa1',
        latest: 'bbbbbbb2',
        message: 'waiting for work to finish',
        checkedAt: null,
        state: 'waiting',
      }),
    ).toBe('New version available, waiting (aaaaaaa → bbbbbbb): waiting for work to finish');
  });

  it('picks labels in the language in use when they are read', () => {
    expect(SCOUT_STATUS.running.label).toBe('侦察中');
    setLang('en');
    const labels = [
      ...Object.values(SCOUT_STATUS).map((s) => s.label),
      ...Object.values(RISK).map((r) => r.label),
      ...Object.values(CATEGORY),
    ];
    for (const label of labels) expect(label).not.toMatch(cjk);
    expect(SCOUT_STATUS.rate_limited).toMatchObject({
      label: 'Out of quota / rate-limited',
      tone: 'attention',
    });
    expect(RISK.mid).toMatchObject({ label: 'Medium risk', tone: 'attention' });
    expect(CATEGORY.bug).toBe('Bug');
  });
});

describe('how a repo delivers', () => {
  afterEach(() => setLang('zh'));

  it('tells pushing the target branch from pull requests', () => {
    expect(deliveryText({ deliver: 'push', push: true })).toBe(
      '推送：合并到本地目标分支后自动推送',
    );
    expect(deliveryText({ deliver: 'push', push: false })).toBe(
      '推送：只合并到本地目标分支，由你推送',
    );
    expect(deliveryText({ deliver: 'pr', push: true })).toBe(
      'PR：推送 Run 的分支、开合并到目标分支的 PR，在 GitHub 上合并后 Run 完成；目标分支不由 Master 推送',
    );
    // deliver: pr without push disables the repo.
    expect(deliveryText({ deliver: 'pr', push: false })).toContain('这个仓库现在停用');
  });

  it('tells a GitLab repo delivering through merge requests', () => {
    expect(deliveryText({ deliver: 'mr', push: true })).toBe(
      'MR：推送 Run 的分支、开合并到目标分支的 MR，在 GitLab 上合并后 Run 完成；目标分支不由 Master 推送',
    );
    // deliver: mr without push disables the repo, as deliver: pr does.
    expect(deliveryText({ deliver: 'mr', push: false })).toBe(
      'MR，但没开 push：deliver: mr 要配 push: true，这个仓库现在停用',
    );
  });

  it('names a change request for exactly the repos repoDeliversByPr says deliver through one', () => {
    for (const deliver of ['push', 'pr', 'mr'] as const) {
      for (const push of [true, false]) {
        const text = deliveryText({ deliver, push });
        expect(/^(PR|MR)/.test(text), `${deliver} ${push}`).toBe(repoDeliversByPr({ deliver }));
      }
    }
  });

  it('in English', () => {
    setLang('en');
    const texts = (['push', 'pr', 'mr'] as const).flatMap((deliver) =>
      [true, false].map((push) => deliveryText({ deliver, push })),
    );
    expect(texts[2]).toContain('the Master never pushes the target branch');
    expect(texts[4]).toBe(
      "Merge request: the Run's branch is pushed with a merge request into the target branch, and the Run completes once it is merged on GitLab; the Master never pushes the target branch",
    );
    expect(texts[5]).toBe(
      'Merge request, but push is off: deliver: mr needs push: true, so the repo is disabled now',
    );
    for (const text of texts) expect(text).not.toMatch(/[一-鿿]/);
    // GitHub's words stay out of a GitLab repo's.
    for (const text of texts.slice(4)) expect(text).not.toMatch(/GitHub|pull request|deliver: pr/);
  });
});
