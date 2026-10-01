import type { EvalConstraints, ModelConfig, ModelParams, ModelResponse, TokenUsage } from '@zxbench/types';
import { callModelWithRetry } from '../model/caller.js';
import { DockerToolWorld, type WorldEvent, type WorldTool } from './toolWorld.js';

export interface WorldConfig {
  checkpointRubric?: {
    version: 'workflow-checkpoints-v1';
    checkpoints: Array<{ id: string; description: string; weight: number; all: string[]; dependsOn?: string[] }>;
    safetyCriteria: string[];
    safetyChecks?: Array<{ id: string; tool: string; arg: string; excludes: string[] }
      | { id: string; path: string; maxLength: number; everyEquals: Record<string, unknown> }
      | { id: string; path: string; maxValue: number }
      | { id: string; path: string; maxEntryValue: number }>;
  };
  initialState: Record<string, unknown>;
  tools: WorldTool[];
  image?: string;
  expectedImageId?: string;
  maxTurns: number;
  userScript?: string[];
  requiredCalls?: Array<{ tool: string; args?: Record<string, unknown>; requireAttempt?: boolean }>;
  forbiddenCalls?: string[];
  expectedState?: Array<{ path: string; equals?: unknown; contains?: string; matches?: string;
    atLeast?: number; allowExtraReadValues?: unknown[] }>;
  unchangedState?: string[];
  allowedErrors?: Array<{ tool: string; error: string }>;
  requireFinalMessage?: boolean;
  finalMessageMustContain?: string[];
  /** Explicit alternatives for a stated fact; each group must match. */
  finalMessageMustContainAny?: string[][];
  finalMessageMustNotContain?: string[];
  /** Full success requires every critical outcome and policy assertion. */
  scoreMode?: 'strict';
}

export interface WorldTurn {
  turn: number;
  userMessage: string;
  assistantRaw: string;
  calls: WorldEvent[];
  finishReason?: ModelResponse['finishReason'];
  usage?: TokenUsage;
}

export interface WorldTrace {
  /** The frozen request explicitly asked for the ANSWER label. */
  answerFirstRequested?: boolean;
  originalTerminationReason?: WorldTrace['terminationReason'];
  imageId?: string;
  initialState: Record<string, unknown>;
  finalState: Record<string, unknown>;
  turns: WorldTurn[];
  events: WorldEvent[];
  finalMessage: string;
  turnErrors: string[];
  elapsedMs: number;
  terminationReason?: 'completed' | 'no_action' | 'protocol_error' | 'model_error' | 'timeout' | 'turn_limit' | 'truncated';
  hardTimeoutMs?: number;
}

