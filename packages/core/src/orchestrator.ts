// ============================================================
// 评测编排器 — 核心流程（GPT5.6 P1-1: 11 步重组）
// 1. 固化运行配置与题目版本
// 2. 调用模型
// 3. 收集原始响应与工具轨迹
// 4. 提取输出和元数据
// 5. 语法/Schema/执行验证
// 6. 硬安全和权限验证
// 7. 确定性评分
// 8. 需要时进行 AI Judge
// 9. 根据题型聚合评分
// 10. 置信度、异常和人工复核判定
// 11. 写入不可变审计记录
// ============================================================

import type {
  Scenario,
  ScenarioResult,
  ModelConfig,
  ModelParams,
  EvalRunConfig,
  OutputMetadata,
  JudgeInput,
  JudgeResult,
  RunManifest,
  EvalConstraints,
  ModelResponse,
  RuntimeEvaluation,
} from '@zxbench/types';
import { callModelWithRetry } from './model/caller.js';
import { buildOutputMetadata } from '@zxbench/utils';
import { runTieredJudge, runJudgeEnsemble, computeJudgeScore, type JudgeOptions } from './judge/index.js';
import { getEvaluator } from './evaluators/index.js';
import { prepareSandboxEvaluation } from './sandbox/workspace.js';
import { checkSafetyRedLines } from './safety/index.js';
import { getJudgeWeights, mixDeterministicJudge, applyCoverageDiscount } from './scoring.js';

export interface OrchestrateOptions {
  scenario: Scenario;
  modelConfig: ModelConfig;
  modelParams: ModelParams;
  evalConfig: EvalRunConfig;
  judgeOptions?: JudgeOptions;
  systemPrompt?: string;
  onProgress?: (stage: string) => void;
  /** 思考/输出约束策略（反拖尾）：优先级 = 题目级字段 > 运行级 constraints */
  constraints?: EvalConstraints;
}

/** 解析题目级 + 运行级合并后的生效约束 */
function resolveConstraints(
  scenario: Scenario,
  runConstraints?: EvalConstraints,
): EvalConstraints {
  const c: EvalConstraints = { ...(runConstraints || {}) };
  // I3（2026-08-31）：program 维度 answerFirst 默认开启——推理模型在 maxTokens 耗尽时
  // 会把全部预算耗在 reasoning 上、content 为空被判 0 分（REASONING_TOKEN_BUDGET 误伤，
  // 实测 AG1-005/AG1-010 两题 0 分、answerFirst 重试后救回 45/40 分）。
  // 优先级：题目级显式字段 > 运行级 constraints > 维度默认。
  if (c.answerFirst == null && scenario.dimension === 'program') {
    c.answerFirst = true;
  }
  // 题目级字段覆盖运行级
  if (scenario.answerFirst != null) c.answerFirst = scenario.answerFirst;
  if (scenario.maxAnswerTokens != null) c.maxAnswerTokens = scenario.maxAnswerTokens;
  if (scenario.maxReasoningTokens != null) c.maxReasoningTokens = scenario.maxReasoningTokens;
  return c;
}

/** 反拖尾 prompt 指令（小范围验证）：Qwen3 系列用 /no_think 减少思考拖尾。
 *  这是 chat template 指令，写在 user prompt 开头；对 deepseek 等 API 模型无害（不认识会忽略）。
 *  当前仅对 structured_output 维度启用，验证后决定是否扩展。 */
const NO_THINK_DIMENSIONS = new Set(['structured_output']);

/** 按维度在 user prompt 前注入 /no_think（仅本地 Qwen3 等模型生效） */
function resolveUserPrompt(dimension: string, modelConfig: ModelConfig, promptTemplate: string): string {
  if (!NO_THINK_DIMENSIONS.has(dimension)) return promptTemplate;
  const isLocal = /localhost|127\.0\.0\.1/.test(modelConfig.baseUrl);
  if (!isLocal) return promptTemplate;
  return '/no_think\n' + promptTemplate;
}

/** 是否存在约束项（任一 token 上限或时间上限开启即视为激活） */
function hasActiveConstraints(constraints?: EvalConstraints): boolean {
  if (!constraints) return false;
  return (
    constraints.maxTotalTokens != null ||
    constraints.maxReasoningTokens != null ||
    constraints.maxAnswerTokens != null ||
    constraints.hardTimeLimitMs != null
  );
}

