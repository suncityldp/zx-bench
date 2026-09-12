import {snapshotHash} from '../contracts/pack.js';
import {HE001_CRITERIA,HE001_RUBRIC_VERSION} from './he001Rubric.js';

/** Label-blinded author anchors for a single human. Not model outputs, not a
 * claim that the reviewer has never seen the rubric or earlier score examples.
 */
export function buildHE001BlindPacket(input:{id:string;answer:string}[],questionHash:string){
 if(!input.length||new Set(input.map(a=>a.id)).size!==input.length||input.some(a=>typeof a.answer!=='string'||!a.answer.trim()))throw new Error('Unique nonempty anchor answers required');
 const order=[...input].sort((a,b)=>snapshotHash({seed:'HE001-human-20260910',id:a.id}).localeCompare(snapshotHash({seed:'HE001-human-20260910',id:b.id})));
 const mapping:Record<string,string>={};
 const items=order.map((a,i)=>{const id=`HR-${String(i+1).padStart(3,'0')}`;mapping[id]=a.id;return {id,answer:a.answer,answerHash:snapshotHash(a.answer)};});
 const body={version:1,rubricVersion:HE001_RUBRIC_VERSION,questionHash,mode:'single_human_author_labels_hidden',answerOrigin:'synthetic_author_anchors_not_model_outputs',blindingLimit:'Reviewer has seen criterion definitions and some score-category examples; not fully unexposed independent validation.',criteria:HE001_CRITERIA,items};
 return {packet:{...body,hash:snapshotHash(body)},mapping};
}
