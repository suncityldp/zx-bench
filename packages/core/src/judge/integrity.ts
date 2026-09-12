import type { JudgeInput, JudgeResult } from '@zxbench/types';
import { snapshotHash } from '../contracts/pack.js';

export const JUDGE_AUDIT_VERSION = 'judge_lineage_v1';
export function judgeProvenance(input: JudgeInput, system: string, user: string, response: string, judgeModel: string): NonNullable<JudgeResult['provenance']>[number] {
  return { policyVersion: JUDGE_AUDIT_VERSION, candidateHash: snapshotHash({ raw: input.rawModelOutput ?? null, structured: input.candidateAnswer }),
    inputHash: snapshotHash(input), promptHash: snapshotHash({ system, user }), responseHash: snapshotHash(response), judgeModel };
}

/** Verifies citation existence, NOT whether the cited claim is semantically wrong. */
export function validateScoreEvidence(input: JudgeInput, parsed: Record<string, unknown>): JudgeResult['scoreEvidence'] {
  if (input.judgeEvidenceContract !== 'criterion_evidence_v1') return undefined;
  const req = input.requirements as unknown as { reviewedRubric?: { criteria: { id: string }[] } };
  const scores = (req?.reviewedRubric ? parsed.rubric_scores : input.dimension === 'reasoning_math'
    ? Object.fromEntries(['math_correctness','reasoning_validity','task_completeness'].map(k => [k, parsed[k]]))
    : { factuality: parsed.factuality }) as Record<string, number>;
  const ids = req?.reviewedRubric?.criteria.map(c => c.id) ?? Object.keys(scores);
  const raw = parsed.score_evidence;
  const fail = (reason: string): never => { throw new Error(`JUDGE_EVIDENCE_INVALID: ${reason}; manual Judge-only review required`); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('score_evidence must be an object');
  const rows = raw as Record<string, { kind: string; quote?: string; explanation: string }>;
  if (Object.keys(rows).some(id => !ids.includes(id))) return fail('unknown criterion evidence');
  for (const id of ids) {
    const row = rows[id];
    if (typeof scores?.[id] !== 'number' || !Number.isFinite(scores[id]) || scores[id] < 0 || scores[id] > 1) return fail(`invalid score: ${id}`);
    if (scores[id] < 1 && !row) return fail(`missing deduction evidence: ${id}`);
    if (!row) continue;
    if (!['assertion','omission'].includes(row.kind) || typeof row.explanation !== 'string' || !row.explanation.trim() || row.explanation.length > 240) return fail(`invalid evidence: ${id}`);
    if (row.kind === 'assertion' && (typeof row.quote !== 'string' || !row.quote.trim() || row.quote.length > 240 || !input.rawModelOutput?.includes(row.quote))) return fail(`quote not in candidate: ${id}`);
    if (row.kind === 'omission' && row.quote !== undefined) return fail(`omissions cannot invent quotes: ${id}`);
  }
  if (parsed.critical_error === true && !ids.some(id => scores[id] < 1 && rows[id]?.kind === 'assertion')) return fail('critical error requires an evidenced failed assertion');
  return rows as JudgeResult['scoreEvidence'];
}
