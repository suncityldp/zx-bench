// ============================================================
// 精确答案行评分器 (exact_answer_line)
// 用于 reasoning_math 维度：从模型输出中提取最终答案行
// 与期望答案比较，支持数值容差、单位归一化、多答案格式
// ============================================================

import type { Scenario, ScenarioResult, OutputMetadata, ModelResponse, AxisEvidence } from '@zxbench/types';
import type { Evaluator } from './index.js';
import { formatValidScore } from './responseState.js';

export const exactAnswerLineEvaluator: Evaluator = {
  name: 'exact_answer_line',
  version: 'exact_answer_v3',

  async evaluate(
    scenario: Scenario,
    modelOutput: string,
    outputMetadata: OutputMetadata,
    _modelResponse?: ModelResponse,
  ): Promise<Partial<ScenarioResult>> {
    const axisScores: Record<string, number> = {};
    const axisEvidence: Record<string, AxisEvidence> = {};
    const evidence: string[] = [];

    // ===== 1. 格式基础分 (10%) =====
    // 检查输出是否为非空且有意义的内容
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

    // ===== 2. 获取期望答案 =====
    const requirements = (scenario.requirements as unknown as Record<string, unknown>) || {};
    const expectedAnswer = requirements.answer;
    const scoring = scenario.scoring as unknown as Record<string, unknown>;
    const tolerance = (scoring.tolerance as number) ?? 0.01;
    // Legacy/custom scenarios keep relative tolerance; numeric benchmark tasks explicitly use units.
    const toleranceMode = scoring.toleranceMode === 'absolute' ? 'absolute' : 'relative';

    if (expectedAnswer === undefined || expectedAnswer === null) {
      // 没有期望答案，只评格式（无答案可验证）
      axisScores.answer_accuracy = 100;
      axisEvidence.answer_accuracy = 'unmeasured';
      const totalScore = Math.round(axisScores.format_valid * 0.1 + axisScores.answer_accuracy * 0.9);
      return { axisScores, axisEvidence, totalScore, safetyLevel: 'safe', evidence };
    }

    // ===== 3. 截断惩罚 =====
    if (outputMetadata.truncated || outputMetadata.incomplete) {
      evidence.push('Output was truncated — answer may be incomplete');
      // 截断时 format_valid 已由 formatValidScore 统一降为 60；此处仅追加证据，不再二次乘 0.6（避免双重惩罚，A3-6 统一）
    }

    // ===== 4. 从输出中提取答案 =====
    const strict = scoring.comparisonMode === 'strict';
    // Versioned benchmark contracts keep the whole final line (dates and multi-field
    // answers must never be truncated by parseFloat or a preceding intermediate '=').
    const extractedAnswer = strict ? extractAnswerLine(modelOutput) : extractFinalAnswer(modelOutput);
    if (extractedAnswer === null) {
      axisScores.answer_accuracy = 0;
      axisEvidence.answer_accuracy = 'rule';
      evidence.push(`Could not extract answer from output. Expected: ${JSON.stringify(expectedAnswer)}`);
      const totalScore = Math.round(axisScores.format_valid * 0.1 + axisScores.answer_accuracy * 0.9);
      return { axisScores, axisEvidence, totalScore, safetyLevel: 'safe', evidence };
    }

    evidence.push(`Extracted answer: ${JSON.stringify(extractedAnswer)}`);

    // ===== 5. 比较答案（移除 reasoning_valid 伪轴：它只测截断、不测推理） =====
    const variants = Array.isArray(requirements.acceptedVariants)
      ? requirements.acceptedVariants.filter((v): v is string => typeof v === 'string') : [];
    const accuracy = strict
      ? Math.max(...[expectedAnswer, ...variants].map(v => compareStrictAnswer(extractedAnswer, v, scoring.answerUnit)))
      : compareAnswer(extractedAnswer, expectedAnswer, tolerance, toleranceMode);
    axisScores.answer_accuracy = accuracy;
    axisEvidence.answer_accuracy = 'rule';

    if (accuracy >= 90) {
      evidence.push(`Answer correct (accuracy: ${accuracy})`);
    } else if (accuracy >= 50) {
      evidence.push(`Answer partially correct (accuracy: ${accuracy}), expected: ${JSON.stringify(expectedAnswer)}`);
    } else {
      evidence.push(`Answer incorrect (accuracy: ${accuracy}), extracted: ${JSON.stringify(extractedAnswer)}, expected: ${JSON.stringify(expectedAnswer)}`);
    }

    // ===== 6. 综合评分：格式 10% + 答案准确性 90% =====
    const totalScore = Math.round(
      axisScores.format_valid * 0.10 +
      axisScores.answer_accuracy * 0.90,
    );

    return {
      axisScores,
      axisEvidence,
      totalScore,
      safetyLevel: 'safe',
      evidence,
    };
  },
};

