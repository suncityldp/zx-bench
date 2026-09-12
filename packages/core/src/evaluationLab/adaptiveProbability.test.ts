import {describe,it,expect} from 'vitest';
import {buildAdaptiveProbability,probabilityReference,verifyAdaptiveProbability,scoreAdaptiveProbability,type ProbabilityProblem} from './adaptiveProbability.js';
const number=(v:unknown)=>{const [n,d='1']=String(v).split('/');return Number(n)/Number(d);};
/** Independent oracle: uniformly enumerate labelled length-cap permutations,
 * then truncate each latent sequence at its actual stop. Do not remove latent post-stop balls. */
function labelledOracle(p:ProbabilityProblem){
  const sums=[0,0,0,0,0];
  p.boxes.forEach((counts,box)=>{
    const balls=counts.flatMap((count,color)=>Array.from({length:count},()=>color)),n=balls.length;
    const prior=box===0?p.priorA[0]/p.priorA[1]:1-p.priorA[0]/p.priorA[1],denominator=n*(n-1)*(n-2)*(n-3);
    for(let a=0;a<n;a++)for(let b=0;b<n;b++)if(b!==a)for(let c=0;c<n;c++)if(c!==a&&c!==b)for(let d=0;d<n;d++)if(d!==a&&d!==b&&d!==c){
      const seen=[0,0,0],left=[...counts];let t=0,last=-1;
      for(const index of [a,b,c,d]){last=balls[index];seen[last]++;left[last]--;t++;if(seen[2]===p.stopGreen)break;}
      if(seen[0]!==1||last!==2)continue;
      const weight=prior/denominator*p.reportByLength[t][0]/p.reportByLength[t][1],remaining=n-t;
      sums[0]+=weight;if(box===0)sums[1]+=weight;if(t<p.cap)sums[2]+=weight;
      sums[3]+=weight*left[0]/remaining;sums[4]+=weight*left.reduce((s,x)=>s+x*(x-1),0)/(remaining*(remaining-1));
    }
  });
  return sums.map((s,i)=>i?s/sums[0]:s);
}
describe('adaptive probability pilot',()=>{
  const pack=buildAdaptiveProbability();
  it('cross-checks all tasks with labelled-ball enumeration',()=>{for(const c of pack.cases){const expected=Object.values(probabilityReference(c.problem).answer).map(number),independent=labelledOracle(c.problem);expected.forEach((v,i)=>expect(v).toBeCloseTo(independent[i],11));}});
  it('cross-checks the next fixed confirmation seed and verifies genuine new mathematical data',()=>{
    for(const c of buildAdaptiveProbability(20260913).cases){
      expect(c.problem).not.toEqual(pack.cases.find(p=>p.family===c.family&&p.variant===c.variant)!.problem);
      const expected=Object.values(probabilityReference(c.problem).answer).map(number),independent=labelledOracle(c.problem);
      expected.forEach((v,i)=>expect(v).toBeCloseTo(independent[i],11));
    }
  });
  it('accepts exact references with optional explanation but does not certify that prose',()=>{for(const c of pack.cases){const text=JSON.stringify(probabilityReference(c.problem).answer);expect(verifyAdaptiveProbability(c,text).pass).toBe(true);expect(verifyAdaptiveProbability(c,'解释\n```json\n'+text+'\n```').pass).toBe(true);expect(verifyAdaptiveProbability(c,text).proofCorrectness).toBe('not_inferred_from_final_answer');}});
  it('rejects a wrong probability and multiple candidate JSON blocks',()=>{const c=pack.cases[0],answer=probabilityReference(c.problem).answer;expect(verifyAdaptiveProbability(c,JSON.stringify({...answer,posterior_a:'0'})).pass).toBe(false);expect(verifyAdaptiveProbability(c,'```json\n{}\n```\n```json\n'+JSON.stringify(answer)+'\n```').pass).toBe(false);});
  it('changes inference under selective reporting but not uniform reporting thinning',()=>{
    const base=pack.cases.find(c=>c.family==='stopping_conditioning'&&c.variant==='base')!,selective=pack.cases.find(c=>c.family==='observation_selection'&&c.variant==='base')!;
    const a=probabilityReference(base.problem).answer,b=probabilityReference(selective.problem).answer;
    expect(a.early_stop_probability).not.toBe(b.early_stop_probability);
    const half=probabilityReference({...base.problem,reportByLength:Array.from({length:5},()=>[1,2] as [number,number])}).answer;
    expect(number(half.report_probability)).toBeCloseTo(number(a.report_probability)/2,14);
    expect(half.posterior_a).toBe(a.posterior_a);expect(half.next_red_probability).toBe(a.next_red_probability);
  });
  it('keeps irrelevant variants identical in data, and parameters genuinely change data',()=>{for(const family of new Set(pack.cases.map(c=>c.family))){const f=pack.cases.filter(c=>c.family===family);expect(f.find(c=>c.variant==='base')!.problem).toEqual(f.find(c=>c.variant==='irrelevant')!.problem);expect(f.find(c=>c.variant==='base')!.problem).not.toEqual(f.find(c=>c.variant==='parameter')!.problem);}});
  it('has no reference answers or family labels in public fields',()=>{expect(pack.questions).toHaveLength(6);expect(new Set(pack.questions.map(q=>q.id)).size).toBe(6);for(const q of pack.questions)expect(Object.keys(q).sort()).toEqual(['dimension','id','messages','questionHash']);});
  it('rejects impossible reports and oversized state spaces',()=>{const p=pack.cases[0].problem;expect(()=>probabilityReference({...p,reportByLength:Array.from({length:5},()=>[0,1] as [number,number])})).toThrow();expect(()=>probabilityReference({...p,boxes:[[100,2,3],[4,3,2]]})).toThrow();});
  it('never turns unparseable or truncated answers into math zero or drops their denominator',()=>{
    const input={contractHash:pack.contractHash,runId:'r',modelId:'m',modelFamily:'f',answers:pack.cases.map(c=>({id:c.id,questionHash:c.question.questionHash,outcome:'completed',output:JSON.stringify(probabilityReference(c.problem).answer)}))};
    expect(scoreAdaptiveProbability(pack,input).dimensions[0].score).toBe(100);
    const bad=structuredClone(input);bad.answers[0].output='not a numerical answer';const scored=scoreAdaptiveProbability(pack,bad);expect(scored.rows[0].state).toBe('unparseable_requires_review');expect(scored.rows[0].pass).toBeNull();expect(scored.dimensions[0].planned).toBe(6);expect(scored.dimensions[0].score).toBeNull();
    bad.answers[0].outcome='truncated';expect(scoreAdaptiveProbability(pack,bad).rows[0].pass).toBeNull();
    const duplicate=structuredClone(input);duplicate.answers.push(duplicate.answers[0]);expect(()=>scoreAdaptiveProbability(pack,duplicate)).toThrow();
  });
});
