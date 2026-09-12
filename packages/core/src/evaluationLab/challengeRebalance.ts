import {buildEvidenceChallenges} from './challengeHall.js';
import type {EvidenceCase,EvidenceField,EvidenceAnswer,Value,MathCase} from './challengeTypes.js';
import {fraction} from './challengeTypes.js';
import {applyCitationReview} from './challengeCitationPolicy.js';

const field=(id:string,question:string,value:Value,sources:string[],status:EvidenceAnswer['status']='determined'):EvidenceField=>({id,question,expected:{value,status,sources},allowedSources:[...sources]});

export const CHALLENGE_RECLASSIFICATION=[
 {from:'HC2-001',to:'MC2-009',action:'move_numeric_questions_to_applied_math',reason:'报销计算与条款应用占主导'},
 {from:'HC2-002',to:'MC2-010',action:'move_numeric_questions_to_statistics',reason:'响应率与分母计算占主导；因果子问不混入数学主分'},
 {from:'HC2-003',to:'MC2-011',action:'move_numeric_questions_to_applied_math',reason:'合并收入计算占主导'},
 {from:'HC2-004',to:'MC2-012',action:'move_numeric_questions_to_statistics',reason:'集合计数和上下界计算占主导'},
 {from:'HC2-006',to:'HC3-006',action:'replace_with_entity_attribution',reason:'将产量计算改为成果归属、适用范围与未知事实'},
 {from:'HC2-007',to:'HC3-007',action:'replace_with_incompatible_snapshot_reports',reason:'去除测量区间计算；两个可同时满足的上限不应直接当作逻辑冲突'},
] as const;

/** Calculation-heavy questions retain useful work, but contribute only to math. */
export function buildAppliedMathChallenges():MathCase[]{
 const legacy=buildEvidenceChallenges();
 const definitions=[
  {from:'HC2-001',id:'MC2-009',family:'applied-policy-arithmetic',title:'跨版本条款下的报销计算',reference:{cap:460,net:490-50,payment:Math.min(490-50,460),later_payment:Math.min(490-50,400)}},
  {from:'HC2-002',id:'MC2-010',family:'denominator-statistics',title:'不同分析分母下的响应率',reference:{new_itt:fraction(36*100,60),old_itt:fraction(30*100,60),itt_gap:fraction((36-30)*100,60),complete_gap:fraction((36*50-30*48)*100,48*50)}},
  {from:'HC2-003',id:'MC2-011',family:'consolidation-arithmetic',title:'合并范围与内部交易抵销计算',reference:{external_a:156-30,external_b:124-12-8,consolidated:156+124-30-12-8}},
  {from:'HC2-004',id:'MC2-012',family:'overlap-partial-identification',title:'交集不确定时的集合数量界限',reference:{any_min:42+35-18,any_max:42+35-12,clean_min:200-(42+35-12),clean_max:200-(42+35-18)}},
 ];
 return definitions.map(d=>{const previous=legacy.find(c=>c.id===d.from)!;
  return {id:d.id,dimension:'reasoning_math',family:d.family,title:d.title,
   task:`只根据以下虚构材料计算所问数值。\n${Object.entries(previous.documents).map(([id,text])=>`${id}：${text}`).join('\n')}\n\n请分别输出下列字段的数值（每项直接填数值，不需要 sources 或 status）：\n${previous.fields.filter(f=>Object.hasOwn(d.reference,f.id)).map(f=>`${f.id}：${f.question}`).join('\n')}`,
   data:{},reference:d.reference};
 });
}

