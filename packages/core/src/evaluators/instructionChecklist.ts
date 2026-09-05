// ============================================================
// 指令遵循评分器 (instruction_checklist)
// 用于 instruction_following 维度
// 基于 constraints 配置逐项检查模型输出是否满足指令要求
// 支持 partialCredit（部分给分）
// ============================================================

import type { Scenario, ScenarioResult, OutputMetadata, ModelResponse, AxisEvidence } from '@zxbench/types';
import type { Evaluator } from './index.js';
import { weightedScoreByCoverage } from './scoreAggregate.js';
import { formatValidScore } from './responseState.js';

/** 约束类型定义 */
interface Constraint {
  id: string;
  type: string;
  description: string;
  check: Record<string, unknown>;
}

interface ConstraintResult {
  id: string;
  type: string;
  description: string;
  passed: boolean;
  detail: string;
}

export const instructionChecklistEvaluator: Evaluator = {
  name: 'instruction_checklist',
  version: 'instruction_checklist_v4',
  aliases: ['instruction_checklist_v3'],

  async evaluate(
    scenario: Scenario,
    modelOutput: string,
    outputMetadata: OutputMetadata,
    _modelResponse?: ModelResponse,
  ): Promise<Partial<ScenarioResult>> {
    const axisScores: Record<string, number> = {};
    const axisEvidence: Record<string, AxisEvidence> = {};
    const evidence: string[] = [];

    // ===== 1. 格式化基础检查 =====
    if (!modelOutput || modelOutput.trim().length === 0) {
      axisScores.format_valid = 0;
      axisEvidence.format_valid = 'rule';
      evidence.push('Empty model output');
      return {
        axisScores,
        axisEvidence,
        totalScore: 0,
        safetyLevel: 'safe',
        evidence,
      };
    }

    axisScores.format_valid = formatValidScore(outputMetadata);
    axisEvidence.format_valid = 'rule';

    // ===== 2. 加载约束列表 =====
    const requirements = (scenario.requirements as unknown as Record<string, unknown>) || {};
    const constraints: Constraint[] = Array.isArray(requirements.constraints)
      ? requirements.constraints as Constraint[]
      : [];

    if (constraints.length === 0) {
      // 无约束配置：指令遵循无法验证 → 题集配置缺陷，标记为人工复核 + 不虚高打分。
      // A3-1 修复：不再用 [format,0.2],[undefined,0.8] 制造 coverage=0.2 进而被误打折；
      // 直接置 0 + axisCoverage 0，由 orchestrator 的 totalScore<30 规则触发人工复核。
      axisEvidence.instruction_compliance = 'unmeasured';
      evidence.push('No explicit constraints defined — instruction compliance unmeasured');
      return { axisScores, axisEvidence, axisCoverage: 0, totalScore: 0, safetyLevel: 'safe', evidence };
    }

    // ===== 3. 逐项检查 =====
    const results: ConstraintResult[] = [];
    for (const constraint of constraints) {
      const result = checkConstraint(modelOutput, constraint);
      results.push(result);
    }

    const passedCount = results.filter((r) => r.passed).length;
    const totalCount = results.length;

    // ===== 4. 生成证据 =====
    for (const r of results) {
      const status = r.passed ? 'PASS' : 'FAIL';
      evidence.push(`[${status}] ${r.id}: ${r.description} — ${r.detail}`);
    }

    // ===== 5. 计算分数 =====
    const scoring = scenario.scoring as unknown as Record<string, unknown>;
    const partialCredit = scoring.partialCredit !== false; // 默认开启部分给分

    if (partialCredit) {
      // 部分给分模式：每通过一项得 (100/总数) 分
      axisScores.instruction_compliance = Math.round((passedCount / Math.max(totalCount, 1)) * 100);
    } else {
      // 全有或全无模式
      axisScores.instruction_compliance = passedCount === totalCount ? 100 : 0;
    }
    axisEvidence.instruction_compliance = 'rule';

    // ===== 6. 截断惩罚 =====
    if (outputMetadata.truncated) {
      evidence.push('Output was truncated — some constraints may not be verifiable');
      axisScores.format_valid = Math.round(axisScores.format_valid * 0.7);
    }

    // ===== 7. 总分（格式 20% + 指令遵循 80%；coverage 仅按已配置轴计算，A3-1 修复） =====
    const { score: totalScore, coverage: axisCoverage } = weightedScoreByCoverage([
      [axisScores.format_valid, 0.2],
      [axisScores.instruction_compliance, 0.8],
    ]);

    return {
      axisScores,
      axisEvidence,
      axisCoverage,
      totalScore,
      safetyLevel: 'safe',
      evidence,
    };
  },
};

// ===== 约束检查函数 =====

function checkConstraint(text: string, constraint: Constraint): ConstraintResult {
  const { id, type, description, check } = constraint;

  switch (type) {
    case 'exact_count':
      return checkExactCount(text, id, type, description, check);
    case 'paragraph_count':
      return checkParagraphCount(text, id, type, description, check);
    case 'sentence_count':
      return checkSentenceCount(text, id, type, description, check);
    case 'inclusion':
      return checkInclusion(text, id, type, description, check);
    case 'exclusion':
      return checkExclusion(text, id, type, description, check);
    case 'english_free':
      return checkEnglishFree(text, id, type, description);
    case 'length':
      return checkLength(text, id, type, description, check);
    case 'format':
      return checkFormat(text, id, type, description, check);
    case 'exact_order':
      return checkExactOrder(text, id, type, description, check);
    case 'exact_word':
      return checkExactWord(text, id, type, description, check);
    case 'conflict_resolution':
      return checkConflictResolution(text, id, type, description, check);
    case 'numeric_column':
      return checkNumericColumn(text, id, type, description, check);
    case 'numeric_sequence':
      return checkNumericSequence(text, id, type, description, check);
    case 'line_structure':
      return checkLineStructure(text, id, type, description, check);
    case 'json_valid':
      return checkJsonValid(text, id, type, description, check);
    default:
      // 未实现的约束类型：显式 FAIL（不再静默 PASS，防止约束形同虚设）
      return {
        id, type, description,
        passed: false,
        detail: `UNKNOWN_CONSTRAINT_TYPE: "${type}" — check implementation missing`,
      };
  }
}

