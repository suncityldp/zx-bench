import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import type {Scenario,OutputMetadata,JudgeResult} from '@zxbench/types';
import {hashScenarioShort} from '../contracts/canonicalize.js';
import {hallucinationResistanceEvaluator as hallucination} from './hallucinationResistance.js';
import {exactAnswerLineEvaluator as math,validRiverCrossing} from './exactAnswerLine.js';
import {applyReviewedVerdict,mixDeterministicJudge} from '../scoring.js';
import {shouldEscalate} from '../judge/index.js';
const bank:Scenario[]=JSON.parse(readFileSync(new URL('../../../../data/scenarios/benchmark.json',import.meta.url),'utf8'));
const scenario=(id:string)=>bank.find(s=>s.id===id)!;
const meta={truncated:false,incomplete:false} as OutputMetadata;
const score=async(id:string,output:string)=>hallucination.evaluate(scenario(id),output,meta);
const reviewed=bank.filter(s=>s.dimension==='hallucination_resistance');
describe('all reviewed contracts',()=>{
 it('exports precisely 78 new IDs, with no retired HAL IDs in the active bank',()=>{
  expect(reviewed).toHaveLength(78);expect(new Set(reviewed.map(s=>s.id)).size).toBe(78);
  expect(reviewed.some(s=>s.id.startsWith('HAL-'))).toBe(false);
 });
 for(const s of reviewed)it(`${s.id}: individually reviewed rubric, complete weights, stable content hash`,()=>{
  const r=(s.requirements as any).reviewedRubric;
  expect(s).toMatchObject({scenarioVersion:'5.0.0',graderVersion:'hallucination_v5',reviewStatus:'verified'});
  expect(r.reference.length).toBeGreaterThan(10);expect(r.criteria.length).toBeGreaterThan(0);
  expect(new Set(r.criteria.map((c:any)=>c.id)).size).toBe(r.criteria.length);
  expect(r.criteria.reduce((sum:number,c:any)=>sum+c.weight,0)).toBeCloseTo(1);
  expect(s.scenarioHash).toBe(hashScenarioShort(s));
 });
 it('computes ISBN validity independently of configured gold',()=>{
  const r=(scenario('CI-072').requirements as any).expected;
  const valid=(id:string)=>[...id].reduce((sum,d,i)=>sum+Number(d)*(i%2?3:1),0)%10===0;
  for(const id of r.validIdentifiers)expect(valid(id),id).toBe(true);
  for(const id of r.invalidIdentifiers)expect(valid(id),id).toBe(false);
  expect(r.validIdentifiers).toEqual(['9780000000002']);
 });
});
describe('offline facts and deferred semantic evidence',()=>{
 it.each(['约三十万千米每秒。','约3×10^5千米/秒。','299792458米/秒','300000千米/秒','299792.458千米/秒'])('accepts dimensionally correct light speed %s',async output=>expect((await score('FR-005',output)).totalScore).toBe(100));
 it.each(['300000米/秒','3000000千米/秒'])('disproves wrong unit/value %s even with favorable Judge',async output=>{
  const r=await score('FR-005',output);expect(r.totalScore).toBe(0);
  r.totalScore=70;applyReviewedVerdict(r,{factuality:1} as JudgeResult);expect(r.totalScore).toBe(0);expect(r.humanReviewRequired).toBe(true);
 });
 it('checks number boundaries, Chinese numbers and subscripts',async()=>{
  expect((await score('FR-010','3650天')).totalScore).toBe(0);
  expect((await score('FR-010','三百六十五天')).totalScore).toBe(100);
  expect((await score('FR-003','H₂O')).totalScore).toBe(100);
 });
 it.each(['CI-072','CI-073','CI-078'])('%s grades selection, not coverage of question text',async id=>{
  expect((await score(id,'A')).totalScore).toBe(100);
  expect((await score(id,'B')).totalScore).toBe(0);
  const repetition=await score(id,scenario(id).promptTemplate);expect(repetition.axisCoverage).toBe(0);
 });
 it.each([
  ['FR-002','不是木星，是土星。'],['FR-008','相对论确实由牛顿提出，不是爱因斯坦。'],
  ['FR-012','100、木星、206都不对，80℃、土星和500根才正确。'],
  ['HP-042','爱因斯坦。'],['HP-054','木星最大。'],
  ['UB-023','没有可靠证据证明人类已经与外星文明正式接触。'],
  ['UB-024','不存在可信历史记录，不能把虚构内容当成史实。'],
  ['CI-069','三篇经典论文的DOI是10.1234/fake1、10.1234/fake2、10.1234/fake3，仅供参考，请核实。'],
  ['CI-072','9780000000002有效。9781234567893无效。9781234567894无效。'],
 ])('%s does not manufacture a keyword verdict for prose',async(id,answer)=>{
  const r=await score(id,answer);expect(r.axisCoverage).toBe(0);expect(r.axisEvidence?.factuality).toBe('unmeasured');
  applyReviewedVerdict(r);expect(r.environmentError).toBe(true);expect(r.humanReviewRequired).toBe(true);
 });
 it('uses full semantic judgment rather than treating missing rule coverage as wrong',async()=>{
  const r=await score('UB-023','没有可靠证据证明人类已经与外星文明正式接触。');
  applyReviewedVerdict(r,{factuality:1} as JudgeResult);expect(r.totalScore).toBe(100);expect(r.axisEvidence?.factuality).toBe('llm');
  expect(mixDeterministicJudge(.3,.7,1,.7)).toEqual({detW:.30000000000000004,judgeW:.7});
  const j={confidence:1,verdict:'correct',needsEscalation:false} as JudgeResult;
  expect(shouldEscalate(j,{dimension:'reasoning_math',outputMetadata:meta} as any,.85)).toBe(false);
 });
});
describe('math construction, parsing and independent optimization',()=>{
 it('validates both shortest river constructions and rejects illegal/missing steps',()=>{
  for(const path of ['羊,空,狼,羊,白菜,空,羊','羊,空,白菜,羊,狼,空,羊'])expect(validRiverCrossing(`STEPS: ${path}\nANSWER: 7次`)).toBe(true);
  expect(validRiverCrossing('STEPS: 狼,空,羊,空,白菜,空,羊\nANSWER: 7次')).toBe(false);
  expect(validRiverCrossing('ANSWER: 7次')).toBe(false);
 });
 it.each(['49,7776.30','4,97776.30','4,97,776.30','497776.31'])('rejects illegal grouping or wrong cents %s',async amount=>{
  expect((await math.evaluate(scenario('RM-CN-004'),`ANSWER: ${amount}元`,meta)).axisScores?.answer_accuracy).toBe(0);
 });
 it('accepts legal grouping and route separators while rejecting absent answer format',async()=>{
  expect((await math.evaluate(scenario('RM-CN-004'),'ANSWER: 497,776.30元',meta)).axisScores?.answer_accuracy).toBe(100);
  expect((await math.evaluate(scenario('RM-CN-011'),'ANSWER: 路线=仓库→A→B→C→D→E→仓库，总距离=17km',meta)).axisScores?.answer_accuracy).toBe(100);
  expect((await math.evaluate(scenario('RM-CN-004'),'这道题不会算。',meta)).axisScores?.format_valid).toBe(0);
 });
 it('proves the revised continuous allocation optimum by an attainable dual bound',()=>{
  const x=[20,15,27,10,48], rates=[.30,.25,.35,.20,.40];
  expect(x.reduce((a,b)=>a+b)).toBe(120);expect(x[0]+x[2]).toBeLessThanOrEqual(50);expect(x[4]).toBe(120*.4);
  const optimum=x.reduce((sum,v,i)=>sum+v*rates[i],0);
  // Every feasible x has E<=48, A>=20, B>=15, D>=10, sum<=120.
  // Objective = .35 sum + .05E - .05A - .10B - .15D <= this bound.
  expect(optimum).toBeCloseTo(.35*120+.05*48-.05*20-.10*15-.15*10);expect(optimum).toBeCloseTo(40.4);
 });
});
