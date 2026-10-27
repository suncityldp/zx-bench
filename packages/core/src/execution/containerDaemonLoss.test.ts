import { beforeEach, describe, it, expect, vi } from 'vitest';
import { execAsync } from './execAsync.js';
import { runInContainer } from './containerRunner.js';
vi.mock('./execAsync.js', () => ({ execAsync: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
describe('Docker connection failures after readiness', () => {
  it('does not mistake candidate exit 125 or fake daemon error text for infrastructure failure',async()=>{
    vi.mocked(execAsync).mockImplementation(async(_cmd,args)=>({
      status:args[0]==='run'?125:0,
      stdout:args[0]==='inspect'?JSON.stringify({StartedAt:'2026-09-12T00:00:00Z',Error:'',ExitCode:125}):'',
      stderr:args[0]==='run'?'Docker unavailable — container execution skipped':'',
    }));
    const r=await runInContainer({image:'fixture',command:['false'],localImageOnly:true,readOnlyRoot:true});
    expect(r.infrastructureError).toBeUndefined();expect(r.success).toBe(false);
    const args=vi.mocked(execAsync).mock.calls.find(([,args])=>args[0]==='run')![1];
    expect(args).toContain('--read-only');expect(args).toContain('--tmpfs');expect(args).not.toContain('--rm');
  });
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

it.each(['mount','inspect'])('retains safe %s failure evidence',async(stage)=>{
 vi.mocked(execAsync).mockImplementation(async(_cmd,args)=>({status:args[0]==='run'?125:args[0]==='inspect'&&stage==='inspect'?1:0,
 stdout:args[0]==='inspect'&&stage==='mount'?JSON.stringify({StartedAt:'0001-',Error:'invalid mount /private/token=secret'}):'',
 stderr:args[0]==='inspect'?'No such container /private/secret':''}));
 const r=await runInContainer({image:'fixture',command:['false'],localImageOnly:true});
 expect(r.infrastructureError).toBeTruthy();
 expect(r.infrastructureEvidence).toMatchObject({runStatus:125,dockerError:stage==='mount'?'mount-error':'container-missing'});
 expect(JSON.stringify(r.infrastructureEvidence)).not.toMatch(/private|secret/);
 expect(vi.mocked(execAsync).mock.calls.filter(c=>c[1][0]==='run')).toHaveLength(1);
});
it('localImageOnly never builds or pulls a missing image',async()=>{
 vi.mocked(execAsync).mockImplementation(async(_cmd,args)=>({status:args[0]==='image'?1:0,stdout:'',stderr:''}));
 const r=await runInContainer({image:'missing',command:['true'],localImageOnly:true});
 expect(r.infrastructureError).toBeTruthy();
 expect(vi.mocked(execAsync).mock.calls.some(c=>['pull','build','run'].includes(c[1][0]))).toBe(false);
});
it.each([NaN,Infinity,1.5,'secret-status',null])('normalizes malformed diagnostic status %s',async status=>{
 vi.mocked(execAsync).mockImplementation(async(_cmd,args)=>({status:args[0]==='run'||args[0]==='inspect'?status:0,stdout:'',stderr:'No such container'} as any));
 const result=await runInContainer({image:'fixture',command:['false'],localImageOnly:true});
 expect(result.infrastructureEvidence).toMatchObject({runStatus:null,inspectStatus:null});
 expect(JSON.stringify(result.infrastructureEvidence)).not.toContain('secret-status');
});
