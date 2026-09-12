/** New development scoring lane. No Judge, network, database, or legacy-score mutation. */
import {snapshotHash} from '../contracts/pack.js';
import {buildChallengePack, candidateQuestion, gradeChallenge} from './challengePack.js';
import {exactKeys, object, type ChallengeCase, type ChallengeGrade} from './challengeTypes.js';

export const VERIFIABLE_CORE_POLICY = {
  version: 'verifiable-core-2026-09-11-v1',
  scope: 'development_lab_only',
  judge: {automaticCalls: false, role: 'optional_diagnostic_only', scoreWeight: 0},
  hallucinationRule: 'each_field_requires_value_status_and_relevant_sufficient_sources_together',
  mathRule: 'all_requested_answers_constraints_and_certificates_must_pass',
  aggregation: 'equal_case_mean_within_dimension_only_when_all_planned_cases_measured',
  incompleteRule: 'missing_truncated_environment_error_or_grader_error_is_unmeasured_not_zero',
  malformedCompleteRule: 'completed_but_malformed_answer_scores_zero',
  historyRule: 'one_explicit_answer_per_case_no_best_of_no_implicit_retry_selection',
  combinedScore: null,
  independentGold: false,
  difficultyCalibrated: false,
  productionEligible: false,
} as const;

export function buildVerifiableCore() {
  const pack = buildChallengePack();
  const questions = pack.cases.map(candidateQuestion);
  const contract = {policy: VERIFIABLE_CORE_POLICY, sourceVersion: pack.version, sourceHash: pack.hash,
    plannedQuestions: questions.map(q => ({id:q.id, dimension:q.dimension, questionHash:snapshotHash(q)}))};
  return {contract, contractHash:snapshotHash(contract), cases:pack.cases, questions};
}

export interface CoreAnswer {
  id: string;
  questionHash: string;
  outcome: 'completed'|'truncated'|'environment_error';
  output: string;
}
export interface CoreSubmission {
  contractHash: string;
  runId: string;
  modelId: string;
  answers: CoreAnswer[];
}
export interface CoreRow {
  id: string;
  dimension: ChallengeCase['dimension'];
  state: 'measured'|'missing'|'truncated'|'environment_error'|'grader_error';
  score: number|null;
  strictPass: boolean|null;
  outputHash: string|null;
  grade: ChallengeGrade|null;
  fieldChecks: {id:string; answer:boolean; sources:boolean; joint:boolean}[];
}

/** Open prose and Judge observations have no path into the primary result. */
export function auxiliaryObservation(itemId:string, observation:unknown) {
  return {itemId, role:'diagnostic_only', primaryScore:null, includedInPrimary:false,
    observation, semanticAccuracyVerified:false, productionEligible:false};
}

export function gradeVerifiableCase(c:ChallengeCase, answer?:CoreAnswer):CoreRow {
  const base:CoreRow = {id:c.id, dimension:c.dimension, state:'missing', score:null, strictPass:null,
    outputHash:answer ? snapshotHash(answer.output) : null, grade:null, fieldChecks:[]};
  if (!answer) return base;
  if (answer.outcome !== 'completed') return {...base, state:answer.outcome};
  let grade:ChallengeGrade;
  try { grade = gradeChallenge(c, answer.output, true); }
  catch { return {...base, state:'grader_error'}; } // Verifier failure is not model failure.
  const fieldChecks = c.dimension === 'hallucination_resistance' ? c.fields.map(f => {
    const pass = (suffix:string) => grade.formatValid && grade.checks.find(r=>r.id===f.id+suffix)?.pass===true;
    return {id:f.id, answer:pass('.answer'), sources:pass('.sources'), joint:pass('.answer') && pass('.sources')};
  }) : [];
  // Never average the old separate answer/citation checks: correct citations cannot rescue a wrong claim.
  const score = c.dimension === 'hallucination_resistance'
    ? 100 * fieldChecks.filter(f=>f.joint).length / fieldChecks.length
    : grade.strictPass ? 100 : 0;
  return {...base, state:'measured', score, strictPass:grade.strictPass, grade, fieldChecks};
}

/** One model/run, full frozen denominator. Ambiguous historical attempts must be resolved upstream. */
export function scoreVerifiableRun(input:unknown) {
  const pack = buildVerifiableCore();
  if (!exactKeys(input, ['contractHash','runId','modelId','answers']) || input.contractHash!==pack.contractHash ||
      typeof input.runId!=='string' || !input.runId.trim() || typeof input.modelId!=='string' || !input.modelId.trim() ||
      !Array.isArray(input.answers)) throw new Error('Invalid run envelope or stale scoring contract');
  const answers = new Map<string,CoreAnswer>();
  for (const row of input.answers) {
    if (!exactKeys(row,['id','questionHash','outcome','output']) || typeof row.id!=='string' || typeof row.output!=='string' ||
        !['completed','truncated','environment_error'].includes(row.outcome as string)) throw new Error('Invalid answer record');
    const planned = pack.contract.plannedQuestions.find(q=>q.id===row.id);
    if (!planned || planned.questionHash!==row.questionHash || answers.has(row.id)) throw new Error('Unknown, stale or duplicate answer; no best-of selection');
    answers.set(row.id,row as unknown as CoreAnswer);
  }
  const rows = pack.cases.map(c=>gradeVerifiableCase(c, answers.get(c.id)));
  const dimensions = (['hallucination_resistance','reasoning_math'] as const).map(dimension=>{
    const group=rows.filter(r=>r.dimension===dimension), measured=group.filter(r=>r.state==='measured');
    return {dimension, planned:group.length, measured:measured.length, strictPassed:measured.filter(r=>r.strictPass).length,
      score:measured.length===group.length ? measured.reduce((sum,r)=>sum+r.score!,0)/group.length : null,
      status:measured.length===group.length ? 'complete_development_measurement' : 'incomplete_no_dimension_score',
      unresolved:group.filter(r=>r.state!=='measured').map(r=>({id:r.id,state:r.state}))};
  });
  return {policy:VERIFIABLE_CORE_POLICY, contractHash:pack.contractHash, runId:input.runId, modelId:input.modelId,
    submissionHash:snapshotHash(input), dimensions, rows, combinedScore:null, judgeCalls:0, productionScoresChanged:false};
}

/** Export only candidate-visible fields; coordinator references never enter model messages. */
export function verifyFrozenCore(frozen:unknown) {
  const current=buildVerifiableCore();
  if (!object(frozen) || snapshotHash(frozen)!==snapshotHash(current)) throw new Error('Frozen/current core mismatch');
  return current;
}
