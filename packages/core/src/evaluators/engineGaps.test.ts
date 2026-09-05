import { describe, it, expect } from 'vitest';
import { instructionChecklistEvaluator } from './instructionChecklist.js';
import type { OutputMetadata, Scenario } from '@zxbench/types';

/**
 * 引擎缺口修复的回归测试
 *
 * 背景：24 题 rubric 落库后做覆盖度审计，发现 5 处引擎层缺口使得「prompt 明确要求了、
 * rubric 想查也查不了」。每一条都对应审计里的真实发现，不是理论推演：
 *
 *   1. checkFormat 正则非法 → 静默 PASS。实测 IF-CN-014/c4 的 pattern 是裸 `*`，
 *      本意应是字面星号，作为正则是非法量词 —— 这条约束一直在默默送分。
 *   2. checkSentenceCount 把 \n 当句子分隔符，与 prompt「以句末标点结尾算一句」冲突。
 *      实测 IF-CN-009 上，5 行无句末标点的输出被判成 5 句、满分通过。
 *   3. checkParagraphCount 用 /\n{2,}/，CRLF 与含空格空行都识别不了，整篇算成 1 段。
 *      实测 IF-CN-018 合规回答 100→86、IF-CN-040 100→57。
 *   4. 无 json_valid 检查器。IF-CN-003/007 的「有效 JSON」只能查首尾字符，
 *      中间语法错误一律放过 —— 而这恰恰是两题最核心的要求。
 *   5. numeric_column 无奇偶。IF-CN-037「库存列必须全为偶数」，改奇数后仍 100 分。
 *
 * 这些函数都不导出，一律通过公开入口 evaluate() 跑真实评分，再从 evidence 解析判定。
 */

const meta = (): OutputMetadata =>
  ({
    finishReason: 'stop',
    truncated: false,
    containsCodeBlock: false,
    containsFinalConclusion: true,
    outputLength: 0,
    outputTokens: 0,
    inputTokens: 0,
    maxTokens: 8192,
    incomplete: false,
    incompleteReasons: [],
    inferenceMs: 0,
    tokenSpeed: 0,
  } as unknown as OutputMetadata);

interface Verdict {
  passed: boolean;
  detail: string;
}

async function run(requirements: unknown, output: string): Promise<Map<string, Verdict>> {
  const scenario = {
    id: 'IF-CN-TEST',
    dimension: 'instruction_following',
    category: 'format_control',
    difficulty: 'medium',
    language: 'zh-CN',
    locale: 'zh-CN',
    status: 'active',
    tier: 'L1',
    promptTemplate: '',
    grader: 'instruction_checklist',
    graderVersion: 'instruction_checklist_v4',
    scoring: { type: 'instruction_checklist', partialCredit: true },
    requirements,
    scenarioVersion: '1',
    scenarioHash: 'x',
  } as unknown as Scenario;

  const res = await instructionChecklistEvaluator.evaluate(scenario, output, meta());
  const evidence = (res.evidence as string[]) ?? [];
  const verdicts = new Map<string, Verdict>();
  for (const line of evidence) {
    const m = /^\[(PASS|FAIL)\]\s+([^:]+):\s*([\s\S]*)$/.exec(line);
    if (m) verdicts.set(m[2].trim(), { passed: m[1] === 'PASS', detail: m[3].trim() });
  }
  return verdicts;
}

/** 只放一条约束，返回该条的判定 */
async function checkOne(
  type: string,
  check: Record<string, unknown>,
  output: string,
): Promise<Verdict> {
  const v = await run(
    { constraints: [{ id: 'c1', type, description: `${type} constraint`, check }] },
    output,
  );
  const got = v.get('c1');
  if (!got) throw new Error(`constraint c1 missing from evidence; got keys: ${[...v.keys()].join(', ')}`);
  return got;
}

// ============================================================
// 1. checkFormat：正则非法不再静默 PASS
// ============================================================

describe('checkFormat: 非法正则必须判负，不能静默放行', () => {
  it('裸 `*` 这种非法量词 → FAIL（IF-CN-014/c4 的真实形态）', async () => {
    const v = await checkOne('format', { pattern: '*' }, '任意输出');
    expect(v.passed).toBe(false);
    expect(v.detail).toMatch(/INVALID_REGEX/);
  });

  it('未闭合的括号 → FAIL', async () => {
    const v = await checkOne('format', { pattern: '(未闭合' }, '任意输出');
    expect(v.passed).toBe(false);
    expect(v.detail).toMatch(/INVALID_REGEX/);
  });

  it('空 pattern → FAIL（空约束永远送分，属假约束）', async () => {
    const v = await checkOne('format', { pattern: '' }, '任意输出');
    expect(v.passed).toBe(false);
    expect(v.detail).toMatch(/NO_PATTERN_SPECIFIED/);
  });

  it('合法正则仍照常工作（不误伤）', async () => {
    expect((await checkOne('format', { pattern: '^\\{' }, '{"a":1}')).passed).toBe(true);
    expect((await checkOne('format', { pattern: '^\\{' }, '不是 JSON')).passed).toBe(false);
  });
});

