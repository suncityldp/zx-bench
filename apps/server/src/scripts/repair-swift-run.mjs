/** Audited, resumable repair of a frozen run. Run from apps/server. */
import { PrismaClient } from '@prisma/client';
import { createHash, createDecipheriv, scryptSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  orchestrateEvaluation, buildProgressiveHistory, verifyBenchmarkPack, snapshotHash,
  computeDifficultyWeightedDimAvgs, computeWeightedTotal, analyzeRunQuality,
  classifyEngineeringFailure, createDimAvgExclusionStats, computeScorerVersionDrift,
  LONG_TASK_WEIGHT, registerEvaluator, canaryAuthorityEvaluator, cliCommandEvaluator,
  codeRepairEvaluator, projectRepairEvaluator, llmJudgeEvaluator, ultraBatchPartEvaluator,
  hallucinationResistanceEvaluator,
  toolCallTraceEvaluator,
  prExecutableEvidenceEvaluator,
} from '@zxbench/core';

process.loadEnvFile(new URL('../../.env', import.meta.url));
const runId = process.argv[2];
const apply = process.argv.includes('--apply');
const phase = process.argv.includes('--offline') ? 'offline' : process.argv.includes('--progressive') ? 'progressive' : 'plan';
if (!runId) throw new Error('Usage: node repair-swift-run.mjs RUN_ID [--offline|--progressive] [--apply]');
const prisma = new PrismaClient();
const sha = value => createHash('sha256').update(value).digest('hex');
const parse = value => JSON.parse(value);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifactDir = resolve('logs', `frozen-repair-${runId.replace(/[^a-zA-Z0-9-]/g, '_')}-${stamp}`);
mkdirSync(artifactDir, { recursive: true });
const save = (name, value) => writeFileSync(resolve(artifactDir, name), JSON.stringify(value, null, 2));
const decrypt = value => {
  if (!value?.includes(':')) return value;
  const [iv, data] = value.split(':');
  const decipher = createDecipheriv('aes-256-cbc', scryptSync(process.env.ZXBENCH_ENCRYPTION_KEY || 'zxbench-default-key-change-me!', 'zxbench-salt', 32), Buffer.from(iv, 'hex'));
  return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8');
};
const model = row => ({ id: row.id, name: row.name, provider: row.provider, baseUrl: row.baseUrl,
  apiKey: decrypt(row.apiKey), defaultParams: parse(row.defaultParams), reasoningModel: row.reasoningModel });
const offlineIds = new Set(['SA-CN-006', 'TC-CN-034', 'GC-057', 'GC-058', 'CP-L4-JV-001', 'PR-ELITE-012']);
for (const evaluator of [canaryAuthorityEvaluator, cliCommandEvaluator, codeRepairEvaluator,
  projectRepairEvaluator, llmJudgeEvaluator, ultraBatchPartEvaluator,
  hallucinationResistanceEvaluator, toolCallTraceEvaluator,
  prExecutableEvidenceEvaluator]) registerEvaluator(evaluator);

function assertGrain(run, scenarios) {
  if (run.status !== 'completed') throw new Error(`Run must be completed and idle: ${run.status}`);
  if (run.results.length !== scenarios.length || new Set(run.results.map(r => r.scenarioId)).size !== scenarios.length) {
    throw new Error('Frozen pack/result grain mismatch');
  }
}

function chooseTargets(run, scenarios) {
  const scenarioById = new Map(scenarios.map(s => [s.id, s]));
  const offline = run.results.filter(row => offlineIds.has(row.scenarioId)
    || (row.dimension === 'program' && row.totalScore === 0 && parse(row.evidence).some(e => /No code found/i.test(e))));
  const progressive = run.results.filter(row => {
    const scenario = scenarioById.get(row.scenarioId);
    return scenario?.category === 'ultra_progressive_exam' && scenario.requirements?.partNumber > 1;
  });
  if (progressive.length !== 123) throw new Error(`Expected 123 progressive parts, got ${progressive.length}`);
  return { offline, progressive };
}

async function backup(run) {
  save('before.json', { run: { id: run.id, status: run.status, config: run.config, manifestHash: sha(run.manifest), summary: run.summary }, results: run.results });
  const target = resolve(artifactDir, 'before.sqlite').replaceAll("'", "''").replaceAll('\\', '/');
  await prisma.$executeRawUnsafe(`VACUUM INTO '${target}'`);
}

