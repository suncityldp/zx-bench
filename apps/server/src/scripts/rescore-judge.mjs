// AI Judge 失败结果离线重算（正确版）
// 修复历史 bug：原先直接用打折后的 deterministicScore 作为 det 分，且未做 coverage 让渡合并，
// 导致 Judge 缺席期被打折的题即使后来重跑 Judge 也救不回分数。
// 现在：重跑最新确定性评分器恢复「原始」确定性分 + coverage，再用 judge 重判 + coverage 让渡合并。
// 运行: node src/scripts/rescore-judge.mjs [DRY_RUN=1] [LIMIT=N] [CONCURRENCY=4] [JUDGE_MODEL_ID=...] [ONLY_PROBLEMATIC=1]
//   ONLY_PROBLEMATIC=1 时，除 JUDGE_FAILED 外也处理曾用 buggy 逻辑重算过的 JUDGE_RESCORED 题
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { scryptSync, createDecipheriv } from 'node:crypto';
import {
  runTieredJudge, runJudgeEnsemble, computeJudgeScore, registerEvaluator, getEvaluator,
  bugFindingEvaluator, codeRepairEvaluator, structuredOutputEvaluator,
  dataExtractionEvaluator, exactAnswerLineEvaluator, instructionChecklistEvaluator,
  canaryAuthorityEvaluator, toolCallTraceEvaluator, agentTraceEvaluator, cliCommandEvaluator,
  hallucinationResistanceEvaluator,
} from '@zxbench/core';

const DB_PATH = (process.env.ZXBENCH_DB_PATH || path.resolve(import.meta.dirname, '../../../data/zxbench.db'));
const ENCRYPTION_KEY = process.env.ZXBENCH_ENCRYPTION_KEY || 'zxbench-default-key-change-me!';

// ===== 注册评分器（与 server/index.ts 一致） =====
registerEvaluator(bugFindingEvaluator);
registerEvaluator(codeRepairEvaluator);
registerEvaluator(structuredOutputEvaluator);
registerEvaluator(dataExtractionEvaluator);
registerEvaluator(exactAnswerLineEvaluator);
registerEvaluator(instructionChecklistEvaluator);
registerEvaluator(canaryAuthorityEvaluator);
registerEvaluator(toolCallTraceEvaluator);
registerEvaluator(agentTraceEvaluator);
registerEvaluator(cliCommandEvaluator);
registerEvaluator(hallucinationResistanceEvaluator);

function decryptApiKey(encrypted) {
  if (!encrypted || !encrypted.includes(':')) return encrypted;
  const key = scryptSync(ENCRYPTION_KEY, 'zxbench-salt', 32);
  const [ivHex, data] = encrypted.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const d = createDecipheriv('aes-256-cbc', key, iv);
  let out = d.update(data, 'hex', 'utf8');
  out += d.final('utf8');
  return out;
}

// 与 orchestrator getJudgeWeights 完全一致
function getJudgeWeights(dimension, grader) {
  if (dimension === 'data_extraction' || grader === 'json_atomic_fields') return { deterministic: 1.0, judge: 0.0 };
  if (dimension === 'safety_authority') return { deterministic: 1.0, judge: 0.0 };
  if (dimension === 'structured_output' || grader === 'schema_compliance') return { deterministic: 0.9, judge: 0.1 };
  if (dimension === 'reasoning_math') return { deterministic: 0.95, judge: 0.05 };
  if (dimension === 'program' || grader === 'code_repair') return { deterministic: 0.8, judge: 0.2 };
  if (dimension === 'bug_finding' || grader === 'bug_finding') return { deterministic: 0.4, judge: 0.6 };
  if (dimension === 'instruction_following' || grader === 'instruction_checklist') return { deterministic: 0.5, judge: 0.5 };
  if (dimension === 'agent_workflow' || grader === 'agent_trace') return { deterministic: 0.7, judge: 0.3 };
  if (dimension === 'tool_cli_workflow' || grader === 'tool_call_trace') return { deterministic: 0.7, judge: 0.3 };
  if (dimension === 'cli_deep_tasks' || grader === 'cli_command') return { deterministic: 0.5, judge: 0.5 };
  if (dimension === 'hallucination_resistance' || grader === 'hallucination_resistance') return { deterministic: 1.0, judge: 0.0 };
  return { deterministic: 0.6, judge: 0.4 };
}

