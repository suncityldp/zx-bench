import { describe, expect, it } from 'vitest';
import { releasedBenchmark, selectReleasedPack } from './releasedBenchmark.js';
import { verifyBenchmarkPack } from '@zxbench/core';
import type { EvalRunConfig } from '@zxbench/types';

const config = { runsPerQuestion:1 } as EvalRunConfig;
const bank = [...releasedBenchmark().byId.values()];

describe('nine-model default benchmark selection', () => {
  it('freezes all 920 adopted instances representing exactly 803 sources', () => {
    const rows = [...bank,{ ...bank[0],id:'CLI-CN-002' },{ ...bank[0],id:'unrelated-development' }];
    const pack = selectReleasedPack(rows,config);
    verifyBenchmarkPack(pack);
    expect(pack.scenarios).toHaveLength(920);
    expect(pack.scenarios.filter(s => s.benchmarkSource)).toHaveLength(306);
    expect(new Set(pack.scenarios.map(s => s.benchmarkSource?.id ?? s.id)).size).toBe(803);
    expect(pack.scenarios.map(s => s.id)).not.toContain('CLI-CN-002');
    expect(pack.scenarios.map(s => s.id)).not.toContain('unrelated-development');
  });
  it('rejects obsolete source IDs even with explicit development mode', () => {
    expect(() => selectReleasedPack(bank,{ ...config,evaluationMode:'development',scenarioIds:['CLI-CN-002'] }))
      .toThrow(/outside released benchmark/);
  });
  it('rejects incomplete imports before inference instead of silently shrinking the pack', () => {
    expect(() => selectReleasedPack(bank.slice(1),config)).toThrow(/database incomplete/);
  });
  it('rejects hash drift and retains the adopted frozen execution content', () => {
    const item = bank.find(s => s.benchmarkSource)!;
    expect(() => selectReleasedPack([{ ...item,scenarioHash:'new-unapproved-version' }],
      { ...config,scenarioIds:[item.id] })).toThrow(/out of sync/);
    const pack = selectReleasedPack([item],{ ...config,evaluationMode:'official',scenarioIds:[item.id] });
    expect(pack.scenarios[0]).toEqual(item);
  });
});
