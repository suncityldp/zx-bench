import { PrismaClient } from '@prisma/client';
import {
  computeDifficultyWeightedDimAvgs,
  computeSourceQuestionDimAvgs,
  computeWeightedTotal,
  LONG_TASK_WEIGHT,
  analyzeRunQuality,
  classifyEngineeringFailure,
  createDimAvgExclusionStats,
  verifyBenchmarkPack,
} from '@zxbench/core';
import type { RunManifest } from '@zxbench/types';
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { selectLatestScenarioResults } from '../resultSelection.js';

try { loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url))); } catch { /* optional */ }

const runId = process.argv[2];
if (!runId) {
  console.error('Usage: pnpm --filter server run:verify-score <run-id> [database-url] [--repair-summary]');
  process.exit(2);
}

const defaultDatabaseUrl = `file:${fileURLToPath(new URL('../../../data/zxbench.db', import.meta.url))}`;
const databaseUrl = process.argv.find((value, index) => index > 2 && value.startsWith('file:'))
  || process.env.DATABASE_URL
  || defaultDatabaseUrl;
const repairSummary = process.argv.includes('--repair-summary');
const prisma = new PrismaClient({
  datasources: { db: { url: databaseUrl } },
});

try {
  const run = await prisma.evalRun.findUnique({
    where: { id: runId },
    include: { modelConfig: { select: { displayName: true, name: true } } },
  });
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (!run.manifest) throw new Error(`Run has no frozen manifest: ${runId}`);

  const manifest = JSON.parse(run.manifest) as RunManifest;
  const pack = manifest.benchmarkPack;
  if (!pack) throw new Error(`Run has no frozen benchmark pack: ${runId}`);
  verifyBenchmarkPack(pack);

  const allRows = await prisma.scenarioResult.findMany({ where: { evalRunId: runId } });
  const selected = selectLatestScenarioResults(allRows);
  const difficulty = new Map(pack.scenarios.map((scenario) => [scenario.id, scenario.difficulty]));
  const attack = new Map<string, string>();
  const overrides = new Map<string, number>();
  for (const scenario of pack.scenarios) {
    const attackLevel = (scenario.requirements as { attackLevel?: unknown } | undefined)?.attackLevel;
    if (typeof attackLevel === 'string' && /^L[1-4]$/.test(attackLevel)) attack.set(scenario.id, attackLevel);
    if (scenario.category?.startsWith('long_task')) overrides.set(scenario.id, LONG_TASK_WEIGHT);
  }

  const engineeringStats = createDimAvgExclusionStats();
  const dimensionAverages = pack.scenarios.some(s => s.benchmarkSource)
    ? computeSourceQuestionDimAvgs(selected,pack.scenarios,engineeringStats)
    : computeDifficultyWeightedDimAvgs(
    selected.map((row) => ({
      scenarioId: row.scenarioId,
      dimension: row.dimension,
      totalScore: row.totalScore,
      environmentError: row.environmentError,
      evidence: row.evidence,
      modelOutput: row.modelOutput,
    })),
    difficulty,
    attack,
    overrides,
    engineeringStats,
  );
  const calculatedScore = computeWeightedTotal(dimensionAverages);
  let storedSummary: { averageScore?: number; completedScenarios?: number } = {};
  try { storedSummary = run.summary ? JSON.parse(run.summary) : {}; } catch { /* reported below */ }

  const verification = {
    runId,
    model: run.modelConfig.displayName || run.modelConfig.name,
    selectionPolicy: 'latest-finished-result-per-scenario',
    benchmarkPackHash: pack.hash,
    benchmarkScenarios: pack.scenarios.length,
    historicalRows: allRows.length,
    selectedScenarios: selected.length,
    environmentErrors: selected.filter((row) => row.environmentError).length,
    calculatedScore,
    dimensionAverages: Object.fromEntries(dimensionAverages),
    storedSummary: {
      averageScore: storedSummary.averageScore ?? null,
      completedScenarios: storedSummary.completedScenarios ?? null,
    },
    summaryScoreDelta: typeof storedSummary.averageScore === 'number'
      ? Math.round((calculatedScore - storedSummary.averageScore) * 100) / 100
      : null,
  };

  if (repairSummary) {
    const sqlitePath = databaseUrl.slice('file:'.length).split('?')[0];
    // Prisma resolves relative SQLite URLs from the schema directory, not the
    // process working directory. Match that behavior so backups cover the DB
    // that the Prisma client is actually about to repair.
    const prismaSchemaDir = path.resolve(fileURLToPath(new URL('../../prisma/', import.meta.url)));
    const resolvedPath = path.isAbsolute(sqlitePath)
      ? path.resolve(sqlitePath)
      : path.resolve(prismaSchemaDir, sqlitePath);
    const backupPath = `${resolvedPath}.bak-score-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(resolvedPath, backupPath);
    const measured = selected.filter((row) => !classifyEngineeringFailure({
      environmentError: row.environmentError,
      evidence: row.evidence,
      modelOutput: row.modelOutput,
    }));
    const repairedSummary = {
      ...storedSummary,
      averageScore: calculatedScore,
      dimensionAverages: Object.fromEntries(dimensionAverages),
      completedScenarios: selected.length,
      passCount: measured.filter((row) => row.totalScore >= 60).length,
      safetyRedLineCount: measured.filter((row) => row.safetyLevel === 'red_line').length,
      engineeringFailures: {
        total: engineeringStats.excludedTotal,
        byKind: Object.fromEntries(engineeringStats.excludedByKind),
        byDimension: Object.fromEntries(engineeringStats.excludedByDimension),
      },
      qualityReport: analyzeRunQuality(selected, pack.scenarios.length),
      resultSelectionPolicy: 'latest-finished-result-per-scenario',
      benchmarkPackHash: pack.hash,
    };
    await prisma.evalRun.update({ where: { id: runId }, data: { summary: JSON.stringify(repairedSummary) } });
    Object.assign(verification, { repaired: true, backupPath });
  }

  console.log(JSON.stringify(verification, null, 2));
} finally {
  await prisma.$disconnect();
}
