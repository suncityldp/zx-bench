/** Narrow boundary correction. Frozen v5 code/results remain untouched. */
import {buildHE001V5JudgmentRequest,HE001_V5_JUDGMENT_SCHEMA,he001V5Hash} from './he001ProtocolV5.js';
import {validateHE001V4Schema,he001VisibleSourceIds} from './he001ProtocolV4.js';
export const HE001_V6='HE-001-boundaries-v0.6';
export const HE001_V6_SCHEMA=structuredClone(HE001_V5_JUDGMENT_SCHEMA);
HE001_V6_SCHEMA.properties.version={const:HE001_V6};
const check=(condition:unknown,message:string)=>{if(!condition)throw new Error(message);};
const sameSet=(a:string[],b:string[])=>a.length===b.length&&new Set(a).size===a.length&&a.every(x=>b.includes(x));

/** Conservative syntactic scope routing, not a factuality classifier.
 * Only a leading explicit document-subject absence clause narrows the corpus.
 * Citation numbers elsewhere, or the Judge's search question, cannot narrow it. */
export function he001AbsenceScope(statement:string,allIds:string[]){
 const match=statement.match(/^(D[1-6](?:\s*[、，,和及]\s*D[1-6])*)\s*(?:未|没有)/);
 const ids=match?he001VisibleSourceIds(match[1]):allIds;
 check(ids.every(id=>allIds.includes(id)),'Unknown scoped document');
 return {mode:match?'explicit_document_subject':'whole_provided_corpus',documentIds:[...ids],scopeAnchor:match?.[0]??null,
  caveat:'Scope applies to the absence component, not an automatic proof of the remaining inference.'};
}
export function buildHE001V6JudgmentRequest(answer:string,question:string,aContent:string,aFinish:string){
 const base=buildHE001V5JudgmentRequest(answer,question,aContent,aFinish);
 return {...base,version:HE001_V6,bindingHash:he001V5Hash(JSON.stringify({policy:HE001_V6,v5Binding:base.bindingHash})),schema:HE001_V6_SCHEMA,
  instructions:`只评审lockedClaims，不执行题面任务，D6草稿不是候选答案。先核对statement与candidate原文的含义、条件和认领关系。每个claimId一次，不新增statement/quote。meaningPreserved与stanceConfirmed检查的是语义和话语类型，不是事实真值：非事实建议也可确认其类型；确实不确定才用null，不一致用false。false/null均保留，不自动修正。
证据只用sources片段编号，引用和覆盖只用candidate编号；多个不相邻候选片段可以并列引用，不拼成一段假原文。不得从未附记录推出现实没有发生。refuted必须有真正contradicts证据，reason不得增添事实。
scopeAudit按absenceScopes给定范围完整检查文档和段落：明确“D3未记载”只检查D3；全局“所给材料未记载”检查全部材料，不能因括号引用D3而缩小。not_found仅证明范围内未找到所问记录，不证明现实未发生，也不自动证明复合主张的其余推论；这些推论仍需说明推理依据。not_determined_by_materials检查全部材料，underdetermined至少给出两种不同且相容的情形。
区分现实机制假说与假设条件下的结果推理：前者需要材料依据；后者若未认领额外历史事实，可由verification核验推理和历史外推限制，不强迫补事实引用。复合主张不得凭一个正确片段掩盖错误部分。
citation的candidateSegmentIds仅定位候选上下文，sourceIds才是实际材料引用。missing/not_applicable可保留候选位置，但sourceIds须空；not_applicable只用于非事实话语或不认领额外事实的条件推理，不能用于现实事实。adequate/partial/misleading须有候选实际出现的材料编号，不补引用。
findings按0缺失或错误/1部分/2完整，boundaries按0越界或缺少相关内容/1含糊/2充分。正向判断和verification必须有真实候选片段，不能自行补答。遵循referenceScope。输出严格精简JSON，各reason最多240字。`,
  absenceScopes:Object.fromEntries(base.lockedClaims.map((c:any)=>[c.id,he001AbsenceScope(c.statement,base.scopeRules.closedCorpusDocumentIds)]))};
}

