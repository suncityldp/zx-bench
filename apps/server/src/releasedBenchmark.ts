import fs from 'node:fs';
import type { Scenario, EvalRunConfig, BenchmarkPack } from '@zxbench/types';
import { checkScenarioEligibility, createBenchmarkPack } from '@zxbench/core';

const catalogUrl = new URL('../../../data/scenarios/benchmark.json', import.meta.url);
const metadataUrl = new URL('../../../data/scenarios/benchmark-release.json', import.meta.url);
let cache: { stamp: string; byId: Map<string, Scenario>; metadata: Record<string, unknown> } | undefined;

export function releasedBenchmark() {
  const stamp = `${fs.statSync(catalogUrl).mtimeMs}:${fs.statSync(metadataUrl).mtimeMs}`;
  if (cache?.stamp === stamp) return cache;
  const scenarios = JSON.parse(fs.readFileSync(catalogUrl, 'utf8')) as Scenario[];
  const metadata = JSON.parse(fs.readFileSync(metadataUrl, 'utf8')) as Record<string, unknown>;
  const byId = new Map(scenarios.map(s => [s.id, s]));
  if (byId.size !== scenarios.length || scenarios.length !== metadata.executionInstanceCount) {
    throw new Error('Released benchmark catalogue is incomplete');
  }
  cache = { stamp, byId, metadata };
  return cache;
}

/** Read-only readiness check for startup; never edits definitions or run snapshots. */
export function releasedDatabaseStatus(rows: Array<{ id: string; scenarioHash: string }>) {
  const { byId } = releasedBenchmark();
  const stored = new Map(rows.map(row => [row.id, row]));
  const missingIds = [...byId.values()].filter(s => !stored.has(s.id)).map(s => s.id);
  const driftedIds = [...byId.values()].filter(s => stored.has(s.id)
    && stored.get(s.id)!.scenarioHash !== s.scenarioHash).map(s => s.id);
  return { ready: !missingIds.length && !driftedIds.length, expected: byId.size, missingIds, driftedIds };
}

/** The adopted execution contracts retain their historic shadow flag/hash.
 * Only an exact ID/hash in the published catalogue can use this exception.
 */
export function releasedEligibility(scenario: Scenario) {
  const release = releasedBenchmark();
  const frozen = release.byId.get(scenario.id);
  if (!frozen || frozen.scenarioHash !== scenario.scenarioHash) {
    return { eligible: false, reasons: ['题目不属于当前九模型发行题集或内容哈希不匹配'] };
  }
  const reasons = checkScenarioEligibility(frozen).reasons.filter(reason =>
    !(frozen.benchmarkSource?.releaseId === release.metadata.releaseId && reason === '开发影子题不进入正式分数'));
  const until = (frozen.requirements as { validUntil?: string } | undefined)?.validUntil;
  if (until && (!Number.isFinite(Date.parse(until)) || Date.parse(until) < Date.now())) reasons.push('gold 已过期或有效期非法');
  return { eligible: !reasons.length, reasons };
}

export function selectReleasedPack(
  rows: Array<{ id: string; scenarioHash: string; dimension: string }>,
  config: EvalRunConfig, dimensionIds?: string[],
): BenchmarkPack {
  const { byId } = releasedBenchmark();
  const requested = config.scenarioIds?.length ? new Set(config.scenarioIds) : undefined;
  const required = [...byId.values()].filter(s => (!dimensionIds?.length || dimensionIds.includes(s.dimension))
    && (!config.difficultyFilter?.length || config.difficultyFilter.includes(s.difficulty))
    && (config.specialPack !== 'migration-189' || Boolean(s.benchmarkSource))
    && (!requested || requested.has(s.id)));
  if (requested) {
    const allowed = new Set(required.map(s => s.id));
    const missing = [...requested].filter(id => !allowed.has(id));
    if (missing.length) throw new Error(`Scenario selection missing or outside released benchmark/dimension filter: ${missing.join(', ')}`);
  }
  const stored = new Map(rows.map(s => [s.id,s]));
  const missing = required.filter(s => !stored.has(s.id));
  if (missing.length) throw new Error(`Released benchmark database incomplete (${missing.length}): ${missing.slice(0,20).map(s => s.id).join(', ')}。数据库缺少当前发行题目；请保持服务运行，在项目根目录执行 node scripts/seed-benchmark.mjs 同步题库后重试。`);
  const drifted = required.filter(s => stored.get(s.id)!.scenarioHash !== s.scenarioHash);
  if (drifted.length) throw new Error(`Released benchmark database is out of sync: ${drifted.map(s => s.id).join(', ')}。数据库题目与当前发行题库不一致；请保持服务运行，在项目根目录执行 node scripts/seed-benchmark.mjs 同步题库后重试。`);
  const rejected = required.flatMap(s => {
    const { reasons } = releasedEligibility(s);
    return reasons.length ? [`${s.id}: ${reasons.join('; ')}`] : [];
  });
  if (rejected.length) throw new Error(`Released eligibility rejected: ${rejected.slice(0,20).join('\n')}`);
  // Validation above enforces the published allowlist. Freeze the complete file
  // definition, including fields not representable in ScenarioDefinition's schema.
  return createBenchmarkPack(required, 'development');
}
