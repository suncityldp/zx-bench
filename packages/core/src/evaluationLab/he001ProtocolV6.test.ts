import {readFileSync} from 'node:fs';
import {it,expect} from 'vitest';
import {he001AbsenceScope,replayHE001V5Boundaries,buildHE001V6JudgmentRequest,parseHE001V6Judgment,HE001_V6} from './he001ProtocolV6.js';
import {buildHE001V5JudgmentRequest} from './he001ProtocolV5.js';
const read=(name:string)=>JSON.parse(readFileSync(new URL(`./fixtures/${name}`,import.meta.url),'utf8'));
const inputs=read('he001-v5-inputs.json'),a=read('he001-v5-stage-a.json'),b=read('he001-v5-stage-b.json'),answer=inputs.items[0].answer;
const replay=(review=JSON.parse(b.content))=>replayHE001V5Boundaries(answer,inputs.question,a.content,a.finishReason,JSON.stringify(review),b.finishReason);
it('replays the untouched archived response without changing labels or turning null into true',()=>{
 const p=replay();expect(p.structuralCompatibility).toBe(true);expect(p.unresolvedAlignment).toEqual(['C8','C9']);expect(p.profile).toBeNull();
 expect(p.originalReview).toEqual(JSON.parse(b.content));expect(p.labelsChanged).toBe(false);expect(p.productionEligible).toBe(false);
});
it('preserves disjoint evidence as separate original ranges, not a stitched quote',()=>{
 const ranges=replay().resolved.findings.find((x:any)=>x.id==='sensor_observation').ranges;
 expect(ranges.map((r:any)=>r.id)).toEqual(['A001','A004']);for(const r of ranges)expect(answer.slice(r.start,r.end)).toBe(r.text);
});
it('narrows only an explicit leading document absence subject',()=>{
 const all=['D1','D2','D3','D4','D5','D6'];expect(he001AbsenceScope('D3未给出湿度。',all).documentIds).toEqual(['D3']);
 expect(he001AbsenceScope('所给材料未记录湿度。（D3）',all).documentIds).toEqual(all);
 expect(he001AbsenceScope('D3、D5没有提供记录。',all).documentIds).toEqual(['D3','D5']);
});
it.each(['bad_scope','missing_scope_segment','unknown_range','fake_citation','scope_as_refutation','critical_nonfactual','duplicate_claim'])('still blocks %s',mode=>{
 const r=JSON.parse(b.content);if(mode==='bad_scope')r.judgments[1].scopeAudit.documentIds=['D4'];
 if(mode==='missing_scope_segment')r.judgments[1].scopeAudit.inspectedSegmentIds=[];
 if(mode==='unknown_range')r.findings[0].candidateSegmentIds=['D6:P002'];
 if(mode==='fake_citation')r.judgments[7].citation.sourceIds=['D3'];
 if(mode==='scope_as_refutation')r.judgments[1].label='refuted';
 if(mode==='critical_nonfactual')r.judgments[7].criticalError=true;
 if(mode==='duplicate_claim')r.judgments[1].claimId='C1';expect(()=>replay(r)).toThrow();
});
it('does not let a Judge narrow a global assertion just by writing a narrower search question',()=>{
 const x=JSON.parse(a.content);x.claims[1].statement='所给材料没有提供湿度记录。';
 const r=JSON.parse(b.content);r.bindingHash=buildHE001V5JudgmentRequest(answer,inputs.question,JSON.stringify(x),'stop').bindingHash;
 expect(()=>replayHE001V5Boundaries(answer,inputs.question,JSON.stringify(x),'stop',JSON.stringify(r),'stop')).toThrow(/Scope/);
});
it('does not exempt world hypotheses from evidence or citations',()=>{
 const x=JSON.parse(a.content);x.claims[8].kind='world_assertion';const r=JSON.parse(b.content);r.bindingHash=buildHE001V5JudgmentRequest(answer,inputs.question,JSON.stringify(x),'stop').bindingHash;
 expect(()=>replayHE001V5Boundaries(answer,inputs.question,JSON.stringify(x),'stop',JSON.stringify(r),'stop')).toThrow(/World hypothesis/);
});
it('keeps explicit false alignment unresolved, never accepts it as agreement',()=>{
 const r=JSON.parse(b.content);r.judgments[0].meaningPreserved=false;expect(replay(r).unresolvedAlignment).toContain('C1');
});
it('requires a fresh v6 binding for new executions and rejects old responses there',()=>{
 expect(()=>parseHE001V6Judgment(answer,inputs.question,a.content,'stop',b.content,'stop')).toThrow();
 const packet=buildHE001V6JudgmentRequest(answer,inputs.question,a.content,'stop');
 const synthetic=JSON.parse(b.content);synthetic.version=HE001_V6;synthetic.bindingHash=packet.bindingHash;
 expect(parseHE001V6Judgment(answer,inputs.question,a.content,'stop',JSON.stringify(synthetic),'stop').structuralCompatibility).toBe(true);
});
