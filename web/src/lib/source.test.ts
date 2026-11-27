import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigView, RepoSourceSettings } from '../../../src/api/types.js';
import { AgentSchema, TemplateSchema } from '../../../src/config/schema.js';
import { setLang } from '../../../src/i18n.js';
import { ApiError } from './api.js';
import {
  MAX_RISKS,
  maxRiskLabel,
  noScoutAgentNote,
  SOURCE_PLATFORMS,
  type SourceForm,
  scoutAgentLabel,
  scoutAgentOptions,
  sourceFormInit,
  sourceFormProblems,
  sourcePlatformHint,
  sourcePlatformLabel,
  sourceRequest,
  sourceSaveFailure,
  sourceTemplateOptions,
  templateOptionLabel,
} from './source.js';

afterEach(() => setLang('zh'));

const template = (id: string, name?: string) =>
  TemplateSchema.parse({ id, ...(name ? { name } : {}), stages: [{ id: 'a', agent: 'coder' }] });
const agent = (id: string, cli: string) => ({ ...AgentSchema.parse({ cli, model: 'm' }), id });

type View = Pick<ConfigView, 'templates' | 'repoTemplates' | 'agents' | 'clis' | 'repoSources'>;

function view(extra: Partial<View> = {}): View {
  return {
    templates: [template('dev', '开发'), template('docs')],
    repoTemplates: [
      {
        repo: 'app',
        branch: 'main',
        sha: 'abc',
        // `dev` is the home directory's too, so the app's Runs get the home directory's.
        templates: [template('dev', '仓库的开发'), template('e2e', '端到端')],
        files: [],
      },
      { repo: 'other', branch: 'main', sha: 'def', templates: [template('theirs')], files: [] },
    ],
    agents: [
      agent('coder', 'claude-code'),
      agent('cursor', 'cursor-agent'),
      agent('codexer', 'codex'),
    ],
    clis: [
      { cli: 'claude-code', readOnly: true },
      { cli: 'cursor-agent', readOnly: false },
      { cli: 'codex', readOnly: true },
    ],
    repoSources: {},
    ...extra,
  };
}

const settings: RepoSourceSettings = {
  template: 'e2e',
  scout: { agent: 'codexer', auto: false, interval_minutes: 30, max_proposals: 2 },
  auto_accept: { max_risk: 'low', max_size: 'M', max_per_day: 4 },
  auto_merge: true,
  max_run_attempts: 1,
  daily_budget_usd: 12.5,
};

/** A form at the defaults, on `platform`. */
function form(extra: Partial<SourceForm> = {}): SourceForm {
  return { ...sourceFormInit(view(), 'app'), platform: 'backlog', ...extra };
}

