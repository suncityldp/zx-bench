import type { FinishReason, OutputMetadata } from '@zxbench/types';

/** 截断检测模式 */
const TRUNCATION_PATTERNS = [
  /(?:wait|let me|let's check|i'll|i will|continuing|继续|让我)\s*$/i,
  /```\s*$/,  // 代码块只有开始没有结束
  /\.\.\.\s*$/,
  /\/\/\s*\.\.\.\s*$/,
];

/** 检测输出是否被截断 */
export function detectTruncation(
  content: string,
  finishReason: FinishReason,
  maxTokens: number,
  outputTokens: number,
): { truncated: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // finish_reason == length → 触达 max_tokens
  if (finishReason === 'length') {
    reasons.push('finish_reason is length (hit max_tokens)');
  }

  // 输出 token 接近 max_tokens（95% 以上）
  if (outputTokens > maxTokens * 0.95) {
    reasons.push(`output tokens (${outputTokens}) near max_tokens (${maxTokens})`);
  }

  // 文本模式检测
  for (const pattern of TRUNCATION_PATTERNS) {
    if (pattern.test(content.trimEnd())) {
      reasons.push(`matches truncation pattern: ${pattern.source}`);
      break;
    }
  }

  // 代码块只有开始没有结束
  const openFences = (content.match(/```/g) || []).length;
  if (openFences % 2 !== 0) {
    reasons.push('unclosed code fence');
  }

  return {
    truncated: reasons.length > 0,
    reasons,
  };
}

/** 构建完整输出元数据（GPT5.6 P0-1） */
export function buildOutputMetadata(
  content: string,
  finishReason: FinishReason,
  maxTokens: number,
  outputTokens: number,
): OutputMetadata {
  const { truncated, reasons } = detectTruncation(content, finishReason, maxTokens, outputTokens);
  const containsCodeBlock = /```[\s\S]*?```/.test(content);
  // ANSWER: 行（CLI 实地调查题等题面要求的一行式结论）也视为最终结论
  const containsFinalConclusion = /(?:最终|结论|判定|verdict|conclusion|final|^answer\s*[:：])/im.test(content);

  return {
    finishReason,
    truncated,
    containsCodeBlock,
    containsFinalConclusion,
    outputLength: content.length,
    outputTokens,
    inputTokens: 0, // 由调用方覆盖（orchestrator 从模型响应回填）
    maxTokens,
    incomplete: truncated || !containsFinalConclusion,
    incompleteReasons: reasons.length > 0 ? reasons : (!containsFinalConclusion ? ['no final conclusion found'] : undefined),
  };
}
