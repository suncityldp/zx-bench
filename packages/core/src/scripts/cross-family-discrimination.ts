import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {snapshotHash} from '../contracts/pack.js';
import {buildApiControlPlan,API_CONTROL_PROVIDERS,gradeApiControl} from '../evaluationLab/apiControlPlan.js';
import {scoreMethods,type Answer} from '../evaluationLab/methodsV2/score.js';
import {scoreAdaptiveProbability} from '../evaluationLab/adaptiveProbability.js';
import {observedDiscrimination,type ObservedDimensionModel} from '../evaluationLab/observedDiscrimination.js';
const root=fileURLToPath(new URL('../../../../',import.meta.url));
const [evidenceRun,probabilityRun,apiRun,output]=process.argv.slice(2);
if(!output)throw new Error('Usage: LOCAL_EVIDENCE_RUN LOCAL_PROBABILITY_RUN API_RUN NEW_OUTPUT');
const read=(p:string)=>JSON.parse(readFileSync(resolve(root,p),'utf8'));
const plan=buildApiControlPlan(),apiStatus=read(join(apiRun,'status.json'));
assert.deepEqual(apiStatus,{...apiStatus,state:'completed',completed:28,attempted:28,planned:28,judgeCalls:0,productionWrites:false});
const localEvidenceConfig=read(join(evidenceRun,'run/config.json')),localProbabilityConfig=read(join(probabilityRun,'run/config.json'));
assert.deepEqual(localEvidenceConfig.models.map(({key,path,family}:any)=>({key,path,family})),localProbabilityConfig.models.map(({key,path,family}:any)=>({key,path,family})));
assert.equal(read(join(probabilityRun,'audit.json')).explicitAttempts,12);
const local=localEvidenceConfig.models.map((model:any)=>{
  const evidenceSubmission=read(join(evidenceRun,'run',model.key,'submission-008.json'));
  const probabilitySubmission=read(join(probabilityRun,'run',model.key,'submission-006.json'));
  assert.equal(evidenceSubmission.modelId,model.path);assert.equal(probabilitySubmission.modelId,model.path);
  return {model, evidence:scoreMethods(plan.evidence,evidenceSubmission), probability:scoreAdaptiveProbability(plan.probability,probabilitySubmission)};
});
const api=API_CONTROL_PROVIDERS.map(provider=>{
  const audit=read(join(apiRun,`${provider.key}-audit.json`)),answers=read(join(apiRun,provider.key,'answers-014.json')) as Answer[];
  assert.equal(audit.explicitAttempts,14);assert.equal(audit.provider,provider.key);assert.equal(audit.planHash,plan.contractHash);
  return {provider,grade:gradeApiControl(plan,provider.key,`${apiRun}/${provider.key}`,answers)};
});
function observed(dimension:'hallucination_resistance'|'reasoning_math'){
  const localModels:ObservedDimensionModel[]=local.map((x:{model:any;evidence:ReturnType<typeof scoreMethods>;probability:ReturnType<typeof scoreAdaptiveProbability>})=>{const rows=dimension==='hallucination_resistance'?x.evidence.rows:x.probability.rows;
    return {modelId:x.model.path,modelFamily:x.model.family,executionClass:'local_unsloth',rows:rows.filter((r:any)=>r.dimension===dimension||dimension==='reasoning_math').map((r:any)=>({id:r.id,family:r.family,pass:r.pass,state:r.state}))};});
  const apiModels:ObservedDimensionModel[]=api.map(x=>{const rows=dimension==='hallucination_resistance'?x.grade.evidence.rows:x.grade.probability.rows;
    return {modelId:x.provider.requestedModel,modelFamily:x.provider.family,executionClass:'provider_api',rows:rows.filter((r:any)=>r.dimension===dimension||dimension==='reasoning_math').map((r:any)=>({id:r.id,family:r.family,pass:r.pass,state:r.state}))};});
  return observedDiscrimination(dimension,[...localModels,...apiModels]);
}
const result={version:'cross-family-discrimination-2026-09-12-v1',planHash:plan.contractHash,
  hallucinationResistance:observed('hallucination_resistance'),reasoningMath:observed('reasoning_math'),
  sourceAudits:[join(probabilityRun,'audit.json'),...API_CONTROL_PROVIDERS.map(p=>join(apiRun,`${p.key}-audit.json`))].map(path=>({path,hash:snapshotHash(read(path))})),
  conditions:{local:{generation:localProbabilityConfig.generation,load:localProbabilityConfig.load,hardSeconds:localProbabilityConfig.hard_seconds,concurrency:localProbabilityConfig.concurrency},
    api:plan.policy.providers.map(p=>({model:p.requestedModel,parameters:p.parameters,maxTokens:plan.policy.maxTokens,hardSeconds:plan.policy.hardSeconds,concurrency:plan.policy.concurrency}))},
  conclusionsAreDescriptiveNotCausal:true,judgeCalls:0,productionWrites:false,difficultyCalibrated:false,productionEligible:false};
writeFileSync(resolve(root,output),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,hallucination:{models:result.hallucinationResistance.models,signal:result.hallucinationResistance.screeningSignal,separatingItems:result.hallucinationResistance.separatingItems},
  math:{models:result.reasoningMath.models,signal:result.reasoningMath.screeningSignal,separatingItems:result.reasoningMath.separatingItems}}));
