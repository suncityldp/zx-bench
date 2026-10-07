import {beforeEach,expect,it,vi} from 'vitest';
import {isolatedCsharpOptions,validIsolatedCsharpJsonContract,CSHARP_JSON_IMAGE} from './isolatedCsharpJson.js';
import {ISOLATED_CSHARP_JSON_PILOTS} from '../evaluationLab/isolatedCsharpJsonGold.js';
import {codeRepairEvaluator} from '../evaluators/codeRepair.js';
import {runInContainer} from './containerRunner.js';
import {readFileSync} from 'node:fs';
vi.mock('./containerRunner.js',async original=>({...await original<object>(),runInContainer:vi.fn()}));
beforeEach(()=>vi.mocked(runInContainer).mockReset());
const fixture=ISOLATED_CSHARP_JSON_PILOTS['CP-L3-SEM-CS-002'];
it('validates seven fixed C# adapters and rejects executable or malformed call shapes',()=>{
  expect(Object.keys(ISOLATED_CSHARP_JSON_PILOTS)).toHaveLength(7);
  for(const f of Object.values(ISOLATED_CSHARP_JSON_PILOTS))expect(validIsolatedCsharpJsonContract(f.contract)).toBe(true);
  for(const bad of [
    {...fixture.contract,adapter:'eval'},
    {...fixture.contract,cases:[]},
    {...fixture.contract,cases:[{...fixture.contract.cases[0],calls:[['code()','extra']]}]},
    {...fixture.contract,cases:[{...fixture.contract.cases[0],expected:[true]}]},
    {...fixture.contract,cases:[fixture.contract.cases[0],fixture.contract.cases[0]]},
  ])expect(validIsolatedCsharpJsonContract(bad)).toBe(false);
});
it('uses pinned hardened .NET and mounts only project, candidate and data-only driver',()=>{
  const c=fixture.contract.cases[0],o=isolatedCsharpOptions(fixture.correct,fixture.contract,c.calls);
  expect(o.image).toBe(CSHARP_JSON_IMAGE);expect(o.files?.map(f=>f.path)).toEqual(['app.csproj','Candidate.cs','Driver.cs']);
  expect(o).toMatchObject({localImageOnly:true,readOnlyRoot:true,readOnly:true,networkDisabled:true,runAsNonRoot:true,memoryMb:512,pidsLimit:96,maxOutputBytes:65536});
  const serialized=JSON.stringify(o);
  for(const hidden of [c.id,'expected','score":100'])expect(serialized).not.toContain(hidden);
  expect(serialized).toContain('decimal.Parse');
});
it('does not permit a C# contract on another language before execution',async()=>{
  const scenario={id:'x',language:'java',functionName:fixture.contract.entrypoint,requirements:{isolatedCsharpJson:fixture.contract},hiddenTests:fixture.contract.cases.map(c=>({id:c.id}))};
  const r=await codeRepairEvaluator.evaluate(scenario as any,'```java\nclass RoundMoney{}\n```',{} as any);
  expect(r.environmentError).toBe(true);expect(r.axisCoverage).toBe(0);expect(runInContainer).not.toHaveBeenCalled();
});
it('binds every C# pilot to the reviewed bank without changing original test IDs',()=>{
  const bank=JSON.parse(readFileSync('data/scenarios/benchmark.json','utf8'));
  for(const [id,p] of Object.entries(ISOLATED_CSHARP_JSON_PILOTS)){
    const s=bank.find((x:any)=>x.id===id);
    expect(s.requirements.isolatedCsharpJson).toEqual(p.contract);
    expect(s.hiddenTests.map((t:any)=>t.id)).toEqual(p.contract.cases.map(c=>c.id));
    expect(s.graderVersion).toBe(s.requirements.programRevision === 'program-submission-contracts-20261007-v1' ? '4.15.0' : '4.14.0');expect(s.scenarioVersion).toBe(s.requirements.programRevision ? '5.1.0' : p.contract.protocol==='isolated-csharp-json-v2'?'4.4.0':'4.0.0');
  }
});
