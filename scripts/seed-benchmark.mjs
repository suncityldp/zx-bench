// ============================================================
// 一键导入基准题集（valid 题全量，10 大维度）
// 用法: node scripts/seed-benchmark.mjs [--reset]
//   --reset  先清空已有题目再导入
// 前置: 服务已启动（默认 http://localhost:3001，可用 BASE_URL 覆盖）
// ============================================================
import path from 'node:path';
import { loadBenchmarkImportScope } from './benchmark-import-scope.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCENARIOS_DIR = path.join(ROOT, 'data/scenarios');
const BASE = process.env.BASE_URL || 'http://localhost:3001';
const RESET = process.argv.includes('--reset');

// benchmark.json is the only released catalogue. Other JSON arrays in this
// directory are development fixtures or historical subsets and must never be
// imported into the formal database merely because they share the extension.
const { scenarios } = loadBenchmarkImportScope(SCENARIOS_DIR);
console.log(`读取 benchmark.json：${scenarios.length} 道正式定义`);

if (RESET) {
  const existing = await fetch(BASE + '/api/scenarios').then((r) => r.json());
  const ids = (existing.data || []).map((s) => s.id);
  console.log('--reset: 删除 ' + ids.length + ' 道已有题目');
  for (const id of ids) {
    await fetch(BASE + '/api/scenarios/' + id, { method: 'DELETE' });
  }
}

let removed = 0;
if (!RESET) {
  const existing = await fetch(BASE + '/api/scenarios').then((r) => r.json());
  const releasedIds = new Set(scenarios.map(s => s.id));
  const stale = (existing.data || []).filter(s => !releasedIds.has(s.id));
  for (const scenario of stale) {
    const res = await fetch(BASE + '/api/scenarios/' + encodeURIComponent(scenario.id), { method: 'DELETE' });
    const body = await res.json();
    if (!body.success) throw new Error(`删除集合外题目失败 ${scenario.id}: ${body.error}`);
    removed++;
  }
}

let ok = 0, fail = 0;
for (const s of scenarios) {
  try {
    const res = await fetch(BASE + '/api/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s),
    });
    const body = await res.json();
    if (body.success) ok++;
    else { fail++; console.error('  ✗ ' + s.id + ': ' + body.error); }
  } catch (err) {
    fail++;
    console.error('  ✗ ' + s.id + ': ' + err.message);
  }
}

console.log('\n导入完成：成功 ' + ok + ' / 失败 ' + fail + ' / 正式定义 ' + scenarios.length + ' / 删除集合外定义 ' + removed);
process.exit(fail > 0 ? 1 : 0);