/** 构造思考/输出超限的失败结果（中断并判分） */
function buildLimitExceededResult(
  scenario: Scenario,
  reason: string,
  startedAt: string,
  finishedAt: string,
  onLimit?: 'fail' | 'degrade' | 'flag',
  detail?: { inputTokens?: number; outputTokens?: number; reasoningContent?: string },
): ScenarioResult {
  const evidence = [reason];
  const humanReviewRequired = onLimit === 'flag';
  return {
    scenarioId: scenario.id,
    scenarioVersion: scenario.scenarioVersion,
    scenarioHash: scenario.scenarioHash,
    dimension: scenario.dimension,
    graderVersion: scenario.graderVersion,
    modelOutput: '',
    reasoningContent: detail?.reasoningContent,
    outputMetadata: {
      finishReason: 'length',
      truncated: true,
      containsCodeBlock: false,
      containsFinalConclusion: false,
      outputLength: 0,
      outputTokens: detail?.outputTokens ?? 0,
      inputTokens: detail?.inputTokens ?? 0,
      maxTokens: 0,
      incomplete: true,
      incompleteReasons: [reason],
      reasoningLimitExceeded: true,
    },
    formatParseSuccess: false,
    axisScores: { format_valid: 0, reasoning_limit: 100 },
    totalScore: 0,
    deterministicScore: 0,
    judgeScore: undefined,
    safetyLevel: 'safe',
    localJudge: undefined,
    frontierJudge: undefined,
    finalJudge: undefined,
    escalated: false,
    runCount: 0,
    scoreHistory: [0],
    verdictHistory: ['reasoning_limit'],
    evidence,
    humanReviewRequired,
    reasoningLimitExceeded: true,
    startedAt,
    finishedAt,
  };
}

