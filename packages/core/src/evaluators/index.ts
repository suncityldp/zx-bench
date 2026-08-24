// ============================================================
// 评分器基类接口
// ============================================================

import type { Scenario, ScenarioResult, ModelResponse, OutputMetadata, ModelConfig } from '@zxbench/types';

/** 评分器接口 */
export interface Evaluator {
  name: string;
  version: string;
  aliases?: string[];

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

export function registerEvaluator(evaluator: Evaluator): void {
  const key = `${evaluator.name}@${evaluator.version}`;
  evaluators.set(key, evaluator);
  // 注册别名
  const aliases = (evaluator as { aliases?: string[] }).aliases;
  if (aliases) {
    for (const alias of aliases) {
      evaluators.set(`${alias}@${evaluator.version}`, evaluator);
    }
  }
}

export function getEvaluator(name: string, version?: string): Evaluator | undefined {
  if (version) {
    // 1. 精确匹配
    let key = `${name}@${version}`;
    let evaluator = evaluators.get(key);
    if (evaluator) return evaluator;

    // 2. 模糊匹配：name 可能是评分器的前缀 (如 code_repair → code_repair_v3)
    for (const [regKey, ev] of evaluators.entries()) {
      const [regName] = regKey.split('@');
      if (regName === name || regName.startsWith(name + '_')) return ev;
    }

    // 3. 忽略版本做 name 匹配（取最新版本）
    const entries = [...evaluators.entries()]
      .filter(([k]) => k.startsWith(name + '@') || k.startsWith(name + '_'));
    if (entries.length > 0) return entries[entries.length - 1][1];
  }
  // 找最新版本
  const entries = [...evaluators.entries()].filter(([k]) => k.startsWith(name + '@') || k.startsWith(name + '_'));
  return entries.length > 0 ? entries[entries.length - 1][1] : undefined;
}

export function listEvaluators(): Array<{ name: string; version: string }> {
  return [...evaluators.values()].map((e) => ({ name: e.name, version: e.version }));
}
