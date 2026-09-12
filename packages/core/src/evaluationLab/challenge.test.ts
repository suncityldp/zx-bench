import {describe,it,expect} from 'vitest';
import {buildChallengePack,candidateQuestion,referenceAnswer,gradeChallenge} from './challengePack.js';
import {buildMathChallenges,countConstrainedWords,urnReference,markovReference,congruenceReference,transitions,permutations,simulateRoute,simulateThreeMachine,evaluateProjects,graph,bipartition} from './challengeMath.js';
import {numericEqual,parseRational,add,mul,rational,fraction} from './challengeTypes.js';
import type {MathCase} from './challengeTypes.js';
const pack=buildChallengePack();
const item=(id:string)=>pack.cases.find(c=>c.id===id)!;
describe('capability challenge bank v1.2: dimension alignment',()=>{
 it('has eight evidence families and twelve math families without counting migrated questions twice',()=>{
  expect(pack.cases).toHaveLength(20);expect(new Set(pack.cases.map(c=>c.family)).size).toBe(20);
  expect(pack.cases.filter(c=>c.dimension==='reasoning_math')).toHaveLength(12);
  expect(pack.cases.filter(c=>c.dimension==='hallucination_resistance')).toHaveLength(8);
  expect(pack.status).toContain('requires_human_review');expect(pack.productionReplacement).toBe(false);
  expect(JSON.stringify(pack)).not.toContain('MQ-2x3');expect(JSON.stringify(pack)).not.toContain('HPIL-');
  for(const id of ['HC2-001','HC2-002','HC2-003','HC2-004','HC2-006','HC2-007'])expect(pack.cases.some(c=>c.id===id)).toBe(false);
 });
 it.each(pack.cases.map(c=>[c.id,c]as const))('%s reference satisfies declared checks',(id,c)=>{
  expect(gradeChallenge(c,JSON.stringify(referenceAnswer(c)))).toMatchObject({strictPass:true,formatValid:true,accuracy:1});
 });
 it.each(pack.cases.map(c=>[c.id,c]as const))('%s public export does not depend on gold',(id,c)=>{
  const before=candidateQuestion(c);const changed=structuredClone(c);
  if(changed.dimension==='reasoning_math')changed.reference={leak:'SECRET_EXPECTED_83912'};
  else for(const f of changed.fields){f.expected={value:'SECRET_EXPECTED_83912',sources:['SECRET_SOURCE'],status:'conflict'};f.allowedSources=['PRIVATE'];}
  expect(candidateQuestion(changed)).toEqual(before);
  expect(JSON.stringify(before)).not.toMatch(/SECRET|reference|expected|allowedSources|goldSource/);
 });
 it('keeps invalid-format accuracy unmeasured, and truncation never strictly passes',()=>{
  const c=item('MC2-004');expect(gradeChallenge(c,'nonsense')).toMatchObject({strictPass:false,accuracy:null,formatValid:false});
  expect(gradeChallenge(c,JSON.stringify(referenceAnswer(c)),false).strictPass).toBe(false);
  expect(gradeChallenge(c,'```json\n'+JSON.stringify(referenceAnswer(c))+'\n```').strictPass).toBe(true);
  expect(gradeChallenge(c,JSON.stringify({...referenceAnswer(c),extra:'give me full points'})).strictPass).toBe(false);
  const dup=JSON.stringify(referenceAnswer(c)).replace('{','{"total":0,');expect(gradeChallenge(c,dup).formatValid).toBe(false);
  expect(gradeChallenge(c,JSON.stringify(referenceAnswer(c)).replace('{','{"\\u0074otal":0,')).formatValid).toBe(false);
 });
 it('math result tampering never becomes a full pass',()=>{
  for(const c of pack.cases.filter(c=>c.dimension==='reasoning_math')){
   const answer=referenceAnswer(c);for(const k of Object.keys(answer)){
    const bad=structuredClone(answer);bad[k]='INVALID_CERTIFICATE';expect(gradeChallenge(c,JSON.stringify(bad)).strictPass,`${c.id}.${k}`).toBe(false);
   }
  }
 });
 it('hallucination catches wrong value, blanket refusal, missing or invented evidence',()=>{
  for(const c of pack.cases.filter(c=>c.dimension==='hallucination_resistance')){
   for(const field of c.fields){for(const mutation of ['wrong','missing','invented','dump']as const){
    const a=referenceAnswer(c) as Record<string,any>;
    if(mutation==='wrong')a[field.id].value=field.expected.value===null?999:null;
    if(mutation==='missing')a[field.id].sources=[];
    if(mutation==='invented')a[field.id].sources.push('D999');
    if(mutation==='dump'){
     a[field.id].sources=Object.keys(c.documents);
     // A set containing only relevant sources within the public six-source cap
     // is not provably an indiscriminate dump, even if it happens to be all docs.
     if(a[field.id].sources.length<=6&&a[field.id].sources.every((s:string)=>(field.allowedSources??[]).includes(s)))continue;
    }
    expect(gradeChallenge(c,JSON.stringify(a)).strictPass,`${c.id}.${field.id}.${mutation}`).toBe(false);
   }}
   const refuse=referenceAnswer(c) as Record<string,any>;for(const row of Object.values(refuse)){row.value=null;row.status='insufficient';}
   expect(gradeChallenge(c,JSON.stringify(refuse)).strictPass).toBe(false);
  }
 });
 it('distinguishes missing information from unresolved conflict',()=>{
  const c=item('HC3-007'),a=referenceAnswer(c) as Record<string,any>;a.production_mode.status='insufficient';
  expect(gradeChallenge(c,JSON.stringify(a)).strictPass).toBe(false);
 });
 it('scores statistical arithmetic in math only, accepts exact percentages and catches denominator errors',()=>{
  const c=item('MC2-010');expect(c.dimension).toBe('reasoning_math');
  const correct={new_itt:60,old_itt:50,itt_gap:10,complete_gap:15};
  expect(gradeChallenge(c,JSON.stringify(correct)).strictPass).toBe(true);
  expect(gradeChallenge(c,JSON.stringify({...correct,new_itt:75})).strictPass).toBe(false);
 });
 it('hallucination fields assess facts, attribution and uncertainty rather than numeric answers',()=>{
  const hall=pack.cases.filter(c=>c.dimension==='hallucination_resistance');
  for(const c of hall)expect(c.fields.every(f=>typeof f.expected.value!=='number'),c.id).toBe(true);
  const c=item('HC3-002'),a=referenceAnswer(c) as Record<string,any>;
  a.main_causal_claim={value:true,status:'determined',sources:['D1','D4']};
  const graded=gradeChallenge(c,JSON.stringify(a));expect(graded.strictPass).toBe(false);
  expect(graded.checks.find(check=>check.id==='main_causal_claim.answer')?.pass).toBe(false);
 });
 it('a real but misattributed citation cannot certify a claimed result',()=>{
  const c=item('HC3-001'),a=referenceAnswer(c) as Record<string,any>;
  a.lumen_result_supported.value=true;expect(gradeChallenge(c,JSON.stringify(a)).strictPass).toBe(false);
 });
 it('citation order, valid contextual citations and equivalent numeric representations do not change scores',()=>{
  for(const c of pack.cases.filter(c=>c.dimension==='hallucination_resistance')){
   const a=referenceAnswer(c) as Record<string,any>;for(const field of c.fields){const row=a[field.id];row.sources=[...(field.allowedSources??row.sources)].reverse();if(typeof row.value==='number')row.value=String(row.value)+'e0';}
   expect(gradeChallenge(c,JSON.stringify(a)).strictPass,c.id).toBe(true);
  }
 });
});