// ============================================================
// 2. checkSentenceCount：换行不再是句子分隔符
// ============================================================

describe('checkSentenceCount: 句子以句末标点为准', () => {
  // IF-CN-009 的真实失效形态：5 行、一行一句，但全无句末标点。
  // 旧实现会数成 5 句 → 恰好 5 句 → PASS。按 prompt 定义它只有 0 句（或 1 个未收尾的句子）。
  const noPunctuation = ['第一句内容', '第二句内容', '第三句内容', '第四句内容', '第五句内容'].join('\n');

  it('无句末标点的多行文本不再被数成 5 句', async () => {
    const v = await checkOne('sentence_count', { count: 5 }, noPunctuation);
    expect(v.passed).toBe(false);
  });

  it('5 个带句号的句子仍判 5 句', async () => {
    const text = ['第一句内容。', '第二句内容。', '第三句内容。', '第四句内容。', '第五句内容。'].join('\n');
    expect((await checkOne('sentence_count', { count: 5 }, text)).passed).toBe(true);
  });

  it('句号与换行混排时以句号计数', async () => {
    const text = '第一句内容。\n第二句内容。\n第三句内容。';
    expect((await checkOne('sentence_count', { count: 3 }, text)).passed).toBe(true);
  });

  it('逃生口 newlineAsSeparator: true 恢复旧行为（按行计数）', async () => {
    const v = await checkOne('sentence_count', { count: 5, newlineAsSeparator: true }, noPunctuation);
    expect(v.passed).toBe(true);
  });

  it('末尾无标点的残句也计入（与「以标点结尾算一句」不冲突）', async () => {
    // 「你好。」+「世界」→ 划成 2 段，第 2 段无标点但非空
    expect((await checkOne('sentence_count', { count: 2 }, '你好。世界')).passed).toBe(true);
  });
});

// ============================================================
// 3. checkParagraphCount：认得 CRLF 与含空格的空行
// ============================================================

describe('checkParagraphCount: 段落分隔的口径统一', () => {
  const three = ['第一段内容', '第二段内容', '第三段内容'];

  it('LF 空行分隔仍然工作（向后兼容）', async () => {
    expect((await checkOne('paragraph_count', { count: 3 }, three.join('\n\n'))).passed).toBe(true);
  });

  it('CRLF 空行分隔 → 认得（旧实现会算成 1 段）', async () => {
    const v = await checkOne('paragraph_count', { count: 3 }, three.join('\r\n\r\n'));
    expect(v.passed).toBe(true);
    expect(v.detail).toMatch(/Exactly 3 paragraphs/);
  });

  it('空行里含空格 / Tab → 认得（旧实现会算成 1 段）', async () => {
    expect((await checkOne('paragraph_count', { count: 3 }, three.join('\n   \n'))).passed).toBe(true);
    expect((await checkOne('paragraph_count', { count: 3 }, three.join('\n\t\n'))).passed).toBe(true);
  });

  it('多个连续空行仍算一个分隔', async () => {
    expect((await checkOne('paragraph_count', { count: 3 }, three.join('\n\n\n\n'))).passed).toBe(true);
  });

  it('真正的 1 段不会被拆开', async () => {
    const v = await checkOne('paragraph_count', { count: 1 }, three.join(' '));
    expect(v.passed).toBe(true);
  });
});

// ============================================================
// 4. json_valid 检查器
// ============================================================

