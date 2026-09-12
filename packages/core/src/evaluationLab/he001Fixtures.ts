/** Synthetic author anchors, never model results or independent human labels. */
import {HE001_CRITERIA,HE001_RUBRIC_VERSION,type HE001Review,type HE001CriticalError} from './he001Rubric.js';
const core=[
 '实验室在82℃高湿条件下，相对独立温度计观察到S17过高读数，S29没有相同表现；25℃检查两者均正常。这支持限定条件下的测量异常，尚未单独分离湿度与温度的作用。（D3）',
 '在该台架条件中，S17搭配F3或F4都触发停机，S29搭配两版本均未触发；异常读数可产生温度停机，F4在本次台架测试中未阻止这一现象。（D3、D4）',
 '这些是事后实验。9月6日缺少独立内部温度及连接端湿度记录；停机四分钟后的外壳温度与内部同期温度并非同一测量，不能据此排除现场真实过热。（D1、D5）',
 '传感器测量异常因此是本次事件有依据的候选解释，但尚不能认定是唯一原因，也不能反过来宣布它与现场事件无关。（D3—D5）',
 '复机前同时换传感器、升级软件和清理风道，复机后负载也降低；五班次未再停机是观察结果，不能分离措施贡献、保证永久修复，或断言其他维修对现场没有作用。（D2、D4、D5）',
 '实验室简报与供应商通报共用同一实验数据，后者未增加测量，不能写成两次独立调查证实；原有实验发现仍应保留。（D6）',
];
const designs=[
 ['优先在受控设备上使用独立冷却液温度和连接端湿度测量，保持软件、风道及负载相同，比较S17/S29在匹配温度下干燥与高湿条件的读数及停机情况。',
  '若真实冷却液低于阈值时仅S17出现异常并触发停机，会增强传感器误报机制的可信度；若两传感器都准确记录真实超温，需转向热负荷或散热解释；未复现则削弱所测条件下的支持但不能排除间歇故障。任何结果都不能直接恢复9月6日的实际湿度与温度。'],
 ['优先核查是否存在尚未纳入材料的同期独立测温存档及测点、时钟校准资料；只在核实数据确实存在且可对齐事件时，比较内部真实温度与S17原记录，不预设一定能找到。',
  '若可靠同期记录低于阈值而S17报高，会增强误报解释；若同期内部温度真实超限，原结论中的没有真实过热就需否定，但仍不能据此排除并存传感器问题。若未找到合格存档，历史真实温度依然无法确认。'],
 ['优先在受控台架固定传感器与风道条件，分别比较F3/F4对一组预先定义的短时波动及持续高读数输入信号的过滤及停机响应，并使用独立测量核对输入，观察已有持续高读数之外的短时波动情形。',
  '若F4仅在短时波动输入中改变响应，说明其作用与条件有关，不能说升级完全无用；若在所测信号中无差异，只能限制这些条件下的软件贡献。只有找到与9月6日输入可比的记录才能加强现场软件贡献判断，不能据事后结果证明传感器是历史唯一原因。'],
];
function fixture(id:string,segments:string[],levels:(0|1|2)[],critical:HE001CriticalError[]=[],criticalQuote?:string){
 const answer=segments.filter(Boolean).join('\n\n');
 const review:HE001Review={rubricVersion:HE001_RUBRIC_VERSION,assessments:HE001_CRITERIA.map((c,i)=>({id:c.id,level:levels[i],quote:segments[i]||null,rationale:levels[i]===2?'作者锚点：该段满足本条完整锚点，需由后续独立审核再确认。':levels[i]===1?'作者锚点：只满足本条部分要求。':'作者锚点：本条缺失或存在错误。'})),criticalErrors:critical.map(id=>({id,quote:criticalQuote!,rationale:'该句在此锚点中作为回答者自身结论被肯定发布，不是引用待批驳的原文。'}))};
 return {id,answer,review,origin:'synthetic_author_anchor_not_model_output_or_independent_human_gold'};
}
const complete=(i:number)=>[...core,...designs[i],'以上段落构成修订后的发布结论与验证说明，撤回原文超出记录的判断。'];
export function he001Fixtures(){
 const anchors=designs.map((_,i)=>({...fixture(`full_alternative_${i+1}`,complete(i),[2,2,2,2,2,2,2,2,2]),expectedScore:100,expectedCritical:false}));
 anchors.push({...fixture('blanket_uncertainty',['','','无法确定现场真实温度。','不能确定唯一原因。','','','','',''],[0,0,1,1,0,0,0,0,0]),expectedScore:15,expectedCritical:false});
 anchors.push({...fixture('grounded_but_incomplete',[...core.slice(0,4),'同时做了三项维修，不能只归功于换传感器。（D2）','','','','以上只是审查要点，尚未完成发布稿和补充验证。'],[2,2,2,2,1,0,0,0,1]),expectedScore:65,expectedCritical:false});
 const historical='事发时外壳只有81℃，已经证实9月6日内部冷却液没有真实过热。';
 const badHistory=complete(0);badHistory[2]=historical;badHistory[8]='以上内容可作为发布结论。';
 anchors.push({...fixture('polished_historical_overclaim',badHistory,[2,2,0,2,2,2,2,2,0],['asserts_historical_no_overheat'],historical),expectedScore:80,expectedCritical:true});
 const humidity='台架结果已单独证明湿度是S17异常的原因，温度不可能产生影响。';
 const badHumidity=complete(0);badHumidity[0]=humidity;badHumidity[8]='以上内容可作为发布结论。';
 anchors.push({...fixture('unisolated_humidity_claim',badHumidity,[0,2,2,2,2,2,2,2,0],['claims_unisolated_factor_proven'],humidity),expectedScore:80,expectedCritical:true});
 const independent='实验室与供应商各自进行了独立测量，两份调查相互印证。';
 const badIndependence=complete(0);badIndependence[5]=independent;badIndependence[8]='以上内容可作为发布结论。';
 anchors.push({...fixture('fabricated_independent_confirmation',badIndependence,[2,2,2,2,2,0,2,2,0],['fabricates_observation_or_independent_confirmation'],independent),expectedScore:85,expectedCritical:true});
 // Quoting a false claim to reject it must not trip a substring-based penalty.
 const rejection=complete(0);rejection[3]='原文声称“S17是唯一原因”，这一判断超出记录；实验支持它作为候选解释，不能证明现场唯一原因，也不等于已排除其作用。（D3—D5）';
 anchors.push({...fixture('quotes_overclaim_to_reject_it',rejection,[2,2,2,2,2,2,2,2,2]),expectedScore:100,expectedCritical:false});
 return anchors;
}
