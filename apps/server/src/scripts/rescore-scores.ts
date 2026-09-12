/**
 * 历史数据离线重算脚本（评分契约重构后）
 * 用新评分器对已保存的 modelOutput 重新评分，无需重新调用模型。
 * 沙箱测试（JS/TS patch 验证、编译检查）会在重算时重新执行。
 *
 * 运行:
 *   cd apps/server
 *   npx tsx src/scripts/rescore-scores.ts
 *   # 可选环境变量:
 *   #   RESCORE_LIMIT=100  只重算最近 100 条
 *   #   RESCORE_DIM=program 只重算指定维度
 *   #   DRY_RUN=1          只预览不写库
 */
import { PrismaClient } from '@prisma/client';
import {
  getEvaluator, registerEvaluator,
  bugFindingEvaluator, codeRepairEvaluator, structuredOutputEvaluator,
  dataExtractionEvaluator, exactAnswerLineEvaluator, instructionChecklistEvaluator,
  canaryAuthorityEvaluator, toolCallTraceEvaluator, agentTraceEvaluator, cliCommandEvaluator,
  projectRepairEvaluator, hallucinationResistanceEvaluator, sandboxEvaluator, llmJudgeEvaluator,
} from '@zxbench/core';
import type { Scenario, Difficulty, QuestionStatus, ScenarioTier, Verdict, OutputPolicy } from '@zxbench/types';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ===== 注册评分器（与 apps/server/src/index.ts 启动逻辑一致） =====
registerEvaluator(bugFindingEvaluator);
registerEvaluator(codeRepairEvaluator);
registerEvaluator(projectRepairEvaluator);
registerEvaluator(structuredOutputEvaluator);
registerEvaluator(dataExtractionEvaluator);
registerEvaluator(exactAnswerLineEvaluator);
registerEvaluator(instructionChecklistEvaluator);
registerEvaluator(canaryAuthorityEvaluator);
registerEvaluator(toolCallTraceEvaluator);
registerEvaluator(agentTraceEvaluator);
registerEvaluator(cliCommandEvaluator);
registerEvaluator(hallucinationResistanceEvaluator);
registerEvaluator(sandboxEvaluator);
registerEvaluator(llmJudgeEvaluator);

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

// ===== det/judge 权重（与 orchestrator getJudgeWeights 保持一致） =====
function getJudgeWeights(dimension: string, grader: string): { deterministic: number; judge: number } {
  if (dimension === 'data_extraction' || grader === 'json_atomic_fields') return { deterministic: 1.0, judge: 0.0 };
  if (dimension === 'safety_authority') return { deterministic: 1.0, judge: 0.0 };
  if (dimension === 'structured_output' || grader === 'schema_compliance') return { deterministic: 0.9, judge: 0.1 };
  if (dimension === 'reasoning_math') return { deterministic: 0.95, judge: 0.05 };
  if (dimension === 'program' || grader === 'code_repair') return { deterministic: 0.8, judge: 0.2 };
  if (dimension === 'bug_finding' || grader === 'bug_finding') return { deterministic: 0.4, judge: 0.6 };
  if (dimension === 'instruction_following' || grader === 'instruction_checklist') return { deterministic: 0.5, judge: 0.5 };
  if (dimension === 'agent_workflow' || grader === 'agent_trace') return { deterministic: 0.7, judge: 0.3 };
  if (dimension === 'tool_cli_workflow' || grader === 'tool_call_trace') return { deterministic: 0.7, judge: 0.3 };
  if (dimension === 'cli_deep_tasks' || grader === 'cli_command') return { deterministic: 0.5, judge: 0.5 };
  return { deterministic: 0.6, judge: 0.4 };
}

// ===== DB 行 → Scenario =====
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deserializeScenario(row: any): Scenario {
  return {
    id: row.id,
    dimension: row.dimension,
    category: row.category,
    difficulty: row.difficulty as Difficulty,
    language: row.language,
    locale: row.locale,
    status: row.status as QuestionStatus,
    tier: (row.tier || 'public_dev') as ScenarioTier,
    promptTemplate: row.promptTemplate,
    sourceCode: row.sourceCode ?? undefined,
    functionName: row.functionName ?? undefined,
    expectedVerdict: (row.expectedVerdict ?? undefined) as Verdict | undefined,
    grader: row.grader,
    graderVersion: row.graderVersion,
    scoring: JSON.parse(row.scoring),
    hiddenTests: row.hiddenTests ? JSON.parse(row.hiddenTests) : undefined,
    requirements: row.requirements ? JSON.parse(row.requirements) : undefined,
    tags: row.tags ? JSON.parse(row.tags) : undefined,
    scenarioVersion: row.scenarioVersion,
    scenarioHash: row.scenarioHash,
    outputPolicy: (row.outputPolicy ?? undefined) as OutputPolicy | undefined,
    answerFirst: row.answerFirst ?? undefined,
    maxAnswerTokens: row.maxAnswerTokens ?? undefined,
    maxReasoningTokens: row.maxReasoningTokens ?? undefined,
  };
}

