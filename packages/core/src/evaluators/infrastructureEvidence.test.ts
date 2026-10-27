import {it,expect,vi} from 'vitest';
import {runInContainer} from '../execution/containerRunner.js';
import {codeRepairEvaluator} from './codeRepair.js';
vi.mock('../execution/containerRunner.js',async original=>({...await original<object>(),runInContainer:vi.fn()}));
it.each(['syntax','observation'])('preserves %s evidence in unmeasured evaluator result',async phase=>{
 vi.mocked(runInContainer).mockReset();
 const failure={success:false,stdout:'candidate secret',stderr:'private path',exitCode:125,timedOut:false,durationMs:1,infrastructureError:'Container control-plane state unavailable',infrastructureEvidence:{stage:'inspect' as const,runStatus:125,inspectStatus:1,reason:'invalid-state' as const,dockerError:'container-missing'}};
 if(phase==='observation')vi.mocked(runInContainer).mockResolvedValueOnce({...failure,success:true,infrastructureError:undefined});
 vi.mocked(runInContainer).mockResolvedValueOnce(failure);
 const contract={protocol:'quickjs-observation-v1',entrypoint:'target',cases:[{id:'one',calls:[[1]],expected:[{outcome:{kind:'return',value:1}}]}]};
 const s={id:'mock',language:'javascript',functionName:'target',hiddenTests:[{id:'one'}],requirements:{quickJsObservation:contract}};
 const r=await codeRepairEvaluator.evaluate(s as any,'```javascript\nfunction target(a){return a}\n```',{} as any,{} as any);
 expect(r.environmentError).toBe(true);
 expect(r.axisEvidence).toEqual({compilation:'unmeasured',test_pass:'unmeasured'});
 expect(r.evidence?.join('\n')).toContain('"phase":"'+phase+'"');
 expect(r.evidence?.join('\n')).toContain('"inspectStatus":1');
 expect(r.evidence?.join('\n')).not.toMatch(/candidate secret|private path/);
});