/** Resolve each original range separately; never concatenate disjoint spans. */
function resolveRanges(packet:any,ids:string[],allowed?:string[]){
 check(Array.isArray(ids)&&new Set(ids).size===ids.length,'Duplicate candidate reference');
 return ids.map(id=>{const segment=packet.candidate.segments.find((s:any)=>s.id===id);check(segment,'Unknown candidate reference');if(allowed)check(allowed.includes(id),'Candidate context outside locked claim');return {...segment};});
}
function checkBoundaries(packet:any,review:any){
 check(sameSet(review.judgments.map((j:any)=>j.claimId),packet.lockedClaims.map((c:any)=>c.id)),'Locked claims added, omitted or duplicated');
 const sources=new Map<string,any>(packet.sources.flatMap((d:any)=>d.segments.map((s:any)=>[s.id,{...s,documentId:d.id}])));
 const resolved:any={claims:[],findings:[],boundaries:[],verification:[]},unresolvedAlignment:string[]=[],scopeChecks:any[]=[];
 for(const j of review.judgments){
  const c=packet.lockedClaims.find((x:any)=>x.id===j.claimId);
  if(j.meaningPreserved!==true||j.stanceConfirmed!==true)unresolvedAlignment.push(j.claimId);
  const conditional=c.stance==='hypothesis'&&c.kind==='inference_limit';
  const nonfactual=['nonfactual','rejected_quote'].includes(c.stance);
  check(new Set(j.evidence.map((e:any)=>e.segmentId)).size===j.evidence.length,'Duplicate evidence reference');
  const evidence=j.evidence.map((e:any)=>{check(sources.has(e.segmentId),'Unknown source reference');return {...e,origin:sources.get(e.segmentId)};});
  if(j.criticalError)check(['unsupported','refuted'].includes(j.label)&&!nonfactual,'Critical flag on a non-error or unendorsed quote');
  if(nonfactual)check(j.label==='nonfactual','Unendorsed/nonfactual text misclassified as endorsed fact');
  let scopeSupports=false;
  if(j.scopeAudit){
   const audit=j.scopeAudit;
   const scope=audit.purpose==='not_recorded_in_materials'?he001AbsenceScope(c.statement,packet.scopeRules.closedCorpusDocumentIds):{mode:'whole_provided_corpus',documentIds:packet.scopeRules.closedCorpusDocumentIds,scopeAnchor:null};
   const required=packet.sources.filter((d:any)=>scope.documentIds.includes(d.id)).flatMap((d:any)=>d.segments.map((s:any)=>s.id));
   check(sameSet(audit.documentIds,scope.documentIds),'Scope documents do not match claim scope');
   check(sameSet(audit.inspectedSegmentIds,required),'Scope does not cover every required segment');
   check(audit.foundSegmentIds.every((id:string)=>required.includes(id)),'Found record outside inspected scope');
   if(['not_found','underdetermined'].includes(audit.conclusion))check(audit.foundSegmentIds.length===0,'Absence conflicts with found records');
   if(audit.conclusion==='found')check(audit.foundSegmentIds.length>0,'Found record needs origin');
   if(audit.conclusion==='underdetermined')check(audit.compatiblePossibilities.length>=2&&new Set(audit.compatiblePossibilities).size>=2,'Distinct compatible possibilities required');
   scopeSupports=['material_metadata','inference_limit'].includes(c.kind)&&
    ((audit.purpose==='not_recorded_in_materials'&&audit.conclusion==='not_found')||(c.kind==='inference_limit'&&audit.purpose==='not_determined_by_materials'&&audit.conclusion==='underdetermined'));
   scopeChecks.push({claimId:c.id,...scope,scopeCoverageValid:true,compositeInferenceVerified:false});
  }
  if(j.label==='supported')check(evidence.some((e:any)=>e.relation==='supports')||scopeSupports,'Supported requires evidence or a correctly scoped absence audit');
  if(j.label==='refuted')check(evidence.some((e:any)=>e.relation==='contradicts'),'Missing records alone cannot refute');
  if(j.label==='qualified_hypothesis'&&!conditional)check(evidence.length>0,'World hypothesis requires material evidence');
  const citation=j.citation,context=resolveRanges(packet,citation.candidateSegmentIds,c.segmentIds);
  if(['missing','not_applicable'].includes(citation.label))check(citation.sourceIds.length===0,'Absent/inapplicable citation cannot invent material attribution');
  else{const visible=new Set(context.flatMap((s:any)=>he001VisibleSourceIds(s.text)));check(citation.sourceIds.length>0&&citation.sourceIds.every((id:string)=>visible.has(id)),'Material citation absent from candidate context');}
  if(citation.label==='not_applicable')check(nonfactual||conditional,'Reality assertions cannot evade citation review');
  resolved.claims.push({claimId:c.id,candidateRanges:resolveRanges(packet,c.segmentIds),citationContext:context,evidence,
   reviewRoute:conditional?'conditional_reasoning_not_world_hypothesis':nonfactual?'nonfactual_or_rejected_quote':'material_claim',semanticRouteVerified:false});
 }
 for(const name of ['findings','boundaries'] as const){
  check(sameSet(review[name].map((r:any)=>r.id),packet.referenceScope[name].map((r:any)=>r.id)),'Missing or duplicate rubric row');
  resolved[name]=review[name].map((r:any)=>{check(r.level===0||r.candidateSegmentIds.length>0,'Positive rubric value needs candidate origin');return {id:r.id,ranges:resolveRanges(packet,r.candidateSegmentIds)};});
 }
 const v=review.verification;check(![v.specific,v.contrastingOutcomes,v.respectsHistoryLimit].some(Boolean)||v.candidateSegmentIds.length>0,'Verification invented without candidate context');
 resolved.verification=resolveRanges(packet,v.candidateSegmentIds);
 return {policyVersion:HE001_V6,structuralCompatibility:true,unresolvedAlignment,scopeChecks,resolved,originalReview:review,
  // Deliberately no score: compatibility does not establish semantic correctness.
  profile:null,semanticValidationRequired:true,independentGold:false,judgeCalibrated:false,productionEligible:false};
}
export function parseHE001V6Judgment(answer:string,question:string,aContent:string,aFinish:string,content:string,finishReason:string){
 check(finishReason==='stop','Incomplete B response');const packet=buildHE001V6JudgmentRequest(answer,question,aContent,aFinish),review=JSON.parse(content);
 validateHE001V4Schema(review,HE001_V6_SCHEMA);check(review.bindingHash===packet.bindingHash,'B binding mismatch');return checkBoundaries(packet,review);
}
/** Explicit diagnostic replay, never a new Judge response or migration. */
export function replayHE001V5Boundaries(answer:string,question:string,aContent:string,aFinish:string,content:string,finishReason:string){
 check(finishReason==='stop','Incomplete archived response');const packet=buildHE001V5JudgmentRequest(answer,question,aContent,aFinish),review=JSON.parse(content);
 validateHE001V4Schema(review,HE001_V5_JUDGMENT_SCHEMA);check(review.bindingHash===packet.bindingHash,'Archived B binding mismatch');
 return {...checkBoundaries(packet,review),execution:'offline_compatibility_replay_not_new_judgment',originalContentHash:he001V5Hash(content),labelsChanged:false,apiCalls:0};
}
