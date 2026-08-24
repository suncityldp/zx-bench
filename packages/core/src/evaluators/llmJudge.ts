// ============================================================
// llm_judge 评分器 v1 —— PR 评审质量判定（PR-ELITE-012/013）。
// 判定方式：模型输出（结构化评审）与 judge_ground_truth 的确定性匹配。
// 轴（rubric）：critical_findings_recall / severity_accuracy /
//   false_positive_control / actionable_feedback / diff_coverage。
// 匹配：ground_truth 每条 finding 提供 file|area + keywords，
//   在模型输出中做「文件/关键词命中 + 邻近严重级别」判定。
// ============================================================

import type { Scenario, ScenarioResult, OutputMetadata, ModelResponse, AxisEvidence, ModelConfig } from '@zxbench/types';
import type { Evaluator } from './index.js';
import { callModel } from '../model/caller.js';

interface GroundTruthFinding {
  id: string;
  file?: string;
  area?: string;
  severity: string; // critical|high|medium|low|nit
  finding: string;
  isFP?: boolean;
  keywords?: string[];
}

interface LlmJudgeRequirements {
  prompt?: string;
  diff?: string;
  judge_config?: { rubric_version?: string; temperature?: string | number; require_structured_output?: string | boolean };
  judge_ground_truth?: GroundTruthFinding[];
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'nit'];
const SEV_RE = /\b(critical|high|medium|low|nit)\b/gi;

const DEFAULT_WEIGHTS: Record<string, number> = {
  critical_findings_recall: 30,
  severity_accuracy: 20,
  false_positive_control: 20,
  actionable_feedback: 15,
  diff_coverage: 15,
};

function normalizeSeverity(s: string): string {
  const t = s.trim().toLowerCase();
  if (SEVERITY_ORDER.includes(t)) return t;
  return t;
}

/** 从 finding 描述派生关键词（未显式提供时） */
function deriveKeywords(f: GroundTruthFinding): string[] {
  const kws: string[] = [];
  if (f.keywords && f.keywords.length) kws.push(...f.keywords);
  if (f.file) {
    kws.push(f.file);
    const base = f.file.split('/').pop() || '';
    if (base) kws.push(base.replace(/\.\w+$/, ''));
  }
  if (f.area) kws.push(f.area);
  return [...new Set(kws.map(k => k.toLowerCase()))];
}

/** 在输出中定位某关键词的命中位置（返回首个位置，未命中 -1） */
function findKeyword(output: string, kw: string): number {
  return output.toLowerCase().indexOf(kw.toLowerCase());
}

/** 在关键词命中位置 ±100 字符窗口内取最近的严重级别词 */
function severityAround(output: string, pos: number): string | null {
  if (pos < 0) return null;
  const start = Math.max(0, pos - 100);
  const win = output.slice(start, Math.min(output.length, pos + 100)).toLowerCase();
  const center = pos - start;
  const ms = [...win.matchAll(SEV_RE)];
  if (!ms.length) return null;
  let best = ms[0];
  let bestDist = Infinity;
  for (const m of ms) {
    const d = Math.abs((m.index ?? 0) - center);
    if (d < bestDist) { bestDist = d; best = m; }
  }
  return best[0];
}

/** 用 Judge 模型评估「修复建议可落地程度」（0-100）。失败返回 null 以回退启发式。 */
async function judgeActionableWithLLM(
  modelOutput: string,
  gt: GroundTruthFinding[],
  judgeModel: ModelConfig,
): Promise<number | null> {
  try {
    const systemPrompt = '你是资深 PR 评审裁判。请评估评审意见中修复建议的质量。只输出 JSON：{"score": 0-100 整数, "reason": "一句话"}。';
    const gtSummary = gt.map(g => '- [' + g.severity + '] ' + (g.file || g.area || '') + ' ' + g.finding).join('\n');
    const userPrompt = [
      '【评审意见】', modelOutput, '',
      '【基准缺陷（供参考，用于判断建议是否针对真实缺陷）】', gtSummary, '',
      '评估修复建议质量：90-100 每条发现都有具体可执行建议；60-89 多数有建议；30-59 少数有建议；0-29 基本只指出问题。',
      '只输出 JSON：{"score": ..., "reason": "..."}',
    ].join('\n');
    const resp = await callModel({
      config: judgeModel,
      params: { temperature: judgeModel.reasoningModel ? 1 : 0, maxTokens: 256, timeout: 30000 },
      systemPrompt,
      userPrompt,
    });
    const m = (resp.content || '').match(/"score"\s*:\s*(\d+)/);
    if (m) {
      const s = Math.max(0, Math.min(100, Number(m[1])));
      if (Number.isFinite(s)) return s;
    }
    return null;
  } catch {
    return null;
  }
}

