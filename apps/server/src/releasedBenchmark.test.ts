import { describe, expect, it } from 'vitest';
import { releasedBenchmark, releasedDatabaseStatus, selectReleasedPack } from './releasedBenchmark.js';
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
    expect(() => selectReleasedPack(bank.slice(1),config)).toThrow(/node scripts\/seed-benchmark\.mjs/);
  });
  it('rejects hash drift and retains the adopted frozen execution content', () => {
    const item = bank.find(s => s.benchmarkSource)!;
    expect(() => selectReleasedPack([{ ...item,scenarioHash:'new-unapproved-version' }],
      { ...config,scenarioIds:[item.id] })).toThrow(/out of sync/);
    const pack = selectReleasedPack([item],{ ...config,evaluationMode:'official',scenarioIds:[item.id] });
    expect(pack.scenarios[0]).toEqual(item);
  });
});

describe('startup bank readiness', () => {
  it('reports an empty install and the missing migration definitions from an upgrade', () => {
    const empty = releasedDatabaseStatus([]);
    expect(empty.ready).toBe(false);
    expect(empty.missingIds).toHaveLength(920);
    const previous = bank.filter(s => !s.benchmarkSource);
    const result = releasedDatabaseStatus(previous);
    expect(result.missingIds).toHaveLength(306);
    for (const [dimension, count] of Object.entries({ cli_deep_tasks:56, safety_authority:60, tool_cli_workflow:98, agent_workflow:87 })) {
      expect(bank.filter(s => result.missingIds.includes(s.id) && s.dimension === dimension)).toHaveLength(count);
    }
    expect(result.driftedIds).toEqual([]);
  });
  it('detects same-ID hash drift and accepts complete imports with unrelated rows', () => {
    const changed = bank.map((s, i) => i === 0 ? { ...s, scenarioHash:'stale' } : s);
    const result = releasedDatabaseStatus(changed);
    expect(result.ready).toBe(false);
    expect(result.missingIds).toEqual([]);
    expect(result.driftedIds).toEqual([bank[0].id]);
    expect(releasedDatabaseStatus([...bank,{ id:'custom',scenarioHash:'custom' }]).ready).toBe(true);
  });
});
