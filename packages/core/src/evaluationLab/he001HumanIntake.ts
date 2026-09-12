import {snapshotHash} from '../contracts/pack.js';
import type {buildHE001BlindPacket} from './he001BlindReview.js';
type Packet=ReturnType<typeof buildHE001BlindPacket>['packet'];
export interface HE001HumanSubmission {
 packetHash:string;itemId:string;answerHash:string;reviewerId:string;rawUserReply:string;
 levels:(0|1|2|null)[];reportedErrorQuotes:string[];
 // Null means the user has not explicitly classified severity, not "no error".
 criticalSeverity:boolean|null;
}
/** Preserve human labels verbatim. Never copy author labels or repair a human
 * judgment to fit the rubric during blinded collection.
 */
export function recordHE001HumanSubmission(packet:Packet,s:HE001HumanSubmission){
 const {hash,...body}=packet;
 if(hash!==snapshotHash(body)||s.packetHash!==hash)throw new Error('Packet integrity mismatch');
 const item=packet.items.find(i=>i.id===s.itemId);
 if(!item||item.answerHash!==snapshotHash(item.answer)||s.answerHash!==item.answerHash)throw new Error('Unknown or stale answer');
 if(typeof s.reviewerId!=='string'||!s.reviewerId.trim()||typeof s.rawUserReply!=='string'||!s.rawUserReply.trim())throw new Error('User reply provenance required');
 if(!Array.isArray(s.levels)||s.levels.length!==packet.criteria.length||s.levels.some(x=>x!==null&&x!==0&&x!==1&&x!==2))throw new Error('Explicit grade or null required for every criterion');
 if(!Array.isArray(s.reportedErrorQuotes)||s.reportedErrorQuotes.some(q=>typeof q!=='string'||!q.trim()||!item.answer.includes(q)))throw new Error('Reported error must quote the candidate');
 if(![true,false,null].includes(s.criticalSeverity))throw new Error('Severity must be explicit or pending');
 const assessments=packet.criteria.map((c,i)=>({id:c.id,level:s.levels[i],weight:c.weight,points:s.levels[i]===null?null:c.weight*s.levels[i]!/2}));
 const scoresComplete=s.levels.every(x=>x!==null);
 return {version:1,source:'direct_user_message',rubricVersion:packet.rubricVersion,...s,assessments,
  weightedScore:scoresComplete?assessments.reduce((n,a)=>n+a.points!,0):null,
  scoresComplete,status:!scoresComplete?'awaiting_criterion_ratings':s.criticalSeverity===null?'awaiting_severity_confirmation':'single_item_review_complete',
  authorLabelsConsulted:false,exportableAsIndependentGold:false};
}
