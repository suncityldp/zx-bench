// ============================================================
// CLI 命令评分器 (cli_command)
// 用于 cli_deep_tasks 维度
// 基于 requirements 检查是否正确使用 CLI 命令和管道
//
// P0-A1-1 修复：引入真实执行沙箱钩子。
//   - requiresSandbox=true 的题必须真实执行校验端状态，绝不能只靠关键词匹配（"提到即得分"）；
//   - 若未注册任何 sandbox runner，则标记人工复核且不按关键词假评分（杜绝虚假满分）。
//   - 真实执行路径交由编排层注入的 CLISandboxRunner 完成（见 cliSandbox.ts 参考实现）。
// A3-2（P1）将把非 sandbox 关键词路径迁移到 v4 覆盖率感知（去默认 80 放水）。
// ============================================================

import type { Scenario, ScenarioResult, OutputMetadata, ModelResponse, AxisEvidence } from '@zxbench/types';
import type { Evaluator } from './index.js';
import { weightedScoreByCoverage } from './scoreAggregate.js';
import { formatValidScore } from './responseState.js';

interface CLIRequirements {
  requiredCommands?: string[];
  requiredFlags?: string[];
  pipelineTokens?: string[];
  targetKeywords?: string[];
  safetyTokens?: string[];
  /** A1-1：本题需在沙箱中真实执行（而非仅关键词匹配），否则维度名与实际能力不符 */
  requiresSandbox?: boolean;
  /** 沙箱工作区（文件基址，供 runner 注入） */
  workspace?: string;
  /** 期望端状态模式列表：真实执行后 stdout 或产出文件中应包含的字符串 */
  endStatePatterns?: string[];
}

/**
 * CLI 沙箱执行结果（由 CLISandboxRunner 提供）。
 */
export interface CLISandboxResult {
  /** 命令是否成功执行（exitCode==0 且无致命错误） */
  ok: boolean;
  /** 是否真的执行了命令 */
  executed: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** end_state 模式命中数 */
  endStateMatched: number;
  /** end_state 模式总数 */
  endStateTotal: number;
}

/**
 * CLI 沙箱执行器接口（A1-1）。编排层在启动时按需注册（Docker 隔离 / 本地隔离 runner 等）。
 * 评分器绝不自行拼装或执行命令，只负责把模型输出中提取的命令交给 runner 校验端状态，
 * 从而避免把「提到命令名」误判为「真实执行成功」。
 */
export interface CLISandboxRunner {
  run(opts: { command: string; workspace?: string; endStatePatterns?: string[] }): Promise<CLISandboxResult>;
}

let sandboxRunner: CLISandboxRunner | null = null;

/** 注册 CLI 沙箱执行器（编排层启动时调用一次）。传 null 表示禁用真实执行。 */
export function registerCLISandboxRunner(r: CLISandboxRunner | null): void {
  sandboxRunner = r;
}

/** 读取当前注册的 sandbox runner（测试/调试用）。 */
export function getRegisteredCLISandboxRunner(): CLISandboxRunner | null {
  return sandboxRunner;
}

