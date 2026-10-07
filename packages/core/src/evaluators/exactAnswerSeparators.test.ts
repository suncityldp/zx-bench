import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Scenario, OutputMetadata } from '@zxbench/types';
import { exactAnswerLineEvaluator, normalizeSkeletonSeparators } from './exactAnswerLine.js';

// 题集源：data/scenarios/benchmark.json（与 dataExtractionV3 / restoredMathQuestions 测试同一来源）
const bank: Scenario[] = JSON.parse(readFileSync(new URL('../../../../data/scenarios/benchmark.json', import.meta.url), 'utf8'));
const scenario = (id: string): Scenario => bank.find((s) => s.id === id)!;
const meta = { truncated: false, incomplete: false } as OutputMetadata;
// These regressions preserve the pre-review, all-or-nothing contract.
const legacyScenario = (id:string):Scenario => ({...scenario(id),graderVersion:'exact_answer_v4',
  scoring:{...scenario(id).scoring,mathReviewPolicy:undefined} as Scenario['scoring']});

/** 取 answer_accuracy 轴分（strict 模式下恒为 0 或 100） */
const acc = async (id: string, answer: string) =>
  (await exactAnswerLineEvaluator.evaluate(legacyScenario(id), `ANSWER: ${answer}`, meta)).axisScores?.answer_accuracy;

/** 取计算后的总分（format_valid 100 → 0.1×100 + 0.9×acc） */
const total = async (id: string, answer: string) =>
  (await exactAnswerLineEvaluator.evaluate(legacyScenario(id), `ANSWER: ${answer}`, meta)).totalScore;

describe('strict 答案比较 —— 分隔符等价类（RM-CN-012 回归）', () => {
  // 2026-09-15 run 实测：模型最后一行输出与 gold 只差「列表分隔符」（逗号 vs 连字符），
  // 被判 answer_accuracy=0 → det 10 / 总分 15，而 AI Judge 独立给 100。
  const modelLine = '顺序=J3,J1,J4,J2,J5，最短完工时间=23小时';

  it('RM-CN-012：连字符与逗号是等价的列表分隔符（原判 15 分的假阴性）', async () => {
    expect(scenario('RM-CN-012').requirements).toMatchObject({
      answer: '顺序=J3-J1-J4-J2-J5，最短完工时间=23小时',
    });
    expect(await acc('RM-CN-012', modelLine)).toBe(100);
    expect(await total('RM-CN-012', modelLine)).toBe(100);
  });

  it('分隔符归一不放宽字段顺序与取值', async () => {
    // 顺序错 → 0（分隔符归一不得吞掉顺序差异）
    expect(await acc('RM-CN-012', '顺序=J1,J3,J4,J2,J5，最短完工时间=23小时')).toBe(0);
    // 另换一个合法 Johnson 序（J1-J3 互换）→ 0
    expect(await acc('RM-CN-012', '顺序=J3-J4-J1-J2-J5，最短完工时间=23小时')).toBe(0);
    // 数值错 → 0
    expect(await acc('RM-CN-012', '顺序=J3,J1,J4,J2,J5，最短完工时间=24小时')).toBe(0);
    // 字段缺失 → 0（值个数不一致）
    expect(await acc('RM-CN-012', '顺序=J3,J1,J4,J2,J5')).toBe(0);
  });

  it('RM-CN-011：路径分隔符同样归一，但总距离必须一致', async () => {
    const gold = '路线=仓库-A-B-C-D-E-仓库，总距离=17km';
    expect(scenario('RM-CN-011').requirements).toMatchObject({ answer: gold });
    expect(await acc('RM-CN-011', '路线=仓库,A,B,C,D,E,仓库，总距离=17km')).toBe(100);
    expect(await acc('RM-CN-011', gold)).toBe(100);
    expect(await acc('RM-CN-011', '路线=仓库,A,B,C,D,E,仓库，总距离=18km')).toBe(0);
  });

  it('负号不是分隔符：符号仍参与比较', async () => {
    const gold = '结论=错误，今年=75万，增长率=-25%，错误类型=A';
    expect(scenario('RM-CN-035').requirements).toMatchObject({ answer: gold });
    // 完全一致 → 100
    expect(await acc('RM-CN-035', gold)).toBe(100);
    // 丢掉负号 → 0（若负号被误当分隔符吃掉，这里会错误地判 100）
    expect(await acc('RM-CN-035', '结论=错误，今年=75万，增长率=25%，错误类型=A')).toBe(0);
  });

  it('normalizeSkeletonSeparators 单元契约', () => {
    // 连字符 / 顿号 / 分号 / 全角逗号 → 半角逗号
    expect(normalizeSkeletonSeparators('J3-J1-J4')).toBe('J3,J1,J4');
    expect(normalizeSkeletonSeparators('A和B、D和E')).toBe('A和B,D和E');
    expect(normalizeSkeletonSeparators('a;b；c')).toBe('a,b,c');
    // 骨架里的数字已是 `#`，负号不在骨架中出现
    expect(normalizeSkeletonSeparators('结论=错误,今年=#万,增长率=#%,错误类型=A'))
      .toBe('结论=错误,今年=#万,增长率=#%,错误类型=A');
    // 等号 / 冒号 / 百分号不参与分隔符归一
    expect(normalizeSkeletonSeparators('A=#%')).toBe('A=#%');
  });
});
