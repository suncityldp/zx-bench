import {appendFileSync, existsSync} from 'node:fs';
import {postHE001Once} from './he001JudgeTrial.js';

/** One provider request. Preserves wire and partial output; no SDK retry or model fallback. */
export async function apiControlStream(options: {endpoint: string; key: string; body: unknown; wireFile: string; stopFile: string;
  timeoutMs: number; onProgress?: (value: {bytes: number; elapsedMs: number}) => void}, post = postHE001Once) {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 1200000) throw new Error('Invalid hard timeout');
  const controller = new AbortController(), abort = () => controller.abort(), started = Date.now();
  const timer = setTimeout(abort, options.timeoutMs), ticker = setInterval(() => {
    if (existsSync(options.stopFile)) abort(); options.onProgress?.({bytes, elapsedMs: Date.now() - started});
  }, 1000);
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  let content = '', reasoningContent = '', finishReason = 'unknown', streamDone = false, bytes = 0;
  let httpStatus: number | null = null, error: string | null = null, usage: unknown = null;
  const models = new Set<string>(), responseIds = new Set<string>();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (existsSync(options.stopFile)) abort();
    controller.signal.throwIfAborted();
    const response = await post(options.endpoint, options.key, options.body, controller.signal); httpStatus = response.status;
    if (!response.ok) {await response.body?.cancel(); throw new Error('HTTP_' + response.status);}
    if (!response.body) throw new Error('missing_body'); reader = response.body.getReader();
    const decoder = new TextDecoder(); let pending = '';
    const consume = (line: string) => {
      if (!line.startsWith('data:')) return; const text = line.slice(5).trim();
      if (text === '[DONE]') {streamDone = true; return;} if (!text) return;
      const chunk = JSON.parse(text); if (chunk.error) throw new Error('provider_stream_error');
      if (chunk.model) models.add(String(chunk.model)); if (chunk.id) responseIds.add(String(chunk.id)); if (chunk.usage) usage = chunk.usage;
      for (const choice of chunk.choices ?? []) {
        if ((choice.index ?? 0) !== 0) throw new Error('extra_choice');
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta ?? {}; if (delta.tool_calls || delta.function_call) throw new Error('unexpected_tool_call');
        if (typeof delta.content === 'string') content += delta.content;
        const reasoning = delta.reasoning_content ?? delta.reasoning; if (typeof reasoning === 'string') reasoningContent += reasoning;
      }
    };
    while (!streamDone) {
      const chunk = await reader.read();
      if (chunk.done) {pending += decoder.decode(); if (pending.trim()) consume(pending.trim()); break;}
      bytes += chunk.value.byteLength; if (bytes > 67108864) throw new Error('wire_size_limit');
      appendFileSync(options.wireFile, chunk.value); pending += decoder.decode(chunk.value, {stream: true});
      let at: number; while ((at = pending.indexOf('\n')) >= 0) {consume(pending.slice(0, at).replace(/\r$/, '')); pending = pending.slice(at + 1);}
    }
    if (!streamDone) throw new Error('missing_done');
    if (finishReason !== 'stop') throw new Error(finishReason === 'length' ? 'truncated' : 'non_stop_finish');
  } catch (e) {
    const message = e instanceof Error ? e.message : '';
    error = controller.signal.aborted ? 'timeout_or_cancelled'
      : /^(HTTP_\d+|missing_body|provider_stream_error|extra_choice|unexpected_tool_call|wire_size_limit|missing_done|truncated|non_stop_finish)$/.test(message) ? message : 'transport_or_stream_parse_error';
  } finally {
    clearTimeout(timer); clearInterval(ticker); if (reader) try {await reader.cancel();} catch {}
    controller.abort(); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
  return {content, reasoningContent, finishReason, streamDone, usage, httpStatus, error, bytes,
    returnedModels: [...models], responseIds: [...responseIds], latencyMs: Date.now() - started, remoteCancellationGuaranteed: false};
}
