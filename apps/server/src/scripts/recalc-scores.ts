/**
 * 重新计算所有已完成运行的 summary（难度加权 + 维度加权）
 * 运行: node apps/server/dist/scripts/recalc-scores.js
 *
 * 2026-09-16 口径统一：删除本文件内嵌的第二份聚合实现，改用 @zxbench/core 正式实现
 * + buildDimAvgWeightLookups。此前本文件只做 environmentError 隔离，缺工程失败隔离、
 * 缺 long_task 权重覆盖（3.0）、缺 attackLevel 乘子，且本地 computeWeightedTotal 用
 * `?? 0` 静默丢弃未知维度（core 版会抛错）——与在线口径（routes/index.ts）及
 * verify-run-score.ts 不一致，用它重算出的分数与线上不可比。
 */
import { PrismaClient } from '@prisma/client';
import {
  computeDifficultyWeightedDimAvgs as computeDifficultyWeightedDimAvgsPure,
  computeWeightedTotal as computeWeightedTotalPure,
  buildDimAvgWeightLookups,
  createDimAvgExclusionStats,
  classifyEngineeringFailure,
  DIMENSION_WEIGHTS,
  computeSourceQuestionDimAvgs,
  verifyBenchmarkPack,
} from '@zxbench/core';

const prisma = new PrismaClient();

