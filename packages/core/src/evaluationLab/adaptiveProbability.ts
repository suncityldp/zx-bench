/** Small-state reasoning tasks: stopping rules and selection-biased observation, not long arithmetic. */
import {snapshotHash} from '../contracts/pack.js';
import {rational,add,mul,div,fraction,numericEqual,exactKeys,type Rational} from './challengeTypes.js';
import {question,opaque,shuffle,type Question} from './methodsV2/types.js';
import {parseAnswer} from './methodsV2/verify.js';
import {certificateDiagnostic} from './certificateDiagnostic.js';
export interface ProbabilityProblem {boxes:[number[],number[]];priorA:[number,number];cap:number;stopGreen:number;reportByLength:[number,number][]}
export const ADAPTIVE_PROBABILITY_VERSION='adaptive-probability-2026-09-12-v1';
const FIELDS=['report_probability','posterior_a','early_stop_probability','next_red_probability','next_two_same_probability'] as const;
const zero=()=>rational(0n),q=(n:number,d=1)=>rational(BigInt(n),BigInt(d));
export function probabilityReference(p:ProbabilityProblem){
  if(p.boxes.length!==2||p.boxes.some(b=>b.length!==3||b.some(n=>!Number.isInteger(n)||n<0)||b.reduce((s,n)=>s+n,0)<p.cap+2||b.reduce((s,n)=>s+n,0)>12)||p.cap!==4||p.stopGreen!==2||p.reportByLength.length!==5)throw new Error('Unsupported bounded experiment');
  if(p.priorA.length!==2||p.priorA.some(n=>!Number.isInteger(n))||p.priorA[0]<=0||p.priorA[0]>=p.priorA[1]||p.priorA[1]>100||p.reportByLength.some(v=>v.length!==2||!Number.isInteger(v[0])||!Number.isInteger(v[1])||v[1]<=0||v[1]>100||v[0]<0||v[0]>v[1]))throw new Error('Invalid probabilities');
  const totals=Array.from({length:5},zero);let terminalPaths=0;
  p.boxes.forEach((initial,box)=>{
    const prior=box===0?q(...p.priorA):q(p.priorA[1]-p.priorA[0],p.priorA[1]);
    function visit(left:number[],drawn:number[],path:Rational,last:number){
      const t=drawn.reduce((s,n)=>s+n,0);
      if(t===p.cap||drawn[2]===p.stopGreen){
        terminalPaths++;if(drawn[0]!==1||last!==2)return;
        const weight=mul(path,q(...p.reportByLength[t])),n=left.reduce((s,n)=>s+n,0);
        totals[0]=add(totals[0],weight);if(box===0)totals[1]=add(totals[1],weight);if(t<p.cap)totals[2]=add(totals[2],weight);
        totals[3]=add(totals[3],mul(weight,q(left[0],n)));
        totals[4]=add(totals[4],mul(weight,q(left.reduce((s,k)=>s+k*(k-1),0),n*(n-1))));return;
      }
      const n=left.reduce((s,k)=>s+k,0);
      left.forEach((count,color)=>{if(!count)return;const next=[...left],seen=[...drawn];next[color]--;seen[color]++;
        visit(next,seen,mul(path,q(count,n)),color);});
    }
    visit([...initial],[0,0,0],prior,-1);
  });
  if(totals[0][0]===0n)throw new Error('Impossible conditioning event');
  return {answer:Object.fromEntries(FIELDS.map((field,i)=>{const r=i===0?totals[0]:div(totals[i],totals[0]);return [field,fraction(r[0],r[1])];})),terminalPaths};
}
export interface ProbabilityCase {id:string;family:string;variant:string;group:string;problem:ProbabilityProblem;question:Question}
export function buildAdaptiveProbability(seed=20260912){
  if(!Number.isInteger(seed)||seed<0||seed>0x7fffffff)throw new Error('Invalid seed');
  const cases:ProbabilityCase[]=[];
  for(const family of ['stopping_conditioning','observation_selection'])for(const variant of ['base','parameter','irrelevant']){
    const changed=variant==='parameter',offset=seed%3;
    const problem:ProbabilityProblem={boxes:changed?[[3+offset,4,2],[2,3+offset,4]]:[[4+offset,3,2],[2,4+offset,3]],priorA:changed?[3,7]:[2,5],cap:4,stopGreen:2,
      reportByLength:family==='stopping_conditioning'?[[1,1],[1,1],[1,1],[1,1],[1,1]]:[[0,1],[1,5],[1,5],[1,3],[3,4]]};
    const id=opaque({version:ADAPTIVE_PROBABILITY_VERSION,seed,family,variant}),group=opaque({seed,family});
    const task=`这是一个隐藏来源、提前停止和选择性报告的概率实验。颜色下标0/1/2依次为红/蓝/绿；盒内每个球等概率。
1. 开始时只选一次盒子：选择A的概率为priorA[0]/priorA[1]，否则选B；此后不换盒。boxes[0]/boxes[1]给出A/B中三种颜色球的数量。
2. 从所选盒逐个不放回抽球。每次抽后检查：累计抽到stopGreen个绿球，或总抽取次数达到cap，即立即停止。停止后的球留在盒中，不再执行本阶段抽取；已抽出的球不放回。记真实停止长度为T。
3. 只有“已抽出恰好1个红球，且最后一个抽出的球是绿球”时，观察员才有资格发出报告。满足此条件后，还以reportByLength[T][0]/reportByLength[T][1]的概率发出报告，否则保持沉默。该报告硬币在给定T后与其他随机选择独立。不满足资格条件时报告概率为0。
4. 你只知道报告确实发出，不知道盒子、T、完整颜色序列或硬币结果以外的信息。下一次抽取从停止时剩下的同一盒球中进行，仍不放回。
求：report_probability=P(发出报告)；posterior_a=P(选A|发出报告)；early_stop_probability=P(T<cap|发出报告)；next_red_probability=P(随后第1球红|发出报告)；next_two_same_probability=P(随后连续两球颜色相同|发出报告)。
可仅返回JSON对象；若附解释，最终答案须放在唯一的json代码块中，不另给第二份JSON答案。键为上述五个名称，数值为精确整数或分数字符串。五个答案独立逐项核验，全部正确才算整题精确答案通过。无法明确提取答案时记为待审而非数学零分；附加证明正确性单独记录，不由文字长度决定数学分数。
数据：${JSON.stringify(problem)}${variant==='irrelevant'?'\n档案管理信息：本月有37份登记单，封面编号908。这些字段不参与实验。':''}`;
    probabilityReference(problem);cases.push({id,family,variant,group,problem,question:question(id,'reasoning_math',task)});
  }
  const ordered=shuffle(cases,seed),policy={version:ADAPTIVE_PROBABILITY_VERSION,seed,primary:'exact_five_probability_answers_not_general_proof_grade',
    parsing:'whole_json_or_one_explicit_json_fence_no_syntax_repair_no_best_of',unparseable:'unmeasured_requires_review_not_zero_or_dropped_from_denominator',extraProse:'separate_semantic_review_not_silently_accepted_as_correct_proof',
    aggregation:'equal_family_all_planned_required',difficultyCalibrated:false,productionEligible:false,judgeCalls:0};
  return {policy,cases:ordered,questions:ordered.map(c=>c.question),contractHash:snapshotHash({policy,cases:ordered})};
}
export function verifyAdaptiveProbability(c:ProbabilityCase,output:string){
  const extraction=certificateDiagnostic(output);if(extraction.certificate===null)return {formatValid:false,pass:false,extraction,checks:{}};
  const v=parseAnswer(extraction.certificate);if(!exactKeys(v,[...FIELDS]))return {formatValid:false,pass:false,extraction,checks:{}};
  const reference=probabilityReference(c.problem).answer,checks=Object.fromEntries(FIELDS.map(f=>[f,numericEqual(v[f],reference[f])]));
  return {formatValid:true,pass:Object.values(checks).every(Boolean),extraction,checks,proofCorrectness:'not_inferred_from_final_answer'};
}
export function scoreAdaptiveProbability(pack:ReturnType<typeof buildAdaptiveProbability>,input:unknown){
  if(!exactKeys(input,['contractHash','runId','modelId','modelFamily','answers'])||input.contractHash!==pack.contractHash||!['runId','modelId','modelFamily'].every(k=>typeof input[k]==='string'&&String(input[k]).trim())||!Array.isArray(input.answers))throw new Error('Invalid submission');
  const answers=new Map<string,any>();
  for(const a of input.answers){if(!exactKeys(a,['id','questionHash','outcome','output'])||typeof a.id!=='string'||answers.has(a.id)||!pack.cases.some(c=>c.id===a.id&&c.question.questionHash===a.questionHash)||!['completed','truncated','environment_error'].includes(String(a.outcome))||typeof a.output!=='string')throw new Error('Duplicate/stale/unknown answer');answers.set(a.id,a);}
  const rows=pack.cases.map(c=>{const a=answers.get(c.id),base={id:c.id,family:c.family,group:c.group,variant:c.variant,outputHash:a?snapshotHash(a.output):null};
    if(!a||a.outcome!=='completed')return {...base,state:a?.outcome??'missing',pass:null};
    try{const verification=verifyAdaptiveProbability(c,a.output);return {...base,state:verification.formatValid?'completed':'unparseable_requires_review',pass:verification.formatValid?verification.pass:null,verification};}catch{return {...base,state:'grader_error',pass:null};}});
  const families=[...new Set(rows.map(r=>r.family))].map(family=>{const f=rows.filter(r=>r.family===family),measured=f.filter(r=>r.pass!==null),passed=f.filter(r=>r.pass).length;return {family,planned:f.length,measured:measured.length,passed,score:measured.length===f.length?100*passed/f.length:null};});
  return {version:pack.policy.version,contractHash:pack.contractHash,runId:input.runId,modelId:input.modelId,modelFamily:input.modelFamily,rows,families,
    dimensions:[{dimension:'reasoning_math',scope:'exact_probability_answer_pilot_not_general_proof_score',planned:rows.length,measured:rows.filter(r=>r.pass!==null).length,
      score:families.every(f=>f.score!==null)?families.reduce((s,f)=>s+f.score!,0)/families.length:null,weighting:'equal_family'}],
    combinedScore:null,judgeCalls:0,productionEligible:false,difficultyCalibrated:false};
}
