// Preserve release/audit evidence. Freeze current source separately; never claim
// new human gold or silently rewrite earlier source fingerprints.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = new URL('../', import.meta.url);
const destination = new URL('data/scenarios/runtime-source-snapshot.json', root);
const hash = text => createHash('sha256').update(text).digest('hex');
const read = path => readFileSync(new URL(path, root), 'utf8').replaceAll('\r\n', '\n');
const historicalPaths = ['data/scenarios/execution-review-manifest.json', 'data/scenarios/pr-witness-development.json'];
const historical = historicalPaths.map(path => [path, JSON.parse(read(path))]);
const workflowPaths = ['packages/core/src/audit.ts','packages/core/src/contracts/eligibility.ts','packages/core/src/contracts/knownDefects.ts','packages/core/src/evaluators/worldTrace.ts','packages/core/src/evaluators/worldCheckpoints.ts','packages/core/src/evaluators/semanticFinalAnswer.ts','packages/core/src/execution/worldLoop.ts','packages/types/src/index.ts','scripts/lib/workflow-checkpoints.mjs','scripts/lib/workflow-contract-repairs.mjs','scripts/lib/workflow-read-verification.mjs','scripts/prepare-workflow-runtime.mjs','docker/workflow-contracts/runtime.json','data/scenarios/benchmark.json','data/scenarios/benchmark-meta.json','data/scenarios/benchmark-release.json'];
const paths = [...new Set([...historical.flatMap(([, artifact]) => Object.keys(artifact.sourceHashes)),...workflowPaths])].sort();
const snapshot = {
  schemaVersion: 1,
  version: 'runtime-source-2026-10-01-workflow-repair',
  applicationVersion: JSON.parse(read('package.json')).version,
  baselineCommit: '71635c2e2a21c1e5a7ca9e53c95e61df9328702b',
  purpose: 'Current runtime fingerprint; historical audit and production-task snapshots remain unchanged',
  independentHumanGold: false,
  historicalRescoring: false,
  sourceHashNormalization: 'UTF-8, CRLF to LF',
  historicalSnapshots: Object.fromEntries(historical.map(([path, artifact]) => [path, { version: artifact.version, sha256: hash(read(path)) }])),
  sourceHashes: Object.fromEntries(paths.map(path => [path, hash(read(path))])),
};
const serialized = JSON.stringify(snapshot, null, 2) + '\n';
if (process.argv.includes('--write')) writeFileSync(destination, serialized);
else if (readFileSync(destination, 'utf8').replaceAll('\r\n', '\n') !== serialized) throw new Error('Current runtime source snapshot drift; review source changes before freezing a new snapshot');
console.log(JSON.stringify({ checked: true, written: process.argv.includes('--write'), version: snapshot.version, sourceCount: paths.length, historicalSnapshotsPreserved: historicalPaths.length }));
