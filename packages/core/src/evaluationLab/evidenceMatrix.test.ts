import {describe,expect,it} from 'vitest';
import {buildEvidenceMatrix,evidenceMatrixReference,verifyEvidenceMatrix,scoreEvidenceMatrix} from './evidenceMatrix.js';
describe('multi-claim evidence matrix',()=>{
  const pack=buildEvidenceMatrix();
  const submission=()=>({contractHash:pack.contractHash,runId:'r',modelId:'m',modelFamily:'f',answers:pack.cases.map(c=>({id:c.id,questionHash:c.question.questionHash,outcome:'completed',output:JSON.stringify(evidenceMatrixReference(c))}))});
  it('accepts exact claim states and minimal evidence in any order',()=>{for(const c of pack.cases){const answer=evidenceMatrixReference(c);answer.claims.reverse();answer.claims.forEach(x=>x.sources.reverse());const v=verifyEvidenceMatrix(c,JSON.stringify(answer));expect(v.pass).toBe(true);expect(v.atoms).toHaveLength(4);}});
  it('separates status and minimal-source errors',()=>{const c=pack.cases[0],a=evidenceMatrixReference(c),wrongStatus=structuredClone(a),extra=structuredClone(a);
    wrongStatus.claims[0].status=wrongStatus.claims[0].status==='supported'?'refuted':'supported';let v=verifyEvidenceMatrix(c,JSON.stringify(wrongStatus));expect(v.pass).toBe(false);expect(v.atoms[0].statusPass).toBe(false);
    extra.claims[0].sources.push('D99');v=verifyEvidenceMatrix(c,JSON.stringify(extra));expect(v.pass).toBe(false);expect(v.atoms[0].sourcesPass).toBe(false);});
  it('has true irrelevant twins and parameter variants that change a gold state',()=>{for(const family of new Set(pack.cases.map(c=>c.family))){const base=pack.cases.find(c=>c.family===family&&c.variant==='base')!,irrelevant=pack.cases.find(c=>c.family===family&&c.variant==='irrelevant')!,parameter=pack.cases.find(c=>c.family===family&&c.variant==='parameter')!;
    expect(base.documents).toEqual(irrelevant.documents);expect(base.gold).toEqual(irrelevant.gold);expect(parameter.gold.map(x=>x.status)).not.toEqual(base.gold.map(x=>x.status));}});
  it('publishes no gold fields and balances closed-evidence states',()=>{for(const q of pack.questions){expect(Object.keys(q).sort()).toEqual(['dimension','id','messages','questionHash']);expect(q.messages[0].content).not.toContain('"gold"');}
    const statuses=new Set(pack.cases.flatMap(c=>c.gold.map(g=>g.status)));expect(statuses).toEqual(new Set(['supported','refuted','insufficient','conflict']));});
  it('asks about the underlying claim rather than the meta-claim that records conflict',()=>{const c=pack.cases.find(c=>c.family==='versioned_authority_graph'&&c.variant==='base')!;
    expect(c.claims.C4).toBe('经理已经批准E2申请。');expect(c.gold.find(g=>g.id==='C4')!.status).toBe('conflict');});
  it('uses the stated mechanical citation rule and excludes a superseded draft',()=>{const c=pack.cases.find(c=>c.family==='causal_lineage_graph'&&c.variant==='parameter')!;
    expect(c.question.messages[0].content).toContain('排除被替代、无权和仅转述材料');expect(c.gold.find(g=>g.id==='C4')!.sources).toEqual(['D01','D07']);});
  it('scores complete references but keeps bad format and truncation unmeasured',()=>{const input=submission();expect(scoreEvidenceMatrix(pack,input).dimensions[0].score).toBe(100);
    input.answers[0].output='bad';let r=scoreEvidenceMatrix(pack,input);expect(r.rows[0].pass).toBeNull();expect(r.dimensions[0].score).toBeNull();input.answers[0].outcome='truncated';r=scoreEvidenceMatrix(pack,input);expect(r.rows[0].pass).toBeNull();});
  it('rejects duplicates, unknown claims and invalid seed',()=>{const c=pack.cases[0],a=evidenceMatrixReference(c);a.claims[1].id=a.claims[0].id;expect(verifyEvidenceMatrix(c,JSON.stringify(a)).formatValid).toBe(false);
    const input=submission();input.answers.push(input.answers[0]);expect(()=>scoreEvidenceMatrix(pack,input)).toThrow();expect(()=>buildEvidenceMatrix(-1)).toThrow();});
});