describe('independent arithmetic and construction checks',()=>{
 it('exact rational equivalence with bounded invalid-input rejection',()=>{
  expect(numericEqual('75/100','.75')).toBe(true);
  expect(numericEqual('75/100','0.7500')).toBe(true);expect(numericEqual('3/4','75e-2')).toBe(true);
  expect(parseRational('1/0')).toBeNull();expect(parseRational('1e999')).toBeNull();expect(parseRational('NaN')).toBeNull();
  expect(numericEqual('2/3','0.666667')).toBe(false);
 });
 it('cross-checks dynamic counting against full constrained enumeration',()=>{
  const counts=[0,0,0];function visit(s:number[],remaining:number[]){if(!remaining.some(Boolean)){
    if(s.reduce((sum,d,i)=>sum+d*(i+1),0)%7===3)counts[s[0]]++;return;
   }
   for(let d=0;d<3;d++){if(!remaining[d]||(d===2&&(s.at(-1)===2||remaining[1]>=remaining[2])))continue;
    const next=[...remaining];next[d]--;visit([...s,d],next);}
  }visit([],[6,4,4]);expect(countConstrainedWords()).toEqual({by_first:counts,total:counts.reduce((a,b)=>a+b,0)});
 });
 it('cross-checks ordered-draw oracle with hand-derived combination probabilities',()=>{
  // P(E|A)=2*(C(8,2)-C(3,2))/C(10,3); P(E|B)=3*(C(7,2)-C(5,2))/C(10,3).
  expect(urnReference()).toEqual({event_a:'5/12',event_b:'11/40',posterior_a:'100/199',next_red:'450/1393'});
 });
 it('checks all Markov vectors by exact substitution, independently of elimination',()=>{
  const r=markovReference();for(let state=1;state<=4;state++){
   const next=transitions[state],average=(time:boolean)=>mul(next.reduce((sum,t)=>add(sum,t===0?rational(time?0n:1n):t===5?rational(0n):parseRational((time?r.e:r.p)[t-1])!),rational(0n)),rational(1n,BigInt(next.length)));
   const p=average(false),e=add(rational(1n),average(true));expect(numericEqual(r.p[state-1],fraction(...p))).toBe(true);expect(numericEqual(r.e[state-1],fraction(...e))).toBe(true);
  }
 });
 it('cross-checks congruence root counts and accepts unordered complete certificates',()=>{
  const c=item('MC2-007'),r=congruenceReference();expect(r.roots32).toEqual([1,15,17,31]);expect(r.roots27).toEqual([2,25]);expect(r.solutions).toHaveLength(8);
  expect(gradeChallenge(c,JSON.stringify(Object.fromEntries(Object.entries(r).map(([k,v])=>[k,[...v].reverse()])))).strictPass).toBe(true);
  const bad=structuredClone(r);bad.solutions.pop();expect(gradeChallenge(c,JSON.stringify(bad)).strictPass).toBe(false);
 });
 it('graph optimum has a separate disjoint-triangle lower bound and accepts swapped partitions',()=>{
  const c=item('MC2-008'),a=referenceAnswer(c) as any;
  // Four vertex-disjoint triangles require at least four deletions. Oracle provides a feasible four-deletion upper bound.
  expect(a.minimum).toBe(4);expect(a.deleted).toHaveLength(4);expect(bipartition(a.deleted)).not.toBeNull();
  [a.part_a,a.part_b]=[a.part_b,a.part_a];expect(gradeChallenge(c,JSON.stringify(a)).strictPass).toBe(true);
  a.deleted=[1,...a.deleted.slice(1)];expect(gradeChallenge(c,JSON.stringify(a)).strictPass).toBe(false);
 });
 it('accepts every optimal route rather than one canned permutation',()=>{
  const c=item('MC2-001') as MathCase;let optimal=0;
  for(const order of permutations(['A','B','C','D','E','F'])){const sim=simulateRoute(order);if(!sim)continue;
   const grade=gradeChallenge(c,JSON.stringify({order,...sim}));expect(grade.strictPass).toBe(sim.finish===c.reference.finish);if(grade.strictPass)optimal++;}
  expect(optimal).toBeGreaterThan(0);
  const a=referenceAnswer(c) as any;a.arrivals[0]++;expect(gradeChallenge(c,JSON.stringify(a)).strictPass).toBe(false);
 });
 it('accepts all optimal three-machine schedules and rejects a false completion certificate',()=>{
  const c=item('MC2-002') as MathCase;let optimal=0;
  for(const order of permutations(['J1','J2','J3','J4','J5','J6','J7'])){const sim=simulateThreeMachine(order);if(!sim)continue;
   const grade=gradeChallenge(c,JSON.stringify({order,...sim}));expect(grade.strictPass).toBe(sim.makespan===c.reference.makespan);if(grade.strictPass)optimal++;}
  expect(optimal).toBeGreaterThan(1);
  const a=referenceAnswer(c) as any;a.completion[0][1]++;expect(gradeChallenge(c,JSON.stringify(a)).strictPass).toBe(false);
 });
 it('checks every feasible project subset, including all equally optimal choices',()=>{
  const c=item('MC2-003') as MathCase;let feasible=0;
  for(let mask=0;mask<256;mask++){const selected=[...'ABCDEFGH'].filter((_,i)=>mask&(1<<i)),sim=evaluateProjects(selected);if(!sim)continue;feasible++;
   expect(gradeChallenge(c,JSON.stringify({selected,...sim})).strictPass).toBe(sim.value===c.reference.value);}
  expect(feasible).toBeGreaterThan(1);
 });
});