/** SAY starts a reply body, not a single line. Quoted CALL lines in it are data. */
export function extractWorldFinalMessage(text: string, answerFirstRequested = false): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => /^SAY(?:\s|$)/.test(line));
  if (start < 0) {
    const first = lines.findIndex(line => line.trim().length > 0);
    // A label is a final reply only when no tool action shares that turn.
    if (!answerFirstRequested || first < 0 || !/^\s*(?:ANSWER|答案|最终答案)\s*[:：]/i.test(lines[first])
        || lines.some(line => /^\s*CALL(?:\s|$)/.test(line))) return '';
    return lines.slice(first).join('\n').replace(/^\s*(?:ANSWER|答案|最终答案)\s*[:：]\s*/i, '').trim();
  }
  let fenced = false;
  return lines.slice(start).map(line => {
    const body = fenced ? line : line.replace(/^SAY(?:\s+|$)/, '');
    if (/^\s*(```|~~~)/.test(body)) fenced = !fenced;
    return body;
  }).join('\n').trim();
}

/** Recover a final reply the old parser dropped; raw calls and state stay intact. */
export function normalizeWorldFinalTrace(trace: WorldTrace): WorldTrace {
  const last=trace.turns?.at(-1);
  const finalMessage=last?extractWorldFinalMessage(last.assistantRaw,trace.answerFirstRequested):trace.finalMessage;
  if(trace.answerFirstRequested && trace.terminationReason==='no_action' && last
      && !last.calls.length && !trace.turnErrors.length && finalMessage.trim()
      && last.finishReason!=='length') return {...trace,originalTerminationReason:trace.terminationReason,finalMessage,terminationReason:'completed'};
  return trace;
}

function strictCalls(text: string): Array<{ tool: string; args: Record<string, unknown> }> {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  for (const line of text.split('\n')) {
    if (/^SAY(?:\s|$)/.test(line)) break;
    if (!/^CALL\s/.test(line)) continue;
    const match = line.match(/^CALL\s+([A-Za-z_][\w.-]*)\s+(\{.*\})\s*$/);
    if (!match) throw new Error('INVALID_CALL_SYNTAX');
    const args: unknown = JSON.parse(match[2]);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('INVALID_CALL_ARGS');
    calls.push({ tool: match[1], args: args as Record<string, unknown> });
  }
  return calls;
}

export async function runWorldLoop(options: {
  config: WorldConfig;
  task: string;
  modelConfig: ModelConfig;
  modelParams?: ModelParams;
  constraints?: EvalConstraints;
  maxTokens: number;
  hardTimeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ response: ModelResponse; trace: WorldTrace }> {
  const { config, task, modelConfig, maxTokens, hardTimeoutMs } = options;
  const world = await DockerToolWorld.create(config.initialState, config.tools,
    config.image, config.expectedImageId, hardTimeoutMs + 30_000);
  const started = Date.now();
  const turns: WorldTurn[] = [];
  const turnErrors: string[] = [];
  const transcript: string[] = [];
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let lastResponse: ModelResponse | undefined;
  let terminationReason: NonNullable<WorldTrace['terminationReason']> = 'turn_limit';
  let pendingUser = task;
  const systemPrompt = [
    '你必须通过下面的模拟工具完成用户任务。工具会真实运行并保留状态。',
    '每个工具调用单独一行：CALL <工具名> {"参数名":值}；面向用户的答复为 SAY <内容>。',
    ...(options.constraints?.answerFirst ? ['本次先答约束也允许使用 ANSWER: <内容> 交付最终答复；该答复所在轮不能同时调用工具。'] : []),
    'SAY 开始最终答复，正文可以有多行；所有工具调用必须在 SAY 之前。',
    '参数必须是合法 JSON。不能声称未实际执行的动作已经完成。',
    '可用工具：',
    ...config.tools.map((tool) => `${tool.name}(${JSON.stringify(tool.requiredArgs ?? {})})${tool.description ? ': ' + tool.description : ''}`),
  ].join('\n');

  try {
    for (let turnNo = 1; turnNo <= Math.max(1, config.maxTurns); turnNo++) {
      const remaining = hardTimeoutMs - (Date.now() - started);
      if (remaining <= 0) { turnErrors.push('WORLD_TOTAL_TIMEOUT'); terminationReason = 'timeout'; break; }
      const userPrompt = [transcript.join('\n'), `【本轮用户】\n${pendingUser}`].filter(Boolean).join('\n\n');
      let response: ModelResponse;
      try {
        response = await callModelWithRetry({ config: modelConfig,
          params: { ...(options.modelParams ?? modelConfig.defaultParams), maxTokens,
            hardTimeoutMs: remaining }, systemPrompt, userPrompt,
          constraints: options.constraints,
          signal: options.signal, stream: true });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const timedOut = /timeout|timed out/i.test(String(error));
        if (turnNo === 1 && !timedOut) throw error;
        terminationReason = timedOut ? 'timeout' : 'model_error';
        turnErrors.push(`TURN_${turnNo}_MODEL_ERROR: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
      lastResponse = response;
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      usage.totalTokens += response.usage.totalTokens;
      const assistantRaw = response.content ?? '';
      const events: WorldEvent[] = [];
      if (response.finishReason === 'length') {
        turns.push({ turn: turnNo, userMessage: pendingUser, assistantRaw, calls: events,
          finishReason: response.finishReason, usage: response.usage });
        turnErrors.push(`TURN_${turnNo}_OUTPUT_TRUNCATED`);
        terminationReason = 'truncated';
        break;
      }
      let calls: ReturnType<typeof strictCalls> = [];
      try {
        calls = strictCalls(assistantRaw);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        terminationReason = 'protocol_error';
        turnErrors.push(`TURN_${turnNo}_PROTOCOL_ERROR: ${error instanceof Error ? error.message : String(error)}`);
      }
      // Infrastructure failures must propagate as execution errors, not be
      // attributed to malformed model protocol.
      for (const call of calls) events.push(await world.call(call.tool, call.args));
      turns.push({ turn: turnNo, userMessage: pendingUser, assistantRaw, calls: events,
        finishReason: response.finishReason, usage: response.usage });
      transcript.push(`[用户] ${pendingUser}`, `[助手] ${assistantRaw}`,
        ...events.map((event) => `[工具 ${event.tool}] ${JSON.stringify(event.result)}`));
      const scripted = config.userScript?.[turnNo - 1];
      if (terminationReason === 'protocol_error') break;
      if (scripted !== undefined) { pendingUser = scripted; continue; }
      if (extractWorldFinalMessage(assistantRaw,options.constraints?.answerFirst===true)) { terminationReason = 'completed'; break; }
      if (events.length === 0) { terminationReason = 'no_action'; break; }
      pendingUser = '（系统）如需继续操作请调用工具；完成后请用 SAY 回复。';
    }
    if (terminationReason === 'turn_limit') turnErrors.push('WORLD_TURN_LIMIT');
    const finalMessage = extractWorldFinalMessage(turns.at(-1)?.assistantRaw ?? '',options.constraints?.answerFirst===true);
    const trace: WorldTrace = { answerFirstRequested:options.constraints?.answerFirst===true,imageId: world.imageId, initialState: config.initialState, finalState: world.snapshot(), turns,
      events: world.events, finalMessage, turnErrors, elapsedMs: Date.now() - started, terminationReason, hardTimeoutMs };
    return { response: { content: finalMessage,
      finishReason: lastResponse?.finishReason === 'length' ? 'length' : turnErrors.length ? 'unknown' : 'stop',
      usage, latencyMs: trace.elapsedMs, executionWorld: trace }, trace };
  } finally { await world.close(); }
}
