import type {BoundaryClaim} from './boundaryClaimDiagnostic.js';

/** Exhaust a finite product automaton for every legal u, rather than extrapolating bounded examples. */
export function verifyBoundaryClaim(claim: BoundaryClaim, stateLimit = 10000) {
  const {alphabet, forbidden, pieces} = claim;
  if (!alphabet.length || alphabet.length > 3 || new Set(alphabet).size !== alphabet.length || alphabet.some(c => c.length !== 1)) throw new Error('Invalid alphabet');
  const word = (s: string) => typeof s === 'string' && s.length > 0 && s.length <= 8 && [...s].every(c => alphabet.includes(c));
  if (!forbidden.length || forbidden.length > 8 || forbidden.some(s => !word(s)) || !pieces.length || pieces.length > 16 || pieces.some(s => !word(s))) throw new Error('Invalid patterns');
  if (!['prefix', 'suffix'].includes(claim.side) || !['always_legal', 'always_illegal'].includes(claim.conclusion) || !Number.isInteger(claim.minCombinedLength) || claim.minCombinedLength < 0 || claim.minCombinedLength > 40) throw new Error('Invalid implication');
  for (const c of [claim.uFirst, claim.uLast, claim.pieceFirst, claim.pieceLast]) if (c !== undefined && !alphabet.includes(c)) throw new Error('Unknown endpoint');
  if (!Number.isInteger(stateLimit) || stateLimit < 1 || stateLimit > 100000) throw new Error('Invalid resource limit');
  const prefixes = [...new Set(['', ...forbidden.flatMap(f => Array.from({length: f.length}, (_, i) => f.slice(0, i)))])];
  const step = (state: number, c: string) => {
    if (state === -1) return -1; const suffix = prefixes[state] + c;
    if (forbidden.some(f => suffix.endsWith(f))) return -1;
    let best = 0; prefixes.forEach((p, i) => {if (p.length > prefixes[best].length && suffix.endsWith(p)) best = i;}); return best;
  };
  const run = (state: number, s: string) => [...s].reduce(step, state);
  let reached = 0, premises = 0;
  for (const piece of pieces) {
    if (claim.pieceFirst !== undefined && piece[0] !== claim.pieceFirst || claim.pieceLast !== undefined && piece.at(-1) !== claim.pieceLast) continue;
    const minU = Math.max(0, claim.minCombinedLength - piece.length);
    type State = {uState: number; combinedState: number; length: number; last: string; u: string};
    const initial: State = {uState: 0, combinedState: claim.side === 'prefix' ? run(0, piece) : 0, length: 0, last: '', u: ''};
    const key = (s: State) => JSON.stringify([s.uState, s.combinedState, s.length, s.last]);
    const queue = [initial], seen = new Set([key(initial)]); reached++;
    if (reached > stateLimit) return {status: 'unmeasured' as const, reason: 'state_limit', reached, premises, witness: null};
    for (let i = 0; i < queue.length; i++) {
      const s = queue[i];
      if (s.length >= minU && (claim.uFirst === undefined || s.u.length > 0) && (claim.uLast === undefined || s.last === claim.uLast)) {
        premises++;
        const combinedState = claim.side === 'prefix' ? s.combinedState : run(s.uState, piece), legal = combinedState !== -1;
        if (legal !== (claim.conclusion === 'always_legal')) {
          const combined = claim.side === 'prefix' ? piece + s.u : s.u + piece;
          return {status: 'disproved' as const, reached, premises, witness: {u: s.u, piece, combined, uLegal: true, combinedLegal: legal}, proof: 'concrete_counterexample'};
        }
      }
      for (const c of alphabet) {
        if (s.u.length === 0 && claim.uFirst !== undefined && c !== claim.uFirst) continue;
        const uState = step(s.uState, c); if (uState === -1) continue;
        const next: State = {uState, combinedState: claim.side === 'prefix' ? step(s.combinedState, c) : uState,
          length: Math.min(minU, s.length + 1), last: c, u: s.u + c};
        const k = key(next); if (seen.has(k)) continue;
        if (reached >= stateLimit) return {status: 'unmeasured' as const, reason: 'state_limit', reached, premises, witness: null};
        seen.add(k); queue.push(next); reached++;
      }
    }
  }
  return {status: premises ? 'proved' as const : 'vacuous' as const, reached, premises, witness: null, proof: 'exhaustive_reachable_product_automaton'};
}
