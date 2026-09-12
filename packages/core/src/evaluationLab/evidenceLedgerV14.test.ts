import {describe, expect, it} from 'vitest';
import {buildEvidenceLedgerV14, evidenceLedgerV14Reference, scoreEvidenceLedgerV14, verifyEvidenceLedgerV14} from './evidenceLedgerV14.js';

const pack = buildEvidenceLedgerV14();

describe('evidence ledger v1.4 direct-claim repair', () => {
  it('uses direct factual wording for every provenance claim', () => {
    const provenance = pack.cases.filter((testCase) => testCase.family === 'provenance_intervention_ledger');
    expect(provenance).toHaveLength(3);
    for (const testCase of provenance) {
      expect(Object.values(testCase.claims).join('|')).not.toMatch(/现有材料支持|足以证明|能唯一确定|实验本身足以/);
      expect(testCase.question.messages[0].content).toContain('全部是直接事实主张');
    }
  });

  it('maps missing causal observations to insufficient and active forensic disagreement to conflict', () => {
    const base = pack.cases.find((testCase) => testCase.family === 'provenance_intervention_ledger' && testCase.variant === 'base')!;
    expect(base.gold.find((gold) => gold.id === 'C3')).toEqual({id: 'C3', status: 'insufficient', sources: ['D01', 'D10']});
    expect(base.gold.find((gold) => gold.id === 'C4')).toEqual({id: 'C4', status: 'insufficient', sources: ['D01', 'D05']});
    expect(base.gold.find((gold) => gold.id === 'C5')).toEqual({id: 'C5', status: 'conflict', sources: ['D01', 'D08', 'D09']});
    expect(base.gold.find((gold) => gold.id === 'C6')).toEqual({id: 'C6', status: 'insufficient', sources: ['D01', 'D06', 'D07']});
  });

  it('accepts every reference answer and produces 72/72 atoms', () => {
    const answers = pack.cases.map((testCase) => ({
      id: testCase.id,
      questionHash: testCase.question.questionHash,
      outcome: 'completed',
      output: JSON.stringify(evidenceLedgerV14Reference(testCase)),
    }));
    for (const [index, testCase] of pack.cases.entries()) {
      expect(verifyEvidenceLedgerV14(testCase, answers[index].output)).toMatchObject({formatValid: true, pass: true, passedAtoms: 12});
    }
    const result = scoreEvidenceLedgerV14(pack, {contractHash: pack.contractHash, runId: 'r', modelId: 'm', modelFamily: 'f', answers});
    expect(result.dimensions[0]).toMatchObject({plannedAtoms: 72, passedAtoms: 72, score: 100});
  });

  it('changes IDs and contract from v1.3 and exposes no gold in public questions', async () => {
    const {buildEvidenceLedger} = await import('./evidenceLedgerV13.js');
    const prior = buildEvidenceLedger();
    expect(pack.contractHash).not.toBe(prior.contractHash);
    expect(new Set(pack.cases.map((testCase) => testCase.id))).not.toEqual(new Set(prior.cases.map((testCase) => testCase.id)));
    expect(JSON.stringify(pack.questions)).not.toContain('"gold"');
  });
});