/** 精确词位置检查：指定词必须出现在文本首/尾（如"全文首字必须是春"） */
function checkExactWord(
  text: string, id: string, type: string, description: string, check: Record<string, unknown>,
): ConstraintResult {
  const word = String(check.word ?? check.pattern ?? '');
  const position = String(check.position ?? 'start');

  if (!word) {
    return { id, type, description, passed: false, detail: 'exact_word 配置不完整（需 word 字段）' };
  }

  const trimmed = text.trim();
  let passed = false;
  let actual = '';
  if (position === 'start') {
    passed = trimmed.startsWith(word);
    actual = trimmed.slice(0, word.length);
  } else if (position === 'end') {
    passed = trimmed.endsWith(word);
    actual = trimmed.slice(Math.max(0, trimmed.length - word.length));
  } else {
    // 默认全文精确匹配
    passed = trimmed === word;
    actual = trimmed.slice(0, 30);
  }

  return {
    id, type, description, passed,
    detail: passed
      ? `Text ${position} matches "${word}"`
      : `Text ${position} is "${actual}", expected "${word}"`,
  };
}

/** 冲突解决检查：输出需命中至少一个（OR）或全部（requireAll）解决标记 */
function checkConflictResolution(
  text: string, id: string, type: string, description: string, check: Record<string, unknown>,
): ConstraintResult {
  const patterns: string[] = Array.isArray(check.patterns) ? check.patterns as string[] : [];

  if (patterns.length === 0) {
    return { id, type, description, passed: false, detail: 'conflict_resolution 配置不完整（需 patterns）' };
  }

  const requireAll = check.requireAll === true;
  const found = patterns.filter((p) => text.includes(p));

  const passed = requireAll ? found.length === patterns.length : found.length > 0;
  return {
    id, type, description, passed,
    detail: passed
      ? `Conflict-resolution markers found: ${found.join(', ')}`
      : `No conflict-resolution markers found (expected ${requireAll ? 'all of' : 'at least one of'}: ${patterns.join(', ')})`,
  };
}

/** 顺序约束：A 必须出现在 B 之前（如"上海必须在北京之前"） */
function checkExactOrder(
  text: string, id: string, type: string, description: string, check: Record<string, unknown>,
): ConstraintResult {
  const before = String(check.before ?? check.first ?? (Array.isArray(check.patterns) ? check.patterns[0] : '')).toLowerCase();
  const after = String(check.after ?? check.second ?? (Array.isArray(check.patterns) ? check.patterns[1] : '')).toLowerCase();

  if (!before || !after || before === 'undefined') {
    return { id, type, description, passed: false, detail: 'exact_order 配置不完整（需 before/after 或 patterns[0..1]）' };
  }

  const low = text.toLowerCase();
  const iBefore = low.indexOf(before);
  const iAfter = low.indexOf(after);
  const passed = iBefore !== -1 && iAfter !== -1 && iBefore < iAfter;

  return {
    id, type, description, passed,
    detail: passed
      ? `"${before}" appears before "${after}"`
      : iBefore === -1
        ? `"${before}" not found`
        : iAfter === -1
          ? `"${after}" not found`
          : `Order violated: "${before}" at ${iBefore} appears after "${after}" at ${iAfter}`,
  };
}

/** 精确计数检查：某个词/短语恰好出现 N 次 */
function checkExactCount(
  text: string, id: string, type: string, description: string, check: Record<string, unknown>,
): ConstraintResult {
  const target = String(check.target || '');
  const expectedCount = Number(check.count ?? 1);

  if (!target) {
    return { id, type, description, passed: true, detail: 'No target specified — skipped' };
  }

  // 转义正则特殊字符
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = text.match(new RegExp(escaped, 'g'));
  const actualCount = matches ? matches.length : 0;

  const passed = actualCount === expectedCount;
  return {
    id, type, description, passed,
    detail: passed
      ? `"${target}" appears exactly ${actualCount} times (expected ${expectedCount})`
      : `"${target}" appears ${actualCount} times (expected ${expectedCount})`,
  };
}

/** 段落数检查 */
function checkParagraphCount(
  text: string, id: string, type: string, description: string, check: Record<string, unknown>,
): ConstraintResult {
  const expectedCount = Number(check.count ?? 1);

  // 段落以「空行」分隔。
  // 修过两个真实缺陷：
  //   1. 原来用 /\n{2,}/，遇到 CRLF（\r\n\r\n）匹配不到 —— Windows 上产出的回答
  //      整篇会被算成 1 段。实测 IF-CN-018/040 的合规回答因此被判 100→86 / 100→57。
  //   2. 空行里含空格或 Tab（"\n   \n"）时同样匹配不到。
  // 现在：先把 CRLF / CR 统一成 LF，再按「换行 + 可选空白 + 换行」切分。
  // 这样切分口径与 rubric 里 format 约束惯用的 \n[ \t]*\n 保持一致。
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const actualCount = paragraphs.length;

  const passed = actualCount === expectedCount;
  return {
    id, type, description, passed,
    detail: passed
      ? `Exactly ${actualCount} paragraphs (expected ${expectedCount})`
      : `${actualCount} paragraphs (expected ${expectedCount})`,
  };
}