describe('what the source form offers', () => {
  it("offers the home directory's templates, then the repo's own it does not shadow", () => {
    expect(sourceTemplateOptions(view(), 'app')).toEqual([
      { id: 'dev', name: '开发', source: 'home' },
      { id: 'docs', name: 'docs', source: 'home' },
      { id: 'e2e', name: '端到端', source: 'repo' },
    ]);
    // Another repo's templates are its own only.
    expect(sourceTemplateOptions(view(), 'solo').map((o) => o.id)).toEqual(['dev', 'docs']);
  });

  it('keeps offering the template set now when it is missing, marked so', () => {
    const options = sourceTemplateOptions(view(), 'app', 'gone');
    expect(options.at(-1)).toEqual({ id: 'gone', name: 'gone', source: 'missing' });
    expect(sourceTemplateOptions(view(), 'app', 'e2e')).toHaveLength(3);
    expect(options.map(templateOptionLabel)).toEqual([
      'dev · 开发（数据目录）',
      'docs（数据目录）',
      'e2e · 端到端（仓库自带）',
      'gone（不存在或无效）',
    ]);
  });

  it('offers for the scout only enabled agents of a CLI that runs read-only', () => {
    expect(scoutAgentOptions(view())).toEqual([
      { id: 'coder', cli: 'claude-code', usable: true },
      { id: 'codexer', cli: 'codex', usable: true },
    ]);
    expect(noScoutAgentNote(view())).toBeNull();
  });

  it('keeps offering the scout agent set now when it cannot scout, marked so', () => {
    const cursor = scoutAgentOptions(view(), 'cursor');
    expect(cursor.at(-1)).toEqual({ id: 'cursor', cli: 'cursor-agent', usable: false });
    const gone = scoutAgentOptions(view(), 'gone');
    expect(gone.at(-1)).toEqual({ id: 'gone', cli: '', usable: false });
    expect(scoutAgentOptions(view(), 'coder')).toHaveLength(2);
    expect([...cursor, ...gone].map(scoutAgentLabel)).toEqual([
      'coder (claude-code)',
      'codexer (codex)',
      'cursor（cursor-agent，不能只读运行）',
      'coder (claude-code)',
      'codexer (codex)',
      'gone（不存在或未启用）',
    ]);
  });

  it('tells why no agent can scout', () => {
    const noAgent = view({ agents: [agent('cursor', 'cursor-agent')] });
    expect(scoutAgentOptions(noAgent)).toEqual([]);
    expect(noScoutAgentNote(noAgent)).toBe(
      '侦察要以只读方式运行，只能用 claude-code、codex 的 Agent，agents.yaml 里还没有启用的。加一个之后就能在这里选。',
    );
    const noCli = view({ clis: [{ cli: 'cursor-agent', readOnly: false }] });
    expect(noScoutAgentNote(noCli)).toBe(
      '没有能以只读方式运行的 CLI，侦察没法运行，所以不能设置侦察。',
    );
  });
});

describe('what the source form starts from', () => {
  it("starts a repo of no source from the schema's defaults and the first template", () => {
    expect(sourceFormInit(view(), 'app')).toEqual({
      platform: 'none',
      issuesRepo: '',
      template: 'dev',
      scoutAgent: '',
      scoutAuto: true,
      scoutIntervalMinutes: '0',
      scoutMaxProposals: '5',
      maxRisk: 'none',
      maxSize: 'L',
      maxPerDay: '',
      autoMerge: false,
      maxRunAttempts: '3',
      dailyBudgetUsd: '',
      push: false,
      byRequest: false,
    });
    expect(sourceFormInit(view({ templates: [], repoTemplates: [] }), 'app').template).toBe('');
  });

  it("starts from the repo's entry as loaded", () => {
    const github = view({
      repoSources: {
        app: {
          source: 'github',
          issuesRepo: 'me/app',
          settings: { ...settings, push: true, deliver: 'pr' },
        },
      },
    });
    expect(sourceFormInit(github, 'app')).toEqual({
      platform: 'github',
      issuesRepo: 'me/app',
      template: 'e2e',
      scoutAgent: 'codexer',
      scoutAuto: false,
      scoutIntervalMinutes: '30',
      scoutMaxProposals: '2',
      maxRisk: 'low',
      maxSize: 'M',
      maxPerDay: '4',
      autoMerge: true,
      maxRunAttempts: '1',
      dailyBudgetUsd: '12.5',
      push: true,
      byRequest: true,
    });

    const backlog = view({
      repoSources: { app: { source: 'backlog', settings: { ...settings, scout: null } } },
    });
    expect(sourceFormInit(backlog, 'app')).toMatchObject({
      platform: 'backlog',
      issuesRepo: '',
      scoutAgent: '',
      scoutAuto: true,
      push: false,
      byRequest: false,
    });

    const gitlab = view({
      repoSources: {
        app: {
          source: 'gitlab',
          host: 'gitlab.com',
          issuesRepo: 'grp/app',
          settings: { ...settings, push: true, deliver: 'push' },
        },
      },
    });
    expect(sourceFormInit(gitlab, 'app')).toMatchObject({
      platform: 'gitlab',
      issuesRepo: 'grp/app',
      push: true,
      byRequest: false,
    });
  });
});

