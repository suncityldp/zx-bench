import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDeployment } from './check-deployment.mjs';
const scenarios = [{ id: 'a', scenarioHash: 'hash', status: 'valid' }];
const log = { log() {}, error() {} };
const mockFetch = (version = '0.2.11', rows = scenarios) => async (url, options) => {
  assert(!options.method || options.method === 'GET');
  const route = new URL(url).pathname;
  if (route === '/') return new Response('<div id="root"></div><script type="module" src="/assets/app.js"></script>');
  if (route === '/assets/app.js') return new Response('console.log("ready")');
  return Response.json(route === '/api/scenarios' ? { success: true, data: rows } : { status: 'ok', version });
};
test('accepts matching API/frontend/bank with read-only requests', async () => {
  const result = await checkDeployment({ base: 'http://127.0.0.1:3001', version: '0.2.11', scenarios, log, fetchImpl: mockFetch() });
  assert.equal(result.ready, true);
  assert.equal(result.modelRequests, 0);
});
test('rejects an old running process or incomplete database rather than claiming deployment succeeded', async () => {
  const options = { base: 'http://127.0.0.1:3001', version: '0.2.11', scenarios, log };
  await assert.rejects(checkDeployment({ ...options, fetchImpl: mockFetch('0.2.10') }), /version mismatch/);
  await assert.rejects(checkDeployment({ ...options, fetchImpl: mockFetch('0.2.11', []) }), /incomplete/);
});
