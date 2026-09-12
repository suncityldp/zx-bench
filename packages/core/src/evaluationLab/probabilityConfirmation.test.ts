import {describe, expect, it} from 'vitest';
import {buildAdaptiveProbability, probabilityReference} from './adaptiveProbability.js';
import {confirmProbabilityComparison, type ProbabilityTrial} from './probabilityConfirmation.js';
const conditions = {generation: {max_tokens: 90000, temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0,
  repetition_penalty: 1, presence_penalty: 0, frequency_penalty: 0, enable_thinking: true, seed: 20260910},
  load: {max_seq_length: 131072, n_parallel: 1, cache_type_kv: 'q8_0', speculative_type: 'off', disable_vision: true}, hardSeconds: 1200, concurrency: 1};
function trial(seed: number, left: number, right: number): ProbabilityTrial {
  const pack = buildAdaptiveProbability(seed);
  const submission = (modelId: string, passed: number) => ({contractHash: pack.contractHash, runId: `${seed}-${modelId}`, modelId, modelFamily: 'shared',
    answers: pack.cases.map((c, i) => ({id: c.id, questionHash: c.question.questionHash, outcome: 'completed',
      output: JSON.stringify({...probabilityReference(c.problem).answer, ...(i >= passed ? {posterior_a: '0'} : {})})}))});
  return {pack, submissions: [submission('A', left), submission('B', right)], conditions: structuredClone(conditions)};
}
describe('fixed new-parameter confirmation without best-of', () => {
  it('reports reproduced direction with both original rounds intact', () => {
    const r = confirmProbabilityComparison(trial(20260912, 4, 1), trial(20260913, 3, 2));
    expect(r.outcome).toBe('direction_reproduced_in_this_parameter_round'); expect(r.combinedScore).toBeNull();
    expect(r.bestOfScore).toBeNull(); expect(r.statisticalRankingEstablished).toBe(false); expect(r.problemPairs).toHaveLength(6);
  });
  it('reports a tie or reversal rather than averaging away the failure', () => {
    expect(confirmProbabilityComparison(trial(20260912, 4, 1), trial(20260913, 2, 2)).outcome).toBe('not_reproduced_tied');
    expect(confirmProbabilityComparison(trial(20260912, 4, 1), trial(20260913, 1, 4)).outcome).toBe('not_reproduced_reversed');
  });
  it('cannot confirm a direction absent in the first round', () => {
    expect(confirmProbabilityComparison(trial(20260912, 4, 4), trial(20260913, 5, 2)).outcome).toBe('initial_trial_had_no_direction_to_confirm');
  });
  it('keeps partial second rounds pending even if the observed ordering looks clear', () => {
    const next = trial(20260913, 0, 6); (next.submissions[0] as {answers: unknown[]}).answers.pop();
    const r = confirmProbabilityComparison(trial(20260912, 4, 1), next);
    expect(r.outcome).toBe('pending'); expect(r.confirmationDirection).toBeNull(); expect(r.rounds.confirmation.paired.scoreDifference).toBeNull();
  });
  it('rejects shifted models, reversed model order and changed lineage', () => {
    const initial = trial(20260912, 4, 1), next = trial(20260913, 3, 2);
    next.submissions.reverse(); expect(() => confirmProbabilityComparison(initial, next)).toThrow('identity');
    next.submissions.reverse(); (next.submissions[0] as {modelFamily: string}).modelFamily = 'another-family';
    expect(() => confirmProbabilityComparison(initial, next)).toThrow('lineage');
  });
  it('rejects two equally incomplete declarations rather than silently assuming defaults', () => {
    const initial = trial(20260912, 4, 1), next = trial(20260913, 3, 2);
    delete initial.conditions.generation.seed; delete next.conditions.generation.seed;
    expect(() => confirmProbabilityComparison(initial, next)).toThrow('Incomplete');
    initial.conditions.generation.seed = 20260910; next.conditions.generation.seed = 20260910;
    delete initial.conditions.load.cache_type_kv; delete next.conditions.load.cache_type_kv;
    expect(() => confirmProbabilityComparison(initial, next)).toThrow('Incomplete');
  });
  it('rejects altered budgets or other generation settings', () => {
    const initial = trial(20260912, 4, 1), next = trial(20260913, 3, 2);
    next.conditions.generation.temperature = 0; expect(() => confirmProbabilityComparison(initial, next)).toThrow('conditions');
    next.conditions.hardSeconds = 600; expect(() => confirmProbabilityComparison(initial, next)).toThrow('budget');
  });
  it('rejects seed labels that merely repeat the three-value parameter cycle', () => {
    expect(() => confirmProbabilityComparison(trial(20260912, 4, 1), trial(20260915, 3, 2))).toThrow('unchanged mathematical problem');
    const first = trial(20260912, 4, 1); expect(() => confirmProbabilityComparison(first, first)).toThrow('retry');
  });
  it('rejects changed frozen questions and duplicate answer attempts', () => {
    const initial = trial(20260912, 4, 1), next = trial(20260913, 3, 2);
    next.pack.cases[0].problem.priorA = [1, 3]; expect(() => confirmProbabilityComparison(initial, next)).toThrow('Modified');
    const valid = trial(20260913, 3, 2), a = valid.submissions[0] as {answers: unknown[]}; a.answers.push(a.answers[0]);
    expect(() => confirmProbabilityComparison(initial, valid)).toThrow('Duplicate');
  });
});
