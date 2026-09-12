import {snapshotHash} from '../contracts/pack.js';
import {gradeEvidence} from './challengeHall.js';
import {buildRebalancedEvidenceChallenges,buildAppliedMathChallenges,CHALLENGE_RECLASSIFICATION} from './challengeRebalance.js';
import {buildMathChallenges,gradeMath} from './challengeMath.js';
import {CHALLENGE_VERSION,type ChallengeCase,object,result} from './challengeTypes.js';

export function buildChallengePack(){
 const cases:ChallengeCase[]=[...buildRebalancedEvidenceChallenges(),...buildMathChallenges(),...buildAppliedMathChallenges()];
 return {version:CHALLENGE_VERSION,status:'development_requires_human_review_and_model_pilot',
  goldSource:'synthetic_authored_materials_and_executable_math_oracles_not_human_gold',
  difficulty:'designed_challenge_not_empirically_calibrated',productionReplacement:false,
  reclassification:CHALLENGE_RECLASSIFICATION,cases,hash:snapshotHash(cases)};
}
/** Allowlist is the ONLY model-facing export. Never serialize whole cases into requests. */
export function candidateQuestion(c:ChallengeCase){
 const common='只提交一个 JSON 对象，键不得重复，可使用一个 json 代码块包裹。数字可用数值或精确等价数字字符串；分数可用字符串 p/q。不要附加其他字段或自然语言解答。按题目给出可检验的答案/证书，不要求内部思维链。';
 const user=c.dimension==='hallucination_resistance'?
  `以下均为虚构的封闭材料，只根据材料回答；不要使用外部事实或把材料中的宣传措辞当证据。需要跨材料推断；区分事实可确定、信息不足和无法消解的冲突。\n\n${Object.entries(c.documents).map(([id,text])=>`${id}：${text}`).join('\n')}\n\n问题（每个 ID 单独作答）：\n${c.fields.map(f=>`${f.id}：${f.question}`).join('\n')}\n\n${common}\n每个 ID 对应 {"value":答案,"status":"determined"或"insufficient"或"conflict","sources":["材料ID"]}。不能确定时 value 必须为 null，不填猜测值。sources 列出支持该项完整推断链的材料 ID，每项最多 6 个，不重复；可附带与本项有关的背景材料，不要无差别列出所有材料或编造编号。`:
  `${c.task}\n${Object.keys(c.data as object).length?`\n输入数据：\n${JSON.stringify(c.data,null,2)}\n`:''}\n${common}`;
 return {id:c.id,dimension:c.dimension,family:c.family,title:c.title,
  messages:[{role:'system' as const,content:'你正在完成能力挑战题。评分只依据题目明确要求，不使用外部工具。'},{role:'user' as const,content:user}]};
}
export function referenceAnswer(c:ChallengeCase):Record<string,unknown>{return c.dimension==='reasoning_math'?structuredClone(c.reference):Object.fromEntries(c.fields.map(f=>[f.id,structuredClone(f.expected)]));}
/** JSON.parse accepts duplicate keys; reject them instead of silently keeping the last answer. */
function parseUniqueJson(text:string):unknown{
 if(text.length>500000)throw new Error('Answer exceeds bounded parser size');
 const value=JSON.parse(text);const stack:{kind:'object'|'array';keys:Set<string>;expectKey:boolean}[]=[];
 for(const match of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],]/g)){
  const token=match[0],top=stack.at(-1);
  if(token==='{'||token==='[')stack.push({kind:token==='{'?'object':'array',keys:new Set(),expectKey:true});
  else if(token==='}'||token===']')stack.pop();
  else if(token===','){if(top)top.expectKey=true;}
  else if(top?.kind==='object'&&top.expectKey){const key=JSON.parse(token);if(top.keys.has(key))throw new Error('Duplicate JSON key');top.keys.add(key);top.expectKey=false;}
 }return value;
}
export function gradeChallenge(c:ChallengeCase,output:string,complete=true){
 let value:unknown;try{const text=output.trim();const fence=text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);value=parseUniqueJson(fence?fence[1]:text);if(!object(value))throw new Error('not object');}catch{return result(c.id,[],false,'Invalid JSON object; mathematical/evidence accuracy unmeasured');}
 const grade=c.dimension==='hallucination_resistance'?gradeEvidence(c,value):gradeMath(c,value);
 if(!complete){grade.strictPass=false;if(grade.evidencePass!==undefined)grade.evidencePass=false;if(grade.answerPass!==undefined)grade.answerPass=false;grade.error='Incomplete/truncated output cannot certify strict success';}return grade;
}
export function renderQuestionBook(cases:ChallengeCase[]):string{
 const hall=cases.filter(c=>c.dimension==='hallucination_resistance').length,math=cases.filter(c=>c.dimension==='reasoning_math').length;
 return `# 能力挑战题：题面审核版\n\n${cases.length} 道候选题：${hall} 道幻觉抵抗、${math} 道数学推理。此文件只包含考生可见内容，不包含参考答案、Judge 分数或预设通过标签。\n\n状态：待人工审题及真实模型试测，尚不能声称已具有高区分度。无需重做此前 44 个基础夹具；请先检查这些题的难度、歧义和可解性。旧题库与历史成绩不变。\n\n`+
 cases.map(c=>{const q=candidateQuestion(c);return `## ${q.id} · ${q.title}\n\n${q.messages[1].content}\n`;}).join('\n');
}
