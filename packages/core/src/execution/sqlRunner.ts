// ============================================================
// SQL 隐藏测试容器执行（Phase 2 垂直切片）。
// 建表 + 插数 + 跑查询 + 结果集比对。用 node:22-alpine 内置 node:sqlite。
// 评分：查询结果集是否等于期望结果集（JSON 规范化后深度比较）。
// ============================================================

import { runInContainer } from './containerRunner.js';

export interface SqlFixture {
  dialect?: string;
  /** 建表 SQL（多条用分号分隔） */
  schema: string;
  /** 插数 SQL */
  seed: string;
  /** 期望结果集（fix 查询应返回的结果） */
  expectedResult: unknown[];
  /** 执行计划禁用模式（正则）：计划匹配则判 fail（用于 n_plus_one 等性能题，如 'CORRELATED SCALAR SUBQUERY'） */
  forbidPlanPattern?: string;
}

export interface SqlRunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  /** 实际结果集 */
  actual: unknown[];
  passed: boolean;
}

const SQL_IMAGE = 'node:22-alpine';

export function buildSqlHarness(query: string, fixture: SqlFixture): { 'main.mjs': string } {
  const schemaSql = fixture.schema + '\n' + fixture.seed;
  const code = [
    "import { DatabaseSync } from 'node:sqlite';",
    "const db = new DatabaseSync(':memory:');",
    'db.exec(' + JSON.stringify(schemaSql) + ');',
    'const rows = db.prepare(' + JSON.stringify(query) + ').all();',
    'console.log("RESULT:" + JSON.stringify(rows));',
    "const plan = db.prepare('EXPLAIN QUERY PLAN ' + " + JSON.stringify(query) + ').all().map(r => r.detail).join("\\n");',
    'console.log("PLAN:" + JSON.stringify(plan));',
  ].join('\n');
  return { 'main.mjs': code };
}

/** 规范化对象（递归排序 key），用于结果集比较 */
function normalize(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(normalize);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = normalize((v as Record<string, unknown>)[k]);
  return out;
}

export function runSqlInContainer(query: string, fixture: SqlFixture, timeoutMs = 30000): SqlRunResult {
  const harness = buildSqlHarness(query, fixture);
  const res = runInContainer({
    image: SQL_IMAGE,
    command: ['node', 'main.mjs'],
    files: [{ path: 'main.mjs', content: harness['main.mjs'] }],
    timeoutMs,
    memoryMb: 128,
    pidsLimit: 64,
  });

  let actual: unknown[] = [];
  let plan = '';
  let passed = false;
  if (res.exitCode === 0 && !res.timedOut) {
    const rm = res.stdout.match(/RESULT:([^\n]*)/);
    const pm = res.stdout.match(/PLAN:"(.*)"/);
    try { actual = rm ? JSON.parse(rm[1]) : []; } catch { actual = []; }
    plan = pm ? pm[1] : '';
    const resultOk = JSON.stringify(normalize(actual)) === JSON.stringify(normalize(fixture.expectedResult));
    const planOk = !fixture.forbidPlanPattern || !new RegExp(fixture.forbidPlanPattern).test(plan);
    passed = resultOk && planOk;
  }

  return {
    success: res.success,
    stdout: res.stdout,
    stderr: res.stderr,
    exitCode: res.exitCode,
    timedOut: res.timedOut,
    durationMs: res.durationMs,
    actual,
    passed,
  };
}
