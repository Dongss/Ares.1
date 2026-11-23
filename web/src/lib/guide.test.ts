import { afterEach, describe, expect, it } from 'vitest';
import type { GitHubRepoStatus } from '../../../src/api/types.js';
import { TemplateSchema } from '../../../src/config/schema.js';
import { setLang } from '../../../src/i18n.js';
import { NOTICE_KINDS, type NoticeKind, noticeFor } from '../../../src/notify/notice.js';
import type { EventRow } from '../../../src/store/types.js';
import {
  ACTOR,
  acceptStep,
  autonomy,
  autonomyLevel,
  cycleSteps,
  dataPaths,
  GUIDE_SECTIONS,
  type GuideInput,
  guardrails,
  idleReasons,
  isGuideSection,
  issueFlow,
  labelHelp,
  mergeNeedsApproval,
  noticeRows,
  notifyChannel,
  runStages,
  scoutGuide,
  shellQuote,
  startCommand,
  stopCommand,
} from './guide.js';

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
  agents: [
    { id: 'claude-coder', model: 'opus', effort: 'xhigh' as const, args: [] },
    { id: 'claude-reviewer', model: 'opus', args: [] },
  ],
} as unknown as Parameters<typeof issueFlow>[0];

const scout: NonNullable<GitHubRepoStatus['scout']> = {
  agent: 'claude-reviewer',
  auto: true,
  intervalHours: 0,
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
  autoAccept: { maxRisk: 'none', maxPerDay: null, usedToday: 0 },
  autoMerge: false,
  budget: { dailyUsd: null, spentToday: 0, reached: false },
  push: false,
  maxRunAttempts: 3,
};

/** Everything handed over: idle scouts, any risk accepted, merged, pushed, upgraded. */
const autoRepo: GitHubRepoStatus = {
  ...manualRepo,
  scout,
  autoAccept: { maxRisk: 'high', maxPerDay: null, usedToday: 2 },
  autoMerge: true,
  budget: { dailyUsd: 20, spentToday: 3.2, reached: false },
  push: true,
};

/** Some of it: low risk accepted, merge still approved, pushed, no upgrades. */
const partialRepo: GitHubRepoStatus = {
  ...manualRepo,
  scout: { ...scout, intervalHours: 6 },
  autoAccept: { maxRisk: 'low', maxPerDay: 3, usedToday: 1 },
  push: true,
};

const off: GuideInput['upgrade'] = { auto: false, installDir: null };
const on: GuideInput['upgrade'] = { auto: true, installDir: '/Users/me/ares1-stable' };

