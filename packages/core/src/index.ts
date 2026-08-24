// ============================================================
// @zxbench/core — 评测引擎核心
// ============================================================

// 模型调用
export { callModel, callModelWithRetry } from './model/index.js';
export type { CallModelOptions } from './model/index.js';

// AI Judge
export { runTieredJudge, shouldEscalate } from './judge/index.js';
export type { JudgeOptions } from './judge/index.js';
export { JUDGE_SYSTEM_PROMPT, getJudgeSystemPrompt, buildJudgeUserPrompt } from './judge/prompts.js';

// 安全红线
export { checkSafetyRedLines } from './safety/index.js';

// 评分器
export { registerEvaluator, getEvaluator, listEvaluators } from './evaluators/index.js';
export type { Evaluator } from './evaluators/index.js';
export { bugFindingEvaluator } from './evaluators/bugFinding.js';
export { codeRepairEvaluator } from './evaluators/codeRepair.js';
export { projectRepairEvaluator } from './evaluators/projectRepair.js';
export { structuredOutputEvaluator } from './evaluators/structuredOutput.js';
export { dataExtractionEvaluator } from './evaluators/dataExtraction.js';
export { exactAnswerLineEvaluator } from './evaluators/exactAnswerLine.js';
export { instructionChecklistEvaluator } from './evaluators/instructionChecklist.js';
export { canaryAuthorityEvaluator } from './evaluators/canaryAuthority.js';
export { toolCallTraceEvaluator } from './evaluators/toolCallTrace.js';
export { agentTraceEvaluator } from './evaluators/agentTrace.js';
export { cliCommandEvaluator, registerCLISandboxRunner, getRegisteredCLISandboxRunner, extractPrimaryCommand, canonicalizeCliFlags } from './evaluators/cliCommand.js';
export type { CLISandboxRunner, CLISandboxResult } from './evaluators/cliCommand.js';
export { LocalCLISandboxRunner } from './evaluators/cliSandbox.js';
export type { LocalCLISandboxRunnerOptions } from './evaluators/cliSandbox.js';
export { registerToolCatalog, getRegisteredToolCatalog, validateToolCall } from './evaluators/toolCatalog.js';
export type { ToolCatalog, ToolSpec, ToolParamSpec, ToolCallValidation } from './evaluators/toolCatalog.js';
export { hallucinationResistanceEvaluator } from './evaluators/hallucinationResistance.js';
export { sandboxEvaluator } from './evaluators/sandbox.js';
export { llmJudgeEvaluator } from './evaluators/llmJudge.js';

// 沙箱执行
export { runInSandbox, runTestCase, runTestSuite, runReplacedCodeTest, runReplacedCodeTestPython, runTestCaseInContainer, runReplacedCodeTestPythonInContainer } from './sandbox/index.js';
export type { SandboxResult, SandboxOptions } from './sandbox/index.js';

// 隐藏测试
export { runHiddenTests, runPublicTests, summarizeTestResults, calculateTestScore, generateTestTemplate } from './hidden-tests/index.js';
export type { TestSuiteResult } from './hidden-tests/index.js';

// 格式解析器
export { parseJSON, parseCSV, parseXML, parseSQL, parseHTML, parseYAML, parseRegex, parseMermaid, parseMarkdown, parseTOML, parseByFormat } from './parsers/index.js';
export type { SupportedFormat } from './parsers/index.js';

// 编排器
export { orchestrateEvaluation, generateManifest } from './orchestrator.js';
export type { OrchestrateOptions } from './orchestrator.js';

// 多轮稳定性评测
export { runMultipleEvaluations, batchMultiRunEvaluation } from './multi-run/index.js';
export type { MultiRunOptions } from './multi-run/index.js';

// 报告生成
export { generateReport, generateCompareReport } from './report/index.js';
export type { GenerateReportOptions, GenerateCompareReportOptions, ReportResult } from './report/index.js';
export {
  REPORT_SYSTEM_PROMPT,
  COMPARE_REPORT_SYSTEM_PROMPT,
  buildReportUserPrompt,
  buildCompareReportUserPrompt,
} from './report/prompts.js';
export type { ReportUserPromptData, CompareReportUserPromptData } from './report/prompts.js';

// 参数化题目引擎
export { generateVariables, instantiateScenario, createParameterizedInstance } from './parameterize/index.js';
// 评分/聚合核心
export { DIMENSION_WEIGHTS, DIFFICULTY_WEIGHTS, ATTACK_WEIGHTS, LONG_TASK_WEIGHT, TARGET_DIFFICULTY_DISTRIBUTION, analyzeDifficultyDistribution, computeWeightedTotal, getJudgeWeights, mixDeterministicJudge, applyCoverageDiscount, computeConsistencyScore, computeDifficultyWeightedDimAvgs, normalizeDimension, DIMENSION_ALIASES } from './scoring.js';

// 场景契约（Phase 1）
export { GRADER_CONTRACTS, getGraderContract, listGraderContracts, validateScenario, canonicalizeScenario, hashScenario, hashScenarioShort, checkScenarioEligibility, partitionByEligibility, DIMENSION_DEFINITIONS, recommendDimension, validateDimensionDisjointness } from './contracts/index.js';
export type { GraderContract } from './contracts/index.js';

// 容器执行后端（Phase 2）
export { runInContainer, isDockerAvailable, getImageDigest, CONTAINER_IMAGES, buildGoTestHarness, runGoTestsInContainer, runGoProgramInContainer, buildJavaHarness, runJavaTestsInContainer, buildCHarness, runCTestsInContainer, runCppTestsInContainer, runCppTsanInContainer, buildRustHarness, runRustTestsInContainer, runRustMiriInContainer, buildPhpHarness, runPhpTestsInContainer, buildCsharpHarness, runCsharpTestsInContainer, buildSqlHarness, runSqlInContainer, buildBashHarness, runBashTestsInContainer, runTypeScriptTypeCheck } from './execution/index.js';
export type { ContainerRunOptions, ContainerRunResult, ContainerFile, TypeCheckCase, TypeCheckResult, RustMiriResult } from './execution/index.js';
