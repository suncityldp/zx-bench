/** Closed-evidence ledger tasks with explicit, removable-source minimality and atomic scoring. */
import {snapshotHash} from '../contracts/pack.js';
import {certificateDiagnostic} from './certificateDiagnostic.js';
import {exactKeys} from './challengeTypes.js';
import {parseAnswer} from './methodsV2/verify.js';
import {opaque, question, shuffle, type Question} from './methodsV2/types.js';

type Status = 'supported' | 'refuted' | 'insufficient' | 'conflict';
export interface EvidenceLedgerGold {id: string; status: Status; sources: string[]}
export interface EvidenceLedgerCase {
  id: string;
  family: string;
  variant: string;
  group: string;
  documents: Record<string, string>;
  claims: Record<string, string>;
  gold: EvidenceLedgerGold[];
  question: Question;
}
export const EVIDENCE_LEDGER_VERSION = 'evidence-ledger-2026-09-12-v1.3';
const STATUSES: Status[] = ['supported', 'refuted', 'insufficient', 'conflict'];

export function evidenceLedgerReference(testCase: EvidenceLedgerCase) {
  return {claims: testCase.gold.map((gold) => ({id: gold.id, status: gold.status, sources: [...gold.sources]}))};
}

function temporalScope(parameter: boolean) {
  const documents: Record<string, string> = {
    D01: '裁定规则：材料必须同时匹配人员、费用类别和发生日期才适用；同一发布者的终版仅在明示时替代被点名草稿；部门专项终版在其范围内优先于机构通则；部门建议备忘录无裁定权；不完整流水中没有某笔记录不能证明已付款或未付款；同范围同权限且互不替代的终版相互矛盾时保留冲突。',
    D02: '机构财务终版：1月1日至12月31日，普通员工住宿每日上限500元。',
    D03: parameter
      ? '财务部专项终版：财务部申请人E2在1月1日至3月31日的住宿每日上限700元；本终版明确替代D07草稿。'
      : '财务部专项终版：财务部申请人E2在1月1日至3月31日的住宿每日上限800元；本终版明确替代D07草稿。',
    D04: '费用记录：申请人E2，所属财务部，住宿发生于1月15日，标价750元。',
    D05: '部门建议备忘录：建议把E2住宿上限临时按900元处理；本文件不是财务终版。',
    D06: '付款流水节选：当前节选不完整，未显示E2的住宿付款条目，无法据此确认是否曾支付。',
    D07: '被替代草稿：E2住宿每日上限600元。',
    D08: parameter
      ? '审批终版A：E2申请已批准；本终版明确替代D09草稿。'
      : '审批终版A：E2申请已批准；未替代其他终版。',
    D09: parameter
      ? '审批草稿D09：E2申请未批准。'
      : '审批终版B：E2申请未批准；与D08同权限、同范围且互不替代。',
    D10: '交通费用终版：出租车费用上限与住宿无关。',
  };
  const claims = {
    C1: 'D04所述费用的适用住宿上限是500元。',
    C2: 'D04所述750元住宿标价超过适用上限。',
    C3: 'E2已经实际收到D04对应的住宿报销款。',
    C4: '现有审批材料能唯一确定E2申请已获批准。',
    C5: 'D05的900元建议是D04费用的有效控制上限。',
    C6: 'D07仍是E2住宿上限的当前控制材料。',
  };
  const gold: EvidenceLedgerGold[] = [
    {id: 'C1', status: 'refuted', sources: ['D01', 'D03', 'D04']},
    {id: 'C2', status: parameter ? 'supported' : 'refuted', sources: ['D01', 'D03', 'D04']},
    {id: 'C3', status: 'insufficient', sources: ['D01', 'D06']},
    {
      id: 'C4',
      status: parameter ? 'supported' : 'conflict',
      sources: parameter ? ['D01', 'D08'] : ['D01', 'D08', 'D09'],
    },
    {id: 'C5', status: 'refuted', sources: ['D01', 'D05']},
    {id: 'C6', status: 'refuted', sources: ['D01', 'D03']},
  ];
  return {documents, claims, gold};
}

