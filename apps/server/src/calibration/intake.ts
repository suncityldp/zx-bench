import type { PrismaClient } from '@prisma/client';
import type { CalibrationCandidate, CriterionResult, OutputMetadata, RunManifest, Scenario, ScenarioResult } from '@zxbench/types';
import { calibrationSplit, snapshotHash, verifyBenchmarkPack, sampleCalibrationCandidates } from '@zxbench/core';
import { decodeScenario } from '../evaluationSnapshot.js';
import type { CalibrationStore } from './store.js';
import { replayInstructionCriteria } from './replay.js';

const SEED = 'zxbench-p1-2026-09-08';
const parse = <T>(s: string | null | undefined, fallback: T): T => { try { return s ? JSON.parse(s) as T : fallback; } catch { return fallback; } };

export async function collectRunCandidates(prisma: PrismaClient, runId: string, includeControls = true): Promise<CalibrationCandidate[]> {
  const run = await prisma.evalRun.findUnique({ where: { id: runId }, include: { modelConfig: true, results: true } });
  if (!run) throw new Error('Run not found');
  const pack = parse<RunManifest | undefined>(run.manifest, undefined)?.benchmarkPack;
  if (pack) verifyBenchmarkPack(pack);
  const current = pack ? [] : await prisma.scenarioDefinition.findMany({ where: { id: { in: run.results.map(r => r.scenarioId) } } });
  const scenarios = new Map((pack?.scenarios ?? current.map(decodeScenario)).map(s => [s.id, s]));
  const candidates: CalibrationCandidate[] = [];
  for (const row of [...run.results].sort((a, b) => a.id.localeCompare(b.id, 'en'))) {
    const scenario = scenarios.get(row.scenarioId);
    if (!scenario) continue;
    const meta = parse<OutputMetadata>(row.outputMetadata, {} as OutputMetadata);
    const attempts = meta.evaluationAudit?.attempts ?? [{ ...row, outputMetadata: meta,
      evidence: parse<string[]>(row.evidence, []), criterionResults: meta.evaluationAudit?.criterionResults,
      judgeScoreHistory: meta.evaluationAudit?.judgeScoreHistory }];
    for (const [attemptIndex, attempt] of attempts.entries()) {
      const failureTypes: string[] = [];
      if (attempt.environmentError) failureTypes.push('environment_error');
      if (attempt.evidence.some(e => /^(JUDGE_FAILED|JUDGE_ENSEMBLE_PARTIAL):/.test(e))) failureTypes.push('judge_failure');
      if (attempt.outputMetadata.incomplete || attempt.outputMetadata.truncated) failureTypes.push('truncation');
      if (attempt.safetyLevel === 'red_line') failureTypes.push('safety_red_line');
      if (!attempt.modelOutput.trim()) failureTypes.push('empty_output');
      if (attempt.totalScore < 60) failureTypes.push('low_score');
      if (attempt.deterministicScore != null && attempt.judgeScore != null && Math.abs(attempt.deterministicScore - attempt.judgeScore) >= 25) failureTypes.push('judge_rule_disagreement');
      if (attempt.criterionResults?.some(c => c.status !== 'pass')) failureTypes.push('constraint_failure');
      if (!failureTypes.length && attempt.humanReviewRequired) failureTypes.push('human_review_requested');
      if (!failureTypes.length && !includeControls) continue;
      const automaticCriteria = attempt.criterionResults ?? [];
      const automaticSource: CalibrationCandidate['automaticSource'] = automaticCriteria.length ? 'saved_audit' : 'unavailable';
      const automaticGraderVersion = attempt.graderVersion;
      const declared = scenario.grader.startsWith('instruction_checklist')
        ? (scenario.requirements as unknown as { constraints?: Array<{ id: string; description: string; critical?: boolean }> })?.constraints : undefined;
      const criteria = declared?.length ? declared.map(c => ({ id: c.id, description: c.description || c.id, critical: c.critical === true }))
        : [{ id: 'overall_correct', description: '答案是否完整正确并满足题面要求（人工整体判定，不由总分推断）', critical: false }];
      if (criteria.some(c => !c.id) || new Set(criteria.map(c => c.id)).size !== criteria.length) continue;
      const answerHash = snapshotHash(attempt.modelOutput);
      const scenarioContentHash = snapshotHash(scenario);
      const { evaluationAudit: _audit, ...outputMetadata } = attempt.outputMetadata;
      const stable = { runId, resultId: row.id, attemptIndex, modelId: run.modelConfigId, modelName: run.modelConfig.name,
        scenario, scenarioContentHash, answerHash, modelOutput: attempt.modelOutput,
        reasoningContent: attempt.reasoningContent ?? undefined, outputMetadata, observedScore: attempt.totalScore,
        snapshotOrigin: pack ? 'run_manifest' as const : 'current_definition' as const,
        failureTypes, environmentError: attempt.environmentError === true, criteria, automaticCriteria, automaticSource,
        automaticGraderVersion, judgeScoreHistory: attempt.judgeScoreHistory ?? [],
        split: calibrationSplit(scenario, SEED), splitSeed: SEED, leakageGroup: scenario.id };
      candidates.push({ ...stable, id: snapshotHash(stable), collectedAt: new Date().toISOString() });
    }
  }
  return candidates;
}

export async function intakeRuns(prisma: PrismaClient, store: CalibrationStore, runIds: string[], count = 60, includeControls = true) {
  if (!runIds.length || runIds.length > 20) throw new Error('Select 1–20 runs');
  const candidates: CalibrationCandidate[] = [];
  for (const id of [...new Set(runIds)]) candidates.push(...await collectRunCandidates(prisma, id, includeControls));
  const selected = sampleCalibrationCandidates(candidates, count, SEED);
  let inserted = 0;
  let replayUnavailable = 0;
  for (const c of selected) {
    // Replay only the selected IF samples, and never run legacy regexes on the API thread.
    if (!c.automaticCriteria.length && c.scenario.grader.startsWith('instruction_checklist')) {
      const replay = await replayInstructionCriteria(c.scenario, c.modelOutput, c.outputMetadata ?? {} as OutputMetadata);
      c.automaticCriteria = replay.criteria;
      c.automaticIssue = replay.issue;
      c.automaticSource = replay.issue ? 'unavailable' : 'offline_rule_replay';
      c.automaticGraderVersion = replay.version;
      if (replay.issue) replayUnavailable++;
      const { id: _id, collectedAt: _time, ...content } = c;
      c.id = snapshotHash(content);
    }
    if (store.put(c)) inserted++;
  }
  return { inspectedCandidates: candidates.length, selected: selected.length, inserted,
    duplicates: selected.length - inserted, replayUnavailable, splitSeed: SEED,
    currentDefinitionSnapshots: selected.filter(c => c.snapshotOrigin === 'current_definition').length,
    controls: selected.filter(c => !c.failureTypes.length).length };
}
