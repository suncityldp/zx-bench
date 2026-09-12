// ============================================================
// 评分器基类接口
// ============================================================

import type { Scenario, ScenarioResult, ModelResponse, OutputMetadata, ModelConfig } from '@zxbench/types';

/** 评分器接口 */
export interface Evaluator {
  name: string;
  version: string;
  aliases?: string[];
  /** 已验证语义等价、可安全复用当前 evaluator 的历史版本。 */
  compatibleVersions?: string[];

  /** 评分 */
  evaluate(
    scenario: Scenario,
    modelOutput: string,
    outputMetadata: OutputMetadata,
    modelResponse?: ModelResponse,
    judgeModel?: ModelConfig,
  ): Promise<Partial<ScenarioResult>>;
}

/** 评分器注册表 */
const evaluators = new Map<string, Evaluator>();
const latestByName = new Map<string, Evaluator>();

export function registerEvaluator(evaluator: Evaluator): void {
  const key = `${evaluator.name}@${evaluator.version}`;
  evaluators.set(key, evaluator);
  latestByName.set(evaluator.name, evaluator);
  for (const version of evaluator.compatibleVersions ?? []) {
    evaluators.set(`${evaluator.name}@${version}`, evaluator);
  }
  // 注册别名
  const aliases = (evaluator as { aliases?: string[] }).aliases;
  if (aliases) {
    for (const alias of aliases) {
      evaluators.set(`${alias}@${evaluator.version}`, evaluator);
      latestByName.set(alias, evaluator);
      for (const version of evaluator.compatibleVersions ?? []) {
        evaluators.set(`${alias}@${version}`, evaluator);
      }
    }
  }
}

export function getEvaluator(name: string, version?: string): Evaluator | undefined {
  if (version) {
    // 不得把未知版本静默降级到“最新”实现；只有显式声明兼容的版本可复用。
    return evaluators.get(`${name}@${version}`);
  }
  return latestByName.get(name);
}

export function listEvaluators(): Array<{ name: string; version: string }> {
  return [...evaluators.values()].map((e) => ({ name: e.name, version: e.version }));
}
