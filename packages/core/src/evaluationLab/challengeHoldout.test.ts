import {describe,it,expect} from 'vitest';
import {buildEvidenceHoldoutDraft} from './challengeHoldout.js';
import {buildChallengePack,candidateQuestion,gradeChallenge,referenceAnswer} from './challengePack.js';
import {readFileSync} from 'node:fs';
describe('unrun holdout draft isolation',()=>{
 const draft=buildEvidenceHoldoutDraft();
 it('versions the user-approved wording change without changing other families or answer gold',()=>{
  const old=JSON.parse(readFileSync(new URL('./fixtures/holdout-draft-v0.1.json',import.meta.url),'utf8'));
  expect(draft.version).toBe('hall-holdout-draft-2026-09-10-v0.5');
  for(const e of draft.entries){const previous=old.entries.find((x:{case:{id:string}})=>x.case.id===e.case.id);
   expect(e.case.fields.map(f=>f.expected)).toEqual(previous.case.fields.map((f:{expected:unknown})=>f.expected));
   if(!['effective-key-and-registry-authority','certificate-full-scope-versus-excerpt'].includes(e.variantGroup))expect(e.case).toEqual(previous.case);
   if(e.variantGroup==='effective-key-and-registry-authority'){
    expect(e.intendedUse).toBe('boundary_consistency_check_not_high_difficulty');
    expect(e.case.documents.D1).not.toMatch(/同级效力|接收时刻不参与|只有明确指定/);
    const records=e.case.documents.D6.split('\n').slice(1).map(s=>JSON.parse(s));
    expect(records.length).toBe(e.case.id==='HB-09'?2:1);
    for(const record of records){expect(record.replaces).toBeNull();expect(record.effective_at).toBe('12:00');}
   }
  }
 });
 it('limits v0.3 changes to the approved certificate family and records no answer-gold approval',()=>{
  const old=JSON.parse(readFileSync(new URL('./fixtures/holdout-draft-v0.2.json',import.meta.url),'utf8'));
  for(const e of draft.entries){const previous=old.entries.find((x:{case:{id:string}})=>x.case.id===e.case.id);
   if(e.variantGroup!=='certificate-full-scope-versus-excerpt')expect(e.case).toEqual(previous.case);
   else{
    expect(e.intendedUse).toBe('boundary_consistency_check_not_high_difficulty');
    expect(e.case.documents.D1).not.toMatch(/完整附件之外|不沿商标许可转移|只有带签名/);
    expect(e.case.documents.D5).toContain('单条命中记录');
    expect(e.case.documents.D6).toContain('replaces: null');
    expect(e.case.fields.map(f=>f.expected)).toEqual(previous.case.fields.map((f:{expected:unknown})=>f.expected));
   }
  }
  expect(draft.questionReview).toHaveLength(4);expect(draft.independentHumanGold).toBe(false);
  expect(draft.questionReview.every(r=>r.scope.endsWith('_not_answer_gold'))).toBe(true);
 });
 it('v0.4 only reclassifies deployment cases and records redesign as pending, without changing any prompts or gold',()=>{
  const old=JSON.parse(readFileSync(new URL('./fixtures/holdout-draft-v0.3.json',import.meta.url),'utf8'));
  for(const e of draft.entries){const previous=old.entries.find((x:{case:{id:string}})=>x.case.id===e.case.id);
   expect(e.case).toEqual(previous.case);
   if(e.variantGroup==='versioned-deployment-versus-staged-build')expect(e.intendedUse).toBe('basic_regression_not_high_difficulty');
   else if(e.variantGroup!=='incident-identity-and-final-cause')expect(e).toEqual(previous);
  }
  expect(draft.redesignBacklog).toHaveLength(2);
  expect(draft.redesignBacklog[0].status).toBe('planned_not_authored');
 });
 it('v0.5 reclassifies the last family without modifying any saved question or factual gold',()=>{
  const old=JSON.parse(readFileSync(new URL('./fixtures/holdout-draft-v0.4.json',import.meta.url),'utf8'));
  for(const e of draft.entries){const previous=old.entries.find((x:{case:{id:string}})=>x.case.id===e.case.id);
   expect(e.case).toEqual(previous.case);
   if(e.variantGroup==='incident-identity-and-final-cause')expect(e.intendedUse).toBe('basic_regression_not_high_difficulty');
   else expect(e).toEqual(previous);
  }
  expect(draft.entries.every(e=>e.intendedUse!=='unclassified_pending_question_review')).toBe(true);
  expect(draft.suiteIntendedUse).toBe('boundary_and_basic_regression_not_high_difficulty_discrimination');
  expect(draft.redesignBacklog.find(b=>b.family==='incident-identity-and-final-cause')?.status).toBe('question_draft_pending_review');
 });
 it('contains four three-way counterfactual families, not twelve independent families',()=>{
  expect(draft.entries).toHaveLength(12);expect(new Set(draft.entries.map(e=>e.variantGroup)).size).toBe(4);
  expect(draft.independentHumanGold).toBe(false);expect(draft.modelCalls).toBe(0);
  const status=draft.entries.map(e=>e.case.fields[0].expected.status);
  for(const s of ['determined','insufficient','conflict'])expect(status.filter(x=>x===s)).toHaveLength(4);
  expect(draft.entries.filter(e=>e.case.fields[0].expected.value===true)).toHaveLength(2);
  expect(draft.entries.filter(e=>e.case.fields[0].expected.value===false)).toHaveLength(2);
 });
 it('changes only D6 within each family and leaves questions identical',()=>{
  for(const family of new Set(draft.entries.map(e=>e.variantGroup))){const variants=draft.entries.filter(e=>e.variantGroup===family);
   for(const e of variants){expect(e.case.fields[0].question).toBe(variants[0].case.fields[0].question);
    for(const id of ['D1','D2','D3','D4','D5'])expect(e.case.documents[id]).toBe(variants[0].case.documents[id]);
   }
   expect(new Set(variants.map(e=>e.case.documents.D6)).size).toBe(3);
  }
 });
 it('keeps gold out of prompts and all holdout IDs out of the current benchmark pack',()=>{
  for(const {case:c}of draft.entries){const before=candidateQuestion(c),changed=structuredClone(c);changed.fields[0].expected={value:'SECRET_987',status:'conflict',sources:['SECRET']};
   expect(candidateQuestion(changed)).toEqual(before);expect(JSON.stringify(before)).not.toContain('SECRET');
   expect(buildChallengePack().cases.some(x=>x.id===c.id)).toBe(false);
   expect(gradeChallenge(c,JSON.stringify(referenceAnswer(c))).strictPass).toBe(true);
  }
 });
 it('rejects one status used blindly across all variants',()=>{
  for(const status of ['determined','insufficient','conflict']){const passed=draft.entries.filter(({case:c})=>{const a=referenceAnswer(c) as any;a.claim={value:null,status,sources:['D1','D2','D6']};return gradeChallenge(c,JSON.stringify(a)).strictPass;});
   expect(passed.length).toBeLessThan(12);
  }
 });
});
