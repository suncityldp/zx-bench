// ============================================================
// Bash 隐藏测试容器执行（Phase 2）。
// 断言风格：[[ "$(fn ...)" == "expected" ]]，以脚本退出码判定 pass/fail。
// 每条测试独立 bash 进程执行（断言失败 exit 非零）。
// ============================================================

import type { HiddenTestCase } from '@zxbench/types';
import { runInContainer } from './containerRunner.js';

export interface BashFixture {
  /** 镜像，默认 bash:5 */
  image?: string;
  /** set 选项（如 set -e） */
  setOptions?: string[];
  helpers?: string;
}

export interface BashRunResult {
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
  const startedAt = Date.now();

  for (let i = 0; i < testCases.length; i++) {
    const harness = buildBashHarness(sourceCode, [testCases[i]], fixture);
    const res = await runInContainer({
      image,
      command: ['bash', 'main.sh'],
      files: [{ path: 'main.sh', content: harness['main.sh'] }],
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
