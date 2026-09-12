// ============================================================
// @zxbench/core — 评测引擎核心
// ============================================================

// 模型调用
export { callModel, callModelWithRetry } from './model/index.js';
export type { CallModelOptions } from './model/index.js';

// AI Judge
export { runTieredJudge, shouldEscalate, runJudgeEnsemble, computeJudgeScore } from './judge/index.js';
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
export { attachEvaluationAudit, summarizeCriteria } from './audit.js';
export { calibrationSplit, normalizeReviewer, validateCalibrationReview, summarizeCalibration, validateReviewTransition, sampleCalibrationCandidates } from './calibration.js';
export { analyzeRubricQuality } from './rubricQA.js';
// Read-only, opt-in capability lab inspection; does not alter production grading.
export { inspectCapabilitySubmission } from './evaluationLab/capabilityInspection.js';
export type { InspectionKind, ClaimReviewAttachment } from './evaluationLab/capabilityInspection.js';
export { confirmProbabilityComparison } from './evaluationLab/probabilityConfirmation.js';
export type { ProbabilityTrial } from './evaluationLab/probabilityConfirmation.js';
export { observedDiscrimination } from './evaluationLab/observedDiscrimination.js';
export type { ObservedDimensionModel } from './evaluationLab/observedDiscrimination.js';
export { judgeRoleEvidence } from './evaluationLab/judgeRoleEvidence.js';
export type { BoundedJudgeControl, BoundedJudgeRealSignal } from './evaluationLab/judgeRoleEvidence.js';
export { buildLatentCensoringProbability, latentCensoringReference, verifyLatentCensoring, scoreLatentCensoring } from './evaluationLab/latentCensoringProbability.js';
export type { LatentCensoringProblem, LatentCensoringCase } from './evaluationLab/latentCensoringProbability.js';
export { buildEvidenceMatrix, evidenceMatrixReference, verifyEvidenceMatrix, scoreEvidenceMatrix } from './evaluationLab/evidenceMatrix.js';
export type { EvidenceMatrixGold, EvidenceMatrixCase } from './evaluationLab/evidenceMatrix.js';
export { buildEvidenceLedger, evidenceLedgerReference, verifyEvidenceLedger, scoreEvidenceLedger } from './evaluationLab/evidenceLedgerV13.js';
export type { EvidenceLedgerGold, EvidenceLedgerCase } from './evaluationLab/evidenceLedgerV13.js';
export { buildEvidenceLedgerV14, evidenceLedgerV14Reference, verifyEvidenceLedgerV14, scoreEvidenceLedgerV14 } from './evaluationLab/evidenceLedgerV14.js';
export { buildEvidenceLedgerV15, evidenceLedgerV15Reference, verifyEvidenceLedgerV15, scoreEvidenceLedgerV15 } from './evaluationLab/evidenceLedgerV15.js';
export type { EvidenceLedgerV15Gold, EvidenceLedgerV15Case } from './evaluationLab/evidenceLedgerV15.js';
export { buildEvidenceLedgerV16, evidenceLedgerV16Reference, verifyEvidenceLedgerV16, scoreEvidenceLedgerV16 } from './evaluationLab/evidenceLedgerV16.js';
export type { EvidenceLedgerV16Gold, EvidenceLedgerV16Case } from './evaluationLab/evidenceLedgerV16.js';
export { buildEvidenceLedgerV17, evidenceLedgerV17Reference, verifyEvidenceLedgerV17, scoreEvidenceLedgerV17 } from './evaluationLab/evidenceLedgerV17.js';
export type { EvidenceLedgerV17Gold, EvidenceLedgerV17Case } from './evaluationLab/evidenceLedgerV17.js';
export { buildEvidenceLedgerV18, evidenceLedgerV18Reference, verifyEvidenceLedgerV18, scoreEvidenceLedgerV18 } from './evaluationLab/evidenceLedgerV18.js';
export type { EvidenceLedgerV18Gold, EvidenceLedgerV18Case } from './evaluationLab/evidenceLedgerV18.js';
export { DIMENSION_EVALUATION_POLICY_V1, routeDimensionEvaluation, isRetiredJudgeModel } from './evaluationLab/dimensionEvaluationPolicyV1.js';
export type { EvaluationRouteInput } from './evaluationLab/dimensionEvaluationPolicyV1.js';
export { buildHardApiControlPlan, hardApiBody, gradeHardApi } from './evaluationLab/hardApiControlPlan.js';
export { checkRegression, parseRegressionExport } from './regression.js';
export type { RegressionRun } from './regression.js';
export { createBenchmarkPack, verifyBenchmarkPack, snapshotHash } from './contracts/pack.js';

// 报告生成
export { analyzeRunQuality } from './quality.js';
export { referenceAnswerWarnings, partitionReferenceAnswerRuns } from './referenceAnswerReview.js';
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
export { DIMENSION_WEIGHTS, DIFFICULTY_WEIGHTS, ATTACK_WEIGHTS, LONG_TASK_WEIGHT, JUDGE_WEIGHT_CAP, TARGET_DIFFICULTY_DISTRIBUTION, analyzeDifficultyDistribution, computeWeightedTotal, getJudgeWeights, applyReviewedVerdict, mixDeterministicJudge, applyCoverageDiscount, computeConsistencyScore, computeDifficultyWeightedDimAvgs, normalizeDimension, DIMENSION_ALIASES } from './scoring.js';

// 场景契约（Phase 1）
export { GRADER_CONTRACTS, getGraderContract, listGraderContracts, validateScenario, canonicalizeScenario, hashScenario, hashScenarioShort, checkScenarioEligibility, partitionByEligibility, DIMENSION_DEFINITIONS, recommendDimension, validateDimensionDisjointness } from './contracts/index.js';
export type { GraderContract } from './contracts/index.js';

// 容器执行后端（Phase 2）
export { runInContainer, isDockerAvailable, getImageDigest, CONTAINER_IMAGES, buildGoTestHarness, runGoTestsInContainer, runGoProgramInContainer, buildJavaHarness, runJavaTestsInContainer, buildCHarness, runCTestsInContainer, runCppTestsInContainer, runCppTsanInContainer, buildRustHarness, runRustTestsInContainer, runRustMiriInContainer, buildPhpHarness, runPhpTestsInContainer, buildCsharpHarness, runCsharpTestsInContainer, buildSqlHarness, runSqlInContainer, buildBashHarness, runBashTestsInContainer, runTypeScriptTypeCheck } from './execution/index.js';
export { DOCKER_NOT_READY, isDockerInfrastructureFailure } from './execution/dockerReadiness.js';
export type { ContainerRunOptions, ContainerRunResult, ContainerFile, TypeCheckCase, TypeCheckResult, RustMiriResult } from './execution/index.js';