export const llmJudgeEvaluator: Evaluator = {
  name: 'llm_judge',
  version: '1.0.0',

  async evaluate(
    scenario: Scenario,
    modelOutput: string,
    _metadata: OutputMetadata,
    _modelResponse?: ModelResponse,
    judgeModel?: ModelConfig,
  ): Promise<Partial<ScenarioResult>> {
    const req = (scenario.requirements ?? {}) as LlmJudgeRequirements;
    const gt = req.judge_ground_truth ?? [];
    const evidence: string[] = [];
    const axisScores: Record<string, number> = {};
    const axisEvidence: Record<string, AxisEvidence> = {};

    if (!modelOutput || !modelOutput.trim()) {
      for (const a of Object.keys(DEFAULT_WEIGHTS)) { axisScores[a] = 0; axisEvidence[a] = 'rule'; }
      return { axisScores, axisEvidence, totalScore: 0, safetyLevel: 'safe', evidence: ['模型输出为空'] };
    }

    const real = gt.filter(g => !g.isFP);
    const fp = gt.filter(g => g.isFP);

    // 1. critical_findings_recall：真实缺陷命中率
    let detected = 0;
    let sevCorrect = 0;
    let sevScored = 0;
    for (const g of real) {
      const kws = deriveKeywords(g);
      let hitPos = -1;
      let hitKw = '';
      for (const kw of kws) {
        const p = findKeyword(modelOutput, kw);
        if (p >= 0) { hitPos = p; hitKw = kw; break; }
      }
      if (hitPos >= 0) {
        detected++;
        const sev = severityAround(modelOutput, hitPos);
        if (sev) {
          sevScored++;
          if (normalizeSeverity(sev) === normalizeSeverity(g.severity)) sevCorrect++;
        }
        evidence.push('HIT [' + g.id + '] ' + hitKw + (sev ? ' (sev=' + sev + ')' : ''));
      } else {
        evidence.push('MISS [' + g.id + '] ' + (g.file || g.area || g.finding.slice(0, 30)));
      }
    }
    axisScores.critical_findings_recall = real.length ? Math.round((detected / real.length) * 100) : 0;
    axisEvidence.critical_findings_recall = 'rule';

    // 2. severity_accuracy：命中发现的级别一致性
    axisScores.severity_accuracy = sevScored ? Math.round((sevCorrect / sevScored) * 100) : 0;
    axisEvidence.severity_accuracy = 'rule';

    // 3. false_positive_control：是否把 FP 探针误报为真实缺陷
    let fpViolation = false;
    for (const f of fp) {
      const kws = deriveKeywords(f);
      for (const kw of kws) {
        const p = findKeyword(modelOutput, kw);
        if (p >= 0) {
          const sev = severityAround(modelOutput, p);
          // 若把 FP 标注为 critical/high/medium 即算误报
          if (sev && ['critical', 'high', 'medium'].includes(sev)) { fpViolation = true; evidence.push('FP-FAIL [' + f.id + '] 将 ' + kw + ' 误报为 ' + sev); }
          else evidence.push('FP-OK [' + f.id + '] ' + kw + (sev ? ' (sev=' + sev + ')' : ' (未标注级别)'));
          break;
        }
      }
    }
    axisScores.false_positive_control = fpViolation ? 0 : 100;
    axisEvidence.false_positive_control = 'rule';

    // 4. diff_coverage：改动文件/区域覆盖（非 FP 发现的文件优先，否则用 diff 文件）
    const realFiles = real.flatMap(g => (g.file ? [g.file] : []));
    const diffUnits = realFiles.length
      ? [...new Set(realFiles)]
      : (req.diff ? [...new Set([...req.diff.matchAll(/^\+\+\+ b\/([^\n]+)/gm)].map(m => m[1]))] : []);
    const covered = diffUnits.filter(f => modelOutput.toLowerCase().includes(f.toLowerCase()) || modelOutput.toLowerCase().includes(f.split('/').pop()?.toLowerCase() || ''));
    axisScores.diff_coverage = diffUnits.length ? Math.round((covered.length / diffUnits.length) * 100) : 100;
    axisEvidence.diff_coverage = 'rule';
    evidence.push('diff_coverage: ' + covered.length + '/' + diffUnits.length + ' 文件');

    // 5. actionable_feedback：修复建议可落地程度（优先 LLM Judge，失败回退启发式）
    const suggCount = (modelOutput.match(/(建议|改为|修复|应改为|应当|replace|should|suggest|fix)/gi) || []).length;
    const heuristicActionable = detected ? Math.min(100, Math.round((suggCount / detected) * 100)) : 0;
    let actionableScore = heuristicActionable;
    let actionableEvidence: AxisEvidence = 'rule';
    if (judgeModel) {
      const llmScore = await judgeActionableWithLLM(modelOutput, gt, judgeModel);
      if (llmScore !== null) { actionableScore = llmScore; actionableEvidence = 'llm'; }
    }
    axisScores.actionable_feedback = actionableScore;
    axisEvidence.actionable_feedback = actionableEvidence;
    evidence.push('actionable: ' + actionableScore + (actionableEvidence === 'llm' ? ' (LLM)' : ' (heuristic)'));

    // 6. 加权总分
    const weights = (scenario.scoring?.weights as Record<string, number> | undefined) ?? DEFAULT_WEIGHTS;
    let total = 0, wsum = 0;
    for (const [k, w] of Object.entries(weights)) {
      total += (axisScores[k] ?? 0) * w;
      wsum += w;
    }
    total = wsum > 0 ? Math.round(total / wsum) : 0;

    return { axisScores, axisEvidence, totalScore: total, safetyLevel: 'safe', evidence };
  },
};
