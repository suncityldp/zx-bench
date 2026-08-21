// 全题库契约审计（Phase 1）：读 benchmark.json + CR2 packs，逐题跑契约校验，
// 输出分类统计 + 未消费字段统计 + 不达标题清单。运行: node scripts/validate-scenarios.mjs
import { readFileSync } from 'node:fs';
import { validateScenario, listGraderContracts } from '@zxbench/core';

const BASE = new URL('../../../../data/scenarios/', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:');
const benchmarkPath = BASE + 'benchmark.json';

const scenarios = JSON.parse(readFileSync(benchmarkPath, 'utf8'));
console.log(`题库总量: ${scenarios.length}`);

// 收集 CR2 packs（额外维度）
const cr2Files = ['cr2-c-rust-sql.json', 'cr2-java-go.json', 'cr2-js-ts.json', 'cr2-others.json', 'cr2-python.json'];
const cr2 = [];
for (const f of cr2Files) {
  try { cr2.push(...JSON.parse(readFileSync(BASE + f, 'utf8'))); } catch { /* ignore */ }
}
console.log(`CR2 pack 总量: ${cr2.length}`);

const all = [...scenarios, ...cr2];

const errorCounts = new Map();
const warningCounts = new Map();
const byDimension = new Map();
const unconsumedFields = new Map();
const ineligible = [];
const unregisteredGraders = new Set();

for (const s of all) {
  const report = validateScenario(s);
  if (!byDimension.has(s.dimension)) byDimension.set(s.dimension, { total: 0, eligible: 0, errors: 0, warnings: 0 });
  const d = byDimension.get(s.dimension);
  d.total++;
  d.errors += report.errors.length;
  d.warnings += report.warnings.length;
  if (report.eligible) d.eligible++;

  for (const e of report.errors) errorCounts.set(e.code, (errorCounts.get(e.code) || 0) + 1);
  for (const w of report.warnings) {
    warningCounts.set(w.code, (warningCounts.get(w.code) || 0) + 1);
    if (w.code === 'UNCONSUMED_FIELD' && w.path) {
      const field = w.path.replace('requirements.', '');
      const key = s.dimension + '.' + field;
      unconsumedFields.set(key, (unconsumedFields.get(key) || 0) + 1);
    }
  }
  if (report.errors.length > 0) ineligible.push({ id: s.id, dimension: s.dimension, errors: report.errors.map((e) => e.code) });
  if (report.errors.some((e) => e.code === 'UNREGISTERED_GRADER')) unregisteredGraders.add(s.grader);
}

console.log('\n=== 错误码统计 ===');
for (const [code, n] of [...errorCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${code}: ${n}`);
}
console.log('\n=== 警告码统计 ===');
for (const [code, n] of [...warningCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${code}: ${n}`);
}
console.log('\n=== 按维度 ===');
for (const [dim, d] of [...byDimension.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`  ${dim}: ${d.total} 题, eligible=${d.eligible}, errors=${d.errors}, warnings=${d.warnings}`);
}
console.log('\n=== 未消费字段（声明但 evaluator 未消费，前 30） ===');
for (const [k, n] of [...unconsumedFields.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
  console.log(`  ${k}: ${n}`);
}
console.log('\n=== 未注册 grader ===');
console.log('  ' + [...unregisteredGraders].join(', ') || '(none)');
console.log('\n=== 不达标题（error）: ' + ineligible.length + ' 题 ===');
for (const x of ineligible.slice(0, 40)) {
  console.log(`  ${x.id} [${x.dimension}] ${x.errors.join(', ')}`);
}
if (ineligible.length > 40) console.log(`  ... 共 ${ineligible.length} 题`);

console.log('\n=== 已注册 grader 契约 ===');
for (const c of listGraderContracts()) {
  console.log(`  ${c.grader}@${c.version} [${c.dimension}] consumed=${c.consumedFields.length} declared=${c.declaredFields.length}`);
}
