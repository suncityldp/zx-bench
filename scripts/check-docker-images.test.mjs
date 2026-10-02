import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectImageContracts, checkDockerImages } from './check-docker-images.mjs';

const server = { status: 0, stdout: JSON.stringify({ Os: 'linux', Arch: 'amd64' }) };
test('collects implicit defaults, custom images and distinct pins without scanning fixture contents', () => {
  const rows = collectImageContracts([
    { id: 'a', requirements: { executionWorld: { expectedImageId: 'old' }, executionCases: [{}], executionImageId: 'old' } },
    { id: 'b', requirements: { executionShell: { expectedImageId: 'new' } } },
    { id: 'c', requirements: { agentLoop: { backend: 'docker', expectedImageId: 'node-id' } } },
    { id: 'd', requirements: { image: 'custom:local', files: [{ content: 'image: should-not-scan' }] } },
    { id: 'e', requirements: { agentLoop: { backend: 'local' } } },
  ]);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], { image: 'python:3.12-alpine', expectedImageId: 'old', scenarioIds: ['a'] });
  assert.equal(rows[2].image, 'node:22-alpine');
  assert.equal(rows[3].image, 'custom:local');
});
test('unreachable daemon stops before image inspection and distinguishes missing CLI', () => {
  for (const [result, status] of [[{ error: { code: 'ENOENT', message: 'not found' } }, 'cli_missing'], [{ status: 1, stderr: 'permission denied' }, 'unavailable']]) {
    const calls = [];
    const report = checkDockerImages([{ image: 'x', scenarioIds: ['a'] }], args => { calls.push(args); return result; });
    assert.equal(report.ok, false);
    assert.equal(report.daemon.status, status);
    assert.equal(calls.length, 1);
  }
});
test('checks actual image IDs, deduplicates inspect and reports unavailable images', () => {
  const calls = [];
  const report = checkDockerImages([
    { image: 'python:test', expectedImageId: 'old', scenarioIds: ['a'] },
    { image: 'python:test', expectedImageId: 'current', scenarioIds: ['b'] },
    { image: 'custom:local', scenarioIds: ['c'] },
  ], args => {
    calls.push(args);
    if (args[0] === 'version') return server;
    if (args[2] === 'custom:local') return { status: 1, stderr: 'No such image' };
    return { status: 0, stdout: JSON.stringify([{ Id: 'current', Os: 'linux', Architecture: 'amd64' }]) };
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.images.map(image => image.status), ['id_mismatch', 'ready', 'unavailable']);
  assert.equal(calls.length, 3);
  assert(calls.every(args => ['version', 'image'].includes(args[0])));
});
test('rejects Windows container engine and malformed successful inspect responses', () => {
  const report = checkDockerImages([], () => ({ status: 0, stdout: JSON.stringify({ Os: 'windows', Arch: 'amd64' }) }));
  assert.equal(report.ok, false);
  assert.equal(report.daemon.status, 'unsupported_os');
  assert.throws(() => checkDockerImages([{ image: 'x' }], args => args[0] === 'version' ? server : { status: 0, stdout: '[]' }), /no ID/);
});
test('matching Linux image contracts pass', () => {
  const report = checkDockerImages([{ image: 'x', expectedImageId: 'fixed', scenarioIds: ['a'] }], args => args[0] === 'version' ? server :
    { status: 0, stdout: JSON.stringify([{ Id: 'fixed', Os: 'linux', Architecture: 'amd64' }]) });
  assert.equal(report.ok, true);
});
