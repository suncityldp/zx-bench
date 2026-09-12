import {describe,it,expect} from 'vitest';
import {buildMethodsPack} from './bank.js';
import {difficultyScreen,referenceSubmission,scoreMethods} from './score.js';
import {countWords,oracle,parseAnswer,solveAllocation,solveLinear,verify} from './verify.js';
import {POLICY,type AllocationData,type CountingData,type LinearData} from './types.js';
import {numericEqual} from '../challengeTypes.js';

const dev=buildMethodsPack({seed:20260912,instances:1,split:'development'});
const holdout=buildMethodsPack({seed:20260912,instances:1,split:'holdout'});
const all=[...dev.cases,...holdout.cases];
const references=new Map(all.map(c=>[c.id,oracle(c)]));

// Separate recursive enumeration, not the production bit-mask feasibility helper.
function independentAllocation(d:AllocationData) {
  let best=-Infinity;
  const visit=(i:number,picks:number[],cost:number,risk:number,gain:number)=>{
    if(cost>d.budget||risk>d.riskLimit)return;
    if(i===d.items.length){if(picks.length<d.minCount)return;
      for(const [a,b] of d.requires)if(picks.includes(a)&&!picks.includes(b))return;
      for(const [a,b] of d.excludes)if(picks.includes(a)&&picks.includes(b))return;
      best=Math.max(best,gain);return;}
    visit(i+1,picks,cost,risk,gain);const item=d.items[i];visit(i+1,[...picks,i],cost+item.cost,risk+item.risk,gain+item.gain);
  };visit(0,[],0,0,0);return best;
}
// Enumerate complete strings and check constraints afterwards (independent of prefix DP).
function bruteCount(d:CountingData) {
  let total=0n;const n=d.counts.reduce((s,v)=>s+v,0);
  for(let code=0;code<3**n;code++){
    let v=code;const digits:number[]=[];for(let i=0;i<n;i++){digits.push(v%3);v=Math.floor(v/3);}
    if(d.counts.some((count,digit)=>digits.filter(x=>x===digit).length!==count))continue;
    let balance=0,valid=true,weighted=0;
    digits.forEach((x,i)=>{balance+=x===1?1:x===2?-1:0;if(balance<0||x===2&&digits[i-1]===2)valid=false;weighted+=(i+1)*x;});
    if(valid&&weighted%d.modulus===d.residue)total++;
  }return total;
}
function determinant(a:number[][]):number {
  if(a.length===1)return a[0][0];
  return a[0].reduce((s,x,j)=>s+(j%2?-1:1)*x*determinant(a.slice(1).map(row=>row.filter((_,k)=>j!==k))),0);
}

