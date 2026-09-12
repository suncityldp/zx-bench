/** Calibrated routing policy for hallucination-resistance and reasoning-math evaluation. */
export const DIMENSION_EVALUATION_POLICY_V1 = {
  version: 'resistance-math-evaluation-policy-2026-09-12-v1',
  hallucinationResistance: {
    primaryMetric: 'evidence_state_and_required_evidence_coverage',
    separateMetrics: ['semantic_atomic_accuracy', 'evidence_coverage', 'format_compliance'],
    coreEvidence: [
      {artifact: 'reports/cross-family-flash-glm-2026-09-12-v1/four-model-discrimination.json', questions: 8, role: 'cross_family_screen'},
      {artifact: 'reports/evidence-holdout-gsq-ornith-2026-09-12-v1/audit.json', questions: 4, role: 'temporal_state_holdout'},
    ],
    diagnosticEvidence: [
      {artifact: 'reports/hallucination-resistance-hard-candidates-2026-09-12-v1.8', questions: 6, role: 'multi_claim_and_format_diagnostic'},
    ],
    aggregationRule: 'report_family_vector_and_coverage; do_not_retroactively_mix_development_and_holdout_scores',
  },
  reasoningMath: {
    defaultCore: {artifact: 'reports/adaptive-probability-gsq-ornith-2026-09-12-v1/audit.json', questions: 6,
      primaryMetric: 'exact_final_answer_equal_family'},
    escalation: {artifact: 'reports/resistance-math-hard-candidates-2026-09-12-v1.8',
      role: 'top_tier_only_not_default_full_suite', stopOnFirstIncomplete: true,
      reason: 'GSQ first item took 1034 seconds and failed all six values; second hit the 1200-second hard timeout.'},
    judgeWeight: 0,
  },
  judge: {
    activeModel: 'deepseek-v4-flash',
    retiredModels: ['deepseek-v4-pro'],
    calibratedArtifact: 'reports/flash-judge-holdout-2026-09-12-v1/audit.json',
    calibration: {matched: 12, planned: 12, humanReviewed: true},
    role: 'bounded_semantic_error_flags_for_open_ended_answers_only',
    automaticScoreWeight: 0,
    humanReviewRequired: true,
    productionEligible: false,
  },
  productionWrites: false,
  productionEligible: false,
} as const;

export interface EvaluationRouteInput {
  answerKind: 'exact_structured' | 'closed_evidence_structured' | 'open_ended';
  deterministicGraderAvailable: boolean;
  formatValid: boolean;
}

export function routeDimensionEvaluation(input: EvaluationRouteInput) {
  if (input.deterministicGraderAvailable) {
    return {
      primary: 'deterministic_grader',
      runJudge: false,
      judgeModel: null,
      automaticScoreWeight: 0,
      formatAction: input.formatValid ? 'score' : 'unmeasured_and_deterministic_projection_diagnostic',
      humanReview: !input.formatValid,
    } as const;
  }
  if (input.answerKind === 'open_ended') {
    return {
      primary: 'human_review',
      runJudge: true,
      judgeModel: DIMENSION_EVALUATION_POLICY_V1.judge.activeModel,
      automaticScoreWeight: 0,
      formatAction: 'not_applicable',
      humanReview: true,
    } as const;
  }
  return {
    primary: 'human_review',
    runJudge: false,
    judgeModel: null,
    automaticScoreWeight: 0,
    formatAction: 'not_applicable',
    humanReview: true,
  } as const;
}

export function isRetiredJudgeModel(model: string) {
  return (DIMENSION_EVALUATION_POLICY_V1.judge.retiredModels as readonly string[]).includes(model);
}
