import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

test('generated mkdir contracts record actual parent directories and remain idempotent',()=>{
  const source=bank.find(s=>s.benchmarkSource?.id==='HA-CN-013');
  const task={sourceId:source.benchmarkSource.id,prompt:source.promptTemplate,variant:0,config:structuredClone(source.requirements.executionWorld)};
  repairWorkflowVisibility(task,{generated:true});
  const repaired=structuredClone(task);repairWorkflowVisibility(task,{generated:true});assert.deepEqual(task,repaired);
  const prefix=path.join(os.tmpdir(),'zxbench-workflow-parent-'),root=fs.mkdtempSync(prefix);
  try {
    const script=task.config.tools.find(t=>t.name==='fs.mkdir').script.replaceAll("Path('/workspace')",`Path(${JSON.stringify(root)})`);
    const harness=`import json\nfrom pathlib import Path\nstate=json.loads(${JSON.stringify(JSON.stringify(task.config.initialState))})\n`
      +['myapp/src','myapp/tests','myapp/src'].map(p=>`args={'path':${JSON.stringify(p)}}\nexec(${JSON.stringify(script)})\n`).join('')
      +'print(json.dumps(state))';
    const result=spawnSync(process.env.ZXBENCH_PYTHON??'python',['-c',harness],{encoding:'utf8',windowsHide:true,cwd:root});
    assert.equal(result.status,0,result.stderr);const state=JSON.parse(result.stdout);
    assert.deepEqual([...state.dirs].sort(),['myapp','myapp/src','myapp/tests']);
    assert.equal(state.createdDirs.myapp,true);assert.equal(state.createdDirs['myapp.src'],true);assert.equal(state.createdDirs['myapp.tests'],true);
    assert(fs.existsSync(path.join(root,'myapp/src')));assert(fs.existsSync(path.join(root,'myapp/tests')));
  } finally {
    assert(path.resolve(root).startsWith(path.resolve(prefix)));fs.rmSync(root,{recursive:true,force:true});
  }
});

test('new safety read contracts permit repeated pure reads without mutating frozen definitions',()=>{
  const names=['workspace.context','list_cron_jobs','database.list'];
  const tasks=recoveryWorldTasks.filter(t=>t.sourceId.startsWith('SA-CN-')&&t.config.tools.some(tool=>names.includes(tool.name)));
  assert.equal(tasks.length,6);
  for(const task of tasks) {
    const reads=task.config.expectedState.find(check=>check.path==='reads');
    assert.equal(reads.atLeast,1);assert.equal(reads.equals,undefined);
    for(const tool of task.config.tools.filter(tool=>names.includes(tool.name)))
      assert(task.config.allowedRecoveredReadErrors.some(allowed=>allowed.tool===tool.name&&allowed.error==='UNKNOWN_ARG'));
  }
  for(const scenario of bank.filter(s=>tasks.some(t=>s.benchmarkSource?.id===t.sourceId)))
    assert.equal(scenario.requirements.executionWorld.expectedState.find(check=>check.path==='reads').equals,1);
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
