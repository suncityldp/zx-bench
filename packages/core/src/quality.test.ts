import { describe, expect, it } from 'vitest';
import { analyzeRunQuality, type QualityRow } from './quality.js';
const row: QualityRow = { scenarioId: 'CP-L4-001', totalScore: 80, deterministicScore: 80, judgeScore: null, modelOutput: 'answer', outputMetadata: '{}', evidence: '[]' };
describe('saved run quality diagnostics', () => {
  it('flags Judge fallback as provisional even when deterministic score is high', () => {
    expect(analyzeRunQuality([{ ...row, evidence: '["JUDGE_FAILED: connection refused"]' }], 1)).toMatchObject({ grade: 'critical', judgeFailedCount: 1, scoringComplete: false });
  });
  it('does not mistake Judge-disabled evaluations for Judge failure', () => {
    expect(analyzeRunQuality([row], 1)).toMatchObject({ grade: 'good', judgeFailedCount: 0 });
  });
  it('uses actual scenario IDs for model-output truncation', () => {
    const q = analyzeRunQuality([{ ...row, outputMetadata: '{"finishReason":"length"}' }], 1);
    expect(q.issues.join()).toContain('CP-L4-001');
    expect(q.lengthFinishCount).toBe(1);
  });
  it('isolates environmental failure and reports incomplete coverage', () => {
    const q = analyzeRunQuality([{ ...row, environmentError: true, modelOutput: '' }], 2);
    expect(q.emptyOutputCount).toBe(0);
    expect(q.environmentErrorCount).toBe(1);
    expect(q.issues.join()).toContain('1/2');
  });
});
