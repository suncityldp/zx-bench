import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Plain Node ESM release script.
import { benchmarkCounts } from '../../../scripts/benchmark-counts.mjs';
describe('catalogue and archive count semantics', () => {
  it('counts every shadow source, not just one explicitly listed challenge', () => {
    const pack = [{ id: 'a', status: 'valid', dimension: 'math' }, { id: 'b', status: 'valid', dimension: 'math', requirements: { developmentShadow: true } }, { id: 'c', status: 'valid', dimension: 'structured', requirements: { developmentShadow: true } }, { id: 'd', status: 'retired' }];
    expect(benchmarkCounts(pack, [{ id: 'old', status: 'retired' }])).toMatchObject({ count: 3, currentRecordCount: 4, retiredCount: 1, archivedRetiredCount: 1, totalCount: 5, developmentShadowCount: 2, defaultRunCount: 1 });
    expect(() => benchmarkCounts(pack, [{ id: 'd', status: 'retired' }])).toThrow('overlaps');
  });
  it('reproduces all released derived counts and disjoint unique identities', () => {
    const bank = JSON.parse(readFileSync('data/scenarios/benchmark.json', 'utf8'));
    const archive = JSON.parse(readFileSync('data/scenarios/archive/benchmark-retired.json', 'utf8'));
    const meta = JSON.parse(readFileSync('data/scenarios/benchmark-meta.json', 'utf8'));
    const counts = benchmarkCounts(bank, archive);
    expect(counts).toMatchObject({ currentRecordCount: 920, validCount: 920, defaultRunCount: 920, sourceQuestionCount: 803, executionInstanceCount: 920, developmentShadowCount: 306, archivedRetiredCount: 141, totalCount: 1061 });
    for (const [key, value] of Object.entries(counts)) expect(meta[key], key).toEqual(value);
  });
});