describe('the request the source form sends', () => {
  it('sends only the platform for none', () => {
    expect(sourceRequest(form({ platform: 'none', issuesRepo: 'x/y', push: true }))).toEqual({
      platform: 'none',
    });
  });

  it("leaves out what equals the schema's defaults, and empty number boxes", () => {
    expect(sourceRequest(form())).toEqual({ platform: 'backlog', template: 'dev', scout: null });
    expect(
      sourceRequest(form({ platform: 'github', maxRunAttempts: ' ', scoutMaxProposals: '' })),
    ).toEqual({ platform: 'github', template: 'dev', scout: null });
    // A scout at its defaults: the agent only.
    expect(sourceRequest(form({ scoutAgent: 'coder' }))).toEqual({
      platform: 'backlog',
      template: 'dev',
      scout: { agent: 'coder' },
    });
  });

  it('sends what differs from the defaults, numbers as numbers', () => {
    const changed: Partial<SourceForm> = {
      template: 'e2e',
      scoutAgent: 'codexer',
      scoutAuto: false,
      scoutIntervalMinutes: '30',
      scoutMaxProposals: '2',
      maxRisk: 'mid',
      maxSize: 'S',
      maxPerDay: ' 4 ',
      autoMerge: true,
      maxRunAttempts: '1',
      dailyBudgetUsd: '12.5',
    };
    const fields = {
      template: 'e2e',
      scout: { agent: 'codexer', auto: false, interval_minutes: 30, max_proposals: 2 },
      auto_accept: { max_risk: 'mid', max_size: 'S', max_per_day: 4 },
      auto_merge: true,
      max_run_attempts: 1,
      daily_budget_usd: 12.5,
    };
    expect(sourceRequest(form(changed))).toEqual({ platform: 'backlog', ...fields });
    expect(
      sourceRequest(
        form({
          ...changed,
          platform: 'github',
          issuesRepo: ' me/app ',
          push: true,
          byRequest: true,
        }),
      ),
    ).toEqual({ platform: 'github', issues_repo: 'me/app', ...fields, push: true, deliver: 'pr' });
    expect(
      sourceRequest(
        form({
          ...changed,
          platform: 'gitlab',
          issuesRepo: 'grp/app',
          push: true,
          byRequest: true,
        }),
      ),
    ).toEqual({ platform: 'gitlab', issues_repo: 'grp/app', ...fields, push: true, deliver: 'mr' });
  });

  it('sends only the fields of the platform chosen', () => {
    const hosted = { issuesRepo: 'me/app', push: true, byRequest: true };
    expect(sourceRequest(form({ ...hosted, platform: 'backlog' }))).toEqual({
      platform: 'backlog',
      template: 'dev',
      scout: null,
    });
    // GitHub works the issues' repo out by itself; GitLab always says it.
    expect(sourceRequest(form({ platform: 'github', issuesRepo: '  ' }))).not.toHaveProperty(
      'issues_repo',
    );
    expect(sourceRequest(form({ platform: 'gitlab', issuesRepo: '' }))).toMatchObject({
      issues_repo: '',
    });
  });

  it('sends back what it started from as the entry was', () => {
    const github = view({
      repoSources: {
        app: {
          source: 'github',
          issuesRepo: null,
          settings: { ...settings, push: true, deliver: 'pr' },
        },
      },
    });
    expect(sourceRequest(sourceFormInit(github, 'app'))).toEqual({
      platform: 'github',
      template: 'e2e',
      scout: { agent: 'codexer', auto: false, interval_minutes: 30, max_proposals: 2 },
      auto_accept: { max_risk: 'low', max_size: 'M', max_per_day: 4 },
      auto_merge: true,
      max_run_attempts: 1,
      daily_budget_usd: 12.5,
      push: true,
      deliver: 'pr',
    });
  });
});

