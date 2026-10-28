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
const toolPaths = ['packages/core/src/evaluators/toolCallTrace.ts','packages/core/src/evaluators/cliCommand.ts','scripts/lib/tool-contract-repairs.mjs','scripts/lib/tool-checkpoints.mjs','scripts/lib/tool-cli-checkpoints.mjs','scripts/lib/execution-task-pack.mjs','scripts/lib/recovery-world-tasks.mjs'];
const visibleContractPaths = ['scripts/lib/workflow-visible-contracts.mjs','scripts/build-tool-world-pilots.mjs','packages/core/src/evaluators/agentTrace.ts'];
const reviewPaths = ['packages/core/src/scoring.ts','packages/core/src/quality.ts','packages/core/src/referenceAnswerReview.ts','packages/core/src/evaluators/exactAnswerLine.ts','packages/core/src/evaluators/mathAnswerFields.ts','packages/core/src/evaluators/ultraBatchPart.ts','packages/core/src/evaluationLab/examExpansion/index.ts','packages/core/src/evaluationLab/examExpansion/math-candidates.json','packages/core/src/evaluationLab/examPaper/index.ts','apps/server/src/routes/index.ts','scripts/lib/tool-content-delivery-review.mjs','scripts/build-recovery-world-docker.mjs','scripts/build-advanced-cli-docker.mjs'];
const programPaths = ['packages/core/src/evaluators/repairSubmission.ts','packages/core/src/execution/goSubmission.ts','packages/core/src/execution/isolatedGoJson.ts','packages/core/src/execution/typescriptTypeWorker.ts','scripts/revise-program-contracts.mjs','data/scenarios/program-revision-manifest.json'];
const semanticPaths = ['packages/core/src/evaluators/semanticMeaningReview.ts','packages/core/src/evaluators/semanticMeaningReview.test.ts','docs/semantic-meaning-review-v2.md','scripts/freeze-runtime-source-snapshot.mjs'];
const deploymentPaths = ['packages/core/src/execution/imagePreflight.ts','packages/core/src/execution/sessionRunner.ts','packages/core/src/orchestrator.ts','apps/server/src/index.ts','apps/server/src/applicationVersion.ts','scripts/check-docker-images.mjs','scripts/prepare-docker-images.mjs','scripts/export-docker-images.mjs','scripts/configure-server-env.mjs','scripts/check-deployment.mjs','docker/execution-images/runtime.json'];
const bugfixPaths = ["apps/server/src/modelSecrets.ts","packages/core/src/model/caller.ts","packages/core/src/evaluators/codeRepair.ts","packages/core/src/evaluators/reviewedWorldFacts.ts","scripts/lib/safety-contract-repairs.mjs"];
const paths = [...new Set([...historical.flatMap(([, artifact]) => Object.keys(artifact.sourceHashes)),...workflowPaths,...toolPaths,...visibleContractPaths,...reviewPaths,...programPaths,...semanticPaths,...deploymentPaths,...bugfixPaths,'packages/core/src/execution/inspectContainerState.ts'])].sort();
const snapshot = {
  schemaVersion: 1,
  version: 'runtime-source-2026-10-28-v0.2.13-container-recovery',
  applicationVersion: JSON.parse(read('package.json')).version,
  baselineCommit: '5c4648973dd1ad5034a6eb7671042bd9dd93afe3',
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
