import {describe, expect, it} from 'vitest';
import {verifyBoundaryClaim} from './verifyBoundaryClaim.js';
import {boundaryClaimDiagnostic, type BoundaryClaim} from './boundaryClaimDiagnostic.js';
const base: BoundaryClaim = {alphabet: ['0', '1'], forbidden: ['1111'], pieces: ['0', '10', '110', '1110'], side: 'suffix', uLast: '1', pieceFirst: '1', minCombinedLength: 4, conclusion: 'always_illegal'};
describe('finite-state universal concatenation verification', () => {
  it('disproves the real false sufficient condition with a legal witness', () => {
    const r = verifyBoundaryClaim(base); expect(r.status).toBe('disproved');
    expect(r.witness!.u.endsWith('1')).toBe(true); expect(r.witness!.piece.startsWith('1')).toBe(true);
    expect(r.witness!.combined.includes('1111')).toBe(false); expect(r.witness!.combined.length).toBeGreaterThanOrEqual(4);
  });
  it('proves safe prefix and suffix barriers over all lengths', () => {
    expect(verifyBoundaryClaim({...base, side: 'prefix', conclusion: 'always_legal', pieceFirst: undefined}).status).toBe('proved');
    expect(verifyBoundaryClaim({...base, pieces: ['0', '01', '011', '0111'], pieceFirst: '0', conclusion: 'always_legal'}).status).toBe('proved');
  });
  it('distinguishes true always-illegal implications, empty premises and bounded resources', () => {
    expect(verifyBoundaryClaim({...base, forbidden: ['11'], pieces: ['10'], minCombinedLength: 0}).status).toBe('proved');
    expect(verifyBoundaryClaim({...base, pieces: ['0']}).status).toBe('vacuous');
    expect(verifyBoundaryClaim(base, 1).status).toBe('unmeasured');
  });
  it('cross-checks many finite-state claims against independent bounded word enumeration', () => {
    for (const forbidden of [['11'], ['111'], ['00'], ['01']]) for (const side of ['prefix', 'suffix'] as const) for (const conclusion of ['always_legal', 'always_illegal'] as const) for (const uFirst of [undefined, '0', '1']) {
      const c: BoundaryClaim = {...base, forbidden, side, conclusion, uFirst, minCombinedLength: 3, pieces: ['0', '10'], uLast: undefined, pieceFirst: undefined};
      const exact = verifyBoundaryClaim(c), finite = boundaryClaimDiagnostic(c, 8);
      if (exact.status === 'proved' || exact.status === 'vacuous') expect(finite.status).toBe('unmeasured');
      if (exact.status === 'disproved') {
        expect(finite.status).toBe('disproved'); const w = exact.witness!;
        expect(forbidden.every(f => !w.u.includes(f))).toBe(true);
        expect(forbidden.every(f => !w.combined.includes(f))).toBe(conclusion !== 'always_legal');
        if (uFirst) expect(w.u.startsWith(uFirst)).toBe(true);
      }
    }
  });
  it('keeps the empty word distinct when a first/last condition is required', () => {
    expect(verifyBoundaryClaim({...base, forbidden: ['0', '1'], pieces: ['1'], uFirst: '1', minCombinedLength: 0}).status).toBe('vacuous');
    expect(verifyBoundaryClaim({...base, forbidden: ['0', '1'], pieces: ['1'], uFirst: undefined, uLast: undefined, pieceFirst: undefined, minCombinedLength: 0}).status).toBe('proved');
  });
});
