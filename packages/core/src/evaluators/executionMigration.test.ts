import { describe, expect, it } from 'vitest';
import { toolCallTraceEvaluator } from './toolCallTrace.js';
import { agentLoopTraceEvaluator } from './agentLoopTrace.js';
import { executeRetailTool, type RetailState } from '../agentLoop/retailRuntime.js';
import { evaluateWorldTrace } from './worldTrace.js';
import { validateScenario } from '../contracts/validateScenario.js';
import { cliCommandEvaluator } from './cliCommand.js';
import { parseToolCalls } from '../agentLoop/loop.js';
import { orchestrateEvaluation } from '../orchestrator.js';
import { registerEvaluator } from './index.js';
registerEvaluator(cliCommandEvaluator);
import type { Scenario, OutputMetadata, ModelResponse } from '@zxbench/types';

const meta = { finishReason: 'stop', truncated: false, containsCodeBlock: false,
  containsFinalConclusion: true, outputLength: 1, outputTokens: 1, inputTokens: 1,
  maxTokens: 100, incomplete: false } as OutputMetadata;
const scenario = (id: string, requirements: Record<string, unknown>, grader: string, dimension: string) =>
  ({ id, requirements, grader, dimension, promptTemplate: '订单 o_1004', scoring: { type: grader } }) as unknown as Scenario;

