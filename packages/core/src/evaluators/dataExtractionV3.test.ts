import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { OutputMetadata, Scenario } from '@zxbench/types';
import { hashScenarioShort } from '../contracts/canonicalize.js';
import { validateScenario } from '../contracts/validateScenario.js';
import { dataExtractionEvaluator } from './dataExtraction.js';

const bank: Scenario[] = JSON.parse(readFileSync(new URL('../../../../data/scenarios/benchmark.json', import.meta.url), 'utf8'));
const scenarios = bank.filter((scenario) => scenario.dimension === 'data_extraction');
const scenario = (id: string) => scenarios.find((item) => item.id === id)!;
const meta = { finishReason:'stop', truncated:false, incomplete:false } as OutputMetadata;
const expected = (item: Scenario) => (item.requirements as unknown as {expected: unknown}).expected;

describe('reviewed data-extraction v3 bank', () => {
  it('freezes 56 unique, reviewed and hash-valid scenarios', () => {
    expect(scenarios).toHaveLength(56);
    expect(new Set(scenarios.map((item) => item.id)).size).toBe(56);
    expect(scenarios.filter((item) => item.reviewStatus === 'verified')).toHaveLength(56);
    for (const item of scenarios) {
      expect(item).toMatchObject({grader:'json_atomic_fields', graderVersion:'json_atomic_v3', scenarioVersion:'3.0.0', outputPolicy:'raw_only'});
      expect(item.goldSource).toBe('zxbench:data-extraction-manual-review-2026-09-12');
      expect(item.scenarioHash).toBe(hashScenarioShort(item));
      expect(validateScenario(item, {strict:true}).errors).toEqual([]);
      expect(item.promptTemplate).toContain('输出契约（唯一有效要求）');
    }
  });

  it('keeps a usable difficulty gradient while adding 21 non-trivial cases', () => {
    const added = scenarios.filter((item) => Number(item.id.slice(-3)) >= 36);
    expect(added).toHaveLength(21);
    expect(added.some((item) => item.difficulty === 'easy')).toBe(false);
    expect(added.filter((item) => item.difficulty === 'hard').length).toBeGreaterThanOrEqual(14);
    expect(added.filter((item) => item.difficulty === 'adversarial').length).toBeGreaterThanOrEqual(4);
  });

  it('awards every frozen gold answer exactly 100 without a Judge', async () => {
    for (const item of scenarios) {
      const result = await dataExtractionEvaluator.evaluate(item, JSON.stringify(expected(item)), meta);
      expect(result.totalScore, item.id).toBe(100);
      expect(result.axisEvidence, item.id).toEqual({
        format_valid:'rule', field_accuracy:'rule', completeness:'rule', schema_compliance:'rule', output_discipline:'rule',
      });
    }
  });

  it('freezes the formerly broken array and nested-order contracts in full', () => {
    expect(expected(scenario('DE-CN-002'))).toHaveLength(3);
    expect((expected(scenario('DE-CN-002')) as any)[2]).toEqual({
      reviewer:'赵六', product:'Apple Watch Series 9', rating:4, comment:null, order_id:'AW20240320003',
    });
    expect((expected(scenario('DE-CN-004')) as any).items).toHaveLength(3);
    expect((expected(scenario('DE-CN-004')) as any).items[2].spec).toBeNull();
  });

  it('rejects type coercion, missing nulls, extra keys and fenced JSON', async () => {
    const toggle = scenario('DE-CN-041');
    const gold = expected(toggle) as any;
    const wrongType = await dataExtractionEvaluator.evaluate(toggle, JSON.stringify({...gold, rollout_percent:'0'}), meta);
    expect(wrongType.axisScores?.field_accuracy).toBeLessThan(100);
    expect(wrongType.axisScores?.schema_compliance).toBeLessThan(100);

    const {disabled_reason: _removed, ...missingNull} = gold;
    const missing = await dataExtractionEvaluator.evaluate(toggle, JSON.stringify(missingNull), meta);
    expect(missing.axisScores?.completeness).toBeLessThan(100);

    const extra = await dataExtractionEvaluator.evaluate(toggle, JSON.stringify({...gold, explanation:'none'}), meta);
    expect(extra.axisScores?.schema_compliance).toBe(0);
    expect(extra.axisScores?.output_discipline).toBe(0);
    expect(extra.totalScore).toBeLessThanOrEqual(80);

    const fenced = await dataExtractionEvaluator.evaluate(toggle, `\`\`\`json\n${JSON.stringify(gold)}\n\`\`\``, meta);
    expect(fenced.axisScores?.output_discipline).toBe(0);
    expect(fenced.totalScore).toBe(90);
  });

  it('independently checks normalized and reconciled gold values', () => {
    expect((expected(scenario('DE-CN-037')) as any).recognized_revenue).toBe(120000 + 64000 * .5 + 29500);
    expect((expected(scenario('DE-CN-040')) as any).duration_seconds).toBe((Date.parse('2026-09-01T01:20:45Z') - Date.parse('2026-09-01T01:15:30Z')) / 1000);
    expect((expected(scenario('DE-CN-052')) as any).fx_gain_loss).toBe(-22 * 1000);
    const temperatures = (expected(scenario('DE-CN-054')) as any).temperatures as number[];
    expect(Number((temperatures.reduce((a,b) => a + b, 0) / temperatures.length).toFixed(1))).toBe(21.8);
    expect((expected(scenario('DE-CN-055')) as any).payable).toBe(4299 * 2 - 300);
  });
});
