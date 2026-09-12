import type { RunManifest } from '@zxbench/types';
import { analyzeRunQuality, type QualityRow } from './quality.js';
import { verifyBenchmarkPack, snapshotHash } from './contracts/pack.js';

export interface RegressionRun {
  manifest: RunManifest;
  results: Array<Omit<QualityRow, 'outputMetadata' | 'evidence'> & {
    scenarioId: string; dimension: string; safetyLevel: string;
    outputMetadata: unknown; evidence: unknown;
  }>;
}

/** Accept both a plain artifact and the existing HTTP export {success,data} envelope. */
export function parseRegressionExport(input: unknown): RegressionRun {
  if (!input || typeof input !== 'object') throw new Error('Invalid regression export');
  const envelope = input as { success?: boolean; data?: unknown };
  if (envelope.success === false) throw new Error('Export contains a failed API response');
  const run = (envelope.success === true ? envelope.data : input) as RegressionRun | undefined;
  if (!run || !Array.isArray(run.results)) throw new Error('Regression export must contain a results array');
  return run;
}

/** Fail closed for incomparability, missing rows, infra errors and provisional Judge scores. */
export function checkRegression(baseline: RegressionRun, candidate: RegressionRun, maxScoreDrop = 0) {
  if (!Number.isFinite(maxScoreDrop) || maxScoreDrop < 0) throw new Error('maxScoreDrop must be finite and nonnegative');
  const issues: string[] = [];
  for (const [label, run] of [['baseline', baseline], ['candidate', candidate]] as const) {
    const pack = run.manifest?.benchmarkPack;
    if (!pack) { issues.push(`${label}: missing frozen benchmark pack`); continue; }
    try { verifyBenchmarkPack(pack); } catch { issues.push(`${label}: invalid pack hash`); }
    const ids = run.results.map(r => r.scenarioId);
    const expected = new Set(pack.scenarios.map(s => s.id));
    if (new Set(ids).size !== ids.length) issues.push(`${label}: duplicate result IDs`);
    if (ids.length !== expected.size || ids.some(id => !expected.has(id))) issues.push(`${label}: incomplete or mismatched coverage`);
    if (run.results.some(r => !Number.isFinite(r.totalScore) || r.totalScore < 0 || r.totalScore > 100)) issues.push(`${label}: invalid score`);
    for (const row of run.results) {
      try {
        const meta = typeof row.outputMetadata === 'string' ? JSON.parse(row.outputMetadata) : row.outputMetadata;
        const audit = (meta as { evaluationAudit?: { version: number; scenarioHash: string } })?.evaluationAudit;
        const scenario = pack.scenarios.find(s => s.id === row.scenarioId);
        if (audit?.version !== 1 || audit.scenarioHash !== scenario?.scenarioHash) issues.push(`${label}: missing/mismatched result audit: ${row.scenarioId}`);
      } catch { issues.push(`${label}: malformed result metadata: ${row.scenarioId}`); }
    }
    const quality = analyzeRunQuality(run.results.map(r => ({ ...r,
      outputMetadata: typeof r.outputMetadata === 'string' ? r.outputMetadata : JSON.stringify(r.outputMetadata),
      evidence: typeof r.evidence === 'string' ? r.evidence : JSON.stringify(r.evidence),
    })), expected.size);
    if (quality.environmentErrorCount || quality.partialEnvironmentErrors || !quality.scoringComplete || quality.constraintMetrics.unmeasuredCriteria) {
      issues.push(`${label}: incomplete scoring or environment errors`);
    }
  }
  if (baseline.manifest?.benchmarkPack?.hash !== candidate.manifest?.benchmarkPack?.hash) issues.push('Benchmark packs differ');
  if (baseline.manifest?.scorers?.configHash !== candidate.manifest?.scorers?.configHash) issues.push('Scoring configuration differs');
  if (baseline.manifest?.scorers?.version !== candidate.manifest?.scorers?.version) issues.push('Scorer versions differ');
  if (baseline.manifest?.judgeIdentityHash !== candidate.manifest?.judgeIdentityHash) issues.push('Judge identity or parameters differ');
  if (snapshotHash(baseline.manifest?.config ?? {}) !== snapshotHash(candidate.manifest?.config ?? {})) issues.push('Evaluation parameters differ');
  const byId = new Map(baseline.results.map(r => [r.scenarioId, r]));
  const deltas = candidate.results.flatMap(r => byId.has(r.scenarioId)
    ? [{ scenarioId: r.scenarioId, dimension: r.dimension, delta: r.totalScore - byId.get(r.scenarioId)!.totalScore }] : []);
  const meanDelta = deltas.length ? deltas.reduce((n, r) => n + r.delta, 0) / deltas.length : null;
  if (meanDelta === null || meanDelta < -maxScoreDrop) issues.push('Paired mean score regressed');
  const dimensions = [...new Set(deltas.map(r => r.dimension))].map(dimension => {
    const rows = deltas.filter(r => r.dimension === dimension);
    const delta = rows.reduce((n, r) => n + r.delta, 0) / rows.length;
    if (delta < -maxScoreDrop) issues.push(`Dimension regressed: ${dimension}`);
    return { dimension, delta };
  });
  const metrics = [baseline, candidate].map(run => analyzeRunQuality(run.results.map(r => ({ ...r,
    outputMetadata: typeof r.outputMetadata === 'string' ? r.outputMetadata : JSON.stringify(r.outputMetadata),
    evidence: typeof r.evidence === 'string' ? r.evidence : JSON.stringify(r.evidence),
  })), run.results.length).constraintMetrics);
  if (metrics[1].scoredSamples < metrics[0].scoredSamples) issues.push('Criterion evidence coverage decreased');
  if (metrics[0].strictPassRate != null && (metrics[1].strictPassRate == null || metrics[1].strictPassRate < metrics[0].strictPassRate)) issues.push('Strict pass rate regressed');
  if (metrics[1].criticalFailures > 0) issues.push('Critical constraint failed');
  if (candidate.results.some(r => r.safetyLevel === 'red_line')) issues.push('Safety red line violated');
  return { passed: issues.length === 0, issues, meanDelta, dimensions, constraintMetrics: metrics[1],
    regressions: deltas.filter(r => r.delta < 0).sort((a, b) => a.delta - b.delta) };
}
