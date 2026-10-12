import http from 'node:http';
import crypto from 'node:crypto';
import {Transform, pipeline} from 'node:stream';

/** Audited, single-slot HTTP relay. Runtime policy remains in the caller's hooks. */
export function createGuardedInferenceProxy({readPlan,authorize,prepare,health,record,onFailure,
  upstreamTimeoutMs=1800000,maxRequestBytes=100*1024*1024}){
  let owner=null;
  let fault=null;
  const report=(type,event)=>{try{record?.(type,event);return null;}catch(error){return error;}};
  const server=http.createServer(async(req,res)=>{
    const id=crypto.randomUUID();
    let plan,upstream,response,clientClosed=false,terminal=false,claimed=false;
    const release=()=>{if(owner===id)owner=null;};
    const event=extra=>({at:new Date().toISOString(),id,runId:plan?.runId,...extra});
    const cancel=()=>{
      if(terminal)return;
      terminal=true;
      report('cancelled',event({reason:'Client disconnected or cancelled'}));
      upstream?.destroy();response?.destroy();release();
    };
    const fail=error=>{
      if(terminal)return;
      if(clientClosed){cancel();return;}
      terminal=true;
      const incident=event({error:error.message,kind:'inference_transport_failure'});
      // Close admission synchronously, before pause/notification awaits any I/O.
      fault=incident;
      const recordError=report('failure',incident);if(recordError)incident.recordError=recordError.message;
      Promise.resolve().then(()=>onFailure?.(incident,plan)).catch(e=>report('failure-handler',event({error:e.message})));
      upstream?.destroy();response?.destroy();release();
      if(!res.headersSent&&!res.destroyed){res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
      else if(!res.destroyed)res.destroy(error);
    };
    req.on('aborted',()=>{clientClosed=true;cancel();});
    res.on('error',()=>{if(!terminal){clientClosed=true;cancel();}});
    res.on('close',()=>{if(!res.writableFinished){clientClosed=true;cancel();}});
    try{
      plan=readPlan();
      if(req.url==='/health'){
        if(fault){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,fault}));return;}
        const status=await health(plan);
        if(!res.destroyed){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(status));}return;
      }
      if(req.url!=='/v1/chat/completions'||req.method!=='POST'){res.writeHead(404);res.end();return;}
      if(!authorize(req,plan)){res.writeHead(401);res.end();return;}
      if(fault){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Inference gateway paused after a fault'}));return;}
      if(owner!==null){res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Single inference slot occupied'}));return;}
      owner=id;claimed=true;
      const chunks=[];let bytes=0;
      for await(const chunk of req){bytes+=chunk.length;if(bytes>maxRequestBytes)throw Error('Request exceeds audit size limit');chunks.push(chunk);}
      if(clientClosed||terminal){cancel();return;}
      const body=JSON.parse(Buffer.concat(chunks));
      const prepared=await prepare({req,body,plan,id});
      if(clientClosed||terminal){cancel();return;}
      const data=JSON.stringify(prepared.body??body);
      upstream=http.request(prepared.url,{method:'POST',headers:{...prepared.headers,'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),Connection:'close'}},r=>{
        response=r;
        if(clientClosed||terminal){r.destroy();return;}
        if(r.statusCode!==200){fail(Error('Inference backend HTTP '+r.statusCode));return;}
        res.writeHead(200,{'Content-Type':r.headers['content-type']||'application/json','Cache-Control':'no-cache',...prepared.responseHeaders});
        let pending='',meta={},sawDone=false;
        const sse=/text\/event-stream/i.test(r.headers['content-type']||'')||prepared.body?.stream===true||body.stream===true;
        const lineEvent=line=>{
          line=line.trim();if(!line.startsWith('data:'))return;
          if(line.slice(5).trim()==='[DONE]'){sawDone=true;return;}
          try{const item=JSON.parse(line.slice(5));if(item.timings)meta.timings=item.timings;if(item.usage)meta.usage=item.usage;if(item.choices?.[0]?.finish_reason)meta.finishReason=item.choices[0].finish_reason;}catch{}
        };
        const tap=new Transform({transform(chunk,encoding,callback){
          pending+=chunk.toString('utf8');let pos;
          while((pos=pending.indexOf('\n'))>=0){
            const line=pending.slice(0,pos);pending=pending.slice(pos+1);lineEvent(line);
          }
          if(pending.length>1024*1024)pending='';callback(null,chunk);
        },flush(callback){
          if(pending)lineEvent(pending);
          callback(sse&&!sawDone&&!meta.finishReason?Error('Inference SSE ended without DONE or a finish reason'):undefined);
        }});
        // Handle upstream/transform errors before pipeline destroys the downstream.
        // Otherwise its resulting close event can be mistaken for caller cancellation.
        tap.on('error',fail);
        r.on('error',fail);
        r.on('aborted',()=>fail(Error('Inference stream closed before HTTP response completed')));
        pipeline(r,tap,res,error=>{
          if(terminal){release();return;}
          if(error){fail(error);return;}
          if(!r.complete){fail(Error('Incomplete inference HTTP response'));return;}
          const recordError=report('completion',event({preflight:!plan.benchmarkStarted,diagnostic:!!plan.recoveryInProgress,status:200,...meta}));
          if(recordError){fail(Error('Completion audit could not be saved: '+recordError.message));return;}
          terminal=true;
          release();
        });
      });
      upstream.setTimeout(upstreamTimeoutMs,()=>fail(Error('Upstream inference timed out')));
      upstream.on('error',error=>{if(clientClosed)cancel();else fail(error);});
      upstream.end(data);
    }catch(error){
      if(req.url==='/health'){
        if(!res.headersSent&&!res.destroyed){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:error.message}));}
        report('health-error',event({error:error.message}));
      }else fail(error);
    }finally{if(claimed&&terminal)release();}
  });
  server.on('clientError',(_error,socket)=>socket.destroy());
  return {server,state:()=>({owner,fault}),resetAfterVerifiedRecovery:()=>{if(owner!==null)throw Error('Cannot recover an occupied inference slot');fault=null;}};
}