function provenanceIntervention(parameter: boolean) {
  const documents: Record<string, string> = {
    D01: '推断规则：随机试验只支持其试验人群内的处理效应；转述或派生同一上游数据不是独立复现，判断来源关系时须使用写明血缘的材料；观察相关不能单独证明唯一原因；未来新设备实验不能单独确定缺失原始状态的历史事件原因；同范围同权限且互不替代的独立终版矛盾时保留冲突，明示替代的草稿不再控制当前结论。',
    D02: '随机试验R终版：在人群P中随机分组，处理组错误率10%，对照组20%，流程和失访相同。',
    D03: '摘要S：10%与20%全部逐字取自D02，没有新增样本或测量。',
    D04: '复核表V：由D03自动生成，并以D02作为唯一上游数据；没有独立采样。',
    D05: '观察日志：高负载班次同时出现更多告警和故障；未随机化且未排除设备老化。',
    D06: '历史事故记录：当时没有内部温度或原始波形，两种机制A/B均可能。',
    D07: '下周在另一台新设备上的受控实验复现机制A响应；实验不恢复历史事故的缺失原始状态。',
    D08: parameter
      ? '独立法证终版A：机制A导致该事故；本终版明确替代D09草稿。'
      : '独立法证终版A：机制A导致该事故；未替代其他终版。',
    D09: parameter
      ? '法证草稿D09：机制B导致该事故。'
      : '另一独立法证终版B：机制B导致该事故；与D08同权限且互不替代。',
    D10: parameter
      ? '人群Q随机试验终版：随机分组后处理组错误率12%，对照组24%，流程和失访相同。'
      : '人群Q观察报告：采用处理的班次错误率较低，但未随机化且未控制班次难度。',
  };
  const claims = {
    C1: '在人群P内，D02支持处理降低错误率。',
    C2: 'D03与D04是对D02结果的两次独立复现。',
    C3: '现有材料支持处理在人群Q内降低错误率。',
    C4: 'D05足以证明高负载是其中全部故障的唯一原因。',
    C5: '当前法证材料能唯一确定机制A导致该历史事故。',
    C6: 'D07这一未来实验本身足以确定机制A是历史事故的唯一原因。',
  };
  const gold: EvidenceLedgerGold[] = [
    {id: 'C1', status: 'supported', sources: ['D01', 'D02']},
    {id: 'C2', status: 'refuted', sources: ['D01', 'D03', 'D04']},
    {
      id: 'C3',
      status: parameter ? 'supported' : 'insufficient',
      sources: parameter ? ['D01', 'D10'] : ['D01', 'D02', 'D10'],
    },
    {id: 'C4', status: 'insufficient', sources: ['D01', 'D05']},
    {
      id: 'C5',
      status: parameter ? 'supported' : 'conflict',
      sources: parameter ? ['D01', 'D08'] : ['D01', 'D08', 'D09'],
    },
    {id: 'C6', status: 'refuted', sources: ['D01', 'D06', 'D07']},
  ];
  return {documents, claims, gold};
}