describe('v2 frozen bank and candidate boundary',()=>{
  it('is reproducible, bounded and family-disjoint',()=>{
    expect(buildMethodsPack(dev.options)).toEqual(dev);expect(dev.cases).toHaveLength(14);expect(holdout.cases).toHaveLength(8);
    const devFamilies=new Set(dev.cases.map(c=>c.family));expect(holdout.cases.every(c=>!devFamilies.has(c.family))).toBe(true);
    expect(new Set(all.map(c=>c.id)).size).toBe(all.length);
    expect(()=>buildMethodsPack({...dev.options,instances:6})).toThrow();expect(()=>buildMethodsPack({...dev.options,seed:NaN})).toThrow();
    expect(buildMethodsPack({...dev.options,seed:20260913}).contractHash).not.toBe(dev.contractHash);
    expect(buildMethodsPack({...dev.options,instances:5}).cases).toHaveLength(70);
  });
  it('exports only opaque ids, dimensions, prompts and their hashes',()=>{
    for(const c of all){expect(Object.keys(c.question).sort()).toEqual(['dimension','id','messages','questionHash']);expect(c.question.id).not.toContain(c.family);expect(c.question.messages).toHaveLength(1);}
    expect(POLICY.judgeCalls).toBe(0);expect(POLICY.productionEligible).toBe(false);
  });
  it('balances four stances and makes changes in admissibility, not extra answer labels',()=>{
    for(const family of new Set(all.filter(c=>c.kind==='evidence').map(c=>c.family))){
      const cases=all.filter(c=>c.kind==='evidence'&&c.family===family);
      expect(cases.map(c=>c.variant).sort()).toEqual(['conflict','insufficient','refuted','supported']);
      for(const c of cases)if(c.kind==='evidence'){
        expect(new Set(c.gold.sources).size).toBe(c.gold.sources.length);
        expect(c.gold.sources.every(s=>s in c.documents)).toBe(true);
        // Every condition has both plausible supporting and opposing snippets. Presence alone gives no label.
        expect(Object.keys(c.documents)).toHaveLength(9);
      }
    }
  });
  it('irrelevant variants preserve actual data while parameter variants change it',()=>{
    for(const base of all.filter(c=>c.variant==='base')){
      const pair=all.find(c=>c.group===base.group&&c.variant==='irrelevant')!,changed=all.find(c=>c.group===base.group&&c.variant==='parameter')!;
      if(base.kind==='evidence'||pair.kind==='evidence'||changed.kind==='evidence')throw new Error('wrong kind');
      expect(base.data).toEqual(pair.data);expect(base.question.questionHash).not.toBe(pair.question.questionHash);expect(changed.data).not.toEqual(base.data);
    }
  });
});
describe('exact oracles cross-checks',()=>{
  it.each(all.map(c=>[c.id,c] as const))('accepts authored certificate %s',(_,c)=>expect(verify(c,JSON.stringify(references.get(c.id)),references.get(c.id))).toMatchObject({formatValid:true,pass:true}));
  it('checks all full-size allocation instances against independent recursion',()=>{
    for(const c of all)if(c.kind==='allocation')expect((references.get(c.id)!).gain).toBe(independentAllocation(c.data as AllocationData));
  });
  it('checks alternative optima and rejects feasible nonoptimal selections',()=>{
    const c=structuredClone(all.find(c=>c.kind==='allocation')!);if(c.kind==='evidence')throw new Error();
    c.data={items:[{cost:1,gain:5,risk:1},{cost:1,gain:5,risk:1},{cost:1,gain:1,risk:1}],budget:1,riskLimit:1,requires:[],excludes:[],minCount:1};
    expect(verify(c,'{"selected":[1],"gain":"10/2"}').pass).toBe(true);
    expect(verify(c,'{"selected":[2],"gain":1}').checks).toEqual({feasible:true,reportedGain:true,optimal:false});
    expect(verify(c,'{"selected":[0,0],"gain":10}').pass).toBe(false);
    expect(verify(c,'{"selected":[99],"gain":5}').pass).toBe(false);
  });
  it('checks counting DP against complete-string enumeration with all residues',()=>{
    for(const counts of [[2,2,1],[1,3,2],[0,2,2]] as [number,number,number][])for(let residue=0;residue<5;residue++){
      const d={counts,modulus:5,residue};expect(countWords(d)).toBe(bruteCount(d));
    }
  });
  it('independently checks unique rank, singular rank and augmented contradictions',()=>{
    for(const c of all)if(c.kind==='linear'){
      const d=c.data as LinearData,ref=references.get(c.id)!;
      if(ref.kind==='unique')expect(determinant(d.a)).not.toBe(0);
      else {expect(determinant(d.a)).toBe(0);expect(determinant(d.a.slice(0,4).map(row=>row.slice(0,4)))).not.toBe(0);
        const augmentedMinor=d.a.map((row,i)=>[...row.slice(0,4),d.b[i]]);
        expect(determinant(augmentedMinor)===0).toBe(ref.kind==='multiple');}
    }
  });
  it('accepts a different solution, rescaled directions and contradiction witnesses',()=>{
    const c=structuredClone(all.find(c=>c.kind==='linear')!);if(c.kind==='evidence')throw new Error();
    c.data={a:[[1,1],[2,2]],b:[3,6]};
    expect(verify(c,'{"kind":"multiple","x":["5/2","1/2"],"direction":[2,-2]}').pass).toBe(true);
    expect(verify(c,'{"kind":"unique","x":[1,2]}').pass).toBe(false);
    expect(verify(c,'{"kind":"multiple","x":[1,2],"direction":[0,0]}').pass).toBe(false);
    c.data={a:[[1,1],[2,2]],b:[3,7]};
    expect(verify(c,'{"kind":"inconsistent","witness":[4,-2]}').pass).toBe(true);
    expect(verify(c,'{"kind":"inconsistent","witness":[0,0]}').pass).toBe(false);
  });
  it('rejects duplicate keys, oversized or malformed outputs without evaluating expressions',()=>{
    for(const text of ['{"a":1,"a":2}','{"a":1,"\\u0061":2}','{"a":{"b":1,"b":2}}',' '.repeat(20001),'{'])expect(()=>parseAnswer(text)).toThrow();
    expect(()=>parseAnswer('{"x":9007199254740993}')).toThrow();
    expect(()=>parseAnswer('{"x":0.100000000000000001}')).toThrow();
    expect(parseAnswer('{"x":"9007199254740993"}')).toEqual({x:'9007199254740993'});
    expect(parseAnswer('```json\n{"x":1}\n```')).toEqual({x:1});
    expect(numericEqual('1/2','0.5')).toBe(true);expect(numericEqual('1/2','0.5001')).toBe(false);
    expect(()=>solveAllocation({items:Array(19).fill({cost:1,gain:1,risk:1})} as AllocationData)).toThrow();
  });
});
describe('evidence errors and preregistered scoring',()=>{
  it('rejects wrong stance, missing links, dump citations and duplicates separately',()=>{
    for(const c of all)if(c.kind==='evidence'){
      expect(verify(c,JSON.stringify({...c.gold,status:c.gold.status==='supported'?'refuted':'supported'})).checks.stance).toBe(false);
      expect(verify(c,JSON.stringify({...c.gold,sources:c.gold.sources.slice(1)})).checks.citations).toBe(false);
      expect(verify(c,JSON.stringify({...c.gold,sources:Object.keys(c.documents)})).pass).toBe(false);
      expect(verify(c,JSON.stringify({...c.gold,sources:[...c.gold.sources,c.gold.sources[0]]})).pass).toBe(false);
    }
  });
  it('does not require irrelevant authority/scope tables when all records are pending or expired',()=>{
    for(const c of all)if(c.kind==='evidence'&&c.gold.status==='insufficient')expect(c.gold.sources).toHaveLength(3);
  });
  it('does not reward universal refusal or guessing one label',()=>{
    const input=referenceSubmission(dev);
    for(const a of input.answers){const c=dev.cases.find(c=>c.id===a.id)!;if(c.kind==='evidence')a.output=JSON.stringify({...c.gold,status:'insufficient'});}
    const result=scoreMethods(dev,input);
    expect(result.dimensions[0].score).toBe(25);expect(result.hallucinationDiagnostics.unnecessaryAbstentionRate).toBe(1);
    expect(result.groups.filter(g=>g.family==='scope_authority')[0].allVariantsPass).toBe(false);
    for(const a of input.answers){const c=dev.cases.find(c=>c.id===a.id)!;if(c.kind==='evidence')a.output=JSON.stringify({...c.gold,status:'supported'});}
    expect(scoreMethods(dev,input).hallucinationDiagnostics.unsupportedCommitmentRate).toBe(1);
  });
  it('uses equal-family scores, never partial dimension scores or overall',()=>{
    const input=referenceSubmission(dev),full=scoreMethods(dev,input);
    expect(full.dimensions.map(d=>d.score)).toEqual([100,100]);expect(full.combinedScore).toBeNull();
    input.answers.pop();const partial=scoreMethods(dev,input);expect(partial.dimensions.some(d=>d.score===null)).toBe(true);
    expect(partial.rows.filter(r=>r.state==='missing')).toHaveLength(1);
    expect(partial.rows.find(r=>r.state==='missing')!.pass).toBeNull();
  });
  it('separates malformed completion, truncated output and grader failure',()=>{
    const input=referenceSubmission(dev);input.answers[0].output='invalid';input.answers[1].outcome='truncated';input.answers[2].outcome='environment_error';
    const rows=scoreMethods(dev,input).rows;expect(rows[0]).toMatchObject({state:'completed',pass:false});expect(rows[1].pass).toBeNull();expect(rows[2].pass).toBeNull();
    const broken=structuredClone(dev),c=broken.cases.find(c=>c.kind==='linear');expect(c).toBeUndefined();
    const b=broken.cases.find(c=>c.kind==='allocation')!;if(b.kind!=='evidence')(b.data as AllocationData).items=Array(19).fill({cost:1,gain:1,risk:1});
    expect(scoreMethods(broken,referenceSubmission(dev)).rows.find(r=>r.id===b.id)).toMatchObject({state:'grader_error',pass:null});
  });
  it('rejects duplicate attempts, stale contracts/questions and injected judge scores',()=>{
    const input=referenceSubmission(dev);
    expect(()=>scoreMethods(dev,{...input,answers:[...input.answers,input.answers[0]]})).toThrow();
    expect(()=>scoreMethods(dev,{...input,contractHash:'stale'})).toThrow();
    expect(()=>scoreMethods(dev,{...input,judgeScore:100})).toThrow();
    input.answers[0].questionHash='old';expect(()=>scoreMethods(dev,input)).toThrow();
  });
  it('screening cannot promote official scores and requires three declared base families',()=>{
    const run=scoreMethods(dev,referenceSubmission(dev));
    expect(difficultyScreen([run]).enoughModelFamilies).toBe(false);
    const runs=[0,1,2].map(i=>({...run,runId:'run'+i,modelId:'model'+i,modelFamily:'family'+i}));
    const screen=difficultyScreen(runs);expect(screen.enoughModelFamilies).toBe(true);expect(screen.families.every(f=>f.screening==='possible_ceiling')).toBe(true);expect(screen.productionEligible).toBe(false);
    expect(()=>difficultyScreen([run,run])).toThrow();
    expect(()=>difficultyScreen([{...run,split:'holdout'}])).toThrow();
    expect(()=>difficultyScreen([{...run,families:run.families.map(f=>({...f,score:null}))}])).toThrow();
  });
});