function input(github: GitHubRepoStatus | null, upgrade = off): GuideInput {
  return {
    github,
    pollMinutes: 5,
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
  });

  it('hands every step to the AI or the Master when everything is automatic', () => {
    const steps = byId(input(autoRepo, on));
    expect(steps.scout?.actors).toEqual(['ai']);
    expect(steps.scout?.text).toBe(
      'claude-reviewer 只读地看代码、文档和最近的 Run 记录，找值得做的事',
    );
    expect(steps.propose?.text).toContain('一次最多 5 条');
    // Size L proposals always wait for a human.
    expect(steps.accept?.actors).toEqual(['master', 'human']);
    expect(steps.accept?.text).toBe(
      'S、M 级提案自动采纳（加 ares1:ready 和 ares1:auto）；当天自动花费到 $20.00 后暂停，第二天自动继续采纳积压的提案；L 级提案由你来做：加 ares1:ready 或关闭',
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
    expect(steps.rescout?.text).toContain('两次至少隔 6 小时');
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

  it('works without GitHub', () => {
    const steps = byId(input(null));
    expect(steps.scout?.text).toContain('还没有接入 GitHub');
    expect(steps.propose?.text).toContain('需求只从 GitHub issue 来');
    expect(steps.propose?.text).toContain('配置 github');
    expect(steps.run?.text).toContain('建不了 Run');
    expect(steps.push?.text).toBe('由你来做：合并只到本地的目标分支（main），需要时自己 git push');
    expect(runStages(input(null))).toBeNull();
  });

  it('says when the template of the issues is missing', () => {
    const broken = { ...manualRepo, template: 'gone' };
    const i = input(broken);
    expect(i.flow).toBeNull();
    expect(byId(i).run?.text).toContain('模板「gone」不存在或无效');
  });
});

describe('the accept step', () => {
  afterEach(() => setLang('zh'));

  const CJK = /[一-鿿]/;
  const withRisk = (maxRisk: GitHubRepoStatus['autoAccept']['maxRisk']): GitHubRepoStatus => ({
    ...autoRepo,
    autoAccept: { ...autoRepo.autoAccept, maxRisk },
  });
  /** A rule that accepts every proposal: no setting of the current rule leaves none to you. */
  const all = () => true;

  it('leaves every proposal to you with max_risk: none', () => {
    const step = acceptStep(withRisk('none'));
    expect(step.actors).toEqual(['human']);
    expect(step.text.startsWith('所有提案都由你来做：')).toBe(true);
    expect(step.text).not.toContain('自动采纳');
  });

  it('leaves only size L proposals to you with max_risk: high', () => {
    const step = acceptStep(withRisk('high'));
    expect(step.actors).toEqual(['master', 'human']);
    expect(step.text).toContain('S、M 级提案自动采纳');
    expect(step.text).toContain('；L 级提案由你来做：加 ares1:ready 或关闭');
    expect(step.text).not.toContain('其余');
  });

  it('is up to the Master alone when no proposal needs you', () => {
    const step = acceptStep(withRisk('high'), all);
    expect(step.actors).toEqual(['master']);
    expect(step.text).toBe(
      '所有提案自动采纳（加 ares1:ready 和 ares1:auto）；当天自动花费到 $20.00 后暂停，第二天自动继续采纳积压的提案',
    );
    expect(step.text).not.toContain('由你来做');
    // The cycle and the summary of what is left to you follow the same rule.
    const i = input(withRisk('high'));
    expect(cycleSteps(i, all).find((s) => s.id === 'accept')).toEqual(step);
    expect(autonomy(i, all).auto).toContain('采纳所有提案');
    expect(autonomy(i, all).you.join()).not.toContain('采纳');
  });

  it('says the daily limits only pause it until the next day', () => {
    const both = {
      ...withRisk('low'),
      autoAccept: { maxRisk: 'low' as const, maxPerDay: 3, usedToday: 0 },
    };
    expect(acceptStep(both).text).toContain(
      '；当天自动采纳满 3 条或自动花费到 $20.00 后暂停，第二天自动继续采纳积压的提案；',
    );
    const noLimit = { ...withRisk('high'), budget: { ...autoRepo.budget, dailyUsd: null } };
    expect(acceptStep(noLimit).text).toBe(
      'S、M 级提案自动采纳（加 ares1:ready 和 ares1:auto）；L 级提案由你来做：加 ares1:ready 或关闭',
    );
    for (const github of [both, noLimit, withRisk('high')]) {
      expect(acceptStep(github).text).not.toContain('就停');
    }
  });

  it('words the same in English', () => {
    setLang('en');
    expect(acceptStep(withRisk('none')).text).toBe(
      'All proposals are up to you: label the issues to do with ares1:ready; close the others as not planned with a one-line reason',
    );
    expect(acceptStep(withRisk('high')).text).toBe(
      'Accepted automatically: size S or M proposals (labeled ares1:ready and ares1:auto); once automatic spending reaches $20.00 in a day, it pauses for the rest of the day and accepts the backlog by itself the next day. Up to you: size L proposals; add ares1:ready or close them',
    );
    const one = {
      ...withRisk('mid'),
      autoAccept: { maxRisk: 'mid' as const, maxPerDay: 1, usedToday: 0 },
    };
    expect(acceptStep(one).text).toContain(
      'once 1 proposal is accepted or automatic spending reaches $20.00 in a day,',
    );
    expect(acceptStep(one).text).toContain('Up to you: size L proposals and high-risk proposals;');
    const none = acceptStep(withRisk('high'), all);
    expect(none.actors).toEqual(['master']);
    expect(none.text).not.toContain('Up to you');
    for (const github of [null, withRisk('none'), withRisk('low'), withRisk('mid'), one]) {
      expect(acceptStep(github).text).not.toMatch(CJK);
    }
    expect(none.text).not.toMatch(CJK);
  });
});

describe('the Run stages', () => {
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
        '采纳 S、M 级提案',
        '合并',
        '推送到 GitHub',
        '升级 Master',
      ],
      // Size L proposals always wait for a human.
      you: ['采纳 L 级提案'],
    });
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
    expect(g.conditions).toContain('不限间隔（interval_hours: 0）');
    expect(g.conditions).toContain(
      '不在退避：侦察没找到需求或失败后先等 5 分钟，连续每多一次等待翻倍，最长 6 小时；有侦察找到了需求，或目标分支有了新提交，就不再等',
    );
    expect(g.conditions).toContain(
      '不在等侦察的 Agent 恢复额度：额度用尽或被限流不算失败，也不计入退避；CLI 给了额度重置时间就等到那时再多等 1 分钟，没给就按连续被限流的次数等 5、10、20、40 分钟，之后每次 1 小时',
    );
    expect(g.conditions).toContain(
      '仓库没有会自己往下走的 Run（排队、执行中、等评估回复且设了超时，或等目标分支上的改动清掉后自动合并）：手上的活做完了才找新活；只等人的 Run 不用等，算进下面的上限',
    );
    expect(g.conditions).toContain(
      '在自动采纳范围内、还没采纳的提案加上卡住等人的 Run 少于 5 个（max_proposals）；L 级提案留给你处理，不挡侦察',
    );
    expect(g.now).toBe('条件都满足，下次检查（每 5 分钟）时就会侦察。');
    expect(g.waiting).toBe(false);

    const p = scoutGuide(input(partialRepo), now);
    expect(p.conditions).toContain('距上次侦察满 6 小时（interval_hours）');
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
    expect(scoutGuide(input(null), now).now).toBe('还没有接入 GitHub，不会自己找活。');
  });
});

