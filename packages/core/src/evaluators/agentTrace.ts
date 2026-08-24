// ============================================================
// Agent 轨迹评分器 (agent_trace) v5
// 用于 agent_workflow 维度
// 契约修复：
//   - 移除默认值放水：无 planning/action/state/completion 需求时对应轴 unmeasured
//   - "提及即得分" → "调用即得分"：动作要求工具名以结构化调用形态出现
//   - 新增顺序校验：expectedActions 必须按声明顺序依次调用
// ============================================================

import type { Scenario, ScenarioResult, OutputMetadata, ModelResponse, AxisEvidence } from '@zxbench/types';
import type { Evaluator } from './index.js';
import { findToolCallIndex } from './callMatch.js';
import { weightedScoreByCoverage } from './scoreAggregate.js';
import { formatValidScore } from './responseState.js';

interface AgentAction {
  tool?: string;
  paramPatterns?: string[];
}

interface AgentRequirements {
  expectedActions?: AgentAction[];
  expectedStateChanges?: Array<{ key: string; patterns: string[] }>;
  completionKeywords?: string[];
  planningKeywords?: string[];
}

export const agentTraceEvaluator: Evaluator = {
  name: 'agent_trace',
  version: 'agent_trace_v5',

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
      return { axisScores, axisEvidence, totalScore: 0, safetyLevel: 'safe', evidence };
    }
    axisScores.format_valid = formatValidScore(outputMetadata);
    axisEvidence.format_valid = 'rule';

    const requirements = (scenario.requirements as unknown as AgentRequirements) || {};
    const output = modelOutput.toLowerCase();

    // ===== 2. 规划/推理步骤检查 (20%) =====
    if (requirements.planningKeywords && requirements.planningKeywords.length > 0) {
      const planningHits = requirements.planningKeywords.filter((kw) =>
        output.includes(kw.toLowerCase()),
      ).length;
      axisScores.planning = Math.round(
        (planningHits / requirements.planningKeywords.length) * 100,
      );
      axisEvidence.planning = 'rule';
      evidence.push(`Planning keywords: ${planningHits}/${requirements.planningKeywords.length}`);
    } else {
      axisEvidence.planning = 'unmeasured';
      evidence.push('No planning keywords configured — planning unmeasured');
    }

    // ===== 3. 动作序列检查 (40%)：结构化调用 + 顺序校验 =====
    if (requirements.expectedActions && requirements.expectedActions.length > 0) {
      let actionHits = 0;
      let lastIdx = -1;
      const orderViolations: string[] = [];

      for (const action of requirements.expectedActions) {
        const toolName = (action.tool || '').toLowerCase();
        if (!toolName) { actionHits++; continue; }

        // 要求工具以结构化调用形态出现
        const idx = findToolCallIndex(modelOutput, toolName);
        if (idx === -1) {
          evidence.push(`Action not called: ${toolName}`);
          continue;
        }
        // 顺序校验：调用位置必须严格递增
        if (idx <= lastIdx) {
          orderViolations.push(toolName);
          evidence.push(`Action out of order: ${toolName} (pos ${idx}, expected after ${lastIdx})`);
          continue;
        }
        lastIdx = idx;

        // 参数模式：至少一个出现在输出中
        if (action.paramPatterns && action.paramPatterns.length > 0) {
          const paramHits = action.paramPatterns.filter((p) =>
            output.includes(p.toLowerCase()),
          ).length;
          if (paramHits > 0) {
            actionHits++;
          } else {
            evidence.push(`Action called but params missing: ${toolName}`);
          }
        } else {
          actionHits++;
        }
      }

      axisScores.action_sequence = Math.round(
        (actionHits / requirements.expectedActions.length) * 100,
      );
      axisEvidence.action_sequence = 'rule';
      evidence.push(`Actions matched (in order): ${actionHits}/${requirements.expectedActions.length}${orderViolations.length ? `, out-of-order: ${orderViolations.join(', ')}` : ''}`);
    } else {
      axisEvidence.action_sequence = 'unmeasured';
      evidence.push('No expected actions configured — action sequence unmeasured');
    }

    // ===== 4. 状态变化检查 (20%) =====
    if (requirements.expectedStateChanges && requirements.expectedStateChanges.length > 0) {
      let stateHits = 0;
      for (const sc of requirements.expectedStateChanges) {
        const matched = sc.patterns.some((p) => output.includes(p.toLowerCase()));
        if (matched) stateHits++;
      }
      axisScores.state_awareness = Math.round(
        (stateHits / requirements.expectedStateChanges.length) * 100,
      );
      axisEvidence.state_awareness = 'rule';
      evidence.push(`State changes: ${stateHits}/${requirements.expectedStateChanges.length}`);
    } else {
      axisEvidence.state_awareness = 'unmeasured';
      evidence.push('No expected state changes configured — state awareness unmeasured');
    }

    // ===== 5. 完成度关键词检查 (10%) =====
    if (requirements.completionKeywords && requirements.completionKeywords.length > 0) {
      const completionHits = requirements.completionKeywords.filter((kw) =>
        output.includes(kw.toLowerCase()),
      ).length;
      axisScores.completion = Math.round(
        (completionHits / requirements.completionKeywords.length) * 100,
      );
      axisEvidence.completion = 'rule';
      evidence.push(`Completion keywords: ${completionHits}/${requirements.completionKeywords.length}`);
    } else {
      axisEvidence.completion = 'unmeasured';
      evidence.push('No completion keywords configured — completion unmeasured');
    }

    // ===== 6. 总分：已测量轴加权 + 覆盖率保底（题集缺检查项时打折，不虚高） =====
    // A3-1 修复：仅纳入「场景实际配置」的轴（见 tool_call_trace 同款修复），
    // 避免合法缺省（未配置的 planning/state/completion）被计入覆盖率分母触发误打折。
    const axes: Array<[number | undefined, number]> = [
      [axisScores.format_valid, 0.10],
    ];
    if (requirements.planningKeywords && requirements.planningKeywords.length > 0) axes.push([axisScores.planning, 0.20]);
    if (requirements.expectedActions && requirements.expectedActions.length > 0) axes.push([axisScores.action_sequence, 0.40]);
    if (requirements.expectedStateChanges && requirements.expectedStateChanges.length > 0) axes.push([axisScores.state_awareness, 0.20]);
    if (requirements.completionKeywords && requirements.completionKeywords.length > 0) axes.push([axisScores.completion, 0.10]);
    const { score: totalScore, coverage: axisCoverage } = weightedScoreByCoverage(axes);

    return { axisScores, axisEvidence, axisCoverage, totalScore, safetyLevel: 'safe', evidence };
  },
};
