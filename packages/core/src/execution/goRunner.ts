// ============================================================
// Go 隐藏测试容器执行（Phase 2 垂直切片）。
// 题目 sourceCode 是裸 function snippet（缺 package/import），testCode 是
// testing 风格片段（t.Fatal）。本模块按 fixture 生成完整 *_test.go + go.mod，
// 在 golang 容器里 go test。
// 镜像用 golang:1.21：Go 1.22 起循环变量语义改变，会消除 loop-variable-capture
// 类题目的 bug（如 goroutine_capture），因此固定 1.21 保持题目设计时代的语义。
// ============================================================

import type { HiddenTestCase } from '@zxbench/types';
import { runInContainer } from './containerRunner.js';

export interface GoFixture {
  /** 额外 import 包名 */
  imports?: string[];
  /** 与 imports 对齐的 use-stub（如 'errors.New'），避免 bug 版本 unused import 编译失败 */
  importStubs?: string[];
  /** 依赖函数/变量定义（如 fetch 桩），拼在 sourceCode 之后 */
  helpers?: string;
  /** 启用 race detector（并发/race 题） */
  race?: boolean;
}

export interface GoRunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  tests: { name: string; passed: boolean }[];
}

const GO_IMAGE = 'golang:1.21';

/** 生成完整可编译的 Go 测试 harness（main_test.go + go.mod） */
export function buildGoTestHarness(
  sourceCode: string,
  testCases: HiddenTestCase[],
  fixture: GoFixture = {},
): { 'main_test.go': string; 'go.mod': string } {
  const imports = fixture.imports ?? [];
  const stubs = fixture.importStubs ?? [];
  const importLines = ['testing', ...imports].map((i) => '\t"' + i + '"');
  const stubLines = stubs.map((s) => 'var _ = ' + s);

  const testFns = testCases.map((tc, i) => {
    const body = tc.testCode.split('\n').map((ln) => (ln.trim() ? '\t\t' + ln.trim() : '')).join('\n');
    return 'func TestHidden_' + i + '(t *testing.T) {\n' + body + '\n}';
  }).join('\n\n');

  const parts = [
    'package main',
    '',
    'import (',
    ...importLines,
    ')',
  ];
  if (stubLines.length > 0) parts.push('', ...stubLines);
  parts.push('', sourceCode.trim());
  const helpers = (fixture.helpers || '').trim();
  if (helpers) parts.push('', helpers);
  parts.push('', testFns, '');

  return {
    'main_test.go': parts.join('\n'),
    'go.mod': 'module fixture\n\ngo 1.21\n',
  };
}

/** 在 golang 容器里跑 Go hidden tests，返回整体结果 + 逐测试解析 */
export function runGoTestsInContainer(
  sourceCode: string,
  testCases: HiddenTestCase[],
  fixture: GoFixture = {},
  timeoutMs = 30000,
): GoRunResult {
  const harness = buildGoTestHarness(sourceCode, testCases, fixture);
  const cmd = ['go', 'test', '-p', '1'];
  if (fixture.race) cmd.push('-race');
  cmd.push('-run', 'TestHidden', '-count=1', '-v', './...');

  const res = runInContainer({
    image: GO_IMAGE,
    command: cmd,
    files: [
      { path: 'main_test.go', content: harness['main_test.go'] },
      { path: 'go.mod', content: harness['go.mod'] },
    ],
    timeoutMs,
    memoryMb: 512,
    pidsLimit: 256,
    env: { GOCACHE: '/tmp/go-build', GOPATH: '/tmp/gopath', HOME: '/tmp', GOMAXPROCS: '1', CGO_ENABLED: '1' },
  });

  const tests: { name: string; passed: boolean }[] = [];
  for (const ln of (res.stdout + '\n' + res.stderr).split('\n')) {
    const m = ln.match(/--- (PASS|FAIL): (TestHidden_\d+)/);
    if (m) tests.push({ name: m[2], passed: m[1] === 'PASS' });
  }

  return {
    success: res.success,
    stdout: res.stdout,
    stderr: res.stderr,
    exitCode: res.exitCode,
    timedOut: res.timedOut,
    durationMs: res.durationMs,
    tests,
  };
}