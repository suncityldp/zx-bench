import {DatabaseSync} from 'node:sqlite';
import {createHash,createDecipheriv,scryptSync} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,existsSync,renameSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {snapshotHash} from '../contracts/pack.js';
import {assessAtomicAudit} from '../evaluationLab/atomicJudge.js';
import {parseAnchoredAudit,anchoredJudgeFixtures,ANCHORED_JUDGE_INSTRUCTIONS,anchoredPublicItem} from '../evaluationLab/anchoredAtomicJudge.js';
import {judgeStreamOnce} from '../evaluationLab/judgeStreamOnce.js';
const root=fileURLToPath(new URL('../../../../',import.meta.url)),[mode,target,id,execute]=process.argv.slice(2);
if(!target)throw new Error('Usage: --prepare NEW_DIR | --call DIR NN --execute');
const dir=resolve(root,target),read=(p:string)=>JSON.parse(readFileSync(join(dir,p),'utf8'));
const save=(p:string,v:unknown)=>{const dest=join(dir,p);writeFileSync(dest+'.tmp',JSON.stringify(v,null,2)+'\n');renameSync(dest+'.tmp',dest);};
const sources=['anchoredAtomicJudge.ts','verifiedAtomicJudge.ts','atomicJudge.ts','atomicJudgeFixtures.ts','regularPartition.ts','linearOptimizationCertificate.ts','judgeStreamOnce.ts','he001JudgeTrial.ts','challengeTypes.ts','methodsV2/types.ts','methodsV2/verify.ts'].map(n=>'packages/core/src/evaluationLab/'+n).concat(['packages/core/src/contracts/pack.ts','packages/core/src/scripts/flash-judge-holdout.ts']);
const hashes=Object.fromEntries(sources.map(p=>[p,createHash('sha256').update(readFileSync(join(root,p))).digest('hex')]));
const modelId='a6696c05-df59-428e-a073-c8ce0ee81a21',modelName='deepseek-v4-flash',displayName='deepseek-v4-pro-tencnet';
const params={max_tokens:32768,temperature:1,reasoning_effort:'max',stream:true,stream_options:{include_usage:true}};
const version='flash-anchored-judge-holdout-2026-09-12-v1',fixtures=()=>anchoredJudgeFixtures().filter(f=>f.split==='holdout');
const config=()=>{const db=new DatabaseSync(join(root,'apps/data/zxbench.db'),{readOnly:true});const row=db.prepare('SELECT name,displayName,baseUrl,apiKey FROM ModelConfig WHERE id=?').get(modelId) as any;db.close();
  if(row?.name!==modelName||row.displayName!==displayName||!row.apiKey)throw new Error('Selected Flash Judge configuration missing or changed');
  const endpoint=new URL(row.baseUrl.replace(/\/$/,'')+'/chat/completions');if(endpoint.href!=='https://tokenhub.tencentmaas.com/v1/chat/completions'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw new Error('Unexpected endpoint');return {...row,endpoint:endpoint.href};};
const decrypt=(s:string)=>{const [iv,data]=s.split(':');if(!iv||!data)return s;const d=createDecipheriv('aes-256-cbc',scryptSync(process.env.ZXBENCH_ENCRYPTION_KEY||'zxbench-default-key-change-me!','zxbench-salt',32),Buffer.from(iv,'hex'));return d.update(data,'hex','utf8')+d.final('utf8');};
if(mode==='--prepare'&&!id&&!execute){
  if(existsSync(dir))throw new Error('Do not overwrite trial');config();const gold=fixtures(),plan=[];
  for(let i=0;i<gold.length;i+=2)plan.push({id:String(plan.length+1).padStart(2,'0'),itemIds:gold.slice(i,i+2).map(f=>f.item.id)});
  const inputs={instructions:ANCHORED_JUDGE_INSTRUCTIONS,items:gold.map(f=>anchoredPublicItem(f.item)),plan};mkdirSync(join(dir,'coordinator'),{recursive:true});
  save('coordinator/fixtures.json',gold);save('inputs.json',inputs);save('calls.json',[]);save('manifest.json',{version,createdAt:new Date().toISOString(),modelId,modelName,displayName,
    params,perCallTimeoutMs:1200000,maxCalls:6,itemsPerCall:2,retries:0,concurrency:1,sourceHashes:hashes,inputsHash:snapshotHash(inputs),fixturesHash:snapshotHash(gold),
    independentGold:false,productionEligible:false,authorizationContext:'Persistent user goal requires the currently configured Judge to run effectively; execution remains separate from the authorized 28 candidate calls.',
    rule:'Frozen holdout only. Each call must complete and then receive a reason/span/source review before the next call. Any mismatch stops.'});
  save('status.json',{state:'prepared',active:null,pid:null,finished:0,maxCalls:6,apiCalls:0});console.log(JSON.stringify({dir,modelName,items:12,maxCalls:6,apiCalls:0}));
}else if(mode==='--call'&&/^\d\d$/.test(id??'')&&execute==='--execute'){
  const manifest=read('manifest.json'),inputs=read('inputs.json'),gold=read('coordinator/fixtures.json'),calls=read('calls.json');
  if(existsSync(join(dir,'STOP'))||snapshotHash(manifest.sourceHashes)!==snapshotHash(hashes)||snapshotHash(inputs)!==manifest.inputsHash||snapshotHash(gold)!==manifest.fixturesHash||
      snapshotHash(fixtures())!==manifest.fixturesHash||snapshotHash(params)!==snapshotHash(manifest.params))throw new Error('Stopped or frozen inputs changed');
  if(calls.length>=6||inputs.plan[calls.length]?.id!==id||calls.some((c:any)=>c.status!=='all_labels_match'))throw new Error('Wrong call order or prior failure');
  for(const c of calls){if(snapshotHash(read(`${c.id}-raw.json`))!==c.rawHash)throw new Error('Historical raw changed');const review=read(`${c.id}-review.json`);
    if(review.rawHash!==c.rawHash||review.decision!=='continue'||review.reasonsSupported!==true||review.segmentsPreserveStance!==true||review.sourceLinksRelevant!==true)throw new Error('Semantic review required');}
  const attempt=join(dir,`${id}-attempt.json`);if(existsSync(attempt))throw new Error('Attempt already exists; inspect process, never retry');
  const lock=join(dir,'active.lock');writeFileSync(lock,JSON.stringify({id,pid:process.pid}),{flag:'wx'});
  try{
    const step=inputs.plan[calls.length],chosen=gold.filter((f:any)=>step.itemIds.includes(f.item.id)),items=chosen.map((f:any)=>anchoredPublicItem(f.item));
    const packet={version,bindingHash:snapshotHash(items),items},cfg=config(),body={model:cfg.name,...params,messages:[{role:'system',content:inputs.instructions},{role:'user',content:JSON.stringify(packet)}]};
    save(`${id}-request.json`,{endpoint:cfg.endpoint,body});writeFileSync(attempt,JSON.stringify({id,pid:process.pid,startedAt:new Date().toISOString(),requestHash:snapshotHash(body),attempt:1}),{flag:'wx'});
    const progress=(p:unknown)=>save('status.json',{state:'running',id,pid:process.pid,active:id,finished:calls.length,maxCalls:6,progress:p,updatedAt:new Date().toISOString()});progress(null);
    const raw=await judgeStreamOnce({endpoint:cfg.endpoint,key:decrypt(cfg.apiKey),body,wireFile:join(dir,`${id}-wire.sse`),stopFile:join(dir,'STOP'),timeoutMs:1200000,onProgress:progress});save(`${id}-raw.json`,raw);
    let status='call_failed',error=raw.error,assessment:unknown=null;
    try{if(raw.error)throw new Error(raw.error);const verdicts=parseAnchoredAudit(items,raw.content,raw.finishReason,raw.streamDone),checked=assessAtomicAudit(chosen,verdicts);assessment=checked;
      save(`${id}-parsed.json`,{verdicts,assessment:checked,semanticReasonsAudited:false});status=checked.allMatch?'all_labels_match':'semantic_mismatch_stop';
    }catch(e){error=e instanceof Error?e.message:'invalid';status=raw.finishReason==='length'?'truncated_stop':'invalid_audit_stop';}
    const result={id,status,error,assessment,rawHash:snapshotHash(raw),latencyMs:raw.latencyMs,usage:raw.usage};calls.push(result);save('calls.json',calls);
    if(status!=='all_labels_match')save('STOP',{id,status,error,automaticRetries:0});
    save('status.json',{state:status==='all_labels_match'?'awaiting_semantic_reason_review':'failure_stop',active:null,pid:null,finished:calls.length,maxCalls:6,productionEligible:false});console.log(JSON.stringify({event:'finished',...result}));
  }finally{unlinkSync(lock);}
}else throw new Error('Usage: --prepare NEW_DIR | --call DIR NN --execute');
