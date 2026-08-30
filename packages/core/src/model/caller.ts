// ============================================================
// 模型调用模块 — OpenAI API 兼容
// 支持 reasoning_content 分离（DeepSeek-R1、QwQ 等）
// 支持流式调用获取精确 TTFT 和生成速度
// ============================================================

import type { ModelConfig, ModelParams, ModelResponse, TokenUsage, FinishReason, EvalConstraints } from '@zxbench/types';

export interface CallModelOptions {
  config: ModelConfig;
  params: ModelParams;
  systemPrompt?: string;
  userPrompt: string;
  signal?: AbortSignal;
  /** 思考/输出约束（反拖尾）：注入 prompt 软约束 + 预算硬限制 */
  constraints?: EvalConstraints;
  /** 启用流式调用以获取精确的 TTFT（首 token 延迟）和生成速度（默认 false，保持向后兼容） */
  stream?: boolean;
}

/** 调用模型（OpenAI Chat Completions API 兼容） */
export async function callModel(options: CallModelOptions): Promise<ModelResponse> {
  if (options.stream) {
    return callModelStreaming(options);
  }
  return callModelNonStreaming(options);
}

// ========== 非流式调用（保留兼容） ==========

async function callModelNonStreaming(options: CallModelOptions): Promise<ModelResponse> {
  const { config, params, systemPrompt, userPrompt, signal, constraints } = options;
  const startTime = Date.now();

  const { controller, timeoutId, timeoutMs } = buildTimeout(constraints, params, signal);
  const { messages, defaultMaxTokens } = buildMessages(config, params, systemPrompt, userPrompt, constraints);

  const body: Record<string, unknown> = {
    model: config.name,
    messages,
    max_tokens: defaultMaxTokens,
    stream: false,
  };

  fillExtraParams(body, params);

  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const headers = buildHeaders(config);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Model API error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as Record<string, unknown>;
    const latencyMs = Date.now() - startTime;

    return parseNonStreamingResponse(data, latencyMs);
  } catch (err) {
    throw wrapTimeoutError(err, timeoutMs);
  } finally {
    clearTimeout(timeoutId);
  }
}

// ========== 流式调用（精确 TTFT + 生成速度） ==========

