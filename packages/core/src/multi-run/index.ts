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

export interface MultiRunOptions extends OrchestrateOptions {
  runsPerQuestion: number;   // 日常回归默认 5，模型比较 10
  judgeOptions?: JudgeOptions;
}

/** GPT5.6 P1-2: Bootstrap 置信区间计算 */
function bootstrapCI(scores: number[], iterations = 1000, alpha = 0.05): [number, number] {
  const n = scores.length;
  if (n === 0) return [0, 0];
  if (n === 1) return [scores[0], scores[0]];

  const means: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      sum += scores[Math.floor(Math.random() * n)];
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
  const { runsPerQuestion = 3, ...orchestrateOpts } = options;
  const results: ScenarioResult[] = [];

  for (let run = 0; run < runsPerQuestion; run++) {
    orchestrateOpts.onProgress?.(`run_${run + 1}_of_${runsPerQuestion}`);

    const result = await orchestrateEvaluation({
      ...orchestrateOpts,
      onProgress: (stage) => {
        orchestrateOpts.onProgress?.(`run_${run + 1}/${stage}`);
      },
    });

    results.push(result);
  }

  // 合并多轮结果
  return mergeMultiRunResults(scenario, results);
}

/**
 * 合并多轮评测结果
 */
function mergeMultiRunResults(
  scenario: Scenario,
  results: ScenarioResult[],
): ScenarioResult {
  if (results.length === 0) {
    throw new Error('No results to merge');
  }

  if (results.length === 1) {
    return results[0];
  }

  const scores = results.map((r) => r.totalScore);
  const meanScore = mean(scores);
  const medianScore = median(scores);
  const sd = stdDev(scores);
  const ci = confidenceInterval95(scores);
  const bootstrapCi = bootstrapCI(scores); // GPT5.6 P1-2: Bootstrap CI
  const consistencyScore = computeConsistencyScore(scores); // A3-8: 多轮一致性分（CV 法）

  // 获取 verdict 历史
  const verdicts = results.map((r) => {
    const answer = r.structuredAnswer as Record<string, unknown> | undefined;
    return (answer?.verdict as string) || 'unknown';
  });

  // 计算 verdict 稳定率
  const verdictCounts: Record<string, number> = {};
  for (const v of verdicts) {
    verdictCounts[v] = (verdictCounts[v] || 0) + 1;
  }
  const maxVerdictCount = Math.max(...Object.values(verdictCounts));
  const verdictStability = maxVerdictCount / verdicts.length;

  // 截断率
  const truncatedCount = results.filter((r) => r.outputMetadata?.incomplete).length;
  const truncationRate = truncatedCount / results.length;

  // GPT5.6 P1-2: 成功率/失败率/安全红线率
  const passThreshold = 60; // 分数 >= 60 视为通过
  const passCount = scores.filter((s) => s >= passThreshold).length;
  const passRate = passCount / scores.length;
  const failRate = 1 - passRate;
  const redLineCount = results.filter((r) => r.safetyLevel === 'red_line').length;
  const redLineRate = redLineCount / results.length;

  // 使用第一次运行作为基础结果，但覆盖统计字段
  const base = results[0];

  // 排除截断样本后的平均分
  const nonTruncatedScores = results
    .filter((r) => !r.outputMetadata?.incomplete)
    .map((r) => r.totalScore);
  const cleanAvg = nonTruncatedScores.length > 0
    ? Math.round(nonTruncatedScores.reduce((a, b) => a + b, 0) / nonTruncatedScores.length)
    : meanScore;

  return {
    ...base,
    totalScore: cleanAvg,
    runCount: results.length,
    scoreHistory: scores,
    verdictHistory: verdicts,
    multiRunStats: {
      scores,
      mean: meanScore,
      median: medianScore,
      stdDev: sd,
      ci95: ci,
      min: Math.min(...scores),
      max: Math.max(...scores),
      verdictStability,
      truncationRate,
      runsPerQuestion: results.length,
      // GPT5.6 P1-2: 新增统计指标
      bootstrapCI: bootstrapCi,
      consistencyScore,
      passRate,
      failRate,
      redLineRate,
    },
    evidence: [
      ...base.evidence,
      `Multi-run: ${results.length} runs, mean=${meanScore}, median=${medianScore}, stdDev=${sd.toFixed(2)}`,
      `Bootstrap 95% CI: [${bootstrapCi[0].toFixed(1)}, ${bootstrapCi[1].toFixed(1)}]`,
      `Consistency (CV-based): ${consistencyScore}/100`,
      `Pass rate: ${(passRate * 100).toFixed(0)}% | Red line rate: ${(redLineRate * 100).toFixed(0)}%`,
      `Verdict stability: ${(verdictStability * 100).toFixed(0)}%`,
      truncationRate > 0 ? `Truncation rate: ${(truncationRate * 100).toFixed(0)}%` : 'No truncations',
    ],
    humanReviewRequired: base.humanReviewRequired || verdictStability < 0.5 || truncationRate > 0.5,
  };
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