function deserializeScenario(sd) {
  return {
    id: sd.id, dimension: sd.dimension, category: sd.category, difficulty: sd.difficulty,
    language: sd.language, locale: sd.locale, status: sd.status, tier: sd.tier || 'public_dev',
    promptTemplate: sd.promptTemplate, sourceCode: sd.sourceCode ?? undefined,
    functionName: sd.functionName ?? undefined, expectedVerdict: sd.expectedVerdict ?? undefined,
    grader: sd.grader, graderVersion: sd.graderVersion, scoring: JSON.parse(sd.scoring || '{}'),
    hiddenTests: sd.hiddenTests ? JSON.parse(sd.hiddenTests) : undefined,
    requirements: sd.requirements ? JSON.parse(sd.requirements) : undefined,
    tags: sd.tags ? JSON.parse(sd.tags) : undefined,
    scenarioVersion: sd.scenarioVersion, scenarioHash: sd.scenarioHash,
    outputPolicy: sd.outputPolicy ?? undefined,
    answerFirst: sd.answerFirst ?? undefined,
    maxAnswerTokens: sd.maxAnswerTokens ?? undefined,
    maxReasoningTokens: sd.maxReasoningTokens ?? undefined,
  };
}

const dryRun = process.env.DRY_RUN === '1';
const limit = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : undefined;
const concurrency = process.env.CONCURRENCY ? parseInt(process.env.CONCURRENCY, 10) : 4;
const judgeModelId = process.env.JUDGE_MODEL_ID;
const onlyProblematic = process.env.ONLY_PROBLEMATIC === '1';
// P0：ENSEMBLE=N 时对每题重复判分 N 次取均（默认 1，与历史一致）
const ensemble = process.env.ENSEMBLE ? parseInt(process.env.ENSEMBLE, 10) : 1;

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 10000');

const judgeRow = judgeModelId
  ? db.prepare("SELECT * FROM ModelConfig WHERE id = ?").get(judgeModelId)
  : db.prepare("SELECT * FROM ModelConfig WHERE modelType = 'judge' LIMIT 1").get();
if (!judgeRow) { console.error('未找到 judge 模型'); process.exit(1); }
console.log('Judge 模型: ' + judgeRow.name + ' (' + judgeRow.id + ') baseUrl=' + judgeRow.baseUrl);

const localModel = {
  id: judgeRow.id,
  name: judgeRow.name,
  provider: judgeRow.provider,
  baseUrl: judgeRow.baseUrl,
  apiKey: judgeRow.apiKey ? decryptApiKey(judgeRow.apiKey) : undefined,
  defaultParams: JSON.parse(judgeRow.defaultParams || '{}'),
  reasoningModel: judgeRow.reasoningModel === 1 || judgeRow.reasoningModel === true,
};

// 可选 RUN_ID 限定到单个 run；SCENARIO_IDS 限定题集（高信号子集）；KIMI_ONLY=1 只处理 kimi-k3 旧判分的题
const runId = process.env.RUN_ID;
const kimiOnly = process.env.KIMI_ONLY === '1';
const scenarioIds = process.env.SCENARIO_IDS ? process.env.SCENARIO_IDS.split(/[\s,]+/).filter(Boolean) : null;
// ENSEMBLE 模式：对 RUN_ID 内全部题重判（去掉 JUDGE_FAILED 过滤），需显式 RUN_ID
if (ensemble >= 2 && !runId) { console.error('ENSEMBLE 模式需要 RUN_ID 限定范围'); process.exit(1); }
let where = ensemble >= 2
  ? '1=1'
  : (kimiOnly
    ? "evidence LIKE '%kimi-k3%'"
    : (onlyProblematic
      ? "(evidence LIKE '%JUDGE_FAILED%' OR evidence LIKE '%JUDGE_RESCORED%')"
      : "evidence LIKE '%JUDGE_FAILED%'"));
