// ============================================================
// 评测报告生成模块
// 调用 AI Judge 模型生成结构化的模型能力评测报告
// 支持单模型报告 + 模型对比报告
// ============================================================

import type { ModelConfig, ModelParams } from '@zxbench/types';
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
export async function generateReport(options: GenerateReportOptions): Promise<ReportResult> {
  const { judgeConfig, judgeParams, data, language, onProgress } = options;
  const systemPrompt = language === 'en' ? REPORT_SYSTEM_PROMPT_EN : REPORT_SYSTEM_PROMPT;

  onProgress?.('构建报告提示词');
  const userPrompt = buildReportUserPrompt(data, language);

  onProgress?.('调用 Judge 模型生成报告');
  const startTime = Date.now();

  const response = await callModel({
    config: judgeConfig,
    params: {
      temperature: resolveReportTemperature(judgeConfig),
      maxTokens: 8192,   // 报告可能较长，给足够空间
      ...judgeParams,
    },
    systemPrompt,
    userPrompt,
  });

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

  const response = await callModel({
    config: judgeConfig,
    params: {
      temperature: resolveReportTemperature(judgeConfig),
      maxTokens: 8192,
      ...judgeParams,
    },
    systemPrompt,
    userPrompt,
  });

  const latencyMs = Date.now() - startTime;

  const markdown = response.content || '';

  if (!markdown.trim()) {
    console.warn('[report] Judge returned empty content for comparison, generating fallback');
    return {
      markdown: `# 模型对比报告（降级版）\n\n## 参评模型\n\n${
        data.models.map((m) => `- **${m.modelName}**：均分 ${m.overview.averageScore} | 通过率 ${m.overview.passRate}%`).join('\n')
      }\n\n*报告生成失败，仅显示基础数据。请检查 Judge 模型状态后重试。*`,
      metadata: {
        modelName: data.models.map((m) => m.modelName).join(' vs '),
        generatedAt: new Date().toISOString(),
        promptTokens: response.usage.inputTokens,
        outputTokens: 0,
        latencyMs,
        judgeModel: judgeConfig.name,
      },
    };
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
