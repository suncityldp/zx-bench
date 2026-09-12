import type { CalibrationCandidate, CalibrationEvent, CalibrationReview, CandidateReviewSummary, Scenario } from '@zxbench/types';
import { snapshotHash } from './contracts/pack.js';

/** Stable by scenario identity, NOT model, output or scenario version. Public examples never become blind holdout. */
export function calibrationSplit(scenario: Scenario, seed: string): CalibrationCandidate['split'] {
  if (scenario.tier === 'blind_holdout') return 'blind_holdout';
  if (scenario.tier === 'private_validation') return 'calibration';
  return parseInt(snapshotHash({ group: scenario.id, seed }).slice(0, 8), 16) % 5 === 0 ? 'calibration' : 'development';
}

export function normalizeReviewer(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

export function validateCalibrationReview(candidate: CalibrationCandidate, review: CalibrationReview): void {
  if (!review || typeof review.reviewer !== 'string' || normalizeReviewer(review.reviewer).length < 2 || review.reviewer.length > 100) throw new Error('Reviewer name must contain 2–100 characters');
  if (!['usable', 'exclude', 'needs_context'].includes(review.outcome)) throw new Error('Invalid review outcome');
  if (typeof review.rationale !== 'string' || review.rationale.trim().length < 8) throw new Error('Provide a review rationale (at least 8 characters)');
  if (typeof review.sourceVerified !== 'boolean' || typeof review.sourceEvidence !== 'string') throw new Error('Source verification fields are required');
  if (review.sourceVerified && review.sourceEvidence.trim().length < 8) throw new Error('Verified source requires traceable evidence');
  if (!review.labels || typeof review.labels !== 'object' || Array.isArray(review.labels)) throw new Error('Criterion labels are required');
  const ids = candidate.criteria.map(c => c.id);
  if (new Set(ids).size !== ids.length || !ids.length) throw new Error('Candidate rubric has empty/duplicate criterion IDs');
  if (Object.keys(review.labels).length !== ids.length || ids.some(id => !['pass', 'fail', 'unmeasured'].includes(review.labels[id]))) throw new Error('Label every criterion exactly once');
}

export function summarizeCalibration(candidate: CalibrationCandidate, events: CalibrationEvent[]): CandidateReviewSummary {
  const latest = new Map<string, CalibrationReview>();
  let adjudication: CalibrationReview | undefined;
  for (const event of events) {
    if (event.kind === 'review') latest.set(normalizeReviewer(event.review.reviewer), event.review);
    else adjudication = event.review;
  }
  const reviews = [...latest.values()];
  const consensus = reviews.length >= 2 && reviews.every(r => r.outcome === reviews[0].outcome && snapshotHash(r.labels) === snapshotHash(reviews[0].labels));
  const selected = adjudication ?? (consensus ? reviews[0] : undefined);
  let state: CandidateReviewSummary['state'] = reviews.length === 0 ? 'unreviewed' : reviews.length < 2 ? 'in_review' : consensus ? 'agreed' : 'disputed';
  if (adjudication) state = 'adjudicated';
  if (selected?.outcome === 'exclude') state = 'excluded';
  if (selected?.outcome === 'needs_context') state = 'needs_context';
  const exclusionReasons: string[] = [];
  if (!selected || selected.outcome !== 'usable') exclusionReasons.push('Needs two consistent independent reviews or a third-reviewer adjudication');
  if (selected && Object.values(selected.labels).some(l => l === 'unmeasured')) exclusionReasons.push('Human labels include unmeasured criteria');
  const sourceReviews = adjudication ? [adjudication] : reviews;
  if (!sourceReviews.length || sourceReviews.some(r => !r.sourceVerified)) exclusionReasons.push('Gold/source not independently verified');
  if (candidate.environmentError) exclusionReasons.push('Infrastructure failure belongs in harness regression, not model-capability gold');
  return { state, revision: events.length, reviewerCount: latest.size, labels: selected?.labels,
    exportable: exclusionReasons.length === 0, exclusionReasons };
}

export function validateReviewTransition(candidate: CalibrationCandidate, events: CalibrationEvent[], kind: CalibrationEvent['kind'], review: CalibrationReview): void {
  validateCalibrationReview(candidate, review);
  if (events.some(e => e.kind === 'adjudicate')) throw new Error('Adjudicated records are immutable; create a new version to revise');
  if (kind === 'adjudicate') {
    if (summarizeCalibration(candidate, events).state !== 'disputed') throw new Error('Only disputed records can be adjudicated');
    if (events.some(e => normalizeReviewer(e.review.reviewer) === normalizeReviewer(review.reviewer))) throw new Error('Adjudicator must be independent of both reviewers');
  } else if (events.some(e => normalizeReviewer(e.review.reviewer) === normalizeReviewer(review.reviewer))) {
    throw new Error('Each reviewer submits once per immutable candidate');
  } else if (new Set(events.map(e => normalizeReviewer(e.review.reviewer))).size >= 2) {
    throw new Error('Two reviews already exist; use adjudication for disagreements');
  }
}

/** Fixed round-robin sampling by dimension/difficulty/model/failure; scores do not decide which winner to retain. */
export function sampleCalibrationCandidates(candidates: CalibrationCandidate[], count: number, seed: string): CalibrationCandidate[] {
  if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('Sample count must be 1–10000');
  const groups = new Map<string, CalibrationCandidate[]>();
  for (const c of candidates) {
    const key = [c.scenario.dimension, c.scenario.difficulty, c.modelId, c.failureTypes[0] ?? 'control'].join('|');
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const dimensions = new Map<string, CalibrationCandidate[][]>();
  for (const [key, rows] of [...groups.entries()].sort(([a], [b]) => snapshotHash({ seed, key: a }).localeCompare(snapshotHash({ seed, key: b }), 'en'))) {
    const dim = rows[0].scenario.dimension;
    const ordered = rows.sort((a, b) => snapshotHash({ seed, id: a.id }).localeCompare(snapshotHash({ seed, id: b.id }), 'en'));
    dimensions.set(dim, [...(dimensions.get(dim) ?? []), ordered]);
  }
  const strata = [...dimensions.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([, queues]) => ({ queues, index: 0 }));
  const picked: CalibrationCandidate[] = [];
  while (picked.length < count && strata.some(s => s.queues.some(q => q.length))) for (const stratum of strata) {
    for (let step = 0; step < stratum.queues.length; step++) {
      const queue = stratum.queues[stratum.index++ % stratum.queues.length];
      if (queue.length && picked.length < count) { picked.push(queue.shift()!); break; }
    }
  }
  return picked;
}
