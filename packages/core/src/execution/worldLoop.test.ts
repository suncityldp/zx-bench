import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig, ModelResponse } from '@zxbench/types';
const mocks = vi.hoisted(() => ({ call: vi.fn(), create: vi.fn() }));
vi.mock('../model/caller.js', () => ({ callModelWithRetry: mocks.call }));
vi.mock('./toolWorld.js', () => ({ DockerToolWorld: { create: mocks.create } }));
import { extractWorldFinalMessage, runWorldLoop } from './worldLoop.js';
import { executionTimeoutMs } from './budget.js';
const config: ModelConfig = { id: 'test', name: 'test', provider: 'openai', baseUrl: 'http://unused', defaultParams: {} };
const response = (content: string, finishReason: ModelResponse['finishReason'] = 'stop') => ({ content, finishReason,
  usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, latencyMs: 1 });
const run = (maxTurns = 3, signal?: AbortSignal) => runWorldLoop({ config: { initialState: {}, tools: [], maxTurns },
  task: 'test', modelConfig: config, modelParams: { temperature: 0.2 }, maxTokens: 100,
  hardTimeoutMs: 1_200_000, signal });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockImplementation(async () => {
    const events: unknown[] = [];
    return { imageId: 'test', events, snapshot: () => ({}), close: vi.fn(),
      call: vi.fn(async (tool, args) => { const e = { tool, args, ok: true, result: {} }; events.push(e); return e; }) };
  });
});
describe('world reply and termination contract', () => {
  it('shows tool schemas without function parentheses and discloses prior calls', async () => {
    mocks.call.mockResolvedValue(response('SAY ok'));
    await runWorldLoop({config:{initialState:{},maxTurns:2,tools:[
      {name:'memory.read',kind:'read',path:'memory/{key}',requiredArgs:{key:'string'}},
      {name:'memory.save',kind:'set',path:'memory/{key}',requiredArgs:{key:'string',value:'string'},requirePriorCall:{tool:'memory.read',sameArgs:['key'],allowedErrors:['NOT_FOUND']}}
    ]},task:'test',modelConfig:config,maxTokens:100,hardTimeoutMs:1000});
    const prompt=mocks.call.mock.calls[0][0].systemPrompt;
    expect(prompt).toContain('工具 memory.read；参数类型 {"key":"string"}');
    expect(prompt).not.toContain('memory.read(');
    expect(prompt).toContain('相同的 key 参数');
    expect(prompt).toContain('预期错误 NOT_FOUND');
  });
  it('still rejects parenthesized CALL syntax without executing it', async () => {
    mocks.call.mockResolvedValue(response('CALL request.inspect({})'));
    const {trace}=await run();
    expect(trace.terminationReason).toBe('protocol_error');
    expect(trace.events).toHaveLength(0);
    expect(trace.turnErrors[0]).toContain('INVALID_CALL_SYNTAX');
  });
  it('preserves lists, repeated SAY lines and quoted CALL text without executing it', async () => {
    const body = 'SAY 订单：\n- #8811\nSAY - #8812\n```text\nCALL danger {}\nSAY literal\n```';
    expect(extractWorldFinalMessage(body)).toBe('订单：\n- #8811\n- #8812\n```text\nCALL danger {}\nSAY literal\n```');
    mocks.call.mockResolvedValue(response(body));
    const { trace } = await run();
    expect(trace.events).toHaveLength(0);
    expect(trace.finalMessage).toContain('#8812');
    expect(trace.terminationReason).toBe('completed');
    expect(trace.turns[0].usage?.totalTokens).toBe(5);
  });
  it('records round exhaustion and keeps calls instead of calling it a normal stop', async () => {
    mocks.call.mockResolvedValue(response('CALL read {}'));
    const { trace, response: r } = await run(2);
    expect(trace.events).toHaveLength(2);
    expect(trace.turnErrors).toContain('WORLD_TURN_LIMIT');
    expect(trace.terminationReason).toBe('turn_limit');
    expect(r.finishReason).toBe('unknown');
  });
  it('retains truncation and never executes a truncated action response', async () => {
    mocks.call.mockResolvedValue(response('CALL dangerous {}', 'length'));
    const { trace, response: r } = await run();
    expect(trace.events).toHaveLength(0);
    expect(trace.terminationReason).toBe('truncated');
    expect(r.finishReason).toBe('length');
  });
  it('keeps prior events on timeout and propagates caller cancellation', async () => {
    mocks.call.mockResolvedValueOnce(response('CALL read {}')).mockRejectedValueOnce(new Error('Model call timed out'));
    const { trace } = await run();
    expect(trace.events).toHaveLength(1);
    expect(trace.terminationReason).toBe('timeout');
    const controller = new AbortController(); controller.abort();
    mocks.call.mockRejectedValueOnce(new Error('aborted'));
    await expect(run(3, controller.signal)).rejects.toThrow('aborted');
  });
  it('uses run-level budgets, caps them at a smaller task limit, and forwards sampling', async () => {
    expect(executionTimeoutMs(undefined, { hardTimeLimitMs: 1_200_000 }, {})).toBe(1_200_000);
    expect(executionTimeoutMs(360, { hardTimeLimitMs: 1_200_000 }, {})).toBe(360_000);
    expect(executionTimeoutMs(1200, { hardTimeLimitMs: 600_000 }, {})).toBe(600_000);
    mocks.call.mockResolvedValue(response('SAY ok'));
    await run();
    expect(mocks.call.mock.calls[0][0].params.temperature).toBe(0.2);
    expect(mocks.call.mock.calls[0][0].params.hardTimeoutMs).toBeGreaterThan(1_199_000);
  });
});
