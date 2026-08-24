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

const RUST_IMAGE = 'rust:1.75-alpine';

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
export async function runRustTestsInContainer(
  sourceCode: string,
  testCases: HiddenTestCase[],
  fixture: RustFixture = {},
  timeoutMs = 30000,
): Promise<RustRunResult> {
  const tests: { name: string; passed: boolean }[] = [];
  let allStdout = '';
  let allStderr = '';
  let exitCode = 0;
  let timedOut = false;
  const startedAt = Date.now();

  for (let i = 0; i < testCases.length; i++) {
    const harness = buildRustHarness(sourceCode, [testCases[i]], fixture);
    const res = await runInContainer({
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

export interface RustMiriResult {
  compiled: boolean;
  miriClean: boolean;
  testsPassed: number;
  testsTotal: number;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

const RUST_MIRI_IMAGE = 'zxbench/rust:nightly-miri';

// RS-003 专属测试套件：split_two 边界 + 越界 panic + Miri 干净
const RS003_MIRI_TESTS = [
  '#[cfg(test)]',
  'mod miri_tests {',
  '    use super::*;',
  '',
  '    #[test]',
  '    fn test_normal_split() {',
  '        let mut buf = [1u8, 2, 3, 4];',
  '        let (a, b) = split_two(&mut buf, 2);',
  '        assert_eq!(a, &[1, 2]);',
  '        assert_eq!(b, &[3, 4]);',
  '    }',
  '',
  '    #[test]',
  '    fn test_mid_zero() {',
  '        let mut buf = [1u8, 2, 3];',
  '        let (a, b) = split_two(&mut buf, 0);',
  '        assert!(a.is_empty());',
  '        assert_eq!(b, &[1, 2, 3]);',
  '    }',
  '',
  '    #[test]',
  '    fn test_mid_len() {',
  '        let mut buf = [1u8, 2, 3];',
  '        let (a, b) = split_two(&mut buf, 3);',
  '        assert_eq!(a, &[1, 2, 3]);',
  '        assert!(b.is_empty());',
  '    }',
  '',
  '    #[test]',
  '    #[should_panic(expected = "mid out of range")]',
  '    fn test_oob_panics() {',
  '        let mut buf = [1u8, 2, 3];',
  '        let _ = split_two(&mut buf, 5);',
  '    }',
  '}',
].join('\n');

/** Rust Miri 并发/健全性压测（CP-L3-RS-003）：cargo +nightly miri test。
 *  正确实现：Miri 无 UB 且 4 测试全过；错误实现：Miri 报 Undefined Behavior（retag/越界）。 */
export async function runRustMiriInContainer(sourceCode: string, timeoutMs = 180000): Promise<RustMiriResult> {
  const cargoToml = '[package]\nname = "miri_check"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\npath = "src/lib.rs"\n';
  const libRs = sourceCode.trim() + '\n\n' + RS003_MIRI_TESTS;
  const startedAt = Date.now();
  const res = await runInContainer({
    image: RUST_MIRI_IMAGE,
    command: ['sh', '-c', 'cargo +nightly miri test'],
    files: [
      { path: 'Cargo.toml', content: cargoToml },
      { path: 'src/lib.rs', content: libRs },
    ],
    timeoutMs,
    memoryMb: 1024,
    cpuLimit: 2.0,
    pidsLimit: 128,
    networkDisabled: true,
    readOnly: false,
    env: { CARGO_TARGET_DIR: '/tmp/target', CARGO_HOME: '/tmp/cargo-home', MIRI_SYSROOT: '/opt/miri-sysroot' },
  });
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  const combined = stdout + '\n' + stderr;
  const m = /test result: ok\. (\d+) passed/.exec(stdout);
  return {
    compiled: !/error\[E\d+\]|error: could not compile|cannot find function|cannot find value/.test(combined),
    miriClean: !/Undefined Behavior|UB: |error: Undefined/.test(combined),
    testsPassed: m ? parseInt(m[1], 10) : 0,
    testsTotal: 4,
    stdout,
    stderr,
    exitCode: res.exitCode,
    timedOut: res.timedOut,
    durationMs: Date.now() - startedAt,
  };
}
