import {HE001_PROTOCOL_VERSION,HE001_FINDINGS,HE001_BOUNDARIES,type HE001ProfileReview,type HE001ClaimLabel,type HE001CitationLabel} from './he001Protocol.js';
const parts=[
 '在82℃高湿台架条件下，S17相对独立温度计出现超过90℃的读数，S29未出现超过90℃的读数；25℃检查两者均在校准允差内。D3未给出25℃连接端湿度，也没有同温干湿对照，不能单独认定湿度的因果作用。（D3）',
 '指定台架中S17配F3/F4均触发停机，S29配两个版本均未触发，说明F4没有阻止本次台架现象。（D4）',
 '9月6日缺少同期内部独立温度及连接端湿度记录；事后四分钟的外壳测温不能替代内部同期测温，所以不能排除现场真实过热。（D1、D5）',
 '传感器测量异常是有实验依据的候选解释，但不是已经确证的现场唯一根因，也没有被排除。（D3、D4、D5）',
 '三项措施同时实施且复机负载降低，五班次未停机是有效观察，但不能分离各措施贡献、证明永久修复或断言其他措施毫无作用。（D2、D5）',
 '两份文稿所引技术依据来自同一组实验，供应商通报未附新增测量记录，不能据此写为两次独立调查确认。（D6）',
 '优先在受控条件下保持软件、风道和负载一致，加入独立冷却液测温，对照两个探头在匹配温度的干燥与高湿环境中的读数和停机响应。',
 '若仅S17在真实温度低于阈值时触发停机，会增强所测条件下误报机制的支持；若独立测温显示真实超温且两探头一致，只能说明这次新测试发生真实超温，不能据此排除其他条件下的误报或并存故障。与现场条件是否相符仍需核验，两类结果都不能直接重建9月6日的真实状态。',
];
const evidence=[['D3'],['D4'],['D1','D5'],['D3','D4','D5'],['D2','D5'],['D6'],[],[]];
const baseLabels:HE001ClaimLabel[]=['supported','supported','supported','qualified_hypothesis','supported','supported','nonfactual','nonfactual'];
export function he001ProtocolFixtures(){
 const make=(id:string,mutate?:(p:string[],r:HE001ProfileReview)=>void)=>{
  const p=[...parts];
  const r:HE001ProfileReview={version:HE001_PROTOCOL_VERSION,claimExtraction:'complete',claims:p.map((quote,i)=>({id:`C${i+1}`,quote,label:baseLabels[i],reason:'作者构造的语义审查锚点；不是实际Judge或独立人工结果。',evidence:[...evidence[i]],critical:false,citation:{label:(i<6?'adequate':'not_applicable') as HE001CitationLabel,reason:'事实引用与提出未来验证分别处理。'}})),
   findings:HE001_FINDINGS.map((f,i)=>({id:f.id,level:2,quote:p[[0,1,4,5][i]],reason:'保留对应实质发现。'})),
   boundaries:HE001_BOUNDARIES.map((b,i)=>({id:b.id,level:2,quote:p[[2,3,4,0][i]],reason:'结论保持材料允许的范围。'})),
   verification:{specific:true,contrastingOutcomes:true,respectsHistoryLimit:true,quote:p[6]+'\n\n'+p[7],reason:'方案具体，比较结果有区分作用，说明历史局限。'}};
  if(mutate)mutate(p,r);
  return {id,answer:p.filter(Boolean).join('\n\n'),review:r,origin:'synthetic_author_review_not_model_or_human_gold'};
 };
 const replace=(p:string[],r:HE001ProfileReview,i:number,s:string)=>{const old=p[i];p[i]=s;r.claims[i].quote=s;for(const x of [...r.findings,...r.boundaries])if(x.quote===old)x.quote=s;};
 return [
  make('supported_complete'),
  make('reordered_same_meaning',(p)=>{const reordered=[p[5],...p.slice(0,5),p[6],p[7]];p.splice(0,p.length,...reordered);}),
  make('paraphrased_same_meaning',(p,r)=>{replace(p,r,5,'供应商通报援引的是实验室简报，所给材料没有附第二组新增测量记录；这不足以支持两次独立确认的说法。（D6）');}),
  make('implicit_factor_boundary',(p,r)=>{replace(p,r,0,'在所述82℃高湿台架条件下，S17相对独立温度计出现超过90℃的读数，S29未出现超过90℃的读数；在所述25℃检查中，两者读数均在校准允差内。这些结果限于记录的测试条件。（D3）');r.boundaries[3].reason='保留条件限定且未认领湿度因果，不要求额外写免责声明。';}),
  make('additional_relevant_context',(p,r)=>{replace(p,r,1,p[1].replace('（D4）','（D3、D4）'));}),
  make('correct_but_missing_citations',(p,r)=>{for(let i=0;i<6;i++){replace(p,r,i,p[i].replace(/（D[^）]+）/g,''));r.claims[i].citation.label='missing';}}),
  make('endorsed_historical_overclaim',(p,r)=>{replace(p,r,2,'外壳测温81℃已经证明9月6日内部冷却液没有真实过热。（D1）');r.claims[2].label='unsupported';r.claims[2].critical=true;r.claims[2].citation.label='misleading';r.boundaries[0].level=0;}),
  make('fabricated_independent_measurement',(p,r)=>{replace(p,r,5,'供应商另做了独立测量，因此两份独立调查相互验证。（D6）');r.claims[5].label='unsupported';r.claims[5].reason='未附记录不能证明从未测量，但材料不足以支持另做独立测量及相互验证的断言。';r.claims[5].critical=true;r.claims[5].citation.label='misleading';r.findings[3].level=0;}),
  make('explicit_controller_contradiction',(p,r)=>{replace(p,r,1,'D4记录S17配F4在四轮测试中均未触发停机，说明F4阻止了本次台架现象。（D4）');r.claims[1].label='refuted';r.claims[1].reason='D4明确记载S17配F4每轮都触发，与均未触发直接冲突。';r.claims[1].critical=true;r.claims[1].citation.label='misleading';r.findings[1].level=0;}),
  make('invented_dry_baseline',(p,r)=>{const s='D3还记录25℃基线的连接端是干燥的。（D3）';p.push(s);r.claims.push({id:'C9',quote:s,label:'unsupported',reason:'25℃连接端湿度未记录；无依据的新增断言单独抽取，不覆盖原来有支持的观察。',evidence:['D3'],critical:false,citation:{label:'misleading',reason:'D3没有所引干燥基线。'}});r.boundaries[3]={id:'factor',level:1,quote:s,reason:'原限定仍在，但新增与其冲突的无依据湿度基线。'};}),
  make('quoted_error_rejected',(p,r)=>{replace(p,r,2,'原文的“设备当时并未真实过热”应撤回：外壳后测温不等于内部同期温度，现场又缺少同期独立内部温度和湿度，不能排除真实过热。（D1、D5）');}),
  make('blanket_abstention',(p,r)=>{const s='资料不足，我不作任何判断，也没有可提供的实质结论或验证建议。';p.splice(0,p.length,s);r.claims=[{id:'C1',quote:s,label:'nonfactual',reason:'拒绝作答本身不等于已编造事实；覆盖单独扣失。',evidence:[],critical:false,citation:{label:'not_applicable',reason:'没有作出需要引用的实质事实断言。'}}];for(const x of [...r.findings,...r.boundaries]){x.level=0;x.quote=null;x.reason='没有完成此项。';}r.verification={specific:false,contrastingOutcomes:false,respectsHistoryLimit:false,quote:null,reason:'未提出验证。'};}),
 ];
}
