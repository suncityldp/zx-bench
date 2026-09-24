import type { OutputMetadata, Scenario, ScenarioResult } from '@zxbench/types';
import type { Evaluator } from './index.js';
import { buildEvidenceExam, gradePart as gradeEvidencePart } from '../evaluationLab/evidenceExam/index.js';
import { buildExamPaper, gradePart as gradeMathPart, paperSourceIdentity, paperSourceVersion } from '../evaluationLab/examExpansion/index.js';
import { differsOnlyByHardTimeLimit } from '../evaluationLab/questionHashCompatibility.js';

// 2026-09-16（R3）：**不再在模块加载时固化评卷表**。
// 旧实现 `const mathParts = new Map(buildExamPaper().parts...)` 会把进程启动那一刻的
// 评卷表钉死；一旦题库（题面/评分项 key）更新而进程没重启，提交就会以「未知评分项」
// 被静默丢弃并判 0 —— 实测一次回归因此得出「5/12 题 0 分」的假结论。
// 现在每次评分解析一次（buildExamPaper 内部按文件 sha256 自动重载），并加一道
// fail-closed 一致性守卫：题库记录的 questionHash 与已加载评卷表不一致时，
// **判为环境错误（不计分、不静默判 0）**，并在证据里直接写明要重启服务。
function resolvePart(id: string): { part: ReturnType<typeof buildExamPaper>['parts'][number] | ReturnType<typeof buildEvidenceExam>['parts'][number]; kind: 'math' | 'evidence' } | null {
  const math = buildExamPaper().parts.find((p) => p.id === id);
  if (math) return { part: math, kind: 'math' };
  const evidence = buildEvidenceExam().parts.find((p) => p.id === id);
  if (evidence) return { part: evidence, kind: 'evidence' };
  return null;
}

export const ultraBatchPartEvaluator: Evaluator = {
  name: 'ultra_batch_part',
  version: '1.0.0',
  async evaluate(scenario: Scenario, modelOutput: string, _metadata: OutputMetadata): Promise<Partial<ScenarioResult>> {
    const resolved = resolvePart(scenario.id);
    if (!resolved) throw new Error(`Unknown ultra-batch part: ${scenario.id}`);
    const { part, kind } = resolved;

    // ---- 评卷表一致性守卫（fail-closed）----
    const recorded = (scenario.requirements as { questionHash?: unknown } | undefined)?.questionHash;
    const currentPrompt = part.question.messages.length === 1 && part.question.messages[0].role === 'user'
      ? part.question.messages[0].content : '';
    const safeLegacyTimeLimit = scenario.dimension === part.question.dimension
      && typeof scenario.promptTemplate === 'string'
      && differsOnlyByHardTimeLimit(scenario.promptTemplate, currentPrompt);
    if (typeof recorded === 'string' && recorded.length > 0
      && recorded !== part.question.questionHash && !safeLegacyTimeLimit) {
      return {
        axisScores: {},
        axisEvidence: {},
        axisCoverage: 0,
        totalScore: 0,
        environmentError: true,
        humanReviewRequired: true,
        safetyLevel: 'safe',
        evidence: [
          `STALE_GRADER_PAPER: 题库记录的 questionHash=${recorded.slice(0, 12)}… 与已加载评卷表 `
          + `${part.question.questionHash.slice(0, 12)}…（${paperSourceVersion()} / ${paperSourceIdentity()}）不一致。`,
          `题面与评分项可能已更新但进程仍持有旧评卷表 —— 判分不可信，已按环境错误隔离（不计入均分）。`
          + `请重启服务后重跑；若重启后仍报此错，说明题库未按当前评卷表重新播种。`,
        ],
      };
    }

    const result = kind === 'evidence'
      ? gradeEvidencePart(part as ReturnType<typeof buildEvidenceExam>['parts'][number], modelOutput)
      : gradeMathPart(part as ReturnType<typeof buildExamPaper>['parts'][number], modelOutput);
    const score = Math.round(100 * result.earned / result.points);
    return {
      totalScore: score,
      deterministicScore: score,
      axisScores: { progressive_part: score },
      axisCoverage: 1,
      axisEvidence: { progressive_part: 'rule' },
      evidence: [`PROGRESSIVE_PART: earned=${result.earned}/${result.points}`],
      formatParseSuccess: result.rejectedRecords === 0 && !result.incompleteTail,
    };
  },
};

/**
 * UMX（ultra_proof_part）**不可用普通 run 路径评分** —— 2026-09-17 核查结论。
 *
 * 本评分器**故意**恒返回 `totalScore: 0` + `evidence: ['PROOF_REQUIRES_RUBRIC_JUDGE']`，
 * 表示「证明题必须由 rubric 逐条判分」。但 `scoreUltraMathRubric`
 * （`evaluationLab/ultraMathRubric.ts`）**全仓只被测试引用，没有任何执行路径**，
 * `ULTRA_MATH_RUBRICS` 的 criteria 在运行期也从不被消费。
 *
 * ⇒ 走普通 run 时，确定性分恒为 0、而 orchestrator 会让**通用 LLM judge** 接手，
 *   其判分轴是 `judge_bug_detection` / `judge_root_cause` / `judge_patch_correctness` /
 *   `judge_scope_discipline` / `judge_output_completeness`（与 UMX 的 criteria 毫无关系）
 *   ⇒ **只要模型产出了非空文本就会拿 ~100 分**；无输出则恒 0。两种分数都不携带信息。
 *
 * **判据（排查同类问题用）**：`axisScores` 为空 + `evidence` 含 `PROOF_REQUIRES_RUBRIC_JUDGE`
 * + `axisEvidence` 出现 `judge_*` 轴 ⇒ 这题在当前路径下没有被真正评分，
 * 不要用它得到的任何分数（包括满分）做结论。
 *
 * 因此 UMX 八题在题库里标了 `requirements.developmentShadow = true` +
 * `scoringPath: 'explicit_progressive_exam'`（见 `scripts/mark-umx-not-atomically-scoreable.mjs`），
 * 与 `docs/ultra-math-exam-manifest.json` 声明的 `defaultAtomicBank: false` 对齐。
 * 若要恢复自动评分，需要先让 judge 产出 `UltraPartReview`（逐 criteria 的 awarded + evidence），
 * 那是新的设计工作，不是接线。
 */
export const ultraProofPartEvaluator: Evaluator = {
  name: 'ultra_proof_part',
  version: '1.0.0',
  async evaluate(_scenario: Scenario, modelOutput: string): Promise<Partial<ScenarioResult>> {
    const submitted = modelOutput.trim().length > 0;
    return {
      totalScore: 0,
      deterministicScore: 0,
      axisScores: {},
      axisCoverage: 0,
      axisEvidence: {},
      evidence: [submitted ? 'PROOF_REQUIRES_RUBRIC_JUDGE' : 'NO_ANSWER_SUBMITTED'],
      formatParseSuccess: submitted,
    };
  },
};
