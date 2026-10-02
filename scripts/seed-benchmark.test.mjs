import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedBenchmark } from './seed-benchmark.mjs';

const log = { log() {}, error() {} };
const scenario = { id: 'CLI-CN-002-DOCKER', status: 'valid', scenarioHash: 'frozen', requirements: { executionImageId: 'fixed' } };
const response = (body, ok = true) => ({ ok, status: ok ? 200 : 500, async json() { return body; } });
test('default import preserves unrelated definitions and sends frozen image/hash unchanged', async () => {
  const calls = [];
  const stored = [{ id: 'custom-question', status: 'valid', scenarioHash: 'custom' }];
  const result = await seedBenchmark({ scenarios: [scenario], base: 'http://test/', log,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (options?.method === 'POST') { const body = JSON.parse(options.body); assert.deepEqual(body, scenario); stored.push(body); return response({ success: true }); }
      return response({ success: true, data: stored });
    } });
  assert.deepEqual(result, { ok: 1, fail: 0, missing: [], drifted: [] });
  assert.deepEqual(calls.map(call => call.options?.method ?? 'GET'), ['POST', 'GET']);
  assert.equal(stored[0].id, 'custom-question');
  assert.equal(calls[0].url, 'http://test/api/scenarios');
});
test('verification detects missing Docker migration definitions despite successful POSTs', async () => {
  const result = await seedBenchmark({ scenarios: [scenario], base: 'http://test', log,
    fetchImpl: async (_url, options) => response(options?.method === 'POST' ? { success: true } : { success: true, data: [] }) });
  assert.deepEqual(result.missing, [scenario.id]);
});
test('verification detects stale hashes and retired definitions', async () => {
  const result = await seedBenchmark({ scenarios: [scenario], base: 'http://test', log,
    fetchImpl: async (_url, options) => response(options?.method === 'POST' ? { success: true } :
      { success: true, data: [{ ...scenario, scenarioHash: 'old', status: 'retired' }] }) });
  assert.deepEqual(result.missing, [scenario.id]);
  assert.deepEqual(result.drifted, [scenario.id]);
});
test('HTTP failures count as failures even if body reports success', async () => {
  const result = await seedBenchmark({ scenarios: [scenario], base: 'http://test', log,
    fetchImpl: async (_url, options) => options?.method === 'POST' ? response({ success: true }, false) : response({ success: true, data: [] }) });
  assert.equal(result.fail, 1);
});
test('failed verification response cannot report completion', async () => {
  await assert.rejects(seedBenchmark({ scenarios: [scenario], base: 'http://test', log,
    fetchImpl: async (_url, options) => response(options?.method === 'POST' ? { success: true } : { success: false, error: 'database offline' }) }), /database offline/);
});

test('read-only check reports missing definitions without mutation', async () => {
  const methods = [];
  const result = await seedBenchmark({ scenarios: [scenario], base: 'http://test', checkOnly: true, log,
    fetchImpl: async (_url, options) => { methods.push(options?.method ?? 'GET'); return response({ success:true, data:[] }); } });
  assert.deepEqual(methods, ['GET']);
  assert.deepEqual(result.missing, [scenario.id]);
  await assert.rejects(seedBenchmark({ scenarios: [scenario], base:'http://test', checkOnly:true, reset:true, log }), /cannot be combined/);
});

test('full released bank repairs the 306 missing migration instances without deleting old definitions', async () => {
  const { readFileSync } = await import('node:fs');
  const bank = JSON.parse(readFileSync(new URL('../data/scenarios/benchmark.json', import.meta.url), 'utf8'));
  const stored = new Map(bank.filter(s => !s.benchmarkSource).map(s => [s.id,s]));
  stored.set('custom-question', { id:'custom-question', status:'valid', scenarioHash:'custom' });
  const result = await seedBenchmark({ scenarios: bank, base:'http://test', log,
    fetchImpl: async (_url, options) => {
      assert.notEqual(options?.method, 'DELETE');
      if (options?.method === 'POST') { const row = JSON.parse(options.body); stored.set(row.id, row); }
      return response({ success:true, data:[...stored.values()] });
    } });
  assert.equal(result.ok, 920);
  assert.equal(result.fail, 0);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.drifted, []);
  assert.equal(stored.get('custom-question').scenarioHash, 'custom');
});
