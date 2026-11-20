import { afterEach, describe, expect, it } from 'vitest';
import type { StageDef } from '../src/config/schema.js';
import { formatFeedback, formatReviewIssues, resultProblem } from '../src/engine/contracts.js';
import { commitMessage } from '../src/engine/engine.js';
import {
  assessmentArtifact,
  assessPrompt,
  type PromptContext,
  reviewPrompt,
  reworkPrompt,
  taskPrompt,
} from '../src/engine/prompts.js';
import { setLang } from '../src/i18n.js';
import type { AssessmentEntry, ReplyTimeoutEntry } from '../src/store/types.js';

const ctx = (stage: Partial<StageDef> = {}): PromptContext => ({
  goal: '添加 feature.txt',
  stage: { id: 'implement', kind: 'agent', ...stage } as StageDef,
  inputs: [],
  stageFeedback: null,
  verifyCommands: ['npm test'],
});

describe('prompts', () => {
  it('introduces the project by its display name, not the technical one', () => {
    const prompts = {
      task: taskPrompt(ctx(), null, 'full'),
      review: reviewPrompt(ctx({ id: 'review', kind: 'review' }), 'abc123', ''),
      assess: assessPrompt(ctx({ id: 'assess', kind: 'assess' }), [], null),
    };
    expect(prompts.task.startsWith('你是战神一号调度的开发 Agent，')).toBe(true);
    expect(prompts.review.startsWith('你是战神一号调度的代码评审 Agent。')).toBe(true);
    expect(prompts.assess.startsWith('你是战神一号的「需求评估」Agent。')).toBe(true);
    for (const prompt of Object.values(prompts)) expect(prompt).not.toContain('ares1');
  });

  it('asks coding agents for a Chinese summary, first time and on rework', () => {
    expect(taskPrompt(ctx(), null, 'full')).toContain('summary 用中文书写');
    expect(reworkPrompt('测试没过')).toContain('summary 用中文书写');
  });

  it('tells a full-permission agent to edit files with the edit tool, not inline scripts', () => {
    const prompt = taskPrompt(ctx(), null, 'full');
    expect(prompt).toContain('改文件请直接用编辑文件的工具');
    expect(prompt).toContain("`python3 - <<'EOF'`、`node -e`、`sed -i`");
    expect(prompt).toContain('可能被权限模式拒绝，有操作被拒绝时这次结果不算通过，要返工');
    // It may run the verify commands itself.
    expect(prompt).toContain('检查命令，全部通过才算完成：`npm test`。你可以先自己运行确认');
    expect(prompt).not.toContain('不能执行命令');
  });

  it('tells a safe agent it cannot run commands, and still lists the verify commands', () => {
    const prompt = taskPrompt(ctx(), null, 'safe');
    expect(prompt).toContain('你只能修改文件，不能执行命令');
    expect(prompt).toContain('执行命令会被拒绝，有操作被拒绝时这次结果不算通过，要返工');
    expect(prompt).toContain('检查命令由 Master 在你完成后运行，全部通过才算完成：`npm test`');
    expect(prompt).not.toContain('先自己运行确认');
    expect(prompt).not.toContain('改文件请直接用编辑文件的工具');
  });

  it('leaves out the verify commands when there are none, under either permission', () => {
    for (const permission of ['full', 'safe'] as const) {
      const prompt = taskPrompt({ ...ctx(), verifyCommands: [] }, null, permission);
      expect(prompt).not.toContain('检查命令');
      expect(prompt).not.toContain('先自己运行确认');
      expect(prompt).toContain('有操作被拒绝时这次结果不算通过');
    }
  });

  it('lists the verify commands that already passed for the reviewer', () => {
    const prompt = reviewPrompt(ctx({ id: 'review', kind: 'review' }), 'abc123', ' 1 file', [
      'npm run build',
      'npm test',
    ]);
    expect(prompt).toContain('## 已通过的检查');
    expect(prompt).toContain('`npm run build`、`npm test`');
    expect(prompt).toContain('不需要重复运行');
    expect(prompt).toContain('相关的单个测试');
  });

  it('leaves out the passed-checks section when nothing ran', () => {
    const prompt = reviewPrompt(ctx({ id: 'review', kind: 'review' }), 'abc123', '');
    expect(prompt).not.toContain('已通过的检查');
  });

  it("hands the previous round's review to the reviewer and asks to check it item by item", () => {
    const previous = '评审结论：还差测试\n1. [必须修改]（src/x.ts） 缺少测试';
    const prompt = reviewPrompt(ctx({ id: 'review', kind: 'review' }), 'abc123', ' 1 file', [], {
      round: 2,
      text: previous,
    });
    expect(prompt).toContain('## 上一轮评审的意见（第 2 轮）');
    expect(prompt).toContain(previous);
    expect(prompt).toContain('逐条确认上一轮的「必须修改」是否已经解决');
    expect(prompt).toContain('没有解决的，继续列为 must');
    expect(prompt).toContain('已经解决的，不要再提');
    expect(prompt).toContain('在 summary 中说明上一轮的问题各自是否已解决');
    // Right after the diff overview.
    expect(prompt.indexOf('## 改动概览')).toBeLessThan(prompt.indexOf('## 上一轮评审的意见'));
  });

  it('leaves out the previous-review section in the first round', () => {
    const prompt = reviewPrompt(ctx({ id: 'review', kind: 'review' }), 'abc123', ' 1 file');
    expect(prompt).not.toContain('上一轮评审的意见');
    expect(prompt).not.toContain('逐条确认');
  });

  it('limits must-fix issues and asks for Chinese review text', () => {
    const prompt = reviewPrompt(ctx({ id: 'review', kind: 'review' }), 'abc123', '');
    expect(prompt).toContain('must（必须修改）：只限以下情况');
    for (const s of ['没有达成目标', '破坏了已有功能', '改动的行为缺少测试', 'AGENTS.md']) {
      expect(prompt).toContain(s);
    }
    expect(prompt).toContain('超出目标范围的改进、边缘情况的打磨、风格偏好');
    expect(prompt).toContain('不要要求扩大改动范围');
    expect(prompt).toContain('summary 和每条问题的 description 都用中文书写');
  });

  const asked: AssessmentEntry = {
    role: 'assessor',
    verdict: 'ask',
    summary: '范围不清',
    questions: ['改哪些页面？'],
    suggestions: [],
    revisedGoal: null,
    proposedDrop: false,
    stageRunId: 'sr',
    at: '2026-11-20T00:00:00Z',
  };
  const timeout: ReplyTimeoutEntry = { role: 'timeout', hours: 24, at: '2026-11-21T00:00:00Z' };

  it('asks the round after nobody replied to decide on its own: go with assumptions, or drop', () => {
    const prompt = assessPrompt(ctx({ id: 'assess', kind: 'assess' }), [asked, timeout], null);
    expect(prompt).toContain('### 第 1 轮评估：需要讨论');
    expect(prompt).toContain('改哪些页面？');
    expect(prompt).toContain('### 24 小时内没有人回复');
    expect(prompt).toContain('上面的疑问 24 小时内没有人回复，这一轮由你自己决定，不能再给 ask');
    expect(prompt).toContain('逐条写明你对之前的疑问做了哪些假设');
    expect(prompt).toContain('drop（不做）：认为不该做时给出，summary 写明理由');
    expect(prompt).toContain('不要写 revisedGoal');
    expect(prompt).toContain('{"verdict": "go"');
    expect(prompt).not.toContain('verdict 三选一');
    // A stage that does not wait says so instead.
    const noWait = assessPrompt(
      ctx({ id: 'assess', kind: 'assess' }),
      [asked, { ...timeout, hours: 0 }],
      null,
    );
    expect(noWait).toContain('这个阶段不等人回复，这一轮由你自己决定');
    // While the questions still wait for a reply, the usual three verdicts apply.
    expect(assessPrompt(ctx({ id: 'assess', kind: 'assess' }), [asked], null)).toContain(
      'verdict 三选一',
    );
  });

  it('carries the timeout into the assessment artifact of a go decided alone', () => {
    const go: AssessmentEntry = {
      ...asked,
      verdict: 'go',
      summary: '假设只改首页',
      questions: [],
      decidedAlone: true,
    };
    const text = assessmentArtifact(go, [asked, timeout]);
    expect(text.startsWith('需求评估结论：没人回复，按评估的假设开工\n\n假设只改首页')).toBe(true);
    expect(text).toContain('#### 24 小时内没有人回复');
  });
});

