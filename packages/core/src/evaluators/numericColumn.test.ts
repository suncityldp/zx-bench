import { describe, it, expect } from 'vitest';
import { instructionChecklistEvaluator } from './instructionChecklist.js';
import type { OutputMetadata, Scenario } from '@zxbench/types';

/**
 * numeric_column 约束检查器回归测试
 *
 * 背景：IF-CN-001「按 GDP 从高到低排序」、IF-CN-006「CSV 按面积从大到小排序」、
 * IF-CN-037「价格从高到低 + 评分只能是 1–5 整数」三道题的排序要求原本无处判定，
 * 而 checkConstraint 的 default 分支对未知类型是显式 FAIL —— 新类型必须真的注册进 switch。
 *
 * checkNumericColumn 不导出，因此一律通过公开入口 instructionChecklistEvaluator.evaluate()
 * 跑真实评分，再从返回的 evidence 里解析 [PASS] / [FAIL] 行。
 *
 * 三道题的真值都是小数（4.72 / 166.49 …），小数值是核心场景而非边角，故单独覆盖。
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

/** 跑一次评分，返回 constraintId -> { passed, detail } */
async function run(
  requirements: unknown,
  output: string,
): Promise<Map<string, Verdict>> {
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

/** 只放一条 numeric_column 约束，返回该条的判定 */
async function checkOne(
  check: Record<string, unknown>,
  output: string,
): Promise<Verdict> {
  const v = await run(
    { constraints: [{ id: 'c1', type: 'numeric_column', description: 'numeric column', check }] },
    output,
  );
  const got = v.get('c1');
  if (!got) throw new Error(`constraint c1 missing from evidence; got keys: ${[...v.keys()].join(', ')}`);
  return got;
}

// ===== 测试夹具 =====

/** IF-CN-001 形态：中文列名带全角括号，值为两位小数 */
const GDP_DESC_OK = [
  '| 城市 | GDP（万亿元） |',
  '| --- | --- |',
  '| 深圳 | 4.72 |',
  '| 苏州 | 4.16 |',
  '| 成都 | 3.24 |',
  '| 武汉 | 2.82 |',
].join('\n');

/** 与上面只有一处逆序（成都 3.24 排到武汉 2.82 后面） */
const GDP_DESC_BROKEN = [
  '| 城市 | GDP（万亿元） |',
  '| --- | --- |',
  '| 深圳 | 4.72 |',
  '| 苏州 | 4.16 |',
  '| 武汉 | 2.82 |',
  '| 成都 | 3.24 |',
].join('\n');

const GDP_ASC_OK = [
  '| 城市 | GDP（万亿元） |',
  '| --- | --- |',
  '| 武汉 | 2.82 |',
  '| 成都 | 3.24 |',
  '| 苏州 | 4.16 |',
  '| 深圳 | 4.72 |',
].join('\n');

/** IF-CN-006 形态：CSV，值为两位小数 */
const CSV_AREA_DESC_OK = [
  '省份,面积（万平方公里）',
  '新疆,166.49',
  '西藏,122.84',
  '内蒙古,118.30',
  '青海,72.23',
  '宁夏,48.60',
].join('\n');

/** IF-CN-037 形态：价格 + 评分两列 */
const PRICE_RATING_TABLE = [
  '| 商品 | 价格 | 评分 |',
  '| --- | --- | --- |',
  '| A | 1299 | 5 |',
  '| B | 899 | 4 |',
  '| C | 399 | 3 |',
].join('\n');

describe('numeric_column constraint', () => {
  it('registers the type in the switch (unknown types still FAIL explicitly)', async () => {
    // 若 numeric_column 没注册，default 分支会给出 UNKNOWN_CONSTRAINT_TYPE 并判负
    const ok = await checkOne(
      { columnName: 'GDP（万亿元）', order: 'desc' },
      GDP_DESC_OK,
    );
    expect(ok.passed).toBe(true);
    expect(ok.detail).not.toContain('UNKNOWN_CONSTRAINT_TYPE');
  });

  it('passes markdown desc ordering', async () => {
    const r = await checkOne({ columnName: 'GDP（万亿元）', order: 'desc' }, GDP_DESC_OK);
    expect(r.passed).toBe(true);
    expect(r.detail).toContain('4 values');
    expect(r.detail).toContain('descending');
  });

  it('fails markdown desc when a single pair is out of order', async () => {
    const r = await checkOne({ columnName: 'GDP（万亿元）', order: 'desc' }, GDP_DESC_BROKEN);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('not descending');
    // 点出具体行号和值：成都 3.24 在第 4 行，武汉 2.82 在第 3 行
    expect(r.detail).toContain('row 4 (3.24)');
    expect(r.detail).toContain('row 3 (2.82)');
  });

  it('passes markdown asc ordering', async () => {
    const r = await checkOne({ columnName: 'GDP（万亿元）', order: 'asc' }, GDP_ASC_OK);
    expect(r.passed).toBe(true);
    expect(r.detail).toContain('ascending');
  });

  it('fails asc when descending', async () => {
    const r = await checkOne({ columnName: 'GDP（万亿元）', order: 'asc' }, GDP_DESC_OK);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('not ascending');
  });

  it('rejects adjacent equal values when allowEqual is false', async () => {
    const table = [
      '| 城市 | GDP |',
      '| --- | --- |',
      '| 深圳 | 4.72 |',
      '| 苏州 | 4.72 |',
      '| 成都 | 3.24 |',
    ].join('\n');
    const r = await checkOne({ columnName: 'GDP', order: 'desc' }, table);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('==');
    expect(r.detail).toContain('row 2 (4.72) == row 1 (4.72)');
  });

  it('accepts adjacent equal values when allowEqual is true', async () => {
    const table = [
      '| 城市 | GDP |',
      '| --- | --- |',
      '| 深圳 | 4.72 |',
      '| 苏州 | 4.72 |',
      '| 成都 | 3.24 |',
    ].join('\n');
    const r = await checkOne({ columnName: 'GDP', order: 'desc', allowEqual: true }, table);
    expect(r.passed).toBe(true);
    expect(r.detail).toContain('equal allowed');
  });

  it('still rejects a real inversion when allowEqual is true', async () => {
    const r = await checkOne(
      { columnName: 'GDP（万亿元）', order: 'desc', allowEqual: true },
      GDP_DESC_BROKEN,
    );
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('not descending');
  });

  it('parses csv format', async () => {
    const r = await checkOne(
      { format: 'csv', columnName: '面积（万平方公里）', order: 'desc' },
      CSV_AREA_DESC_OK,
    );
    expect(r.passed).toBe(true);
    expect(r.detail).toContain('5 values');
    expect(r.detail).toContain('descending');
  });

  it('fails csv desc when out of order', async () => {
    const broken = [
      '省份,面积（万平方公里）',
      '新疆,166.49',
      '青海,72.23',
      '西藏,122.84',
    ].join('\n');
    const r = await checkOne(
      { format: 'csv', columnName: '面积（万平方公里）', order: 'desc' },
      broken,
    );
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('row 3 (122.84)');
  });

  it('supports a custom csv delimiter', async () => {
    const table = ['省份;面积', '新疆;166.49', '西藏;122.84', '内蒙古;118.30'].join('\n');
    const r = await checkOne(
      { format: 'csv', delimiter: ';', columnName: '面积', order: 'desc' },
      table,
    );
    expect(r.passed).toBe(true);
  });

  it('fails on unique violation', async () => {
    const table = [
      '| 排名 | 分数 |',
      '| --- | --- |',
      '| 1 | 90 |',
      '| 2 | 90 |',
      '| 3 | 80 |',
    ].join('\n');
    const r = await checkOne({ columnName: '分数', unique: true }, table);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('duplicate value 90');
    expect(r.detail).toContain('rows 1, 2');
  });

  it('passes unique when all values differ', async () => {
    const table = [
      '| 排名 | 分数 |',
      '| --- | --- |',
      '| 1 | 95 |',
      '| 2 | 90 |',
      '| 3 | 80 |',
    ].join('\n');
    const r = await checkOne({ columnName: '分数', unique: true }, table);
    expect(r.passed).toBe(true);
    expect(r.detail).toContain('unique');
  });

  it('fails when a value exceeds max', async () => {
    const table = [
      '| 商品 | 评分 |',
      '| --- | --- |',
      '| A | 5 |',
      '| B | 6 |',
    ].join('\n');
    const r = await checkOne({ columnName: '评分', min: 1, max: 5 }, table);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('row 2: 6 > max 5');
  });

  it('fails when a value is below min', async () => {
    const table = [
      '| 商品 | 评分 |',
      '| --- | --- |',
      '| A | 0 |',
      '| B | 4 |',
    ].join('\n');
    const r = await checkOne({ columnName: '评分', min: 1, max: 5 }, table);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('row 1: 0 < min 1');
  });

  it('passes when all values are within [min, max]', async () => {
    const r = await checkOne({ columnName: '评分', min: 1, max: 5 }, PRICE_RATING_TABLE);
    expect(r.passed).toBe(true);
    expect(r.detail).toContain('within [1, 5]');
  });

  it('accepts minValue / maxValue aliases', async () => {
    const table = ['| 商品 | 评分 |', '| --- | --- |', '| A | 9 |'].join('\n');
    const r = await checkOne({ columnName: '评分', minValue: 1, maxValue: 5 }, table);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('> max 5');
  });

  it('fails on integer violation (decimal value)', async () => {
    const table = [
      '| 商品 | 评分 |',
      '| --- | --- |',
      '| A | 5 |',
      '| B | 4.5 |',
    ].join('\n');
    const r = await checkOne({ columnName: '评分', integer: true }, table);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('row 2: 4.5 is not an integer');
  });

  it('passes integer when all values are whole numbers', async () => {
    const r = await checkOne({ columnName: '评分', integer: true, min: 1, max: 5 }, PRICE_RATING_TABLE);
    expect(r.passed).toBe(true);
    expect(r.detail).toContain('all integers');
  });

  it('handles decimal values correctly (core scenario: values are not integers)', async () => {
    // 小数精度：0.1 级别的差值必须能分辨，不能被当成相等而误判
    const table = [
      '| 城市 | 面积 |',
      '| --- | --- |',
      '| A | 166.49 |',
      '| B | 166.48 |',
      '| C | 48.60 |',
    ].join('\n');
    const r = await checkOne({ columnName: '面积', order: 'desc' }, table);
    expect(r.passed).toBe(true);
    expect(r.detail).toContain('3 values');

    const inverted = [
      '| 城市 | 面积 |',
      '| --- | --- |',
      '| A | 166.48 |',
      '| B | 166.49 |',
    ].join('\n');
    const bad = await checkOne({ columnName: '面积', order: 'desc' }, inverted);
    expect(bad.passed).toBe(false);
    expect(bad.detail).toContain('166.49');
  });

  it('fails when the column name is not found (never silently passes)', async () => {
    const r = await checkOne({ columnName: '不存在的列', order: 'desc' }, GDP_DESC_OK);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('not found');
    expect(r.detail).toContain('GDP（万亿元）'); // 把可用列名列出来
  });

  it('fails when columnName is given but hasHeader is false', async () => {
    const r = await checkOne({ columnName: 'GDP', order: 'desc', hasHeader: false }, GDP_DESC_OK);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('no header row available');
  });

  it('fails when there are no data rows at all', async () => {
    const headerOnly = ['| 城市 | GDP |', '| --- | --- |'].join('\n');
    const r = await checkOne({ columnName: 'GDP', order: 'desc' }, headerOnly);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('no parseable data row');
  });

  it('fails when every data row is unparseable', async () => {
    const table = [
      '| 城市 | GDP |',
      '| --- | --- |',
      '| 深圳 | 待定 |',
      '| 苏州 | N/A |',
    ].join('\n');
    const r = await checkOne({ columnName: 'GDP', order: 'desc' }, table);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('no parseable data row');
  });

  it('fails when a single row in the target column is unparseable', async () => {
    const table = [
      '| 城市 | GDP |',
      '| --- | --- |',
      '| 深圳 | 4.72 |',
      '| 苏州 | 待定 |',
      '| 成都 | 3.24 |',
    ].join('\n');
    const r = await checkOne({ columnName: 'GDP', order: 'desc' }, table);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('unparseable');
    expect(r.detail).toContain('row 2');
  });

  it('fails when no assertion is specified', async () => {
    const r = await checkOne({ columnName: 'GDP（万亿元）' }, GDP_DESC_OK);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('NO_ASSERTION_SPECIFIED');
  });

  it('skips markdown separator rows (they must not count as data rows)', async () => {
    const table = [
      '| 城市 | GDP |',
      '| :---: | :---: |',   // 居中对齐分隔行
      '| 深圳 | 4.72 |',
      '| 苏州 | 4.16 |',
      '| 成都 | 3.24 |',
      '| 武汉 | 2.82 |',
    ].join('\n');
    const r = await checkOne({ columnName: 'GDP', order: 'desc', minRows: 4 }, table);
    expect(r.passed).toBe(true);
    // 分隔行若被当成数据行，会是 unparseable 违规，或让 values 数 > 4
    expect(r.detail).toContain('4 values');
    expect(r.detail).not.toContain('unparseable');
  });

  it('skips ===-style separator rows too', async () => {
    const table = ['| A | v |', '| === | === |', '| x | 3 |', '| y | 2 |', '| z | 1 |'].join('\n');
    const r = await checkOne({ columnName: 'v', order: 'desc' }, table);
    expect(r.passed).toBe(true);
    expect(r.detail).toContain('3 values');
  });

  it('ignores non-table prose lines around the table', async () => {
    const table = [
      '下面是各城市 GDP 排名：',
      '',
      '| 城市 | GDP |',
      '| --- | --- |',
      '| 深圳 | 4.72 |',
      '| 苏州 | 4.16 |',
      '',
      '数据来源：统计局。',
    ].join('\n');
    const r = await checkOne({ columnName: 'GDP', order: 'desc' }, table);
    expect(r.passed).toBe(true);
    expect(r.detail).toContain('2 values');
  });

  it('parses currency symbols and thousands separators', async () => {
    const table = [
      '| 商品 | 价格 |',
      '| --- | --- |',
      '| A | ¥1,299 |',
      '| B | $899 |',
      '| C | €199 |',
      '| D | ￥99 |',
    ].join('\n');
    const r = await checkOne({ columnName: '价格', order: 'desc', min: 1, max: 9999 }, table);
    expect(r.passed).toBe(true);
    expect(r.detail).toContain('4 values');
    expect(r.detail).toContain('within [1, 9999]');
  });

  it('fails minRows when too few rows parsed', async () => {
    const table = ['| 城市 | GDP |', '| --- | --- |', '| 深圳 | 4.72 |'].join('\n');
    const r = await checkOne({ columnName: 'GDP', order: 'desc', minRows: 4 }, table);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('expected >= 4');
  });

  it('supports column index instead of column name', async () => {
    const r = await checkOne({ column: 1, order: 'desc' }, GDP_DESC_OK);
    expect(r.passed).toBe(true);
    expect(r.detail).toContain('#1');
  });

  it('supports hasHeader=false with column index', async () => {
    const table = ['| 深圳 | 4.72 |', '| 苏州 | 4.16 |', '| 成都 | 3.24 |'].join('\n');
    const r = await checkOne({ hasHeader: false, column: 1, order: 'desc' }, table);
    expect(r.passed).toBe(true);
    expect(r.detail).toContain('3 values');
  });

  it('reports every violation, not just the first', async () => {
    const table = [
      '| 商品 | 评分 |',
      '| --- | --- |',
      '| A | 9 |',
      '| B | 9 |',
      '| C | 0 |',
    ].join('\n');
    const r = await checkOne({ columnName: '评分', min: 1, max: 5, unique: true }, table);
    expect(r.passed).toBe(false);
    // 三条违规都要出现在 detail 里
    expect(r.detail).toContain('row 1: 9 > max 5');
    expect(r.detail).toContain('row 2: 9 > max 5');
    expect(r.detail).toContain('row 3: 0 < min 1');
    expect(r.detail).toContain('duplicate value 9');
  });

  it('combines order + integer for the IF-CN-037 shape', async () => {
    // 价格列从高到低 + 评分列只能是 1–5 的整数
    const v = await run(
      {
        constraints: [
          { id: 'price_desc', type: 'numeric_column', description: '价格从高到低', check: { columnName: '价格', order: 'desc' } },
          { id: 'rating_int', type: 'numeric_column', description: '评分 1-5 整数', check: { columnName: '评分', integer: true, min: 1, max: 5 } },
        ],
      },
      PRICE_RATING_TABLE,
    );
    expect(v.get('price_desc')?.passed).toBe(true);
    expect(v.get('rating_int')?.passed).toBe(true);

    const broken = [
      '| 商品 | 价格 | 评分 |',
      '| --- | --- | --- |',
      '| A | 899 | 4.5 |',
      '| B | 1299 | 5 |',
    ].join('\n');
    const v2 = await run(
      {
        constraints: [
          { id: 'price_desc', type: 'numeric_column', description: '价格从高到低', check: { columnName: '价格', order: 'desc' } },
          { id: 'rating_int', type: 'numeric_column', description: '评分 1-5 整数', check: { columnName: '评分', integer: true, min: 1, max: 5 } },
        ],
      },
      broken,
    );
    expect(v2.get('price_desc')?.passed).toBe(false);
    expect(v2.get('rating_int')?.passed).toBe(false);
  });
});

// ============================================================================
// 书写形式解耦：rubric 不能与答案的具体书写形式耦合 —— 内容相同、写法不同必须同样判过。
//
// 这两组用例来自实测误判：
//   1. 模型写表头 `**GDP（万亿元）**`（加粗）或 `GDP(万亿元)`（半角括号），
//      严格全等匹配会「找不到列」→ FAIL，但语义上这是完全正确的答案。
//   2. 模型在单元格里带单位写 `4.72万亿`，旧解析器 Number('4.72万亿') === NaN → FAIL。
// ============================================================================

describe('numeric_column: header name normalization', () => {
  it('matches a bolded header cell against a plain columnName', async () => {
    const table = [
      '| 商品 | **价格** |',
      '| --- | --- |',
      '| A | 1299 |',
      '| B | 899 |',
      '| C | 399 |',
    ].join('\n');
    const r = await checkOne({ columnName: '价格', order: 'desc' }, table);
    expect(r.passed).toBe(true);
    expect(r.detail).toContain('3 values');
  });

  it('matches a half-width-parenthesis header against a full-width columnName', async () => {
    const table = [
      '| 城市 | GDP(万亿元) |',
      '| --- | --- |',
      '| 深圳 | 4.72 |',
      '| 苏州 | 4.16 |',
      '| 成都 | 3.24 |',
    ].join('\n');
    // 配置里写全角、答案里写半角 —— 双向都要能匹配
    const r = await checkOne({ columnName: 'GDP（万亿元）', order: 'desc' }, table);
    expect(r.passed).toBe(true);

    const reverse = [
      '| 城市 | GDP（万亿元） |',
      '| --- | --- |',
      '| 深圳 | 4.72 |',
      '| 苏州 | 4.16 |',
    ].join('\n');
    const r2 = await checkOne({ columnName: 'GDP(万亿元)', order: 'desc' }, reverse);
    expect(r2.passed).toBe(true);
  });

  it('matches a backticked header cell', async () => {
    const table = [
      '| 城市 | `GDP` |',
      '| --- | --- |',
      '| 深圳 | 4.72 |',
      '| 苏州 | 4.16 |',
    ].join('\n');
    const r = await checkOne({ columnName: 'GDP', order: 'desc' }, table);
    expect(r.passed).toBe(true);
  });

  it('lists NORMALIZED column names in the not-found detail', async () => {
    const table = [
      '| **城市名称** | **GDP(万亿元)** | **常住人口(万人)** |',
      '| --- | --- | --- |',
      '| 深圳 | 4.72 | 1779 |',
      '| 苏州 | 4.16 | 1295 |',
    ].join('\n');
    const r = await checkOne({ columnName: '面积（平方公里）', order: 'desc' }, table);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('not found');
    // 归一化后：** 去掉、半角括号转全角 —— 排查时看到的就是实际参与比较的字符串
    expect(r.detail).toContain('城市名称 | GDP（万亿元） | 常住人口（万人）');
    expect(r.detail).not.toContain('**');
    expect(r.detail).not.toContain('GDP(万亿元)');
  });

  it('does NOT let normalization mask a genuinely missing column', async () => {
    // 归一化只吃标记字符，不碰内容：'GDP' 依然不能匹配 'GDP（万亿元）'
    const r = await checkOne({ columnName: 'GDP', order: 'desc' }, GDP_DESC_OK);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('not found');
  });
});

describe('numeric_column: cell unit suffix', () => {
  it('accepts a column where every cell carries the same unit suffix', async () => {
    const table = [
      '| 城市 | GDP |',
      '| --- | --- |',
      '| 深圳 | 4.72万亿 |',
      '| 苏州 | 4.16万亿 |',
      '| 成都 | 3.24万亿 |',
    ].join('\n');
    const r = await checkOne({ columnName: 'GDP', order: 'desc' }, table);
    expect(r.passed).toBe(true);
    expect(r.detail).toContain('3 values');
    expect(r.detail).toContain('descending');
  });

  it('still catches a real inversion when units are present', async () => {
    const table = [
      '| 城市 | GDP |',
      '| --- | --- |',
      '| 深圳 | 4.72万亿 |',
      '| 苏州 | 3.24万亿 |',
      '| 成都 | 4.16万亿 |',
    ].join('\n');
    const r = await checkOne({ columnName: 'GDP', order: 'desc' }, table);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('row 3 (4.16)');
  });

  it('parses currency symbol + unit and uses the value for ordering', async () => {
    const table = [
      '| 商品 | 价格 |',
      '| --- | --- |',
      '| A | ¥1,299元 |',
      '| B | ￥899元 |',
      '| C | €199元 |',
    ].join('\n');
    const r = await checkOne({ columnName: '价格', order: 'desc', min: 1, max: 9999 }, table);
    expect(r.passed).toBe(true);
    expect(r.detail).toContain('3 values');
    expect(r.detail).toContain('within [1, 9999]');
  });

  it('fails on mixed unit suffixes, and says so explicitly', async () => {
    // 关键点：41600 > 4.72，剥掉后缀后「数值」是降序的 —— 单纯比数值会给出假的 PASS。
    // 必须判负，且 detail 必须点明是单位不一致，而不是排序违规。
    const table = [
      '| 城市 | GDP |',
      '| --- | --- |',
      '| 深圳 | 41600亿 |',
      '| 苏州 | 4.72万亿 |',
    ].join('\n');
    const r = await checkOne({ columnName: 'GDP', order: 'desc' }, table);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('inconsistent unit suffixes');
    expect(r.detail).toContain('"亿"');
    expect(r.detail).toContain('"万亿"');
    expect(r.detail).toContain('cannot compare magnitudes safely');
    // 不是被排序断言拦下的
    expect(r.detail).not.toContain('not descending');
  });

  it('fails on mixed unit suffixes even without an order assertion', async () => {
    const table = [
      '| 城市 | GDP |',
      '| --- | --- |',
      '| 深圳 | 4.72万亿 |',
      '| 苏州 | 41600亿 |',
    ].join('\n');
    const r = await checkOne({ columnName: 'GDP', min: 1 }, table);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('inconsistent unit suffixes');
  });

  it('treats a uniformly-suffixed column and an unsuffixed column consistently', async () => {
    // 全部为空后缀 = 一致，不判负（回归保护：别把「无单位」也当成不一致）
    const r = await checkOne({ columnName: 'GDP（万亿元）', order: 'desc' }, GDP_DESC_OK);
    expect(r.passed).toBe(true);
    expect(r.detail).not.toContain('inconsistent unit suffixes');
  });

  it('still reports unparseable cells (no leading digit → null, unchanged)', async () => {
    const table = [
      '| 城市 | GDP |',
      '| --- | --- |',
      '| 深圳 | 4.72 |',
      '| 苏州 | 待定 |',
    ].join('\n');
    const r = await checkOne({ columnName: 'GDP', order: 'desc' }, table);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('unparseable');
  });

  it('parses markdown-bolded cell values (**4.72**) instead of calling them unparseable', async () => {
    // 模型常用加粗强调最大值，这是正确写法，判 unparseable 属于误判
    const table = [
      '| 城市 | GDP |',
      '| --- | --- |',
      '| 深圳 | **4.72** |',
      '| 苏州 | 4.16 |',
      '| 成都 | 3.24 |',
    ].join('\n');
    const r = await checkOne({ columnName: 'GDP', order: 'desc' }, table);
    expect(r.passed).toBe(true);
    expect(r.detail).toContain('descending');
  });

  it('still catches a real inversion when values are bolded', async () => {
    const table = [
      '| 城市 | GDP |',
      '| --- | --- |',
      '| 深圳 | **4.72** |',
      '| 苏州 | **3.24** |',
      '| 成都 | **4.16** |',
    ].join('\n');
    const r = await checkOne({ columnName: 'GDP', order: 'desc' }, table);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('not descending');
  });
});

describe('numeric_column: approximate qualifiers', () => {
  it('parses "约4.72" so magnitude ordering stays judgeable', async () => {
    // 约数修饰应由「禁止约数」那条约束单独判定；
    // 若在这里判 unparseable，一个「约」字会连带点掉排序约束，导致错误无法归因。
    const table = [
      '| 城市 | GDP（万亿元） |',
      '| --- | --- |',
      '| 上海 | 约4.72 |',
      '| 深圳 | 约3.46 |',
      '| 广州 | 约3.10 |',
    ].join('\n');
    const r = await checkOne({ columnName: 'GDP（万亿元）', order: 'desc' }, table);
    expect(r.passed).toBe(true);
    expect(r.detail).toContain('descending');
  });

  it('strips 大约 / ~ / ≈ / ca. and still orders correctly', async () => {
    const table = [
      '| 城市 | GDP |',
      '| --- | --- |',
      '| 上海 | 大约4.72 |',
      '| 深圳 | ~3.46 |',
      '| 广州 | ≈3.10 |',
      '| 北京 | ca.4.98 |',
    ].join('\n');
    // 注意：北京 4.98 最大却在最后 → 应当判负，证明前缀剥掉后数值确实参与了比较
    const r = await checkOne({ columnName: 'GDP', order: 'desc' }, table);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('not descending');
  });

  it('still enforces min/max on approximate values', async () => {
    const table = [
      '| 商品 | 评分 |',
      '| --- | --- |',
      '| A | 约5 |',
      '| B | 约3 |',
    ].join('\n');
    const r = await checkOne({ columnName: '评分', min: 1, max: 5, integer: true }, table);
    expect(r.passed).toBe(true);
    const bad = table.replace('| A | 约5 |', '| A | 约9 |');
    const r2 = await checkOne({ columnName: '评分', min: 1, max: 5, integer: true }, bad);
    expect(r2.passed).toBe(false);
  });

  it('does NOT strip the qualifier when it is not a prefix (still unparseable)', async () => {
    // 保守边界：只剥「前缀」。'4.72 约' 这种仍在数字之后，应保持 unparseable 行为不变。
    const table = ['| 城市 | GDP |', '| --- | --- |', '| 深圳 | 待定约 |', '| 苏州 | 4.16 |'].join('\n');
    const r = await checkOne({ columnName: 'GDP', order: 'desc' }, table);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('unparseable');
  });
});
