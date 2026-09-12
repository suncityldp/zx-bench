import {describe, expect, it} from 'vitest';
import {buildEvidenceLedgerV17, evidenceLedgerV17Reference, scoreEvidenceLedgerV17, verifyEvidenceLedgerV17} from './evidenceLedgerV17.js';

describe('evidence ledger v1.7', () => {
  it('accepts D02 as relevant but optional for temporal C2', () => {
    const testCase = buildEvidenceLedgerV17().cases.find((candidate) => candidate.family === 'temporal_scope_ledger')!;
    const answer = evidenceLedgerV17Reference(testCase);
    answer.claims.find((claim) => claim.id === 'C2')!.sources.push('D02');
    expect(verifyEvidenceLedgerV17(testCase, JSON.stringify(answer)).atoms.find((atom) => atom.id === 'C2')).toMatchObject({statusPass: true, sourcesPass: true});
  });

  it('still rejects an unrelated transport rule for temporal C2', () => {
    const testCase = buildEvidenceLedgerV17().cases.find((candidate) => candidate.family === 'temporal_scope_ledger')!;
    const answer = evidenceLedgerV17Reference(testCase);
    answer.claims.find((claim) => claim.id === 'C2')!.sources.push('D10');
    expect(verifyEvidenceLedgerV17(testCase, JSON.stringify(answer)).atoms.find((atom) => atom.id === 'C2')).toMatchObject({statusPass: true, sourcesPass: false, disallowed: ['D10']});
  });

  it('scores all six reference cases as 72 of 72 atoms', () => {
    const pack = buildEvidenceLedgerV17();
    const answers = pack.cases.map((testCase) => ({id: testCase.id, questionHash: testCase.question.questionHash, outcome: 'completed', output: JSON.stringify(evidenceLedgerV17Reference(testCase))}));
    const score = scoreEvidenceLedgerV17(pack, {contractHash: pack.contractHash, runId: 'oracle', modelId: 'oracle', modelFamily: 'synthetic', answers});
    expect(score.dimensions[0]).toMatchObject({planned: 6, measured: 6, plannedAtoms: 72, passedAtoms: 72, score: 100});
  });
});
