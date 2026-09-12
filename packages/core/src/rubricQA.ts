import type { CalibrationRecord } from '@zxbench/types';
import { snapshotHash } from './contracts/pack.js';

/** Descriptive offline diagnostics. Never edits rubrics or trains against holdout labels. */
export function analyzeRubricQuality(records: CalibrationRecord[]) {
  const usable = records.filter(r => r.candidate.split !== 'blind_holdout' && r.summary.exportable);
  const answerGroups = new Map<string, CalibrationRecord[]>();
  for (const r of usable) {
    const key = `${r.candidate.scenarioContentHash}:${r.candidate.automaticGraderVersion}:${r.candidate.answerHash}`;
    answerGroups.set(key, [...(answerGroups.get(key) ?? []), r]);
  }
  const inconsistentAnswers = [...answerGroups.entries()].filter(([, rows]) =>
    new Set(rows.map(r => snapshotHash(r.summary.labels))).size > 1 ||
    new Set(rows.map(r => snapshotHash(r.candidate.automaticCriteria.map(c => ({ id: c.id, status: c.status }))))).size > 1,
  );
  const excludedIds = new Set(inconsistentAnswers.flatMap(([, rows]) => rows.map(r => r.candidate.id)));
  const groups = new Map<string, CalibrationRecord[]>();
  for (const r of usable.filter(r => !excludedIds.has(r.candidate.id))) {
    const key = `${r.candidate.scenarioContentHash}:${r.candidate.automaticGraderVersion}`;
    // Repeated identical answers should not inflate criterion activation sample size.
    if (!(groups.get(key) ?? []).some(other => other.candidate.answerHash === r.candidate.answerHash)) groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  let comparisons = 0, correct = 0, criticalFalsePasses = 0, expectedLabels = 0;
  const scenarios = [...groups.entries()].map(([scenarioHash, rows]) => {
    const criteria = rows[0].candidate.criteria.map(criterion => {
      let passed = 0, measured = 0, compared = 0, matched = 0, falsePass = 0, falseFail = 0;
      for (const row of rows) {
        expectedLabels++;
        const auto = row.candidate.automaticCriteria.find(c => c.id === criterion.id)?.status;
        const human = row.summary.labels?.[criterion.id];
        if (auto === 'pass' || auto === 'fail') {
          measured++; if (auto === 'pass') passed++;
          if (human === 'pass' || human === 'fail') {
            compared++; comparisons++; if (auto === human) { matched++; correct++; }
            if (auto === 'pass' && human === 'fail') { falsePass++; if (criterion.critical) criticalFalsePasses++; }
            if (auto === 'fail' && human === 'pass') falseFail++;
          }
        }
      }
      return { id: criterion.id, critical: criterion.critical, measured, activationRate: measured ? passed / measured : null,
        agreement: compared ? matched / compared : null, compared, falsePass, falseFail,
        nonDiscriminating: measured >= 3 && (passed === 0 || passed === measured),
        recommendation: criterion.critical ? 'Retain critical guardrail; review false passes manually' : 'Diagnostic only; do not auto-delete' };
    });
    const redundantPairs: Array<[string, string]> = [];
    // Bound pairwise work for externally supplied giant rubrics.
    for (let i = 0; i < Math.min(criteria.length, 100); i++) for (let j = i + 1; j < Math.min(criteria.length, 100); j++) {
      const pairs = rows.map(r => [r.candidate.automaticCriteria.find(c => c.id === criteria[i].id)?.status, r.candidate.automaticCriteria.find(c => c.id === criteria[j].id)?.status])
        .filter(([a, b]) => (a === 'pass' || a === 'fail') && (b === 'pass' || b === 'fail'));
      if (pairs.length >= 3 && pairs.every(([a, b]) => a === b)) redundantPairs.push([criteria[i].id, criteria[j].id]);
    }
    return { scenarioId: rows[0].candidate.scenario.id, groupKey: scenarioHash,
      scenarioHash: rows[0].candidate.scenarioContentHash, automaticGraderVersion: rows[0].candidate.automaticGraderVersion,
      distinctAnswers: rows.length, criteria, redundantPairs };
  });
  const judgeVariances = usable.flatMap(r => {
    const scores = r.candidate.judgeScoreHistory;
    if (scores.length < 2 || scores.some(s => !Number.isFinite(s))) return [];
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    return [{ candidateId: r.candidate.id, n: scores.length, stdDev: Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / (scores.length - 1)) }];
  });
  return { reviewedCandidates: usable.length, excludedHoldout: records.filter(r => r.candidate.split === 'blind_holdout').length,
    inconsistentAnswerGroups: inconsistentAnswers.map(([key, rows]) => ({ key, candidateIds: rows.map(r => r.candidate.id) })),
    comparisons, agreement: comparisons ? correct / comparisons : null,
    labelCoverage: expectedLabels ? comparisons / expectedLabels : null, criticalFalsePasses, scenarios, judgeVariances,
    warnings: ['Descriptive diagnostics, not proof of quality; inspect strata and independent held-out data.',
      'Constant activation or redundant labels never authorize automatic removal of a critical constraint.'] };
}
