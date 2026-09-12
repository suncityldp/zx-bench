/** Explicit one-off GLM continuation after the immutable base run stopped on HTTP 429. */
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
const baseRelative = 'reports/cross-family-hard-flash-glm-2026-09-12-v1';
const base = resolve(root, baseRelative);
const [mode, target, execute] = process.argv.slice(2);
if (!target || !['--prepare', '--run'].includes(mode) || (mode === '--prepare' ? execute !== undefined : execute !== '--execute')) {
  throw new Error('Usage: --prepare NEW_DIR | --run DIR --execute');
}
const out = resolve(root, target);
const readAbsolute = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const read = (path: string) => readAbsolute(resolve(root, path));
const save = (path: string, data: unknown) =>
  writeFileSync(join(out, path), JSON.stringify(data, null, 2) + '\n', {flag: 'wx'});
const status = (data: unknown) => {
  writeFileSync(
    join(out, 'status.json.tmp'),
    JSON.stringify({...data as object, updatedAt: new Date().toISOString()}, null, 2),
  );
  renameSync(join(out, 'status.json.tmp'), join(out, 'status.json'));
};
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const sourceFiles = [
  'packages/core/src/scripts/run-hard-api-control-continuation.ts',
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
  Object.fromEntries(sourceFiles.map((path) => [path, sha(join(root, path))]));

const plan = buildHardApiControlPlan();
const provider = API_CONTROL_PROVIDERS.find((entry) => entry.key === 'glm-5.2');
assert(provider);
function configuration() {
  const database = new DatabaseSync(join(root, 'apps/data/zxbench.db'), {readOnly: true});
  let row: {name: string; baseUrl: string; apiKey: string} | undefined;
  try {
    row = database.prepare('SELECT name,baseUrl,apiKey FROM ModelConfig WHERE id=?').get(provider!.configId) as typeof row;
  } finally {
    database.close();
  }
  assert(row && row.name === provider!.requestedModel && row.apiKey, 'Selected GLM configuration missing or changed');
  const endpoint = new URL(row.baseUrl.replace(/\/$/, '') + '/chat/completions');
  assert.equal(endpoint.href, provider!.endpoint);
  assert(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
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

function validateBase() {
  const baseManifest = readAbsolute(join(base, 'manifest.json'));
  assert.equal(snapshotHash(readAbsolute(join(base, 'plan.json'))), snapshotHash(plan));
  assert.equal(baseManifest.planHash, snapshotHash(plan));
  for (const [path, hash] of Object.entries(baseManifest.sourceHashes as Record<string, string>)) {
    assert.equal(sha(join(root, path)), hash, `Base source changed: ${path}`);
  }
  const stop = readAbsolute(join(base, 'STOP'));
  const baseStatus = readAbsolute(join(base, 'status.json'));
  assert.deepEqual(stop, {error: 'HTTP_429', attempted: 15, completed: 14, automaticRetries: 0});
  assert.equal(baseStatus.state, 'stopped');
  const failedQuestion = plan.questions[2];
  const failedDirectory = join(base, provider!.key, failedQuestion.id);
  const failedRaw = readAbsolute(join(failedDirectory, 'raw.json'));
  assert.equal(failedRaw.httpStatus, 429);
  assert.equal(failedRaw.error, 'HTTP_429');
  assert.equal(failedRaw.bytes, 0);
  assert.deepEqual(failedRaw.responseIds, []);
  const inherited: Answer[] = readAbsolute(join(base, provider!.key, 'answers-002.json'));
  assert.equal(inherited.length, 2);
  assert.deepEqual(inherited.map((answer) => answer.id), plan.questions.slice(0, 2).map((question) => question.id));
  return {baseManifest, inherited, failedQuestion, failedRaw};
}

if (mode === '--prepare') {
  if (existsSync(out)) throw new Error('Never overwrite an existing continuation');
  const validated = validateBase();
  configuration();
  mkdirSync(out, {recursive: true});
  save('plan.json', plan);
  save('inherited-answers.json', validated.inherited);
  save('manifest.json', {
    version: 'hard-api-control-glm-429-continuation-v1',
    sourceHashes: sourceHashes(),
    planHash: snapshotHash(plan),
    baseRun: baseRelative,
    baseManifestHash: snapshotHash(validated.baseManifest),
    inheritedAnswersHash: snapshotHash(validated.inherited),
    inheritedCount: 2,
    failedQuestionId: validated.failedQuestion.id,
    failedRawHash: snapshotHash(validated.failedRaw),
    remainingQuestionIds: plan.questions.slice(2).map((question) => question.id),
    requestsPlanned: 10,
    retriesWithinContinuation: 0,
    disclosure: 'This is a new explicit continuation after an immutable empty HTTP 429 attempt, not a rewrite of the base run.',
  });
  status({state: 'prepared', completed: 0, attempted: 0, planned: 10});
  console.log(JSON.stringify({prepared: target, inherited: 2, requests: 10, priorFailure: 'HTTP_429'}));
} else {
  const manifest = read(join(target, 'manifest.json'));
  const verify = () => {
    const validated = validateBase();
    assert.equal(snapshotHash(sourceHashes()), snapshotHash(manifest.sourceHashes));
    assert.equal(snapshotHash(read(join(target, 'plan.json'))), snapshotHash(plan));
    assert.equal(manifest.planHash, snapshotHash(plan));
    assert.equal(manifest.baseManifestHash, snapshotHash(validated.baseManifest));
    assert.equal(manifest.inheritedAnswersHash, snapshotHash(validated.inherited));
    assert.equal(manifest.failedRawHash, snapshotHash(validated.failedRaw));
  };
  verify();
  if (existsSync(join(out, 'STOP')) || existsSync(join(out, 'RUN_STARTED.json'))) {
    throw new Error('Already attempted or stopped; no automatic resume/retry');
  }
  const config = configuration();
  const key = decrypt(config.apiKey);
  const answers: Answer[] = read(join(target, 'inherited-answers.json'));
  mkdirSync(join(out, provider.key));
  save('RUN_STARTED.json', {pid: process.pid, startedAt: new Date().toISOString(), manifestHash: snapshotHash(manifest)});
  let attempted = 0;
  let completed = 0;
  try {
    for (const [offset, question] of plan.questions.slice(2).entries()) {
      verify();
      if (existsSync(join(out, 'STOP'))) throw new Error('Manual_STOP');
      const relative = join(provider.key, question.id);
      mkdirSync(join(out, relative));
      const body = hardApiBody(provider, question);
      save(join(relative, 'request.json'), {endpoint: provider.endpoint, body});
      save(join(relative, 'attempt.json'), {
        startedAt: new Date().toISOString(),
        continuationOrdinal: ++attempted,
        globalQuestionOrdinal: offset + 3,
        requestHash: snapshotHash(body),
        attemptsWithinContinuation: 1,
        priorEmpty429Attempt: offset === 0,
      });
      const active = {state: 'running', provider: provider.key, question: question.id, completed, attempted, planned: 10};
      status(active);
      console.log(JSON.stringify({started: true, provider: provider.key, question: question.id, attempted, planned: 10}));
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
      const globalCount = String(answers.length).padStart(3, '0');
      save(join(provider.key, `answers-${globalCount}.json`), answers);
      verify();
      save(join(provider.key, `grades-${globalCount}.json`), gradeHardApi(plan, provider.key, `${target}/${provider.key}`, answers));
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
    status({state: 'completed', completed, attempted, planned: 10, inherited: 2, judgeCalls: 0, productionWrites: false});
  } catch (errorValue) {
    const message = errorValue instanceof Error ? errorValue.message : '';
    const error = /^(HTTP_\d+|Manual_STOP|truncated|timeout_or_cancelled|unexpected_or_missing_returned_model|missing_done|non_stop_finish)$/.test(message)
      ? message
      : 'execution_or_integrity_error';
    save('STOP', {error, attempted, completed, automaticRetries: 0});
    status({state: 'stopped', error, completed, attempted, planned: 10, automaticRetries: 0});
    console.log(JSON.stringify({state: 'stopped', error, completed, attempted}));
    process.exitCode = 1;
  }
}
