/** v1.7: treats the superseded institution-wide cap as relevant evidence for over-cap comparison. */
import {snapshotHash} from '../contracts/pack.js';
import {
  buildEvidenceLedgerV16,
  evidenceLedgerV16Reference,
  scoreEvidenceLedgerV16,
  verifyEvidenceLedgerV16,
  type EvidenceLedgerV16Case,
  type EvidenceLedgerV16Gold,
} from './evidenceLedgerV16.js';
import {opaque, question, shuffle} from './methodsV2/types.js';

export const EVIDENCE_LEDGER_V17_VERSION = 'evidence-ledger-2026-09-12-v1.7';
export type EvidenceLedgerV17Case = EvidenceLedgerV16Case;
export type EvidenceLedgerV17Gold = EvidenceLedgerV16Gold;
export {evidenceLedgerV16Reference as evidenceLedgerV17Reference, verifyEvidenceLedgerV16 as verifyEvidenceLedgerV17};

export function buildEvidenceLedgerV17(seed = 20260912) {
  const prior = buildEvidenceLedgerV16(seed);
  const cases: EvidenceLedgerV17Case[] = prior.cases.map((oldCase) => {
    const id = opaque({version: EVIDENCE_LEDGER_V17_VERSION, seed, family: oldCase.family, variant: oldCase.variant});
    const group = opaque({version: EVIDENCE_LEDGER_V17_VERSION, seed, family: oldCase.family});
    const gold = oldCase.gold.map((item) => ({
      ...item,
      requiredSources: [...item.requiredSources],
      allowedSources: oldCase.family === 'temporal_scope_ledger' && item.id === 'C2'
        ? [...new Set([...item.allowedSources, 'D02'])]
        : [...item.allowedSources],
    }));
    return {...oldCase, id, group, gold, question: question(id, 'hallucination_resistance', oldCase.question.messages[0].content)};
  });
  const ordered = shuffle(cases, seed);
  const policy = {
    ...prior.policy,
    version: EVIDENCE_LEDGER_V17_VERSION,
    supersedes: 'evidence-ledger-2026-09-12-v1.6-after_three_completed_diagnostic_responses',
    citationBoundaryFix: 'temporal_C2_D02_is_relevant_but_not_required',
  };
  return {policy, cases: ordered, questions: ordered.map((testCase) => testCase.question), contractHash: snapshotHash({policy, cases: ordered})};
}

export function scoreEvidenceLedgerV17(pack: ReturnType<typeof buildEvidenceLedgerV17>, input: any) {
  return scoreEvidenceLedgerV16(pack as ReturnType<typeof buildEvidenceLedgerV16>, input);
}
