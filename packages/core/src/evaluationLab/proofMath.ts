import {snapshotHash} from '../contracts/pack.js';
import {exactKeys,object} from './challengeTypes.js';
import {question,random,shuffle,opaque,type Question} from './methodsV2/types.js';
import {parseAnswer} from './methodsV2/verify.js';
import {verifyLinearOptimization,type LinearOptimization} from './linearOptimizationCertificate.js';
import {verifyRegularPartition,type PartitionProblem,type PartitionCertificate} from './regularPartition.js';
export const PROOF_MATH_VERSION='proof-math-2026-09-12-v1';
interface Base {id:string;family:string;instance:number;question:Question}
export interface OptimizationCase extends Base {kind:'optimization';problem:LinearOptimization;reference:Record<string,unknown>}
export interface PartitionCase extends Base {kind:'partition';problem:PartitionProblem;proposals:{id:string;certificate:PartitionCertificate}[]}
export type ProofCase=OptimizationCase|PartitionCase;
const LP_TASK=`在实数域处理线性规划：最大化 c·x，约束 A·x≤b 且所有 x_j≥0。必须判定有有限最优解、不可行或目标无界，并提交可核验证书。
有限最优解返回 {"status":"optimal","x":[原问题可行解],"y":[非负对偶向量],"value":最优值}，需要 Aᵀy≥c 且 c·x=b·y=value。
不可行返回 {"status":"infeasible","y":[非负向量]}，需 Aᵀy≥0 且 b·y<0。
无界返回 {"status":"unbounded","x":[可行点],"ray":[非负方向]}，需 A·ray≤0 且 c·ray>0。
只返回对应JSON。数值可用整数或精确分数字符串，接受任意有效证书，不要求唯一证书。不得使用外部工具。`;
function optimization(seed:number,status:'optimal'|'infeasible'|'unbounded',instance:number):OptimizationCase {
  const r=random(seed+instance*347),integer=()=>Math.floor(r()*7)-3,n=4;
  let a:number[][],b:number[],c:number[],reference:Record<string,unknown>;
  if(status==='optimal'){
    const x=[1+instance,2,1,0],y=[2,1,3,0,0,0];
    // Positive definite active block, with mixed-sign coefficients and a zero primal variable.
    a=Array.from({length:6},(_,i)=>Array.from({length:n},(_,j)=>i<3&&i===j?6+instance:integer()));
    b=a.map((row,i)=>row.reduce((s,v,j)=>s+v*x[j],0)+(i<3?0:4+i));
    c=Array.from({length:n},(_,j)=>a.reduce((s,row,i)=>s+row[j]*y[i],0)-(j===3?2:0));
    reference={status,x,y,value:c.reduce((s,v,j)=>s+v*x[j],0)};
  }else if(status==='infeasible'){
    a=Array.from({length:3},()=>Array.from({length:n},integer));b=[2+instance,3,1];const weights=[2,1,3];
    a.push(Array.from({length:n},(_,j)=>-a.reduce((s,row,i)=>s+weights[i]*row[j],0)));
    b.push(-b.reduce((s,v,i)=>s+weights[i]*v,0)-1);c=Array.from({length:n},integer);
    reference={status,y:[...weights,1]};
  }else{
    const x=[1,1+instance,0,2],ray=[1,2,1,1];
    a=Array.from({length:5},()=>{const row=Array.from({length:3},integer);return [...row,-row.reduce((s,v,j)=>s+v*ray[j],0)-Math.floor(r()*3)];});
    b=a.map((row,i)=>row.reduce((s,v,j)=>s+v*x[j],0)+i);c=[2,1,3,-1];reference={status,x,ray};
  }
  // Shuffle constraints so positional templates do not reveal active rows or witness coefficients.
  const order=shuffle(a.map((_,i)=>i),seed+instance+55),problem={a:order.map(i=>a[i]),b:order.map(i=>b[i]),c};
  if(Array.isArray(reference.y))reference.y=order.map(i=>(reference.y as number[])[i]);
  const id=opaque({version:PROOF_MATH_VERSION,seed,status,instance});
  if(!verifyLinearOptimization(problem,reference).pass)throw new Error('Generated LP certificate invalid');
  return {id,family:'linear_'+status,instance,kind:'optimization',problem,reference,question:question(id,'reasoning_math',LP_TASK+'\n数据：'+JSON.stringify(problem))};
}
function partition(seed:number,instance:number):PartitionCase {
  const length=3+instance,problem={alphabet:['0','1'],forbidden:['1'.repeat(length)],minLength:length};
  const prefix=Array.from({length},(_,k)=>'1'.repeat(k)+'0'),suffix=prefix.map(s=>[...s].reverse().join(''));
  const proposals=shuffle([
    {id:'K1',certificate:{side:'prefix' as const,pieces:prefix}},
    {id:'K2',certificate:{side:'suffix' as const,pieces:prefix}},
    {id:'K3',certificate:{side:'suffix' as const,pieces:suffix}},
    {id:'K4',certificate:{side:'prefix' as const,pieces:prefix.filter((_,i)=>i!==1)}},
  ],seed+instance).map((p,i)=>({...p,id:'P'+(i+1)}));
  const id=opaque({version:PROOF_MATH_VERSION,seed,instance,kind:'partition'});
  const task=`设L为字母表alphabet上不包含任何forbidden子串的全部有限串（含空串）。检查以下提议是否将L中长度至少minLength的串恰好划分为互不相交的类。
side=prefix时，第i类为piece_i后拼任意u∈L；side=suffix时，第i类为任意u∈L后拼piece_i。只考虑拼接后长度至少minLength的串。必须同时满足：不漏掉目标串、同一串不落入两类、不产生L以外的串。
每个提议返回 {"valid":true,"witness":null} 或 {"valid":false,"witness":{"kind":"missing或overlap或invalid","word":"一个具体反例"}}。missing为合法但零类覆盖，overlap为两类以上覆盖，invalid为被某类生成的非法串。反例不要求最短，长度须≤40；不允许用空泛文字代替。只返回以提议ID为键的JSON对象。
数据：${JSON.stringify({problem,proposals})}`;
  return {id,family:'regular_partition_proof',instance,kind:'partition',problem,proposals,question:question(id,'reasoning_math',task)};
}
export function buildProofMath(seed=20260912){
  if(!Number.isInteger(seed)||seed<0||seed>0x7fffffff)throw new Error('Invalid seed');
  const cases:ProofCase[]=[];
  for(const status of ['optimal','infeasible','unbounded'] as const)for(let i=0;i<2;i++)cases.push(optimization(seed,status,i));
  for(let i=0;i<2;i++)cases.push(partition(seed,i));
  const policy={version:PROOF_MATH_VERSION,scope:'development_math_certificate_pilot',seed,judgeCalls:0,productionEligible:false,independentGold:false,
    aggregation:'equal_family_strict_pass_rate_only_when_all_planned_cases_measured',combinedScore:null,history:'one_explicit_attempt_no_best_of',
    missing:'truncated_environment_error_missing_and_grader_error_unmeasured',sampling:{concurrency:1,hardSeconds:1200,maxTokens:90000,contextLength:131072,temperature:0.6,topP:0.95,topK:20,minP:0,generationSeed:20260910}};
  const ordered=shuffle(cases,seed+551);return {policy,cases:ordered,questions:ordered.map(c=>c.question),contractHash:snapshotHash({policy,cases:ordered})};
}
export function proofReference(c:ProofCase):Record<string,unknown>{
  if(c.kind==='optimization')return structuredClone(c.reference);
  return Object.fromEntries(c.proposals.map(p=>{const checked=verifyRegularPartition(c.problem,p.certificate);return [p.id,checked.pass?{valid:true,witness:null}:{valid:false,witness:{kind:checked.witnesses[0].kind,word:checked.witnesses[0].word}}];}));
}
export function verifyProofMath(c:ProofCase,output:string){
  let v:unknown;try{v=parseAnswer(output);}catch{return {formatValid:false,pass:false,checks:{} as Record<string,boolean>};}
  if(c.kind==='optimization')return verifyLinearOptimization(c.problem,v);
  if(!exactKeys(v,c.proposals.map(p=>p.id)))return {formatValid:false,pass:false,checks:{}};
  const checks:Record<string,boolean>={};
  for(const p of c.proposals){
    const value=v[p.id];if(!exactKeys(value,['valid','witness'])||typeof value.valid!=='boolean')return {formatValid:false,pass:false,checks:{}};
    const truth=verifyRegularPartition(c.problem,p.certificate);checks[p.id+':classification']=value.valid===truth.pass;
    if(value.valid){checks[p.id+':witness']=value.witness===null;continue;}
    const w=value.witness;if(!exactKeys(w,['kind','word'])||!['missing','overlap','invalid'].includes(String(w.kind))||typeof w.word!=='string'||w.word.length>40||[...w.word].some(x=>!c.problem.alphabet.includes(x)))return {formatValid:false,pass:false,checks:{}};
    const word=w.word,allowed=(text:string)=>!c.problem.forbidden.some(f=>text.includes(f)),matches=p.certificate.pieces.filter(piece=>p.certificate.side==='suffix'?word.endsWith(piece)&&allowed(word.slice(0,word.length-piece.length)):word.startsWith(piece)&&allowed(word.slice(piece.length))).length;
    checks[p.id+':witness']=word.length>=c.problem.minLength&&(w.kind==='missing'?allowed(word)&&matches===0:w.kind==='overlap'?matches>=2:!allowed(word)&&matches>=1);
  }
  return {formatValid:true,pass:Object.values(checks).every(Boolean),checks};
}
export function scoreProofMath(pack:ReturnType<typeof buildProofMath>,input:unknown){
  if(!exactKeys(input,['contractHash','runId','modelId','modelFamily','answers'])||input.contractHash!==pack.contractHash||!['runId','modelId','modelFamily'].every(k=>typeof input[k]==='string'&&String(input[k]).trim())||!Array.isArray(input.answers))throw new Error('Invalid submission');
  const answers=new Map<string,any>();
  for(const a of input.answers){if(!exactKeys(a,['id','questionHash','outcome','output'])||typeof a.id!=='string'||answers.has(a.id)||!pack.cases.some(c=>c.id===a.id&&c.question.questionHash===a.questionHash)||!['completed','truncated','environment_error'].includes(String(a.outcome))||typeof a.output!=='string')throw new Error('Duplicate/stale/unknown answer');answers.set(a.id,a);}
  const rows=pack.cases.map(c=>{const a=answers.get(c.id),base={id:c.id,family:c.family,instance:c.instance,outputHash:a?snapshotHash(a.output):null};
    if(!a||a.outcome!=='completed')return {...base,state:a?.outcome??'missing',pass:null};
    try{const verification=verifyProofMath(c,a.output);return {...base,state:'completed',pass:verification.pass,verification};}catch{return {...base,state:'grader_error',pass:null};}});
  const families=[...new Set(rows.map(r=>r.family))].map(family=>{const f=rows.filter(r=>r.family===family),measured=f.filter(r=>r.pass!==null),passed=f.filter(r=>r.pass).length;return {family,planned:f.length,measured:measured.length,passed,score:measured.length===f.length?100*passed/f.length:null};});
  return {version:pack.policy.version,contractHash:pack.contractHash,runId:input.runId,modelId:input.modelId,modelFamily:input.modelFamily,rows,families,
    dimensions:[{dimension:'reasoning_math',planned:rows.length,measured:rows.filter(r=>r.pass!==null).length,score:families.every(f=>f.score!==null)?families.reduce((s,f)=>s+f.score!,0)/families.length:null,weighting:'equal_family'}],
    combinedScore:null,judgeCalls:0,productionEligible:false,difficultyCalibrated:false};
}