/** Read only the last nonempty line, as required by the versioned prompt contract. */
function extractAnswerLine(text: string): string | null {
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  const match = lines.at(-1)?.match(/^[ \t]*(?:\*\*)?(?:ANSWER|最终答案|答案)(?:\*\*)?[ \t]*[:：][ \t]*(.*)$/i);
  return match ? match[1].trim().replace(/\*\*/g, '') : null;
}

function normalizeAnswer(text: string): string {
  return text.normalize('NFKC').replace(/\*\*/g, '').replace(/\s+/g, '')
    .replace(/，/g, ',').replace(/[;；]/g, ',').replace(/[。.,]+$/, '')
    // Only remove syntactically valid thousands separators, never field delimiters.
    .replace(/\d{1,3}(?:,\d{3})+(?:\.\d+)?/g, m => m.replace(/,/g, ''));
}

/** Exact decimal identity without parsing the value as an IEEE-754 Number.
 * Canonical form is signed significant digits plus a base-10 exponent. Unit
 * conversion shifts the exponent, so it introduces no floating-point error.
 */
function canonicalDecimal(text: string, decimalShift = 0): string | null {
  if (text.length > 4096) return null;
  const match = text.match(/^([+-]?)(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?$/);
  if (!match || (match[3] && match[3].replace(/^[+-]/, '').length > 6)) return null;
  const [whole, fraction = ''] = match[2].split('.');
  let digits = (whole + fraction).replace(/^0+/, '');
  if (!digits) return '0';
  const trailingZeros = digits.length - digits.replace(/0+$/, '').length;
  digits = digits.slice(0, digits.length - trailingZeros);
  // Only the bounded exponent is converted to Number; answer digits never are.
  const exponent = Number(match[3] || 0) - fraction.length + trailingZeros + decimalShift;
  return `${match[1] === '-' ? '-' : ''}${digits}e${exponent}`;
}

/**
 * Compare the requested labelled format and every numeric component independently.
 * All components must pass. Text similarity is never evidence of arithmetic correctness.
 * Numeric values must be identical. Precision/rounding belongs in the prompt
 * and gold, not in a scoring tolerance; alternative wording is an explicit gold variant.
 */
function compareStrictAnswer(extracted: string | number, expected: unknown, unit?: unknown): number {
  const actual = normalizeAnswer(String(extracted));
  if (typeof expected === 'number') {
    const m = actual.match(/^[¥￥]?([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)(万|亿)?(元|种|次|个|件|%)?$/);
    if (!m) return 0;
    if (typeof unit === 'string' && ((m[3] && m[3] !== unit) || (m[2] && unit !== '元'))) return 0;
    const shift = m[2] === '万' ? 4 : m[2] === '亿' ? 8 : 0;
    const value = canonicalDecimal(m[1], shift);
    return value !== null && value === canonicalDecimal(String(expected)) ? 100 : 0;
  }
  if (typeof expected !== 'string') return 0;
  const target = normalizeAnswer(expected);
  const numberPattern = /(?<![A-Za-z\d.])[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/g;
  const values = (s: string) => [...s.matchAll(numberPattern)].map(m => canonicalDecimal(m[0]));
  const actualValues = values(actual), expectedValues = values(target);
  if (actual.replace(numberPattern, '#') !== target.replace(numberPattern, '#')
    || actualValues.length !== expectedValues.length) return 0;
  return actualValues.every((v, i) => v !== null && v === expectedValues[i]) ? 100 : 0;
}

// ===== 答案提取 =====

/**
 * 从模型输出中提取最终答案
 * 支持中文数学题常见格式：
 * - "答案：XXX" / "答案是：XXX"
 * - "最终结果：XXX" / "结果是：XXX"
 * - "= XXX" / "=XXX"
 * - 最后一行纯数字
 * - "**答案**：XXX" / "**Answer**: XXX"
 * - Markdown 格式的答案
 */
function extractFinalAnswer(text: string): string | number | null {
  // 尝试匹配明确的答案标记
  const patterns = [
    // 中文答案格式
    /(?:最终)?答案[是为：:]\s*(.+?)(?:\n|$)/i,
    /(?:最终)?结果[是为：:]\s*(.+?)(?:\n|$)/i,
    /(?:因此|所以|故)[,，]?\s*(?:答案[是为：:]?\s*)?(.+?)(?:\n|$)/i,
    // 数学等号格式
    /=\s*([\d,.]+)\s*(?:元|万元|个|只|米|km|kg|g|秒|分钟|小时|天|年|%|℃)?(?:\s*$)/m,
    // Markdown 粗体答案
    /\*\*答案\*\*[：:]\s*(.+?)(?:\n|$)/i,
    /\*\*Answer\*\*[：:]\s*(.+?)(?:\n|$)/i,
    // 英文答案格式
    /(?:answer|result)[：:]\s*(.+?)(?:\n|$)/i,
    // 结论格式
    /(?:综上|综上所述|总结)[：:，,]?\s*(.+?)(?:\n|$)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const answerText = match[1].trim();
      // 尝试解析为数字
      const num = parseNumericAnswer(answerText);
      if (num !== null) return num;
      // 返回原始文本（去除尾部标点和空白）
      return answerText.replace(/[。，,;；\s]+$/g, '').trim();
    }
  }

  // 最后手段：查找最后一行可能是答案的内容
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  // 从后往前找第一个可能包含答案的行
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    // 跳过空行、标题行、分隔线
    if (line.startsWith('#') || line.startsWith('---') || line.startsWith('===')) continue;
    if (line.length < 50) {
      const num = parseNumericAnswer(line);
      if (num !== null) return num;
      // 如果是短文本行，可能也是答案
      return line.replace(/[。，,;；\s]+$/g, '').trim();
    }
  }

  return null;
}

/**
 * 从文本中解析数值答案
 * 支持格式：123, 12.5, 1,234.56, -456, 50%, 100万元, 3.14元, 5次/分钟
 * A3-9 修复：先剥离尾部单位字符（不含 万/亿），再单独处理 万/亿 倍数，避免「万元」被一并剥掉导致数量级错误。
 */
function parseNumericAnswer(text: string): number | null {
  // 去除千分位、约数词、空白
  let cleaned = text
    .replace(/[,，]/g, '')
    .replace(/[约近大约]/, '')
    .replace(/\s+/g, '')
    .trim();

  // 处理百分比
  if (cleaned.endsWith('%')) {
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  }

  // A3-9：先剥离尾部单位字符（不含 万/亿，留给倍数处理），支持复合单位如 次/分钟、元/吨
  cleaned = cleaned.replace(/[元个只米公斤千克千吨公里kmkgg秒分钟小时天年°℃次片件倍]/g, '');

  // 处理万/亿 倍数（可出现在单位前，如 万元、亿吨）
  let multiplier = 1;
  if (cleaned.endsWith('万')) {
    multiplier = 10000;
    cleaned = cleaned.slice(0, -1);
  } else if (cleaned.endsWith('亿')) {
    multiplier = 100000000;
    cleaned = cleaned.slice(0, -1);
  }

  const num = parseFloat(cleaned);
  if (isNaN(num)) return null;
  return num * multiplier;
}

// ===== 答案比较 =====

/**
 * 比较提取的答案和期望答案
 * @returns 0-100 的准确度分数
 */
function compareAnswer(extracted: string | number, expected: unknown, tolerance: number, mode: 'absolute' | 'relative'): number {
  // ===== 数值比较 =====
  if (typeof expected === 'number') {
    const extractedNum = typeof extracted === 'number'
      ? extracted
      : parseNumericAnswer(String(extracted));

    if (extractedNum === null || !Number.isFinite(extractedNum) || !Number.isFinite(expected)) return 0;

    // 完全相等
    if (extractedNum === expected) return 100;

    if (mode === 'absolute') {
      return Math.abs(extractedNum - expected) <= Math.max(0, tolerance) ? 100 : 0;
    }

    // 容差比较（A3-9 收紧：相对误差档位更严格，20% 误差不再给 40 分）
    if (expected === 0) {
      // 避免除以0
      return Math.abs(extractedNum) <= tolerance ? 100 : Math.max(0, Math.round(100 - Math.abs(extractedNum) * 10));
    }

    const relativeError = Math.abs(extractedNum - expected) / Math.abs(expected);
    if (relativeError <= tolerance) return 100;
    if (relativeError <= tolerance * 2) return 90;
    if (relativeError <= tolerance * 5) return 75;
    if (relativeError <= tolerance * 10) return 50;
    if (relativeError <= tolerance * 20) return 25;
    return 0;
  }

  // ===== 字符串比较 =====
  if (typeof expected === 'string') {
    const expectedStr = expected.trim();
    const extractedStr = String(extracted).trim();

    // 完全匹配
    if (extractedStr === expectedStr) return 100;

    // 忽略大小写
    if (extractedStr.toLowerCase() === expectedStr.toLowerCase()) return 95;

    // 包含关系
    if (extractedStr.includes(expectedStr) || expectedStr.includes(extractedStr)) {
      const shorter = Math.min(extractedStr.length, expectedStr.length);
      const longer = Math.max(extractedStr.length, expectedStr.length);
      if (longer === 0) return 100;
      return Math.round(80 + (shorter / longer) * 15); // 80-95
    }

    // 相似度比较（简单编辑距离）
    const similarity = simpleSimilarity(extractedStr, expectedStr);
    return Math.round(similarity * 100);
  }

  return 0;
}

/** 简单的字符串相似度（0-1） */
function simpleSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  // 基于公共子序列的相似度
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const lcsLength = dp[m][n];
  const maxLen = Math.max(m, n);
  return lcsLength / maxLen;
}
