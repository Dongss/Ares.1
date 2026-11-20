import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigView } from '../../../src/api/types.js';
import { AgentSchema, TemplateSchema } from '../../../src/config/schema.js';
import { setLang } from '../../../src/i18n.js';
import {
  AGENT_STATE,
  agentRows,
  configFileWarnings,
  templateAnchor,
  templateCards,
} from './config.js';

const dev = TemplateSchema.parse({
  id: 'dev',
  name: '开发',
  stages: [{ id: 'a', agent: 'coder' }],
});
const agent = (id: string, raw: unknown) => ({ ...AgentSchema.parse(raw), id });

const view: ConfigView = {
  language: 'zh',
  agents: [
    agent('coder', { cli: 'claude-code', model: 'sonnet', effort: 'high', tags: ['coding'] }),
  ],
  templates: [dev],
  errors: { 'workflows/bad.yaml': ['stages: 至少一个'], 'agents.yaml#typo': ['tierr: 多余'] },
  warnings: {},
  loadedAt: '2026-11-19T00:00:00.000Z',
  reloadError: null,
  restartNeeded: [],
  dir: '/home/me/.ares1',
  configFile: { path: '/home/me/.ares1/config.yaml', source: 'port: 4870\n' },
  agentsFile: { path: '/home/me/.ares1/agents.yaml', source: 'agents: {}\n' },
  agentEntries: [
    {
      id: 'coder',
      state: 'enabled',
      config: agent('coder', {
        cli: 'claude-code',
        model: 'sonnet',
        effort: 'high',
        tags: ['coding'],
      }),
      rawCli: 'claude-code',
      rawModel: 'sonnet',
      errors: [],
    },
    {
      id: 'legacy',
      state: 'disabled',
      config: agent('legacy', {
        cli: 'claude-code',
        model: 'opus',
        tier: 'high',
        cost: 'high',
        args: ['--effort', 'max'],
        enabled: false,
      }),
      rawCli: 'claude-code',
      rawModel: 'opus',
      errors: [],
    },
    {
      id: 'typo',
      state: 'invalid',
      config: null,
      rawCli: 'claude-code',
      rawModel: null,
      errors: ['tierr: 多余', 'model: 必填'],
    },
  ],
  templateFiles: [
    {
      key: 'workflows/bad.yaml',
      file: 'bad.yaml',
      path: '/home/me/.ares1/workflows/bad.yaml',
      source: 'id: bad\n',
      templateId: null,
      errors: ['stages: 至少一个'],
      warnings: [],
    },
    {
      key: 'workflows/dev.yaml',
      file: 'dev.yaml',
      path: '/home/me/.ares1/workflows/dev.yaml',
      source: 'id: dev\n',
      templateId: 'dev',
      errors: [],
      warnings: ['评审 Agent 相同'],
    },
  ],
};

describe('templateCards', () => {
  it('pairs loaded templates with their files and keeps invalid files apart', () => {
    const { valid, invalid } = templateCards(view);
    expect(valid).toEqual([
      {
        key: 'workflows/dev.yaml',
        file: 'dev.yaml',
        path: '/home/me/.ares1/workflows/dev.yaml',
        source: 'id: dev\n',
        template: dev,
        errors: [],
        warnings: ['评审 Agent 相同'],
      },
    ]);
    expect(invalid.map((c) => [c.file, c.template, c.errors])).toEqual([
      ['bad.yaml', null, ['stages: 至少一个']],
    ]);
  });

  it('anchors template cards by id', () => {
    expect(templateAnchor('self-dev')).toBe('template-self-dev');
  });
});

describe('configFileWarnings', () => {
  it('shows the warnings about config.yaml, none when there are none', () => {
    expect(configFileWarnings(view)).toEqual([]);
    const warned: ConfigView = {
      ...view,
      warnings: {
        'config.yaml': ['未知的配置项 upgarde，已忽略'],
        'workflows/dev.yaml': ['评审 Agent 相同'],
      },
    };
    expect(configFileWarnings(warned)).toEqual(['未知的配置项 upgarde，已忽略']);
  });
});

describe('agentRows', () => {
  it('lists every agent with its settings and why it is not in use', () => {
    expect(agentRows(view)).toEqual([
      {
        id: 'coder',
        state: 'enabled',
        cli: 'claude-code',
        model: 'sonnet',
        effort: 'high',
        tier: 'mid',
        cost: 'mid',
        tags: ['coding'],
        reason: null,
      },
      {
        id: 'legacy',
        state: 'disabled',
        cli: 'claude-code',
        model: 'opus',
        effort: 'max',
        tier: 'high',
        cost: 'high',
        tags: [],
        reason: '配置了 enabled: false',
      },
      {
        id: 'typo',
        state: 'invalid',
        cli: 'claude-code',
        model: null,
        effort: null,
        tier: null,
        cost: null,
        tags: [],
        reason: 'tierr: 多余；model: 必填',
      },
    ]);
  });
});

describe('agentRows in English', () => {
  afterEach(() => setLang('zh'));

  it('says why an agent is not in use, and labels its state, in English', () => {
    setLang('en');
    const rows = agentRows(view);
    expect(rows.find((r) => r.id === 'legacy')?.reason).toBe('Set to enabled: false');
    // The problems themselves come from the Master, in its language; only the separator changes.
    expect(rows.find((r) => r.id === 'typo')?.reason).toBe('tierr: 多余; model: 必填');
    expect(Object.values(AGENT_STATE).map((s) => s.label)).toEqual([
      'Enabled',
      'Disabled',
      'Invalid',
    ]);
  });
});
