import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PrismaClient, ScenarioDefinition } from '@prisma/client';
import type { CalibrationCandidate, CalibrationReview } from '@zxbench/types';
import { snapshotHash, createBenchmarkPack } from '@zxbench/core';
import { CalibrationStore } from './store.js';
import { registerCalibrationRoutes, presentCalibration, withCurrentSourceStatus } from './routes.js';
import { decodeScenario } from '../evaluationSnapshot.js';
import { collectRunCandidates, intakeRuns } from './intake.js';
vi.mock('./replay.js', () => ({ replayInstructionCriteria: vi.fn().mockResolvedValue({ criteria: [{ id: 'include', description: '', status: 'pass', critical: false, evidence: '', source: 'rule' }], version: 'test-v1' }) }));

const row = { id: 'IF-1', dimension: 'instruction_following', difficulty: 'easy', category: 'fixture', tier: 'public_dev',
  promptTemplate: 'Only respond with OK', grader: 'instruction_checklist', graderVersion: 'instruction_checklist_v4',
  scenarioVersion: '1', scenarioHash: 'legacy', scoring: '{}', requirements: JSON.stringify({ constraints: [{ id: 'include', description: 'includes OK', type: 'inclusion', check: { patterns: ['OK'] } }] }) } as ScenarioDefinition;
const candidate = (): CalibrationCandidate => ({ id: 'candidate', runId: 'run', resultId: 'result', attemptIndex: 0,
  modelId: 'model', modelName: 'model', scenario: decodeScenario(row), scenarioContentHash: snapshotHash(decodeScenario(row)),
  answerHash: snapshotHash('OK'), modelOutput: 'OK', snapshotOrigin: 'current_definition', observedScore: 100,
  failureTypes: [], environmentError: false, criteria: [{ id: 'include', description: 'includes OK', critical: false }],
  automaticCriteria: [{ id: 'include', description: '', status: 'pass', critical: false, evidence: '', source: 'rule' }],
  automaticSource: 'offline_rule_replay', automaticGraderVersion: 'v1', judgeScoreHistory: [], split: 'calibration', splitSeed: 'seed', leakageGroup: 'IF-1', collectedAt: '2026-09-08' });
const review = (reviewer: string): CalibrationReview => ({ reviewer, outcome: 'usable', labels: { include: 'pass' }, rationale: 'Independently verified candidate answer', sourceVerified: true, sourceEvidence: 'Original prompt and reference verified independently' });
const stores: CalibrationStore[] = [];
const memoryStore = () => { const s = new CalibrationStore(':memory:'); stores.push(s); return s; };
afterEach(() => { for (const s of stores.splice(0)) s.close(); });
function prismaFixture() {
  return { scenarioDefinition: { findMany: vi.fn().mockResolvedValue([row]) } } as unknown as PrismaClient;
}
describe('durable calibration store', () => {
  it('intake is idempotent and conflicting immutable payloads are rejected', () => {
    const store = memoryStore(); expect(store.put(candidate())).toBe(true);
    expect(store.put({ ...candidate(), collectedAt: 'tomorrow' })).toBe(false);
    expect(() => store.put({ ...candidate(), modelOutput: 'changed' })).toThrow('collision');
    expect(store.count()).toBe(1);
  });
  it('retains append-only reviews on disk and detects revision conflicts', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'zxbench-calibration-test-'));
    const file = path.join(directory, 'review.db');
    let store = new CalibrationStore(file);
    try {
      store.put(candidate()); store.review('candidate', 0, 'review', review('Alice'));
      expect(() => store.review('candidate', 0, 'review', review('Bob'))).toThrow('Revision conflict');
      store.close(); store = new CalibrationStore(file);
      expect(store.get('candidate')?.events).toHaveLength(1);
      const final = store.review('candidate', 1, 'review', review('Bob'));
      expect(final.summary.exportable).toBe(true);
      const a = store.freezeExport([final], 'calibration', 'seed');
      expect(store.freezeExport([final], 'calibration', 'seed').hash).toBe(a.hash);
      expect(() => store.freezeExport([final], 'development', 'seed')).toThrow('exactly one split');
    } finally { store.close(); rmSync(directory, { recursive: true }); }
  });
  it('hides model grades and peer labels from an unsubmitted second reviewer', () => {
    const store = memoryStore(); store.put(candidate());
    const record = store.review('candidate', 0, 'review', review('Alice'));
    const blind = presentCalibration(record, 'Bob');
    expect(blind.blindReview).toBe(true); expect(blind.events).toEqual([]);
    expect(blind.candidate).not.toHaveProperty('automaticCriteria');
    expect(blind.candidate).not.toHaveProperty('modelName');
    expect(blind.candidate).not.toHaveProperty('observedScore');
  });
  it('source changes invalidate reviewed export eligibility without deleting audit history', async () => {
    const store = memoryStore(); store.put(candidate()); store.review('candidate', 0, 'review', review('Alice'));
    const record = store.review('candidate', 1, 'review', review('Bob'));
    const prisma = prismaFixture();
    expect((await withCurrentSourceStatus([record], prisma))[0].summary.exportable).toBe(true);
    vi.mocked(prisma.scenarioDefinition.findMany).mockResolvedValue([{ ...row, promptTemplate: 'New task' }]);
    const [stale] = await withCurrentSourceStatus([record], prisma);
    expect(stale.summary.exportable).toBe(false); expect(stale.events).toHaveLength(2);
    expect(() => store.freezeExport([stale], 'calibration', 'seed')).toThrow('reviewed');
  });
});