async function callModelStreaming(options: CallModelOptions): Promise<ModelResponse> {
  const { config, params, systemPrompt, userPrompt, signal, constraints } = options;
  const requestStartTime = Date.now();

  const { controller, timeoutId, timeoutMs } = buildTimeout(constraints, params, signal);
  const { messages, defaultMaxTokens } = buildMessages(config, params, systemPrompt, userPrompt, constraints);

  const body: Record<string, unknown> = {
    model: config.name,
    messages,
    max_tokens: defaultMaxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };

  fillExtraParams(body, params);

  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const headers = buildHeaders(config);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      // 如果不支持 stream_options，回退到不带 stream_options 的流式
      if (response.status === 400 && errorText.includes('stream_options')) {
        console.warn(`[caller] Provider doesn't support stream_options, retrying without it`);
        const body2 = { ...body };
        delete (body2 as Record<string, unknown>).stream_options;
        return await fetchAndParseStream(url, headers, body2, controller.signal, requestStartTime, timeoutMs);
      }
      throw new Error(`Model API error ${response.status}: ${errorText}`);
    }

    return await parseStreamResponse(response, requestStartTime, timeoutMs, constraints?.maxReasoningTokens);
  } catch (err) {
    throw wrapTimeoutError(err, timeoutMs);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchAndParseStream(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal: AbortSignal,
  requestStartTime: number,
  timeoutMs: number,
): Promise<ModelResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Model API error ${response.status}: ${await response.text()}`);
  }
  return parseStreamResponse(response, requestStartTime, timeoutMs);
}

/**
 * 带空闲超时的 stream read。
 * 后端 stall（连接未断但不再推送）时抛出可诊断错误，而不是静默阻塞到整体截止。
 */
async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
  requestStartTime: number,
): Promise<{ done: boolean; value?: Uint8Array }> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(
        `Model stream idle for ${idleMs}ms (elapsed ${Date.now() - requestStartTime}ms) — 后端已连接但停止推送`,
      ));
    }, idleMs);
  });
  try {
    return await Promise.race([reader.read(), idle]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function parseStreamResponse(
  response: Response,
  requestStartTime: number,
  timeoutMs: number,
  maxReasoningTokens?: number,
): Promise<ModelResponse> {
  if (!response.body) {
    throw new Error('Streaming response has no body');
  }

  // 空闲超时：两次 chunk 之间允许的最大间隔。
  // 原先该形参被写成 _timeoutMs（未使用），读流循环完全没有超时保护：后端一旦
  // 「开了流但不关闭」（本地推理引擎中止、代理挂起等常见故障），await reader.read()
  // 会一直阻塞到外层 AbortController 的整体截止（默认 10 分钟），期间不产生任何日志，
  // 排障时表现为「无任何输出的静默挂起」，极易被误判为死循环。
  // 补一个空闲上限，让 stall 尽快显性化为可诊断的错误。
  // 取值：给推理模型留出充分的思考停顿，同时不超过整体硬超时。
  const idleMs = Math.max(30_000, Math.min(timeoutMs, 180_000));
  if (process.env.ZXB_CALLER_TRACE) {
    console.error(`[caller] parseStreamResponse timeoutMs=${timeoutMs} idleMs=${idleMs}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let content = '';
  let reasoningContent = '';
  let finishReason: FinishReason = 'unknown';
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let lastTimings: Record<string, number> | undefined;
  let firstTokenTime = 0;
  let lastTokenTime = 0;
  let buffer = '';
  // I3（2026-08-31）：maxReasoningTokens 硬截断标志。
  // 此前该约束只是 prompt 软提示，模型完全无视（实测限 8192 实际耗 58192，7.1 倍），
  // 思考耗尽全部 maxTokens 后 content 为空 → orchestrator 判 REASONING_TOKEN_BUDGET 0 分。
  // 现在流式观察 reasoning 增量（字符数/3 估算 token，与下方 usage 兜底口径一致），
  // 超预算即主动停止读流：已产出的 content 保留进入正常评分，避免"判 0 误伤真实能力"。
  let reasoningHardCapped = false;

  try {
    while (true) {
      const { done, value } = await readWithIdleTimeout(reader, idleMs, requestStartTime);
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') continue;
        if (!dataStr) continue;

        try {
          const chunk = JSON.parse(dataStr);
          const choice = (chunk.choices as Array<Record<string, unknown>>)?.[0];
          if (!choice) continue;

          const delta = choice.delta as Record<string, unknown> | undefined;
          if (delta?.content) {
            const text = String(delta.content);
            if (firstTokenTime === 0) firstTokenTime = Date.now();
            lastTokenTime = Date.now();
            content += text;
          }

          const rc = delta?.reasoning_content || delta?.reasoning;
          if (rc) {
            reasoningContent += String(rc);
            // I3 硬截断：reasoning 估算 token 超预算 → 停止读流，保留已有 content
            if (
              maxReasoningTokens != null &&
              !reasoningHardCapped &&
              Math.ceil(reasoningContent.length / 3) > maxReasoningTokens
            ) {
              reasoningHardCapped = true;
              console.warn(
                `[caller] maxReasoningTokens=${maxReasoningTokens} exceeded (est ${Math.ceil(reasoningContent.length / 3)} tokens) — hard-capping stream, keeping partial content`,
              );
              finishReason = 'length';
              break;
            }
          }

          if (choice.finish_reason) {
            finishReason = mapFinishReason(String(choice.finish_reason));
          }

          if (chunk.usage) {
            usage = extractTokenUsage(chunk);
            lastTimings = chunk.timings as Record<string, number> | undefined;
          }
        } catch {
          // 跳过无法解析的 chunk
        }
      }
      if (reasoningHardCapped) break;
    }

    // 处理 buffer 中可能残留的最后一行
    if (buffer.trim().startsWith('data:')) {
      const dataStr = buffer.trim().slice(5).trim();
      if (dataStr && dataStr !== '[DONE]') {
        try {
          const chunk = JSON.parse(dataStr);
          if (chunk.usage) {
            usage = extractTokenUsage(chunk);
            lastTimings = chunk.timings as Record<string, number> | undefined;
          }
        } catch { /* ignore */ }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const totalTime = Date.now() - requestStartTime;
  const ttftMs = firstTokenTime > 0 ? firstTokenTime - requestStartTime : totalTime;
  const generationMs = firstTokenTime > 0 && lastTokenTime > 0 ? lastTokenTime - firstTokenTime : 0;

  // 如果流中没有 usage 信息，用字符数估算（约 3 字符/token 混合中英文）
  if (usage.outputTokens === 0 && content.length > 0) {
    const estimated = Math.max(1, Math.round(content.length / 3));
    usage.outputTokens = estimated;
    usage.totalTokens = usage.inputTokens + estimated;
  }

  const tokensPerSecond = generationMs > 0
    ? Math.round(usage.outputTokens / (generationMs / 1000))
    : (totalTime > 0 ? Math.round(usage.outputTokens / (totalTime / 1000)) : 0);

  // LM Studio 对 reasoning 模型的流式响应只输出 reasoning_content、不输出 content。
  // 当 content 为空但 reasoningContent 非空时，把 reasoningContent 作为 content 的 fallback，
  // 避免 modelOutput 假空响应（2026-08-30 根因定位）。
  const finalContent = content || reasoningContent;

  return {
    content: finalContent,
    reasoningContent: reasoningContent || undefined,
    finishReason,
    usage,
    latencyMs: totalTime,
    ttftMs,
    generationMs,
    tokensPerSecond,
    // I3：reasoning 硬截断标记——orchestrator 据此不把"思考超限"判 0，
    // 而是用已产出 content 正常评分（附 truncated 证据）。
    raw: {
      streamed: true,
      contentLength: finalContent.length,
      timings: lastTimings,
      reasoningHardCapped: reasoningHardCapped || undefined,
      maxReasoningTokens: reasoningHardCapped ? maxReasoningTokens : undefined,
    },
  };
}

// ========== 共享辅助 ==========

function buildTimeout(
  constraints: EvalConstraints | undefined,
  params: ModelParams,
  signal: AbortSignal | undefined,
): { controller: AbortController; timeoutId: ReturnType<typeof setTimeout>; timeoutMs: number } {
  // 默认 10 分钟：含本地模型队列排队时间，避免并发下排队挤占推理预算导致误判超时
  const timeoutMs = constraints?.hardTimeLimitMs ?? params.timeout ?? 600_000;
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(new Error(`Model call timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return { controller, timeoutId, timeoutMs };
}

function buildMessages(
  config: ModelConfig,
  params: ModelParams,
  systemPrompt: string | undefined,
  userPrompt: string,
  constraints: EvalConstraints | undefined,
): { messages: Array<{ role: string; content: string }>; defaultMaxTokens: number } {
  const REASONING_DEFAULT_TOKENS = 32768;
  const NORMAL_DEFAULT_TOKENS = 8192;
  const isReasoningModel = config.reasoningModel === true;

  const DEFAULT_SYSTEM = isReasoningModel
    ? '请直接给出最终答案，禁止输出任何分析过程、思考过程或推理过程。不要解释你的思路，只输出最终结果。'
    : '';
  const REASONING_SUFFIX = isReasoningModel
    ? '\n\nCRITICAL: You are a reasoning model. Your thinking/analysis tokens are SEPARATE from your output. DO NOT put your answer inside reasoning. Always produce the final answer in the content field.'
    : '';

  const constraintInstructions = buildConstraintInstructions(constraints);
  const constraintSuffix = constraintInstructions ? `\n\n${constraintInstructions}` : '';

  const messages: Array<{ role: string; content: string }> = [];
  const effectiveSystem = (systemPrompt || DEFAULT_SYSTEM) + constraintSuffix;
  if (effectiveSystem) {
    messages.push({ role: 'system', content: effectiveSystem + REASONING_SUFFIX });
  }
  messages.push({ role: 'user', content: constraintSuffix ? `${userPrompt}${constraintSuffix}` : userPrompt });

  let defaultMaxTokens = params.maxTokens ?? (isReasoningModel ? REASONING_DEFAULT_TOKENS : NORMAL_DEFAULT_TOKENS);
  if (constraints?.maxTotalTokens) {
    defaultMaxTokens = constraints.maxTotalTokens;
  } else if (constraints?.maxReasoningTokens || constraints?.maxAnswerTokens) {
    defaultMaxTokens = (constraints.maxReasoningTokens ?? 0) + (constraints.maxAnswerTokens ?? 0);
  }

  return { messages, defaultMaxTokens };
}

function fillExtraParams(body: Record<string, unknown>, params: ModelParams): void {
  if (params.temperature != null) body.temperature = params.temperature;
  if (params.topP != null) body.top_p = params.topP;
  if (params.stop) body.stop = params.stop;
  if (params.extra) {
    Object.assign(body, params.extra);
  }
}

function buildHeaders(config: ModelConfig): Record<string, string> {
  // Connection: close —— 禁用 undici keep-alive 连接复用（2026-08-30 K2/K3 事故根因）。
  // 本地后端（LM Studio / llama.cpp）发生 stall 或重载后，连接池里会残留半关闭 socket；
  // 之后每个 fetch 都复用这个坏连接 → 全量 "fetch failed"（code=UND_ERR_CONNECT_TIMEOUT），
  // 重试也走同一池、永不恢复，表现为 run 前段正常、某一刻起连败到结束（ornith K2 24 题后连败 34 题）。
  // 评测每题调用间隔秒级、且目标是本地服务，长连接收益小、毒化风险大，一律短连接。
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Connection: 'close',
  };
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }
  return headers;
}

/**
 * 从 API 响应 chunk 里提取 token 用量。
 * llama.cpp 等本地服务在启用 prompt 缓存 / 推测解码时，usage.prompt_tokens 可能少报甚至为 0，
 * 而 timings 里的 prompt_n + cache_n（完整输入）与 predicted_n（完整输出）始终准确，
 * 因此取两者的较大值兜底，确保输入/输出 token 完整统计。
 */
function extractTokenUsage(chunk: Record<string, unknown>): TokenUsage {
  const u = (chunk.usage ?? {}) as Record<string, number>;
  const t = (chunk.timings ?? {}) as Record<string, number>;
  const timingsInput = (t.prompt_n ?? 0) + (t.cache_n ?? 0);
  const inputTokens = Math.max(u.prompt_tokens ?? 0, timingsInput);
  const outputTokens = Math.max(u.completion_tokens ?? 0, t.predicted_n ?? 0);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function parseNonStreamingResponse(data: Record<string, unknown>, latencyMs: number): ModelResponse {
  const choice = (data.choices as Array<Record<string, unknown>>)?.[0];
  const message = choice?.message as Record<string, unknown> | undefined;

  const reasoningContent = (message?.reasoning_content as string)
    || (message?.reasoning as string)
    || undefined;

  const content = (message?.content as string) || '';
  // LM Studio reasoning 模型：content 可能为空而 reasoning_content 非空，fallback 防止假空响应
  const finalContent = content || reasoningContent || '';
  const finishReason = mapFinishReason(choice?.finish_reason as string);
  return {
    content: finalContent,
    reasoningContent,
    finishReason,
    usage: extractTokenUsage(data),
    latencyMs,
    raw: data,
  };
}

function wrapTimeoutError(err: unknown, timeoutMs: number): never {
  if (err instanceof Error) {
    const isTimeout = err.name === 'AbortError' || String(err.message).includes('timed out');
    if (isTimeout) {
      throw new Error(`Model call timed out after ${timeoutMs}ms: ${err.message}`);
    }
  }
  throw err;
}

/** 映射 finish_reason */
function mapFinishReason(reason?: string): FinishReason {
  switch (reason) {
    case 'stop': return 'stop';
    case 'length': return 'length';
    case 'content_filter': return 'content_filter';
    case 'tool_calls': return 'tool_calls';
    default: return 'unknown';
  }
}

/** 带重试的模型调用 */
export async function callModelWithRetry(
  options: CallModelOptions,
  maxRetries = 3,
): Promise<ModelResponse> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callModel(options);
    } catch (err) {
      lastError = err as Error;
      // 超时错误不重试：达到 hardTimeLimitMs 仍未返回，说明是"思考拖尾"而非网络抖动，
      // 重试大概率仍会超时，只会成倍浪费时间和占用本地模型队列。
      const isTimeout =
        (err as Error)?.name === 'AbortError'
        || /timed out|timeout/i.test((err as Error)?.message || '');
      if (isTimeout) {
        throw err;
      }
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * 2 ** attempt, 10000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError ?? new Error('Model call failed');
}

/** 根据约束生成注入 prompt 的指令文本（软约束；硬校验在编排器中执行） */
function buildConstraintInstructions(constraints?: EvalConstraints): string {
  if (!constraints) return '';
  const lines: string[] = [];

  if (constraints.answerFirst) {
    lines.push('请先给出最终答案，再给出原因或推理过程。不要把答案埋在长段分析中间，开头第一句必须直接给出答案。');
  }
  if (constraints.maxAnswerTokens) {
    lines.push(`最终答案必须控制在 ${constraints.maxAnswerTokens} 个 token（约 ${Math.round(constraints.maxAnswerTokens * 0.75)} 个汉字或 ${Math.round(constraints.maxAnswerTokens * 3)} 个英文字符）以内。`);
  }
  if (constraints.maxReasoningTokens) {
    lines.push(`思考过程必须控制在 ${constraints.maxReasoningTokens} 个 token 以内，不要过度展开、反复自我确认或输出冗余推理。`);
  }
  if (constraints.hardTimeLimitMs) {
    lines.push(`请在 ${Math.round(constraints.hardTimeLimitMs / 1000)} 秒内完成回答。如果无法在时限内给出完整答案，请直接给出最可能的最终答案。`);
  }

  return lines.join(' ');
}