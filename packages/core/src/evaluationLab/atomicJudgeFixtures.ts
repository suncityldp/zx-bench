import {snapshotHash} from '../contracts/pack.js';
import {solveLinear,countWords,solveAllocation} from './methodsV2/verify.js';
import {shuffle} from './methodsV2/types.js';
import type {AuditFixture} from './atomicJudge.js';

/** No Judge-generated gold. Explicit minimal pairs, reserved families, no model labels. */
export function atomicJudgeFixtures():AuditFixture[] {
  const rows:AuditFixture[]=[];
  const pair=(family:string,split:AuditFixture['split'],dimension:AuditFixture['item']['dimension'],sources:Record<string,string>,focus:string,good:string,bad:string,basis:string)=>{
    for(const [expected,candidate] of [['pass',good],['fail',bad]] as const)rows.push({family,split,expected,basis,
      item:{id:'AJ-'+snapshotHash({family,split,candidate}).slice(0,12),dimension,sources,focus,candidate}});
  };
  pair('missing_record_and_rejected_quote','development','hallucination_resistance',
    {D1:'故障当时没有保存设备内部温度记录。外壳温度是在停机20分钟后测得，不能替代故障时内部温度。',D2:'现场人员提出了传感器偏移和真实过热两种解释。调查尚未区分。'},
    '仅核查候选是否把缺少记录变成现实事件确定发生或未发生，及是否误把被批驳引文当作其主张。',
    '有人写“设备当时并未真实过热”，这说法应撤回。D1缺少同期内部记录，D2保留两种解释；不能排除真实过热，也不能确认它发生。',
    '虽然内部记录缺失，但外壳后来温度正常已经证明设备故障时并未真实过热；真实过热可以排除。',
    '封闭材料明确保留两种机制；正向样本拒绝引文而非认领引文。');
  pair('observational_causality','development','hallucination_resistance',
    {D1:'部门A、B的员工自行选择新旧培训。A的新方案参加者本来资历更高，B的新方案参加者每周自愿加练。',D2:'新方案参加者平均成绩高7分。没有随机分配，也未记录或调整全部混杂因素。'},
    '核查是否将观察关联表述成已识别的培训因果效应。',
    '新方案组高7分是观察差异，不能据此确定培训导致提高7分；自选和加练等因素尚未分离。',
    '尽管参加者自行选组，两部门都观察到优势已经排除了选择偏差，证明培训净提高7分。',
    '两个观察样本不能排除共同选择偏差，未识别因果。');
  pair('source_lineage','development','hallucination_resistance',
    {D1:'原始实验登记号E17，样本40。公告甲引用E17。',D2:'公告乙翻译公告甲，并明确仍使用E17的同一批40个样本，没有新实验。'},
    '仅核查是否错误声称有两组独立实验。',
    '甲乙是两份传播材料，但都追溯到E17，不能作为两组独立实验相互验证。',
    '两份不同语言公告相互印证，已经形成两组独立实验的重复验证。',
    '数据血缘显式同源，语言或出版物数不是独立实验数。');
  if(solveLinear({a:[[1,1],[2,2]],b:[3,6]}).kind!=='multiple')throw new Error('Linear fixture oracle failed');
  pair('uniqueness_certificate','development','reasoning_math',{D1:'在实数域求解：x+y=3，2x+2y=6。'},
    '核查解集及唯一性论证，不仅核查某个解能否代入。',
    '第二式是第一式的两倍。全部解为(x,y)=(t,3-t)，t为任意实数；(1,2)只是其中一组。',
    '代入可知(1,2)满足两个方程，因此它是方程组的唯一解。',
    '精确RREF为多解，零空间方向(1,-1)。');
  const allocation={items:[{cost:6,gain:12,risk:0},{cost:5,gain:9,risk:0},{cost:5,gain:9,risk:0}],budget:10,riskLimit:0,minCount:0,requires:[] as [number,number][],excludes:[] as [number,number][]};
  if(solveAllocation(allocation).gain!==18)throw new Error('Optimization fixture oracle failed');
  pair('greedy_optimality','development','reasoning_math',{D1:'0/1背包，容量10。项目A重6值12，B重5值9，C重5值9。每项最多选一次，不能拆分。'},
    '核查全局最优结论，不能将局部贪心的可行解当作最优证明。',
    'A的价值密度最大，但选A只能得12；B和C合重10、总值18，所以密度贪心在这里不是最优。',
    'A的价值密度最大，先选A后剩余容量无法放其他项目，因此12是这个0/1背包的全局最优值。',
    '独立枚举8个子集及生产精确枚举均给出18。');
  const roots=Array.from({length:12},(_,i)=>i).filter(x=>(6*x-6)%12===0);
  if(roots.join(',')!=='1,3,5,7,9,11')throw new Error('Modular fixture oracle failed');
  pair('noninvertible_modular_cancellation','development','reasoning_math',{D1:'求整数同余方程6x≡6 (mod 12)的全部解。'},
    '核查约分后模数及解集是否完整。',
    '两边与模数同时除以6得到x≡1 (mod 2)，故全部奇数都是解。',
    '两边除以6得到x≡1 (mod 12)，所以模12只有余数1能满足原方程。',
    '直接枚举模12有六个根，不能保留原模数直接约去非可逆因子。');

  pair('time_boundary','holdout','hallucination_resistance',
    {D1:'证书C的有效区间为[2026-05-01 00:00,2026-06-12 00:00)，UTC，左闭右开。',D2:'续期申请于2026-06-12 09:00收件。所给完整档案中只有收件回执，没有续期证书。'},
    '判断2026-06-12 00:00这一时点是否可依据旧证书或收件回执声称认证有效。',
    '该时点等于旧证书的开区间右端，旧证书已不覆盖；收件回执也不是续期证书，不能据此认定当时认证有效。',
    '旧证书写到6月12日，当日还有续期收件记录，因此6月12日00:00必然仍然认证有效。',
    '半开区间端点计算，收件不蕴含审批。');
  pair('entity_scope','holdout','hallucination_resistance',
    {D1:'澄山实验室是澄山集团的子公司，独立法人。证书L8只覆盖澄山实验室的Q类检测。',D2:'所给完整目录未提供澄山集团的Q类认证记录。集团宣传页引用子公司的L8。'},
    '只核查是否将子公司的认证范围移植给母公司，或将目录缺失等同于现实中永远没有认证。',
    'L8只证明实验室的Q类范围，不能推出集团自身已获Q类认证；这也不等于证明集团现实中永远没有认证。',
    '集团拥有实验室，因此L8已经证明集团自身也获得Q类认证。',
    '法人及证书范围明确；集团控制关系不是认证范围继承。');
  pair('equal_authority_conflict','holdout','hallucination_resistance',
    {D1:'同一批次的终签记录R1：许可发布。记录效力与R2相同。',D2:'同一批次终签R2：不予许可发布。没有撤销R1的条款。登记未规定按页面更新时间取舍，R2页面更新较晚。'},
    '核查是否正确保留无优先规则的同权威冲突。',
    'R1与R2冲突且效力相同，材料未给冲突消解规则；仅凭页面更新时间不能确定最终许可状态。',
    'R2页面较晚，所以必然取代R1，许可状态已经可以无歧义确定为不予许可。',
    '无优先关系，页面时间不是撤销或效力证据。');
  if(Math.sqrt(3+6)!==3||Math.sqrt(-2+6)===-2)throw new Error('Root fixture oracle failed');
  pair('extraneous_root','holdout','reasoning_math',{D1:'在实数域解sqrt(x+6)=x，sqrt表示非负平方根。'},
    '核查平方后的候选根是否通过原方程与符号条件。',
    '平方得到候选3和-2，但原式右端须非负；3可代入，-2代入左端2不等于右端-2，所以只取3。',
    '平方得到x²-x-6=0，根为3和-2；平方等价，因此两者都是原方程解。',
    '原式逐根代入与非负约束交叉核验。');
  pair('prior_sensitive_bayes','holdout','reasoning_math',{D1:'先抽取盒子：P(A)=1/3，P(B)=2/3。红球概率P(红|A)=3/4，P(红|B)=1/4。观察到红球。'},
    '核查后验计算是否保留先验权重。',
    'A且红的概率为1/4，B且红为1/6，所以P(A|红)=(1/4)/(1/4+1/6)=3/5。',
    '红球概率之比是3:1，因此看到红球后来自A的概率就是3/4，先验不用再计入。',
    '精确有理式(1/4)/(5/12)=3/5。');
  const binary=Array.from({length:32},(_,i)=>i.toString(2).padStart(5,'0')).filter(s=>!s.includes('11')).length;
  if(binary!==13)throw new Error('Binary fixture oracle failed');
  pair('dependent_counting','holdout','reasoning_math',{D1:'长度5的二进制串，不允许出现相邻的11，求数量。'},
    '核查计数是否正确处理相邻事件的依赖，不接受仅凭对称性的一半估计。',
    '按末位是0或10分解，f(n)=f(n-1)+f(n-2)，f(0)=1、f(1)=2，得到f(5)=13。',
    '全部有32个串，按0和1的对称性有一半不含11，所以数量为16。',
    '完整枚举32个串结果13；递推独立同值。');
  return shuffle(rows,20260912);
}
