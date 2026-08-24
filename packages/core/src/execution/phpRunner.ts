// ============================================================
// PHP 隐藏测试容器执行（Phase 2 垂直切片）。
// 生成 main.php（<?php + sourceCode + assert 测试），php:8.2-cli 运行。
// php:8.2-cli 内置 mbstring，assert 默认抛 AssertionError（zend.assertions=1）。
// ============================================================

import type { HiddenTestCase } from '@zxbench/types';
import { runInContainer } from './containerRunner.js';

export interface PhpFixture {
  phpVersion?: string;
  helpers?: string;
}

export interface PhpRunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  tests: { name: string; passed: boolean }[];
}

const PHP_IMAGE = 'php:8.2-cli-alpine';

export function buildPhpHarness(
  sourceCode: string,
  testCases: HiddenTestCase[],
  fixture: PhpFixture = {},
): { 'main.php': string } {
  const parts = ['<?php', sourceCode.trim()];
  const helpers = (fixture.helpers || '').trim();
  if (helpers) parts.push(helpers);
  parts.push('', ...testCases.map((tc) => tc.testCode.trim()), '');
  return { 'main.php': parts.join('\n\n') };
}

/** 逐测试独立运行（assert 失败 fatal，需隔离才能逐测试判定） */
export async function runPhpTestsInContainer(
  sourceCode: string,
  testCases: HiddenTestCase[],
  fixture: PhpFixture = {},
  timeoutMs = 30000,
): Promise<PhpRunResult> {
  const tests: { name: string; passed: boolean }[] = [];
  let allStdout = '';
  let allStderr = '';
  let exitCode = 0;
  let timedOut = false;
  const startedAt = Date.now();

  for (let i = 0; i < testCases.length; i++) {
    const harness = buildPhpHarness(sourceCode, [testCases[i]], fixture);
    const res = await runInContainer({
      image: PHP_IMAGE,
      command: ['php', 'main.php'],
      files: [{ path: 'main.php', content: harness['main.php'] }],
      timeoutMs,
      memoryMb: 128,
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
