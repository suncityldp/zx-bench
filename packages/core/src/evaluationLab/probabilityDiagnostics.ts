import {snapshotHash} from '../contracts/pack.js';
import {buildAdaptiveProbability, scoreAdaptiveProbability} from './adaptiveProbability.js';

const fields = ['report_probability', 'posterior_a', 'early_stop_probability', 'next_red_probability', 'next_two_same_probability'] as const;
type Pack = ReturnType<typeof buildAdaptiveProbability>;
type Score = ReturnType<typeof scoreAdaptiveProbability>;

/** Read-only diagnostics: never alter the frozen all-five-correct primary score. */
export function probabilityDiagnostics(pack: Pack, submission: unknown) {
  const score = scoreAdaptiveProbability(pack, submission);
  const checksFor = (row: Score['rows'][number]): Record<string, boolean> | null => {
    if (row.pass === null || !('verification' in row) || !row.verification) return null;
    return row.verification.checks as Record<string, boolean>;
  };
  const summarize = (rows: Score['rows']) => fields.map(field => {
    const measured = rows.filter(r => checksFor(r) !== null);
    const correct = measured.filter(r => checksFor(r)![field]).length;
    return {field, planned: rows.length, measured: measured.length, correct,
      accuracy: measured.length === rows.length ? correct / rows.length : null};
  });
  const groups = [...new Set(pack.cases.map(c => c.group))].map(group => {
    const rows = score.rows.filter(r => r.group === group);
    const select = (variant: string) => {
      const matches = rows.filter(r => r.variant === variant);
      if (matches.length !== 1) throw new Error('Exactly one base, parameter and irrelevant variant required');
      return matches[0];
    };
    const base = select('base'), parameter = select('parameter'), irrelevant = select('irrelevant');
    const problem = (id: string) => pack.cases.find(c => c.id === id)!.problem;
    if (snapshotHash(problem(base.id)) !== snapshotHash(problem(irrelevant.id))) throw new Error('Irrelevant pair changes mathematical data');
    return {group, family: base.family, ids: {base: base.id, parameter: parameter.id, irrelevant: irrelevant.id},
      baseAndIrrelevantBothCorrect: base.pass === null || irrelevant.pass === null ? null : base.pass && irrelevant.pass,
      // A single observed transition is not a causal estimate of distraction susceptibility.
      baseCorrectIrrelevantWrong: base.pass === null || irrelevant.pass === null ? null : base.pass && !irrelevant.pass,
      baseCorrectParameterWrong: base.pass === null || parameter.pass === null ? null : base.pass && !parameter.pass,
      allThreeCorrect: rows.some(r => r.pass === null) ? null : rows.every(r => r.pass),
      components: summarize(rows)};
  });
  return {version: 'probability-diagnostics-v1', contractHash: pack.contractHash, submissionHash: snapshotHash(submission),
    runId: score.runId, modelId: score.modelId, modelFamily: score.modelFamily,
    primary: score.dimensions[0], components: summarize(score.rows), groups,
    rows: score.rows.map(r => ({id: r.id, outputHash: r.outputHash, state: r.state, pass: r.pass})),
    interpretation: {componentCountsAreIndependentTrials: false, groupsAreIndependentBaseFamilies: false,
      componentsAreDiagnosticNotExtraScore: true, proofCorrectness: 'not_inferred',
      causalEffectOfIrrelevantText: 'not_established_by_one_pair', missingNeverDropped: true},
    productionEligible: false, judgeCalls: 0};
}

/** Matched questions only; all planned items stay in the denominator. No best-of deduplication. */
export function compareProbabilityDiagnostics(left: ReturnType<typeof probabilityDiagnostics>, right: ReturnType<typeof probabilityDiagnostics>) {
  if (left.contractHash !== right.contractHash || left.rows.length !== right.rows.length) throw new Error('Same frozen contract required');
  if (left.modelId === right.modelId) throw new Error('Do not select or compare retries as different models');
  if (new Set(left.rows.map(r => r.id)).size !== left.rows.length || new Set(right.rows.map(r => r.id)).size !== right.rows.length) throw new Error('Duplicate question');
  const paired = left.rows.map(a => {
    const b = right.rows.find(r => r.id === a.id);
    if (!b) throw new Error('Mismatched question set');
    return {id: a.id, leftOutputHash: a.outputHash, rightOutputHash: b.outputHash,
      result: a.pass === null || b.pass === null ? 'unmeasured' : a.pass === b.pass ? (a.pass ? 'both_correct' : 'both_wrong') : a.pass ? 'left_only' : 'right_only'};
  });
  const counts = Object.fromEntries(['unmeasured', 'both_correct', 'both_wrong', 'left_only', 'right_only'].map(k => [k, paired.filter(r => r.result === k).length]));
  return {contractHash: left.contractHash, runIds: [left.runId, right.runId], planned: paired.length, counts, paired,
    complete: counts.unmeasured === 0, scoreDifference: left.primary.score === null || right.primary.score === null ? null : left.primary.score - right.primary.score,
    independentBaseFamilies: left.modelFamily === right.modelFamily ? 1 : 'requires_external_lineage_verification',
    statisticalRankingEstablished: false, productionEligible: false};
}
