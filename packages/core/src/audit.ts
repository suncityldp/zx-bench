import type { CriterionResult, ScenarioResult } from '@zxbench/types';

/** Strict AND is separate from weighted/partial-credit model scores. */
export function summarizeCriteria(criteria: CriterionResult[] = []) {
  const measured = criteria.filter(c => c.status !== 'unmeasured');
  const passed = measured.filter(c => c.status === 'pass').length;
  const critical = criteria.filter(c => c.critical);
  return {
    total: criteria.length, measured: measured.length, passed,
    strictPass: criteria.length === 0 ? null : criteria.every(c => c.status === 'pass'),
    constraintAccuracy: measured.length ? passed / measured.length : null,
    criticalPass: critical.length ? critical.every(c => c.status === 'pass') : null,
  };
}

/** Keep additive audit data inside the existing durable JSON column. */
export function attachEvaluationAudit(result: ScenarioResult, attempts?: ScenarioResult[]): ScenarioResult {
  return { ...result, outputMetadata: { ...result.outputMetadata, evaluationAudit: {
    version: 1, scenarioHash: result.scenarioHash,
    axisCoverage: result.axisCoverage,
    runtimeEvaluation: result.runtimeEvaluation,
    graderVersion: result.graderVersion,
    criterionResults: result.criterionResults,
    judgeScoreHistory: result.judgeScoreHistory,
    multiRunStats: result.multiRunStats,
    attempts,
  } } };
}
