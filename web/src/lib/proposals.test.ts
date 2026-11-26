import { afterEach, describe, expect, it } from 'vitest';
import type { BacklogRepoStatus, ProposalView } from '../../../src/api/types.js';
import { setLang } from '../../../src/i18n.js';
import { formatTime } from './format.js';
import { pollText } from './issues.js';
import {
  acceptBlocker,
  attemptsText,
  attemptText,
  backlogOutdatedBy,
  canReject,
  decidedText,
  failureLabel,
  failureLabels,
  failuresHeading,
  humanMark,
  mergeProposals,
  PROPOSAL_STATUS,
  pendingText,
  proposalCountsText,
  proposalGroups,
  proposalRedoText,
  restartBlocker,
  restartHint,
  restartLabels,
  scoutProposalFiled,
  sortProposals,
  stepRestartBlocker,
} from './proposals.js';

afterEach(() => setLang('zh'));

const CHINESE = /[一-鿿]/;
const NOW = new Date('2026-11-25T12:00:00');

function proposal(over: Partial<ProposalView> & Pick<ProposalView, 'id'>): ProposalView {
  return {
    repoId: 'repo-1',
    repo: 'demo',
    scoutId: 'scout-1',
    author: 'scout',
    title: `Proposal ${over.id}`,
    category: 'feature',
    size: 'M',
    risk: 'low',
    why: 'why',
    evidence: [],
    what: 'what',
    acceptance: [],
    status: 'pending',
    rejectReason: null,
    auto: false,
    runId: null,
    attempt: 1,
    failures: [],
    redo: null,
    iterationId: null,
    dependsOn: [],
    createdAt: '2026-11-25T08:00:00.000Z',
    decidedAt: null,
    runStatus: null,
    redoAt: null,
    maxAttempts: 3,
    restartable: false,
    ...over,
  };
}

function repo(name: string, over: Partial<BacklogRepoStatus> = {}): BacklogRepoStatus {
  return {
    name,
    template: 'self-dev',
    problems: [],
    scout: null,
    autoAccept: { maxRisk: 'low', maxSize: 'M', maxPerDay: null, usedToday: 0 },
    autoMerge: false,
    budget: { dailyUsd: null, spentToday: 0, reached: false },
    maxRunAttempts: 3,
    pendingProposals: 0,
    ...over,
  };
}

describe('the order of local proposals', () => {
  it('puts the pending ones first, newest first, then the most recently decided', () => {
    const ps = [
      proposal({
        id: 'accepted-early',
        status: 'accepted',
        createdAt: '2026-11-20T08:00:00.000Z',
        decidedAt: '2026-11-21T08:00:00.000Z',
      }),
      proposal({ id: 'pending-old', createdAt: '2026-11-19T08:00:00.000Z' }),
      proposal({
        id: 'rejected-late',
        status: 'rejected',
        createdAt: '2026-11-18T08:00:00.000Z',
        decidedAt: '2026-11-24T08:00:00.000Z',
      }),
      proposal({ id: 'pending-new', createdAt: '2026-11-24T09:00:00.000Z' }),
    ];
    expect(sortProposals(ps).map((p) => p.id)).toEqual([
      'pending-new',
      'pending-old',
      'rejected-late',
      'accepted-early',
    ]);
    // The input is left alone.
    expect(ps[0]?.id).toBe('accepted-early');
  });

  it('merges the pending and the recent lists, each proposal once', () => {
    const a = proposal({ id: 'a' });
    const b = proposal({ id: 'b', status: 'accepted' });
    const merged = mergeProposals([a], [b, { ...a, title: 'again' }]);
    expect(merged.map((p) => p.id)).toEqual(['a', 'b']);
    expect(merged[0]?.title).toBe('Proposal a');
    expect(mergeProposals()).toEqual([]);
  });
});

describe('proposalGroups', () => {
  it('lists every repo of backlog.repos in order, then repos taken out that have proposals', () => {
    const ps = [
      proposal({ id: 'z1', repo: 'zeta' }),
      proposal({ id: 'd1', repo: 'demo', status: 'accepted', decidedAt: NOW.toISOString() }),
      proposal({ id: 'd2', repo: 'demo' }),
      proposal({ id: 'a1', repo: 'alpha-gone' }),
      proposal({ id: 'z2', repo: 'zz-gone' }),
    ];
    const groups = proposalGroups([repo('zeta'), repo('demo'), repo('empty')], ps);
    expect(
      groups.map((g) => [g.repo, g.status?.name ?? null, g.proposals.map((p) => p.id)]),
    ).toEqual([
      ['zeta', 'zeta', ['z1']],
      ['demo', 'demo', ['d2', 'd1']],
      ['empty', 'empty', []],
      ['alpha-gone', null, ['a1']],
      ['zz-gone', null, ['z2']],
    ]);
    expect(proposalGroups([], [])).toEqual([]);
  });
});

