import type { EvaluationAudit } from '@zxbench/types';
import { summarizeCriteria } from './audit.js';

import { referenceAnswerWarnings } from './referenceAnswerReview.js';
/** Diagnose saved rows, not stale in-memory attempts or display metadata. */
export interface QualityRow {
  scenarioId?: string;
  scenarioVersion?: string;
  graderVersion?: string;
  totalScore: number;
  judgeScore: number | null;
  modelOutput: string | null;
  outputMetadata: string | null;
  deterministicScore: number | null;
  environmentError?: boolean | null;
  evidence?: string | null;
}

export function analyzeRunQuality(results: QualityRow[], totalScenarios: number) {
  const audits = results.map(r => {
    try { return JSON.parse(r.outputMetadata || '{}').evaluationAudit as EvaluationAudit | undefined; }
    catch { return undefined; }
  });
  const samples = results.flatMap((r, i) => {
    if (r.environmentError) return [];
    const audit = audits[i];
    return audit?.attempts ? audit.attempts.filter(a => !a.environmentError).map(a => summarizeCriteria(a.criterionResults))
      : [summarizeCriteria(audit?.criterionResults)];
  });
  const measuredSamples = samples.filter(s => s.total > 0);
  const criteriaMeasured = samples.reduce((n, s) => n + s.measured, 0);
  const criteriaPassed = samples.reduce((n, s) => n + s.passed, 0);
  const constraintMetrics = {
    samples: samples.length, scoredSamples: measuredSamples.length,
    strictPassRate: measuredSamples.length ? measuredSamples.filter(s => s.strictPass).length / measuredSamples.length : null,
    constraintAccuracy: criteriaMeasured ? criteriaPassed / criteriaMeasured : null,
    criticalFailures: samples.filter(s => s.criticalPass === false).length,
    unmeasuredCriteria: samples.reduce((n, s) => n + s.total - s.measured, 0),
    unscoredSamples: samples.length - measuredSamples.length,
  };
  const valid = results.filter(r => !r.environmentError);
  const issues: string[] = [];
  const referenceIssues = referenceAnswerWarnings(results);
  issues.push(...referenceIssues);
  const empty = valid.filter(r => !r.modelOutput?.trim());
  const judgeZero = valid.filter(r => r.judgeScore === 0);
  const failed = valid.filter(r => {
    try {
      const audit = JSON.parse(r.outputMetadata || '{}').evaluationAudit as EvaluationAudit | undefined;
      return (JSON.parse(r.evidence || '[]') as string[]).some(e => /^(JUDGE_FAILED|JUDGE_ENSEMBLE_PARTIAL):/.test(e)) ||
        !!audit?.attempts?.some(a => a.evidence.some(e => /^(JUDGE_FAILED|JUDGE_ENSEMBLE_PARTIAL):/.test(e)));
    }
    catch { return false; }
  });
  const length = valid.filter(r => {
    try { const m = JSON.parse(r.outputMetadata || '{}'); return m.finishReason === 'length' || m.truncated || m.incomplete; }
    catch { return false; }
  });
  const zeroDet = valid.filter(r => r.deterministicScore === 0 && r.judgeScore === null);
  const partialRepeats = valid.filter(r => {
    try { return (JSON.parse(r.evidence || '[]') as string[]).some(e => e.startsWith('CANDIDATE_REPEATS_PARTIAL:')); }
    catch { return false; }
  });
  if (partialRepeats.length) issues.push(`候选重复作答未完成: ${partialRepeats.length} 题`);
  if (results.length !== totalScenarios) issues.push(`结果覆盖: ${results.length}/${totalScenarios}`);
  if (results.length !== valid.length) issues.push(`环境故障隔离: ${results.length - valid.length} 题`);
  if (empty.length) issues.push(`空输出: ${empty.length}/${valid.length} 题`);
  if (judgeZero.length) issues.push(`Judge 0 分: ${judgeZero.length} 题`);
  if (failed.length) issues.push(`Judge 失败降级: ${failed.length}/${valid.length} 题，当前分数为临时确定性分，需仅 Judge 补评`);
  if (length.length) issues.push(`输出截断(finish_reason=length): ${length.length} 题 — ${length.map(r => r.scenarioId || 'unknown').slice(0, 10).join(', ')}`);
  if (zeroDet.length) issues.push(`确定性评分为 0(Judge 未参与): ${zeroDet.length} 题`);
  const partialEnvironmentErrors = audits.reduce((n, a) => n + (a?.attempts?.filter(r => r.environmentError).length ?? 0), 0);
  if (partialEnvironmentErrors) issues.push(`重复作答环境故障: ${partialEnvironmentErrors} 次（已隔离，完整尝试记录已保留）`);
  if (constraintMetrics.unmeasuredCriteria) issues.push(`未测量约束: ${constraintMetrics.unmeasuredCriteria} 条（严格通过不放行）`);
  const threshold = Math.max(5, Math.floor(valid.length * 0.05));
  const grade: 'good' | 'warning' | 'critical' = referenceIssues.length > 0 || failed.length > 0 || empty.length > threshold || length.length > threshold
    ? 'critical' : issues.length ? 'warning' : 'good';
  return { grade, issues, constraintMetrics, partialEnvironmentErrors, emptyOutputCount: empty.length, judgeZeroCount: judgeZero.length,
    lengthFinishCount: length.length, zeroDeterministCount: zeroDet.length,
    judgeFailedCount: failed.length, scoringComplete: failed.length === 0 && partialRepeats.length === 0 && referenceIssues.length === 0,
    referenceAnswerIssueCount: referenceIssues.length,
    environmentErrorCount: results.length - valid.length };
}