export function buildEvidenceLedger(seed = 20260912) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0x7fffffff) throw new Error('Invalid seed');
  const cases: EvidenceLedgerCase[] = [];
  for (const family of ['temporal_scope_ledger', 'provenance_intervention_ledger']) {
    for (const variant of ['base', 'parameter', 'irrelevant']) {
      const built = family === 'temporal_scope_ledger'
        ? temporalScope(variant === 'parameter')
        : provenanceIntervention(variant === 'parameter');
      const id = opaque({version: EVIDENCE_LEDGER_VERSION, seed, family, variant});
      const group = opaque({version: EVIDENCE_LEDGER_VERSION, seed, family});
      const task = `以下是封闭材料，不得使用外部知识，不得把“未记录”当成反证。对C1-C6分别判断supported/refuted/insufficient/conflict，并给出恰好必要的材料编号。
材料编号规则是可删除检验：必须含D01；再加入所有且仅加入这样的事实材料——删除它后，当前status就不再能由剩余所列材料推出。不得加入只提供背景但删除后不影响status的材料。
来源血缘主张只列明确写出来源关系的材料，不因其提到上游编号就自动加入上游内容；版本替代主张只列明确宣告替代的当前材料，不自动加入被替代草稿；conflict必须列全部仍有效且互相矛盾的控制材料；insufficient必须列全部直接相关但仍缺少关键观测的材料。
只返回JSON对象：{"claims":[{"id":"C1","status":"...","sources":["D.."]},...]}; C1-C6各一次，不得多字段。顺序不限。每个主张的status和sources分别计为两个原子，另报告整题是否全对。
材料：${JSON.stringify(built.documents)}
待判断主张：${JSON.stringify(built.claims)}${variant === 'irrelevant' ? '\n无关封面字段：封皮为紫色，库位731；删除后不影响任何status。' : ''}`;
      cases.push({id, family, variant, group, ...built, question: question(id, 'hallucination_resistance', task)});
    }
  }
  const ordered = shuffle(cases, seed);
  const policy = {
    version: EVIDENCE_LEDGER_VERSION,
    seed,
    primary: 'atomic_claim_status_and_removable_source_minimality',
    atomsPerQuestion: 12,
    aggregation: 'equal_family_atomic_accuracy_all_planned_required',
    strictQuestionPass: 'all_twelve_atoms',
    format: 'one_exact_json_object_no_repair',
    judgeCalls: 0,
    independentGold: false,
    difficultyCalibrated: false,
    productionEligible: false,
  };
  return {policy, cases: ordered, questions: ordered.map((testCase) => testCase.question), contractHash: snapshotHash({policy, cases: ordered})};
}

export function verifyEvidenceLedger(testCase: EvidenceLedgerCase, output: string) {
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
    ) {
      return {id: typeof row.id === 'string' ? row.id : '?', statusPass: false, sourcesPass: false, passedAtoms: 0, plannedAtoms: 2, pass: false};
    }
    seen.add(row.id);
    const gold = testCase.gold.find((candidate) => candidate.id === row.id);
    if (!gold) return {id: row.id, statusPass: false, sourcesPass: false, passedAtoms: 0, plannedAtoms: 2, pass: false};
    const statusPass = row.status === gold.status;
    const sourcesPass = [...row.sources].sort().join('|') === [...gold.sources].sort().join('|');
    return {id: row.id, statusPass, sourcesPass, passedAtoms: Number(statusPass) + Number(sourcesPass), plannedAtoms: 2, pass: statusPass && sourcesPass};
  });
  const formatValid = seen.size === testCase.gold.length && testCase.gold.every((gold) => seen.has(gold.id));
  const passedAtoms = formatValid ? atoms.reduce((sum, atom) => sum + atom.passedAtoms, 0) : 0;
  const plannedAtoms = testCase.gold.length * 2;
  return {formatValid, pass: formatValid && passedAtoms === plannedAtoms, passedAtoms, plannedAtoms, extraction, atoms};
}

export function scoreEvidenceLedger(pack: ReturnType<typeof buildEvidenceLedger>, input: any) {
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
      const verification = verifyEvidenceLedger(testCase, answer.output);
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
      scope: 'closed_evidence_atomic_status_and_minimal_sources',
      planned: rows.length,
      measured: measuredRows.length,
      plannedAtoms: rows.length * 12,
      passedAtoms: measuredRows.reduce((sum, row) => sum + (row.passedAtoms ?? 0), 0),
      score: families.every((family) => family.score !== null)
        ? families.reduce((sum, family) => sum + family.score!, 0) / families.length
        : null,
      weighting: 'equal_family_atomic_accuracy',
    }],
    combinedScore: null,
    judgeCalls: 0,
    independentGold: false,
    difficultyCalibrated: false,
    productionEligible: false,
  };
}