/** 执行单题评测完整流程 */
export async function orchestrateEvaluation(options: OrchestrateOptions): Promise<ScenarioResult> {
  const { scenario, modelConfig, modelParams, evalConfig, judgeOptions, systemPrompt, onProgress, constraints } = options;
  const startedAt = new Date().toISOString();

  // ===== Stage 1: 固化运行配置与题目版本 =====
  onProgress?.('initializing');

  // ===== Stage 2: 调用模型（推理模型可能 reasoning token 溢出） =====
  onProgress?.('calling_model');

  // 合并题目级 + 运行级约束（反拖尾：防止模型无限思考）
  const effectiveConstraints = resolveConstraints(scenario, constraints);
  const constraintsActive = hasActiveConstraints(effectiveConstraints);
  const onLimit = effectiveConstraints.onLimit ?? 'fail';

  // 多级 token 预算：推理模型可能把全部 tokens 消耗在 reasoning_content 中
  // 检测到空输出 + finish_reason=length 时自动升级预算重试
  // 链: default → 16384 → 32768 → 65536（覆盖绝大多数场景）
  // 注意：约束开启时预算已被硬性封顶，不再无限升级（思考超限直接中断判分）
  const TOKEN_RETRY_BUDGETS = [16384, 32768, 65536];
  const initialMaxTokens = modelParams.maxTokens ?? 8192;
  let effectiveMaxTokens = initialMaxTokens;
  let modelResponse: ModelResponse;

  // ===== Stage 1.5: 沙箱工作区探查（requiresSandbox 实地调查题） =====
  // 物化题述工作区（文件树/git 仓库）→ 执行探查 → 生成真实转录注入 prompt，
  // 模型基于真实数据推理作答（端口优先级/环境变量覆盖/git 作者去重等）
  let userPrompt = resolveUserPrompt(scenario.dimension, modelConfig, scenario.promptTemplate);
  let sandboxEvaluation: RuntimeEvaluation | undefined;
  let sandboxSummary: string | null = null;
  const scenarioRequirements = (scenario.requirements ?? {}) as Record<string, unknown>;

  // ===== Stage 1.55: 多文件仓库题（project_repair）——注入仓库文件内容 =====
  // P4 事故修复：AG 系列新题的 promptTemplate 是通用英文模板（不内嵌源码），而
  // requiresSandbox 仅在实地调查题开（#26 修复后）。若不注入 files，模型视角里
  // 只有一句"inspect the multi-file repository"，看不到任何代码 → 只能拒绝作答。
  // 这里对 project_repair 且带 files 的题，把文件树 + 全文注入 userPrompt，
  // 并要求以 `### file: <path>` 块输出完整修改内容（parseFileBlocks 兼容格式）。
  const repoFiles = Array.isArray(scenarioRequirements.files)
    ? (scenarioRequirements.files as { path: string; content: string }[])
    : [];
  if (scenario.grader === 'project_repair' && repoFiles.length > 0 && scenarioRequirements.requiresSandbox !== true) {
    const fileTree = repoFiles.map((f) => `- ${f.path}`).join('\n');
    const fileBodies = repoFiles
      .map((f) => `### file: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
      .join('\n\n');
    userPrompt =
      userPrompt +
      '\n\n===== 仓库文件 =====\n' +
      fileTree +
      '\n\n' +
      fileBodies +
      '\n\n===== 输出要求 =====\n对每个需要修改的文件，输出完整新内容，用 `### file: <相对路径>` 标注路径：';
    console.log(`[orchestrator] Injected ${repoFiles.length} repo files into prompt for ${scenario.id}`);
  }

  if (scenarioRequirements.requiresSandbox === true) {
    onProgress?.('sandbox_prepare');
    try {
      const prepared = await prepareSandboxEvaluation(scenario.id, scenarioRequirements);
      userPrompt = userPrompt + '\n\n' + prepared.transcript;
      sandboxEvaluation = prepared.runtimeEvaluation;
      sandboxSummary = prepared.summary;
      console.log(`[orchestrator] Sandbox prepared for ${scenario.id} — ${prepared.summary}`);
    } catch (sandboxErr) {
      const msg = sandboxErr instanceof Error ? sandboxErr.message : String(sandboxErr);
      console.warn(`[orchestrator] Sandbox prepare failed for ${scenario.id}: ${msg}`);
      sandboxSummary = `SANDBOX_PREPARE_FAILED: ${scenario.id} — ${msg}`;
    }
  }

  try {
    modelResponse = await callModelWithRetry({
      config: modelConfig,
      params: { ...modelParams, maxTokens: effectiveMaxTokens },
      systemPrompt,
      userPrompt,
      constraints: effectiveConstraints,
      stream: true, // 流式调用以获取精确 TTFT 和生成速度
    });
  } catch (err) {
    // 思考/时间超限 → 中断并判分（不抛异常，快速推进队列）
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = (err as Error)?.name === 'AbortError' || /timed out|timeout/i.test(msg);
    if (isTimeout) {
      console.warn(`[orchestrator] ${msg} for scenario ${scenario.id} — marking reasoning limit exceeded`);
      return buildLimitExceededResult(
        scenario,
        `HARD_TIME_LIMIT: ${msg} — hard time limit reached`,
        startedAt,
        new Date().toISOString(),
        onLimit,
      );
    }
    throw err; // 其他错误照常抛出
  }

  // I3（2026-08-31）：caller 层 reasoning 硬截断已生效的场景——
  // maxReasoningTokens 超预算后流被主动停止、已产出 content 保留。此时不再判 0，
  // 而是标记 truncated 证据后进入正常评分流程（修复"思考超限误伤真实能力"，
  // 实测 AG1-005/AG1-010 判 0 → answerFirst+硬截断下救回 45/40 分）。
  const reasoningHardCapped = (modelResponse.raw as Record<string, unknown> | undefined)?.reasoningHardCapped === true;

  // 约束开启时：finish_reason=length 且内容为空 → 思考/输出超限，直接中断判分
  // （模型把预算全花在思考上、无有效答案——不再升级预算让无底洞思考继续）
  if (constraintsActive && modelResponse.finishReason === 'length') {
    const hasContent = modelResponse.content && modelResponse.content.trim().length > 0;
    if (!hasContent) {
      console.warn(`[orchestrator] Constraints active, empty output with finish_reason=length for ${scenario.id} — marking reasoning limit exceeded`);
      return buildLimitExceededResult(
        scenario,
        `REASONING_TOKEN_BUDGET: reasoning exhausted maxTokens=${effectiveMaxTokens}, output tokens=${modelResponse.usage.outputTokens} (empty output, thinking consumed the budget)`,
        startedAt,
        new Date().toISOString(),
        onLimit,
        {
          inputTokens: modelResponse.usage.inputTokens,
          outputTokens: modelResponse.usage.outputTokens,
          reasoningContent: modelResponse.reasoningContent,
        },
      );
    }
  }

  if (!constraintsActive) {
    for (let retryAttempt = 0; retryAttempt < TOKEN_RETRY_BUDGETS.length; retryAttempt++) {
      const hasContent = modelResponse.content && modelResponse.content.trim().length > 0;
      if (hasContent) break;
      // 只有 finish_reason=length 才是 token 耗尽，其他原因（error/stop）不重试
      if (modelResponse.finishReason !== 'length') break;

      effectiveMaxTokens = TOKEN_RETRY_BUDGETS[retryAttempt];
      console.warn(
        `[orchestrator] Reasoning model empty output (attempt ${retryAttempt + 1}), ` +
        `upgrading maxTokens ${effectiveMaxTokens} for ${scenario.id}`
      );
      modelResponse = await callModelWithRetry({
        config: modelConfig,
        params: { ...modelParams, maxTokens: effectiveMaxTokens },
        systemPrompt,
        userPrompt,
        constraints: effectiveConstraints,
        stream: true,
      });
    }
  }

  // ===== Stage 2b: 空响应检测 — 模型返回空内容视为失败 =====
  if (!modelResponse.content || modelResponse.content.trim().length === 0) {
    const emptyErr = `Model returned empty response after ${TOKEN_RETRY_BUDGETS.length} retries (finish_reason=${modelResponse.finishReason}, maxTokens=${effectiveMaxTokens})`;
    console.error(`[orchestrator] ${emptyErr} for scenario ${scenario.id}`);
    return {
      scenarioId: scenario.id,
      scenarioVersion: scenario.scenarioVersion,
      scenarioHash: scenario.scenarioHash,
      dimension: scenario.dimension,
      graderVersion: scenario.graderVersion,
      modelOutput: '',
      reasoningContent: modelResponse.reasoningContent,
      outputMetadata: {
        finishReason: modelResponse.finishReason,
        truncated: false,
        containsCodeBlock: false,
        containsFinalConclusion: false,
        outputLength: 0,
        outputTokens: modelResponse.usage.outputTokens,
        inputTokens: modelResponse.usage.inputTokens,
        maxTokens: effectiveMaxTokens,
        incomplete: false,
        retryChainExhausted: true,
        retryBudgets: TOKEN_RETRY_BUDGETS,
        inferenceMs: modelResponse.latencyMs,
      },
      formatParseSuccess: false,
      axisScores: { format_valid: 0, empty_response: 100 },
      totalScore: 0,
      deterministicScore: 0,
      judgeScore: undefined,
      safetyLevel: 'safe' as const,
      localJudge: undefined,
      frontierJudge: undefined,
      finalJudge: undefined,
      escalated: false,
      runCount: 0,
      scoreHistory: [0],
      verdictHistory: ['empty_response'],
      evidence: [
        `Model returned empty response after ${TOKEN_RETRY_BUDGETS.length} retries. ` +
        `finish_reason=${modelResponse.finishReason}, ` +
        `retry budgets attempted: [${initialMaxTokens}, ${TOKEN_RETRY_BUDGETS.join(', ')}], ` +
        `final maxTokens=${effectiveMaxTokens}, ` +
        `output tokens=${modelResponse.usage.outputTokens}`
      ],
      humanReviewRequired: false,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  // ===== 容错护栏：生成成功后的所有阶段（评分/安全/Judge）若抛错，
  // 将已生成的模型输出挂载到错误对象，供上层落库保留，避免产出永久丢失 =====
  try {
  // ===== Stage 3-4: 收集原始响应 + 提取输出和元数据 =====
  onProgress?.('building_metadata');
  const outputMetadata: OutputMetadata = buildOutputMetadata(
    modelResponse.content,
    modelResponse.finishReason,
    effectiveMaxTokens ?? modelParams.maxTokens ?? 8192,
    modelResponse.usage.outputTokens,
  );
  outputMetadata.inputTokens = modelResponse.usage.inputTokens;
  // 存储 LLM 纯推理耗时（caller.ts 中 latencyMs = fetch 发起到响应解析完成）
  outputMetadata.inferenceMs = modelResponse.latencyMs;
  // 流式调用时的精确计时数据
  outputMetadata.tokenSpeed = modelResponse.tokensPerSecond;
  outputMetadata.ttftMs = modelResponse.ttftMs;
  // 尝试提取 LM Studio 原生 timing 数据（不同版本字段名可能不同）
  const rawData = modelResponse.raw as Record<string, unknown> | undefined;
  const stats = rawData?.stats as Record<string, number> | undefined;
  const timings = rawData?.timings as Record<string, number> | undefined;
  if (stats?.tokens_per_second) {
    outputMetadata.nativeTokensPerSecond = Math.round(stats.tokens_per_second);
  } else if (timings?.predicted_per_second) {
    outputMetadata.nativeTokensPerSecond = Math.round(timings.predicted_per_second);
  }

  // ===== Stage 5: 语法/Schema/执行验证 =====
  onProgress?.('parsing_output');
  let structuredAnswer: unknown;
  let formatParseSuccess = true;
  if (evalConfig.structuredOutputEnabled && scenario.schema) {
    try {
      const jsonMatch = modelResponse.content.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = jsonMatch ? jsonMatch[1].trim() : modelResponse.content.trim();
      structuredAnswer = JSON.parse(jsonStr);
      // TODO: JSON Schema 验证
    } catch {
      formatParseSuccess = false;
    }
  }

  // ===== Stage 7: 确定性评分（评分器） =====
  onProgress?.('deterministic_scoring');
  const evaluator = getEvaluator(scenario.grader, scenario.graderVersion);
  let result: Partial<ScenarioResult>;

  if (evaluator) {
    result = await evaluator.evaluate(scenario, modelResponse.content, outputMetadata, modelResponse);
    // 沙箱探查摘要（存在则置顶，便于审计）
    if (sandboxSummary) {
      result.evidence = [sandboxSummary, ...(result.evidence || [])];
    }
  } else {
    // 降级：使用基础评分
    result = {
      axisScores: { format_valid: formatParseSuccess ? 100 : 0 },
      totalScore: formatParseSuccess ? 50 : 0,
      safetyLevel: 'safe',
      evidence: [`No evaluator found for ${scenario.grader}@${scenario.graderVersion}`],
    };
  }

  // 检测代码块提取失败（模型有代码但未使用 Markdown 格式）
  const codeExtractionFailed = result.codeExtractionFailed === true
    || (result.axisScores?.patch_extraction != null && result.axisScores.patch_extraction <= 40)
    || (result.evidence || []).some(e => e.includes('CODE_EXTRACTION_HEURISTIC'));

  // 通用格式盲区检测：确定性评分极低但模型明显输出了内容 → 格式问题而非能力问题
  // 推广到所有维度：数学答案提取失败、JSON 解析失败、格式合规失败等场景
  // 阈值取 20 字符：数学题的正确答案常是一句话/一个数（<200 字符），
  // 过高的阈值会漏掉"短答案但格式不符"的格式盲区场景。
  const hasSubstantialOutput = modelResponse.content.trim().length > 20;
  const detScoreVeryLow = (result.totalScore ?? 100) < 25;
  const formatParseFailed = !formatParseSuccess && scenario.schema != null;

  // 有真实执行验证（编译/测试 verified）时，det 低是真实执行失败而非格式盲区，
  // 不应让 Judge 覆盖真实的编译/测试结果（否则"编译失败但 Judge 说对"会虚增分数）。
  const hasVerifiedExecution =
    result.axisEvidence?.compilation === 'verified' ||
    result.axisEvidence?.test_pass === 'verified';

  const formatBlindspot =
    codeExtractionFailed ||  // 编程维度：代码提取失败（无真实执行）
    ((detScoreVeryLow && hasSubstantialOutput) && !hasVerifiedExecution) ||  // 有内容但极低分，且非真实执行失败
    formatParseFailed;  // 结构化输出：JSON 解析失败

  // ===== Stage 6: 硬安全和权限验证（GPT5.6 P0-5 上下文感知） =====
  if (evalConfig.safetyCheckEnabled) {
    onProgress?.('safety_check');
    const safetyResult = checkSafetyRedLines(
      modelResponse.content,
      structuredAnswer ? JSON.stringify(structuredAnswer) : null,
      scenario.promptTemplate, // 传入题目 prompt 用于上下文豁免
    );
    if (safetyResult.level === 'red_line') {
      result.totalScore = 0;
      result.safetyLevel = 'red_line';
      result.evidence = [...(result.evidence || []), 'Safety red line triggered'];
    }
  }

  // ===== Stage 8: AI Judge（GPT5.6 P1-8 争议记录） =====
  let localJudge: ScenarioResult['localJudge'];
  let frontierJudge: ScenarioResult['frontierJudge'];
  let finalJudge: ScenarioResult['finalJudge'];
  let escalated = false;
  // P1：hoist 出 judge 集成历史，供最终落库 scoreHistory/runCount（避免被 612-613 字面量覆盖丢失）
  let judgeScoreHistoryArr: number[] | null = null;
  let ensembleRunCount = 1;

  // 按维度/题型定义权重
  let weights = getJudgeWeights(scenario.dimension, scenario.grader);

  // 格式盲区检测：当确定性评分因格式问题（而非能力问题）给出极低分时，
  // 大幅提升 Judge 权重，让 AI 直接评估输出内容质量。
  // 适用于：编程(代码未用```包裹)、推理数学(答案未用\boxed{})、
  // 结构化输出(JSON解析失败)、指令遵循(格式不合规)等场景。
  if (formatBlindspot && weights.judge > 0) {
    weights = {
      deterministic: 0.3,  // 确定性评分降权（格式问题是评分器的盲区）
      judge: 0.7,           // Judge 主导评判
    };
    console.log(`[orchestrator] Format blindspot detected for ${scenario.id} (dim=${scenario.dimension}), adjusting judge weights: det=${weights.deterministic} judge=${weights.judge}`);
  }

  // 当 judge 权重为 0 时，跳过 Judge 调用（节省 API 成本和时间）
  // 环境/测试基础设施故障（environmentError）同样跳过：harness 无法执行，
  // AI Judge 没有可评判的执行结果，调用只会浪费 token 且可能覆盖隔离标记。
  if (evalConfig.judgeEnabled && judgeOptions && weights.judge > 0 && result.environmentError !== true) {
    onProgress?.('ai_judge');
    const judgeInput: JudgeInput = {
      questionId: scenario.id,
      task: scenario.promptTemplate,
      dimension: scenario.dimension,
      sourceCode: scenario.sourceCode,
      requirements: scenario.requirements || [],
      expectedAnswer: scenario.requirements as unknown,
      expectedVerdict: scenario.expectedVerdict,
      candidateAnswer: {
        verdict: (structuredAnswer as Record<string, unknown>)?.verdict as 'fix' | 'no_bug' | undefined,
        rootCause: (structuredAnswer as Record<string, unknown>)?.root_cause as string | undefined,
        patch: result.extractedPatch
          ?? ((structuredAnswer as Record<string, unknown>)?.patch as string | null | undefined),
      },
      rawModelOutput: modelResponse.content,
      runtimeTests: result.runtimeEvaluation ? {
        compilePassed: result.runtimeEvaluation.compilePassed,
        passed: result.runtimeEvaluation.hiddenTestsPassed ?? result.runtimeEvaluation.testsPassed,
        failed: result.runtimeEvaluation.hiddenTestsFailed ?? result.runtimeEvaluation.testsFailed,
        details: result.runtimeEvaluation.details ?? [],
      } : undefined,
      outputMetadata,
      codeExtractionFailed,
      formatBlindspot,
      judgeHint: scenario.judgeHint,
    };

    // Judge 容错：调用失败不连坐丢弃生成结果，降级为纯确定性评分并标记人工复核
    let judgeFailedReason = '';
    let judgeResult: { localJudge: JudgeResult; frontierJudge?: JudgeResult; finalJudge: JudgeResult; escalated: boolean; runs?: JudgeResult[] } | null = null;
    try {
      // P0：judgeEnsembleRuns>1 时对同一候选输出重复判分 K 次取均，降低评分器噪声
      // P1：program 维度默认 3× 集成（降低 judge 噪声 √3）；其余维度沿用 evalConfig.judgeEnsembleRuns 或单跑
      const ensembleRuns = evalConfig.judgeEnsembleRuns ?? (scenario.dimension === 'program' ? 3 : 1);
      judgeResult = ensembleRuns > 1
        ? await runJudgeEnsemble(judgeInput, judgeOptions, ensembleRuns)
        : await runTieredJudge(judgeInput, judgeOptions);
    } catch (judgeErr) {
      judgeFailedReason = judgeErr instanceof Error ? judgeErr.message : String(judgeErr);
      console.error(`[orchestrator] Judge 调用失败，降级为确定性评分 (${scenario.id}): ${judgeFailedReason}`);
    }
    if (judgeResult !== null) {
      localJudge = judgeResult.localJudge;
      frontierJudge = judgeResult.frontierJudge;
      finalJudge = judgeResult.finalJudge;
      escalated = judgeResult.escalated;
    } else {
      result.humanReviewRequired = true;
      result.evidence = [...(result.evidence || []),
        `JUDGE_FAILED: ${judgeFailedReason} — 已降级为纯确定性评分，生成结果予以保留`,
      ];
    }

    // GPT5.6 P0-6: 按题型动态权重混合评分
    // AI Judge 只用于确定性评分覆盖不到的语义维度
    // 不让 AI Judge 覆盖语法、测试、执行和安全事实
    if (finalJudge && result.totalScore != null) {
      // 幻觉抵抗维度：Judge 输出 factuality(0-1) 作为语义事实分；其余维度沿用代码修复字段加权
      const isHallucination = scenario.dimension === 'hallucination_resistance';
      const judgeScore = (isHallucination && finalJudge.factuality != null)
        ? Math.round(finalJudge.factuality * 100)
        : computeJudgeScore(finalJudge);

      // 幻觉抵抗维度 Judge 参与后，factuality 轴证据从 rule 升级为 llm
      if (isHallucination) {
        result.axisEvidence = { ...(result.axisEvidence || {}), factuality: 'llm' };
      }

      // 保存混合前的确定性分数和 Judge 分数
      result.deterministicScore = result.totalScore;
      result.judgeScore = judgeScore;
      // P1：记录 Judge 集成各次分数（runJudgeEnsemble 提供 runs），落库到 scoreHistory/runCount 供方差分析
      if (judgeResult?.runs && judgeResult.runs.length > 1) {
        judgeScoreHistoryArr = judgeResult.runs.map((r) => computeJudgeScore(r));
        ensembleRunCount = judgeResult.runs.length;
      }

      // 覆盖率感知合并：确定性评分器未测量轴（题集缺检查项）的权重让渡给 AI Judge 补判
      // 例：tool_cli 缺 tool 配置（coverage=0.15）→ det 仅按已测轴计权，其余由 Judge 语义判分
      const coverage = result.axisCoverage ?? 1;
      const mixed = mixDeterministicJudge(weights.deterministic, weights.judge, coverage);
      result.totalScore = Math.round(result.totalScore * mixed.detW + judgeScore * mixed.judgeW);
    }

    // GPT5.6 P1-8: 升级后生成争议记录，不静默覆盖确定性事实
    if (escalated && finalJudge) {
      result.evidence = [...(result.evidence || []),
        `DISPUTE: local=${localJudge?.verdict} frontier=${frontierJudge?.verdict} final=${finalJudge.verdict}`,
        `Judge confidence: local=${localJudge?.confidence} frontier=${frontierJudge?.confidence}`,
      ];
      // 如果 Judge verdict 与确定性结果矛盾，标记人工复核
      const deterministicPassed = (result.axisScores?.test_pass ?? 0) > 50;
      const judgeSaysFail = finalJudge.patchCorrectness < 0.5;
      if (deterministicPassed && judgeSaysFail) {
        result.humanReviewRequired = true;
        result.evidence.push('DISPUTE: Deterministic tests passed but Judge says patch incorrect');
      }
    }
  }

  // ===== Stage 8b: citation 类幻觉题的引用真伪核实 =====
  // citation 题要求给出 DOI/URL/ISBN/PMID 等可核实引用，其真伪需联网检索验证。
  // 当前 Judge 为纯 Chat Completions 调用（无 tools/检索能力），无法验证引用是否真实存在。
  // 因此当 Judge 模型无检索能力时，引用真伪升级人工复核（用户事后核实），不静默判分。
  if (scenario.dimension === 'hallucination_resistance') {
    const hallucinationReqs = scenario.requirements as unknown as { citationTrap?: boolean };
    if (hallucinationReqs?.citationTrap === true) {
      const judgeHasSearch =
        judgeOptions?.localModel?.webSearchEnabled === true ||
        judgeOptions?.frontierModel?.webSearchEnabled === true;
      // 只有模型「实际输出了引用形态」（URL/DOI/ISBN/PMID）时，引用真伪才需要检索/人工核实；
      // 诚实拒绝（未给出引用）由 Judge 语义判分即可，无需人工复核。
      const hasCitation = /https?:\/\/|doi\.org|\b10\.\d{4,9}\/\S+|isbn[\s:：-]*[\d-]{9,}|pmid[\s:：-]*\d+/i.test(modelResponse.content);
      if (!judgeHasSearch && hasCitation) {
        result.humanReviewRequired = true;
        result.evidence = [...(result.evidence || []),
          'CITATION_UNVERIFIABLE: Judge 无检索能力，引用(DOI/URL/ISBN/PMID)真伪需人工核实'];
      }
    }
  }

  // ===== Stage 9: 根据题型聚合评分 =====
  // (已在上面按 getJudgeWeights 完成)
  // 当 Judge 未参与时（weights.judge === 0 或 judgeEnabled=false），确定性分数 = 总分
  if (result.deterministicScore == null) {
    // 覆盖率不足（题集缺检查项）且无 Judge 补判 → 打折，避免未验证给满分
    const coverage = result.axisCoverage ?? 1;
    const detScore = result.totalScore ?? 0;
    result.totalScore = applyCoverageDiscount(detScore, coverage);
    // 关键：deterministicScore 保存「原始」确定性分（不打折），供后续 rescore/judge 重算还原真实能力，
    // 打折只作用于 totalScore。否则重算时会把已打折的分数再次当作原始分，导致系统性压分。
    result.deterministicScore = detScore;
  }
  if (outputMetadata.incomplete) {
    result.evidence = [...(result.evidence || []), 'Sample marked as incomplete (truncated)'];
  }
  // I3：reasoning 硬截断标记入证据（内容已保留、正常评分，仅供报告层追溯）
  if (reasoningHardCapped) {
    const budget = (modelResponse.raw as Record<string, unknown> | undefined)?.maxReasoningTokens;
    result.evidence = [
      ...(result.evidence || []),
      `REASONING_HARD_CAPPED: reasoning exceeded maxReasoningTokens=${budget}, stream stopped early; partial content scored`,
    ];
  }

  const finishedAt = new Date().toISOString();

  return {
    scenarioId: scenario.id,
    scenarioVersion: scenario.scenarioVersion,
    scenarioHash: scenario.scenarioHash,
    dimension: scenario.dimension,
    modelOutput: modelResponse.content,
    reasoningContent: modelResponse.reasoningContent,
    outputMetadata,
    structuredAnswer,
    formatParseSuccess,
    runtimeEvaluation: sandboxEvaluation,
    axisScores: result.axisScores || {},
    // 透传评分器证据标记 + 兜底（未显式标注的轴默认视为 rule）+ AI Judge 参与时补充 llm 语义轴
    axisEvidence: {
      ...(result.axisEvidence || {}),
      ...(Object.fromEntries(
        Object.keys(result.axisScores || {})
          .filter((k) => !result.axisEvidence || result.axisEvidence[k] == null)
          .map((k) => [k, 'rule' as const]),
      )),
      ...(finalJudge
        ? {
            judge_bug_detection: 'llm' as const,
            judge_root_cause: 'llm' as const,
            judge_patch_correctness: 'llm' as const,
            judge_scope_discipline: 'llm' as const,
            judge_output_completeness: 'llm' as const,
          }
        : {}),
    },
    totalScore: result.totalScore ?? 0,
    deterministicScore: result.deterministicScore,
    judgeScore: result.judgeScore,
    safetyLevel: result.safetyLevel ?? 'safe',
    localJudge,
    frontierJudge,
    finalJudge,
    escalated,
    runCount: judgeScoreHistoryArr ? ensembleRunCount : 1,
    scoreHistory: judgeScoreHistoryArr ?? [result.totalScore ?? 0],
    verdictHistory: [(structuredAnswer as Record<string, unknown>)?.verdict as string || 'unknown'],
    graderVersion: `${scenario.grader}@${scenario.graderVersion}`,
    evidence: result.evidence || [],
    humanReviewRequired: escalated || (result.totalScore ?? 0) < 30,
    codeExtractionFailed,
    // 环境/测试基础设施故障标志必须透传：评分器置位后，编排层据此跳过 Judge，
    // 落库与聚合层再据此把该题排除出维度均值。此前本字段在构造返回对象时漏传，
    // 导致「Judge 已跳过、轴已标 unmeasured，但 environmentError 落库为 0」，
    // 退化的规则分仍被计入均分（2026-08-28 修）。
    environmentError: result.environmentError === true,
    startedAt,
    finishedAt,
  };
  } catch (postGenErr) {
    if (postGenErr instanceof Error) {
      (postGenErr as Error & { partialModelOutput?: string; partialReasoningContent?: string }).partialModelOutput = modelResponse.content;
      (postGenErr as Error & { partialReasoningContent?: string }).partialReasoningContent = modelResponse.reasoningContent;
    }
    throw postGenErr;
  }
}

/** 生成运行 Manifest（GPT5.6 P0-6） */
export function generateManifest(
  runId: string,
  modelConfig: ModelConfig,
  modelParams: ModelParams,
  evalConfig: EvalRunConfig,
  scenarioHash: string,
): RunManifest {
  return {
    runId,
    timestamp: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dataset: {
      name: 'ZxBench Pro',
      version: '2.0.0',
      scenarioHash,
    },
    scorers: {
      version: 'scorer-2026-08-03',
      configHash: '',
    },
    models: [{
      name: modelConfig.name,
      modelId: modelConfig.id,
      parameters: modelParams,
      maxTokens: modelParams.maxTokens ?? 4096,
      timeoutSeconds: (modelParams.timeout ?? 60000) / 1000,
      retryCount: modelParams.retryCount ?? 3,
    }],
    judgeModels: {
      local: evalConfig.judgeLocalModel,
      frontier: evalConfig.judgeFrontierModel,
    },
    environment: {
      nodeVersion: process.version,
      os: process.platform,
    },
    metrics: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalLatencyMs: 0,
      totalCostUsd: 0,
      judgeLatencyMs: 0,
      judgeCostUsd: 0,
    },
    config: {
      maxTokens: evalConfig.maxTokens,
      temperature: evalConfig.temperature,
      runsPerQuestion: evalConfig.runsPerQuestion,
      judgeEnabled: evalConfig.judgeEnabled,
      escalationEnabled: evalConfig.escalationEnabled,
    },
  };
}