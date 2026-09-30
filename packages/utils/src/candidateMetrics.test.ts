import { describe, expect, it } from 'vitest';
import { aggregateCandidateMetrics as aggregate, combineCandidateMetrics } from './candidateMetrics.js';
const row = (m: object) => ({ outputMetadata: m });
describe('paired candidate costs', () => {
  it('uses exactly the timed output sample set, and preserves known zero tokens', () => {
    const result = aggregate([row({ inputTokens: 1, outputTokens: 100, inferenceMs: 1000 }), row({ inputTokens: 2, outputTokens: 900 }), row({ inputTokens: 3, outputTokens: 0, inferenceMs: 1000 }), row({ inputTokens: 4, outputTokens: 100, inferenceMs: 0 })]);
    expect(result).toMatchObject({ totalOutputTokens: 1100, timedOutputTokens: 100, candidateElapsedMs: 2000, candidateTokensPerSecond: 50, timingCoverage: .5, generationTokensPerSecond: null });
  });
  it('returns unknown for absent/invalid legacy timing instead of summary fallback', () => {
    expect(aggregate([{ outputMetadata: 'bad-json' }, row({ outputTokens: 20, inferenceMs: -1 }), row({ outputTokens: 20, inferenceMs: Infinity })])).toMatchObject({ candidateTokensPerSecond: null, candidateElapsedMs: null, totalInputTokens: null });
  });
  it('distinguishes generation from tool-loop effective throughput', () => {
    const r = aggregate([row({ inputTokens: 1, outputTokens: 100, inferenceMs: 10000, tokenSpeed: 100, executionWorldTrace: {} }), row({ inputTokens: 1, outputTokens: 100, inferenceMs: 2000, nativeTokensPerSecond: 80 })]);
    expect(r.generationTokensPerSecond).toBe(80);
    expect(r.generationCoverage).toBe(.5);
    expect(r.candidateTokensPerSecond).toBeCloseTo(200 / 12);
  });
  it('combines parallel groups with paired sums rather than max speed or wall-clock time', () => {
    const r = combineCandidateMetrics([aggregate([row({ inputTokens: 1, outputTokens: 100, inferenceMs: 1000 })]), aggregate([row({ inputTokens: 1, outputTokens: 100, inferenceMs: 3000 }), row({ inputTokens: 1, outputTokens: 1000 })])]);
    expect(r).toMatchObject({ totalOutputTokens: 1200, timedOutputTokens: 200, candidateElapsedMs: 4000, candidateTokensPerSecond: 50 });
    expect(r.timingCoverage).toBeCloseTo(2 / 3);
  });
  it('uses real repeated attempts instead of the merged metadata with missing timing', () => {
    const attempts = [row({ inputTokens: 1, outputTokens: 100, inferenceMs: 1000 }), row({ inputTokens: 1, outputTokens: 900 })];
    expect(aggregate([row({ inputTokens: 2, outputTokens: 1000, inferenceMs: 1000, evaluationAudit: { attempts } })])).toMatchObject({ sampleCount: 2, candidateTokensPerSecond: 100, timingCoverage: .5 });
  });
  it('does not bill saved-answer rescoring as a new candidate call', () => {
    const original = row({ inputTokens: 1, outputTokens: 100, inferenceMs: 1000, candidateGenerated: true });
    const replay = row({ inputTokens: 1, outputTokens: 100, inferenceMs: 1000, candidateGenerated: false, evaluationAudit: { attempts: [original] } });
    expect(aggregate([original, replay], { consumed: true })).toMatchObject({ sampleCount: 1, totalOutputTokens: 100 });
  });
});
