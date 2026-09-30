import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerRoutes } from './index.js';
import { createBenchmarkPack, runMultipleEvaluations, verifyBenchmarkPack } from '@zxbench/core';

const db = vi.hoisted(() => ({
  modelConfig: { findUnique: vi.fn(), findMany: vi.fn(), delete: vi.fn() },
  scenarioDefinition: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
  evalRun: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), findMany: vi.fn() },
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
  db.evalRun.findMany.mockResolvedValue([]);
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
  it('recomputes historical list costs from latest rows after retry, without old-summary token fallback', async () => {
    const original = { id: 'old', scenarioId: 'a', startedAt: '2026-09-01', finishedAt: '2026-09-01', outputMetadata: '{"inputTokens":1,"outputTokens":100,"inferenceMs":1000}' };
    const latest = { ...original, id: 'new', finishedAt: '2026-09-02', outputMetadata: '{"inputTokens":1,"outputTokens":200,"inferenceMs":2000}' };
    const untimed = { ...original, id: 'untimed', scenarioId: 'b', outputMetadata: '{"inputTokens":1,"outputTokens":900}' };
    db.evalRun.findMany.mockResolvedValue([{ id: 'history', config: '{}', manifest: null, summary: '{"totalOutputTokens":99999,"engineeringFailures":{"total":2}}', modelConfig: model, results: [original, latest, untimed] }]);
    const response = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data[0].summary).toMatchObject({ totalOutputTokens: 1100, timedOutputTokens: 200, candidateTokensPerSecond: 100, timingCoverage: .5, engineeringFailures: { total: 2 }, consumedCandidateMetrics: { totalOutputTokens: 1200 } });
  });
  it('preview and single/batch creation freeze the same difficulty-selected IDs and hash', async () => {
    db.modelConfig.findMany.mockResolvedValue([model, { ...model, id: 'mock2' }]);
    db.scenarioDefinition.findMany.mockResolvedValue([row, { ...row, id: 'hard', difficulty: 'hard' }]);
    const payload = { difficultyIds: ['hard'], dimensionIds: [], modelConfigId: 'mock', modelConfigIds: ['mock', 'mock2'] };
    const preview = await app.inject({ method: 'POST', url: '/api/runs/preview', payload });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.scenarioIds).toEqual(['hard']);
    const single = await app.inject({ method: 'POST', url: '/api/runs', payload });
    expect(single.statusCode).toBe(200);
    await vi.waitFor(() => expect(saved.get(single.json().data.id)?.status).toBe('completed'));
    const batch = await app.inject({ method: 'POST', url: '/api/runs/batch', payload });
    expect(batch.statusCode).toBe(200);
    await vi.waitFor(() => expect([...saved.values()].every(r => r.status === 'completed')).toBe(true));
    for (const run of saved.values()) {
      expect(JSON.parse(run.config).difficultyFilter).toEqual(['hard']);
      expect(JSON.parse(run.manifest).benchmarkPack.hash).toBe(preview.json().data.hash);
    }
  });
  it.each(['/api/runs/preview', '/api/runs', '/api/runs/batch'])('rejects invalid difficulty enum in %s', async url => {
    const res = await app.inject({ method: 'POST', url, payload: { modelConfigId: 'mock', modelConfigIds: ['mock'], difficultyIds: ['impossible'] } });
    expect(res.statusCode).toBe(400);
    expect(db.evalRun.create).not.toHaveBeenCalled();
  });
  it('gives friendly model reference feedback and keeps database race protection', async () => {
    db.evalRun.count.mockResolvedValue(3);
    const referenced = await app.inject({ method: 'DELETE', url: '/api/models/mock' });
    expect(referenced.statusCode).toBe(409);
    expect(referenced.json().error).toContain('3');
    expect(db.modelConfig.delete).not.toHaveBeenCalled();
    db.evalRun.count.mockResolvedValue(0);
    db.modelConfig.delete.mockRejectedValue({ code: 'P2003' });
    const race = await app.inject({ method: 'DELETE', url: '/api/models/mock' });
    expect(race.statusCode).toBe(409);
    expect(race.json().error).toContain('引用');
    db.evalRun.findMany.mockResolvedValue([{ config: '{"judgeModelConfigId":"mock"}' }]);
    const judge = await app.inject({ method: 'DELETE', url: '/api/models/mock' });
    expect(judge.statusCode).toBe(409);
    expect(judge.json().error).toContain('Judge');
  });
  it('includes all 10 default extension questions through the official create-run API', async () => {
    const { readFileSync } = await import('node:fs');
    const bank = JSON.parse(readFileSync('data/scenarios/benchmark.json', 'utf8'));
    // 2026-09-16: ten coverage items were retired for cross-run saturation, so only the
    // remaining ten still-valid default extension questions are eligible for an official run.
    const additions = bank.filter((s: any) => s.grader === 'challenge_extension'
      && !s.requirements?.developmentShadow && s.status === 'valid');
    db.scenarioDefinition.findMany.mockResolvedValue(additions.map((s: any) => ({ ...s,
      scoring: JSON.stringify(s.scoring), requirements: JSON.stringify(s.requirements),
      hiddenTests: JSON.stringify(s.hiddenTests), tags: JSON.stringify(s.tags),
      goldVerifiedAt: s.goldVerifiedAt ? new Date(s.goldVerifiedAt) : null,
    })));
    const response = await app.inject({ method: 'POST', url: '/api/runs', payload: {
      modelConfigId: 'mock', config: { evaluationMode: 'official' },
    } });
    expect(response.statusCode, response.body).toBe(200);
    const id = response.json().data.id;
    await vi.waitFor(() => expect(saved.get(id)?.status).toBe('completed'));
    const calledIds = vi.mocked(runMultipleEvaluations).mock.calls.map(call => call[0].id);
    expect(calledIds.sort()).toEqual(additions.map((s: any) => s.id).sort());
    expect(calledIds).toHaveLength(10);
    expect(JSON.parse(saved.get(id)!.manifest).benchmarkPack.scenarios).toHaveLength(10);
  });
  it('keeps all 20 pre-existing project repair questions in official scope', async () => {
    const { readFileSync } = await import('node:fs');
    const bank = JSON.parse(readFileSync('data/scenarios/benchmark.json', 'utf8'));
    const projects = bank.filter((s: any) => s.grader === 'project_repair');
    expect(projects).toHaveLength(20);
    db.scenarioDefinition.findMany.mockResolvedValue(projects.map((s: any) => ({ ...s,
      scoring: JSON.stringify(s.scoring), requirements: JSON.stringify(s.requirements),
      hiddenTests: JSON.stringify(s.hiddenTests), tags: JSON.stringify(s.tags),
      goldVerifiedAt: s.goldVerifiedAt ? new Date(s.goldVerifiedAt) : null,
    })));
    const response = await app.inject({ method: 'POST', url: '/api/runs', payload: {
      modelConfigId: 'mock', config: { evaluationMode: 'official' },
    } });
    expect(response.statusCode, response.body).toBe(200);
    const id = response.json().data.id;
    await vi.waitFor(() => expect(saved.get(id)?.status).toBe('completed'));
    expect(vi.mocked(runMultipleEvaluations).mock.calls.map(call => call[0].id).sort())
      .toEqual(projects.map((s: any) => s.id).sort());
  });
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
  it('allows a frozen public item in an official run', async () => {
    const { readFileSync } = await import('node:fs');
    const released = JSON.parse(readFileSync('data/scenarios/benchmark.json', 'utf8'))[0];
    const frozen = { ...released, scoring: JSON.stringify(released.scoring),
      requirements: JSON.stringify(released.requirements), hiddenTests: JSON.stringify(released.hiddenTests),
      tags: JSON.stringify(released.tags), goldVerifiedAt: released.goldVerifiedAt ? new Date(released.goldVerifiedAt) : null };
    db.scenarioDefinition.findMany.mockResolvedValue([frozen]);
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { modelConfigId: 'mock', config: { evaluationMode: 'official' } } });
    expect(res.statusCode).toBe(200);
    const id = res.json().data.id;
    await vi.waitFor(() => expect(saved.get(id)?.status).toBe('completed'));
    expect(runMultipleEvaluations).toHaveBeenCalledWith(expect.objectContaining({ id: released.id }), expect.anything());
  });
  it('excludes stale valid database rows from an official run', async () => {
    const { readFileSync } = await import('node:fs');
    const released = JSON.parse(readFileSync('data/scenarios/benchmark.json', 'utf8'))[0];
    const dbReleased = { ...released, scoring: JSON.stringify(released.scoring),
      requirements: JSON.stringify(released.requirements), hiddenTests: JSON.stringify(released.hiddenTests),
      tags: JSON.stringify(released.tags), goldVerifiedAt: released.goldVerifiedAt ? new Date(released.goldVerifiedAt) : null };
    db.scenarioDefinition.findMany.mockResolvedValue([dbReleased, { ...row, id: 'CR2-STALE-001' }]);
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { modelConfigId: 'mock', config: { evaluationMode: 'official' } } });
    expect(res.statusCode).toBe(200);
    const id = res.json().data.id;
    await vi.waitFor(() => expect(saved.get(id)?.status).toBe('completed'));
    expect(vi.mocked(runMultipleEvaluations).mock.calls.map((call) => call[0].id)).toEqual([released.id]);
    expect(JSON.parse(saved.get(id)!.manifest).benchmarkPack.scenarios).toHaveLength(1);
  });
  it('rejects a released ID whose database content hash is out of sync', async () => {
    const { readFileSync } = await import('node:fs');
    const released = JSON.parse(readFileSync('data/scenarios/benchmark.json', 'utf8'))[0];
    db.scenarioDefinition.findMany.mockResolvedValue([{ ...released, scenarioHash: 'stale-content-hash',
      scoring: JSON.stringify(released.scoring), requirements: JSON.stringify(released.requirements),
      hiddenTests: JSON.stringify(released.hiddenTests), tags: JSON.stringify(released.tags),
      goldVerifiedAt: released.goldVerifiedAt ? new Date(released.goldVerifiedAt) : null }]);
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: {
      modelConfigId: 'mock', config: { evaluationMode: 'official' },
    } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('out of sync');
    expect(db.evalRun.create).not.toHaveBeenCalled();
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
  it('excludes development-shadow tasks by default but allows an explicit run', async () => {
    const shadow = { ...row, id: 'shadow', dimension: 'program', grader: 'project_repair', requirements: '{"files":[],"developmentShadow":true}' };
    db.scenarioDefinition.findMany.mockResolvedValue([row, shadow]);
    const ordinary = await app.inject({ method: 'POST', url: '/api/runs', payload: { modelConfigId: 'mock' } });
    await vi.waitFor(() => expect(saved.get(ordinary.json().data.id)?.status).toBe('completed'));
    expect(runMultipleEvaluations).toHaveBeenCalledTimes(1);
    expect(runMultipleEvaluations).toHaveBeenLastCalledWith(expect.objectContaining({ id: row.id }), expect.anything());

    vi.mocked(runMultipleEvaluations).mockClear();
    const explicit = await app.inject({ method: 'POST', url: '/api/runs', payload: { modelConfigId: 'mock', scenarioIds: ['shadow'] } });
    await vi.waitFor(() => expect(saved.get(explicit.json().data.id)?.status).toBe('completed'));
    expect(runMultipleEvaluations).toHaveBeenCalledTimes(1);
    expect(runMultipleEvaluations).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'shadow' }), expect.anything());
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
  it('rejects duplicate models in a batch instead of launching the same model twice', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/runs/batch', payload: { modelConfigIds: ['mock', 'mock'] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('不能重复');
    expect(db.evalRun.create).not.toHaveBeenCalled();
  });
});
