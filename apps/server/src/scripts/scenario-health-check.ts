/**
 * 题集体检脚本（只读诊断，不写库）
 * ============================================================
 * 与 audit-config-gaps.ts 的分工：
 *   - audit-config-gaps.ts = 「补全型」：为缺失配置生成草稿并可写库
 *   - scenario-health-check.ts = 「诊断型」：全维度扫描题库健康度，输出分级问题报告
 *
 * 检查项（15 项）：
 *  [P0] C1  评分器未注册/无法解析（会导致 fallback 50 分事故）
 *  [P0] C2  评分器版本漂移（DB graderVersion ≠ 已注册版本，靠模糊匹配兜底）
 *  [P0] C3  instruction_following 使用未实现的 constraint 类型（恒 FAIL）
 *  [P0] C4  编程题有 hiddenTests 但语言不可沙箱执行（测试资产浪费 + 评分降级）
 *  [P1] C5  instruction_following 约束配置不完整（缺 patterns/check）
 *  [P1] C6  agent/tool_cli 缺期望轨迹配置（确定性轴 unmeasured）
 *  [P1] C7  hallucination 可答题缺标准答案/关键词
 *  [P1] C8  hallucination 答案匹配脆弱（短数字/单字符 referenceAnswer 子串误判）
 *  [P1] C9  PREMISE_FALSE 题缺纠正关键词锚点（高频词误判风险）
 *  [P1] C10 维度难度梯度断裂（缺 easy 或 medium 档）
 *  [P2] C11 重复/高度相似题目（prompt 归一化后完全相同）
 *  [P2] C12 prompt 长度异常（过短 <15 或超长 >4000 字符）
 *  [P2] C13 元数据缺失（scenarioHash 空 / status 非 valid / requirements 解析失败）
 *  [P2] C14 维度题量 vs 权重失衡提示
 *  [P2] C15 fix/no_bug 陷阱题配比 + 陷阱题缺 expectedVerdict（fix 题不需要该字段）
 *
 * 用法:
 *   npx tsx src/scripts/scenario-health-check.ts              # 控制台报告 + scenario-health.json
 *   npx tsx src/scripts/scenario-health-check.ts --json-only  # 只写 JSON 不打印明细
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ===== 手动加载 apps/server/.env（DATABASE_URL） =====
function loadEnv() {
  const envPath = join(process.cwd(), '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnv();

const prisma = new PrismaClient();
const OUTPUT_FILE = join(process.cwd(), 'scenario-health.json');
const jsonOnly = process.argv.includes('--json-only');

// ============================================================
// 基准配置（与代码保持同步 — 修改时注意副本）
// ============================================================

/** 已注册评分器（来自 packages/core/src/evaluators/*，含 aliases）
 *  注意：与 server/index.ts registerEvaluator() 列表一致 */
const REGISTERED_EVALUATORS: Array<{ name: string; version: string; aliases?: string[] }> = [
  { name: 'bug_finding', version: '3.0.0' },
  { name: 'code_repair', version: '3.2.0', aliases: ['3.1.0', '3.0.0', 'code_repair_v3'] },
  { name: 'schema_compliance', version: 'schema_compliance_v2', aliases: ['structured_output_v2'] },
  { name: 'json_atomic_fields', version: 'json_atomic_v2' },
  { name: 'exact_answer_line', version: 'exact_answer_v2' },
  { name: 'instruction_checklist', version: 'instruction_checklist_v4', aliases: ['instruction_checklist_v3'] },
  { name: 'canary_authority', version: 'canary_authority_v3' },
  { name: 'tool_call_trace', version: 'tool_trace_v4', aliases: ['tool_trace_v3'] },
  { name: 'agent_trace', version: 'agent_trace_v5' },
  { name: 'cli_command', version: 'cli_command_v1' },
  { name: 'hallucination_resistance', version: 'hallucination_v3', aliases: ['hallucination_v2', 'hallucination_v1'] },
];

