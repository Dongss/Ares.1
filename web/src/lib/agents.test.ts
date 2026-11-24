import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSummary } from '../../../src/api/types.js';
import { AgentSchema } from '../../../src/config/schema.js';
import { setLang } from '../../../src/i18n.js';
import {
  agentPageRow,
  agentStatus,
  agentTotals,
  errorText,
  isAgentPageEvent,
  outcomeRates,
} from './agents.js';

const NO_RUNS: AgentSummary['runs'] = {
  attempts: 0,
  passed: 0,
  rework: 0,
  agentError: 0,
  stopped: 0,
  costUsd: 0,
  costUnknown: 0,
  lastAt: null,
  lastError: null,
};
const NO_SCOUTS: AgentSummary['scouts'] = { scouts: 0, costUsd: 0, costUnknown: 0, lastAt: null };

const entry = (id: string, raw: Record<string, unknown>): AgentSummary['entry'] => ({
  id,
  state: raw.enabled === false ? 'disabled' : 'enabled',
  config: { ...AgentSchema.parse(raw), id },
  rawCli: String(raw.cli),
  rawModel: String(raw.model),
  errors: [],
  warnings: raw.cli === 'codex' && raw.permission === 'safe' ? ['Codex 没有只改文件的模式'] : [],
});

const summary = (
  id: string,
  e: AgentSummary['entry'],
  runs: Partial<AgentSummary['runs']> = {},
  scouts: Partial<AgentSummary['scouts']> = {},
): AgentSummary => ({
  id,
  state: e?.state ?? 'removed',
  entry: e,
  runs: { ...NO_RUNS, ...runs },
  scouts: { ...NO_SCOUTS, ...scouts },
});

const coder = summary(
  'coder',
  entry('coder', { cli: 'claude-code', model: 'opus', effort: 'xhigh' }),
  {
    attempts: 13,
    passed: 9,
    rework: 2,
    agentError: 1,
    stopped: 1,
    costUsd: 7.78,
    costUnknown: 0,
    lastAt: '2026-11-19T08:00:00.000Z',
    lastError: {
      attemptId: 'att-1',
      runId: 'run-b',
      at: '2026-11-19T07:00:00.000Z',
      message: '模型不存在\n  stderr:   no such model',
      truncated: true,
    },
  },
);

describe('agentPageRow', () => {
  it('shows the configuration, outcome counts and costs of an agent', () => {
    expect(agentPageRow(coder)).toEqual({
      id: 'coder',
      state: 'enabled',
      cli: 'claude-code',
      model: 'opus',
      effort: 'xhigh',
      defaultEffort: false,
      reason: null,
      warnings: [],
      attempts: 13,
      outcomes: '9 / 2 / 1',
      rates: '返工 17%、出错 8%',
      stopped: '另有 1 次被停止或中断',
      runCost: '$7.78',
      scoutCost: null,
      scouts: 0,
      totalCost: '$7.78',
      lastAt: '2026-11-19T08:00:00.000Z',
      lastError: {
        attemptId: 'att-1',
        runId: 'run-b',
        at: '2026-11-19T07:00:00.000Z',
        message: '模型不存在\n  stderr:   no such model',
        truncated: true,
        text: '模型不存在 stderr: no such model…',
      },
    });
  });

  it('marks unknown costs instead of counting them as $0', () => {
    const row = agentPageRow(
      summary(
        'cursor',
        entry('cursor', { cli: 'cursor-agent', model: 'gpt' }),
        { attempts: 3, passed: 3, costUsd: 0, costUnknown: 3 },
        { scouts: 2, costUsd: 0.3, costUnknown: 1, lastAt: '2026-11-19T09:00:00.000Z' },
      ),
    );
    expect(row).toMatchObject({
      effort: null,
      defaultEffort: true,
      runCost: '费用未知',
      scoutCost: '$0.30 + 未知',
      scouts: 2,
      totalCost: '$0.30 + 未知',
      rates: '返工 0%、出错 0%',
      stopped: null,
      // The latest of executions and scouts.
      lastAt: '2026-11-19T09:00:00.000Z',
    });
    const both = agentPageRow(
      summary('a', null, { attempts: 1, costUsd: 1, costUnknown: 1 }, { scouts: 1, costUsd: 0.5 }),
    );
    expect(both.totalCost).toBe('$1.50 + 未知');
  });

  it('carries what to know about an agent in use', () => {
    const row = agentPageRow(
      summary('codex', entry('codex', { cli: 'codex', model: 'gpt-5.5', permission: 'safe' })),
    );
    expect(row).toMatchObject({
      state: 'enabled',
      cli: 'codex',
      reason: null,
      warnings: ['Codex 没有只改文件的模式'],
    });
  });

  it('shows dashes for what an agent never did', () => {
    const row = agentPageRow(
      summary('off', entry('off', { cli: 'claude-code', model: 'haiku', enabled: false })),
    );
    expect(row).toMatchObject({
      state: 'disabled',
      reason: '配置了 enabled: false',
      attempts: 0,
      outcomes: null,
      rates: null,
      stopped: null,
      runCost: null,
      scoutCost: null,
      totalCost: '$0',
      lastAt: null,
      lastError: null,
    });
  });

  it('describes invalid and removed agents', () => {
    const invalid = agentPageRow(
      summary('broken', {
        id: 'broken',
        state: 'invalid',
        config: null,
        rawCli: 'claude-code',
        rawModel: null,
        errors: ['model: 必填'],
        warnings: [],
      }),
    );
    expect(invalid).toMatchObject({
      cli: 'claude-code',
      model: null,
      effort: null,
      defaultEffort: false,
      reason: 'model: 必填',
      warnings: [],
    });
    const removed = agentPageRow(summary('old', null, { attempts: 2, rework: 1, agentError: 1 }));
    expect(removed).toMatchObject({
      state: 'removed',
      cli: null,
      model: null,
      effort: null,
      defaultEffort: false,
      reason: 'agents.yaml 中已经没有这一项，这里是它留下的记录',
      outcomes: '0 / 1 / 1',
      rates: '返工 50%、出错 50%',
    });
    expect(agentStatus(removed.state)).toEqual({ label: '已不在配置中', tone: 'muted' });
  });
});

