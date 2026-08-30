import { describe, it, expect } from 'vitest';
import {
  DIMENSION_WEIGHTS,
  computeWeightedTotal,
  getJudgeWeights,
  mixDeterministicJudge,
  applyCoverageDiscount,
  computeDifficultyWeightedDimAvgs,
  LONG_TASK_WEIGHT,
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
    ['agent_workflow', '', 0.85, 0.15],
    ['tool_cli_workflow', '', 0.85, 0.15],
    ['cli_deep_tasks', '', 0.7, 0.3],
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

describe('mixDeterministicJudge (coverage-aware handoff, I1 judge cap)', () => {
  it('preserves total weight across coverage levels', () => {
    for (const c of [0, 0.15, 0.5, 0.8, 1]) {
      const m = mixDeterministicJudge(0.7, 0.3, c);
      expect(m.detW + m.judgeW).toBeCloseTo(1.0, 5);
    }
  });

  it('caps judge weight at JUDGE_WEIGHT_CAP (0.3), excess handed back to deterministic', () => {
    // 低覆盖 0.15：rawJudgeW = 0.3 + 0.7×0.85 = 0.895 → 封顶 0.3，detW = 0.7
    const m = mixDeterministicJudge(0.7, 0.3, 0.15);
    expect(m.judgeW).toBeCloseTo(0.3, 5);
    expect(m.detW).toBeCloseTo(0.7, 5);
  });

  it('keeps raw judge weight when below cap (high coverage)', () => {
    // 覆盖 0.9：rawJudgeW = 0.3 + 0.7×0.1 = 0.37 > 0.3 → 仍封顶
    const m = mixDeterministicJudge(0.7, 0.3, 0.9);
    expect(m.judgeW).toBeCloseTo(0.3, 5);
    expect(m.detW).toBeCloseTo(0.7, 5);
  });

  it('does not cap when raw judge weight is naturally below cap', () => {
    // program 维度 det=0.8 judge=0.2, coverage=1 → rawJudgeW = 0.2 < 0.3，原样保留
    const m = mixDeterministicJudge(0.8, 0.2, 1);
    expect(m.judgeW).toBeCloseTo(0.2, 5);
    expect(m.detW).toBeCloseTo(0.8, 5);
  });

  it('I1 regression: program AG 场景 judge 权重从 57% 压回 30%', () => {
    // 实测 AG 覆盖 0.53：修复前 judgeW = 0.2 + 0.8×0.47 ≈ 0.576 → 修复后 0.3
    const m = mixDeterministicJudge(0.8, 0.2, 0.53);
    expect(m.judgeW).toBeCloseTo(0.3, 5);
    expect(m.detW).toBeCloseTo(0.7, 5);
    expect(m.detW + m.judgeW).toBeCloseTo(1.0, 5);
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

  it('weightOverrideLookup overrides difficulty weight (long_task 3.0 > adversarial 2.5)', () => {
    // 长任务 a 得 0 分（权重 3.0），普通 adversarial b 得 100 分（权重 2.5）
    const results = [
      { scenarioId: 'a', dimension: 'program', totalScore: 0 },
      { scenarioId: 'b', dimension: 'program', totalScore: 100 },
    ];
    const lookup = new Map([['a', 'adversarial'], ['b', 'adversarial']]);
    const override = new Map([['a', LONG_TASK_WEIGHT]]);
    const avgs = computeDifficultyWeightedDimAvgs(results, lookup, undefined, override);
    // 均分 = (0*3.0 + 100*2.5) / 5.5
    expect(avgs.get('program')).toBeCloseTo((100 * 2.5) / 5.5, 5);
    // 无覆盖时两者同为 adversarial 2.5 → 均分 50
    const avgsNoOverride = computeDifficultyWeightedDimAvgs(results, lookup);
    expect(avgsNoOverride.get('program')).toBe(50);
  });

  it('weightOverrideLookup does not interfere with attackLevel multiplier', () => {
    // attackLevel 乘子与显式覆盖独立：覆盖题不应再吃难度权重
    const results = [{ scenarioId: 'a', dimension: 'hallucination_resistance', totalScore: 60 }];
    const lookup = new Map([['a', 'hard']]);
    const attack = new Map([['a', 'L4']]);
    const override = new Map([['a', 3.0]]);
    const avgs = computeDifficultyWeightedDimAvgs(results, lookup, attack, override);
    // 权重 = 3.0 × 2.0(L4) = 6.0；均分仍为 60（单题）
    expect(avgs.get('hallucination_resistance')).toBe(60);
  });
});
