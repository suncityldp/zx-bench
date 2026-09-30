// Historical task evidence is immutable; current source pins live separately.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PR_SQL_DEVELOPMENT_TASK } from '../packages/core/dist/evaluationLab/prWitnessSql.js';
const root = new URL('../', import.meta.url);
const artifact = JSON.parse(readFileSync(new URL('data/scenarios/pr-witness-development.json', root), 'utf8'));
const taskHash = createHash('sha256').update(JSON.stringify(PR_SQL_DEVELOPMENT_TASK)).digest('hex');
if (artifact.taskHash !== taskHash || JSON.stringify(artifact.task) !== JSON.stringify(PR_SQL_DEVELOPMENT_TASK)) throw Error('Historical task contract changed; create a reviewed new task version instead of rewriting its evidence');
if (artifact.independentHumanGold !== false || artifact.historicalRescoring !== false) throw Error('Historical evidence flags changed');
execFileSync(process.execPath, [fileURLToPath(new URL('scripts/freeze-runtime-source-snapshot.mjs', root)), ...(process.argv.includes('--write') ? ['--write'] : [])], { stdio: 'inherit' });
console.log(JSON.stringify({ checked: true, id: artifact.task.id, taskHash, historicalEvidencePreserved: true }));
