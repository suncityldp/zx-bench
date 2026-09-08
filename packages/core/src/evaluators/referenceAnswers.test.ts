import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Scenario, OutputMetadata } from '@zxbench/types';
import { hashScenarioShort } from '../contracts/canonicalize.js';
import { exactAnswerLineEvaluator as evaluator } from './exactAnswerLine.js';
const scenarios: Scenario[] = JSON.parse(readFileSync(new URL('../../../../data/scenarios/benchmark.json', import.meta.url), 'utf8'));
const scenario = (n: number) => scenarios.find(s => s.id === `RM-CN-${String(n).padStart(3, '0')}`)!;
const meta = { truncated: false, incomplete: false } as OutputMetadata;
const accuracy = async (n: number, output: string) => (await evaluator.evaluate(scenario(n), output, meta)).axisScores?.answer_accuracy;
const round = (n: number, digits = 2) => Number(n.toFixed(digits));
const permutations = <T,>(a: T[]): T[][] => a.length ? a.flatMap((v, i) => permutations(a.filter((_, j) => i !== j)).map(p => [v, ...p])) : [[]];

describe('issue #7 independent arithmetic oracles', () => {
  const gross = 8999 * 10 + 2259 * 5 + 6799 * 2;
  const supply = 500 * 500 + 300 * 500 * .9 + 200 * 500 * .85;
  const member = supply * .95;
  const final = round((member + (member > 500000 ? 0 : 3000)) * 1.13 * .98);
  const principal = 50000, rate = .0275;
  const r = .042 / 12, factor = (1 + r) ** 360;
  const month = Math.round(1000000 * r * factor / (factor - 1));
  const bFactor = 1.12 * .95 * 1.08;
  const cagr = (1725 / 800) ** (1 / 4) - 1;
  const profits = 600000 - 50000 - 30000;
  const scores = [72, 85, 91, 68, 77, 85, 93, 85, 60, 79];
  const mean = scores.reduce((a, b) => a + b) / scores.length;
  const sorted = [...scores].sort((a, b) => a - b);
  const p = 320 / 400, se = Math.sqrt(p * (1 - p) / 400);
  const d = new Date('2024-03-04T00:00:00Z');
  const duration = 5 + Math.max(8 + 12, 15) + 7 + 2;
  for (let days = 1; days < duration;) { d.setUTCDate(d.getUTCDate() + 1); if (![0, 6].includes(d.getUTCDay())) days++; }
  const date = `${d.getUTCFullYear()}年${String(d.getUTCMonth() + 1).padStart(2, '0')}月${String(d.getUTCDate()).padStart(2, '0')}日`;
  const expected: Record<number, string | number> = {
    1: 399 + 259 + 189 - 80 - 30,
    2: `含税总额${gross}元，不含税总额${round(gross / 1.13)}元，增值税额${round(gross - gross / 1.13)}元`,
    3: 5000 * 2.5 * 7.24 * 1.08 + 3500,
    4: final,
    5: `单利利息${principal * rate * 3}元，单利本息${principal * (1 + rate * 3)}元，复利本息${round(principal * (1 + rate) ** 3)}元`,
    6: `月供${month}元，总还款${month * 360}元，总利息${month * 360 - 1000000}元`,
    7: `A=${round(100 * (1 + .03 * 3))}万，B=${round(100 * bFactor)}万，C=${round(100 * (1 + rate) ** 3)}万，B年化=${round((bFactor ** (1 / 3) - 1) * 100)}%，最高=B`,
    8: date,
    9: `安全库存${(80 - 50) * 7 * 1.5}件，再订货点${50 * 7 + (80 - 50) * 7 * 1.5}件，可支撑${200 / 50}天`,
    10: `每日在岗${3 * 5}人，最少员工${Math.ceil(3 * 5 * 7 / 5)}人，含加班最少${Math.ceil(3 * 5 * 7 / 6)}人`,
    15: `同比${(1560 - 1200) / 1200 * 100}%，环比${round((1560 - 1800) / 1800 * 100, 1)}%，全年${1200 + 1350 + 1500 + 1800}万，Q4占比${round(1800 / 5850 * 100, 1)}%`,
    16: `简单平均${(85 + 92 + 78 + 88 + 95) / 5}分，加权平均${round((85 * 3 + 92 * 4 + 78 * 3 + 88 * 2 + 95 * 2) / 14)}分，差距${95 - 78}分，变化${round(3 * 4 / 14)}分`,
    17: `不良率${round((.4 * .02 + .35 * .03 + .25 * .05) * 100)}%，来自A的概率${round(.4 * .02 / (.4 * .02 + .35 * .03 + .25 * .05) * 100)}%`,
    18: `平均${mean}，中位数${(sorted[4] + sorted[5]) / 2}，众数85，极差${sorted[9] - sorted[0]}，方差${round(scores.reduce((sum, v) => sum + (v - mean) ** 2, 0) / scores.length)}`,
    19: `CAGR=${round(cagr * 100)}%，最高增长年份=2021年和2023年，2025预计=${round(1725 * (1 + cagr) ** 2)}万`,
    20: `甲=${profits * .4 + 50000}元，乙=${profits * .35 + 30000}元，丙=${profits * .25}元`,
    21: `满意率${p * 100}%，SE=${round(se * 100)}%，置信区间=${round((p - 1.96 * se) * 100, 1)}%-${round((p + 1.96 * se) * 100, 1)}%，所需样本=${Math.ceil(1.96 ** 2 * p * (1 - p) / .02 ** 2)}`,
    22: 'A=20万,B=15万,C=25万,D=10万,E=30万',
    27: `甲=${(72 / 3) + 7}岁，乙=${72 / 3}岁，丙=${(72 / 3) - 7}岁`,
    30: `电费=${240 * .55 + (350 - 240) * .6}元，水费=${15 * 3.5 + 7 * 5}元，总计=${240 * .55 + 110 * .6 + 15 * 3.5 + 7 * 5}元`,
    32: (25000 - 4500 - 5000 - 2000 - 1000) * .2 - 1410,
    33: `盈亏平衡=${150000 / (200 - 80)}件，单月盈利=第${[500, 1000, 2000].findIndex(q => q * 120 - 150000 > 0) + 1}月，回收投资=第${3 + Math.ceil((2000000 - [500, 1000, 2000].reduce((sum, q) => sum + q * 120 - 150000, 0)) / (3500 * 120 - 150000))}月`,
    34: round(10000 - 2 * (10000 / 22) - 2 * 50 + 2 * 2 * (10000 / 22)),
    35: `结论=错误，今年=${100 * .5 * 1.5}万，增长率=${(.5 * 1.5 - 1) * 100}%，错误名称=百分比基数谬误`,
  };
  for (const [id, answer] of Object.entries(expected)) {
    it(`RM-CN-${id}: independently derived answer passes`, async () => {
      expect((scenario(Number(id)).requirements as any).answer).toEqual(answer);
      expect(await accuracy(Number(id), `ANSWER: ${answer}`)).toBe(100);
    });
  }
  it('RM-CN-004 uses non-overlapping tiers and cents without intermediate rounding', () => {
    expect(supply).toBe(470000); expect(member).toBe(446500);
    expect(final).toBe(497776.30);
    // A second calculation, entirely in integer cents and percentage multipliers.
    expect((44950000n * 113n * 98n) / 10000n).toBe(49777630n);
  });
  it('RM-CN-011 follows nearest-neighbour edges and adds every leg including return', async () => {
    const edges: [string, string, number][] = [['仓库','A',3],['仓库','B',5],['仓库','C',4],['A','B',2],['A','C',6],['A','D',4],['B','C',3],['B','E',7],['C','D',2],['C','E',5],['D','E',3],['D','仓库',6],['E','仓库',4]];
    const distance = (a: string, b: string) => edges.find(([x,y]) => (x===a && y===b)||(x===b && y===a))?.[2] ?? Infinity;
    const unvisited = new Set(['A','B','C','D','E']); const route=['仓库']; let sum=0;
    while(unvisited.size) { const last=route[route.length-1]; const next=[...unvisited].sort((a,b)=>distance(last,a)-distance(last,b))[0]; sum+=distance(last,next); route.push(next); unvisited.delete(next); }
    sum+=distance(route[route.length-1],'仓库');route.push('仓库');
    expect(sum).toBe(17); expect(await accuracy(11,`ANSWER: 路线=${route.join('-')}，总距离=${sum}km`)).toBe(100);
  });
  it('RM-CN-012 checks the stated Johnson order against all 120 schedules', async () => {
    const jobs: Record<string,[number,number]>={J1:[3,6],J2:[5,2],J3:[1,2],J4:[6,4],J5:[7,1]};
    const duration=(order:string[])=>{let m1=0,m2=0;for(const job of order){m1+=jobs[job][0];m2=Math.max(m1,m2)+jobs[job][1];}return m2;};
    const best=Math.min(...permutations(Object.keys(jobs)).map(duration));
    expect(best).toBe(23);expect(duration(['J3','J1','J4','J2','J5'])).toBe(best);
    expect(await accuracy(12,`ANSWER: 顺序=J3-J1-J4-J2-J5，最短完工时间=${best}小时`)).toBe(100);
  });
  it('RM-CN-023 enumerates distinct shows; treating same-type shows as identical gives 3, never 4', async () => {
    const valid=permutations(['S1','S2','D1','D2','C','M']).filter(p=>p[0].startsWith('S')&&p[5]==='M'&&!['C'].includes(p[1])&&p[2]!=='C'&&!p.slice(1).some((v,i)=>v.startsWith('D')&&p[i].startsWith('D')));
    expect(valid).toHaveLength(12);expect(new Set(valid.map(p=>p.map(v=>v[0]).join(''))).size).toBe(3);
    expect(await accuracy(23,`ANSWER: ${valid.length}种`)).toBe(100);
  });
  it('RM-CN-024 uniquely satisfies the one-truth constraint', async () => {
    const solutions=['甲','乙','丙','丁'].filter(who=>[who==='乙',who==='丁',who!=='丙',who!=='丁'].filter(Boolean).length===1);
    expect(solutions).toEqual(['丙']);expect(await accuracy(24,'ANSWER: 偷吃者=丙，说真话者=丁')).toBe(100);
  });
  it('RM-CN-025 finds the minimum crossings by BFS over legal states', async () => {
    const queue: Array<[number, number]>=[[0,0]], seen=new Set([0]);let answer=-1;
    while(queue.length){const [state,steps]=queue.shift()!;if(state===15){answer=steps;break;}const f=state&1;
      for(const item of [0,2,4,8]){if(item&&!!(state&item)!==!!f)continue;const next=state^1^item;const bits=[1,2,4,8].map(b=>!!(next&b));if((bits[1]===bits[2]&&bits[0]!==bits[2])||(bits[2]===bits[3]&&bits[0]!==bits[2])||seen.has(next))continue;seen.add(next);queue.push([next,steps+1]);}}
    expect(answer).toBe(7);expect(await accuracy(25,`ANSWER: ${answer}次`)).toBe(100);
  });
  it('RM-CN-029 computes both profit metrics instead of confusing output with profit', async () => {
    const rows=[['A',20,1000,8000,150],['B',15,900,9000,180],['C',25,1500,7500,120],['D',10,400,10000,250],['E',30,1800,7000,100]] as const;
    const total=(r:typeof rows[number])=>r[2]*r[4]-r[1]*r[3];
    const bestTotal=[...rows].sort((a,b)=>total(b)-total(a))[0][0];
    const bestPerson=[...rows].sort((a,b)=>total(b)/b[1]-total(a)/a[1])[0][0];
    const production=rows.reduce((s,r)=>s+r[2],0)/rows.reduce((s,r)=>s+r[1],0);
    expect(await accuracy(29,`ANSWER: 人均利润最高=${bestPerson}部门，总利润最高=${bestTotal}部门，人均产出=${production}件`)).toBe(100);
  });
});

