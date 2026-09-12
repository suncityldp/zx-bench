// Targeted recovery for results whose AI Judge request failed after model output was saved.
//
// Scope is intentionally narrow:
// - only the four named comparison runs;
// - only non-environment rows explicitly marked JUDGE_FAILED;
// - never calls the evaluated model and never overwrites deterministic result fields.
//
// The deterministic evaluator is invoked read-only only to recover axisCoverage.  A strict
// raw-score equality check aborts that row if evaluator behaviour has drifted, preventing a
// new evaluator version from silently changing a historical test result.
//
// Usage (from apps/server):
//   CONCURRENCY=1 node src/scripts/rescore-missing-judge-safe.mjs
//   DRY_RUN=1 LIMIT=1 CONCURRENCY=1 node src/scripts/rescore-missing-judge-safe.mjs

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { createDecipheriv, scryptSync } from 'node:crypto';
import {
  runTieredJudge,
  runJudgeEnsemble,
  computeJudgeScore,
  getJudgeWeights,
  mixDeterministicJudge,
  registerEvaluator,
  getEvaluator,
  bugFindingEvaluator,
  codeRepairEvaluator,
  projectRepairEvaluator,
  structuredOutputEvaluator,
  dataExtractionEvaluator,
  exactAnswerLineEvaluator,
  instructionChecklistEvaluator,
  canaryAuthorityEvaluator,
  toolCallTraceEvaluator,
  agentTraceEvaluator,
  cliCommandEvaluator,
  hallucinationResistanceEvaluator,
  sandboxEvaluator,
  llmJudgeEvaluator,
} from '@zxbench/core';

const RUN_IDS = [
  'zxbench-pro-2026-09-02T17-25-54-699Z-af139f41', // Fable base
  'zxbench-pro-2026-09-03T00-19-41-342Z-af0ffbd9', // Fable program rerun
  'zxbench-pro-2026-09-02T23-47-51-096Z-3b74766f', // Fable hallucination rerun
  'zxbench-pro-2026-09-03T02-37-48-833Z-fb6f82c0', // Qwen UD Q4 full run
];
const EXPECTED_JUDGE_ID = 'e32d8a5d-b6ed-45ac-8bb1-a60859ab419e';
const DB_PATH = process.env.ZXBENCH_DB_PATH
  || path.resolve(import.meta.dirname, '../../../data/zxbench.db');
const ENCRYPTION_KEY = process.env.ZXBENCH_ENCRYPTION_KEY || 'zxbench-default-key-change-me!';
const dryRun = process.env.DRY_RUN === '1';
const limit = Number.parseInt(process.env.LIMIT || '', 10);
const concurrency = Math.max(1, Math.min(2, Number.parseInt(process.env.CONCURRENCY || '1', 10) || 1));
const judgeTimeoutMs = Math.max(30_000, Number.parseInt(process.env.JUDGE_TIMEOUT_MS || '120000', 10) || 120_000);

for (const evaluator of [
  bugFindingEvaluator, codeRepairEvaluator, projectRepairEvaluator, structuredOutputEvaluator,
  dataExtractionEvaluator, exactAnswerLineEvaluator, instructionChecklistEvaluator,
  canaryAuthorityEvaluator, toolCallTraceEvaluator, agentTraceEvaluator, cliCommandEvaluator,
  hallucinationResistanceEvaluator, sandboxEvaluator, llmJudgeEvaluator,
]) registerEvaluator(evaluator);

function parseJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function decryptApiKey(encrypted) {
  if (!encrypted || !encrypted.includes(':')) return encrypted;
  const [ivHex, data] = encrypted.split(':');
  if (!ivHex || !data) return encrypted;
  const key = scryptSync(ENCRYPTION_KEY, 'zxbench-salt', 32);
  const decipher = createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
  return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8');
}

