// ============================================================
// C# 隐藏测试容器执行（Phase 2 垂直切片）。
// 测试断言是 xUnit 风格（Assert.Equal/True），这里用 dotnet Console + 自定义
// Assert 静态类（把 xUnit 语义映射到 throw），dotnet SDK 容器编译运行。
// ============================================================

import type { HiddenTestCase } from '@zxbench/types';
import { runInContainer } from './containerRunner.js';

export interface CsharpFixture {
  wrapInClass?: boolean;
  usings?: string[];
  helpers?: string;
}

export interface CsharpRunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  tests: { name: string; passed: boolean }[];
}

// MCR(dotnet SDK) 在当前环境不可达，用 Docker Hub 的 mono:6.12 编译运行 C#。
// 这些题的 C# 特性（泛型/lambda/decimal/MidpointRounding）mono 均支持。
const CS_IMAGE = 'mcr.microsoft.com/dotnet/sdk:8.0-alpine';

const ASSERT_CLASS = [
  'static class Assert {',
  '    public static void Equal<T>(T expected, T actual) {',
  '        if (!EqualityComparer<T>.Default.Equals(expected, actual)) throw new Exception("Assert.Equal failed");',
  '    }',
  '    public static void True(bool cond, string msg = null) { if (!cond) throw new Exception(msg ?? "Assert.True failed"); }',
  '    public static void False(bool cond, string msg = null) { if (cond) throw new Exception(msg ?? "Assert.False failed"); }',
  '    public static void Null(object o) { if (o != null) throw new Exception("Assert.Null failed"); }',
  '    public static void NotNull(object o) { if (o == null) throw new Exception("Assert.NotNull failed"); }',
  '}',
].join('\n');

const CSPROJ = [
  '<Project Sdk="Microsoft.NET.Sdk">',
  '  <PropertyGroup>',
  '    <OutputType>Exe</OutputType>',
  '    <TargetFramework>net8.0</TargetFramework>',
  '    <Nullable>disable</Nullable>',
  '    <ImplicitUsings>disable</ImplicitUsings>',
  '  </PropertyGroup>',
  '</Project>',
].join('\n');

export function buildCsharpHarness(
  sourceCode: string,
  testCases: HiddenTestCase[],
  fixture: CsharpFixture = {},
): { 'Program.cs': string; 'app.csproj': string } {
  const usings = ['using System;', 'using System.Collections.Generic;', 'using System.Linq;', ...(fixture.usings ?? []).map((u) => { const t = u.trim(); if (t.startsWith('using ')) return t.endsWith(';') ? t : t + ';'; return 'using ' + t + ';'; })];
  const wrap = fixture.wrapInClass ?? false;
  const helpers = (fixture.helpers || '').trim();
  const helperClassNames = [...helpers.matchAll(/\bclass\s+(\w+)/g)].map((m) => m[1]);
  const helpersPublic = helpers.split('\n').map((line) => {
    if (/^class\s/.test(line)) return 'public ' + line;
    if (/^static\s/.test(line)) return 'public ' + line;
    return line;
  }).join('\n');
  const helpersWrapped = helpers ? 'public static class Helpers {' + '\n' + helpersPublic + '\n' + '}' : '';
  const tests = testCases.map((tc) => {
    let code = tc.testCode;
    for (const cn of helperClassNames) code = code.replace(new RegExp('\\b' + cn + '\\b', 'g'), 'Helpers.' + cn);
    return '        ' + code.trim();
  }).join('\n');

  // 提取 sourceCode 里的 using 语句到最前（否则拼在 Assert 类后触发 CS1529）
  const usingRe = /^\s*using\s+[\w.]+\s*;/;
  const srcLines = sourceCode.split('\n');
  const srcUsings = srcLines.filter((l) => usingRe.test(l.trim()));
  const srcRest = srcLines.filter((l) => !usingRe.test(l.trim())).join('\n').trim();
  const allUsings = helpersWrapped ? [...usings, 'using static Helpers;', ...srcUsings] : [...usings, ...srcUsings];

  const parts = [...allUsings, '', ASSERT_CLASS];
  if (!wrap) {
    parts.push('', srcRest, '', 'class Program {', '    static void Main() {', tests, '        Console.WriteLine("OK");', '    }', '}');
  } else {
    parts.push('', 'class Program {', srcRest, '', '    static void Main() {', tests, '        Console.WriteLine("OK");', '    }', '}');
  }
  if (helpersWrapped) parts.push('', helpersWrapped);
  return { 'Program.cs': parts.join('\n') + '\n', 'app.csproj': CSPROJ + '\n' };
}

/** 逐测试独立编译运行（throw 会终止，需隔离） */
export function runCsharpTestsInContainer(
  sourceCode: string,
  testCases: HiddenTestCase[],
  fixture: CsharpFixture = {},
  timeoutMs = 30000,
): CsharpRunResult {
  const tests: { name: string; passed: boolean }[] = [];
  let allStdout = '';
  let allStderr = '';
  let exitCode = 0;
  let timedOut = false;
  const startedAt = Date.now();

  for (let i = 0; i < testCases.length; i++) {
    const harness = buildCsharpHarness(sourceCode, [testCases[i]], fixture);
    const res = runInContainer({
      image: CS_IMAGE,
      command: ['sh', '-c', 'dotnet run --project app.csproj'],
      files: [
        { path: 'Program.cs', content: harness['Program.cs'] },
        { path: 'app.csproj', content: harness['app.csproj'] },
      ],
      timeoutMs,
      memoryMb: 512,
      pidsLimit: 128,
      readOnly: false,
      env: {
        DOTNET_CLI_HOME: '/tmp/dotnet',
        DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
        DOTNET_NOLOGO: '1',
        HOME: '/tmp',
      },
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
