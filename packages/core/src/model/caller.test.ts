import { afterEach, describe, expect, it, vi } from 'vitest';
import { callModel, type CallModelOptions } from './caller.js';

const options = { config: { name: 'test', provider: 'openai', baseUrl: 'http://unused/v1' }, params: {}, userPrompt: 'test', stream: true } as CallModelOptions;
const event = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
function stream(text: string, close = true, cancel = vi.fn()) {
  return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); if (close) c.close(); }, cancel }), { headers: { 'content-type': 'text/event-stream' } });
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('OpenAI-compatible usage and reasoning streams', () => {
  it('honors the explicit 1,200-second limit over a 600-second model default', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    })));
    let settled = false;
    const pending = callModel({ ...options, params: { timeout: 600000 }, constraints: { hardTimeLimitMs: 1200000 } })
      .then(() => { settled = true; return ''; }, error => { settled = true; return error.message; });
    await vi.advanceTimersByTimeAsync(600000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(600000);
    expect(await pending).toContain('1200000ms');
  });
  it('stops at the protocol DONE marker even if the proxy leaves the connection open', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream(event({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n', false, cancel)));
    expect((await callModel(options)).content).toBe('done');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('reads choices:[] usage and does not count reasoning twice', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream(
      event({ choices: [{ delta: { reasoning_content: 'thinking' } }] }) +
      event({ choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }) +
      event({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 20 } } }) + 'data: [DONE]\n\n')));
    const r = await callModel(options);
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 30, totalTokens: 130, reasoningTokens: 20, source: 'provider' });
    expect(r.content).toBe('answer');
    expect(r.reasoningContent).toBe('thinking');
  });
  it('handles timings-only usage and an unterminated final SSE line', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream(event({ choices: [], timings: { prompt_n: 10, cache_n: 90, predicted_n: 20 } }) + event({ choices: [{ delta: { content: 'tail' }, finish_reason: 'stop' }] }).trimEnd())));
    const r = await callModel(options);
    expect(r.content).toBe('tail');
    expect(r.finishReason).toBe('stop');
    expect(r.usage.totalTokens).toBe(120);
  });
  it('estimates both generated channels when provider omits usage', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream(event({ choices: [{ delta: { reasoning: 'a'.repeat(90), content: 'a'.repeat(30) }, finish_reason: 'stop' }] }))));
    expect((await callModel(options)).usage).toMatchObject({ outputTokens: 40, source: 'estimated' });
  });
  it.each([true, false])('does not promote reasoning into a final answer (stream=%s)', async (streaming) => {
    const choice = { delta: { reasoning: 'only thinking' }, message: { reasoning: 'only thinking' }, finish_reason: 'length' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streaming ? stream(event({ choices: [choice] })) : Response.json({ choices: [choice] })));
    const r = await callModel({ ...options, stream: streaming });
    expect(r.content).toBe('');
    expect(r.reasoningContent).toBe('only thinking');
  });
  it('keeps the reasoning budget on stream_options fallback and cancels generation', async () => {
    const cancel = vi.fn();
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('unsupported stream_options', { status: 400 })).mockResolvedValueOnce(stream(event({ choices: [{ delta: { reasoning_content: 'a'.repeat(100) } }] }), false, cancel));
    vi.stubGlobal('fetch', fetchMock);
    const r = await callModel({ ...options, constraints: { maxReasoningTokens: 10 } });
    expect(r.finishReason).toBe('length');
    expect(cancel).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).stream_options).toBeUndefined();
  });
});