const params = [];
if (runId) { where += ' AND evalRunId = ?'; params.push(runId); }
if (scenarioIds && scenarioIds.length) {
  const ph = scenarioIds.map(() => '?').join(',');
  where += ` AND scenarioId IN (${ph})`;
  params.push(...scenarioIds);
}
const sql = "SELECT * FROM ScenarioResult WHERE " + where + " ORDER BY finishedAt ASC" + (limit ? ' LIMIT ' + limit : '');
const stmt = db.prepare(sql);
const rows = stmt.all(...params);
console.log('待重算 ' + rows.length + ' 条' + (dryRun ? '（DRY-RUN）' : '') + '，并发 ' + concurrency + '\n');

let idx = 0, ok = 0, skip = 0, fail = 0, changed = 0;
const ensembleRecords = [];  // P0：ENSEMBLE 模式下收集每题各次 judge 分数，供方差分析

async function worker() {
  while (true) {
    const i = idx++;
    if (i >= rows.length) return;
    const r = rows[i];
    try {
      const sd = db.prepare("SELECT * FROM ScenarioDefinition WHERE id = ?").get(r.scenarioId);
      if (!sd) { console.log('  [跳过] ' + r.scenarioId + ' 无题目定义'); skip++; continue; }
      const scenario = deserializeScenario(sd);
      const outputMetadata = JSON.parse(r.outputMetadata || '{}');
      const evidence = JSON.parse(r.evidence || '[]');

      // 1. 重跑评分器 → 原始确定性分 + coverage
      const evaluator = getEvaluator(sd.grader, sd.graderVersion);
      let det;
      if (evaluator) {
        det = await evaluator.evaluate(scenario, r.modelOutput, outputMetadata);
      } else {
        det = { totalScore: r.totalScore, axisScores: JSON.parse(r.axisScores || '{}'), axisEvidence: JSON.parse(r.axisEvidence || '{}'), axisCoverage: 1 };
        evidence.push('RESCORE: no evaluator for ' + sd.grader + '@' + sd.graderVersion);
      }
      const score = det.totalScore ?? 0;
      const coverage = det.axisCoverage ?? 1;

      // 2. judge 权重
      let weights = getJudgeWeights(r.dimension, sd.grader);
      if (weights.judge <= 0) {
        const total = coverage >= 0.5 ? score : Math.round(score * 0.3);
        if (!dryRun) {
          db.prepare("UPDATE ScenarioResult SET totalScore=?, deterministicScore=?, axisScores=?, axisEvidence=? WHERE id=?")
            .run(total, score, JSON.stringify(det.axisScores || {}), JSON.stringify(det.axisEvidence || {}), r.id);
        }
        if (total !== r.totalScore) changed++;
        ok++; continue;
      }

      // 3. formatBlindspot
      const axisScores = det.axisScores || {};
      const codeExtractionFailed = (axisScores.patch_extraction != null && axisScores.patch_extraction <= 40)
        || (det.evidence || []).some(e => e.includes('CODE_EXTRACTION_HEURISTIC'));
      const hasSubstantialOutput = (r.modelOutput || '').trim().length > 20;
      const detScoreVeryLow = score < 25;
      if ((detScoreVeryLow && hasSubstantialOutput) || codeExtractionFailed) {
        weights = { deterministic: 0.3, judge: 0.7 };
      }

      // 4. 用 deepseek-v4-pro 重跑 judge（旧 kimi-k3 判分作废，全部重新判）
      const requirements = sd.requirements ? JSON.parse(sd.requirements) : undefined;
      const judgeInput = {
        questionId: r.scenarioId,
        task: sd.promptTemplate,
        dimension: r.dimension,
        sourceCode: sd.sourceCode ?? undefined,
        requirements: Array.isArray(requirements) ? requirements : [],
        expectedAnswer: requirements,
        expectedVerdict: sd.expectedVerdict ?? undefined,
        candidateAnswer: {},
        rawModelOutput: r.modelOutput,
        outputMetadata,
        codeExtractionFailed,
        judgeHint: sd.judgeHint ?? undefined,
      };
      const jr = ensemble >= 2
        ? await runJudgeEnsemble(judgeInput, { localModel, escalationThreshold: 0.85 }, ensemble)
        : await runTieredJudge(judgeInput, { localModel, escalationThreshold: 0.85 });
      const localJudge = jr.localJudge, frontierJudge = jr.frontierJudge, finalJudge = jr.finalJudge, escalated = jr.escalated;
      const judgeScore = computeJudgeScore(finalJudge);
      // P0：记录每次 judge 分数历史，供方差分析（runJudgeEnsemble 在 K>=2 时提供 runs）
      const ensembleHistory = (ensemble >= 2 && jr.runs) ? jr.runs.map((x) => computeJudgeScore(x)) : null;

      // 5. coverage 让渡合并（与 orchestrator 一致）
      const detW = weights.deterministic * coverage;
      const judgeW = weights.judge + weights.deterministic * (1 - coverage);
      const total = Math.round(score * detW + judgeScore * judgeW);
      const newHr = escalated || total < 30;

      const newEvidence = evidence.filter((e) => !e.includes('JUDGE_FAILED') && !e.includes('JUDGE_RESCORED')).concat('JUDGE_RESCORED: ' + finalJudge.judgeModel + ' verdict=' + finalJudge.verdict + ' conf=' + finalJudge.confidence.toFixed(2));

      // P0：ENSEMBLE 历史落盘（evidence 备注 + 全局数组写 JSON）
      if (ensembleHistory) {
        ensembleRecords.push({
          scenarioId: r.scenarioId, evalRunId: runId ?? r.evalRunId, dimension: r.dimension,
          beforeTotal: r.totalScore, beforeJudge: r.judgeScore,
          afterJudge: Math.round(judgeScore), ensemble: ensembleHistory,
        });
        newEvidence.push('JUDGE_ENSEMBLE(' + ensemble + '): [' + ensembleHistory.join(',') + '] -> ' + Math.round(judgeScore));
      }

      const diff = total !== r.totalScore ? '⚠️' : '·';
      console.log('  [' + diff + '] ' + r.scenarioId.padEnd(14) + ' (' + r.dimension.padEnd(22) + ') ' + r.totalScore + ' → ' + total + ' (det=' + score + ', judge=' + judgeScore.toFixed(1) + ', cov=' + coverage.toFixed(2) + ')');
      if (total !== r.totalScore) changed++;

      if (!dryRun) {
        db.prepare("UPDATE ScenarioResult SET totalScore=?, deterministicScore=?, judgeScore=?, axisScores=?, axisEvidence=?, localJudge=?, frontierJudge=?, finalJudge=?, escalated=?, humanReviewRequired=?, evidence=? WHERE id=?")
          .run(
            total, score, Math.round(judgeScore), JSON.stringify(det.axisScores || {}), JSON.stringify(det.axisEvidence || {}),
            JSON.stringify(localJudge), frontierJudge ? JSON.stringify(frontierJudge) : null, JSON.stringify(finalJudge),
            escalated ? 1 : 0, newHr ? 1 : 0, JSON.stringify(newEvidence), r.id,
          );
      }
      ok++;
    } catch (err) {
      console.log('  [错误] ' + r.scenarioId + ': ' + (err instanceof Error ? err.message : String(err)));
      fail++;
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, () => worker()));
console.log('\n=== 完成！成功 ' + ok + '，跳过 ' + skip + '，失败 ' + fail + '，分数变化 ' + changed + ' 条 ===');

if (ensemble >= 2 && ensembleRecords.length) {
  const fs = await import('node:fs');
  const outPath = path.resolve(import.meta.dirname, 'ensemble_history.json');
  fs.writeFileSync(outPath, JSON.stringify(ensembleRecords, null, 2));
  console.log('ENSEMBLE 历史已写入: ' + outPath + ' (' + ensembleRecords.length + ' 条)');
}
db.close();