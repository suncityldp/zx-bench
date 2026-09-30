import { describe, expect, it } from 'vitest';
import type { Scenario } from '@zxbench/types';
import { computeSourceQuestionDimAvgs } from './sourceQuestionScoring.js';
import { createDimAvgExclusionStats } from './scoring.js';

const source = (id: string,taskCount: number) => ({ releaseId:'nine-model-adopted-2026-09-29',id,
  scenarioHash:'frozen',dimension:'agent_workflow',difficulty:'medium' as const,category:'test',taskCount });
const bank = [{ id:'a',difficulty:'easy',benchmarkSource:source('source-a',1) },
  { id:'b0',difficulty:'adversarial',benchmarkSource:source('source-b',2) },
  { id:'b1',difficulty:'adversarial',benchmarkSource:source('source-b',2) }] as Scenario[];
const results = [{ scenarioId:'a',dimension:'agent_workflow',totalScore:100 },
  { scenarioId:'b0',dimension:'agent_workflow',totalScore:0 },
  { scenarioId:'b1',dimension:'agent_workflow',totalScore:0 }];

describe('released source-question scoring', () => {
  it('gives each source its original weight regardless of number/difficulty of task instances', () => {
    expect(computeSourceQuestionDimAvgs(results,bank).get('agent_workflow')).toBe(50);
  });
  it('does not average a source until all its instances have results', () => {
    expect(computeSourceQuestionDimAvgs(results.slice(0,2),bank).get('agent_workflow')).toBe(100);
  });
  it('excludes an entire source with an engineering failure and reports the failed instance', () => {
    const stats = createDimAvgExclusionStats();
    expect(computeSourceQuestionDimAvgs([results[0],results[1],{ ...results[2],environmentError:true }],bank,stats)
      .get('agent_workflow')).toBe(100);
    expect(stats.excludedTotal).toBe(1);
  });
  it('preserves historical task scoring when the frozen source marker is absent', () => {
    const historical = bank.map(({ benchmarkSource,...s }) => s as Scenario);
    expect(computeSourceQuestionDimAvgs(results,historical).get('agent_workflow')).toBeCloseTo(100/6);
  });
});
