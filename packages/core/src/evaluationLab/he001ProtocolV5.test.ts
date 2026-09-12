import {readFileSync} from 'node:fs';
import {describe,it,expect,vi} from 'vitest';
import {HE001_V5,buildHE001V5ExtractionRequest,parseHE001V5Extraction,buildHE001V5JudgmentRequest,parseHE001V5Judgment,runHE001V5Stages,he001V5Segments,uniqueHE001V5Inputs} from './he001ProtocolV5.js';
import {he001V5Fixtures} from './he001ProtocolV5Fixtures.js';
const question=readFileSync(new URL('./fixtures/he001-question.md',import.meta.url),'utf8');
const answer='25℃检查中，S17和S29的读数均在校准允差内。（D3）\n\n所给材料未记录25℃检查时连接端湿度。\n\n建议补充独立测温。';
function fixture(){
 const request=buildHE001V5ExtractionRequest(answer);
 const a={version:HE001_V5,stage:'candidate_extraction',candidateHash:request.candidate.hash,complete:true,
  claims:request.candidate.segments.map((s,i)=>({id:`C${i+1}`,statement:s.text,segmentIds:[s.id],stance:i===2?'nonfactual':'endorsed',kind:i===0?'world_assertion':i===1?'material_metadata':'proposal_or_other'}))};
 const packet=buildHE001V5JudgmentRequest(answer,question,JSON.stringify(a),'stop');
 const scope={purpose:'not_recorded_in_materials',question:'25℃检查时探头连接端湿度是否有记录？',documentIds:packet.scopeRules.closedCorpusDocumentIds,inspectedSegmentIds:packet.scopeRules.allSourceSegmentIds,conclusion:'not_found',foundSegmentIds:[],compatiblePossibilities:[],reason:'全部给定材料未注明该次检查湿度；不推断现实没有湿度。'};
 const b={version:HE001_V5,stage:'evidence_judgment',bindingHash:packet.bindingHash,judgments:a.claims.map((c,i)=>({claimId:c.id,meaningPreserved:true,stanceConfirmed:true,alignmentReason:'作者测试标签，非独立语义核验。',label:i===2?'nonfactual':'supported',criticalError:false,reason:'仅用于结构回归。',evidence:i===0?[{segmentId:'D3:P001',relation:'supports'}]:[],scopeAudit:i===1?structuredClone(scope):null,
   citation:{label:i===0?'adequate':i===1?'missing':'not_applicable',candidateSegmentIds:i===0?['A001']:[],sourceIds:i===0?['D3']:[],reason:'候选实际编号。'}})),
  findings:packet.referenceScope.findings.map(f=>({id:f.id,level:0,candidateSegmentIds:[],reason:'微型测试回答没有完整覆盖此题。'})),
  boundaries:packet.referenceScope.boundaries.map(f=>({id:f.id,level:0,candidateSegmentIds:[],reason:'不凭拒答给满分。'})),
  verification:{specific:false,contrastingOutcomes:false,respectsHistoryLimit:false,candidateSegmentIds:['A003'],reason:'只有简略建议，不假设已满足完整验证要求。'}};
 return {a,b,packet};
}
function parse(f=fixture()){return parseHE001V5Judgment(answer,question,JSON.stringify(f.a),'stop',JSON.stringify(f.b),'stop');}
describe('HE-001 v5 isolated extraction and scoped evidence protocol',()=>{
 it('stage A contains only candidate content and neutral extraction instructions',()=>{
  const a=buildHE001V5ExtractionRequest(answer);expect(a).not.toHaveProperty('question');expect(a).not.toHaveProperty('sources');expect(a).not.toHaveProperty('referenceScope');
  expect(JSON.stringify(a)).not.toContain('两份独立调查均证实');expect(a.candidate.segments.map(s=>s.text)).toEqual(answer.split('\n\n'));
 });
 it('preserves UTF-16 offsets, punctuation, shared negation and CRLF bytes',()=>{
  const text='🙂不能A、B或C。\r\n\r\n第二段。';const segments=he001V5Segments(text,'A');
  expect(segments[0].text).toBe('🙂不能A、B或C。');expect(segments[1].start).toBe(text.indexOf('第二段'));
  for(const s of segments)expect(text.slice(s.start,s.end)).toBe(s.text);
 });
 it('constructs candidate quotes locally, not from generated prose',()=>{
  const f=fixture(),parsed=parseHE001V5Extraction(answer,JSON.stringify(f.a),'stop');
  expect(parsed.claims[0].origin.quote).toBe(answer.split('\n\n')[0]);expect(parsed.gate.normalizedMeaningValidated).toBe(false);
 });
 it.each(['incomplete','unknown_reference','missing_paragraph','duplicate_id','duplicate_statement','changed_hash','extra_quote','source_reference','noncontiguous'])('blocks stage B for %s extraction',async mode=>{
  const {a}=fixture();
  if(mode==='incomplete')a.complete=false;
  if(mode==='unknown_reference')a.claims[0].segmentIds=['A999'];
  if(mode==='missing_paragraph')a.claims.pop();
  if(mode==='duplicate_id')a.claims[1].id=a.claims[0].id;
  if(mode==='duplicate_statement')a.claims[1].statement=a.claims[0].statement;
  if(mode==='changed_hash')a.candidateHash='wrong';
  if(mode==='extra_quote')(a.claims[0] as any).quote='题面中待批驳的文字';
  if(mode==='source_reference')a.claims[0].segmentIds=['D6:P002'];
  if(mode==='noncontiguous')a.claims[0].segmentIds=['A001','A003'];
  const invoke=vi.fn(async()=>({content:JSON.stringify(a),finishReason:'stop'}));
  await expect(runHE001V5Stages(answer,question,invoke)).rejects.toThrow();expect(invoke).toHaveBeenCalledTimes(1);
 });
 it('rejects truncated or old-format extraction without calling stage B',async()=>{
  const old=JSON.parse(readFileSync(new URL('./fixtures/he001-v4-j4-002-raw.json',import.meta.url),'utf8'));
  for(const response of [{content:old.content,finishReason:'stop'},{content:JSON.stringify(fixture().a),finishReason:'length'}]){
   const invoke=vi.fn(async()=>response);await expect(runHE001V5Stages(answer,question,invoke)).rejects.toThrow();expect(invoke).toHaveBeenCalledTimes(1);
  }
 });
 it('retains raw stage responses when extraction or judgment fails',async()=>{
  const f=fixture();
  for(const badStage of ['candidate_extraction','evidence_judgment']){
   const invoke=vi.fn(async(stage:string)=>({content:stage===badStage?'invalid raw response':JSON.stringify(f.a),finishReason:'stop'}));
   try{await runHE001V5Stages(answer,question,invoke);expect.fail('Expected pipeline rejection');}catch(e:any){
    expect(e.name).toBe('HE001V5PipelineError');expect(e.stageA.content).toBe(badStage==='candidate_extraction'?'invalid raw response':JSON.stringify(f.a));
    if(badStage==='candidate_extraction')expect(e.stageB).toBeNull();else expect(e.stageB.content).toBe('invalid raw response');
   }
   expect(invoke).toHaveBeenCalledTimes(badStage==='candidate_extraction'?1:2);
  }
 });
 it('reuses a complete negation context for multiple distinct normalized claims',()=>{
  const text='不能分离各措施贡献、证明永久修复或断言其他措施毫无作用。',r=buildHE001V5ExtractionRequest(text);
  const a={version:HE001_V5,stage:'candidate_extraction',candidateHash:r.candidate.hash,complete:true,claims:['不能证明永久修复。','不能断言其他措施毫无作用。'].map((statement,i)=>({id:`C${i}`,statement,segmentIds:['A001'],stance:'endorsed',kind:'inference_limit'}))};
  const parsed=parseHE001V5Extraction(text,JSON.stringify(a),'stop');expect(parsed.claims.every((c:any)=>c.origin.quote===text)).toBe(true);
 });
 it('stage B exposes immutable targets and distinguishes D6 draft from record evidence',()=>{
  const {packet}=fixture();expect(packet.lockedClaims[0].origin.segmentIds).toEqual(['A001']);
  expect(packet.sources.find(s=>s.id==='D6')!.segments.some(s=>s.role==='quoted_draft_not_established_fact')).toBe(true);
  expect(packet).not.toHaveProperty('question');expect(packet.schema.properties).not.toHaveProperty('claims');
 });
 it('the two-stage callback sequence runs once per stage and does not retry',async()=>{
  const f=fixture(),invoke=vi.fn(async(stage:string)=>({content:JSON.stringify(stage==='candidate_extraction'?f.a:f.b),finishReason:'stop'}));
  const output=await runHE001V5Stages(answer,question,invoke);expect(invoke.mock.calls.map(c=>c[0])).toEqual(['candidate_extraction','evidence_judgment']);expect(output.result.profile).not.toBeNull();
 });
 it.each(['new_claim','missing_claim','duplicate_claim','extra_statement','extra_quote','stale_binding'])('rejects stage B target substitution: %s',mode=>{
  const f=fixture();if(mode==='new_claim')f.b.judgments[0].claimId='C999';if(mode==='missing_claim')f.b.judgments.pop();if(mode==='duplicate_claim')f.b.judgments[1].claimId='C1';
  if(mode==='extra_statement')(f.b.judgments[0] as any).statement='题面D6的断言';if(mode==='extra_quote')(f.b.judgments[0] as any).quote='题面文字';if(mode==='stale_binding')f.b.bindingHash='old';
  expect(()=>parse(f)).toThrow();
 });
 it.each([false,null])('withholds the profile if semantic alignment is %s',value=>{
  const f=fixture();(f.b.judgments[0] as any).meaningPreserved=value;const p=parse(f);expect(p.profile).toBeNull();expect(p.state).toBe('alignment_review_required');
 });
 it('detects stale A/B binding after normalization or source text changes',()=>{
  const f=fixture();f.a.claims[0].statement='改变了规范化的内容';expect(()=>parse(f)).toThrow(/binding/);
  const fresh=fixture();expect(()=>parseHE001V5Judgment(answer,question.replace('82±0.2','82±0.3'),JSON.stringify(fresh.a),'stop',JSON.stringify(fresh.b),'stop')).toThrow(/binding/);
 });
 it('a complete material-scope audit can support an absence claim without a fabricated local supports quote',()=>{
  const f=fixture();expect(f.b.judgments[1].evidence).toEqual([]);const p=parse(f);expect(p.profile?.reliability.supported).toBe(2);expect(p.verification.scopeConclusionVerified).toBe(false);
 });
 it.each(['missing_document','missing_segment','invented_segment','found_with_no_record','not_found_with_record','uncertain','no_scope'])('rejects invalid absence support: %s',mode=>{
  const f=fixture(),a=f.b.judgments[1].scopeAudit!;
  if(mode==='missing_document')a.documentIds.pop();if(mode==='missing_segment')a.inspectedSegmentIds.pop();if(mode==='invented_segment')a.inspectedSegmentIds[0]='D99:P001';
  if(mode==='found_with_no_record')a.conclusion='found';if(mode==='not_found_with_record')a.foundSegmentIds=['D3:P001'] as never[];
  if(mode==='uncertain')a.conclusion='uncertain';if(mode==='no_scope')f.b.judgments[1].scopeAudit=null;
  expect(()=>parse(f)).toThrow();
 });
 it('does not use a scope-only absence audit to refute or confirm a world fact',()=>{
  for(const label of ['supported','refuted']){
   const f=fixture();f.a.claims[1].kind='world_assertion';f.b.bindingHash=buildHE001V5JudgmentRequest(answer,question,JSON.stringify(f.a),'stop').bindingHash;f.b.judgments[1].label=label;expect(()=>parse(f)).toThrow();
  }
 });
 it('underdetermination requires an inference-limit claim and two distinct compatible possibilities',()=>{
  const f=fixture();f.a.claims[1].kind='inference_limit';f.b.bindingHash=buildHE001V5JudgmentRequest(answer,question,JSON.stringify(f.a),'stop').bindingHash;
  Object.assign(f.b.judgments[1].scopeAudit!,{purpose:'not_determined_by_materials',conclusion:'underdetermined',compatiblePossibilities:['现场真实超温，同时有条件性传感器异常。','现场未超温，出现条件性误报。']});
  expect(()=>parse(f)).not.toThrow();f.b.judgments[1].scopeAudit!.compatiblePossibilities=['同一个情形','同一个情形'] as never[];expect(()=>parse(f)).toThrow();
 });
 it('material segment existence does not prove a contradiction relation or Judge reason',()=>{
  const f=fixture();f.b.judgments[0].label='refuted';f.b.judgments[0].evidence[0].relation='contradicts';const p=parse(f);
  expect(p.verification.evidenceEntailmentVerified).toBe(false);expect(p.verification.judgeReasonVerified).toBe(false);expect(p.verification.productionEligible).toBe(false);
 });
 it.each(['unknown_source','missing_cite_id','wrong_candidate_cite','invented_verification','source_as_finding','supported_critical'])('rejects %s',mode=>{
  const f=fixture();if(mode==='unknown_source')f.b.judgments[0].evidence[0].segmentId='D7:P001';if(mode==='missing_cite_id')f.b.judgments[0].citation.sourceIds=['D4'];
  if(mode==='wrong_candidate_cite')f.b.judgments[0].citation.candidateSegmentIds=['A002'];
  if(mode==='invented_verification'){f.b.verification.specific=true;f.b.verification.candidateSegmentIds=[];}
  if(mode==='source_as_finding'){f.b.findings[0].level=2;f.b.findings[0].candidateSegmentIds=['D3:P001'] as never[];}
  if(mode==='supported_critical')f.b.judgments[0].criticalError=true;expect(()=>parse(f)).toThrow();
 });
 it('rejects endorsed error labels on a rejected quotation',()=>{
  const f=fixture();f.a.claims[0].stance='rejected_quote';f.b.bindingHash=buildHE001V5JudgmentRequest(answer,question,JSON.stringify(f.a),'stop').bindingHash;f.b.judgments[0].label='unsupported';f.b.judgments[0].criticalError=true;expect(()=>parse(f)).toThrow();
 });
 it('has seven distinct visible controls, including a real shared-to-explicit negation change',()=>{
  const f=he001V5Fixtures(question);expect(f).toHaveLength(7);expect(new Set(f.map(x=>x.answer)).size).toBe(7);
  expect(f.find(x=>x.id==='explicit_negation_same_meaning')!.answer).toContain('不能分离各措施贡献，不能证明永久修复');
  expect(()=>uniqueHE001V5Inputs([{id:'a',answer:'同一个回答'},{id:'b',answer:'同一个回答'}])).toThrow(/Duplicate visible/);
 });
});
