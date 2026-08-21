// ============================================================
// Rust 隐藏测试容器执行（Phase 2 垂直切片）。
// 生成 main.rs + assert_eq 测试，rustc 编译运行。
// borrow_checker 类题的 bug 是编译期错误（E0502 等），编译失败即 0 分。
// ============================================================

import type { HiddenTestCase } from '@zxbench/types';
import { runInContainer } from './containerRunner.js';

export interface RustFixture {
  /** 额外 extern crate / use（如 'use std::collections::HashSet;'） */
  uses?: string[];
  helpers?: string;
}

export interface RustRunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  tests: { name: string; passed: boolean }[];
}

const RUST_IMAGE = 'rust:1.75';

export function buildRustHarness(
  sourceCode: string,
  testCases: HiddenTestCase[],
  fixture: RustFixture = {},
): { 'main.rs': string } {
  const uses = fixture.uses ?? [];
  const tests = testCases.map((tc) => '    { ' + tc.testCode.trim() + ' }').join('\n');
  const parts = [...uses, sourceCode.trim()];
  const helpers = (fixture.helpers || '').trim();
  if (helpers) parts.push(helpers);
  parts.push('', 'fn main() {', tests, '    println!("OK");', '}', '');
  return { 'main.rs': parts.join('\n') };
}

/** 逐测试独立编译运行（assert panic 会 abort，需隔离） */
export function runRustTestsInContainer(
  sourceCode: string,
  testCases: HiddenTestCase[],
  fixture: RustFixture = {},
  timeoutMs = 30000,
): RustRunResult {
  const tests: { name: string; passed: boolean }[] = [];
  let allStdout = '';
  let allStderr = '';
  let exitCode = 0;
  let timedOut = false;
  const startedAt = Date.now();

  for (let i = 0; i < testCases.length; i++) {
    const harness = buildRustHarness(sourceCode, [testCases[i]], fixture);
    const res = runInContainer({
      image: RUST_IMAGE,
      command: ['sh', '-c', 'rustc main.rs -o /tmp/a.out && /tmp/a.out'],
      files: [{ path: 'main.rs', content: harness['main.rs'] }],
      timeoutMs,
      memoryMb: 512,
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
