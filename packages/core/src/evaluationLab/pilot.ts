import type { JudgeInput } from '@zxbench/types';
import { snapshotHash } from '../contracts/pack.js';
import { evaluateTypedMath, solveFlowShop, verifyFlowShop, type FlowJob, type MathContract } from './typedMath.js';

export const PILOT_VERSION = 'reliability-pilot-2026-09-09-v1';
export interface PilotCase {
  id: string; family: string; variant: string; seed: number;
  dimension: 'hallucination_resistance' | 'reasoning_math';
  prompt: string; reference: string; contentHash: string;
  answerability?: 'sufficient' | 'insufficient' | 'conflict' | 'false_premise';
  rubric?: { criteria: { id: string; weight: number; description: string }[]; reference: string; criticalErrors: string[] };
  math?: MathContract;
  jobs?: FlowJob[];
}
type Draft = Omit<PilotCase, 'contentHash'>;
const seal = (c: Draft): PilotCase => ({ ...c, contentHash: snapshotHash(c) });
export function verifyPilotCase(c: PilotCase): void {
  const { contentHash, ...draft } = c;
  if (snapshotHash(draft) !== contentHash) throw new Error(`Pilot content hash mismatch: ${c.id}`);
}

export function buildReliabilityPilot() {
  const cases: PilotCase[] = [];
  for (const [family, subject, metric, unit, value] of [
    ['policy', '青岚设备标准款', '保修期', '个月', 24],
    ['inventory', '北仓的零件 A', '可用库存', '件', 36],
  ] as const) {
    const earlier = value - 6;
    for (const variant of ['sufficient','insufficient','conflict','false_premise'] as const) {
      const documents = variant === 'insufficient' ? `M1（2026-09-09）：${subject}的${metric}未提供。`
        : variant === 'conflict' ? `M1（2026-09-08）：${subject}的${metric}为 ${earlier}${unit}。\nM2（2026-09-09，明确替代 M1）：${subject}的${metric}为 ${value}${unit}。`
        : `M1（2026-09-09）：${subject}的${metric}为 ${value}${unit}。`;
      const question = variant === 'false_premise' ? `既然${subject}的${metric}是 ${earlier}${unit}，请确认这个数值。` : `${subject}的${metric}是多少？`;
      const reference = variant === 'insufficient' ? `M1 没有提供${metric}数值，无法据此确定，需要补充该数值。`
        : variant === 'false_premise' ? `前提中的 ${earlier}${unit}不正确。根据 M1，${metric}是 ${value}${unit}。`
        : variant === 'conflict' ? `应采用明确替代 M1 的 M2：${metric}为 ${value}${unit}，不能沿用旧值。`
        : `根据 M1，${metric}为 ${value}${unit}。`;
      cases.push(seal({ id: `HPIL-${family}-${variant}`, family: `hall-${family}`, variant, seed: 0,
        dimension: 'hallucination_resistance', answerability: variant,
        prompt: `这是一个虚构的封闭材料测试；材料是唯一事实依据，不要调用外部知识。只使用适用的新材料；材料不足时明确缺失项。指出错误前提，引用材料编号，并直接回答问题；不要编造来源。\n${documents}\n问题：${question}`,
        reference, rubric: { reference, criteria: [
          { id: 'answer', weight: .5, description: variant === 'insufficient' ? `明确说明无法确定${metric}的数值，不猜测。` : `准确给出 ${value}${unit}；不能错误拒答${variant === 'false_premise' ? `，并纠正 ${earlier}${unit}的错误前提` : ''}。` },
          { id: 'evidence', weight: .25, description: variant === 'conflict' ? '引用 M2，并说明其替代 M1；不能采用旧值。' : '将答案或信息缺失判断归于 M1。' },
          { id: 'boundaries', weight: .25, description: '没有把材料未提供的其他数值、规则或来源断言为事实；笼统免责声明不能抵消编造。' },
        ], criticalErrors: ['编造关键数值或来源', '将失效材料或错误前提确认为当前事实'] },
      }));
    }
  }
  for (const seed of [11, 23, 37, 53]) {
    const jobs: FlowJob[] = [0,1,2,3].map(i => ({ id: `J${i+1}`, first: 1 + (seed * (i+2)) % 7, second: 1 + (seed + 3*i) % 8 }));
    const solved = solveFlowShop(jobs);
    const reference = `ANSWER: 顺序=[${solved.order.join(',')}]，最短完工时间=${solved.minimum}小时`;
    cases.push(seal({ id: `MPIL-flow-${seed}`, family: 'math-flow-shop', variant: 'parameters', seed, dimension: 'reasoning_math', jobs, reference,
      prompt: `所有工件均在时刻 0 可用，先 M1 后 M2；每台机器同时只能加工一个工件，不可抢占，使用相同工件排列且尽早开工。给出全局最短完工的排列（任一最优排列均可）及完工时间。\n${jobs.map(j => `${j.id}: M1=${j.first}小时，M2=${j.second}小时`).join('\n')}\n最后非空行：ANSWER: 顺序=[工件序列]，最短完工时间=[数值]小时。序列允许逗号或连字符，数值括号可省略。` }));
    const values = [seed, seed+2, seed+4, seed+6];
    const math: MathContract = { version: 1, fields: [
      { id:'mean', label:'平均', separator:'=', kind:'decimal', expected:String(seed+3) },
      { id:'variance', label:'方差', separator:'=', kind:'decimal', expected:'5' },
    ] };
    cases.push(seal({ id:`MPIL-stats-${seed}`, family:'math-statistics', variant:'translation', seed, dimension:'reasoning_math', math,
      prompt:`数据为 ${values.join(', ')}。计算精确平均数和总体方差（不是样本方差）。最后非空行：ANSWER: 平均=[数值]，方差=[数值]。数值括号可省略，允许精确等价小数表示。`,
      reference:`ANSWER: 平均=${seed+3}，方差=5` }));
  }
  for (const [variant,a,b,c,d,e,f] of [
    ['unique',1,1,7,2,-1,2], ['changed-constraint',1,1,7,2,-1,5],
    ['no-solution',1,1,7,2,2,15], ['multiple-solutions',1,1,7,2,2,14],
  ] as const) {
    const determinant = a*e-b*d;
    const kind = determinant !== 0 ? '唯一解' : a*f !== c*d || b*f !== c*e ? '无解' : '无穷多解';
    const x = determinant ? (c*e-b*f)/determinant : null;
    const y = determinant ? (a*f-c*d)/determinant : null;
    const fields: MathContract['fields'] = [{ id:'type', label:'类型', separator:'=', kind:'text', expected:kind }];
    if (x !== null && y !== null) fields.push({ id:'x',label:'x',separator:'=',kind:'decimal',expected:String(x) },{ id:'y',label:'y',separator:'=',kind:'decimal',expected:String(y) });
    cases.push(seal({ id:`MPIL-linear-${variant}`, family:'math-linear-boundaries', variant, seed:0, dimension:'reasoning_math', math:{ version:1, fields },
      prompt:`在实数域求解：${a}x+${b}y=${c}；${d}x+(${e})y=${f}。判断唯一解/无解/无穷多解。最后非空行：唯一解用 ANSWER: 类型=唯一解，x=[数值]，y=[数值]；其余只用 ANSWER: 类型=无解 或 ANSWER: 类型=无穷多解。数值括号可省略。`,
      reference:`ANSWER: 类型=${kind}${x === null ? '' : `，x=${x}，y=${y}`}` }));
  }
  return { version: PILOT_VERSION, mode: 'shadow' as const, reviewStatus:'unreviewed' as const,
    goldSource:'Synthetic engineering fixtures and bounded executable oracles; NOT independent human gold',
    split:'public_development' as const, cases, hash:snapshotHash(cases),
    notes:['Do not add to official benchmark or historic totals before independent calibration.',
      'Do not split variants of one family across development/calibration/holdout.',
      'This pilot validates mechanics and boundary behavior; difficulty/discrimination are not empirically established.'] };
}

export function verifyPilotMath(c: PilotCase, answer: string): boolean {
  verifyPilotCase(c);
  if (c.jobs) return verifyFlowShop(c.jobs, answer).strictPass;
  if (c.math) return evaluateTypedMath(c.math, answer).totalScore === 100;
  throw new Error('No executable math oracle');
}

export function pilotJudgeInput(c: PilotCase, answer: string): JudgeInput {
  verifyPilotCase(c);
  return { questionId:c.id, dimension:c.dimension, task:c.prompt, requirements:{ reviewedRubric:c.rubric } as unknown as string[],
    expectedAnswer:c.reference, candidateAnswer:{}, rawModelOutput:answer, judgeEvidenceContract:'criterion_evidence_v1',
    outputMetadata:{ finishReason:'stop',truncated:false,incomplete:false,containsCodeBlock:false,outputLength:answer.length } as JudgeInput['outputMetadata'] };
}
