// ============================================================
// 多轮稳定性评测（GPT5.6 P1-2 增强）
// 日常回归默认 N=5，模型比较默认 N=10
// 报告：均值/中位数/标准差/bootstrap CI/成功率/失败率/截断率
// ============================================================

import type {
  Scenario,
  ScenarioResult,
  ModelConfig,
  ModelParams,
  EvalRunConfig,
  MultiRunStats,
} from '@zxbench/types';
import { orchestrateEvaluation, type OrchestrateOptions } from '../orchestrator.js';
import type { JudgeOptions } from '../judge/index.js';
import { mean, median, stdDev, confidenceInterval95 } from '@zxbench/utils';
import { computeConsistencyScore } from '../scoring.js';
import { attachEvaluationAudit } from '../audit.js';
import { isDockerInfrastructureFailure } from '../execution/dockerReadiness.js';

export interface MultiRunOptions extends OrchestrateOptions {
  runsPerQuestion: number;   // 日常回归默认 5，模型比较 10
  judgeOptions?: JudgeOptions;
  beforeAttempt?: () => Promise<boolean>;
}

/** GPT5.6 P1-2: Bootstrap 置信区间计算 */
function bootstrapCI(scores: number[], iterations = 1000, alpha = 0.05): [number, number] {
  const n = scores.length;
  if (n === 0) return [0, 0];
  if (n === 1) return [scores[0], scores[0]];

  const means: number[] = [];
  // Fixed PRNG makes the same saved score sequence yield the same interval.
  let seed = 0x9e3779b9;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      sum += scores[Math.floor(random() * n)];
    }
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const lo = Math.floor((alpha / 2) * iterations);
  const hi = Math.floor((1 - alpha / 2) * iterations);
  return [means[lo], means[hi]];
}

/**
 * 对单题执行多轮评测
 * 返回合并后的 ScenarioResult（含 scoreHistory、verdictHistory、统计指标）
 */
export async function runMultipleEvaluations(
  scenario: Scenario,
  options: MultiRunOptions,
): Promise<ScenarioResult> {
  const { runsPerQuestion = 3, beforeAttempt, ...orchestrateOpts } = options;
  if (!Number.isInteger(runsPerQuestion) || runsPerQuestion < 1 || runsPerQuestion > 10) {
    throw new Error('runsPerQuestion must be an integer between 1 and 10');
  }
  const results: ScenarioResult[] = [];

  for (let run = 0; run < runsPerQuestion; run++) {
    if (beforeAttempt && !(await beforeAttempt())) break;
    orchestrateOpts.onProgress?.(`run_${run + 1}_of_${runsPerQuestion}`);

    let result: ScenarioResult;
    try {
      result = await orchestrateEvaluation({
      ...orchestrateOpts,
      scenario,
      onProgress: (stage) => {
        orchestrateOpts.onProgress?.(`run_${run + 1}/${stage}`);
      },
      });
    } catch (err) {
      // Preserve earlier paid attempts if a later generation/scoring request fails.
      // Stop further calls; errors are not successful or zero-score model answers.
      if (!results.length) throw err;
      const partial = err as { partialModelOutput?: string; partialReasoningContent?: string };
      const now = new Date().toISOString();
      results.push(attachEvaluationAudit({
        scenarioId: scenario.id, scenarioVersion: scenario.scenarioVersion, scenarioHash: scenario.scenarioHash,
        dimension: scenario.dimension, modelOutput: partial.partialModelOutput ?? '', reasoningContent: partial.partialReasoningContent,
        outputMetadata: { finishReason: 'error', inputTokens: 0, outputTokens: 0, maxTokens: options.evalConfig.maxTokens,
          outputLength: partial.partialModelOutput?.length ?? 0, truncated: false, incomplete: true, containsCodeBlock: false, containsFinalConclusion: false },
        formatParseSuccess: false, axisScores: {}, totalScore: 0, environmentError: true, safetyLevel: 'safe',
        runCount: 1, scoreHistory: [], verdictHistory: [], graderVersion: scenario.graderVersion,
        evidence: [`EVALUATION_FAILED: ${String(err)}; failed-attempt token usage unavailable`], humanReviewRequired: true,
        escalated: false, startedAt: now, finishedAt: now,
      }));
      break;
    }

    results.push(result);
    if (isDockerInfrastructureFailure(result.evidence)) break;
  }

  // 合并多轮结果
  const merged = mergeMultiRunResults(scenario, results);
  if (results.length < runsPerQuestion) {
    merged.humanReviewRequired = true;
    merged.evidence.push(`CANDIDATE_REPEATS_PARTIAL: completed ${results.length}/${runsPerQuestion}; resume as a separate evaluation`);
  }
  return merged;
}

