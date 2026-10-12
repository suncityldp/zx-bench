import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {writeRuntimeJson} from './lib/atomic-runtime-json.mjs';
test('concurrent runtime writers cannot expose partial JSON or collide on a shared temp file',async()=>{
  fs.mkdirSync('work/atomic-runtime-test',{recursive:true});const directory=fs.mkdtempSync('work/atomic-runtime-test/case-');const file=path.resolve(directory,'state.json');writeRuntimeJson(file,{writer:-1,text:'完整状态'});
  const module=new URL('./lib/atomic-runtime-json.mjs',import.meta.url).href;
  const code="const {writeRuntimeJson}=await import(process.argv[1]);for(let i=0;i<100;i++)writeRuntimeJson(process.argv[2],{writer:Number(process.argv[3]),iteration:i,text:'完整状态'});";
  const children=[0,1,2].map(i=>spawn(process.execPath,['--input-type=module','-e',code,module,file,String(i)],{windowsHide:true,stdio:['ignore','ignore','pipe']}));let done=false;const errors=[];children.forEach(c=>c.stderr.on('data',x=>errors.push(x.toString())));
  let failure;const all=Promise.all(children.map(c=>once(c,'exit').then(([exit])=>assert.equal(exit,0,errors.join(''))))).then(()=>done=true,error=>{failure=error;done=true;});
  // Yield between reads: Windows can deny replacement while a reader holds the
  // destination open. Test concurrent snapshots without monopolizing its handle.
  let reads=0;while(!done){const item=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(item.text,'完整状态');reads++;await new Promise(r=>setTimeout(r,2));}await all;if(failure)throw failure;assert(reads>0);assert.equal(fs.readdirSync(directory).filter(f=>f.includes('.tmp-')).length,0);
});
