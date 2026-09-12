/** Visible, author-authored controls only. No saved Judge output is relabelled. */
import {he001V4Fixtures} from './he001ProtocolV4Fixtures.js';
import {he001SourceBodies} from './he001ProtocolV4.js';
import {uniqueHE001V5Inputs} from './he001ProtocolV5.js';
export function he001V5Fixtures(question:string){
 return uniqueHE001V5Inputs(he001V4Fixtures(he001SourceBodies(question)).map(f=>{
  let id=f.id,answer=f.answer;
  if(id==='shared_negation_separate_statements'){
   id='explicit_negation_same_meaning';
   answer=answer.replace('三项措施同时实施且复机负载降低，五班次未停机是有效观察，但不能分离各措施贡献、证明永久修复或断言其他措施毫无作用。',
    '三项措施同时实施且复机负载降低，五班次未停机是有效观察。这一观察不能分离各措施贡献，不能证明永久修复，也不能证明其他措施毫无作用。');
  }
  return {id,answer,origin:'author_synthetic_visible_control_not_independent_gold'};
 }));
}
