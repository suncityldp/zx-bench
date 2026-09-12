// Offline candidate recovery. Explicit runs only, paused/completed runs only.
// Usage: node src/scripts/replay-environment-results.mjs --run ID [--run ID] --apply
// Optional --allow-rust-preflight-fix permits ONLY the known CP-L4-RS-001 lockfile fix.
// Without --apply this writes a plan, performs no execution and changes no scores.
import { PrismaClient } from '@prisma/client';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash, createDecipheriv, scryptSync } from 'node:crypto';
import { resolve } from 'node:path';
import { decodeScenario } from '../../dist/evaluationSnapshot.js';
import { registerEvaluator, codeRepairEvaluator, projectRepairEvaluator, orchestrateEvaluation,
  verifyBenchmarkPack, snapshotHash, isDockerAvailable, computeDifficultyWeightedDimAvgs,
  computeWeightedTotal, LONG_TASK_WEIGHT, analyzeRunQuality } from '@zxbench/core';
process.loadEnvFile(new URL('../../.env', import.meta.url));
const args=process.argv.slice(2), runIds=args.flatMap((a,i)=>a==='--run'?[args[i+1]]:[]);
const scenarioIds=args.flatMap((a,i)=>a==='--scenario'?[args[i+1]]:[]);
if (!runIds.length || runIds.some(x=>!x||x.startsWith('--'))) throw new Error('Explicit --run ID required');
const apply=args.includes('--apply'), allowRust=args.includes('--allow-rust-preflight-fix');
const p=new PrismaClient();
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const dir=resolve('logs',`environment-replay-${stamp}`);
mkdirSync(dir,{recursive:true});
const save=(name,data)=>writeFileSync(resolve(dir,name),JSON.stringify(data,null,2));
const hash=s=>createHash('sha256').update(s).digest('hex');
const safeModel=row=>({id:row.id,name:row.name,provider:row.provider,baseUrl:row.baseUrl,defaultParams:JSON.parse(row.defaultParams),reasoningModel:row.reasoningModel});
function decrypt(value) {
  if(!value?.includes(':'))return value;
  const [iv,data]=value.split(':');
  const decipher=createDecipheriv('aes-256-cbc',scryptSync(process.env.ZXBENCH_ENCRYPTION_KEY||'zxbench-default-key-change-me!','zxbench-salt',32),Buffer.from(iv,'hex'));
  return decipher.update(data,'hex','utf8')+decipher.final('utf8');
}
async function assertIdle(id) {
  const run=await p.evalRun.findUniqueOrThrow({where:{id}});
  if(!['paused','completed','cancelled','failed'].includes(run.status))throw new Error(`Run must be idle: ${id}`);
  return run;
}
registerEvaluator(codeRepairEvaluator);registerEvaluator(projectRepairEvaluator);
const outcomes=[];
try {
  const defs=(await p.scenarioDefinition.findMany()).map(decodeScenario);
  const targets=[];
  for(const id of runIds) {
    const run=await assertIdle(id), config=JSON.parse(run.config), manifest=JSON.parse(run.manifest||'{}');
    if(manifest.benchmarkPack)verifyBenchmarkPack(manifest.benchmarkPack);
    const rows=await p.scenarioResult.findMany({where:{evalRunId:id,environmentError:true,dimension:'program',...(scenarioIds.length?{scenarioId:{in:scenarioIds}}:{})},orderBy:{scenarioId:'asc'}});
    const judge=config.judgeEnabled?await p.modelConfig.findUnique({where:{id:config.judgeModelConfigId||''}}):null;
    const model=await p.modelConfig.findUniqueOrThrow({where:{id:run.modelConfigId}});
    for(const old of rows) {
      if(!old.modelOutput.trim())throw new Error(`Missing answer: ${old.id}`);
      const metadata=JSON.parse(old.outputMetadata);
      if(metadata.evaluationAudit?.attempts?.length)throw new Error(`Multi-attempt replay requires per-attempt recovery: ${old.id}`);
      let scenario=manifest.benchmarkPack?.scenarios.find(s=>s.id===old.scenarioId)??defs.find(s=>s.id===old.scenarioId);
      if(!scenario||!['code_repair','project_repair'].includes(scenario.grader))throw new Error(`Unsupported scenario: ${old.scenarioId}`);
      if(scenario.requirements?.requiresSandbox)throw new Error('Cannot replay without original sandbox transcript');
      if(scenario.scenarioVersion!==old.scenarioVersion) {
        const rust=allowRust&&scenario.id==='CP-L4-RS-001'&&old.scenarioVersion==='1.2.0'&&scenario.scenarioVersion==='1.2.1'
          &&scenario.requirements?.executionPolicy?.dependencyPreflight?.command==='CARGO_HOME=/tmp/.cargo cargo fetch';
        if(!rust)throw new Error(`Unapproved scenario version drift: ${old.scenarioId}`);
      }
      targets.push({old,scenario,metadata,config,model:safeModel(model),judge});
    }
    // Never include credentials from ModelConfig or execution secrets from manifests.
    save(`${id}-before.json`,{run:{id:run.id,status:run.status,summary:run.summary,reportContent:run.reportContent},results:rows});
  }
  save('plan.json',targets.map(t=>({runId:t.old.evalRunId,resultId:t.old.id,scenarioId:t.scenario.id,oldVersion:t.old.scenarioVersion,
    executionVersion:t.scenario.scenarioVersion,answerSha256:hash(t.old.modelOutput),judge:t.judge?.name??null})));
  console.log(JSON.stringify({mode:apply?'apply':'plan',count:targets.length,artifactDirectory:dir,judges:[...new Set(targets.map(t=>t.judge?.name??'none'))]}));
  if(apply) {
    if(!(await isDockerAvailable()))throw new Error('Docker not ready; no result updated');
    // Consistent full SQLite backup before the first write. Explicit destination, never overwrite.
    await p.$executeRawUnsafe(`VACUUM INTO '${resolve(dir,'before.sqlite').replaceAll("'","''").replaceAll('\\','/')}'`);
    for(const t of targets) {
      await assertIdle(t.old.evalRunId);
      console.log(`REPLAY_START ${t.old.evalRunId} ${t.scenario.id}`);
      const start=new Date().toISOString();
      const r=await orchestrateEvaluation({scenario:t.scenario,modelConfig:t.model,modelParams:t.model.defaultParams,evalConfig:t.config,
        constraints:t.config.constraints,
        judgeOptions:t.judge?{localModel:{...safeModel(t.judge),apiKey:decrypt(t.judge.apiKey)},escalationThreshold:t.config.escalationThreshold??0.85}:undefined,
        savedCandidate:{metadata:t.metadata,response:{content:t.old.modelOutput,reasoningContent:t.old.reasoningContent??undefined,
          finishReason:t.metadata.finishReason||'stop',latencyMs:t.metadata.inferenceMs||0,
          usage:{inputTokens:t.metadata.inputTokens||0,outputTokens:t.metadata.outputTokens||0,totalTokens:(t.metadata.inputTokens||0)+(t.metadata.outputTokens||0)}}}});
      const audit={at:new Date().toISOString(),startedAt:start,originalResultId:t.old.id,answerSha256:hash(t.old.modelOutput),
        originalScenarioVersion:t.old.scenarioVersion,executionScenarioVersion:t.scenario.scenarioVersion,scenarioSnapshotHash:snapshotHash(t.scenario),
        candidateGenerationCalls:0,judgeModelId:t.judge?.id??null,oldScore:t.old.totalScore,newScore:r.totalScore,environmentError:!!r.environmentError};
      save(`${t.old.id}-replay.json`,{audit,scenario:t.scenario,result:r});
      if(r.environmentError){
        // Keep the isolated score, but expose the latest cause rather than showing
        // only a stale pre-recovery error. All previous evidence remains in backup.
        await p.$transaction(async tx=>{
          const liveRun=await tx.evalRun.findUniqueOrThrow({where:{id:t.old.evalRunId}});
          if(liveRun.status==='running'||liveRun.status==='pending')throw new Error('Run resumed during replay; refusing evidence update');
          const live=await tx.scenarioResult.findUniqueOrThrow({where:{id:t.old.id}});
          if(snapshotHash(live)!==snapshotHash(t.old))throw new Error('Result changed concurrently; refusing evidence update');
          await tx.scenarioResult.update({where:{id:t.old.id},data:{humanReviewRequired:true,
            evidence:JSON.stringify([...r.evidence,`SAVED_ANSWER_REPLAY_ENV: ${JSON.stringify(audit)}`]),
            outputMetadata:JSON.stringify({...t.metadata,environmentReplayHistory:[...(t.metadata.environmentReplayHistory||[]),audit]})}});
        });
        outcomes.push({...audit,status:'still_environment_error',scenario:t.scenario.id});save('outcomes.json',outcomes);
        console.log(`REPLAY_ENV ${t.scenario.id}`);continue;
      }
      if(t.config.judgeEnabled&&!r.finalJudge&&!r.evidence.some(e=>e.startsWith('JUDGE_FAILED:'))) {
        r.evidence.push('JUDGE_FAILED: configured Judge unavailable during saved-answer recovery');r.humanReviewRequired=true;
      }
      const updatedMetadata={...t.metadata,evaluationAudit:r.outputMetadata.evaluationAudit,
        environmentReplayHistory:[...(t.metadata.environmentReplayHistory||[]),audit]};
      await p.$transaction(async tx=>{
        const run=await tx.evalRun.findUniqueOrThrow({where:{id:t.old.evalRunId}});
        if(run.status==='running'||run.status==='pending')throw new Error('Run resumed during replay; refusing write');
        const live=await tx.scenarioResult.findUniqueOrThrow({where:{id:t.old.id}});
        if(snapshotHash(live)!==snapshotHash(t.old))throw new Error('Result changed concurrently; refusing overwrite');
        await tx.scenarioResult.update({where:{id:t.old.id},data:{axisScores:JSON.stringify(r.axisScores),axisEvidence:JSON.stringify(r.axisEvidence),
          totalScore:r.totalScore,deterministicScore:r.deterministicScore,judgeScore:r.judgeScore??null,environmentError:false,
          safetyLevel:r.safetyLevel,localJudge:r.localJudge?JSON.stringify(r.localJudge):null,frontierJudge:r.frontierJudge?JSON.stringify(r.frontierJudge):null,
          finalJudge:r.finalJudge?JSON.stringify(r.finalJudge):null,escalated:r.escalated,graderVersion:r.graderVersion,
          evidence:JSON.stringify([...r.evidence,`SAVED_ANSWER_REPLAY: ${JSON.stringify(audit)}`]),outputMetadata:JSON.stringify(updatedMetadata),
          humanReviewRequired:r.humanReviewRequired,scoreHistory:JSON.stringify(r.scoreHistory),verdictHistory:JSON.stringify(r.verdictHistory)}});
        // Preserve generation, reasoning, token metadata, timestamps, original version and runCount.
        const results=await tx.scenarioResult.findMany({where:{evalRunId:run.id}});
        const pack=JSON.parse(run.manifest||'{}').benchmarkPack?.scenarios??defs;
        const dims=computeDifficultyWeightedDimAvgs(results,new Map(pack.map(s=>[s.id,s.difficulty])),
          new Map(pack.filter(s=>s.requirements?.attackLevel).map(s=>[s.id,s.requirements.attackLevel])),
          new Map(pack.filter(s=>s.category?.startsWith('long_task')).map(s=>[s.id,LONG_TASK_WEIGHT])));
        const prior=JSON.parse(run.summary||'{}');
        await tx.evalRun.update({where:{id:run.id},data:{summary:JSON.stringify({...prior,completedScenarios:results.length,
          averageScore:computeWeightedTotal(dims),dimensionAverages:Object.fromEntries(dims),
          passCount:results.filter(s=>!s.environmentError&&s.totalScore>=60).length,
          qualityReport:analyzeRunQuality(results,prior.totalScenarios||results.length),lastEnvironmentReplayAt:audit.at,
          reportNeedsRegeneration:!!run.reportContent})}});
      },{timeout:15000});
      const verified=await p.scenarioResult.findUniqueOrThrow({where:{id:t.old.id}});
      for(const field of ['modelOutput','reasoningContent','startedAt','finishedAt','runCount','scenarioVersion']) {
        if(String(verified[field])!==String(t.old[field]))throw new Error(`Replay changed immutable ${field}`);
      }
      const vm=JSON.parse(verified.outputMetadata);
      for(const [key,value] of Object.entries(t.metadata))if(!['evaluationAudit','environmentReplayHistory'].includes(key)&&JSON.stringify(vm[key])!==JSON.stringify(value))throw new Error(`Metadata changed: ${key}`);
      outcomes.push({...audit,status:r.finalJudge?'rescored':'deterministic_only',scenario:t.scenario.id});
      save('outcomes.json',outcomes);console.log(`REPLAY_DONE ${t.scenario.id} score=${r.totalScore} judge=${r.judgeScore??'pending'}`);
    }
  }
  save('outcomes.json',outcomes);
} finally {await p.$disconnect();}
