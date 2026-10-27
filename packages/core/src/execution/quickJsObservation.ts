/** Trusted observation backend, not an independently registered scorer.
 * Only the versioned code_repair adapter grants formal scoring authority.
 * Every case gets a fresh container+WASM runtime; calls in a case share a module.
 * Expectations and IDs never enter the candidate or observer container. */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';
import type { TestDetail } from '@zxbench/types';
import { runInContainer, type ContainerRunOptions } from './containerRunner.js';
import { QUICKJS_OBSERVER_DRIVER } from './quickJsObserverDriver.js';
import type { JsonValue } from './isolatedJson.js';
// Resolved from the locally verified Node image; execution never pulls it.
export const QUICKJS_RUNTIME_IMAGE='node@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293';

export type QuickJsProtocol = 'quickjs-observation-v1' | 'quickjs-observation-v2';
export interface StringObservationMatch { equals?: string; includes?: string[]; excludes?: string[]; }
export interface QuickJsExpected {
  outcome: { kind: 'return'; value?: JsonValue; valueAt?: {path:(string|number)[];value:JsonValue}[]; stringMatch?: StringObservationMatch }
    | { kind: 'throw'; errorType?: string; message?: StringObservationMatch };
  argumentsAfter?: JsonValue[];
  argumentChecks?: {index:number;value:JsonValue}[];
  sameArgument?: { index: number; same: boolean }[];
}
export interface QuickJsObservationCase { id: string; calls: JsonValue[][]; expected: QuickJsExpected[]; }
export interface QuickJsObservationContract { protocol: QuickJsProtocol; entrypoint: string; cases: QuickJsObservationCase[]; }
const own=(v:object,k:PropertyKey)=>Object.hasOwn(v,k);
const record=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
export function validStringObservationMatch(v:unknown):v is StringObservationMatch {
  if(!record(v)||!Object.keys(v).length||Object.keys(v).some(k=>!['equals','includes','excludes'].includes(k)))return false;
  if(own(v,'equals')&&(typeof v.equals!=='string'||v.equals.length>8192))return false;
  for(const key of ['includes','excludes'])if(own(v,key)&&(!Array.isArray(v[key])||!v[key].length||v[key].length>32
    ||!v[key].every((x:unknown)=>typeof x==='string'&&x.length>0&&x.length<=8192)))return false;
  return Buffer.byteLength(JSON.stringify(v))<=32768;
}
export function matchesObservationString(value:unknown,match:StringObservationMatch):boolean {
  return typeof value==='string'&&(!own(match,'equals')||value===match.equals)
    &&(!match.includes||match.includes.every(s=>value.includes(s)))&&(!match.excludes||match.excludes.every(s=>!value.includes(s)));
}
/** Validate BEFORE serialization: JSON.stringify is lossy for these values. */
export function validObservationJson(value:unknown):value is JsonValue {
  let count=0;const seen=new Set<object>();
  const visit=(v:unknown,depth:number):boolean=>{
    if(++count>10000||depth>32)return false;
    if(v===null||typeof v==='boolean'||typeof v==='string')return true;
    if(typeof v==='number')return Number.isFinite(v)&&!Object.is(v,-0);
    if(!v||typeof v!=='object'||seen.has(v)||(!Array.isArray(v)&&!record(v)))return false;
    seen.add(v);
    const keys=Reflect.ownKeys(v);
    if(Array.isArray(v)&&keys.length!==v.length+1)return false;
    for(const k of keys){
      if(Array.isArray(v)&&k==='length')continue;
      if(typeof k!=='string')return false;
      if(Array.isArray(v)&&(!/^(0|[1-9][0-9]*)$/.test(k)||Number(k)>=v.length))return false;
      const d=Object.getOwnPropertyDescriptor(v,k)!;
      if(!own(d,'value')||!d.enumerable||!visit(d.value,depth+1))return false;
    }
    seen.delete(v);return true;
  };
  try {return visit(value,0)&&Buffer.byteLength(JSON.stringify(value))<=262144;} catch{return false;}
}
export function validQuickJsObservationContract(value:unknown):value is QuickJsObservationContract {
  if(!record(value)||!['quickjs-observation-v1','quickjs-observation-v2'].includes(value.protocol)||typeof value.entrypoint!=='string'||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.entrypoint)
    ||!Array.isArray(value.cases)||!value.cases.length||value.cases.length>100)return false;
  const ids=new Set<string>();
  return value.cases.every((c:unknown)=>{
    if(!record(c)||typeof c.id!=='string'||!c.id.trim()||ids.has(c.id)||!Array.isArray(c.calls)||!c.calls.length||c.calls.length>100
      ||!c.calls.every((a:unknown)=>Array.isArray(a)&&validObservationJson(a))||Buffer.byteLength(JSON.stringify(c.calls))>262144
      ||!Array.isArray(c.expected)||c.expected.length!==c.calls.length)return false;
    ids.add(c.id);
    return c.expected.every((e:unknown,i:number)=>{
      if(!record(e)||!record(e.outcome))return false;
      const n=c.calls[i].length,o=e.outcome;
      const checks=(x:unknown,test:(v:Record<string,any>)=>boolean)=>Array.isArray(x)&&x.every(v=>record(v)&&test(v));
      const index=(v:Record<string,any>)=>Number.isInteger(v.index)&&v.index>=0&&v.index<n;
      if(value.protocol==='quickjs-observation-v1'&&(own(o,'message')||own(o,'stringMatch')))return false;
      if(o.kind==='return'){
        if(own(o,'errorType')||own(o,'message')||(own(o,'value')&&!validObservationJson(o.value))
          ||(own(o,'stringMatch')&&!validStringObservationMatch(o.stringMatch)))return false;
        if(own(o,'valueAt')&&!checks(o.valueAt,v=>Array.isArray(v.path)&&v.path.length<=32
          &&v.path.every((p:unknown)=>typeof p==='string'||(typeof p==='number'&&Number.isSafeInteger(p)&&p>=0))&&validObservationJson(v.value)))return false;
      } else if(o.kind==='throw'){
        if(own(o,'value')||own(o,'valueAt')||own(o,'stringMatch')||own(e,'sameArgument')
          ||(own(o,'message')&&!validStringObservationMatch(o.message))
          ||(own(o,'errorType')&&!['RangeError','TypeError','ReferenceError','SyntaxError','URIError','EvalError','Error','ThrownValue'].includes(o.errorType)))return false;
      } else return false;
      if(own(e,'argumentsAfter')&&(!Array.isArray(e.argumentsAfter)||e.argumentsAfter.length!==n||!validObservationJson(e.argumentsAfter)))return false;
      if(own(e,'argumentChecks')&&!checks(e.argumentChecks,v=>index(v)&&validObservationJson(v.value)))return false;
      if(own(e,'sameArgument')&&!checks(e.sameArgument,v=>index(v)&&typeof v.same==='boolean'))return false;
      return true;
    });
  });
}
export function quickJsObservationOptions(code: string, language: 'javascript'|'typescript', entrypoint: string,
  calls: JsonValue[][], budgetMs = 1000, protocol:QuickJsProtocol='quickjs-observation-v1'): ContainerRunOptions {
  if(!['quickjs-observation-v1','quickjs-observation-v2'].includes(protocol))throw Error('Unsupported observation protocol');
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entrypoint)||!['javascript','typescript'].includes(language))throw Error('Unsupported observation interface');
  if(!Number.isInteger(budgetMs)||budgetMs<10||budgetMs>3000)throw Error('Invalid observation budget');
  if(typeof code!=='string'||Buffer.byteLength(code)>262144||!Array.isArray(calls)||!calls.length||calls.length>100
    ||!calls.every(a=>Array.isArray(a)&&validObservationJson(a))||Buffer.byteLength(JSON.stringify(calls))>262144)throw Error('Invalid observation input');
  const require=createRequire(import.meta.url);
  const core=dirname(dirname(require.resolve('quickjs-emscripten-core')));
  const variant=dirname(require.resolve('@jitl/quickjs-wasmfile-release-sync/package.json'));
  const ffi=dirname(dirname(createRequire(join(core,'package.json')).resolve('@jitl/quickjs-ffi-types')));
  const source=language==='typescript'?ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText:code;
  return { image:QUICKJS_RUNTIME_IMAGE,command:['node','observer.mjs'],
    files:[{path:'observer.mjs',content:QUICKJS_OBSERVER_DRIVER},{path:'candidate.js',content:source+`\nexport { ${entrypoint} as zxEntry };\n`},
      {path:'input.json',content:JSON.stringify({calls,budgetMs,...(protocol==='quickjs-observation-v2'?{protocol}:{})})}],
    mounts:[['quickjs-emscripten-core',core],['@jitl/quickjs-wasmfile-release-sync',variant],['@jitl/quickjs-ffi-types',ffi]]
      .map(([name,path])=>({src:realpathSync(path),dst:'/opt/zx-observer/node_modules/'+name,readonly:true})),
    localImageOnly:true,readOnlyRoot:true,readOnly:true,networkDisabled:true,runAsNonRoot:true,
    memoryMb:192,cpuLimit:1,pidsLimit:32,timeoutMs:budgetMs+3000,maxOutputBytes:65536,
  };
}

