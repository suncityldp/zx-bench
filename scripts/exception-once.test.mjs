import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {sendExceptionOnce} from './lib/exception-once.mjs';
const dir=()=>fs.mkdtempSync(path.join(os.tmpdir(),'zxbench-exception-test-'));
test('simultaneous senders emit one exception, and verified resume permits another',async()=>{
  const directory=dir();let calls=0;const send=async()=>{calls++;await new Promise(r=>setTimeout(r,20));return {sent:true};};
  const args={key:'run|resume1',directory,send};const results=await Promise.all([sendExceptionOnce(args),sendExceptionOnce(args)]);assert.equal(calls,1);assert(results.some(r=>r.duplicate));assert((await sendExceptionOnce(args)).duplicate);
  await sendExceptionOnce({...args,key:'run|resume2'});assert.equal(calls,2);
});
test('failed sender is retryable and a dead sender claim cannot suppress a future exception',async()=>{
  const directory=dir(),key='episode';await assert.rejects(sendExceptionOnce({directory,key,send:async()=>{throw Error('failure');}}));
  let calls=0;const send=async()=>{calls++;return {sent:true};};await sendExceptionOnce({directory,key,send});assert.equal(calls,1);
  const db=new DatabaseSync(path.join(directory,'notification-claims.sqlite'));db.prepare("UPDATE Claim SET state='pending',owner=987654321,at=? WHERE key=?").run(Date.now(),key);db.close();
  await sendExceptionOnce({directory,key,send,isAlive:()=>false});assert.equal(calls,2);
});
