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
export { structuredOutputEvaluator } from './evaluators/structuredOutput.js';
export { dataExtractionEvaluator } from './evaluators/dataExtraction.js';
export { exactAnswerLineEvaluator } from './evaluators/exactAnswerLine.js';
export { instructionChecklistEvaluator } from './evaluators/instructionChecklist.js';
export { canaryAuthorityEvaluator } from './evaluators/canaryAuthority.js';
export { toolCallTraceEvaluator } from './evaluators/toolCallTrace.js';
export { agentTraceEvaluator } from './evaluators/agentTrace.js';
export { cliCommandEvaluator } from './evaluators/cliCommand.js';
export { hallucinationResistanceEvaluator } from './evaluators/hallucinationResistance.js';

// 沙箱执行
export { runInSandbox, runTestCase, runTestSuite } from './sandbox/index.js';
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
export { DIMENSION_WEIGHTS, DIFFICULTY_WEIGHTS, computeWeightedTotal, getJudgeWeights, mixDeterministicJudge, applyCoverageDiscount, computeDifficultyWeightedDimAvgs } from './scoring.js';

// 场景契约（Phase 1）
export { GRADER_CONTRACTS, getGraderContract, listGraderContracts, validateScenario, canonicalizeScenario, hashScenario, hashScenarioShort, checkScenarioEligibility, partitionByEligibility } from './contracts/index.js';
export type { GraderContract } from './contracts/index.js';
