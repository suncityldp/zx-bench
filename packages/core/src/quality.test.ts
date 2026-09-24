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
  it('does not flag measured progressive zero scores as missing Judge participation', () => {
    const q = analyzeRunQuality([{ ...row, totalScore: 0, deterministicScore: 0, graderVersion: 'ultra_batch_part@1.0.0', evidence: '["PROGRESSIVE_PART: earned=0/20"]' }], 1);
    expect(q).toMatchObject({ grade: 'good', zeroDeterministCount: 0, scoringComplete: true });
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
  it('blocks a run when the saved CLI scorer missed an executable ANSWER line', () => {
    const q = analyzeRunQuality([{ ...row, graderVersion: 'cli_command@cli_command_v5',
      modelOutput: "ANSWER: awk '{print $1}' /workspace/access.log | sort",
      evidence: '["No executable shell command found in model output"]' }], 1);
    expect(q).toMatchObject({ grade: 'critical', scoringComplete: false, parserFalseNegativeCount: 1 });
  });
  it('blocks inconsistent single-attempt score history', () => {
    const q = analyzeRunQuality([{ ...row, runCount: 1, scoreHistory: '[75]' }], 1);
    expect(q).toMatchObject({ grade: 'critical', scoringComplete: false, scoreIntegrityFailureCount: 1 });
  });
  it('holds publication on an unresolved Judge-versus-execution disagreement', () => {
    const q = analyzeRunQuality([{ ...row, evidence: '["JUDGE_EXECUTION_CONFLICT: verified test_pass=0"]' }], 1);
    expect(q).toMatchObject({ grade: 'critical', scoringComplete: false, executionJudgeConflictCount: 1 });
  });
});
