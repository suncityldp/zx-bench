// ============================================================
// 验证环境错误隔离的端到端效果（P1 污染修复验收）
// 1) 确认 environmentError 列存在且已标记的行数/分布
// 2) 量化污染：被标记行若不隔离（计入均值）对维度均值的下拉幅度
// 3) 抽查被标记行的证据，确认是 harness 故障而非模型失败
//
// 用法: node apps/server/src/scripts/verify-env-isolation.mjs
// ============================================================
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = (process.env.ZXBENCH_DB_PATH || 'J:/AI/zxbench-webui/apps/data/zxbench.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 15000');

const cols = db.prepare('PRAGMA table_info(ScenarioResult)').all().map((c) => c.name);
if (!cols.includes('environmentError')) {
  console.error('ScenarioResult 缺少 environmentError 列，请先执行 prisma db push');
  process.exit(1);
}

const runs = db.prepare('SELECT id, name FROM EvalRun').all();
const runName = new Map(runs.map((r) => [r.id, r.name]));

const envRows = db.prepare(
  'SELECT id, evalRunId, scenarioId, dimension, totalScore, evidence FROM ScenarioResult WHERE environmentError = 1',
).all();
console.log('===== 1. 已标记环境错误行 =====');
console.log(`总数: ${envRows.length} 行\n`);

const byRun = new Map();
const byDim = new Map();
const scores = [];
for (const r of envRows) {
  if (!byRun.has(r.evalRunId)) byRun.set(r.evalRunId, []);
  byRun.get(r.evalRunId).push(r);
  if (!byDim.has(r.dimension)) byDim.set(r.dimension, []);
  byDim.get(r.dimension).push(r);
  scores.push(r.totalScore);
}
for (const [runId, list] of byRun) {
  console.log(`[${runName.get(runId) || runId}] ${list.length} 行: ${list.map((r) => `${r.scenarioId}(${r.totalScore})`).join(', ')}`);
}
console.log('');
for (const [dim, list] of byDim) {
  const avg = list.reduce((s, r) => s + r.totalScore, 0) / list.length;
  console.log(`  维度 ${dim}: ${list.length} 行，误记分数均值 ${avg.toFixed(1)}`);
}

console.log('\n===== 2. 污染量化：隔离前后维度均值对比 =====');
// 对每个维度：对比（含污染行均值）vs（隔离后均值）
const dimSql = db.prepare(
  'SELECT dimension, COUNT(*) as cnt, AVG(totalScore) as avgScore FROM ScenarioResult WHERE environmentError = 0 GROUP BY dimension',
).all();
const dimAllSql = db.prepare(
  'SELECT dimension, COUNT(*) as cnt, AVG(totalScore) as avgScore FROM ScenarioResult GROUP BY dimension',
).all();
const avgAll = new Map(dimAllSql.map((r) => [r.dimension, r.avgScore]));
const avgClean = new Map(dimSql.map((r) => [r.dimension, r.avgScore]));
const allDims = new Set([...avgAll.keys(), ...avgClean.keys()]);
console.log('维度           | 隔离前均值 | 隔离后均值 | 差值');
for (const dim of allDims) {
  const before = avgAll.get(dim);
  const after = avgClean.get(dim);
  if (before === undefined || after === undefined) continue;
  const diff = after - before;
  console.log(`${dim.padEnd(14)} | ${before.toFixed(2).padStart(8)}  | ${after.toFixed(2).padStart(8)}  | ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}`);
}

console.log('\n===== 3. 抽查被标记行证据（前 3 条） =====');
for (const r of envRows.slice(0, 3)) {
  let ev = '';
  try { ev = JSON.parse(r.evidence || '[]').join(' | '); } catch { ev = (r.evidence || '').slice(0, 200); }
  console.log(`\n[${r.scenarioId}] ${r.dimension} (score=${r.totalScore})`);
  console.log(`  证据: ${ev.slice(0, 300)}`);
}

console.log("\n===== 4. 未被标记的环境故障疑似行（防漏检，evidence 含 '/root'/daemon 但未标记） =====");
const suspectPatterns = [/cannot create directory/i, /verifying workloads/i, /docker daemon/i, /oci runtime/i, /no space left/i, /eacess:/i, /eacces:/i];
const unmarked = db.prepare(
  'SELECT id, evalRunId, scenarioId, dimension, totalScore, evidence, outputMetadata FROM ScenarioResult WHERE environmentError = 0',
).all();
const suspects = [];
for (const r of unmarked) {
  const haystack = [r.evidence, r.outputMetadata].join('\n');
  if (suspectPatterns.some((re) => re.test(haystack))) {
    suspects.push(r);
  }
}
if (suspects.length === 0) {
  console.log('无（已全部标记或证据不含环境故障信号）✓');
} else {
  for (const r of suspects) {
    const hay = [r.evidence, r.outputMetadata].join(' ');
    const line = hay.match(/cannot create directory[^"]{0,120}|verifying workloads[^"]{0,80}|daemon[^"]{0,80}|oci runtime[^"]{0,80}/i);
    console.log(`  [${r.scenarioId}] ${r.dimension} score=${r.totalScore} run=${runName.get(r.evalRunId) || r.evalRunId}`);
    console.log(`    片段: ${line ? line[0] : '(未匹配到可读片段)'}`);
  }
}

db.close();
