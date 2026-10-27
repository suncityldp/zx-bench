import {it,expect,vi} from 'vitest';
import {inspectContainerState} from './inspectContainerState.js';
const normal={status:0,stdout:JSON.stringify({StartedAt:'2026-01-01',Error:''}),stderr:''};
it('shares total budget and bounds attempts',async()=>{
 let now=0;const exec=vi.fn(async(_c:any,_a:any,o:any)=>{now+=o.timeout;return {status:null,stdout:'',stderr:'',error:{code:'ETIMEDOUT'} as any};});
 const r=await inspectContainerState('only',8000,{exec,now:()=>now,sleep:async(ms)=>{now+=ms;}});
 expect(exec).toHaveBeenCalledTimes(1);expect(r.kind).toBe('timeout');expect(r.elapsedMs).toBe(8000);
});
it.each([false,true])('retries only queries and prioritizes recovered conflict=%s',async conflict=>{
 let now=0;const exec=vi.fn().mockResolvedValueOnce({status:0,stdout:'',stderr:''}).mockResolvedValue({...normal,stdout:JSON.stringify({StartedAt:'2026-01-01',Error:conflict?'denied':''})});
 const r=await inspectContainerState('only',8000,{exec,now:()=>now,sleep:async(ms)=>{now+=ms;}});
 expect(r.attempts).toBe(2);expect(r.available).toBe(!conflict);expect(exec.mock.calls[1][2].timeout).toBe(7900);expect(exec.mock.calls.every(c=>c[1][0]==='inspect')).toBe(true);
});
it.each([['','empty-output'],['bad','invalid-json'],['{}','invalid-state']])('classifies %s and bounds retries',async(stdout,kind)=>{
 let now=0;const exec=vi.fn().mockResolvedValue({status:0,stdout,stderr:''});
 const r=await inspectContainerState('only',8000,{exec,now:()=>now,sleep:async(ms)=>{now+=ms;}});
 expect(r.attempts).toBe(3);expect(r.kind).toBe(kind);expect(r.elapsedMs).toBe(350);
});
it.each([undefined,'',0,'0001-01-01'])('treats abnormal StartedAt as conflict without retry',async StartedAt=>{
 const exec=vi.fn().mockResolvedValue({status:0,stdout:JSON.stringify({Error:'',StartedAt}),stderr:''});
 const r=await inspectContainerState('only',8000,{exec,now:()=>0,sleep:async()=>{}});
 expect(r.kind).toBe('state-conflict');expect(r.attempts).toBe(1);
});
it.each([NaN,Infinity,-Infinity,-1,0])('does not start a query for invalid/exhausted budget %s',async budget=>{
 const exec=vi.fn();const r=await inspectContainerState('only',budget,{exec,now:()=>0,sleep:async()=>{}});
 expect(exec).not.toHaveBeenCalled();expect(r.kind).toBe('budget-exhausted');expect(r.budgetMs).toBe(0);
});
it('reports close latency honestly without launching another query',async()=>{
 let now=0;const exec=vi.fn(async()=>{now=8250;return {status:null,stdout:'',stderr:'',error:{code:'ETIMEDOUT'} as any};});
 const r=await inspectContainerState('only',8000,{exec,now:()=>now,sleep:async(ms)=>{now+=ms;}});
 expect(r.elapsedMs).toBe(8250);expect(r.budgetExceeded).toBe(true);expect(exec).toHaveBeenCalledTimes(1);
});
it('does not trust state text from a failed CLI query',async()=>{
 let now=0;const exec=vi.fn().mockResolvedValue({status:1,stdout:JSON.stringify({Error:'conflict',StartedAt:''}),stderr:''});
 const r=await inspectContainerState('only',8000,{exec,now:()=>now,sleep:async(ms)=>{now+=ms;}});
 expect(r.kind).toBe('nonzero-status');expect(r.attempts).toBe(3);
});
