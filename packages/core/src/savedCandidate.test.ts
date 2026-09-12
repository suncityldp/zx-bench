import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scenario, ModelConfig, EvalRunConfig, ModelResponse, OutputMetadata } from '@zxbench/types';
import { orchestrateEvaluation } from './orchestrator.js';
import { registerEvaluator } from './evaluators/index.js';
import { callModelWithRetry } from './model/caller.js';
import { isDockerAvailable } from './execution/containerRunner.js';
vi.mock('./model/caller.js', () => ({ callModelWithRetry: vi.fn() }));
vi.mock('./execution/containerRunner.js', async original => ({ ...await original<object>(), isDockerAvailable: vi.fn() }));
const scenario = { id: 'REPLAY', dimension: 'program', grader: 'replay_fixture', graderVersion: '1',
  scenarioVersion: '1', promptTemplate: 'fix code', requirements: [], scoring: {} } as unknown as Scenario;
const model = { name: 'never-called', baseUrl: 'https://example.invalid', defaultParams: {} } as ModelConfig;
const config = { judgeEnabled: false, safetyCheckEnabled: false } as EvalRunConfig;
const metadata = { inputTokens: 123, outputTokens: 456, reasoningTokens: 400, inferenceMs: 789,
  finishReason: 'length', incomplete: true, truncated: true, outputLength: 6 } as OutputMetadata;
const response = { content: 'answer', finishReason: 'length', reasoningContent: 'original reasoning',
  latencyMs: 789, usage: { inputTokens: 123, outputTokens: 456, totalTokens: 579 } } as ModelResponse;
beforeEach(() => {
  vi.clearAllMocks();
  registerEvaluator({ name: 'replay_fixture', version: '1', evaluate: async () => ({ totalScore: 80, axisScores: { test_pass: 80 }, axisEvidence: { test_pass: 'verified' }, evidence: ['tests executed'] }) });
});
describe('immutable saved candidate replay', () => {
  it('uses the original answer and timing without candidate generation or startup preflight', async () => {
    const result = await orchestrateEvaluation({ scenario, modelConfig: model, modelParams: {}, evalConfig: config,
      savedCandidate: { response, metadata } });
    expect(callModelWithRetry).not.toHaveBeenCalled();
    expect(isDockerAvailable).not.toHaveBeenCalled();
    expect(result.modelOutput).toBe(response.content);
    expect(result.reasoningContent).toBe(response.reasoningContent);
    expect(result.outputMetadata).toMatchObject(metadata);
    expect(result.totalScore).toBe(80);
  });
  it('never retries generation even if a saved answer is empty and token-limited', async () => {
    await orchestrateEvaluation({ scenario, modelConfig: model, modelParams: {}, evalConfig: config,
      savedCandidate: { response: { ...response, content: '' }, metadata } });
    expect(callModelWithRetry).not.toHaveBeenCalled();
  });
  it('blocks new generation when Docker startup fails, without scoring a zero', async () => {
    vi.mocked(isDockerAvailable).mockResolvedValue(false);
    await expect(orchestrateEvaluation({ scenario, modelConfig: model, modelParams: {}, evalConfig: config })).rejects.toThrow('DOCKER_NOT_READY:');
    expect(callModelWithRetry).not.toHaveBeenCalled();
  });
});
