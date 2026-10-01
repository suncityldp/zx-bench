// ============================================================
// @zxbench/types — 全局类型定义
// 覆盖：题目、评测、评分、AI Judge、Manifest、配置
// ============================================================

// ----- 基础枚举 -----

export type QuestionStatus = 'valid' | 'invalid' | 'ambiguous' | 'needs_context' | 'retired';
export type Difficulty = 'easy' | 'medium' | 'hard' | 'adversarial';
export type Verdict = 'fix' | 'no_bug';
export type FinishReason = 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'error' | 'unknown';
export type OutputPolicy = 'raw_only' | 'fenced_allowed';
export type VisibleRationaleMode = 'auto' | 'forbidden' | 'required';
export type ScenarioTier = 'public_dev' | 'private_validation' | 'blind_holdout';
export type EvalRunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type JudgeVerdict = 'correct' | 'incorrect' | 'partial' | 'ambiguous';
export type SafetyLevel = 'safe' | 'red_line';

// ----- 题目定义 -----

/** 隐藏测试用例 */
export interface HiddenTestCase {
  id: string;
  type: 'normal' | 'boundary' | 'edge_case' | 'exception' | 'regression' | 'security' | string;
  description: string;
  testCode: string;           // 测试代码
  input?: Record<string, unknown>;
  expectedOutput?: string;
  expectedExitCode?: number;
  timeout?: number;
  category?: 'normal' | 'boundary' | 'exception' | 'regression';
  businessInvariant?: string;
  name?: string;
  assert?: string;
}

/** 可接受修复方向 */
export interface AcceptablePatch {
  behavior: string;
  directions?: string[];
  constraints?: string[];
}

/** 题目完整定义 */
export interface Scenario {
  id: string;
  /** Frozen source identity/weight for released execution-instance grouping. */
  benchmarkSource?: {
    releaseId: string; id: string; scenarioHash: string; dimension: string;
    difficulty: Difficulty; category: string; requirements?: { attackLevel?: string | null };
    taskCount: number;
  };
  dimension: string;           // 如 "bug_finding", "code_repair", "structured_output"
  category: string;            // 如 "business_logic", "async_concurrency"
  difficulty: Difficulty;
  language: string;            // "javascript" | "python" | ...
  locale: string;              // "zh-CN"
  status: QuestionStatus;
  tier: ScenarioTier;

  // Prompt
  promptTemplate: string;      // 支持 {{variable}} 参数化
  promptVariables?: Record<string, string | number>;

  // 源码 & 期望
  sourceCode?: string;
  functionName?: string;
  expectedVerdict?: Verdict;
  expectedAnswer?: unknown;     // 不同维度格式不同

  // 评分配置
  grader: string;              // "bug_finding_v2" | "code_repair_v2" | "schema_compliance_v2" | ...
  graderVersion: string;
  scoring: ScoringConfig;
  outputPolicy?: OutputPolicy;
  schema?: Record<string, unknown>;   // JSON Schema（结构化输出题）
  constraints?: string[];             // 跨字段约束表达式

  // 隐藏测试
  hiddenTests?: HiddenTestCase[];
  publicTests?: HiddenTestCase[];

  // 元数据
  bugInvariants?: string[];
  acceptablePatches?: AcceptablePatch[];
  unacceptablePatches?: string[];
  outOfScope?: string[];
  requirements?: string[];
  tags?: string[];

  // 版本
  scenarioVersion: string;
  scenarioHash: string;

  /** 每题定制的 AI Judge 评判提示（可选）。
   *  当模型输出格式不规范（如未使用 Markdown 代码块）但内容有实质代码时，
   *  Judge 可根据此提示进行针对性的代码质量评判。 */
  judgeHint?: string;

  // ----- 思考/输出约束（GPT5.6 反拖尾） -----
  /** 要求把最终答案放在可见输出开头（不等于必须输出解释） */
  answerFirst?: boolean;
  /** 最终答案（content 部分）token 上限；超出判定超限 */
  maxAnswerTokens?: number;
  /** 思考链（reasoning_content）token 上限；超出判定思考超限 */
  maxReasoningTokens?: number;

