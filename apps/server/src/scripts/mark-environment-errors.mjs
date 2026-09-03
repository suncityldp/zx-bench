// ============================================================
// 回溯标记环境/测试基础设施故障（P1 污染修复的存量数据部分）
// 把历史上被误记为「模型失败」的 harness 故障行标记 environmentError=1，
// 聚合层（scoring/routes/recalc）识别后不计入维度均值。
//
// 判定依据：evidence JSON 里包含高置信环境故障模式（与 harnessErrors.ts 同步）。
//   - cannot create directory '/root': permission denied  (Java non-root HOME)
//   - an issue was encountered verifying workloads          (dotnet 无网络)
//   - cannot connect to the docker daemon / error response from daemon
//   - oci runtime ... failed                                (容器运行时)
//   - no space left on device                               (磁盘满)
//   - eacces: permission denied                             (权限)
//   - crates.io/npm/NuGet/PyPI 包仓库网络故障                 (依赖环境)
// 刻意不包含 SQL 语法错误类模式（no such column / syntax error）——那是模型真实失败。
//
// 用法: node apps/server/src/scripts/mark-environment-errors.mjs [--dry-run]
// ============================================================
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = (process.env.ZXBENCH_DB_PATH || 'J:/AI/zxbench-webui/apps/data/zxbench.db');
const DRY_RUN = process.argv.includes('--dry-run');

const PATTERNS = [
  // 注意：容器 locale 可能输出弯引号（‘/root’ U+2018/U+2019），必须兼容
  { re: /cannot create directory\s*['"`\u2018\u2019]?\/root['"`\u2018\u2019]?\s*:\s*permission denied/i, reason: 'container HOME=/root unwritable for non-root user' },
  { re: /an issue was encountered verifying workloads/i, reason: 'dotnet workload verification failed (network disabled)' },
  { re: /cannot connect to the docker daemon/i, reason: 'docker daemon unreachable' },
  { re: /error response from daemon/i, reason: 'docker daemon error' },
  { re: /docker unavailable\s*[—-]\s*container execution skipped/i, reason: 'docker daemon unavailable — container execution skipped' },
  { re: /oci runtime (?:exec|create|start) failed/i, reason: 'OCI runtime failure' },
  { re: /no space left on device/i, reason: 'disk full (container/image)' },
  { re: /eacces:\s*permission denied/i, reason: 'EACCES permission denied' },
];
const PACKAGE_REGISTRY_HOST = /(?:crates\.io|index\.crates\.io|static\.crates\.io|registry\.npmjs\.org|api\.nuget\.org|pypi\.org|files\.pythonhosted\.org)/i;
const PACKAGE_REGISTRY_TRANSPORT_ERROR = /(?:eai_again|enotfound|etimedout|econnrefused|econnreset|could not resolve host|dns|proxy|certificate|tls|ssl|network is unreachable|connection (?:timed out|refused|reset)|failed to (?:download|get|fetch)|unable to load the service index|nu1301)/i;

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 15000');

// 确认列存在（db push 已加；防御性检查）
const cols = db.prepare('PRAGMA table_info(ScenarioResult)').all().map((c) => c.name);
if (!cols.includes('environmentError')) {
  console.error('ScenarioResult 缺少 environmentError 列，请先执行 prisma db push');
  process.exit(1);
}

const rows = db.prepare(
  'SELECT id, evalRunId, scenarioId, dimension, totalScore, evidence, outputMetadata FROM ScenarioResult WHERE environmentError = 0',
).all();
console.log(`扫描 ${rows.length} 行 ScenarioResult…\n`);

const matched = [];
const byRun = new Map();
for (const r of rows) {
  let hit = null;
  const haystack = [r.evidence, r.outputMetadata].join('\n');
  for (const { re, reason } of PATTERNS) {
    if (re.test(haystack)) { hit = reason; break; }
  }
  if (!hit && PACKAGE_REGISTRY_HOST.test(haystack) && PACKAGE_REGISTRY_TRANSPORT_ERROR.test(haystack)) {
    hit = 'package registry network unavailable';
  }
  if (hit) {
    matched.push({ ...r, reason: hit });
    const key = r.evalRunId;
    if (!byRun.has(key)) byRun.set(key, { runId: key, count: 0, dims: new Map(), reasons: new Set() });
    const g = byRun.get(key);
    g.count++;
    g.dims.set(r.dimension, (g.dims.get(r.dimension) || 0) + 1);
    g.reasons.add(hit);
  }
}

console.log(`命中环境故障: ${matched.length} 行\n`);
const total = matched.length;
const updateStmt = db.prepare('UPDATE ScenarioResult SET environmentError = 1 WHERE id = ?');

// 按 run 汇总（展示模型名）
const runs = db.prepare('SELECT id, name FROM EvalRun').all();
const runName = new Map(runs.map((r) => [r.id, r.name]));

for (const [runId, g] of byRun) {
  console.log(`[${runName.get(runId) || runId}] ${g.count} 行环境故障`);
  for (const [dim, c] of g.dims) console.log(`    ${dim}: ${c}`);
  console.log(`    原因: ${[...g.reasons].join(' | ')}`);
  console.log('');
}

if (DRY_RUN) {
  console.log(`[dry-run] 未写入。共 ${total} 行将被标记。`);
} else {
  db.exec('BEGIN');
  try {
    for (const r of matched) updateStmt.run(r.id);
    db.exec('COMMIT');
    console.log(`✅ 已标记 ${total} 行为环境故障（environmentError=1）`);
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('写入失败，已回滚:', e.message);
    process.exit(1);
  }
}

db.close();
