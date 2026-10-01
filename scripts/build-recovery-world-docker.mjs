import fs from 'node:fs';
import { recoveryWorldTasks } from './lib/recovery-world-tasks.mjs';
import { hashScenarioShort } from '../packages/core/dist/contracts/canonicalize.js';
import { validateScenario } from '../packages/core/dist/contracts/validateScenario.js';
import { spawnSync } from 'node:child_process';
// Validate multilingual tool behavior before producing any candidate task pack.
const preflight=spawnSync(process.execPath,['--test','scripts/recovery-world-search.test.mjs'],{stdio:'inherit'});
if(preflight.status!==0) throw new Error('Recovery-world tool contract preflight failed');
const bank = JSON.parse(fs.readFileSync('data/scenarios/benchmark.json','utf8'));
const originalEasyMigration = new Set(['HA-CN-041','HA-CN-042','HA-CN-043',
  'SA-CN-001','SA-CN-026','SA-CN-032','TC-CN-001','TC-CN-005','TC-CN-009',
  'TC-CN-014','TC-CN-020','TC-CN-024']);
const tasks = recoveryWorldTasks.map(task=>{
  const source = bank.find(s=>s.id===task.sourceId);
  if (!source || !(['medium','hard','adversarial'].includes(source.difficulty)
    || (source.difficulty==='easy' && task.variant===0 && originalEasyMigration.has(source.id)))) {
    throw Error(`Not an approved original migration: ${task.sourceId}`);
  }
  const scenario = {...source,id:`${source.id}-RECOVERY-${task.variant}`,tier:'private_dev',status:'valid',
    ...(task.graderVersion?{grader:'agent_trace',graderVersion:task.graderVersion}:source.grader==='cli_command'?{grader:'agent_trace',graderVersion:'agent_trace_v5'}:{}),
    scenarioVersion:task.scenarioVersion??'3.0.0',reviewStatus:'unreviewed',responseMode:'live_execution',promptTemplate:task.prompt,
    requirements:{migrationSourceId:source.id,developmentShadow:true,executionWorld:{...task.config,
      image:task.image??'python:3.12-alpine',
      expectedImageId:task.imageId??'sha256:d09d15e60962ca365d1cd544a48773bac9d33f2fb1b00f2aa0deec78ade7dc31'}}};
  scenario.scenarioHash=hashScenarioShort(scenario);
  const errors=validateScenario(scenario).errors;
  if(errors.length) throw Error(JSON.stringify(errors));
  return scenario;
});
fs.writeFileSync('data/pilots/recovery-world-docker-v1.json',JSON.stringify(tasks,null,2)+'\n');
console.log(`Wrote ${tasks.length} recovery/authorization variants from ${new Set(tasks.map(t=>t.requirements.migrationSourceId)).size} source tasks`);
