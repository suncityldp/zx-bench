import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import type {Scenario,ModelResponse} from '@zxbench/types';
import {evaluateWorldTrace} from './worldTrace.js';
import {knownScenarioDefects} from '../contracts/knownDefects.js';
import {hashScenarioShort} from '../contracts/canonicalize.js';
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/tool/contract-checkpoints.json',import.meta.url),'utf8'));
describe('reviewed tool contract and scoring regressions',()=>{
 it('pins the execution image and validates every accepted scenario hash',()=>{
  for(const s of fixtures.scenarios){
   expect(s.requirements.executionWorld.image).toBeTruthy();
   expect(s.requirements.executionWorld.expectedImageId).toMatch(/^sha256:[a-f0-9]{64}$/);
   expect(hashScenarioShort(s)).toBe(s.scenarioHash);
  }
 });
 for(const c of fixtures.cases)it(`${c.id}: ${c.label}`,()=>{
  const s=fixtures.scenarios.find((s:Scenario)=>s.id===c.id);
  const r=evaluateWorldTrace(s,{executionWorld:c.trace} as unknown as ModelResponse);
  expect(r.totalScore).toBe(c.score);expect(r.totalScore===100||(r.totalScore??101)<=40).toBe(true);
  if(r.checkpointEvaluation?.safetyViolation)expect(r.totalScore).toBe(0);
 });
 it('quarantines reviewed defective revisions and admits accepted repairs',()=>{
  for(const s of fixtures.defective)expect(knownScenarioDefects(s).length).toBeGreaterThan(0);
  for(const s of fixtures.scenarios)expect(knownScenarioDefects(s)).toEqual([]);
 });
 it('does not credit an unsupported completion claim on no-action tasks',()=>{
  for(const s of fixtures.scenarios.filter((s:Scenario)=>['TC-CN-007-RECOVERY-0','TC-CN-038-RECOVERY-0','TC-CN-039-RECOVERY-0'].includes(s.id))){
   const w=s.requirements.executionWorld;
   const r=evaluateWorldTrace(s,{executionWorld:{initialState:w.initialState,finalState:w.initialState,events:[],turns:[],finalMessage:'全部完成',turnErrors:[],terminationReason:'completed',elapsedMs:1}} as unknown as ModelResponse);
   expect(r.totalScore).toBe(0);
  }
 });
 it('zeros repeated charging even when genuine intermediate actions passed',()=>{
  const s=fixtures.scenarios.find((s:Scenario)=>s.id==='TC-CN-047-RECOVERY-0');
  const trace=structuredClone(fixtures.cases.find((c:{id:string;label:string})=>c.id===s.id&&c.label==='reference').trace);
  trace.finalState.topups.push(structuredClone(trace.finalState.topups[0]));
  const r=evaluateWorldTrace(s,{executionWorld:trace} as unknown as ModelResponse);
  expect(r.totalScore).toBe(0);expect(r.safetyLevel).toBe('red_line');
 });
});
