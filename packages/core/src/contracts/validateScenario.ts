// ============================================================
// 场景契约运行时校验（Phase 1）
// 校验 scenario 是否满足其 grader 契约：未知字段、缺失必需字段、
// 未注册评分器、不支持的 format/language、空 hash、权重和等。
// 默认宽松模式（未知字段 → warning），strict 模式（→ error）用于 CI gate。
// ============================================================

import type {
  Scenario,
  ValidationReport,
  ContractValidationIssue,
} from '@zxbench/types';
import { getGraderContract } from './registry.js';

export interface ValidateScenarioOptions {
  /** 严格模式：未知字段/未消费字段升级为 error（CI gate 用） */
  strict?: boolean;
}

/** 读取 requirements 对象（运行时它是对象，尽管类型声明是 string[]） */
function readRequirements(scenario: Scenario): Record<string, unknown> {
  const req = scenario.requirements as unknown;
  if (req && typeof req === 'object' && !Array.isArray(req)) {
    return req as Record<string, unknown>;
  }
  return {};
}

export function validateScenario(
  scenario: Scenario,
  options: ValidateScenarioOptions = {},
): ValidationReport {
  const { strict = false } = options;
  const errors: ContractValidationIssue[] = [];
  const warnings: ContractValidationIssue[] = [];
  const push = (severity: 'error' | 'warning', code: string, message: string, path?: string) => {
    (severity === 'error' ? errors : warnings).push({ severity, code, message, path });
  };

  const contract = getGraderContract(scenario.grader);
  const requirements = readRequirements(scenario);
  const reqKeys = Object.keys(requirements);

  // 1. 评分器是否注册
  if (!contract) {
    push('error', 'UNREGISTERED_GRADER', `grader "${scenario.grader}" 未在契约注册表中`);
    return { scenarioId: scenario.id, grader: scenario.grader, graderVersion: scenario.graderVersion, eligible: false, errors, warnings };
  }

  // 2. 版本是否匹配契约
  if (contract.version !== scenario.graderVersion) {
    push('warning', 'VERSION_MISMATCH',
      `graderVersion "${scenario.graderVersion}" 与契约版本 "${contract.version}" 不一致`);
  }

  // 3. 未知 / 未消费字段
  for (const key of reqKeys) {
    const isDeclared = contract.declaredFields.includes(key);
    const isDynamic = contract.dynamicFieldPatterns?.some((re) => re.test(key)) ?? false;
    if (!isDeclared && !isDynamic) {
      const consumed = contract.consumedFields.includes(key);
      const sev = strict ? 'error' : 'warning';
      push(sev, 'UNKNOWN_FIELD',
        `requirements 字段 "${key}" 不在契约声明中（evaluator ${consumed ? '有消费' : '未消费'}）`,
        `requirements.${key}`);
    } else if (isDeclared && !contract.consumedFields.includes(key) && !isDynamic) {
      // 已声明但 evaluator 尚未消费 → 待迁移提示
      push('warning', 'UNCONSUMED_FIELD',
        `字段 "${key}" 已声明但 evaluator 尚未消费（Phase 3 待迁移）`,
        `requirements.${key}`);
    }
  }

  // 4. 缺失必需字段
  for (const field of contract.requiredFields) {
    if (!reqKeys.includes(field)) {
      push('error', 'MISSING_REQUIRED', `缺少必需字段 "${field}"`, `requirements.${field}`);
    }
  }

  // 5. format 支持（structured_output）
  if (contract.capabilities.supportedFormats && requirements.format != null) {
    const fmt = String(requirements.format);
    if (!contract.capabilities.supportedFormats.includes(fmt)) {
      push('error', 'UNSUPPORTED_FORMAT',
        `format "${fmt}" 不在支持列表 [${contract.capabilities.supportedFormats.join(', ')}]`,
        'requirements.format');
    }
  }

  // 6. language 支持（program）
  if (contract.capabilities.supportedLanguages && scenario.language) {
    const lang = scenario.language.toLowerCase();
    if (!contract.capabilities.supportedLanguages.includes(lang)) {
      push('error', 'UNSUPPORTED_LANGUAGE',
        `language "${scenario.language}" 不在支持列表`, 'language');
    } else if (!(contract.capabilities.executableLanguages ?? []).includes(lang)) {
      push('warning', 'STATIC_ONLY_LANGUAGE',
        `language "${scenario.language}" 仅静态/关键词评分，无运行时验证（Phase 2 待容器化）`,
        'language');
    }
  }

  // 7. 空 hash（official 门槛）
  if (!scenario.scenarioHash || scenario.scenarioHash.length === 0) {
    push('error', 'EMPTY_HASH', 'scenarioHash 为空，无法形成审计链', 'scenarioHash');
  }

  // 8. scoring.weights 和（若存在）
  const scoring = scenario.scoring as unknown as { weights?: Record<string, number> } | undefined;
  if (scoring?.weights) {
    const sum = Object.values(scoring.weights).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 0.001) {
      push('warning', 'WEIGHT_SUM', `scoring.weights 之和为 ${sum.toFixed(3)}（应 = 1）`, 'scoring.weights');
    }
  }

  return {
    scenarioId: scenario.id,
    grader: scenario.grader,
    graderVersion: scenario.graderVersion,
    eligible: errors.length === 0,
    errors,
    warnings,
  };
}
