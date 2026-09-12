/** v1.5: direct claims plus required/allowed citation sets instead of a brittle unique minimum. */
import {snapshotHash} from '../contracts/pack.js';
import {certificateDiagnostic} from './certificateDiagnostic.js';
import {exactKeys} from './challengeTypes.js';
import {buildEvidenceLedgerV14} from './evidenceLedgerV14.js';
import type {EvidenceLedgerCase} from './evidenceLedgerV13.js';
import {parseAnswer} from './methodsV2/verify.js';
import {opaque, question, shuffle, type Question} from './methodsV2/types.js';

type Status = 'supported' | 'refuted' | 'insufficient' | 'conflict';
export interface EvidenceLedgerV15Gold {
  id: string;
  status: Status;
  requiredSources: string[];
  allowedSources: string[];
}
export interface EvidenceLedgerV15Case {
  id: string;
  family: string;
  variant: string;
  group: string;
  documents: Record<string, string>;
  claims: Record<string, string>;
  gold: EvidenceLedgerV15Gold[];
  question: Question;
}
export const EVIDENCE_LEDGER_V15_VERSION = 'evidence-ledger-2026-09-12-v1.5';
const STATUSES: Status[] = ['supported', 'refuted', 'insufficient', 'conflict'];

function citationGold(testCase: EvidenceLedgerCase): EvidenceLedgerV15Gold[] {
  const parameter = testCase.variant === 'parameter';
  if (testCase.family === 'temporal_scope_ledger') {
    return [
      {id: 'C1', status: 'refuted', requiredSources: ['D01', 'D03', 'D04'], allowedSources: ['D01', 'D02', 'D03', 'D04']},
      {id: 'C2', status: parameter ? 'supported' : 'refuted', requiredSources: ['D01', 'D03', 'D04'], allowedSources: ['D01', 'D03', 'D04']},
      {id: 'C3', status: 'insufficient', requiredSources: ['D01', 'D06'], allowedSources: ['D01', 'D04', 'D06']},
      {
        id: 'C4',
        status: parameter ? 'supported' : 'conflict',
        requiredSources: parameter ? ['D01', 'D08'] : ['D01', 'D08', 'D09'],
        allowedSources: ['D01', 'D08', 'D09'],
      },
      {id: 'C5', status: 'refuted', requiredSources: ['D01', 'D03', 'D04'], allowedSources: ['D01', 'D03', 'D04', 'D05']},
      {id: 'C6', status: 'refuted', requiredSources: ['D01', 'D03', 'D04'], allowedSources: ['D01', 'D03', 'D04', 'D07']},
    ];
  }
  return [
    {id: 'C1', status: 'supported', requiredSources: ['D01', 'D02'], allowedSources: ['D01', 'D02']},
    {id: 'C2', status: 'refuted', requiredSources: ['D01', 'D03', 'D04'], allowedSources: ['D01', 'D02', 'D03', 'D04']},
    {id: 'C3', status: parameter ? 'supported' : 'insufficient', requiredSources: ['D01', 'D10'], allowedSources: ['D01', 'D02', 'D10']},
    {id: 'C4', status: 'insufficient', requiredSources: ['D01', 'D05'], allowedSources: ['D01', 'D05']},
    {
      id: 'C5',
      status: parameter ? 'supported' : 'conflict',
      requiredSources: parameter ? ['D01', 'D08'] : ['D01', 'D08', 'D09'],
      allowedSources: ['D01', 'D06', 'D08', 'D09'],
    },
    {id: 'C6', status: 'insufficient', requiredSources: ['D01', 'D06', 'D07'], allowedSources: ['D01', 'D06', 'D07']},
  ];
}

export function evidenceLedgerV15Reference(testCase: EvidenceLedgerV15Case) {
  return {claims: testCase.gold.map((gold) => ({id: gold.id, status: gold.status, sources: [...gold.requiredSources]}))};
}

