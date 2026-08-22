import { describe, it, expect } from 'vitest';
import {
  DIMENSION_WEIGHTS,
  computeWeightedTotal,
  getJudgeWeights,
  mixDeterministicJudge,
  applyCoverageDiscount,
  computeDifficultyWeightedDimAvgs,
} from './scoring.js';

describe('computeWeightedTotal', () => {
  it('returns 0 for empty input', () => {
    expect(computeWeightedTotal(new Map())).toBe(0);
  });

  it('returns 100 when every dimension scores 100', () => {
    const m = new Map();
    for (const d of Object.keys(DIMENSION_WEIGHTS)) m.set(d, 100);
    expect(computeWeightedTotal(m)).toBe(100);
  });

  it('normalizes weights: a single dimension passes through its score', () => {
    expect(computeWeightedTotal(new Map([['program', 75]]))).toBe(75);
  });

  it('DIMENSION_WEIGHTS sums to 1.0', () => {
    const sum = Object.values(DIMENSION_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it('computes the weighted-total formula exactly', () => {
    const m = new Map([['program', 80], ['reasoning_math', 50]]);
    expect(computeWeightedTotal(m)).toBeCloseTo(68.75, 2);
  });
});

describe('getJudgeWeights', () => {
  const cases = [
    ['data_extraction', '', 1.0, 0.0],
    ['safety_authority', '', 1.0, 0.0],
    ['hallucination_resistance', '', 0.3, 0.7],
    ['structured_output', '', 0.9, 0.1],
    ['reasoning_math', '', 0.95, 0.05],
    ['program', '', 0.8, 0.2],
    ['bug_finding', '', 0.4, 0.6],
    ['instruction_following', '', 0.5, 0.5],
    ['agent_workflow', '', 0.7, 0.3],
    ['tool_cli_workflow', '', 0.7, 0.3],
    ['cli_deep_tasks', '', 0.5, 0.5],
    ['unknown_dim', '', 0.6, 0.4],
  ];
  for (const c of cases) {
    it(c[0] + ' -> det=' + c[2] + ' judge=' + c[3], () => {
      const w = getJudgeWeights(c[0], c[1]);
      expect(w.deterministic).toBeCloseTo(c[2], 5);
      expect(w.judge).toBeCloseTo(c[3], 5);
      expect(w.deterministic + w.judge).toBeCloseTo(1.0, 5);
    });
  }
});

describe('mixDeterministicJudge (coverage-aware handoff)', () => {
  it('preserves total weight across coverage levels', () => {
    for (const c of [0, 0.15, 0.5, 0.8, 1]) {
      const m = mixDeterministicJudge(0.7, 0.3, c);
      expect(m.detW + m.judgeW).toBeCloseTo(1.0, 5);
    }
  });

  it('hands off unmeasured deterministic weight to judge at low coverage', () => {
    const m = mixDeterministicJudge(0.7, 0.3, 0.15);
    expect(m.detW).toBeCloseTo(0.7 * 0.15, 5);
    expect(m.judgeW).toBeCloseTo(0.3 + 0.7 * (1 - 0.15), 5);
  });
});

describe('applyCoverageDiscount (regression: the GLM5.2 under-scoring bug)', () => {
  it('does not discount when coverage >= 0.5', () => {
    expect(applyCoverageDiscount(80, 0.5)).toBe(80);
    expect(applyCoverageDiscount(80, 1)).toBe(80);
  });

  it('discounts totalScore to 30% when coverage < 0.5', () => {
    expect(applyCoverageDiscount(80, 0.4)).toBe(24);
  });

  it('contract: only totalScore is discounted, deterministicScore stays raw', () => {
    const raw = 80;
    const coverage = 0.15;
    const totalScore = applyCoverageDiscount(raw, coverage);
    const deterministicScore = raw;
    expect(totalScore).toBe(24);
    expect(deterministicScore).toBe(80);
    expect(deterministicScore).not.toBe(totalScore);
  });
});

describe('computeDifficultyWeightedDimAvgs (pure)', () => {
  it('weights hard questions higher than easy ones', () => {
    const results = [
      { scenarioId: 'a', dimension: 'program', totalScore: 90 },
      { scenarioId: 'b', dimension: 'program', totalScore: 60 },
    ];
    const lookup = new Map([['a', 'hard'], ['b', 'easy']]);
    const avgs = computeDifficultyWeightedDimAvgs(results, lookup);
    expect(avgs.get('program')).toBeCloseTo(80, 5);
  });

  it('falls back to medium weight for unknown difficulty', () => {
    const results = [{ scenarioId: 'x', dimension: 'program', totalScore: 80 }];
    const avgs = computeDifficultyWeightedDimAvgs(results, new Map());
    expect(avgs.get('program')).toBe(80);
  });

  it('groups averages independently per dimension', () => {
    const results = [
      { scenarioId: 'a', dimension: 'program', totalScore: 100 },
      { scenarioId: 'b', dimension: 'reasoning_math', totalScore: 50 },
    ];
    const lookup = new Map([['a', 'medium'], ['b', 'medium']]);
    const avgs = computeDifficultyWeightedDimAvgs(results, lookup);
    expect(avgs.get('program')).toBe(100);
    expect(avgs.get('reasoning_math')).toBe(50);
  });
});
