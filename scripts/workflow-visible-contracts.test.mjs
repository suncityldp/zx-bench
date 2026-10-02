import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {repairWorkflowVisibility} from './lib/workflow-visible-contracts.mjs';
import {buildWorkflowRubric} from './lib/workflow-checkpoints.mjs';
import {recoveryWorldTasks} from './lib/recovery-world-tasks.mjs';
const bank=JSON.parse(fs.readFileSync(new URL('../data/scenarios/benchmark.json',import.meta.url),'utf8'));

test('published workflow repairs are idempotent, including normalized path evidence',()=>{
  for(const s of bank.filter(s=>s.dimension==='agent_workflow')) {
    const task={sourceId:s.benchmarkSource.id,prompt:s.promptTemplate,variant:Number(s.id.split('-').at(-1)),config:structuredClone(s.requirements.executionWorld)};
    const original=structuredClone(task);repairWorkflowVisibility(task);assert.deepEqual(task,original,s.id);
  }
});
test('workflow outcomes keep their own evidence and required actions still gate completion',()=>{
  for(const s of bank.filter(s=>s.dimension==='agent_workflow')) {
    const w=s.requirements.executionWorld,r=buildWorkflowRubric(structuredClone(w),s.benchmarkSource.id);
    assert.deepEqual(r,w.checkpointRubric,s.id);
    for(const outcome of r.checkpoints.filter(c=>c.id.startsWith('outcome_')))assert.equal(outcome.dependsOn,undefined,s.id);
    assert(r.checkpoints.at(-1).all.includes('world_required_0'),s.id);
  }
});
test('shared builder does not silently amend the tool-call dimension',()=>{
  for(const task of recoveryWorldTasks.filter(t=>t.sourceId.startsWith('TC-CN-')))for(const outcome of task.config.checkpointRubric.checkpoints.filter(c=>c.id.startsWith('outcome_')))
    assert.deepEqual(outcome.dependsOn,['action_0'],task.sourceId);
});
