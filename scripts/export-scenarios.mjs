// ============================================================
// 导出基准题集到 data/scenarios/（开源可复现）
//   - benchmark.json          ：有效题及待复核题（只有 status='valid' 参与评测）
//   - benchmark-retired.json  ：status='retired' 的历史归档题（放 archive/ 子目录，
//                               seed-benchmark.mjs 的 readdirSync 不递归，不会带进评测）
// 为每题生成 scenarioHash（内容哈希，用于版本漂移检测）+ benchmark-meta.json
// 用法: node scripts/export-scenarios.mjs
// 前置: 数据库已就绪（apps/data/zxbench.db，可用 ZXBENCH_DB_PATH 覆盖）
// ============================================================
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { hashScenarioShort } from '../packages/core/dist/contracts/canonicalize.js';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DB_PATH = process.env.ZXBENCH_DB_PATH || path.join(ROOT, 'apps/data/zxbench.db');
const OUT_DIR = process.env.ZXBENCH_EXPORT_DIR || path.join(ROOT, 'data/scenarios');
const ARCHIVE_DIR = path.join(OUT_DIR, 'archive');
const OUT_FILE = path.join(OUT_DIR, 'benchmark.json');
const RETIRED_FILE = path.join(ARCHIVE_DIR, 'benchmark-retired.json');
const META_FILE = path.join(OUT_DIR, 'benchmark-meta.json');
const BENCHMARK_VERSION = '1.3.0';

const JSON_FIELDS = [
  'scoring', 'hiddenTests', 'requirements', 'tags',
  'toolSchema', 'expectedState', 'requiredInvariants',
  'allowedActions', 'forbiddenActions', 'requiredOrder',
];
const SKIP_FIELDS = ['createdAt', 'updatedAt', 'goldVerifiedAt'];

function parseJson(v) {
  if (v == null || v === '') return undefined;
  try { return JSON.parse(v); } catch { return v; }
}

function toScenario(r) {
  const o = {};
  for (const [k, v] of Object.entries(r)) {
    if (SKIP_FIELDS.includes(k)) continue;
    if (JSON_FIELDS.includes(k)) o[k] = parseJson(v);
    else o[k] = v;
  }
  o.scenarioHash = hashScenarioShort(o);
  return o;
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });
db.exec('PRAGMA busy_timeout = 10000');
const rows = db.prepare('SELECT * FROM ScenarioDefinition ORDER BY dimension, id').all();
const valid = rows.filter((r) => (r.status ?? 'valid') === 'valid').map(toScenario);
const retired = rows.filter((r) => r.status === 'retired').map(toScenario);
const current = rows.filter((r) => r.status !== 'retired').map(toScenario);
const reviewCount = current.length - valid.length;

const byDim = {};
for (const s of valid) byDim[s.dimension] = (byDim[s.dimension] || 0) + 1;
const retiredByDim = {};
for (const s of retired) retiredByDim[s.dimension] = (retiredByDim[s.dimension] || 0) + 1;

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(ARCHIVE_DIR, { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(current, null, 1));
writeFileSync(RETIRED_FILE, JSON.stringify(retired, null, 1));
writeFileSync(META_FILE, JSON.stringify({
  version: BENCHMARK_VERSION,
  count: valid.length,
  validCount: valid.length,
  ambiguousCount: rows.filter((r) => r.status === 'ambiguous').length,
  reviewCount,
  retiredCount: retired.length,
  totalCount: current.length + retired.length,
  dimensions: byDim,
  retiredDimensions: retiredByDim,
  generatedAt: new Date().toISOString(),
}, null, 1));

console.log(`已导出 valid ${valid.length} 题 + 待复核 ${reviewCount} 题 -> ${OUT_FILE}`);
console.log(`已归档 retired ${retired.length} 题 -> ${RETIRED_FILE}`);
console.log(`题库累计 ${current.length + retired.length} 题；版本: ${BENCHMARK_VERSION}`);
for (const [d, n] of Object.entries(byDim)) console.log(`  ${d}: ${n}`);
db.close();
