/** Multi-claim closed-evidence tasks with authority, version, lineage and causal traps. */
import {snapshotHash} from '../contracts/pack.js';
import {exactKeys} from './challengeTypes.js';
import {certificateDiagnostic} from './certificateDiagnostic.js';
import {parseAnswer} from './methodsV2/verify.js';
import {opaque,question,shuffle,type Question} from './methodsV2/types.js';
type Status='supported'|'refuted'|'insufficient'|'conflict';
export interface EvidenceMatrixGold {id:string;status:Status;sources:string[]}
export interface EvidenceMatrixCase {id:string;family:string;variant:string;group:string;documents:Record<string,string>;claims:Record<string,string>;gold:EvidenceMatrixGold[];question:Question}
export const EVIDENCE_MATRIX_VERSION='evidence-matrix-2026-09-12-v1.2';
const statuses:Status[]=['supported','refuted','insufficient','conflict'];
export function evidenceMatrixReference(c:EvidenceMatrixCase){return {claims:c.gold.map(x=>({id:x.id,status:x.status,sources:[...x.sources]}))};}
function versioned(tag:number,parameter:boolean){
  const documents:Record<string,string>={
    D01:'裁定规则：资格只由HR终版与活动日期共同确定；费用上限只由财务终版确定；部门备忘录不能覆盖终版。只有明示替代才使旧稿失效。缺少付款记录既不证明已付款，也不证明未付款。相互矛盾且无优先关系的同级终版构成冲突。',
    D02:`HR终版H-${tag}：E2合同自1月10日至1月20日有效。本终版明确替代草稿D06。`,D03:'活动签到记录：活动日期为1月15日，申请人为E2。',
    D04:parameter?'财务终版F：E2本次住宿每日适用上限为800元。':'财务终版F：E2本次住宿每日适用上限为600元。',
    D05:parameter?'部门备忘录：建议按600元上限处理。':'部门备忘录：建议按800元上限处理。',D06:'HR草稿：E2合同状态未激活。',
    D07:'酒店账单：E2住宿标价700元；本材料不是付款流水。',D08:'HR终版A：记录显示经理已批准E2申请。',D09:'HR终版B：记录显示经理未批准E2申请；未说明替代D08。'};
  const claims={C1:'活动日当天E2具有申请资格。',C2:'E2本次住宿每日适用上限为800元。',C3:'E2已经实际收到一笔住宿报销款。',C4:'经理已经批准E2申请。'};
  const gold:EvidenceMatrixGold[]=[{id:'C1',status:'supported',sources:['D01','D02','D03']},{id:'C2',status:parameter?'supported':'refuted',sources:['D01','D04']},
    {id:'C3',status:'insufficient',sources:['D01','D07']},{id:'C4',status:'conflict',sources:['D01','D08','D09']}];return {documents,claims,gold};
}
function causal(tag:number,parameter:boolean){
  const documents:Record<string,string>={
    D01:'推断规则：随机对照试验可支持其试验人群内的处理效应；观察相关不能单独证明因果或唯一原因；转述同一上游材料不是独立佐证；未来受控实验不能单独确定缺失记录的历史事件原因。同级独立终版冲突且无优先规则时保留冲突；明示替代的旧稿不再参与当前结论。',
    D02:`随机试验R-${tag}终版：同一目标人群随机分组，处理组错误率10%，对照组20%，流程与失访相同。`,D03:'汇总简报：逐字转述D02的10%与20%，并标注唯一来源为D02。',
    D04:'观察日志：高负载班次同时出现更多告警和更多故障；未做随机化，也未排除设备老化。',D05:'事故当时没有内部温度或原始波形，两种机制均可能。',
    D06:'下周受控实验在新设备上复现响应，只能说明该机制在实验条件下可行。',
    D07:parameter?'独立法证终版A：机制A导致该事故；本终版明确替代D08。':'独立法证终版A：机制A导致该事故。',
    D08:parameter?'法证草稿：机制B导致该事故。':'另一独立法证终版B：机制B导致该事故；与D07同级且无替代关系。'};
  const claims={C1:'在D02的试验目标人群内，处理降低了错误率。',C2:'D02与D03构成两份独立证据。',C3:'高负载是D04中全部故障的唯一原因。',C4:'机制A导致该历史事故。'};
  const gold:EvidenceMatrixGold[]=[{id:'C1',status:'supported',sources:['D01','D02']},{id:'C2',status:'refuted',sources:['D01','D02','D03']},
    {id:'C3',status:'insufficient',sources:['D01','D04']},{id:'C4',status:parameter?'supported':'conflict',sources:parameter?['D01','D07']:['D01','D07','D08']}];return {documents,claims,gold};
}
export function buildEvidenceMatrix(seed=20260912){
  if(!Number.isInteger(seed)||seed<0||seed>0x7fffffff)throw new Error('Invalid seed');const cases:EvidenceMatrixCase[]=[];
  for(const family of ['versioned_authority_graph','causal_lineage_graph'])for(const variant of ['base','parameter','irrelevant']){
    const parameter=variant==='parameter',built=family==='versioned_authority_graph'?versioned(100+seed%800,parameter):causal(100+seed%800,parameter);
    const id=opaque({version:EVIDENCE_MATRIX_VERSION,seed,family,variant}),group=opaque({version:EVIDENCE_MATRIX_VERSION,seed,family});
    const task=`以下是封闭材料。不得使用外部知识，也不得把“未记录”当作反证。对C1-C4分别判断supported/refuted/insufficient/conflict，并按下列机械规则给出材料编号集合：凡使用权限、版本、因果、来源独立性、缺证据或冲突规则，必须含D01；supported/refuted只列D01（若适用）及直接控制结论的当前事实材料，排除被替代、无权和仅转述材料；insufficient列D01及所有表面相关但明确缺少所需观测的材料；conflict列D01及全部相互矛盾且仍有效的控制材料。不得加入其他材料。
只返回JSON对象：{"claims":[{"id":"C1","status":"...","sources":["D.."]},...]}; claims顺序不限，但C1-C4各一次，不得多字段。sources顺序不限，必须恰为最小集合；结论和最小证据均正确才通过该原子，四个原子全通过才算整题通过。
材料：${JSON.stringify(built.documents)}
待判断主张：${JSON.stringify(built.claims)}${variant==='irrelevant'?'\n无关封面信息：装订颜色为蓝色，存储格编号482；不参与任何裁定。':''}`;
    cases.push({id,family,variant,group,...built,question:question(id,'hallucination_resistance',task)});
  }
  const ordered=shuffle(cases,seed),policy={version:EVIDENCE_MATRIX_VERSION,seed,primary:'all_claim_states_and_minimal_evidence',aggregation:'equal_family_all_planned_required',
    format:'one_exact_json_object_no_repair',citationRule:'mechanical_current_controlling_evidence_v1',judgeCalls:0,independentGold:false,difficultyCalibrated:false,productionEligible:false};
  return {policy,cases:ordered,questions:ordered.map(c=>c.question),contractHash:snapshotHash({policy,cases:ordered})};
}
export function verifyEvidenceMatrix(c:EvidenceMatrixCase,output:string){
  const extraction=certificateDiagnostic(output);if(extraction.certificate===null)return {formatValid:false,pass:false,extraction,atoms:[]};
  const value=parseAnswer(extraction.certificate);if(!exactKeys(value,['claims'])||!Array.isArray(value.claims)||value.claims.length!==c.gold.length)return {formatValid:false,pass:false,extraction,atoms:[]};
  const seen=new Set<string>(),atoms=value.claims.map((row:any)=>{
    if(!exactKeys(row,['id','status','sources'])||typeof row.id!=='string'||seen.has(row.id)||!statuses.includes(String(row.status) as Status)||!Array.isArray(row.sources)||
      row.sources.some((x:unknown)=>typeof x!=='string')||new Set(row.sources).size!==row.sources.length)return {id:typeof row.id==='string'?row.id:'?',statusPass:false,sourcesPass:false,pass:false};
    seen.add(row.id);const gold=c.gold.find(x=>x.id===row.id);if(!gold)return {id:row.id,statusPass:false,sourcesPass:false,pass:false};
    const sourcesPass=[...row.sources].sort().join('|')===[...gold.sources].sort().join('|'),statusPass=row.status===gold.status;return {id:row.id,statusPass,sourcesPass,pass:statusPass&&sourcesPass};});
  const formatValid=seen.size===c.gold.length&&c.gold.every(g=>seen.has(g.id));return {formatValid,pass:formatValid&&atoms.every(a=>a.pass),extraction,atoms};
}
export function scoreEvidenceMatrix(pack:ReturnType<typeof buildEvidenceMatrix>,input:any){
  if(!exactKeys(input,['contractHash','runId','modelId','modelFamily','answers'])||input.contractHash!==pack.contractHash||!Array.isArray(input.answers))throw new Error('Invalid submission');const answers=new Map<string,any>();
  for(const a of input.answers){if(!exactKeys(a,['id','questionHash','outcome','output'])||typeof a.id!=='string'||answers.has(a.id)||!pack.cases.some(c=>c.id===a.id&&c.question.questionHash===a.questionHash)||
      !['completed','truncated','environment_error'].includes(String(a.outcome))||typeof a.output!=='string')throw new Error('Duplicate/stale/unknown answer');answers.set(a.id,a);}
  const rows=pack.cases.map(c=>{const a=answers.get(c.id),base={id:c.id,family:c.family,group:c.group,variant:c.variant,outputHash:a?snapshotHash(a.output):null};if(!a||a.outcome!=='completed')return {...base,state:a?.outcome??'missing',pass:null};
    try{const verification=verifyEvidenceMatrix(c,a.output);return {...base,state:verification.formatValid?'completed':'unparseable_requires_review',pass:verification.formatValid?verification.pass:null,verification};}catch{return {...base,state:'grader_error',pass:null};}});
  const families=[...new Set(rows.map(r=>r.family))].map(family=>{const selected=rows.filter(r=>r.family===family),measured=selected.filter(r=>r.pass!==null),passed=measured.filter(r=>r.pass).length;return {family,planned:selected.length,measured:measured.length,passed,score:measured.length===selected.length?100*passed/selected.length:null};});
  return {version:pack.policy.version,contractHash:pack.contractHash,runId:input.runId,modelId:input.modelId,modelFamily:input.modelFamily,rows,families,
    dimensions:[{dimension:'hallucination_resistance',scope:'closed_multi_claim_evidence_matrix',planned:rows.length,measured:rows.filter(r=>r.pass!==null).length,
      score:families.every(f=>f.score!==null)?families.reduce((s,f)=>s+f.score!,0)/families.length:null,weighting:'equal_family'}],combinedScore:null,judgeCalls:0,independentGold:false,difficultyCalibrated:false,productionEligible:false};
}
