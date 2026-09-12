import {snapshotHash} from '../../contracts/pack.js';
import {exactKeys,object} from '../challengeTypes.js';
import {oracle,verify,type Verification} from './verify.js';
import type {Case,Pack} from './types.js';

type Outcome='completed'|'truncated'|'environment_error';
export interface Answer {id:string;questionHash:string;outcome:Outcome;output:string}
export interface Submission {contractHash:string;runId:string;modelId:string;modelFamily:string;answers:Answer[]}
export interface Row {id:string;family:string;group:string;variant:string;dimension:Case['question']['dimension'];state:Outcome|'missing'|'grader_error';pass:boolean|null;outputHash:string|null;verification?:Verification;goldStatus?:string}
const ratio=(n:number,d:number)=>d?n/d:null;
const mean=(n:number[])=>n.length?n.reduce((a,b)=>a+b,0)/n.length:null;

export function scoreMethods(pack:Pack,input:unknown) {
  if(!exactKeys(input,['contractHash','runId','modelId','modelFamily','answers'])||input.contractHash!==pack.contractHash||
    !['runId','modelId','modelFamily'].every(k=>typeof input[k]==='string'&&String(input[k]).trim().length>0)||!Array.isArray(input.answers))throw new Error('Invalid submission or contract');
  const byId=new Map(pack.cases.map(c=>[c.id,c])),answers=new Map<string,Answer>();
  for(const a of input.answers) {
    if(!exactKeys(a,['id','questionHash','outcome','output'])||typeof a.id!=='string'||!byId.has(a.id)||answers.has(a.id)||
      byId.get(a.id)!.question.questionHash!==a.questionHash||!['completed','truncated','environment_error'].includes(String(a.outcome))||typeof a.output!=='string')throw new Error('Duplicate, stale, unknown or malformed answer record');
    answers.set(a.id,a as unknown as Answer);
  }
  const rows:Row[]=pack.cases.map(c=>{
    const a=answers.get(c.id),base={id:c.id,family:c.family,group:c.group,variant:c.variant,dimension:c.question.dimension,
      outputHash:a?snapshotHash(a.output):null,...(c.kind==='evidence'?{goldStatus:c.gold.status}:{})};
    if(!a||a.outcome!=='completed')return {...base,state:a?.outcome??'missing',pass:null};
    try{const verification=verify(c,a.output);return {...base,state:'completed',pass:verification.pass,verification};}
    catch{return {...base,state:'grader_error',pass:null};}
  });
  const families=[...new Set(rows.map(r=>r.family))].map(family=>{
    const planned=rows.filter(r=>r.family===family),measured=planned.filter(r=>r.pass!==null),passed=measured.filter(r=>r.pass).length;
    return {family,dimension:planned[0].dimension,planned:planned.length,measured:measured.length,passed,
      observedPassRate:ratio(passed,measured.length),score:measured.length===planned.length?100*passed/planned.length:null};
  });
  const dimensions=(['hallucination_resistance','reasoning_math'] as const).map(dimension=>{
    const f=families.filter(f=>f.dimension===dimension);
    return {dimension,planned:f.reduce((s,x)=>s+x.planned,0),measured:f.reduce((s,x)=>s+x.measured,0),
      score:f.length&&f.every(x=>x.score!==null)?mean(f.map(x=>x.score!)):null,weighting:'equal_family' as const};
  });
  const hall=rows.filter(r=>r.goldStatus&&r.pass!==null),valid=hall.filter(r=>r.verification?.formatValid);
  const known=valid.filter(r=>['supported','refuted'].includes(r.goldStatus!)),unknown=valid.filter(r=>['insufficient','conflict'].includes(r.goldStatus!));
  const attempted=valid.filter(r=>['supported','refuted'].includes(r.verification!.status!));
  const errors=attempted.filter(r=>!r.verification!.checks.stance);
  const unnecessary=known.filter(r=>['insufficient','conflict'].includes(r.verification!.status!));
  const unsupported=unknown.filter(r=>['supported','refuted'].includes(r.verification!.status!));
  const groups=[...new Set(rows.map(r=>r.group))].map(group=>{
    const g=rows.filter(r=>r.group===group),b=g.find(r=>r.variant==='base'),n=g.find(r=>r.variant==='irrelevant'),p=g.find(r=>r.variant==='parameter');
    return {group,family:g[0].family,planned:g.length,measured:g.filter(r=>r.pass!==null).length,
      allVariantsPass:g.every(r=>r.pass!==null)?g.every(r=>r.pass):null,
      baseAndIrrelevantPass:b&&n&&b.pass!==null&&n.pass!==null?b.pass&&n.pass:null,
      parameterRegression:b&&p&&b.pass!==null&&p.pass!==null?b.pass&&!p.pass:null,
      note:'paired_diagnostics_not_independent_samples_or_additional_score'};
  });
  return {version:pack.policy.version,contractHash:pack.contractHash,runId:input.runId as string,modelId:input.modelId as string,modelFamily:input.modelFamily as string,
    split:pack.options.split,options:pack.options,rows,families,dimensions,groups,combinedScore:null,judgeCalls:0,productionEligible:false,
    hallucinationDiagnostics:{scope:'observed_measured_items_only_not_full_score',measured:hall.length,validFormat:valid.length,formatFailures:hall.length-valid.length,
      attempted:attempted.length,incorrectAttempts:errors.length,incorrectAmongAttempts:ratio(errors.length,attempted.length),
      answerable:known.length,unnecessaryAbstentions:unnecessary.length,unnecessaryAbstentionRate:ratio(unnecessary.length,known.length),
      unknownOrConflicting:unknown.length,unsupportedCommitments:unsupported.length,unsupportedCommitmentRate:ratio(unsupported.length,unknown.length),
      stanceAccuracy:ratio(valid.filter(r=>r.verification!.checks.stance).length,valid.length),
      jointEvidenceAccuracy:ratio(hall.filter(r=>r.pass).length,hall.length)},
    budgetPolicy:pack.policy.sampling,independentGold:false,difficultyCalibrated:false};
}
export type ScoredRun=ReturnType<typeof scoreMethods>;
/** Screening only: never auto-promotes gold, removes difficult items, or selects model attempts. */
export function difficultyScreen(runs:ScoredRun[]) {
  if(!runs.length)throw new Error('At least one run required');
  if(runs.some(r=>r.split!=='development'))throw new Error('Holdout results cannot be used for difficulty tuning');
  if(runs.some(r=>r.contractHash!==runs[0].contractHash||r.families.some(f=>f.score===null)))throw new Error('Require complete same-contract runs');
  if(new Set(runs.map(r=>r.modelId)).size!==runs.length||new Set(runs.map(r=>r.runId)).size!==runs.length)throw new Error('Choose one explicit run per model; no retry averaging or best-of');
  const distinctDeclaredModelFamilies=new Set(runs.map(r=>r.modelFamily)).size,enough=distinctDeclaredModelFamilies>=3;
  return {scope:'development_screening_only_not_validation',distinctDeclaredModelFamilies,enoughModelFamilies:enough,
    modelFamilyProvenance:'caller_declared_requires_run_manifest_check',independentGold:false,difficultyCalibrated:false,productionEligible:false,
    families:runs[0].families.map(f=>{
      const scores=runs.map(r=>r.families.find(x=>x.family===f.family)!.score!);
      return {family:f.family,scores,spread:Math.max(...scores)-Math.min(...scores),
        screening:!enough?'insufficient_model_families':scores.every(x=>x>=95)?'possible_ceiling':scores.every(x=>x<=5)?'possible_floor':'candidate_for_larger_pilot'};
    }),note:'95/5 are preregistered screening heuristics, not psychometric difficulty estimates. No IID confidence interval over paired variants.'};
}
export function referenceSubmission(pack:Pack):Submission {
  return {contractHash:pack.contractHash,runId:'synthetic-oracle-QA-not-model',modelId:'author-oracle',modelFamily:'synthetic-not-model',
    answers:pack.cases.map(c=>({id:c.id,questionHash:c.question.questionHash,outcome:'completed',output:JSON.stringify(oracle(c))}))};
}
export function assertFrozenPack(value:unknown):asserts value is Pack {
  if(!object(value)||!object(value.options)||!Array.isArray(value.cases)||typeof value.contractHash!=='string')throw new Error('Invalid frozen pack');
}