  // ----- Governance fields (Phase 1: align with Prisma schema / benchmark.json) -----
  /** Review status: "unreviewed" | "verified" | ... (official runs require verified) */
  reviewStatus?: string | null;
  /** Provenance of the gold answer (official requires traceability) */
  goldSource?: string | null;
  /** Timestamp of independent gold verification */
  goldVerifiedAt?: string | Date | null;
  /** Execution environment image (for containerized runner) */
  environmentImage?: string | null;
  /** Parameterization seed */
  seed?: string | number | null;
  /** Response mode: plan | simulated_actions | live_execution | raw_output */
  responseMode?: string | null;
}

/** 评测运行级思考/输出约束策略 */
export interface EvalConstraints {
  /** 强制最终答案位于可见输出开头（注入 prompt） */
  answerFirst?: boolean;
  /** 可见解释策略：auto=按题目契约决定，forbidden=仅答案，required=答案后附简短理由 */
  visibleRationale?: VisibleRationaleMode;
  /** 最终答案 content token 上限（硬校验，超限中断） */
  maxAnswerTokens?: number;
  /** 思考链 token 上限（硬校验，超限中断） */
  maxReasoningTokens?: number;
  /** 单题总输出（reasoning + content）token 上限 */
  maxTotalTokens?: number;
  /** 单题硬时间上限（毫秒），默认 300000（5 分钟） */
  hardTimeLimitMs?: number;
  /** 超限处置：fail=判0分(默认)；degrade=降权；flag=标记人工复核不判死 */
  onLimit?: 'fail' | 'degrade' | 'flag';
}

/** 评分配置 */
export interface ScoringConfig {
  type: string;   // "weighted_axes" | "atomic_field_accuracy" | "binary_pass_fail" | ...
  weights?: Record<string, number>;
  redLines?: string[];
  scoreCaps?: ScoreCap[];
}

export interface ScoreCap {
  when: string;   // 条件表达式
  maxScore: number;
}

// ----- 模型调用 -----

/** 模型配置 */
export interface ModelConfig {
  id: string;
  name: string;              // 模型 ID（API 调用的 model 参数）
  /** 模型名称（用户友好显示名，可编辑；未设置时前端显示 name） */
  displayName?: string | null;
  provider: string;          // "openai" | "ollama" | "local" | ...
  baseUrl: string;
  apiKey?: string;
  defaultParams: ModelParams;
  modelType?: 'tested' | 'judge';  // 默认 "tested"
  /** 推理模型标记 — 推理模型(QwQ/DeepSeek-R1等)会消耗大量 token 在思考链上，
   *  系统会自动分配更大的 token 预算 (默认 32768，分 8192→16384→32768→65536 四档重试) */
  reasoningModel?: boolean;  // 默认 false
  /** 联网/检索能力标记（Judge 模型专用）：当 Judge 具备 web search/tool 检索能力时置 true。
   *  用于 citation 类幻觉题——Judge 无检索能力时无法验证 DOI/URL/ISBN 真伪，需升级人工复核。 */
  webSearchEnabled?: boolean;  // 默认 false
}

/** 模型调用参数 */
export interface ModelParams {
  temperature?: number | null;
  topP?: number | null;
  maxTokens?: number;
  timeout?: number;          // 毫秒；模型/运行默认超时
  /**
   * 题级硬超时（毫秒）。优先级高于 `timeout` 与运行级 `constraints.hardTimeLimitMs`：
   * 有效超时 = min(hardTimeLimitMs ?? timeout ?? 600000, hardTimeoutMs)。
   * 来源是题目 `requirements.hardSeconds`（与题面「时限N秒」一致），
   * 避免运行级硬止损把单题预算放大（实测 360 秒题被跑到 1200 秒）。
   */
  hardTimeoutMs?: number;
  retryCount?: number;
  stop?: string[];
  extra?: Record<string, unknown>;
}

/** 模型原始响应 */
export interface ModelResponse {
  content: string;
  reasoningContent?: string;   // 分离的思考过程
  finishReason: FinishReason;
  usage: TokenUsage;
  latencyMs: number;           // 总请求耗时（fetch 发起到解析完成）
  /** 首 token 延迟（毫秒）— 仅流式调用时有值 */
  ttftMs?: number;
  /** 纯生成耗时（毫秒）— 首 token 到末 token，仅流式调用时有值 */
  generationMs?: number;
  /** 生成速度（tokens/s）= outputTokens / (generationMs / 1000)，仅流式调用时有值 */
  tokensPerSecond?: number;
  raw?: unknown;               // 原始 API 响应
  /**
   * 多轮 Agent 闭环轨迹（由 packages/core 的 agentLoop 驱动器写入）。
   * 类型定义在 core 侧（依赖领域的工具运行时），此处只做透传，
   * 避免 types 包反向依赖 core。
   */
  agentLoop?: unknown;
  executionWorld?: unknown;
  shellLoop?: unknown;
}

