import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Scenario, OutputMetadata } from '@zxbench/types';
import { hashScenarioShort } from '../contracts/canonicalize.js';
import { dataExtractionEvaluator } from './dataExtraction.js';
import { exactAnswerLineEvaluator } from './exactAnswerLine.js';
const scenarios = JSON.parse(readFileSync(new URL('../../../../data/scenarios/benchmark.json', import.meta.url), 'utf8')) as Scenario[];
const meta = { finishReason: 'stop', truncated: false, incomplete: false } as OutputMetadata;
describe('September scenario defects', () => {
  it('requires exact normalized values for all eight numeric math scenarios', async () => {
    const numeric = scenarios.filter(s => s.dimension === 'reasoning_math' && s.grader === 'exact_answer_line' && typeof (s.requirements as any)?.answer === 'number');
    expect(numeric).toHaveLength(8);
    for (const s of numeric) {
      expect((s.scoring as any).toleranceMode).toBe('absolute');
      expect((s.scoring as any).tolerance).toBe(0);
      expect(s.scenarioHash).toBe(hashScenarioShort(s));
    }
    const tax = scenarios.find(s => s.id === 'RM-CN-032')!;
    expect((await exactAnswerLineEvaluator.evaluate(tax, 'ANSWER: 1,090.00元', meta)).axisScores?.answer_accuracy).toBe(100);
    expect((await exactAnswerLineEvaluator.evaluate(tax, 'ANSWER: 1091元', meta)).axisScores?.answer_accuracy).toBe(0);
    expect((await exactAnswerLineEvaluator.evaluate(tax, 'ANSWER: 1092元', meta)).axisScores?.answer_accuracy).toBe(0);
    const legacy = { ...tax, scoring: { type: 'exact_answer_line', tolerance: 0.01 } } as Scenario;
    expect((await exactAnswerLineEvaluator.evaluate(legacy, 'ANSWER: 1092元', meta)).axisScores?.answer_accuracy).toBe(100);
  });
  it('calculates the supplied arithmetic correctly and rejects the former gold', async () => {
    const s = scenarios.find(s => s.id === 'RM-CN-032')!;
    const expected = (25000 - 4500 - 5000 - 2000 - 1000) * 0.2 - 1410;
    expect(expected).toBe(1090);
    const good = await exactAnswerLineEvaluator.evaluate(s, `ANSWER: ${expected}元`, meta);
    const bad = await exactAnswerLineEvaluator.evaluate(s, 'ANSWER: 1340元', meta);
    expect(good.axisScores?.answer_accuracy).toBe(100);
    expect(bad.axisScores?.answer_accuracy).toBe(0);
  });
  it('scores the advertised object with nested items and detects missing product data', async () => {
    const s = scenarios.find(s => s.id === 'DE-CN-004')!;
    expect(s.promptTemplate).toContain('输出一个 JSON 对象');
    const answer = { items_count: 3, order_id: 'JD202403180077', items: [
      { name: '华为 MatePad Pro', spec: '12.6英寸 8+256GB', price: 4299, rating: 5, comment: '平板非常好用' },
      { name: '华为 M-Pencil', spec: '第二代', price: 599, rating: 4, comment: '手写笔延迟略高' },
      { name: '平板保护套', spec: null, price: 129, rating: 3, comment: '质量一般，不太贴合' },
    ] };
    const good = await dataExtractionEvaluator.evaluate(s, JSON.stringify(answer), meta);
    const missing = await dataExtractionEvaluator.evaluate(s, JSON.stringify({ ...answer, items: [] }), meta);
    expect(good.axisScores?.field_accuracy).toBe(100);
    expect(missing.axisScores?.field_accuracy).toBeLessThan(100);
  });
  it('versions each changed contract and gives it a reproducible hash', () => {
    for (const id of ['RM-CN-032', 'DE-CN-004', 'CP-L4-RS-001']) {
      const s = scenarios.find(s => s.id === id)!;
      expect(s.scenarioVersion).toBe(id === 'CP-L4-RS-001' ? '1.2.1' : id === 'RM-CN-032' ? '3.2.0' : '2.0.1');
      expect(s.scenarioHash).toBe(hashScenarioShort(s));
    }
  });
});
