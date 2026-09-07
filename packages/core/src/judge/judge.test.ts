import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JudgeInput, ModelConfig, ModelResponse } from '@zxbench/types';
import { callModel } from '../model/caller.js';
import { runTieredJudge } from './index.js';
import { buildJudgeUserPrompt } from './prompts.js';
vi.mock('../model/caller.js', () => ({ callModel: vi.fn() }));
const input = { questionId: 'long', dimension: 'program', task: 'repair', candidateAnswer: {}, outputMetadata: {}, rawModelOutput: 'x'.repeat(12000) + 'LAST_FILE_REQUIRED' } as JudgeInput;
const options = { localModel: { name: 'judge', defaultParams: { maxTokens: 16000 } } as ModelConfig, escalationThreshold: 0.85 };
const valid = { verdict: 'correct', bug_detection: 1, root_cause: 1, patch_correctness: 1, patch_completeness: 1, scope_discipline: 1, output_completeness: 1, confidence: 0.95 };
function response(content: string, finishReason = 'stop') { vi.mocked(callModel).mockResolvedValue({ content, finishReason, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as ModelResponse); }
beforeEach(() => vi.clearAllMocks());
describe('Judge integrity', () => {
  it('includes the entire multi-file answer', () => {
    expect(buildJudgeUserPrompt(input)).toContain('LAST_FILE_REQUIRED');
    expect(buildJudgeUserPrompt(input)).not.toContain('[truncated for judge]');
  });
  it('uses configured generation budget and accepts a complete judgment', async () => {
    response(JSON.stringify(valid));
    expect((await runTieredJudge(input, options)).finalJudge.patchCorrectness).toBe(1);
    expect(vi.mocked(callModel).mock.calls[0][0].params.maxTokens).toBe(16000);
  });
  it('rejects output cut off by provider even if its JSON parses', async () => {
    response(JSON.stringify(valid), 'length');
    await expect(runTieredJudge(input, options)).rejects.toThrow('JUDGE_OUTPUT_TRUNCATED');
  });
  it.each(['not JSON', '{}', 'null', '[]', JSON.stringify({ ...valid, confidence: 2 }), JSON.stringify({ ...valid, patch_correctness: '1' })])('rejects malformed judgments instead of returning zero scores: %s', async content => {
    response(content);
    await expect(runTieredJudge(input, options)).rejects.toThrow(/JUDGE_INVALID/);
  });
  it('accepts the hallucination-specific factuality contract', async () => {
    response(JSON.stringify({ verdict: 'correct', factuality: 1, confidence: 0.9 }));
    expect((await runTieredJudge({ ...input, dimension: 'hallucination_resistance' }, options)).finalJudge.factuality).toBe(1);
  });
});
