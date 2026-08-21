// ============================================================
// Java 隐藏测试容器执行（Phase 2 垂直切片）。
// 生成完整 HiddenTest.java，在 eclipse-temurin 容器里 javac + JUnitCore 运行。
// JUnit jar 通过 mounts 从 host libs 目录挂载（ZXBENCH_JAVA_LIBS 可覆盖）。
// ============================================================

import type { HiddenTestCase } from '@zxbench/types';
import { runInContainer } from './containerRunner.js';
import { fileURLToPath } from 'node:url';

export interface JavaFixture {
  imports?: string[];
  wrapInClass?: boolean;
  helpers?: string;
}

export interface JavaRunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  tests: { name: string; passed: boolean }[];
}

const JAVA_IMAGE = 'eclipse-temurin:17-jdk-alpine';
const JUNIT_JAR = 'junit-4.13.2.jar';
const HAMCREST_JAR = 'hamcrest-core-1.3.jar';
function javaLibsDir(): string {
  if (process.env.ZXBENCH_JAVA_LIBS) return process.env.ZXBENCH_JAVA_LIBS;
  // 默认从项目内 data/java-libs 读取（随仓库分发，clone 即跑）
  return fileURLToPath(new URL('../../../../data/java-libs', import.meta.url));
}

export function buildJavaHarness(
  sourceCode: string,
  testCases: HiddenTestCase[],
  fixture: JavaFixture = {},
): { 'HiddenTest.java': string } {
  const imports = fixture.imports ?? [];
  const wrap = fixture.wrapInClass ?? false;
  const testMethods = testCases
    .map((tc, i) => '    @Test public void t' + i + '() { ' + tc.testCode.trim() + ' }')
    .join('\n');
  const parts: string[] = [
    'import org.junit.Test;',
    'import static org.junit.Assert.*;',
    ...imports,
    '',
  ];
  if (!wrap) {
    parts.push(sourceCode.trim(), '', 'public class HiddenTest {', testMethods, '}');
  } else {
    parts.push('public class HiddenTest {', sourceCode.trim(), '', testMethods, '}');
  }
  const helpers = (fixture.helpers || '').trim();
  if (helpers) parts.push('', helpers);
  return { 'HiddenTest.java': parts.join('\n') + '\n' };
}

export function runJavaTestsInContainer(
  sourceCode: string,
  testCases: HiddenTestCase[],
  fixture: JavaFixture = {},
  timeoutMs = 30000,
): JavaRunResult {
  const harness = buildJavaHarness(sourceCode, testCases, fixture);
  const libs = javaLibsDir();
  const cp = '/libs/' + JUNIT_JAR + ':/libs/' + HAMCREST_JAR;
  const shell = 'mkdir -p /tmp/classes && javac -d /tmp/classes -cp ' + cp + ' HiddenTest.java && java -cp /tmp/classes:' + cp + ' org.junit.runner.JUnitCore HiddenTest';
  const res = runInContainer({
    image: JAVA_IMAGE,
    command: ['sh', '-c', shell],
    files: [{ path: 'HiddenTest.java', content: harness['HiddenTest.java'] }],
    mounts: [{ src: libs, dst: '/libs', readonly: true }],
    timeoutMs,
    memoryMb: 384,
    pidsLimit: 64,
  });

  const tests: { name: string; passed: boolean }[] = testCases.map((_, i) => ({ name: 't' + i, passed: true }));
  const out = res.stdout + '\n' + res.stderr;
  const okMatch = /OK \((\d+) tests?\)/.test(out);
  const failNames = new Set<string>();
  for (const ln of out.split('\n')) {
    const m = ln.match(/^\d+\)\s+(t\d+)\(/);
    if (m) failNames.add(m[1]);
  }
  if (!okMatch) {
    for (const t of tests) if (failNames.has(t.name)) t.passed = false;
    if (!/Tests run:/.test(out)) {
      for (const t of tests) t.passed = false;
    }
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