describe('deciding a proposal', () => {
  it('rejects only a pending proposal, and only with a reason', () => {
    const pending = proposal({ id: 'p' });
    expect(canReject(pending, '')).toBe(false);
    expect(canReject(pending, '   \n ')).toBe(false);
    expect(canReject(pending, '重复了')).toBe(true);
    expect(canReject({ ...pending, status: 'accepted' }, '重复了')).toBe(false);
    expect(canReject({ ...pending, status: 'rejected' }, '重复了')).toBe(false);
  });

  it('says why a pending proposal cannot be accepted, as the Master would refuse it', () => {
    const pending = proposal({ id: 'p' });
    expect(acceptBlocker(pending, repo('demo'))).toBeNull();
    // Decided ones have nothing to accept.
    expect(acceptBlocker({ ...pending, status: 'accepted' }, null)).toBeNull();
    expect(acceptBlocker(pending, null)).toBe(
      'demo 已经不在 config.yaml 的 backlog.repos 里，不能再采纳它的提案；拒绝还可以',
    );
    expect(acceptBlocker(pending, repo('demo', { problems: ['模板不存在'] }))).toMatch(
      /^这个仓库的配置有问题/,
    );
    setLang('en');
    expect(acceptBlocker(pending, null)).toBe(
      'demo is no longer in backlog.repos of config.yaml, so its proposals cannot be accepted; they can still be rejected',
    );
    expect(acceptBlocker(pending, repo('demo', { problems: ['x'] }))).not.toMatch(CHINESE);
  });

  it('says whether auto-accept takes a pending proposal later or it waits for a human', () => {
    const auto = { maxRisk: 'low', maxSize: 'M' } as const;
    const within = proposal({ id: 'p', risk: 'low', size: 'S' });
    expect(pendingText(within, auto)).toMatch(/^在自动采纳范围内，还没采纳/);
    expect(pendingText({ ...within, size: 'L' }, auto)).toBe('超出自动采纳的范围，等你采纳或拒绝');
    expect(pendingText({ ...within, risk: 'mid' }, auto)).toBe(
      '超出自动采纳的范围，等你采纳或拒绝',
    );
    expect(pendingText(within, { maxRisk: 'none', maxSize: 'L' })).toBe(
      '超出自动采纳的范围，等你采纳或拒绝',
    );
    expect(pendingText({ ...within, status: 'accepted' }, auto)).toBeNull();
    expect(pendingText(within, null)).toBeNull();
    setLang('en');
    expect(pendingText(within, auto)).toMatch(/^Within auto-accept but not accepted yet/);
    expect(pendingText({ ...within, size: 'L' }, auto)).toBe(
      'Beyond auto-accept, so it waits for you to accept or reject it',
    );
  });

  it('leaves the draft a human wrote to them, within auto-accept or not, and marks it', () => {
    const auto = { maxRisk: 'high', maxSize: 'L' } as const;
    const draft = proposal({ id: 'p', author: 'human', scoutId: null, risk: 'low', size: 'S' });
    expect(pendingText(draft, auto)).toBe(
      '你写下先存着的需求：不会自动采纳，也不挡自动侦察；想开工就采纳，不做了就拒绝',
    );
    expect(pendingText({ ...draft, status: 'accepted' }, auto)).toBeNull();
    expect(humanMark(draft)).toBe('人写的');
    // Marked whatever became of it.
    expect(humanMark(proposal({ id: 'r', author: 'human', status: 'accepted' }))).toBe('人写的');
    expect(humanMark(proposal({ id: 'q' }))).toBeNull();
    setLang('en');
    expect(pendingText(draft, auto)).toBe(
      'A requirement you wrote and kept for later: it is never accepted automatically and does not hold the automatic scout back; accept it to start, or reject it',
    );
    expect(humanMark(draft)).toBe('Human-written');
  });

  it('says how and when a proposal was decided', () => {
    const at = '2026-11-20T09:30:00.000Z';
    const time = formatTime(at, NOW);
    const accepted = proposal({ id: 'p', status: 'accepted', decidedAt: at });
    expect(decidedText(proposal({ id: 'p' }), NOW)).toBeNull();
    expect(decidedText(accepted, NOW)).toBe(`${time} 采纳`);
    expect(decidedText({ ...accepted, auto: true }, NOW)).toBe(`${time} 自动采纳`);
    expect(decidedText({ ...accepted, status: 'rejected' }, NOW)).toBe(`${time} 拒绝`);
    expect(decidedText({ ...accepted, decidedAt: null }, NOW)).toBe('采纳');
    setLang('en');
    expect(decidedText(accepted, NOW)).toBe(`Accepted ${time}`);
    expect(decidedText({ ...accepted, auto: true }, NOW)).toBe(`Accepted automatically ${time}`);
    expect(decidedText({ ...accepted, status: 'rejected', decidedAt: null }, NOW)).toBe('Rejected');
  });
});

