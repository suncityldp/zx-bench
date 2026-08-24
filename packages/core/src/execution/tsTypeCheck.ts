// ============================================================
// TypeScript 类型级校验（tsc --strict 正/负向类型断言）
// 针对 CP-L3-TS-003/004/006/007 这类"修类型定义"的题：
// 现有 sandbox 只 transpileModule 剥类型不校验 → 任何答案都能过。
// 这里用 typescript 编译器 API 做真实 strict 类型检查：
//   positive —— solution + 用例代码，0 错误才算过；
//   negative —— solution + 反例代码，必须出现 ≥1 类型错误才算过（证明类型约束真的生效）。
// ============================================================

import ts from 'typescript';
import type { TestDetail } from '@zxbench/types';

export interface TypeCheckCase {
  id: string;
  description: string;
  /** positive: 拼接后必须 0 错误；negative: 拼接后必须 ≥1 错误 */
  kind: 'positive' | 'negative';
  /** 与 solution 拼接的用例代码（负向用例即"故意错用"的反例） */
  code?: string;
}

export interface TypeCheckResult {
  /** solution 单独在 strict 下是否 0 错误（对应 compilation 轴） */
  compiled: boolean;
  compileErrors: string[];
  details: TestDetail[];
}

const TYPE_PREAMBLE = 'type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;\n';

const FILE = '/solution.ts';
const OPTIONS: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
  lib: ['lib.es2020.d.ts'],
  types: [],
};

function getErrors(code: string): string[] {
  const sourceFile = ts.createSourceFile(FILE, TYPE_PREAMBLE + code, ts.ScriptTarget.ES2020, true);
  const host = ts.createCompilerHost(OPTIONS);
  const origGet = host.getSourceFile.bind(host);
  const origExists = host.fileExists.bind(host);
  const origRead = host.readFile.bind(host);
  host.getSourceFile = (f, lang, onErr, nf) => (f === FILE ? sourceFile : origGet(f, lang, onErr, nf));
  host.fileExists = (f) => (f === FILE ? true : origExists(f));
  host.readFile = (f) => (f === FILE ? TYPE_PREAMBLE + code : origRead(f));
  const program = ts.createProgram([FILE], OPTIONS, host);
  return ts.getPreEmitDiagnostics(program)
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

export function runTypeScriptTypeCheck(solution: string, cases: TypeCheckCase[]): TypeCheckResult {
  const compileErrors = getErrors(solution);
  const compiled = compileErrors.length === 0;

  const details: TestDetail[] = [];
  for (const c of cases) {
    const startedAt = new Date().toISOString();
    const full = solution + '\n\n// ---- type-check case: ' + (c.description || c.id) + ' ----\n' + (c.code || '');
    const errs = getErrors(full);
    const passed = c.kind === 'positive' ? errs.length === 0 : errs.length > 0;
    details.push({
      testId: c.id,
      testType: c.kind === 'positive' ? 'type_positive' : 'type_negative',
      name: c.description,
      passed,
      actual: errs.length === 0 ? '(no type errors)' : errs.join(' | '),
      expected: c.kind === 'positive' ? 'no type errors' : 'type error expected',
      duration: 0,
      timedOut: false,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
  }
  return { compiled, compileErrors, details };
}
