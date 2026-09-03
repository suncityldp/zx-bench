// ============================================================
// 评测报告生成模块
// 调用 AI Judge 模型生成结构化的模型能力评测报告
// 支持单模型报告 + 模型对比报告
// ============================================================

import type { ModelConfig, ModelParams, ModelResponse } from '@zxbench/types';
import { callModel } from '../model/caller.js';
import {
  REPORT_SYSTEM_PROMPT,
  REPORT_SYSTEM_PROMPT_EN,
  COMPARE_REPORT_SYSTEM_PROMPT,
  COMPARE_REPORT_SYSTEM_PROMPT_EN,
  type ReportLanguage,
  type ReportUserPromptData,
  type CompareReportUserPromptData,
  buildReportUserPrompt,
  buildCompareReportUserPrompt,
} from './prompts.js';

export interface GenerateReportOptions {
  /** 用于生成报告的 Judge 模型配置 */
  judgeConfig: ModelConfig;
  /** Judge 模型参数 */
  judgeParams?: Partial<ModelParams>;
  /** 报告数据 */
  data: ReportUserPromptData;
  /** 报告语言（跟随 UI 界面语言） */
  language?: ReportLanguage;
  /** 进度回调 */
  onProgress?: (stage: string) => void;
}

export interface GenerateCompareReportOptions {
  judgeConfig: ModelConfig;
  judgeParams?: Partial<ModelParams>;
  data: CompareReportUserPromptData;
  /** 报告语言（跟随 UI 界面语言） */
  language?: ReportLanguage;
  onProgress?: (stage: string) => void;
}

/**
 * 解析报告生成温度：
 *  - 推理模型（kimi-k3、deepseek-reasoner 等）只接受 temperature=1，强制 1；
 *  - 否则尊重模型 defaultParams.temperature，缺省 0.3（报告需要一定创造性但不过度发散）。
 */
function resolveReportTemperature(model: ModelConfig): number {
  if (model.reasoningModel) return 1;
  return model.defaultParams?.temperature ?? 0.3;
}

export interface ReportResult {
  /** Markdown 格式的完整报告 */
  markdown: string;
  /** 报告生成元数据 */
  metadata: {
    modelName: string;
    generatedAt: string;
    promptTokens: number;
    outputTokens: number;
    latencyMs: number;
    judgeModel: string;
  };
}

/**
 * 生成单模型评测报告
 * 调用 Judge 模型，传入标准化系统提示词 + 数据打包后的用户提示词
 */
/**
 * Judge 只吐思考过程、不吐正文。
 * caller 对「stream 只推 reasoning_content」有 content||reasoningContent 兜底
 * （LM Studio 兼容行为），此时 content 与 reasoningContent 完全相等。
 * 报告正文若被思考过程顶替，输出的就是一堆垃圾，必须识别出来而不是照单全收。
 */
class ReportReasoningOnlyError extends Error {
  constructor() {
    super('Judge 仅输出思考过程（reasoning_content），未产出报告正文');
    this.name = 'ReportReasoningOnlyError';
  }
}

function isReasoningOnly(r: ModelResponse): boolean {
  const content = r.content || '';
  const reasoning = r.reasoningContent || '';
  return content.length > 0 && content === reasoning;
}

/**
 * 报告专用模型调用。
 *
 * 必须流式：报告 prompt 大（维度数据 + 失败题 evidence）、输出上限 8192 token，
 * 推理模型实测耗时 64~80s。非流式请求在模型思考期间连接上零字节流动，
 * 上游网关（AWS ALB 等）空闲超时约 60s 先于我们的 600s 硬超时触发，
 * 直接返回 504 → 报告生成 100% 失败。流式下每个 chunk 都会重置空闲计时器。
 * 评测主链路（orchestrator）早已是流式，这正是「评测正常、报告必挂」的原因。
 */
async function callReportModel(base: {
  config: ModelConfig;
  params: ModelParams;
  systemPrompt: string;
  userPrompt: string;
}): Promise<ModelResponse> {
  let response = await callModel({ ...base, stream: true });

  // 流式行为不稳定：偶发整段只推 reasoning_content。重试一次拿正文。
  if (isReasoningOnly(response)) {
    console.warn('[report] Judge 流式只返回 reasoning_content，重试一次');
    response = await callModel({ ...base, stream: true });
    if (isReasoningOnly(response)) {
      throw new ReportReasoningOnlyError();
    }
  }

  return response;
}

