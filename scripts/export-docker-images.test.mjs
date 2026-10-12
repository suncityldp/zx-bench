import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planImageExport, verifyArchiveManifest, verifySavedArchive } from './export-docker-images.mjs';

const config = Buffer.from(JSON.stringify({ os: 'linux', architecture: 'amd64' }));
const id = `sha256:${createHash('sha256').update(config).digest('hex')}`;
const image = { image: 'python:test', actualImageId: id, os: 'linux', architecture: 'amd64' };
const manifest = [{ Config: `${id.slice(7)}.json`, RepoTags: ['python:test'], Layers: [] }];
const configs = new Map([[manifest[0].Config, config]]);
const bank = expectedImageId => Buffer.from(JSON.stringify([
  { id: 'a', requirements: { executionWorld: { image: image.image, expectedImageId } } },
  { id: 'b', requirements: { executionShell: { image: image.image, expectedImageId } } },
]));

test('export preflight rejects drift and never pulls, builds or re-pins', () => {
  const calls = [];
  const run = args => {
    calls.push(args);
    return { status: 0, stdout: JSON.stringify(args[0] === 'version' ? { Os: 'linux', Arch: 'amd64' }
      : [{ Id: id, Os: 'linux', Architecture: 'amd64' }]) };
  };
  assert.throws(() => planImageExport(bank('sha256:old'), run), /preflight failed/);
  const plan = planImageExport(bank(id), run);
  assert.equal(plan.images.length, 1);
  assert.equal(plan.scenarioCount, 2);
  assert.equal(plan.bankSha256, createHash('sha256').update(bank(id)).digest('hex'));
  assert(calls.every(args => ['version', 'image'].includes(args[0]) && args[1] !== 'pull'));
});

test('rejects architecture mismatch and empty image scope before saving', () => {
  const run = args => ({ status: 0, stdout: JSON.stringify(args[0] === 'version' ? { Os: 'linux', Arch: 'amd64' }
    : [{ Id: id, Os: 'linux', Architecture: 'arm64' }]) });
  assert.throws(() => planImageExport(bank(id), run), /architecture/);
  assert.throws(() => planImageExport(Buffer.from('[]'), run), /no explicit/);
});

test('selective export checks only requested contracts and rejects unknown images', () => {
  const bytes = Buffer.from(JSON.stringify([
    { id: 'a', requirements: { executionWorld: { image: image.image, expectedImageId: id } } },
    { id: 'b', requirements: { executionWorld: { image: 'missing:test', expectedImageId: 'old' } } },
  ]));
  const calls = [];
  const run = args => {
    calls.push(args);
    if (args[0] === 'version') return { status: 0, stdout: JSON.stringify({ Os: 'linux', Arch: 'amd64' }) };
    if (args[2] === image.image) return { status: 0, stdout: JSON.stringify([{ Id: id, Os: 'linux', Architecture: 'amd64' }]) };
    return { status: 1, stderr: 'No such image' };
  };
  const plan = planImageExport(bytes, run, [image.image, image.image]);
  assert.equal(plan.scope, 'selected_explicit_question_bank_images');
  assert.equal(plan.images.length, 1);
  assert.equal(plan.scenarioCount, 1);
  assert.equal(calls.length, 2);
  assert.throws(() => planImageExport(bytes, run, ['unknown:test']), /not declared/);
  assert.throws(() => planImageExport(bytes, run), /preflight failed/);
});

test('checks archive tags, config content IDs and platforms independently of current local tags', () => {
  verifyArchiveManifest(manifest, configs, [image]);
  assert.throws(() => verifyArchiveManifest([{ ...manifest[0], RepoTags: ['wrong:test'] }], configs, [image]), /one tag/);
  assert.throws(() => verifyArchiveManifest([...manifest, ...manifest], configs, [image]), /one tag/);
  const changed = Buffer.from(JSON.stringify({ os: 'linux', architecture: 'amd64', config: { Env: ['changed'] } }));
  assert.throws(() => verifyArchiveManifest(manifest, new Map([[manifest[0].Config, changed]]), [image]), /ID mismatch/);
  assert.throws(() => verifyArchiveManifest(manifest, configs, [{ ...image, architecture: 'arm64' }]), /platform/);
});

test('containerd index IDs must prove the tag-to-index-to-platform-config digest chain', () => {
  const entries = new Map(configs);
  const blob = document => {
    const bytes = Buffer.from(JSON.stringify(document));
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    entries.set(`blobs/sha256/${digest.slice(7)}`, bytes);
    return { digest, size: bytes.length };
  };
  const platformManifest = blob({ config: { digest: id, size: config.length }, layers: [] });
  const target = { ...blob({ manifests: [{ ...platformManifest, platform: { os: 'linux', architecture: 'amd64' } }] }),
    mediaType: 'application/vnd.oci.image.index.v1+json',
    annotations: { 'io.containerd.image.name': 'docker.io/library/python:test' } };
  entries.set('index.json', Buffer.from(JSON.stringify({ manifests: [target] })));
  const containerdImage = { ...image, actualImageId: target.digest };
  assert.deepEqual(verifyArchiveManifest(manifest, entries, [containerdImage]), [
    { image: image.image, imageId: target.digest, configDigest: id, idKind: 'oci_index' },
  ]);
  const corrupt = new Map(entries);
  corrupt.set(`blobs/sha256/${platformManifest.digest.slice(7)}`, Buffer.from('{}'));
  assert.throws(() => verifyArchiveManifest(manifest, corrupt, [containerdImage]), /OCI blob mismatch/);
  entries.set('index.json', Buffer.from(JSON.stringify({ manifests: [{ ...target,
    annotations: { 'io.containerd.image.name': 'wrong:test' } }] })));
  assert.throws(() => verifyArchiveManifest(manifest, entries, [containerdImage]), /OCI target mismatch/);
});

function tarEntry(name, bytes) {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
  header[156] = 48;
  header.fill(32, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}

test('verifies saved tar bytes and rejects missing, duplicate or truncated entries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zxbench-export-test-'));
  const path = join(dir, 'images.tar');
  const manifestEntry = tarEntry('manifest.json', Buffer.from(JSON.stringify(manifest)));
  const configEntry = tarEntry(manifest[0].Config, config);
  const bytes = Buffer.concat([configEntry, manifestEntry, Buffer.alloc(1024)]);
  try {
    writeFileSync(path, bytes);
    assert.deepEqual(await verifySavedArchive(path, [image]), {
      bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      identities: [{ image: image.image, imageId: id, configDigest: id, idKind: 'config' }],
    });
    writeFileSync(path, Buffer.concat([configEntry, Buffer.alloc(1024)]));
    await assert.rejects(verifySavedArchive(path, [image]), /no manifest/);
    writeFileSync(path, Buffer.concat([configEntry, manifestEntry, manifestEntry, Buffer.alloc(1024)]));
    await assert.rejects(verifySavedArchive(path, [image]), /Duplicate/);
    writeFileSync(path, bytes.subarray(0, 513));
    await assert.rejects(verifySavedArchive(path, [image]), /Truncated/);
  } finally { unlinkSync(path); rmdirSync(dir); }
});
