import {it,expect,vi} from 'vitest';
import {execAsync} from '../execution/execAsync.js';
import {codeRepairEvaluator} from './codeRepair.js';
vi.mock('../execution/execAsync.js',()=>({execAsync:vi.fn()}));
const contract={protocol:'quickjs-observation-v1',entrypoint:'target',cases:[{id:'one',calls:[[1]],expected:[{outcome:{kind:'return',value:1}}]}]};
const scenario={id:'mock',language:'javascript',functionName:'target',sourceCode:'function target(a){return a}',hiddenTests:[{id:'one'}],requirements:{quickJsObservation:contract}};
const evaluate=()=>codeRepairEvaluator.evaluate(scenario as any,'```javascript\nfunction target(a){return a}\n```',{} as any,{} as any);
it.each(['syntax','observation'])('carries run-only mount clues through real %s pipeline',async phase=>{
 let runs=0;
 vi.mocked(execAsync).mockReset().mockImplementation(async(_cmd,args)=>{
  if(args[0]==='run') {runs++;return {status:phase==='syntax'||runs===2?125:0,stdout:'',stderr:'invalid mount /private/password=secret bearer SECRET'};}
  if(args[0]==='inspect')return phase==='syntax'||runs===2?{status:1,stdout:'',stderr:'No such container /private/SECRET'}:{status:0,stdout:JSON.stringify({StartedAt:'2026-01-01',Error:''}),stderr:''};
  return {status:0,stdout:'',stderr:''};
 });
 const r=await evaluate();
 expect(r.environmentError).toBe(true);
 expect(r.axisEvidence).toEqual({compilation:'unmeasured',test_pass:'unmeasured'});
 const line=r.evidence!.find(x=>x.startsWith('EXECUTION_FAILURE_DETAIL: '))!;
 expect(line,'final evaluator must retain failure detail').toBeDefined();
 const detail=JSON.parse(line.slice('EXECUTION_FAILURE_DETAIL: '.length));
 expect(detail).toMatchObject({phase,stage:'inspect',runStatus:125,inspectStatus:1,reason:'invalid-state',dockerError:'container-missing',untrustedRunDiagnostic:'mount-error'});
 expect(JSON.stringify(r)).not.toMatch(/SECRET|password=|\/private/);
 expect(runs).toBe(phase==='syntax'?1:2);
});
it.each(['syntax','observation'])('does not exempt a started candidate with exit125 and spoofed Docker text in %s',async phase=>{
 let runs=0;
 vi.mocked(execAsync).mockReset().mockImplementation(async(_cmd,args)=>{
  if(args[0]==='run'){runs++;return {status:phase==='syntax'||runs===2?125:0,stdout:'',stderr:'Docker unavailable; invalid mount; No such container'};}
  return {status:0,stdout:args[0]==='inspect'?JSON.stringify({StartedAt:'2026-01-01',Error:'',ExitCode:125}):'',stderr:''};
 });
 const r=await evaluate();
 expect(r.environmentError).toBe(false);
 expect(r.axisScores?.test_pass).toBe(0);
 expect(r.axisEvidence?.test_pass).toBe('verified');
 expect(r.evidence?.join('\n')).not.toContain('EXECUTION_FAILURE_DETAIL');
 expect(runs).toBe(phase==='syntax'?1:2);
});