/** 句子数检查 */
function checkSentenceCount(
  text: string, id: string, type: string, description: string, check: Record<string, unknown>,
): ConstraintResult {
  const expectedCount = Number(check.count ?? 1);

  // 句子 = 以句末标点（。！？!?）结尾的一段。
  // 修过一个真实缺陷：原来 split 的字符类里带了 \n，换行也被当成句子分隔符，
  // 于是「一行一句但一句末标点都没有」的文本会被数成 N 句 ——
  // 与 prompt「以句号、感叹号或问号结尾算一句」的定义直接冲突。
  // 实测 IF-CN-009 上，5 行无句末标点的输出被判成 5 句、满分通过。
  //
  // 保留 newlineAsSeparator: true 作为逃生口，供确需按行计数的旧题使用。
  const separator = check.newlineAsSeparator === true ? /[。！？!?\n]+/ : /[。！？!?]+/;
  const sentences = text
    .split(separator)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const actualCount = sentences.length;

  const passed = actualCount === expectedCount;
  return {
    id, type, description, passed,
    detail: passed
      ? `Exactly ${actualCount} sentences (expected ${expectedCount})`
      : `${actualCount} sentences (expected ${expectedCount})`,
  };
}

/** 包含检查：必须包含指定模式 */
function checkInclusion(
  text: string, id: string, type: string, description: string, check: Record<string, unknown>,
): ConstraintResult {
  const patterns: string[] = Array.isArray(check.patterns) ? check.patterns as string[] : [];

  if (patterns.length === 0) {
    return { id, type, description, passed: true, detail: 'No patterns specified — skipped' };
  }

  // 检查是否包含任一模式（OR 逻辑）
  const requireAll = check.requireAll === true;
  const missingPatterns: string[] = [];

  for (const pattern of patterns) {
    if (!text.includes(pattern)) {
      missingPatterns.push(pattern);
    }
  }

  if (requireAll) {
    const passed = missingPatterns.length === 0;
    return {
      id, type, description, passed,
      detail: passed
        ? `All ${patterns.length} patterns found`
        : `Missing patterns: ${missingPatterns.join(', ')}`,
    };
  }

  // OR 逻辑：至少包含一个
  const passed = missingPatterns.length < patterns.length;
  return {
    id, type, description, passed,
    detail: passed
      ? `Found at least one of ${patterns.length} patterns`
      : `None of the ${patterns.length} required patterns found`,
  };
}

/** 排除检查：不得包含指定模式 */
function checkExclusion(
  text: string, id: string, type: string, description: string, check: Record<string, unknown>,
): ConstraintResult {
  const patterns: string[] = Array.isArray(check.patterns) ? check.patterns as string[] : [];

  if (patterns.length === 0) {
    // 通用排除：检查阿拉伯数字
    const excludeDigits = check.excludeDigits !== false;
    const excludeEnglish = check.excludeEnglish !== false;

    if (excludeDigits && /\d/.test(text)) {
      return { id, type, description, passed: false, detail: 'Text contains digits (forbidden)' };
    }
    if (excludeEnglish && /[a-zA-Z]/.test(text)) {
      return { id, type, description, passed: false, detail: 'Text contains English letters (forbidden)' };
    }

    return { id, type, description, passed: true, detail: 'No forbidden patterns found' };
  }

  const foundPatterns: string[] = [];
  for (const pattern of patterns) {
    if (text.includes(pattern)) {
      foundPatterns.push(pattern);
    }
  }

  const passed = foundPatterns.length === 0;
  return {
    id, type, description, passed,
    detail: passed
      ? 'No forbidden patterns found'
      : `Forbidden patterns found: ${foundPatterns.join(', ')}`,
  };
}

/** 英文排除检查 */
function checkEnglishFree(
  text: string, id: string, type: string, description: string,
): ConstraintResult {
  const hasEnglish = /[a-zA-Z]/.test(text);
  const passed = !hasEnglish;

  return {
    id, type, description, passed,
    detail: passed ? 'No English letters found' : 'Text contains English letters (forbidden)',
  };
}

/** 长度检查 */
function checkLength(
  text: string, id: string, type: string, description: string, check: Record<string, unknown>,
): ConstraintResult {
  // 兼容 min/max 别名（题库中存在两种写法，不兼容会导致长度约束静默失效）
  const minLength = Number(check.minLength ?? check.min ?? 0);
  const maxLength = Number(check.maxLength ?? check.max ?? Infinity);

  // 计算中文字符数（排除空白和标点？用实际字符数）
  const charCount = text.replace(/\s/g, '').length;

  const details: string[] = [];
  let passed = true;

  if (minLength > 0 && charCount < minLength) {
    passed = false;
    details.push(`too short (${charCount} < ${minLength})`);
  }
  if (maxLength < Infinity && charCount > maxLength) {
    passed = false;
    details.push(`too long (${charCount} > ${maxLength})`);
  }

  return {
    id, type, description, passed,
    detail: passed
      ? `Length ${charCount} within [${minLength}, ${maxLength}]`
      : `Length ${charCount} outside [${minLength}, ${maxLength}] (${details.join(', ')})`,
  };
}

