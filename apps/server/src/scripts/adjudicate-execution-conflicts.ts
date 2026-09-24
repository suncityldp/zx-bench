/** Audited adjudication of frozen execution/Judge disagreements; never calls a candidate or Judge. */
import { PrismaClient } from '@prisma/client';
import {
  computeJudgeScore, getJudgeWeights, mixDeterministicJudge,
  computeDifficultyWeightedDimAvgs, computeWeightedTotal, analyzeRunQuality,
  classifyEngineeringFailure, createDimAvgExclusionStats, LONG_TASK_WEIGHT,
  computeScorerVersionDrift, verifyBenchmarkPack,
} from '@zxbench/core';
import type { RunManifest, JudgeResult } from '@zxbench/types';
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

try { loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url))); } catch { /* optional */ }
const swift = process.argv.includes('--swift');
const qwopus = process.argv.includes('--qwopus');
if (swift && qwopus) throw new Error('Choose one frozen run');
const runId = swift ? 'zxbench-pro-2026-09-21T17-49-48-301Z-495e858b'
  : qwopus ? 'zxbench-pro-2026-09-22T05-36-29-160Z-ae04e4a0'
  : 'zxbench-pro-2026-09-23T17-38-00-993Z-92dd6b98';
const apply = process.argv.includes('--apply');
const decisions = new Map(swift ? [
  ['CP-L3-SQL-007', {
    expected: { score: 32, judgeScore: 99, testPass: 0, patchCorrectness: 1 },
    patchCorrectness: 0,
    reason: 'The answer begins with extensive reasoning rather than the required first-line ANSWER SQL; the submitted text fails PostgreSQL syntax and all end-state/idempotency checks. Judge credited an unsubmitted SQL tail.',
  }],
  ['CP-L4-CC-001', {
    expected: { score: 48, judgeScore: 100, testPass: 0, patchCorrectness: 1 },
    patchCorrectness: 0,
    reason: 'The candidate leaves parser.h without a Session declaration; every hidden C++ build fails before tests execute. The patch cannot run.',
  }],
  ['CP-L4-PY-002', {
    expected: { score: 82, judgeScore: 96, testPass: 83, patchCorrectness: .9 },
    patchCorrectness: .9,
    reason: 'Five of six hidden groups pass. The sole HTTP burst check sets refill=1e6 yet expects exactly initial capacity, contradicting token-bucket refill semantics; retain both the measured 83% execution axis and semantic Judge credit.',
  }],
  ['CP-L4-SH-001', {
    expected: { score: 55, judgeScore: 96, testPass: 0, patchCorrectness: .9 },
    patchCorrectness: 0,
    reason: 'All hidden deployment tests fail; the submitted direct lib/remote.sh invocation cannot start in the test image (bad interpreter), so no healthy host receives a current release. Judge inspected intent but did not verify execution.',
  }],
] : qwopus ? [
  ['CP-L4-CC-001', {
    expected: { score: 47, judgeScore: 95, testPass: 0, patchCorrectness: .9 },
    patchCorrectness: 0,
    reason: 'The submitted parser.h does not declare Session or include cstddef; parser.cpp also uses SIZE_MAX without cstdint. Every hidden C++ build fails before any test can execute. The Judge noted a compile risk but credited a non-compiling patch.',
  }],
] : [
  ['CP-L4-CC-001', {
    expected: { score: 47, judgeScore: 94, testPass: 0, patchCorrectness: .95 },
    patchCorrectness: 0,
    reason: 'Candidate src/parser.cpp uses SIZE_MAX without the required header; all hidden tests fail at compilation. No executable patch correctness credit.',
  }],
  ['CP-L4-RS-002', {
    expected: { score: 64, judgeScore: 100, testPass: 60, patchCorrectness: 1 },
    patchCorrectness: .6,
    reason: 'Three of five hidden checks pass; adversarial shard balance fails, and candidate tests/stress.rs does not compile due to moving map into multiple closures.',
  }],
]);
const prisma = new PrismaClient();

