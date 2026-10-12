/** Uses the persisted resume epoch, so restarting a watcher cannot hide an incident. */
export function runtimeFault({plan,runStatus,guard,guardStatus,proxy,proxyErrors=[],isAlive,now=Date.now()}){
  if(plan.recoveryInProgress||plan.reportExported)return null;
  const since=Date.parse(plan.resumedAt||plan.startedAt||plan.monitoring?.exceptionNotificationActivatedAt||0);
  const actionable=['running','guard_paused'].includes(plan.status);
  const fresh=proxyErrors.find(e=>(!e.runId||e.runId===plan.runId)&&Date.parse(e.at)>=since);
  if(actionable&&fresh)return {source:'proxy',error:fresh.error};
  if(actionable&&guardStatus?.tripped&&Date.parse(guardStatus.at)>=since)return {source:'guard',error:guardStatus.error};
  if(plan.status==='running'){
    if(guard&&!isAlive(guard.pid))return {source:'guard',error:'Runtime guard process exited unexpectedly'};
    if(proxy&&!isAlive(proxy.pid))return {source:'proxy',error:'Audit proxy process exited unexpectedly'};
    const interval=plan.monitoring?.guardIntervalMs||120000;
    const heartbeat=Math.max(Date.parse(guard?.at||0),Date.parse(guardStatus?.at||0),since);
    if(now-heartbeat>interval+60000)return {source:'guard',error:'Runtime guard heartbeat is stale'};
    if(runStatus==='paused')return {source:'benchmark',error:'Benchmark unexpectedly paused'};
    // Resume replaces an old controller before its fresh worker is fully visible.
    // A terminal snapshot in that bounded transition must be rechecked, not acted
    // on as a permanent stopped run. Real transport/process faults above stay live.
    const resumeTransition=now-Date.parse(plan.resumedAt||0)<15000;
    if(['failed','cancelled'].includes(runStatus)&&!resumeTransition)return {source:'benchmark',error:'Benchmark stopped with status '+runStatus};
  }
  if(plan.reportExportAttempts>=3)return {source:'report',error:'Completed report could not be exported: '+plan.reportExportError};
  if(plan.status==='completed'&&!plan.reportExported&&guard&&!isAlive(guard.pid))return {source:'report',error:'Report exporter exited before the final report was saved'};
  return null;
}
