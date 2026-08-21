// ============================================================
// TS → JS 转译（隐藏测试沙箱）
// TS 题源码带类型注解（interface/泛型/参数与返回类型），
// 直接 new AsyncFunction 会 SyntaxError → 全部 0 分。
// 这里仅当代码含 TS 语法时用 TypeScript 编译器剥离类型（不校验），
// 纯 JS 代码原样透传，不影响既有 JS/Python/Go 题。
// ============================================================

/** 检测代码是否含 TS 类型语法（类型注解 / 接口 / 泛型） */
function looksLikeTypeScript(code: string): boolean {
  return (
    /\b(interface|type|enum|namespace)\s+[A-Za-z_$]/.test(code) ||
    /\)\s*:\s*[A-Za-z_$][\w$<>\[\].|,{}:\s]*\s*\{/.test(code) ||               // 返回类型 ) : Type {
    /\)\s*:\s*[A-Za-z_$][\w$<>\[\].|]*\s*=>/.test(code) ||                       // 箭头函数返回 ) : Type =>
    /\(\s*[A-Za-z_$]\w*\s*:\s*[A-Za-z_$][\w$<>\[\].|]*\s*[,)]/.test(code) ||  // 参数注解 name: Type
    /\b(?:const|let|var)\s+[A-Za-z_$]\w*\s*:\s*[A-Za-z_$]/.test(code) ||          // 变量注解 name: Type
    /[A-Za-z_$]\w*\s*<[A-Za-z_$][^>{]*>\s*\(/.test(code)                           // 泛型函数 f<T>( 或 f<T, U>(
  );
}

/** 剥离 TS 类型语法 → 纯 JS（供 AsyncFunction 沙箱执行） */
function transpileTsForSandbox(code: string): string {
  // export 在 AsyncFunction 作用域非法：先剥掉（同名声明仍留在作用域，测试可直接调用）
  const cleaned = code
    .replace(/^\s*export\s+default\s+/gm, '')
    .replace(/^\s*export\s+/gm, '');
  const out = ts.transpileModule(cleaned, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.None,
      isolatedModules: true,
    },
    reportDiagnostics: false,
  });
  return out.outputText;
}

/** 供沙箱运行的最终代码：TS 检测后转译，纯 JS 透传 */
function toRunnableJs(code: string): string {
  return looksLikeTypeScript(code) ? transpileTsForSandbox(code) : code;
}

// ============================================================
// 沙箱执行环境 — 子进程隔离执行（GPT5.6 P0-1）
// 替代 VM2：使用独立子进程执行不可信代码
// 每个代码任务在独立进程中运行，具备超时/内存/文件系统隔离
// ============================================================

import { fork, spawnSync, type ChildProcess } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HiddenTestCase, TestDetail } from '@zxbench/types';
import ts from 'typescript';

export interface SandboxResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;     // ms
  timedOut: boolean;
  oomKilled: boolean;
}

export interface SandboxOptions {
  timeout?: number;      // ms, default 10000
  memoryLimit?: number;  // bytes, default 128MB
  maxProcesses?: number; // 最大子进程数, default 1
}

/** Worker 脚本路径（动态生成） */
let workerScriptPath: string | null = null;

/** 获取或创建 worker 脚本 */
function getWorkerScript(): string {
  if (workerScriptPath) return workerScriptPath;

  const workerCode = `
// Sandbox Worker — 在独立进程中执行不可信代码
process.on('message', (msg) => {
  const { code, timeout } = msg;

  // 重定向 console 输出到父进程
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  const origInfo = console.info;

  console.log = (...args) => {
    process.send?.({ type: 'stdout', data: args.map(String).join(' ') });
  };
  console.info = (...args) => {
    process.send?.({ type: 'stdout', data: args.map(String).join(' ') });
  };
  console.error = (...args) => {
    process.send?.({ type: 'stderr', data: args.map(String).join(' ') });
  };
  console.warn = (...args) => {
    process.send?.({ type: 'stderr', data: args.map(String).join(' ') });
  };

  // 超时自杀
  const timer = setTimeout(() => {
    process.send?.({ type: 'timeout' });
    process.exit(124);
  }, timeout);

  try {
    // 使用 AsyncFunction 构造器（而非 eval）：支持测试代码顶层 await（异步函数验证），
    // 同步代码行为不变；fn() 返回 Promise，等待其完成后再退出，避免异步断言被提前截断
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction(code);
    Promise.resolve()
      .then(() => fn())
      .then(() => {
        clearTimeout(timer);
        process.send?.({ type: 'done', exitCode: 0 });
        process.exit(0);
      })
      .catch((e) => {
        clearTimeout(timer);
        process.send?.({
          type: 'error',
          message: e instanceof Error ? e.message : String(e),
        });
        process.exit(1);
      });
  } catch (e) {
    clearTimeout(timer);
    process.send?.({
      type: 'error',
      message: e instanceof Error ? e.message : String(e),
    });
    process.exit(1);
  }
});
`;

  const dir = mkdtempSync(join(tmpdir(), 'zxbench-worker-'));
  workerScriptPath = join(dir, 'worker.js');
  writeFileSync(workerScriptPath, workerCode, 'utf8');

  // 进程退出时清理
  process.on('exit', () => {
    try { unlinkSync(workerScriptPath!); } catch { /* ignore */ }
  });

  return workerScriptPath;
}