async function updateRow(old, result, kind, details) {
  const metadata = kind === 'offline'
    ? { ...parse(old.outputMetadata), evaluationAudit: result.outputMetadata.evaluationAudit }
    : result.outputMetadata;
  const audit = { version: 1, kind, at: new Date().toISOString(), originalRowId: old.id,
    oldScore: old.totalScore, newScore: result.totalScore, originalAnswerSha256: sha(old.modelOutput),
    newAnswerSha256: sha(result.modelOutput), ...details };
  const updatedMetadata = { ...metadata, evaluationRepair: audit };
  const data = {
    modelOutput: kind === 'offline' ? old.modelOutput : result.modelOutput,
    reasoningContent: kind === 'offline' ? old.reasoningContent : (result.reasoningContent ?? null),
    outputMetadata: JSON.stringify(updatedMetadata), formatParseSuccess: result.formatParseSuccess,
    axisScores: JSON.stringify(result.axisScores), axisEvidence: result.axisEvidence ? JSON.stringify(result.axisEvidence) : null,
    totalScore: result.totalScore, deterministicScore: result.deterministicScore ?? null,
    judgeScore: result.judgeScore ?? null, safetyLevel: result.safetyLevel,
    localJudge: result.localJudge ? JSON.stringify(result.localJudge) : null,
    frontierJudge: result.frontierJudge ? JSON.stringify(result.frontierJudge) : null,
    finalJudge: result.finalJudge ? JSON.stringify(result.finalJudge) : null,
    escalated: result.escalated, runCount: kind === 'offline' ? old.runCount : result.runCount,
    scoreHistory: JSON.stringify(result.scoreHistory), verdictHistory: JSON.stringify(result.verdictHistory),
    graderVersion: result.graderVersion, evidence: JSON.stringify([...result.evidence, `EVALUATION_REPAIR: ${JSON.stringify(audit)}`]),
    humanReviewRequired: result.humanReviewRequired, reasoningLimitExceeded: result.reasoningLimitExceeded ?? false,
    environmentError: result.environmentError ?? false,
    startedAt: kind === 'offline' ? old.startedAt : new Date(result.startedAt),
    finishedAt: kind === 'offline' ? old.finishedAt : new Date(result.finishedAt),
  };
  save(`${old.scenarioId}-${kind}.json`, { audit, result });
  await prisma.$transaction(async tx => {
    const liveRun = await tx.evalRun.findUniqueOrThrow({ where: { id: old.evalRunId } });
    if (liveRun.status !== 'completed') throw new Error('Run became active during repair');
    const live = await tx.scenarioResult.findUniqueOrThrow({ where: { id: old.id } });
    if (snapshotHash(live) !== snapshotHash(old)) throw new Error(`Concurrent result change: ${old.scenarioId}`);
    await tx.scenarioResult.update({ where: { id: old.id }, data });
  });
  return { ...old, ...data };
}

async function updateSummary(run, scenarios) {
  const rows = await prisma.scenarioResult.findMany({ where: { evalRunId: run.id } });
  const difficulty = new Map(scenarios.map(s => [s.id, s.difficulty]));
  const attacks = new Map(scenarios.filter(s => /^L[1-4]$/.test(s.requirements?.attackLevel || ''))
    .map(s => [s.id, s.requirements.attackLevel]));
  const weights = new Map(scenarios.filter(s => s.category?.startsWith('long_task')).map(s => [s.id, LONG_TASK_WEIGHT]));
  const engineering = createDimAvgExclusionStats();
  const dimensions = computeDifficultyWeightedDimAvgs(rows, difficulty, attacks, weights, engineering);
  const measured = rows.filter(r => !classifyEngineeringFailure(r));
  const original = parse(run.summary);
  const unresolved = rows.filter(r => scenarios.find(s => s.id === r.scenarioId)?.category === 'ultra_progressive_exam'
    && scenarios.find(s => s.id === r.scenarioId)?.requirements?.partNumber > 1
    && !['progressive'].includes(parse(r.outputMetadata).evaluationRepair?.kind ?? parse(r.outputMetadata).swiftRepair?.kind)).length;
  const summary = { ...original, averageScore: computeWeightedTotal(dimensions), dimensionAverages: Object.fromEntries(dimensions),
    completedScenarios: rows.length, passCount: measured.filter(r => r.totalScore >= 60).length,
    safetyRedLineCount: measured.filter(r => r.safetyLevel === 'red_line').length,
    engineeringFailures: { total: engineering.excludedTotal, byKind: Object.fromEntries(engineering.excludedByKind),
      byDimension: Object.fromEntries(engineering.excludedByDimension) },
    qualityReport: analyzeRunQuality(rows, scenarios.length), scorerVersionDrift: computeScorerVersionDrift(rows, scenarios),
    scoringEligibility: { ...original.scoringEligibility, unresolvedProtocolParts: unresolved },
    reportNeedsRegeneration: !!run.reportContent, lastEvaluationRepairAt: new Date().toISOString() };
  await prisma.evalRun.update({ where: { id: run.id }, data: { summary: JSON.stringify(summary) } });
  save('summary-after.json', summary);
  console.log(JSON.stringify({ phase, averageBefore: original.averageScore, averageAfter: summary.averageScore,
    unresolvedProtocolParts: unresolved, engineeringFailures: engineering.excludedTotal }));
}