async function main() {
  const limit = process.env.RESCORE_LIMIT ? parseInt(process.env.RESCORE_LIMIT, 10) : undefined;
  const dimFilter = process.env.RESCORE_DIM;
  const dryRun = process.env.DRY_RUN === '1';
  // 强制重算已带证据标记的结果（评分器契约升级后需全量刷新）
  const force = process.env.RESCORE_FORCE === '1';

  console.log('=== 历史结果离线重算（新评分契约）===\n');

  const results = await prisma.scenarioResult.findMany({
    orderBy: { finishedAt: 'desc' },
    take: limit,
  });
  console.log(`待重算 ${results.length} 条${dryRun ? '（DRY-RUN，不写库）' : ''}\n`);

  let updated = 0;
  let skipped = 0;
  let changed = 0;

  for (const r of results) {
    if (dimFilter && r.dimension !== dimFilter) { skipped++; continue; }

    // 已带证据标记的默认跳过（分数与证据均为最新，避免重复沙箱测试耗时）；RESCORE_FORCE=1 时强制重算
    if (r.axisEvidence && !force) { skipped++; continue; }

    const sd = await prisma.scenarioDefinition.findUnique({ where: { id: r.scenarioId } });
    if (!sd) { skipped++; continue; }

    const evaluator = getEvaluator(sd.grader, sd.graderVersion);
    if (!evaluator) {
      console.log(`  [跳过] ${r.scenarioId} 无评分器 ${sd.grader}@${sd.graderVersion}`);
      skipped++;
      continue;
    }

    let outputMetadata;
    try { outputMetadata = JSON.parse(r.outputMetadata); } catch { outputMetadata = {}; }

    try {
      const scenario = deserializeScenario(sd);
      const det = await evaluator.evaluate(scenario, r.modelOutput, outputMetadata);

      const newDet = det.totalScore ?? r.totalScore;
      const weights = getJudgeWeights(scenario.dimension, scenario.grader);
      // judge 合并：覆盖率感知（与 orchestrator 一致）——未测量轴由 judge 补判 / 无 judge 时打折
      const coverage = det.axisCoverage ?? 1;
      const finalTotal = (r.judgeScore != null && weights.judge > 0)
        ? Math.round(newDet * weights.deterministic * coverage
            + r.judgeScore * (weights.judge + weights.deterministic * (1 - coverage)))
        : (coverage >= 0.5 ? newDet : Math.round(newDet * 0.3));

      // 证据标记兜底：未显式标注的轴默认视为 rule（与 orchestrator 行为一致）
      const axisScoresOut = det.axisScores || {};
      const axisEvidenceOut = {
        ...(det.axisEvidence || {}),
        ...Object.fromEntries(
          Object.keys(axisScoresOut)
            .filter((k) => !det.axisEvidence || det.axisEvidence[k] == null)
            .map((k) => [k, 'rule']),
        ),
      };

      const oldTotal = r.totalScore;
      const diffMark = finalTotal !== oldTotal ? '⚠️' : '·';
      console.log(`  [${diffMark}] ${r.scenarioId}  ${oldTotal} → ${finalTotal} (det=${newDet}${r.judgeScore != null ? `, judge=${r.judgeScore}` : ''})`);

      if (finalTotal !== oldTotal) changed++;

      if (!dryRun) {
        await prisma.scenarioResult.update({
          where: { id: r.id },
          data: {
            totalScore: finalTotal,
            deterministicScore: newDet,
            axisScores: JSON.stringify(axisScoresOut),
            axisEvidence: JSON.stringify(axisEvidenceOut),
          },
        });
      }
      updated++;
    } catch (err) {
      console.log(`  [错误] ${r.scenarioId}: ${err instanceof Error ? err.message : String(err)}`);
      skipped++;
    }
  }

  console.log(`\n=== 完成！更新 ${updated} 条，跳过 ${skipped} 条，分数变化 ${changed} 条 ===`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
