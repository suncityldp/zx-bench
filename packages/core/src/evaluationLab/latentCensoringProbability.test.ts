import {describe,expect,it} from 'vitest';
import {buildLatentCensoringProbability,latentCensoringReference,verifyLatentCensoring,scoreLatentCensoring,type LatentCensoringProblem} from './latentCensoringProbability.js';
const number=(v:unknown)=>{const [n,d='1']=String(v).split('/');return Number(n)/Number(d);};
function labelledOracle(p:LatentCensoringProblem){
  const totals=[0,0,0,0,0,0],priorTotal=p.prior.reduce((a,b)=>a+b,0);
  p.boxes.forEach((counts,box)=>{const balls=counts.flatMap((count,color)=>Array.from({length:count},()=>color)),n=balls.length,den=n*(n-1)*(n-2)*(n-3)*(n-4);
    for(let a=0;a<n;a++)for(let b=0;b<n;b++)if(b!==a)for(let c=0;c<n;c++)if(c!==a&&c!==b)for(let d=0;d<n;d++)if(![a,b,c].includes(d))for(let e=0;e<n;e++)if(![a,b,c,d].includes(e)){
      const seen=[0,0,0],left=[...counts];let t=0,last=-1;
      for(const index of [a,b,c,d,e]){last=balls[index];seen[last]++;left[last]--;t++;if(seen[2]===p.stopGreen)break;}
      const signal=p.signalByLastAndRedParity[last][seen[0]%2],select=p.selectByBoxAndLength[box][t];
      const weight=p.prior[box]/priorTotal/den*signal[0]/signal[1]*select[0]/select[1],remaining=n-t;
      totals[0]+=weight;if(box===0)totals[1]+=weight;if(t<p.cap)totals[2]+=weight;if(seen[0]===1)totals[3]+=weight;
      totals[4]+=weight*left[0]/remaining;totals[5]+=weight*left.reduce((s,x)=>s+x*(x-1),0)/(remaining*(remaining-1));
    }
  });return totals.map((v,i)=>i?v/totals[0]:v);
}
describe('latent censoring probability challenge',()=>{
  const pack=buildLatentCensoringProbability();
  it('cross-checks every exact reference by labelled-ball enumeration',()=>{for(const c of pack.cases){const a=Object.values(latentCensoringReference(c.problem).answer).map(number),b=labelledOracle(c.problem);a.forEach((v,i)=>expect(v).toBeCloseTo(b[i],10));}});
  it('changes selection inference and retains true irrelevant twins',()=>{for(const variant of ['base','parameter']){
    const a=pack.cases.find(c=>c.family==='noisy_signal'&&c.variant===variant)!,b=pack.cases.find(c=>c.family==='selected_record'&&c.variant===variant)!;
    expect(latentCensoringReference(a.problem).answer.posterior_box_a).not.toBe(latentCensoringReference(b.problem).answer.posterior_box_a);
  }for(const family of new Set(pack.cases.map(c=>c.family))){const f=pack.cases.filter(c=>c.family===family);expect(f.find(c=>c.variant==='base')!.problem).toEqual(f.find(c=>c.variant==='irrelevant')!.problem);}});
  it('accepts the exact answer and rejects one wrong field or two JSON blocks',()=>{const c=pack.cases[0],a=latentCensoringReference(c.problem).answer;
    expect(verifyLatentCensoring(c,JSON.stringify(a)).pass).toBe(true);expect(verifyLatentCensoring(c,JSON.stringify({...a,posterior_box_a:'0'})).pass).toBe(false);
    expect(verifyLatentCensoring(c,'```json\n'+JSON.stringify(a)+'\n```\n```json\n{}\n```').formatValid).toBe(false);});
  it('keeps unparseable and truncated answers unmeasured with denominator intact',()=>{const input={contractHash:pack.contractHash,runId:'r',modelId:'m',modelFamily:'f',answers:pack.cases.map(c=>({id:c.id,questionHash:c.question.questionHash,outcome:'completed',output:JSON.stringify(latentCensoringReference(c.problem).answer)}))};
    expect(scoreLatentCensoring(pack,input).dimensions[0].score).toBe(100);input.answers[0].output='bad';let r=scoreLatentCensoring(pack,input);expect(r.rows[0].pass).toBeNull();expect(r.dimensions[0].score).toBeNull();input.answers[0].outcome='truncated';r=scoreLatentCensoring(pack,input);expect(r.rows[0].pass).toBeNull();});
  it('publishes no gold and rejects invalid state spaces',()=>{for(const q of pack.questions)expect(Object.keys(q).sort()).toEqual(['dimension','id','messages','questionHash']);const p=pack.cases[0].problem;
    expect(()=>latentCensoringReference({...p,boxes:[[100,1,2],p.boxes[1],p.boxes[2]]})).toThrow();expect(()=>buildLatentCensoringProbability(-1)).toThrow();});
});
