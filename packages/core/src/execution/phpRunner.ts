// ============================================================
// PHP 隐藏测试容器执行（Phase 2 垂直切片）。
// 生成 main.php（<?php + sourceCode + assert 测试），php:8.2-cli 运行。
// 显式启用断言；不依赖镜像 php.ini 的生产默认值。
// ============================================================

import type { HiddenTestCase } from '@zxbench/types';
import { runInContainer } from './containerRunner.js';
import { completionToken, completed } from './completion.js';

export interface PhpFixture {
  phpVersion?: string;
  helpers?: string;
}

export interface PhpRunResult {
  compiled: boolean;
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
  const source = sourceCode.trim().replace(/^<\?php\s*/, '').replace(/\?>\s*$/, '');
  const parts = ['<?php', source];
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
  let compiled = testCases.length > 0;
  const startedAt = Date.now();

  for (let i = 0; i < testCases.length; i++) {
    const token = completionToken();
    const harness = buildPhpHarness(sourceCode, [{ ...testCases[i], testCode: testCases[i].testCode + `\necho "\\n${token}\\n";` }], fixture);
    const res = await runInContainer({
      image: PHP_IMAGE,
      command: ['sh', '-c', `php -l main.php && printf '\\n${token}_COMPILED\\n' && php -d zend.assertions=1 -d assert.active=1 -d assert.exception=1 main.php`],
      files: [{ path: 'main.php', content: harness['main.php'] }],
      timeoutMs,
      memoryMb: 128,
      pidsLimit: 64,
    });
    const didComplete = completed(res.stdout, token);
    compiled = compiled && completed(res.stdout, token + '_COMPILED');
    tests.push({ name: 't' + i, passed: res.exitCode === 0 && !res.timedOut && didComplete });
    if (!didComplete && res.exitCode === 0) allStderr += '\nTEST_EXECUTION_INCOMPLETE: no completion evidence\n';
    allStdout += res.stdout;
    allStderr += res.stderr;
    if (res.exitCode !== 0) exitCode = res.exitCode;
    if (res.timedOut) timedOut = true;
  }

  return {
    compiled,
    success: tests.length > 0 && tests.every((t) => t.passed),
    stdout: allStdout,
    stderr: allStderr,
    exitCode,
    timedOut,
    durationMs: Date.now() - startedAt,
    tests,
  };
}
