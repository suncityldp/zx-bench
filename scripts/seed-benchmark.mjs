// ============================================================
// 一键导入基准题集（valid 题全量，10 大维度）
// 用法: node scripts/seed-benchmark.mjs [--reset]
//   --reset  先清空已有题目再导入
// 前置: 服务已启动（默认 http://localhost:3001，可用 BASE_URL 覆盖）
// ============================================================
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCENARIOS_DIR = path.join(ROOT, 'data/scenarios');
const BASE = process.env.BASE_URL || 'http://localhost:3001';
const RESET = process.argv.includes('--reset');

const files = fs.readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith('.json'));
if (files.length === 0) {
  console.error('data/scenarios 下没有 json 题目文件');
  process.exit(1);
}

// 读取全部题目，按 id 去重（benchmark.json 是全集，cr2-*.json 是历史子集）
const seen = new Set();
const scenarios = [];
for (const f of files) {
  const arr = JSON.parse(fs.readFileSync(path.join(SCENARIOS_DIR, f), 'utf8'));
  let added = 0;
  for (const s of arr) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    scenarios.push(s);
    added++;
  }
  console.log('  读取 ' + f + ': ' + arr.length + ' 题（新增 ' + added + '）');
}
console.log('\n共加载 ' + scenarios.length + ' 道题\n');

if (RESET) {
  const existing = await fetch(BASE + '/api/scenarios').then((r) => r.json());
  const ids = (existing.data || []).map((s) => s.id);
  console.log('--reset: 删除 ' + ids.length + ' 道已有题目');
  for (const id of ids) {
    await fetch(BASE + '/api/scenarios/' + id, { method: 'DELETE' });
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

console.log('\n导入完成：成功 ' + ok + ' / 失败 ' + fail + ' / 总计 ' + scenarios.length);
process.exit(fail > 0 ? 1 : 0);