describe('outcomeRates', () => {
  it('only counts executions with an outcome', () => {
    expect(outcomeRates({ ...NO_RUNS, attempts: 3, stopped: 3 })).toBeNull();
    expect(outcomeRates({ ...NO_RUNS, attempts: 5, passed: 2, rework: 1, stopped: 2 })).toBe(
      '返工 33%、出错 0%',
    );
    expect(outcomeRates({ ...NO_RUNS, attempts: 300, passed: 299, agentError: 1 })).toBe(
      '返工 0%、出错 <1%',
    );
  });
});

describe('errorText', () => {
  it('puts the error on one line and marks a cut', () => {
    expect(errorText({ message: '  a\n\n b\tc ', truncated: false })).toBe('a b c');
    expect(errorText({ message: 'abc', truncated: true })).toBe('abc…');
  });
});

describe('agentTotals', () => {
  it('adds up every agent, keeping unknown costs marked', () => {
    const scout = summary('scout', null, {}, { scouts: 2, costUsd: 0.3, costUnknown: 1 });
    const cursor = summary('cursor', null, { attempts: 2, costUnknown: 2 });
    expect(agentTotals([coder, scout, cursor])).toEqual({
      attempts: 15,
      scouts: 2,
      runCost: '$7.78 + 未知',
      scoutCost: '$0.30 + 未知',
      totalCost: '$8.08 + 未知',
    });
    expect(agentTotals([coder])).toMatchObject({
      runCost: '$7.78',
      scoutCost: '$0',
      totalCost: '$7.78',
    });
    expect(agentTotals([])).toEqual({
      attempts: 0,
      scouts: 0,
      runCost: '$0',
      scoutCost: '$0',
      totalCost: '$0',
    });
  });
});

describe('isAgentPageEvent', () => {
  it('reloads when executions, outcomes, scouts or agents.yaml change', () => {
    for (const type of [
      'attempt.finished',
      'task.rework',
      'task.passed',
      'stage.passed',
      'run.blocked',
      'run.status',
      'scout.completed',
      'scout.failed',
      'scout.rate_limited',
      'config.reloaded',
    ]) {
      expect(isAgentPageEvent({ type }), type).toBe(true);
    }
    for (const type of ['scout.started', 'run.created', 'approval.requested', 'merge.done']) {
      expect(isAgentPageEvent({ type }), type).toBe(false);
    }
  });
});

describe('in English', () => {
  afterEach(() => setLang('zh'));

  it('describes rates, stopped executions and removed agents without Chinese', () => {
    setLang('en');
    expect(outcomeRates({ ...NO_RUNS, attempts: 4, passed: 2, rework: 1, agentError: 1 })).toBe(
      'Rework 25%, error 25%',
    );
    const one = agentPageRow(summary('old', null, { attempts: 2, rework: 1, stopped: 1 }));
    expect(one.stopped).toBe('1 more was stopped or interrupted');
    expect(one.reason).not.toMatch(/[\u4e00-\u9fff]/);
    const two = agentPageRow(summary('old', null, { attempts: 2, stopped: 2 }));
    expect(two.stopped).toBe('2 more were stopped or interrupted');
    expect(agentStatus('removed')).toEqual({ label: 'No longer configured', tone: 'muted' });
  });
});
