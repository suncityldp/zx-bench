import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { CalibrationRecord, CalibrationReview, CalibrationSplit } from '@zxbench/types';
import { analyzeRubricQuality, normalizeReviewer, snapshotHash } from '@zxbench/core';
import { decodeScenario } from '../evaluationSnapshot.js';
import { getCalibrationStore, type CalibrationStore } from './store.js';
import { intakeRuns } from './intake.js';

export async function withCurrentSourceStatus(records: CalibrationRecord[], prisma: PrismaClient): Promise<CalibrationRecord[]> {
  const rows = await prisma.scenarioDefinition.findMany({ where: { id: { in: [...new Set(records.map(r => r.candidate.scenario.id))] } } });
  const current = new Map(rows.map(row => [row.id, decodeScenario(row)]));
  return records.map(record => {
    const scenario = current.get(record.candidate.scenario.id);
    const until = (record.candidate.scenario.requirements as unknown as { validUntil?: string })?.validUntil;
    const reason = !scenario || snapshotHash(scenario) !== record.candidate.scenarioContentHash
      ? 'Current scenario differs or was removed; new version/review required'
      : until && (!Number.isFinite(Date.parse(until)) || Date.parse(until) < Date.now()) ? 'Reference/gold validity expired' : undefined;
    return reason ? { ...record, summary: { ...record.summary, exportable: false, exclusionReasons: [...record.summary.exclusionReasons, reason] } } : record;
  });
}

/** Independent first/second review is blind to model names, automated grades and peer labels. Local identity is self-reported. */
export function presentCalibration(record: CalibrationRecord, reviewer = '', adjudicate = false) {
  const submitted = record.events.some(e => normalizeReviewer(e.review.reviewer) === normalizeReviewer(reviewer));
  const canSeeReviews = submitted || (adjudicate && record.summary.state === 'disputed');
  const { observedScore: _score, automaticCriteria: _automatic, judgeScoreHistory: _history,
    modelId: _modelId, modelName: _name, reasoningContent: _reasoning, ...blind } = record.candidate;
  return { candidate: canSeeReviews ? record.candidate : blind,
    events: canSeeReviews ? record.events : [], summary: { ...record.summary, labels: canSeeReviews ? record.summary.labels : undefined },
    blindReview: !canSeeReviews, identityNotice: 'Reviewer identifiers are self-reported in this local app; use real independent reviewers.' };
}

export async function registerCalibrationRoutes(app: FastifyInstance, prisma: PrismaClient, storeProvider: () => CalibrationStore = getCalibrationStore) {
  app.get('/api/calibration', async request => {
    const q = request.query as { state?: string; split?: string; dimension?: string; offset?: string; limit?: string };
    const store = storeProvider();
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 30));
    const offset = Math.max(0, Math.floor(Number(q.offset) || 0));
    const records = await withCurrentSourceStatus(store.list(), prisma);
    const filtered = records.filter(r => (!q.state || r.summary.state === q.state) && (!q.split || r.candidate.split === q.split) && (!q.dimension || r.candidate.scenario.dimension === q.dimension));
    return { success: true, data: { total: filtered.length, stored: store.count(), scanned: records.length,
      candidates: filtered.slice(offset, offset + limit).map(r => ({ id: r.candidate.id, scenarioId: r.candidate.scenario.id,
        dimension: r.candidate.scenario.dimension, difficulty: r.candidate.scenario.difficulty, split: r.candidate.split,
        snapshotOrigin: r.candidate.snapshotOrigin, ...r.summary, labels: undefined })) } };
  });
  app.post('/api/calibration/intake', async (request, reply) => {
    try {
      const body = request.body as { runIds?: string[]; count?: number; includeControls?: boolean };
      if (!Array.isArray(body.runIds) || body.runIds.some(id => typeof id !== 'string')) throw new Error('runIds must be a list of run IDs');
      const result = await intakeRuns(prisma, storeProvider(), body.runIds, body.count ?? 60, body.includeControls !== false);
      return { success: true, data: result };
    } catch (err) { return reply.status(400).send({ success: false, error: String(err) }); }
  });
  app.get('/api/calibration/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { reviewer?: string; adjudicate?: string };
    const record = storeProvider().get(id);
    if (!record) return reply.status(404).send({ success: false, error: 'Candidate not found' });
    const [fresh] = await withCurrentSourceStatus([record], prisma);
    return { success: true, data: presentCalibration(fresh, query.reviewer, query.adjudicate === 'true') };
  });
  app.post('/api/calibration/:id/reviews', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const { expectedRevision, kind, review } = request.body as { expectedRevision: number; kind: 'review' | 'adjudicate'; review: CalibrationReview };
      if (kind !== 'review' && kind !== 'adjudicate') throw new Error('Invalid review action');
      const record = storeProvider().review(id, expectedRevision, kind, review);
      const [fresh] = await withCurrentSourceStatus([record], prisma);
      return { success: true, data: presentCalibration(fresh, review.reviewer) };
    } catch (err) { return reply.status(String(err).includes('Revision conflict') ? 409 : 400).send({ success: false, error: String(err) }); }
  });
  app.get('/api/calibration/rubric-qa', async () => {
    const store = storeProvider();
    const records = await withCurrentSourceStatus(store.list(), prisma);
    return { success: true, data: { ...analyzeRubricQuality(records), storedCandidates: store.count(), inspectedCandidates: records.length } };
  });
  app.post('/api/calibration/export', async (request, reply) => {
    try {
      const body = request.body as { candidateIds: string[]; split: CalibrationSplit; allowHoldout?: boolean };
      if (!Array.isArray(body.candidateIds) || !body.candidateIds.length || body.candidateIds.length > 1000 || new Set(body.candidateIds).size !== body.candidateIds.length) throw new Error('Select 1–1000 distinct candidate IDs');
      if (!['development', 'calibration', 'blind_holdout'].includes(body.split)) throw new Error('Select exactly one split');
      if (body.split === 'blind_holdout' && !body.allowHoldout) throw new Error('Blind-holdout export requires explicit allowHoldout acknowledgement');
      const store = storeProvider();
      const records = body.candidateIds.map(id => { const r = store.get(id); if (!r) throw new Error(`Unknown candidate ${id}`); return r; });
      const fresh = await withCurrentSourceStatus(records, prisma);
      const content = store.freezeExport(fresh, body.split, 'zxbench-p1-2026-09-08');
      reply.header('Content-Disposition', `attachment; filename="calibration-${content.hash.slice(0, 12)}.json"`);
      return content;
    } catch (err) { return reply.status(400).send({ success: false, error: String(err) }); }
  });
}
