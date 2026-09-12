import { describe, expect, it } from 'vitest';
import type { HiddenTestCase } from '@zxbench/types';
import { runPhpTestsInContainer } from './phpRunner.js';
import { runBashTestsInContainer } from './bashRunner.js';
import { runCTestsInContainer, runCppTestsInContainer } from './cRunner.js';
import { runRustTestsInContainer } from './rustRunner.js';
import { runCsharpTestsInContainer } from './csharpRunner.js';
import { runGoTestsInContainer } from './goRunner.js';
import { runJavaTestsInContainer } from './javaRunner.js';
import { runSqlInContainer } from './sqlRunner.js';
import { runInContainer } from './containerRunner.js';
import { runTestCaseInContainer, runReplacedCodeTestPythonInContainer } from '../sandbox/index.js';
import { codeRepairEvaluator } from '../evaluators/codeRepair.js';

// Explicit opt-in: ordinary unit tests must not silently download/start Docker.
const integration = process.env.ZXBENCH_CONTAINER_TESTS === '1' ? describe : describe.skip;
const tc = (testCode: string): HiddenTestCase => ({ id: 'behavior', type: 'hidden', testCode });
type Result = { tests: { passed: boolean }[]; stdout: string; stderr: string; compiled?: boolean };
type Runner = (source: string, tests: HiddenTestCase[]) => Promise<Result>;
const cases: { language: string; run: Runner; correct: string; wrong: string; early: string; assertion: string }[] = [
  { language: 'PHP', run: runPhpTestsInContainer, correct: '<?php function answer() { return 42; } ?>', wrong: 'function answer() { return 0; }', early: 'exit(0);', assertion: 'assert(answer() === 42);' },
  { language: 'Bash', run: runBashTestsInContainer, correct: 'answer() { echo 42; }', wrong: 'answer() { echo 0; }', early: 'exit 0', assertion: '[[ "$(answer)" == "42" ]]\necho after_assertion' },
  { language: 'C', run: runCTestsInContainer, correct: 'int answer() { return 42; }', wrong: 'int answer() { return 0; }', early: 'int answer() { exit(0); }', assertion: 'assert(answer() == 42);' },
  { language: 'C++', run: runCppTestsInContainer, correct: 'int answer() { return 42; }', wrong: 'int answer() { return 0; }', early: 'int answer() { exit(0); }', assertion: 'assert(answer() == 42);' },
  { language: 'Rust', run: runRustTestsInContainer, correct: 'fn answer() -> i32 { 42 }', wrong: 'fn answer() -> i32 { 0 }', early: 'fn answer() -> i32 { std::process::exit(0) }', assertion: 'assert_eq!(answer(), 42);' },
  { language: 'C#', run: (s, t) => runCsharpTestsInContainer(s, t, { wrapInClass: true }), correct: 'static int Answer() { return 42; }', wrong: 'static int Answer() { return 0; }', early: 'static int Answer() { Environment.Exit(0); return 0; }', assertion: 'Assert.Equal(42, Answer());' },
  { language: 'Go', run: runGoTestsInContainer, correct: 'func answer() int { return 42 }', wrong: 'func answer() int { return 0 }', early: 'func answer() int { panic("stop") }', assertion: 'if answer() != 42 { t.Fatal("wrong") }' },
  { language: 'Java', run: (s, t) => runJavaTestsInContainer(s, t, { wrapInClass: true }), correct: 'static int answer() { return 42; }', wrong: 'static int answer() { return 0; }', early: 'static int answer() { System.exit(0); return 0; }', assertion: 'assertEquals(42, answer());' },
];

