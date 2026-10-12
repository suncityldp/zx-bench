import { beforeEach, expect, it, vi } from 'vitest';
import type { Scenario, ModelConfig, EvalRunConfig } from '@zxbench/types';
import { orchestrateEvaluation } from './orchestrator.js';
import { callModelWithRetry } from './model/caller.js';
import { execAsync } from './execution/execAsync.js';

vi.mock('./model/caller.js', () => ({ callModelWithRetry: vi.fn() }));
vi.mock('./execution/execAsync.js', () => ({ execAsync: vi.fn() }));
vi.mock('./execution/containerRunner.js', async original => ({ ...await original<object>(), isDockerAvailable: vi.fn().mockResolvedValue(true) }));

const scenario = { id: 'PREFLIGHT-FIXTURE', dimension: 'cli_deep_tasks', grader: 'cli_command', graderVersion: '1',
  promptTemplate: 'Produce a command', scenarioVersion: '1', scenarioHash: 'fixture', requirements: {
    executionCases: [{ input: 'a' }], executionImage: 'python:fixture', executionImageId: 'frozen',
  }, scoring: {} } as unknown as Scenario;
const model = { id: 'mock', name: 'mock', provider: 'openai', baseUrl: 'https://example.invalid', defaultParams: {} } as ModelConfig;
const evalConfig = { judgeEnabled: false, runsPerQuestion: 1, safetyCheckEnabled: false, hiddenTestsEnabled: false } as EvalRunConfig;
beforeEach(() => { vi.clearAllMocks(); });

it.each([
  { status: 1, stdout: '', stderr: 'No such image' },
  { status: 0, stdout: '[{"Id":"moved","Os":"linux"}]', stderr: '' },
])('pauses CLI generation before any model request on missing/drifted images: %s', async result => {
  vi.mocked(execAsync).mockResolvedValue(result);
  await expect(orchestrateEvaluation({ scenario, modelConfig: model, modelParams: {}, evalConfig })).rejects.toThrow('DOCKER_NOT_READY:');
  expect(callModelWithRetry).not.toHaveBeenCalled();
  expect(execAsync).toHaveBeenCalledWith('docker', ['image', 'inspect', 'python:fixture'], { timeout: 15_000 });
});
