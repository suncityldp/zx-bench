import {snapshotHash} from '../contracts/pack.js';
import {exactKeys} from './challengeTypes.js';

/** A bounded simulator, NOT an assumption about real production causality.
 * Kept outside buildChallengePack and all official dimension scores.
 */
export const EE_VERSION='EE-001-executable-evidence-v0.1';
export type EEWorld={networkCleared:boolean;manualTarget:'none'|'A'|'B'|'C';workerA:boolean;imageA:boolean;workerC:boolean;imageC:boolean};
export const EE_CLAIMS=[
 {id:'c1',text:'三个租户收到 accepted=true，说明三个租户都提交了自动回滚任务。'},
 {id:'c2',text:'租户A在本次窗口内实际应用了自动回滚。'},
 {id:'c3',text:'本次人工修复操作的目标是租户B。'},
 {id:'c4',text:'租户C的工作进程在本次窗口内运行过。'},
 {id:'c5',text:'租户C的回滚镜像在本次窗口内不可用。'},
 {id:'c6',text:'保持本次人工操作和网络变化不变，若只取消A的自动回滚应用，A在窗口末仍会恢复。'},
 {id:'c7',text:'租户C没有恢复，说明它的自动回滚开关当时处于关闭状态。'},
 {id:'c8',text:'对本次三个租户而言，启用自动回滚开关的租户全部恢复。'},
] as const;
export type EEClaimId=typeof EE_CLAIMS[number]['id'];
export const EE_OBSERVATIONS={A:true,B:true,C:false};
export const EE_POLICY={defaultEnabled:false,tenantOverrides:{A:true,C:true}};
const enabled=(tenant:string)=>Object.hasOwn(EE_POLICY.tenantOverrides,tenant)?EE_POLICY.tenantOverrides[tenant as 'A'|'C']:EE_POLICY.defaultEnabled;
export const EE_RUNTIME_SOURCE=`def enabled(tenant):
    return overrides.get(tenant, default_enabled)

def receive(tenant):
    if enabled(tenant):
        enqueue(tenant)
    return {"accepted": True}

def finish_window(tenant, worker_ran, image_usable, manual_target, network_cleared):
    applied = enabled(tenant) and worker_ran and image_usable
    recovered = applied or (manual_target == tenant) or network_cleared
    return recovered`;
