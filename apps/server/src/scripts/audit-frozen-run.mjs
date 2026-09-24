/** Read-only, per-question quality inventory for one completed frozen run. */
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyBenchmarkPack, analyzeRunQuality } from '@zxbench/core';

process.loadEnvFile(new URL('../../.env', import.meta.url));
const runId = process.argv[2];
if (!runId) throw new Error('Usage: node audit-frozen-run.mjs RUN_ID');
const prisma = new PrismaClient();
const parse = (value, fallback) => {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};
const sha = value => createHash('sha256').update(value ?? '').digest('hex');

try {
  const run = await prisma.evalRun.findUniqueOrThrow({ where: { id: runId }, include: { results: true, modelConfig: true } });
  if (run.status !== 'completed' || !run.manifest || !run.summary) throw new Error('Completed frozen run required');
  const manifest = parse(run.manifest, null);
  verifyBenchmarkPack(manifest.benchmarkPack);
  const scenarios = manifest.benchmarkPack.scenarios;
  const byId = new Map(scenarios.map(s => [s.id, s]));
  const unique = new Set(run.results.map(r => r.scenarioId));
  if (run.results.length !== scenarios.length || unique.size !== scenarios.length) {
    throw new Error(`Result grain mismatch: ${run.results.length} rows, ${unique.size} unique, ${scenarios.length} scenarios`);
  }
  const ledger = run.results.map(row => {
    const scenario = byId.get(row.scenarioId);
    if (!scenario) throw new Error(`Result absent from frozen pack: ${row.scenarioId}`);
    const meta = parse(row.outputMetadata, {});
    const evidence = parse(row.evidence, []);
    const history = parse(row.scoreHistory, []);
    const flags = [];
    const progressive = scenario.category === 'ultra_progressive_exam' && scenario.requirements?.partNumber > 1;
    if (progressive && (meta.evaluationRepair?.kind ?? meta.swiftRepair?.kind) !== 'progressive') flags.push('progressive_not_replayed');
    if (row.environmentError) flags.push('environment_error');
    if (!row.modelOutput.trim()) flags.push('empty_answer');
    if (meta.finishReason === 'length') flags.push('output_limit');
    if (evidence.some(e => e.startsWith('HARD_TIME_LIMIT:'))) flags.push('hard_time_limit');
    if (evidence.some(e => e.startsWith('REASONING_TOKEN_BUDGET:'))) flags.push('reasoning_budget_exhausted');
    if (evidence.some(e => e.startsWith('JUDGE_EXECUTION_CONFLICT:'))) flags.push('judge_execution_conflict');
    if (evidence.some(e => e.startsWith('CLI_LEXICAL_JUDGE_CONFLICT:'))
      && !evidence.some(e => e.startsWith('CLI_SEMANTIC_REVIEW:'))) flags.push('cli_judge_conflict');
    if (evidence.some(e => e.startsWith('CITATION_UNVERIFIABLE:'))) flags.push('citation_needs_external_verification');
    if (evidence.some(e => e.startsWith('COMPILATION_FAILED:'))
      || evidence.some(e => e.startsWith('EXECUTION_EVIDENCE:') && /"passed":false/.test(e))) flags.push('verified_execution_failure');
    if (row.runCount === 1 && (history.length !== 1 || history[0] !== row.totalScore)) flags.push('score_history_mismatch');
    if (row.totalScore < 60) flags.push('low_score');
    if (row.totalScore === 0) flags.push('zero_score');
    if (row.safetyLevel === 'red_line') flags.push('safety_red_line');
    if (row.humanReviewRequired) flags.push('human_review');
    return {
      id: row.scenarioId, dimension: row.dimension, grader: scenario.grader,
      score: row.totalScore, deterministicScore: row.deterministicScore, judgeScore: row.judgeScore,
      answerSha256: sha(row.modelOutput), answerBytes: Buffer.byteLength(row.modelOutput),
      progressive, repairedAt: progressive ? (meta.evaluationRepair?.at ?? meta.swiftRepair?.at ?? null) : null,
      flags, evidence: flags.includes('low_score') || flags.includes('human_review')
        ? evidence.filter(e => !e.startsWith('EXECUTION_EVIDENCE:') && !e.startsWith('EVALUATION_REPAIR:')).slice(0, 8)
        : [],
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const counts = {};
  for (const row of ledger) for (const flag of row.flags) counts[flag] = (counts[flag] ?? 0) + 1;
  const summary = parse(run.summary, {});
  const quality = analyzeRunQuality(run.results, scenarios.length);
  const report = {
    version: 1, runId, model: run.modelConfig.name, benchmarkPackHash: manifest.benchmarkPack.hash,
    rows: ledger.length, uniqueRows: unique.size, progressiveExpected: ledger.filter(r => r.progressive).length,
    progressiveReplayed: ledger.filter(r => r.progressive && !r.flags.includes('progressive_not_replayed')).length,
    averageScore: summary.averageScore, dimensionAverages: summary.dimensionAverages,
    flags: counts, quality, ledger,
  };
  const output = resolve('logs', `quality-ledger-${runId}.json`);
  mkdirSync(resolve('logs'), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, runId, rows: report.rows, uniqueRows: report.uniqueRows,
    progressiveExpected: report.progressiveExpected, progressiveReplayed: report.progressiveReplayed,
    averageScore: report.averageScore, flags: counts, quality: { grade: quality.grade, scoringComplete: quality.scoringComplete } }, null, 2));
} finally { await prisma.$disconnect(); }
