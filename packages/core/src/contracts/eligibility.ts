// ============================================================
// ============================================================
// 正式运行资格门槛
// 公开发布的轻量题库不拥有私有 holdout；不能因 public_dev
// 标签或原有 review 元数据而让“正式评测”完全不可用。正式运行仍严格要求：
// 题目当前有效、内容哈希已冻结、且不是开发影子题。
// review/tier/gold 仍作为报告审计元数据，而不是面向用户的运行阻断。
// ============================================================

import type { Scenario, ScenarioEligibility } from '@zxbench/types';
import { validateScenario } from './validateScenario.js';
import { hashScenario, hashScenarioShort } from './canonicalize.js';
import { knownScenarioDefects } from './knownDefects.js';

/**
 * 判定题目是否可进入公开发行的正式运行。
 * 依据是可执行的发行契约，不把不存在的私有题库当成前置条件。
 */
export function checkScenarioEligibility(scenario: Scenario): ScenarioEligibility {
  const reasons: string[] = [...knownScenarioDefects(scenario)];
  const report = validateScenario(scenario);

  if (report.errors.length > 0) {
    reasons.push(`契约校验失败: ${report.errors.map((e) => e.code).join(', ')}`);
  }
  if (scenario.status !== 'valid') {
    reasons.push(`status=${scenario.status}（正式运行仅接收 valid 题目）`);
  }
  if ((scenario.requirements as unknown as { developmentShadow?: boolean } | undefined)?.developmentShadow === true) {
    reasons.push('开发影子题不进入正式分数');
  }
  if (scenario.scenarioHash !== hashScenario(scenario) && scenario.scenarioHash !== hashScenarioShort(scenario)) {
    reasons.push('scenarioHash 与题目内容不匹配（须重新审核并冻结）');
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