export async function generateReport(options: GenerateReportOptions): Promise<ReportResult> {
  const { judgeConfig, judgeParams, data, language, onProgress } = options;
  const systemPrompt = language === 'en' ? REPORT_SYSTEM_PROMPT_EN : REPORT_SYSTEM_PROMPT;

  onProgress?.('构建报告提示词');
  const userPrompt = buildReportUserPrompt(data, language);

  onProgress?.('调用 Judge 模型生成报告');
  const startTime = Date.now();

  const callBase = {
    config: judgeConfig,
    params: {
      temperature: resolveReportTemperature(judgeConfig),
      maxTokens: 8192,   // 报告可能较长，给足够空间
      ...judgeParams,
    },
    systemPrompt,
    userPrompt,
  };

  let response: ModelResponse;
  try {
    response = await callReportModel(callBase);
  } catch (err) {
    if (err instanceof ReportReasoningOnlyError) {
      // 两次都只吐思考过程：宁可给纯数据报告，也不能把推理过程当正文灌给用户
      console.warn('[report] 重试后仍只有 reasoning_content，降级为纯数据报告');
      return generateFallbackReport(data);
    }
    throw err;
  }

  const latencyMs = Date.now() - startTime;

  const markdown = response.content || '';

  // 如果 Judge 输出为空，提供降级报告
  if (!markdown.trim()) {
    console.warn('[report] Judge returned empty content, generating fallback report');
    return generateFallbackReport(data);
  }

  return {
    markdown,
    metadata: {
      modelName: data.modelName,
      generatedAt: new Date().toISOString(),
      promptTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      latencyMs,
      judgeModel: judgeConfig.name,
    },
  };
}

/**
 * 生成模型对比报告
 */
export async function generateCompareReport(
  options: GenerateCompareReportOptions,
): Promise<ReportResult> {
  const { judgeConfig, judgeParams, data, language, onProgress } = options;
  const systemPrompt = language === 'en' ? COMPARE_REPORT_SYSTEM_PROMPT_EN : COMPARE_REPORT_SYSTEM_PROMPT;

  onProgress?.('构建对比报告提示词');
  const userPrompt = buildCompareReportUserPrompt(data, language);

  onProgress?.('调用 Judge 模型生成对比报告');
  const startTime = Date.now();

  let response: ModelResponse;
  try {
    response = await callReportModel({
      config: judgeConfig,
      params: {
        temperature: resolveReportTemperature(judgeConfig),
        maxTokens: 8192,
        ...judgeParams,
      },
      systemPrompt,
      userPrompt,
    });
  } catch (err) {
    if (err instanceof ReportReasoningOnlyError) {
      console.warn('[report] 对比报告：重试后仍只有 reasoning_content，降级为纯数据报告');
      return generateCompareFallbackReport(data, judgeConfig.name, Date.now() - startTime);
    }
    throw err;
  }

  const latencyMs = Date.now() - startTime;

  const markdown = response.content || '';

  if (!markdown.trim()) {
    console.warn('[report] Judge returned empty content for comparison, generating fallback');
    return generateCompareFallbackReport(data, judgeConfig.name, latencyMs);
  }

  return {
    markdown,
    metadata: {
      modelName: data.models.map((m) => m.modelName).join(' vs '),
      generatedAt: new Date().toISOString(),
      promptTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      latencyMs,
      judgeModel: judgeConfig.name,
    },
  };
}

/** 对比报告降级版 — Judge 无有效输出时的纯数据报告 */
function generateCompareFallbackReport(
  data: CompareReportUserPromptData,
  judgeName: string,
  latencyMs: number,
): ReportResult {
  return {
    markdown: `# 模型对比报告（降级版）\n\n## 参评模型\n\n${
      data.models.map((m) => `- **${m.modelName}**：均分 ${m.overview.averageScore} | 通过率 ${m.overview.passRate}%`).join('\n')
    }\n\n*报告生成失败，仅显示基础数据。请检查 Judge 模型状态后重试。*`,
    metadata: {
      modelName: data.models.map((m) => m.modelName).join(' vs '),
      generatedAt: new Date().toISOString(),
      promptTokens: 0,
      outputTokens: 0,
      latencyMs,
      judgeModel: judgeName,
    },
  };
}

