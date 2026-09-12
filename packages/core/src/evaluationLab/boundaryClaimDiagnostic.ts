/** Search for a concrete disproof of a concatenation implication. Not finding one is NOT a proof. */
export interface BoundaryClaim {
  alphabet: string[]; forbidden: string[]; pieces: string[]; side: 'prefix'|'suffix';
  uFirst?: string; uLast?: string; pieceFirst?: string; pieceLast?: string;
  minCombinedLength: number; conclusion: 'always_legal'|'always_illegal';
}
export function boundaryClaimDiagnostic(claim: BoundaryClaim, maxULength = 8, maxNodes = 10000) {
  const {alphabet, forbidden, pieces} = claim;
  if (!alphabet.length || alphabet.length > 3 || new Set(alphabet).size !== alphabet.length || alphabet.some(c => c.length !== 1)) throw new Error('Bounded single-unit alphabet required');
  const wordValid = (s: string) => typeof s === 'string' && s.length <= 32 && [...s].every(c => alphabet.includes(c));
  if (!forbidden.length || forbidden.length > 8 || forbidden.some(s => !wordValid(s) || !s.length) || !pieces.length || pieces.length > 16 || pieces.some(s => !wordValid(s) || !s.length)) throw new Error('Invalid forbidden patterns or pieces');
  if (!['prefix', 'suffix'].includes(claim.side) || !['always_legal', 'always_illegal'].includes(claim.conclusion) || !Number.isInteger(claim.minCombinedLength) || claim.minCombinedLength < 0 || claim.minCombinedLength > 40) throw new Error('Invalid implication');
  for (const c of [claim.uFirst, claim.uLast, claim.pieceFirst, claim.pieceLast]) if (c !== undefined && !alphabet.includes(c)) throw new Error('Unknown endpoint');
  if (!Number.isInteger(maxULength) || maxULength < 0 || maxULength > 12 || !Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 100000) throw new Error('Invalid search bound');
  const legal = (s: string) => forbidden.every(f => !s.includes(f));
  const endpoints = (s: string, first?: string, last?: string) => (first === undefined || s[0] === first) && (last === undefined || s.at(-1) === last);
  const queue = ['']; let checked = 0;
  for (let i = 0; i < queue.length; i++) {
    const u = queue[i];
    if (!legal(u)) continue; // Extending an illegal u cannot restore membership in a forbidden-substring language.
    if (endpoints(u, claim.uFirst, claim.uLast)) for (const piece of pieces) {
      if (!endpoints(piece, claim.pieceFirst, claim.pieceLast)) continue;
      const combined = claim.side === 'prefix' ? piece + u : u + piece;
      if (combined.length < claim.minCombinedLength) continue; checked++;
      const isLegal = legal(combined);
      if (isLegal !== (claim.conclusion === 'always_legal')) return {status: 'disproved' as const, checked, witness: {u, piece, combined, uLegal: true, combinedLegal: isLegal}, scope: 'concrete_counterexample_to_claim_not_whole_proof_grade'};
    }
    if (u.length < maxULength) for (const c of alphabet) {
      if (queue.length >= maxNodes) return {status: 'unmeasured' as const, checked, witness: null, reason: 'search_node_limit_not_a_proof'};
      queue.push(u + c);
    }
  }
  return {status: 'unmeasured' as const, checked, witness: null, reason: 'no_counterexample_within_bound_not_a_proof'};
}
