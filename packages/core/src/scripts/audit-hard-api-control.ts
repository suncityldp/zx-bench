import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {snapshotHash} from '../contracts/pack.js';
import {
  API_CONTROL_PROVIDERS,
  allowedReturnedModel,
  buildHardApiControlPlan,
  gradeHardApi,
  hardApiBody,
} from '../evaluationLab/hardApiControlPlan.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const [run, providerKey, output] = process.argv.slice(2);
if (!output) throw new Error('Usage: RUN PROVIDER NEW_AUDIT');
const read = (path: string) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const sha = (path: string) => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
const manifest = read(join(run, 'manifest.json'));
const plan = buildHardApiControlPlan();
assert.equal(snapshotHash(read(join(run, 'plan.json'))), snapshotHash(plan));
assert.equal(manifest.planHash, snapshotHash(plan));
for (const [path, hash] of Object.entries(manifest.sourceHashes as Record<string, string>)) {
  assert.equal(sha(path), hash, path);
}
assert.equal(read(join(run, 'RUN_STARTED.json')).manifestHash, snapshotHash(manifest));
const providerIndex = API_CONTROL_PROVIDERS.findIndex((provider) => provider.key === providerKey);
assert(providerIndex >= 0);
const provider = API_CONTROL_PROVIDERS[providerIndex];
const base = join(run, provider.key);
const answers = read(join(base, 'answers-012.json'));
assert.equal(answers.length, 12);
assert.deepEqual(answers.map((answer: any) => answer.id), plan.questions.map((question) => question.id));

const details = plan.questions.map((question, index) => {
  const directory = join(base, question.id);
  const request = read(join(directory, 'request.json'));
  const raw = read(join(directory, 'raw.json'));
  const attempt = read(join(directory, 'attempt.json'));
  const answer = answers[index];
  assert.deepEqual(request, {endpoint: provider.endpoint, body: hardApiBody(provider, question)});
  assert.equal(attempt.requestHash, snapshotHash(request.body));
  assert.equal(attempt.attemptsForQuestion, 1);
  assert.equal(attempt.ordinal, providerIndex * 12 + index + 1);
  assert.equal(answer.questionHash, question.questionHash);
  assert.equal(answer.outcome, 'completed');
  assert.equal(answer.output, raw.content);
  assert.equal(raw.error, null);
  assert.equal(raw.httpStatus, 200);
  assert.equal(raw.streamDone, true);
  assert.equal(raw.finishReason, 'stop');
  assert(raw.latencyMs > 0 && raw.latencyMs <= 1_205_000);
  assert(allowedReturnedModel(provider.key, raw.returnedModels));
  const wirePath = resolve(root, directory, 'wire.sse');
  const wire = readFileSync(wirePath);
  assert.equal(wire.byteLength, raw.bytes);
  let content = '';
  let reasoningContent = '';
  let finishReason = 'unknown';
  let streamDone = false;
  let usage: unknown = null;
  const models = new Set<string>();
  const responseIds = new Set<string>();
  for (const line of wire.toString('utf8').split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const value = line.slice(5).trim();
    if (!value) continue;
    if (value === '[DONE]') {
      streamDone = true;
      continue;
    }
    assert(!streamDone, 'Data after DONE');
    const chunk = JSON.parse(value);
    assert(!chunk.error);
    if (chunk.model) models.add(chunk.model);
    if (chunk.id) responseIds.add(chunk.id);
    if (chunk.usage) usage = chunk.usage;
    for (const choice of chunk.choices ?? []) {
      assert.equal(choice.index ?? 0, 0);
      const delta = choice.delta ?? {};
      assert(!delta.tool_calls && !delta.function_call);
      content += delta.content ?? '';
      reasoningContent += delta.reasoning_content ?? delta.reasoning ?? '';
      finishReason = choice.finish_reason ?? finishReason;
    }
  }
  assert.deepEqual(
    {content, reasoningContent, finishReason, streamDone, usage, returnedModels: [...models], responseIds: [...responseIds]},
    {
      content: raw.content,
      reasoningContent: raw.reasoningContent,
      finishReason: raw.finishReason,
      streamDone: raw.streamDone,
      usage: raw.usage,
      returnedModels: raw.returnedModels,
      responseIds: raw.responseIds,
    },
  );
  assert.equal(responseIds.size, 1);
  return {
    id: question.id,
    questionHash: question.questionHash,
    requestHash: snapshotHash(request.body),
    answerHash: snapshotHash(answer.output),
    wireHash: sha(join(directory, 'wire.sse')),
    returnedModels: raw.returnedModels,
    responseIds: raw.responseIds,
    latencyMs: raw.latencyMs,
    usage: raw.usage,
  };
});
assert.equal(new Set(details.flatMap((detail) => detail.responseIds)).size, 12);
const grades = gradeHardApi(plan, provider.key, `${run}/${provider.key}`, answers);
assert.deepEqual(read(join(base, 'grades-012.json')), grades);
const result = {
  version: 'hard-api-control-answer-audit-v1',
  provider: provider.key,
  planHash: plan.contractHash,
  manifestHash: snapshotHash(manifest),
  dimensions: grades.dimensions,
  details,
  explicitAttempts: 12,
  automaticRetries: 0,
  judgeCalls: 0,
  productionWrites: false,
  oldScoresChanged: false,
  graderReplayIsNotIndependentGold: true,
  providerAliasIsNotImmutableWeights: true,
  sameDecodingAsLocal: false,
  combinedScore: null,
  productionEligible: false,
  auditorHash: sha(fileURLToPath(import.meta.url)),
};
writeFileSync(resolve(root, output), JSON.stringify(result, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({output, provider: provider.key, dimensions: result.dimensions, explicitAttempts: 12}));
