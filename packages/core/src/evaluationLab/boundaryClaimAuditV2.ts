import {snapshotHash} from '../contracts/pack.js';
import {parseAnswer} from './methodsV2/verify.js';
import {BOUNDARY_AUDIT_INSTRUCTIONS, boundaryPublicInput, checkBoundaryAudit, type BoundaryAuditInput} from './boundaryClaimAudit.js';
export const GENERAL_BOUNDARY_TARGET = 'P9999';
export const BOUNDARY_AUDIT_V2_INSTRUCTIONS = BOUNDARY_AUDIT_INSTRUCTIONS
  .replace('proposal必须为题目P编号', 'proposal必须为宿主proposals中的P编号，包含宿主登记的一般原理反例检验集合P9999')
  .replace('scope=general_instantiation用于一般原理在一个题目提议中的实例，保留该原理全部可表示条件。', 'scope=general_instantiation用于原文一般原理，proposal填写P9999，保留该原理全部可表示条件；不要要求原文先点名某个具体提议。')
  + '\n一般原理本身也是必须提取的主张，不要推迟到后面的应用句。P9999由宿主收集题目全部pieces构成，只是用于寻找反例的有限实例集合，不能证明一般原理。P9999只能使用general_instantiation。原文“若A则B”“满足A就会B”通常是在认领充分性蕴含；不得因为你认为数学上不成立，就擅自改成“可能B”或存在性。若语气真的无法确定，coverage用uncertain而不是none。不添加原文没有的强条件来修好作者证明。';
function augmented(input: BoundaryAuditInput): BoundaryAuditInput {
  if (Object.hasOwn(input.proposals, GENERAL_BOUNDARY_TARGET)) throw new Error('Reserved host target conflicts with question');
  const pieces = [...new Set(Object.values(input.proposals).flatMap(p => p.pieces))];
  if (pieces.length > 16) throw new Error('General instance pool exceeds supported bound');
  return {...input, proposals: {...input.proposals, [GENERAL_BOUNDARY_TARGET]: {side: 'prefix', pieces}}};
}
export function boundaryPublicInputV2(input: BoundaryAuditInput) {
  return {...boundaryPublicInput(augmented(input)), originalInputHash: snapshotHash(input), hostGeneralTarget: {id: GENERAL_BOUNDARY_TARGET,
    provenance: 'union_of_original_question_pieces_not_an_original_proposal', sideField: 'placeholder_only_general_claim_side_comes_from_candidate',
    proofScope: 'counterexamples_only_for_general_claims_never_general_theorem_proof'}};
}
export function checkBoundaryAuditV2(input: BoundaryAuditInput, content: string, finishReason: string, streamDone: boolean) {
  const rows = parseAnswer(content);
  if (Array.isArray(rows)) for (const row of rows) {
    if (row && typeof row === 'object' && Array.isArray(row.claims)) for (const claim of row.claims) {
      if (claim?.proposal === GENERAL_BOUNDARY_TARGET && claim.scope !== 'general_instantiation') throw new Error('Host pool is not a question proposal');
    }
  }
  return {...checkBoundaryAudit(augmented(input), content, finishReason, streamDone), version: 'boundary-claim-audit-v2', originalInputHash: snapshotHash(input),
    hostGeneralTarget: boundaryPublicInputV2(input).hostGeneralTarget};
}
