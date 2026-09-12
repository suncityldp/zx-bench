/** Source-backed author audit, NOT independent expert verification or a gold set.
 * External sources establish methods, never facts about this fictional incident.
 */
export const HE001_REFERENCE_AUDIT = {
  version: 'HE-001-reference-audit-v0.3',
  checkedOn: '2026-09-11',
  methodReview: 'primary_sources_consulted_by_same_author',
  semanticReview: 'author_rechecked_not_independent',
  independentExpertVerified: false,
  judgeCalibrated: false,
  productionEligible: false,
  sources: [
    {id:'FEVER',url:'https://aclanthology.org/N18-1074/',section:'Abstract',
      principle:'区分支持、反驳、信息不足；前两种应给出证据。',
      limitation:'文本事实核验框架，不替本题每个中文主张提供独立标签。'},
    {id:'NIST-CONFOUNDING',url:'https://www.itl.nist.gov/div898/handbook/pri/section3/pri3343.htm',section:'5.3.3.4.3',
      principle:'混杂使部分效应无法单独估计。',
      limitation:'该页讨论部分因子设计；本题不是该设计，只借鉴可分离性原理，不套用其数值公式。'},
    {id:'NIST-INTERACTION',url:'https://www.itl.nist.gov/div898/handbook/pri/section2/pri212.htm',section:'5.2.1.2',
      principle:'固定其他因素的一次局部比较不能自动识别所有交互或所有条件下的效应。',
      limitation:'用于约束后续验证的外推，不表明本设备存在任何特定交互。'},
    {id:'CITEEVAL',url:'https://aclanthology.org/2025.acl-long.1574/',section:'Abstract',
      principle:'引用评估应结合完整上下文，不只用被引文本的二元支持关系。',
      limitation:'借鉴评估视角，不声称完全复现CiteEval指标或验证了本地Judge。'},
  ],
  ledger: [
    {id:'R01',basis:'direct_record',source:'D3',quote:'独立校准温度计始终记录82±0.2℃；S17在四轮测试中均出现超过90℃的读数，S29四轮均未出现。',
      allowed:'限定该台架条件下S17报高、S29未超过90℃。',excluded:'S29所有读数均精确到82℃；S17在所有环境均失效。'},
    {id:'R02',basis:'direct_record',source:'D3',quote:'两者读数均在校准允差内',
      allowed:'25℃检查中读数在允差内。',excluded:'全面正常或整个量程都正常。'},
    {id:'R03',basis:'absence_and_inference',source:'D3',quote:'随后在82℃恒温槽中将探头连接端置于高湿条件',
      allowed:'不能从所给记录隔离湿度单因素作用；25℃连接端湿度未交代。',excluded:'25℃已知干燥；温度与湿度已经确认同时改变。'},
    {id:'R04',basis:'direct_record',source:'D4',quote:'S17配F3、S17配F4均在每轮触发温度停机；S29配F3、S29配F4均未触发。',
      allowed:'该组测试里F4未阻止S17组合停机。',excluded:'F4已阻止这组停机（refuted）；F4在所有条件都无作用（unsupported）。'},
    {id:'R05',basis:'direct_record',source:'D1',quote:'测点在设备外壳，记录于停机后4分钟。S17测量的是设备内部冷却液。',
      allowed:'测量对象、时间不同，不能拿后测外壳值直接替换同期内部值。',excluded:'由81℃直接证明现场内部没过热；虚构冷却速率或温差。'},
    {id:'R06',basis:'absence_and_inference',source:'D5',quote:'没有保存探头连接端的湿度记录，也没有独立的内部冷却液温度记录',
      allowed:'给定记录未识别历史真实温度与连接端湿度，不能排除真过热或误报。',excluded:'肯定真实过热、肯定未过热或给出两者概率。'},
    {id:'R07',basis:'direct_record',source:'D2',quote:'三项完成后才复机。随后连续五个班次没有再次触发温度停机',
      allowed:'同时维修后的五班次无温度停机是观察。',excluded:'永久修复；只有换探头有作用。'},
    {id:'R08',basis:'direct_record',source:'D2',quote:'这些班次均采用此前高负载任务约六成的负载',
      allowed:'恢复观察限于较低负载；不能当同负载单措施对照。',excluded:'正式证明软件或风道贡献为零。'},
    {id:'R09',basis:'direct_record',source:'D6',quote:'所引“供应商服务通报”注明技术依据为该实验室简报，未附新增测量记录。',
      allowed:'所给两文稿共享依据，未提供独立新增测量供相互验证。',excluded:'供应商从来没做过测量；凭空肯定另做了独立测量（均unsupported）。'},
    {id:'R10',basis:'inference_across_records',source:'D4',quote:'所有台架记录对应9月8日的实验室测试',
      allowed:'事后复现支持候选机制，不自动确定9月6日现场机制或唯一根因。',excluded:'把新实验当历史现场测量；把未证明唯一根因当排除传感器故障。'},
    {id:'R11',basis:'task_requirement',source:'task',quote:'最后提出一项优先补充的验证，并说明其不同结果将如何影响你对“9月6日这次停机原因”的判断。',
      allowed:'多种方案可接受，须具体、说明结果含义、交代历史外推限度。',excluded:'强制复述作者实验；只说需要更多数据；未来设想被当成已发生测量。'},
    {id:'R12',basis:'task_requirement',source:'task',quote:'保留材料能够支持的实质发现',
      allowed:'不应靠全部拒答拿到能力满分；正确限定观察也无须堆砌免责声明。',excluded:'只因缺少指定措辞判错；不回答任何发现却称完整完成。'},
  ],
  correctedFromV02: [
    '另做独立测量的断言由refuted改为unsupported；新增D4明确矛盾锚点。',
    '删除25℃干燥或温湿度确认同时改变的无依据前提。',
    '将S29未异常收紧为未超过90℃；将25℃正常收紧为允差内。',
    '参考答案的供应商未增加测量改为通报未附新增测量记录。',
    '边界按结论范围判断，增加没有额外湿度免责声明的正确对照。',
    '后续真实超温只说明新测试状态，不自动使历史解释转向散热。',
  ],
  remainingGates: [
    '各主张标签及抽取粒度仍缺独立审查；来源核验不是专家金标。',
    '可在明确模型与调用预算后做实验性Judge-only试评，结果只能称对作者锚点的一致性/分歧。',
    '正式校准准确率和模型成绩需独立参考核验及未见答案验证；当前禁止生产准入。',
  ],
} as const;

/** Checks provenance links/quotes only; intentionally makes no semantic claim. */
export function verifyHE001ReferenceLedger(question:string) {
  for (const item of HE001_REFERENCE_AUDIT.ledger) {
    if (!question.includes(item.quote)) throw new Error(`Reference quote absent: ${item.id}`);
  }
  return {checkedQuotes:HE001_REFERENCE_AUDIT.ledger.length,allQuotesPresent:true,
    semanticVerification:false,independentExpertVerified:false,productionEligible:false};
}
