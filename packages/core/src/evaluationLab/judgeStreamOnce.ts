import {appendFileSync,existsSync} from 'node:fs';
import {postHE001Once} from './he001JudgeTrial.js';
/** Transport-only helper. Exactly one POST; no schema-repair, fallback or retry. */
export async function judgeStreamOnce(options:{endpoint:string;key:string;body:unknown;wireFile:string;stopFile:string;timeoutMs:number;onProgress?:(v:{bytes:number;elapsedMs:number})=>void},post=postHE001Once){
  const start=Date.now(),controller=new AbortController(),abort=()=>controller.abort();let content='',reasoningContent='',finishReason='unknown',streamDone=false,usage:any=null,bytes=0,httpStatus:number|null=null,error:string|null=null;
  process.once('SIGINT',abort);process.once('SIGTERM',abort);
  const timer=setTimeout(abort,options.timeoutMs),ticker=setInterval(()=>{if(existsSync(options.stopFile))abort();options.onProgress?.({bytes,elapsedMs:Date.now()-start});},1000);
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{
    const response=await post(options.endpoint,options.key,options.body,controller.signal);httpStatus=response.status;
    if(!response.ok){await response.body?.cancel();throw new Error('HTTP_'+response.status);}if(!response.body)throw new Error('missing_body');reader=response.body.getReader();
    const decoder=new TextDecoder();let pending='';
    const consume=(line:string)=>{if(!line.startsWith('data:'))return;const text=line.slice(5).trim();if(text==='[DONE]'){streamDone=true;return;}if(!text)return;
      const chunk=JSON.parse(text);if(chunk.error)throw new Error('provider_stream_error');if(chunk.usage)usage=chunk.usage;
      for(const c of chunk.choices??[]){if((c.index??0)!==0)throw new Error('extra_choice');if(c.finish_reason)finishReason=c.finish_reason;const d=c.delta??{};if(d.tool_calls)throw new Error('unexpected_tool_call');
        if(typeof d.content==='string')content+=d.content;const r=d.reasoning_content??d.reasoning;if(typeof r==='string')reasoningContent+=r;}};
    while(!streamDone){const chunk=await reader.read();if(chunk.done){pending+=decoder.decode();if(pending.trim())consume(pending.trim());break;}
      bytes+=chunk.value.byteLength;if(bytes>8000000)throw new Error('response_size_limit');appendFileSync(options.wireFile,chunk.value);pending+=decoder.decode(chunk.value,{stream:true});
      let end:number;while((end=pending.indexOf('\n'))>=0){consume(pending.slice(0,end).replace(/\r$/,''));pending=pending.slice(end+1);}}
  }catch(e){const message=e instanceof Error?e.message:'';error=controller.signal.aborted?'timeout_or_cancelled':/^(HTTP_\d+|missing_body|provider_stream_error|extra_choice|unexpected_tool_call|response_size_limit)$/.test(message)?message:'transport_or_stream_parse_error';}
  finally{clearTimeout(timer);clearInterval(ticker);if(reader)try{await reader.cancel();}catch{}controller.abort();process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
  return {content,reasoningContent,finishReason,streamDone,usage,httpStatus,error,bytes,latencyMs:Date.now()-start};
}
