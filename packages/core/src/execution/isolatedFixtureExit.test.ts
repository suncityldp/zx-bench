import{expect,it}from'vitest';
import{readFileSync}from'node:fs';
import{ISOLATED_FIXTURE_EXIT_PILOTS}from'../evaluationLab/isolatedFixtureExitGold.js';
import{validIsolatedFixtureExitContract}from'./isolatedFixtureExit.js';
const bank=JSON.parse(readFileSync('data/scenarios/benchmark.json','utf8'));
it('binds all twenty final fixtures and freezes their IDs',()=>{
 expect(Object.keys(ISOLATED_FIXTURE_EXIT_PILOTS)).toHaveLength(20);
 for(const[id,p]of Object.entries(ISOLATED_FIXTURE_EXIT_PILOTS)){const s=bank.find((x:any)=>x.id===id);expect(validIsolatedFixtureExitContract(p.contract),id).toBe(true);expect(s.requirements.isolatedFixtureExit).toEqual(p.contract);expect(s.hiddenTests.map((x:any)=>x.id)).toEqual(p.contract.caseIds);expect(s.graderVersion).toBe(s.requirements.programRevision === 'program-submission-contracts-20261007-v1' ? '4.15.0' : '4.14.0')}
});