/**
 * 在隔离子进程中执行 JavaScript 代码
 * 每个调用创建独立子进程，执行完毕后进程销毁
 */
export function runInSandbox(code: string, options: SandboxOptions = {}): Promise<SandboxResult> {
  const { timeout = 10000, memoryLimit = 128 * 1024 * 1024 } = options;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const workerPath = getWorkerScript();
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    let resolved = false;
    let timedOut = false;
    let oomKilled = false;

    const child: ChildProcess = fork(workerPath, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      execArgv: [`--max-old-space-size=${Math.floor(memoryLimit / 1024 / 1024)}`],
    });

    // 超时保护
    const killTimer = setTimeout(() => {
      timedOut = true;
      if (!resolved) {
        resolved = true;
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        // 关键：超时后必须直接 resolve，不能依赖 exit handler（否则 exit 事件里
        // 因 resolved 已为 true 提前 return，Promise 永不 resolve → 评测卡死）
        resolve({
          success: false,
          stdout: stdoutLines.join('\n'),
          stderr: stderrLines.join('\n'),
          exitCode: 124,
          duration: Date.now() - startedAt,
          timedOut: true,
          oomKilled: false,
        });
      }
    }, timeout + 1000); // 比 worker 内部超时多 1s 缓冲

    // IPC 消息处理
    child.on('message', (msg: Record<string, unknown>) => {
      if (msg.type === 'stdout') stdoutLines.push(String(msg.data));
      if (msg.type === 'stderr') stderrLines.push(String(msg.data));
      if (msg.type === 'timeout') timedOut = true;
      if (msg.type === 'error') stderrLines.push(String(msg.message));
    });

    // 子进程退出
    child.on('exit', (code, signal) => {
      clearTimeout(killTimer);
      if (resolved) return;
      resolved = true;

      if (signal === 'SIGKILL') oomKilled = true;

      const duration = Date.now() - startedAt;
      const exitCode = code ?? (timedOut ? 124 : 1);

      resolve({
        success: exitCode === 0 && !timedOut,
        stdout: stdoutLines.join('\n'),
        stderr: stderrLines.join('\n'),
        exitCode,
        duration,
        timedOut,
        oomKilled,
      });
    });

    // 子进程错误
    child.on('error', (err) => {
      clearTimeout(killTimer);
      if (resolved) return;
      resolved = true;

      resolve({
        success: false,
        stdout: stdoutLines.join('\n'),
        stderr: err.message,
        exitCode: 1,
        duration: Date.now() - startedAt,
        timedOut: false,
        oomKilled: false,
      });
    });

    // 发送代码到 worker
    child.send({ code, timeout });
  });
}

/**
 * 执行单个测试用例
 * 将 sourceCode + patch + testCode 组合后在子进程沙箱中运行
 */
