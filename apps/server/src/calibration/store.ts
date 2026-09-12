import { createRequire } from 'node:module';
import type { DatabaseSync as SQLiteDatabase } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CalibrationCandidate, CalibrationEvent, CalibrationRecord, CalibrationReview } from '@zxbench/types';
import { snapshotHash, summarizeCalibration, validateReviewTransition } from '@zxbench/core';

// Vite 5's older builtin catalogue does not recognize node:sqlite; keep the Node-only load native.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/** Separate append-only governance store: never updates model results or question gold. */
export class CalibrationStore {
  private db: SQLiteDatabase;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS review_events (candidate_id TEXT NOT NULL REFERENCES candidates(id), revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(candidate_id, revision));
      CREATE TABLE IF NOT EXISTS frozen_exports (hash TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL);`);
  }
  close(): void { this.db.close(); }
  put(candidate: CalibrationCandidate): boolean {
    const existing = this.db.prepare('SELECT payload FROM candidates WHERE id=?').get(candidate.id) as { payload: string } | undefined;
    if (existing) {
      const { collectedAt: _oldTime, ...old } = JSON.parse(existing.payload) as CalibrationCandidate;
      const { collectedAt: _newTime, ...next } = candidate;
      if (snapshotHash(old) !== snapshotHash(next)) throw new Error('Candidate ID collision; immutable payload differs');
      return false;
    }
    const r = this.db.prepare('INSERT OR IGNORE INTO candidates(id,content_hash,payload,created_at) VALUES(?,?,?,?)')
      .run(candidate.id, snapshotHash(candidate), JSON.stringify(candidate), candidate.collectedAt);
    return Number(r.changes) === 1;
  }
  get(id: string): CalibrationRecord | undefined {
    const row = this.db.prepare('SELECT payload, content_hash FROM candidates WHERE id=?').get(id) as { payload: string; content_hash: string } | undefined;
    if (!row) return undefined;
    const candidate = JSON.parse(row.payload) as CalibrationCandidate;
    if (snapshotHash(candidate) !== row.content_hash) throw new Error('Candidate snapshot integrity failed');
    const events = (this.db.prepare('SELECT payload FROM review_events WHERE candidate_id=? ORDER BY revision').all(id) as Array<{ payload: string }>).map(r => JSON.parse(r.payload) as CalibrationEvent);
    return { candidate, events, summary: summarizeCalibration(candidate, events) };
  }
  list(limit = 5000): CalibrationRecord[] {
    return (this.db.prepare('SELECT id FROM candidates ORDER BY created_at DESC, id LIMIT ?').all(limit) as Array<{ id: string }>).map(r => this.get(r.id)!);
  }
  count(): number { return Number((this.db.prepare('SELECT COUNT(*) n FROM candidates').get() as { n: number }).n); }
  review(id: string, expectedRevision: number, kind: CalibrationEvent['kind'], review: CalibrationReview): CalibrationRecord {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const record = this.get(id);
      if (!record) throw new Error('Candidate not found');
      if (!Number.isInteger(expectedRevision) || record.summary.revision !== expectedRevision) throw new Error('Revision conflict: reload before submitting');
      validateReviewTransition(record.candidate, record.events, kind, review);
      const event: CalibrationEvent = { revision: expectedRevision + 1, kind, review, createdAt: new Date().toISOString() };
      this.db.prepare('INSERT INTO review_events(candidate_id,revision,payload) VALUES(?,?,?)').run(id, event.revision, JSON.stringify(event));
      const updated = this.get(id)!;
      this.db.exec('COMMIT'); return updated;
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }
  freezeExport(records: CalibrationRecord[], split: CalibrationCandidate['split'], seed: string) {
    if (!records.length || records.some(r => !r.summary.exportable || r.candidate.split !== split)) throw new Error('Export requires reviewed, source-verified records in exactly one split');
    const content = { schemaVersion: 1, kind: 'human-calibration', split, seed,
      records: [...records].sort((a, b) => a.candidate.id.localeCompare(b.candidate.id, 'en')) };
    const hash = snapshotHash(content);
    const payload = { ...content, hash };
    this.db.prepare('INSERT OR IGNORE INTO frozen_exports(hash,payload,created_at) VALUES(?,?,?)').run(hash, JSON.stringify(payload), new Date().toISOString());
    return payload;
  }
}

let shared: CalibrationStore | undefined;
export function getCalibrationStore(): CalibrationStore {
  return shared ??= new CalibrationStore(process.env.ZXBENCH_CALIBRATION_DB || fileURLToPath(new URL('../../../data/calibration.db', import.meta.url)));
}