describe('local proposal labels', () => {
  it('counts the proposals of a repo by status', () => {
    const ps = [
      proposal({ id: '1' }),
      proposal({ id: '2' }),
      proposal({ id: '3', status: 'accepted' }),
      proposal({ id: '4', status: 'rejected' }),
    ];
    expect(proposalCountsText(ps)).toBe('2 条待处理、1 条已采纳、1 条已拒绝');
    expect(proposalCountsText(ps.slice(2))).toBe('1 条已采纳、1 条已拒绝');
    expect(proposalCountsText([])).toBeNull();
    setLang('en');
    expect(proposalCountsText(ps)).toBe('2 pending, 1 accepted, 1 rejected');
  });

  it('labels the statuses in the language in use', () => {
    expect(PROPOSAL_STATUS.pending).toMatchObject({ label: '待处理', tone: 'attention' });
    expect(PROPOSAL_STATUS.accepted).toMatchObject({ label: '已采纳', tone: 'success' });
    expect(PROPOSAL_STATUS.rejected).toMatchObject({ label: '已拒绝', tone: 'muted' });
    expect(PROPOSAL_STATUS.failed).toMatchObject({ label: '已失败', tone: 'danger' });
    setLang('en');
    expect(Object.values(PROPOSAL_STATUS).map((s) => s.label)).toEqual([
      'Pending',
      'Accepted',
      'Rejected',
      'Failed',
    ]);
  });

  it('counts the failed ones too', () => {
    const ps = [proposal({ id: '1', status: 'accepted' }), proposal({ id: '2', status: 'failed' })];
    expect(proposalCountsText(ps)).toBe('1 条已采纳、1 条已失败');
    setLang('en');
    expect(proposalCountsText(ps)).toBe('1 accepted, 1 failed');
  });

  it('tells the attempts at a proposal, the redo to come and why each attempt failed', () => {
    const failures = [
      { runId: 'run-1', attempt: 1, stage: '编码', error: '模型额度用完了' },
      { runId: 'run-2', attempt: 2, stage: null, error: '准备命令失败' },
    ];
    const first = proposal({ id: 'p', status: 'accepted', runId: 'run-1' });
    expect(attemptsText(first)).toBeNull();
    expect(attemptsText(proposal({ id: 'p' }))).toBeNull();
    // Its first Run failed and waits to be redone: of as many attempts as the API says it gets.
    const waiting = { ...first, failures: failures.slice(0, 1), redo: 'pending' as const };
    expect(attemptsText(waiting)).toBe('第 1/3 次尝试');
    const redone = { ...first, runId: 'run-3', attempt: 3, failures };
    expect(attemptsText(redone)).toBe('第 3/3 次尝试');
    expect(attemptsText({ ...redone, maxAttempts: 5 })).toBe('第 3/5 次尝试');
    // Without the setting once the repo left backlog.repos.
    expect(attemptsText({ ...redone, maxAttempts: null })).toBe('第 3 次尝试');
    const failed = {
      ...redone,
      status: 'failed' as const,
      failures: [...failures, { runId: 'run-3', attempt: 3, stage: null, error: '又失败了' }],
    };
    expect(attemptsText(failed)).toBe(
      '失败 3 次，达到尝试次数上限（max_run_attempts），不再自动重做',
    );
    // Started over once, its attempts from 1 again, and failed again: counted since.
    const again = {
      ...failed,
      attempt: 2,
      maxAttempts: 2,
      failures: [
        ...failed.failures,
        { runId: 'run-4', attempt: 1, stage: '编码', error: '还是不行' },
        { runId: 'run-5', attempt: 2, stage: null, error: '还是不行' },
      ],
    };
    expect(attemptsText(again)).toBe(
      '重新开始后又失败 2 次，达到尝试次数上限（max_run_attempts），不再自动重做',
    );
    // Started over and at work again: which attempt of this round.
    const restarted = { ...again, status: 'accepted' as const, runId: 'run-6', attempt: 1 };
    expect(attemptsText({ ...restarted, maxAttempts: 3 })).toBe('第 1/3 次尝试');

    expect(proposalRedoText(first, NOW)).toBeNull();
    const redoAt = '2026-11-25T12:30:00.000Z';
    expect(proposalRedoText({ ...waiting, redoAt }, NOW)).toBe(
      `预计 ${formatTime(redoAt, NOW)} 自动重做，开始第 2 次尝试`,
    );
    expect(proposalRedoText({ ...waiting, redoAt: '2026-11-25T03:00:00.000Z' }, NOW)).toBe(
      '下一次检查时自动重做，开始第 2 次尝试',
    );
    // A step of GitHub has no attempts of a proposal.
    expect(proposalRedoText({ attempt: null, redoAt }, NOW)).toBeNull();

    expect(failures.map((f) => failureLabel(f))).toEqual([
      '第 1 次，失败在「编码」阶段',
      '第 2 次',
    ]);
    expect(failureLabels(again.failures)).toEqual([
      '第 1 次，失败在「编码」阶段',
      '第 2 次',
      '第 3 次',
      '第 2 轮第 1 次，失败在「编码」阶段',
      '第 2 轮第 2 次',
    ]);
    setLang('en');
    expect(attemptsText(redone)).toBe('Attempt 3 of 3');
    expect(attemptsText(failed)).toBe(
      'Failed 3 times, the most attempts it gets (max_run_attempts); not redone any more',
    );
    expect(attemptsText(again)).toBe(
      'Failed 2 more times after being started over, the most attempts it gets (max_run_attempts); not redone any more',
    );
    expect(failureLabels(again.failures)).toEqual([
      'Attempt 1, failed in the "编码" stage',
      'Attempt 2',
      'Attempt 3',
      'Round 2, attempt 1, failed in the "编码" stage',
      'Round 2, attempt 2',
    ]);
  });

  it('offers to start a failed proposal over, and says why it cannot be now', () => {
    const failed = proposal({ id: 'p', status: 'failed', restartable: true });
    expect(restartHint(proposal({ id: 'p', status: 'accepted' }))).toBeNull();
    expect(restartHint(failed)).toBe(
      '不再自动重做了。修好原因后可以重新开始：次数从头算，马上建一个新的 Run，它会看到之前每次失败的原因',
    );
    expect(restartHint({ ...failed, iterationId: 'iteration-1' })).toContain(
      '迭代没有别的步骤卡住时回到进行中',
    );
    expect(restartBlocker(failed, repo('demo'))).toBeNull();
    expect(restartBlocker({ ...failed, restartable: false }, null)).toBeNull();
    expect(restartBlocker(failed, null)).toBe(
      'demo 已经不在 config.yaml 的 backlog.repos 里，不能再重新开始它的提案',
    );
    expect(restartBlocker(failed, repo('demo', { problems: ['x'] }))).toBe(
      '这个仓库的配置有问题（见上面），改好之后才能重新开始',
    );
    expect(restartLabels()).toEqual({
      label: '重新开始',
      confirm: '确认重新开始：次数从头算，马上建 Run',
    });
    expect(failuresHeading(3)).toBe('失败的尝试（3 次）及原因');
    setLang('en');
    expect(restartLabels().label).toBe('Start over');
    expect(restartBlocker(failed, repo('demo', { problems: ['模板 x 不存在', 'y'] }), false)).toBe(
      'demo has problems; fix them before starting it over: 模板 x 不存在; y',
    );
    expect(restartHint({ ...failed, iterationId: 'iteration-1' })).toBe(
      'It is not redone automatically any more. Once the cause is fixed, start it over: its attempts count from 1 again, and a new Run is created at once, told why each earlier attempt failed; the iteration goes on again unless another step still blocks it',
    );
  });

  it("says why a failed step cannot be started over, by its iteration's repo in the backlog", () => {
    const step = { restartable: true };
    const backlog = {
      repos: [repo('other', { problems: ['别的仓库的问题'] }), repo('demo', { problems: [] })],
    };
    // Not known yet: nothing held back on a guess.
    expect(stepRestartBlocker(step, 'demo', undefined)).toBeNull();
    expect(stepRestartBlocker(step, 'demo', backlog)).toBeNull();
    expect(stepRestartBlocker({ restartable: false }, 'gone', backlog)).toBeNull();
    expect(stepRestartBlocker(step, 'gone', backlog)).toBe(
      'gone 已经不在 config.yaml 的 backlog.repos 里，不能再重新开始它的提案',
    );
    // The iteration's page does not show the repo's problems: they are spelled out.
    expect(stepRestartBlocker(step, 'other', backlog)).toBe(
      'other 的配置有问题，改好之后才能重新开始：别的仓库的问题',
    );
    const broken = { repos: [repo('demo', { problems: ['模板 x 不存在', 'demo 没有注册'] })] };
    expect(stepRestartBlocker(step, 'demo', broken)).toBe(
      'demo 的配置有问题，改好之后才能重新开始：模板 x 不存在；demo 没有注册',
    );
  });

  it('has no Chinese left in English', () => {
    setLang('en');
    const pending = proposal({ id: 'p' });
    const auto = { maxRisk: 'low', maxSize: 'M' } as const;
    const texts = [
      ...Object.values(PROPOSAL_STATUS).map((s) => s.label),
      acceptBlocker(pending, null),
      acceptBlocker(pending, repo('demo', { problems: ['x'] })),
      pendingText(pending, auto),
      pendingText({ ...pending, risk: 'high' }, auto),
      proposalCountsText([
        pending,
        { ...pending, status: 'accepted' },
        { ...pending, status: 'rejected' },
      ]),
      decidedText(
        { ...pending, status: 'accepted', auto: true, decidedAt: NOW.toISOString() },
        NOW,
      ),
      decidedText({ ...pending, status: 'rejected', decidedAt: NOW.toISOString() }, NOW),
      pollText(5, NOW.toISOString(), NOW),
      proposalCountsText([{ status: 'failed' }]),
      attemptsText({ status: 'accepted', attempt: 2, maxAttempts: 3, failures: [] }),
      attemptsText({ status: 'failed', attempt: 1, maxAttempts: 1, failures: [] }),
      attemptsText({
        status: 'failed',
        attempt: 1,
        maxAttempts: 1,
        failures: [{ attempt: 1 }, { attempt: 1 }],
      }),
      attemptText(2, null),
      proposalRedoText({ attempt: 1, redoAt: NOW.toISOString() }, NOW),
      failureLabel({ attempt: 1, stage: 'coding' }),
      ...failureLabels([
        { attempt: 1, stage: null },
        { attempt: 1, stage: 'coding' },
      ]),
      failuresHeading(1),
      restartHint({ restartable: true, iterationId: null }),
      restartHint({ restartable: true, iterationId: 'iteration-1' }),
      restartBlocker({ restartable: true, repo: 'demo' }, null),
      restartBlocker({ restartable: true, repo: 'demo' }, repo('demo', { problems: ['x'] })),
      stepRestartBlocker({ restartable: true }, 'gone', { repos: [] }),
      stepRestartBlocker({ restartable: true }, 'demo', {
        repos: [repo('demo', { problems: ['x'] })],
      }),
      restartLabels().label,
      restartLabels().confirm,
    ];
    for (const s of texts) {
      expect(s).toBeTruthy();
      expect(s).not.toMatch(CHINESE);
    }
  });
});

