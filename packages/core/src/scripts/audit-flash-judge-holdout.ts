/** Offline audit for the current Flash Judge holdout run. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {snapshotHash} from '../contracts/pack.js';
import {assessAtomicAudit, type AuditFixture, type AuditVerdict} from '../evaluationLab/atomicJudge.js';
import {
  ANCHORED_JUDGE_INSTRUCTIONS,
  anchoredJudgeFixtures,
  anchoredPublicItem,
  parseAnchoredAudit,
} from '../evaluationLab/anchoredAtomicJudge.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const [target, destination] = process.argv.slice(2);
assert(target && destination, 'Usage: audit-flash-judge-holdout DIR NEW_AUDIT_JSON');
const dir = resolve(root, target);
const out = resolve(root, destination);
const read = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

assert(!existsSync(out), 'Do not overwrite an audit');
assert(!existsSync(join(dir, 'active.lock')), 'Judge call still active');
assert(!existsSync(join(dir, 'STOP')), 'Judge run stopped on a failure');

const manifest = read('manifest.json');
const inputs = read('inputs.json');
const fixtures: AuditFixture[] = read('coordinator/fixtures.json');
const calls: any[] = read('calls.json');
const expectedFixtures = anchoredJudgeFixtures().filter((fixture) => fixture.split === 'holdout');

assert.equal(manifest.version, 'flash-anchored-judge-holdout-2026-09-12-v1');
assert.equal(snapshotHash(inputs), manifest.inputsHash);
assert.equal(snapshotHash(fixtures), manifest.fixturesHash);
assert.equal(snapshotHash(expectedFixtures), manifest.fixturesHash);
assert.equal(calls.length, manifest.maxCalls);
assert.equal(calls.length, readdirSync(dir).filter((name) => /^\d\d-attempt\.json$/.test(name)).length);
for (const [path, hash] of Object.entries(manifest.sourceHashes as Record<string, string>)) {
  assert.equal(sha(join(root, path)), hash, `Frozen source changed: ${path}`);
}

let lastEnd = 0;
const verdicts: AuditVerdict[] = [];
const reconstructed = calls.map((call, index) => {
  const step = inputs.plan[index];
  assert.equal(call.id, step.id);
  assert.equal(call.status, 'all_labels_match');
  const chosen = fixtures.filter((fixture) => step.itemIds.includes(fixture.item.id));
  const items = chosen.map((fixture) => anchoredPublicItem(fixture.item));
  const packet = {version: manifest.version, bindingHash: snapshotHash(items), items};
  const request = read(`${call.id}-request.json`);
  const attempt = read(`${call.id}-attempt.json`);
  const raw = read(`${call.id}-raw.json`);
  const parsedFile = read(`${call.id}-parsed.json`);
  const review = read(`${call.id}-review.json`);

  assert.deepEqual(request.body.messages, [
    {role: 'system', content: ANCHORED_JUDGE_INSTRUCTIONS},
    {role: 'user', content: JSON.stringify(packet)},
  ]);
  assert.equal(request.body.model, manifest.modelName);
  for (const [key, value] of Object.entries(manifest.params)) assert.deepEqual(request.body[key], value);
  assert.equal(snapshotHash(request.body), attempt.requestHash);
  assert.equal(attempt.attempt, 1);
  assert.equal(snapshotHash(raw), call.rawHash);
  assert.equal(review.rawHash, call.rawHash);
  assert.equal(review.decision, 'continue');
  assert.equal(review.reasonsSupported, true);
  assert.equal(review.segmentsPreserveStance, true);
  assert.equal(review.sourceLinksRelevant, true);

  const start = Date.parse(attempt.startedAt);
  assert(Number.isFinite(start) && start >= lastEnd, 'Judge calls overlap');
  lastEnd = start + raw.latencyMs;

  let content = '';
  let reasoningContent = '';
  let finishReason = 'unknown';
  let streamDone = false;
  let usage: any = null;
  const wirePath = join(dir, `${call.id}-wire.sse`);
  const wire = readFileSync(wirePath);
  assert.equal(wire.length, raw.bytes);
  for (const line of wire.toString('utf8').split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') {
      streamDone = true;
      continue;
    }
    if (!data) continue;
    const chunk = JSON.parse(data);
    assert(!chunk.error);
    if (chunk.usage) usage = chunk.usage;
    for (const choice of chunk.choices ?? []) {
      assert.equal(choice.index ?? 0, 0);
      assert(!choice.delta?.tool_calls);
      content += choice.delta?.content ?? '';
      reasoningContent += choice.delta?.reasoning_content ?? choice.delta?.reasoning ?? '';
      finishReason = choice.finish_reason ?? finishReason;
    }
  }
  assert.deepEqual(
    {content, reasoningContent, finishReason, streamDone, usage},
    {
      content: raw.content,
      reasoningContent: raw.reasoningContent,
      finishReason: raw.finishReason,
      streamDone: raw.streamDone,
      usage: raw.usage,
    },
  );
  assert.equal(raw.httpStatus, 200);
  assert.equal(raw.error, null);
  assert.equal(finishReason, 'stop');
  assert.equal(streamDone, true);

  const parsed = parseAnchoredAudit(items, content, finishReason, streamDone);
  assert.deepEqual(parsed, parsedFile.verdicts);
  const assessment = assessAtomicAudit(chosen, parsed);
  assert.deepEqual(assessment, parsedFile.assessment);
  assert.equal(assessment.allMatch, true);
  verdicts.push(...parsed);
  return {
    id: call.id,
    rawHash: call.rawHash,
    wireHash: sha(wirePath),
    reviewHash: sha(join(dir, `${call.id}-review.json`)),
    labelsMatch: true,
    semanticReviewPassed: true,
    latencyMs: raw.latencyMs,
    usage,
  };
});

const assessment = assessAtomicAudit(fixtures, verdicts);
assert.equal(assessment.complete, true);
assert.equal(assessment.allMatch, true);
const byDimension = [...new Set(fixtures.map((fixture) => fixture.item.dimension))].map((dimension) => {
  const selected = fixtures.filter((fixture) => fixture.item.dimension === dimension);
  const selectedVerdicts = verdicts.filter((verdict) => selected.some((fixture) => fixture.item.id === verdict.id));
  return {dimension, ...assessAtomicAudit(selected, selectedVerdicts)};
});

const historicalLedger = JSON.parse(
  readFileSync(join(root, 'reports/he001-judge-trial-2026-09-11-v0.6/preserved-input-hashes.json'), 'utf8'),
);
for (const [path, hash] of Object.entries(historicalLedger as Record<string, string>)) {
  assert.equal(sha(join(root, path)), hash, `Historical input changed: ${path}`);
}

const result = {
  createdAt: new Date().toISOString(),
  version: manifest.version,
  judge: {modelName: manifest.modelName, displayName: manifest.displayName, modelConfigId: manifest.modelId},
  calls: reconstructed,
  assessment,
  byDimension,
  gates: {
    allSixCallsCompleted: reconstructed.length === 6,
    allLabelsMatch: assessment.allMatch,
    allReasonsSegmentsSourcesReviewed: reconstructed.every((row) => row.semanticReviewPassed),
    noRetry: reconstructed.length === readdirSync(dir).filter((name) => /^\d\d-attempt\.json$/.test(name)).length,
    rawStreamsReconstructed: true,
    noTruncationOrOperationalFailure: true,
  },
  eligibleForBoundedReviewQueue: true,
  boundedRole: 'semantic_error_flags_and_human_review_queue_only',
  productionEligible: false,
  automaticScoreWeight: 0,
  independentHumanGold: false,
  usage: {
    promptTokens: reconstructed.reduce((sum, row) => sum + (row.usage?.prompt_tokens ?? 0), 0),
    completionTokens: reconstructed.reduce((sum, row) => sum + (row.usage?.completion_tokens ?? 0), 0),
    reasoningTokens: reconstructed.reduce(
      (sum, row) => sum + (row.usage?.completion_tokens_details?.reasoning_tokens ?? 0),
      0,
    ),
    latencyMs: reconstructed.reduce((sum, row) => sum + row.latencyMs, 0),
  },
  historicalFilesUnchanged: Object.keys(historicalLedger).length,
  caveats: [
    'The 12 authored paired controls are not IID samples or independent human gold.',
    'Passing qualifies only narrow semantic flags and a mandatory human-review queue.',
    'The Judge does not replace deterministic exact-answer checks and has zero automatic score weight.',
  ],
};

assert(Object.values(result.gates).every(Boolean));
writeFileSync(out, JSON.stringify(result, null, 2) + '\n', {flag: 'wx'});
console.log(
  JSON.stringify({
    output: destination,
    matched: assessment.matched,
    planned: assessment.planned,
    eligibleForBoundedReviewQueue: result.eligibleForBoundedReviewQueue,
    usage: result.usage,
  }),
);
