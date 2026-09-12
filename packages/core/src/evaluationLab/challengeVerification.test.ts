import {describe,it,expect} from 'vitest';
import {buildChallengePack,gradeChallenge,referenceAnswer} from './challengePack.js';
import type {MathCase} from './challengeTypes.js';

const pack=buildChallengePack();
const item=(id:string)=>pack.cases.find(c=>c.id===id)!;
const math=(id:string)=>item(id) as MathCase;
// Separate enumeration and schedule evaluation: do not call production simulators.
function enumerate<T>(input:T[]):T[][]{
 const output:T[][]=[];
 function visit(prefix:T[],rest:T[]){if(!rest.length){output.push(prefix);return;}
  for(let i=0;i<rest.length;i++)visit([...prefix,rest[i]],[...rest.slice(0,i),...rest.slice(i+1)]);
 }visit([],input);return output;
}

describe('post-review reference and grading verification',()=>{
 it('recomputes routing from public input with separate constraint evaluation',()=>{
  const c=math('MC2-001'),d=c.data as any;let best=Infinity,feasible=0;
  for(const order of enumerate<string>(d.nodes.slice(1))){
   if(d.precedence.some(([a,b]:string[])=>order.indexOf(a)>=order.indexOf(b)))continue;
   let last='S',end=0,valid=true;const starts:number[]=[];
   for(const next of [...order,'S']){
    if(d.forbidden.some(([a,b]:string[])=>a===last&&b===next)){valid=false;break;}
    const i=d.nodes.indexOf(next),j=d.nodes.indexOf(last);
    const start=Math.max(end+d.travel[j][i],d.windows[i][0]);
    if(start>d.windows[i][1]){valid=false;break;}
    if(next!=='S')starts.push(start);end=start+d.service[i];last=next;
   }
   if(!valid)continue;feasible++;best=Math.min(best,end);
   expect(gradeChallenge(c,JSON.stringify({order,arrivals:starts,finish:end})).strictPass).toBe(end===c.reference.finish);
  }
  expect(feasible).toBeGreaterThan(0);expect(best).toBe(34);expect(c.reference.finish).toBe(best);
 });
 it('recomputes flowshop using integer time search for each operation including the outage',()=>{
  const c=math('MC2-002'),d=c.data as any;let best=Infinity,boundary10=false,boundary16=false;
  for(const order of enumerate<string>(d.jobs.map((j:any)=>j.id))){
   if(order.indexOf('J2')>order.indexOf('J6'))continue;
   const completion:number[][]=[];
   for(let i=0;i<order.length;i++){
    const durations=d.jobs.find((j:any)=>j.id===order[i]).p,row:number[]=[];
    for(let machine=0;machine<3;machine++){
     let start=Math.max(completion[i-1]?.[machine]??0,row[machine-1]??0);
     while(machine===1&&Array.from({length:durations[machine]},(_,k)=>start+k).some(t=>t>=10&&t<16))start++;
     row.push(start+durations[machine]);
     if(machine===1){boundary10 ||= row[machine]===10;boundary16 ||= start===16;}
    }completion.push(row);
   }
   const makespan=completion.at(-1)![2];best=Math.min(best,makespan);
   expect(gradeChallenge(c,JSON.stringify({order,completion,makespan})).strictPass).toBe(makespan===c.reference.makespan);
  }
  // This particular job bank reaches start=16 but never completion=10 on M2.
  expect(boundary10).toBe(false);expect(boundary16).toBe(true);expect(best).toBe(48);expect(c.reference.makespan).toBe(best);
 });
 it('recomputes project selection from public data without the production feasibility helper',()=>{
  const c=math('MC2-003'),d=c.data as any;let best=-Infinity;
  for(let mask=0;mask<2**d.items.length;mask++){
   const chosen=d.items.filter((_:unknown,i:number)=>(mask>>i)&1),selected=chosen.map((p:any)=>p.id);
   const sums=chosen.reduce((a:any,p:any)=>({cost:a.cost+p.cost,staff:a.staff+p.staff,value:a.value+p.value}),{cost:0,staff:0,value:0});
   if(sums.cost>d.budget||sums.staff>d.staff||d.requiredSkills.some((s:string)=>!chosen.some((p:any)=>p.skills.includes(s)))||d.requires.some(([a,b]:string[])=>selected.includes(a)&&!selected.includes(b))||d.exclusive.some(([a,b]:string[])=>selected.includes(a)&&selected.includes(b)))continue;
   best=Math.max(best,sums.value);
   expect(gradeChallenge(c,JSON.stringify({selected,...sums})).strictPass).toBe(sums.value===c.reference.value);
  }
  expect(best).toBe(48);expect(c.reference.value).toBe(best);
 });
 it.each(['MC2-007','MC2-008'])('%s accepts exact numeric strings throughout the certificate',id=>{
  const c=item(id);const strings=JSON.parse(JSON.stringify(referenceAnswer(c),(_,v)=>typeof v==='number'?`${v}e0`:v));
  expect(gradeChallenge(c,JSON.stringify(strings)).strictPass).toBe(true);
 });
 it('rejects numerically equivalent duplicate roots and fractional graph vertices',()=>{
  const c=item('MC2-007'),a=referenceAnswer(c) as any;a.roots32[1]='1.0';
  expect(gradeChallenge(c,JSON.stringify(a)).strictPass).toBe(false);
  const g=item('MC2-008'),b=referenceAnswer(g) as any;b.deleted[0]='5/2';
  expect(gradeChallenge(g,JSON.stringify(b)).strictPass).toBe(false);
  b.deleted=[2,'2.0',7,10];expect(gradeChallenge(g,JSON.stringify(b)).strictPass).toBe(false);
 });
 it.each([
  ['HC3-001','lumen_deployed_repair',['D7']],
  ['HC3-003','pilot_approved',['D4']],
  ['HC3-004','production_reproduced',['D4']],
  ['HC3-004','sensor_root_cause',['D5']],
  ['HC3-006','c104_any_certificate',['D7']],
  ['HC3-007','f_observed_later',['D2','D3']],
  ['HC2-008','s_awarded',['D7']],
 ] as const)('%s.%s accepts a self-contained sufficient citation',(id,key,sources)=>{
  const c=item(id),a=referenceAnswer(c) as any;a[key].sources=[...sources];
  expect(gradeChallenge(c,JSON.stringify(a)).strictPass).toBe(true);
  a[key].value=a[key].value===null?true:null;
  expect(gradeChallenge(c,JSON.stringify(a)).strictPass).toBe(false);
 });
 it('independently checks migrated applied math and rejects swapped interval directions',()=>{
  const expected:Record<string,unknown>={
   'MC2-009':{cap:460,net:440,payment:440,later_payment:400},
   'MC2-010':{new_itt:60,old_itt:50,itt_gap:10,complete_gap:15},
   'MC2-011':{external_a:126,external_b:104,consolidated:230},
   'MC2-012':{any_min:59,any_max:65,clean_min:135,clean_max:141},
  };
  for(const [id,a] of Object.entries(expected))expect(gradeChallenge(item(id),JSON.stringify(a)).strictPass,id).toBe(true);
  // Construct every admissible overlap, not just the stored endpoint formulas.
  const counts=Array.from({length:7},(_,i)=>({any:42+35-(12+i),clean:200-42-35+(12+i)}));
  expect(math('MC2-012').reference).toEqual({any_min:Math.min(...counts.map(x=>x.any)),any_max:Math.max(...counts.map(x=>x.any)),clean_min:Math.min(...counts.map(x=>x.clean)),clean_max:Math.max(...counts.map(x=>x.clean))});
  expect(gradeChallenge(item('MC2-012'),JSON.stringify({any_min:65,any_max:59,clean_min:141,clean_max:135})).strictPass).toBe(false);
 });
});
