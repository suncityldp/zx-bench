import { beforeEach, expect, it, vi } from 'vitest';
import type { EvalRunConfig, ModelConfig, ModelResponse, Scenario, RuntimeEvaluation, RunManifest } from '@zxbench/types';
import { orchestrateEvaluation, generateManifest } from './orchestrator.js';
import { registerEvaluator } from './evaluators/index.js';
import { callModelWithRetry } from './model/caller.js';
import { runTieredJudge } from './judge/index.js';
import { checkRegression } from './regression.js';
vi.mock('./model/caller.js', () => ({ callModelWithRetry: vi.fn() }));
vi.mock('./judge/index.js', async original => ({ ...await original<object>(), runTieredJudge: vi.fn() }));
const runtime: RuntimeEvaluation = { compilePassed: false, compileError: 'syntax error', testsPassed: 0,
  testsFailed: 1, testsTotal: 1, hiddenTestsPassed: 0, hiddenTestsFailed: 1, hiddenTestsTotal: 1,
  details: [{ testId: 'actual-test', passed: false, stderr: 'syntax error' }] };
const scenario = { id: 'execution-audit', dimension: 'program', grader: 'execution_audit', graderVersion: 'old',
  scenarioVersion: '1', scenarioHash: 'hash', promptTemplate: 'repair', requirements: {} } as Scenario;
const model = { name: 'mock', defaultParams: {} } as ModelConfig;
beforeEach(() => {
  vi.clearAllMocks();
  registerEvaluator({ name: 'execution_audit', version: 'new', compatibleVersions: ['old'], evaluate: async () => ({
    totalScore: 20, axisScores: { compilation: 0, test_pass: 0 }, axisEvidence: { compilation: 'verified', test_pass: 'verified' },
    axisCoverage: .4, runtimeEvaluation: runtime, evidence: [],
  }) });
  vi.mocked(runTieredJudge).mockResolvedValue({ finalJudge: { confidence: 1, verdict: 'correct', bug_detection: 1,
    root_cause: 1, patch_correctness: 1, scope_discipline: 1, output_completeness: 1, notes: [], evidence: [] }, escalated: false } as any);
});
it.each([false, true])('persists actual execution and scorer identity with Judge=%s', async judgeEnabled => {
  const result = await orchestrateEvaluation({ scenario, modelConfig: model, modelParams: {},
    evalConfig: { judgeEnabled, judgeEnsembleRuns: 1, safetyCheckEnabled: false } as EvalRunConfig,
    judgeOptions: judgeEnabled ? { localModel: model } : undefined,
    savedCandidate: { response: { content: 'candidate answer', finishReason: 'stop', latencyMs: 1,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as ModelResponse, metadata: {} as any },
  });
  expect(callModelWithRetry).not.toHaveBeenCalled();
  expect(result.runtimeEvaluation).toEqual(runtime);
  expect(result.axisCoverage).toBe(.4);
  expect(result.axisScores).toMatchObject({ compilation: 0, test_pass: 0 });
  expect(result.graderVersion).toBe('execution_audit@new');
  const stored = JSON.parse(JSON.stringify(result.outputMetadata)).evaluationAudit;
  expect(stored).toMatchObject({ axisCoverage: .4, graderVersion: 'execution_audit@new', runtimeEvaluation: runtime });
  if (!judgeEnabled) { expect(result.totalScore).toBe(6); expect(result.deterministicScore).toBe(20); }
});
it('new manifests identify the changed scoring implementation and reject cross-version regression comparisons', () => {
  const manifest = generateManifest('new-run', model, {}, {} as EvalRunConfig, 'hash');
  expect(manifest.scorers.version).toBe('scorer-2026-09-08-execution-v2-reviewed');
  const old = { ...manifest, scorers: { ...manifest.scorers, version: 'scorer-2026-09-07-audit-v1' } } as RunManifest;
  const result = checkRegression({ manifest: old, results: [] }, { manifest, results: [] });
  expect(result.issues).toContain('Scorer versions differ');
});
