// ============================================================
// 官方运行资格门槛（Phase 1）
// 官方 run 仅允许 reviewStatus=verified 且 tier ∈ {private_validation, blind_holdout}
// 且 gold 来源可溯源、hash 非空的题目；public_dev/unreviewed 仅用于开发。
// ============================================================

import type { Scenario, ScenarioEligibility } from '@zxbench/types';
import { validateScenario } from './validateScenario.js';

/** 官方资格要求的 tier */
const OFFICIAL_TIERS = new Set(['private_validation', 'blind_holdout']);

/**
 * 判定题目是否满足 official 门槛。
 * official 要求：契约校验通过 + 已 review + 保护性 tier + gold 可溯源 + hash 非空。
 */
export function checkScenarioEligibility(scenario: Scenario): ScenarioEligibility {
  const reasons: string[] = [];
  const report = validateScenario(scenario);

  if (report.errors.length > 0) {
    reasons.push(`契约校验失败: ${report.errors.map((e) => e.code).join(', ')}`);
  }
  if (scenario.reviewStatus !== 'verified') {
    reasons.push(`reviewStatus=${scenario.reviewStatus}（官方要求 verified）`);
  }
  if (!OFFICIAL_TIERS.has(scenario.tier)) {
    reasons.push(`tier=${scenario.tier}（官方要求 private_validation/blind_holdout）`);
  }
  if (!scenario.goldSource) {
    reasons.push('缺少 goldSource（gold 来源不可溯源）');
  }
  if (!scenario.goldVerifiedAt) {
    reasons.push('缺少 goldVerifiedAt（gold 未经独立验证）');
  }

  return { eligible: reasons.length === 0, reasons };
}

/**
 * 批量过滤：返回 { eligible, ineligible } 两桶。
 */
export function partitionByEligibility(scenarios: Scenario[]): {
  eligible: Scenario[];
  ineligible: { scenario: Scenario; reasons: string[] }[];
} {
  const eligible: Scenario[] = [];
  const ineligible: { scenario: Scenario; reasons: string[] }[] = [];
  for (const s of scenarios) {
    const r = checkScenarioEligibility(s);
    if (r.eligible) eligible.push(s);
    else ineligible.push({ scenario: s, reasons: r.reasons });
  }
  return { eligible, ineligible };
}
