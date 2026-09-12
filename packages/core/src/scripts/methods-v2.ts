/** Versioned offline lane: no DB writes, inference or Judge calls. */
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {snapshotHash} from '../contracts/pack.js';
import {buildMethodsPack} from '../evaluationLab/methodsV2/bank.js';
import {VERSION} from '../evaluationLab/methodsV2/types.js';
import {assertFrozenPack,difficultyScreen,referenceSubmission,scoreMethods,type ScoredRun} from '../evaluationLab/methodsV2/score.js';

const usage='Usage: methods-v2 export NEW_DIR development|holdout SEED INSTANCES(1..5) | verify PACK_DIR | grade PACK_DIR SUBMISSION NEW_RESULT | screen NEW_RESULT SCORED_RUN...';
const root=fileURLToPath(new URL('../../../../',import.meta.url)),args=process.argv.slice(2),[mode,target,...rest]=args;
if(!mode||mode==='--help'||mode==='-h'){console.log(usage);process.exit(0);}
const read=(p:string)=>JSON.parse(readFileSync(resolve(root,p),'utf8'));
const codeFiles=['types.ts','bank.ts','verify.ts','score.ts'].map(n=>'packages/core/src/evaluationLab/methodsV2/'+n)
  .concat(['packages/core/src/evaluationLab/challengeTypes.ts','packages/core/src/contracts/pack.ts','packages/core/src/scripts/methods-v2.ts']);
const hashes=Object.fromEntries(codeFiles.map(p=>[p,createHash('sha256').update(readFileSync(join(root,p))).digest('hex')])),codeHash=snapshotHash(hashes);
const save=(p:string,data:unknown)=>writeFileSync(resolve(root,p),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
if(mode==='export'&&rest.length===3) {
  const [split,seed,instances]=rest;
  if(split!=='development'&&split!=='holdout')throw new Error('Specify development or holdout');
  const dir=resolve(root,target);if(existsSync(dir))throw new Error('Never overwrite a frozen export');
  const pack=buildMethodsPack({split,seed:Number(seed),instances:Number(instances)}),input=referenceSubmission(pack),qa=scoreMethods(pack,input);
  if(qa.rows.some(r=>!r.pass))throw new Error('Oracle self-check failed');
  mkdirSync(join(dir,'coordinator'),{recursive:true});
  const publicPack={contractHash:pack.contractHash,questions:pack.cases.map(c=>c.question)};
  save(join(dir,'candidate-questions.json'),publicPack);
  save(join(dir,'coordinator/frozen-pack.json'),pack);
  save(join(dir,'coordinator/reference-QA-not-model.json'),{input,qa});
  save(join(dir,'manifest.json'),{contractHash:pack.contractHash,publicHash:snapshotHash(publicPack),options:pack.options,policy:pack.policy,codeHash,codeFiles:hashes,
    questions:pack.cases.length,createdAt:new Date().toISOString(),oracleSelfChecks:qa.rows.length,modelCalls:0,judgeCalls:0,productionWrites:false});
  save(join(dir,'submission-template.json'),{contractHash:pack.contractHash,runId:'REPLACE',modelId:'REPLACE',modelFamily:'REPLACE_WITH_BASE_MODEL_FAMILY',answers:[]});
  writeFileSync(join(dir,'题面.md'),'# 幻觉抵抗／数学推理方法 v2 · '+split+'\n\n合成封闭材料和精确数学候选题，未校准难度，不是正式模型成绩。无参考答案和成组标签。每题使用独立上下文。\n\n'+pack.cases.map(c=>'## '+c.id+'\n\n'+c.question.messages.map(m=>m.content).join('\n')+'\n').join('\n'),{flag:'wx'});
  console.log(JSON.stringify({dir,questions:pack.cases.length,selfChecks:qa.rows.length,modelCalls:0,judgeCalls:0}));
} else if((mode==='grade'&&rest.length===2)||(mode==='verify'&&rest.length===0)) {
  const dir=resolve(root,target),pack=read(join(dir,'coordinator/frozen-pack.json'));assertFrozenPack(pack);
  const fresh=buildMethodsPack(pack.options),manifest=read(join(dir,'manifest.json')),publicPack=read(join(dir,'candidate-questions.json'));
  if(snapshotHash(pack)!==snapshotHash(fresh)||manifest.contractHash!==pack.contractHash||manifest.codeHash!==codeHash||snapshotHash(manifest.codeFiles)!==snapshotHash(hashes)||
    snapshotHash(publicPack)!==snapshotHash({contractHash:pack.contractHash,questions:pack.cases.map(c=>c.question)})||manifest.publicHash!==snapshotHash(publicPack))throw new Error('Frozen data/code mismatch; export a NEW version instead of silent rescore');
  if(mode==='verify')console.log(JSON.stringify({verified:true,questions:pack.cases.length,contractHash:pack.contractHash,codeHash}));
  else {const result={...scoreMethods(pack,read(rest[0])),codeHash};save(rest[1],result);console.log(JSON.stringify({result:resolve(root,rest[1]),dimensions:result.dimensions,judgeCalls:0}));}
} else if(mode==='screen'&&rest.length>=1) {
  // Re-grade supplied submissions through a verified frozen package using grade first.
  const runs=rest.map(p=>read(p) as ScoredRun);
  if(runs.some(r=>r.version!==VERSION||!Array.isArray(r.families)||!Array.isArray(r.rows)))throw new Error('Not a current v2 score file');
  save(target,difficultyScreen(runs));console.log(JSON.stringify({result:resolve(root,target),productionEligible:false}));
} else throw new Error(usage);
