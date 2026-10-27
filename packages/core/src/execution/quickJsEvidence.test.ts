import {it,expect} from 'vitest';
import {sufficientQuickJsV1Evidence as check} from './quickJsObservation.js';
const c={id:'one',calls:[[1]],expected:[{outcome:{kind:'return' as const,value:1}}]};
const report=(value:any)=>({protocol:'quickjs-observation-v1',status:'ok',observations:[{kind:'return',valueType:'json',value,sameArgument:[false],argumentsAfter:[1]}]});
it('accepts complete correct and wrong evidence independently of expected answer',()=>{for(const n of [1,2])expect(check(JSON.stringify(report(n)),c,'quickjs-observation-v1')).toBe(true);});
it('rejects malformed, missing, forged and cross-protocol records',()=>{
 const r=report(1);for(const x of ['', '{', JSON.stringify({...r,protocol:'other'}),JSON.stringify({...r,id:'foreign'}),JSON.stringify({...r,observations:[]}),JSON.stringify({...r,observations:[{...r.observations[0],sameArgument:['true']}]}),JSON.stringify({...r,observations:[{...r.observations[0],argumentsAfter:[]}]}),JSON.stringify({...r,observations:[{...r.observations[0],valueType:'forged'}]})])expect(check(x,c,'quickjs-observation-v1')).toBe(false);
 expect(check(JSON.stringify(r),c,'quickjs-observation-v2')).toBe(false);
});
it('keeps bootstrap and unknown errors closed but recognizes fixed candidate failures',()=>{
 for(const phase of ['bootstrap','unknown'])expect(check(JSON.stringify({protocol:'quickjs-observation-v1',phase,status:'imports_not_supported',observations:[]}),c,'quickjs-observation-v1')).toBe(false);
 expect(check(JSON.stringify({protocol:'quickjs-observation-v1',phase:'load',status:'imports_not_supported',observations:[]}),c,'quickjs-observation-v1')).toBe(true);
});
it.each([['load','engine_resource_error'],['call','entrypoint_not_function'],['bootstrap','execution_budget_exceeded'],['unknown','imports_not_supported']])('rejects impossible or unsupported phase %s/status %s', (phase,status)=>{
 expect(check(JSON.stringify({protocol:'quickjs-observation-v1',phase,status,observations:[]}),c,'quickjs-observation-v1')).toBe(false);
});
it('binds trusted ordered observations to host call arity without inventing output IDs',()=>{
 const ordered={...report(1),observations:[report(1).observations[0],{...report(2).observations[0],sameArgument:[false,false],argumentsAfter:[1,2]}]};
 const two={id:'host-bound',calls:[[1],[1,2]],expected:[...c.expected,...c.expected]};
 expect(check(JSON.stringify(ordered),two,'quickjs-observation-v1')).toBe(true);
 expect(check(JSON.stringify({...ordered,observations:[...ordered.observations].reverse()}),two,'quickjs-observation-v1')).toBe(false);
 expect(check(JSON.stringify({...ordered,observations:ordered.observations.concat(ordered.observations[0])}),two,'quickjs-observation-v1')).toBe(false);
});
