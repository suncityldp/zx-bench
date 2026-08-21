// ============================================================
// C 隐藏测试容器执行（Phase 2 垂直切片）。
// 生成 main.c + assert 测试，gcc -fsanitize=address 编译运行。
// ASan 让 buffer overflow / use-after-free 等内存错误变成确定性运行时错误。
// ============================================================

import type { HiddenTestCase } from '@zxbench/types';
import { runInContainer } from './containerRunner.js';

export interface CFixture {
  /** 额外 #include（如 <stdint.h>） */
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

const C_IMAGE = 'gcc:13';

export function buildCHarness(
  sourceCode: string,
  testCases: HiddenTestCase[],
  fixture: CFixture = {},
): { 'main.c': string } {
  const includes = ['<stdio.h>', '<stdlib.h>', '<string.h>', '<assert.h>', ...(fixture.includes ?? [])];
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
  return { 'main.c': parts.join('\n') };
}

/** 逐个测试独立编译运行（assert/ASan 失败会 abort，需隔离才能逐测试判定） */
export function runCTestsInContainer(
  sourceCode: string,
  testCases: HiddenTestCase[],
  fixture: CFixture = {},
  timeoutMs = 30000,
): CRunResult {
  const tests: { name: string; passed: boolean }[] = [];
  let allStdout = '';
  let allStderr = '';
  let exitCode = 0;
  let timedOut = false;
  const startedAt = Date.now();

  for (let i = 0; i < testCases.length; i++) {
    const harness = buildCHarness(sourceCode, [testCases[i]], fixture);
    const res = runInContainer({
      image: C_IMAGE,
      command: ['sh', '-c', 'gcc -fsanitize=address -g main.c -o /tmp/a.out && /tmp/a.out'],
      files: [{ path: 'main.c', content: harness['main.c'] }],
      timeoutMs,
      memoryMb: 256,
      pidsLimit: 64,
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
