import {describe, expect, it} from 'vitest';
import {buildAdaptiveProbability, probabilityReference} from './adaptiveProbability.js';
import {probabilityDiagnostics, compareProbabilityDiagnostics} from './probabilityDiagnostics.js';

const pack = buildAdaptiveProbability();
function submission(modelId = 'A') {
  return {contractHash: pack.contractHash, runId: `run-${modelId}`, modelId, modelFamily: 'shared-base',
    answers: pack.cases.map(c => ({id: c.id, questionHash: c.question.questionHash, outcome: 'completed', output: JSON.stringify(probabilityReference(c.problem).answer)}))};
}
describe('probability diagnostics keep ability, missingness and paired variants separate', () => {
  it('reports complete oracle checks without treating five components as independent trials', () => {
    const d = probabilityDiagnostics(pack, submission());
    expect(d.primary.score).toBe(100);
    expect(d.components.every(c => c.correct === 6 && c.accuracy === 1)).toBe(true);
    expect(d.groups.every(g => g.allThreeCorrect)).toBe(true);
    expect(d.interpretation.componentCountsAreIndependentTrials).toBe(false);
  });
  it('keeps all planned missing cases and suppresses incomplete scores', () => {
    const s = submission(); s.answers = s.answers.slice(0, 1);
    const d = probabilityDiagnostics(pack, s);
    expect(d.primary.score).toBeNull();
    expect(d.components.every(c => c.planned === 6 && c.measured === 1 && c.accuracy === null)).toBe(true);
    expect(d.groups.every(g => g.allThreeCorrect === null)).toBe(true);
  });
  it('diagnoses a component error without inflating the primary all-correct score', () => {
    const s = submission(), base = pack.cases.find(c => c.variant === 'irrelevant')!;
    const answer = s.answers.find(a => a.id === base.id)!;
    answer.output = JSON.stringify({...probabilityReference(base.problem).answer, posterior_a: '0'});
    const d = probabilityDiagnostics(pack, s);
    expect(d.primary.score).toBeCloseTo(100 * 5 / 6);
    expect(d.components.find(c => c.field === 'posterior_a')!.correct).toBe(5);
    expect(d.groups.find(g => g.group === base.group)!.baseCorrectIrrelevantWrong).toBe(true);
  });
  it('marks unparseable and truncated outputs unmeasured, not math errors', () => {
    const s = submission(); s.answers[0].output = 'unable to extract'; s.answers[1].outcome = 'truncated';
    const d = probabilityDiagnostics(pack, s);
    expect(d.components.every(c => c.measured === 4 && c.correct === 4)).toBe(true);
    expect(d.rows.filter(r => r.pass === null)).toHaveLength(2);
  });
  it('matches raw-answer hashes and keeps partial comparisons provisional', () => {
    const a = probabilityDiagnostics(pack, submission()), s = submission('B'); s.answers.pop();
    const comparison = compareProbabilityDiagnostics(a, probabilityDiagnostics(pack, s));
    expect(comparison.counts.unmeasured).toBe(1);
    expect(comparison.scoreDifference).toBeNull();
    expect(comparison.independentBaseFamilies).toBe(1);
    expect(comparison.paired[0].leftOutputHash).toBe(a.rows[0].outputHash);
  });
  it('rejects retries, stale contracts, duplicate answers and altered irrelevant pairs', () => {
    const a = probabilityDiagnostics(pack, submission());
    expect(() => compareProbabilityDiagnostics(a, a)).toThrow(/retries/);
    expect(() => compareProbabilityDiagnostics(a, {...a, contractHash: 'stale'})).toThrow(/contract/);
    const s = submission(); s.answers.push(s.answers[0]);
    expect(() => probabilityDiagnostics(pack, s)).toThrow(/Duplicate/);
    const changed = structuredClone(pack); changed.cases.find(c => c.variant === 'irrelevant')!.problem.priorA = [1, 2];
    expect(() => probabilityDiagnostics(changed, submission())).toThrow(/mathematical data/);
  });
});