export function buildEvidenceLedgerV15(seed = 20260912) {
  const prior = buildEvidenceLedgerV14(seed);
  const cases: EvidenceLedgerV15Case[] = prior.cases.map((oldCase) => {
    const id = opaque({version: EVIDENCE_LEDGER_V15_VERSION, seed, family: oldCase.family, variant: oldCase.variant});
    const group = opaque({version: EVIDENCE_LEDGER_V15_VERSION, seed, family: oldCase.family});
    const gold = citationGold(oldCase);
    const claims = oldCase.family === 'temporal_scope_ledger' ? {
      C1: 'D04所述费用的适用住宿上限是500元。',
      C2: 'D04所述750元住宿标价超过适用上限。',
      C3: 'E2已经实际收到D04对应的住宿报销款。',
      C4: 'E2申请已获批准。',
      C5: 'D04费用的有效控制上限是900元。',
      C6: 'D04费用的当前住宿上限是600元。',
    } : oldCase.claims;
    const task = `以下是封闭材料，不得使用外部知识，不得把“未记录”当成反证。C1-C6全部是直接事实主张；分别判断supported/refuted/insufficient/conflict，并列出裁定所用材料编号。
status含义：supported=当前控制材料直接支持该事实；refuted=当前控制材料直接支持其否定；insufficient=相关材料存在但缺关键观测，既不能支持也不能反驳；conflict=仍有效的同级控制材料直接矛盾。
每个sources必须覆盖裁定不可缺少的规则与事实材料；可以加入直接解释该主张、适用范围或冲突消解的相关材料，但不得加入与该主张无关的材料。来源血缘须引用写明血缘的材料；版本替代须引用宣告替代的当前材料；conflict须覆盖全部仍有效的矛盾控制材料；insufficient须覆盖暴露关键观测缺口的材料。
只返回JSON对象：{"claims":[{"id":"C1","status":"...","sources":["D.."]},...]}; C1-C6各一次，不得多字段。顺序不限。每个主张的status和证据有效性分别计为两个原子，另报告整题是否全对。
材料：${JSON.stringify(oldCase.documents)}
待判断主张：${JSON.stringify(claims)}${oldCase.variant === 'irrelevant' ? '\n无关封面字段：封皮为紫色，库位731；不得用于任何裁定。' : ''}`;
    return {
      id,
      family: oldCase.family,
      variant: oldCase.variant,
      group,
      documents: oldCase.documents,
      claims,
      gold,
      question: question(id, 'hallucination_resistance', task),
    };
  });
  const ordered = shuffle(cases, seed);
  const policy = {
    version: EVIDENCE_LEDGER_V15_VERSION,
    seed,
    primary: 'atomic_direct_claim_status_and_required_allowed_evidence',
    atomsPerQuestion: 12,
    aggregation: 'equal_family_atomic_accuracy_all_planned_required',
    strictQuestionPass: 'all_twelve_atoms',
    citationRule: 'all_required_present_and_no_source_outside_allowed_set',
    format: 'one_exact_json_object_no_repair',
    judgeCalls: 0,
    independentGold: false,
    difficultyCalibrated: false,
    productionEligible: false,
    supersedes: 'evidence-ledger-2026-09-12-v1.4-after_one_completed_diagnostic_response',
  };
  return {policy, cases: ordered, questions: ordered.map((testCase) => testCase.question), contractHash: snapshotHash({policy, cases: ordered})};
}

export function verifyEvidenceLedgerV15(testCase: EvidenceLedgerV15Case, output: string) {
  const extraction = certificateDiagnostic(output);
  if (extraction.certificate === null) return {formatValid: false, pass: false, extraction, atoms: []};
  const value = parseAnswer(extraction.certificate);
  if (!exactKeys(value, ['claims']) || !Array.isArray(value.claims) || value.claims.length !== testCase.gold.length) {
    return {formatValid: false, pass: false, extraction, atoms: []};
  }
  const seen = new Set<string>();
  const atoms = value.claims.map((row: any) => {
    if (
      !exactKeys(row, ['id', 'status', 'sources']) ||
      typeof row.id !== 'string' ||
      seen.has(row.id) ||
      !STATUSES.includes(String(row.status) as Status) ||
      !Array.isArray(row.sources) ||
      row.sources.some((source: unknown) => typeof source !== 'string') ||
      new Set(row.sources).size !== row.sources.length
    ) return {id: typeof row.id === 'string' ? row.id : '?', statusPass: false, sourcesPass: false, missingRequired: [], disallowed: [], passedAtoms: 0, plannedAtoms: 2, pass: false};
    seen.add(row.id);
    const gold = testCase.gold.find((candidate) => candidate.id === row.id);
    if (!gold) return {id: row.id, statusPass: false, sourcesPass: false, missingRequired: [], disallowed: [], passedAtoms: 0, plannedAtoms: 2, pass: false};
    const supplied = new Set<string>(row.sources);
    const allowed = new Set(gold.allowedSources);
    const missingRequired = gold.requiredSources.filter((source) => !supplied.has(source));
    const disallowed = row.sources.filter((source: string) => !allowed.has(source));
    const statusPass = row.status === gold.status;
    const sourcesPass = missingRequired.length === 0 && disallowed.length === 0;
    return {id: row.id, statusPass, sourcesPass, missingRequired, disallowed, passedAtoms: Number(statusPass) + Number(sourcesPass), plannedAtoms: 2, pass: statusPass && sourcesPass};
  });
  const formatValid = seen.size === testCase.gold.length && testCase.gold.every((gold) => seen.has(gold.id));
  const passedAtoms = formatValid ? atoms.reduce((sum, atom) => sum + atom.passedAtoms, 0) : 0;
  const plannedAtoms = testCase.gold.length * 2;
  return {formatValid, pass: formatValid && passedAtoms === plannedAtoms, passedAtoms, plannedAtoms, extraction, atoms};
}

