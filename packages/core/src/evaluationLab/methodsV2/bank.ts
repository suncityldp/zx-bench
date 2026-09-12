import {snapshotHash} from '../../contracts/pack.js';
import {POLICY,opaque,question,random,shuffle,type Case,type Evidence,type Options,type Pack,type Stance,type AllocationData,type CountingData,type LinearData} from './types.js';

const FAMILIES=[['scope_authority','development'],['citation_origin','development'],['temporal_validity','holdout'],
  ['constrained_allocation','development'],['modular_counting','development'],['linear_certificate','holdout']] as const;
const EVIDENCE_INSTRUCTION='仅使用本题提供的封闭材料，判断指定命题的证据状态。supported=有有效支持且无有效反驳；refuted=有有效反驳且无有效支持；conflict=二者均有；insufficient=二者均无。材料不足不等于现实中为假。只返回 JSON {"status":"上述四值之一","sources":["文档编号"]}。sources 必须包含支撑判断的完整最小证据链，不要添加无关或重复文档。题面定义的判断规则无需另行引用。';

function evidence(family:string,split:Options['split'],seed:number,instance:number,status:Stance):Evidence {
  const key={family,seed,instance,status},id=opaque(key),r=random(seed+instance*7919),tag=100+Math.floor(r()*800);
  const entity=`澄${tag}`,target=`X-${tag}`,alias=`A-${tag}`,docNames=shuffle(['D14','D27','D39','D48','D53','D66','D72','D85','D91','D06','D32','D57'],seed+instance*31);
  const [identity,index,policy,positive,negative,neutral,...noise]=docNames;
  let rules:string,claim:string,docs:Record<string,string>={};
  // The registry names the complete admissible record set. Unlisted snippets cannot establish a conclusion.
  const active=status==='conflict'?[positive,negative]:status==='supported'?[positive]:status==='refuted'?[negative]:[neutral];
  if(family==='scope_authority') {
    rules='名称先按实体名册归一。备案目录指定本次审查唯一使用的分支与记录集；同名异实体、其他分支和目录外材料均不能替代它。记录只有同时满足签署人授权范围、已终签、目标分支一致才有效；终签许可支持命题，终签不予许可反驳命题。无结果的转办条目不表达许可结论。';
    claim=`“${entity}的目标分支在本次备案中获准对外发布”。`;
    docs[identity]=`实体名册：${entity}对应${target}；历史工作名${alias}对应${target}；${entity}实验室对应L-${tag}。`;
    docs[index]=`本次备案目录：实体${target}，目标分支R-${tag+2}；封闭审查记录集=[${active.join(',')}]; 该集合完整，目录外不属于本次备案。`;
    docs[policy]=`签署权限表：U-${tag}仅有${target}/R-${tag+2}的终签权限；V-${tag}只有L-${tag}的终签权限。转办员无终签权限。`;
    docs[positive]=`记录：实体${alias}；分支R-${tag+2}；签署U-${tag}；流程=终签；决定=许可发布。`;
    docs[negative]=`记录：实体${alias}；分支R-${tag+2}；签署U-${tag}；流程=终签；决定=不予许可发布。`;
    docs[neutral]=`记录：实体${alias}；分支R-${tag+2}；签署U-${tag}；流程=转办；决定栏留待终签填写。`;
    docs[noise[0]]=`内部邮件：${entity}已经可以发布，附件沿用R-${tag+1}签发单。`;
    docs[noise[1]]=`${entity}实验室：分支R-${tag+2}；V-${tag}终签；许可发布。`;
    docs[noise[2]]=`较晚的会议摘录：计划引用${positive}作为已批准的依据；本摘录不属备案目录。`;
  } else if(family==='citation_origin') {
    rules='先匹配试验编号，再从来源登记定位原始报告。只有登记列出的原始方法记录用于判断分组方式；综述、新闻、同名另一试验不构成原始方法证据。公开随机数表决定分组支持随机分配；报名时由参与者自行选组反驳随机分配；仅报告样本人数不确定分组方式。登记集完整，多个有效原始记录不一致时不按发布时间或多数票消除冲突。';
    claim=`“${entity}试验的参与者采用随机分配进入各组”。`;
    docs[identity]=`试验注册映射：${entity}=${target}；项目短名${alias}=${target}；${entity}-扩展试验=E-${tag}。`;
    docs[index]=`来源登记：${target}的原始方法记录完整集合=[${active.join(',')}]；通讯文章和分析摘要只作衍生材料。`;
    docs[policy]=`文档链核验：上列原始方法记录中的试验短名使用注册映射；这些记录为作者方法附件，版本地位相同。正文结论不能补足未写的分组步骤。`;
    docs[positive]=`作者方法附件，试验${alias}：完成招募后，按预先公开的随机数表将参与者分至两组；两组人数接近。`;
    docs[negative]=`作者方法附件，试验${alias}：报名时参与者自行选择进入哪组；随后补招使两组人数接近。`;
    docs[neutral]=`作者方法附件，试验${alias}：纳入${tag}人，分为两组；本附件字段为样本总量和随访时间。`;
    docs[noise[0]]=`新闻转载：一项“随机试验”显示效果明显；脚注指向通讯文章${noise[1]}。`;
    docs[noise[1]]=`通讯文章：根据两组人数接近，将${entity}称为随机试验；方法链接转引${index}。`;
    docs[noise[2]]=`方法附表：E-${tag}用计算机随机分组；标题=${entity}-扩展试验。`;
  } else {
    const day=12+instance%10;
    rules='只判断目标时点和目标适用范围。有效期采用左闭右开区间；认证登记列出同等权威的完整证书集。证书覆盖时点且范围匹配时，状态“有效”支持命题，“已撤销”反驳命题；不覆盖时点的证书、收件回执和其他范围不支持也不反驳。相同权威的矛盾记录必须保留为冲突，不按页面更新日期取舍。';
    claim=`“${entity}在2026-06-${day} 00:00的Q-${tag}范围认证有效”。`;
    docs[identity]=`登记主体：${entity}=${target}；证书使用别名${alias}；同名子公司=${target}-S。`;
    docs[index]=`认证目录：${target}的本次核验完整证书集=[${active.join(',')}]；目录不包含回执。`;
    docs[policy]=`范围对照：Q-${tag}对应证书代码C-${tag}；C-${tag+1}是不同业务范围。目录证书具有相同效力，无覆盖冲突时的优先级条款。`;
    const prefix=`证书主体${alias}；范围C-${tag}；时区UTC；区间[2026-06-01 00:00,2026-07-01 00:00)`;
    docs[positive]=`${prefix}；状态=有效。`;
    docs[negative]=`${prefix}；状态=已撤销。`;
    docs[neutral]=`证书主体${alias}；范围C-${tag}；区间[2026-05-01 00:00,2026-06-${day} 00:00)，UTC；状态=有效。`;
    docs[noise[0]]=`较新网页：${entity}持有有效认证。网页摘录未区分范围。`;
    docs[noise[1]]=`证书主体${alias}；范围C-${tag+1}；2026年全年；状态=有效。`;
    docs[noise[2]]=`2026-06-${day}续期申请已收件，收件主体${target}。`;
    claim+='所有未标明时区的题面时间也按UTC。';
  }
  // Nonselected plausible records remain in the packet; only the admissibility chain resolves them.
  const ordered=Object.fromEntries(shuffle(Object.entries(docs),seed+instance*97));
  const prompt=[EVIDENCE_INSTRUCTION,`规则：${rules}`,`待判定命题：${claim}`,...Object.entries(ordered).map(([k,v])=>`[${k}] ${v}`)].join('\n\n');
  return {id,family,split,instance,group:opaque({family,seed,instance}),variant:status,kind:'evidence',documents:ordered,
    // Pending/out-of-window records already establish insufficiency: authorization/scope
    // tables cannot change that conclusion, so requiring them would punish a minimal valid proof.
    gold:{status,sources:[identity,index,...(family==='citation_origin'||status==='insufficient'?[]:[policy]),...active]},
    question:question(id,'hallucination_resistance',prompt)};
}