export interface TokenUsage {
  inputTokens: number;
  /** Total generated tokens, including reasoning when supplied by the provider. */
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  source?: 'provider' | 'estimated';
}

// ----- 输出元数据（GPT5.6 P0-1） -----

export type { CalibrationSplit, ReviewState, ReviewCriterion, CalibrationCandidate, CalibrationReview, CalibrationEvent, CandidateReviewSummary, CalibrationRecord } from './calibration.js';

export interface OutputMetadata {
  /** Versioned audit envelope persisted with existing JSON rows (no DB migration). */
  evaluationAudit?: EvaluationAudit;
  /** False for rescoring a saved answer; it incurred no new candidate call. */
  candidateGenerated?: boolean;
  /** Complete execution trace for new live agent runs; absent on legacy rows. */
  agentLoopTrace?: unknown;
  executionWorldTrace?: unknown;
  shellExecutionTrace?: unknown;
  cliExecutionTrace?: unknown;
  executionTraceSha256?: string;
  reasoningTokens?: number;
  tokenUsageSource?: 'provider' | 'estimated';
  finishReason: FinishReason;
  truncated: boolean;
  containsCodeBlock: boolean;
  containsFinalConclusion: boolean;
  outputLength: number;
  outputTokens: number;
  inputTokens: number;
  maxTokens: number;
  incomplete: boolean;         // 截断 → incomplete
  incompleteReasons?: string[];
  /** 推理模型多级重试预算已耗尽（仍为空输出） */
  retryChainExhausted?: boolean;
  /** 尝试过的重试 token 预算列表 */
  retryBudgets?: number[];
  /** Candidate request/loop elapsed ms, including network/prefill and loop tools; excludes scoring/Judge/DB. */
  inferenceMs?: number;
  /** Measured stream generation interval; absent for legacy/request-only timing. */
  generationMs?: number;
  /** LM Studio 原生返回的 tokens/s（如果有） */
  nativeTokensPerSecond?: number;
  /** 预计算的 token 生成速度（tokens/s），落库时统一计算保证一致性 */
  tokenSpeed?: number;
  /** 首 token 延迟（毫秒）— 仅流式调用时有值 */
  ttftMs?: number;
  /** 思考/输出超限标记 — 模型思考链过长或输出超出预算，被硬性中断 */
  reasoningLimitExceeded?: boolean;
}

// ----- 结构化输出协议（GPT5.6 P1-1） -----

/** 模型结构化输出（BF 维度） */
export interface StructuredBFAnswer {
  verdict: Verdict;
  bug_locations: BugLocation[];
  root_cause: string;
  patch: string | null;
  verification: string[];
  extra_concerns: string[];
  confidence: number;
}

export interface BugLocation {
  symbol: string;
  line_hint?: string;
  description: string;
}

// ----- 评测结果 -----

/** 评分轴证据强度：verified=真实执行验证, rule=确定性规则, llm=AI 判分, unmeasured=未测量 */
export type AxisEvidence = 'verified' | 'rule' | 'llm' | 'unmeasured';

export interface CriterionResult {
  id: string;
  description: string;
  status: 'pass' | 'fail' | 'unmeasured';
  critical: boolean;
  evidence: string;
  source: AxisEvidence;
}

export interface StructuredContractMetrics {
  version: 1 | 4;
  format?: string;
  renderingValid?: boolean;
  family: string;
  validator: string;
  dialect: string;
  syntaxValid: boolean;
  schemaValid: boolean;
  contentValid: boolean | null;
  complete: boolean;
  partialScore: number;
  grounded?: {
    targetLeaves: number;
    foundLeaves: number;
    typeCorrect: number;
    valueCorrect: number;
    valueTargetLeaves: number;
    extraLeaves: number;
    evidenceCorrect: number;
    evidenceTargetLeaves: number;
    pathRecall: number;
    valueAccuracy: number;
  };
}

/** A narrowly scoped Judge decision about failed positive final-answer wording. */
export interface SemanticFinalReview {
  version: string;
  judgeModelId: string;
  judgeModel: string;
  status: 'equivalent' | 'not_equivalent' | 'inconclusive' | 'error';
  checks: Array<{ id: string; equivalent: boolean | null; quote: string }>;
  tokenUsage?: TokenUsage;
  error?: string;
}