export async function runTestCase(
  sourceCode: string,
  patch: string | null,
  testCase: HiddenTestCase,
  options: SandboxOptions = {},
): Promise<TestDetail> {
  const startedAt = new Date().toISOString();

  // 应用 patch
  let modifiedCode = sourceCode;
  if (patch) {
    modifiedCode = applyPatch(sourceCode, patch);
  }

  // 组合完整代码：源码 + 测试代码
  const fullCode = `
    ${modifiedCode}

    // ===== 测试代码 =====
    ${testCase.testCode}
  `;

  const result = await runInSandbox(toRunnableJs(fullCode), {
    timeout: testCase.timeout || options.timeout || 10000,
    ...options,
  });

  // 判断测试结果
  let passed = false;
  if (testCase.expectedOutput !== undefined) {
    passed = result.stdout.trim() === String(testCase.expectedOutput).trim();
  } else if (testCase.expectedExitCode !== undefined) {
    passed = result.exitCode === testCase.expectedExitCode;
  } else {
    passed = result.success;
  }

  return {
    testId: testCase.id,
    testType: testCase.type,
    passed,
    actualOutput: result.stdout.trim() || undefined,
    expectedOutput: testCase.expectedOutput !== undefined ? String(testCase.expectedOutput) : undefined,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    duration: result.duration,
    timedOut: result.timedOut,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

/**
 * 完整代码模式：直接用替换后的完整代码 + 测试代码运行
 * 适用于模型输出完整修复代码（非 diff）的场景
 */
export async function runReplacedCodeTest(
  replacedCode: string,
  testCase: HiddenTestCase,
  options: SandboxOptions = {},
): Promise<TestDetail> {
  const startedAt = new Date().toISOString();
  const fullCode = `
    ${replacedCode}

    // ===== 测试代码 =====
    ${testCase.testCode}
  `;
  const result = await runInSandbox(toRunnableJs(fullCode), {
    timeout: testCase.timeout || options.timeout || 10000,
    ...options,
  });

  let passed = false;
  if (testCase.expectedOutput !== undefined) {
    passed = result.stdout.trim() === String(testCase.expectedOutput).trim();
  } else if (testCase.expectedExitCode !== undefined) {
    passed = result.exitCode === testCase.expectedExitCode;
  } else {
    passed = result.success;
  }

  return {
    testId: testCase.id,
    testType: testCase.type,
    passed,
    actualOutput: result.stdout.trim() || undefined,
    expectedOutput: testCase.expectedOutput !== undefined ? String(testCase.expectedOutput) : undefined,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    duration: result.duration,
    timedOut: result.timedOut,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

/**
 * 批量运行测试用例
 */
export async function runTestSuite(
  sourceCode: string,
  patch: string | null,
  testCases: HiddenTestCase[],
  options: SandboxOptions = {},
): Promise<TestDetail[]> {
  const results: TestDetail[] = [];
  for (const tc of testCases) {
    results.push(await runTestCase(sourceCode, patch, tc, options));
  }
  return results;
}

// ============================================================
// Python 沙箱（子进程隔离，与 JS worker 同级防护：超时/临时目录/断网环境变量）
// ============================================================

let pythonBinCache: string | null | undefined;

/** 探测可用的 Python 解释器（python → python3）；无则返回 null（缓存结果） */
export function getPythonBin(): string | null {
  if (pythonBinCache !== undefined) return pythonBinCache;
  for (const bin of ['python', 'python3']) {
    try {
      const res = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 8000 });
      if (!res.error && res.status === 0) {
        pythonBinCache = bin;
        return bin;
      }
    } catch { /* ignore */ }
  }
  pythonBinCache = null;
  return null;
}

/**
 * Python 完整代码模式：修复代码 + assert 测试 → 临时文件 → 子进程执行
 * 判定：退出码 0 = 通过（assert 失败/异常退出码非 0 = 失败）
 * 与 JS 版的差异：Python 题库测试均为 assert 风格（expectedOutput 仅为描述性），
 * 因此不按 stdout 匹配，统一用退出码判定
 */
export async function runReplacedCodeTestPython(
  replacedCode: string,
  testCase: HiddenTestCase,
  options: SandboxOptions = {},
): Promise<TestDetail> {
  const startedAt = new Date().toISOString();
  const bin = getPythonBin();
  if (!bin) {
    return {
      testId: testCase.id,
      testType: testCase.type,
      passed: false,
      stdout: '',
      stderr: 'Python interpreter unavailable — test skipped',
      exitCode: -1,
      duration: 0,
      timedOut: false,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const fullCode = `${replacedCode}\n\n# ===== 测试代码 =====\n${testCase.testCode}\n`;
  const dir = mkdtempSync(join(tmpdir(), 'bl-pytest-'));
  const file = join(dir, 'test_run.py');
  const timeout = testCase.timeout || options.timeout || 10000;

  try {
    writeFileSync(file, fullCode, 'utf8');
    const res = spawnSync(bin, [file], {
      encoding: 'utf8',
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      cwd: dir,
      env: { PATH: process.env.PATH || '', SYSTEMROOT: process.env.SYSTEMROOT || '', HOME: process.env.HOME || '' },
    });
    const timedOut = res.error != null && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
      || res.signal === 'SIGTERM';
    const exitCode = res.status ?? (timedOut ? 124 : 1);
    const stdout = (res.stdout || '').trim();
    const stderr = (res.stderr || '').trim();

    return {
      testId: testCase.id,
      testType: testCase.type,
      passed: exitCode === 0 && !timedOut,
      actualOutput: stdout || undefined,
      expectedOutput: testCase.expectedOutput !== undefined ? String(testCase.expectedOutput) : undefined,
      stdout,
      stderr,
      exitCode,
      duration: 0,
      timedOut,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  } catch (e) {
    return {
      testId: testCase.id,
      testType: testCase.type,
      passed: false,
      stdout: '',
      stderr: e instanceof Error ? e.message : String(e),
      exitCode: 1,
      duration: 0,
      timedOut: false,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * 简单 patch 应用（统一格式 diff → 替换）
 */
function applyPatch(sourceCode: string, patch: string): string {
  const lines = patch.split('\n');
  const sourceLines = sourceCode.split('\n');
  const resultLines = [...sourceLines];

  let currentLine = 0;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentLine = parseInt(hunkMatch[2], 10) - 1;
      continue;
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      resultLines.splice(currentLine, 1);
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      resultLines.splice(currentLine, 0, line.slice(1));
      currentLine++;
    } else if (!line.startsWith('\\')) {
      currentLine++;
    }
  }

  return resultLines.join('\n');
}