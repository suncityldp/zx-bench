import {describe,it,expect} from 'vitest';
import {buildProofMath,proofReference,verifyProofMath,scoreProofMath} from './proofMath.js';
import {verifyLinearOptimization,type LinearOptimization} from './linearOptimizationCertificate.js';
import {solveLinear} from './methodsV2/verify.js';
const pack=buildProofMath();
const input=()=>({contractHash:pack.contractHash,runId:'offline-QA',modelId:'oracle-not-model',modelFamily:'synthetic',answers:pack.cases.map(c=>({id:c.id,questionHash:c.question.questionHash,outcome:'completed',output:JSON.stringify(proofReference(c))}))});
function independentVertexOptimum(p:LinearOptimization){
  const n=p.c.length,a=[...p.a,...Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>i===j?-1:0))],b=[...p.b,...Array(n).fill(0)];
  const combinations:number[][]=[];
  const choose=(at:number,picks:number[])=>{if(picks.length===n){combinations.push(picks);return;}for(let i=at;i<a.length;i++)choose(i+1,[...picks,i]);};choose(0,[]);
  const num=(s:unknown)=>{const [a,b='1']=String(s).split('/');return Number(a)/Number(b);};
  let best=-Infinity;
  for(const rows of combinations){const result=solveLinear({a:rows.map(i=>a[i]),b:rows.map(i=>b[i])});if(result.kind!=='unique')continue;const x=(result.x as string[]).map(num);
    if(a.every((row,i)=>row.reduce((s,v,j)=>s+v*x[j],0)<=b[i]+1e-7))best=Math.max(best,p.c.reduce((s,v,j)=>s+v*x[j],0));}
  return best;
}
describe('proof-oriented math is certificate-scored, not text-style scored',()=>{
  it('has four equally weighted families, two instances each, deterministic public export',()=>{
    expect(pack.cases).toHaveLength(8);expect(new Set(pack.cases.map(c=>c.family)).size).toBe(4);expect(buildProofMath()).toEqual(pack);
    expect(pack.questions.every(q=>Object.keys(q).sort().join(',')==='dimension,id,messages,questionHash')).toBe(true);
    expect(buildProofMath(20260913).contractHash).not.toBe(pack.contractHash);
  });
  it.each(pack.cases.map(c=>[c.id,c] as const))('validates generated certificate %s',(_,c)=>expect(verifyProofMath(c,JSON.stringify(proofReference(c))).pass).toBe(true));
  it('cross-checks optimal LP values with independent vertex enumeration',()=>{
    for(const c of pack.cases)if(c.kind==='optimization'&&c.reference.status==='optimal')expect(independentVertexOptimum(c.problem)).toBeCloseTo(Number(c.reference.value),8);
  });
  it('accepts noncanonical feasible solutions/dual vectors and exact equivalent values',()=>{
    const p={a:[[1,1]],b:[3],c:[1,1]};
    expect(verifyLinearOptimization(p,{status:'optimal',x:['1/2','5/2'],y:[1],value:'6/2'}).pass).toBe(true);
    expect(verifyLinearOptimization(p,{status:'optimal',x:[3,0],y:[1],value:3}).pass).toBe(true);
    expect(verifyLinearOptimization(p,{status:'optimal',x:[4,-1],y:[1],value:3}).pass).toBe(false);
    expect(verifyLinearOptimization(p,{status:'optimal',x:[1,2],y:[0],value:3}).pass).toBe(false);
  });
  it('verifies Farkas sign conventions and recession directions',()=>{
    expect(verifyLinearOptimization({a:[[1],[-1]],b:[0,-1],c:[1]},{status:'infeasible',y:[1,1]}).pass).toBe(true);
    expect(verifyLinearOptimization({a:[[1],[-1]],b:[0,-1],c:[1]},{status:'infeasible',y:[-1,-1]}).pass).toBe(false);
    expect(verifyLinearOptimization({a:[[-1]],b:[0],c:[1]},{status:'unbounded',x:[0],ray:[2]}).pass).toBe(true);
    expect(verifyLinearOptimization({a:[[1]],b:[3],c:[1]},{status:'unbounded',x:[0],ray:[1]}).pass).toBe(false);
    expect(verifyLinearOptimization({a:[[-1]],b:[0],c:[1]},{status:'unbounded',x:[0],ray:[0]}).pass).toBe(false);
  });
  it('rejects right labels paired with bogus partition witnesses or a missing branch answer',()=>{
    const c=pack.cases.find(c=>c.kind==='partition')!;if(c.kind!=='partition')throw new Error();
    const ref=proofReference(c) as any;
    const falseId=Object.keys(ref).find(id=>ref[id].valid===false)!;ref[falseId].witness.word='';expect(verifyProofMath(c,JSON.stringify(ref)).pass).toBe(false);
    delete ref[falseId];expect(verifyProofMath(c,JSON.stringify(ref)).formatValid).toBe(false);
  });
  it('requires complete coverage, preserves failed attempts, disallows duplicates and stale hashes',()=>{
    expect(scoreProofMath(pack,input()).dimensions[0].score).toBe(100);
    const partial=input();partial.answers.pop();expect(scoreProofMath(pack,partial).dimensions[0].score).toBeNull();
    const broken=input();broken.answers[0].output='not json';expect(scoreProofMath(pack,broken).rows[0].pass).toBe(false);
    broken.answers[0].outcome='truncated';expect(scoreProofMath(pack,broken).rows[0].pass).toBeNull();
    const duplicate=input();duplicate.answers.push(duplicate.answers[0]);expect(()=>scoreProofMath(pack,duplicate)).toThrow();
    expect(()=>scoreProofMath(pack,{...input(),contractHash:'old'})).toThrow();
  });
});
