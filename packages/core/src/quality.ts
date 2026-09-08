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
  const valid = results.filter(r => !r.environmentError);
  const issues: string[] = [];
  const referenceIssues = referenceAnswerWarnings(results);
  issues.push(...referenceIssues);
  const empty = valid.filter(r => !r.modelOutput?.trim());
  const judgeZero = valid.filter(r => r.judgeScore === 0);
  const failed = valid.filter(r => {
    try { return (JSON.parse(r.evidence || '[]') as string[]).some(e => e.startsWith('JUDGE_FAILED:')); }
    catch { return false; }
  });
  const length = valid.filter(r => {
    try { return JSON.parse(r.outputMetadata || '{}').finishReason === 'length'; }
    catch { return false; }
  });
  const zeroDet = valid.filter(r => r.deterministicScore === 0 && r.judgeScore === null);
  if (results.length !== totalScenarios) issues.push(`结果覆盖: ${results.length}/${totalScenarios}`);
  if (results.length !== valid.length) issues.push(`环境故障隔离: ${results.length - valid.length} 题`);
  if (empty.length) issues.push(`空输出: ${empty.length}/${valid.length} 题`);
  if (judgeZero.length) issues.push(`Judge 0 分: ${judgeZero.length} 题`);
  if (failed.length) issues.push(`Judge 失败降级: ${failed.length}/${valid.length} 题，当前分数为临时确定性分，需仅 Judge 补评`);
  if (length.length) issues.push(`输出截断(finish_reason=length): ${length.length} 题 — ${length.map(r => r.scenarioId || 'unknown').slice(0, 10).join(', ')}`);
  if (zeroDet.length) issues.push(`确定性评分为 0(Judge 未参与): ${zeroDet.length} 题`);
  const threshold = Math.max(5, Math.floor(valid.length * 0.05));
  const grade: 'good' | 'warning' | 'critical' = referenceIssues.length > 0 || failed.length > 0 || empty.length > threshold || length.length > threshold
    ? 'critical' : issues.length ? 'warning' : 'good';
  return { grade, issues, emptyOutputCount: empty.length, judgeZeroCount: judgeZero.length,
    lengthFinishCount: length.length, zeroDeterministCount: zeroDet.length,
    judgeFailedCount: failed.length, scoringComplete: failed.length === 0 && referenceIssues.length === 0,
    referenceAnswerIssueCount: referenceIssues.length,
    environmentErrorCount: results.length - valid.length };
}