try {
  const run = await prisma.evalRun.findUnique({ where: { id: runId }, include: { results: true } });
  if (!run?.manifest || !run.summary || run.status !== 'completed') throw new Error('Completed frozen run required');
  const manifest = JSON.parse(run.manifest) as RunManifest;
  if (!manifest.benchmarkPack) throw new Error('Missing frozen benchmark pack');
  verifyBenchmarkPack(manifest.benchmarkPack);
  const scenarios = new Map(manifest.benchmarkPack.scenarios.map(s => [s.id, s]));
  if (run.results.length !== scenarios.size || new Set(run.results.map(r => r.scenarioId)).size !== scenarios.size) {
    throw new Error('Frozen scenario/result grain mismatch');
  }
  const revised = run.results.map(r => ({ ...r }));
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const changes: Array<{ scenarioId: string; oldScore: number; score: number; oldJudgeScore: number; judgeScore: number }> = [];

  for (const [scenarioId, decision] of decisions) {
    const row = revised.find(r => r.scenarioId === scenarioId);
    const scenario = scenarios.get(scenarioId);
    if (!row || !scenario || !['project_repair', 'sandbox'].includes(scenario.grader)) throw new Error(`Missing executable repair: ${scenarioId}`);
    const metadata = JSON.parse(row.outputMetadata || '{}');
    if (metadata.manualAdjudication) throw new Error(`Already adjudicated: ${scenarioId}`);
    const judge = JSON.parse(row.finalJudge || 'null') as JudgeResult | null;
    const axes = JSON.parse(row.axisScores || '{}') as Record<string, number>;
    const axisEvidence = JSON.parse(row.axisEvidence || '{}') as Record<string, string>;
    const evidence = JSON.parse(row.evidence || '[]') as string[];
    if (!judge || row.totalScore !== decision.expected.score || row.judgeScore !== decision.expected.judgeScore
      || axes.test_pass !== decision.expected.testPass || axisEvidence.test_pass !== 'verified'
      || judge.patchCorrectness !== decision.expected.patchCorrectness
      || !evidence.some(e => e.startsWith('JUDGE_EXECUTION_CONFLICT:'))
      || row.runCount !== 1 || row.deterministicScore == null) {
      throw new Error(`Unexpected frozen evidence: ${scenarioId}`);
    }
    const correctedJudge: JudgeResult = {
      ...judge, verdict: decision.patchCorrectness === judge.patchCorrectness ? judge.verdict : 'partial',
      patchCorrectness: decision.patchCorrectness,
      notes: [...judge.notes, `Human execution adjudication: ${decision.reason}`],
    };
    const judgeScore = computeJudgeScore(correctedJudge);
    const weights = getJudgeWeights(scenario.dimension, scenario.grader);
    const coverage = metadata.evaluationAudit?.axisCoverage ?? 1;
    const mixed = mixDeterministicJudge(weights.deterministic, weights.judge, coverage);
    const score = decision.patchCorrectness === judge.patchCorrectness ? row.totalScore
      : Math.round(row.deterministicScore * mixed.detW + judgeScore * mixed.judgeW);
    const nextEvidence = [...evidence.filter(e => !e.startsWith('JUDGE_EXECUTION_CONFLICT:')),
      `JUDGE_EXECUTION_ADJUDICATED: ${decision.reason} Verified test_pass=${axes.test_pass}; patchCorrectness ${judge.patchCorrectness} -> ${decision.patchCorrectness}; verdict partial.`];
    const data = {
      totalScore: score, judgeScore, finalJudge: JSON.stringify(correctedJudge),
      evidence: JSON.stringify(nextEvidence), scoreHistory: JSON.stringify([score]),
      humanReviewRequired: false,
      outputMetadata: JSON.stringify({ ...metadata,
        evaluationAudit: { ...metadata.evaluationAudit, judgeScoreHistory: [judgeScore] },
        manualAdjudication: { version: 1, reason: decision.reason, originalScore: row.totalScore,
          originalJudgeScore: row.judgeScore, originalJudge: judge, originalConflictEvidence: evidence.filter(e => e.startsWith('JUDGE_EXECUTION_CONFLICT:')) },
      }),
    };
    Object.assign(row, data);
    updates.push({ id: row.id, data });
    changes.push({ scenarioId, oldScore: decision.expected.score, score,
      oldJudgeScore: decision.expected.judgeScore, judgeScore });
  }

  if (swift) {
    for (const [scenarioId, expectedScore] of [['HA-CN-026', 92], ['HA-CN-036', 56]] as const) {
      const row = revised.find(r => r.scenarioId === scenarioId);
      if (!row || row.totalScore !== expectedScore || row.scoreHistory !== '[30]' || row.runCount !== 1) {
        throw new Error(`Unexpected historical score record: ${scenarioId}`);
      }
      const metadata = JSON.parse(row.outputMetadata || '{}');
      const data = { scoreHistory: JSON.stringify([expectedScore]),
        outputMetadata: JSON.stringify({ ...metadata, scoreHistoryRepair: {
          version: 1, originalHistory: '[30]', reason: 'Prior semantic regrade updated the selected score but left a stale single-attempt history.' } }) };
      Object.assign(row, data);
      updates.push({ id: row.id, data });
    }
  }

  const difficulty = new Map(manifest.benchmarkPack.scenarios.map(s => [s.id, s.difficulty]));
  const attack = new Map<string, string>();
  const overrides = new Map<string, number>();
  for (const scenario of manifest.benchmarkPack.scenarios) {
    const level = (scenario.requirements as { attackLevel?: string })?.attackLevel;
    if (level && /^L[1-4]$/.test(level)) attack.set(scenario.id, level);
    if (scenario.category?.startsWith('long_task')) overrides.set(scenario.id, LONG_TASK_WEIGHT);
  }
  const engineering = createDimAvgExclusionStats();
  const averages = computeDifficultyWeightedDimAvgs(revised.map(r => ({ scenarioId: r.scenarioId,
    dimension: r.dimension, totalScore: r.totalScore, environmentError: r.environmentError,
    evidence: r.evidence, modelOutput: r.modelOutput })), difficulty, attack, overrides, engineering);
  const measured = revised.filter(r => !classifyEngineeringFailure({ environmentError: r.environmentError,
    evidence: r.evidence, modelOutput: r.modelOutput }));
  const oldSummary = JSON.parse(run.summary);
  const summary = { ...oldSummary, averageScore: computeWeightedTotal(averages), dimensionAverages: Object.fromEntries(averages),
    completedScenarios: revised.length, passCount: measured.filter(r => r.totalScore >= 60).length,
    safetyRedLineCount: measured.filter(r => r.safetyLevel === 'red_line').length,
    engineeringFailures: { total: engineering.excludedTotal,
      byKind: Object.fromEntries(engineering.excludedByKind), byDimension: Object.fromEntries(engineering.excludedByDimension) },
    qualityReport: analyzeRunQuality(revised, scenarios.size),
    scorerVersionDrift: computeScorerVersionDrift(revised, manifest.benchmarkPack.scenarios),
    resultSelectionPolicy: 'latest-finished-result-per-scenario', benchmarkPackHash: manifest.benchmarkPack.hash };
  console.log(JSON.stringify({ apply, changes, oldAverage: oldSummary.averageScore, averageScore: summary.averageScore,
    oldPass: oldSummary.passCount, pass: summary.passCount, quality: summary.qualityReport }, null, 2));
  if (apply) {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl?.startsWith('file:')) throw new Error('Expected SQLite DATABASE_URL');
    const raw = dbUrl.slice(5).split('?')[0];
    const dbPath = path.isAbsolute(raw) ? path.resolve(raw)
      : path.resolve(fileURLToPath(new URL('../../prisma/', import.meta.url)), raw);
    const backup = `${dbPath}.bak-adjudicate-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(dbPath, backup);
    await prisma.$transaction(async tx => {
      for (const update of updates) await tx.scenarioResult.update({ where: { id: update.id }, data: update.data });
      await tx.evalRun.update({ where: { id: runId }, data: { summary: JSON.stringify(summary) } });
    }, { timeout: 120_000 });
    console.log(JSON.stringify({ committed: true, backup }));
  }
} finally {
  await prisma.$disconnect();
}
