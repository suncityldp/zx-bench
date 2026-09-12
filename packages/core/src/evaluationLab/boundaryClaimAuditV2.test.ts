import {describe,expect,it} from 'vitest';
import {boundaryPublicInputV2,checkBoundaryAuditV2} from './boundaryClaimAuditV2.js';
import type {BoundaryAuditInput} from './boundaryClaimAudit.js';
const input:BoundaryAuditInput={candidate:'一般原理：若piece首位1且u末位1，u+piece就会包含1111。',question:'Original question unchanged.',alphabet:['0','1'],forbidden:['1111'],minLength:4,proposals:{P1:{side:'suffix',pieces:['0','10','110','1110']},P2:{side:'suffix',pieces:['0','01','011','0111']}}};
const atom={proposal:'P9999',scope:'general_instantiation',side:'suffix',uFirst:null,uLast:'1',pieceFirst:'1',pieceLast:null,pieceForm:'ones_then_zero',conclusion:'always_illegal',stance:'asserted'};
const response=(change={})=>JSON.stringify([{segment:'C1',coverage:'claims',claims:[{...atom,...change}]}]);
describe('host registered general counterexample pool',()=>{
  it('grounds a general claim without inventing an original proposal attribution',()=>{
    const packet=boundaryPublicInputV2(input);expect(packet.question).toBe(input.question);expect(packet.proposals.P9999.pieces).toHaveLength(7);
    const r=checkBoundaryAuditV2(input,response(),'stop',true);expect(r.findings[0].verification.status).toBe('disproved');expect(r.findings[0].disposition).toBe('potential_proof_issue_requires_mapping_review');
  });
  it('does not turn a verified finite instance into a general theorem',()=>{
    const r=checkBoundaryAuditV2(input,response({side:'prefix',uLast:null,pieceFirst:null,conclusion:'always_legal'}),'stop',true);
    expect(r.findings[0].disposition).toBe('restricted_instance_not_general_proof');
  });
  it('rejects collisions and treating the host pool as an original question proposal',()=>{
    expect(()=>boundaryPublicInputV2({...input,proposals:{P9999:input.proposals.P1}})).toThrow(/Reserved/);
    expect(()=>checkBoundaryAuditV2(input,response({scope:'proposal'}),'stop',true)).toThrow(/not a question/);
  });
});
