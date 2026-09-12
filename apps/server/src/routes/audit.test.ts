import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerRoutes } from './index.js';
import { createBenchmarkPack, runMultipleEvaluations, verifyBenchmarkPack } from '@zxbench/core';

const db = vi.hoisted(() => ({
  modelConfig: { findUnique: vi.fn(), findMany: vi.fn() },
  scenarioDefinition: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
  evalRun: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
  scenarioResult: { create: vi.fn(), findMany: vi.fn() },
}));
vi.mock('../index.js', () => ({ prisma: db }));
vi.mock('../calibration/store.js', () => ({ getCalibrationStore: vi.fn() }));
vi.mock('../calibration/intake.js', () => ({ intakeRuns: vi.fn() }));
vi.mock('@zxbench/core', async importOriginal => ({ ...await importOriginal<object>(), runMultipleEvaluations: vi.fn() }));
const model = { id: 'mock', name: 'mock', provider: 'openai', baseUrl: 'https://example.invalid', defaultParams: '{}', apiKey: null };
const row = { id: 'IF-fixture', dimension: 'instruction_following', category: 'test', difficulty: 'easy',
  language: 'general', locale: 'zh-CN', status: 'valid', tier: 'public_dev', promptTemplate: 'original task',
  grader: 'instruction_checklist', graderVersion: 'instruction_checklist_v4', scoring: '{"type":"instruction_checklist"}',
  requirements: '{"constraints":[]}', scenarioHash: 'legacy', scenarioVersion: '1', reviewStatus: 'unreviewed' };
let app: FastifyInstance;
let saved: Map<string, Record<string, any>>;
beforeEach(async () => {
  vi.clearAllMocks(); saved = new Map(); app = Fastify();
  db.modelConfig.findUnique.mockResolvedValue(model);
  db.scenarioDefinition.findMany.mockResolvedValue([row]);
  db.scenarioResult.findMany.mockResolvedValue([]);
  db.scenarioResult.create.mockImplementation(async ({ data }) => data);
  db.evalRun.create.mockImplementation(async ({ data }) => { saved.set(data.id, { ...data }); return { ...data }; });
  db.evalRun.update.mockImplementation(async ({ where, data }) => { const value = { ...saved.get(where.id), ...data }; saved.set(where.id, value); return value; });
  db.evalRun.findUnique.mockImplementation(async ({ where, include }) => {
    const run = saved.get(where.id);
    return run && include?.modelConfig ? { ...run, modelConfig: model } : run;
  });
  db.evalRun.findUniqueOrThrow.mockImplementation(async ({ where }) => saved.get(where.id));
  vi.mocked(runMultipleEvaluations).mockImplementation(async (scenario, options) => ({
    scenarioId: scenario.id, scenarioVersion: '1', scenarioHash: scenario.scenarioHash, dimension: scenario.dimension,
    modelOutput: 'answer', outputMetadata: { inputTokens: 1, outputTokens: 1 },
    totalScore: 100, axisScores: {}, safetyLevel: 'safe', evidence: [], formatParseSuccess: true,
    runCount: options.runsPerQuestion, scoreHistory: [100], verdictHistory: [], graderVersion: '1',
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), escalated: false, humanReviewRequired: false,
  } as any));
  await registerRoutes(app);
});
afterEach(async () => { await app.close(); });

