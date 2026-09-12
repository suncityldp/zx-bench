import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createDecipheriv, createHash, scryptSync} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {snapshotHash} from '../contracts/pack.js';
import {apiControlStream} from '../evaluationLab/apiControlStream.js';
import {
  API_CONTROL_PROVIDERS,
  allowedReturnedModel,
  buildHardApiControlPlan,
  gradeHardApi,
  hardApiBody,
} from '../evaluationLab/hardApiControlPlan.js';
import type {Answer} from '../evaluationLab/methodsV2/score.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const [mode, target, execute] = process.argv.slice(2);
if (!target || !['--prepare', '--run'].includes(mode) || (mode === '--prepare' ? execute !== undefined : execute !== '--execute')) {
  throw new Error('Usage: --prepare NEW_DIR | --run DIR --execute');
}
const out = resolve(root, target);
const read = (path: string) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const save = (path: string, data: unknown) =>
  writeFileSync(join(out, path), JSON.stringify(data, null, 2) + '\n', {flag: 'wx'});
const status = (data: unknown) => {
  writeFileSync(
    join(out, 'status.json.tmp'),
    JSON.stringify({...data as object, updatedAt: new Date().toISOString()}, null, 2),
  );
  renameSync(join(out, 'status.json.tmp'), join(out, 'status.json'));
};
const sourceFiles = [
  'packages/core/src/scripts/run-hard-api-control.ts',
  'packages/core/src/evaluationLab/hardApiControlPlan.ts',
  'packages/core/src/evaluationLab/apiControlPlan.ts',
  'packages/core/src/evaluationLab/apiControlStream.ts',
  'packages/core/src/evaluationLab/evidenceMatrix.ts',
  'packages/core/src/evaluationLab/latentCensoringProbability.ts',
  'packages/core/src/evaluationLab/methodsV2/score.ts',
  'packages/core/src/evaluationLab/methodsV2/types.ts',
  'packages/core/src/evaluationLab/methodsV2/verify.ts',
  'packages/core/src/evaluationLab/challengeTypes.ts',
  'packages/core/src/contracts/pack.ts',
];
const sourceHashes = () =>
  Object.fromEntries(
    sourceFiles.map((path) => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]),
  );

function configuration(provider: typeof API_CONTROL_PROVIDERS[number]) {
  const database = new DatabaseSync(join(root, 'apps/data/zxbench.db'), {readOnly: true});
  let row: {name: string; baseUrl: string; apiKey: string} | undefined;
  try {
    row = database.prepare('SELECT name,baseUrl,apiKey FROM ModelConfig WHERE id=?').get(provider.configId) as typeof row;
  } finally {
    database.close();
  }
  if (!row || row.name !== provider.requestedModel || !row.apiKey) {
    throw new Error('Selected stored configuration missing or changed');
  }
  const endpoint = new URL(row.baseUrl.replace(/\/$/, '') + '/chat/completions');
  if (endpoint.href !== provider.endpoint || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Unexpected stored endpoint');
  }
  return row;
}
function decrypt(value: string) {
  const [iv, data] = value.split(':');
  if (!iv || !data) return value;
  const decipher = createDecipheriv(
    'aes-256-cbc',
    scryptSync(process.env.ZXBENCH_ENCRYPTION_KEY || 'zxbench-default-key-change-me!', 'zxbench-salt', 32),
    Buffer.from(iv, 'hex'),
  );
  return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8');
}