integration('real cross-language positive/negative execution controls', () => {
  for (const c of cases) {
    it(c.language + ': correct passes; wrong and premature exit cannot pass', async () => {
      for (const [source, expected] of [[c.correct, true], [c.wrong, false], [c.early, false]] as const) {
        const result = await c.run(source, [tc(c.assertion)]);
        expect(result.tests, result.stderr + '\n' + result.stdout).toHaveLength(1);
        expect(result.tests[0].passed, result.stderr + '\n' + result.stdout).toBe(expected);
        expect(result.compiled, 'assertion failure/early exit is not compile failure: ' + result.stderr).toBe(true);
      }
      const invalid = c.language === 'Bash' ? 'if then' : c.language === 'PHP' ? '<?php function (' : 'INVALID SYNTAX { !!!';
      const r = await c.run(invalid, [tc(c.assertion)]);
      expect(r.compiled, r.stderr).toBe(false);
      expect(r.tests[0].passed).toBe(false);
    }, 180_000);
  }
  for (const language of ['JavaScript', 'TypeScript', 'Python']) {
    it(language + ': correct passes; wrong and successful early exit fail', async () => {
      for (const mode of ['correct', 'wrong', 'early']) {
        const value = mode === 'correct' ? 42 : 0;
        const py = language === 'Python';
        const source = py ? `def answer(): return ${value}\n${mode === 'early' ? 'import sys; sys.exit(0)' : ''}`
          : `function answer()${language === 'TypeScript' ? ': number' : ''} { return ${value}; }\n${mode === 'early' ? 'process.exit(0);' : ''}`;
        const test = tc(py ? 'assert answer() == 42' : 'if (answer() !== 42) throw Error("wrong");');
        const result = py ? await runReplacedCodeTestPythonInContainer(source, test)
          : await runTestCaseInContainer(source, null, test);
        expect(result.passed, result.stderr).toBe(mode === 'correct');
      }
    }, 120_000);
  }
  it('SQL: checks actual rows, wrong rows and invalid queries', async () => {
    const fixture = { schema: 'create table data (n integer);', seed: 'insert into data values (42);', expectedResult: [{ n: 42 }] };
    for (const [query, pass] of [['select n from data', true], ['select 0 as n', false], ['invalid sql', false]] as const) {
      const r = await runSqlInContainer(query, fixture);
      expect(r.passed, r.stderr).toBe(pass);
    }
  }, 120_000);
  it('Go preserves all tests when the second test panics', async () => {
    const r = await runGoTestsInContainer('', [tc(''), tc('panic("stop")'), tc('')]);
    expect(r.tests).toHaveLength(3);
    expect(r.tests.every(t => !t.passed)).toBe(true);
    expect(r.compiled).toBe(true);
  }, 60_000);
  it('default container runs non-root, with read-only source and no non-loopback interface', async () => {
    const r = await runInContainer({ image: 'bash:5', command: ['bash', '-ec',
      'test "$(id -u)" != 0; ! touch /workspace/source; test "$(ls /sys/class/net)" = lo'], files: [{ path: 'source', content: 'original' }] });
    expect(r.success, r.stderr).toBe(true);
  }, 60_000);
  it('timeout is reported as failure, never a successful empty test', async () => {
    const r = await runBashTestsInContainer('answer() { while true; do :; done; }', [tc('answer')], {}, 1000);
    expect(r.timedOut, r.stderr).toBe(true);
    expect(r.tests[0].passed).toBe(false);
  }, 30_000);
  it('C Valgrind fixture rejects use-after-free and accepts clean memory handling', async () => {
    for (const invalid of [false, true]) {
      const source = `int answer() { int *p = malloc(sizeof(int)); *p=42; ${invalid ? 'free(p); volatile int n=*p;' : 'int n=*p; free(p);'} return 42; }`;
      const r = await runCTestsInContainer(source, [tc('assert(answer()==42);')], { memoryCheck: 'valgrind' });
      expect(r.compiled, r.stderr).toBe(true);
      expect(r.tests[0].passed, r.stderr).toBe(!invalid);
    }
  }, 60_000);
  it('production evaluator defaults to containers for JS/Python, not host execution', async () => {
    const old = process.env.ZXBENCH_EXECUTION_BACKEND;
    delete process.env.ZXBENCH_EXECUTION_BACKEND;
    try {
      for (const language of ['javascript', 'python']) {
        const source = language === 'python' ? 'def answer(): return 42' : 'function answer() { return 42; }';
        const s = {id:'container-default',language,grader:'code_repair',graderVersion:'3.4.0',sourceCode:source,functionName:'answer',requirements:{},scoring:{},hiddenTests:[tc(language==='python'?'assert answer()==42':'if(answer()!==42) throw Error("wrong");')]} as any;
        const r = await codeRepairEvaluator.evaluate(s,'```\n'+source+'\n```',{incomplete:false,truncated:false} as any,{} as any);
        expect(r.axisScores?.test_pass, r.evidence?.join('\n')).toBe(100);
        expect(r.environmentError).not.toBe(true);
      }
    } finally { if(old===undefined) delete process.env.ZXBENCH_EXECUTION_BACKEND; else process.env.ZXBENCH_EXECUTION_BACKEND=old; }
  }, 60_000);
});
