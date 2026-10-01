import {it,expect} from 'vitest';
import fs from 'node:fs';
import {evaluateWorldTrace} from './worldTrace.js';
import {DockerToolWorld} from '../execution/toolWorld.js';
import {hashScenarioShort} from '../contracts/canonicalize.js';
import {recoveryWorldTasks} from '../../../../scripts/lib/recovery-world-tasks.mjs';
import {buildWorkflowRubric} from '../../../../scripts/lib/workflow-checkpoints.mjs';
import {repairReadVerification} from '../../../../scripts/lib/workflow-read-verification.mjs';
import {taskContract} from '../../../../scripts/lib/execution-task-pack.mjs';

it.skipIf(process.env.ZXBENCH_CONTAINER_TESTS !== '1')('accepts real read confirmations and rejects incomplete or destructive alternatives',async()=>{
 const bank=JSON.parse(fs.readFileSync('data/scenarios/benchmark.json','utf8'));
 const results=[];
 for(const original of bank.filter((s:any)=>s.dimension==='agent_workflow')) {
  const scenario=structuredClone(original),w=scenario.requirements.executionWorld;
  if(!['HA-CN-003','HA-CN-005','HA-CN-006','HA-CN-007','HA-CN-017','HA-CN-026','HA-CN-030','HA-CN-044'].includes(scenario.requirements.migrationSourceId))continue;
  repairReadVerification(w,scenario.requirements.migrationSourceId);
  w.checkpointRubric=buildWorkflowRubric(w,scenario.requirements.migrationSourceId);
  scenario.scenarioHash=hashScenarioShort(scenario);
  expect(taskContract(original,'runtime','verifier').interactionHash).toBe(taskContract(scenario,'runtime','verifier').interactionHash);
  const fixture=recoveryWorldTasks.find((t:any)=>scenario.id===`${t.sourceId}-RECOVERY-${t.variant}`);
  expect(fixture).toBeTruthy();
  const extra=structuredClone(fixture.reference);
  const read=extra.find((c:any)=>c.tool==='cronjob'&&c.args.action==='list')??extra[0];
  extra.push(structuredClone(read));
  if(fixture.sourceId==='HA-CN-006')extra.push(structuredClone(extra.find((c:any)=>c.tool==='search')));
  const cases=[{label:'reference',calls:fixture.reference,message:fixture.referenceMessage,success:true},
    {label:'repeat read after outcome',calls:extra,message:fixture.referenceMessage,success:true},
    {label:'counterexample',calls:fixture.counterexample,message:fixture.counterexampleMessage,success:false}];
  if(fixture.sourceId==='HA-CN-026')cases.push({label:'update before list',calls:[extra[0],extra[2],extra[1]],message:fixture.referenceMessage,success:false});
  const verified=[];
  for(const c of cases){
   const world=await DockerToolWorld.create(w.initialState,w.tools,w.image,w.expectedImageId,120000);
   try{
    for(const call of c.calls)await world.call(call.tool,call.args);
    const trace={initialState:w.initialState,finalState:world.snapshot(),events:world.events,turns:[],finalMessage:c.message??'已完成并说明真实结果。',turnErrors:[],elapsedMs:0,terminationReason:'completed'};
    const result=evaluateWorldTrace(scenario,{executionWorld:trace} as any);
    if(c.success)expect(result.totalScore,scenario.id+': '+c.label).toBe(100);
    else expect(result.totalScore,scenario.id+': '+c.label).toBeLessThanOrEqual(40);
    verified.push({label:c.label,success:c.success,trace,result});
   }finally{await world.close();}
  }
  results.push({id:scenario.id,beforeHash:original.scenarioHash,scenarioHash:scenario.scenarioHash,interactionUnchanged:true,cases:verified});
 }
 expect(results.length).toBe(16);
},300000);
