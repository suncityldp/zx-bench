import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig, ModelResponse } from '@zxbench/types';
import type { RetailState } from '../agentLoop/retailRuntime.js';

const mocks = vi.hoisted(() => ({ call: vi.fn(), exec: vi.fn() }));
vi.mock('../model/caller.js', () => ({ callModelWithRetry: mocks.call }));
vi.mock('./execAsync.js', () => ({ execAsync: mocks.exec }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, readFileSync: (...args: Parameters<typeof fs.readFileSync>) =>
    String(args[0]).replaceAll('\\', '/').endsWith('/agentLoop/retailRuntime.js')
      ? '// Engine source is not executed by the mocked Docker transport.'
      : fs.readFileSync(...args) };
});

import { runAgentLoop } from '../agentLoop/loop.js';
import { DockerSession } from './sessionRunner.js';
import { DockerRetailRuntime } from './retailDocker.js';
import { executionTimeoutMs } from './budget.js';

const model: ModelConfig = { id: 'fixture', name: 'fixture', provider: 'openai',
  baseUrl: 'http://unused', defaultParams: {} };
const state: RetailState = { now: '2026-10-06', users: [], products: [], orders: [], refunds: [],
  exchanges: [], messages: [], escalations: [], addressChanges: [], cancellations: [] };
const response = (content: string): ModelResponse => ({ content, finishReason: 'stop',
  usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, latencyMs: 1 });
let clockMs: number;
const run = (hardTimeoutMs = 1_200_000) => runAgentLoop({
  config: { backend: 'docker', state, maxTurns: 3, userScript: [], expectedImageId: 'fixture-image' },
  task: 'query user', modelConfig: model, maxTokens: 131072, hardTimeoutMs,
});

beforeEach(() => {
  vi.clearAllMocks();
  clockMs = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clockMs);
  vi.spyOn(DockerSession.prototype, 'readArtifact').mockReturnValue(JSON.stringify(state));
  mocks.exec.mockImplementation(async (_command, args: string[]) => ({ status: 0, stderr: '',
    stdout: args[0] === 'image' ? JSON.stringify([{ Id: 'fixture-image' }])
      : args[0] === 'exec' ? JSON.stringify({ ok: true, result: { id: 'user' }, violations: [] }) : '',
  }));
});
afterEach(() => vi.restoreAllMocks());

describe('retail Docker lifetime during model generation', () => {
  it('executes a tool after a 319-second first generation within a 20-minute task', async () => {
    mocks.call.mockImplementationOnce(async () => {
      clockMs += 319_000;
      return response('CALL get_user {"userId":"user"}');
    }).mockResolvedValueOnce(response('SAY done'));
    const result = await run();
    expect(result.trace.turns[0].calls[0].ok).toBe(true);
    expect(result.trace.turnErrors).toEqual([]);
    expect(result.trace.elapsedMs).toBe(319_000);
    expect(mocks.call.mock.calls[1][0].params.hardTimeoutMs).toBe(881_000);
    expect(mocks.exec.mock.calls.filter(([, args]) => args[0] === 'rm')).toHaveLength(1);
  });

  it('keeps cumulative model time in the same budget across multiple tool turns', async () => {
    mocks.call.mockImplementationOnce(async () => {
      clockMs += 319_000;
      return response('CALL get_user {"userId":"user"}');
    }).mockImplementationOnce(async () => {
      clockMs += 600_000;
      return response('CALL get_user {"userId":"user"}');
    }).mockResolvedValueOnce(response('SAY done'));
    const result = await run();
    expect(result.trace.turns.slice(0, 2).map(turn => turn.calls[0].ok)).toEqual([true, true]);
    expect(mocks.call.mock.calls[2][0].params.hardTimeoutMs).toBe(281_000);
  });

  it('honors a smaller scenario deadline and cleans up an expired session', async () => {
    const budget = executionTimeoutMs(120, { hardTimeLimitMs: 1_200_000 }, {});
    mocks.call.mockImplementationOnce(async () => {
      clockMs += 150_001;
      return response('CALL get_user {"userId":"user"}');
    });
    await expect(run(budget)).rejects.toThrow('Docker session time budget exhausted');
    expect(mocks.call.mock.calls[0][0].params.hardTimeoutMs).toBe(120_000);
    expect(mocks.exec.mock.calls.some(([, args]) => args[0] === 'exec')).toBe(false);
    expect(mocks.exec.mock.calls.filter(([, args]) => args[0] === 'rm')).toHaveLength(1);
  });

  it('does not extend the per-command Docker deadline when the session lives longer', async () => {
    const runtime = await DockerRetailRuntime.create(state, 'fixture-image', 1_230_000);
    try {
      clockMs += 319_000;
      await runtime.call('get_user', { userId: 'user' }, 1);
      const command = mocks.exec.mock.calls.find(([, args]) => args[0] === 'exec');
      expect(command?.[2].timeout).toBe(30_000);
    } finally { await runtime.close(); }
  });
});
