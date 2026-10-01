import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import type {Scenario,ModelResponse} from '@zxbench/types';
import {DockerToolWorld} from '../execution/toolWorld.js';
import {evaluateWorldTrace} from './worldTrace.js';
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/tool/contract-checkpoints.json',import.meta.url),'utf8'));
describe('real Docker tool contract regressions',()=>{
 it.skipIf(process.env.ZXBENCH_CONTAINER_TESTS!=='1')('reexecutes accepted queries, recovery and safety counterexamples',async()=>{
  const prefix=process.env.ZXBENCH_CONTAINER_CASE_PREFIX;
  const cases=prefix?fixtures.cases.filter((c:{label:string})=>c.label.startsWith(prefix)):fixtures.cases;
  expect(cases.length).toBeGreaterThan(0);
  for(const c of cases){
   const s=fixtures.scenarios.find((s:Scenario)=>s.id===c.id),w=s.requirements.executionWorld;
   const world=await DockerToolWorld.create(w.initialState,w.tools,w.image,w.expectedImageId,120000);
   try{
    for(const e of c.trace.events)await world.call(e.tool,e.args);
    const trace={...c.trace,initialState:w.initialState,finalState:world.snapshot(),events:world.events};
    const result=evaluateWorldTrace(s,{executionWorld:trace} as unknown as ModelResponse);
    expect(result.totalScore,`${c.id}: ${c.label}`).toBe(c.score);
   }finally{await world.close();}
  }
 },240000);
});
