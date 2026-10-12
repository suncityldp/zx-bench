/** Observe actual child exit/spawn errors rather than waiting for a health poll. */
export function superviseChild(child,{shouldIgnore,onFailure}){
  return new Promise(resolve=>{
    let handled=false;
    const handle=async(error,code,signal)=>{
      if(handled)return;handled=true;
      try{
        if(shouldIgnore()){resolve({ignored:true,code,signal});return;}
        const incident={at:new Date().toISOString(),error:error?.message||`Audit proxy exited unexpectedly (code ${code}, signal ${signal})`,code,signal,pid:child.pid};
        await onFailure(incident);resolve({incident});
      }catch(error){resolve({handlerError:error.message});}
    };
    child.on('error',error=>{void handle(error);});
    child.on('exit',(code,signal)=>{void handle(undefined,code,signal);});
  });
}
