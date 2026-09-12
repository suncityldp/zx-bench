import {describe, expect, it} from 'vitest';
import {boundaryPublicInput, checkBoundaryAudit, type BoundaryAuditInput} from './boundaryClaimAudit.js';
const input: BoundaryAuditInput = {candidate: '若piece首字符为1且u末字符为1，则后缀拼接一定非法。', question: 'Use only question data.', alphabet: ['0', '1'], forbidden: ['1111'], minLength: 4, proposals: {P1: {side: 'suffix', pieces: ['0', '10', '110', '1110']}}};
const atom = {proposal: 'P1', scope: 'proposal', side: 'suffix', uFirst: null, uLast: '1', pieceFirst: '1', pieceLast: null, pieceForm: 'any', conclusion: 'always_illegal', stance: 'asserted'};
function check(changes = {}, source = input) {return checkBoundaryAudit(source, JSON.stringify(boundaryPublicInput(source).candidateSegments.map((s, i) => ({segment: s.id, coverage: i ? 'none' : 'claims', claims: i ? [] : [{...atom, ...changes}]}))), 'stop', true);}
describe('semantic-to-formal boundary bridge', () => {
  it('extracts a universal implication and produces a counterexample, not a whole-answer zero', () => {
    const r = check(); expect(r.findings[0].verification.status).toBe('disproved');
    expect(r.findings[0].disposition).toBe('potential_proof_issue_requires_mapping_review'); expect(r.entireProofVerdict).toBe('unmeasured');
  });
  it('does not accuse quoted or unendorsed conditional claims', () => {
    for (const stance of ['quoted', 'conditional', 'uncertain']) expect(check({stance}).findings[0].disposition).toBe('not_unconditional_endorsement');
  });
  it('does not elevate proof of a restricted instance into a general theorem', () => {
    const r = check({scope: 'general_instantiation', side: 'prefix', pieceFirst: null, conclusion: 'always_legal'});
    expect(r.findings[0].verification.status).toBe('proved'); expect(r.findings[0].disposition).toBe('restricted_instance_not_general_proof');
  });
  it('checks negation polarity and preserves full original context', () => {
    const source = {...input, forbidden: ['11'], candidate: '我明确否定下述蕴含：若piece首位1且u末位1，则拼接非法。'};
    const r = check({stance: 'denied'}, source); expect(r.findings[0].verification.status).toBe('proved');
    expect(r.findings[0].disposition).toBe('potential_proof_issue_requires_mapping_review'); expect(r.fullOriginalContext).toBe(source.candidate);
  });
  it('rejects ungrounded changes to direction, conditions and target', () => {
    expect(() => check({side: 'prefix'})).toThrow(/direction/);
    expect(() => check({uLast: 'x'})).toThrow(/condition/);
    expect(() => check({proposal: 'P9'})).toThrow(/schema/);
  });
});