export function eeCandidateQuestion(){
 const text=`以下是完整给定机制的隔离模拟，不是实际生产系统的排障题。只按材料判断，不补充程序之外的故障原因或执行路径。

D1｜本次构建中的程序
${EE_RUNTIME_SOURCE}

其中 overrides 和 default_enabled 来自配置；enqueue 总能成功提交任务，不代表工作进程已运行。三个租户各调用 receive 一次。窗口开始前均未恢复；窗口内是否恢复完全由 finish_window 决定。人工操作、网络变化和自动回滚是本模拟中仅有的恢复途径。

D2｜配置
default_enabled = False
overrides = {"A": True, "C": True}
配置在整个窗口内不变，缺少覆盖项时使用默认值。

D3｜接收回执
A、B、C的接口调用均返回 accepted=true。

D4｜窗口末独立观测
A：已恢复；B：已恢复；C：未恢复。观测准确、对应同一窗口。

D5｜执行边界
network_cleared 是三个租户共用的一个布尔值；它为真时同时作用于三个租户。窗口内人工修复至多针对一个租户，manual_target 可为 none、A、B、C。每个租户的 worker_ran、image_usable 均为布尔值；工作进程若运行，也只处理本次已提交的任务。其余执行细节未保存。

请逐条判断以下断言：
${EE_CLAIMS.map(c=>`${c.id}：${c.text}`).join('\n')}

输出一个JSON对象，每项为 {"verdict":"supported"或"refuted"或"undetermined","witnesses":[]}。supported表示所有符合材料的执行情况均使命题为真；refuted表示全部为假；undetermined表示两种情况均存在。不得把没有证明当作已否定。

对于undetermined，给出两个符合全部材料的具体执行情况：第一个使命题为真，第二个使命题为假。每个情况包含 networkCleared、manualTarget、workerA、imageA、workerC、imageC 六个字段，布尔值用true/false，manualTarget用none/A/B/C字符串。B的开关关闭，B的worker/image不影响本模拟结果，无需填写。其余两类的witnesses填空数组。不要求穷举所有情况，也不要求提供内部思维链。`;
 return {id:'EE-001',title:'接收成功、功能启用与实际恢复',track:'executable_evidence_reasoning_experimental',messages:[{role:'system' as const,content:'仅按题内完整模拟机制完成证据断言核验，不使用外部工具。'},{role:'user' as const,content:text}]};
}
export function validEEWorldShape(w:unknown):w is EEWorld{
 return exactKeys(w,['networkCleared','manualTarget','workerA','imageA','workerC','imageC'])&&
  ['none','A','B','C'].includes(String(w.manualTarget))&&typeof w.manualTarget==='string'&&
  ['networkCleared','workerA','imageA','workerC','imageC'].every(k=>typeof w[k]==='boolean');
}
export function eeExecute(w:EEWorld){
 const applied={A:enabled('A')&&w.workerA&&w.imageA,B:false,C:enabled('C')&&w.workerC&&w.imageC};
 return {applied,recovered:{A:applied.A||w.manualTarget==='A'||w.networkCleared,B:w.manualTarget==='B'||w.networkCleared,C:applied.C||w.manualTarget==='C'||w.networkCleared}};
}
export function eeWorldConsistent(w:unknown):w is EEWorld{
 if(!validEEWorldShape(w))return false;
 const r=eeExecute(w).recovered;return r.A===EE_OBSERVATIONS.A&&r.B===EE_OBSERVATIONS.B&&r.C===EE_OBSERVATIONS.C;
}
export function eeWorlds(){
 const result:EEWorld[]=[];
 for(const manualTarget of ['none','A','B','C'] as const)for(let mask=0;mask<32;mask++){
  const [networkCleared,workerA,imageA,workerC,imageC]=Array.from({length:5},(_,i)=>!!(mask&(1<<i)));
  const w={networkCleared,manualTarget,workerA,imageA,workerC,imageC};if(eeWorldConsistent(w))result.push(w);
 }
 if(!result.length)throw new Error('Contradictory question: no admissible execution');
 return result;
}
export function eeClaim(id:EEClaimId,w:EEWorld):boolean{
 const e=eeExecute(w);
 switch(id){
  case 'c1':return ['A','B','C'].every(enabled);
  case 'c2':return e.applied.A;
  case 'c3':return w.manualTarget==='B';
  case 'c4':return w.workerC;
  case 'c5':return !w.imageC;
  case 'c6':return w.manualTarget==='A'||w.networkCleared;
  case 'c7':return !enabled('C');
  case 'c8':return (['A','B','C'] as const).filter(enabled).every(t=>e.recovered[t]);
  default:throw new Error('Unknown claim');
 }
}
export function eeReference(){
 const worlds=eeWorlds();
 return Object.fromEntries(EE_CLAIMS.map(c=>{
  const yes=worlds.filter(w=>eeClaim(c.id,w)),no=worlds.filter(w=>!eeClaim(c.id,w));
  return [c.id,{verdict:yes.length&&no.length?'undetermined':yes.length?'supported':'refuted',witnesses:yes.length&&no.length?[yes[0],no[0]]:[]}];
 }));
}
export function gradeExecutableEvidence(output:string,complete=true){
 const fail=(error:string)=>({id:'EE-001',formatValid:false,strictPass:false,assertionsCorrect:null,certifiedClaims:null,error});
 let answer:unknown;
 try{
  if(output.length>100000)throw new Error('bounded');
  let text=output.trim();const fence=text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);if(fence)text=fence[1];
  answer=JSON.parse(text);
  // Reject duplicate JSON keys (including escaped aliases) instead of last-key wins.
  const stack:{object:boolean;keys:Set<string>;key:boolean}[]=[];
  for(const m of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],]/g)){
   const t=m[0],top=stack.at(-1);if(t==='{'||t==='[')stack.push({object:t==='{',keys:new Set(),key:true});
   else if(t==='}'||t===']')stack.pop();else if(t===','){if(top)top.key=true;}
   else if(top?.object&&top.key){const k=JSON.parse(t);if(top.keys.has(k))throw new Error('duplicate');top.keys.add(k);top.key=false;}
  }
 }catch{return fail('Invalid or duplicate-key JSON');}
 if(!exactKeys(answer,EE_CLAIMS.map(c=>c.id)))return fail('Every claim exactly once');
 const worlds=eeWorlds();const rows=[];
 for(const c of EE_CLAIMS){
  const a=answer[c.id];
  if(!exactKeys(a,['verdict','witnesses'])||!['supported','refuted','undetermined'].includes(String(a.verdict))||!Array.isArray(a.witnesses))return fail('Invalid claim schema');
  const truth=worlds.map(w=>eeClaim(c.id,w));const expected=truth.every(Boolean)?'supported':truth.every(x=>!x)?'refuted':'undetermined';
  const correct=a.verdict===expected;
  const witnessesValid=a.verdict==='undetermined'?a.witnesses.length===2&&eeWorldConsistent(a.witnesses[0])&&eeWorldConsistent(a.witnesses[1])&&eeClaim(c.id,a.witnesses[0])&&!eeClaim(c.id,a.witnesses[1]):a.witnesses.length===0;
  rows.push({id:c.id,assertionCorrect:correct,witnessesValid});
 }
 return {id:'EE-001',formatValid:true,strictPass:complete&&rows.every(r=>r.assertionCorrect&&r.witnessesValid),assertionsCorrect:rows.filter(r=>r.assertionCorrect).length,certifiedClaims:rows.filter(r=>r.assertionCorrect&&r.witnessesValid).length,rows,complete,scope:'formal_simulation_only_not_open_domain_hallucination_score',questionHash:snapshotHash(eeCandidateQuestion())};
}
