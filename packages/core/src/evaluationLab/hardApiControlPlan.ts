import {snapshotHash} from '../contracts/pack.js';
import {API_CONTROL_PROVIDERS,allowedReturnedModel} from './apiControlPlan.js';
import {buildEvidenceMatrix,scoreEvidenceMatrix} from './evidenceMatrix.js';
import {buildLatentCensoringProbability,scoreLatentCensoring} from './latentCensoringProbability.js';
import type {Answer} from './methodsV2/score.js';
export {API_CONTROL_PROVIDERS,allowedReturnedModel};
export function buildHardApiControlPlan(){
  const evidence=buildEvidenceMatrix(20260912),math=buildLatentCensoringProbability(20260912),questions=[...evidence.questions,...math.questions];
  if(questions.length!==12||new Set(questions.map(q=>q.id)).size!==12)throw new Error('Expected six evidence and six math questions');
  const policy={version:'hard-cross-family-api-control-2026-09-12-v1',questionsPerModel:12,maximumRequests:24,maxTokens:90000,hardSeconds:1200,concurrency:1,
    automaticRetries:0,judgeCalls:0,tools:false,providers:API_CONTROL_PROVIDERS,sameDecodingAsPriorApiControl:true,sameRuntimeAsLocal:false,
    developedAfterPriorCeiling:true,oldScoresReplaced:false,combinedScore:null,productionEligible:false};
  return {policy,evidence,math,questions,contractHash:snapshotHash({policy,evidence:evidence.contractHash,math:math.contractHash,questions})};
}
export function hardApiBody(provider:typeof API_CONTROL_PROVIDERS[number],question:ReturnType<typeof buildHardApiControlPlan>['questions'][number]){
  const registered=API_CONTROL_PROVIDERS.find(p=>p.key===provider.key);if(!registered||snapshotHash(provider)!==snapshotHash(registered))throw new Error('Changed provider');
  return {model:provider.requestedModel,messages:question.messages,...provider.parameters,max_tokens:90000,stream:true};
}
export function gradeHardApi(plan:ReturnType<typeof buildHardApiControlPlan>,providerKey:string,runId:string,answers:Answer[]){
  if(snapshotHash(plan)!==snapshotHash(buildHardApiControlPlan()))throw new Error('Modified hard plan');const provider=API_CONTROL_PROVIDERS.find(p=>p.key===providerKey);
  if(!provider||!runId.trim()||answers.some(a=>!plan.questions.some(q=>q.id===a.id)))throw new Error('Unknown provider/run/question');
  const base={runId,modelId:provider.requestedModel,modelFamily:provider.family},evidenceIds=new Set(plan.evidence.cases.map(c=>c.id));
  const evidence=scoreEvidenceMatrix(plan.evidence,{...base,contractHash:plan.evidence.contractHash,answers:answers.filter(a=>evidenceIds.has(a.id))});
  const math=scoreLatentCensoring(plan.math,{...base,contractHash:plan.math.contractHash,answers:answers.filter(a=>!evidenceIds.has(a.id))});
  return {planHash:plan.contractHash,submissionHash:snapshotHash(answers),provider:providerKey,evidence,math,dimensions:[evidence.dimensions[0],math.dimensions[0]],planned:12,recorded:answers.length,
    combinedScore:null,historicalScoresChanged:false,difficultyCalibrated:false,productionEligible:false};
}