describe('strict answer-contract regressions', () => {
  it('prefers the final ANSWER line over intermediate equations and earlier answers', async () => {
    expect(await accuracy(4,'小计 = 470000\nANSWER: 442717元\n会员价 = 446500\nANSWER: 497776.30元')).toBe(100);
    expect(await accuracy(4,'ANSWER: 497776.30元\nANSWER: 无法确定')).toBe(0);
    expect(await accuracy(4,'ANSWER: 497776.30元\nANSWER:')).toBe(0);
    expect(await accuracy(4,'ANSWER:\n497776.30元')).toBe(0);
    expect(await accuracy(4,'ANSWER: 497776.30元\n以上是我的答案。')).toBe(0);
    expect(await accuracy(4,'ANSWER: 497776.30元\n\n   ')).toBe(100);
  });
  it('checks cents, thousands separators and malformed numeric suffixes', async () => {
    for(const s of ['497776.3','497776.30元','497,776.30元','49.77763万元','0.004977763亿元','4.977763e5元','+0497776.3000元']) expect(await accuracy(4,`ANSWER: ${s}`)).toBe(100);
    for(const s of ['442717元','497776.29元','497776.31元','497776.30或442717元','497776.30oops','497776.30%','497776.30次','Infinity','NaN']) expect(await accuracy(4,`ANSWER: ${s}`)).toBe(0);
  });
  it('rejects even sub-cent differences and precision hidden by binary floating-point parsing', async () => {
    for (const s of ['497776.30000000001元', '497776.29999999999元', '49.77763000000000000001万元', '497776.304元']) {
      expect(await accuracy(4, `ANSWER: ${s}`)).toBe(0);
    }
    const exact = { ...scenario(4), requirements: { answer: '9007199254740993' } } as unknown as Scenario;
    expect((await evaluator.evaluate(exact, 'ANSWER: 9007199254740993.0', meta)).axisScores?.answer_accuracy).toBe(100);
    expect((await evaluator.evaluate(exact, 'ANSWER: 9007199254740992', meta)).axisScores?.answer_accuracy).toBe(0);
  });
  it('normalizes each labelled numeric field but never rounds a candidate into the correct answer', async () => {
    expect(await accuracy(2,'ANSWER: 含税总额114,883.00元，不含税总额101666.3700元，增值税额13216.630元')).toBe(100);
    expect(await accuracy(2,'ANSWER: 含税总额114883元，不含税总额101666.38元，增值税额13216.63元')).toBe(0);
    expect(await accuracy(2,'ANSWER: 含税总额114883元，不含税总额101666.370000000001元，增值税额13216.63元')).toBe(0);
    expect(await accuracy(15,'ANSWER: 同比30.0%，环比-13.30%，全年5850.00万，Q4占比30.80%')).toBe(100);
    expect(await accuracy(15,'ANSWER: 同比30%，环比-13.333333%，全年5850万，Q4占比30.8%')).toBe(0);
  });
  it('preserves dates and full multi-value answers; one wrong digit cannot earn similarity credit', async () => {
    expect(await accuracy(8,'计算共34天 = 2024\nANSWER: 2024年04月18日')).toBe(100);
    expect(await accuracy(8,'ANSWER: 2024年04月19日')).toBe(0);
    expect(await accuracy(2,'ANSWER: 含税总额114883元，不含税总额901666.37元，增值税额13216.63元')).toBe(0);
    expect(await accuracy(2,'ANSWER: 含税总额114883元')).toBe(0);
    expect(await accuracy(5,'ANSWER: 单利利息4125元，单利本息54125元，复利本息54269元')).toBe(0);
    expect(await accuracy(7,'ANSWER: A=109万，B=114.24万，C=108.47万，B年化=4.74%，最高=B')).toBe(0);
  });
  it('reproduces both directions of historical score pollution', async () => {
    const s={...scenario(4), requirements:{answer:442717},scoring:{type:'exact_answer_line',tolerance:1,toleranceMode:'absolute'}} as unknown as Scenario;
    expect((await evaluator.evaluate(s,'ANSWER: 497776.30元',meta)).totalScore).toBe(10);
    expect((await evaluator.evaluate(s,'ANSWER: 442717元',meta)).totalScore).toBe(100);
    (s.scoring as any).toleranceMode='relative';
    expect((await evaluator.evaluate(s,'ANSWER: 0元',meta)).axisScores?.answer_accuracy).toBe(100);
  });
  it('versions all changed contracts and quarantines unresolved prompts', () => {
    const math=scenarios.filter(s=>s.dimension==='reasoning_math');expect(math).toHaveLength(34);
    expect(math.filter(s=>s.status==='ambiguous').map(s=>s.id)).toEqual(['RM-CN-013','RM-CN-014','RM-CN-028','RM-CN-031']);
    expect(math.filter(s=>s.status==='valid')).toHaveLength(30);
    for(const s of math){expect(s.scenarioVersion).toBe('3.0.0');expect(s.graderVersion).toBe('exact_answer_v3');expect((s.scoring as any).tolerance).toBe(0);expect(s.scenarioHash).toBe(hashScenarioShort(s));}
  });
  it('states the final-line format and rounding rules in the prompts', () => {
    for(const s of scenarios.filter(s=>s.dimension==='reasoning_math')) {
      expect(s.promptTemplate).toContain('最后一个非空行');
      expect(s.promptTemplate).toContain('字段名称和字段顺序');
      expect(s.promptTemplate).toContain('不附加解释、计算过程或多个候选答案');
      expect(s.promptTemplate).toContain('数值等价的表示方式');
    }
    for(const n of [2,4,5,7,15,16,17,18,19,21,34]) expect(scenario(n).promptTemplate).toContain('四舍五入');
    expect(scenario(21).promptTemplate).toContain('向上取整');
  });
});
