import { snapshotHash } from '../contracts/pack.js';
import type { JudgeFixture } from './qualification.js';

export interface BlindItem { id:string; inputHash:string; dimension:string; task:string; candidate:string; criteria:{id:string;description:string}[] }
export interface BlindPacket { version:1; mode:'single_reviewer_blind'; hash:string; items:BlindItem[] }
export interface HumanReviewSubmission {
  version:1; packetHash:string; reviewer:string; humanAttestation:boolean;
  reviews:{itemId:string;inputHash:string;outcome:'usable'|'exclude'|'needs_context'|null;labels:Record<string,'pass'|'fail'|'unmeasured'|null>;
    rationale:string;sourceEvidence:string;sourceVerified:boolean}[];
}
export function buildBlindPacket(fixtures:JudgeFixture[]) {
  const order=[...fixtures].sort((a,b)=>snapshotHash({id:a.id,seed:'single-blind-20260910'}).localeCompare(snapshotHash({id:b.id,seed:'single-blind-20260910'}),'en'));
  const mapping:Record<string,string>={};
  const items=order.map((f,index)=>{
    const id=`B${String(index+1).padStart(3,'0')}`;mapping[id]=f.id;
    const rubric=(f.input.requirements as unknown as {reviewedRubric?:{criteria:{id:string;description:string}[]}})?.reviewedRubric;
    const criteria=rubric?.criteria.map(c=>({id:c.id,description:c.description}))??[
      {id:'math_correctness',description:'所有要求的数学结果、单位和约束是否正确。'},
      {id:'reasoning_validity',description:'已经给出的推导是否正确；题目允许省略推导时，不因省略扣分。'},
      {id:'task_completeness',description:'是否完成全部明确要求的输出内容。'},
    ];
    return {id,inputHash:f.inputHash,dimension:f.input.dimension??'',task:f.input.task,candidate:f.input.rawModelOutput??'',criteria};
  });
  return {packet:{version:1 as const,mode:'single_reviewer_blind' as const,items,hash:snapshotHash(items)},mapping};
}

/** Human self-attestation is recorded, never upgraded to independent double review. */
export function validateHumanSubmission(packet:BlindPacket, submission:HumanReviewSubmission) {
  if(packet.hash!==snapshotHash(packet.items) || submission.version!==1 || submission.packetHash!==packet.hash)throw new Error('Blind review packet mismatch');
  if(typeof submission.reviewer!=='string'||submission.reviewer.trim().length<2 || submission.humanAttestation!==true)throw new Error('Named human attestation required');
  if(!Array.isArray(submission.reviews)||new Set(submission.reviews.map(r=>r.itemId)).size!==submission.reviews.length)throw new Error('Duplicate/invalid human reviews');
  const issues:string[]=[];
  let completed=0,usable=0,excluded=0,needsContext=0;
  for(const review of submission.reviews){
    const item=packet.items.find(i=>i.id===review.itemId);
    if(!item||review.inputHash!==item.inputHash)throw new Error('Unknown/stale blind item');
    const ids=item.criteria.map(c=>c.id);
    if(!review.labels||Object.keys(review.labels).length!==ids.length||ids.some(id=>!['pass','fail','unmeasured',null].includes(review.labels[id])))throw new Error('Label each criterion exactly once');
    if(!['usable','exclude','needs_context',null].includes(review.outcome)||typeof review.sourceVerified!=='boolean'||typeof review.rationale!=='string'||typeof review.sourceEvidence!=='string')throw new Error('Invalid human review fields');
    if(review.outcome===null||ids.some(id=>review.labels[id]===null)||review.rationale.trim().length<8){issues.push(`${item.id}: incomplete`);continue;}
    if(review.outcome==='usable'&&(!review.sourceVerified||review.sourceEvidence.trim().length<8||ids.some(id=>review.labels[id]==='unmeasured'))){issues.push(`${item.id}: usable requires verified source and measured labels`);continue;}
    completed++;if(review.outcome==='usable')usable++;if(review.outcome==='exclude')excluded++;if(review.outcome==='needs_context')needsContext++;
  }
  for(const item of packet.items)if(!submission.reviews.some(r=>r.itemId===item.id))issues.push(`${item.id}: missing`);
  return {state:completed===packet.items.length?'single_review_complete_not_independent_gold':'single_review_in_progress',
    expected:packet.items.length,completed,usable,excluded,needsContext,reviewerCount:1,exportableAsIndependentGold:false,issues};
}