describe('audited run API without network or real database', () => {
  it.each(['RM-CN-004', 'RM-CN-013'])('blocks obsolete or disputed frozen math retries without a live definition: %s', async scenarioId => {
    const frozen = { ...row, id: scenarioId, dimension: 'reasoning_math', grader: 'exact_answer_line',
      scenarioVersion: '2.0.1', graderVersion: 'exact_answer_v2', scoring: { type: 'exact_answer_line' }, requirements: { answer: 1 } };
    const benchmarkPack = createBenchmarkPack([frozen as any]);
    saved.set('old-math', { id: 'old-math', modelConfig: model, config: '{}', manifest: JSON.stringify({ benchmarkPack }) });
    db.scenarioDefinition.findUnique.mockResolvedValue(null);
    const res = await app.inject({ method: 'POST', url: `/api/runs/old-math/results/${scenarioId}/retry`, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(runMultipleEvaluations).not.toHaveBeenCalled();
  });
  it('saves an answer before pausing on Docker loss, without generating it again on resume', async () => {
    const evaluate = vi.mocked(runMultipleEvaluations).getMockImplementation()!;
    vi.mocked(runMultipleEvaluations).mockImplementation(async (...args) => ({
      ...await evaluate(...args), environmentError: true,
      evidence: ['ENVIRONMENT_ERROR: docker daemon unreachable'],
    }));
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { modelConfigId: 'mock' } });
    const id = res.json().data.id;
    await vi.waitFor(() => expect(saved.get(id)?.status).toBe('paused'));
    expect(db.scenarioResult.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ modelOutput: 'answer', environmentError: true }) }));
    db.scenarioResult.findMany.mockResolvedValue([{ scenarioId: row.id, dimension: row.dimension, totalScore: 100, environmentError: true }]);
    const resumed = await app.inject({ method: 'POST', url: `/api/runs/${id}/resume`, payload: {} });
    expect(resumed.statusCode).toBe(200);
    await vi.waitFor(() => expect(saved.get(id)?.status).toBe('completed'));
    expect(runMultipleEvaluations).toHaveBeenCalledTimes(1);
  });
  it('keeps a Docker-blocked question in the queue and retries it after resume', async () => {
    const evaluate = vi.mocked(runMultipleEvaluations).getMockImplementation()!;
    vi.mocked(runMultipleEvaluations).mockRejectedValueOnce(new Error('DOCKER_NOT_READY: startup failed')).mockImplementation(evaluate);
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { modelConfigId: 'mock' } });
    const id = res.json().data.id;
    await vi.waitFor(() => expect(saved.get(id)?.status).toBe('paused'));
    expect(db.scenarioResult.create).not.toHaveBeenCalled();
    expect(JSON.parse(saved.get(id)!.summary).pauseReason).toContain('DOCKER_NOT_READY');
    const resumed = await app.inject({ method: 'POST', url: `/api/runs/${id}/resume`, payload: {} });
    expect(resumed.statusCode).toBe(200);
    await vi.waitFor(() => expect(saved.get(id)?.status).toBe('completed'));
    expect(runMultipleEvaluations).toHaveBeenCalledTimes(2);
    expect(db.scenarioResult.create).toHaveBeenCalledTimes(1);
  });
  it('editing a reviewed question clears its verification before future official runs', async () => {
    db.scenarioDefinition.findUnique.mockResolvedValue({ ...row, reviewStatus: 'verified', goldVerifiedAt: new Date('2026-09-01') });
    db.scenarioDefinition.upsert.mockImplementation(async ({ update }) => ({ ...row, ...update }));
    const res = await app.inject({ method: 'POST', url: '/api/scenarios', payload: { ...row, scoring: {}, requirements: { constraints: [] }, promptTemplate: 'changed task' } });
    expect(res.statusCode).toBe(200);
    expect(db.scenarioDefinition.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ reviewStatus: 'unreviewed', goldVerifiedAt: null }) }));
  });
  it('rejects unreviewed official selection before run creation or model calls', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { modelConfigId: 'mock', config: { evaluationMode: 'official' } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('reviewStatus');
    expect(db.evalRun.create).not.toHaveBeenCalled();
    expect(runMultipleEvaluations).not.toHaveBeenCalled();
  });
  it('rejects invalid counts and missing requested questions', async () => {
    for (const payload of [{ config: { runsPerQuestion: 0 } }, { scenarioIds: ['not-in-pack'] }]) {
      const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { modelConfigId: 'mock', ...payload } });
      expect(res.statusCode).toBe(400);
    }
    expect(db.evalRun.create).not.toHaveBeenCalled();
  });
  it('persists a verified content hash before generation and honors selected repeats', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { modelConfigId: 'mock', config: { runsPerQuestion: 2 } } });
    expect(res.statusCode).toBe(200);
    const id = res.json().data.id;
    await vi.waitFor(() => expect(saved.get(id)?.status).toBe('completed'));
    const manifest = JSON.parse(saved.get(id)!.manifest);
    expect(() => verifyBenchmarkPack(manifest.benchmarkPack)).not.toThrow();
    expect(runMultipleEvaluations).toHaveBeenCalledWith(expect.objectContaining({ promptTemplate: 'original task' }), expect.objectContaining({ runsPerQuestion: 2 }));
    const patch = await app.inject({ method: 'PATCH', url: `/api/runs/${id}/config`, payload: { maxTokens: 10000 } });
    expect(patch.statusCode).toBe(409);
  });
  it('shows eligibility failures without rewriting review status', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scenarios/eligibility' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data[0]).toMatchObject({ id: row.id, eligible: false });
    expect(db.evalRun.create).not.toHaveBeenCalled();
  });
  it('blocks tampered persisted snapshots before generation', async () => {
    db.evalRun.findUniqueOrThrow.mockImplementation(async ({ where }) => {
      const run = saved.get(where.id)!;
      const manifest = JSON.parse(run.manifest);
      manifest.benchmarkPack.scenarios[0].promptTemplate = 'tampered task';
      return { ...run, manifest: JSON.stringify(manifest) };
    });
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { modelConfigId: 'mock' } });
    await vi.waitFor(() => expect(saved.get(res.json().data.id)?.status).toBe('failed'));
    expect(runMultipleEvaluations).not.toHaveBeenCalled();
  });
  it('freezes one shared benchmark pack for all models in a batch', async () => {
    db.modelConfig.findMany.mockResolvedValue([model, { ...model, id: 'mock2', name: 'mock2' }]);
    const res = await app.inject({ method: 'POST', url: '/api/runs/batch', payload: { modelConfigIds: ['mock', 'mock2'] } });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect([...saved.values()].every(run => run.status === 'completed')).toBe(true));
    const packs = [...saved.values()].map(run => JSON.parse(run.manifest).benchmarkPack.hash);
    expect(packs).toHaveLength(2);
    expect(new Set(packs).size).toBe(1);
  });
});
