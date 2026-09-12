import {snapshotHash} from '../contracts/pack.js';
import {checkBoundaryAudit, type BoundaryAuditInput} from './boundaryClaimAudit.js';
export interface BoundaryControl {id: string; family: string; input: BoundaryAuditInput; expected: 'claim'|'uncertain'|'none'; stance?: string; uLast?: string|null; pieceFirst?: string|null; expectedVerification?: string; expectedIssues: number}
export function boundaryClaimControls(): BoundaryControl[] {
  const base: BoundaryAuditInput = {candidate: '', question: 'L为alphabet上不含forbidden子串的全部有限串。每个提议的piece集合和拼接方向以proposals为准，只考虑拼接后长度至少minLength的串。', alphabet: ['0','1'], forbidden: ['1111'], minLength: 4, proposals: {P1: {side: 'suffix', pieces: ['0','10','110','1110']}}};
  const specs: Omit<BoundaryControl,'id'>[] = [
    {family:'false_sufficiency', input:{...base,candidate:'对于P1，对任意u∈L和任意piece，只要u末位为1、piece首位为1，u+piece就一定包含禁串。'},expected:'claim',stance:'asserted',uLast:'1',pieceFirst:'1',expectedVerification:'disproved',expectedIssues:1},
    {family:'true_implication_not_hypothetical_stance', input:{...base,forbidden:['11'],candidate:'对于P1，我断言：若u∈L的末位为1且piece首位为1，那么u+piece必定包含禁串。'},expected:'claim',stance:'asserted',uLast:'1',pieceFirst:'1',expectedVerification:'proved',expectedIssues:0},
    {family:'correct_denial_of_implication', input:{...base,candidate:'我明确否定P1的下述普遍命题：“若u∈L末位1且piece首位1，则u+piece一定非法”。'},expected:'claim',stance:'denied',uLast:'1',pieceFirst:'1',expectedVerification:'disproved',expectedIssues:0},
    {family:'quotation_not_endorsement', input:{...base,candidate:'只记录一条他人引文：“对于P1，若u∈L末位1且piece首位1，则u+piece必然非法”。我既不认领也不否定这段引文。'},expected:'claim',stance:'quoted',uLast:'1',pieceFirst:'1',expectedVerification:'disproved',expectedIssues:0},
    {family:'unrepresentable_condition', input:{...base,candidate:'对于P1，我断言：仅对那些中间包含子串010的u∈L，u+piece总是非法。这个包含条件不可省略。'},expected:'uncertain',expectedIssues:0},
    {family:'empty_premise_not_substantive_proof', input:{...base,proposals:{P1:{side:'suffix',pieces:['0']}},candidate:'对于P1，若u∈L末位为1且piece首位为1，则u+piece一定非法。'},expected:'claim',stance:'asserted',uLast:'1',pieceFirst:'1',expectedVerification:'vacuous',expectedIssues:0},
    {family:'later_retraction', input:{...base,candidate:'对于P1，若u∈L末位1且piece首位1，则u+piece一定非法。我现在撤回并明确否定前面这条普遍命题。'},expected:'claim',stance:'denied',uLast:'1',pieceFirst:'1',expectedVerification:'disproved',expectedIssues:0},
    {family:'existential_is_not_universal', input:{...base,candidate:'对于P1，只存在某个合法u和某个piece，使u+piece包含禁串；我并未主张所有满足首末位条件的拼接都非法。'},expected:'none',expectedIssues:0},
  ];
  return specs.map(s=>({...s,id:'BC-'+snapshotHash(s.input).slice(0,14)}));
}
export function assessBoundaryControl(control: BoundaryControl, checked: ReturnType<typeof checkBoundaryAudit>) {
  if(checked.bindingHash!==snapshotHash(control.input))throw new Error('Wrong answer binding');
  const unique=[...new Map(checked.findings.map(f=>[snapshotHash(f.extracted),f])).values()];
  const issues=unique.filter(f=>f.disposition==='potential_proof_issue_requires_mapping_review').length;
  // Redundant piece conditions are accepted only when they select exactly the same question-owned set.
  // E.g. every piece in P1 already ends in 0; adding pieceLast=0 must not fabricate a semantic failure.
  const expectedPieces=control.input.proposals.P1.pieces.filter(p=>control.pieceFirst==null||p[0]===control.pieceFirst).sort();
  const equivalentPieces=(c:any)=>JSON.stringify(control.input.proposals.P1.pieces.filter(p=>(c.pieceFirst===null||p[0]===c.pieceFirst)&&(c.pieceLast===null||p.at(-1)===c.pieceLast)&&(c.pieceForm==='any'||p.endsWith('0')&&[...p.slice(0,-1)].every(s=>s==='1'))).sort())===JSON.stringify(expectedPieces);
  const claimMatch=control.expected==='claim'?unique.length===1&&unique.every(f=>f.extracted.proposal==='P1'&&f.extracted.scope==='proposal'&&f.extracted.side==='suffix'&&f.extracted.uFirst===null&&f.extracted.uLast===control.uLast&&equivalentPieces(f.extracted)&&f.extracted.conclusion==='always_illegal'&&f.extracted.stance===control.stance&&f.verification.status===control.expectedVerification):unique.length===0;
  const uncertaintyMatches=control.expected==='uncertain'?checked.unresolvedSegments.length>0:checked.unresolvedSegments.length===0;
  return {id:control.id,expected:control.expected,claimMatch,uncertaintyMatches,expectedIssues:control.expectedIssues,observedIssues:issues,
    allMatch:claimMatch&&uncertaintyMatches&&issues===control.expectedIssues,fullContextVerified:checked.fullOriginalContext===control.input.candidate,
    productionEligible:false,independentGold:false};
}
