import { describe, expect, it } from 'vitest';
import { planSteps } from '../src/engine/plan.js';
import type { TaskKind } from '../src/store/types.js';

const task = (id: string, kind: TaskKind = 'work') => ({ id, kind });

describe('planSteps', () => {
  it('numbers the work tasks of a plan in order, the plan itself no step', () => {
    const steps = planSteps([task('plan', 'plan'), task('a'), task('b'), task('c')]);
    expect([...steps]).toEqual([
      ['a', { index: 1, total: 3 }],
      ['b', { index: 2, total: 3 }],
      ['c', { index: 3, total: 3 }],
    ]);
    expect(steps.has('plan')).toBe(false);
  });

  it('gives nothing for a plan of a single step', () => {
    expect(planSteps([task('plan', 'plan'), task('a')]).size).toBe(0);
  });

  it('gives nothing for a round without a plan, or whose plan has not passed yet', () => {
    expect(planSteps([task('a')]).size).toBe(0);
    expect(planSteps([task('a'), task('b')]).size).toBe(0);
    expect(planSteps([task('plan', 'plan')]).size).toBe(0);
    expect(planSteps([]).size).toBe(0);
  });
});
