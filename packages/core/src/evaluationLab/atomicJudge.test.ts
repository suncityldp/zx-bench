import {describe,it,expect} from 'vitest';
import {atomicJudgeFixtures} from './atomicJudgeFixtures.js';
import {auditPacket,parseAtomicAudit,assessAtomicAudit,attachSemanticAudit,type AuditVerdict} from './atomicJudge.js';
const fixtures=atomicJudgeFixtures(),selected=fixtures.filter(f=>f.split==='development').slice(0,4),items=selected.map(f=>f.item);
const verdicts:AuditVerdict[]=selected.map(f=>({id:f.item.id,verdict:f.expected,quote:f.item.candidate,sources:[Object.keys(f.item.sources)[0]],reason:'仅用于离线协议测试，不是模型评语。'}));
describe('atomic Judge is a bounded semantic audit, not an automatic score',()=>{
  it('freezes balanced minimal pairs, with disjoint development/holdout families',()=>{
    expect(fixtures).toHaveLength(24);expect(fixtures.filter(f=>f.expected==='pass')).toHaveLength(12);
    expect(new Set(fixtures.map(f=>f.item.id)).size).toBe(24);
    const dev=new Set(fixtures.filter(f=>f.split==='development').map(f=>f.family));
    expect(fixtures.filter(f=>f.split==='holdout').every(f=>!dev.has(f.family))).toBe(true);
    expect(atomicJudgeFixtures()).toEqual(fixtures);
  });
  it('does not send authored labels, family identifiers or rubric basis to Judge',()=>{
    const packet=auditPacket(items);expect(packet.items.every(i=>Object.keys(i).sort().join(',')==='candidate,dimension,focus,id,sources')).toBe(true);
    expect(JSON.stringify(packet)).not.toContain('"expected"');expect(JSON.stringify(packet)).not.toContain('"basis"');
    expect(()=>auditPacket([...items,items[0]])).toThrow();
  });
  it('accepts complete valid structure without equating it with semantic correctness',()=>{
    const wrong=structuredClone(verdicts);wrong[0].verdict=wrong[0].verdict==='pass'?'fail':'pass';
    const parsed=parseAtomicAudit(items,JSON.stringify(wrong),'stop',true);
    expect(assessAtomicAudit(selected,parsed)).toMatchObject({complete:true,allMatch:false,productionEligible:false,automaticScoreWeight:0});
  });
  it('rejects truncated/nonterminal responses even when their JSON is valid',()=>{
    expect(()=>parseAtomicAudit(items,JSON.stringify(verdicts),'length',true)).toThrow();
    expect(()=>parseAtomicAudit(items,JSON.stringify(verdicts),'stop',false)).toThrow();
  });
  it('rejects duplicated ids, unknown source links, invented quotes and extra score fields',()=>{
    for(const mutate of [
      (v:any[])=>{v[1].id=v[0].id;},(v:any[])=>{v[0].sources=['D999'];},
      (v:any[])=>{v[0].quote='这段话从未出现在候选答案中。';},(v:any[])=>{v[0].score=100;},
      (v:any[])=>{v[0].reason='长'.repeat(121);},(v:any[])=>{v[0].sources=['D1','D1'];},
    ]){const changed=structuredClone(verdicts);mutate(changed);expect(()=>parseAtomicAudit(items,JSON.stringify(changed),'stop',true)).toThrow();}
  });
  it('reports missing and uncertain as unresolved, not successful calibration',()=>{
    expect(assessAtomicAudit(selected,verdicts.slice(1))).toMatchObject({complete:false,allMatch:false,measured:3});
    const uncertain=structuredClone(verdicts);uncertain[0].verdict='uncertain';expect(assessAtomicAudit(selected,uncertain).allMatch).toBe(false);
  });
  it('requires held-out labels and reason review before flags become usable',()=>{
    const fail={...verdicts[0],verdict:'fail' as const};
    expect(attachSemanticAudit(true,fail,{operationalPassed:true,heldoutAllMatch:true,reasonsAudited:false}).judgeUsable).toBe(false);
    expect(attachSemanticAudit(true,fail,{operationalPassed:true,heldoutAllMatch:true,reasonsAudited:true})).toMatchObject({exactPass:true,semanticReviewRequired:true,officialScoreChanged:false});
    expect(attachSemanticAudit(false,{...fail,verdict:'pass'},{operationalPassed:true,heldoutAllMatch:true,reasonsAudited:true})).toMatchObject({exactPass:false,officialScoreChanged:false});
  });
});
