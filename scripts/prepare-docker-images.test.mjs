import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureArchive, planPreparation, prepareDockerImages, selectScenarios, validateRuntimeManifest } from './prepare-docker-images.mjs';

const id = `sha256:${'a'.repeat(64)}`, config = `sha256:${'b'.repeat(64)}`;
const spec = { image: 'python:test', imageId: id, configDigest: config, imageIdKind: 'oci_index', platform: 'linux/amd64',
  source: { type: 'registry', repository: 'python', digest: id } };
const manifest = { schemaVersion: 1, images: [spec] };
const contracts = [{ image: spec.image, expectedImageId: id, scenarioIds: ['a'] }];
const makeHost = (current, store = 'containerd') => {
  const state = new Map(current ? [[spec.image, current]] : []), calls = [], mutations = [];
  const run = args => {
    calls.push(args);
    if (args[0] === 'version') return { status: 0, stdout: JSON.stringify({ Os: 'linux', Arch: 'amd64' }) };
    if (args[0] === 'info') return { status: 0, stdout: JSON.stringify(store === 'containerd' ? [['driver-type', 'io.containerd.snapshotter.v1']] : []) };
    const value = state.get(args[2]);
    return value ? { status: 0, stdout: JSON.stringify([{ Id: value, Os: 'linux', Architecture: 'amd64' }]) }
      : { status: 1, stderr: 'No such image' };
  };
  const command = async args => {
    mutations.push(args);
    if (args[0] === 'pull') state.set(args[1], id);
    if (args[1] === 'tag') state.set(args[3], state.get(args[2]));
    if (args[1] === 'load') state.set(spec.image, id);
  };
  return { run, command, state, calls, mutations, log: () => {} };
};

test('ready images and dry-run plans perform no downloads or mutations', async () => {
  const ready = makeHost(id);
  assert.equal((await prepareDockerImages({ contracts, manifest }, ready)).ready, true);
  assert.equal(ready.mutations.length, 0);
  const missing = makeHost();
  const plan = await prepareDockerImages({ contracts, manifest, checkOnly: true }, missing);
  assert.equal(plan.entries[0].action, 'pull');
  assert.equal(missing.mutations.length, 0);
});

test('pulls by immutable digest, validates before retagging, and skips on subsequent runs', async () => {
  const host = makeHost('wrong');
  assert.equal((await prepareDockerImages({ contracts, manifest }, host)).ready, true);
  assert.deepEqual(host.mutations, [['pull', `python@${id}`], ['image', 'tag', `python@${id}`, 'python:test']]);
  await prepareDockerImages({ contracts, manifest }, host);
  assert.equal(host.mutations.length, 2);
});

test('classic store, config-versus-index mismatch and unknown frozen versions fail before network actions', async () => {
  for (const host of [makeHost(undefined, 'classic'), makeHost(config)]) {
    await assert.rejects(prepareDockerImages({ contracts, manifest }, host), /IMAGE_STORE_IDENTITY/);
    assert.equal(host.mutations.length, 0);
  }
  const host = makeHost();
  await assert.rejects(prepareDockerImages({ contracts: [{ ...contracts[0], expectedImageId: config }], manifest }, host), /No published source/);
  assert.equal(host.mutations.length, 0);
});

test('wrong pulled content is never tagged as the frozen runtime', async () => {
  const host = makeHost();
  host.command = async args => { host.mutations.push(args); host.state.set(args[1], config); };
  await assert.rejects(prepareDockerImages({ contracts, manifest }, host), /Pulled image/);
  assert.equal(host.mutations.length, 1);
  assert(!host.state.has(spec.image));
});

test('archive failures stop before load; successful loads still require image ID verification', async () => {
  const source = { type: 'archive', asset: 'image.tar', url: 'https://example.invalid/image.tar', sha256: 'c'.repeat(64), bytes: 42 };
  const archiveManifest = { schemaVersion: 1, images: [{ ...spec, source }] };
  const host = makeHost();
  host.archive = async () => { throw new Error('checksum mismatch'); };
  await assert.rejects(prepareDockerImages({ contracts, manifest: archiveManifest }, host), /checksum/);
  assert.equal(host.mutations.length, 0);
  host.archive = async () => '/cache/image.tar';
  assert.equal((await prepareDockerImages({ contracts, manifest: archiveManifest }, host)).ready, true);
  assert.deepEqual(host.mutations, [['image', 'load', '--input', '/cache/image.tar']]);
});

test('selection is exact and malformed manifests are rejected before any commands', () => {
  const bank = [{ id: 'a', dimension: 'one' }, { id: 'b', dimension: 'two' }];
  assert.deepEqual(selectScenarios(bank, { dimensions: ['one'] }), [bank[0]]);
  assert.deepEqual(selectScenarios(bank, { scenarios: ['b'] }), [bank[1]]);
  assert.throws(() => selectScenarios(bank, { scenarios: ['missing'] }), /Unknown scenario/);
  assert.throws(() => selectScenarios(bank, { dimensions: ['missing'] }), /Unknown dimension/);
  assert.throws(() => validateRuntimeManifest({ ...manifest, images: [spec, spec] }), /Invalid runtime/);
  const offline = { daemon: { status: 'unavailable' }, images: [] };
  assert.equal(planPreparation(contracts, offline, manifest, 'unknown').blocked, true);
});

test('downloads are bounded and hashed before cache promotion, and verified cache avoids another fetch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zxbench-runtime-'));
  const body = Buffer.from('verified tar bytes');
  const source = { asset: 'image.tar', url: 'https://example.invalid', bytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex') };
  let downloads = 0;
  const fetchImpl = async () => { downloads++; return new Response(body); };
  try {
    const path = await ensureArchive(source, dir, fetchImpl);
    assert.equal(readFileSync(path).toString(), body.toString());
    await ensureArchive(source, dir, fetchImpl);
    assert.equal(downloads, 1);
    writeFileSync(path, 'corrupt');
    await assert.rejects(ensureArchive(source, dir, async () => new Response('wrong')), /checksum|size/);
    assert.equal(readFileSync(path, 'utf8'), 'corrupt');
    assert.deepEqual(readdirSync(dir), ['image.tar']);
    await ensureArchive(source, dir, fetchImpl);
    assert.equal(downloads, 2);
  } finally { for (const file of readdirSync(dir)) unlinkSync(join(dir, file)); rmdirSync(dir); }
});
