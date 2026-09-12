/** Author-authored engineering controls, NOT independent calibration gold. */
import {he001ProtocolFixtures} from './he001ProtocolFixtures.js';
import {HE001_V4,he001VisibleSourceIds,type HE001Sources,type HE001V4Review} from './he001ProtocolV4.js';

export function he001V4Fixtures(sources:HE001Sources){
 const author=he001ProtocolFixtures();
 const fromAuthor=(oldId:string,id=oldId)=>{
  const old=structuredClone(author.find(x=>x.id===oldId)!);
  const review:HE001V4Review={...old.review,version:HE001_V4,claims:old.review.claims.map(c=>({
   id:c.id,statement:c.quote,quote:c.quote,label:c.label,criticalError:c.critical,reason:c.reason,
   evidence:c.evidence.map(source=>({source,quote:sources[source],relation:c.label==='refuted'?'contradicts':c.label==='supported'?'supports':'context'})),
   citation:{...c.citation,sources:he001VisibleSourceIds(c.quote),quote:c.citation.label==='not_applicable'?null:c.quote},
  }))};
  return {id,answer:old.answer,review,origin:'v4_author_synthetic_not_model_output_or_independent_gold'};
 };
 const base=fromAuthor('supported_complete');
 const transform=(id:string,change:(s:string)=>string)=>{
  const f=fromAuthor('supported_complete',id);f.answer=change(f.answer);
  for(const c of f.review.claims){c.statement=change(c.statement);c.quote=change(c.quote);c.citation.sources=he001VisibleSourceIds(c.quote);
   if(c.citation.label!=='not_applicable'){
    c.citation.label=c.citation.sources.length?'partial':'missing';
    c.citation.quote=c.citation.sources.length?c.quote:null;
    c.citation.reason=c.citation.sources.length?'正文仍有D3，但复合段落其他主张的引用范围不明确。':'此主张没有可归属的显式材料编号。';
   }
  }
  for(const row of [...f.review.findings,...f.review.boundaries,f.review.verification])if(row.quote!==null)row.quote=change(row.quote);
  return f;
 };
 const removeParentheses=(s:string)=>s.replace(/（D[^）]+）/g,'');
 const parentheses=transform('parenthetical_citations_removed_inline_D3_kept',removeParentheses);
 const noIds=transform('no_explicit_material_ids',s=>removeParentheses(s).replaceAll('D3未给出','所给材料未给出'));
 const shared=fromAuthor('supported_complete','shared_negation_separate_statements');
 const compound=shared.review.claims[4];
 shared.review.claims.splice(4,1,...[
  '三项措施同时实施且复机负载降低，五班次未停机。',
  '上述复机观察不能分离各措施贡献。',
  '上述复机观察不能证明永久修复。',
  '上述复机观察不能证明其他措施毫无作用。',
 ].map((statement,i)=>({...structuredClone(compound),id:`C5-${i+1}`,statement})));
 return [base,parentheses,noIds,shared,fromAuthor('endorsed_historical_overclaim'),fromAuthor('explicit_controller_contradiction'),fromAuthor('fabricated_independent_measurement')];
}

/** Deliberately synthetic micro-controls, NOT replacement HE-001 materials.
 * The source text varies; the candidate's assertion stays byte-identical. */
export function he001V4EvidenceControls(){
 const answer='供应商另做了独立测量。';
 return [
  {id:'absence_is_not_negation',source:'供应商服务通报注明技术依据为实验室简报，未附新增测量记录。',expectedLabel:'unsupported',expectedRelation:'context'},
  {id:'explicit_negation',source:'供应商服务通报明确记载：供应商没有另做独立测量。',expectedLabel:'refuted',expectedRelation:'contradicts'},
  {id:'explicit_confirmation',source:'供应商服务通报明确记载：供应商另做了独立测量，并附完整新增测量记录。',expectedLabel:'supported',expectedRelation:'supports'},
 ].map(x=>({...x,answer,origin:'synthetic_judge_only_micro_control_not_benchmark_question_or_independent_gold'}));
}