export function compareQuickJsObservations(stdout: string, expected: QuickJsExpected[], protocol:QuickJsProtocol='quickjs-observation-v1'): boolean {
  if(Buffer.byteLength(stdout)>65536)return false;
  try {
    const r=JSON.parse(stdout);
    if(r.protocol!==protocol||r.status!=='ok'||!Array.isArray(r.observations)||r.observations.length!==expected.length)return false;
    return expected.every((e,i)=>{
      const o=r.observations[i];
      if(protocol==='quickjs-observation-v1'&&('message' in e.outcome||'stringMatch' in e.outcome))return false;
      if(o?.kind!==e.outcome.kind || !Array.isArray(o.argumentsAfter))return false;
      if(e.outcome.kind==='return'){
        if(!Array.isArray(o.sameArgument)||!o.sameArgument.every((v:unknown)=>typeof v==='boolean'))return false;
        if('value' in e.outcome&&(o.valueType!=='json'||!isDeepStrictEqual(o.value,e.outcome.value)))return false;
        if(e.outcome.stringMatch&&(o.valueType!=='json'||!matchesObservationString(o.value,e.outcome.stringMatch)))return false;
        if(e.outcome.valueAt&&!e.outcome.valueAt.every(p=>{
          let v=o.value;
          for(const key of p.path){if(v===null||typeof v!=='object'||!Object.hasOwn(v,key))return false;v=v[key];}
          return o.valueType==='json'&&isDeepStrictEqual(v,p.value);
        }))return false;
      }
      if(e.outcome.kind==='throw'&&e.outcome.errorType!==undefined&&o.errorType!==e.outcome.errorType)return false;
      if(e.outcome.kind==='throw'&&e.outcome.message&&(o.message?.kind!=='string'||!matchesObservationString(o.message.value,e.outcome.message)))return false;
      if(e.argumentsAfter!==undefined&&!isDeepStrictEqual(o.argumentsAfter,e.argumentsAfter))return false;
      if(e.argumentChecks&&!e.argumentChecks.every(a=>Object.hasOwn(o.argumentsAfter,a.index)&&isDeepStrictEqual(o.argumentsAfter[a.index],a.value)))return false;
      return !e.sameArgument || (o.kind==='return'&&e.sameArgument.every(s=>Number.isInteger(s.index)&&s.index>=0&&o.sameArgument[s.index]===s.same));
    });
  } catch {return false;}
}

