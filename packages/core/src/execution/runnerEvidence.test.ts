import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runInContainer, containerFilePath } from './containerRunner.js';
import { runGoTestsInContainer } from './goRunner.js';
import { runJavaTestsInContainer } from './javaRunner.js';
import { runSqlInContainer } from './sqlRunner.js';
import { runPhpTestsInContainer } from './phpRunner.js';
import { runBashTestsInContainer } from './bashRunner.js';
vi.mock('./containerRunner.js', async original => ({ ...await original<object>(), runInContainer: vi.fn() }));
const tests = [0,1,2].map(i=>({id:'t'+i,type:'hidden' as const,testCode:''}));
const result = (stdout: string, exitCode = 0, timedOut = false) => ({success:exitCode===0,stdout,stderr:'',exitCode,timedOut,durationMs:1});
beforeEach(()=>vi.resetAllMocks());
describe('runner evidence is complete and non-vacuous',()=>{
  it.each(['../outside','nested/../../outside','C:\\outside','/outside','..\\outside','file:stream',''])('rejects unsafe workspace path %s',path=>{
    expect(()=>containerFilePath(process.cwd(),path)).toThrow();
  });
  it('allows a nested relative workspace file',()=>expect(containerFilePath(process.cwd(),'./src/main.js')).toContain('main.js'));
  it.each([
    ['--- PASS: TestHidden_0 (0.00s)\nFAIL',1],
    ['--- PASS: TestHidden_0 (0.00s)\n--- PASS: TestHidden_0 (0.00s)\nPASS',0],
    ['',0],
  ])('Go preserves fixed denominator for incomplete/duplicate report',async(stdout,exitCode)=>{
    vi.mocked(runInContainer).mockResolvedValue(result(stdout,exitCode));
    const r=await runGoTestsInContainer('',tests);
    expect(r.tests).toHaveLength(3);expect(r.tests.every(t=>!t.passed)).toBe(true);
  });
  it('Go preserves legitimate partial credit only for a complete suite',async()=>{
    vi.mocked(runInContainer).mockResolvedValue(result('--- PASS: TestHidden_0 (0.00s)\n--- FAIL: TestHidden_1 (0.00s)\n--- PASS: TestHidden_2 (0.00s)\nFAIL\n',1));
    expect((await runGoTestsInContainer('',tests)).tests.map(t=>t.passed)).toEqual([true,false,true]);
  });
  it.each([['OK (1 test)\n',0,false],['OK (3 tests)\n',1,false],['OK (3 tests)\n',0,true],['Tests run: 3,  Failures: 1\n',1,false]])('Java rejects inconsistent or truncated report',async(out,exit,timeout)=>{
    vi.mocked(runInContainer).mockResolvedValue(result(out,exit,timeout));
    expect((await runJavaTestsInContainer('',tests)).tests.every(t=>!t.passed)).toBe(true);
  });
  it('Java preserves valid failure inventory partial credit',async()=>{
    vi.mocked(runInContainer).mockResolvedValue(result('1) t1(HiddenTest)\nTests run: 3,  Failures: 1\n',1));
    expect((await runJavaTestsInContainer('',tests)).tests.map(t=>t.passed)).toEqual([true,false,true]);
  });
  it.each(['','RESULT:not-json\nPLAN:""','RESULT:{}\nPLAN:""','RESULT:[]\nRESULT:[]\nPLAN:""'])('SQL missing output cannot equal empty gold',async stdout=>{
    vi.mocked(runInContainer).mockResolvedValue(result(stdout));
    expect((await runSqlInContainer('select 1',{schema:'',seed:'',expectedResult:[]})).passed).toBe(false);
  });
  it.each([runPhpTestsInContainer,runBashTestsInContainer])('empty test suite is not successful',async run=>{
    expect((await run('',[])).success).toBe(false);expect(runInContainer).not.toHaveBeenCalled();
  });
});
