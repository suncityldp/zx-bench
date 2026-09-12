import {describe, expect, it} from 'vitest';
import {snapshotHash} from '../contracts/pack.js';
import {inspectCapabilitySubmission, type ClaimReviewAttachment} from './capabilityInspection.js';
import {buildAdaptiveProbability, probabilityReference} from './adaptiveProbability.js';
import {buildProofMath, proofReference} from './proofMath.js';
import {buildMethodsPack} from './methodsV2/bank.js';
import {referenceSubmission} from './methodsV2/score.js';
import {endpointPublicInput} from './endpointClaimAudit.js';
import {boundaryPublicInputV2} from './boundaryClaimAuditV2.js';
const probability = buildAdaptiveProbability();
const probabilitySubmission = () => ({contractHash: probability.contractHash, runId: 'test-run', modelId: 'test-model', modelFamily: 'test-family',
  answers: probability.cases.map(c => ({id: c.id, questionHash: c.question.questionHash, outcome: 'completed', output: JSON.stringify(probabilityReference(c.problem).answer)}))});
function proofFixture() {
  const pack = buildProofMath(), c = pack.cases.find(c => c.kind === 'partition')!;
  if (c.kind !== 'partition') throw new Error('Missing partition');
  const candidate = '每个片段末位都是0。\n```json\n' + JSON.stringify(proofReference(c)) + '\n```';
  const input = {candidate, targets: Object.fromEntries(c.proposals.map(p => [p.id, p.certificate.pieces]))};
  const packet = {...endpointPublicInput(input), fullOriginalQuestion: c.question.messages[0].content}, target = c.proposals.find(p => p.certificate.pieces.some(s => !s.endsWith('0')))!.id;
  const claim = {target, predicate: 'all_last', symbol: '0', stance: 'asserted', context: ['C1']};
  const raw = {content: JSON.stringify(packet.candidateSegments.map((s, i) => ({segment: s.id, coverage: i === 0 ? 'claims' : 'none', claims: i === 0 ? [claim] : []}))),
    finishReason: 'stop', streamDone: true, error: null, httpStatus: 200};
  const review = {rawHash: snapshotHash(raw), outputHash: snapshotHash(candidate), reviewer: 'test_fixture_not_human',
    findings: [{segment: 'C1', ...claim, mappingCorrect: true, basis: 'Synthetic fixture explicitly endorses the false endpoint claim.'}]};
  const attachment: ClaimReviewAttachment = {kind: 'endpoint-v1', questionId: c.id, questionHash: c.question.questionHash, packet, raw, review};
  const submission = {contractHash: pack.contractHash, runId: 'proof-test', modelId: 'test-model', modelFamily: 'test-family',
    answers: pack.cases.map(p => ({id: p.id, questionHash: p.question.questionHash, outcome: 'completed', output: p.id === c.id ? candidate : JSON.stringify(proofReference(p))}))};
  return {pack, submission, attachment, c};
}
describe('application capability inspection entry', () => {
  it('recomputes probability scores and retains original answers', () => {
    const sub = probabilitySubmission(), before = snapshotHash(sub), r = inspectCapabilitySubmission('probability', probability, sub);
    expect(r.frozenDimensions[0].score).toBe(100); expect(r.complete).toBe(true);
    expect(r.rows[0].originalAnswer).toBe(sub.answers.find(a => a.id === r.rows[0].id)!.output);
    expect(snapshotHash(sub)).toBe(before); expect(r.networkCalls).toBe(0);
  });
  it('does not turn missing or truncated attempts into a complete score', () => {
    const sub = probabilitySubmission(); sub.answers.pop(); sub.answers[0].outcome = 'truncated';
    const r = inspectCapabilitySubmission('probability', probability, sub);
    expect(r.rows).toHaveLength(6); expect(r.complete).toBe(false); expect(r.frozenDimensions[0].score).toBeNull();
  });
  it('separates unparseable output from a measured mathematical failure', () => {
    const sub = probabilitySubmission(); sub.answers[0].output = 'no final answer';
    const r = inspectCapabilitySubmission('probability', probability, sub);
    expect(r.rows[0].executionState).toBe('unparseable_requires_review'); expect(r.rows[0].frozenContractPass).toBeNull();
  });
  it('rejects duplicate and stale answers, never selecting the best attempt', () => {
    const sub = probabilitySubmission(); sub.answers.push(sub.answers[0]);
    expect(() => inspectCapabilitySubmission('probability', probability, sub)).toThrow();
    sub.answers.pop(); sub.answers[0].questionHash = 'stale'; expect(() => inspectCapabilitySubmission('probability', probability, sub)).toThrow();
  });
  it('rejects modified gold even if the caller leaves the old contract hash', () => {
    const frozen = structuredClone(probability); frozen.cases[0].problem.priorA = [1, 2];
    expect(() => inspectCapabilitySubmission('probability', frozen, probabilitySubmission())).toThrow('Frozen pack');
  });
  it('exposes false conflict without calling it an ordinary abstention', () => {
    const pack = buildMethodsPack({seed: 20260913, instances: 1, split: 'holdout'}), sub = referenceSubmission(pack);
    const c = pack.cases.find(c => c.kind === 'evidence' && c.gold.status === 'supported')!;
    const a = sub.answers.find(a => a.id === c.id)!; const value = JSON.parse(a.output); value.status = 'conflict'; a.output = JSON.stringify(value);
    const r = inspectCapabilitySubmission('methods-v2', pack, sub);
    expect(r.evidence?.counts.falseConflict).toBe(1); expect(r.evidence?.counts.unsupportedRefutation).toBe(1);
  });
  it('retains strict format failure, correct certificate and reviewed proof error separately', () => {
    const {pack, submission, attachment, c} = proofFixture();
    const r = inspectCapabilitySubmission('proof', pack, submission, [attachment]), row = r.rows.find(r => r.id === c.id)!;
    expect(row.frozenContractPass).toBe(false); expect(row.formatValid).toBe(false); expect(row.exactCertificateDiagnostic?.pass).toBe(true);
    expect(r.diagnosticCounts.invalidFormat).toBe(1); expect(r.diagnosticCounts.exactCertificateCorrect).toBe(8);
    expect(r.reviewedIssues).toBe(1); expect(row.proofVerdict).toBe('unmeasured'); expect(r.historicalScoresChanged).toBe(false);
  });
  it('does not imply a valid whole proof when no Judge review is provided', () => {
    const {pack, submission} = proofFixture(), r = inspectCapabilitySubmission('proof', pack, submission);
    expect(r.reviewedIssues).toBe(0); expect(r.rows.every(r => r.proofVerdict === 'unmeasured')).toBe(true);
  });
  it('rejects wrong question packets and stale Judge review bindings', () => {
    const {pack, submission, attachment} = proofFixture();
    const wrong = structuredClone(attachment); (wrong.packet as {candidate: string}).candidate = 'other';
    expect(() => inspectCapabilitySubmission('proof', pack, submission, [wrong])).toThrow('packet');
    wrong.packet = attachment.packet; wrong.review.rawHash = 'stale';
    expect(() => inspectCapabilitySubmission('proof', pack, submission, [wrong])).toThrow('unbound');
  });
  it('rejects truncated Judge output, duplicate reviews and wrong semantic claim mapping', () => {
    const {pack, submission, attachment} = proofFixture();
    expect(() => inspectCapabilitySubmission('proof', pack, submission, [attachment, attachment])).toThrow('Duplicate review');
    const wrong = structuredClone(attachment); wrong.raw.finishReason = 'length'; wrong.review.rawHash = snapshotHash(wrong.raw);
    expect(() => inspectCapabilitySubmission('proof', pack, submission, [wrong])).toThrow('Incomplete');
    wrong.raw = attachment.raw; wrong.review = structuredClone(attachment.review); wrong.review.findings![0].target = 'P99';
    expect(() => inspectCapabilitySubmission('proof', pack, submission, [wrong])).toThrow('different claim');
  });
  it('quarantines unapproved mappings without discarding mathematical certificates', () => {
    const {pack, submission, attachment} = proofFixture(); attachment.review.findings![0].mappingCorrect = false;
    const r = inspectCapabilitySubmission('proof', pack, submission, [attachment]); expect(r.reviewedIssues).toBe(0);
    expect(r.claimReviews[0].findings[0].displayAsReviewSignal).toBe(false);
  });
  it('allows additional original review context but rejects fabricated segment IDs', () => {
    const {pack, submission, attachment} = proofFixture(); attachment.review.findings![0].context.push('C2');
    expect(inspectCapabilitySubmission('proof', pack, submission, [attachment]).reviewedIssues).toBe(1);
    attachment.review.findings![0].context.push('C9999');
    expect(() => inspectCapabilitySubmission('proof', pack, submission, [attachment])).toThrow('context');
  });
  it('rechecks boundary counterexamples and excludes rejected extraction mappings', () => {
    const {pack, submission, c} = proofFixture();
    const answer = submission.answers.find(a => a.id === c.id)!;
    answer.output = '若piece首位1且u末位1，后缀拼接就一定非法。';
    const packet = boundaryPublicInputV2({candidate: answer.output, question: c.question.messages[0].content, ...c.problem,
      proposals: Object.fromEntries(c.proposals.map(p => [p.id, p.certificate]))});
    const claim = {proposal: 'P9999', scope: 'general_instantiation', side: 'suffix', uFirst: null, uLast: '1',
      pieceFirst: '1', pieceLast: null, pieceForm: 'any', conclusion: 'always_illegal', stance: 'asserted'};
    const raw = {content: JSON.stringify([{segment: 'C1', coverage: 'claims', claims: [claim]}]), finishReason: 'stop', streamDone: true, error: null, httpStatus: 200};
    const attachment: ClaimReviewAttachment = {kind: 'boundary-v2', questionId: c.id, questionHash: c.question.questionHash, packet, raw,
      review: {rawHash: snapshotHash(raw), outputHash: snapshotHash(answer.output), reviewer: 'synthetic_not_human',
        items: [{index: 0, segment: 'C1', retain: true, mappingCorrect: true, basis: 'Original explicitly asserts sufficient conditions.'}]}};
    expect(inspectCapabilitySubmission('proof', pack, submission, [attachment]).reviewedIssues).toBe(1);
    attachment.review.items![0].retain = false;
    expect(inspectCapabilitySubmission('proof', pack, submission, [attachment]).reviewedIssues).toBe(0);
    attachment.review.items![0].index = 2;
    expect(() => inspectCapabilitySubmission('proof', pack, submission, [attachment])).toThrow('different claim');
  });
  it('rejects endpoint packets omitting the full original question', () => {
    const {pack, submission, attachment} = proofFixture();
    delete (attachment.packet as {fullOriginalQuestion?: string}).fullOriginalQuestion;
    expect(() => inspectCapabilitySubmission('proof', pack, submission, [attachment])).toThrow('packet');
  });
});
