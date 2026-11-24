import { afterEach, describe, expect, it } from 'vitest';
import { setLang } from '../../../src/i18n.js';
import {
  acceptRanges,
  autoAcceptText,
  budgetText,
  CATEGORY,
  gapsByGoal,
  gapsHeading,
  issuesUrl,
  proposalKindsText,
  RISK,
  SCOUT_STATUS,
  scoutPlan,
  scoutWaitText,
  upgradeText,
} from './issues.js';

describe('issues display', () => {
  it('links to open issues with a label', () => {
    expect(issuesUrl('me/demo')).toBe('https://github.com/me/demo/issues?q=is%3Aissue%20is%3Aopen');
    expect(issuesUrl('me/demo', 'ares1:proposal')).toBe(
      'https://github.com/me/demo/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22ares1%3Aproposal%22',
    );
  });

  it('describes the scout plan and why it waits', () => {
    const scout = {
      agent: 'a',
      auto: true,
      intervalMinutes: 0,
      maxProposals: 5,
      running: false,
      lastAt: null,
      waiting: null,
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
    expect(autoAcceptText({ maxRisk: 'none', maxPerDay: null, usedToday: 0 })).toBe(
      '关闭：提案都由你采纳',
    );
    expect(autoAcceptText({ maxRisk: 'high', maxPerDay: null, usedToday: 3 })).toBe(
      'S、M 级提案；不限条数，今天 3 条',
    );
    expect(autoAcceptText({ maxRisk: 'low', maxPerDay: 2, usedToday: 1 })).toBe(
      '风险低的 S、M 级提案；每天最多 2 条，今天 1 条',
    );
  });

  it('words which proposals auto-accept takes and which it leaves to you, by the rule', () => {
    expect(acceptRanges('none')).toEqual({ auto: null, human: '所有提案' });
    expect(acceptRanges('low')).toEqual({
      auto: '风险低的 S、M 级提案',
      human: 'L 级提案和风险中、高的提案',
    });
    expect(acceptRanges('mid')).toEqual({
      auto: '风险低、中的 S、M 级提案',
      human: 'L 级提案和风险高的提案',
    });
    expect(acceptRanges('high')).toEqual({ auto: 'S、M 级提案', human: 'L 级提案' });
    expect(acceptRanges('none', () => true)).toEqual({ auto: '所有提案', human: null });
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
  };

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
    expect(autoAcceptText({ maxRisk: 'none', maxPerDay: null, usedToday: 0 })).toBe(
      'Off: you accept every proposal',
    );
    expect(autoAcceptText({ maxRisk: 'low', maxPerDay: 2, usedToday: 1 })).toBe(
      'low-risk proposals of size S or M; at most 2 a day, 1 today',
    );
    expect(acceptRanges('none')).toEqual({ auto: null, human: 'all proposals' });
    expect(acceptRanges('low')).toEqual({
      auto: 'low-risk proposals of size S or M',
      human: 'size L proposals and medium- or high-risk proposals',
    });
    expect(acceptRanges('mid')).toEqual({
      auto: 'low- or medium-risk proposals of size S or M',
      human: 'size L proposals and high-risk proposals',
    });
    expect(acceptRanges('high')).toEqual({
      auto: 'size S or M proposals',
      human: 'size L proposals',
    });
    expect(acceptRanges('none', () => true)).toEqual({ auto: 'all proposals', human: null });
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
