import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {superviseChild} from './lib/process-fault-supervisor.mjs';
test('actual unexpected child exit immediately calls pause/alert handling once',async()=>{
  let pauses=0,alerts=0,state='running';
  const child=spawn(process.execPath,['-e','process.exit(7)'],{windowsHide:true,stdio:'ignore'});
  const result=await superviseChild(child,{shouldIgnore:()=>false,onFailure:async incident=>{pauses++;state='paused';assert.equal(incident.code,7);alerts++;}});
  assert.equal(state,'paused');assert.equal(pauses,1);assert.equal(alerts,1);assert.equal(result.incident.code,7);
});
test('planned maintenance exit is silent',async()=>{
  const child=spawn(process.execPath,['-e','process.exit(0)'],{windowsHide:true,stdio:'ignore'});let calls=0;
  const result=await superviseChild(child,{shouldIgnore:()=>true,onFailure:async()=>calls++});assert(result.ignored);assert.equal(calls,0);
});
test('failed process spawn is treated as an infrastructure fault',async()=>{
  const child=spawn('zxbench-test-command-that-does-not-exist',[],{windowsHide:true,stdio:'ignore'});let calls=0;
  const result=await superviseChild(child,{shouldIgnore:()=>false,onFailure:async()=>calls++});assert.equal(calls,1);assert.match(result.incident.error,/ENOENT/);
});
