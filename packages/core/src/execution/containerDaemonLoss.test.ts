import { beforeEach, describe, it, expect, vi } from 'vitest';
import { execAsync } from './execAsync.js';
import { runInContainer } from './containerRunner.js';
vi.mock('./execAsync.js', () => ({ execAsync: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
describe('Docker connection failures after readiness', () => {
  it('isolates Windows exit 1 when an independent daemon probe fails', async () => {
    let probes = 0;
    vi.mocked(execAsync).mockImplementation(async (_cmd, args) => ({
      status: args[0] === 'version' ? (++probes === 1 ? 0 : 1) : args[0] === 'run' ? 1 : 0,
      stdout: '', stderr: args[0] === 'run' ? 'error during connect: pipe unavailable' : '',
    }) as any);
    const result = await runInContainer({ image: 'fixture', command: ['true'] });
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('Docker unavailable — container execution skipped');
    expect(probes).toBe(2);
    const calls = vi.mocked(execAsync).mock.calls;
    const runArgs = calls.find(([, args]) => args[0] === 'run')![1];
    const name = runArgs[runArgs.indexOf('--name') + 1];
    expect(name).toMatch(/^zxbench-[a-f0-9-]+$/);
    expect(calls.some(([, args]) => args.join(' ') === `rm -f ${name}`)).toBe(true);
  });
  it('keeps compilation failure as a model result when the daemon is healthy', async () => {
    vi.mocked(execAsync).mockImplementation(async (_cmd, args) => ({
      status: args[0] === 'run' ? 1 : 0, stdout: '', stderr: args[0] === 'run' ? 'syntax error' : '',
    }) as any);
    const result = await runInContainer({ image: 'fixture', command: ['true'] });
    expect(result.stderr).toBe('syntax error');
    expect(result.exitCode).toBe(1);
  });
});
