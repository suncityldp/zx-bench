import {describe, expect, it} from 'vitest';
import {buildEvidenceLedgerV18, evidenceLedgerV18Reference, scoreEvidenceLedgerV18, verifyEvidenceLedgerV18} from './evidenceLedgerV18.js';

describe('evidence ledger v1.8', () => {
  it('accepts related non-decisive sources but rejects cross-topic sources', () => {
    const pack = buildEvidenceLedgerV18();
    const provenance = pack.cases.find((candidate) => candidate.family === 'provenance_intervention_ledger')!;
    const related = evidenceLedgerV18Reference(provenance);
    related.claims.find((claim) => claim.id === 'C6')!.sources.push('D08');
    expect(verifyEvidenceLedgerV18(provenance, JSON.stringify(related)).atoms.find((atom) => atom.id === 'C6')).toMatchObject({sourcesPass: true});
    const crossTopic = evidenceLedgerV18Reference(provenance);
    crossTopic.claims.find((claim) => claim.id === 'C6')!.sources.push('D05');
    expect(verifyEvidenceLedgerV18(provenance, JSON.stringify(crossTopic)).atoms.find((atom) => atom.id === 'C6')).toMatchObject({sourcesPass: false, disallowed: ['D05']});
  });

  it('accepts every same-topic cap document for temporal cap claims', () => {
    const temporal = buildEvidenceLedgerV18().cases.find((candidate) => candidate.family === 'temporal_scope_ledger')!;
    const answer = evidenceLedgerV18Reference(temporal);
    answer.claims.find((claim) => claim.id === 'C2')!.sources = ['D01', 'D02', 'D03', 'D04', 'D05', 'D07'];
    expect(verifyEvidenceLedgerV18(temporal, JSON.stringify(answer)).atoms.find((atom) => atom.id === 'C2')).toMatchObject({statusPass: true, sourcesPass: true});
  });

  it('still requires decisive sources and scores all references 72 of 72', () => {
    const pack = buildEvidenceLedgerV18();
    const temporal = pack.cases.find((candidate) => candidate.family === 'temporal_scope_ledger')!;
    const incomplete = evidenceLedgerV18Reference(temporal);
    incomplete.claims.find((claim) => claim.id === 'C2')!.sources = ['D01', 'D02', 'D04'];
    expect(verifyEvidenceLedgerV18(temporal, JSON.stringify(incomplete)).atoms.find((atom) => atom.id === 'C2')).toMatchObject({sourcesPass: false, missingRequired: ['D03']});
    const answers = pack.cases.map((testCase) => ({id: testCase.id, questionHash: testCase.question.questionHash, outcome: 'completed', output: JSON.stringify(evidenceLedgerV18Reference(testCase))}));
    const score = scoreEvidenceLedgerV18(pack, {contractHash: pack.contractHash, runId: 'oracle', modelId: 'oracle', modelFamily: 'synthetic', answers});
    expect(score.dimensions[0]).toMatchObject({planned: 6, measured: 6, plannedAtoms: 72, passedAtoms: 72, score: 100});
  });
});