/** instructionChecklist.ts 已实现的 constraint 类型 */
const IMPLEMENTED_CONSTRAINT_TYPES = new Set([
  'exact_count', 'paragraph_count', 'sentence_count', 'inclusion',
  'exclusion', 'english_free', 'length', 'format', 'exact_order',
  'exact_word', 'conflict_resolution', 'numeric_column', 'numeric_sequence',
  'line_structure', 'json_valid',
]);

/** codeRepair.ts 可沙箱执行的语言（python 需解释器可用） */
const EXECUTABLE_LANGS = new Set(['javascript', 'typescript', 'python', 'py']);
/** codeRepair.ts 可编译检查的语言 */
const COMPILE_CHECK_LANGS = new Set(['python', 'py', 'java', 'go', 'golang', 'rust', 'rs', 'c', 'cpp', 'c++']);

/** 维度总分权重（副本：routes/index.ts + scripts/recalc-scores.ts） */
const DIMENSION_WEIGHTS: Record<string, number> = {
  program: 0.20, reasoning_math: 0.12, hallucination_resistance: 0.12,
  instruction_following: 0.12, safety_authority: 0.10, agent_workflow: 0.08,
  tool_cli_workflow: 0.07, data_extraction: 0.07, cli_deep_tasks: 0.07,
  structured_output: 0.05,
};

const ALL_DIMENSIONS = Object.keys(DIMENSION_WEIGHTS);

// ============================================================
// 报告结构
// ============================================================
type Severity = 'P0' | 'P1' | 'P2';

interface Issue {
  check: string;        // C1..C15
  severity: Severity;
  scenarioId?: string;
  dimension?: string;
  detail: string;
}

const issues: Issue[] = [];
function addIssue(check: string, severity: Severity, detail: string, scenarioId?: string, dimension?: string) {
  issues.push({ check, severity, scenarioId, dimension, detail });
}

// ===== 评分器解析（模拟 getEvaluator 的查找逻辑） =====
function resolveEvaluator(grader: string, graderVersion?: string): { status: 'exact' | 'fuzzy' | 'missing'; matched?: string } {
  // 1. 精确匹配 name@version
  for (const ev of REGISTERED_EVALUATORS) {
    const keys = [ev.name, ...(ev.aliases || [])];
    if (graderVersion && keys.includes(grader) && ev.version === graderVersion) {
      return { status: 'exact', matched: `${ev.name}@${ev.version}` };
    }
  }
  // 2. 别名/名称匹配（忽略版本）→ fuzzy
  for (const ev of REGISTERED_EVALUATORS) {
    const keys = [ev.name, ...(ev.aliases || [])];
    if (keys.includes(grader) || keys.some((k) => k.startsWith(grader + '_'))) {
      return { status: 'fuzzy', matched: `${ev.name}@${ev.version}` };
    }
  }
  return { status: 'missing' };
}

// ===== prompt 归一化（用于重复检测） =====
function normalizePrompt(p: string): string {
  // 保留代码块内容（早期版本把 ``` 块替换为 [CODE]，导致同模板不同代码的题被误判为重复）
  return p.replace(/\s+/g, ' ').trim().toLowerCase();
}

interface Row {
  id: string; dimension: string; difficulty: string; language: string; status: string;
  grader: string; graderVersion: string; promptTemplate: string | null;
  sourceCode: string | null; expectedVerdict: string | null;
  requirements: string | null; hiddenTests: string | null; scenarioHash: string;
}