describe('commitMessage', () => {
  const base = {
    stageName: '编码',
    round: 1,
    goal: '改进提示词\n详细说明',
    summary: '改了提示词。',
    runId: 'run-1',
    agent: { id: 'claude-coder', cli: 'claude-code' },
    attempt: { model: 'opus', actualModel: 'claude-opus-5-5', effort: 'high' },
  };

  it('keeps the first round title plain and records model and effort', () => {
    expect(commitMessage(base)).toBe(
      '编码: 改进提示词\n\n改了提示词。\n\nRun: run-1\nAgent: claude-coder (claude-code, model: claude-opus-5-5, effort: high)\n',
    );
  });

  it('marks later rounds in the title', () => {
    expect(commitMessage({ ...base, round: 2 }).split('\n')[0]).toBe('编码（第 2 轮）: 改进提示词');
  });

  it('falls back to the configured model and the default effort', () => {
    const msg = commitMessage({
      ...base,
      attempt: { model: 'opus', actualModel: null, effort: null },
    });
    expect(msg).toContain('Agent: claude-coder (claude-code, model: opus, effort: 默认)');
  });
});

describe('prompts in English', () => {
  afterEach(() => setLang('zh'));
  const CJK = /[\u4e00-\u9fff]/;
  const enCtx = (stage: Partial<StageDef> = {}): PromptContext => ({
    ...ctx(stage),
    goal: 'Add feature.txt',
  });

  it('writes the task, rework, review and assessment prompts all in English', () => {
    setLang('en');
    const prompts = {
      task: taskPrompt(enCtx(), 'tests failed', 'full'),
      safeTask: taskPrompt(enCtx(), null, 'safe'),
      rework: reworkPrompt('tests failed'),
      review: reviewPrompt(enCtx({ id: 'review', kind: 'review' }), 'abc123', '', ['npm test'], {
        round: 1,
        text: 'fix the tests',
      }),
      assess: assessPrompt(enCtx({ id: 'assess', kind: 'assess' }), [], 'no JSON'),
      assessAfterReply: assessPrompt(
        enCtx({ id: 'assess', kind: 'assess' }),
        [{ role: 'human', text: 'yes, do it', source: 'issue', at: '2026-11-20T00:00:00Z' }],
        null,
      ),
      assessAlone: assessPrompt(
        enCtx({ id: 'assess', kind: 'assess' }),
        [{ role: 'timeout', hours: 2, at: '2026-11-20T00:00:00Z' }],
        'asked again',
      ),
    };
    for (const [name, prompt] of Object.entries(prompts)) {
      expect(prompt, name).not.toMatch(CJK);
    }
    expect(prompts.task.startsWith('You are a development agent scheduled by Ares.1')).toBe(true);
    expect(prompts.task).toContain('Write the summary in English.');
    expect(prompts.review).toContain('Write summary and every issue');
    expect(prompts.assess).toContain(
      'Write summary, questions, suggestions and revisedGoal in English.',
    );
    expect(prompts.assess).toContain('the goals in the README are the basis');
    expect(prompts.assessAlone).toContain('### Nobody replied within 2 hours');
    expect(prompts.assessAlone).toContain(
      'Nobody replied to the questions above within 2 hours, so you decide this round on your own, and ask is not allowed.',
    );
    expect(prompts.assessAlone).toContain('Write summary in English.');
  });

  it('reports result problems and review issues in English, still parsed back', () => {
    setLang('en');
    expect(formatFeedback('No JSON')).toBe(
      'No JSON. Give the JSON result in your last reply, as "Output format" asks.',
    );
    const denied = resultProblem({ ok: true, value: { status: 'done', summary: 'ok' } }, [
      'rm -rf x',
    ]);
    expect(denied?.message).not.toMatch(CJK);
    const issues = formatReviewIssues({
      summary: 'Mostly fine',
      issues: [
        { severity: 'must', file: 'src/x.ts', description: 'breaks the build' },
        { severity: 'suggestion', description: 'rename y' },
      ],
    });
    expect(issues).toBe(
      'Review: Mostly fine\n1. [Must fix] (src/x.ts) breaks the build\n2. [Suggestion] rename y',
    );
  });

  it('writes the assessment artifact in English', () => {
    setLang('en');
    const text = assessmentArtifact(
      {
        role: 'assessor',
        verdict: 'ask',
        summary: 'Unclear scope',
        questions: ['Which pages?'],
        suggestions: ['Start with the home page'],
        revisedGoal: null,
        proposedDrop: false,
        stageRunId: 'sr',
        at: '2026-11-20T00:00:00Z',
      },
      [],
    );
    expect(text).toBe(
      'Requirement assessment: needs discussion\n\nUnclear scope\n\nQuestions and concerns:\n1. Which pages?\n\nSuggestions:\n- Start with the home page\n',
    );
  });

  it('marks later rounds and unknown models in English commit messages', () => {
    setLang('en');
    const msg = commitMessage({
      stageName: 'Coding',
      round: 2,
      goal: 'Add feature.txt',
      summary: 'Added it',
      runId: 'r1',
      agent: { id: 'claude-coder', cli: 'claude-code' },
      attempt: { model: null, actualModel: null, effort: null },
    });
    expect(msg.startsWith('Coding (round 2): Add feature.txt')).toBe(true);
    expect(msg).toContain('model: unknown, effort: default');
  });
});
