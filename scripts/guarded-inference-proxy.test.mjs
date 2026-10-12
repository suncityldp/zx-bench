import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createGuardedInferenceProxy} from './lib/guarded-inference-proxy.mjs';

const delay=ms=>new Promise(r=>setTimeout(r,ms));
const event=x=>'data: '+JSON.stringify(x)+'\n\n';
async function fixture(t,{backend,prepare,timeout=1000,onFailure,record}={}){
  const sockets=new Set();let calls=0;const failures=[],records=[];
  const upstream=http.createServer((req,res)=>{calls++;backend?.(req,res)??res.end(event({choices:[{delta:{content:'OK'},finish_reason:'stop'}],usage:{completion_tokens:3},timings:{draft_n_accepted:2}})+'data: [DONE]\n\n');});
  upstream.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const plan={runId:'isolated-test',benchmarkStarted:true};
  const relay=createGuardedInferenceProxy({readPlan:()=>plan,authorize:r=>r.headers.authorization==='Bearer test-only',
    prepare:prepare??(async({body})=>({body,url:'http://127.0.0.1:'+upstream.address().port,headers:{},responseHeaders:{'x-zxbench-reasoning-budget-tokens':'98000'}})),
    health:async()=>({ok:true}),record:(type,value)=>{record?.(type,value);records.push({type,value});},
    onFailure:async incident=>{failures.push(incident);await onFailure?.(incident);},upstreamTimeoutMs:timeout});
  relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');const base='http://127.0.0.1:'+relay.server.address().port;
  const post=()=>fetch(base+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer test-only'},body:JSON.stringify({max_tokens:131072,reasoning_budget_tokens:98000})});
  t.after(async()=>{relay.server.closeAllConnections();for(const s of sockets)s.destroy();await Promise.all([new Promise(r=>relay.server.close(r)),new Promise(r=>upstream.close(r))]);});
  return {...relay,base,post,records,failures,sockets,calls:()=>calls};
}
test('successful SSE preserves budget attestation and usage, and releases the slot',async t=>{
  const f=await fixture(t);const r=await f.post();assert.equal(r.status,200);assert.equal(r.headers.get('x-zxbench-reasoning-budget-tokens'),'98000');assert.match(await r.text(),/\[DONE\]/);await delay(10);
  assert.equal(f.state().owner,null);assert.equal(f.failures.length,0);assert.equal(f.records[0].type,'completion');assert.equal(f.records[0].value.timings.draft_n_accepted,2);
  assert.equal((await f.post()).status,200);
});
test('caller cancellation leaves the proxy alive and does not create a backend failure',async t=>{
  const f=await fixture(t,{backend:(_req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(event({choices:[{delta:{reasoning_content:'thinking'}}]}));return true;}});
  const controller=new AbortController();const r=await fetch(f.base+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer test-only'},body:'{}',signal:controller.signal});const reader=r.body.getReader();await reader.read();controller.abort();await delay(50);
  assert.equal(f.state().owner,null);assert.equal(f.failures.length,0);assert.equal((await fetch(f.base+'/health')).status,200);assert(f.records.some(r=>r.type==='cancelled'));
});
test('abrupt upstream response closes admission immediately and emits only one failure',async t=>{
  const f=await fixture(t,{backend:(_req,res)=>{res.writeHead(200);res.write(event({choices:[{delta:{content:'partial'}}]}));setTimeout(()=>res.destroy(),15);return true;}});
  const r=await f.post();await assert.rejects(r.text());await delay(25);assert.equal(f.failures.length,1);assert(f.state().fault);assert.equal((await f.post()).status,503);assert.equal(f.calls(),1);assert.equal((await fetch(f.base+'/health')).status,503);assert(!f.records.some(r=>r.type==='completion'));
});
test('upstream connection reset and HTTP error cannot cascade to more questions',async t=>{
  for(const mode of ['reset','http']){
    const f=await fixture(t,{backend:(req,res)=>{if(mode==='reset')req.socket.destroy();else{res.writeHead(500);res.end('failure');}return true;}});
    assert.equal((await f.post()).status,502);await delay(15);assert.equal(f.failures.length,1);assert.equal((await f.post()).status,503);assert.equal(f.calls(),1);
  }
});
test('stalled upstream times out and pauses, while health remains responsive during preparation',async t=>{
  let unblock;const gate=new Promise(r=>{unblock=r;});
  const f=await fixture(t,{prepare:async({body})=>{await gate;return {body,url:'http://127.0.0.1:'+f.sockets.size};}});
  const pending=f.post();await delay(15);const start=Date.now();assert.equal((await fetch(f.base+'/health')).status,200);assert(Date.now()-start<150);unblock();assert.equal((await pending).status,502);
  const stalled=await fixture(t,{timeout:50,backend:()=>true});assert.equal((await stalled.post()).status,502);assert.equal(stalled.failures.length,1);assert.match(stalled.failures[0].error,/timed out/);
});
test('old preparation callback cannot release the lock owned by a later request',async t=>{
  const gates=[];let preparations=0;
  const f=await fixture(t,{prepare:async()=>{const n=preparations++;await new Promise(r=>gates[n]=r);throw Error('prepare '+n);}});
  const controller=new AbortController();const first=fetch(f.base+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer test-only'},body:'{}',signal:controller.signal}).catch(()=>{});await delay(20);controller.abort();await first;await delay(20);
  const second=f.post();await delay(20);const owner=f.state().owner;assert(owner);gates[0]();await delay(20);assert.equal(f.state().owner,owner);assert.equal((await f.post()).status,409);gates[1]();assert.equal((await second).status,502);
});
test('failure of the pause callback is captured without crashing the relay',async t=>{
  const f=await fixture(t,{backend:(req)=>{req.socket.destroy();return true;},onFailure:async()=>{throw Error('Pause API unavailable');}});
  assert.equal((await f.post()).status,502);await delay(20);assert(f.records.some(r=>r.type==='failure-handler'));assert.equal((await fetch(f.base+'/health')).status,503);
});
test('unauthorized requests neither occupy the slot nor interrupt a valid run',async t=>{
  const f=await fixture(t);assert.equal((await fetch(f.base+'/v1/chat/completions',{method:'POST',body:'{}'})).status,401);assert.equal(f.state().owner,null);assert.equal(f.failures.length,0);assert.equal((await f.post()).status,200);
});
test('audit write failure pauses further admission without an uncaught exception',async t=>{
  const f=await fixture(t,{record:type=>{if(type==='completion')throw Error('Disk unavailable');}});
  await (await f.post()).text();await delay(20);assert.equal(f.failures.length,1);assert.match(f.failures[0].error,/audit could not be saved/);assert.equal((await f.post()).status,503);
});
test('HTTP end without an SSE finish marker is an interruption, not a successful answer',async t=>{
  const f=await fixture(t,{backend:(_req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(event({choices:[{delta:{content:'partial'}}]}));setTimeout(()=>res.end(),20);return true;}});
  const r=await f.post();await assert.rejects(r.text());await delay(20);assert.equal(f.failures.length,1);assert.match(f.failures[0].error,/SSE ended/);assert(!f.records.some(r=>r.type==='completion'));
});
test('only explicit verified recovery reopens a failed gateway',async t=>{
  let first=true;const f=await fixture(t,{backend:(_req,res)=>{if(first){first=false;res.writeHead(500);res.end();return true;}res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(event({choices:[{delta:{content:'recovered'},finish_reason:'stop'}]}));return true;}});
  assert.equal((await f.post()).status,502);assert.equal((await f.post()).status,503);f.resetAfterVerifiedRecovery();const r=await f.post();assert.equal(r.status,200);assert.match(await r.text(),/recovered/);assert.equal(f.state().fault,null);
});
