import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildVerifiableCore, scoreVerifiableRun, gradeVerifiableCase, auxiliaryObservation, verifyFrozenCore, type CoreSubmission} from './verifiableCore.js';
import {referenceAnswer} from './challengePack.js';
import type {EvidenceCase} from './challengeTypes.js';

const pack=buildVerifiableCore();
function oracle():CoreSubmission {return {contractHash:pack.contractHash,runId:'synthetic-QA-not-model',modelId:'author-oracle',
  answers:pack.cases.map(c=>({id:c.id,questionHash:pack.contract.plannedQuestions.find(q=>q.id===c.id)!.questionHash,
    outcome:'completed',output:JSON.stringify(referenceAnswer(c))}))};}
const row=(id:string)=>oracle().answers.find(a=>a.id===id)!;

describe('verifiable core: deterministic primary, Judge auxiliary only',()=>{
 it('has 12 math and 8 evidence cases, no HE-001, no public gold, no automatic Judge',()=>{
  expect(pack.cases.filter(c=>c.dimension==='reasoning_math')).toHaveLength(12);
  expect(pack.cases.filter(c=>c.dimension==='hallucination_resistance')).toHaveLength(8);
  expect(pack.contract.policy.judge).toEqual({automaticCalls:false,role:'optional_diagnostic_only',scoreWeight:0});
  expect(pack.contract.plannedQuestions.some(q=>q.id==='HE-001')).toBe(false);
  expect(pack.questions.every(q=>!('reference' in q)&&!('fields' in q)&&!('expected' in q))).toBe(true);
  expect(pack.contract.policy.productionEligible).toBe(false);
 });
 it('oracle QA passes both dimensions without creating a combined or official score',()=>{
  const r=scoreVerifiableRun(oracle());expect(r.dimensions.map(d=>d.score)).toEqual([100,100]);
  expect(r.rows.every(r=>r.strictPass)).toBe(true);expect(r.combinedScore).toBeNull();
  expect(r.productionScoresChanged).toBe(false);expect(r.judgeCalls).toBe(0);
 });
 it('a wrong value earns no credit merely for correct citations',()=>{
  const c=pack.cases.find(c=>c.id==='HC3-001') as EvidenceCase,a=row(c.id),value=JSON.parse(a.output);
  value.r17_tested_repair.value=true;a.output=JSON.stringify(value);
  const r=gradeVerifiableCase(c,a);expect(r.score).toBe(75);
  expect(r.fieldChecks[0]).toEqual({id:'r17_tested_repair',answer:false,sources:true,joint:false});
 });
 it('correct value with missing, irrelevant or invented evidence loses the whole field',()=>{
  const c=pack.cases.find(c=>c.id==='HC3-001')!;
  for(const sources of [[],['D7'],['D99']]) {
    const a=row(c.id),v=JSON.parse(a.output);v.r17_tested_repair.sources=sources;a.output=JSON.stringify(v);
    expect(gradeVerifiableCase(c,a).score).toBe(75);
  }
 });
 it('abstaining on every field cannot earn full score; wrong insufficiency/conflict is rejected',()=>{
  for(const c of pack.cases.filter((c):c is EvidenceCase=>c.dimension==='hallucination_resistance')) {
    const a=row(c.id),v=JSON.parse(a.output);for(const f of c.fields){v[f.id].value=null;v[f.id].status='insufficient';}
    a.output=JSON.stringify(v);expect(gradeVerifiableCase(c,a).score).toBeLessThan(100);
  }
  const c=pack.cases.find(c=>c.id==='HC3-007')!,a=row(c.id),v=JSON.parse(a.output);
  v.production_mode.status='insufficient';a.output=JSON.stringify(v);expect(gradeVerifiableCase(c,a).score).toBe(75);
 });
 it('accepts a sufficient concise citation and preserves uncertainty versus falsity',()=>{
  const c=pack.cases.find(c=>c.id==='HC3-004')!,a=row(c.id),v=JSON.parse(a.output);
  v.sensor_root_cause.sources=['D5'];a.output=JSON.stringify(v);expect(gradeVerifiableCase(c,a).score).toBe(100);
  v.sensor_root_cause.value=false;v.sensor_root_cause.status='determined';a.output=JSON.stringify(v);
  expect(gradeVerifiableCase(c,a).score).toBe(75);
 });
 it('math requires the certificate too, not just the optimal final number',()=>{
  const c=pack.cases.find(c=>c.id==='MC2-001')!,a=row(c.id),v=JSON.parse(a.output);
  v.arrivals[0]+=1;a.output=JSON.stringify(v);expect(gradeVerifiableCase(c,a).score).toBe(0);
 });
 it.each(['not json','{"x":1,"x":2}','{}'])('completed malformed response is zero: %s',output=>{
  const c=pack.cases[0],a=row(c.id);a.output=output;const r=gradeVerifiableCase(c,a);
  expect(r.score).toBe(0);expect(r.state).toBe('measured');expect(r.strictPass).toBe(false);
 });
 it.each(['truncated','environment_error'] as const)('%s never certifies even a complete-looking oracle response',outcome=>{
  const input=oracle();input.answers[0].outcome=outcome;const r=scoreVerifiableRun(input);
  expect(r.rows[0].score).toBeNull();expect(r.rows[0].strictPass).toBeNull();expect(r.dimensions[0].score).toBeNull();
  expect(r.dimensions[0].planned).toBe(8);expect(r.dimensions[1].score).toBe(100);
 });
 it('missing answers do not disappear from denominators or become zero capability',()=>{
  const input=oracle();input.answers.shift();const r=scoreVerifiableRun(input);
  expect(r.rows).toHaveLength(20);expect(r.rows[0].state).toBe('missing');expect(r.dimensions[0].score).toBeNull();
 });
 it('rejects duplicates regardless of which answer scores higher',()=>{
  for(const reverse of [false,true]) {const input=oracle(),duplicate={...input.answers[0],output:'{}'};
    if(reverse)input.answers.unshift(duplicate);else input.answers.push(duplicate);
    expect(()=>scoreVerifiableRun(input)).toThrow(/duplicate/);
  }
 });
 it('rejects stale questions, stale policy, unplanned open questions, and Judge score injection',()=>{
  const a=oracle();a.answers[0].questionHash='stale';expect(()=>scoreVerifiableRun(a)).toThrow(/stale/);
  const b=oracle();b.contractHash='stale';expect(()=>scoreVerifiableRun(b)).toThrow(/stale/);
  const c=oracle();c.answers[0].id='HE-001';expect(()=>scoreVerifiableRun(c)).toThrow(/Unknown/);
  expect(()=>scoreVerifiableRun({...oracle(),judgeScore:100})).toThrow();
  const d=oracle();Object.assign(d.answers[0],{judgeScore:100});expect(()=>scoreVerifiableRun(d)).toThrow();
 });
 it('keeps the real v0.6 failed Judge response diagnostic-only, not a repaired score',()=>{
  const raw=JSON.parse(readFileSync(new URL('./fixtures/he001-v6-failed-raw.json',import.meta.url),'utf8'));
  const review=JSON.parse(raw.content);expect(review.judgments.find((j:any)=>j.claimId==='c4').label).toBe('refuted');
  const diagnostic=auxiliaryObservation('HE-001',review);
  expect(diagnostic.primaryScore).toBeNull();expect(diagnostic.includedInPrimary).toBe(false);
  expect(diagnostic.observation).toEqual(review);expect(diagnostic.semanticAccuracyVerified).toBe(false);
 });
 it('detects modified frozen references and accepts only the current exact contract',()=>{
  expect(verifyFrozenCore(pack).contractHash).toBe(pack.contractHash);
  const bad=structuredClone(pack);bad.cases.pop();expect(()=>verifyFrozenCore(bad)).toThrow(/mismatch/);
 });
});
