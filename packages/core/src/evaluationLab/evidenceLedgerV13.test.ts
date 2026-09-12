import {describe, expect, it} from 'vitest';
import {buildEvidenceLedger, evidenceLedgerReference, scoreEvidenceLedger, verifyEvidenceLedger} from './evidenceLedgerV13.js';

const pack = buildEvidenceLedger();
const submission = () => ({
  contractHash: pack.contractHash,
  runId: 'r',
  modelId: 'm',
  modelFamily: 'f',
  answers: pack.cases.map((testCase) => ({
    id: testCase.id,
    questionHash: testCase.question.questionHash,
    outcome: 'completed',
    output: JSON.stringify(evidenceLedgerReference(testCase)),
  })),
});

describe('evidence ledger v1.3', () => {
  it('builds two families with three variants and six claims each', () => {
    expect(pack.cases).toHaveLength(6);
    expect(new Set(pack.cases.map((testCase) => testCase.family)).size).toBe(2);
    expect(pack.cases.every((testCase) => testCase.gold.length === 6)).toBe(true);
    expect(new Set(pack.cases.map((testCase) => testCase.id)).size).toBe(6);
  });

  it('accepts exact answers independent of claim and source order', () => {
    for (const testCase of pack.cases) {
      const answer = evidenceLedgerReference(testCase);
      answer.claims.reverse();
      answer.claims.forEach((claim) => claim.sources.reverse());
      expect(verifyEvidenceLedger(testCase, JSON.stringify(answer))).toMatchObject({formatValid: true, pass: true, passedAtoms: 12, plannedAtoms: 12});
    }
  });

  it('scores status and source minimality as separate atoms', () => {
    const testCase = pack.cases[0];
    const answer = evidenceLedgerReference(testCase);
    answer.claims[0].sources.push('D10');
    const verified = verifyEvidenceLedger(testCase, JSON.stringify(answer));
    expect(verified).toMatchObject({formatValid: true, pass: false, passedAtoms: 11, plannedAtoms: 12});
    expect(verified.atoms[0]).toMatchObject({statusPass: true, sourcesPass: false, passedAtoms: 1});
  });

  it('uses atomic accuracy while retaining strict whole-question pass diagnostics', () => {
    const input = submission();
    const testCase = pack.cases[0];
    const answer = evidenceLedgerReference(testCase);
    answer.claims[0].status = answer.claims[0].status === 'supported' ? 'refuted' : 'supported';
    input.answers[0].output = JSON.stringify(answer);
    const result = scoreEvidenceLedger(pack, input);
    expect(result.rows.find((row) => row.id === testCase.id)).toMatchObject({pass: false, passedAtoms: 11, plannedAtoms: 12, score: 100 * 11 / 12});
    expect(result.dimensions[0].passedAtoms).toBe(71);
    expect(result.dimensions[0].score).toBeCloseTo(100 * 71 / 72);
  });

  it('changes only intended parameter claims and keeps irrelevant gold unchanged', () => {
    for (const family of new Set(pack.cases.map((testCase) => testCase.family))) {
      const base = pack.cases.find((testCase) => testCase.family === family && testCase.variant === 'base')!;
      const parameter = pack.cases.find((testCase) => testCase.family === family && testCase.variant === 'parameter')!;
      const irrelevant = pack.cases.find((testCase) => testCase.family === family && testCase.variant === 'irrelevant')!;
      expect(irrelevant.gold).toEqual(base.gold);
      expect(parameter.gold).not.toEqual(base.gold);
      expect(irrelevant.question.messages[0].content).toContain('无关封面字段');
    }
  });

  it('keeps gold out of public questions and leaves malformed output unmeasured', () => {
    expect(pack.questions.every((question) => !Object.hasOwn(question, 'gold'))).toBe(true);
    expect(JSON.stringify(pack.questions)).not.toContain('"gold"');
    const input = submission();
    input.answers[0].output = 'not json';
    const result = scoreEvidenceLedger(pack, input);
    expect(result.rows[0]).toMatchObject({state: 'unparseable_requires_review', pass: null, score: null});
    expect(result.dimensions[0].score).toBeNull();
  });
});
