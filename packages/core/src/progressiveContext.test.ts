import { describe, expect, it } from 'vitest';
import type { Scenario } from '@zxbench/types';
import { buildEvidenceExam } from './evaluationLab/evidenceExam/index.js';
import { buildProgressiveHistory } from './progressiveContext.js';

describe('progressive official-run context', () => {
  const parts = buildEvidenceExam().parts.filter(part => part.groupId === 'DX3-01');
  const scenarios = parts.map(part => ({
    id: part.id, category: 'ultra_progressive_exam', dimension: part.dimension,
    promptTemplate: part.question.messages[0].content,
    requirements: { groupId: part.groupId, partNumber: part.number, questionHash: part.question.questionHash },
  })) as Scenario[];

  it('carries frozen prior question and committed answer, not a grading hint', () => {
    const results = new Map([['DX3-01-P1', {
      modelOutput: 'draft\n{"item":"result","answer":{"value":1}}\ntruncated {',
    }]]);
    expect(buildProgressiveHistory(scenarios[1], scenarios, results)).toEqual([
      { role: 'user', content: scenarios[0].promptTemplate },
      { role: 'assistant', content: '{"item":"result","answer":{"value":1}}' },
    ]);
  });

  it('fails closed if a previous turn has not completed', () => {
    expect(() => buildProgressiveHistory(scenarios[1], scenarios, new Map())).toThrow('Missing frozen prior part');
  });

  it('keeps the frozen prior prompt when only its historical hard time limit changed', () => {
    const frozenPrior = {
      ...scenarios[0],
      promptTemplate: scenarios[0].promptTemplate.replace('时限300秒', '时限180秒'),
      requirements: { ...scenarios[0].requirements, questionHash: 'legacy-time-limit-hash' },
    } as Scenario;
    const frozenScenarios = [frozenPrior, ...scenarios.slice(1)];
    const results = new Map([['DX3-01-P1', {
      modelOutput: '{"item":"result","answer":{"value":1}}',
    }]]);

    expect(buildProgressiveHistory(frozenScenarios[1], frozenScenarios, results)).toEqual([
      { role: 'user', content: frozenPrior.promptTemplate },
      { role: 'assistant', content: '{"item":"result","answer":{"value":1}}' },
    ]);
  });

  it('still fails closed if a historical prompt has non-time-limit drift', () => {
    const frozenPrior = {
      ...scenarios[0],
      promptTemplate: scenarios[0].promptTemplate.replace('时限300秒', '时限180秒').replace('订单O-42', '订单O-43'),
      requirements: { ...scenarios[0].requirements, questionHash: 'unrelated-drift-hash' },
    } as Scenario;
    const frozenScenarios = [frozenPrior, ...scenarios.slice(1)];
    const results = new Map([['DX3-01-P1', {
      modelOutput: '{"item":"result","answer":{"value":1}}',
    }]]);

    expect(() => buildProgressiveHistory(frozenScenarios[1], frozenScenarios, results))
      .toThrow('Progressive paper drift: DX3-01-P1');
  });
});
