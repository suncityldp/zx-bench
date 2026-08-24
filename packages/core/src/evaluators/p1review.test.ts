import { describe, it, expect, beforeEach } from 'vitest';
import type { Scenario, OutputMetadata } from '@zxbench/types';
import { toolCallTraceEvaluator } from './toolCallTrace.js';
import { cliCommandEvaluator, registerCLISandboxRunner } from './cliCommand.js';
import { getJudgeWeights, analyzeDifficultyDistribution } from '../scoring.js';
import { recommendDimension, validateDimensionDisjointness } from '../contracts/registry.js';

function meta(truncated = false): OutputMetadata {
  return {
    finishReason: 'stop',
    truncated,
    containsCodeBlock: false,
    containsFinalConclusion: true,
    outputLength: 100,
    outputTokens: 50,
    inputTokens: 10,
    maxTokens: 4096,
    incomplete: false,
  };
}

function scenario(overrides: Record<string, unknown>): Scenario {
  return {
    id: 'T1',
    dimension: 'tool_cli_workflow',
    category: 'cat',
    difficulty: 'medium',
    language: 'python',
    locale: 'zh-CN',
    status: 'valid',
    tier: 'core',
    promptTemplate: 'do it',
    grader: 'tool_call_trace',
    graderVersion: 'tool_trace_v4',
    scoring: {},
    scenarioVersion: '1',
    scenarioHash: 'h',
    ...overrides,
  } as unknown as Scenario;
}

describe('P1-A3-4: 工具/CLI/Agent 维度确定性权重提升、Judge 占比下降', () => {
  it('tool_cli_workflow & agent_workflow 确定性 0.85 / judge 0.15', () => {
    expect(getJudgeWeights('tool_cli_workflow', 'tool_call_trace')).toEqual({ deterministic: 0.85, judge: 0.15 });
    expect(getJudgeWeights('agent_workflow', 'agent_trace')).toEqual({ deterministic: 0.85, judge: 0.15 });
  });
  it('cli_deep_tasks 确定性 0.7 / judge 0.3', () => {
    expect(getJudgeWeights('cli_deep_tasks', 'cli_command')).toEqual({ deterministic: 0.7, judge: 0.3 });
  });
});

describe('P1-A3-2: cli_command v4 覆盖率感知（去默认 80 放水）', () => {
  beforeEach(() => registerCLISandboxRunner(null));
  it('配置 requiredCommands 且命中 → coverage=1、totalScore=100（不再白送默认分）', async () => {
    const s = scenario({ dimension: 'cli_deep_tasks', grader: 'cli_command', requirements: { requiredCommands: ['awk', 'sort'] } });
    const r = await cliCommandEvaluator.evaluate(s, 'use awk and sort here', meta());
    expect(r.axisCoverage).toBeCloseTo(1.0, 5);
    expect(r.totalScore).toBe(100);
    expect(r.axisEvidence?.command_usage).toBe('rule');
  });
  it('配置 requiredCommands 但未命中 → command_usage=0 且明显低于旧的默认 84（不再默认 80 放水）', async () => {
    const s = scenario({ dimension: 'cli_deep_tasks', grader: 'cli_command', requirements: { requiredCommands: ['awk'] } });
    const r = await cliCommandEvaluator.evaluate(s, 'I will use grep only', meta());
    expect(r.axisScores?.command_usage).toBe(0);
    // 旧逻辑会默认 command_usage=80 → totalScore≈84；v4 下只有 format(10%) 贡献 → 远低于 80
    expect(r.totalScore!).toBeLessThan(50);
  });
  it('无任何内容轴配置 → 标记人工复核 + totalScore=0（不再得 84）', async () => {
    const s = scenario({ dimension: 'cli_deep_tasks', grader: 'cli_command', requirements: {} });
    const r = await cliCommandEvaluator.evaluate(s, 'some prose', meta());
    expect(r.totalScore).toBe(0);
    expect(r.humanReviewRequired).toBe(true);
  });
});

describe('P1-A1-3: sequence/orderMatters 顺序工作流真正落地', () => {
  it('顺序正确 → call_discipline 满分、totalScore=100', async () => {
    const s = scenario({ requirements: { sequence: ['search', 'download'] } });
    const out = 'First search(query="x") then download(url="y").';
    const r = await toolCallTraceEvaluator.evaluate(s, out, meta());
    expect(r.totalScore).toBe(100);
    expect(r.evidence?.some((e) => e.includes('sequence order violated'))).toBe(false);
  });
  it('顺序错误 → 扣分（不再忽略顺序）', async () => {
    const s = scenario({ requirements: { sequence: ['search', 'download'] } });
    const out = 'First download(url="y") then search(query="x").';
    const r = await toolCallTraceEvaluator.evaluate(s, out, meta());
    expect(r.evidence?.some((e) => e.includes('sequence order violated'))).toBe(true);
    expect(r.totalScore).toBeLessThan(100);
  });
});

describe('P1-A1-2: 维度非重叠定义 + 互斥校验', () => {
  it('recommendDimension 按 signature 字段推荐正确维度', () => {
    expect(recommendDimension({ tool: 'x' })).toBe('tool_cli_workflow');
    expect(recommendDimension({ requiredCommands: ['x'] })).toBe('cli_deep_tasks');
    expect(recommendDimension({ expectedActions: [{ tool: 'x' }] })).toBe('agent_workflow');
    expect(recommendDimension({})).toBeNull();
  });
  it('validateDimensionDisjointness 捕捉跨维度字段重叠', () => {
    expect(validateDimensionDisjointness('tool_cli_workflow', { tool: 'x', requiredCommands: ['y'] })).not.toHaveLength(0);
    expect(validateDimensionDisjointness('tool_cli_workflow', { tool: 'x' })).toHaveLength(0);
  });
});

describe('P1-A2-1: 难度分布对目标的可量化偏离分析', () => {
  it('当前实际分布：hard+adversarial≈60% 远超目标 40%，整体 offTarget', () => {
    const rep = analyzeDifficultyDistribution({ easy: 75, medium: 184, hard: 270, adversarial: 123 });
    expect(rep.total).toBe(652);
    expect(rep.hardPlusAdversarial).toBeCloseTo(0.6028, 3);
    expect(rep.offTarget).toBe(true);
    expect(rep.deviation.easy).toBeLessThan(0); // easy 欠配
    expect(rep.deviation.hard).toBeGreaterThan(0); // hard 超配
  });
});
