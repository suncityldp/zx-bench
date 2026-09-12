import {describe,it,expect} from 'vitest';
import {buildHE001BlindPacket} from './he001BlindReview.js';
import {recordHE001HumanSubmission,type HE001HumanSubmission} from './he001HumanIntake.js';
describe('HE-001 user ratings intake',()=>{
 const {packet}=buildHE001BlindPacket([{id:'sample',answer:'待核查的原句。'}],'q');
 const submission:HE001HumanSubmission={packetHash:packet.hash,itemId:packet.items[0].id,answerHash:packet.items[0].answerHash,reviewerId:'conversation_user',rawUserReply:'1,2,2,0,2,2,2,2,2；认为原句有误。',levels:[1,2,2,0,2,2,2,2,2],reportedErrorQuotes:['待核查的原句。'],criticalSeverity:null};
 it('retains user labels exactly, computes 77.5, and does not infer severity',()=>{
  const r=recordHE001HumanSubmission(packet,submission);expect(r.levels).toEqual(submission.levels);expect(r.weightedScore).toBe(77.5);expect(r.status).toBe('awaiting_severity_confirmation');expect(r.criticalSeverity).toBeNull();expect(r.exportableAsIndependentGold).toBe(false);
 });
 it('does not turn unknown criterion ratings into zero',()=>{
  const s=structuredClone(submission);s.levels[3]=null;const r=recordHE001HumanSubmission(packet,s);expect(r.weightedScore).toBeNull();expect(r.status).toBe('awaiting_criterion_ratings');
 });
 it('only records complete status after an explicit severity classification',()=>{
  for(const severity of [true,false])expect(recordHE001HumanSubmission(packet,{...submission,criticalSeverity:severity}).status).toBe('single_item_review_complete');
 });
 it('rejects stale packets, answers, missing ratings, invalid levels and invented quotations',()=>{
  for(const change of [{packetHash:'bad'},{answerHash:'bad'},{levels:[1,2]},{levels:[3,2,2,0,2,2,2,2,2]},{reportedErrorQuotes:['not present']},{criticalSeverity:undefined}])expect(()=>recordHE001HumanSubmission(packet,{...submission,...change} as HE001HumanSubmission)).toThrow();
 });
});
