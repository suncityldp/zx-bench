import {validateHE001V4Schema} from './he001ProtocolV4.js';
import {resolveHE001LineBreakSpan} from './he001JudgeTrial.js';
/** The frozen micro schema is supplied by the packet. No author labels are read. */
export function parseHE001V4Micro(source:string,content:string,finishReason:string,schema:unknown){
 if(finishReason!=='stop')throw new Error('Micro Judge did not finish normally');
 const review=JSON.parse(content);validateHE001V4Schema(review,schema);
 const span=resolveHE001LineBreakSpan(source,review.quote);
 const relation={supported:'supports',refuted:'contradicts',unsupported:'context'}[review.label as string];
 if(review.relation!==relation)throw new Error('Micro label/relation conflict');
 return {review:{...review,quote:span.quote},resolution:span.changed?span:null,structureAndSpanChecked:true,evidenceEntailmentChecked:false,independentGold:false,productionEligible:false};
}