export function scoreEvidenceLedgerV15(pack: ReturnType<typeof buildEvidenceLedgerV15>, input: any) {
  if (
    !exactKeys(input, ['contractHash', 'runId', 'modelId', 'modelFamily', 'answers']) ||
    input.contractHash !== pack.contractHash ||
    !['runId', 'modelId', 'modelFamily'].every((key) => typeof input[key] === 'string' && input[key].trim()) ||
    !Array.isArray(input.answers)
  ) throw new Error('Invalid submission');
  const answers = new Map<string, any>();
  for (const answer of input.answers) {
    if (
      !exactKeys(answer, ['id', 'questionHash', 'outcome', 'output']) ||
      typeof answer.id !== 'string' ||
      answers.has(answer.id) ||
      !pack.cases.some((testCase) => testCase.id === answer.id && testCase.question.questionHash === answer.questionHash) ||
      !['completed', 'truncated', 'environment_error'].includes(String(answer.outcome)) ||
      typeof answer.output !== 'string'
    ) throw new Error('Duplicate/stale/unknown answer');
    answers.set(answer.id, answer);
  }
  const rows = pack.cases.map((testCase) => {
    const answer = answers.get(testCase.id);
    const base = {id: testCase.id, family: testCase.family, group: testCase.group, variant: testCase.variant, outputHash: answer ? snapshotHash(answer.output) : null};
    if (!answer || answer.outcome !== 'completed') return {...base, state: answer?.outcome ?? 'missing', pass: null, passedAtoms: null, plannedAtoms: 12, score: null};
    try {
      const verification = verifyEvidenceLedgerV15(testCase, answer.output);
      if (!verification.formatValid) return {...base, state: 'unparseable_requires_review', pass: null, passedAtoms: null, plannedAtoms: 12, score: null, verification};
      const passedAtoms = verification.passedAtoms!;
      const plannedAtoms = verification.plannedAtoms!;
      return {...base, state: 'completed', pass: verification.pass, passedAtoms, plannedAtoms, score: 100 * passedAtoms / plannedAtoms, verification};
    } catch {
      return {...base, state: 'grader_error', pass: null, passedAtoms: null, plannedAtoms: 12, score: null};
    }
  });
  const families = [...new Set(rows.map((row) => row.family))].map((family) => {
    const selected = rows.filter((row) => row.family === family);
    const measured = selected.filter((row) => row.score !== null);
    const passedAtoms = measured.reduce((sum, row) => sum + (row.passedAtoms ?? 0), 0);
    const plannedAtoms = selected.length * 12;
    return {
      family,
      plannedQuestions: selected.length,
      measuredQuestions: measured.length,
      strictQuestionsPassed: measured.filter((row) => row.pass).length,
      passedAtoms,
      plannedAtoms,
      score: measured.length === selected.length ? 100 * passedAtoms / plannedAtoms : null,
    };
  });
  const measuredRows = rows.filter((row) => row.score !== null);
  return {
    version: pack.policy.version,
    contractHash: pack.contractHash,
    runId: input.runId,
    modelId: input.modelId,
    modelFamily: input.modelFamily,
    rows,
    families,
    dimensions: [{
      dimension: 'hallucination_resistance',
      scope: 'closed_evidence_atomic_status_and_bounded_sources',
      planned: rows.length,
      measured: measuredRows.length,
      plannedAtoms: rows.length * 12,
      passedAtoms: measuredRows.reduce((sum, row) => sum + (row.passedAtoms ?? 0), 0),
      score: families.every((family) => family.score !== null) ? families.reduce((sum, family) => sum + family.score!, 0) / families.length : null,
      weighting: 'equal_family_atomic_accuracy',
    }],
    combinedScore: null,
    judgeCalls: 0,
    independentGold: false,
    difficultyCalibrated: false,
    productionEligible: false,
  };
}
