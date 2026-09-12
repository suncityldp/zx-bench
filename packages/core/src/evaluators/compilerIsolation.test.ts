import { describe, it, expect, vi } from 'vitest';
import { projectRepairEvaluator } from './projectRepair.js';
import { isDockerAvailable, runInContainer } from '../execution/index.js';
import type { Scenario, OutputMetadata } from '@zxbench/types';
vi.mock('../execution/index.js', async original => ({ ...await original<object>(), isDockerAvailable: vi.fn(), runInContainer: vi.fn() }));
describe('compiler failure precedence over later cold startup', () => {
  it('does not attempt another cold container after a verified compiler failure', async () => {
    vi.mocked(isDockerAvailable).mockResolvedValue(true);
    vi.mocked(runInContainer).mockResolvedValue({ success:false, stdout:'', stderr:'Updating crates.io index\nwarning: spurious network error: SSL failure\n'+ ' Downloading crates ...\n'.repeat(150) +'error: expected `{`\nerror: could not compile `app` due to 1 previous error',exitCode:101,timedOut:false,durationMs:1 });
    const scenario={id:'compiler',language:'rust',requirements:{files:[{path:'src/lib.rs',content:'broken'}],hiddenTests:[{description:'one',script:'cargo test'},{description:'two',script:'cargo test'}]},scoring:{}} as unknown as Scenario;
    const result=await projectRepairEvaluator.evaluate(scenario,'### file: src/lib.rs\n```rust\nbroken\n```',{} as OutputMetadata);
    expect(runInContainer).toHaveBeenCalledTimes(1);
    expect(result.environmentError).not.toBe(true);
    expect(result.evidence?.some(e=>e.startsWith('COMPILATION_FAILED:'))).toBe(true);
    const execution = JSON.parse(result.evidence!.find(e=>e.startsWith('EXECUTION_EVIDENCE:'))!.slice('EXECUTION_EVIDENCE: '.length));
    expect(execution.stderrTruncated).toBe(true);
    expect(execution.stderr).toContain('error: could not compile `app`');
  });
});
