// ============================================================
// AI Judge 模块 — 分层路由（GPT5.6 P2-2 ~ P2-6）
// 第一层：本地模型初判
// 第二层：顶级模型争议复核
// 自动升级条件判断
// ============================================================

import type {
  JudgeInput,
  JudgeResult,
  JudgeVerdict,
  ModelConfig,
  TokenUsage,
} from '@zxbench/types';
import { callModel } from '../model/caller.js';
import { getJudgeSystemPrompt, buildJudgeUserPrompt } from './prompts.js';

export interface JudgeOptions {
  localModel: ModelConfig;
  frontierModel?: ModelConfig;
  escalationThreshold: number;  // 默认 0.85
}

/**
 * Judge 需要等待推理模型完成较长的思考，但不应无限占住整个评测 worker。
 * 供应商可通过模型 defaultParams.timeout 覆盖；未设置时收敛到 5 分钟。
 */
const DEFAULT_JUDGE_TIMEOUT_MS = 300_000;

/** 判断是否需要升级到顶级模型（GPT5.6 P2-5） */
export function shouldEscalate(
  judgeResult: JudgeResult,
  input: JudgeInput,
  threshold: number,
): boolean {
  // 置信度低于阈值
  if (judgeResult.confidence < threshold) return true;

  // Judge verdict 与 expected_verdict 不一致
  if (input.expectedVerdict) {
    const expectedCorrect = judgeResult.verdict === 'correct';
    const expectedNoBug = judgeResult.verdict === 'incorrect';
    if (input.expectedVerdict === 'fix' && expectedNoBug) return true;
    if (input.expectedVerdict === 'no_bug' && expectedCorrect) return true;
  }

  // 程序测试通过但 Judge 判定 patch 错误（或反之）
  if (input.runtimeTests) {
    const testsPassed = input.runtimeTests.failed === 0;
    const judgeSaysWrong = judgeResult.patchCorrectness < 0.5;
    if (testsPassed && judgeSaysWrong) return true;
    if (!testsPassed && judgeResult.patchCorrectness > 0.8) return true;
  }

  // 候选答案被截断
  if (input.outputMetadata.truncated) return true;

  // 无隐藏测试
  if (!input.runtimeTests || input.runtimeTests.passed + input.runtimeTests.failed === 0) return true;

  return false;
}

/**
 * 尝试修复被截断的 JSON（常见于 max_tokens 不足导致输出被切断）
 * 策略：
 * 1. 提取代码块中的 JSON
 * 2. 补齐缺失的闭合括号（} 和 ]）
 * 3. 移除末尾不完整的字段
 */
