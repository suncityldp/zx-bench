import {buildChallengePack} from './challengePack.js';
import {buildEvidenceHoldoutDraft} from './challengeHoldout.js';

const MATH_CHECKS:Record<string,string>={
 'MC2-001':'独立枚举路线、时间窗及约束，与最优值比较',
 'MC2-002':'独立按整数时刻搜索加工区间，枚举排列核对最优值',
 'MC2-003':'独立枚举所有子集，验证资源及依赖约束和最优值',
 'MC2-004':'动态规划计数与完整约束枚举交叉核对',
 'MC2-005':'组合计数与带标签抽样枚举交叉核对',
 'MC2-006':'精确分数求解后代入所有状态递推关系',
 'MC2-007':'同余根枚举、解集合完整性及等价整数表示检查',
 'MC2-008':'互不相交三角形给出删点下界，合法二分构造给出上界',
 'MC2-009':'按冻结报销条款独立复算数值',
 'MC2-010':'按冻结分母规则独立复算响应率',
 'MC2-011':'按冻结合并口径独立复算收入',
 'MC2-012':'遍历允许的交集大小核对集合上下界',
};
/** Development routing only, not a promotion of any item to production gold.
 * Different implementations written by the same author are NOT independent experts.
 */
export function buildVerificationReadiness(){
 const pack=buildChallengePack(),holdout=buildEvidenceHoldoutDraft();
 const existing=pack.cases.map(c=>{
  if(c.dimension==='reasoning_math'&&!MATH_CHECKS[c.id])throw new Error(`No verifier inventory for ${c.id}`);
  return {id:c.id,family:c.family,track:c.dimension==='reasoning_math'?'executable_development_pilot':'authored_evidence_rule_development',
   basis:c.dimension==='reasoning_math'?MATH_CHECKS[c.id]:'作者维护的事实/状态和充分引用规则；自动匹配不证明语义金标正确',
   requiredNextGate:c.dimension==='reasoning_math'?'题意与验证器一致性、边界/反例覆盖、保留题及难度校准':'参考范围与引用语义核验；答案一致性不等于幻觉区分度',productionEligible:false,independentExpertVerified:false};
 });
 const regression=holdout.entries.map(e=>({id:e.case.id,family:e.variantGroup,track:'basic_regression_only',basis:e.intendedUse,requiredNextGate:'仅作一致性回归；不能将相关变体当成独立高难度样本',productionEligible:false,independentExpertVerified:false}));
 return {version:'verification-first-routing-v1',scope:'development_lab_only',userRole:'question_clarity_and_task_value',
  rules:['题面认可不等于答案金标','模型一致意见不等于已验证真值','同一作者的多种实现不等于独立专家核验','核验不可靠的题不进入正式总分','不会因审核者不熟悉专业背景而自动降低题目难度'],
  items:[...existing,...regression,{id:'HE-001',family:'open_evidence_weighing',track:'experimental_unverified',basis:'题面认可与作者rubric样例；未完成专业答案核验，HR-001人工评分已排除校准',requiredNextGate:'可靠专业/来源核验及参考范围复核；作者样例测试不能替代Judge校准',productionEligible:false,independentExpertVerified:false},
   {id:'EE-001',family:'executable_evidence_reasoning',track:'executable_evidence_experimental',basis:'题内完整模拟、执行组合穷举、Python与TypeScript交叉核对及符号推导；不是开放领域因果真值',requiredNextGate:'题面清晰度审核、模型难度试测；不直接并入幻觉抵抗或数学正式维度',productionEligible:false,independentExpertVerified:false}],
  modelCalls:0,judgeCalls:0,productionWrites:false};
}

export interface HumanCalibrationProgress {status:string;excludedCalibrationItems?:string[];requestFurtherProfessionalRatings?:boolean}
/** Consumers must consult current disposition, not just a historical score file. */
export function humanReviewCalibrationEligibility(progress:HumanCalibrationProgress,itemId:string){
 if(progress.excludedCalibrationItems?.includes(itemId))return {eligible:false,reason:'reviewer_suitability_exclusion'};
 if(progress.status.startsWith('paused_')||progress.requestFurtherProfessionalRatings===false)return {eligible:false,reason:'review_paused'};
 // Collecting a score alone never establishes appropriate domain verification.
 return {eligible:false,reason:'independent_suitability_and_reference_verification_required'};
}
