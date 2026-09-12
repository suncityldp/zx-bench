/** v1.8: broad topic-bounded allowed sets; only cross-topic evidence is penalized. */
import {snapshotHash} from '../contracts/pack.js';
import {
  buildEvidenceLedgerV17,
  evidenceLedgerV17Reference,
  scoreEvidenceLedgerV17,
  verifyEvidenceLedgerV17,
  type EvidenceLedgerV17Case,
  type EvidenceLedgerV17Gold,
} from './evidenceLedgerV17.js';
import {opaque, question, shuffle} from './methodsV2/types.js';

export const EVIDENCE_LEDGER_V18_VERSION = 'evidence-ledger-2026-09-12-v1.8';
export type EvidenceLedgerV18Case = EvidenceLedgerV17Case;
export type EvidenceLedgerV18Gold = EvidenceLedgerV17Gold;
export {evidenceLedgerV17Reference as evidenceLedgerV18Reference, verifyEvidenceLedgerV17 as verifyEvidenceLedgerV18};

function topicAllowed(testCase: EvidenceLedgerV17Case, claimId: string) {
  if (testCase.family === 'temporal_scope_ledger') {
    if (['C1', 'C2', 'C5', 'C6'].includes(claimId)) return ['D01', 'D02', 'D03', 'D04', 'D05', 'D07'];
    if (claimId === 'C3') return ['D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07'];
    return ['D01', 'D04', 'D08', 'D09'];
  }
  if (['C1', 'C2', 'C3'].includes(claimId)) return ['D01', 'D02', 'D03', 'D04', 'D10'];
  if (claimId === 'C4') return ['D01', 'D05'];
  return ['D01', 'D06', 'D07', 'D08', 'D09'];
}

export function buildEvidenceLedgerV18(seed = 20260912) {
  const prior = buildEvidenceLedgerV17(seed);
  const cases: EvidenceLedgerV18Case[] = prior.cases.map((oldCase) => {
    const id = opaque({version: EVIDENCE_LEDGER_V18_VERSION, seed, family: oldCase.family, variant: oldCase.variant});
    const group = opaque({version: EVIDENCE_LEDGER_V18_VERSION, seed, family: oldCase.family});
    const gold = oldCase.gold.map((item) => ({
      ...item,
      requiredSources: [...item.requiredSources],
      allowedSources: topicAllowed(oldCase, item.id),
    }));
    return {...oldCase, id, group, gold, question: question(id, 'hallucination_resistance', oldCase.question.messages[0].content)};
  });
  const ordered = shuffle(cases, seed);
  const policy = {
    ...prior.policy,
    version: EVIDENCE_LEDGER_V18_VERSION,
    supersedes: 'evidence-ledger-2026-09-12-v1.7-after_five_completed_diagnostic_responses',
    citationBoundaryFix: 'required_sources_are_decisive_allowed_sources_are_broad_topic_bounded_cross_topic_only_is_penalized',
  };
  return {policy, cases: ordered, questions: ordered.map((testCase) => testCase.question), contractHash: snapshotHash({policy, cases: ordered})};
}

export function scoreEvidenceLedgerV18(pack: ReturnType<typeof buildEvidenceLedgerV18>, input: any) {
  return scoreEvidenceLedgerV17(pack as ReturnType<typeof buildEvidenceLedgerV17>, input);
}
