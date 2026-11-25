import { afterEach, describe, expect, it } from 'vitest';
import type { BacklogRepoStatus, ProposalView } from '../../../src/api/types.js';
import { setLang } from '../../../src/i18n.js';
import { formatTime } from './format.js';
import { pollText } from './issues.js';
import {
  acceptBlocker,
  backlogOutdatedBy,
  canReject,
  decidedText,
  mergeProposals,
  PROPOSAL_STATUS,
  pendingText,
  proposalCountsText,
  proposalGroups,
  scoutProposalFiled,
  sortProposals,
} from './proposals.js';

afterEach(() => setLang('zh'));

const CHINESE = /[一-鿿]/;
const NOW = new Date('2026-11-25T12:00:00');

function proposal(over: Partial<ProposalView> & Pick<ProposalView, 'id'>): ProposalView {
  return {
    repoId: 'repo-1',
    repo: 'demo',
    scoutId: 'scout-1',
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
    iterationId: null,
    dependsOn: [],
    createdAt: '2026-11-25T08:00:00.000Z',
    decidedAt: null,
    runStatus: null,
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
    setLang('en');
    expect(Object.values(PROPOSAL_STATUS).map((s) => s.label)).toEqual([
      'Pending',
      'Accepted',
      'Rejected',
    ]);
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
  it('reloads the local backlog on proposals, scouts, new Runs, Run statuses and reloads', () => {
    for (const type of [
      'proposal.auto_accepted',
      'proposal.accepted',
      'proposal.rejected',
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
