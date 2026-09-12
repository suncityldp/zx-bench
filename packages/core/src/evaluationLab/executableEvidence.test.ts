import {describe,it,expect} from 'vitest';
import {EE_CLAIMS,EE_RUNTIME_SOURCE,eeWorlds,eeReference,eeCandidateQuestion,eeWorldConsistent,gradeExecutableEvidence} from './executableEvidence.js';
import {buildChallengePack} from './challengePack.js';
describe('EE-001 independent possible-world checks',()=>{
 // Symbolic argument, independent of the enumeration implementation:
 // C not recovered forces network=false. B is disabled yet recovered, forcing
 // manual=B. Hence A's recovery forces workerA=imageA=true. C needs at least
 // one of workerC/imageC=false. Those are the only three possibilities.
 const symbolic=[
  {networkCleared:false,manualTarget:'B',workerA:true,imageA:true,workerC:false,imageC:false},
  {networkCleared:false,manualTarget:'B',workerA:true,imageA:true,workerC:true,imageC:false},
  {networkCleared:false,manualTarget:'B',workerA:true,imageA:true,workerC:false,imageC:true},
 ];
 it('matches the separately derived complete three-world set',()=>{
  expect(eeWorlds()).toHaveLength(3);for(const w of symbolic)expect(eeWorlds()).toContainEqual(w);
 });
 it('checks the complete verdict vector independently, without using reference labels',()=>{
  const verdicts=['refuted','supported','supported','undetermined','undetermined','refuted','refuted','refuted'];
  expect(EE_CLAIMS.map(c=>eeReference()[c.id].verdict)).toEqual(verdicts);
 });
 it('accepts all valid alternative witness pairs, not one author pair',()=>{
  for(const yes of symbolic)for(const no of symbolic){
   const a=eeReference();a.c4.witnesses=[yes as any,no as any];
   expect(gradeExecutableEvidence(JSON.stringify(a)).strictPass).toBe(yes.workerC&&!no.workerC);
   const b=eeReference();b.c5.witnesses=[yes as any,no as any];
   expect(gradeExecutableEvidence(JSON.stringify(b)).strictPass).toBe(!yes.imageC&&no.imageC);
  }
 });
 it('rejects blanket uncertainty, false certainty and witnesses inconsistent with other observations',()=>{
  const a=eeReference();for(const c of EE_CLAIMS)a[c.id]={verdict:'undetermined',witnesses:[symbolic[0] as any,symbolic[1] as any]};
  expect(gradeExecutableEvidence(JSON.stringify(a)).strictPass).toBe(false);
  for(const c of EE_CLAIMS){const b=eeReference();b[c.id].verdict=b[c.id].verdict==='supported'?'refuted':'supported';b[c.id].witnesses=[];expect(gradeExecutableEvidence(JSON.stringify(b)).strictPass).toBe(false);}
  const b=eeReference();b.c4.witnesses[0].networkCleared=true;expect(gradeExecutableEvidence(JSON.stringify(b)).strictPass).toBe(false);
 });
 it('rejects duplicate keys, extra fields, missing claims, invalid boolean coercions and truncation',()=>{
  const a=eeReference(),text=JSON.stringify(a);expect(gradeExecutableEvidence(text).strictPass).toBe(true);
  expect(gradeExecutableEvidence(text,false).strictPass).toBe(false);
  expect(gradeExecutableEvidence(text.replace('{','{"c1":null,')).formatValid).toBe(false);
  expect(gradeExecutableEvidence(text.replace('{','{"\\u00631":null,')).formatValid).toBe(false);
  expect(gradeExecutableEvidence(JSON.stringify({...a,extra:1})).formatValid).toBe(false);
  delete a.c1;expect(gradeExecutableEvidence(JSON.stringify(a)).formatValid).toBe(false);
  expect(eeWorldConsistent({...symbolic[0],workerA:1})).toBe(false);
 });
 it('has no references in candidate export and no production pack integration',()=>{
  const q=eeCandidateQuestion();expect(q.messages[1].content).toContain(EE_RUNTIME_SOURCE);expect(q.messages[1].content).toContain('overrides = {"A": True, "C": True}');
 });
 it('stays outside existing official/development challenge scores',()=>{
  expect(buildChallengePack().cases.some(c=>c.id==='EE-001')).toBe(false);
  expect(JSON.stringify(eeCandidateQuestion())).not.toMatch(/reference|expected|symbolic|worldCount/);
 });
});
