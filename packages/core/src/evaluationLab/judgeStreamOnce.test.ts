import {describe,it,expect} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {judgeStreamOnce} from './judgeStreamOnce.js';
describe('one-shot Judge transport',()=>{
  it('preserves stream bytes and extracts a complete response without a retry',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'zxbench-judge-stream-'));let calls=0;
    const text='data: '+JSON.stringify({choices:[{index:0,delta:{content:'[]'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}})+'\n\ndata: [DONE]\n\n';
    try{const result=await judgeStreamOnce({endpoint:'https://example.invalid',key:'test-fixture',body:{},wireFile:join(dir,'wire'),stopFile:join(dir,'STOP'),timeoutMs:1000},async()=>{calls++;return new Response(text);});
      expect(calls).toBe(1);expect(result).toMatchObject({content:'[]',finishReason:'stop',streamDone:true,error:null});expect(readFileSync(join(dir,'wire'),'utf8')).toBe(text);
    }finally{rmSync(dir,{recursive:true});}
  });
  it('does not fabricate completion on EOF and does not retry HTTP failures',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'zxbench-judge-stream-'));let calls=0;
    try{const options={endpoint:'https://example.invalid',key:'test-fixture',body:{},wireFile:join(dir,'wire'),stopFile:join(dir,'STOP'),timeoutMs:1000};
      const eof=await judgeStreamOnce(options,async()=>{calls++;return new Response('data: {"choices":[{"delta":{"content":"[]"},"finish_reason":"stop"}]}\n');});
      expect(eof.streamDone).toBe(false);
      const failed=await judgeStreamOnce(options,async()=>{calls++;return new Response(null,{status:503});});expect(failed.error).toBe('HTTP_503');expect(calls).toBe(2);
    }finally{rmSync(dir,{recursive:true});}
  });
});
