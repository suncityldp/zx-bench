import {describe,it,expect} from 'vitest';
import {HE001_CRITERIA,scoreHE001Review} from './he001Rubric.js';
import {he001Fixtures} from './he001Fixtures.js';
describe('HE-001 draft semantic-review accounting (not Judge calibration)',()=>{
 const anchors=he001Fixtures();
 it('weights total 100 with nine distinct criteria',()=>{expect(HE001_CRITERIA.reduce((n,c)=>n+c.weight,0)).toBe(100);expect(new Set(HE001_CRITERIA.map(c=>c.id)).size).toBe(9);});
 it.each(anchors)('$id has transparent expected arithmetic and separate critical flags',a=>{
  const g=scoreHE001Review(a.answer,a.review);expect(g.weightedScore).toBe(a.expectedScore);expect(g.hasCriticalUnsupportedClaim).toBe(a.expectedCritical);
  if(a.expectedCritical)expect(g.fullRubricPass).toBe(false);
 });
 it('does not let blanket abstention earn a high score',()=>{const a=anchors.find(a=>a.id==='blanket_uncertainty')!;expect(scoreHE001Review(a.answer,a.review).weightedScore).toBe(15);});
 it('accepts distinct investigation choices without an exact citation whitelist',()=>{
  for(const a of anchors.filter(a=>a.id.startsWith('full_alternative_')))expect(scoreHE001Review(a.answer,a.review).fullRubricPass).toBe(true);
 });
 it('rejects missing, duplicate and unknown reviews rather than defaulting to points',()=>{
  const a=anchors[0];for(const mutate of [(r:any)=>r.assessments.pop(),(r:any)=>r.assessments[1]=r.assessments[0],(r:any)=>r.assessments[0].id='unknown',(r:any)=>r.assessments[0].level=3,(r:any)=>r.rubricVersion='old']){
   const r=structuredClone(a.review);mutate(r);expect(()=>scoreHE001Review(a.answer,r)).toThrow();
  }
 });
 it('requires actual answer spans and explanations for points and error flags',()=>{
  const a=anchors[0];for(const mutate of [(r:any)=>r.assessments[0].quote='not in answer',(r:any)=>r.assessments[0].quote=null,(r:any)=>r.assessments[0].rationale='',(r:any)=>r.criticalErrors=[{id:'asserts_unique_historical_cause',quote:'not in answer',rationale:'reason'}],(r:any)=>r.criticalErrors=undefined]){
   const r=structuredClone(a.review);mutate(r);expect(()=>scoreHE001Review(a.answer,r)).toThrow();
  }
 });
 it('does not score raw answer text without a semantic review',()=>{
  expect(()=>scoreHE001Review(anchors[0].answer,{rubricVersion:'HE-001-rubric-draft-v0.1',assessments:[],criticalErrors:[]})).toThrow();
 });
});
