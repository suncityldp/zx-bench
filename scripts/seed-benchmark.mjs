// Import the released catalogue into the running server. Default: upsert only.
// Usage: node scripts/seed-benchmark.mjs [--check | --reset]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBenchmarkImportScope } from './benchmark-import-scope.mjs';

export async function seedBenchmark({ scenarios, base, reset = false, checkOnly = false, fetchImpl = fetch, log = console }) {
  if (reset && checkOnly) throw new Error('--check cannot be combined with --reset');
  const request = async (route, options) => {
    const response = await fetchImpl(base.replace(/\/$/, '') + route, { ...options, signal: AbortSignal.timeout(30_000) });
    const body = await response.json();
    if (!response.ok || body.success !== true) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  };
  log.log(`读取 benchmark.json：${scenarios.length} 道正式定义`);
  if (reset) {
    const existing = await request('/api/scenarios');
    if (!Array.isArray(existing.data)) throw new Error('题目列表响应不是数组');
    log.log(`--reset: 删除 ${existing.data.length} 道已有题目`);
    for (const scenario of existing.data) await request('/api/scenarios/' + encodeURIComponent(scenario.id), { method: 'DELETE' });
  }
  let ok = 0, fail = 0;
  for (const scenario of checkOnly ? [] : scenarios) {
    try {
      await request('/api/scenarios', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scenario) });
      ok++;
    } catch (error) { fail++; log.error(`  ✗ ${scenario.id}: ${error.message}`); }
  }
  // Verify what the target server actually persisted, not just successful POSTs.
  const stored = await request('/api/scenarios');
  if (!Array.isArray(stored.data)) throw new Error('题目列表响应不是数组');
  const byId = new Map(stored.data.map(scenario => [scenario.id, scenario]));
  const missing = scenarios.filter(scenario => byId.get(scenario.id)?.status !== 'valid').map(scenario => scenario.id);
  const drifted = scenarios.filter(scenario => byId.has(scenario.id) && byId.get(scenario.id).scenarioHash !== scenario.scenarioHash).map(scenario => scenario.id);
  log.log(`${checkOnly ? '只读检查完成' : '导入完成'}：成功 ${ok} / 失败 ${fail} / 正式定义 ${scenarios.length} / 缺失或非有效 ${missing.length} / 哈希不符 ${drifted.length}`);
  if (missing.length) log.error(`缺失或非有效题号：${missing.slice(0, 20).join(', ')}`);
  if (drifted.length) log.error(`哈希不符题号：${drifted.slice(0, 20).join(', ')}`);
  return { ok, fail, missing, drifted };
}

export async function main(args = process.argv.slice(2)) {
  if (args.some(arg => !['--reset', '--check'].includes(arg))) throw new Error('Usage: node scripts/seed-benchmark.mjs [--check | --reset]');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { scenarios } = loadBenchmarkImportScope(path.join(root, 'data/scenarios'));
  const result = await seedBenchmark({ scenarios, base: process.env.BASE_URL || 'http://localhost:3001', reset: args.includes('--reset'), checkOnly: args.includes('--check') });
  return result.fail || result.missing.length || result.drifted.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(`题库导入失败：${error.message}`); process.exitCode = 1; }
}
