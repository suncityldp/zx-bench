// ============================================================
// C/C++ 隐藏测试容器执行（Phase 2 垂直切片）。
// 生成 main.c / main.cpp + assert 测试，gcc / g++ -fsanitize=address 编译运行。
// ASan 让 buffer overflow / use-after-free 等内存错误变成确定性运行时错误。
// ============================================================

import type { HiddenTestCase } from '@zxbench/types';
import { runInContainer } from './containerRunner.js';

export interface CFixture {
  /** 额外 #include（如 <stdint.h> / <cstddef>） */
  includes?: string[];
  helpers?: string;
}

export interface CRunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  tests: { name: string; passed: boolean }[];
}

const C_IMAGE = 'zxbench/cpp:gcc13-valgrind';

export function buildCHarness(
  sourceCode: string,
  testCases: HiddenTestCase[],
  fixture: CFixture = {},
  cpp = false,
): Record<string, string> {
  const file = cpp ? 'main.cpp' : 'main.c';
  const base = cpp
    ? ['<cstdio>', '<cstdlib>', '<cstring>', '<cassert>']
    : ['<stdio.h>', '<stdlib.h>', '<string.h>', '<assert.h>'];
  const includes = [...base, ...(fixture.includes ?? [])];
  const incBlock = includes.map((i) => '#include ' + i).join('\n');
  const tests = testCases.map((tc) => '    { ' + tc.testCode.trim() + ' }').join('\n');
  const parts = [
    incBlock,
    '',
    sourceCode.trim(),
  ];
  const helpers = (fixture.helpers || '').trim();
  if (helpers) parts.push('', helpers);
  parts.push('', 'int main() {', tests, '    return 0;', '}', '');
  return { [file]: parts.join('\n') };
}

/** 逐个测试独立编译运行（assert/ASan 失败会 abort，需隔离才能逐测试判定） */
export function runCTestsInContainer(
  sourceCode: string,
  testCases: HiddenTestCase[],
  fixture: CFixture = {},
  timeoutMs = 30000,
  cpp = false,
): CRunResult {
  const file = cpp ? 'main.cpp' : 'main.c';
  const compiler = cpp ? 'g++ -std=c++17' : 'gcc';
  const tests: { name: string; passed: boolean }[] = [];
  let allStdout = '';
  let allStderr = '';
  let exitCode = 0;
  let timedOut = false;
  const startedAt = Date.now();

  for (let i = 0; i < testCases.length; i++) {
    const harness = buildCHarness(sourceCode, [testCases[i]], fixture, cpp);
    const res = runInContainer({
      image: C_IMAGE,
      command: ['sh', '-c', `${compiler} -g ${file} -o /tmp/a.out && /tmp/a.out`],
      files: [{ path: file, content: harness[file] }],
      timeoutMs,
      memoryMb: 256,
      pidsLimit: 64,
      env: { ASAN_OPTIONS: 'detect_stack_use_after_return=0:halt_on_error=1:detect_leaks=0' },
    });
    tests.push({ name: 't' + i, passed: res.exitCode === 0 && !res.timedOut });
    allStdout += res.stdout;
    allStderr += res.stderr;
    if (res.exitCode !== 0) exitCode = res.exitCode;
    if (res.timedOut) timedOut = true;
  }

  return {
    success: tests.every((t) => t.passed),
    stdout: allStdout,
    stderr: allStderr,
    exitCode,
    timedOut,
    durationMs: Date.now() - startedAt,
    tests,
  };
}

/** C++ 隐藏测试容器执行：g++ -std=c++17 + ASan + assert */
export function runCppTestsInContainer(
  sourceCode: string,
  testCases: HiddenTestCase[],
  fixture: CFixture = {},
  timeoutMs = 30000,
): CRunResult {
  return runCTestsInContainer(sourceCode, testCases, fixture, timeoutMs, true);
}


export interface CTsanResult {
  raceDetected: boolean;
  passed: boolean;
  compileError: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

const TREIBER_TSAN_MAIN = `int main() {
    {
        TreiberStack s;
        for (int i = 1; i <= 5; i++) s.push(i);
        int out; std::vector<int> v;
        while (s.pop(out)) v.push_back(out);
        assert(v.size() == 5);
        for (int i = 0; i < 5; i++) assert(v[i] == 5 - i);
    }
    {
        TreiberStack s; int out;
        assert(!s.pop(out));
    }
    {
        TreiberStack s;
        const int P = 8, N = 20000;
        std::atomic<int> pushed{0};
        std::atomic<bool> done{false};
        std::vector<std::thread> pros;
        for (int p = 0; p < P; p++) {
            pros.emplace_back([&, p]() {
                for (int i = 0; i < N; i++) { s.push(p * N + i); pushed.fetch_add(1); }
            });
        }
        std::vector<int> counts(P * N, 0);
        std::atomic<int> popped{0};
        std::thread con([&]() {
            int v;
            while (true) {
                if (s.pop(v)) { counts[v]++; popped.fetch_add(1); }
                else if (done.load() && pushed.load() == popped.load()) break;
            }
        });
        for (auto& t : pros) t.join();
        done.store(true);
        con.join();
        assert(popped.load() == P * N);
        for (int i = 0; i < P * N; i++) assert(counts[i] == 1);
    }
    puts("ALL_TESTS_PASSED");
    return 0;
}`;

/** C++ 并发题 TSan 压测：Treiber 无锁栈内存序（CP-L3-CC-005）。
 *  编译 g++ -fsanitize=thread，用 setarch -R 关 ASLR（需 seccomp=unconfined）。
 *  正确实现：无 data race 且 ALL_TESTS_PASSED；错误实现：TSan 报 data race（exit 66）。 */
export function runCppTsanInContainer(sourceCode: string, timeoutMs = 120000): CTsanResult {
  const file = 'main.cpp';
  const includes = ['<atomic>', '<thread>', '<vector>', '<cstdio>', '<cassert>'];
  const incBlock = includes.map((i) => '#include ' + i).join('\n');
  const harness = incBlock + '\n\n' + sourceCode.trim() + '\n\n' + TREIBER_TSAN_MAIN;
  const startedAt = Date.now();
  const res = runInContainer({
    image: C_IMAGE,
    command: ['sh', '-c', 'g++ -std=c++17 -fsanitize=thread -g ' + file + ' -o /tmp/t && setarch $(uname -m) -R /tmp/t'],
    files: [{ path: file, content: harness }],
    timeoutMs,
    memoryMb: 768,
    cpuLimit: 2.0,
    pidsLimit: 256,
    networkDisabled: true,
    readOnly: false,
    seccompUnconfined: true,
    env: { TSAN_OPTIONS: 'halt_on_error=1' },
  });
  const stderr = res.stderr || '';
  const stdout = res.stdout || '';
  return {
    raceDetected: /WARNING: ThreadSanitizer: data race/.test(stderr),
    passed: /ALL_TESTS_PASSED/.test(stdout) && !/WARNING: ThreadSanitizer/.test(stderr),
    compileError: /error:/.test(stderr) && !/ThreadSanitizer/.test(stderr),
    stdout,
    stderr,
    exitCode: res.exitCode,
    timedOut: res.timedOut,
    durationMs: Date.now() - startedAt,
  };
}
