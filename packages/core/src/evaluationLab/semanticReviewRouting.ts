import {snapshotHash} from '../contracts/pack.js';
import type {AuditVerdict} from './atomicJudge.js';
export type AuditScope='closed_evidence_state'|'exact_math_certificate'|'free_form_proof';
/** Exact adjudication is never delegated back to a fallible semantic Judge. */
export function judgeRoute(scope:AuditScope){
  return scope==='free_form_proof'
    ?{requestRole:'bounded_shadow_review_only',automaticScoreAuthority:false,requiresReasonReview:true}
    :{requestRole:'deterministic_verifier_no_judge',automaticScoreAuthority:false,requiresReasonReview:false};
}
export function reviewedSemanticSignal(input:{scope:AuditScope;exactPass:boolean|null;candidate:string;outputHash:string;raw:unknown;rawHash:string;verdict:AuditVerdict;
  review:{rawHash:string;decision:string;reasonsSupported:boolean;quotesPreserveStance:boolean;sourceLinksRelevant:boolean}}){
  if(snapshotHash(input.candidate)!==input.outputHash||snapshotHash(input.raw)!==input.rawHash||input.review.rawHash!==input.rawHash)throw new Error('Signal is not bound to original answer and reviewed Judge output');
  if(input.verdict.quote!==input.candidate)throw new Error('Full original candidate context required');
  const approved=input.review.decision==='continue'&&input.review.reasonsSupported&&input.review.quotesPreserveStance&&input.review.sourceLinksRelevant;
  const route=judgeRoute(input.scope);
  const status=input.scope!=='free_form_proof'?'excluded_exact_adjudication':!approved?'quarantined_unvalidated_judge':input.verdict.verdict==='uncertain'?'unresolved':input.verdict.verdict==='fail'?'reviewed_proof_issue':'reviewed_no_proof_issue';
  return {exactPass:input.exactPass,judgeVerdict:input.verdict.verdict,route,status,
    displayAsReviewSignal:status==='reviewed_proof_issue',automaticScoreChanged:false,
    // A reviewed flag is inspectable evidence, not an independently adjudicated grade.
    independentlyAdjudicated:false};
}
