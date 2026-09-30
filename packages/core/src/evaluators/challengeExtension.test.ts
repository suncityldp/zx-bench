import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Scenario } from '@zxbench/types';
import { buildChallengeExtension } from '../evaluationLab/challengeExtension.js';
import { challengeExtensionEvaluator } from './challengeExtension.js';
import { challengeSupplementEvaluator } from './challengeSupplement.js';
import { buildChallengePack, referenceAnswer } from '../evaluationLab/challengePack.js';
import { registerEvaluator } from './index.js';
import { orchestrateEvaluation } from '../orchestrator.js';
import { checkScenarioEligibility } from '../contracts/eligibility.js';
import { hashScenarioShort } from '../contracts/canonicalize.js';
import { getJudgeWeights } from '../scoring.js';
import { RETIRED_REASONING_MATH_CHALLENGE_ID_SET } from '../evaluationLab/challengeRetirement.js';
import { runTieredJudge, runJudgeEnsemble } from '../judge/index.js';

vi.mock('../judge/index.js', () => ({ runTieredJudge: vi.fn(), runJudgeEnsemble: vi.fn(), computeJudgeScore: vi.fn() }));
const bank = JSON.parse(readFileSync('data/scenarios/benchmark.json', 'utf8')) as Scenario[];
const manifest = JSON.parse(readFileSync('data/scenarios/challenge-extension-manifest.json', 'utf8'));
const pack = buildChallengeExtension();
const metadata = { finishReason: 'stop', truncated: false, incomplete: false, containsCodeBlock: false,
  containsFinalConclusion: true, outputLength: 100, outputTokens: 100, inputTokens: 100, maxTokens: 90000 } as any;
const find = (id: string) => bank.find(s => s.id === id)!;
registerEvaluator(challengeExtensionEvaluator);
registerEvaluator(challengeSupplementEvaluator);

describe('bank 1.31.1 challenge integration and restored formal scope', () => {
  it('freezes the exact source, counts, hashes and default eligibility', () => {
    expect(pack.hash).toBe(manifest.sourceHash);
    expect(pack.cases).toHaveLength(21);
    const meta = JSON.parse(readFileSync('data/scenarios/benchmark-meta.json', 'utf8'));
    expect(bank).toHaveLength(meta.currentRecordCount);
    // 2026-09-17：UMX 八题标 developmentShadow（ultra_proof_part 在普通 run 路径下分数无意义），
    // 非 shadow 数 848 -> 840。定义与 rubric 保留，仍可被显式指定运行。
    expect(bank.filter(s => s.status === 'valid' && !(s.requirements as any)?.developmentShadow)).toHaveLength(meta.defaultRunCount);
    for (const item of pack.cases) {
      const scenario = find(item.id);
      expect(scenario.scenarioHash, item.id).toBe(hashScenarioShort(scenario));
      expect(checkScenarioEligibility(scenario).eligible, item.id)
        .toBe(!item.developmentShadow && !RETIRED_REASONING_MATH_CHALLENGE_ID_SET.has(item.id));
      expect(getJudgeWeights(scenario.dimension, scenario.grader).judge).toBe(0);
    }
    const projectRepairs = bank.filter(s => s.grader === 'project_repair');
    expect(projectRepairs).toHaveLength(20);
    expect(projectRepairs.every(s => !(s.requirements as any)?.developmentShadow)).toBe(true);
    expect(projectRepairs.every(s => checkScenarioEligibility(s).eligible)).toBe(true);
  });
  it.each(pack.cases)('replays gold and rejects wrong/incomplete answers: $id', async item => {
    const scenario = find(item.id), gold = JSON.stringify(item.reference);
    const evaluate = (output: string, meta = metadata) => challengeExtensionEvaluator.evaluate(scenario, output, meta);
    expect(await evaluate(gold)).toMatchObject({ totalScore: 100, environmentError: false, humanReviewRequired: false });
    expect((await evaluate('{}')).totalScore).toBe(0);
    const wrong = Object.fromEntries(Object.keys(item.reference).map(key => [key, 'WRONG']));
    expect((await evaluate(JSON.stringify(wrong))).totalScore).toBe(0);
    expect((await evaluate(gold, { ...metadata, truncated: true, finishReason: 'length' })).totalScore).toBe(0);
  });
  it.each(pack.cases)('runs through the real orchestrator without Judge even when enabled: $id', async item => {
    const output = JSON.stringify(item.reference);
    const result = await orchestrateEvaluation({ scenario: find(item.id),
      modelConfig: { id: 'offline', name: 'offline', provider: 'local', baseUrl: 'http://unused', defaultParams: {} },
      modelParams: { maxTokens: 90000 }, evalConfig: { judgeEnabled: true },
      judgeOptions: { localModel: { id: 'must-not-call' } },
      savedCandidate: { response: { content: output, reasoningContent: '', finishReason: 'stop', latencyMs: 1, usage: { inputTokens: 100, outputTokens: 100 } }, metadata },
    } as any);
    expect(result.totalScore, JSON.stringify(result.evidence)).toBe(100);
    expect(runTieredJudge).not.toHaveBeenCalled();
    expect(runJudgeEnsemble).not.toHaveBeenCalled();
  });
  it('also bypasses Judge for the original five deterministic supplement questions', async () => {
    for (const scenario of bank.filter(s => s.grader === 'challenge_supplement')) {
      const item = buildChallengePack().cases.find(c => c.id === scenario.id)!;
      expect(getJudgeWeights(scenario.dimension, scenario.grader)).toEqual({ deterministic: 1, judge: 0 });
      expect((await challengeSupplementEvaluator.evaluate(scenario, JSON.stringify(referenceAnswer(item)), metadata)).totalScore).toBe(100);
    }
  });
  it('scores coverage answers by verified field checks instead of an all-or-zero cliff', async () => {
    const item = pack.cases.find(c => c.id === 'HC3-003')!;
    const answer = structuredClone(item.reference) as any;
    answer.announcement_proves_national.sources = ['D5', 'D4'];
    const result = await challengeExtensionEvaluator.evaluate(find(item.id), JSON.stringify(answer), metadata);
    expect(result.totalScore).toBeGreaterThan(0);
    expect(result.totalScore).toBeLessThan(100);
    expect(result.axisScores?.challenge_answer).toBe(100);
    expect(result.axisScores?.evidence_attribution).toBeLessThan(100);
    expect(result.evidence).toContain('FAILED_CHECK:announcement_proves_national.sources');
  });
  it('rejects stale source hashes or changed prompts, and separates unparseable probability output', async () => {
    const probability = pack.cases.find(c => c.kind === 'probability')!, scenario = find(probability.id);
    expect(await challengeExtensionEvaluator.evaluate({ ...scenario, promptTemplate: 'changed' }, '{}', metadata)).toMatchObject({ environmentError: true });
    expect(await challengeExtensionEvaluator.evaluate({ ...scenario, requirements: { ...(scenario.requirements as any), sourcePackHash: 'stale' } }, '{}', metadata)).toMatchObject({ environmentError: true });
    expect(await challengeExtensionEvaluator.evaluate(scenario, 'not JSON', metadata)).toMatchObject({ environmentError: true, formatParseSuccess: false, axisCoverage: 0 });
    expect(await challengeExtensionEvaluator.evaluate(scenario, '说明\n```json\n' + JSON.stringify(probability.reference) + '\n```', metadata)).toMatchObject({ totalScore: 100 });
  });
});
