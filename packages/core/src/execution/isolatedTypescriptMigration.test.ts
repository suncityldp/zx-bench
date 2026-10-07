import{expect,it}from'vitest';
import{readFileSync}from'node:fs';
import{validIsolatedTypescriptJsonContract}from'./isolatedTypescriptJson.js';
import{validIsolatedTypescriptTypeContract}from'./isolatedTypescriptType.js';
import{ISOLATED_TYPESCRIPT_JSON_PILOTS}from'../evaluationLab/isolatedTypescriptJsonGold.js';
import{ISOLATED_TYPESCRIPT_TYPE_PILOTS}from'../evaluationLab/isolatedTypescriptTypeGold.js';
const bank=JSON.parse(readFileSync('data/scenarios/benchmark.json','utf8'));
it('binds all six TypeScript migrations and freezes formal IDs',()=>{
 const entries=[...Object.entries(ISOLATED_TYPESCRIPT_JSON_PILOTS),...Object.entries(ISOLATED_TYPESCRIPT_TYPE_PILOTS)];
 expect(entries).toHaveLength(6);
 for(const[id,p]of entries){const s=bank.find((x:any)=>x.id===id);const key='adapter'in p.contract?'isolatedTypescriptJson':'isolatedTypescriptType';expect(s.requirements[key]).toEqual(p.contract);expect(s.hiddenTests.map((x:any)=>x.id)).toEqual(p.contract.cases.map(x=>x.id));expect(s.graderVersion).toBe(s.requirements.programRevision === 'program-submission-contracts-20261007-v1' ? '4.15.0' : '4.14.0')}
});
it('strictly validates both TypeScript contracts',()=>{
 expect(Object.values(ISOLATED_TYPESCRIPT_JSON_PILOTS).every(p=>validIsolatedTypescriptJsonContract(p.contract))).toBe(true);
 expect(Object.values(ISOLATED_TYPESCRIPT_TYPE_PILOTS).every(p=>validIsolatedTypescriptTypeContract(p.contract))).toBe(true);
});
