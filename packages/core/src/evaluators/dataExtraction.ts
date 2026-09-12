// ============================================================
// Data Extraction 评分器 v2 (json_atomic_fields)
// DE 维度：格式解析 20% + 字段准确性 40% + 完整性 20%
//         + Schema 合规 10% + 输出纪律 10%
// 支持点号路径 (如 "0.rating" 表示数组第一个元素的 rating 字段)
// 支持 null 期望值 (字段应为空/缺失)
// ============================================================

import type { Scenario, ScenarioResult, OutputMetadata, ModelResponse, AxisEvidence } from '@zxbench/types';
import type { Evaluator } from './index.js';

export const dataExtractionEvaluator: Evaluator = {
  name: 'json_atomic_fields',
  version: 'json_atomic_v2',

  async evaluate(
    scenario: Scenario,
    modelOutput: string,
    outputMetadata: OutputMetadata,
    _modelResponse?: ModelResponse,
  ): Promise<Partial<ScenarioResult>> {
    const axisScores: Record<string, number> = {};
    const axisEvidence: Record<string, AxisEvidence> = {};
    const evidence: string[] = [];

    // ===== 1. 格式解析 (20%) =====
    let parsed: unknown;
    try {
      parsed = extractJson(modelOutput);
      if (parsed === null) throw new Error('no JSON found');
      axisScores.format_valid = 100;
      axisEvidence.format_valid = 'rule';
      evidence.push('Output parsed as valid JSON');
    } catch {
      axisScores.format_valid = 0;
      axisEvidence.format_valid = 'rule';
      evidence.push('Failed to parse output as JSON');
      return {
        axisScores,
        axisEvidence,
        totalScore: 0,
        safetyLevel: 'safe',
        evidence,
      };
    }

    // ===== 2. 获取期望字段 =====
    // requirements 在数据库中存储为 JSON 对象，如 {"user_name": "张三", ...}。
    // 控制字段不能被误当成待抽取字段。
    const requirements = (scenario.requirements as unknown as Record<string, unknown>) || {};
    const expectedFields = Object.entries(requirements).filter(([key]) => !CONTROL_REQUIREMENT_KEYS.has(key));

    if (expectedFields.length === 0) {
      // 没有期望字段：无字段可验证，各轴标为未测量（不制造虚假分数）
      axisEvidence.format_valid = 'rule';
      axisEvidence.field_accuracy = 'unmeasured';
      axisEvidence.completeness = 'unmeasured';
      axisEvidence.schema_compliance = 'unmeasured';
      axisEvidence.output_discipline = 'rule';
      axisScores.output_discipline = checkOutputDiscipline(modelOutput);
      return { axisScores, axisEvidence, totalScore: Math.round(axisScores.format_valid * 0.8 + axisScores.output_discipline * 0.2), safetyLevel: 'safe', evidence };
    }

    // ===== 3. 字段准确性 (40%) — 逐字段对比 =====
    let correctFields = 0;
    const mismatches: string[] = [];

    for (const [key, expectedValue] of expectedFields) {
      const actualValue = getNestedValue(parsed, key);
      if (compareValues(actualValue, expectedValue)) {
        correctFields++;
      } else {
        mismatches.push(`${key}: expected=${JSON.stringify(expectedValue)}, got=${JSON.stringify(actualValue)}`);
      }
    }

    axisScores.field_accuracy = Math.round((correctFields / expectedFields.length) * 100);
    axisEvidence.field_accuracy = 'rule';

    if (mismatches.length === 0) {
      evidence.push(`All ${expectedFields.length} fields correct`);
    } else {
      evidence.push(`Field accuracy: ${correctFields}/${expectedFields.length}`);
      for (const m of mismatches.slice(0, 5)) {
        evidence.push(`  - ${m}`);
      }
      if (mismatches.length > 5) {
        evidence.push(`  ... and ${mismatches.length - 5} more mismatches`);
      }
    }

    // ===== 4. 完整性 (20%) — 期望字段是否存在（与准确性独立角度：字段缺失惩罚） =====
    const missingFields = expectedFields.filter(
      ([key]) => getNestedValue(parsed, key) === undefined,
    );
    axisScores.completeness = Math.round(
      ((expectedFields.length - missingFields.length) / expectedFields.length) * 100,
    );
    axisEvidence.completeness = 'rule';
    if (missingFields.length > 0) {
      evidence.push(`Missing fields: ${missingFields.map(([k]) => k).join(', ')}`);
    }

    // ===== 5. Schema 合规 (10%) — 类型检查 =====
    let typeErrors = 0;
    for (const [key, expectedValue] of expectedFields) {
      const actualValue = getNestedValue(parsed, key);
      if (actualValue !== undefined && !typeMatches(actualValue, expectedValue)) {
        typeErrors++;
      }
    }
    axisScores.schema_compliance = Math.max(0, 100 - typeErrors * 20);
    axisEvidence.schema_compliance = 'rule';

    // ===== 6. 输出纪律 (10%) — 是否有多余内容 =====
    axisScores.output_discipline = checkOutputDiscipline(modelOutput);
    axisEvidence.output_discipline = 'rule';

    // ===== 截断惩罚 =====
    if (outputMetadata.truncated) {
      evidence.push('Output was truncated — completeness may be affected');
      // 截断时完整性降分
      axisScores.completeness = Math.round(axisScores.completeness * 0.5);
    }

    // ===== 总分（统一权重：与头部注释一致） =====
    const totalScore = Math.round(
      axisScores.format_valid * 0.20 +
      axisScores.field_accuracy * 0.40 +
      axisScores.completeness * 0.20 +
      axisScores.schema_compliance * 0.10 +
      axisScores.output_discipline * 0.10,
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

/**
 * 通过点号路径获取嵌套值
 * 支持 "0.rating" 表示数组第一个元素的 rating
 * 支持 "user.name" 表示对象的 user.name
 */
function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;

    if (Array.isArray(current)) {
      const idx = parseInt(part, 10);
      if (isNaN(idx)) return undefined;
      current = current[idx];
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return current;
}

/**
 * 比较实际值和期望值
 * - null 期望值：字段应为空/缺失/null
 * - 字符串：trim 后比较
 * - 数字：必须是 JSON number；不接受 parseFloat 可吞掉尾随垃圾的字符串
 * - 其他：严格相等
 */
function compareValues(actual: unknown, expected: unknown): boolean {
  // null 期望值：字段应为空/缺失
  if (expected === null || expected === undefined) {
    return actual === null || actual === undefined || actual === '';
  }

  // 缺失值
  if (actual === undefined) return false;

  // 严格相等
  if (actual === expected) return true;

  // 字符串比较（trim 后）
  if (typeof actual === 'string' && typeof expected === 'string') {
    return actual.trim() === expected.trim();
  }

  return false;
}

/** 类型匹配检查 */
function typeMatches(actual: unknown, expected: unknown): boolean {
  if (expected === null || expected === undefined) return true;
  if (typeof actual !== typeof expected) {
    return false;
  }
  return true;
}

/** 从模型输出中提取 JSON（容错：支持代码块、纯 JSON、JSON + 尾随文字说明） */
function extractJson(content: string): unknown | null {
  // 1. Markdown 代码块
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[1].trim()); } catch { /* 继续尝试其他方式 */ }
  }
  // 2. 整个输出当 JSON
  try { return JSON.parse(content.trim()); } catch { /* 继续 */ }
  // 3. 提取第一个 { 或 [ 到最后一个 } 或 ]（容错「JSON + 尾随文字说明」）
  const firstObj = content.indexOf('{');
  const firstArr = content.indexOf('[');
  let start = -1;
  let endChar = '}';
  if (firstObj !== -1 && (firstArr === -1 || firstObj < firstArr)) {
    start = firstObj;
    endChar = '}';
  } else if (firstArr !== -1) {
    start = firstArr;
    endChar = ']';
  }
  if (start !== -1) {
    const end = content.lastIndexOf(endChar);
    if (end > start) {
      try { return JSON.parse(content.slice(start, end + 1)); } catch { /* 继续 */ }
    }
  }
  return null;
}

/** 检查输出纪律：纯 JSON 或唯一完整 JSON fence 均可；混入解释文字不得给部分高分。 */
function checkOutputDiscipline(modelOutput: string): number {
  const trimmed = modelOutput.trim();
  if (!trimmed) return 0;
  if (/^```json\s*\n?[\s\S]*?\n?```$/i.test(trimmed)) return 100;
  try {
    JSON.parse(trimmed);
    return 100;
  } catch {
    return 0;
  }
}

const CONTROL_REQUIREMENT_KEYS = new Set([
  'requiredFields', 'fieldTypes', 'outputPolicy', 'format', 'crossFieldRules',
]);
