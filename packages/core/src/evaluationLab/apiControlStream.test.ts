import {afterEach, describe, expect, it} from 'vitest';
import {mkdtempSync, readFileSync, writeFileSync, existsSync, unlinkSync, rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {apiControlStream} from './apiControlStream.js';
const directories: string[] = [];
function options() {const dir = mkdtempSync(join(tmpdir(), 'zxbench-api-stream-')); directories.push(dir);
  return {endpoint: 'https://example.invalid/chat/completions', key: 'synthetic-test-key', body: {}, wireFile: join(dir, 'wire.sse'), stopFile: join(dir, 'STOP'), timeoutMs: 1000};}
afterEach(() => {for (const dir of directories.splice(0)) {for (const file of ['wire.sse', 'STOP']) {const path = join(dir, file); if (existsSync(path)) unlinkSync(path);} rmdirSync(dir);}});
const event = (delta: object, finish: string | null = null) => 'data: ' + JSON.stringify({id: 'test-request', model: 'deepseek-flash', choices: [{index: 0, delta, finish_reason: finish}]}) + '\n\n';
describe('one-shot API control transport', () => {
  it('retains exact wire, returned model, reasoning and final output', async () => {
    const o = options(), wire = event({reasoning_content: 'reason'}) + event({content: '{"ok":true}'}, 'stop') + 'data: [DONE]\n\n'; let calls = 0;
    const r = await apiControlStream(o, async () => {calls++; return new Response(wire);});
    expect(calls).toBe(1); expect(r.error).toBeNull(); expect(r.content).toBe('{"ok":true}'); expect(r.reasoningContent).toBe('reason');
    expect(r.returnedModels).toEqual(['deepseek-flash']); expect(readFileSync(o.wireFile, 'utf8')).toBe(wire);
  });
  it('does not retry an HTTP failure or save its possibly sensitive body', async () => {
    const o = options(); let calls = 0; const r = await apiControlStream(o, async () => {calls++; return new Response('sensitive-error-body', {status: 401});});
    expect(calls).toBe(1); expect(r.error).toBe('HTTP_401'); expect(r.content).toBe(''); expect(existsSync(o.wireFile)).toBe(false);
  });
  it('preserves partial answers when completion is missing or truncated', async () => {
    const a = await apiControlStream(options(), async () => new Response(event({content: 'partial'}, 'stop')));
    const b = await apiControlStream(options(), async () => new Response(event({content: 'partial'}, 'length') + 'data: [DONE]\n'));
    expect(a.error).toBe('missing_done'); expect(b.error).toBe('truncated'); expect(b.content).toBe('partial');
  });
  it('rejects tool calls instead of executing them', async () => {
    const r = await apiControlStream(options(), async () => new Response(event({tool_calls: [{id: 'x'}]})));
    expect(r.error).toBe('unexpected_tool_call');
  });
  it('honors a preexisting stop without sending a request', async () => {
    const o = options(); writeFileSync(o.stopFile, 'stop'); let calls = 0;
    const r = await apiControlStream(o, async () => {calls++; return new Response('');});
    expect(calls).toBe(0); expect(r.error).toBe('timeout_or_cancelled');
  });
  it('aborts an outstanding request on the hard timeout without retry', async () => {
    const o = {...options(), timeoutMs: 10}; let calls = 0;
    const r = await apiControlStream(o, async (_url, _key, _body, signal) => {calls++; return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true}));});
    expect(calls).toBe(1); expect(r.error).toBe('timeout_or_cancelled');
  });
});
