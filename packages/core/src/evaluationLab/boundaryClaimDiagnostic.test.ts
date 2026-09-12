import {describe, expect, it} from 'vitest';
import {boundaryClaimDiagnostic, type BoundaryClaim} from './boundaryClaimDiagnostic.js';
const base: BoundaryClaim = {alphabet: ['0', '1'], forbidden: ['1111'], pieces: ['0', '10', '110', '1110'], side: 'suffix', uLast: '1', pieceFirst: '1', minCombinedLength: 4, conclusion: 'always_illegal'};
describe('boundary implication counterexamples', () => {
  it('disproves the additional real-answer inference: touching ones do not necessarily make four ones', () => {
    const r = boundaryClaimDiagnostic(base);
    expect(r.status).toBe('disproved'); expect(r.witness!.combinedLegal).toBe(true);
    expect(r.witness!.u.endsWith('1')).toBe(true); expect(r.witness!.piece.startsWith('1')).toBe(true);
    expect(r.witness!.combined.length).toBeGreaterThanOrEqual(4); expect(r.witness!.combined.includes('1111')).toBe(false);
  });
  it('also produces illegal generation witnesses for a false always-legal claim', () => {
    const r = boundaryClaimDiagnostic({...base, conclusion: 'always_legal'});
    expect(r.status).toBe('disproved'); expect(r.witness!.combined.includes('1111')).toBe(true);
  });
  it('does not call bounded failure to find a witness a successful proof', () => {
    const r = boundaryClaimDiagnostic({...base, side: 'prefix', pieceFirst: undefined, pieceLast: '0', conclusion: 'always_legal'});
    expect(r.status).toBe('unmeasured'); expect(r.witness).toBeNull();
  });
  it('distinguishes resource bounds and rejects invalid claims', () => {
    expect(boundaryClaimDiagnostic(base, 8, 1).status).toBe('unmeasured');
    expect(() => boundaryClaimDiagnostic({...base, uLast: 'x'})).toThrow(/endpoint/);
  });
});