function tryRepairTruncatedJson(content: string): Record<string, unknown> | null {
  try {
    // 提取 JSON 代码块
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    let jsonStr = jsonMatch ? jsonMatch[1].trim() : content.trim();

    // 移除末尾不完整的行（最后一个不完整的键值对或数组元素）
    const lastComma = jsonStr.lastIndexOf(',');
    const lastBrace = jsonStr.lastIndexOf('}');
    const lastBracket = jsonStr.lastIndexOf(']');

    // 如果末尾有未闭合的字符串（奇数个引号），截断到上一个完整位置
    if (lastComma > Math.max(lastBrace, lastBracket)) {
      jsonStr = jsonStr.slice(0, lastComma);
    }

    // 计算未闭合的括号
    let braceDepth = 0;
    let bracketDepth = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < jsonStr.length; i++) {
      const ch = jsonStr[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') braceDepth++;
      if (ch === '}') braceDepth--;
      if (ch === '[') bracketDepth++;
      if (ch === ']') bracketDepth--;
    }

    // 补齐缺失的闭合括号
    if (braceDepth > 0 || bracketDepth > 0) {
      for (let i = 0; i < bracketDepth; i++) jsonStr += ']';
      for (let i = 0; i < braceDepth; i++) jsonStr += '}';
    }

    // 尝试解析修复后的 JSON
    return JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 解析 Judge 调用温度：
 *  - 推理模型（kimi-k3、deepseek-reasoner 等）只接受 temperature=1，强制 1；
 *  - 否则尊重模型 defaultParams.temperature，缺省 0.1（Judge 需要低温度保证稳定）。 */
function resolveJudgeTemperature(model: ModelConfig): number {
  if (model.reasoningModel) return 1;
  return model.defaultParams?.temperature ?? 0.1;
}

/** 调用 Judge 模型 */
async function callJudgeModel(
  model: ModelConfig,
  input: JudgeInput,
): Promise<JudgeResult> {
  const userPrompt = buildJudgeUserPrompt(input);
  const systemPrompt = getJudgeSystemPrompt(input.dimension);
  const startTime = Date.now();

  const response = await callModel({
    config: model,
    // Judge 使用 SSE。腾讯等推理端点在非流式模式下会在完整推理结束前一直
    // 不返回响应头，恰好撞上 Node/Undici 的 300 秒 headers timeout，表现为
    // `fetch failed`。流式响应先建立连接并持续输出，仍由下面的总超时和 caller
    // 的空闲超时保护，避免静默挂起。
    stream: true,
    params: {
      maxTokens: 8192,
      temperature: resolveJudgeTemperature(model),
      timeout: model.defaultParams?.timeout ?? DEFAULT_JUDGE_TIMEOUT_MS,
    },
    systemPrompt,
    userPrompt,
  });

  const latencyMs = Date.now() - startTime;
  const wasTruncated = response.finishReason === 'length';

  // 解析 Judge 输出（严格 JSON，带截断修复）
  let parsed: Record<string, unknown>;
  try {
    // 尝试从代码块中提取 JSON
    const jsonMatch = response.content.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : response.content.trim();
    parsed = JSON.parse(jsonStr);
  } catch {
    // JSON 解析失败 — 尝试修复截断的 JSON
    const repaired = tryRepairTruncatedJson(response.content);
    if (repaired) {
      parsed = repaired;
    } else {
      // 无法修复，返回降级结果
      return {
        judgeModel: model.name,
        verdict: 'ambiguous',
        bugDetection: 0,
        rootCause: 0,
        patchCorrectness: 0,
        patchCompleteness: 0,
        scopeDiscipline: 0,
        outputCompleteness: 0,
        confidence: 0,
        needsEscalation: true,
        evidence: [wasTruncated ? 'Judge output was truncated (max_tokens limit)' : 'Judge output is not valid JSON'],
        notes: [response.content.slice(0, 500)],
        latencyMs,
        tokenUsage: response.usage,
      };
    }
  }

  return {
    judgeModel: model.name,
    verdict: (parsed.verdict as JudgeVerdict) || 'ambiguous',
    bugDetection: toScore(parsed.bug_detection),
    rootCause: toScore(parsed.root_cause),
    patchCorrectness: toScore(parsed.patch_correctness),
    patchCompleteness: toScore(parsed.patch_completeness),
    scopeDiscipline: toScore(parsed.scope_discipline),
    outputCompleteness: toScore(parsed.output_completeness),
    factuality: typeof parsed.factuality === 'number' ? toScore(parsed.factuality) : undefined,
    confidence: toScore(parsed.confidence),
    needsEscalation: Boolean(parsed.needs_escalation),
    evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map(String) : [],
    notes: Array.isArray(parsed.notes) ? parsed.notes.map(String) : [],
    latencyMs,
    tokenUsage: response.usage,
  };
}

function toScore(val: unknown): number {
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0;
}

/** 合并两个 Judge 结果 */
function mergeDecisions(local: JudgeResult, frontier: JudgeResult): JudgeResult {
  // 决策优先级：编译结果 > 隐藏测试 > 结构化 verdict > AI Judge 解释
  // 顶级模型权重更高
  return {
    judgeModel: `${local.judgeModel}+${frontier.judgeModel}`,
    verdict: frontier.verdict,  // 以顶级模型为准
    bugDetection: local.bugDetection * 0.3 + frontier.bugDetection * 0.7,
    rootCause: local.rootCause * 0.3 + frontier.rootCause * 0.7,
    patchCorrectness: local.patchCorrectness * 0.3 + frontier.patchCorrectness * 0.7,
    patchCompleteness: local.patchCompleteness * 0.3 + frontier.patchCompleteness * 0.7,
    scopeDiscipline: local.scopeDiscipline * 0.3 + frontier.scopeDiscipline * 0.7,
    outputCompleteness: local.outputCompleteness * 0.3 + frontier.outputCompleteness * 0.7,
    factuality: (local.factuality != null && frontier.factuality != null)
      ? local.factuality * 0.3 + frontier.factuality * 0.7
      : (frontier.factuality ?? local.factuality),
    confidence: Math.max(local.confidence, frontier.confidence),
    needsEscalation: false,
    evidence: [...local.evidence, ...frontier.evidence],
    notes: [...local.notes, ...frontier.notes, 'Escalated to frontier judge'],
    latencyMs: local.latencyMs + frontier.latencyMs,
    tokenUsage: mergeTokenUsage(local.tokenUsage, frontier.tokenUsage),
  };
}

function mergeTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/** 执行分层 Judge 流程 */
export async function runTieredJudge(
  input: JudgeInput,
  options: JudgeOptions,
): Promise<{ localJudge: JudgeResult; frontierJudge?: JudgeResult; finalJudge: JudgeResult; escalated: boolean }> {
  // 第一层：本地模型初判
  const localJudge = await callJudgeModel(options.localModel, input);

  // 判断是否需要升级
  const needsEscalation = localJudge.needsEscalation
    || shouldEscalate(localJudge, input, options.escalationThreshold);

  if (needsEscalation && options.frontierModel) {
    // 第二层：顶级模型争议复核
    const frontierJudge = await callJudgeModel(options.frontierModel, input);
    const finalJudge = mergeDecisions(localJudge, frontierJudge);
    return { localJudge, frontierJudge, finalJudge, escalated: true };
  }

  return { localJudge, finalJudge: localJudge, escalated: false };
}

/** 计算 Judge 综合分（与 orchestrator / rescore 共用，避免重复加权逻辑） */
export function computeJudgeScore(j: JudgeResult): number {
  return Math.round(
    j.bugDetection * 25 +
    j.rootCause * 25 +
    j.patchCorrectness * 30 +
    j.scopeDiscipline * 10 +
    j.outputCompleteness * 10,
  );
}

/**
 * 集成判分（P0）：对同一候选输出重复调用分层 Judge K 次，对各连续子分取均值，
 * 降低评分器随机性带来的方差（K 次平均使评分器噪声分量 ÷√K）。
 * 仅对「同一候选输出」重复判分（候选模型只调用一次），不引入额外候选方差。
 *
 * 返回聚合后的 finalJudge，以及每次运行的 finalJudge 列表（供方差分析 /
 * 写回 judgeScoreHistory）。runs 为空时退化为单次 runTieredJudge。
 */
export async function runJudgeEnsemble(
  input: JudgeInput,
  options: JudgeOptions,
  K = 3,
): Promise<{
  localJudge: JudgeResult;
  frontierJudge?: JudgeResult;
  finalJudge: JudgeResult;
  escalated: boolean;
  runs: JudgeResult[];
  /** K 轮集成中失败轮的诊断。只要至少一轮成功，保留成功评分。 */
  failures: string[];
}> {
  const n = Math.max(1, Math.floor(K));
  const runs: JudgeResult[] = [];
  let localJudge: JudgeResult | undefined;
  let frontierJudge: JudgeResult | undefined;
  let escalated = false;
  const failures: string[] = [];

  for (let i = 0; i < n; i++) {
    try {
      const r = await runTieredJudge(input, options);
      runs.push(r.finalJudge);
      if (!localJudge) localJudge = r.localJudge;
      if (r.frontierJudge) frontierJudge = r.frontierJudge;
      if (r.escalated) escalated = true;
    } catch (err) {
      // 不能让第 2/3 轮短暂网络故障抹掉已完成的评分；全部失败时仍向上抛，
      // 由 orchestrator 走原有的确定性评分降级路径。
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (runs.length === 0 || !localJudge) {
    throw new Error(`All ${n} judge ensemble runs failed: ${failures.join(' | ') || 'unknown error'}`);
  }

  const avgNum = (sel: (j: JudgeResult) => number): number =>
    runs.reduce((a, j) => a + sel(j), 0) / runs.length;

  const averaged: JudgeResult = {
    ...runs[0],
    bugDetection: avgNum((j) => j.bugDetection),
    rootCause: avgNum((j) => j.rootCause),
    patchCorrectness: avgNum((j) => j.patchCorrectness),
    patchCompleteness: avgNum((j) => j.patchCompleteness),
    scopeDiscipline: avgNum((j) => j.scopeDiscipline),
    outputCompleteness: avgNum((j) => j.outputCompleteness),
    factuality: runs[0].factuality != null ? avgNum((j) => j.factuality ?? 0) : undefined,
    confidence: avgNum((j) => j.confidence),
    evidence: runs.flatMap((j) => j.evidence),
    notes: runs.flatMap((j) => j.notes),
  };

  return {
    localJudge: localJudge!,
    frontierJudge,
    finalJudge: averaged,
    escalated,
    runs,
    failures,
  };
}
