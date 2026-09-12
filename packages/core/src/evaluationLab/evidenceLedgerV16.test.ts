import {describe, expect, it} from 'vitest';
import {buildEvidenceLedgerV16, evidenceLedgerV16Reference, scoreEvidenceLedgerV16, verifyEvidenceLedgerV16} from './evidenceLedgerV16.js';

describe('evidence ledger v1.6', () => {
  it('removes the answer-leading historical-state sentence and keeps oracle answers valid', () => {
    const pack = buildEvidenceLedgerV16();
    for (const testCase of pack.cases) {
      expect(verifyEvidenceLedgerV16(testCase, JSON.stringify(evidenceLedgerV16Reference(testCase)))).toMatchObject({formatValid: true, pass: true, passedAtoms: 12});
      if (testCase.family === 'provenance_intervention_ledger') {
        expect(testCase.documents.D07).toBe('下周在另一台新设备上的受控实验复现机制A响应。');
        expect(testCase.documents.D07).not.toContain('不恢复历史事故');
      }
    }
  });

  it('requires both the historical missing-state record and the future experiment for C6', () => {
    const testCase = buildEvidenceLedgerV16().cases.find((candidate) => candidate.family === 'provenance_intervention_ledger')!;
    const answer = evidenceLedgerV16Reference(testCase);
    answer.claims.find((claim) => claim.id === 'C6')!.sources = ['D01', 'D07'];
    const verification = verifyEvidenceLedgerV16(testCase, JSON.stringify(answer));
    expect(verification.atoms.find((atom) => atom.id === 'C6')).toMatchObject({statusPass: true, sourcesPass: false, missingRequired: ['D06']});
  });

  it('scores all six reference cases as 72 of 72 atoms', () => {
    const pack = buildEvidenceLedgerV16();
    const answers = pack.cases.map((testCase) => ({id: testCase.id, questionHash: testCase.question.questionHash, outcome: 'completed', output: JSON.stringify(evidenceLedgerV16Reference(testCase))}));
    const score = scoreEvidenceLedgerV16(pack, {contractHash: pack.contractHash, runId: 'oracle', modelId: 'oracle', modelFamily: 'synthetic', answers});
    expect(score.dimensions[0]).toMatchObject({planned: 6, measured: 6, plannedAtoms: 72, passedAtoms: 72, score: 100});
  });
});