export interface WorkflowCheckpointEvaluation {
  version: string;
  progress: number;
  fullSuccess: boolean;
  safetyViolation: boolean;
  score: number;
  checkpoints: Array<{id:string;description:string;weight:number;all:string[];dependsOn?:string[];passed:boolean;awarded:number}>;
}

export interface EvaluationAudit {
  version: 1;
  scenarioHash: string;
  axisCoverage?: number;
  runtimeEvaluation?: RuntimeEvaluation;
  graderVersion?: string;
  criterionResults?: CriterionResult[];
  semanticFinalReview?: SemanticFinalReview;
  checkpointEvaluation?: WorkflowCheckpointEvaluation;
  structuredContractMetrics?: StructuredContractMetrics;
  judgeScoreHistory?: number[];
  multiRunStats?: MultiRunStats;
  /** Full independent candidate attempts; parent output is only a representative. */
  attempts?: ScenarioResult[];
}

/** 单题评测结果 */
export interface ScenarioResult {
  scenarioId: string;
  scenarioVersion: string;
  scenarioHash: string;
  dimension: string;

  // 模型输出
  modelOutput: string;
  reasoningContent?: string;
  outputMetadata: OutputMetadata;
  structuredAnswer?: unknown;       // 解析后的结构化输出
  formatParseSuccess: boolean;      // 格式解析是否成功

  // 运行时评估
  runtimeEvaluation?: RuntimeEvaluation;

  // 评分
  axisScores: Record<string, number>;
  /** 各评分轴的证据强度标记（verified/rule/llm/unmeasured），用于报告披露 */
  axisEvidence?: Record<string, AxisEvidence>;
  /** 已测量轴权重占比（0-1）。<0.5 时 judge 未参与则打折、参与则由 AI Judge 补判 */
  axisCoverage?: number;
  totalScore: number;
  criterionResults?: CriterionResult[];
  semanticFinalReview?: SemanticFinalReview;
  checkpointEvaluation?: WorkflowCheckpointEvaluation;
  structuredContractMetrics?: StructuredContractMetrics;
  deterministicScore?: number;
  judgeScore?: number;
  safetyLevel: SafetyLevel;

  // AI Judge
  localJudge?: JudgeResult;
  frontierJudge?: JudgeResult;
  finalJudge?: JudgeResult;
  escalated: boolean;
  /** P0：Judge 集成各次的 judgeScore 序列（runJudgeEnsemble 写入），用于方差分析 */
  judgeScoreHistory?: number[];

  // 多轮统计
  runCount: number;
  scoreHistory: number[];
  verdictHistory: string[];
  multiRunStats?: MultiRunStats;

  // 审计
  graderVersion: string;
  evidence: string[];
  humanReviewRequired: boolean;
  humanReviewNotes?: string;
  /** 代码块提取失败标记 — 模型输出了代码但未使用 Markdown 代码块包裹 */
  codeExtractionFailed?: boolean;
  /** 测试基础设施/环境故障标记（如容器 HOME 权限、dotnet workload 校验失败、
   *  docker daemon 故障）。非模型错误，聚合计算维度均值时必须隔离（不计入）。 */
  environmentError?: boolean;
  /** 评分器提取到的修复 patch（供 Judge 复核，代码修复维度） */
  extractedPatch?: string;
  /** 思考/输出超限标记 — 思考链过长或超出预算被硬性中断（0 分或降权） */
  reasoningLimitExceeded?: boolean;

  // 时间
  startedAt: string;
  finishedAt: string;
}

/** 运行时评估结果 */
export interface RuntimeEvaluation {
  compilePassed: boolean;
  compileError?: string;
  testsPassed: number;
  testsFailed: number;
  testsTotal: number;
  hiddenTestsPassed: number;
  hiddenTestsFailed: number;
  hiddenTestsTotal: number;
  details: TestDetail[];
  runtimeError?: string;
  patchEfficiency?: number;   // 成功修复数 / 修改行数
  /** requiresSandbox 题目：工作区沙箱探查摘要 */
  sandbox?: {
    workspaceFiles: number;
    gitRepos: number;
    exploreSteps: number;
    transcriptChars: number;
  };
}

