/** v1.6: removes an answer-leading sentence from the future-experiment document. */
import {snapshotHash} from '../contracts/pack.js';
import {
  buildEvidenceLedgerV15,
  evidenceLedgerV15Reference,
  scoreEvidenceLedgerV15,
  verifyEvidenceLedgerV15,
  type EvidenceLedgerV15Case,
  type EvidenceLedgerV15Gold,
} from './evidenceLedgerV15.js';
import {opaque, question, shuffle} from './methodsV2/types.js';

export const EVIDENCE_LEDGER_V16_VERSION = 'evidence-ledger-2026-09-12-v1.6';
export type EvidenceLedgerV16Case = EvidenceLedgerV15Case;
export type EvidenceLedgerV16Gold = EvidenceLedgerV15Gold;
export {evidenceLedgerV15Reference as evidenceLedgerV16Reference, verifyEvidenceLedgerV15 as verifyEvidenceLedgerV16};

function renderTask(testCase: EvidenceLedgerV15Case) {
  return `以下是封闭材料，不得使用外部知识，不得把“未记录”当成反证。C1-C6全部是直接事实主张；分别判断supported/refuted/insufficient/conflict，并列出裁定所用材料编号。
status含义：supported=当前控制材料直接支持该事实；refuted=当前控制材料直接支持其否定；insufficient=相关材料存在但缺关键观测，既不能支持也不能反驳；conflict=仍有效的同级控制材料直接矛盾。
每个sources必须覆盖裁定不可缺少的规则与事实材料；可以加入直接解释该主张、适用范围或冲突消解的相关材料，但不得加入与该主张无关的材料。来源血缘须引用写明血缘的材料；版本替代须引用宣告替代的当前材料；conflict须覆盖全部仍有效的矛盾控制材料；insufficient须覆盖暴露关键观测缺口的材料。
只返回JSON对象：{"claims":[{"id":"C1","status":"...","sources":["D.."]},...]}; C1-C6各一次，不得多字段。顺序不限。每个主张的status和证据有效性分别计为两个原子，另报告整题是否全对。
材料：${JSON.stringify(testCase.documents)}
待判断主张：${JSON.stringify(testCase.claims)}${testCase.variant === 'irrelevant' ? '\n无关封面字段：封皮为紫色，库位731；不得用于任何裁定。' : ''}`;
}

export function buildEvidenceLedgerV16(seed = 20260912) {
  const prior = buildEvidenceLedgerV15(seed);
  const cases: EvidenceLedgerV16Case[] = prior.cases.map((oldCase) => {
    const documents = {...oldCase.documents};
    if (oldCase.family === 'provenance_intervention_ledger') {
      documents.D07 = '下周在另一台新设备上的受控实验复现机制A响应。';
    }
    const id = opaque({version: EVIDENCE_LEDGER_V16_VERSION, seed, family: oldCase.family, variant: oldCase.variant});
    const group = opaque({version: EVIDENCE_LEDGER_V16_VERSION, seed, family: oldCase.family});
    const nextCase: EvidenceLedgerV16Case = {
      ...oldCase,
      id,
      group,
      documents,
      gold: oldCase.gold.map((gold) => ({...gold, requiredSources: [...gold.requiredSources], allowedSources: [...gold.allowedSources]})),
      question: oldCase.question,
    };
    nextCase.question = question(id, 'hallucination_resistance', renderTask(nextCase));
    return nextCase;
  });
  const ordered = shuffle(cases, seed);
  const policy = {
    ...prior.policy,
    version: EVIDENCE_LEDGER_V16_VERSION,
    supersedes: 'evidence-ledger-2026-09-12-v1.5-before_any_model_call',
    answerLeakageControl: 'future_experiment_states_only_observed_response_not_the_historical_inference_limit',
  };
  return {policy, cases: ordered, questions: ordered.map((testCase) => testCase.question), contractHash: snapshotHash({policy, cases: ordered})};
}

export function scoreEvidenceLedgerV16(pack: ReturnType<typeof buildEvidenceLedgerV16>, input: any) {
  return scoreEvidenceLedgerV15(pack as ReturnType<typeof buildEvidenceLedgerV15>, input);
}
