/** v1.4: direct factual claims only; removes meta-claim status ambiguity from v1.3. */
import {snapshotHash} from '../contracts/pack.js';
import {
  buildEvidenceLedger,
  evidenceLedgerReference,
  scoreEvidenceLedger,
  verifyEvidenceLedger,
  type EvidenceLedgerCase,
  type EvidenceLedgerGold,
} from './evidenceLedgerV13.js';
import {opaque, question, shuffle} from './methodsV2/types.js';

export const EVIDENCE_LEDGER_V14_VERSION = 'evidence-ledger-2026-09-12-v1.4';
export {evidenceLedgerReference as evidenceLedgerV14Reference, verifyEvidenceLedger as verifyEvidenceLedgerV14};

function directClaims(testCase: EvidenceLedgerCase) {
  if (testCase.family === 'temporal_scope_ledger') {
    return {claims: {...testCase.claims}, gold: testCase.gold.map((gold) => ({...gold, sources: [...gold.sources]}))};
  }
  const parameter = testCase.variant === 'parameter';
  const claims = {
    C1: '处理在人群P内降低错误率。',
    C2: 'D03与D04是对D02结果的两次独立复现。',
    C3: '处理在人群Q内降低错误率。',
    C4: '高负载是D05所述全部故障的唯一原因。',
    C5: '机制A导致该历史事故。',
    C6: 'D07新设备中的响应机制与历史事故当时的响应机制完全相同。',
  };
  const gold: EvidenceLedgerGold[] = [
    {id: 'C1', status: 'supported', sources: ['D01', 'D02']},
    {id: 'C2', status: 'refuted', sources: ['D01', 'D03', 'D04']},
    {id: 'C3', status: parameter ? 'supported' : 'insufficient', sources: ['D01', 'D10']},
    {id: 'C4', status: 'insufficient', sources: ['D01', 'D05']},
    {id: 'C5', status: parameter ? 'supported' : 'conflict', sources: parameter ? ['D01', 'D08'] : ['D01', 'D08', 'D09']},
    {id: 'C6', status: 'insufficient', sources: ['D01', 'D06', 'D07']},
  ];
  return {claims, gold};
}

export function buildEvidenceLedgerV14(seed = 20260912) {
  const prior = buildEvidenceLedger(seed);
  const cases = prior.cases.map((oldCase) => {
    const {claims, gold} = directClaims(oldCase);
    const id = opaque({version: EVIDENCE_LEDGER_V14_VERSION, seed, family: oldCase.family, variant: oldCase.variant});
    const group = opaque({version: EVIDENCE_LEDGER_V14_VERSION, seed, family: oldCase.family});
    const task = `以下是封闭材料，不得使用外部知识，不得把“未记录”当成反证。C1-C6全部是直接事实主张，不是“材料是否足以”之类元主张；分别判断supported/refuted/insufficient/conflict，并给出恰好必要的材料编号。
status含义：supported=当前控制材料直接支持该事实；refuted=当前控制材料直接支持其否定；insufficient=相关材料存在但缺关键观测，既不能支持也不能反驳；conflict=仍有效的同级控制材料直接矛盾。
材料编号采用可删除检验：必须含D01；再加入所有且仅加入这样的事实材料——删除它后，当前status就不再能由剩余所列材料推出。不得加入只提供背景但删除后不影响status的材料。
来源血缘主张只列明确写出来源关系的材料，不因其提到上游编号就自动加入上游内容；版本替代只列明确宣告替代的当前材料，不自动加入被替代草稿；conflict列全部仍有效且互相矛盾的控制材料；insufficient列全部直接相关且共同暴露关键观测缺口的材料。
只返回JSON对象：{"claims":[{"id":"C1","status":"...","sources":["D.."]},...]}; C1-C6各一次，不得多字段。顺序不限。每个主张的status和sources分别计为两个原子，另报告整题是否全对。
材料：${JSON.stringify(oldCase.documents)}
待判断主张：${JSON.stringify(claims)}${oldCase.variant === 'irrelevant' ? '\n无关封面字段：封皮为紫色，库位731；删除后不影响任何status。' : ''}`;
    return {
      ...oldCase,
      id,
      group,
      claims,
      gold,
      question: question(id, 'hallucination_resistance', task),
    };
  });
  const ordered = shuffle(cases, seed);
  const policy = {
    ...prior.policy,
    version: EVIDENCE_LEDGER_V14_VERSION,
    claimForm: 'direct_factual_claims_only_no_evidence_sufficiency_meta_claims',
    supersedes: 'evidence-ledger-2026-09-12-v1.3-before_any_completed_valid_model_run',
  };
  return {policy, cases: ordered, questions: ordered.map((testCase) => testCase.question), contractHash: snapshotHash({policy, cases: ordered})};
}

export function scoreEvidenceLedgerV14(pack: ReturnType<typeof buildEvidenceLedgerV14>, input: any) {
  return scoreEvidenceLedger(pack as ReturnType<typeof buildEvidenceLedger>, input);
}
