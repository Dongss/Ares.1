import { afterEach, describe, expect, it } from 'vitest';
import type { GitHubRepoStatus } from '../../../src/api/types.js';
import { TemplateSchema } from '../../../src/config/schema.js';
import { setLang } from '../../../src/i18n.js';
import { NOTICE_KINDS, type NoticeKind, noticeFor } from '../../../src/notify/notice.js';
import type { EventRow } from '../../../src/store/types.js';
import {
  ACTOR,
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
    expect(steps.accept?.text).toContain('由你来做：给要做的 issue 加 ares1:ready');
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
      '所有风险、大小不是 L 的提案自动采纳（加 ares1:ready 和 ares1:auto），当天自动花费到 $20.00 就停；其余的由你来做：加 ares1:ready 或关闭',
    );
    expect(steps.run?.actors).toEqual(['ai', 'master']);
    expect(steps.push?.actors).toEqual(['master']);
    expect(steps.push?.text).toContain('推送到 GitHub');
    expect(steps.upgrade?.actors).toEqual(['master']);
    expect(steps.rescout?.actors).toEqual(['ai']);
    expect(steps.rescout?.text).toBe(
      '仓库没有未结束的 Run 时，下次检查（每 5 分钟）就再侦察，参考新的 Run 记录和被拒的 issue',
    );
  });

  it('mixes the two when partly automatic', () => {
    const steps = byId(input(partialRepo));
    expect(steps.accept?.text).toContain('风险低、大小不是 L 的提案自动采纳');
    expect(steps.accept?.text).toContain('每天最多 3 条');
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
        '采纳所有风险的提案',
        '合并',
        '推送到 GitHub',
        '升级 Master',
      ],
      you: [],
    });
    expect(autonomy(input(partialRepo))).toEqual({
      auto: ['编码', '评审', '找活（侦察）', '采纳风险低的提案', '推送到 GitHub'],
      you: ['合并前审批', '升级 Master'],
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
    expect(g.conditions).toContain('今天侦察和自动采纳的 Run 一共花费不到 $20.00（现在 $3.20）');
    expect(g.conditions).toContain(
      '不限间隔（interval_hours: 0）：上次侦察失败或没找到新需求也不额外等',
    );
    expect(g.conditions).toContain(
      '在自动采纳范围内、还没采纳的提案少于 5 条（max_proposals）；超出范围的（风险更高或大小为 L）留给你处理，不挡侦察',
    );
    expect(g.now).toBe('条件都满足，下次检查（每 5 分钟）时就会侦察。');
    expect(g.waiting).toBe(false);

    const p = scoutGuide(input(partialRepo), now);
    expect(p.conditions).toContain('距上次侦察满 6 小时（interval_hours）');
    expect(p.conditions).toContain('没设每日花费上限（daily_budget_usd），不受花费限制');

    // Without auto-accept every untriaged proposal counts.
    const m = scoutGuide(input({ ...manualRepo, scout }), now);
    expect(m.conditions).toContain('还没处理的提案少于 5 条（max_proposals）');
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
    expect(auto(partialRepo.autoAccept)).toContain(
      '现在是风险低、大小不是 L 的提案（max_risk: low）',
    );
    expect(auto(autoRepo.autoAccept)).toContain(
      '现在是所有风险、大小不是 L 的提案（max_risk: high）',
    );
    expect(auto(manualRepo.autoAccept)).toContain('现在自动采纳关闭');
    expect(auto(null)).toContain('风险在 max_risk 以内');
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
    expect(rail(i, 'Run 预算')).toMatchObject({ on: true });
    expect(rail(i, 'Run 预算')?.text).toContain('$5.00');
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
    expect(idleReasons({ ...base, attention: 1, github: busy }, now)).toEqual([
      '有 1 个 Run 在等你审批或卡住了：它们让出了执行位，但仓库有未结束的 Run 时不会自动侦察。到首页「待我处理」处理。',
    ]);
    const full = { ...autoRepo, scout: { ...scout, waiting: { reason: '有 5 条提案等你处理' } } };
    expect(idleReasons({ ...base, github: full }, now)).toEqual([
      '自动侦察在等：有 5 条提案等你处理。',
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
      'Accepted automatically: low-risk proposals that are not size L (labeled ares1:ready and ares1:auto), at most 3 a day; the rest are up to you: add ares1:ready or close them',
    );
    expect(steps.push?.text).toContain('pushes the target branch (main) to GitHub');
    expect(runStages(inputEn(manualRepo))?.find((s) => s.id === 'e2e')?.name).toBe(
      'E2E (placeholder)',
    );
    expect(autonomy(inputEn(autoRepo, on)).auto).toContain('Accepting all proposals');
    const checks = guardrails(inputEn(manualRepo), true).find((g) => g.title === 'Checks');
    expect(checks?.text).toContain('npm run build, npm test run');
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
    for (const reason of ['等 1 个未结束的 Run 做完', 'Waiting for 1 unfinished Run to finish']) {
      expect(idleReasons({ ...base, attention: 1, github: waitingFor(reason) }, now)).toEqual([
        '1 Run is waiting for your approval or blocked: it frees the execution slot, but the repo is not scouted automatically while it has unfinished Runs. Handle it under "Needs me" on the home page.',
      ]);
    }
    expect(idleReasons({ ...base, github: waitingFor('5 proposals await you') }, now)).toEqual([
      'Automatic scouting is waiting: 5 proposals await you.',
    ]);
  });
});
