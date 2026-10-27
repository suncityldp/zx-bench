import {execAsync, type AsyncExecResult} from './execAsync.js';
export type InspectFailureKind='empty-output'|'invalid-json'|'invalid-state'|'nonzero-status'|'timeout'|'exec-error'|'state-conflict'|'budget-exhausted';
export async function inspectContainerState(name:string,budgetMs:number,dependencies={exec:execAsync,now:()=>performance.now(),sleep:(ms:number)=>new Promise<void>(r=>setTimeout(r,ms))}) {
 const budget=Number.isFinite(budgetMs)?Math.max(0,Math.min(8000,Math.floor(budgetMs))):0,start=dependencies.now();
 const timing=()=>{const elapsedMs=Math.max(0,Math.ceil(dependencies.now()-start));return {elapsedMs,budgetExceeded:elapsedMs>budget};};
 let result:AsyncExecResult={status:null,stdout:'',stderr:''};
 let kind:InspectFailureKind=budget>0?'empty-output':'budget-exhausted';let attempts=0;
 const history:{status:number|null;kind:InspectFailureKind|null;errorCode:'ETIMEDOUT'|'ENOBUFS'|'ENOENT'|'EACCES'|'OTHER'|null;timeoutMs:number}[]=[];
 for(let i=0;i<3;i++){
  if(i){const delay=i===1?100:250;if(dependencies.now()-start+delay>=budget)break;await dependencies.sleep(delay);}
  const remaining=Math.floor(budget-(dependencies.now()-start));if(remaining<=0)break;
  result=await dependencies.exec('docker',['inspect','--format','{{json .State}}',name],{timeout:remaining,maxBuffer:65536});attempts++;
  const code=result.error?.code;const errorCode=code?(['ETIMEDOUT','ENOBUFS','ENOENT','EACCES'].includes(code)?code as 'ETIMEDOUT'|'ENOBUFS'|'ENOENT'|'EACCES':'OTHER'):null;
  let state:any;
  if(result.error)kind=code==='ETIMEDOUT'?'timeout':'exec-error';
  else if(result.status!==0)kind='nonzero-status';
  else if(!result.stdout.trim())kind='empty-output';
  else {try{state=JSON.parse(result.stdout);kind='invalid-state';}catch{kind='invalid-json';}}
  if(state&&typeof state==='object'&&!Array.isArray(state)&&typeof state.Error==='string'){
   const conflict=!!state.Error||typeof state.StartedAt!=='string'||!state.StartedAt||state.StartedAt.startsWith('0001-');
   if(conflict||(!result.error&&result.status===0)){
    history.push({status:result.status,kind:conflict?'state-conflict':null,errorCode,timeoutMs:remaining});
    return {available:!conflict,kind:conflict?'state-conflict' as const:undefined,result,history,attempts,budgetMs:budget,...timing()};
   }
  }
  history.push({status:Number.isSafeInteger(result.status)?result.status:null,kind,errorCode,timeoutMs:remaining});
 }
 return {available:false,kind,result,history,attempts,budgetMs:budget,...timing()};
}