try {
  const run = await prisma.evalRun.findUniqueOrThrow({ where: { id: runId }, include: { modelConfig: true, results: true } });
  if (!run.manifest || !run.summary) throw new Error('Frozen manifest and summary required');
  const manifest = parse(run.manifest);
  verifyBenchmarkPack(manifest.benchmarkPack);
  const scenarios = manifest.benchmarkPack.scenarios;
  assertGrain(run, scenarios);
  const scenarioById = new Map(scenarios.map(s => [s.id, s]));
  const { offline, progressive } = chooseTargets(run, scenarios);
  const existing = new Map(run.results.map(r => [r.scenarioId, { modelOutput: r.modelOutput, environmentError: r.environmentError }]));
  for (const row of progressive) buildProgressiveHistory(scenarioById.get(row.scenarioId), scenarios, existing);
  const config = parse(run.config);
  const judgeRow = await prisma.modelConfig.findUniqueOrThrow({ where: { id: config.judgeModelConfigId } });
  const judgeOptions = { localModel: model(judgeRow), escalationThreshold: config.escalationThreshold ?? 0.85 };
  const testedModel = model(run.modelConfig);
  if (process.env.ZXB_TESTED_MODEL_BASE_URL) testedModel.baseUrl = process.env.ZXB_TESTED_MODEL_BASE_URL;
  if (process.env.ZXB_TESTED_MODEL_API_KEY === 'none') testedModel.apiKey = '';
  save('plan.json', { runId, phase, model: { name: testedModel.name, baseUrl: testedModel.baseUrl },
    judge: { name: judgeRow.name, baseUrl: judgeRow.baseUrl }, offline: offline.map(r => r.scenarioId),
    progressive: progressive.map(r => r.scenarioId), benchmarkPackHash: manifest.benchmarkPack.hash });
  console.log(JSON.stringify({ phase, apply, offline: offline.length, progressive: progressive.length, artifactDir }));
  if (!apply) process.exitCode = 0;
  else {
    await backup(run);
    if (phase === 'offline') {
      for (const old of offline) {
        if (['offline'].includes(parse(old.outputMetadata).evaluationRepair?.kind ?? parse(old.outputMetadata).swiftRepair?.kind)) continue;
        const scenario = scenarioById.get(old.scenarioId);
        const metadata = parse(old.outputMetadata);
        if (metadata.evaluationAudit?.attempts?.length) throw new Error(`Multi-attempt answer requires separate recovery: ${old.scenarioId}`);
        const response = { content: old.modelOutput, reasoningContent: old.reasoningContent ?? undefined,
          finishReason: metadata.finishReason || 'stop', latencyMs: metadata.inferenceMs || 0,
          usage: { inputTokens: metadata.inputTokens || 0, outputTokens: metadata.outputTokens || 0,
            totalTokens: (metadata.inputTokens || 0) + (metadata.outputTokens || 0) } };
        const result = await orchestrateEvaluation({ scenario, modelConfig: testedModel,
          modelParams: { ...testedModel.defaultParams, maxTokens: config.maxTokens, temperature: config.temperature },
          evalConfig: config, judgeOptions, constraints: config.constraints, savedCandidate: { response, metadata } });
        await updateRow(old, result, 'offline', { judgeModelId: judgeRow.id, candidateGenerationCalls: 0 });
        console.log(`OFFLINE ${old.scenarioId} ${old.totalScore}->${result.totalScore} env=${!!result.environmentError}`);
      }
    } else if (phase === 'progressive') {
      const groups = [...new Set(progressive.map(r => scenarioById.get(r.scenarioId).requirements.groupId))];
      let next = 0;
      const worker = async () => {
        while (next < groups.length) {
          const group = groups[next++];
          for (let part = 2; part <= 4; part++) {
            const id = `${group}-P${part}`;
            const old = await prisma.scenarioResult.findFirstOrThrow({ where: { evalRunId: run.id, scenarioId: id } });
            if (['progressive'].includes(parse(old.outputMetadata).evaluationRepair?.kind ?? parse(old.outputMetadata).swiftRepair?.kind)) continue;
            const scenario = scenarioById.get(id);
            const priorRows = await prisma.scenarioResult.findMany({ where: { evalRunId: run.id,
              scenarioId: { in: Array.from({ length: part - 1 }, (_, i) => `${group}-P${i + 1}`) } } });
            const prior = new Map(priorRows.map(r => [r.scenarioId, { modelOutput: r.modelOutput, environmentError: r.environmentError }]));
            const priorMessages = buildProgressiveHistory(scenario, scenarios, prior);
            const result = await orchestrateEvaluation({ scenario, modelConfig: testedModel,
              modelParams: { ...testedModel.defaultParams, maxTokens: config.maxTokens, temperature: config.temperature },
              evalConfig: config, constraints: config.constraints, priorMessages });
            if (result.environmentError) throw new Error(`Progressive infrastructure failure ${id}: ${result.evidence.join('; ')}`);
            await updateRow(old, result, 'progressive', { previousPartIds: priorRows.map(r => r.scenarioId),
              priorTurns: priorMessages.length, candidateGenerationCalls: 1 });
            console.log(`PROGRESSIVE ${id} ${old.totalScore}->${result.totalScore}`);
          }
        }
      };
      const outcomes = await Promise.allSettled([worker(), worker()]);
      const failures = outcomes.filter(outcome => outcome.status === 'rejected');
      if (failures.length) {
        await updateSummary(run, scenarios);
        throw new AggregateError(failures.map(outcome => outcome.reason), 'Progressive repair stopped; committed parts are resumable');
      }
    }
    await updateSummary(run, scenarios);
  }
} finally { await prisma.$disconnect(); }