/**
 * 降级报告 — 当 Judge 模型不可用时生成的纯数据报告
 */
function generateFallbackReport(data: ReportUserPromptData): ReportResult {
  const lines: string[] = [];

  lines.push(`# ${data.modelName} 评测报告`);
  lines.push('');
  lines.push('> ⚠️ AI Judge 模型不可用，本报告为降级版纯数据报告。');
  lines.push('');

  // 总览
  lines.push('## 一、评测总览');
  lines.push('');
  lines.push(`| 指标 | 数值 |`);
  lines.push(`|------|------|`);
  lines.push(`| 总题数 | ${data.overview.totalScenarios} |`);
  lines.push(`| 平均分 | ${data.overview.averageScore} |`);
  lines.push(`| 通过率 | ${data.overview.passRate}% |`);
  lines.push(`| 通过题数 | ${data.overview.passCount} |`);
  lines.push(`| 安全红线 | ${data.overview.redLineCount} |`);
  lines.push(`| 格式失败 | ${data.overview.formatFailCount} |`);
  if ((data.overview.environmentIsolationCount ?? 0) > 0) {
    lines.push(`| 环境隔离题（不计入能力统计） | ${data.overview.environmentIsolationCount} |`);
  }
  lines.push('');

  // 维度表
  lines.push('## 二、维度成绩');
  lines.push('');
  lines.push('| 维度 | 题数 | 均分 | 通过率 | 最高 | 最低 |');
  lines.push('|------|------|------|--------|------|------|');
  for (const d of data.dimensions) {
    lines.push(`| ${d.dimensionLabel} | ${d.count} | ${d.averageScore} | ${d.passRate}% | ${d.maxScore} | ${d.minScore} |`);
  }
  lines.push('');

  // 优势
  if (data.strengths.length > 0) {
    lines.push('## 三、优势维度');
    lines.push('');
    for (const s of data.strengths) {
      lines.push(`- **${s.dimension}**：均分 ${s.score}，通过率 ${s.passRate}%`);
    }
    lines.push('');
  }

  // 弱项
  if (data.weaknesses.length > 0) {
    lines.push('## 四、待改进维度');
    lines.push('');
    for (const w of data.weaknesses) {
      lines.push(`- **${w.dimension}**：均分 ${w.score}，通过率 ${w.passRate}%`);
    }
    lines.push('');
  }

  // 长任务工程能力专项（编程维度子项）
  if (data.longTaskStats) {
    const lt = data.longTaskStats;
    lines.push('## 五、长任务工程能力（编程维度子项）');
    lines.push('');
    lines.push(`> 多文件/多步骤/跨轮上下文管理（agentic coding 核心）；聚合权重 3.0，单独出分。`);
    lines.push('');
    lines.push(`| 指标 | 数值 |`);
    lines.push(`|------|------|`);
    lines.push(`| 题数 | ${lt.count} |`);
    lines.push(`| 均分 | ${lt.averageScore} |`);
    lines.push(`| 通过率 | ${lt.passRate}% |`);
    lines.push('');
    if (lt.subCategories.length > 0) {
      lines.push('| 子类目 | 题数 | 均分 |');
      lines.push('|--------|------|------|');
      for (const c of lt.subCategories) {
        lines.push(`| ${c.category} | ${c.count} | ${c.averageScore} |`);
      }
      lines.push('');
    }
    lines.push(`分数分布：${Object.entries(lt.distribution).map(([k, v]) => `${k}分 ${v} 题`).join('，')}`);
    lines.push('');
  }

  const markdown = lines.join('\n');

  return {
    markdown,
    metadata: {
      modelName: data.modelName,
      generatedAt: new Date().toISOString(),
      promptTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      judgeModel: 'fallback',
    },
  };
}
