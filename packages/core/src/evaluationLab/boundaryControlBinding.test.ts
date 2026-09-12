import {expect,it} from 'vitest';
import {boundaryClaimControls} from './boundaryClaimControls.js';
import {checkBoundaryAuditV2} from './boundaryClaimAuditV2.js';
import {assessBoundaryControlV2} from './boundaryControlBinding.js';
it('adapts actual v2 packet identity while rejecting tampering of either hash',()=>{
  const c=boundaryClaimControls()[0],raw=JSON.stringify([{segment:'C1',coverage:'claims',claims:[{proposal:'P1',scope:'proposal',side:'suffix',uFirst:null,uLast:'1',pieceFirst:'1',pieceLast:null,pieceForm:'any',conclusion:'always_illegal',stance:'asserted'}]}]);
  const r=checkBoundaryAuditV2(c.input,raw,'stop',true);expect(assessBoundaryControlV2(c,r).allMatch).toBe(true);
  expect(()=>assessBoundaryControlV2(c,{...r,bindingHash:'tampered'})).toThrow(/binding/);
  expect(()=>assessBoundaryControlV2(c,{...r,originalInputHash:'tampered'})).toThrow(/binding/);
});
