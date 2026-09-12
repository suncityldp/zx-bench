import {describe, expect, it} from 'vitest';
import {checkEndpointClaims, endpointPublicInput, type EndpointAuditInput} from './endpointClaimAudit.js';

const input: EndpointAuditInput = {candidate: 'P1：各 piece 末位为0。\n故拼接合法。', targets: {P1: ['0', '01', '011']}};
function response(source = input, stance = 'asserted', predicate = 'all_last', symbol = '0') {
  return endpointPublicInput(source).candidateSegments.map((s, i) => ({segment: s.id, coverage: i === 0 ? 'claims' : 'none', claims: i === 0 ? [{target: 'P1', predicate, symbol, stance, context: [s.id]}] : []}));
}
const check = (value: unknown, source = input) => checkEndpointClaims(source, JSON.stringify(value), 'stop', true);
describe('bounded endpoint claims separate language mapping from exact checking', () => {
  it('produces a mechanical counterexample to the missed actual proof premise', () => {
    const result = check(response());
    expect(result.findings[0]).toMatchObject({propositionTrue: false, counterexample: '01', disposition: 'potential_proof_issue_requires_mapping_review'});
    expect(result.overallProofVerdict).toBe('unmeasured');
    expect(result.extractionMappingVerified).toBe(false);
  });
  it('accepts a true first-character claim without certifying the whole proof', () => {
    const source = {...input, candidate: 'P1所有片段首位为0。'};
    expect(check(response(source, 'asserted', 'all_first'), source).findings[0].propositionTrue).toBe(true);
  });
  it('does not turn quotations, conditionals or uncertainty into endorsed errors', () => {
    for (const stance of ['quoted', 'conditional', 'uncertain']) {
      expect(check(response(input, stance)).findings[0].disposition).toBe('not_an_unconditional_endorsement');
    }
    expect(check(response(input, 'denied')).findings[0].disposition).toBe('supported_extracted_denial');
  });
  it('retains the exact later retraction context rather than trusting copied quotes', () => {
    const source = {...input, candidate: '片段都以0结尾。该说法是错误的。'};
    const rows = response(source, 'denied'); rows[0].claims[0].context.push('C2');
    const result = check(rows, source);
    expect(result.findings[0].context.map(s => s.text).join('')).toBe(source.candidate);
    expect(result.findings[0].disposition).toBe('supported_extracted_denial');
  });
  it('rejects missing/repeated segments, unsupported claims and unanchored context', () => {
    const rows = response();
    expect(() => check(rows.slice(1))).toThrow(/Every/);
    expect(() => check(rows.map(() => rows[0]))).toThrow(/coverage/);
    const unknown = response(); unknown[0].claims[0].target = 'P99'; expect(() => check(unknown)).toThrow(/claim/);
    const unanchored = response(); unanchored[0].claims[0].context = ['C2']; expect(() => check(unanchored)).toThrow(/claim/);
    const duplicated = response(); duplicated[0].claims.push(duplicated[0].claims[0]); expect(() => check(duplicated)).toThrow(/Duplicate/);
  });
  it('makes no correctness or recall claim when the extractor marks every span none', () => {
    const result = check(response().map(r => ({...r, coverage: 'none', claims: []})));
    expect(result.findings).toEqual([]);
    expect(result.coverageMeaning).toBe('row_accounting_only_not_verified_claim_recall');
    expect(result.overallProofVerdict).toBe('unmeasured');
  });
  it('rejects truncation and marks explicit uncertainty', () => {
    expect(() => checkEndpointClaims(input, JSON.stringify(response()), 'length', true)).toThrow(/Incomplete/);
    const rows = response(); rows[0] = {segment: 'C1', coverage: 'uncertain', claims: []};
    expect(check(rows).uncertainSegments).toEqual(['C1']);
  });
});