async function main() {
  const rows = await prisma.scenarioDefinition.findMany({
    select: {
      id: true, dimension: true, difficulty: true, language: true, status: true,
      grader: true, graderVersion: true, promptTemplate: true, sourceCode: true,
      expectedVerdict: true, requirements: true, hiddenTests: true, scenarioHash: true,
    },
  }) as Row[];

  console.log(`加载题库: ${rows.length} 题\n`);

  // ===== C1/C2: 评分器注册与版本 =====
  const versionDrift = new Map<string, number>();
  for (const r of rows) {
    const res = resolveEvaluator(r.grader, r.graderVersion);
    if (res.status === 'missing') {
      addIssue('C1', 'P0', `grader=${r.grader}@${r.graderVersion} 无匹配评分器 → 运行时 fallback 50 分`, r.id, r.dimension);
    } else if (res.status === 'fuzzy') {
      const key = `${r.grader}@${r.graderVersion} → ${res.matched}`;
      versionDrift.set(key, (versionDrift.get(key) || 0) + 1);
    }
  }
  for (const [key, cnt] of versionDrift) {
    addIssue('C2', 'P0', `版本漂移（靠模糊匹配兜底）: ${key} × ${cnt} 题`);
  }

  // ===== 逐题检查 =====
  const dimCounts = new Map<string, number>();
  const dimDiff = new Map<string, Record<string, number>>();
  const promptNormIndex = new Map<string, string[]>();

  for (const r of rows) {
    dimCounts.set(r.dimension, (dimCounts.get(r.dimension) || 0) + 1);
    const dd = dimDiff.get(r.dimension) || {};
    dd[r.difficulty] = (dd[r.difficulty] || 0) + 1;
    dimDiff.set(r.dimension, dd);

    // 解析 requirements
    let req: Record<string, unknown> | unknown[] | null = null;
    let reqParseError = false;
    if (r.requirements) {
      try { req = JSON.parse(r.requirements); } catch { reqParseError = true; }
    }

    // C13: 元数据
    if (reqParseError) addIssue('C13', 'P2', 'requirements JSON 解析失败', r.id, r.dimension);
    if (!r.scenarioHash) addIssue('C13', 'P2', 'scenarioHash 为空（反污染/版本校验失效）', r.id, r.dimension);
    if (r.status !== 'valid') addIssue('C13', 'P2', `status=${r.status}（非 valid，评测时会被过滤）`, r.id, r.dimension);

    // C11: 重复题检测（收集索引）
    if (r.promptTemplate) {
      const norm = normalizePrompt(r.promptTemplate);
      const bucket = promptNormIndex.get(norm) || [];
      bucket.push(r.id);
      promptNormIndex.set(norm, bucket);
    }

    // C12: prompt 长度（hallucination_resistance 为短事实题，设计上允许极短 prompt）
    const plen = r.promptTemplate?.length ?? 0;
    if (plen > 0 && plen < 15 && r.dimension !== 'hallucination_resistance') {
      addIssue('C12', 'P2', `prompt 过短（${plen} 字符）`, r.id, r.dimension);
    }
    if (plen > 4000) addIssue('C12', 'P2', `prompt 超长（${plen} 字符，注意上下文预算）`, r.id, r.dimension);

    // ===== 维度专属检查 =====
    const reqObj = (Array.isArray(req) ? null : req) as Record<string, unknown> | null;

    // C3/C5: instruction_following
    if (r.dimension === 'instruction_following' && reqObj) {
      const cons = Array.isArray(reqObj.constraints) ? reqObj.constraints as Array<Record<string, unknown>> : [];
      if (cons.length === 0) {
        addIssue('C5', 'P1', '无 constraints 配置（确定性轴 unmeasured，靠 Judge/打折）', r.id, r.dimension);
      }
      for (const c of cons) {
        const type = String(c.type || '');
        if (!IMPLEMENTED_CONSTRAINT_TYPES.has(type)) {
          addIssue('C3', 'P0', `未实现的 constraint 类型 "${type}"（评分器 default 分支恒 FAIL）`, r.id, r.dimension);
        }
        // C5: 配置完整性
        if (type === 'inclusion' || type === 'exclusion') {
          const patterns = (c.check as Record<string, unknown>)?.patterns;
          if (!Array.isArray(patterns) || patterns.length === 0) {
            addIssue('C5', 'P1', `constraint ${c.id}:${type} 缺 patterns`, r.id, r.dimension);
          }
        }
        if (type === 'exact_order') {
          const check = (c.check || {}) as Record<string, unknown>;
          const hasBA = (check.before || check.first) && (check.after || check.second);
          const hasPats = Array.isArray(check.patterns) && check.patterns.length >= 2;
          if (!hasBA && !hasPats) addIssue('C5', 'P1', `constraint ${c.id}:exact_order 配置不完整（缺 before/after）`, r.id, r.dimension);
        }
        if (type === 'exact_count') {
          const check = (c.check || {}) as Record<string, unknown>;
          if (!check.target) addIssue('C5', 'P1', `constraint ${c.id}:exact_count 缺 target（会被跳过）`, r.id, r.dimension);
        }
        if (type === 'length') {
          const check = (c.check || {}) as Record<string, unknown>;
          if (check.minLength == null && check.maxLength == null && check.min == null && check.max == null) {
            addIssue('C5', 'P1', `constraint ${c.id}:length 缺长度边界（min/max/minLength/maxLength 均无，约束失效）`, r.id, r.dimension);
          }
        }
        if (type === 'exact_word') {
          const check = (c.check || {}) as Record<string, unknown>;
          if (!check.word) addIssue('C5', 'P1', `constraint ${c.id}:exact_word 缺 word 字段`, r.id, r.dimension);
        }
        if (type === 'conflict_resolution') {
          const check = (c.check || {}) as Record<string, unknown>;
          if (!Array.isArray(check.patterns) || check.patterns.length === 0) {
            addIssue('C5', 'P1', `constraint ${c.id}:conflict_resolution 缺 patterns`, r.id, r.dimension);
          }
        }
      }
    }

    // C4: program 沙箱可执行性
    if (r.dimension === 'program') {
      const lang = (r.language || '').toLowerCase();
      let testCount = 0;
      try { testCount = JSON.parse(r.hiddenTests || '[]').length; } catch { /* ignore */ }
      const executable = EXECUTABLE_LANGS.has(lang);
      const compilable = COMPILE_CHECK_LANGS.has(lang);
      if (!executable && testCount > 0) {
        // 环境限制项：可编译语言有 compileCheck + AI Judge 升级兜底（设计内降级）；纯静态语言仅弱证据。
        // 修复途径为安装对应工具链/容器化执行环境，记 P2 advisory 而非数据缺陷
        addIssue('C4', 'P2',
          `${lang} 题配置了 ${testCount} 个 hiddenTests 但本机无法沙箱执行（仅 ${compilable ? '编译检查' : '纯静态'}），test_pass 依赖 Judge 兜底；建议安装对应工具链`,
          r.id, r.dimension);
      }
      if (executable && testCount === 0) {
        addIssue('C4', 'P1', '可执行语言但无 hiddenTests（test_pass unmeasured）', r.id, r.dimension);
      }
      if (!executable && !compilable && lang !== 'sql' && lang !== 'markdown') {
        addIssue('C4', 'P2', `语言 ${lang} 既不可执行也不可编译检查（只剩 static_signals 弱证据）；建议接入对应运行时`, r.id, r.dimension);
      }
      // C15: 陷阱题必须显式标注 no_bug（fix 题走默认修复分支，无需该字段）
      const isTrap = reqObj?.isCorrectCodeTrap === true;
      if (isTrap && r.expectedVerdict !== 'no_bug') {
        addIssue('C15', 'P1', '标记为正确代码陷阱题（isCorrectCodeTrap）但 expectedVerdict ≠ no_bug（会走修复分支误判）', r.id, r.dimension);
      }
    }

    // C6: agent/tool_cli 期望轨迹（字段清单与 tool_trace_v4 / agent_trace_v5 消费的字段对齐）
    if ((r.dimension === 'agent_workflow' || r.dimension === 'tool_cli_workflow') && reqObj) {
      const hasAgentTrace = Array.isArray(reqObj.expectedActions) && reqObj.expectedActions.length > 0;
      const hasToolTrace = typeof reqObj.tool === 'string' && reqObj.tool.length > 0;
      // tool_trace_v4 确定性轴消费的语义字段
      const v4Semantic = [
        'commands', 'should_call', 'should_call_first', 'should_not_call',
        'should_not_directly', 'should_not_call_any', 'minimal_calls', 'require_patterns',
      ];
      const hasSemantic = v4Semantic.some((k) => {
        const v = reqObj[k];
        return Array.isArray(v) ? v.length > 0 : v !== undefined;
      });
      if (!hasAgentTrace && !hasToolTrace && !hasSemantic) {
        addIssue('C6', 'P1', '无期望轨迹/语义配置（确定性轴全部 unmeasured）', r.id, r.dimension);
      }
    }

    // C7/C8/C9: hallucination_resistance
    if (r.dimension === 'hallucination_resistance' && reqObj) {
      const ab = String(reqObj.answerability || '(未标注)');
      if (!reqObj.answerability) addIssue('C7', 'P1', '缺 answerability 标注（默认按 ANSWERABLE 处理）', r.id, r.dimension);
      if (ab === 'ANSWERABLE' || ab === 'PARTIALLY_ANSWERABLE') {
        const ref = reqObj.referenceAnswer;
        const kws = Array.isArray(reqObj.answerKeywords) ? reqObj.answerKeywords as unknown[] : [];
        if (ref == null && kws.length === 0) {
          addIssue('C7', 'P1', `${ab} 题无 referenceAnswer/answerKeywords（模型必判 hallucination）`, r.id, r.dimension);
        }
        // C8: 脆弱匹配
        if (typeof ref === 'number' && String(ref).length <= 2) {
          addIssue('C8', 'P1', `数值答案 "${ref}" 过短，includes 子串匹配假阳性高（如任何含该数字的输出都算对）`, r.id, r.dimension);
        }
        if (typeof ref === 'string' && ref.length <= 2 && kws.length === 0) {
          addIssue('C8', 'P1', `字符串答案 "${ref}" 过短，子串匹配假阳性高`, r.id, r.dimension);
        }
        for (const k of kws) {
          if (typeof k === 'string' && k.length <= 1) {
            addIssue('C8', 'P1', `answerKeywords 含单字符 "${k}"，匹配无区分度`, r.id, r.dimension);
          }
        }
      }
      if (ab === 'PREMISE_FALSE' && !Array.isArray(reqObj.correctionKeywords)) {
        addIssue('C9', 'P1', 'PREMISE_FALSE 题无 correctionKeywords 锚点（依赖"并非/没有"等高频词检测，假阳性风险）', r.id, r.dimension);
      }
    }

    // reasoning_math / data_extraction 答案配置抽查
    if (r.dimension === 'reasoning_math' && reqObj && reqObj.answer == null) {
      addIssue('C5', 'P1', 'reasoning_math 题缺 requirements.answer（精确匹配失效）', r.id, r.dimension);
    }
  }

  // ===== C11: 汇总重复题 =====
  for (const [norm, ids] of promptNormIndex) {
    if (ids.length > 1) {
      addIssue('C11', 'P2', `发现 ${ids.length} 道 prompt 完全相同的题: ${ids.join(', ')}${norm.length < 60 ? ` — "${norm.slice(0, 50)}"` : ''}`);
    }
  }

  // ===== C10: 难度梯度 =====
  for (const dim of ALL_DIMENSIONS) {
    const dd = dimDiff.get(dim) || {};
    const total = dimCounts.get(dim) || 0;
    if (total === 0) { addIssue('C10', 'P1', `维度 ${dim} 无任何题目`, undefined, dim); continue; }
    const easy = dd.easy || 0, medium = dd.medium || 0;
    if (easy === 0) addIssue('C10', 'P1', `${dim} 无 easy 题（弱模型基础能力无法区分）— 分布: ${JSON.stringify(dd)}`, undefined, dim);
    if (medium === 0) addIssue('C10', 'P1', `${dim} 无 medium 题 — 分布: ${JSON.stringify(dd)}`, undefined, dim);
    const advRatio = (dd.adversarial || 0) / total;
    if (advRatio > 0.4) addIssue('C10', 'P2', `${dim} adversarial 占比 ${(advRatio * 100).toFixed(0)}% 偏高（难度加权后分数方差大）`, undefined, dim);
  }

  // ===== C14: 题量 vs 权重失衡 =====
  const totalAll = rows.length;
  for (const dim of ALL_DIMENSIONS) {
    const cnt = dimCounts.get(dim) || 0;
    const w = DIMENSION_WEIGHTS[dim];
    const cntShare = cnt / totalAll;
    // 权重份额远大于题量份额 → 单题影响力过大；反之 → 题量投入浪费
    if (w > cntShare * 2.5) addIssue('C14', 'P2', `${dim}: 权重 ${(w * 100).toFixed(0)}% 但题量仅 ${cnt} 题（${(cntShare * 100).toFixed(1)}%），单题影响力过大`, undefined, dim);
    if (cntShare > w * 2.5 && w > 0) addIssue('C14', 'P2', `${dim}: 题量 ${cnt} 题（${(cntShare * 100).toFixed(1)}%）但权重仅 ${(w * 100).toFixed(0)}%，题量投入与权重失衡`, undefined, dim);
  }

  // ===== C15: no_bug 陷阱题配比 =====
  const progRows = rows.filter((r) => r.dimension === 'program');
  const noBug = progRows.filter((r) => r.expectedVerdict === 'no_bug').length;
  if (progRows.length > 0 && noBug / progRows.length < 0.1) {
    addIssue('C15', 'P2', `program no_bug 陷阱题仅 ${noBug}/${progRows.length}（${((noBug / progRows.length) * 100).toFixed(0)}%），建议 ≥15% 防"一律提出修复"策略`);
  }

  // ============================================================
  // 输出报告
  // ============================================================
  const bySeverity: Record<Severity, number> = { P0: 0, P1: 0, P2: 0 };
  const byCheck = new Map<string, number>();
  for (const i of issues) {
    bySeverity[i.severity]++;
    byCheck.set(i.check, (byCheck.get(i.check) || 0) + 1);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    totalScenarios: rows.length,
    summary: {
      bySeverity,
      byCheck: Object.fromEntries([...byCheck.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))),
      dimensionCounts: Object.fromEntries(dimCounts),
    },
    issues,
  };
  writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2), 'utf8');

  if (!jsonOnly) {
    console.log('============================================================');
    console.log(' 题集体检报告');
    console.log('============================================================');
    console.log(`总题数: ${rows.length}   P0: ${bySeverity.P0}   P1: ${bySeverity.P1}   P2: ${bySeverity.P2}\n`);

    const checkTitles: Record<string, string> = {
      C1: '评分器无法解析（fallback 50 分风险）', C2: '评分器版本漂移（模糊匹配兜底）',
      C3: '未实现的 constraint 类型（恒 FAIL）', C4: 'hiddenTests 与沙箱语言不匹配',
      C5: '约束/答案配置不完整', C6: 'agent/tool_cli 缺期望轨迹',
      C7: 'hallucination 缺标准答案', C8: 'hallucination 答案匹配脆弱',
      C9: 'PREMISE_FALSE 缺纠正锚点', C10: '难度梯度断裂',
      C11: '重复题目', C12: 'prompt 长度异常',
      C13: '元数据缺失', C14: '题量 vs 权重失衡',
      C15: 'verdict/陷阱题配比',
    };

    for (const sev of ['P0', 'P1', 'P2'] as Severity[]) {
      const sevIssues = issues.filter((i) => i.severity === sev);
      if (sevIssues.length === 0) continue;
      console.log(`──── ${sev} (${sevIssues.length}) ────`);
      for (const [check, cnt] of [...byCheck.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
        const list = sevIssues.filter((i) => i.check === check);
        if (list.length === 0) continue;
        console.log(`\n[${check}] ${checkTitles[check] || check} × ${list.length}`);
        const MAX_PRINT = 15;
        for (const i of list.slice(0, MAX_PRINT)) {
          console.log(`  ${i.scenarioId ? `• ${i.scenarioId}` : '•'} ${i.detail}`);
        }
        if (list.length > MAX_PRINT) console.log(`  ... 其余 ${list.length - MAX_PRINT} 条见 scenario-health.json`);
      }
      console.log('');
    }
    console.log(`完整报告 → ${OUTPUT_FILE}`);
  } else {
    console.log(`体检完成: P0=${bySeverity.P0} P1=${bySeverity.P1} P2=${bySeverity.P2} → ${OUTPUT_FILE}`);
  }

  // 退出码：存在 P0 时非零（可接入 CI）
  if (bySeverity.P0 > 0) process.exitCode = 2;
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