export interface TestDetail {
  testId?: string;
  testType?: string;
  name?: string;
  category?: 'public' | 'hidden';
  passed: boolean;
  expected?: string;
  actual?: string;
  actualOutput?: string;
  expectedOutput?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  duration?: number;
  timedOut?: boolean;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

// ----- AI Judge（GPT5.6 P2） -----

/** Judge 输入（结构化） */
export interface JudgeInput {
  /** Opt-in shadow policy; legacy runs keep their existing scoring contract. */
  judgeEvidenceContract?: 'criterion_evidence_v1';
  questionId: string;
  task: string;
  dimension?: string;           // 题目维度，用于选择 prompt 模板
  sourceCode?: string;
  requirements: string[];
  expectedAnswer?: unknown;     // 期望答案（数据抽取等维度）
  expectedVerdict?: Verdict;
  bugIntent?: {
    location: string;
    behavior: string;
  };
  candidateAnswer: {
    verdict?: Verdict;
    rootCause?: string;
    patch?: string | null;
    verification?: string[];
  };
  rawModelOutput?: string;      // 模型原始输出（所有维度通用）
  runtimeTests?: {
    compilePassed: boolean;
    passed: number;
    failed: number;
    details: TestDetail[];
  };
  outputMetadata: OutputMetadata;
  /** 代码块提取失败标记 — 模型输出了内容但未使用 Markdown 代码块包裹 */
  codeExtractionFailed?: boolean;
  /** 通用格式盲区标记 — 确定性评分因格式问题给出极低分（非能力问题） */
  formatBlindspot?: boolean;
  /** 每题定制的 Judge 评判提示（来自 Scenario.judgeHint） */
  judgeHint?: string;
}

/** Judge 输出（严格 JSON） */
export interface JudgeResult {
  /** Invocation lineage, retained across tiered/ensemble judgments. No credentials. */
  provenance?: Array<{ policyVersion: string; candidateHash: string; inputHash: string; promptHash: string; responseHash: string; judgeModel: string }>;
  rubricScores?: Record<string, number>;
  scoreEvidence?: Record<string, { kind: 'assertion' | 'omission'; quote?: string; explanation: string }>;
  judgeModel: string;
  verdict: JudgeVerdict;
  bugDetection: number;
  rootCause: number;
  patchCorrectness: number;
  patchCompleteness: number;
  scopeDiscipline: number;
  outputCompleteness: number;
  /** 幻觉抵抗维度专用：事实正确性 0-1（Judge 语义判断，而非规则匹配） */
  factuality?: number;
  confidence: number;
  needsEscalation: boolean;
  evidence: string[];
  notes: string[];
  latencyMs: number;
  tokenUsage: TokenUsage;
}

// ----- 安全红线（GPT5.6 P0-5） -----

export interface SafetyCheckResult {
  level: SafetyLevel;
  violations: SafetyViolation[];
  score: number;
}

export interface SafetyViolation {
  type: string;    // "secret_leak" | "dangerous_operation" | "unauthorized_access" | "injection" | ...
  description: string;
  severity: 'high' | 'medium' | 'low' | 'warning' | 'info';
}

// ----- 运行 Manifest（GPT5.6 P0-6） -----

export interface RunManifest {
  executionIdentityHash?: string;
  judgeIdentityHash?: string;
  benchmarkPack?: BenchmarkPack;
  runId: string;
  timestamp: string;
  timezone: string;
  dataset: {
    name: string;
    version: string;
    commit?: string;
    scenarioHash: string;
  };
  scorers: {
    version: string;
    configHash: string;
  };
  models: ModelRunConfig[];
  judgeModels?: {
    local?: string;
    frontier?: string;
  };
  systemPromptHash?: string;
  toolSchemaHash?: string;
  environment?: {
    nodeVersion: string;
    os: string;
    sandboxVersion?: string;
  };
  metrics: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalLatencyMs: number;
    totalCostUsd: number;
    judgeLatencyMs: number;
    judgeCostUsd: number;
  };
  config: {
    maxTokens: number;
    temperature: number | null;
    runsPerQuestion: number;
    judgeEnabled: boolean;
    escalationEnabled: boolean;
    /**
     * 运行级约束必须随清单冻结（2026-09-16 补）：answerFirst 会让评分器改判答案位置
     * （实测使 reasoning_math 均分相差 8.97 分），hardTimeLimitMs 决定哪些题会被中断判 0。
     * 此前清单只存 5 个键，复现口径不完整。
     */
    constraints?: EvalConstraints;
    /** 影响评分的其余开关，一并冻结以便完整复现 */
    safetyCheckEnabled?: boolean;
    hiddenTestsEnabled?: boolean;
    structuredOutputEnabled?: boolean;
    escalationThreshold?: number;
    judgeModelConfigId?: string | null;
    semanticFinalReviewEnabled?: boolean;
  };
}

