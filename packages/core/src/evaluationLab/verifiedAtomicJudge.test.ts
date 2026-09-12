import {describe,it,expect} from 'vitest';
import {verifiedJudgeFixtures,VERIFIED_JUDGE_INSTRUCTIONS} from './verifiedAtomicJudge.js';
import {auditPacket} from './atomicJudge.js';
describe('new Judge gold is checked beyond final answer arithmetic',()=>{
  const fixtures=verifiedJudgeFixtures();
  it('has balanced, disjoint development/holdout template families',()=>{
    expect(fixtures).toHaveLength(24);expect(fixtures.filter(f=>f.expected==='pass')).toHaveLength(12);
    const dev=new Set(fixtures.filter(f=>f.split==='development').map(f=>f.family));
    expect(fixtures.filter(f=>f.split==='holdout').every(f=>!dev.has(f.family))).toBe(true);
    expect(fixtures.filter(f=>f.split==='holdout')).toHaveLength(12);
  });
  it('derives all machine-checkable fixture labels from the actual certificates',()=>{
    for(const f of fixtures){const evidence=f.oracleEvidence as {pass?:boolean}|undefined;if(typeof evidence?.pass==='boolean')expect(f.expected).toBe(evidence.pass?'pass':'fail');}
    const original=fixtures.find(f=>f.family==='orientation_and_partition'&&f.item.candidate.includes('末尾为0或10'))!;
    expect(original.expected).toBe('fail');expect((original.oracleEvidence as any).witnesses.some((w:any)=>w.word==='01')).toBe(true);
  });
  it('does not mistake different valid orientations for errors',()=>{
    const family=fixtures.filter(f=>f.family==='orientation_and_partition');
    expect(family.filter(f=>f.expected==='pass')).toHaveLength(2);
    expect(family.filter(f=>f.expected==='fail')).toHaveLength(2);
  });
  it('never includes gold or verifier output in the Judge packet',()=>{
    const packet=auditPacket(fixtures.slice(0,4).map(f=>f.item));
    expect(JSON.stringify(packet)).not.toContain('oracleEvidence');expect(JSON.stringify(packet)).not.toContain('"expected"');
    expect(VERIFIED_JUDGE_INSTRUCTIONS).toContain('关键证明步骤不成立，仍为fail');
  });
});
