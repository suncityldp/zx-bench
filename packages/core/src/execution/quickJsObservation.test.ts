import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {QUICKJS_OBSERVATION_PILOTS} from '../evaluationLab/quickJsObservationGold.js';
import {validObservationJson,validQuickJsObservationContract,quickJsObservationOptions,runQuickJsObservationSuite,runQuickJsScoringSuite,compareQuickJsObservations} from './quickJsObservation.js';
import {runInContainer} from './containerRunner.js';
vi.mock('./containerRunner.js',()=>({runInContainer:vi.fn(),CONTAINER_IMAGES:{javascript:'node:20-alpine'}}));
it('binds every migrated observation contract to original test IDs and discloses the restricted runtime',()=>{
  const bank=JSON.parse(readFileSync('data/scenarios/benchmark.json','utf8'));
  for(const [id,pilot] of Object.entries(QUICKJS_OBSERVATION_PILOTS)){
    const s=bank.find((s:any)=>s.id===id);
    expect(s.requirements.quickJsObservation,id).toEqual(pilot.contract);
    expect(pilot.contract.cases.map(c=>c.id),id).toEqual(s.hiddenTests.map((t:any)=>t.id));
    expect(s.promptTemplate,id).toContain(`执行环境契约（${pilot.contract.protocol}）`);
    expect(s.promptTemplate,id).toContain('无模块导入');
    expect(s.promptTemplate,id).toContain('WASM内存32MB');
    expect(s.requirements.isolatedJson,id).toBeUndefined();
  }
});
const contract=()=>({protocol:'quickjs-observation-v1' as const,entrypoint:'target',cases:[{id:'only',calls:[[[1,2]]],expected:[{outcome:{kind:'return' as const,value:[1,2]},sameArgument:[{index:0,same:true}]}]}]});
it.each(['syntax','observation'])('retains trusted failure evidence for %s without candidate output',async(phase)=>{
  vi.mocked(runInContainer).mockReset();
  const failure={success:false,stdout:'secret candidate text',stderr:'sensitive path',exitCode:125,timedOut:false,durationMs:1,
    infrastructureError:'Container control-plane state unavailable',
    infrastructureEvidence:{stage:'inspect' as const,runStatus:125,inspectStatus:1,reason:'invalid-state' as const,dockerError:'container-missing'}};
  if(phase==='observation')vi.mocked(runInContainer).mockResolvedValueOnce({...failure,success:true,exitCode:0,infrastructureError:undefined});
  vi.mocked(runInContainer).mockResolvedValueOnce(failure);
  const result=await runQuickJsScoringSuite('function target(a){return a}','javascript',contract());
  expect(result.infrastructureError).toBe(failure.infrastructureError);
  expect(JSON.parse(result.details[0].error!)).toMatchObject({phase,runStatus:125,inspectStatus:1});
  expect(JSON.stringify(result.details)).not.toMatch(/secret|sensitive/);
  expect(runInContainer).toHaveBeenCalledTimes(phase==='syntax'?1:2);
  vi.mocked(runInContainer).mockReset();
});
it('rejects lossy or executable JSON before starting any container',async()=>{
  const cycle:any={};cycle.self=cycle;
  for(const v of [NaN,Infinity,-0,undefined,()=>0,new Date(),cycle,[,1],{get x(){throw Error('getter must not execute')}},Object.assign([1],{x:2})]){
    expect(validObservationJson(v)).toBe(false);
    const c=contract();c.cases[0].calls=[[v as any]];
    await expect(runQuickJsObservationSuite('function target(){}','javascript',c)).rejects.toThrow('Invalid observation contract');
  }
  expect(runInContainer).not.toHaveBeenCalled();
  expect(validObservationJson({'__safe':['nul\0tail','\ud800',true,0,null]})).toBe(true);
});
it('validates every case, index and mutually exclusive outcome field upfront',()=>{
  expect(validQuickJsObservationContract(contract())).toBe(true);
  const changes=[(c:any)=>c.cases.push(c.cases[0]),(c:any)=>c.cases[0].id='',(c:any)=>c.cases[0].expected[0].sameArgument[0].index=1,
    (c:any)=>c.cases[0].expected[0].sameArgument[0].same=1,(c:any)=>c.cases[0].expected[0].outcome.errorType='Error',
    (c:any)=>c.cases[0].expected[0].outcome={kind:'throw',errorType:'InternalError'},(c:any)=>c.cases[0].expected=[]];
  for(const change of changes){const c=contract();change(c);expect(validQuickJsObservationContract(c)).toBe(false);}
});
it('never materializes expected answers, IDs, full bank or project mounts',()=>{
  const o=quickJsObservationOptions('function target(a){return a}','javascript','target',[[123]]);
  expect(o.files!.map(f=>f.path)).toEqual(['observer.mjs','candidate.js','input.json']);
  expect(JSON.parse(o.files![2].content)).toEqual({calls:[[123]],budgetMs:1000});
  expect(o.mounts).toHaveLength(3);
  expect(o.mounts!.every(m=>m.readonly&&m.dst.startsWith('/opt/zx-observer/node_modules/'))).toBe(true);
  expect(o.readOnlyRoot&&o.networkDisabled&&o.runAsNonRoot&&o.localImageOnly).toBe(true);
  expect(o.files![0].content).not.toContain('executePendingJobs(');
  expect(o.files![0].content).not.toContain('.dump(');
});
it('compares exact typed data and real identity/exception observations, never status-only',()=>{
  const expected=contract().cases[0].expected;
  const r={protocol:'quickjs-observation-v1',status:'ok',observations:[{kind:'return',valueType:'json',value:[1,2],argumentsAfter:[[1,2]],sameArgument:[true]}]};
  expect(compareQuickJsObservations(JSON.stringify(r),expected)).toBe(true);
  for(const bad of [{...r,status:'engine_resource_error'},{...r,observations:[]},{...r,observations:[{...r.observations[0],sameArgument:[1]}]},
    {...r,observations:[{...r.observations[0],value:['1',2]}]}, {passed:true,score:100}])expect(compareQuickJsObservations(JSON.stringify(bad),expected)).toBe(false);
});
it('preserves partial assertions without silently requiring an Array or unasserted fields',()=>{
  const expected=QUICKJS_OBSERVATION_PILOTS['CP-L3-AW-JS-005'].contract.cases[0].expected;
  for(const value of [[{role:'system'},{text:'b'}],{'0':{role:'system'},'1':{text:'b'},length:2}]){
    const report={protocol:'quickjs-observation-v1',status:'ok',observations:[{
      kind:'return',valueType:'json',value,argumentsAfter:[],sameArgument:[],
    }]};
    expect(compareQuickJsObservations(JSON.stringify(report),expected)).toBe(true);
  }
});
it('keeps observer initialization failures unmeasured, but not candidate-phase rejections',async()=>{
  const output=(phase:string)=>({success:true,stdout:JSON.stringify({protocol:'quickjs-observation-v1',status:'observer_operation_failed',phase,observations:[]}),stderr:'',exitCode:0,timedOut:false,durationMs:1});
  vi.mocked(runInContainer).mockResolvedValue(output('bootstrap'));
  const startup=await runQuickJsObservationSuite('function target(){}','javascript',contract());
  expect(startup.infrastructureError).toBe('Trusted QuickJS observer initialization failed');
  vi.mocked(runInContainer).mockResolvedValue(output('call'));
  const candidate=await runQuickJsObservationSuite('function target(){}','javascript',contract());
  expect(candidate.infrastructureError).toBeUndefined();
  expect(candidate.passed).toBe(0);
});