/** Only v1 complete observer records are eligible; IDs stay host-bound to this invocation. */
export function sufficientQuickJsV1Evidence(stdout:string,c:QuickJsObservationCase,protocol:QuickJsProtocol):boolean {
 if(protocol!=='quickjs-observation-v1'||Buffer.byteLength(stdout)>65536)return false;
 const keys=(o:Record<string,any>,allowed:string[])=>Object.keys(o).every(k=>allowed.includes(k));
 try {
  const r=JSON.parse(stdout);if(!record(r)||r.protocol!==protocol||!Array.isArray(r.observations))return false;
  if(r.status!=='ok')return keys(r,['protocol','status','phase','observations'])&&r.observations.length===0&&(
    (r.phase===undefined&&['candidate_load_error','execution_budget_exceeded'].includes(r.status))||
    (r.phase==='load'&&['execution_budget_exceeded','entrypoint_not_function','async_not_supported','imports_not_supported'].includes(r.status))||
    (r.phase==='call'&&['execution_budget_exceeded','engine_resource_error','async_not_supported','imports_not_supported'].includes(r.status)));
  if(!keys(r,['protocol','status','observations'])||r.observations.length!==c.calls.length)return false;
  return r.observations.every((o:unknown,i:number)=>{
   if(!record(o)||!Array.isArray(o.argumentsAfter)||o.argumentsAfter.length!==c.calls[i].length||!validObservationJson(o.argumentsAfter))return false;
   if(o.kind==='throw')return keys(o,['kind','errorType','argumentsAfter'])&&['RangeError','TypeError','ReferenceError','SyntaxError','URIError','EvalError','Error','ThrownValue'].includes(o.errorType);
   return o.kind==='return'&&keys(o,['kind','sameArgument','valueType','value','argumentsAfter'])&&Array.isArray(o.sameArgument)&&o.sameArgument.length===c.calls[i].length&&o.sameArgument.every((v:unknown)=>typeof v==='boolean')&&(
    (o.valueType==='undefined'&&!own(o,'value'))||(o.valueType==='json'&&own(o,'value')&&validObservationJson(o.value)));
  });
 }catch{return false;}
}

