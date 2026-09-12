import {snapshotHash} from '../contracts/pack.js';
import {buildAdaptiveProbability, scoreAdaptiveProbability} from './adaptiveProbability.js';
import {buildProofMath, scoreProofMath, verifyProofMath, type PartitionCase} from './proofMath.js';
import {buildMethodsPack} from './methodsV2/bank.js';
import {scoreMethods, type Submission} from './methodsV2/score.js';
import type {Stance} from './methodsV2/types.js';
import {certificateDiagnostic} from './certificateDiagnostic.js';
import {evidenceStateDiagnostics} from './evidenceStateDiagnostics.js';
import {probabilityDiagnostics} from './probabilityDiagnostics.js';
import {endpointPublicInput, checkEndpointClaims} from './endpointClaimAudit.js';
import {boundaryPublicInputV2, checkBoundaryAuditV2} from './boundaryClaimAuditV2.js';

export type InspectionKind = 'methods-v2' | 'proof' | 'probability';
export interface ClaimReviewAttachment {
  kind: 'endpoint-v1' | 'boundary-v2';
  questionId: string;
  questionHash: string;
  // The exact public packet sent to Judge, not a caller-supplied replacement question.
  packet: unknown;
  raw: {content: string; finishReason: string; streamDone: boolean; error: unknown; httpStatus: number};
  review: {
    rawHash: string; outputHash: string; reviewer: string;
    findings?: Array<{segment: string; target: string; predicate: string; symbol: string; stance: string; context: string[]; mappingCorrect: boolean; basis: string}>;
    items?: Array<{index: number; segment: string; retain: boolean; mappingCorrect: boolean; basis: string}>;
  };
}

/** Rebuild targets from the frozen question. Review declarations remain attributed, not independent gold. */
function inspectClaims(c: PartitionCase, candidate: string, attachment: ClaimReviewAttachment) {
  const {raw, review} = attachment;
  if (attachment.questionHash !== c.question.questionHash || review.outputHash !== snapshotHash(candidate) ||
      review.rawHash !== snapshotHash(raw) || !review.reviewer?.trim()) throw new Error('Stale or unbound claim review');
  if (raw.error !== null || raw.httpStatus !== 200) throw new Error('Failed Judge response cannot become reviewed evidence');
  const input = {candidate, question: c.question.messages[0].content, ...c.problem,
    proposals: Object.fromEntries(c.proposals.map(p => [p.id, p.certificate]))};
  const endpointInput = {candidate, targets: Object.fromEntries(c.proposals.map(p => [p.id, p.certificate.pieces]))};
  const packet = attachment.kind === 'endpoint-v1'
    ? {...endpointPublicInput(endpointInput), fullOriginalQuestion: c.question.messages[0].content}
    : boundaryPublicInputV2(input);
  if (snapshotHash(packet) !== snapshotHash(attachment.packet)) throw new Error('Judge packet differs from original question or answer');
  const basisValid = (s: unknown) => typeof s === 'string' && s.trim().length > 0;
  let findings;
  if (attachment.kind === 'endpoint-v1') {
    const checked = checkEndpointClaims(endpointInput, raw.content, raw.finishReason, raw.streamDone);
    if (!Array.isArray(review.findings) || review.findings.length !== checked.findings.length) throw new Error('Incomplete endpoint mapping review');
    findings = checked.findings.map((f, index) => {
      const r = review.findings![index];
      const identity = {segment: f.segment, target: f.target, predicate: f.predicate, symbol: f.symbol, stance: f.stance};
      const reviewedIdentity = {segment: r.segment, target: r.target, predicate: r.predicate, symbol: r.symbol, stance: r.stance};
      if (snapshotHash(identity) !== snapshotHash(reviewedIdentity) || !basisValid(r.basis) || typeof r.mappingCorrect !== 'boolean') throw new Error('Endpoint review mapped to different claim');
      // A reviewer may add original surrounding context, but never invent or omit Judge's cited context.
      const segments = endpointPublicInput(endpointInput).candidateSegments;
      if (!Array.isArray(r.context) || new Set(r.context).size !== r.context.length ||
          f.context.some(s => !r.context.includes(s.id)) || r.context.some(id => !segments.some(s => s.id === id))) throw new Error('Invalid reviewed context');
      return {finding: f, mappingReview: r, resolvedReviewContext: r.context.map(id => segments.find(s => s.id === id)!),
        displayAsReviewSignal: r.mappingCorrect && f.disposition === 'potential_proof_issue_requires_mapping_review'};
    });
  } else {
    const checked = checkBoundaryAuditV2(input, raw.content, raw.finishReason, raw.streamDone);
    if (!Array.isArray(review.items) || review.items.length !== checked.findings.length) throw new Error('Incomplete boundary mapping review');
    findings = checked.findings.map((f, index) => {
      const r = review.items![index];
      if (r.index !== index || r.segment !== f.segment.id || !basisValid(r.basis) || typeof r.retain !== 'boolean' || typeof r.mappingCorrect !== 'boolean') throw new Error('Boundary review mapped to different claim');
      return {finding: f, mappingReview: r, displayAsReviewSignal: r.retain && r.mappingCorrect && f.disposition === 'potential_proof_issue_requires_mapping_review'};
    });
  }
  return {kind: attachment.kind, questionId: c.id, questionHash: c.question.questionHash,
    outputHash: snapshotHash(candidate), rawHash: snapshotHash(raw), reviewHash: snapshotHash(review), packetHash: snapshotHash(packet),
    reviewer: review.reviewer, fullOriginalContext: candidate, findings,
    reviewedIssues: findings.filter(f => f.displayAsReviewSignal).length,
    overallProofVerdict: 'unmeasured', independentGold: false, automaticScoreChanged: false,
    networkProvenance: 'provided_artifacts_not_a_network_or_SSE_audit'};
}