function deserializeScenario(row) {
  return {
    id: row.id,
    dimension: row.dimension,
    category: row.category,
    difficulty: row.difficulty,
    language: row.language,
    locale: row.locale,
    status: row.status,
    tier: row.tier || 'public_dev',
    promptTemplate: row.promptTemplate,
    sourceCode: row.sourceCode || undefined,
    functionName: row.functionName || undefined,
    expectedVerdict: row.expectedVerdict || undefined,
    grader: row.grader,
    graderVersion: row.graderVersion,
    scoring: parseJson(row.scoring, {}),
    hiddenTests: parseJson(row.hiddenTests, undefined),
    requirements: parseJson(row.requirements, []),
    tags: parseJson(row.tags, undefined),
    scenarioVersion: row.scenarioVersion,
    scenarioHash: row.scenarioHash,
    outputPolicy: row.outputPolicy || undefined,
    answerFirst: row.answerFirst == null ? undefined : Boolean(row.answerFirst),
    maxAnswerTokens: row.maxAnswerTokens ?? undefined,
    maxReasoningTokens: row.maxReasoningTokens ?? undefined,
  };
}

function modelResponseFromStored(row, outputMetadata) {
  const inputTokens = Number(outputMetadata.inputTokens || 0);
  const outputTokens = Number(outputMetadata.outputTokens || 0);
  return {
    content: row.modelOutput,
    reasoningContent: row.reasoningContent || undefined,
    finishReason: outputMetadata.finishReason || 'unknown',
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    latencyMs: Number(outputMetadata.inferenceMs || 0),
  };
}

function candidateAnswerFromStored(output, formatParseSuccess) {
  if (!formatParseSuccess) return {};
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced ? fenced[1] : output).trim();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return {
      verdict: parsed.verdict,
      rootCause: parsed.root_cause,
      patch: parsed.patch,
      verification: parsed.verification,
    };
  } catch {
    return {};
  }
}