describe('what the source form tells before sending', () => {
  const agents = scoutAgentOptions(view(), 'cursor');

  it('finds nothing in settings that can work, nor for none', () => {
    expect(sourceFormProblems(form(), agents)).toEqual([]);
    expect(sourceFormProblems(form({ platform: 'github' }), agents)).toEqual([]);
    expect(sourceFormProblems(form({ platform: 'none', template: '' }), agents)).toEqual([]);
    // The backlog has no push to need.
    expect(sourceFormProblems(form({ byRequest: true }), agents)).toEqual([]);
  });

  it('tells GitLab without issues_repo, a PR or MR without push, no template, a scout that cannot', () => {
    expect(
      sourceFormProblems(
        form({ platform: 'gitlab', issuesRepo: ' ', byRequest: true, template: '' }),
        agents,
      ),
    ).toEqual([
      'GitLab 必须填 issues_repo（项目路径，如 group/name）',
      '请选一个模板（template）',
      'deliver: mr 要求开启 push：开 MR 要先把 Run 的分支推送到 GitLab',
    ]);
    expect(
      sourceFormProblems(
        form({ platform: 'github', byRequest: true, scoutAgent: 'cursor' }),
        agents,
      ),
    ).toEqual([
      '侦察 Agent cursor 用不了：侦察要用启用的、能以只读方式运行的 Agent',
      'deliver: pr 要求开启 push：开 PR 要先把 Run 的分支推送到 GitHub',
    ]);
    expect(
      sourceFormProblems(form({ platform: 'github', byRequest: true, push: true }), agents),
    ).toEqual([]);
  });
});

describe('a failed save', () => {
  it("lists the Master's problems one by one, or tells its message", () => {
    expect(sourceSaveFailure(new ApiError('x', 400, ['模板 nope 不存在或无效']))).toEqual({
      error: '设置有问题，config.yaml 没有改动：',
      problems: ['模板 nope 不存在或无效'],
    });
    expect(sourceSaveFailure(new ApiError('配置现在加载不了', 409))).toEqual({
      error: '配置现在加载不了',
      problems: [],
    });
    expect(sourceSaveFailure('boom')).toEqual({ error: 'boom', problems: [] });
  });
});

describe('the source form in English', () => {
  it('has no Chinese left', () => {
    setLang('en');
    const texts = [
      ...SOURCE_PLATFORMS.flatMap((p) => [sourcePlatformLabel(p), sourcePlatformHint(p)]),
      ...MAX_RISKS.map(maxRiskLabel),
      ...sourceTemplateOptions(
        view({
          templates: [template('dev', 'Development')],
          repoTemplates: [
            { repo: 'app', branch: 'main', sha: 'abc', templates: [template('e2e')], files: [] },
          ],
        }),
        'app',
        'gone',
      ).map(templateOptionLabel),
      ...[...scoutAgentOptions(view(), 'cursor'), ...scoutAgentOptions(view(), 'gone')].map(
        scoutAgentLabel,
      ),
      noScoutAgentNote(view({ agents: [] })) ?? '',
      noScoutAgentNote(view({ clis: [] })) ?? '',
      ...sourceFormProblems(
        form({ platform: 'gitlab', template: '', scoutAgent: 'cursor', byRequest: true }),
        scoutAgentOptions(view(), 'cursor'),
      ),
      ...sourceFormProblems(form({ platform: 'github', byRequest: true }), []),
      sourceSaveFailure(new ApiError('x', 400, ['p'])).error,
    ];
    expect(texts).toContain(
      "deliver: mr needs push: a merge request needs the Run's branch pushed to GitLab",
    );
    expect(texts).toContain(
      'The scout agent cursor cannot scout: the scout needs an enabled agent that can run read-only',
    );
    expect(texts.join('\n')).not.toMatch(/[一-鿿]/);
  });
});