/** 格式检查 */
function checkFormat(
  text: string, id: string, type: string, description: string, check: Record<string, unknown>,
): ConstraintResult {
  const pattern = String(check.pattern || '');
  // 空 pattern 等于这条约束什么都不做 —— 那是一条假约束，必须判负。
  // 与 numeric_column 的 NO_ASSERTION_SPECIFIED 同款规则：宁可见到明确的分，
  // 也不能留一条永远送分、从分数上还看不出异常的约束。
  if (!pattern) {
    return {
      id, type, description, passed: false,
      detail: 'NO_PATTERN_SPECIFIED: format constraint has an empty pattern — it can never discriminate',
    };
  }

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, check.caseInsensitive ? 'i' : '');
  } catch (e) {
    // 改过一次行为：原先是「正则非法 → 静默 PASS」。
    // 后果是写错的正则变成永远送分的假约束 —— 实测库里 IF-CN-014/c4 的 pattern 是裸 `*`，
    // （本意应是字面星号，作为正则是非法量词），多年来一直在默默送分。
    // 现在显式判负，把错误暴露出来。
    return {
      id, type, description, passed: false,
      detail: `INVALID_REGEX: ${(e as Error).message} — pattern: ${pattern.slice(0, 80)}`,
    };
  }

  const passed = regex.test(text);
  return {
    id, type, description, passed,
    detail: passed ? 'Format matches pattern' : 'Format does not match required pattern',
  };
}

// ===== JSON 合法性检查（json_valid）=====
// 背景：IF-CN-003「输出必须是有效的 JSON」与 IF-CN-007「代码块内的 JSON 必须是有效的」
// 这两条恰恰是各自题目里最考验指令遵循的要求，但此前无从判定 ——
// 只能用 format 正则去查首尾字符（`^\s*\{` / `\}` 结尾），
// 中间缺逗号、多尾逗号、引号未闭合、括号不匹配一律判通过。
// 正则无法判定任意嵌套的 JSON 语法，只能真的解析一遍。
//
// 规则（与 numeric_column 一致）：绝不静默 PASS。
//   找不到目标代码块 / 目标为空 → FAIL
//   解析失败 → FAIL，并带上 JSON.parse 的原始错误信息，便于定位
//
// check 参数：
//   language?: string  只校验 info string 等于该值的代码块（如 "json"）
//   fenced?: boolean   true = 只校验代码块内的内容；缺省 = 校验整段文本
//                      （给了 language 时自动视为 fenced）
function checkJsonValid(
  text: string, id: string, type: string, description: string, check: Record<string, unknown>,
): ConstraintResult {
  const languageRaw = check.language;
  const hasLanguage =
    languageRaw !== undefined && languageRaw !== null && String(languageRaw).trim() !== '';
  const language = hasLanguage ? String(languageRaw).trim().toLowerCase() : '';
  const fenced = check.fenced === true || hasLanguage;

  const targets: Array<{ label: string; body: string }> = [];

  if (fenced) {
    // 捕获围栏代码块的 info string 与正文；未闭合的围栏匹配不到，属于「没有可校验的对象」
    const re = /```([A-Za-z0-9_+-]*)[ \t]*\r?\n?([\s\S]*?)```/g;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = re.exec(text)) !== null) {
      idx++;
      const info = (m[1] ?? '').toLowerCase();
      if (hasLanguage && info !== language) continue;
      targets.push({
        label: `block #${idx}${info ? ` (\`\`\`${info})` : ''}`,
        body: m[2] ?? '',
      });
    }
    if (targets.length === 0) {
      return {
        id, type, description, passed: false,
        detail: hasLanguage
          ? `No \`\`\`${language} code block found — nothing to validate`
          : 'No fenced code block found — nothing to validate',
      };
    }
  } else {
    targets.push({ label: 'whole output', body: text });
  }

  const errors: string[] = [];
  for (const t of targets) {
    const body = t.body.trim();
    if (!body) {
      errors.push(`${t.label}: empty`);
      continue;
    }
    try {
      JSON.parse(body);
    } catch (e) {
      errors.push(`${t.label}: ${(e as Error).message.slice(0, 160)}`);
    }
  }

  if (errors.length > 0) {
    return { id, type, description, passed: false, detail: `Invalid JSON — ${errors.join('; ')}` };
  }
  return {
    id, type, description, passed: true,
    detail: `Valid JSON (${targets.length} target(s): ${targets.map((t) => t.label).join(', ')})`,
  };
}

// ===== 数值列检查（numeric_column）=====
// 背景：IF-CN-001「按 GDP 从高到低排序」、IF-CN-006「CSV 按面积从大到小排序」、
// IF-CN-037「价格从高到低 + 评分只能是 1–5 整数」三道题的核心要求原本无法判定。
// 三道题的真值都是小数（4.72 / 166.49 …），故全程用 number，不做整数假设。
//
// 三条硬性规则：
//   1. 绝不静默 PASS —— 列找不到、零个可解析数据行，一律 FAIL + 明确 detail
//   2. 一个断言都没给 → FAIL（NO_ASSERTION_SPECIFIED），不做「假约束」
//   3. 零个成功解析的数据行 → 一律 FAIL

/**
 * 表格行解析。
 * - 默认 markdown：只取以 `|` 开头的行，按 `|` 切分并去掉首尾空片段，跳过分隔行（`---` / `:---:` / `===`）
 * - check.format === 'csv'：按行切分，按 `,` 切列（可用 check.delimiter 自定义）
 */
