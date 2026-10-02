// Re-execute the published synthetic evidence; never calls a model or live server.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {DockerToolWorld} from '../packages/core/dist/execution/toolWorld.js';
import {evaluateWorldTrace} from '../packages/core/dist/evaluators/worldTrace.js';
const bank=JSON.parse(fs.readFileSync(new URL('../data/scenarios/benchmark.json',import.meta.url),'utf8'));
const fixture=JSON.parse(fs.readFileSync(new URL('../packages/core/src/evaluators/fixtures/workflow/visible-contracts.json',import.meta.url),'utf8'));
const filter=process.argv.find(a=>a.startsWith('--scenario='))?.split('=')[1];
const cases=fixture.cases.filter(c=>!filter||c.id===filter);assert(cases.length,'No matching cases');
let passed=0;
for(const c of cases){
 const s=bank.find(s=>s.id===c.id);assert.equal(s.scenarioHash,c.scenarioHash);
 const w=s.requirements.executionWorld;
 const world=await DockerToolWorld.create(w.initialState,w.tools,w.image,w.expectedImageId,120000);
 try{
  for(const event of c.trace.events)await world.call(event.tool,event.args);
  const trace={...c.trace,initialState:w.initialState,finalState:world.snapshot(),events:world.events};
  assert.equal(evaluateWorldTrace(s,{executionWorld:trace}).totalScore,c.score,`${c.id}: ${c.label}`);
  passed++;console.log(`PASS ${passed}/${cases.length} ${c.id}: ${c.label}`);
 }finally{await world.close();}
}
console.log(JSON.stringify({status:'passed',cases:passed,newModelCalls:0}));