function allocation(seed:number):AllocationData {
  const r=random(seed),items=Array.from({length:16},()=>({cost:4+Math.floor(r()*17),gain:8+Math.floor(r()*39),risk:1+Math.floor(r()*7)}));
  return {items,budget:76+seed%11,riskLimit:25+seed%7,requires:[[5,1],[8,3],[13,8],[15,2]],excludes:[[0,4],[6,11],[9,14]],minCount:4};
}
function linear(seed:number,mode:number):LinearData {
  const r=random(seed),n=5;
  const a=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>i===j?12+Math.floor(r()*6):Math.floor(r()*5)-2));
  const x=Array.from({length:n},()=>Math.floor(r()*9)-4),b=a.map(row=>row.reduce((s,v,j)=>s+v*x[j],0));
  if(mode!==0){a[n-1]=a[0].map((v,j)=>v+a[1][j]);b[n-1]=b[0]+b[1]+(mode===2?1:0);}
  return {a,b};
}
function mathCases(family:string,split:Options['split'],seed:number,instance:number):Case[] {
  const parameter=seed+instance*101,group=opaque({family,seed,instance});
  return ['base','parameter','irrelevant',...(family==='linear_certificate'?['inconsistent']:[])].map(variant=>{
    const p=parameter+(variant==='parameter'?37:0),id=opaque({family,seed,instance,variant});
    let data:AllocationData|CountingData|LinearData,task:string,kind:'allocation'|'counting'|'linear';
    if(family==='constrained_allocation') {
      kind='allocation';data=allocation(p);
      task='从编号0..15的项目中选一个子集。总cost不超过budget，总risk不超过riskLimit，数量不少于minCount。requires的[a,b]表示选a必须选b；excludes的[a,b]不能同时选。最大化总gain。只返回 JSON {"selected":[项目编号],"gain":总收益}。允许任意并列最优子集；必须同时通过可行性和全局最优性验证。';
    } else if(family==='modular_counting') {
      kind='counting';data={counts:[10+p%3,6,5],modulus:11,residue:p%11};
      task='计算由0、1、2组成的字符串总数，各数字出现次数由counts依次给定。任意前缀中1的个数不少于2的个数；不得出现相邻的22；从左到右位置编号从1开始，将每一位置的编号乘以该位置的数字再求和，除以modulus的余数必须为residue。例如串102的加权和是1×1+2×0+3×2=7（仅解释规则，不是本题数据）。只返回 JSON {"count":"精确整数"}，不得使用浮点近似。';
    } else {
      kind='linear';data=linear(p,variant==='parameter'?1:variant==='inconsistent'?2:0);
      task='对有理数域上的方程组 A x = b 分类并提交证书。唯一解：{"kind":"unique","x":[精确有理数]}；多解：{"kind":"multiple","x":[一个解],"direction":[非零零空间向量]}；无解：{"kind":"inconsistent","witness":[向量y]}，证书必须满足 yᵀA=0 且 yᵀb≠0。数值用整数或"分子/分母"。只返回对应 JSON；分类也会独立核验，不仅检查代入。';
    }
    const noise=variant==='irrelevant'?'\n背景记录：录入员本月处理了37份表格，档案封面编号为908；这些是文书管理字段，不参与上述数学约束。':'';
    return {id,family,split,instance,group,variant,kind,data,question:question(id,'reasoning_math',task+'\n数据：'+JSON.stringify(data)+noise)};
  });
}
export function buildMethodsPack(options:Options):Pack {
  if(!Number.isInteger(options.seed)||options.seed<0||options.seed>0x7fffffff||!Number.isInteger(options.instances)||options.instances<1||options.instances>5||!['development','holdout'].includes(options.split))throw new Error('Invalid seed/instances(1..5)/split');
  const cases:Case[]=[];
  for(const [family,split] of FAMILIES)if(split===options.split)for(let i=0;i<options.instances;i++) {
    if(['scope_authority','citation_origin','temporal_validity'].includes(family))
      for(const status of ['supported','refuted','insufficient','conflict'] as const)cases.push(evidence(family,split,options.seed,i,status));
    else cases.push(...mathCases(family,split,options.seed,i));
  }
  const shuffled=shuffle(cases,options.seed+19);
  // Private labels and gold are covered by the contract, but never placed in the candidate messages.
  return {options,policy:POLICY,cases:shuffled,contractHash:snapshotHash({options,policy:POLICY,cases:shuffled})};
}