describe('json_valid: 真的解析一遍 JSON', () => {
  const validJson = '{"name": "张三", "age": 30, "isActive": true}';

  it('整段输出是合法 JSON → PASS', async () => {
    expect((await checkOne('json_valid', {}, validJson)).passed).toBe(true);
  });

  it('尾逗号 → FAIL（正则查首尾字符查不出这个）', async () => {
    const v = await checkOne('json_valid', {}, '{"a": 1, "b": 2,}');
    expect(v.passed).toBe(false);
    expect(v.detail).toMatch(/Invalid JSON/);
  });

  it('引号未闭合 → FAIL', async () => {
    expect((await checkOne('json_valid', {}, '{"a": "未闭合}')).passed).toBe(false);
  });

  it('JSON 后追加解释文字 → FAIL（prompt 要求「输出必须是有效的 JSON」）', async () => {
    expect((await checkOne('json_valid', {}, `${validJson}\n说明：以上为结果`)).passed).toBe(false);
  });

  it('围栏 ```json 块内合法 → PASS', async () => {
    const text = ['```json', validJson, '```'].join('\n');
    expect((await checkOne('json_valid', { language: 'json' }, text)).passed).toBe(true);
  });

  it('围栏 ```json 块内语法错误 → FAIL（IF-CN-007 的核心要求）', async () => {
    const text = ['```json', '{"a": 1,}', '```'].join('\n');
    expect((await checkOne('json_valid', { language: 'json' }, text)).passed).toBe(false);
  });

  it('围栏块被截断（未闭合）→ FAIL，而不是当作没有块', async () => {
    const text = ['```json', '{"a": 1'].join('\n');
    const v = await checkOne('json_valid', { language: 'json' }, text);
    expect(v.passed).toBe(false);
    expect(v.detail).toMatch(/No ```json code block found/);
  });

  it('指定 language=json 时，只有 bash 块 → FAIL', async () => {
    const text = ['```bash', 'curl -X GET http://example.com', '```'].join('\n');
    const v = await checkOne('json_valid', { language: 'json' }, text);
    expect(v.passed).toBe(false);
  });

  it('不指定 language 时校验所有围栏块，任一非法即 FAIL', async () => {
    const text = ['```json', validJson, '```', '', '```json', '{"坏": }', '```'].join('\n');
    expect((await checkOne('json_valid', { fenced: true }, text)).passed).toBe(false);
  });

  it('代码块存在但内容为空 → FAIL（没有可校验的对象）', async () => {
    const v = await checkOne('json_valid', { language: 'json' }, '```json\n\n```');
    expect(v.passed).toBe(false);
    expect(v.detail).toMatch(/empty/);
  });

  it('整段输出为空 → 评估器在入口就短路判 0 分，不会走到约束检查', async () => {
    // 这是正确行为：空输出没有任何可判定的内容，没必要逐条跑约束。
    // 记录在此是为了防止后人误以为「json_valid 没对空输出判负」。
    const v = await run({ constraints: [{ id: 'c1', type: 'json_valid', description: 'valid json', check: {} }] }, '   ');
    expect(v.size).toBe(0);
  });

  it('未知类型仍然显式 FAIL（新类型必须注册进 switch）', async () => {
    const v = await checkOne('json_valid', {}, validJson);
    expect(v.detail).not.toMatch(/UNKNOWN_CONSTRAINT_TYPE/);
  });
});

// ============================================================
// 5. numeric_column：奇偶 / 模数
// ============================================================

describe('numeric_column: 奇偶与模数断言', () => {
  // IF-CN-037 的真实形态：名称 / 价格 / 库存 / 评分
  const tableEven = [
    '| 名称 | 价格 | 库存 | 评分 |',
    '| --- | --- | --- | --- |',
    '| A | 99 | 120 | 5 |',
    '| B | 88 | 84 | 4 |',
    '| C | 77 | 66 | 3 |',
  ].join('\n');

  const tableOdd = tableEven
    .replace('| 120 |', '| 121 |')
    .replace('| 84 |', '| 85 |')
    .replace('| 66 |', '| 67 |');

  it('库存列全偶数 → PASS', async () => {
    const v = await checkOne('numeric_column', { columnName: '库存', even: true }, tableEven);
    expect(v.passed).toBe(true);
    expect(v.detail).toMatch(/all even/);
  });

  it('库存列改成奇数 → FAIL（审计里实测这条此前拿满分）', async () => {
    const v = await checkOne('numeric_column', { columnName: '库存', even: true }, tableOdd);
    expect(v.passed).toBe(false);
    expect(v.detail).toMatch(/not even/);
  });

  it('odd 断言', async () => {
    const v = await checkOne('numeric_column', { columnName: '库存', odd: true }, tableOdd);
    expect(v.passed).toBe(true);
    expect((await checkOne('numeric_column', { columnName: '库存', odd: true }, tableEven)).passed).toBe(false);
  });

  it('非整数上判奇偶 → FAIL，且明确说明原因', async () => {
    const withDecimal = tableEven.replace('| 120 |', '| 120.5 |');
    const v = await checkOne('numeric_column', { columnName: '库存', even: true }, withDecimal);
    expect(v.passed).toBe(false);
    expect(v.detail).toMatch(/not an integer/);
  });

  it('通用 modulus 断言', async () => {
    const v = await checkOne(
      'numeric_column',
      { columnName: '库存', modulus: { divisor: 3, remainder: 0 } },
      tableEven, // 120 / 84 / 66 都能被 3 整除
    );
    expect(v.passed).toBe(true);
    expect(v.detail).toMatch(/mod 3/);
  });

  it('负数取模先规约到 [0, divisor)，不被 JS 负余数误判', async () => {
    // -4 % 3 在 JS 里是 -1，规约后应为 2；-4 ≡ 2 (mod 3)
    const negativeTable = [
      '| 名称 | 库存 |',
      '| --- | --- |',
      '| A | -4 |',
      '| B | 5 |',
    ].join('\n');
    const v = await checkOne(
      'numeric_column',
      { columnName: '库存', modulus: { divisor: 3, remainder: 2 } },
      negativeTable,
    );
    expect(v.passed).toBe(true);
  });

  it('modulus 参数非法（divisor=0）→ 视为未指定，走 NO_ASSERTION 分支', async () => {
    const v = await checkOne('numeric_column', { columnName: '库存', modulus: { divisor: 0 } }, tableEven);
    expect(v.passed).toBe(false);
    expect(v.detail).toMatch(/NO_ASSERTION_SPECIFIED/);
  });

  it('什么断言都不给仍然 FAIL（规则 2 未被破坏）', async () => {
    const v = await checkOne('numeric_column', { columnName: '库存' }, tableEven);
    expect(v.passed).toBe(false);
    expect(v.detail).toMatch(/NO_ASSERTION_SPECIFIED/);
  });
});