function parseTableRows(text: string, check: Record<string, unknown>): string[][] {
  const isCsv = check.format === 'csv';
  const delimiter = String(check.delimiter ?? ',');

  const rows: string[][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;

    if (isCsv) {
      rows.push(line.split(delimiter).map((c) => c.trim()));
      continue;
    }

    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    // markdown 表格首列前 / 末列后各有一个空片段，去掉
    if (cells.length > 0 && cells[0] === '') cells.shift();
    if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    if (cells.length === 0) continue;
    // 分隔行：所有单元格都是 --- / :---: / :---:-: / === 之类
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || /^:?=+:?$/.test(c))) continue;

    rows.push(cells);
  }
  return rows;
}

/**
 * 表头列名归一化：对「表头单元格」与「配置里的 columnName」施加完全相同的变换后再比较。
 *
 * 目的：rubric 不应与答案的书写形式耦合。下面几种写法在语义上是同一列，必须都能匹配上：
 *   `**GDP（万亿元）**` / `` `GDP(万亿元)` `` / `GDP（万亿元）` / `GDP（万亿元） `
 * 括号统一到全角，这样 detail 里直接打印出来的就是可读的中文列名。
 *
 * 注意：只对双方用同一个函数才有意义 —— 任何一侧漏掉归一化都会让匹配再次退化成字符串全等。
 */
