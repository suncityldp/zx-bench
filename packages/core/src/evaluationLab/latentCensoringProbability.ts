/** Harder exact probability: latent source, adaptive stopping, noisy signal and record selection. */
import {snapshotHash} from '../contracts/pack.js';
import {rational,add,mul,div,fraction,numericEqual,exactKeys,type Rational} from './challengeTypes.js';
import {question,opaque,shuffle,type Question} from './methodsV2/types.js';
import {parseAnswer} from './methodsV2/verify.js';
import {certificateDiagnostic} from './certificateDiagnostic.js';
export interface LatentCensoringProblem {
  boxes:[number[],number[],number[]]; prior:[number,number,number]; cap:5; stopGreen:2;
  signalByLastAndRedParity:[[number,number][],[number,number][],[number,number][]];
  selectByBoxAndLength:[[number,number][],[number,number][],[number,number][]];
}
export const LATENT_CENSORING_VERSION='latent-censoring-probability-2026-09-12-v1';
const FIELDS=['observed_record_probability','posterior_box_a','early_stop_probability','one_red_drawn_probability','next_red_probability','next_two_same_probability'] as const;
const q=(n:number,d=1)=>rational(BigInt(n),BigInt(d)),zero=()=>rational(0n);
const prob=(v:[number,number])=>q(v[0],v[1]);
export function latentCensoringReference(p:LatentCensoringProblem){
  if(p.boxes.length!==3||p.prior.length!==3||p.prior.some(x=>!Number.isInteger(x)||x<=0)||p.prior.reduce((a,b)=>a+b,0)>100||
    p.boxes.some(b=>b.length!==3||b.some(x=>!Number.isInteger(x)||x<0)||b.reduce((a,c)=>a+c,0)<7||b.reduce((a,c)=>a+c,0)>14)||p.cap!==5||p.stopGreen!==2)
    throw new Error('Invalid bounded latent experiment');
  const validMatrix=(m:[number,number][][],rows:number,cols:number)=>m.length===rows&&m.every(r=>r.length===cols&&r.every(([n,d])=>Number.isInteger(n)&&Number.isInteger(d)&&d>0&&d<=100&&n>=0&&n<=d));
  if(!validMatrix(p.signalByLastAndRedParity,3,2)||!validMatrix(p.selectByBoxAndLength,3,6))throw new Error('Invalid channel probabilities');
  const totalPrior=p.prior.reduce((a,b)=>a+b,0),totals=Array.from({length:FIELDS.length},zero);let terminalPaths=0;
  p.boxes.forEach((initial,box)=>{
    const prior=q(p.prior[box],totalPrior);
    function visit(left:number[],drawn:number[],path:Rational,last:number){
      const t=drawn.reduce((a,b)=>a+b,0);
      if(t===p.cap||drawn[2]===p.stopGreen){
        terminalPaths++;const weight=mul(mul(mul(prior,path),prob(p.signalByLastAndRedParity[last][drawn[0]%2])),prob(p.selectByBoxAndLength[box][t]));
        totals[0]=add(totals[0],weight);if(box===0)totals[1]=add(totals[1],weight);if(t<p.cap)totals[2]=add(totals[2],weight);if(drawn[0]===1)totals[3]=add(totals[3],weight);
        const n=left.reduce((a,b)=>a+b,0);totals[4]=add(totals[4],mul(weight,q(left[0],n)));
        totals[5]=add(totals[5],mul(weight,q(left.reduce((s,c)=>s+c*(c-1),0),n*(n-1))));return;
      }
      const n=left.reduce((a,b)=>a+b,0);
      left.forEach((count,color)=>{if(!count)return;const next=[...left],seen=[...drawn];next[color]--;seen[color]++;visit(next,seen,mul(path,q(count,n)),color);});
    }
    visit([...initial],[0,0,0],q(1),-1);
  });
  if(totals[0][0]===0n)throw new Error('Impossible observed record');
  return {answer:Object.fromEntries(FIELDS.map((field,i)=>{const value=i===0?totals[0]:div(totals[i],totals[0]);return [field,fraction(value[0],value[1])];})),terminalPaths};
}
export interface LatentCensoringCase {id:string;family:string;variant:string;group:string;problem:LatentCensoringProblem;question:Question}
export function buildLatentCensoringProbability(seed=20260912){
  if(!Number.isInteger(seed)||seed<0||seed>0x7fffffff)throw new Error('Invalid seed');const cases:LatentCensoringCase[]=[],offset=seed%4;
  for(const family of ['noisy_signal','selected_record'])for(const variant of ['base','parameter','irrelevant']){
    const changed=variant==='parameter';
    const problem:LatentCensoringProblem={boxes:changed?[[5,3+offset,2],[3,5,3+offset],[4+offset,2,5]]:[[4+offset,4,2],[2,5+offset,4],[5,2+offset,3]],
      prior:changed?[2,3,5]:[3,4,3],cap:5,stopGreen:2,
      signalByLastAndRedParity:changed?[[[1,4],[3,4]],[[2,3],[1,3]],[[4,5],[2,5]]]:[[[4,5],[1,5]],[[1,3],[2,3]],[[3,4],[1,2]]],
      selectByBoxAndLength:family==='noisy_signal'?Array.from({length:3},()=>Array.from({length:6},()=>[1,1] as [number,number])) as LatentCensoringProblem['selectByBoxAndLength']:
        [[[0,1],[0,1],[1,5],[1,3],[1,2],[4,5]],[[0,1],[0,1],[1,2],[1,4],[3,4],[1,3]],[[0,1],[0,1],[2,5],[3,5],[1,4],[2,3]]]};
    latentCensoringReference(problem);const id=opaque({version:LATENT_CENSORING_VERSION,seed,family,variant}),group=opaque({version:LATENT_CENSORING_VERSION,seed,family});
    const task=`这是一个三种隐藏来源、提前停止、带噪观测和记录选择的精确概率实验。颜色下标0/1/2为红/蓝/绿。
1. 只在开始时按prior三个正整数的比例选择盒A/B/C；boxes给出各盒三色球数，此后不换盒。逐球等概率、不放回抽取。
2. 每次抽后检查：累计抽到stopGreen个绿球，或总次数达到cap，立即停止。真实停止长度为T，最后一球颜色为L，已抽红球数为R。
3. 停止后传感器产生信号S的概率为signalByLastAndRedParity[L][R mod 2]；随后档案员以selectByBoxAndLength[盒][T]的概率保留该记录。给定盒、抽取序列后，这两个硬币相互独立。
4. 你只知道“产生S且记录被保留”，不知道盒、T、L、R或序列。随后继续从停止时剩余的同一盒抽球。
求六个精确值：observed_record_probability=P(S且保留)；posterior_box_a=P(A|S且保留)；early_stop_probability=P(T<cap|S且保留)；one_red_drawn_probability=P(R=1|S且保留)；next_red_probability=P(随后第1球红|S且保留)；next_two_same_probability=P(随后两球同色|S且保留)。
可仅返回JSON；若解释，最终答案放在唯一json代码块。键只能是上述六个，值为整数或分数字符串；六项全对才通过。数据：${JSON.stringify(problem)}${variant==='irrelevant'?'\n无关档案字段：本周封皮为紫色，库位编号731，不参与概率过程。':''}`;
    cases.push({id,family,variant,group,problem,question:question(id,'reasoning_math',task)});
  }
  const ordered=shuffle(cases,seed),policy={version:LATENT_CENSORING_VERSION,seed,primary:'six_exact_probabilities',parsing:'whole_json_or_one_json_fence_no_repair',
    aggregation:'equal_family_all_planned_required',relatedVariantsAreIndependent:false,judgeCalls:0,difficultyCalibrated:false,productionEligible:false};
  return {policy,cases:ordered,questions:ordered.map(c=>c.question),contractHash:snapshotHash({policy,cases:ordered})};
}
export function verifyLatentCensoring(c:LatentCensoringCase,output:string){
  const extraction=certificateDiagnostic(output);if(extraction.certificate===null)return {formatValid:false,pass:false,checks:{},extraction};
  const answer=parseAnswer(extraction.certificate);if(!exactKeys(answer,[...FIELDS]))return {formatValid:false,pass:false,checks:{},extraction};
  const reference=latentCensoringReference(c.problem).answer,checks=Object.fromEntries(FIELDS.map(f=>[f,numericEqual(answer[f],reference[f])]));
  return {formatValid:true,pass:Object.values(checks).every(Boolean),checks,extraction,proofCorrectness:'not_inferred'};
}
export function scoreLatentCensoring(pack:ReturnType<typeof buildLatentCensoringProbability>,input:any){
  if(!exactKeys(input,['contractHash','runId','modelId','modelFamily','answers'])||input.contractHash!==pack.contractHash||
    !['runId','modelId','modelFamily'].every(k=>typeof input[k]==='string'&&input[k].trim())||!Array.isArray(input.answers))throw new Error('Invalid submission');
  const answers=new Map<string,any>();
  for(const a of input.answers){if(!exactKeys(a,['id','questionHash','outcome','output'])||typeof a.id!=='string'||answers.has(a.id)||
      !pack.cases.some(c=>c.id===a.id&&c.question.questionHash===a.questionHash)||!['completed','truncated','environment_error'].includes(String(a.outcome))||typeof a.output!=='string')throw new Error('Duplicate/stale/unknown answer');answers.set(a.id,a);}
  const rows=pack.cases.map(c=>{const a=answers.get(c.id),base={id:c.id,family:c.family,group:c.group,variant:c.variant,outputHash:a?snapshotHash(a.output):null};
    if(!a||a.outcome!=='completed')return {...base,state:a?.outcome??'missing',pass:null};
    try{const verification=verifyLatentCensoring(c,a.output);return {...base,state:verification.formatValid?'completed':'unparseable_requires_review',pass:verification.formatValid?verification.pass:null,verification};}
    catch{return {...base,state:'grader_error',pass:null};}});
  const families=[...new Set(rows.map(r=>r.family))].map(family=>{const selected=rows.filter(r=>r.family===family),measured=selected.filter(r=>r.pass!==null),passed=measured.filter(r=>r.pass).length;
    return {family,planned:selected.length,measured:measured.length,passed,score:measured.length===selected.length?100*passed/selected.length:null};});
  return {version:pack.policy.version,contractHash:pack.contractHash,runId:input.runId,modelId:input.modelId,modelFamily:input.modelFamily,rows,families,
    dimensions:[{dimension:'reasoning_math',scope:'latent_censoring_exact_probability_challenge',planned:rows.length,measured:rows.filter(r=>r.pass!==null).length,
      score:families.every(f=>f.score!==null)?families.reduce((s,f)=>s+f.score!,0)/families.length:null,weighting:'equal_family'}],combinedScore:null,judgeCalls:0,productionEligible:false,difficultyCalibrated:false};
}
