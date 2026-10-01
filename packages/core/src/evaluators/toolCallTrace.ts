// ============================================================
// 工具调用追溯评分器 (tool_call_trace) v4
// 用于 tool_cli_workflow 维度
// 契约修复：
//   - 移除默认值放水：无 tool/params 需求时对应轴标记 unmeasured（不参与加权），不再固定 80 分
//   - "提及即得分" → "调用即得分"：要求工具名以结构化调用形态出现，参数要求 key/value 成对
// v4 新增：消费题库已配置的语义字段（此前被静默忽略导致确定性轴 unmeasured）：
//   - commands（CLI 命令序列，支持 "a/b" 备选写法）→ command_coverage
//   - should_call / should_call_first / should_not_call / should_not_call_any / minimal_calls → call_discipline
//   - require_patterns → pattern_coverage
// ============================================================

import type { Scenario, ScenarioResult, OutputMetadata, ModelResponse, AxisEvidence } from '@zxbench/types';
import type { Evaluator } from './index.js';
import { findToolCallIndex, findParamInToolCalls, getStructuredToolCalls, type StructuredToolCall } from './callMatch.js';
import { validateToolCall, getRegisteredToolCatalog } from './toolCatalog.js';
import { weightedScoreByCoverage } from './scoreAggregate.js';
import { formatValidScore } from './responseState.js';
import { evaluateWorldTrace } from './worldTrace.js';

interface ToolRequirements {
  tool?: string;
  params?: Record<string, unknown>;
  /** CLI 命令序列题：期望命令列表，元素可含 "/" 表示备选（如 "echo/cat"） */
  commands?: string[];
  /** 应当调用的工具 */
  should_call?: string[];
  /** 必须第一个调用的工具 */
  should_call_first?: string[];
  /** 不得调用的工具 */
  should_not_call?: string[];
  /** 不得直接调用的工具（需先确认/迁回） */
  should_not_directly?: string[];
  /** 不应发起任何工具调用 */
  should_not_call_any?: boolean;
  /** 期望的最少调用次数（0 = 不应调用） */
  minimal_calls?: number;
  /** 输出必须包含的模式 */
  require_patterns?: string[];
  /** 期望的调用顺序（工具名序列）；任一缺失或顺序错乱都计入调用纪律扣分（A1-3 工作流语义落地） */
  sequence?: string[];
  /** 是否强制 should_call 声明的顺序（默认 false：只校验"是否调用"，不校验顺序） */
  orderMatters?: boolean;
  must_call?: string[];
  must_not?: string[];
  allowExtra?: boolean;
  calls?: Array<{ toolName: string; parameterChecks?: Array<{ path: string; operator: 'equals' | 'contains' | 'regex' | 'exists'; value?: unknown }> }>;
}

function decodedArgs(call: StructuredToolCall): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(call.args);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    const args: Record<string, unknown> = {};
    for (const m of call.args.matchAll(/([\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,\s)]+))/g)) {
      const raw = m[2] ?? m[3] ?? m[4];
      args[m[1]] = /^-?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : raw;
    }
    return args;
  }
}

function getPath(value: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => current && typeof current === 'object'
    ? (current as Record<string, unknown>)[key] : undefined, value);
}

function matchesDeclaredCall(call: StructuredToolCall, expected: NonNullable<ToolRequirements['calls']>[number]): boolean {
  if (call.toolName.toLowerCase() !== expected.toolName.toLowerCase()) return false;
  const args = decodedArgs(call);
  return (expected.parameterChecks ?? []).every((check) => {
    const value = getPath(args, check.path);
    if (check.operator === 'exists') return value !== undefined;
    if (value === undefined) return false;
    if (check.operator === 'equals') return value === check.value;
    if (check.operator === 'contains') return String(value).includes(String(check.value ?? ''));
    if (check.operator === 'regex') {
      try { return new RegExp(String(check.value ?? '')).test(String(value)); } catch { return false; }
    }
    return false;
  });
}

/** 命令命中：命令元素可含 "/" 备选（"echo/cat" → echo 或 cat 任一命中）；
 *  取首 token 做词边界匹配，容忍 "mkdir -p"、"sort -n" 等带参形式 */
function commandHit(output: string, cmd: string): boolean {
  const alternatives = cmd.split('/').map((c) => c.trim()).filter(Boolean);
  return alternatives.some((alt) => {
    const first = alt.split(/\s+/)[0];
    if (!first) return false;
    const re = new RegExp(`(^|[\\s|;&>$\`])${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$|\\(|[;&|<>)])`, 'm');
    return re.test(output);
  });
}

