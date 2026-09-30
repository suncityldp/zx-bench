import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { selectScenarioPack, selectionConfig } from './scenarioSelection.js';
import type { EvalRunConfig } from '@zxbench/types';
const config = { runsPerQuestion: 1, evaluationMode: 'development' } as EvalRunConfig;
const row = (id: string, difficulty = 'easy', requirements = '{}', tags = '[]') => ({ id, difficulty, dimension: 'structured_output', status: 'valid', requirements, tags, scoring: '{}', scenarioHash: id }) as never;
describe('one authoritative selector', () => {
  it('persists identical single/batch filters and empty filters mean all defaults', () => {
    const rows = [row('easy'), row('hard', 'hard'), row('shadow', 'easy', '{"developmentShadow":true}')];
    expect(selectScenarioPack(rows, config).scenarios.map(s => s.id)).toEqual(['easy', 'hard']);
    const selected = selectionConfig(config, { dimensionIds: [], difficultyIds: ['hard'] });
    expect(selected.difficultyFilter).toEqual(['hard']);
    expect(selectScenarioPack(rows, selected).scenarios.map(s => s.id)).toEqual(['hard']);
    expect(selectScenarioPack(rows, selectionConfig(config, { scenarioIds: ['shadow'] })).scenarios.map(s => s.id)).toEqual(['shadow']);
  });
  it.each([{ difficultyFilter: ['extreme'] }, { dimensionFilter: ['typo'] }, { specialPack: 'unknown' }, { evaluationMode: 'prod' }, { parallelMode: 'unlimited' }, { constraints: { onLimit: 'truncate' } }])('rejects invalid enums before pack freezing: %j', invalid => {
    expect(() => selectScenarioPack([row('a')], { ...config, ...invalid } as EvalRunConfig)).toThrow('Invalid');
  });
  it('keeps a special pack fixed despite dimension/difficulty filters', () => {
    const bank = JSON.parse(readFileSync('data/scenarios/benchmark.json', 'utf8'));
    const source = bank.filter((s: any) => s.status === 'valid' && s.tags?.includes('structured-contract-development-release'));
    const rows = source.map((s: any) => ({ ...s, scoring: JSON.stringify(s.scoring), requirements: JSON.stringify(s.requirements), tags: JSON.stringify(s.tags), goldVerifiedAt: s.goldVerifiedAt ? new Date(s.goldVerifiedAt) : null }));
    expect(selectScenarioPack(rows, { ...config, specialPack: 'mixed', dimensionFilter: ['program'], difficultyFilter: ['hard'] }).scenarios.map(s => s.id).sort()).toEqual(source.filter((s: any) => s.tags.includes('screening:mixed')).map((s: any) => s.id).sort());
    expect(selectScenarioPack(rows, { ...config, specialPack: 'all' }).scenarios).toHaveLength(source.length);
    expect(() => selectScenarioPack(rows.slice(1), { ...config, specialPack: 'all' })).toThrow('missing');
    const expired = rows.map((s: any, i: number) => i ? s : { ...s, requirements: JSON.stringify({ ...JSON.parse(s.requirements), validUntil: '2020-01-01' }) });
    expect(() => selectScenarioPack(expired, { ...config, specialPack: 'all' })).toThrow('expired');
    expect(() => selectScenarioPack(rows, { ...config, specialPack: 'all', evaluationMode: 'official' })).toThrow('development');
  });
  it('enforces expiry and does not silently shrink a fixed special pack', () => {
    const expired = row('old', 'easy', '{"validUntil":"2020-01-01"}', '["structured-contract-development-release"]');
    expect(selectScenarioPack([expired, row('current')], config).scenarios.map(s => s.id)).toEqual(['current']);
    expect(() => selectScenarioPack([expired], { ...config, specialPack: 'all' })).toThrow('missing');
  });
  it('rejects incomplete migration execution packs rather than silently selecting pilots', () => {
    expect(() => selectScenarioPack([row('CLI-PILOT-test')], { ...config, specialPack: 'migration-189' })).toThrow('incomplete');
  });
  it('freezes all 306 migration instances with hashes, and normalizes single/batch fixed-group config', () => {
    const plan = JSON.parse(readFileSync('data/execution/migration-plan.json', 'utf8'));
    const packs = ['cli-original-docker-v1', 'cli-advanced-docker-v1', 'recovery-world-docker-v1', 'cli-execution-v1', 'tool-world-v1', 'retail-docker-v1', 'shell-investigation-v1', 'special-shell-v1'];
    const pilots = new Map<string, any>(packs.flatMap(name => JSON.parse(readFileSync(`data/pilots/${name}.json`, 'utf8'))).map((s: any) => [s.id, s]));
    const rows = plan.migrationTasks.map((t: any) => {
      const path = `data/execution/tasks/${t.taskId}/scenario.json`;
      const s = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : pilots.get(t.taskId);
      return { ...s, scoring: JSON.stringify(s.scoring), requirements: JSON.stringify(s.requirements), tags: JSON.stringify(s.tags), hiddenTests: JSON.stringify(s.hiddenTests), goldVerifiedAt: s.goldVerifiedAt ? new Date(s.goldVerifiedAt) : null };
    });
    const normalized = selectionConfig({ ...config, specialPack: 'migration-189', runsPerQuestion: 3, judgeEnabled: true }, { dimensionIds: ['program'], difficultyIds: ['easy'] });
    expect(normalized).toMatchObject({ dimensionFilter: [], difficultyFilter: [], runsPerQuestion: 1, judgeEnabled: false });
    const frozen = selectScenarioPack(rows, normalized);
    expect(frozen.scenarios).toHaveLength(306);
    expect(new Set(plan.migrationTasks.map((t: any) => t.sourceId)).size).toBe(189);
    expect(() => selectScenarioPack([{ ...rows[0], scenarioHash: 'stale' }], { ...config, scenarioIds: [rows[0].id] })).toThrow('out of sync');
  });
});
