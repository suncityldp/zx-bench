import {describe, expect, it} from 'vitest';
import {DIMENSION_EVALUATION_POLICY_V1, isRetiredJudgeModel, routeDimensionEvaluation} from './dimensionEvaluationPolicyV1.js';

describe('dimension evaluation policy v1', () => {
  it('never sends exact or closed structured answers to Judge', () => {
    expect(routeDimensionEvaluation({answerKind: 'exact_structured', deterministicGraderAvailable: true, formatValid: true})).toMatchObject({primary: 'deterministic_grader', runJudge: false, automaticScoreWeight: 0});
    expect(routeDimensionEvaluation({answerKind: 'closed_evidence_structured', deterministicGraderAvailable: true, formatValid: false})).toMatchObject({runJudge: false, formatAction: 'unmeasured_and_deterministic_projection_diagnostic', humanReview: true});
  });

  it('uses Flash only as a zero-weight reviewed aid for open answers', () => {
    expect(routeDimensionEvaluation({answerKind: 'open_ended', deterministicGraderAvailable: false, formatValid: true})).toEqual({
      primary: 'human_review', runJudge: true, judgeModel: 'deepseek-v4-flash', automaticScoreWeight: 0,
      formatAction: 'not_applicable', humanReview: true,
    });
    expect(DIMENSION_EVALUATION_POLICY_V1.judge.calibration).toEqual({matched: 12, planned: 12, humanReviewed: true});
  });

  it('retires DeepSeek-v4-pro from Judge routing', () => {
    expect(isRetiredJudgeModel('deepseek-v4-pro')).toBe(true);
    expect(isRetiredJudgeModel('deepseek-v4-flash')).toBe(false);
  });
});
