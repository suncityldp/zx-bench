// ============================================================
// 场景稳定规范化与哈希（Phase 1）
// 单一 hash 实现：字段按固定顺序输出、明确 null/undefined 语义，
// 供导入/导出双向校验与审计链（P1-A5）。
// ============================================================

import { createHash } from 'node:crypto';
import type { Scenario } from '@zxbench/types';

/** 参与 canonical hash 的字段（固定顺序，避免键序漂移） */
const HASH_FIELDS = [
  'id',
  'dimension',
  'category',
  'difficulty',
  'language',
  'locale',
  'status',
  'tier',
  'promptTemplate',
  'sourceCode',
  'functionName',
  'expectedVerdict',
  'grader',
  'graderVersion',
  'scoring',
  'hiddenTests',
  'publicTests',
  'requirements',
  'responseMode',
  'outputPolicy',
  'answerFirst',
  'maxAnswerTokens',
  'maxReasoningTokens',
] as const;

/** 深度稳定化：递归排序对象键、数组保持顺序、undefined → null */
function stabilize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stabilize);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = stabilize((value as Record<string, unknown>)[key]);
  }
  return out;
}

/** 稳定规范 JSON 字符串（字段排序 + null/undefined 语义统一） */
export function canonicalizeScenario(scenario: Scenario): string {
  const canonical: Record<string, unknown> = {};
  for (const field of HASH_FIELDS) {
    const v = (scenario as unknown as Record<string, unknown>)[field];
    canonical[field] = stabilize(v);
  }
  return JSON.stringify(canonical);
}

/** 稳定 hash（sha256 hex，前 16 位用于简短标识） */
export function hashScenario(scenario: Scenario): string {
  return createHash('sha256').update(canonicalizeScenario(scenario), 'utf8').digest('hex');
}

/** 短 hash（与既有 scenarioHash 字段长度对齐：16 位） */
export function hashScenarioShort(scenario: Scenario): string {
  return hashScenario(scenario).slice(0, 16);
}
