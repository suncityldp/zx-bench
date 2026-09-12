import {snapshotHash} from '../contracts/pack.js';
import {AUDIT_INSTRUCTIONS,type AuditFixture} from './atomicJudge.js';
import {atomicJudgeFixtures} from './atomicJudgeFixtures.js';
import {verifyRegularPartition} from './regularPartition.js';
import {verifyLinearOptimization} from './linearOptimizationCertificate.js';
import {shuffle} from './methodsV2/types.js';
export const VERIFIED_JUDGE_VERSION='verified-atomic-judge-2026-09-12-v2';
export const VERIFIED_JUDGE_INSTRUCTIONS=AUDIT_INSTRUCTIONS+`
证明审查必须逐步检查，而不是仅认出正确结论。尤其要区分首位与末位、覆盖与互斥、必要与充分、可行与最优与唯一。检查乘除数的符号及非零条件。对分类或递推论证，尝试小对象检验漏项、重叠或生成非法对象；对不可行与无界证明，核对证书的每一项条件。即使最终数字、递推式或问题分类正确，只要候选实际给出的关键证明步骤不成立，仍为fail。被明确否定的错误引文不算候选认领的步骤。`;
export interface VerifiedFixture extends AuditFixture {oracleEvidence?:unknown}
export function verifiedJudgeFixtures():VerifiedFixture[]{
  const all:VerifiedFixture[]=[];
  const add=(family:string,split:'development'|'holdout',dimension:'hallucination_resistance'|'reasoning_math',sources:Record<string,string>,focus:string,candidate:string,expected:'pass'|'fail',basis:string,oracleEvidence?:unknown)=>{
    all.push({family,split,expected,basis,oracleEvidence,item:{id:'VJ-'+snapshotHash({family,split,candidate}).slice(0,12),dimension,sources,focus,candidate}});
  };
  const old=atomicJudgeFixtures();
  for(const f of old.filter(f=>['missing_record_and_rejected_quote','source_lineage','uniqueness_certificate','noninvertible_modular_cancellation'].includes(f.family))){
    add(f.family,'development',f.item.dimension,f.item.sources,f.item.focus,f.item.candidate,f.expected,f.basis);
  }
  const language={alphabet:['0','1'],forbidden:['11'],minLength:2};
  for(const [side,pieces] of [['suffix',['0','10']],['suffix',['0','01']],['prefix',['0','10']],['prefix',['0','01']]] as const){
    const cert={side,pieces:[...pieces]},verified=verifyRegularPartition(language,cert);
    const term=side==='suffix'?'末尾':'开头';
    const candidate=`将不含11的长度至少2的串按${term}为${pieces[0]}或${pieces[1]}分成两类；各自去掉这些${term}片段后可对应任意更短的合法串。两类互斥、覆盖全部且不产生非法串，故f(n)=f(n-1)+f(n-2)，f(5)=13。`;
    add('orientation_and_partition','development','reasoning_math',{D1:'L为不含11的全部二进制串，含空串。只讨论长度n≥2的串。'},
      '核查候选给出的分类证明是否真的成立，不仅核查最后的递推式和数值。',candidate,verified.pass?'pass':'fail','由可达积自动机完整检查分类的覆盖、互斥和合法性。',verified);
  }
  const versionSources={D1:'数据发布规则：终版表明确替代同编号草稿；草稿不再用于本次结论。',D2:'编号T的草稿写“通过”；编号T的终版写“不通过”，附注明确替代草稿。'};
  add('explicit_supersession','holdout','hallucination_resistance',versionSources,'核查是否遵循明确版本优先规则，不能一律把新旧记录当未决冲突。',
    '按D1的规则，D2终版替代草稿，本次结论是不通过；草稿的旧结论不能制造仍未解决的冲突。','pass','明示撤销/替代，不是凭更新时间猜优先级。');
  add('explicit_supersession','holdout','hallucination_resistance',versionSources,'核查是否遵循明确版本优先规则，不能一律把新旧记录当未决冲突。',
    '草稿和终版结论不同，因此本次结论必然仍处于不可消解的冲突，不能确定是否通过。','fail','忽略材料明确替代规则。');
  const futureSources={D1:'事故当时没有记录内部温度或传感器原始波形；两种历史机制均可能。',D2:'计划下周用另一台设备做受控加热实验，观察传感器响应。该实验不提供事故当时的原始状态记录。'};
  add('future_intervention_vs_history','holdout','hallucination_resistance',futureSources,'核查是否将未来受控实验的条件结果无依据外推为历史唯一事实。',
    '若下周实验出现同样响应，会支持该机制在实验条件下可行，但不能单凭它确定事故当时的唯一机制。','pass','条件推演不认领历史事实，明确保留外推边界。');
  add('future_intervention_vs_history','holdout','hallucination_resistance',futureSources,'核查是否将未来受控实验的条件结果无依据外推为历史唯一事实。',
    '只要下周受控实验复现相同响应，就足以证明事故当时必然由该机制独自造成。','fail','未来实验条件不是缺失的历史状态记录。');
  const optimal={a:[[1,1]],b:[3],c:[1,1]};
  for(const valid of [true,false]){
    const certificate={status:'optimal',x:[1,2],y:valid?[1]:[-1],value:3},verified=verifyLinearOptimization(optimal,certificate);
    const candidate=valid?'可行点(1,2)的目标值为3；取非负对偶乘子1，得到上界x+y≤3，所以该点最优。':
      '可行点(1,2)的目标值为3；把x+y≤3乘以-1且保留≤方向，得-x-y≤-3，这给出了目标上界3，故该点最优。';
    add('dual_sign_proof','holdout','reasoning_math',{D1:'最大化x+y，约束x+y≤3，x≥0，y≥0。'},'核查候选实际使用的上界证明步骤；结论恰好正确不能掩盖错误证明。',candidate,verified.pass?'pass':'fail','对偶非负乘子与精确原/对偶目标值核验。',verified);
  }
  const infeasible={a:[[1,0],[0,1],[-1,-1]],b:[0,0,-1],c:[1,1]};
  for(const valid of [true,false]){
    const certificate={status:'infeasible',y:valid?[1,1,1]:[-1,-1,-1]},verified=verifyLinearOptimization(infeasible,certificate);
    add('farkas_sign_proof','holdout','reasoning_math',{D1:'约束x≤0、y≤0、-x-y≤-1，另有x≥0、y≥0。'},'核查所给不可行证明的方向和乘子条件。',
      valid?'三条不等式分别乘以1后相加，得到0≤-1的矛盾，因此原约束不可行。':
      '三条不等式分别乘以-1并保留原来的≤方向，相加得到0≤1；这构成矛盾，证明不可行。',verified.pass?'pass':'fail','Farkas证书要求非负乘子且加权右端严格为负。',verified);
  }
  const unbounded={a:[[1,-1]],b:[0],c:[1,0]};
  for(const valid of [true,false]){
    const certificate={status:'unbounded',x:[0,0],ray:valid?[1,1]:[1,0]},verified=verifyLinearOptimization(unbounded,certificate);
    add('recession_ray_proof','holdout','reasoning_math',{D1:'最大化x，约束x-y≤0，x≥0，y≥0。'},'核查候选给出的整条射线是否保持可行，不能仅核查起点和目标增长。',
      valid?'从(0,0)沿(1,1)前进，点(t,t)在每个t≥0时可行，目标x=t无上界，所以无界。':
      '从(0,0)沿(1,0)前进，点(t,0)在每个t≥0时都可行，目标不断增大，所以由这条射线证明无界。',verified.pass?'pass':'fail','精确检查A·ray≤0；(1,0)违反约束，虽然问题本身确实无界。',verified);
  }
  if(0.25<=-0.5)throw new Error('Counterexample arithmetic failed');
  add('interval_inequality_proof','holdout','reasoning_math',{D1:'x是任意满足-1≤x≤1的实数。'},'核查推出x²≤1的证明中每一步对整个定义域是否成立。',
    '由-1≤x≤1有|x|≤1，两边均非负，平方得到x²≤1。','pass','绝对值界与非负平方单调性。',{certificate:'abs(x)<=1 implies square bound'});
  add('interval_inequality_proof','holdout','reasoning_math',{D1:'x是任意满足-1≤x≤1的实数。'},'核查推出x²≤1的证明中每一步对整个定义域是否成立。',
    '由x≤1，两边乘以x仍保持≤，所以x²≤x≤1，从而x²≤1。','fail','x=-1/2反驳中间步骤x²≤x；最终结论正确不能补救错误步骤。',{counterexample:{x:'-1/2',xSquared:'1/4',claimedUpper:'-1/2'}});
  if(all.length!==24)throw new Error('Expected 12 development and 12 holdout items');
  return shuffle(all,20260913);
}