describe('scoutProposalFiled', () => {
  it('tells an issue, a local proposal, and one filed nowhere apart', () => {
    expect(scoutProposalFiled({ issue: { number: 3, url: 'u', auto: true } })).toEqual({
      where: 'issue',
      auto: true,
    });
    expect(scoutProposalFiled({ local: { id: 'proposal-1', auto: false } })).toEqual({
      where: 'local',
      auto: false,
    });
    expect(scoutProposalFiled({ local: { id: 'proposal-1', auto: true } })).toEqual({
      where: 'local',
      auto: true,
    });
    expect(scoutProposalFiled({})).toEqual({ where: null, auto: false });
  });
});

describe('backlogOutdatedBy', () => {
  it('reloads the local backlog on proposals, iterations, scouts, new Runs, Run statuses and reloads', () => {
    for (const type of [
      'proposal.auto_accepted',
      'proposal.accepted',
      'proposal.rejected',
      'iteration.accepted',
      'iteration.cancelled',
      'scout.started',
      'scout.completed',
      'run.created',
      'run.status',
      'config.reloaded',
    ]) {
      expect(backlogOutdatedBy(type), type).toBe(true);
    }
    for (const type of ['attempt.started', 'github.error', 'upgrade.done', 'run.blocked']) {
      expect(backlogOutdatedBy(type), type).toBe(false);
    }
  });
});

describe('pollText', () => {
  it('says how often the Master checks and when it last did', () => {
    expect(pollText(5, null, NOW)).toBe('每 5 分钟检查一次');
    expect(pollText(5, '2026-11-25T09:30:00', NOW)).toBe('每 5 分钟检查一次 · 上次 09:30:00');
    setLang('en');
    expect(pollText(1, null, NOW)).toBe('Checks every 1 minute');
    expect(pollText(5, '2026-11-25T09:30:00', NOW)).toBe('Checks every 5 minutes · last 09:30:00');
  });
});