const plan = buildHardApiControlPlan();
if (mode === '--prepare') {
  if (existsSync(out)) throw new Error('Never overwrite an existing trial');
  assert.equal(
    snapshotHash(plan.evidence),
    snapshotHash(read('reports/resistance-math-hard-candidates-2026-09-12-v1.2/coordinator/evidence-pack.json')),
  );
  assert.equal(
    snapshotHash(plan.math),
    snapshotHash(read('reports/resistance-math-hard-candidates-2026-09-12-v1.2/coordinator/math-pack.json')),
  );
  for (const provider of API_CONTROL_PROVIDERS) configuration(provider);
  mkdirSync(out, {recursive: true});
  save('plan.json', plan);
  save('candidate-questions.json', {questions: plan.questions});
  save('manifest.json', {
    planHash: snapshotHash(plan),
    sourceHashes: sourceHashes(),
    preparedAt: new Date().toISOString(),
    policy: plan.policy,
    authorization: 'Persistent project goal requires a separate harder cross-family validation after both API controls reached the old-pack ceiling.',
    selection: 'Frozen v1.2 development pack: six evidence-matrix cases and six latent-censoring probability cases per model.',
    grading: 'Deterministic local graders only; no Judge, no retry, no score replacement.',
    provenance: 'Raw SSE and returned provider model names retained; aliases do not prove immutable weights.',
    caveat: 'Provider API and local-model runs are different execution classes; compare same-question outcomes descriptively, not causally.',
  });
  status({state: 'prepared', completed: 0, attempted: 0, planned: 24});
  console.log(JSON.stringify({prepared: target, requests: 24, questionsPerModel: 12, modelCalls: 0, judgeCalls: 0}));
} else {
  const manifest = read(join(target, 'manifest.json'));
  const verify = () => {
    assert.equal(snapshotHash(sourceHashes()), snapshotHash(manifest.sourceHashes));
    assert.equal(snapshotHash(read(join(target, 'plan.json'))), snapshotHash(plan));
    assert.equal(manifest.planHash, snapshotHash(plan));
  };
  verify();
  if (existsSync(join(out, 'STOP')) || existsSync(join(out, 'RUN_STARTED.json'))) {
    throw new Error('Already attempted or stopped; no automatic resume/retry');
  }
  save('RUN_STARTED.json', {pid: process.pid, startedAt: new Date().toISOString(), manifestHash: snapshotHash(manifest)});
  let attempted = 0;
  let completed = 0;
  try {
    for (const provider of API_CONTROL_PROVIDERS) {
      const config = configuration(provider);
      const key = decrypt(config.apiKey);
      const answers: Answer[] = [];
      mkdirSync(join(out, provider.key));
      for (const question of plan.questions) {
        verify();
        if (existsSync(join(out, 'STOP'))) throw new Error('Manual_STOP');
        const relative = join(provider.key, question.id);
        mkdirSync(join(out, relative));
        const body = hardApiBody(provider, question);
        save(join(relative, 'request.json'), {endpoint: provider.endpoint, body});
        save(join(relative, 'attempt.json'), {
          startedAt: new Date().toISOString(),
          ordinal: ++attempted,
          requestHash: snapshotHash(body),
          attemptsForQuestion: 1,
        });
        const active = {state: 'running', provider: provider.key, question: question.id, completed, attempted, planned: 24};
        status(active);
        console.log(JSON.stringify({started: true, provider: provider.key, question: question.id, attempted, planned: 24}));
        let lastProgress = 0;
        const raw = await apiControlStream({
          endpoint: provider.endpoint,
          key,
          body,
          wireFile: join(out, relative, 'wire.sse'),
          stopFile: join(out, 'STOP'),
          timeoutMs: 1_200_000,
          onProgress: (progress) => {
            if (Date.now() - lastProgress >= 5_000) {
              lastProgress = Date.now();
              status({...active, progress});
            }
          },
        });
        save(join(relative, 'raw.json'), raw);
        const failure = raw.error ??
          (allowedReturnedModel(provider.key, raw.returnedModels) ? null : 'unexpected_or_missing_returned_model');
        const outcome = failure
          ? (['truncated', 'timeout_or_cancelled'].includes(failure) ? 'truncated' : 'environment_error')
          : 'completed';
        answers.push({id: question.id, questionHash: question.questionHash, outcome, output: raw.content});
        const ordinal = String(answers.length).padStart(3, '0');
        save(join(provider.key, `answers-${ordinal}.json`), answers);
        verify();
        const grade = gradeHardApi(plan, provider.key, `${target}/${provider.key}`, answers);
        save(join(provider.key, `grades-${ordinal}.json`), grade);
        if (!failure) completed++;
        console.log(
          JSON.stringify({
            provider: provider.key,
            question: question.id,
            outcome,
            completed,
            attempted,
            milliseconds: raw.latencyMs,
            returnedModels: raw.returnedModels,
          }),
        );
        if (failure) throw new Error(failure);
      }
    }
    status({state: 'completed', completed, attempted, planned: 24, judgeCalls: 0, productionWrites: false});
  } catch (errorValue) {
    const message = errorValue instanceof Error ? errorValue.message : '';
    const error = /^(HTTP_\d+|Manual_STOP|truncated|timeout_or_cancelled|unexpected_or_missing_returned_model|missing_done|non_stop_finish)$/.test(message)
      ? message
      : 'execution_or_integrity_error';
    save('STOP', {error, attempted, completed, automaticRetries: 0});
    status({
      state: 'stopped',
      error,
      completed,
      attempted,
      planned: 24,
      remoteCancellationGuaranteed: false,
      automaticRetries: 0,
    });
    console.log(JSON.stringify({state: 'stopped', error, completed, attempted}));
    process.exitCode = 1;
  }
}
