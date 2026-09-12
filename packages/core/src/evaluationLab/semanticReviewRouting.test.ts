import {describe,it,expect} from 'vitest';
import {snapshotHash} from '../contracts/pack.js';
import {judgeRoute,reviewedSemanticSignal} from './semanticReviewRouting.js';
const raw={content:'result'},candidate='说明';
const input={scope:'free_form_proof' as const,exactPass:true,candidate,outputHash:snapshotHash(candidate),raw,rawHash:snapshotHash(raw),
  verdict:{id:'x',verdict:'fail' as const,quote:candidate,sources:['D1'],reason:'错误前提'},review:{rawHash:snapshotHash(raw),decision:'continue',reasonsSupported:true,quotesPreserveStance:true,sourceLinksRelevant:true}};
describe('scoped semantic routing',()=>{
  it('does not call Judge to recalculate deterministic answers',()=>{expect(judgeRoute('closed_evidence_state').requestRole).toBe('deterministic_verifier_no_judge');expect(judgeRoute('exact_math_certificate').requestRole).toBe('deterministic_verifier_no_judge');});
  it('displays reviewed proof issues without replacing valid certificates',()=>{const r=reviewedSemanticSignal(input);expect(r.displayAsReviewSignal).toBe(true);expect(r.exactPass).toBe(true);expect(r.automaticScoreChanged).toBe(false);});
  it('quarantines unsupported reasons',()=>expect(reviewedSemanticSignal({...input,review:{...input.review,reasonsSupported:false}}).status).toBe('quarantined_unvalidated_judge'));
  it('never lets even a reviewed Judge override closed evidence',()=>expect(reviewedSemanticSignal({...input,scope:'closed_evidence_state'}).displayAsReviewSignal).toBe(false));
  it('rejects stale raw and changed candidate bindings',()=>{expect(()=>reviewedSemanticSignal({...input,candidate:'新文本'})).toThrow();expect(()=>reviewedSemanticSignal({...input,raw:{content:'changed'}})).toThrow();});
});