export async function runQuickJsObservationSuite(code:string,language:'javascript'|'typescript',contract:QuickJsObservationContract) {
  if(!validQuickJsObservationContract(contract))throw Error('Invalid observation contract');
  const details=[];
  for(const c of contract.cases){
    if(!Array.isArray(c.calls)||!c.calls.length||c.calls.length>100||c.calls.length!==c.expected.length)throw Error('Invalid observation case');
    const r=await runInContainer(quickJsObservationOptions(code,language,contract.entrypoint,c.calls,1000,contract.protocol));
    // Explicit adapter-only degradation: never syntax, execution errors or conflicting state.
    if(r.inspectQueryFailure && r.infrastructureError && r.exitCode===0 && !r.executionError && !r.timedOut && !r.outputLimitExceeded && sufficientQuickJsV1Evidence(r.stdout,c,contract.protocol)) {
      r.infrastructureError=undefined;r.success=true;
    }
    // This channel belongs to the independent observer, not the candidate.
    // A failed self-check before candidate load cannot count as model failure.
    if(r.success&&!r.timedOut&&!r.outputLimitExceeded&&!r.infrastructureError){
      try {
        const report=JSON.parse(r.stdout);
        if(report.protocol===contract.protocol&&report.phase==='bootstrap'&&report.status!=='ok'){
          r.infrastructureError='Trusted QuickJS observer initialization failed';
        }
      } catch { /* An absent report alone does not prove infrastructure failure. */ }
    }
    details.push({id:c.id,...r,passed:r.success&&!r.timedOut&&!r.infrastructureError&&!r.outputLimitExceeded&&compareQuickJsObservations(r.stdout,c.expected,contract.protocol)});
    if(r.infrastructureError)break;
  }
  return {protocol:contract.protocol,details,total:contract.cases.length,passed:details.filter(d=>d.passed).length,
    infrastructureError:details.find(d=>d.infrastructureError)?.infrastructureError};
}

/** Official adapter adds a separate non-executing Node module syntax check.
 * The QuickJS observation contract remains synchronous and does not certify TS
 * types, general Node APIs, or complete language/runtime compatibility. */
export async function runQuickJsScoringSuite(code:string,language:'javascript'|'typescript',contract:QuickJsObservationContract) {
  if(!validQuickJsObservationContract(contract))throw Error('Invalid observation contract');
  if(Buffer.byteLength(code)>262144)return {compiled:false,compileError:'Candidate source exceeds observer byte limit',infrastructureError:undefined,
    details:contract.cases.map(c=>({testId:c.id,testType:'hidden' as const,passed:false,exitCode:1,stderr:'Candidate source limit exceeded'})),total:contract.cases.length,passed:0};
  let options:ContainerRunOptions;
  try {options=quickJsObservationOptions(code,language,contract.entrypoint,contract.cases[0].calls,1000,contract.protocol);}
  catch(e){
    if((e as NodeJS.ErrnoException)?.code!=='MODULE_NOT_FOUND'&&(e as NodeJS.ErrnoException)?.code!=='ENOENT')throw e;
    return {compiled:false,compileError:undefined,infrastructureError:'Pinned QuickJS observer dependency unavailable',details:[] as TestDetail[],total:contract.cases.length,passed:0};
  }
  const syntax=await runInContainer({...options,mounts:[],command:['node','--check','syntax.mjs'],
    files:[{path:'syntax.mjs',content:options.files!.find(f=>f.path==='candidate.js')!.content}]});
  let infrastructureError=syntax.infrastructureError;
  const details:TestDetail[]=[];
  if(infrastructureError)details.push({testId:'syntax',testType:'infrastructure',passed:false,
    error:JSON.stringify({phase:'syntax',...syntax.infrastructureEvidence,inspect:syntax.inspectDiagnostics})});
  if(!infrastructureError){
    const observations=syntax.success?await runQuickJsObservationSuite(code,language,contract):undefined;
    infrastructureError=observations?.infrastructureError;
    for(const [i,c] of contract.cases.entries()){
      const r=observations?.details[i]??syntax;
      if(!r)break;
      if(r.infrastructureError){
        details.push({testId:c.id,testType:'infrastructure',passed:false,
          error:JSON.stringify({phase:'observation',...r.infrastructureEvidence,inspect:r.inspectDiagnostics})});
        break;
      }
      details.push({testId:c.id,testType:'hidden',passed:observations?.details[i]?.passed??false,
        error:r.inspectQueryFailure?JSON.stringify({status:'degraded-observer-evidence',phase:'observation',inspect:r.inspectDiagnostics}):undefined,stdout:r.stdout,stderr:r.stderr,actualOutput:r.stdout,exitCode:r.exitCode,timedOut:r.timedOut,duration:r.durationMs});
    }
  }
  return {compiled:syntax.success,compileError:syntax.success?undefined:syntax.stderr,infrastructureError,details,total:contract.cases.length,passed:details.filter(d=>d.passed).length};
}
