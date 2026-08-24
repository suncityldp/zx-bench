// ============================================================
// sandbox 评分器 v1 —— 单条 SQL 语句在 PostgreSQL 沙箱中执行并验证。
// 首个场景：CP-L3-SQL-007（wcte_idempotent_dedupe，数据修改 CTE 去重）。
// 轴：compilation(10) test_pass(40) performance(35) scope_discipline(15)。
// 执行：postgres:15 容器内 initdb + pg_ctl 启动 PG，跑校验 harness。
// ============================================================

import type { Scenario, ScenarioResult, OutputMetadata, ModelResponse, AxisEvidence } from '@zxbench/types';
import type { Evaluator } from './index.js';
import { runInContainer } from '../execution/containerRunner.js';

/** sandbox 场景 requirements（CP-L3-SQL-007） */
interface SandboxRequirements {
  prompt?: string;
  category?: string;
  schema?: string;
  scoring?: { type?: string; axes?: { id: string; weight: number; description?: string }[] };
}

/** 从模型输出提取 SQL（优先代码块，否则整段） */
function extractSql(output: string): string {
  const fence = output.match(/```(?:sql|postgresql|plpgsql)?\s*\n([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  return output.trim();
}

/** 去除 SQL 注释（行注释与块注释），供静态约束检查用 */
function stripComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** 单语句判定：去掉末尾分号后，体内不得再有分号 */
function isSingleStatement(sql: string): boolean {
  const s = sql.trim().replace(/;\s*$/, '').trim();
  return !s.includes(';');
}

/** 是否含 DDL（CREATE/ALTER/DROP/TRUNCATE） */
function hasDdl(sql: string): boolean {
  return /\b(CREATE|ALTER|DROP|TRUNCATE)\b/i.test(sql);
}

/** 是否含 PL/pgSQL 特征（DO 块 / FUNCTION / dollar-quote / DECLARE） */
function hasPlpgsql(sql: string): boolean {
  return /\bDO\b|CREATE\s+(OR\s+REPLACE\s+)?FUNCTION|LANGUAGE\s+plpgsql|\$\$|\bDECLARE\b/i.test(sql);
}

/** PostgreSQL 去重校验 harness（CP-L3-SQL-007 专用）。solution.sql 由 grader 注入。 */
const DEDUPE_HARNESS = `#!/usr/bin/env bash
set -uo pipefail
export PGDATA=/tmp/pgdata
initdb -D "$PGDATA" -U postgres --auth=trust >/dev/null 2>&1 || { echo "INITDB_FAIL"; exit 1; }
pg_ctl -D "$PGDATA" -w -o '-p 5432 -c listen_addresses=127.0.0.1' start >/dev/null 2>&1 || { echo "PGSTART_FAIL"; exit 1; }
P="postgresql://postgres@127.0.0.1:5432/postgres"
q() { psql "$P" -v ON_ERROR_STOP=1 -qAt "$@"; }
SOL=/workspace/solution.sql
q -c "CREATE TABLE ingest_events (id BIGSERIAL PRIMARY KEY, event_uid TEXT NOT NULL, source TEXT, payload TEXT, created_at TIMESTAMPTZ);"
q -c "CREATE INDEX ie_uid ON ingest_events(event_uid);"
q -c "CREATE TABLE event_links (link_id BIGSERIAL PRIMARY KEY, event_id BIGINT NOT NULL, ref TEXT NOT NULL);"
q -c "CREATE INDEX el_eid ON event_links(event_id);"
reset() { q -c "TRUNCATE ingest_events, event_links RESTART IDENTITY;"; }
run_sol() { psql "$P" -v ON_ERROR_STOP=1 -qAt -f "$SOL" 2>/tmp/sol.err; }
snap() { echo "EV=[$(q -c "SELECT string_agg(id||':'||event_uid||':'||coalesce(payload,'-'), '|' ORDER BY id) FROM ingest_events")] LK=[$(q -c "SELECT string_agg(link_id||':'||event_id||':'||ref, '|' ORDER BY link_id) FROM event_links")]"; }
reset
if run_sol >/tmp/o 2>&1; then echo "COMPILATION: pass"; else echo "COMPILATION: fail"; tail -2 /tmp/sol.err; exit 0; fi
reset
q -c "INSERT INTO ingest_events(id,event_uid,source,payload) VALUES (1,'A','s1','p1'),(2,'A','s2','p2'),(3,'A','s3','p3'),(4,'B','s4','p4');"
q -c "INSERT INTO event_links(link_id,event_id,ref) VALUES (1,2,'x'),(2,1,'x'),(3,3,'y'),(4,4,'z');"
run_sol >/dev/null 2>&1
ev=$(q -c "SELECT string_agg(id||':'||event_uid,'|' ORDER BY id) FROM ingest_events")
lk=$(q -c "SELECT string_agg(event_id||':'||ref,'|' ORDER BY link_id) FROM event_links")
dangling=$(q -c "SELECT count(*) FROM event_links l LEFT JOIN ingest_events e ON e.id=l.event_id WHERE e.id IS NULL")
if [ "$ev" = "1:A|4:B" ] && [ "$lk" = "1:x|1:y|4:z" ] && [ "$dangling" = "0" ]; then echo "TEST dedupe_remap: pass"; else echo "TEST dedupe_remap: fail ev=$ev lk=$lk dangling=$dangling"; fi
before=$(snap); run_sol >/dev/null 2>&1; after=$(snap)
if [ "$before" = "$after" ]; then echo "TEST idempotency: pass"; else echo "TEST idempotency: fail"; fi
reset
run_sol >/dev/null 2>&1
c_ev=$(q -c "SELECT count(*) FROM ingest_events"); c_lk=$(q -c "SELECT count(*) FROM event_links")
if [ "$c_ev" = "0" ] && [ "$c_lk" = "0" ]; then echo "TEST clean_db: pass"; else echo "TEST clean_db: fail ev=$c_ev lk=$c_lk"; fi
reset
q -c "INSERT INTO ingest_events(id,event_uid,payload) VALUES (1,'X','oldest'),(2,'X','middle'),(3,'X','newest');"
q -c "INSERT INTO event_links(link_id,event_id,ref) VALUES (1,3,'r');"
run_sol >/dev/null 2>&1
sel=$(q -c "SELECT payload FROM ingest_events WHERE event_uid='X'"); lk2=$(q -c "SELECT event_id FROM event_links WHERE link_id=1")
if [ "$sel" = "oldest" ] && [ "$lk2" = "1" ]; then echo "TEST canonical: pass"; else echo "TEST canonical: fail payload=$sel link_event=$lk2"; fi
reset
q -c "INSERT INTO ingest_events(id,event_uid,payload) SELECT g, (g % 70000)::text, 'p'||g FROM generate_series(1, 100000) g;"
q -c "INSERT INTO event_links(event_id,ref) SELECT 1 + (g % 100000), 'ref'||(g % 180000) FROM generate_series(1, 300000) g;"
t0=$(date +%s%N); run_sol >/dev/null 2>&1; t1=$(date +%s%N); ms=$(( (t1 - t0) / 1000000 ))
echo "PERF_MS: $ms"
`;

const DEFAULT_WEIGHTS: Record<string, number> = {
  compilation: 10, test_pass: 40, performance: 35, scope_discipline: 15,
};

export const sandboxEvaluator: Evaluator = {
  name: 'sandbox',
  version: '1.0.0',

  async evaluate(
    scenario: Scenario,
    modelOutput: string,
    _metadata: OutputMetadata,
    _modelResponse?: ModelResponse,
  ): Promise<Partial<ScenarioResult>> {
    const req = (scenario.requirements ?? {}) as SandboxRequirements;
    const evidence: string[] = [];
    const axisScores: Record<string, number> = {};
    const axisEvidence: Record<string, AxisEvidence> = {};

    const sql = extractSql(modelOutput);
    if (!sql) {
      return {
        axisScores: { compilation: 0, test_pass: 0, performance: 0, scope_discipline: 0 },
        axisEvidence: { compilation: 'rule', test_pass: 'unmeasured', performance: 'unmeasured', scope_discipline: 'rule' },
        totalScore: 0, safetyLevel: 'safe',
        evidence: ['未提取到 SQL 语句'],
      };
    }

    // 1. scope_discipline 静态约束
    const stripped = stripComments(sql);
    let scope = 100;
    const scopeNotes: string[] = [];
    if (!isSingleStatement(stripped)) { scope -= 40; scopeNotes.push('非单语句(含内部分号)'); }
    if (hasDdl(stripped)) { scope -= 30; scopeNotes.push('含 DDL'); }
    if (hasPlpgsql(stripped)) { scope -= 30; scopeNotes.push('含 PL/pgSQL'); }
    scope = Math.max(0, scope);
    axisScores.scope_discipline = scope;
    axisEvidence.scope_discipline = 'rule';
    evidence.push('scope_discipline: ' + (scopeNotes.length ? scopeNotes.join(', ') : '单语句/无DDL/无PLpgSQL 合规'));

    // 2. 容器执行（PG 沙箱）
    const res = await runInContainer({
      image: 'postgres:15',
      command: ['bash', '/workspace/harness.sh'],
      files: [
        { path: 'harness.sh', content: DEDUPE_HARNESS },
        { path: 'solution.sql', content: sql },
      ],
      timeoutMs: 180000,
      memoryMb: 1024,
      pidsLimit: 256,
      networkDisabled: false,
      readOnly: false,
      user: 'postgres',
    });

    if (!res.success && res.exitCode !== 0 && !res.stdout.includes('COMPILATION:')) {
      // 容器级失败（镜像/启动异常），无法测
      return {
        axisScores: { ...axisScores, compilation: 0, test_pass: 0, performance: 0 },
        axisEvidence: { compilation: 'unmeasured', test_pass: 'unmeasured', performance: 'unmeasured', scope_discipline: axisEvidence.scope_discipline },
        totalScore: 0, safetyLevel: 'safe',
        evidence: [...evidence, 'sandbox 容器执行失败: ' + (res.stderr || res.stdout).slice(0, 200)],
      };
    }

    const out = res.stdout + '\n' + res.stderr;
    // 3. compilation
    const compiled = /COMPILATION: pass/.test(out);
    axisScores.compilation = compiled ? 100 : 0;
    axisEvidence.compilation = compiled ? 'verified' : 'rule';
    evidence.push(compiled ? 'PostgreSQL 语法正确' : 'PostgreSQL 语法错误');

    // 4. test_pass（4 个功能用例）
    const testNames = ['dedupe_remap', 'idempotency', 'clean_db', 'canonical'];
    let passed = 0;
    for (const t of testNames) {
      const ok = out.includes('TEST ' + t + ': pass');
      if (ok) passed++;
      evidence.push((ok ? 'PASS' : 'FAIL') + ' [' + t + ']');
    }
    axisScores.test_pass = Math.round((passed / testNames.length) * 100);
    axisEvidence.test_pass = 'verified';

    // 5. performance（< 2s）
    const pm = out.match(/PERF_MS: (\d+)/);
    let perf = 0;
    if (pm) {
      const ms = Number(pm[1]);
      perf = ms <= 2000 ? 100 : Math.max(0, Math.round(100 - (ms - 2000) / 20));
      evidence.push('性能: ' + ms + 'ms' + (ms <= 2000 ? ' (<2s 达标)' : ' (>=2s)'));
    } else {
      evidence.push('性能: 未测得（可能执行失败）');
    }
    axisScores.performance = perf;
    axisEvidence.performance = 'verified';

    // 6. 加权总分（scoring.weights 为顶层 ScoringConfig；缺省用默认权重）
    const weights = (scenario.scoring?.weights as Record<string, number> | undefined) ?? DEFAULT_WEIGHTS;
    let total = 0;
    let wsum = 0;
    for (const [k, w] of Object.entries(weights)) {
      total += (axisScores[k] ?? 0) * w;
      wsum += w;
    }
    total = wsum > 0 ? Math.round(total / wsum) : 0;

    return { axisScores, axisEvidence, totalScore: total, safetyLevel: 'safe', evidence };
  },
};
