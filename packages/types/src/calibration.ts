import type { CriterionResult, OutputMetadata, Scenario } from './index.js';

export type CalibrationSplit = 'development' | 'calibration' | 'blind_holdout';
export type ReviewState = 'unreviewed' | 'in_review' | 'agreed' | 'disputed' | 'adjudicated' | 'excluded' | 'needs_context';
export interface ReviewCriterion { id: string; description: string; critical: boolean }
export interface CalibrationCandidate {
  id: string;
  runId: string;
  resultId: string;
  attemptIndex: number;
  modelId: string;
  modelName: string;
  scenario: Scenario;
  scenarioContentHash: string;
  answerHash: string;
  modelOutput: string;
  reasoningContent?: string;
  outputMetadata?: OutputMetadata;
  snapshotOrigin: 'run_manifest' | 'current_definition';
  observedScore: number;
  failureTypes: string[];
  environmentError: boolean;
  criteria: ReviewCriterion[];
  automaticCriteria: CriterionResult[];
  automaticSource: 'saved_audit' | 'offline_rule_replay' | 'unavailable';
  automaticGraderVersion: string;
  automaticIssue?: string;
  judgeScoreHistory: number[];
  split: CalibrationSplit;
  splitSeed: string;
  leakageGroup: string;
  collectedAt: string;
}
export interface CalibrationReview {
  reviewer: string;
  outcome: 'usable' | 'exclude' | 'needs_context';
  labels: Record<string, 'pass' | 'fail' | 'unmeasured'>;
  rationale: string;
  sourceEvidence: string;
  sourceVerified: boolean;
}
export interface CalibrationEvent {
  revision: number;
  kind: 'review' | 'adjudicate';
  review: CalibrationReview;
  createdAt: string;
}
export interface CandidateReviewSummary {
  state: ReviewState;
  revision: number;
  reviewerCount: number;
  labels?: CalibrationReview['labels'];
  exportable: boolean;
  exclusionReasons: string[];
}
export interface CalibrationRecord {
  candidate: CalibrationCandidate;
  events: CalibrationEvent[];
  summary: CandidateReviewSummary;
}