async function main() {
  console.log('=== 重新计算所有运行 summary（难度加权 + 维度加权） ===\n');

  const runs = await prisma.evalRun.findMany({
    where: { status: { in: ['completed', 'paused'] } },
    select: { id: true, name: true, status: true, summary: true, manifest: true },
  });

  console.log(`找到 ${runs.length} 个已完成/暂停的运行\n`);

  let updated = 0;
  for (const run of runs) {
    const results = await prisma.scenarioResult.findMany({
      where: { evalRunId: run.id },
      select: {
        scenarioId: true, dimension: true, totalScore: true, safetyLevel: true,
        environmentError: true, evidence: true, modelOutput: true, graderVersion: true,
        outputMetadata: true,
      },
    });

    if (results.length === 0) {
      console.log(`  [跳过] ${run.name} - 无结果数据`);
      continue;
    }

    const scenarioIds = [...new Set(results.map((r) => r.scenarioId))];
    let frozen: import('@zxbench/types').Scenario[] | undefined;
    if (run.manifest) {
      const pack = JSON.parse(run.manifest).benchmarkPack;
      if (pack) { verifyBenchmarkPack(pack); frozen = pack.scenarios; }
    }
    const scenarios = frozen ?? await prisma.scenarioDefinition.findMany({
      where: { id: { in: scenarioIds } },
      select: { id: true, difficulty: true, category: true, requirements: true },
    });
    const { difficultyLookup, attackLookup, weightOverrideLookup } = buildDimAvgWeightLookups(scenarios);

    const engStats = createDimAvgExclusionStats();
    const dimAvgs = frozen?.some(s => s.benchmarkSource)
      ? computeSourceQuestionDimAvgs(results,frozen,engStats)
      : computeDifficultyWeightedDimAvgsPure(
      results.map((r) => ({
        scenarioId: r.scenarioId,
        dimension: (r as { dimension?: string }).dimension || 'unknown',
        totalScore: r.totalScore,
        environmentError: (r as { environmentError?: boolean | null }).environmentError ?? undefined,
        evidence: r.evidence,
        modelOutput: r.modelOutput,
      })),
      difficultyLookup,
      attackLookup,
      weightOverrideLookup,
      engStats,
    );

    const avgScore = computeWeightedTotalPure(dimAvgs);
    // 与在线口径一致（routes/index.ts）：通过数按「去重 + 排除工程失败样本」统计
    const seen = new Set<string>();
    let totalPass = 0;
    for (const r of results) {
      if (seen.has(r.scenarioId)) continue;
      seen.add(r.scenarioId);
      const failure = classifyEngineeringFailure({
        environmentError: r.environmentError,
        evidence: r.evidence,
        modelOutput: r.modelOutput,
      });
      if (failure) continue;
      if (r.totalScore >= 60) totalPass++;
    }

    // R6 修复（2026-09-16）：token 汇总从落库行重算，不再继承旧 summary。
    // 根因：run 跨段 resume 时（实测 09-15 run 分 00:15–04:09 与 08:20–10:09 两段，
    // 空档 4 小时），summary 在首段结束时就已写定，resume 追加的 141 题只进了结果表；
    // 本脚本此前只覆盖 averageScore/dimensionAverages 而保留旧 token 值 →
    // 落库 input/output 仅为真实值的 70.7% / 66.4%。
    let tokenInput = 0;
    let tokenOutput = 0;
    const speeds: number[] = [];
    for (const r of results) {
      let meta: Record<string, unknown> | null = null;
      try { meta = r.outputMetadata ? JSON.parse(r.outputMetadata) as Record<string, unknown> : null; } catch { /* ignore */ }
      if (!meta) continue;
      const inTok = Number(meta.inputTokens ?? 0) || 0;
      const outTok = Number(meta.outputTokens ?? 0) || 0;
      tokenInput += inTok;
      tokenOutput += outTok;
      const speed = Number(meta.tokenSpeed ?? 0) || Number(meta.nativeTokensPerSecond ?? 0) || 0;
      if (speed > 0) speeds.push(speed);
    }
    speeds.sort((a, b) => a - b);
    const medianSpeed = speeds.length ? Math.round(speeds[Math.floor(speeds.length / 2)]) : 0;

    // 解析旧 summary 保留其他字段
    let oldSummary: Record<string, unknown> = {};
    try {
      oldSummary = run.summary ? JSON.parse(run.summary) : {};
    } catch { /* ignore */ }

    // manifest.metrics 一并回填（历史 run 恒为 0，成本维度永久缺失）
    let manifest: Record<string, unknown> | null = null;
    try { manifest = run.manifest ? JSON.parse(run.manifest) as Record<string, unknown> : null; } catch { /* ignore */ }
    if (manifest) {
      manifest.metrics = {
        ...(manifest.metrics as Record<string, unknown> | undefined),
        totalInputTokens: tokenInput,
        totalOutputTokens: tokenOutput,
      };
    }

    const newSummary = {
      ...oldSummary,
      totalScenarios: results.length,
      completedScenarios: results.length,
      averageScore: avgScore,
      passCount: totalPass,
      dimensionAverages: Object.fromEntries(dimAvgs),
      totalInputTokens: tokenInput,
      totalOutputTokens: tokenOutput,
      avgTokensPerSecond: medianSpeed,
      safetyRedLineCount: results.filter((r) => r.safetyLevel === 'red_line').length,
      // P0 披露：工程失败样本数（空输出/评分器缺失/环境故障）。
      // 硬时限/推理预算耗尽属于能力失败，按 0 分计入，不在此剔除。
      engineeringFailures: {
        total: engStats.excludedTotal,
        byKind: Object.fromEntries(engStats.excludedByKind),
        byDimension: Object.fromEntries(engStats.excludedByDimension),
      },
    };

    await prisma.evalRun.update({
      where: { id: run.id },
      data: {
        summary: JSON.stringify(newSummary),
        ...(manifest ? { manifest: JSON.stringify(manifest) } : {}),
      },
    });

    const oldScore = (oldSummary as { averageScore?: number }).averageScore ?? '?';
    const oldIn = (oldSummary as { totalInputTokens?: number }).totalInputTokens ?? 0;
    console.log(`  [更新] ${run.name}`);
    console.log(`         旧分: ${oldScore} → 新分: ${avgScore} (${results.length} 题, 工程失败剔除 ${engStats.excludedTotal})`);
    console.log(`         token: input ${oldIn} → ${tokenInput} | output ${(oldSummary as { totalOutputTokens?: number }).totalOutputTokens ?? 0} → ${tokenOutput}`);

    // 打印维度明细
    for (const [dim, avg] of dimAvgs) {
      const w = DIMENSION_WEIGHTS[dim] ?? 0;
      console.log(`           ${dim}: ${Math.round(avg)} (维度权重 ${(w * 100).toFixed(0)}%)`);
    }
    console.log('');
    updated++;
  }

  console.log(`\n=== 完成！共更新 ${updated} 个运行 ===`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