describe('execution migration regressions', () => {
  it('compares nested arguments structurally and requires all state predicates', () => {
    const config = { initialState: {}, maxTurns: 3, tools: [], requireFinalMessage: false,
      requiredCalls: [{ tool: 'patch', args: { value: { a: 1, b: 2 } } }],
      expectedState: [{ path: 'text', equals: 'exact', contains: 'act' }] };
    const s = scenario('world-structural', { executionWorld: config }, 'tool_call_trace', 'tool_cli_workflow');
    const trace = { initialState: {}, finalState: { text: 'exact' }, events: [
      { tool: 'patch', args: { value: { b: 2, a: 1 } }, ok: true }], finalMessage: '', turnErrors: [] };
    expect(evaluateWorldTrace(s, { executionWorld: trace } as unknown as ModelResponse).totalScore).toBe(100);
    trace.finalState.text = 'actually-wrong';
    expect(evaluateWorldTrace(s, { executionWorld: trace } as unknown as ModelResponse).totalScore).toBeLessThan(100);
    const strict = { ...s, requirements: { executionWorld: { ...config, scoreMode: 'strict' } } } as Scenario;
    expect(evaluateWorldTrace(strict, { executionWorld: trace } as unknown as ModelResponse).totalScore).toBe(0);
    config.requiredCalls = [];
    const forbidden = { ...s, requirements: { executionWorld: { ...config, forbiddenCalls: ['patch'] } } } as Scenario;
    expect(evaluateWorldTrace(forbidden, { executionWorld: trace } as unknown as ModelResponse).axisScores?.task_result).toBe(0);
  });
  it('accepts trusted binary artifact assertions but rejects empty assertion lists', () => {
    const make = (assertCommands: unknown[]) => ({ ...scenario('CLI-binary', {
      executionCases: [{ files: [], assertCommands }],
    }, 'cli_command', 'cli_deep_tasks'), responseMode: 'live_execution' }) as Scenario;
    expect(validateScenario(make(['python3 -I -c "assert True"'])).errors.map(e => e.code))
      .not.toContain('EXECUTION_CASES_REQUIRED');
    for (const assertions of [[], [''], [null]]) {
      expect(validateScenario(make(assertions)).errors.map(e => e.code)).toContain('EXECUTION_CASES_REQUIRED');
    }
  });
  it('rejects concrete parameter mismatches and missing dependent calls', async () => {
    const s = scenario('TC-1', {
      tool: 'create_cron_task', params: { interval_minutes: '', priority: '' },
      calls: [{ toolName: 'create_cron_task', parameterChecks: [
        { path: 'interval_minutes', operator: 'equals', value: 30 },
        { path: 'priority', operator: 'equals', value: 5 },
      ] }],
    }, 'tool_call_trace', 'tool_cli_workflow');
    const r = await toolCallTraceEvaluator.evaluate(s,
      'create_cron_task(interval_minutes=999, priority=999)', meta);
    expect(r.axisScores?.call_discipline).toBeLessThan(100);

    const dependent = scenario('TC-2', { tool: 'session_search', params: { query: '' },
      calls: [{ toolName: 'session_search' }, { toolName: 'apply_fix' }], orderMatters: true,
    }, 'tool_call_trace', 'tool_cli_workflow');
    const missing = await toolCallTraceEvaluator.evaluate(dependent, 'session_search(query="fix")', meta);
    expect(missing.axisScores?.call_discipline).toBeLessThan(100);
  });

  it('matches four separate calls of the same tool in order', async () => {
    const s = scenario('TC-3', { sequence: Array(4).fill('create_reminder'),
      tool: 'create_reminder', params: { title: '' },
    }, 'tool_call_trace', 'tool_cli_workflow');
    const output = Array.from({ length: 4 }, (_, i) => `create_reminder(title="${i}")`).join('\n');
    const r = await toolCallTraceEvaluator.evaluate(s, output, meta);
    expect(r.axisScores?.call_discipline).toBe(100);
  });

  it('marks unimplemented conditional requirements as unverified', async () => {
    const s = scenario('TC-conditional', { tool: 'memory.save', params: { key: '' },
      conditional: { when: 'missing' } }, 'tool_call_trace', 'tool_cli_workflow');
    const r = await toolCallTraceEvaluator.evaluate(s, 'memory.save(key="branch")', meta);
    expect(r.criterionResults?.find((item) => item.id === 'tool_unverified_contract')?.status).toBe('unmeasured');
    expect(r.totalScore).toBeLessThan(100);
  });

  it('does not award the procedure criterion for querying a different order', async () => {
    const state: RetailState = { now: '2026-09-16T10:00:00Z', users: [], products: [],
      orders: [
        { id: 'o_1001', userId: 'u', items: [], total: 1, status: 'shipped', placedAt: '2026-09-01', address: 'A' },
        { id: 'o_1004', userId: 'u', items: [], total: 1, status: 'shipped', placedAt: '2026-09-01', address: 'A' },
      ], refunds: [], exchanges: [], messages: [], escalations: [], addressChanges: [], cancellations: [] };
    const args = { orderId: 'o_1001' };
    const call = { tool: 'get_order', args, ...executeRetailTool(state, 'get_order', args, 1) };
    const trace = { initialState: structuredClone(state), state, turns: [{ turn: 1,
      userMessage: '订单 o_1004', assistantRaw: 'CALL get_order {"orderId":"o_1001"}\nSAY 已发货，无法取消', calls: [call] }],
      turnsUsed: 1, finalMessage: '已发货，无法取消', truncated: false, turnErrors: [] };
    const s = scenario('AL-5', { agentLoop: { state, maxTurns: 6 }, agentLoopAssert: {
      mustCallTools: ['get_order'], expectedOutcome: { kind: 'no_state_change' },
      finalMentions: ['已发货', '无法'], maxTurnsUsed: 6,
    } }, 'agent_loop_trace', 'agent_loop');
    const response = { agentLoop: trace } as unknown as ModelResponse;
    const r = await agentLoopTraceEvaluator.evaluate(s, trace.finalMessage, meta, response);
    expect(r.axisScores?.procedure).toBe(0);
    expect(r.criterionResults?.find((c) => c.id === 'agent_loop_procedure')?.status).toBe('fail');
  });

  it('separates blocked tool attempts from a recovered final state', () => {
    const config = { initialState: { files: { 'config.ini': 'old' } }, maxTurns: 3,
      tools: [], requiredCalls: [{ tool: 'apply_fix' }],
      expectedState: [{ path: 'files/config.ini', equals: 'fixed' }] };
    const s = scenario('TC-world', { executionWorld: config }, 'tool_call_trace', 'tool_cli_workflow');
    const events = [
      { ordinal: 0, tool: 'apply_fix', args: {}, ok: false, result: { error: 'DEPENDENCY_NOT_SATISFIED' } },
      { ordinal: 1, tool: 'apply_fix', args: {}, ok: true, result: 'fixed' },
    ];
    const trace = { initialState: config.initialState, finalState: { files: { 'config.ini': 'fixed' } },
      events, turns: [], finalMessage: '已修复', turnErrors: [], elapsedMs: 100 };
    const result = evaluateWorldTrace(s, { executionWorld: trace } as unknown as ModelResponse);
    expect(result.criterionResults?.find((c) => c.id === 'world_call_errors')?.status).toBe('fail');
    expect(result.totalScore).toBeLessThan(100);
  });

  it('rejects live execution scenarios without independently checked outcomes', () => {
    const invalid = { ...scenario('CLI-empty', {}, 'cli_command', 'cli_deep_tasks'),
      responseMode: 'live_execution', graderVersion: 'cli_command_v5', scenarioHash: 'test' } as Scenario;
    expect(validateScenario(invalid).errors.map((issue) => issue.code)).toContain('EXECUTION_CASES_REQUIRED');
  });

  it('requires observed shell execution as well as the correct investigation answer', async () => {
    const s = scenario('CLI-shell', { executionShell: { files: [{ path: 'start.sh', content: 'PORT=8443' }],
      answer: 8443, maxTurns: 3, minCommands: 1 } }, 'cli_command', 'cli_deep_tasks');
    const guessed = await cliCommandEvaluator.evaluate(s, '8443', meta,
      { shellLoop: { turns: [], events: [], answer: '8443', errors: [], elapsedMs: 1 } } as unknown as ModelResponse);
    expect(guessed.criterionResults?.find((c) => c.id === 'shell_exploration')?.status).toBe('fail');
    const explored = await cliCommandEvaluator.evaluate(s, '8443', meta,
      { shellLoop: { turns: [], events: [{ turn: 1, command: 'cat start.sh', stdout: 'PORT=8443', stderr: '',
        exitCode: 0, timedOut: false, outputLimitExceeded: false }], answer: '8443', errors: [], elapsedMs: 1 } } as unknown as ModelResponse);
    expect(explored.totalScore).toBe(100);
  });

  it('does not repair malformed Docker loop calls into executable arguments', () => {
    expect(() => parseToolCalls('CALL issue_refund {orderId: o_1001}', true)).toThrow('INVALID_CALL_ARGS');
    expect(() => parseToolCalls('CALL issue_refund', true)).toThrow('INVALID_CALL_ARGS');
    expect(parseToolCalls('CALL get_order {"orderId":"o_1001"}', true)).toHaveLength(1);
  });

  it('retains Docker shell evidence when the final answer is empty', async () => {
    const trace = { imageId: 'sha256:test', turns: [{ turn: 1, assistantRaw: 'SHELL cat config', events: [] }],
      events: [], answer: '', errors: [], elapsedMs: 10 };
    const s = scenario('CLI-empty-trace', { executionShell: { files: [], answer: 'ok', maxTurns: 2 } },
      'cli_command', 'cli_deep_tasks');
    const result = await orchestrateEvaluation({ scenario: s,
      modelConfig: { id: 'fixture', name: 'fixture', provider: 'openai', baseUrl: 'http://localhost', defaultParams: {} },
      modelParams: { maxTokens: 100 }, evalConfig: {} as never,
      savedCandidate: { response: { content: '', finishReason: 'stop', usage: { inputTokens: 1,
        outputTokens: 2, totalTokens: 3 }, latencyMs: 10, shellLoop: trace }, metadata: meta } });
    expect(result.totalScore).toBe(0);
    expect(result.outputMetadata.shellExecutionTrace).toEqual(trace);
    expect(result.outputMetadata.executionTraceSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('grades saved Docker world evidence when the final SAY is missing', async () => {
    registerEvaluator(toolCallTraceEvaluator);
    const s = { ...scenario('TC-empty-final', { executionWorld: {
      initialState: { done: false }, tools: [], maxTurns: 2,
      requiredCalls: [{ tool: 'apply_fix' }],
      expectedState: [{ path: 'done', equals: true }],
      requireFinalMessage: true, scoreMode: 'strict',
    } }, 'tool_call_trace', 'tool_cli_workflow'),
    scenarioVersion: '1', scenarioHash: 'saved-world-fixture' } as Scenario;
    const trace = { initialState: { done: false }, finalState: { done: true },
      turns: [{ turn: 1, userMessage: '修复', assistantRaw: 'CALL apply_fix {}', calls: [] }],
      events: [{ ordinal: 0, tool: 'apply_fix', args: {}, ok: true, result: { done: true } }],
      finalMessage: '', turnErrors: [], elapsedMs: 10 };
    const result = await orchestrateEvaluation({ scenario: s,
      modelConfig: { id: 'fixture', name: 'fixture', provider: 'openai', baseUrl: 'http://localhost', defaultParams: {} },
      modelParams: { maxTokens: 100 }, evalConfig: {} as never,
      savedCandidate: { response: { content: '', finishReason: 'stop', usage: { inputTokens: 1,
        outputTokens: 2, totalTokens: 3 }, latencyMs: 10, executionWorld: trace }, metadata: meta } });
    expect(result.totalScore).toBe(0);
    expect(result.criterionResults?.find((c) => c.id === 'world_required_0')?.status).toBe('pass');
    expect(result.criterionResults?.find((c) => c.id === 'world_state_0')?.status).toBe('pass');
    expect(result.criterionResults?.find((c) => c.id === 'world_final_message')?.status).toBe('fail');
    expect(result.outputMetadata.executionWorldTrace).toEqual({ ...trace, answerFirstRequested: false });
    expect(result.outputMetadata.retryChainExhausted).toBeUndefined();
    expect(result.evidence?.join(' ')).not.toContain('Model returned empty response');
  });
});