export interface ModelRunConfig {
  name: string;
  modelId: string;
  parameters: ModelParams;
  maxTokens: number;
  timeoutSeconds: number;
  retryCount: number;
}

// ----- 评测运行 -----

export interface EvalRun {
  id: string;
  name: string;
  status: EvalRunStatus;
  modelConfigId: string;
  dimensionIds: string[];
  scenarioIds: string[];
  config: EvalRunConfig;
  manifest?: RunManifest;
  results: ScenarioResult[];
  summary?: EvalSummary;
  createdAt: string;
  updatedAt: string;
}

export interface EvalRunConfig {
  difficultyFilter?: Difficulty[];
  dimensionFilter?: string[];
  specialPack?: 'default' | 'mixed' | 'all' | 'migration-189';
  evaluationMode?: 'development' | 'official';
  /** New runs honor actual candidate repeats; legacy runs retain single-attempt behavior. */
  auditVersion?: 1;
  maxTokens: number;
  temperature: number | null;
  runsPerQuestion: number;        // 多轮次数，默认 3
  judgeEnabled: boolean;
  /** 实际生效的 Judge 模型配置 ID（创建时固化，重跑/审计时还原同一 Judge） */
  judgeModelConfigId?: string;
  /** 新运行绑定 Judge 后，独立启用严格执行题的最终答复语义复核。 */
  semanticFinalReviewEnabled?: boolean;
  judgeLocalModel?: string;
  judgeFrontierModel?: string;
  escalationEnabled: boolean;
  escalationThreshold: number;    // 置信度阈值，默认 0.85
  safetyCheckEnabled: boolean;
  hiddenTestsEnabled: boolean;
  structuredOutputEnabled: boolean;
  parallelism?: number;           // 全局并发题目数，默认 4
  parallelMode?: 'global' | 'per_dimension';  // 并行模式: global=全局并发池, per_dimension=维度独立并行, 默认global
  /** 思考/输出约束策略（反拖尾）：先答案后原因、token 上限、硬时间上限、超限处置 */
  constraints?: EvalConstraints;
  /** P0：Judge 集成次数。>1 时对同一候选输出重复判分 K 次取均，降低评分器噪声。
   *  默认 1（单次，与历史行为一致）。仅影响 Judge 调用，不重跑候选模型。 */
  judgeEnsembleRuns?: number;
  /** 题目子集白名单。非空时只评测这些 scenarioId（用于方差基线、分层抽样、快速冒烟）。
   *  随 config 一起落库，因此断点续跑/重跑可还原同一子集，保证实验可复现。 */
  scenarioIds?: string[];
}

// ----- 评测摘要 -----

export interface EvalSummary {
  totalScenarios: number;
  completedScenarios: number;
  failedScenarios: number;
  averageScore: number;
  medianScore: number;
  stdDeviation: number;
  confidenceInterval95: [number, number];
  truncationRate: number;
  formatComplianceRate: number;
  safetyRedLineCount: number;
  escalationCount: number;
  judgeAgreementRate: number;
  verdictStabilityRate: number;

  // 分维度
  dimensionScores: Record<string, DimensionScore>;

  // 成本
  totalCostUsd: number;
  totalLatencyMs: number;
  averageCostPerQuestion: number;
}

export interface DimensionScore {
  score: number;
  completed: number;
  total: number;
  axisScores: Record<string, number>;
  truncationRate: number;
  safetyRedLineCount: number;
}

// ----- 多轮统计（GPT5.6 P1-5） -----

export interface MultiRunStats {
  validRuns?: number;
  environmentErrorCount?: number;
  scores: number[];
  mean: number;
  median: number;
  stdDev: number;
  ci95: [number, number];
  min: number;
  max: number;
  verdictStability: number;
  truncationRate: number;
  runsPerQuestion: number;
  // GPT5.6 P1-2: 新增统计指标
  bootstrapCI?: [number, number];
  passRate?: number;
  failRate?: number;
  redLineRate?: number;
  // A3-8: 多轮一致性分（基于 CV 法），衡量跨 run 稳定性/可复现性，0-100 越高越稳定
  consistencyScore?: number;
  // 兼容旧字段
  scenarioId?: string;
  runs?: number;
  verdicts?: string[];
  scoreMean?: number;
  scoreMedian?: number;
  scoreStdDev?: number;
  scoreMin?: number;
  scoreMax?: number;
  confidenceInterval95?: [number, number];
}

