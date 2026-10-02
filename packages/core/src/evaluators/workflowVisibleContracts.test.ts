import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import type {Scenario,ModelResponse} from '@zxbench/types';
import {evaluateWorldTrace} from './worldTrace.js';

const bank=JSON.parse(readFileSync(new URL('../../../../data/scenarios/benchmark.json',import.meta.url),'utf8')) as Scenario[];
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/workflow/visible-contracts.json',import.meta.url),'utf8'));
describe('published workflow visibility and equivalent-input regression',()=>{
 it('replays all 216 synthetic Docker traces against their frozen published contracts',()=>{
  expect(fixtures.cases).toHaveLength(216);
  for(const c of fixtures.cases){
   const s=bank.find(s=>s.id===c.id)!;
   expect(s.scenarioHash,c.id).toBe(c.scenarioHash);
   expect(evaluateWorldTrace(s,{executionWorld:c.trace} as ModelResponse).totalScore,`${c.id}: ${c.label}`).toBe(c.score);
  }
 });
 it('does not award credit to a completion claim without actual work on any of the 87 tasks',()=>{
  const workflow=bank.filter(s=>s.dimension==='agent_workflow');expect(workflow).toHaveLength(87);
  for(const s of workflow){
   const w=s.requirements.executionWorld!;
   const trace={initialState:w.initialState,finalState:w.initialState,events:[],turns:[],finalMessage:'任务已完成。',turnErrors:[],elapsedMs:0,terminationReason:'completed'};
   expect(evaluateWorldTrace(s,{executionWorld:trace} as ModelResponse).totalScore,s.id).toBe(0);
  }
 });
});