function normalizeColumnName(s: string): string {
  return s
    .replace(/\*/g, '')       // markdown 加粗/斜体标记
    .replace(/`/g, '')        // 行内代码标记
    .replace(/\(/g, '（')     // 半角括号 → 全角
    .replace(/\)/g, '）')
    .trim();
}

interface ParsedNumericCell {
  value: number;
  /** 数字之后剩下的尾部文本（单位等），已 trim；纯数字时为空串 */
  suffix: string;
}

/** 近似/约数修饰词。模型回答 GDP、人口这类统计值时几乎必然加「约」，属正常书写。 */
const APPROX_PREFIX = /^(?:约|大约|约合|将近|接近|≈|~|ca\.?|approx\.?|about)\s*/i;

/**
 * 单元格 → 数值 + 单位后缀。
 * 先剥掉货币符号（¥ ￥ $ €）、千分位逗号、加粗星号与约数修饰词，
 * 再拆成「数字部分」+「尾部非数字部分」。数字部分解析不出 → 返回 null。
 *
 * 为什么要剥「约」：约数修饰应该由「禁止约数」那条约束单独判定。
 * 若在这里判 unparseable，一个「约」字会同时点掉排序/区间约束（错误无法归因），
 * 而模型只是措辞含糊、量级与顺序其实是对的。
 */
function parseNumericCell(raw: string | undefined): ParsedNumericCell | null {
  if (raw === undefined) return null;
  // 星号也要剥：模型常用 **4.72** 加粗强调某个值，那是正确写法，判 unparseable 属于误判
  let cleaned = raw.trim().replace(/[¥￥$€]/g, '').replace(/,/g, '').replace(/\*/g, '');
  for (let i = 0; i < 3; i++) {
    const next = cleaned.replace(APPROX_PREFIX, '');
    if (next === cleaned) break;
    cleaned = next;
  }
  if (cleaned === '') return null;
  const m = /^(-?\d+(?:\.\d+)?)(.*)$/.exec(cleaned);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  return { value, suffix: m[2].trim() };
}

/**
 * 数值列检查：对表格中某一列做排序 / 唯一性 / 区间 / 整数性断言。
 *
 * check 字段：
 *   columnName  目标列名（与表头各单元格经 normalizeColumnName 归一后相等；找不到 → FAIL）
 *   column      0-based 列序号，默认 0（仅在未给 columnName 时生效）
 *   format      'csv' 走 CSV 解析；默认 markdown
 *   delimiter   CSV 分隔符，默认 ','
 *   hasHeader   默认 true；false 表示第一行即数据
 *   order       'desc' | 'asc'
 *   allowEqual  true 时允许相邻相等（默认严格）
 *   unique      true 要求所有值互不相同
 *   integer     true 要求所有值为整数
 *   min / max   区间（别名 minValue / maxValue）
 *   minRows     成功解析的数据行不少于 N
 */
function checkNumericColumn(
  text: string, id: string, type: string, description: string, check: Record<string, unknown>,
): ConstraintResult {
  const orderRaw = check.order === undefined || check.order === null ? '' : String(check.order).toLowerCase();
  const hasOrder = orderRaw === 'desc' || orderRaw === 'asc';
  const isDesc = orderRaw === 'desc';
  const allowEqual = check.allowEqual === true;
  const unique = check.unique === true;
  const integer = check.integer === true;

  // 奇偶 / 模数：IF-CN-037「库存列必须全为偶数」此前无从判定 ——
  // 12 种检查器里没有任何一种能表达这个要求，于是所有模型都白拿这一分。
  // even / odd 是便利写法，modulus 是通用形式（divisor + remainder）。
  const even = check.even === true;
  const odd = check.odd === true;
  const modulusRaw = check.modulus as { divisor?: unknown; remainder?: unknown } | undefined;
  const modulusDivisor = Number(modulusRaw?.divisor);
  const modulusRemainder = Number(modulusRaw?.remainder ?? 0);
  const hasModulus =
    modulusRaw !== undefined && modulusRaw !== null &&
    Number.isInteger(modulusDivisor) && modulusDivisor > 0 &&
    Number.isFinite(modulusRemainder);

  // 别名兼容：min/minValue、max/maxValue（与 checkLength 的别名风格一致）
  const minRaw = check.min ?? check.minValue;
  const maxRaw = check.max ?? check.maxValue;
  const hasMin = minRaw !== undefined && minRaw !== null && String(minRaw).trim() !== '';
  const hasMax = maxRaw !== undefined && maxRaw !== null && String(maxRaw).trim() !== '';
  const min = Number(minRaw);
  const max = Number(maxRaw);
  const minRows = Number(check.minRows ?? 0);

  // 规则 2：连一个断言都没有的检查器就是假约束 → 判负
  if (!hasOrder && !unique && !integer && !hasMin && !hasMax && !even && !odd && !hasModulus) {
    return {
      id, type, description, passed: false,
      detail:
        'NO_ASSERTION_SPECIFIED: numeric_column requires at least one of ' +
        'order / unique / integer / min / max / even / odd / modulus',
    };
  }

  const rows = parseTableRows(text, check);
  const hasHeader = check.hasHeader !== false;
  const headerRow: string[] = hasHeader ? (rows[0] ?? []) : [];
  const dataRows: string[][] = hasHeader ? rows.slice(1) : rows;

  // ===== 定位目标列 =====
  let colIndex = Number(check.column ?? 0);
  if (!Number.isInteger(colIndex) || colIndex < 0) colIndex = 0;

  const columnNameRaw = check.columnName;
  const hasColumnName = columnNameRaw !== undefined && columnNameRaw !== null && String(columnNameRaw).trim() !== '';
  let label: string;

  if (hasColumnName) {
    const columnName = String(columnNameRaw).trim();
    const wanted = normalizeColumnName(columnName);
    // 规则 1：列名找不到 → FAIL，绝不静默放行
    if (!hasHeader || headerRow.length === 0) {
      return {
        id, type, description, passed: false,
        detail: `Number column "${wanted}" not found: no header row available (hasHeader=${String(hasHeader)})`,
      };
    }
    const idx = headerRow.findIndex((c) => normalizeColumnName(c) === wanted);
    if (idx === -1) {
      // 打印归一化后的列名：排查时看到的就是实际参与比较的字符串
      const available = headerRow.map(normalizeColumnName).join(' | ');
      return {
        id, type, description, passed: false,
        detail: `Number column "${wanted}" not found in header (available: ${available})`,
      };
    }
    colIndex = idx;
    label = `"${columnName}"`;
  } else {
    label = `#${colIndex}`;
  }

  // ===== 取值（行号用 1-based 的「数据行序号」，便于定位）=====
  const values: number[] = [];
  const rowNums: number[] = [];
  const suffixes: string[] = [];
  const violations: string[] = [];

  dataRows.forEach((cells, i) => {
    const rowNo = i + 1;
    const parsed = parseNumericCell(cells[colIndex]);
    if (parsed === null) {
      // 目标列里出现非数值 → 记为解析失败并判负（否则模型可以用「待定」糊弄过去）
      violations.push(`row ${rowNo}: unparseable value "${(cells[colIndex] ?? '').trim()}"`);
      return;
    }
    rowNums.push(rowNo);
    values.push(parsed.value);
    suffixes.push(parsed.suffix);
  });

  // 规则 3：零个成功解析的数据行 → 一律 FAIL
  if (values.length === 0) {
    return {
      id, type, description, passed: false,
      detail: `Number column ${label}: no parseable data row (${dataRows.length} data row(s) examined; ${violations.slice(0, 3).join('; ') || 'no rows at all'})`,
    };
  }

  // ===== 单位一致性 =====
  // 同一列里混写单位（如 4.72万亿 与 41600亿）时，剥掉后缀再比数值会得出错误的大小关系，
  // 那比直接判负更糟 —— 会给出假的高分。宁可明确报出「单位不一致」。
  const distinctSuffixes = [...new Set(suffixes.filter((s) => s !== ''))];
  if (distinctSuffixes.length > 1) {
    const listed = distinctSuffixes.map((s) => `"${s}"`).join(', ');
    return {
      id, type, description, passed: false,
      detail: `inconsistent unit suffixes in column ${label}: [${listed}] — cannot compare magnitudes safely`,
    };
  }

  // ===== 逐条断言（列出全部违规，不只第一条）=====
  if (hasOrder) {
    for (let i = 1; i < values.length; i++) {
      const prev = values[i - 1];
      const cur = values[i];
      const prevRow = rowNums[i - 1];
      const curRow = rowNums[i];
      if (isDesc) {
        if (allowEqual ? cur > prev : cur >= prev) {
          violations.push(`row ${curRow} (${cur}) ${cur > prev ? '>' : '=='} row ${prevRow} (${prev})`);
        }
      } else if (allowEqual ? cur < prev : cur <= prev) {
        violations.push(`row ${curRow} (${cur}) ${cur < prev ? '<' : '=='} row ${prevRow} (${prev})`);
      }
    }
  }

  if (unique) {
    const byValue = new Map<number, number[]>();
    values.forEach((v, i) => {
      const hit = byValue.get(v);
      if (hit) hit.push(rowNums[i]);
      else byValue.set(v, [rowNums[i]]);
    });
    for (const [v, hitRows] of byValue) {
      if (hitRows.length > 1) violations.push(`duplicate value ${v} at rows ${hitRows.join(', ')}`);
    }
  }

  if (integer) {
    values.forEach((v, i) => {
      if (!Number.isInteger(v)) violations.push(`row ${rowNums[i]}: ${v} is not an integer`);
    });
  }

  if (even) {
    values.forEach((v, i) => {
      if (!Number.isInteger(v)) {
        violations.push(`row ${rowNums[i]}: ${v} is not an integer — even/odd is undefined for non-integers`);
      } else if (v % 2 !== 0) {
        violations.push(`row ${rowNums[i]}: ${v} is not even`);
      }
    });
  }

  if (odd) {
    values.forEach((v, i) => {
      if (!Number.isInteger(v)) {
        violations.push(`row ${rowNums[i]}: ${v} is not an integer — even/odd is undefined for non-integers`);
      } else if (Math.abs(v % 2) !== 1) {
        violations.push(`row ${rowNums[i]}: ${v} is not odd`);
      }
    });
  }

  if (hasModulus) {
    values.forEach((v, i) => {
      if (!Number.isInteger(v)) {
        violations.push(`row ${rowNums[i]}: ${v} is not an integer — modulus is undefined for non-integers`);
        return;
      }
      // JS 的 % 对负数返回负余数，先规约到 [0, divisor) 再比较，否则 -3 % 2 = -1 会误判
      const r = ((v % modulusDivisor) + modulusDivisor) % modulusDivisor;
      if (r !== modulusRemainder) {
        violations.push(`row ${rowNums[i]}: ${v} mod ${modulusDivisor} = ${r}, expected ${modulusRemainder}`);
      }
    });
  }

  if (hasMin && Number.isFinite(min)) {
    values.forEach((v, i) => {
      if (v < min) violations.push(`row ${rowNums[i]}: ${v} < min ${min}`);
    });
  }

  if (hasMax && Number.isFinite(max)) {
    values.forEach((v, i) => {
      if (v > max) violations.push(`row ${rowNums[i]}: ${v} > max ${max}`);
    });
  }

  if (Number.isFinite(minRows) && minRows > 0 && values.length < minRows) {
    violations.push(`only ${values.length} parseable row(s), expected >= ${minRows}`);
  }

  // ===== 结果 =====
  if (violations.length > 0) {
    const head = hasOrder
      ? `Number column ${label} not ${isDesc ? 'descending' : 'ascending'}`
      : `Number column ${label} violates constraint`;
    return { id, type, description, passed: false, detail: `${head}: ${violations.join('; ')}` };
  }

  const bounds = hasMin || hasMax
    ? `within [${hasMin ? String(min) : '-Infinity'}, ${hasMax ? String(max) : 'Infinity'}]`
    : '';
  const parts: string[] = [`${values.length} values`];
  if (hasOrder) parts.push(isDesc ? 'descending' : 'ascending');
  if (hasOrder && allowEqual) parts.push('equal allowed');
  if (unique) parts.push('unique');
  if (integer) parts.push('all integers');
  if (even) parts.push('all even');
  if (odd) parts.push('all odd');
  if (hasModulus) parts.push(`all ≡ ${modulusRemainder} (mod ${modulusDivisor})`);
  if (bounds) parts.push(bounds);

  return { id, type, description, passed: true, detail: `Number column ${label}: ${parts.join(', ')}` };
}

