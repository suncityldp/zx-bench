import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scenario, EvalRunConfig, ModelConfig, ModelResponse, JudgeResult } from '@zxbench/types';
import { orchestrateEvaluation } from './orchestrator.js';
import { runMultipleEvaluations } from './multi-run/index.js';
import { registerEvaluator } from './evaluators/index.js';
import { instructionChecklistEvaluator } from './evaluators/instructionChecklist.js';
import { callModelWithRetry } from './model/caller.js';
import { runJudgeEnsemble } from './judge/index.js';
vi.mock('./model/caller.js', () => ({ callModelWithRetry: vi.fn() }));
vi.mock('./judge/index.js', async importOriginal => ({ ...await importOriginal<object>(), runJudgeEnsemble: vi.fn() }));
const s = { id: 'AUDIT', dimension: 'hallucination_resistance', grader: 'audit_fixture', graderVersion: '1',
  promptTemplate: 'answer', scenarioVersion: '1', scenarioHash: 'hash', requirements: [], scoring: {} } as unknown as Scenario;
const model = { id: 'mock', name: 'mock', provider: 'openai', baseUrl: 'https://example.invalid', defaultParams: {} } as ModelConfig;
const config = { maxTokens: 1024, temperature: 0, runsPerQuestion: 1, judgeEnabled: true, judgeEnsembleRuns: 2,
  safetyCheckEnabled: false, hiddenTestsEnabled: false, structuredOutputEnabled: false } as EvalRunConfig;
const judgment = (factuality: number) => ({ factuality, confidence: 1, verdict: 'correct', evidence: [], notes: [], tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as unknown as JudgeResult);
beforeEach(() => {
  vi.clearAllMocks();
  registerEvaluator({ name: 'audit_fixture', version: '1', evaluate: async () => ({ totalScore: 100, axisScores: { factuality: 100 }, safetyLevel: 'safe', evidence: [] }) });
  registerEvaluator(instructionChecklistEvaluator);
  vi.mocked(callModelWithRetry).mockResolvedValue({ content: 'answer', finishReason: 'stop', latencyMs: 1, usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } } as ModelResponse);
  vi.mocked(runJudgeEnsemble).mockResolvedValue({ localJudge: judgment(.5), finalJudge: judgment(.5), escalated: false, runs: [judgment(.2), judgment(.8)], failures: [] });
});
describe('end-to-end candidate vs Judge accounting (mock transport)', () => {
  it('Judge ensemble never masquerades as independent candidate attempts', async () => {
    const r = await orchestrateEvaluation({ scenario: s, modelConfig: model, modelParams: {}, evalConfig: config, judgeOptions: { localModel: model } });
    expect(callModelWithRetry).toHaveBeenCalledTimes(1);
    expect(r.runCount).toBe(1);
    expect(r.scoreHistory).toEqual([r.totalScore]);
    expect(r.judgeScoreHistory).toEqual([20, 80]);
    expect(JSON.parse(JSON.stringify(r)).outputMetadata.evaluationAudit.judgeScoreHistory).toEqual([20, 80]);
  });
  it('candidate repeat count controls actual generation calls and preserves every output', async () => {
    const r = await runMultipleEvaluations(s, { scenario: s, modelConfig: model, modelParams: {}, evalConfig: { ...config, judgeEnabled: false }, runsPerQuestion: 3 });
    expect(callModelWithRetry).toHaveBeenCalledTimes(3);
    expect(r.outputMetadata.evaluationAudit?.attempts).toHaveLength(3);
    expect(r.runCount).toBe(3);
  });
  it.each([0, -1, 1.2, 11, NaN])('rejects invalid repeat counts before model calls: %s', async count => {
    await expect(runMultipleEvaluations(s, { scenario: s, modelConfig: model, modelParams: {}, evalConfig: config, runsPerQuestion: count })).rejects.toThrow('runsPerQuestion');
    expect(callModelWithRetry).not.toHaveBeenCalled();
  });
  it('preserves earlier paid attempts after a later request failure', async () => {
    vi.mocked(callModelWithRetry).mockResolvedValueOnce({ content: 'answer', finishReason: 'stop', latencyMs: 1, usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } } as ModelResponse)
      .mockRejectedValueOnce(new Error('transport down'));
    const r = await runMultipleEvaluations(s, { scenario: s, modelConfig: model, modelParams: {}, evalConfig: { ...config, judgeEnabled: false }, runsPerQuestion: 3 });
    expect(r.outputMetadata.evaluationAudit?.attempts).toHaveLength(2);
    expect(r.multiRunStats?.environmentErrorCount).toBe(1);
    expect(r.evidence.some(e => e.startsWith('CANDIDATE_REPEATS_PARTIAL:'))).toBe(true);
    expect(callModelWithRetry).toHaveBeenCalledTimes(2);
  });
  it('honors pause/cancel checkpoints between independent attempts', async () => {
    const beforeAttempt = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const r = await runMultipleEvaluations(s, { scenario: s, modelConfig: model, modelParams: {}, evalConfig: { ...config, judgeEnabled: false }, runsPerQuestion: 3, beforeAttempt });
    expect(callModelWithRetry).toHaveBeenCalledTimes(1);
    expect(r.evidence.some(e => e.startsWith('CANDIDATE_REPEATS_PARTIAL:'))).toBe(true);
  });
  it('early empty answer has failing criteria and durable audit metadata', async () => {
    vi.mocked(callModelWithRetry).mockResolvedValue({ content: '', finishReason: 'stop', latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as ModelResponse);
    const scenario = { ...s, dimension: 'instruction_following', grader: 'instruction_checklist',
      requirements: { constraints: [{ id: 'required', description: 'include answer', critical: true }] } } as unknown as Scenario;
    const r = await orchestrateEvaluation({ scenario, modelConfig: model, modelParams: {}, evalConfig: { ...config, judgeEnabled: false } });
    expect(r.criterionResults?.[0].status).toBe('fail');
    expect(r.outputMetadata.evaluationAudit?.criterionResults).toHaveLength(1);
  });
});
