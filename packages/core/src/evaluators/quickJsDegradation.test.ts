import {it,expect,vi} from 'vitest';
import {runInContainer} from '../execution/containerRunner.js';
import {codeRepairEvaluator} from './codeRepair.js';
vi.mock('../execution/containerRunner.js',async original=>({...await original<object>(),runInContainer:vi.fn()}));
const report=(value:number)=>JSON.stringify({protocol:'quickjs-observation-v1',status:'ok',observations:[{kind:'return',valueType:'json',value,sameArgument:[false],argumentsAfter:[1]}]});
const cases=[['correct',report(1),false,100],['wrong',report(2),false,0],['empty','',true,undefined],['truncated','{',true,undefined],['missing',JSON.stringify({protocol:'quickjs-observation-v1',status:'ok',observations:[]}),true,undefined],['bootstrap',JSON.stringify({protocol:'quickjs-observation-v1',phase:'bootstrap',status:'observer_rejected',observations:[]}),true,undefined],['candidate',JSON.stringify({protocol:'quickjs-observation-v1',status:'candidate_load_error',observations:[]}),false,0]] as const;
it.each(cases)('adapter classification %s',async(_name,stdout,environment,score)=>{
 vi.mocked(runInContainer).mockReset();
 const base={success:true,stdout:'',stderr:'',exitCode:0,timedOut:false,durationMs:1,executionError:false};
 vi.mocked(runInContainer).mockResolvedValueOnce(base).mockResolvedValueOnce({...base,success:false,stdout,infrastructureError:'Container control-plane state unavailable',inspectQueryFailure:true});
 const contract={protocol:'quickjs-observation-v1',entrypoint:'target',cases:[{id:'one',calls:[[1]],expected:[{outcome:{kind:'return',value:1}}]}]};
 const result=await codeRepairEvaluator.evaluate({id:'mock',language:'javascript',functionName:'target',sourceCode:'function target(a){return a}',hiddenTests:[{id:'one'}],requirements:{quickJsObservation:contract}} as any,'```javascript\nfunction target(a){return a}\n```',{} as any,{} as any);
 if(!environment)expect(result.evidence?.join("\n")).toContain("EXECUTION_OBSERVATION_DEGRADED");
 expect(result.environmentError).toBe(environment);expect(result.axisScores?.test_pass).toBe(score);expect(runInContainer).toHaveBeenCalledTimes(2);
});
it.each(['syntax','timeout','buffer','spawn','exit125','conflict'])('does not relax %s failure',async kind=>{
 vi.mocked(runInContainer).mockReset();
 const base={success:true,stdout:'',stderr:'',exitCode:0,timedOut:false,durationMs:1,executionError:false};
 const failed={...base,success:false,stdout:report(1),infrastructureError:'control unavailable',inspectQueryFailure:kind!=='conflict',timedOut:kind==='timeout',outputLimitExceeded:kind==='buffer',executionError:kind==='spawn',exitCode:kind==='exit125'?125:0};
 if(kind==='syntax')vi.mocked(runInContainer).mockResolvedValueOnce(failed);
 else vi.mocked(runInContainer).mockResolvedValueOnce(base).mockResolvedValueOnce(failed);
 const contract={protocol:'quickjs-observation-v1',entrypoint:'target',cases:[{id:'one',calls:[[1]],expected:[{outcome:{kind:'return',value:1}}]}]};
 const result=await codeRepairEvaluator.evaluate({id:'mock',language:'javascript',functionName:'target',hiddenTests:[{id:'one'}],requirements:{quickJsObservation:contract}} as any,'```javascript\nfunction target(a){return a}\n```',{} as any,{} as any);
 expect(result.environmentError).toBe(true);expect(result.axisEvidence?.test_pass).toBe('unmeasured');expect(runInContainer).toHaveBeenCalledTimes(kind==='syntax'?1:2);
});