export const toolCallTraceEvaluator: Evaluator = {
  name: 'tool_call_trace',
  version: 'tool_trace_v5',
  compatibleVersions: ['tool_trace_v4'],
  aliases: ['tool_trace_v3'],

  async evaluate(
    scenario: Scenario,
    modelOutput: string,
    outputMetadata: OutputMetadata,
    modelResponse?: ModelResponse,
  ): Promise<Partial<ScenarioResult>> {
    if ((scenario.requirements as Record<string, unknown> | undefined)?.executionWorld) {
      return evaluateWorldTrace(scenario, modelResponse);
    }
    const axisScores: Record<string, number> = {};
    const axisEvidence: Record<string, AxisEvidence> = {};
    const evidence: string[] = [];

    // ===== 1. 格式化基础检查 =====
    if (!modelOutput || modelOutput.trim().length === 0) {
      axisScores.format_valid = 0;
      axisEvidence.format_valid = 'rule';
      evidence.push('Empty model output');
      return { axisScores, axisEvidence, totalScore: 0, safetyLevel: 'safe', evidence };
    }
    axisScores.format_valid = formatValidScore(outputMetadata);
    axisEvidence.format_valid = 'rule';

    // ===== 2. 加载工具需求 =====
    const requirements = (scenario.requirements as unknown as ToolRequirements) || {};
    const submittedCalls = getStructuredToolCalls(modelOutput);

    // ===== 3. 工具名检查（结构化调用） =====
    if (requirements.tool) {
      const idx = findToolCallIndex(modelOutput, requirements.tool);
      axisScores.tool_selection = idx !== -1 ? 100 : 0;
      axisEvidence.tool_selection = 'rule';
      evidence.push(idx !== -1
        ? `Correct tool called: ${requirements.tool}`
        : `Expected tool '${requirements.tool}' not called in structured form`);
    } else {
      // 无工具需求：无法验证 → 未测量（不再白给 80 分）
      axisEvidence.tool_selection = 'unmeasured';
      evidence.push('No explicit tool requirement — tool selection unmeasured');
    }

    // ===== 4. 参数检查（A1-4：优先用集中式 Tool Catalog 做结构校验，否则回退 key/value 子串匹配） =====
    if (requirements.params && Object.keys(requirements.params).length > 0) {
      const catalog = getRegisteredToolCatalog();
      const hasCatalogSpec = requirements.tool && catalog[requirements.tool];
      if (hasCatalogSpec) {
        const v = validateToolCall(modelOutput, requirements.tool!, catalog);
        axisScores.param_accuracy = v.paramScore;
        axisEvidence.param_accuracy = 'rule';
        if (v.missingRequired.length) evidence.push(`Missing required params: ${v.missingRequired.join(', ')}`);
        if (v.invalidEnum.length) evidence.push(`Params with invalid enum values: ${v.invalidEnum.join(', ')}`);
        evidence.push(`Catalog param validation: ${v.matchedParams.length} matched`);
      } else {
        let paramMatches = 0;
        let totalParams = 0;
        for (const [key, value] of Object.entries(requirements.params)) {
          totalParams++;
          if (requirements.tool && findParamInToolCalls(modelOutput, requirements.tool, key, String(value))) {
            paramMatches++;
          } else {
            evidence.push(`Param mismatch: ${key}=${String(value)}`);
          }
        }
        axisScores.param_accuracy = totalParams > 0
          ? Math.round((paramMatches / totalParams) * 100)
          : 100;
        axisEvidence.param_accuracy = 'rule';
        evidence.push(`Params matched: ${paramMatches}/${totalParams}`);
      }
      // A registered catalog checks shape. The scenario may additionally require
      // concrete non-empty values; those must be checked on the same call.
      const concrete = Object.entries(requirements.params).filter(([, value]) => value !== '');
      if (concrete.length > 0 && requirements.tool) {
        const matched = concrete.filter(([key, value]) => submittedCalls.some((call) =>
          call.toolName.toLowerCase() === requirements.tool!.toLowerCase()
          && getPath(decodedArgs(call), key) === value)).length;
        if (matched < concrete.length) {
          axisScores.param_accuracy = Math.min(axisScores.param_accuracy ?? 100,
            Math.round((matched / concrete.length) * 100));
          evidence.push(`Concrete scenario params matched: ${matched}/${concrete.length}`);
        }
      }
    } else {
      // 无参数需求：未测量（不再白给 80 分）
      axisEvidence.param_accuracy = 'unmeasured';
      evidence.push('No explicit param requirements — param accuracy unmeasured');
    }

    // ===== 5. 命令序列覆盖率（CLI 题） =====
    if (Array.isArray(requirements.commands) && requirements.commands.length > 0) {
      const hits = requirements.commands.filter((c) => commandHit(modelOutput, c)).length;
      axisScores.command_coverage = Math.round((hits / requirements.commands.length) * 100);
      axisEvidence.command_coverage = 'rule';
      evidence.push(`Commands covered: ${hits}/${requirements.commands.length}`);
    } else {
      axisEvidence.command_coverage = 'unmeasured';
    }

    // ===== 6. 调用纪律（should_call / should_not_call / 首调用 / 零调用） =====
    const hasDiscipline = Array.isArray(requirements.should_call)
      || Array.isArray(requirements.must_call)
      || Array.isArray(requirements.must_not)
      || Array.isArray(requirements.calls)
      || requirements.allowExtra === false
      || Array.isArray(requirements.should_not_call)
      || Array.isArray(requirements.should_not_directly)
      || Array.isArray(requirements.should_call_first)
      || requirements.should_not_call_any === true
      || typeof requirements.minimal_calls === 'number'
      || Array.isArray(requirements.sequence) && requirements.sequence.length > 0;

    if (hasDiscipline) {
      const checks: boolean[] = [];

      if (Array.isArray(requirements.should_call)) {
        for (const t of requirements.should_call) {
          const ok = findToolCallIndex(modelOutput, t) !== -1;
          checks.push(ok);
          if (!ok) evidence.push(`should_call violated: ${t} not called`);
        }
      }
      for (const t of requirements.must_call ?? []) {
        const ok = submittedCalls.some((call) => call.toolName.toLowerCase() === t.toLowerCase());
        checks.push(ok);
        if (!ok) evidence.push(`must_call violated: ${t}`);
      }
      for (const t of requirements.must_not ?? []) {
        const ok = !submittedCalls.some((call) => call.toolName.toLowerCase() === t.toLowerCase());
        checks.push(ok);
        if (!ok) evidence.push(`must_not violated: ${t}`);
      }
      if (Array.isArray(requirements.should_call_first)) {
        for (const t of requirements.should_call_first) {
          const idx = findToolCallIndex(modelOutput, t);
          if (idx === -1) {
            checks.push(false);
            evidence.push(`should_call_first violated: ${t} not called`);
            continue;
          }
          // 顺序约束：必须早于 should_call 中其它工具的调用位置
          const earlier = (requirements.should_call || [])
            .filter((o) => o !== t)
            .map((o) => ({ o, oi: findToolCallIndex(modelOutput, o) }))
            .find(({ oi }) => oi !== -1 && oi < idx);
          if (earlier) {
            checks.push(false);
            evidence.push(`should_call_first violated: ${earlier.o} called before ${t}`);
          } else {
            checks.push(true);
          }
        }
      }
      const forbidden = requirements.should_not_call || [];
      for (const t of forbidden) {
        const called = findToolCallIndex(modelOutput, t) !== -1;
        checks.push(!called);
        if (called) evidence.push(`Forbidden tool called: ${t}`);
      }
      if (requirements.should_not_call_any === true || requirements.minimal_calls === 0) {
        // 零调用约束：输出中不应出现任何结构化调用形态
        const anyCall = getStructuredToolCalls(modelOutput).length > 0;
        checks.push(!anyCall);
        if (anyCall) evidence.push('Zero-call constraint violated: structured call detected');
      }

      // ===== 6b. 顺序工作流（A1-3）：sequence / orderMatters 真正落地 =====
      const seq = Array.isArray(requirements.sequence) && requirements.sequence.length > 0
        ? requirements.sequence
        : (requirements.orderMatters && Array.isArray(requirements.should_call) ? requirements.should_call : null);
      if (seq) {
        let lastOrdinal = -1;
        const idxs = seq.map((t) => {
          const found = submittedCalls.find((call) => call.toolName.toLowerCase() === t.toLowerCase()
            && (call.ordinal ?? -1) > lastOrdinal);
          if (found) lastOrdinal = found.ordinal ?? -1;
          return found?.ordinal ?? -1;
        });
        idxs.forEach((idx, i) => {
          if (idx === -1) {
            checks.push(false);
            evidence.push(submittedCalls.some((call) => call.toolName.toLowerCase() === seq[i].toLowerCase())
              ? `sequence order violated: ${seq[i]} has no remaining call after the previous step`
              : `sequence violated: ${seq[i]} not called`);
          }
        });
        for (let i = 1; i < idxs.length; i++) {
          if (idxs[i - 1] !== -1 && idxs[i] !== -1) {
            if (idxs[i] > idxs[i - 1]) {
              checks.push(true);
            } else {
              checks.push(false);
              evidence.push(`sequence order violated: ${seq[i]} does not appear after ${seq[i - 1]}`);
            }
          }
        }
      }
      if (Array.isArray(requirements.calls) && requirements.calls.length > 0) {
        let next = 0;
        const consumed = new Set<number>();
        for (const expected of requirements.calls) {
          const index = submittedCalls.findIndex((call, i) => i >= next && !consumed.has(i)
            && matchesDeclaredCall(call, expected));
          const fallback = requirements.orderMatters ? -1
            : submittedCalls.findIndex((call, i) => !consumed.has(i) && matchesDeclaredCall(call, expected));
          const matched = index >= 0 ? index : fallback;
          checks.push(matched >= 0);
          if (matched >= 0) consumed.add(matched);
          if (matched >= 0 && requirements.orderMatters) next = matched + 1;
          if (matched < 0) evidence.push(`Declared call missing or wrong params: ${expected.toolName}`);
        }
      }
      if (requirements.allowExtra === false && Array.isArray(requirements.calls)) {
        checks.push(submittedCalls.length <= requirements.calls.length);
        if (submittedCalls.length > requirements.calls.length) evidence.push('Extra tool calls forbidden');
      }

      if (checks.length > 0) {
        axisScores.call_discipline = Math.round((checks.filter(Boolean).length / checks.length) * 100);
        axisEvidence.call_discipline = 'rule';
        evidence.push(`Call discipline: ${checks.filter(Boolean).length}/${checks.length} checks passed`);
      } else {
        axisEvidence.call_discipline = 'unmeasured';
      }
    } else {
      axisEvidence.call_discipline = 'unmeasured';
    }

    // ===== 7. 必含模式覆盖 =====
    if (Array.isArray(requirements.require_patterns) && requirements.require_patterns.length > 0) {
      const hits = requirements.require_patterns.filter((p) => modelOutput.includes(p)).length;
      axisScores.pattern_coverage = Math.round((hits / requirements.require_patterns.length) * 100);
      axisEvidence.pattern_coverage = 'rule';
      evidence.push(`Required patterns: ${hits}/${requirements.require_patterns.length}`);
    } else {
      axisEvidence.pattern_coverage = 'unmeasured';
    }

    // ===== 8. 总分：已测量轴加权 + 覆盖率保底（题集缺检查项时打折，不虚高） =====
    // A3-1 修复：仅纳入「场景实际配置」的轴，使覆盖率分母只计已配置需求，
    // 不再把合法缺省（未配置的 commands/discipline/patterns）计入分母。
    // 否则只配 tool+params 的场景 coverage = 1.00/2.25 = 0.444 < 0.5，
    // 在 Judge 关闭时把满分答案错误打折为 ×0.3（TC-CN-001/002/005 即此情形）。
    const axes: Array<[number | undefined, number]> = [
      [axisScores.format_valid, 0.15],
    ];
    // A3-5：tool_selection 与 command_coverage 互斥，避免 CLI 类场景对同一底层行为重复计量 0.50+0.50。
    // 仅当配置了 tool 且未配置 commands（纯 API 工具场景）时计入 tool_selection。
    if (requirements.tool && !(Array.isArray(requirements.commands) && requirements.commands.length > 0)) {
      axes.push([axisScores.tool_selection, 0.50]);
    } else if (requirements.tool) {
      axisEvidence.tool_selection = 'unmeasured';
      evidence.push('CLI-style scenario (commands configured) — tool_selection excluded to avoid double-counting with command_coverage (A3-5)');
    }
    if (requirements.params && Object.keys(requirements.params).length > 0) axes.push([axisScores.param_accuracy, 0.35]);
    if (Array.isArray(requirements.commands) && requirements.commands.length > 0) axes.push([axisScores.command_coverage, 0.50]);
    if (hasDiscipline) axes.push([axisScores.call_discipline, 0.50]);
    if (Array.isArray(requirements.require_patterns) && requirements.require_patterns.length > 0) axes.push([axisScores.pattern_coverage, 0.25]);
    const { score, coverage: axisCoverage } = weightedScoreByCoverage(axes);
    const declared = scenario.requirements as Record<string, unknown> | undefined;
    const consumedFields = new Set(['tool', 'params', 'commands', 'should_call', 'should_call_first',
      'should_not_call', 'should_not_call_any', 'minimal_calls', 'require_patterns', 'sequence',
      'orderMatters', 'must_call', 'must_not', 'allowExtra', 'calls', 'executionWorld', 'developmentShadow']);
    const pendingFields = Object.keys(declared ?? {}).filter((key) => !consumedFields.has(key));
    if (pendingFields.length > 0) {
      evidence.push(`UNVERIFIED_REQUIREMENTS: ${pendingFields.join(', ')}`);
      axisEvidence.task_completion = 'unmeasured';
    }
    return { axisScores, axisEvidence, axisCoverage,
      totalScore: pendingFields.length ? Math.min(score, 99) : score,
      humanReviewRequired: pendingFields.length > 0, safetyLevel: 'safe', evidence,
      criterionResults: pendingFields.length ? [{ id: 'tool_unverified_contract',
        description: '题目含未验证的条件或结果要求', status: 'unmeasured', critical: true,
        evidence: pendingFields.join(', '), source: 'unmeasured' }] : undefined };
  },
};
