import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// The production importer is plain Node ESM so users can run it without a TS loader.
// @ts-expect-error no declaration file is needed for this local script module
import { loadBenchmarkImportScope } from '../../../scripts/benchmark-import-scope.mjs';

describe('released benchmark import scope', () => {
  it('imports only the canonical bank and identifies accidental bundled history', () => {
    const scope = loadBenchmarkImportScope(path.resolve('data/scenarios'));
    // 2026-09-16：新增 MX3-13~24 十二个高难度题组（48 小问）后，正式题集共 849 条。
    const canonical = JSON.parse(readFileSync('data/scenarios/benchmark.json', 'utf8'));
    expect(scope.scenarios).toEqual(canonical);
    expect(scope.benchmarkIds.size).toBe(canonical.length);
    expect(scope.scenarios.filter((scenario: any) => scenario.dimension === 'program')).toHaveLength(150);
    expect([...scope.accidentalBundledIds].length).toBeGreaterThan(0);
    expect([...scope.accidentalBundledIds].some((id) => String(id).startsWith('CR2-'))).toBe(true);
    expect([...scope.accidentalBundledIds].some((id) => scope.benchmarkIds.has(id))).toBe(false);
  });
});
