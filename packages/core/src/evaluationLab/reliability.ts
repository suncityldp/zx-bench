export interface TrialPlan { scenarioId:string; family:string; trials:number }
export interface TrialEvent {
  id:string; scenarioId:string; trial:number; protocolHash:string;
  kind:'independent'|'replacement'|'judge_only';
  replaces?:string; candidateHash:string; strictPass:boolean|null;
  environmentError:boolean; modelMs:number; judgeMs:number; outputTokens:number;
}
const ratio=(n:number,d:number)=>d ? n/d : null;

/** Ordered immutable events, explicit replacement links; never score-based dedup. */
export function summarizeReliability(plan:TrialPlan[], events:TrialEvent[]) {
  if (!plan.length || new Set(plan.map(p=>p.scenarioId)).size!==plan.length || plan.some(p=>!p.scenarioId || !p.family || !Number.isInteger(p.trials)||p.trials<1||p.trials>20)) throw new Error('Invalid trial plan');
  const active=new Map<string,TrialEvent>(), seen=new Set<string>();
  if(new Set(events.map(e=>e.protocolHash)).size>1) throw new Error('Mixed execution/benchmark protocols');
  let modelMs=0, judgeMs=0, outputTokens=0;
  for(const event of events) {
    const p=plan.find(p=>p.scenarioId===event.scenarioId);
    if(!p || seen.has(event.id) || !event.id || !event.candidateHash || !/^[a-f0-9]{64}$/.test(event.protocolHash) || !Number.isInteger(event.trial)||event.trial<1||event.trial>p.trials ||
      !['independent','replacement','judge_only'].includes(event.kind) || typeof event.environmentError!=='boolean' ||
      (event.strictPass!==null && typeof event.strictPass!=='boolean') ||
      (event.environmentError && event.strictPass===true) || !Number.isInteger(event.outputTokens) ||
      [event.modelMs,event.judgeMs,event.outputTokens].some(v=>!Number.isFinite(v)||v<0)) throw new Error('Invalid trial event');
    seen.add(event.id);
    const key=JSON.stringify([event.scenarioId,event.trial]), before=active.get(key);
    if(event.kind==='independent') {
      if(before || event.replaces) throw new Error('Duplicate independent trial');
    } else {
      if(!before || event.replaces!==before.id) throw new Error('Missing/stale replacement link');
      if(event.kind==='replacement' && !before.environmentError) throw new Error('Cannot replace a valid model failure');
      if(event.kind==='judge_only' && (event.candidateHash!==before.candidateHash || event.modelMs!==0 || event.outputTokens!==0 || event.environmentError!==before.environmentError)) throw new Error('Judge-only cannot change candidate/execution');
    }
    active.set(key,event);
    modelMs+=event.modelMs; judgeMs+=event.judgeMs; outputTokens+=event.outputTokens;
  }
  const rows=plan.map(p=> {
    const results=Array.from({length:p.trials},(_,i)=>active.get(JSON.stringify([p.scenarioId,i+1])));
    const measured=results.filter(r=>r && !r.environmentError && r.strictPass!==null);
    const passed=measured.filter(r=>r!.strictPass).length;
    return {...p,measured:measured.length,passed,allPassed:measured.length===p.trials && passed===p.trials,
      passRate:ratio(passed,measured.length),complete:measured.length===p.trials};
  });
  const expected=plan.reduce((s,p)=>s+p.trials,0), measured=rows.reduce((s,r)=>s+r.measured,0), passed=rows.reduce((s,r)=>s+r.passed,0);
  const families=[...new Set(plan.map(p=>p.family))].map(family=> {
    const items=rows.filter(r=>r.family===family);
    return {family,complete:items.every(r=>r.complete),allPassed:items.every(r=>r.allPassed),
      // Missing trials do not disappear from the delivery denominator.
      deliveredSuccessRate:items.reduce((s,r)=>s+r.passed/r.trials,0)/items.length};
  });
  return {version:'reliability_shadow_v1',protocolHash:events[0]?.protocolHash??null,expected,measured,passed,coverage:measured/expected,
    measuredSuccessRate:ratio(passed,measured),deliveredSuccessRate:passed/expected,
    allTrialsPassedRate:rows.filter(r=>r.allPassed).length/rows.length,
    familyBalancedDeliveryRate:families.reduce((s,f)=>s+f.deliveredSuccessRate,0)/families.length,
    totalModelMs:modelMs,totalJudgeMs:judgeMs,totalOutputTokens:outputTokens,
    modelMsPerDeliveredSuccess:ratio(modelMs,passed),rows,families,
    note:'No best-of selection. Environment failures/missing judgments are uncovered, not model wrong answers; delivery rate still uses the full planned denominator. No confidence/ranking claim from this pilot.'};
}

export interface AnswerabilityObservation { scenarioId:string; family:string; condition:'sufficient'|'insufficient'|'conflict'|'false_premise'; correct:boolean|null; refused:boolean|null; unsupportedAssertion:boolean|null }
export function summarizeAnswerability(rows:AnswerabilityObservation[]) {
  if(rows.some(r=>!r.scenarioId || !r.family || !['sufficient','insufficient','conflict','false_premise'].includes(r.condition) ||
    [r.correct,r.refused,r.unsupportedAssertion].some(v=>v!==null && typeof v!=='boolean'))) throw new Error('Invalid answerability observation');
  if(new Set(rows.map(r=>r.scenarioId)).size!==rows.length) throw new Error('Duplicate answerability observation');
  const byCondition=Object.fromEntries(['sufficient','insufficient','conflict','false_premise'].map(condition=> {
    const group=rows.filter(r=>r.condition===condition), measured=group.filter(r=>r.correct!==null && r.refused!==null && r.unsupportedAssertion!==null);
    return [condition,{expected:group.length,measured:measured.length,correctRate:ratio(measured.filter(r=>r.correct).length,measured.length),
      refusalRate:ratio(measured.filter(r=>r.refused).length,measured.length),unsupportedAssertionRate:ratio(measured.filter(r=>r.unsupportedAssertion).length,measured.length)}];
  }));
  const groups=[...new Set(rows.map(r=>r.family))].map(family=> {
    const group=rows.filter(r=>r.family===family);
    return {family,complete:new Set(group.map(r=>r.condition)).size===4 && group.length===4 && group.every(r=>r.correct!==null && r.refused!==null && r.unsupportedAssertion!==null),
      allPassed:group.length===4 && new Set(group.map(r=>r.condition)).size===4 && group.every(r=>r.correct===true && r.unsupportedAssertion===false)};
  });
  return {byCondition,groups,pairedAllPassedRate:ratio(groups.filter(g=>g.complete&&g.allPassed).length,groups.length)};
}