function ensureRunJudgeConfig(db, judgeId) {
  for (const id of RUN_IDS) {
    const run = db.prepare('SELECT id, config FROM EvalRun WHERE id = ?').get(id);
    if (!run) throw new Error(`comparison run not found: ${id}`);
    const config = parseJson(run.config, {});
    if (config.judgeEnabled !== true || config.judgeModelConfigId !== judgeId) {
      throw new Error(`run ${id} does not match the frozen Judge configuration`);
    }
  }
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 30000');
db.exec('PRAGMA foreign_keys = ON');

const judgeRow = db.prepare('SELECT * FROM ModelConfig WHERE id = ?').get(EXPECTED_JUDGE_ID);
if (!judgeRow) throw new Error(`expected Judge configuration is missing: ${EXPECTED_JUDGE_ID}`);
ensureRunJudgeConfig(db, judgeRow.id);

const localModel = {
  id: judgeRow.id,
  name: judgeRow.name,
  provider: judgeRow.provider,
  baseUrl: judgeRow.baseUrl,
  apiKey: judgeRow.apiKey ? decryptApiKey(judgeRow.apiKey) : undefined,
  // Use a bounded timeout for this recovery job.  It is passed through the
  // core Judge caller and does not modify the saved Judge configuration.
  defaultParams: { ...parseJson(judgeRow.defaultParams, {}), timeout: judgeTimeoutMs },
  reasoningModel: judgeRow.reasoningModel === 1 || judgeRow.reasoningModel === true,
};

const rowSql = `
  SELECT * FROM ScenarioResult
  WHERE evalRunId IN (${RUN_IDS.map(() => '?').join(',')})
    AND environmentError = 0
    AND evidence LIKE '%JUDGE_FAILED%'
  -- Start with single-call dimensions so a connectivity smoke test is fast;
  -- program rows remain exactly in scope and retain their 3-pass ensemble.
  ORDER BY CASE WHEN dimension = 'program' THEN 1 ELSE 0 END, finishedAt ASC, id ASC
  ${Number.isFinite(limit) && limit > 0 ? `LIMIT ${limit}` : ''}`;
const rows = db.prepare(rowSql).all(...RUN_IDS);
const programRows = rows.filter((row) => row.dimension === 'program').length;
console.log(`Judge=${judgeRow.name} (${judgeRow.id}); target results=${rows.length}; program=${programRows}; `
  + `planned Judge calls=${rows.length + programRows * 2}; concurrency=${concurrency}; timeout=${judgeTimeoutMs}ms${dryRun ? '; DRY_RUN' : ''}`);

const update = db.prepare(`
  UPDATE ScenarioResult
  SET totalScore = ?, deterministicScore = ?, judgeScore = ?, axisEvidence = ?,
      localJudge = ?, frontierJudge = ?, finalJudge = ?, escalated = ?,
      runCount = ?, scoreHistory = ?, humanReviewRequired = ?, evidence = ?
  WHERE id = ?
`);

let cursor = 0;
const stats = { rescored: 0, skipped: 0, failed: 0, changed: 0, calls: 0 };

async function rescoreRow(row) {
  const definition = db.prepare('SELECT * FROM ScenarioDefinition WHERE id = ?').get(row.scenarioId);
  if (!definition) throw new Error('scenario definition not found');
  const scenario = deserializeScenario(definition);
  const outputMetadata = parseJson(row.outputMetadata, {});
  const storedDeterministic = row.deterministicScore;
  if (!Number.isInteger(storedDeterministic)) throw new Error('missing stored deterministicScore');

  const evaluator = getEvaluator(scenario.grader, scenario.graderVersion);
  if (!evaluator) throw new Error(`evaluator not registered: ${scenario.grader}@${scenario.graderVersion}`);
  const deterministic = await evaluator.evaluate(
    scenario,
    row.modelOutput,
    outputMetadata,
    modelResponseFromStored(row, outputMetadata),
  );
  const recomputedDeterministic = deterministic.totalScore ?? 0;
  if (recomputedDeterministic !== storedDeterministic) {
    console.log(`[skip deterministic drift] ${row.scenarioId}: stored=${storedDeterministic}, recomputed=${recomputedDeterministic}`);
    stats.skipped++;
    return;
  }

  const storedEvidence = parseJson(row.evidence, []);
  const storedAxisEvidence = parseJson(row.axisEvidence, {});
  const axisScores = deterministic.axisScores || parseJson(row.axisScores, {});
  const axisEvidence = deterministic.axisEvidence || storedAxisEvidence;
  const codeExtractionFailed = deterministic.codeExtractionFailed === true
    || (axisScores.patch_extraction != null && axisScores.patch_extraction <= 40)
    || (deterministic.evidence || []).some((item) => String(item).includes('CODE_EXTRACTION_HEURISTIC'));
  const hasSubstantialOutput = row.modelOutput.trim().length > 20;
  const hasVerifiedExecution = axisEvidence.compilation === 'verified' || axisEvidence.test_pass === 'verified';
  const formatParseFailed = row.dimension === 'structured_output' && row.formatParseSuccess !== true;
  const formatBlindspot = codeExtractionFailed
    || ((recomputedDeterministic < 25 && hasSubstantialOutput) && !hasVerifiedExecution)
    || formatParseFailed;

  let weights = getJudgeWeights(row.dimension, scenario.grader);
  if (formatBlindspot && weights.judge > 0) weights = { deterministic: 0.3, judge: 0.7 };
  if (weights.judge <= 0) {
    console.log(`[skip no judge weight] ${row.scenarioId}`);
    stats.skipped++;
    return;
  }

  const runConfig = parseJson(db.prepare('SELECT config FROM EvalRun WHERE id = ?').get(row.evalRunId).config, {});
  const judgeInput = {
    questionId: scenario.id,
    task: scenario.promptTemplate,
    dimension: scenario.dimension,
    sourceCode: scenario.sourceCode,
    requirements: scenario.requirements || [],
    expectedAnswer: scenario.requirements,
    expectedVerdict: scenario.expectedVerdict,
    candidateAnswer: candidateAnswerFromStored(row.modelOutput, row.formatParseSuccess === true),
    rawModelOutput: row.modelOutput,
    runtimeTests: deterministic.runtimeEvaluation ? {
      compilePassed: deterministic.runtimeEvaluation.compilePassed,
      passed: deterministic.runtimeEvaluation.hiddenTestsPassed ?? deterministic.runtimeEvaluation.testsPassed,
      failed: deterministic.runtimeEvaluation.hiddenTestsFailed ?? deterministic.runtimeEvaluation.testsFailed,
      details: deterministic.runtimeEvaluation.details || [],
    } : undefined,
    outputMetadata,
    codeExtractionFailed,
    formatBlindspot,
  };
  const ensembleRuns = runConfig.judgeEnsembleRuns ?? (row.dimension === 'program' ? 3 : 1);
  const judgeOptions = { localModel, escalationThreshold: runConfig.escalationThreshold || 0.85 };
  const judgeResult = ensembleRuns > 1
    ? await runJudgeEnsemble(judgeInput, judgeOptions, ensembleRuns)
    : await runTieredJudge(judgeInput, judgeOptions);
  stats.calls += ensembleRuns;

  const finalJudge = judgeResult.finalJudge;
  const judgeScore = row.dimension === 'hallucination_resistance' && finalJudge.factuality != null
    ? Math.round(finalJudge.factuality * 100)
    : computeJudgeScore(finalJudge);
  const coverage = deterministic.axisCoverage ?? 1;
  const mixed = mixDeterministicJudge(weights.deterministic, weights.judge, coverage);
  const totalScore = Math.round(storedDeterministic * mixed.detW + judgeScore * mixed.judgeW);
  const finalAxisEvidence = {
    ...storedAxisEvidence,
    ...(row.dimension === 'hallucination_resistance' ? { factuality: 'llm' } : {}),
    judge_bug_detection: 'llm',
    judge_root_cause: 'llm',
    judge_patch_correctness: 'llm',
    judge_scope_discipline: 'llm',
    judge_output_completeness: 'llm',
  };
  const judgeHistory = judgeResult.runs && judgeResult.runs.length > 1
    ? judgeResult.runs.map((item) => row.dimension === 'hallucination_resistance' && item.factuality != null
      ? Math.round(item.factuality * 100)
      : computeJudgeScore(item))
    : [totalScore];
  const evidence = storedEvidence
    .filter((item) => !String(item).includes('JUDGE_FAILED') && !String(item).includes('JUDGE_RESCORED'));
  evidence.push(`JUDGE_RESCORED: ${finalJudge.judgeModel} verdict=${finalJudge.verdict} confidence=${finalJudge.confidence.toFixed(2)}`);
  if (judgeResult.escalated) {
    evidence.push(`DISPUTE: local=${judgeResult.localJudge.verdict} frontier=${judgeResult.frontierJudge?.verdict} final=${finalJudge.verdict}`);
  }

  const before = row.totalScore;
  console.log(`[${before === totalScore ? '=' : 'Δ'}] ${row.scenarioId} ${before} -> ${totalScore} (det=${storedDeterministic}, judge=${judgeScore}, coverage=${coverage.toFixed(2)}, k=${ensembleRuns})`);
  if (before !== totalScore) stats.changed++;
  if (!dryRun) {
    update.run(
      totalScore, storedDeterministic, judgeScore, JSON.stringify(finalAxisEvidence),
      JSON.stringify(judgeResult.localJudge), judgeResult.frontierJudge ? JSON.stringify(judgeResult.frontierJudge) : null,
      JSON.stringify(finalJudge), judgeResult.escalated ? 1 : 0,
      judgeHistory.length, JSON.stringify(judgeHistory),
      (judgeResult.escalated || totalScore < 30) ? 1 : 0, JSON.stringify(evidence), row.id,
    );
  }
  stats.rescored++;
}

async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= rows.length) return;
    const row = rows[index];
    try {
      await rescoreRow(row);
    } catch (error) {
      stats.failed++;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[failed] ${row.scenarioId}: ${message}`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
console.log(JSON.stringify({ ...stats, targetResults: rows.length, dryRun }, null, 2));
db.close();
