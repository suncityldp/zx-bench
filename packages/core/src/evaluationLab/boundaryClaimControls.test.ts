import {describe,expect,it} from 'vitest';
import {boundaryClaimControls,assessBoundaryControl} from './boundaryClaimControls.js';
import {boundaryPublicInput,checkBoundaryAudit} from './boundaryClaimAudit.js';
function response(index:number){const c=boundaryClaimControls()[index];return boundaryPublicInput(c.input).candidateSegments.map((s,i)=>({segment:s.id,coverage:i?'none':c.expected==='claim'?'claims':c.expected,claims:i||c.expected!=='claim'?[]:[{proposal:'P1',scope:'proposal',side:'suffix',uFirst:null,uLast:c.uLast,pieceFirst:c.pieceFirst,pieceLast:null,pieceForm:'any',conclusion:'always_illegal',stance:c.stance}]}));}
describe('boundary semantic controls',()=>{
  it('cross-checks expected exact outcomes, safe abstention and existential exclusion',()=>{
    boundaryClaimControls().forEach((c,i)=>expect(assessBoundaryControl(c,checkBoundaryAudit(c.input,JSON.stringify(response(i)),'stop',true)).allMatch,c.family).toBe(true));
  });
  it('rejects weakened/omitted conditions even when the resulting statement is also false',()=>{
    const c=boundaryClaimControls()[0],r=response(0);r[0].claims[0].uLast=null;
    expect(assessBoundaryControl(c,checkBoundaryAudit(c.input,JSON.stringify(r),'stop',true)).allMatch).toBe(false);
  });
  it('does not reward always returning uncertainty',()=>{
    const c=boundaryClaimControls()[0],r=response(0).map(s=>({...s,coverage:'uncertain',claims:[]}));
    expect(assessBoundaryControl(c,checkBoundaryAudit(c.input,JSON.stringify(r),'stop',true)).allMatch).toBe(false);
  });
  it('accepts logically redundant restrictions of the fixed piece set, not arbitrary added premises',()=>{
    const c=boundaryClaimControls()[0],r=response(0);Object.assign(r[0].claims[0],{pieceLast:'0',pieceForm:'ones_then_zero'});
    expect(assessBoundaryControl(c,checkBoundaryAudit(c.input,JSON.stringify(r),'stop',true)).allMatch).toBe(true);
  });
});
