// ============================================================
// Bash 隐藏测试容器执行（Phase 2）。
// 断言风格：[[ "$(fn ...)" == "expected" ]]，以脚本退出码判定 pass/fail。
// 每条测试独立 bash 进程执行（断言失败 exit 非零）。
// ============================================================

import type { HiddenTestCase } from '@zxbench/types';
import { runInContainer } from './containerRunner.js';
import { completionToken, completed } from './completion.js';

export interface BashFixture {
  /** 镜像，默认 bash:5 */
  image?: string;
  /** set 选项（如 set -e） */
  setOptions?: string[];
  helpers?: string;
}

export interface BashRunResult {
  compiled: boolean;
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  tests: { name: string; passed: boolean }[];
}

const BASH_IMAGE = 'bash:5';

export function buildBashHarness(
  sourceCode: string,
  testCases: HiddenTestCase[],
  fixture: BashFixture = {},
): { 'main.sh': string } {
  const setOpts = fixture.setOptions?.length ? fixture.setOptions.map((o) => 'set ' + o).join('\n') : '';
  const parts = ['#!/bin/bash'];
  if (setOpts) parts.push(setOpts);
  parts.push(sourceCode.trim());
  const helpers = (fixture.helpers || '').trim();
  if (helpers) parts.push(helpers);
  parts.push('', ...testCases.map((tc) => tc.testCode.trim()), '');
  return { 'main.sh': parts.join('\n\n') };
}

/** 逐测试独立 bash 进程执行（断言失败 exit 非零） */
export async function runBashTestsInContainer(
  sourceCode: string,
  testCases: HiddenTestCase[],
  fixture: BashFixture = {},
  timeoutMs = 30000,
): Promise<BashRunResult> {
  const image = fixture.image || BASH_IMAGE;
  const tests: { name: string; passed: boolean }[] = [];
  let allStdout = '';
  let allStderr = '';
  let exitCode = 0;
  let timedOut = false;
  let compiled = testCases.length > 0;
  const startedAt = Date.now();

  for (let i = 0; i < testCases.length; i++) {
    const token = completionToken();
    const harness = buildBashHarness(sourceCode, [{ ...testCases[i], testCode: `set -e -o pipefail\n${testCases[i].testCode}\nprintf '\\n${token}\\n'` }], fixture);
    const res = await runInContainer({
      image,
      command: ['bash', '-c', `bash -n main.sh && printf '\\n${token}_COMPILED\\n' && bash -e -o pipefail main.sh`],
      files: [{ path: 'main.sh', content: harness['main.sh'] }],
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
