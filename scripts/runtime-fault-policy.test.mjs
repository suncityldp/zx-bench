import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeFault} from './lib/runtime-fault-policy.mjs';
const at='2026-10-12T13:00:00.000Z',later='2026-10-12T13:00:05.000Z';
const baseline=()=>({plan:{runId:'test',status:'running',resumedAt:at,monitoring:{guardIntervalMs:120000}},runStatus:'running',guard:{pid:1,at},guardStatus:{at,healthy:true},proxy:{pid:2},isAlive:()=>true,now:Date.parse(later)});
test('normal progress and normal completed reports are silent',()=>{
  assert.equal(runtimeFault(baseline()),null);const b=baseline();b.plan.reportExported=true;b.isAlive=()=>false;assert.equal(runtimeFault(b),null);
});
test('proxy and guard exits are actionable, including failed export after completion',()=>{
  for(const pid of [1,2]){const b=baseline();b.isAlive=n=>n!==pid;assert.match(runtimeFault(b).error,/exited/);}
  const b=baseline();b.plan.status='completed';b.isAlive=()=>false;assert.equal(runtimeFault(b).source,'report');
});
test('stale heartbeat and unexpected pauses are detected',()=>{
  const b=baseline();b.now+=180001;assert.match(runtimeFault(b).error,/stale/);b.now=Date.parse(later);b.runStatus='paused';assert.match(runtimeFault(b).error,/paused/);
});
test('watcher restart does not hide a failure recorded since the last verified resume',()=>{
  const b=baseline();b.proxyErrors=[{runId:'test',at:later,error:'Connection reset'}];b.now+=60000;assert.equal(runtimeFault(b).error,'Connection reset');
  b.plan.resumedAt='2026-10-12T13:02:00.000Z';assert.equal(runtimeFault(b),null);
});
test('old and foreign incidents are ignored, and planned maintenance is silent',()=>{
  const b=baseline();b.proxyErrors=[{runId:'foreign',at:later,error:'wrong run'},{runId:'test',at:'2026-10-12T12:00:00Z',error:'old'}];assert.equal(runtimeFault(b),null);
  b.plan.recoveryInProgress=true;b.isAlive=()=>false;b.runStatus='paused';assert.equal(runtimeFault(b),null);
});
test('resume terminal snapshots are rechecked within a bounded transition, while persistent failures stay actionable',()=>{
  const b=baseline();b.runStatus='cancelled';assert.equal(runtimeFault(b),null);b.now=Date.parse(at)+15001;assert.match(runtimeFault(b).error,/cancelled/);
  b.now=Date.parse(at)+1000;b.isAlive=pid=>pid!==2;assert.match(runtimeFault(b).error,/proxy process exited/);
});