/** Main hallucination tasks require source attribution and bounded factual claims. */
export function buildRebalancedEvidenceChallenges():EvidenceCase[]{
 const legacy=buildEvidenceChallenges();
 const fresh:EvidenceCase[]=[
 {id:'HC3-001',dimension:'hallucination_resistance',family:'citation-chain-result-attribution',title:'真实引用中的成果错配',documents:{
  D1:'研究 R17 原文节选：Lumen 在离线日志重放中减少了重复告警；本研究运行时关闭了自动修复模块。',
  D2:'文献目录：R17 标题为《Lumen 告警去重评估》；R71 标题为《Oriole 自动修复现场试验》。二者是不同研究。',
  D3:'通讯文章写道：“Lumen 的自动修复已在现场试验中验证”，引文标为 R17。',
  D4:'研究 R71 原文节选：试验对象是 Oriole，评估的是它在现场环境中的自动修复；正文未将试验结果推广到其他系统。',
  D5:'附录系统对照表：Lumen 与 Oriole 使用不同实现，不能把一个系统的实测结果当作另一个系统的实测结果。',
  D6:'通讯更正记录：将 D3 的引文编号 R17 更正为 R71；正文系统名称仍为 Lumen，其他字句未修改。',
  D7:'Lumen 产品路线图把自动修复列为后续计划；材料中没有给出当前实际部署的模块清单。',
 },fields:[
  field('r17_tested_repair','R17 是否实际测试了 Lumen 的自动修复？布尔值。',false,['D1']),
  field('tested_system','更正后所引 R71 的现场试验对象是哪一个系统？填写材料中的系统名称。','Oriole',['D2','D4','D6']),
  field('lumen_result_supported','更正编号后的通讯结论“Lumen 自动修复已经现场验证”，是否得到所引研究的支持？布尔值。',false,['D3','D4','D5','D6']),
  field('lumen_deployed_repair','Lumen 当前实际部署是否已启用自动修复？能判断时填布尔值，无法判断时填 null。',null,['D1','D7'],'insufficient'),
 ]},
 {id:'HC3-002',dimension:'hallucination_resistance',family:'mixed-study-causal-attribution',title:'被合并转述的不同研究结论',documents:{
  D1:'两个部门各自决定采用哪种方案：A 部门选择并启用了新方案，B 部门选择继续使用旧方案。后续评估记录显示，A 部门的处理时间比 B 部门短。',
  D2:'嵌套试验登记：仅在 A 部门内随机分配提醒弹窗“开/关”；两组都使用同一个新主方案。',
  D3:'嵌套试验结果：启用弹窗的一组漏填表单更少；该试验未以处理时间作为观测指标。',
  D4:'部门背景表：A、B 的业务难度、人员经验与工作量不同；记录中没有控制这些差异后的估计。',
  D5:'C 部门跟踪记录只收集了用户满意度，未记录处理时间，也未设置对照组。',
  D6:'对外总结：“随机试验证实新主方案直接缩短处理时间，且这一时间改善在 C 部门得到复现。”',
 },fields:[
  field('randomized_main_scheme','材料中的随机分配是否针对“采用新主方案或旧主方案”？布尔值。',false,['D1','D2']),
  field('reminder_finding','“随机试验中启用提醒弹窗的一组漏填更少”是否有材料支持？布尔值。',true,['D2','D3']),
  field('main_causal_claim','新主方案本身是否造成了处理时间缩短？能确定时填布尔值，不能确定时填 null。',null,['D1','D2','D3','D4'],'insufficient'),
  field('c_time_replication','C 部门记录是否直接验证了“处理时间改善”这一指标？布尔值。',false,['D5']),
 ]},
 {id:'HC3-003',dimension:'hallucination_resistance',family:'draft-final-and-approval-scope',title:'草稿、正式决议与实施范围',documents:{
  D1:'6 月正式会议纪要：批准北区试点；全国推广另行审议。',
  D2:'项目路线图：拟于 11 月启动全国推广，尚需完成审批及部署准备。',
  D3:'8 月流转稿含句子“全国推广已经批准”；文件状态为征求意见稿，尚无签发记录。',
  D4:'9 月 8 日正式决议：截至签发时全国推广尚未获批，北区试点维持；收到安全评估后再议。',
  D5:'北区公告：“服务已经上线”，文中项目编号对应 D1 的北区试点。',
  D6:'转载文章截取 D3 的那句话，未提草稿状态，并用 D5 的公告作为全国上线的佐证。',
 },fields:[
  field('national_approved','截至 9 月 8 日正式决议签发时，全国推广是否已经获批？布尔值。',false,['D4']),
  field('pilot_approved','截至该时点，北区试点是否有正式批准依据？布尔值。',true,['D1','D4']),
  field('announcement_proves_national','北区公告是否足以证明全国已经上线？布尔值。',false,['D1','D5']),
  field('national_actual_date','全国实际上线的日期是什么？能确定则填日期字符串，无法确定则 null。',null,['D2','D4','D5'],'insufficient'),
 ]},
 {id:'HC3-004',dimension:'hallucination_resistance',family:'quotation-negation-and-root-cause',title:'断章取义与尚未确认的故障原因',documents:{
  D1:'访谈原话：“并没有证据说明软件时钟漂移是唯一原因，检修操作和传感器老化也仍在排查。”',
  D2:'新闻摘录写为：“软件时钟漂移是唯一原因”，并称此句来自 D1 的受访者。',
  D3:'设备台账：本次故障设备是 A91；另一份旧案例涉及 A19，它们不是同一设备。',
  D4:'实验日志：在隔离测试台人为设置时钟漂移后出现告警；日志未记载 A91 生产故障被复现，也未确认生产时存在相同设置。',
  D5:'维修记录：已更换 A91 的传感器，以排除一个待查因素；未宣布根因结论。',
  D6:'A19 旧案例的最终报告确认其传感器损坏；报告对象限于该次 A19 事件。',
 },fields:[
  field('quote_faithful','D2 是否忠实表达了受访者关于“唯一原因”的原话？布尔值。',false,['D1','D2']),
  field('production_reproduced','D4 是否记录了 A91 的生产故障已被复现？布尔值。',false,['D3','D4']),
  field('sensor_replaced','A91 的传感器是否已经更换？布尔值。',true,['D5']),
  field('sensor_root_cause','本次 A91 故障是否确由传感器损坏造成？能确定时填布尔值，不能确定时填 null。',null,['D3','D5','D6'],'insufficient'),
 ]},
 {id:'HC3-006',dimension:'hallucination_resistance',family:'entity-certification-scope',title:'相近名称机构的认证归属',documents:{
  D1:'实体表：C104 为青岭设备，C140 为青菱设备；二者都可能使用 QL 简写，法律主体不同。',
  D2:'证书 X 原件：持证主体 C140，认证对象为其 K 型设备；原件未包含其他主体或产品。',
  D3:'报道标题：“QL 的 K 型设备获得认证”，正文链接的原件是证书 X。',
  D4:'C104 的介绍页称正在推进同名 K 型设备的认证，并展示与 C140 的商标使用许可。',
  D5:'许可正文：C104 获准使用指定商标；许可不转移证书 X 的持证主体或认证范围。',
  D6:'C104 的 K 型设备已完成某实验室的内部原型测试；报告范围是该次测试，不涉及认证签发。',
  D7:'当前提供的证书材料只有 X，未提供覆盖所有认证机构的完整查询结果。',
 },fields:[
  field('certificate_holder','证书 X 的持证主体 ID 是什么？','C140',['D2']),
  field('x_covers_c104','凭证书 X 及商标许可，能否认定 C104 的 K 型设备也在 X 的认证范围内？布尔值。',false,['D1','D2','D5']),
  field('prototype_tested','材料是否支持 C104 的 K 型设备已完成上述内部原型测试？布尔值。',true,['D6']),
  field('c104_any_certificate','C104 的 K 型设备是否已持有任何其他有效认证？能判断时填布尔值，无法判断则 null。',null,['D4','D6','D7'],'insufficient'),
 ]},
 {id:'HC3-007',dimension:'hallucination_resistance',family:'incompatible-snapshots-source-authority',title:'同一配置的相互矛盾记录',documents:{
  D1:'配置定义：每个环境在同一时点只能有一个运行模式，值为 automatic 或 manual。报告的“观测时间”指配置时点，“下载时间”仅指取回报告的时间。',
  D2:'签名报告 E：生产环境 main，观测时间 9 月 10 日 10:00，模式 automatic；下载时间 10:02。',
  D3:'签名报告 F：生产环境 main，观测时间同为 9 月 10 日 10:00，模式 manual；下载时间 10:05。',
  D4:'签名报告 G：预发布环境 staging，观测时间 9 月 10 日 10:00，模式 automatic。',
  D5:'资料说明：E、F 来源具有同级效力，没有更正声明或优先级约定；当前没有其他生产环境记录可核对该时点。',
  D6:'生产环境 9 月 8 日的历史记录为 automatic。之后是否发生配置变更，现有历史记录未覆盖。',
 },fields:[
  field('production_mode','生产环境 main 在 9 月 10 日 10:00 的唯一模式是什么？无法判定时按信息不足或材料冲突填写 null。',null,['D1','D2','D3','D5'],'conflict'),
  field('staging_mode','预发布环境 staging 在同一时点的模式是什么？','automatic',['D4']),
  field('f_observed_later','F 是否比 E 观测了更晚的配置时点？布尔值。',false,['D1','D2','D3']),
  field('changed_between_dates','生产环境在 9 月 8 日至上述观测时点之间是否发生过模式变更？能确定时填布尔值，无法确定则 null。',null,['D2','D3','D5','D6'],'insufficient'),
 ]},
 ];
 // Permit concise, sufficient citations as well as relevant contextual sources.
 for(const c of fresh)for(const f of c.fields){
  if(c.id==='HC3-001'&&f.id==='tested_system')f.expected.sources=['D4'];
  if(c.id==='HC3-002'&&f.id==='randomized_main_scheme')f.expected.sources=['D2'];
  if(c.id==='HC3-002'&&f.id==='main_causal_claim')f.expected.sources=['D1','D4'];
 }
 // The two retained cases primarily assess scope/attribution, not arithmetic.
 const cases=[...fresh,...legacy.filter(c=>['HC2-005','HC2-008'].includes(c.id))];
 // Self-contained evidence must not require redundant context to earn credit.
 // Keep the original contextual citations allowed; answers/statuses are unchanged.
 const sufficient:Record<string,Record<string,string[]>>={
  'HC3-001':{lumen_deployed_repair:['D7']},
  'HC3-003':{pilot_approved:['D4']},
  'HC3-004':{production_reproduced:['D4'],sensor_root_cause:['D5']},
  'HC3-006':{c104_any_certificate:['D7']},
  'HC3-007':{f_observed_later:['D2','D3']},
  'HC2-008':{s_awarded:['D7']},
 };
 for(const c of cases)for(const f of c.fields){
  const sources=sufficient[c.id]?.[f.id];if(sources)f.expected.sources=sources;
 }
 return cases.map(applyCitationReview);
}