/**
 * 数字序列检查：对「一行一个条目」的答案做数值提取、排序和连续性断言。
 *
 * check 字段：
 *   linePattern  每个非空行都必须匹配的正则（应自行写 ^/$ 锚点）
 *   valuePattern 从每行提取数字的正则，第一捕获组为数字
 *   order       asc | desc
 *   consecutive 整数步长（如 -1 表示 10,9,...,1）
 *   minRows / maxRows / exactRows
 *
 * 这类约束与 numeric_column 分开，避免把 Markdown/CSV 表格解析规则
 * 错用于「城市 - 人口」或「10 -> 十」这样的行式答案。
 */
function checkNumericSequence(
  text: string, id: string, type: string, description: string, check: Record<string, unknown>,
): ConstraintResult {
  const linePattern = String(check.linePattern ?? '');
  const valuePattern = String(check.valuePattern ?? '');
  if (!linePattern || !valuePattern) {
    return { id, type, description, passed: false, detail: 'numeric_sequence 配置不完整（需 linePattern/valuePattern）' };
  }

  let lineRe: RegExp;
  let valueRe: RegExp;
  try {
    lineRe = new RegExp(linePattern);
    valueRe = new RegExp(valuePattern);
  } catch (e) {
    return { id, type, description, passed: false, detail: `INVALID_REGEX: ${(e as Error).message}` };
  }

  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((line) => line.trim().length > 0);
  const violations: string[] = [];
  const values: number[] = [];

  for (const [i, line] of lines.entries()) {
    if (!lineRe.test(line)) violations.push(`line ${i + 1} does not match linePattern`);
    lineRe.lastIndex = 0;
    const match = valueRe.exec(line);
    valueRe.lastIndex = 0;
    const value = match ? Number(match[1]) : NaN;
    if (!Number.isFinite(value)) violations.push(`line ${i + 1} has no parseable number`);
    else values.push(value);
  }

  const exactRows = Number(check.exactRows ?? 0);
  const minRows = Number(check.minRows ?? 0);
  const maxRows = Number(check.maxRows ?? Infinity);
  if (exactRows > 0 && lines.length !== exactRows) violations.push(`expected exactly ${exactRows} non-empty lines, got ${lines.length}`);
  if (minRows > 0 && lines.length < minRows) violations.push(`expected at least ${minRows} non-empty lines, got ${lines.length}`);
  if (maxRows < Infinity && lines.length > maxRows) violations.push(`expected at most ${maxRows} non-empty lines, got ${lines.length}`);
  if (values.length !== lines.length) violations.push('some lines have no parseable numeric value');

  const order = String(check.order ?? '').toLowerCase();
  if (order !== 'asc' && order !== 'desc' && check.consecutive === undefined) {
    violations.push('NO_ASSERTION_SPECIFIED: provide order or consecutive');
  }
  if (order === 'asc' || order === 'desc') {
    for (let i = 1; i < values.length; i++) {
      if (order === 'asc' ? values[i] <= values[i - 1] : values[i] >= values[i - 1]) {
        violations.push(`order violated at line ${i + 1}: ${values[i - 1]} -> ${values[i]}`);
      }
    }
  }
  if (check.consecutive !== undefined) {
    const step = Number(check.consecutive);
    if (!Number.isFinite(step)) violations.push('consecutive must be a finite number');
    else for (let i = 1; i < values.length; i++) {
      if (values[i] - values[i - 1] !== step) {
        violations.push(`step violated at line ${i + 1}: expected ${step}, got ${values[i] - values[i - 1]}`);
      }
    }
  }

  return violations.length > 0
    ? { id, type, description, passed: false, detail: violations.join('; ') }
    : { id, type, description, passed: true, detail: `${values.length} numeric lines validated` };
}

