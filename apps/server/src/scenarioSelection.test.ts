import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { selectScenarioPack, selectionConfig } from './scenarioSelection.js';
import type { EvalRunConfig } from '@zxbench/types';
const config = { runsPerQuestion:1, evaluationMode:'official' } as EvalRunConfig;
const bank = JSON.parse(readFileSync('data/scenarios/benchmark.json','utf8'));
const rows = bank.map((s: any) => ({ ...s, scoring:JSON.stringify(s.scoring), requirements:JSON.stringify(s.requirements), tags:JSON.stringify(s.tags) }));

describe('one authoritative released selector', () => {
  it('persists identical single/batch filters and empty filters mean the complete adopted release', () => {
    expect(selectScenarioPack(rows,config).scenarios).toHaveLength(920);
    const selected = selectionConfig(config,{ dimensionIds:['program'], difficultyIds:['hard'] });
    expect(selected.difficultyFilter).toEqual(['hard']);
    const expected = bank.filter((s: any) => s.dimension === 'program' && s.difficulty === 'hard').map((s: any) => s.id).sort();
    expect(selectScenarioPack(rows,selected).scenarios.map(s => s.id).sort()).toEqual(expected);
    expect(() => selectScenarioPack(rows,selectionConfig(config,{ scenarioIds:['CLI-CN-002'] }))).toThrow('outside released benchmark');
  });
  it.each([{ difficultyFilter:['extreme'] },{ dimensionFilter:['typo'] },{ specialPack:'mixed' },{ evaluationMode:'prod' },{ parallelMode:'unlimited' },{ constraints:{ onLimit:'truncate' } }])('rejects invalid enums before pack freezing: %j', invalid => {
    expect(() => selectScenarioPack(rows,{ ...config,...invalid } as EvalRunConfig)).toThrow('Invalid');
  });
  it('keeps the 306 adopted migration instances fixed despite optional filters', () => {
    const normalized = selectionConfig({ ...config,specialPack:'migration-189',runsPerQuestion:3,judgeEnabled:true },{ dimensionIds:['program'],difficultyIds:['easy'] });
    expect(normalized).toMatchObject({ dimensionFilter:[],difficultyFilter:[],runsPerQuestion:1,judgeEnabled:false });
    const frozen = selectScenarioPack(rows,normalized);
    expect(frozen.scenarios).toHaveLength(306);
    expect(new Set(frozen.scenarios.map(s => s.benchmarkSource!.id)).size).toBe(189);
    expect(() => selectScenarioPack(rows.slice(1),normalized)).toThrow('incomplete');
    const first = frozen.scenarios[0];
    expect(() => selectScenarioPack([{ ...rows.find((s: any) => s.id === first.id),scenarioHash:'stale' }],{ ...config,scenarioIds:[first.id] })).toThrow('out of sync');
  });
  it('rejects an incomplete default bank even in development mode', () => {
    expect(() => selectScenarioPack(rows.slice(1),{ ...config,evaluationMode:'development' })).toThrow('incomplete');
  });
});
