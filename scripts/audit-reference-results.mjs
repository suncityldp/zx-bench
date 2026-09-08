// Read-only inventory of issue #7 affected rows. No model calls or score writes.
// node scripts/audit-reference-results.mjs /absolute/path/to/zxbench.db
import { DatabaseSync } from 'node:sqlite';
import { referenceAnswerWarnings } from '../packages/core/dist/referenceAnswerReview.js';
const dbPath = process.argv[2];
if (!dbPath) { console.error('Usage: node scripts/audit-reference-results.mjs /path/to/zxbench.db'); process.exit(1); }
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const rows = db.prepare('SELECT id, evalRunId, scenarioId, scenarioVersion, graderVersion FROM ScenarioResult WHERE scenarioId LIKE ?').all('RM-CN-%');
  const affected = rows.map(row => ({ ...row, issues: referenceAnswerWarnings([row]) })).filter(row => row.issues.length);
  console.log(JSON.stringify({ scannedMathRows: rows.length, affectedRows: affected.length,
    affectedRuns: new Set(affected.map(row => row.evalRunId)).size, rows: affected }, null, 2));
} finally { db.close(); }