/** Content-addressed, JSON-compatible snapshot. Never includes model credentials. */
export interface BenchmarkPack {
  schemaVersion: 1;
  hash: string;
  scenarios: Scenario[];
}

// ----- API 请求/响应 -----

export interface CreateEvalRunRequest {
  difficultyIds?: Difficulty[];
  name: string;
  modelConfigId: string;
  judgeModelConfigId?: string;   // AI Judge 模型配置 ID
  dimensionIds: string[];
  config: Partial<EvalRunConfig>;
  parentRunId?: string;           // 父运行ID（多维度并行）
  groupName?: string;             // 并行组名
  /** 题目子集白名单，非空时只评测这些 scenarioId（实验用，会固化进 config 便于复现） */
  scenarioIds?: string[];
}

/** 多模型并行评测：一次请求并发启动多个不同模型的评测任务 */
export interface CreateBatchEvalRunRequest {
  difficultyIds?: Difficulty[];
  name?: string;                  // 批量任务名称（各子运行名 = name · 模型名）
  modelConfigIds: string[];       // 多个被测模型配置 ID（并发执行）
  judgeModelConfigId?: string;   // AI Judge 模型配置 ID（共享）
  dimensionIds: string[];         // 维度过滤（所有模型共享）
  config: Partial<EvalRunConfig>; // 共享评测配置
  groupName?: string;             // 并行组名（不传则自动生成）
  /** 题目子集白名单，所有模型共享同一子集（配对实验必须一致） */
  scenarioIds?: string[];
}

/** 批量评测中子运行的信息 */
export interface BatchRunInfo {
  id: string;
  modelConfigId: string;
  name: string;
  status: string;
}

/** 批量评测创建响应 */
export interface CreateBatchEvalRunResponse {
  groupName: string;
  runs: BatchRunInfo[];
  skipped: Array<{ modelConfigId: string; reason: string }>; // 因配置缺失等被跳过的模型
}

/** 批量评测中单个模型的实时/汇总状态 */
export interface BatchRunStatus {
  id: string;
  name: string;
  modelConfigId: string;
  modelName: string;
  status: string;
  total: number;
  completed: number;
  percentage: number;
  dimensionProgress?: DimensionProgress[];
  summary?: {
    averageScore: number;
    dimensionAverages: Record<string, number>;
    passCount: number;
    totalScenarios: number;
    completedScenarios: number;
    durationMs: number | null;
    startedAt: string | null;
    finishedAt: string | null;
  } | null;
  durationMs: number | null;       // 实时：running=now-createdAt，completed=summary.durationMs
  createdAt: string;
  updatedAt: string;
  error?: string;
}

/** 批量评测汇总响应 */
export interface BatchProgressResponse {
  groupName: string;
  totalModels: number;
  completedCount: number;
  runningCount: number;
  failedCount: number;
  // 组级耗时：所有子运行最早开始 ~ 最晚结束
  groupStartedAt: string | null;
  groupFinishedAt: string | null;
  groupDurationMs: number | null;
  runs: BatchRunStatus[];
}

export interface APIResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// ----- 前端状态 -----

/** 单题实时结果摘要 */
export interface QuestionLiveResult {
  scenarioId: string;
  dimension: string;
  difficulty: string;
  language: string;
  totalScore: number;
  safetyLevel: SafetyLevel;
  passed: boolean;           // score >= 60
  /** 环境/测试基础设施故障（harness 故障非模型错误）：该题已隔离，不计入均值 */
  environmentError?: boolean;
  durationMs: number;
  stage: EvalStage;
  error?: string;
  outputTokens?: number;    // 输出 token 数
  inputTokens?: number;     // 输入 token 数
  inferenceMs?: number;     // 候选请求/工具循环耗时（含网络、prefill及循环工具）（毫秒）
  nativeTokensPerSecond?: number; // LM Studio 原生 tokens/s
  tokenSpeed?: number;       // 预计算的 token 生成速度（tokens/s）
}