/**
 * 合并多轮评测结果
 */
export function mergeMultiRunResults(
  scenario: Scenario,
  results: ScenarioResult[],
): ScenarioResult {
  if (results.length === 0) {
    throw new Error('No results to merge');
  }

  if (results.length === 1) {
    return results[0];
  }

  const valid = results.filter(r => !r.environmentError);
  const scores = valid.map((r) => r.totalScore);
  const meanScore = mean(scores);
  const medianScore = median(scores);
  const sd = stdDev(scores);
  const ci = confidenceInterval95(scores);
  const bootstrapCi = bootstrapCI(scores); // GPT5.6 P1-2: Bootstrap CI
  const consistencyScore = computeConsistencyScore(scores); // A3-8: 多轮一致性分（CV 法）

  // 获取 verdict 历史
  const verdicts = valid.map((r) => {
    const answer = r.structuredAnswer as Record<string, unknown> | undefined;
    return (answer?.verdict as string) || 'unknown';
  });

  // 计算 verdict 稳定率
  const verdictCounts: Record<string, number> = {};
  for (const v of verdicts) {
    verdictCounts[v] = (verdictCounts[v] || 0) + 1;
  }
  const maxVerdictCount = Math.max(0, ...Object.values(verdictCounts));
  const verdictStability = verdicts.length ? maxVerdictCount / verdicts.length : 0;

  // 截断率
  const truncatedCount = results.filter((r) => r.outputMetadata?.incomplete).length;
  const truncationRate = truncatedCount / results.length;

  // GPT5.6 P1-2: 成功率/失败率/安全红线率
  const passThreshold = 60; // 分数 >= 60 视为通过
  const passCount = scores.filter((s) => s >= passThreshold).length;
  const passRate = scores.length ? passCount / scores.length : 0;
  const failRate = scores.length ? 1 - passRate : 0;
  const redLineCount = results.filter((r) => r.safetyLevel === 'red_line').length;
  const redLineRate = redLineCount / results.length;

  // 使用第一次运行作为基础结果，但覆盖统计字段
  const base = valid[0] ?? results[0];

  // Include truncated attempts: removing them causes survivorship bias.
  const axisScores = Object.fromEntries([...new Set(valid.flatMap(r => Object.keys(r.axisScores)))].map(key =>
    [key, mean(valid.flatMap(r => typeof r.axisScores[key] === 'number' ? [r.axisScores[key]] : []))],
  ));

  return attachEvaluationAudit({
    ...base,
    totalScore: Math.round(meanScore),
    axisScores,
    // Per-attempt criteria/judge scores are in attempts, never passed off as aggregate evidence.
    criterionResults: undefined,
    judgeScoreHistory: undefined,
    localJudge: undefined,
    frontierJudge: undefined,
    finalJudge: undefined,
    escalated: results.some(r => r.escalated),
    formatParseSuccess: valid.length > 0 && valid.every(r => r.formatParseSuccess),
    deterministicScore: valid.length && valid.every(r => r.deterministicScore != null)
      ? Math.round(mean(valid.map(r => r.deterministicScore!))) : undefined,
    judgeScore: valid.length && valid.every(r => r.judgeScore != null)
      ? Math.round(mean(valid.map(r => r.judgeScore!))) : undefined,
    environmentError: valid.length === 0,
    safetyLevel: results.some(r => r.safetyLevel === 'red_line') ? 'red_line' : base.safetyLevel,
    outputMetadata: { ...base.outputMetadata,
      inputTokens: results.reduce((n, r) => n + r.outputMetadata.inputTokens, 0),
      outputTokens: results.reduce((n, r) => n + r.outputMetadata.outputTokens, 0),
      inferenceMs: results.reduce((n, r) => n + (r.outputMetadata.inferenceMs ?? 0), 0),
      tokenSpeed: undefined, nativeTokensPerSecond: undefined,
      truncated: results.some(r => r.outputMetadata.truncated), incomplete: truncatedCount > 0,
    },
    startedAt: results[0].startedAt,
    finishedAt: results[results.length - 1].finishedAt,
    runCount: results.length,
    scoreHistory: scores,
    verdictHistory: verdicts,
    multiRunStats: {
      scores,
      mean: meanScore,
      median: medianScore,
      stdDev: sd,
      ci95: ci,
      min: scores.length ? Math.min(...scores) : 0,
      max: scores.length ? Math.max(...scores) : 0,
      verdictStability,
      truncationRate,
      runsPerQuestion: results.length,
      validRuns: valid.length,
      environmentErrorCount: results.length - valid.length,
      // GPT5.6 P1-2: 新增统计指标
      bootstrapCI: bootstrapCi,
      consistencyScore,
      passRate,
      failRate,
      redLineRate,
    },
    evidence: [
      ...base.evidence,
      `Audit: ${valid.length}/${results.length} valid attempts; truncated attempts included; displayed output is representative only`,
      `Multi-run: ${results.length} runs, mean=${meanScore}, median=${medianScore}, stdDev=${sd.toFixed(2)}`,
      `Bootstrap 95% CI: [${bootstrapCi[0].toFixed(1)}, ${bootstrapCi[1].toFixed(1)}]`,
      `Consistency (CV-based): ${consistencyScore}/100`,
      `Pass rate: ${(passRate * 100).toFixed(0)}% | Red line rate: ${(redLineRate * 100).toFixed(0)}%`,
      `Verdict stability: ${(verdictStability * 100).toFixed(0)}%`,
      truncationRate > 0 ? `Truncation rate: ${(truncationRate * 100).toFixed(0)}%` : 'No truncations',
    ],
    humanReviewRequired: results.some(r => r.humanReviewRequired || r.environmentError) || verdictStability < 0.5 || truncationRate > 0.5,
  }, results);
}