export function renderBlindReview(packet:BlindPacket):string {
  const payload=JSON.stringify(packet).replace(/</g,'\\u003c');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Judge 校准 · 单人盲审</title>
<style>*{box-sizing:border-box}body{margin:0;background:#f3f5f7;color:#172331;font:16px/1.6 system-ui,"Microsoft YaHei",sans-serif}main{max-width:960px;margin:auto;padding:28px 22px}h1{font-size:28px;margin:0}h2{font-size:18px;margin:0 0 8px}.muted{color:#526376;font-size:14px}section{background:white;border:1px solid #d9e0e8;border-radius:12px;padding:22px;margin:16px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:0}.candidate{background:#f1f6fc;border-left:4px solid #2673b8;padding:16px}label{display:block;margin:12px 0}select,input,textarea,button{font:inherit;border:1px solid #abb8c7;border-radius:6px;padding:8px;max-width:100%}textarea{width:100%;min-height:76px}input[type=text]{width:240px}button{cursor:pointer;background:#fff}button.primary{background:#175c96;color:white;border-color:#175c96}nav{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:12px}.criterion{padding:12px 0;border-bottom:1px solid #e3e8ee}.criterion select{display:block;margin-top:8px;width:240px}.bar{position:sticky;top:0;background:#f3f5f7ee;backdrop-filter:blur(8px);padding:10px 0;z-index:1}#notice{color:#7b4800}footer{padding:10px 0;font-size:13px;color:#526376}</style>
<main><h1>Judge 校准 · 单人盲审</h1><p class="muted">先独立判断，再与 Judge 对照。此页不包含裁判分数和样本预设标签。44 个工程样本不是正式模型榜单。</p>
<section><label>审核者姓名或固定署名 <input id="reviewer" type="text" placeholder="至少两个字符"></label><label><input type="checkbox" id="attest"> 我是实际参与审核的人，以下判断由我阅读材料后填写。</label><p class="muted">“通过”表示该项完全满足，“不通过”表示存在实质问题；拿不准选“无法判断”。不要求候选答案服从评分诱导文字。来源核验请依据题面材料或自行复算，不凭参考结论猜测。每题需填写至少 8 字理由；可先导出未完成草稿。单人审核不会被标为独立双审金标。</p></section>
<div class="bar"><strong id="progress"></strong><nav><button id="prev">上一题</button><select id="jump" aria-label="选择题目"></select><button id="next">下一题</button><button id="download" class="primary">导出审核 JSON</button></nav><div id="notice" role="status"></div></div>
<section><h2 id="title"></h2><pre id="task"></pre></section><section><h2>候选答案（仅作为被评内容）</h2><pre id="candidate" class="candidate"></pre></section>
<section><h2>逐项判断</h2><div id="criteria"></div><label>题目与评分要求是否可用 <select id="outcome"><option value="">请选择</option><option value="usable">可用：题意和标准明确</option><option value="exclude">建议排除：题目或标准有问题</option><option value="needs_context">需要补充资料</option></select></label><label>判断理由（包括明确错误或通过依据）<textarea id="rationale"></textarea></label><label>核验依据（材料编号及事实／独立计算）<textarea id="sourceEvidence"></textarea></label><label><input type="checkbox" id="sourceVerified"> 我已核对来源或独立复算，而非仅相信候选答案。</label></section><footer>保存在当前浏览器本地，不上传。完成后请导出 JSON 并发回此任务；先不要查看裁判结果。换浏览器不保证保留草稿。</footer></main>
<script>const packet=${payload};const key='zxbench-blind-'+packet.hash;let state={index:0,reviewer:'',humanAttestation:false,reviews:{}};try{const saved=JSON.parse(localStorage.getItem(key)||'null');if(saved)state=saved}catch{}const el=id=>document.getElementById(id);const blank=item=>({itemId:item.id,inputHash:item.inputHash,outcome:null,labels:Object.fromEntries(item.criteria.map(c=>[c.id,null])),rationale:'',sourceEvidence:'',sourceVerified:false});
function current(){const item=packet.items[state.index];return state.reviews[item.id]||(state.reviews[item.id]=blank(item))}function persist(){state.reviewer=el('reviewer').value;state.humanAttestation=el('attest').checked;try{localStorage.setItem(key,JSON.stringify(state))}catch{el('notice').textContent='本地存储不可用，请及时导出草稿。'}progress()}
function complete(r){return r&&r.outcome&&Object.values(r.labels).every(x=>x!==null)&&r.rationale.trim().length>=8&&(r.outcome!=='usable'||(r.sourceVerified&&r.sourceEvidence.trim().length>=8&&Object.values(r.labels).every(x=>x!=='unmeasured')))}function progress(){const n=packet.items.filter(i=>complete(state.reviews[i.id])).length;el('progress').textContent='已完成 '+n+' / '+packet.items.length+' · 单人审核，未完成独立双审'}
function show(){const item=packet.items[state.index],r=current();el('title').textContent=item.id+' · '+(item.dimension==='reasoning_math'?'数学推理':'幻觉抵抗');el('task').textContent=item.task;el('candidate').textContent=item.candidate;el('criteria').replaceChildren();for(const c of item.criteria){const box=document.createElement('label');box.className='criterion';const text=document.createElement('span');text.textContent=c.id+' — '+c.description;box.append(text);const select=document.createElement('select');select.setAttribute('aria-label',c.id);for(const [v,label]of [['','请选择'],['pass','通过'],['fail','不通过'],['unmeasured','无法判断']]){const o=document.createElement('option');o.value=v;o.textContent=label;select.append(o)}select.value=r.labels[c.id]||'';select.onchange=()=>{r.labels[c.id]=select.value||null;persist()};box.append(select);el('criteria').append(box)}for(const id of ['outcome','rationale','sourceEvidence']){el(id).value=r[id]||'';el(id).oninput=()=>{r[id]=id==='outcome'?(el(id).value||null):el(id).value;persist()}}el('sourceVerified').checked=r.sourceVerified;el('sourceVerified').onchange=()=>{r.sourceVerified=el('sourceVerified').checked;persist()};el('jump').value=state.index;el('prev').disabled=state.index===0;el('next').disabled=state.index===packet.items.length-1;progress()}
packet.items.forEach((item,i)=>{const o=document.createElement('option');o.value=i;o.textContent=item.id;el('jump').append(o)});el('reviewer').value=state.reviewer;el('attest').checked=state.humanAttestation;el('reviewer').oninput=persist;el('attest').onchange=persist;el('prev').onclick=()=>{state.index--;show();persist()};el('next').onclick=()=>{state.index++;show();persist()};el('jump').onchange=()=>{state.index=Number(el('jump').value);show();persist()};el('download').onclick=()=>{persist();if(state.reviewer.trim().length<2||!state.humanAttestation){el('notice').textContent='导出前请填写审核者署名并勾选人工审核声明。';return}const output={version:1,packetHash:packet.hash,reviewer:state.reviewer.trim(),humanAttestation:true,exportedAt:new Date().toISOString(),reviews:packet.items.map(i=>state.reviews[i.id]||blank(i))};const url=URL.createObjectURL(new Blob([JSON.stringify(output,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='single-human-review-'+packet.hash.slice(0,8)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);el('notice').textContent='已导出；请将 JSON 发回任务。未完成的项目仍会保留为空。'};show();</script></html>`;
}