describe('notifications', () => {
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
      ['github', ev('github.error', { message: 'x' }, null)],
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
    expect(auto(partialRepo.autoAccept)).toContain('现在是风险低的 S、M 级提案（max_risk: low）');
    expect(auto(autoRepo.autoAccept)).toContain('现在是 S、M 级提案（max_risk: high）');
    expect(auto(manualRepo.autoAccept)).toContain('现在自动采纳关闭');
    expect(auto(null)).toContain('由 max_risk 决定');
    expect(labelHelp(null).map(([label]) => label)).toEqual([
      'ares1:proposal',
      'ares1:ready',
      'ares1:running',
      'ares1:needs-you',
      'ares1:failed',
      'ares1:auto',
    ]);
  });

  it('says which channel sends them', () => {
    expect(notifyChannel(true)).toContain('Master 直接发系统通知');
    expect(notifyChannel(false)).toContain('浏览器');
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
      '有 1 个 Run 在等你审批或卡住了：它们让出了执行位；只等人的 Run 不挡自动侦察，但和等你处理的提案一起计入上限（max_proposals），攒满后不再侦察。到首页「待我处理」处理。';
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
  const repos = [null, manualRepo, partialRepo, autoRepo];

  it('words the loop, its stages and what is left to you without Chinese', () => {
    setLang('en');
    for (const github of repos) {
      for (const upgrade of [off, on, { auto: true, installDir: null }]) {
        const i = inputEn(github, upgrade);
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
    expect(runStages(inputEn(manualRepo))?.find((s) => s.id === 'e2e')?.name).toBe(
      'E2E (placeholder)',
    );
    expect(autonomy(inputEn(autoRepo, on))).toMatchObject({
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
    for (const accept of [null, manualRepo.autoAccept, partialRepo.autoAccept]) {
      for (const [, text] of labelHelp(accept)) expect(text).not.toMatch(CJK);
    }
    for (const row of noticeRows()) expect(row.handle).not.toMatch(CJK);
    expect(notifyChannel(true)).not.toMatch(CJK);
    expect(notifyChannel(false)).not.toMatch(CJK);
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
      '2 Runs are waiting for your approval or blocked: they free the execution slot. Runs waiting only for you do not hold the automatic scout back, but count toward its limit (max_proposals) together with the proposals waiting for you, and it stops scouting once that is reached. Handle them under "Needs me" on the home page.',
    ]);
    expect(stuck.join('\n')).not.toMatch(/[一-鿿]/);
    expect(idleReasons({ ...base, github: waitingFor('5 proposals await you') }, now)).toEqual([
      'Automatic scouting is waiting: 5 proposals await you.',
    ]);
  });
});
