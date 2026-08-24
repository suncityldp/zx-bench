import { describe, it, expect, beforeEach } from 'vitest';
import type { Scenario, OutputMetadata } from '@zxbench/types';
import { toolCallTraceEvaluator } from './toolCallTrace.js';
import { agentTraceEvaluator } from './agentTrace.js';
import { instructionChecklistEvaluator } from './instructionChecklist.js';
import {
  cliCommandEvaluator,
  registerCLISandboxRunner,
  extractPrimaryCommand,
  getRegisteredCLISandboxRunner,
} from './cliCommand.js';
import { LocalCLISandboxRunner } from './cliSandbox.js';
import {
  computeWeightedTotal,
  computeDifficultyWeightedDimAvgs,
  normalizeDimension,
  DIMENSION_ALIASES,
} from '../scoring.js';

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

describe('P0-A3-1: 覆盖率分母仅计已配置轴（不再误打折满分答案）', () => {
  it('tool_call_trace: 只配 tool+params 的满分答案 coverage=1.0 且 totalScore=100', async () => {
    const s = scenario({
      dimension: 'tool_cli_workflow',
      grader: 'tool_call_trace',
      requirements: { tool: 'get_weather', params: { location: '北京' } },
    });
    const out = 'I will call get_weather(location="北京") now.';
    const r = await toolCallTraceEvaluator.evaluate(s, out, meta());
    expect(r.axisCoverage).toBeCloseTo(1.0, 5);
    expect(r.totalScore).toBe(100);
  });

  it('tool_call_trace: 配置 commands/discipline/patterns 时覆盖率仍为 1.0', async () => {
    const s = scenario({
      dimension: 'tool_cli_workflow',
      grader: 'tool_call_trace',
      requirements: {
        tool: 'search',
        params: { q: 'x' },
        commands: ['ls', 'cat'],
        should_call: ['search'],
        require_patterns: ['done'],
      },
    });
    const out = 'search(q="x") then ls and cat. done';
    const r = await toolCallTraceEvaluator.evaluate(s, out, meta());
    expect(r.axisCoverage).toBeCloseTo(1.0, 5);
  });

  it('agent_trace: 只配 expectedActions 的满分答案 coverage=1.0', async () => {
    const s = scenario({
      dimension: 'agent_workflow',
      grader: 'agent_trace',
      requirements: { expectedActions: [{ tool: 'search' }] },
    });
    const out = 'search(query="x")';
    const r = await agentTraceEvaluator.evaluate(s, out, meta());
    expect(r.axisCoverage).toBeCloseTo(1.0, 5);
    expect(r.totalScore).toBe(100);
  });

  it('instruction_checklist: 无约束配置 → totalScore=0（不再误打成 30 分）', async () => {
    const s = scenario({
      dimension: 'instruction_following',
      grader: 'instruction_checklist',
      requirements: {},
    });
    const out = 'some answer without constraints';
    const r = await instructionChecklistEvaluator.evaluate(s, out, meta());
    expect(r.totalScore).toBe(0);
    expect(r.axisCoverage).toBe(0);
  });
});

describe('P0-A3-3: 维度命名归一化 + 未知维度硬失败', () => {
  it('normalizeDimension 将 code_repair / codeRepair 归一到 program', () => {
    expect(normalizeDimension('code_repair')).toBe('program');
    expect(normalizeDimension('codeRepair')).toBe('program');
    expect(normalizeDimension('program')).toBe('program');
    expect(normalizeDimension('unknown_dim')).toBe('unknown_dim');
    expect(DIMENSION_ALIASES['code_repair']).toBe('program');
  });

  it('computeWeightedTotal 对未知维度硬失败（不再静默清零）', () => {
    expect(() => computeWeightedTotal(new Map([['code_repair', 80]]))).toThrow();
    expect(() => computeWeightedTotal(new Map([['ghost_dim', 80]]))).toThrow();
  });

  it('computeWeightedTotal 对已知维度正常（含 code_repair 已归一化后）', () => {
    expect(computeWeightedTotal(new Map([['program', 80]]))).toBe(80);
    expect(computeWeightedTotal(new Map([['program', 100]]))).toBe(100);
  });

  it('computeDifficultyWeightedDimAvgs 自动把 code_repair 归一到 program', () => {
    const results = [
      { scenarioId: 'a', dimension: 'code_repair', totalScore: 90 },
      { scenarioId: 'b', dimension: 'program', totalScore: 60 },
    ];
    const avgs = computeDifficultyWeightedDimAvgs(results, new Map([['a', 'medium'], ['b', 'medium']]));
    // 归一后两题都计入 program：(90+60)/2 = 75
    expect(avgs.get('program')).toBeCloseTo(75, 5);
    expect(avgs.has('code_repair')).toBe(false);
  });
});

describe('P0-A1-1: cli_deep_tasks 真实执行钩子 + 防假阳性', () => {
  beforeEach(() => {
    // 每个用例前重置 registry，避免互相污染
    registerCLISandboxRunner(null);
  });

  it('extractPrimaryCommand 优先取最后一个代码块', () => {
    const out = 'run this:\n```bash\necho hello > out.txt\n```';
    expect(extractPrimaryCommand(out)).toContain('echo hello');
  });

  it('requiresSandbox 但无 runner 注册 → 标记人工复核 + 不按关键词假评分（totalScore=0）', async () => {
    expect(getRegisteredCLISandboxRunner()).toBeNull();
    const s = scenario({
      dimension: 'cli_deep_tasks',
      grader: 'cli_command',
      requirements: { requiresSandbox: true, endStatePatterns: ['hello'] },
    });
    const out = 'You should run echo hello > out.txt to get the answer.';
    const r = await cliCommandEvaluator.evaluate(s, out, meta());
    expect(r.humanReviewRequired).toBe(true);
    expect(r.totalScore).toBe(0);
    // 执行轴不应被关键词命中计分
    expect(r.axisEvidence?.command_usage).toBe('unmeasured');
    expect(r.evidence?.some((e) => e.includes('no CLI sandbox runner registered'))).toBe(true);
  });

  it('requiresSandbox + 已注册 runner → 真实执行并校验端状态', async () => {
    registerCLISandboxRunner(new LocalCLISandboxRunner());
    const s = scenario({
      dimension: 'cli_deep_tasks',
      grader: 'cli_command',
      requirements: { requiresSandbox: true, endStatePatterns: ['hello'] },
    });
    const out = '```bash\necho hello > out.txt\n```';
    const r = await cliCommandEvaluator.evaluate(s, out, meta());
    expect(r.humanReviewRequired).toBeFalsy();
    expect(r.axisEvidence?.command_usage).toBe('verified');
    expect(r.totalScore).toBe(100);
  });
});
