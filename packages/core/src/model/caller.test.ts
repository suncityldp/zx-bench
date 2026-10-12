import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildConstraintInstructions, callModel, callModelWithRetry, type CallModelOptions } from './caller.js';

const options = { config: { name: 'test', provider: 'openai', baseUrl: 'http://unused/v1' }, params: {}, userPrompt: 'test', stream: true } as CallModelOptions;
const event = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
function stream(text: string, close = true, cancel = vi.fn()) {
  return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); if (close) c.close(); }, cancel }), { headers: { 'content-type': 'text/event-stream' } });
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('request cancellation and idle recovery', () => {
  it.each([true,false])('makes no request for an already cancelled signal (stream=%s)', async stream => {
    const controller=new AbortController(),reason=new Error('fixture cancellation');controller.abort(reason);
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    await expect(callModel({...options,stream,signal:controller.signal})).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('removes controller listeners after a successful request', async () => {
    const controller=new AbortController(),add=vi.spyOn(controller.signal,'addEventListener'),remove=vi.spyOn(controller.signal,'removeEventListener');
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(stream(event({choices:[{delta:{content:'ok'},finish_reason:'stop'}]})+'data: [DONE]\n\n')));
    expect((await callModel({...options,signal:controller.signal})).content).toBe('ok');
    const listener=add.mock.calls.find(([event])=>event==='abort')?.[1];
    expect(remove).toHaveBeenCalledWith('abort',listener);
  });
  it('bounds stream cancellation even when the underlying callback never resolves', async () => {
    vi.useFakeTimers();
    const cancel=vi.fn(()=>new Promise<void>(()=>{}));
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(stream(event({choices:[{delta:{content:'ok'},finish_reason:'stop'}]})+'data: [DONE]\n\n',false,cancel)));
    const pending=callModel(options);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).content).toBe('ok');expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('enforces the hard deadline while reading a mock stream that ignores fetch abort', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(stream('',false)));
    const result=callModel({...options,params:{hardTimeoutMs:50}}).catch(error=>error);
    await vi.advanceTimersByTimeAsync(50);
    expect((await result).message).toContain('timed out after 50ms');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not reissue an idle generation request', async () => {
    vi.useFakeTimers();
    const fetch=vi.fn().mockImplementation(async()=>stream('',false));vi.stubGlobal('fetch',fetch);
    const result=callModelWithRetry({...options,params:{hardTimeoutMs:600000}},3).catch(error=>error);
    await vi.advanceTimersByTimeAsync(180000);
    expect((await result).message).toContain('Model stream idle');expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('removes completed backoff listeners before the next attempt', async () => {
    vi.useFakeTimers();
    const controller=new AbortController(),add=vi.spyOn(controller.signal,'addEventListener'),remove=vi.spyOn(controller.signal,'removeEventListener');
    vi.stubGlobal('fetch',vi.fn().mockRejectedValueOnce(new Error('temporary fixture failure'))
      .mockResolvedValueOnce(stream('data: [DONE]\n\n')));
    const result=callModelWithRetry({...options,signal:controller.signal},1);
    await vi.advanceTimersByTimeAsync(1000);await result;
    for(const [event,listener] of add.mock.calls)if(event==='abort')expect(remove).toHaveBeenCalledWith('abort',listener);
  });
});

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
  // 2026-09-16：题级预算（requirements.hardSeconds）必须封顶运行级硬止损。
  // 实测 09-15 run 中题面写「时限360秒」的题被跑到 1200 秒才中断，6 题白烧 7200 秒后判 0。
  it('caps the run-level hard limit by the question budget', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    })));
    let settled = false;
    const pending = callModel({ ...options, params: { hardTimeoutMs: 360000 }, constraints: { hardTimeLimitMs: 1200000 } })
      .then(() => { settled = true; return ''; }, error => { settled = true; return error.message; });
    await vi.advanceTimersByTimeAsync(360000);
    expect(settled).toBe(true);
    expect(await pending).toContain('360000ms');
  });

  it('raises the question budget above the model default instead of being capped by it', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    })));
    let settled = false;
    const pending = callModel({ ...options, params: { timeout: 600000, hardTimeoutMs: 1200000 } })
      .then(() => { settled = true; return ''; }, error => { settled = true; return error.message; });
    await vi.advanceTimersByTimeAsync(600000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(600000);
    expect(await pending).toContain('1200000ms');
  });

  it('does not retry a request cancelled by its owning evaluation', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = callModelWithRetry({ ...options, signal: controller.signal }, 3);
    controller.abort(new DOMException('Evaluation cancelled', 'AbortError'));
    await expect(pending).rejects.toThrow('Evaluation cancelled');
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

describe('answer-first prompt policy', () => {
  it('does not force a rationale in automatic mode', () => {
    const text = buildConstraintInstructions({ answerFirst: true, visibleRationale: 'auto' });
    expect(text).toContain('仅当题目允许附加说明时');
    expect(text).toContain('第一个非空行使用 ANSWER:/答案: 标签');
    expect(text).not.toContain('再给出原因或推理过程');
  });

  it('protects strict outputs from labels and visible reasoning', () => {
    const text = buildConstraintInstructions({ answerFirst: true, visibleRationale: 'forbidden' });
    expect(text).toContain('不要输出原因、推理过程');
    expect(text).toContain('不要自行添加 ANSWER:/答案: 标签');
  });

  it('can still require a short rationale when explicitly requested', () => {
    const text = buildConstraintInstructions({ answerFirst: true, visibleRationale: 'required' });
    expect(text).toContain('再给出简短的原因或推理过程');
  });
});
