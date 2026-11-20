import { afterEach, describe, expect, it } from 'vitest';
import { setLang } from '../../../src/i18n.js';
import {
  autoAcceptText,
  budgetText,
  CATEGORY,
  issuesUrl,
  RISK,
  RISK_UP_TO,
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
      intervalHours: 0,
      maxProposals: 5,
      running: false,
      lastAt: null,
      waiting: null,
    };
    expect(scoutPlan(scout)).toBe('没有未结束的 Run 时自动侦察');
    expect(scoutPlan({ ...scout, intervalHours: 6 })).toBe(
      '没有未结束的 Run 时自动侦察，至少间隔 6 小时',
    );
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
      '所有风险、一个 Run 能做完的提案；不限条数，今天 3 条',
    );
    expect(autoAcceptText({ maxRisk: 'low', maxPerDay: 2, usedToday: 1 })).toBe(
      '风险低、一个 Run 能做完的提案；每天最多 2 条，今天 1 条',
    );
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

describe('issues display in English', () => {
  afterEach(() => setLang('zh'));

  const cjk = /[\u4e00-\u9fff]/;
  const scout = {
    agent: 'a',
    auto: true,
    intervalHours: 1,
    maxProposals: 5,
    running: false,
    lastAt: null,
    waiting: null,
  };

  it('describes the scout plan, limits and the upgrade state in English', () => {
    setLang('en');
    expect(scoutPlan(scout)).toBe(
      'Scouts by itself when no Run is unfinished, at least 1 hour apart',
    );
    expect(scoutPlan({ ...scout, intervalHours: 6 })).toContain('at least 6 hours apart');
    expect(scoutPlan({ ...scout, auto: false })).toBe('Only when started here');
    expect(budgetText({ dailyUsd: null, spentToday: 21, reached: false })).toBe(
      '$21.00 (no limit)',
    );
    expect(budgetText({ dailyUsd: 20, spentToday: 21, reached: true })).toContain('limit reached');
    expect(autoAcceptText({ maxRisk: 'none', maxPerDay: null, usedToday: 0 })).toBe(
      'Off: you accept every proposal',
    );
    expect(autoAcceptText({ maxRisk: 'low', maxPerDay: 2, usedToday: 1 })).toBe(
      'low-risk proposals one Run can finish; at most 2 a day, 1 today',
    );
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
      ...Object.values(RISK_UP_TO),
    ];
    for (const label of labels) expect(label).not.toMatch(cjk);
    expect(RISK.mid).toMatchObject({ label: 'Medium risk', tone: 'attention' });
    expect(CATEGORY.bug).toBe('Bug');
  });
});