/** 各维度实时进度 */
export interface DimensionProgress {
  dimension: string;
  total: number;
  completed: number;
  passed: number;            // score >= 60
  failed: number;            // score < 60
  redLine: number;           // safetyLevel === 'red_line'
  avgScore: number;
  scores: number[];
}

/** 评测阶段 */
export type EvalStage =
  | 'queued'
  | 'initializing'
  | 'calling_model'
  | 'building_metadata'
  | 'parsing_output'
  | 'deterministic_scoring'
  | 'safety_check'
  | 'ai_judge'
  | 'reasoning_limit'
  | 'environment_error'
  | 'completed'
  | 'failed';

export interface EvalProgress {
  pauseReason?: string;
  runId: string;
  status: EvalRunStatus;
  total: number;
  completed: number;
  percentage: number;
  eta?: number;
  tokensPerSecond?: number;       // 实时 token 速度（tokens/s）
  totalTokens?: number;           // 累计处理的 token 总数

  // 当前正在测试的题目详情（单值，兼容旧版）
  currentScenarioId?: string;
  currentDimension?: string;
  currentCategory?: string;
  currentDifficulty?: string;
  currentLanguage?: string;
  currentPromptPreview?: string;   // prompt 前 200 字符
  currentStage?: EvalStage;

  // 并行测试：每个维度的当前题目信息（key = scenarioId，避免同维度并发覆盖）
  currentScenarios?: Record<string, {
    scenarioId: string;
    dimension: string;
    category?: string;
    difficulty?: string;
    language?: string;
    promptPreview?: string;
    stage: string;
  }>;

  // 各维度进度
  dimensionProgress?: DimensionProgress[];

  // 并行测试中正在活跃的维度列表
  activeDimensions?: string[];

  // 最近完成的结果（按完成时间倒序，最多 50 条）
  recentResults?: QuestionLiveResult[];

  // 兼容旧字段
  current?: string;
}

// ----- 格式专用解析器（GPT5.6 结构化输出） -----

export type FormatType = 'json' | 'yaml' | 'csv' | 'xml' | 'sql' | 'html' | 'mermaid' | 'markdown' | 'toml' | 'ics' | 'regex';

export interface FormatParseResult {
  format: string;
  success: boolean;
  parsed?: unknown;
  violations: FormatViolation[];
  /** 实际执行到的 schema 约束断言数（用于把 schema 轴按覆盖率折算计分，而非一刀切扣分） */
  schemaChecks?: number;
  // 兼容旧字段
  parseable?: boolean;
  schemaValid?: boolean;
  constraintsValid?: boolean;
  crossFieldConsistent?: boolean;
  executable?: boolean;
  disciplineScore?: number;
  canonicalObject?: unknown;
}

export interface FormatViolation {
  type: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  // 兼容旧字段
  path?: string;
  rule?: string;
  actual?: unknown;
  expected?: unknown;
}

// ----- 参数化题目（GPT5.6 反污染） -----

export interface ParameterizedScenario {
  template: Scenario;
  variables: Record<string, ParameterVariable>;
  instantiatedPrompt: string;
  instantiationSeed: string;
}

export interface ParameterVariable {
  name: string;
  type: 'person_name' | 'company_name' | 'city_name' | 'number' | 'date' | 'id' | 'color' | 'string';
  description?: string;
  min?: number;
  max?: number;
  yearRange?: [number, number];
  values?: string[];
  // 兼容旧字段
  generator?: string;
  value?: string | number;
}

// ----- Scenario contracts (Phase 1: single per-grader contract) -----

/** Capabilities declared by a grader contract (supported format/language/response mode). */
export interface ScenarioCapabilities {
  supportedFormats?: string[];
  supportedLanguages?: string[];
  /** Languages that can be truly executed in an isolated environment (others are static/keyword-scored). */
  executableLanguages?: string[];
  supportedResponseModes?: ("plan" | "simulated_actions" | "live_execution" | "raw_output")[];
  requiresSandbox?: boolean;
}

/** A contract validation issue (error blocks official eligibility; warning = migration/governance hint). */
export interface ContractValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  path?: string;
}

/** Per-scenario contract validation report. */
export interface ValidationReport {
  scenarioId: string;
  grader: string;
  graderVersion: string;
  eligible: boolean;
  errors: ContractValidationIssue[];
  warnings: ContractValidationIssue[];
}

/** Official eligibility gate result. */
export interface ScenarioEligibility {
  eligible: boolean;
  reasons: string[];
}
