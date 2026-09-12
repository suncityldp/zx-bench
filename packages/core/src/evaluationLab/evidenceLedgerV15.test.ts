import {describe, expect, it} from 'vitest';
import {buildEvidenceLedgerV15, evidenceLedgerV15Reference, scoreEvidenceLedgerV15, verifyEvidenceLedgerV15} from './evidenceLedgerV15.js';

const pack = buildEvidenceLedgerV15();

describe('evidence ledger v1.5 bounded citations', () => {
  it('accepts every required-source reference answer', () => {
    for (const testCase of pack.cases) {
      expect(verifyEvidenceLedgerV15(testCase, JSON.stringify(evidenceLedgerV15Reference(testCase)))).toMatchObject({formatValid: true, pass: true, passedAtoms: 12});
    }
  });

  it('accepts relevant optional context but rejects outside sources', () => {
    const testCase = pack.cases.find((candidate) => candidate.family === 'temporal_scope_ledger' && candidate.variant === 'base')!;
    const optional = evidenceLedgerV15Reference(testCase);
    optional.claims.find((claim) => claim.id === 'C3')!.sources.push('D04');
    expect(verifyEvidenceLedgerV15(testCase, JSON.stringify(optional))).toMatchObject({pass: true, passedAtoms: 12});
    const unrelated = evidenceLedgerV15Reference(testCase);
    unrelated.claims.find((claim) => claim.id === 'C3')!.sources.push('D10');
    const verified = verifyEvidenceLedgerV15(testCase, JSON.stringify(unrelated));
    expect(verified).toMatchObject({pass: false, passedAtoms: 11});
    expect(verified.atoms.find((atom) => atom.id === 'C3')).toMatchObject({sourcesPass: false, disallowed: ['D10']});
  });

  it('rejects a missing decisive source independently of a correct status', () => {
    const testCase = pack.cases[0];
    const answer = evidenceLedgerV15Reference(testCase);
    const gold = testCase.gold[0];
    answer.claims[0].sources = answer.claims[0].sources.filter((source) => source !== gold.requiredSources[0]);
    const verified = verifyEvidenceLedgerV15(testCase, JSON.stringify(answer));
    expect(verified.atoms[0]).toMatchObject({statusPass: true, sourcesPass: false, passedAtoms: 1});
  });

  it('contains only direct factual claims and makes citation bounds internally valid', () => {
    for (const testCase of pack.cases) {
      expect(Object.values(testCase.claims).join('|')).not.toMatch(/现有材料支持|足以证明|能唯一确定|实验本身足以/);
      for (const gold of testCase.gold) {
        expect(gold.requiredSources.every((source) => gold.allowedSources.includes(source))).toBe(true);
        expect(new Set(gold.requiredSources).size).toBe(gold.requiredSources.length);
        expect(new Set(gold.allowedSources).size).toBe(gold.allowedSources.length);
      }
    }
  });

  it('scores 72 status/evidence atoms and keeps malformed output unmeasured', () => {
    const answers = pack.cases.map((testCase) => ({id: testCase.id, questionHash: testCase.question.questionHash, outcome: 'completed', output: JSON.stringify(evidenceLedgerV15Reference(testCase))}));
    const input = {contractHash: pack.contractHash, runId: 'r', modelId: 'm', modelFamily: 'f', answers};
    const perfect = scoreEvidenceLedgerV15(pack, input);
    expect(perfect.dimensions[0]).toMatchObject({plannedAtoms: 72, passedAtoms: 72, score: 100});
    input.answers[0].output = 'not json';
    const malformed = scoreEvidenceLedgerV15(pack, input);
    expect(malformed.rows[0]).toMatchObject({state: 'unparseable_requires_review', pass: null, score: null});
    expect(malformed.dimensions[0].score).toBeNull();
  });
});