/** Local application entry point. Does not call models, change frozen scores, or select retries. */
export function inspectCapabilitySubmission(kind: InspectionKind, frozen: unknown, submission: unknown, reviews: ClaimReviewAttachment[] = []) {
  if (!frozen || typeof frozen !== 'object' || !Array.isArray(reviews)) throw new Error('Frozen pack and review array required');
  const stored = frozen as {policy?: {seed?: number}; options?: Parameters<typeof buildMethodsPack>[0]};
  const pack = kind === 'probability' ? buildAdaptiveProbability(stored.policy?.seed)
    : kind === 'proof' ? buildProofMath(stored.policy?.seed)
    : kind === 'methods-v2' && stored.options ? buildMethodsPack(stored.options) : null;
  if (!pack || snapshotHash(pack) !== snapshotHash(frozen)) throw new Error('Frozen pack does not match supported generator/version');
  // Each scorer validates all submission IDs, question hashes and uniqueness before diagnostics.
  const scored = kind === 'probability' ? scoreAdaptiveProbability(pack as ReturnType<typeof buildAdaptiveProbability>, submission)
    : kind === 'proof' ? scoreProofMath(pack as ReturnType<typeof buildProofMath>, submission)
    : scoreMethods(pack as ReturnType<typeof buildMethodsPack>, submission);
  const input = submission as Submission;
  const answers = new Map(input.answers.map(a => [a.id, a]));
  const rows = scored.rows.map(row => {
    const c = pack.cases.find(c => c.id === row.id)!, answer = answers.get(row.id);
    const verification = 'verification' in row ? row.verification : undefined;
    let certificate: {pass: boolean | null; formatValid: boolean | null; error?: string} | null = null;
    if (kind === 'proof') {
      certificate = {pass: null, formatValid: null};
      if (answer?.outcome === 'completed') {
        const extraction = certificateDiagnostic(answer.output);
        if (extraction.certificate !== null) {
          try { const v = verifyProofMath(c as ReturnType<typeof buildProofMath>['cases'][number], extraction.certificate);
            certificate = {pass: v.formatValid ? v.pass : null, formatValid: v.formatValid};
          } catch { certificate = {pass: null, formatValid: null, error: 'certificate_verifier_error'}; }
        }
      }
    }
    return {id: row.id, questionHash: c.question.questionHash, dimension: c.question.dimension, family: c.family,
      executionState: row.state, outputHash: row.outputHash, frozenContractPass: row.pass,
      formatValid: verification?.formatValid ?? null,
      exactCertificateDiagnostic: certificate, checks: verification?.checks ?? null,
      evidenceStatus: verification && 'status' in verification ? verification.status ?? null : null,
      proofVerdict: 'unmeasured', originalAnswer: answer?.output ?? null};
  });
  const claimReviews = reviews.map((attachment, index) => {
    if (!['endpoint-v1', 'boundary-v2'].includes(attachment.kind)) throw new Error('Unsupported claim review protocol');
    if (reviews.slice(0, index).some(r => r.questionId === attachment.questionId && r.kind === attachment.kind)) throw new Error('Duplicate review: do not select a preferred Judge attempt');
    const c = pack.cases.find(c => c.id === attachment.questionId), answer = answers.get(attachment.questionId);
    if (kind !== 'proof' || !c || !('kind' in c) || c.kind !== 'partition' || answer?.outcome !== 'completed') throw new Error('Claim review requires an original completed partition answer');
    return inspectClaims(c as PartitionCase, answer.output, attachment);
  });
  const evidence = kind === 'methods-v2' ? evidenceStateDiagnostics((pack as ReturnType<typeof buildMethodsPack>).cases.flatMap(c => {
    if (c.kind !== 'evidence') return [];
    const row = rows.find(r => r.id === c.id)!;
    const observed = row.formatValid ? row.evidenceStatus as Stance : null;
    return [{id: c.id, expected: c.gold.status, observed, outputHash: row.outputHash,
      ...(observed === null ? {reasonUnmeasured: row.executionState === 'completed' ? 'invalid_format_requires_review' : row.executionState} : {})}];
  })) : null;
  return {version: 'capability-inspection-v1', kind, contractHash: pack.contractHash, frozenPackHash: snapshotHash(pack),
    submissionHash: snapshotHash(submission), runId: input.runId, modelId: input.modelId, modelFamily: input.modelFamily,
    frozenDimensions: scored.dimensions, rows, evidence,
    diagnosticCounts: {planned: rows.length, measuredFrozenContract: rows.filter(r => r.frozenContractPass !== null).length,
      invalidFormat: rows.filter(r => r.formatValid === false).length, unmeasuredFormat: rows.filter(r => r.formatValid === null).length,
      exactCertificateMeasured: kind === 'proof' ? rows.filter(r => r.exactCertificateDiagnostic?.pass !== null).length : null,
      exactCertificateCorrect: kind === 'proof' ? rows.filter(r => r.exactCertificateDiagnostic?.pass === true).length : null,
      scope: 'diagnostics_not_an_alternative_weighted_score'},
    probability: kind === 'probability' ? probabilityDiagnostics(pack as ReturnType<typeof buildAdaptiveProbability>, submission) : null,
    claimReviews, reviewedIssues: claimReviews.reduce((n, r) => n + r.reviewedIssues, 0),
    complete: rows.length > 0 && rows.every(r => r.frozenContractPass !== null),
    completionScope: 'frozen_contract_measurement_not_proof_review_or_goal',
    interpretation: {noCombinedDimensionScore: true, relatedVariantsNotIndependent: true,
      noProofPassFromExactAnswerOrNoJudgeFlag: true, missingRetainedInPlannedDenominator: true,
      reviewDeclarationsAreAttributedNotIndependentGold: true, noBestOfSelection: true},
    networkCalls: 0, productionEligible: false, historicalScoresChanged: false};
}