/** 逐行结构检查：用于列表、编号答案及「奇数行/偶数行」交替格式。 */
function checkLineStructure(
  text: string, id: string, type: string, description: string, check: Record<string, unknown>,
): ConstraintResult {
  const linePattern = String(check.linePattern ?? '');
  if (!linePattern) {
    return { id, type, description, passed: false, detail: 'line_structure 配置不完整（需 linePattern）' };
  }
  let lineRe: RegExp;
  let oddRe: RegExp | null = null;
  let evenRe: RegExp | null = null;
  try {
    lineRe = new RegExp(linePattern);
    if (check.oddPattern !== undefined) oddRe = new RegExp(String(check.oddPattern));
    if (check.evenPattern !== undefined) evenRe = new RegExp(String(check.evenPattern));
  } catch (e) {
    return { id, type, description, passed: false, detail: `INVALID_REGEX: ${(e as Error).message}` };
  }

  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((line) => line.trim().length > 0);
  const violations: string[] = [];
  const exactRows = Number(check.exactRows ?? 0);
  const minRows = Number(check.minRows ?? 0);
  const maxRows = Number(check.maxRows ?? Infinity);
  if (exactRows > 0 && lines.length !== exactRows) violations.push(`expected exactly ${exactRows} non-empty lines, got ${lines.length}`);
  if (minRows > 0 && lines.length < minRows) violations.push(`expected at least ${minRows} non-empty lines, got ${lines.length}`);
  if (maxRows < Infinity && lines.length > maxRows) violations.push(`expected at most ${maxRows} non-empty lines, got ${lines.length}`);

  const seen = new Set<string>();
  const uniqueGroup = check.uniqueGroup === undefined ? null : Number(check.uniqueGroup);
  const maxChars = check.maxChars === undefined ? Infinity : Number(check.maxChars);
  const indentCounts = check.indentCounts && typeof check.indentCounts === 'object'
    ? check.indentCounts as Record<string, unknown>
    : null;
  const actualIndentCounts = new Map<number, number>();
  for (const [i, line] of lines.entries()) {
    lineRe.lastIndex = 0;
    const m = lineRe.exec(line);
    if (!m) {
      violations.push(`line ${i + 1} does not match linePattern`);
      continue;
    }
    const lineNo = i + 1;
    if (indentCounts) {
      const indent = (/^[ \t]*/.exec(line)?.[0] ?? '').replace(/\t/g, '    ').length;
      actualIndentCounts.set(indent, (actualIndentCounts.get(indent) ?? 0) + 1);
    }
    if (oddRe && lineNo % 2 === 1) {
      oddRe.lastIndex = 0;
      if (!oddRe.test(line)) violations.push(`odd line ${lineNo} does not match oddPattern`);
    }
    if (evenRe && lineNo % 2 === 0) {
      evenRe.lastIndex = 0;
      if (!evenRe.test(line)) violations.push(`even line ${lineNo} does not match evenPattern`);
    }
    if (Number.isFinite(maxChars) && line.replace(/\s/g, '').length > maxChars) {
      violations.push(`line ${lineNo} exceeds ${maxChars} non-whitespace characters`);
    }
    if (uniqueGroup !== null) {
      const key = m[uniqueGroup] ?? '';
      if (!key) violations.push(`line ${lineNo} has empty unique capture group ${uniqueGroup}`);
      else if (seen.has(key)) violations.push(`duplicate capture "${key}" at line ${lineNo}`);
      else seen.add(key);
    }
  }
  if (indentCounts) {
    for (const [rawIndent, rawExpected] of Object.entries(indentCounts)) {
      const indent = Number(rawIndent);
      const expected = Number(rawExpected);
      const actual = actualIndentCounts.get(indent) ?? 0;
      if (actual !== expected) violations.push(`indent ${indent}: expected ${expected} line(s), got ${actual}`);
    }
    const expectedTotal = Object.values(indentCounts).reduce<number>((n, v) => n + Number(v), 0);
    if (expectedTotal !== lines.length) violations.push(`indentCounts cover ${expectedTotal} line(s), got ${lines.length}`);
  }

  return violations.length > 0
    ? { id, type, description, passed: false, detail: violations.join('; ') }
    : { id, type, description, passed: true, detail: `${lines.length} non-empty lines validated` };
}