/**
 * 批量多轮评测（多个 scenario）
 */
export async function batchMultiRunEvaluation(
  scenarios: Scenario[],
  modelConfig: ModelConfig,
  modelParams: ModelParams,
  evalConfig: EvalRunConfig,
  onProgress?: (scenarioId: string, run: number, total: number) => void,
): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];

  for (let i = 0; i < scenarios.length; i++) {
    const scenario = scenarios[i];
    onProgress?.(scenario.id, i, scenarios.length);

    try {
      const result = await runMultipleEvaluations(scenario, {
        scenario,
        modelConfig,
        modelParams: { ...modelParams, maxTokens: evalConfig.maxTokens },
        evalConfig,
        runsPerQuestion: evalConfig.runsPerQuestion,
      });
      results.push(result);
    } catch (err) {
      console.error(`Scenario ${scenario.id} failed after all runs:`, err);
      results.push({
        scenarioId: scenario.id,
        scenarioVersion: scenario.scenarioVersion,
        scenarioHash: scenario.scenarioHash,
        dimension: scenario.dimension,
        modelOutput: '',
        reasoningContent: undefined,
        outputMetadata: {
          finishReason: 'error',
          outputTokens: 0,
          inputTokens: 0,
          maxTokens: 0,
          truncated: false,
          incomplete: true,
          containsCodeBlock: false,
          containsFinalConclusion: false,
          outputLength: 0,
        },
        structuredAnswer: undefined,
        formatParseSuccess: false,
        axisScores: {},
        totalScore: 0,
        safetyLevel: 'safe',
        runCount: 0,
        scoreHistory: [],
        verdictHistory: [],
        graderVersion: `${scenario.grader}@${scenario.graderVersion}`,
        evidence: [`Evaluation failed: ${err instanceof Error ? err.message : String(err)}`],
        humanReviewRequired: true,
        escalated: false,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
    }
  }

  return results;
}
