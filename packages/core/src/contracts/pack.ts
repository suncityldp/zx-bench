import { createHash } from 'node:crypto';
import type { BenchmarkPack, Scenario } from '@zxbench/types';
import { checkScenarioEligibility } from './eligibility.js';

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k, v]) => [k, sorted(v)]),
  );
  return value;
}

/** Hash ALL serialized fields, including tool schemas, gold and judge hints. */
export function snapshotHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(sorted(JSON.parse(JSON.stringify(value))))).digest('hex');
}

export function createBenchmarkPack(scenarios: Scenario[], mode: 'development' | 'official' = 'development', now = Date.now()): BenchmarkPack {
  if (!scenarios.length) throw new Error('Benchmark pack is empty');
  if (new Set(scenarios.map(s => s.id)).size !== scenarios.length) throw new Error('Duplicate scenario IDs in benchmark pack');
  if (mode === 'official') {
    const rejected = scenarios.flatMap(s => {
      const reasons = checkScenarioEligibility(s).reasons;
      const until = (s.requirements as unknown as { validUntil?: string })?.validUntil;
      if (until && (!Number.isFinite(Date.parse(until)) || Date.parse(until) < now)) reasons.push('gold 已过期或有效期非法');
      return reasons.length ? [`${s.id}: ${reasons.join('; ')}`] : [];
    });
    if (rejected.length) throw new Error(`Official eligibility rejected (${rejected.length}): ${rejected.slice(0, 20).join('\n')}`);
  }
  const frozen: Scenario[] = JSON.parse(JSON.stringify([...scenarios].sort((a, b) => a.id.localeCompare(b.id, 'en'))));
  return { schemaVersion: 1, hash: snapshotHash(frozen), scenarios: frozen };
}

export function verifyBenchmarkPack(pack: BenchmarkPack): void {
  if (pack.schemaVersion !== 1 || !Array.isArray(pack.scenarios) || !pack.scenarios.length ||
      new Set(pack.scenarios.map(s => s.id)).size !== pack.scenarios.length || snapshotHash(pack.scenarios) !== pack.hash) {
    throw new Error('Benchmark snapshot integrity check failed');
  }
}
