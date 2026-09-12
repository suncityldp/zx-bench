import {snapshotHash} from '../contracts/pack.js';
import {buildAdaptiveProbability} from './adaptiveProbability.js';
import {probabilityDiagnostics, compareProbabilityDiagnostics} from './probabilityDiagnostics.js';

type Pack = ReturnType<typeof buildAdaptiveProbability>;
export interface ProbabilityTrial {
  pack: Pack;
  submissions: [unknown, unknown];
  conditions: {generation: Record<string, unknown>; load: Record<string, unknown>; hardSeconds: number; concurrency: number};
}
const direction = (delta: number): 'left_higher' | 'right_higher' | 'tied' => delta > 0 ? 'left_higher' : delta < 0 ? 'right_higher' : 'tied';
// Match the registered local trial, not two equally incomplete declarations.
const expectedGeneration = {temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0,
  repetition_penalty: 1, presence_penalty: 0, frequency_penalty: 0, max_tokens: 90000, enable_thinking: true, seed: 20260910};
const expectedLoad = {max_seq_length: 131072, n_parallel: 1, cache_type_kv: 'q8_0', speculative_type: 'off', disable_vision: true};

/** Confirmation of a fixed two-model trial, not pooled scoring or a population ranking. */
export function confirmProbabilityComparison(initial: ProbabilityTrial, confirmation: ProbabilityTrial) {
  for (const trial of [initial, confirmation]) {
    if (snapshotHash(buildAdaptiveProbability(trial.pack.policy.seed)) !== snapshotHash(trial.pack)) throw new Error('Modified frozen probability pack');
    if (trial.submissions.length !== 2) throw new Error('Exactly two explicit model submissions required');
    const c = trial.conditions;
    if (!c.generation || !c.load || c.hardSeconds !== 1200 || c.concurrency !== 1 ||
        c.generation.max_tokens !== 90000 || c.load.max_seq_length !== 131072 || c.load.n_parallel !== 1) throw new Error('Frozen serial budget required');
    if (snapshotHash(c.generation) !== snapshotHash(expectedGeneration) || snapshotHash(c.load) !== snapshotHash(expectedLoad)) throw new Error('Incomplete or changed registered conditions');
  }
  if (snapshotHash(initial.conditions) !== snapshotHash(confirmation.conditions)) throw new Error('Changed sampling or execution conditions');
  if (initial.pack.contractHash === confirmation.pack.contractHash) throw new Error('A retry is not new-parameter confirmation');
  const key = (c: Pack['cases'][number]) => `${c.family}/${c.variant}`;
  const source = new Map(initial.pack.cases.map(c => [key(c), c]));
  if (source.size !== initial.pack.cases.length || confirmation.pack.cases.length !== source.size ||
      new Set(confirmation.pack.cases.map(key)).size !== source.size) throw new Error('Changed family/variant plan');
  const problemPairs = confirmation.pack.cases.map(c => {
    const before = source.get(key(c));
    if (!before) throw new Error('Changed family/variant plan');
    if (snapshotHash(before.problem) === snapshotHash(c.problem)) throw new Error('New seed but unchanged mathematical problem');
    if (initial.pack.cases.some(p => snapshotHash(p.problem) === snapshotHash(c.problem))) throw new Error('Confirmation reuses an initial mathematical problem');
    return {family: c.family, variant: c.variant, initialId: before.id, confirmationId: c.id,
      initialProblemHash: snapshotHash(before.problem), confirmationProblemHash: snapshotHash(c.problem)};
  });
  const inspect = (t: ProbabilityTrial) => {
    const left = probabilityDiagnostics(t.pack, t.submissions[0]), right = probabilityDiagnostics(t.pack, t.submissions[1]);
    return {left, right, paired: compareProbabilityDiagnostics(left, right)};
  };
  const prior = inspect(initial), next = inspect(confirmation);
  if (!prior.paired.complete) throw new Error('Initial trial must be complete before confirmation interpretation');
  for (const side of ['left', 'right'] as const) {
    if (prior[side].modelId !== next[side].modelId || prior[side].modelFamily !== next[side].modelFamily) throw new Error('Model identity, order or declared lineage changed');
  }
  const initialDirection = direction(prior.paired.scoreDifference!);
  const confirmationDirection = next.paired.complete ? direction(next.paired.scoreDifference!) : null;
  const outcome = confirmationDirection === null ? 'pending'
    : initialDirection === 'tied' ? 'initial_trial_had_no_direction_to_confirm'
    : confirmationDirection === 'tied' ? 'not_reproduced_tied'
    : confirmationDirection === initialDirection ? 'direction_reproduced_in_this_parameter_round' : 'not_reproduced_reversed';
  const families = [...new Set(initial.pack.cases.map(c => c.family))].map(family => {
    const counts = (t: ProbabilityTrial, d: ReturnType<typeof inspect>) => {
      const ids = new Set(t.pack.cases.filter(c => c.family === family).map(c => c.id));
      const a = d.left.rows.filter(r => ids.has(r.id)), b = d.right.rows.filter(r => ids.has(r.id));
      const complete = [...a, ...b].every(r => r.pass !== null);
      return {plannedPerModel: ids.size, leftCorrect: a.filter(r => r.pass).length, rightCorrect: b.filter(r => r.pass).length,
        direction: complete ? direction(a.filter(r => r.pass).length - b.filter(r => r.pass).length) : null, complete};
    };
    return {family, initial: counts(initial, prior), confirmation: counts(confirmation, next)};
  });
  return {version: 'probability-parameter-confirmation-v1', outcome, initialDirection, confirmationDirection,
    contracts: {initial: initial.pack.contractHash, confirmation: confirmation.pack.contractHash}, conditionsHash: snapshotHash(initial.conditions),
    rounds: {initial: prior, confirmation: next}, problemPairs, families,
    combinedScore: null, bestOfScore: null, statisticalRankingEstablished: false, productionEligible: false,
    interpretation: {sameModelsAndDeclaredConditions: true, differentMathematicalData: true,
      newTemplateFamilies: false, independentBaseModelFamilies: prior.paired.independentBaseFamilies,
      relatedVariantsAreIndependentTrials: false, directionReproductionIsNotDifficultyCalibration: true,
      noSeedSearchToObtainDesiredOrdering: true, networkAndChronologyRequireSeparateRunAudits: true}};
}
