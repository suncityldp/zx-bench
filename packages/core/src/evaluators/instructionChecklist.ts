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

  // 段落以连续换行分隔
  const paragraphs = text
    .split(/\n{2,}/)
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

  // 以句号、感叹号、问号、换行分隔的句子
  const sentences = text
    .split(/[。！？!?\n]+/)
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
  if (!pattern) {
    return { id, type, description, passed: true, detail: 'No format pattern specified — skipped' };
  }

  try {
    const regex = new RegExp(pattern, check.caseInsensitive ? 'i' : '');
    const passed = regex.test(text);
    return {
      id, type, description, passed,
      detail: passed ? 'Format matches pattern' : 'Format does not match required pattern',
    };
  } catch {
    return { id, type, description, passed: true, detail: 'Invalid regex pattern — skipped' };
  }
}
