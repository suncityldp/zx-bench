/** Coordinator-only, author-reviewed draft. This aggregates explicit semantic
 * reviews; it does NOT grade free text by keyword, regex or reference similarity.
 * No model calls, database writes, automatic retries or production integration.
 */
export const HE001_RUBRIC_VERSION='HE-001-rubric-draft-v0.1';
export const HE001_CRITERIA=[
 {id:'observed_sensor_error',weight:15,title:'保留传感器实测发现',full:'准确说明S17在82℃高湿台架条件下相对独立温度计出现过高读数，而S29未出现；可用测量异常等同义表述。不把温度与湿度同时改变的比较说成已隔离湿度的独立作用。',partial:'识别S17存在实测异常，但未清楚限定条件或未交代参照依据；没有提出错误的排他性机制解释。',zero:'遗漏或否认实测异常，或把材料不支持的单因素机制说成已证实。',sourceExamples:['D3']},
 {id:'controller_mechanism',weight:10,title:'保留台架停机及软件对照结果',full:'说明指定台架条件下S17搭配F3/F4均触发停机，S29搭配两版本均未触发；由此支持该条件下异常测量可触发温度停机，F4未消除该台架现象。',partial:'准确说明S17与台架停机的联系，未完整利用软件对照；不泛化为F4在所有条件均无用。',zero:'遗漏、否认或歪曲对照结果。',sourceExamples:['D3','D4']},
 {id:'historical_transfer',weight:15,title:'实验室与原现场事件的证据边界',full:'没有把事后复现直接当成9月6日过程记录；结合原事件缺少内部独立温度、连接端湿度记录，以及外壳测点和停机后时点的差异，说明不能确认原事件没有真实过热或必然经历同一机制。无需逐字列出每个细节，但应覆盖历史条件缺口及外壳测量不能替代内部同期温度。',partial:'明确保留现场归因或真实温度的不确定性，但只给出部分具体依据；仅泛称不能确定而没有材料依据最多部分分。',zero:'声称已排除原现场真实过热、已直接证明事发时相同漂移，或完全不处理此越界判断。',sourceExamples:['D1','D3','D4','D5']},
 {id:'causal_strength',weight:15,title:'不过度否定，也不宣布唯一根因',full:'承认传感器异常是有实验支持的候选解释，同时不宣布它已被确认为现场唯一原因，也不在缺少证据时断言传感器肯定与现场事件无关。',partial:'避免唯一原因断言，但仅作笼统保留，或没有表达实验结果对候选解释的支持。',zero:'断言唯一根因，或把尚未证明错误地当作已排除。',sourceExamples:['D1','D3','D4','D5']},
 {id:'repair_attribution',weight:15,title:'维修贡献与恢复观察的边界',full:'说明三项同时实施、复机负载降低，五个班次未报警不足以分离各措施贡献或证明彻底修复；不能将台架中F4未阻止该现象外推为升级/风道清理对现场完全无作用。',partial:'准确识别同时维修或负载变化中的至少一项，并据此限制归因；未完整处理恢复期限或其他措施贡献。',zero:'把恢复唯一归功于换传感器、宣布永久消除故障或断言其他措施没有现场作用，或完全遗漏此问题。',sourceExamples:['D2','D4','D5']},
 {id:'source_independence',weight:10,title:'识别重复转述而非独立确认',full:'指出两份文稿共享D3/D4的测量来源，供应商通报没有新增测量，不能算两次独立调查确认；不因为转述就否认原实验本身。',partial:'怀疑来源独立性，但未准确说明依赖关系。',zero:'重复两次独立确认的说法、忽略该问题，或无依据指控原实验伪造。',sourceExamples:['D6']},
 {id:'verification_design',weight:8,title:'提出具体且有区分能力的验证',full:'提出至少一项与历史解释有关、可操作的检查或受控比较，说明关键测量/控制对象，能区分合理候选解释或补足特定证据缺口。接受多种方案，不要求复刻作者指定实验，也不要求同时开展所有可能实验。',partial:'方向相关，但测量、对照或可行性仍不清楚；简单重复已有实验但未说明新增价值最多部分分。',zero:'仅说需要更多数据、无关验证，或把未提供的历史数据假定为已经存在。',sourceExamples:[]},
 {id:'verification_interpretation',weight:7,title:'解释不同结果及事后验证限度',full:'说明至少两种可能结果分别如何提高、降低或重定向候选解释的可信度；解释针对9月6日事件的意义，不声称事后实验能直接测回历史状态。合理的历史资料检索也须说明找到/找不到或记录显示不同结果的含义。',partial:'只解释一侧结果，或结果到历史判断之间的联系不充分但未过度断言。',zero:'不解释结果，或把某次事后复现/未复现当成对历史唯一原因的决定性证明。',sourceExamples:[]},
 {id:'publishable_grounding',weight:5,title:'完成改写且引用可追溯',full:'提供可发布结论并说明需要修正的判断，准确引用真实材料且不引入额外事实。可以合并段落、改变顺序，相关背景引用不扣分，不要求唯一措辞或来源编号组合。',partial:'核心内容基本正确但只列审查要点、缺少实际改写，或引用不充分但未编造事实。',zero:'没有实质完成任务，或仍以自己的结论发布严重无依据断言/编造事实。',sourceExamples:['D1','D2','D3','D4','D5','D6']},
] as const;
export type HE001CriterionId=typeof HE001_CRITERIA[number]['id'];
export const HE001_CRITICAL_ERRORS=[
 'asserts_historical_no_overheat','asserts_unique_historical_cause',
 'asserts_permanent_fix_or_other_repairs_useless','fabricates_observation_or_independent_confirmation',
 'claims_unisolated_factor_proven','claims_posthoc_test_proves_history',
] as const;
export type HE001CriticalError=typeof HE001_CRITICAL_ERRORS[number];
export interface HE001Assessment {id:HE001CriterionId;level:0|1|2;quote:string|null;rationale:string}
export interface HE001Review {rubricVersion:string;assessments:HE001Assessment[];criticalErrors:{id:HE001CriticalError;quote:string;rationale:string}[]}
export function scoreHE001Review(answer:string,review:HE001Review){
 if(typeof answer!=='string'||!answer.trim())throw new Error('Nonempty candidate answer required');
 if(review.rubricVersion!==HE001_RUBRIC_VERSION)throw new Error('Rubric version mismatch');
 if(!Array.isArray(review.assessments)||review.assessments.length!==HE001_CRITERIA.length||new Set(review.assessments.map(a=>a.id)).size!==HE001_CRITERIA.length)throw new Error('Each criterion must be reviewed exactly once');
 for(const a of review.assessments){
  if(!HE001_CRITERIA.some(c=>c.id===a.id)||![0,1,2].includes(a.level)||typeof a.rationale!=='string'||!a.rationale.trim())throw new Error('Invalid assessment');
  if(a.quote!==null&&(typeof a.quote!=='string'||!a.quote.trim()||!answer.includes(a.quote)))throw new Error('Review quote must occur in answer');
  if(a.level>0&&a.quote===null)throw new Error('Positive credit requires a candidate evidence span');
 }
 if(!Array.isArray(review.criticalErrors)||new Set(review.criticalErrors.map(e=>e.id)).size!==review.criticalErrors.length)throw new Error('Critical-error list must be explicit and unique');
 for(const e of review.criticalErrors){
  if(!HE001_CRITICAL_ERRORS.includes(e.id)||typeof e.quote!=='string'||!e.quote.trim()||!answer.includes(e.quote)||typeof e.rationale!=='string'||!e.rationale.trim())throw new Error('Critical errors require an actual endorsed assertion and rationale');
 }
 const criteria=HE001_CRITERIA.map(c=>{const a=review.assessments.find(a=>a.id===c.id)!;return {id:c.id,weight:c.weight,level:a.level,points:c.weight*a.level/2};});
 return {rubricVersion:HE001_RUBRIC_VERSION,weightedScore:criteria.reduce((n,c)=>n+c.points,0),maxScore:100,criteria,
  criticalErrors:review.criticalErrors,hasCriticalUnsupportedClaim:review.criticalErrors.length>0,
  fullRubricPass:criteria.every(c=>c.level===2)&&review.criticalErrors.length===0,
  scoreOrigin:'explicit_semantic_review_not_automatic_text_grading' as const,
  calibrationStatus:'author_fixture_checks_only_not_independent_validation' as const};
}
