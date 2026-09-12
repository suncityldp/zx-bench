import { describe, expect, it } from 'vitest';
import type { CalibrationCandidate, CalibrationEvent, CalibrationReview, CalibrationRecord, Scenario } from '@zxbench/types';
import { calibrationSplit, summarizeCalibration, validateReviewTransition, sampleCalibrationCandidates } from './calibration.js';
import { analyzeRubricQuality } from './rubricQA.js';

const candidate = (id = 'one'): CalibrationCandidate => ({ id, runId: 'r', resultId: id, attemptIndex: 0, modelId: 'm', modelName: 'mock',
  scenario: { id: 'IF-1', dimension: 'instruction_following', difficulty: 'easy', tier: 'public_dev' } as Scenario,
  scenarioContentHash: 'same-scenario', answerHash: id, modelOutput: id, snapshotOrigin: 'run_manifest', observedScore: 100,
  failureTypes: [], environmentError: false, criteria: [{ id: 'critical', description: 'must not leak', critical: true }, { id: 'format', description: 'format', critical: false }],
  automaticCriteria: [{ id: 'critical', description: '', critical: true, status: 'pass', source: 'rule', evidence: '' }, { id: 'format', description: '', critical: false, status: 'pass', source: 'rule', evidence: '' }],
  automaticSource: 'saved_audit', automaticGraderVersion: 'v1', judgeScoreHistory: [50, 100], split: 'calibration', splitSeed: 'seed', leakageGroup: 'IF-1', collectedAt: '2026-09-08' });
const review = (reviewer: string, labels: CalibrationReview['labels'] = { critical: 'pass', format: 'pass' }): CalibrationReview => ({
  reviewer, labels, outcome: 'usable', rationale: 'Independently checked the complete answer', sourceVerified: true, sourceEvidence: 'reference task and independent solution' });
const event = (reviewer: string, revision: number, labels?: CalibrationReview['labels']): CalibrationEvent => ({ kind: 'review', revision, review: review(reviewer, labels), createdAt: '2026-09-08' });
const approved = (c = candidate()): CalibrationRecord => { const events = [event('Alice', 1), event('Bob', 2)]; return { candidate: c, events, summary: summarizeCalibration(c, events) }; };

describe('human calibration governance', () => {
  it('requires two independent complete reviews and provenance attestation', () => {
    expect(summarizeCalibration(candidate(), []).exportable).toBe(false);
    expect(summarizeCalibration(candidate(), [event('Alice', 1)]).state).toBe('in_review');
    expect(approved().summary).toMatchObject({ state: 'agreed', exportable: true, reviewerCount: 2 });
    const events = [event('Alice', 1), event('Bob', 2)]; events[1].review.sourceVerified = false;
    expect(summarizeCalibration(candidate(), events).exportable).toBe(false);
  });
  it('does not let casing/full-width names or concurrent resubmissions impersonate another reviewer', () => {
    expect(() => validateReviewTransition(candidate(), [event('Alice', 1)], 'review', review(' ＡＬＩＣＥ '))).toThrow('once');
    expect(() => validateReviewTransition(candidate(), [], 'review', review('Bob', { critical: 'pass' }))).toThrow('every criterion');
  });
  it('requires third-party adjudication for disagreement and preserves the original labels', () => {
    const c = candidate(); const events = [event('Alice', 1), event('Bob', 2, { critical: 'fail', format: 'pass' })];
    expect(summarizeCalibration(c, events).state).toBe('disputed');
    expect(() => validateReviewTransition(c, events, 'adjudicate', review('Alice'))).toThrow('independent');
    expect(() => validateReviewTransition(c, events, 'adjudicate', review('Carol'))).not.toThrow();
    const final = [...events, { ...event('Carol', 3), kind: 'adjudicate' as const }];
    expect(summarizeCalibration(c, final)).toMatchObject({ state: 'adjudicated', exportable: true });
    expect(events[1].review.labels.critical).toBe('fail');
    expect(() => validateReviewTransition(c, final, 'review', review('David'))).toThrow('immutable');
  });
  it('does not certify environmental failures or unknown human labels', () => {
    expect(approved({ ...candidate(), environmentError: true }).summary.exportable).toBe(false);
    const labels = { critical: 'unmeasured' as const, format: 'pass' as const };
    expect(summarizeCalibration(candidate(), [event('Alice', 1, labels), event('Bob', 2, labels)]).exportable).toBe(false);
  });
  it('keeps all models and versions of a question in one stable split; public tasks never become holdout', () => {
    const s = candidate().scenario;
    expect(calibrationSplit(s, 'seed')).toBe(calibrationSplit({ ...s, scenarioVersion: 'v2' }, 'seed'));
    expect(calibrationSplit(s, 'seed')).not.toBe('blind_holdout');
    expect(calibrationSplit({ ...s, tier: 'blind_holdout' }, 'seed')).toBe('blind_holdout');
  });
  it('reproduces stratified sampling regardless of input order', () => {
    const cs = Array.from({ length: 20 }, (_, i) => ({ ...candidate(String(i)), modelId: i % 2 ? 'model1' : 'model2' }));
    expect(sampleCalibrationCandidates(cs, 6, 'fixed').map(c => c.id)).toEqual(sampleCalibrationCandidates([...cs].reverse(), 6, 'fixed').map(c => c.id));
    expect(new Set(sampleCalibrationCandidates(cs, 6, 'fixed').map(c => c.modelId)).size).toBe(2);
  });
});
describe('offline rubric diagnostics', () => {
  it('reports disagreements and critical false passes, never auto-removes a constant guardrail', () => {
    const records = ['a', 'b', 'c'].map(id => approved(candidate(id)));
    records[0].summary.labels = { critical: 'fail', format: 'pass' };
    const qa = analyzeRubricQuality(records);
    expect(qa.criticalFalsePasses).toBe(1);
    expect(qa.agreement).toBeCloseTo(5 / 6);
    expect(qa.scenarios[0].criteria[0].nonDiscriminating).toBe(true);
    expect(qa.scenarios[0].criteria[0].recommendation).toContain('Retain critical');
    expect(qa.scenarios[0].redundantPairs).toEqual([['critical', 'format']]);
    expect(qa.judgeVariances).toHaveLength(3);
  });
  it('excludes holdout and unreviewed labels; identical outputs do not inflate activation samples', () => {
    const holdout = approved({ ...candidate('hidden'), split: 'blind_holdout' });
    const qa = analyzeRubricQuality([approved(), approved(), holdout]);
    expect(qa.excludedHoldout).toBe(1);
    expect(qa.scenarios[0].distinctAnswers).toBe(1);
    expect(analyzeRubricQuality([{ ...approved(), summary: { ...approved().summary, exportable: false } }]).agreement).toBeNull();
  });
  it('does not silently pick a favorable duplicate when the same answer has inconsistent gold', () => {
    const a = approved(candidate('one'));
    const b = approved({ ...candidate('two'), answerHash: a.candidate.answerHash });
    b.summary.labels = { critical: 'fail', format: 'pass' };
    const qa = analyzeRubricQuality([a, b]);
    expect(qa.inconsistentAnswerGroups).toHaveLength(1);
    expect(qa.comparisons).toBe(0);
  });
});
