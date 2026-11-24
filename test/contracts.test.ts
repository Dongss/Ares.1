import { afterEach, describe, expect, it } from 'vitest';
import {
  ASSESS_REPORT_JSON_SCHEMA,
  AssessReportSchema,
  deniedOperations,
  extractStructured,
  formatPlan,
  formatReviewIssues,
  MAX_PLAN_TASKS,
  PLAN_REPORT_JSON_SCHEMA,
  PlanReportSchema,
  parseReport,
  ReviewReportSchema,
  resultProblem,
  TASK_REPORT_JSON_SCHEMA,
  TaskReportSchema,
} from '../src/engine/contracts.js';
import { setLang } from '../src/i18n.js';

describe('agent output contracts', () => {
  it('prefers the CLI structured output', () => {
    expect(extractStructured({ a: 1 }, '```json\n{"a":2}\n```')).toEqual({ a: 1 });
  });

  it('takes the last ```json block, or the whole message', () => {
    const msg = 'x\n```json\n{"a":1}\n```\nmore\n```json\n{"a":2}\n```\n';
    expect(extractStructured(undefined, msg)).toEqual({ a: 2 });
    expect(extractStructured(null, ' {"a":3} ')).toEqual({ a: 3 });
    expect(extractStructured(undefined, 'no json here')).toBeUndefined();
  });

  it('validates against the schema with readable errors', () => {
    const ok = parseReport(
      TaskReportSchema,
      undefined,
      '```json\n{"status":"done","summary":"s"}\n```',
    );
    expect(ok).toEqual({ ok: true, value: { status: 'done', summary: 's' } });
    const bad = parseReport(TaskReportSchema, { status: 'finished' }, '');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/status/);
  });

  it('exports a JSON schema usable with --json-schema', () => {
    expect(TASK_REPORT_JSON_SCHEMA).toMatchObject({
      type: 'object',
      required: ['status', 'summary'],
    });
    // Claude Code rejects the draft 2020-12 $schema marker (found by test/real).
    expect(TASK_REPORT_JSON_SCHEMA).not.toHaveProperty('$schema');
  });

  it('lists each denied operation on one line and reads the list back', () => {
    const done = parseReport(TaskReportSchema, { status: 'done', summary: 's' }, '');
    const denials = [
      'Bash: git commit -m "a"',
      'Bash: cat <<EOF > x\n  line one\n\tline two\nEOF',
      'Read: /etc/hosts',
    ];
    const problem = resultProblem(done, denials);
    expect(problem?.kind).toBe('denied');
    const message = problem?.message ?? '';
    expect(message.split('\n')).toHaveLength(1 + denials.length);
    expect(message).toContain('- Bash: cat <<EOF > x line one line two EOF');
    expect(deniedOperations(message)).toEqual([
      'Bash: git commit -m "a"',
      'Bash: cat <<EOF > x line one line two EOF',
      'Read: /etc/hosts',
    ]);
  });

  it('reads no denied operations from other feedback', () => {
    const incomplete = parseReport(TaskReportSchema, { status: 'incomplete', summary: '- x' }, '');
    const bad = parseReport(TaskReportSchema, undefined, 'no json');
    expect(deniedOperations(resultProblem(incomplete, ['Bash: ls'])?.message ?? '')).toEqual([]);
    expect(deniedOperations(resultProblem(bad, ['Bash: ls'])?.message ?? '')).toEqual([]);
    expect(deniedOperations('做完了')).toEqual([]);
    expect(deniedOperations('')).toEqual([]);
  });

  it('formats review issues with their severity', () => {
    const report = ReviewReportSchema.parse({
      summary: '基本可以',
      issues: [
        { severity: 'must', file: 'a.ts', description: '有 bug' },
        { severity: 'suggestion', description: '命名可以更好' },
      ],
    });
    expect(formatReviewIssues(report)).toBe(
      '评审结论：基本可以\n1. [必须修改]（a.ts） 有 bug\n2. [建议] 命名可以更好',
    );
  });

  it('takes a plan of 1 to 8 steps, each with a title and instructions', () => {
    const step = (n: number) => ({ title: ` 第 ${n} 步 `, instructions: `做第 ${n} 步` });
    const ok = parseReport(PlanReportSchema, { tasks: [step(1), step(2)] }, '');
    expect(ok).toEqual({
      ok: true,
      value: {
        tasks: [
          { title: '第 1 步', instructions: '做第 1 步' },
          { title: '第 2 步', instructions: '做第 2 步' },
        ],
      },
    });
    if (ok.ok)
      expect(formatPlan(ok.value)).toBe('1. 第 1 步\n\n做第 1 步\n\n2. 第 2 步\n\n做第 2 步');
    expect(
      parseReport(PlanReportSchema, { tasks: Array.from({ length: 8 }, (_, i) => step(i)) }, '').ok,
    ).toBe(true);
    // No step at all would leave the stage with nothing to do; more than 8 cost more than they save.
    for (const tasks of [[], Array.from({ length: MAX_PLAN_TASKS + 1 }, (_, i) => step(i))]) {
      const bad = parseReport(PlanReportSchema, { tasks }, '');
      expect(bad.ok ? '' : bad.error).toMatch(/^JSON 结果不符合约定：tasks: /);
    }
    for (const broken of [
      { title: '', instructions: 'x' },
      { title: 'x', instructions: ' ' },
      { title: 'x' },
    ]) {
      expect(parseReport(PlanReportSchema, { tasks: [broken] }, '').ok).toBe(false);
    }
    expect(PLAN_REPORT_JSON_SCHEMA).toMatchObject({
      type: 'object',
      required: ['tasks'],
      properties: { tasks: { type: 'array', minItems: 1, maxItems: MAX_PLAN_TASKS } },
    });
    expect(PLAN_REPORT_JSON_SCHEMA).not.toHaveProperty('$schema');
  });

  it('takes an optional size of S, M or L in an assessment', () => {
    const base = { verdict: 'go', summary: 'fine' };
    for (const size of ['S', 'M', 'L']) {
      const parsed = parseReport(AssessReportSchema, { ...base, size }, '');
      expect(parsed.ok && parsed.value.size).toBe(size);
    }
    const without = parseReport(AssessReportSchema, base, '');
    expect(without.ok && without.value.size).toBeUndefined();
    // Also with ask and drop.
    expect(
      parseReport(AssessReportSchema, { verdict: 'drop', summary: 's', size: 'M' }, '').ok,
    ).toBe(true);
    for (const size of ['XL', 's', '', 3]) {
      expect(parseReport(AssessReportSchema, { ...base, size }, '').ok).toBe(false);
    }
    expect(ASSESS_REPORT_JSON_SCHEMA).toMatchObject({
      properties: { size: { type: 'string', enum: ['S', 'M', 'L'] } },
    });
    expect((ASSESS_REPORT_JSON_SCHEMA as { required: string[] }).required).not.toContain('size');
  });

  it('takes an optional difficulty of low, mid or high in an assessment', () => {
    const base = { verdict: 'go', summary: 'fine' };
    for (const difficulty of ['low', 'mid', 'high']) {
      const parsed = parseReport(AssessReportSchema, { ...base, difficulty }, '');
      expect(parsed.ok && parsed.value.difficulty).toBe(difficulty);
    }
    // A go without one is not a format error.
    const without = parseReport(AssessReportSchema, base, '');
    expect(without.ok).toBe(true);
    expect(without.ok && without.value.difficulty).toBeUndefined();
    // Also with ask and drop.
    expect(
      parseReport(AssessReportSchema, { verdict: 'drop', summary: 's', difficulty: 'high' }, '').ok,
    ).toBe(true);
    for (const difficulty of ['medium', 'LOW', '低', '', 2]) {
      expect(parseReport(AssessReportSchema, { ...base, difficulty }, '').ok).toBe(false);
    }
    expect(ASSESS_REPORT_JSON_SCHEMA).toMatchObject({
      properties: { difficulty: { type: 'string', enum: ['low', 'mid', 'high'] } },
    });
    expect((ASSESS_REPORT_JSON_SCHEMA as { required: string[] }).required).not.toContain(
      'difficulty',
    );
  });
});

describe('agent output contracts in English', () => {
  afterEach(() => setLang('zh'));

  it('reads denied operations back whatever language they were written in', () => {
    const done = parseReport(TaskReportSchema, { status: 'done', summary: 'ok' }, '');
    setLang('en');
    const english = resultProblem(done, ['Bash: ls'])?.message ?? '';
    expect(english).toMatch(/^The following operations were denied/);
    setLang('zh');
    // Stored while the Master ran in English, read back after switching to Chinese.
    expect(deniedOperations(english)).toEqual(['Bash: ls']);
  });

  it('explains a missing or invalid result in English', () => {
    setLang('en');
    expect(parseReport(TaskReportSchema, undefined, 'no json')).toEqual({
      ok: false,
      error: 'No JSON result in the agreed format was found',
    });
    const bad = parseReport(TaskReportSchema, { status: 'maybe', summary: 'x' }, '');
    expect(bad.ok ? '' : bad.error).toMatch(/^The JSON result does not match the agreed format: /);
  });
});
