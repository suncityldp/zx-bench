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
const paths = [...new Set(historical.flatMap(([, artifact]) => Object.keys(artifact.sourceHashes)))].sort();
const snapshot = {
  schemaVersion: 1,
  version: 'runtime-source-2026-09-30',
  applicationVersion: JSON.parse(read('package.json')).version,
  baselineCommit: '86d436b19a48c26f7f9d02294420031772272daa',
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