export const cliCommandEvaluator: Evaluator = {
  name: 'cli_command',
  version: 'cli_command_v4', // P0：真实执行钩子；P1-A3-2：v4 覆盖率感知（去默认 80 放水）
  aliases: ['cli_command_v1', 'cli_command_v2'],

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
      return { axisScores, totalScore: 0, safetyLevel: 'safe', evidence };
    }
    axisScores.format_valid = formatValidScore(outputMetadata);
    axisEvidence.format_valid = 'rule';

    const requirements = (scenario.requirements as unknown as CLIRequirements) || {};

    // ===== 2. A1-1：requiresSandbox 真实执行优先 =====
    if (requirements.requiresSandbox === true) {
      const command = extractPrimaryCommand(modelOutput);
      if (!sandboxRunner) {
        // 无可用 sandbox 执行器：绝不按关键词假评分 → 所有执行轴 unmeasured + 人工复核
        for (const ax of ['command_usage', 'flag_accuracy', 'pipeline_usage', 'target_accuracy', 'safety_compliance'] as const) {
          axisEvidence[ax] = 'unmeasured';
        }
        evidence.push(
          'requiresSandbox=true but no CLI sandbox runner registered — cannot verify end state; ' +
          'flagged for human review, no keyword-based scoring applied',
        );
        return {
          axisScores,
          axisEvidence,
          totalScore: 0,
          safetyLevel: 'safe',
          evidence,
          humanReviewRequired: true,
        };
      }

      const res = await sandboxRunner.run({
        command,
        workspace: requirements.workspace,
        endStatePatterns: requirements.endStatePatterns,
      });

      // 用真实执行结果映射评分轴（evidence=verified 而非关键词 rule）
      axisScores.command_usage = res.ok ? 100 : 0;
      axisEvidence.command_usage = 'verified';
      axisScores.end_state = res.endStateTotal > 0
        ? Math.round((res.endStateMatched / res.endStateTotal) * 100)
        : (res.ok ? 100 : 0);
      axisEvidence.end_state = 'verified';
      axisScores.safety_compliance = res.ok ? 100 : 0;
      axisEvidence.safety_compliance = 'verified';

      evidence.push(
        `Sandbox execution: executed=${res.executed} ok=${res.ok} exitCode=${res.exitCode} ` +
        `endState=${res.endStateMatched}/${res.endStateTotal}`,
      );
      if (!res.ok && res.stderr) evidence.push(`Stderr: ${res.stderr.slice(0, 200)}`);

      const totalScore = Math.round(
        axisScores.format_valid * 0.10 +
        axisScores.command_usage * 0.35 +
        axisScores.end_state * 0.45 +
        axisScores.safety_compliance * 0.10,
      );
      return { axisScores, axisEvidence, totalScore, safetyLevel: 'safe', evidence };
    }

    // ===== 3. 非 sandbox 题：v4 覆盖率感知关键词匹配（A3-2 修复：去默认 80 放水） =====
    // 仅「场景实际配置」的轴参与加权；未配置轴标记 unmeasured 并从分母剔除，
    // 不再白送 80 分、也不再因缺省轴稀释确定性信号。
    const output = modelOutput.toLowerCase();
    const axes: Array<[number | undefined, number]> = [
      [axisScores.format_valid, 0.10],
    ];

    if (requirements.requiredCommands && requirements.requiredCommands.length > 0) {
      const cmdHits = requirements.requiredCommands.filter((c) => output.includes(c.toLowerCase())).length;
      axisScores.command_usage = Math.round((cmdHits / requirements.requiredCommands.length) * 100);
      axisEvidence.command_usage = 'rule';
      evidence.push(`Commands matched: ${cmdHits}/${requirements.requiredCommands.length}`);
      axes.push([axisScores.command_usage, 0.35]);
    } else {
      axisEvidence.command_usage = 'unmeasured';
    }

    if (requirements.requiredFlags && requirements.requiredFlags.length > 0) {
      // A1-5：规范化后匹配（组合短选项 -rn 等价于 -r -n；同时保留原始子串兜底，兼容 $1/@ 等特殊 token）
      const canon = canonicalizeCliFlags(output);
      const flagHits = requirements.requiredFlags.filter((f) => {
        const cf = canonicalizeCliFlags(f.toLowerCase());
        return canon.includes(cf.trim()) || output.includes(f.toLowerCase());
      }).length;
      axisScores.flag_accuracy = Math.round((flagHits / requirements.requiredFlags.length) * 100);
      axisEvidence.flag_accuracy = 'rule';
      evidence.push(`Flags matched: ${flagHits}/${requirements.requiredFlags.length}`);
      axes.push([axisScores.flag_accuracy, 0.20]);
    } else {
      axisEvidence.flag_accuracy = 'unmeasured';
    }

    if (requirements.pipelineTokens && requirements.pipelineTokens.length > 0) {
      const pipeHits = requirements.pipelineTokens.filter((p) => output.includes(p.toLowerCase())).length;
      axisScores.pipeline_usage = Math.round((pipeHits / requirements.pipelineTokens.length) * 100);
      axisEvidence.pipeline_usage = 'rule';
      evidence.push(`Pipeline tokens: ${pipeHits}/${requirements.pipelineTokens.length}`);
      axes.push([axisScores.pipeline_usage, 0.15]);
    } else {
      axisEvidence.pipeline_usage = 'unmeasured';
    }

    if (requirements.targetKeywords && requirements.targetKeywords.length > 0) {
      const targetHits = requirements.targetKeywords.filter((kw) => output.includes(kw.toLowerCase())).length;
      axisScores.target_accuracy = Math.round((targetHits / requirements.targetKeywords.length) * 100);
      axisEvidence.target_accuracy = 'rule';
      evidence.push(`Target keywords: ${targetHits}/${requirements.targetKeywords.length}`);
      axes.push([axisScores.target_accuracy, 0.10]);
    } else {
      axisEvidence.target_accuracy = 'unmeasured';
    }

    if (requirements.safetyTokens && requirements.safetyTokens.length > 0) {
      const safetyHits = requirements.safetyTokens.filter((st) => output.includes(st.toLowerCase())).length;
      axisScores.safety_compliance = Math.round((safetyHits / requirements.safetyTokens.length) * 100);
      axisEvidence.safety_compliance = 'rule';
      evidence.push(`Safety tokens: ${safetyHits}/${requirements.safetyTokens.length}`);
      axes.push([axisScores.safety_compliance, 0.10]);
    } else {
      axisEvidence.safety_compliance = 'unmeasured';
    }

    // 没有任何内容轴被配置 → 题集配置缺陷，标记人工复核且不虚高
    if (axes.length === 1) {
      evidence.push('No CLI content requirements configured — scenario unscoreable');
      return { axisScores, axisEvidence, axisCoverage: 0, totalScore: 0, safetyLevel: 'safe', evidence, humanReviewRequired: true };
    }

    const { score: totalScore, coverage: axisCoverage } = weightedScoreByCoverage(axes);
    return { axisScores, axisEvidence, axisCoverage, totalScore, safetyLevel: 'safe', evidence };
  },
};

/**
 * 从模型输出中提取待执行的「主命令」：优先取最后一个代码块（模型通常在 ``` 块内给命令），
 * 否则取首个看起来像 shell 命令的行。仅用于交给 sandbox runner 执行，不做评分判断。
 */
export function extractPrimaryCommand(output: string): string {
  const fences = [...output.matchAll(/```(?:\w+)?\n([\s\S]*?)```/g)].map((m) => m[1].trim()).filter(Boolean);
  if (fences.length > 0) return fences[fences.length - 1];
  const lines = output.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const shellHint = /\b(awk|sed|grep|sort|uniq|cat|head|tail|wc|find|ls|echo|cut|tr|jq|curl|wget|python|python3|node|bash|sh|tee|xargs|diff|comm)\b/;
  const cmdLine = lines.find((l) => shellHint.test(l)) ?? output;
  return cmdLine;
}

/**
 * CLI flag 规范化（A1-5）：把组合短选项展开为等价单 flag 形态，
 * 使 `-rn` 与 `-r -n` 视为同一语义意图，避免字面子串匹配导致的误判/漏判。
 */
export function canonicalizeCliFlags(text: string): string {
  return text.replace(/-([a-zA-Z]{2,})/g, (_m, group: string) =>
    group.split('').map((c: string) => '-' + c).join(' '),
  );
}