describe('intake provenance', () => {
  const makeRun = () => ({ id: 'run', modelConfigId: 'model', modelConfig: { name: 'model' }, manifest: null,
    results: [{ id: 'result', scenarioId: row.id, scenarioVersion: '1', modelOutput: 'OK', outputMetadata: '{}', evidence: '[]', totalScore: 100,
      graderVersion: 'legacy', humanReviewRequired: false, environmentError: false }] });
  it('labels legacy rule replays as reconstructed, preserves score and does not infer Judge history', async () => {
    const prisma = { ...prismaFixture(), evalRun: { findUnique: vi.fn().mockResolvedValue(makeRun()) } } as unknown as PrismaClient;
    const [c] = await collectRunCandidates(prisma, 'run');
    expect(c).toMatchObject({ snapshotOrigin: 'current_definition', automaticSource: 'unavailable', observedScore: 100, judgeScoreHistory: [] });
    expect(c.automaticCriteria).toEqual([]);
    expect(await collectRunCandidates(prisma, 'run', false)).toEqual([]);
    const store = memoryStore();
    expect((await intakeRuns(prisma, store, ['run'], 1)).inserted).toBe(1);
    expect(store.list()[0].candidate.automaticSource).toBe('offline_rule_replay');
    expect((await intakeRuns(prisma, store, ['run'], 1)).duplicates).toBe(1);
  });
  it('uses frozen original task even if the current question changed', async () => {
    const run = makeRun();
    const pack = createBenchmarkPack([decodeScenario(row)]);
    const prisma = { ...prismaFixture(), evalRun: { findUnique: vi.fn().mockResolvedValue({ ...run, manifest: JSON.stringify({ benchmarkPack: pack }) }) } } as unknown as PrismaClient;
    vi.mocked(prisma.scenarioDefinition.findMany).mockResolvedValue([{ ...row, promptTemplate: 'changed' }]);
    const [c] = await collectRunCandidates(prisma, 'run');
    expect(c.snapshotOrigin).toBe('run_manifest'); expect(c.scenario.promptTemplate).toBe(row.promptTemplate);
  });
});

describe('calibration API', () => {
  it('enforces review, concurrency and export gates end to end with a real isolated SQLite store', async () => {
    const store = memoryStore(); store.put(candidate()); const app = Fastify();
    await registerCalibrationRoutes(app, prismaFixture(), () => store);
    try {
      const request = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object });
      expect((await request('/api/calibration/export', { candidateIds: ['candidate'], split: 'calibration' })).statusCode).toBe(400);
      expect((await request('/api/calibration/candidate/reviews', { expectedRevision: 0, kind: 'review', review: review('Alice') })).statusCode).toBe(200);
      expect((await request('/api/calibration/candidate/reviews', { expectedRevision: 0, kind: 'review', review: review('Bob') })).statusCode).toBe(409);
      expect((await request('/api/calibration/candidate/reviews', { expectedRevision: 1, kind: 'review', review: review('Bob') })).statusCode).toBe(200);
      const exported = await request('/api/calibration/export', { candidateIds: ['candidate'], split: 'calibration' });
      expect(exported.statusCode).toBe(200); expect(exported.json().hash).toHaveLength(64);
      const qa = await app.inject({ url: '/api/calibration/rubric-qa' });
      expect(qa.statusCode).toBe(200); expect(qa.json().data.comparisons).toBe(1);
    } finally { await app.close(); }
  });
});
