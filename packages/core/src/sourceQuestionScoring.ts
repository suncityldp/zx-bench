import type { Scenario } from '@zxbench/types';
import { buildDimAvgWeightLookups, classifyEngineeringFailure, computeDifficultyWeightedDimAvgs } from './scoring.js';
import type { DimAvgExclusionStats, EngineeringFailureInput } from './scoring.js';

type ScoreRow = EngineeringFailureInput & { scenarioId: string; dimension: string; totalScore: number };

/** A source with multiple execution instances gets one original source weight.
 * Only new snapshots carrying explicit release metadata use this projection;
 * historic manifests keep their previous aggregation semantics.
 */
export function computeSourceQuestionDimAvgs(results: ScoreRow[], scenarios: Scenario[], statsOut?: DimAvgExclusionStats): Map<string, number> {
  const byId = new Map(scenarios.map(s => [s.id,s]));
  const weights: Array<{ id: string; difficulty?: string; category?: string; requirements?: unknown }> = [...scenarios];
  const projected: ScoreRow[] = [];
  const groups = new Map<string, { source: NonNullable<Scenario['benchmarkSource']>; rows: ScoreRow[] }>();
  for (const row of results) {
    const source = byId.get(row.scenarioId)?.benchmarkSource;
    if (!source) { projected.push(row); continue; }
    const key = `${source.releaseId}/${source.id}`;
    const group = groups.get(key) ?? { source, rows: [] };
    group.rows.push(row); groups.set(key,group);
  }
  for (const [key,{ source,rows }] of groups) {
    weights.push({ ...source, id: key });
    // Exclude incomplete/invalid source groups; averaging only successful
    // instances would improve a source score when its harder instance failed.
    const failed = rows.filter(r => classifyEngineeringFailure(r));
    if (failed.length) {
      const lookup = buildDimAvgWeightLookups(scenarios);
      computeDifficultyWeightedDimAvgs(failed,lookup.difficultyLookup,lookup.attackLookup,lookup.weightOverrideLookup,statsOut);
      continue;
    }
    if (new Set(rows.map(r => r.scenarioId)).size !== source.taskCount) continue;
    projected.push({ scenarioId:key, dimension:source.dimension,
      totalScore:rows.reduce((sum,r) => sum+r.totalScore,0)/rows.length });
  }
  const lookup = buildDimAvgWeightLookups(weights);
  return computeDifficultyWeightedDimAvgs(projected,lookup.difficultyLookup,lookup.attackLookup,lookup.weightOverrideLookup,statsOut);
}
