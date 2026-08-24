// ============================================================
// Code Repair 评分器 v3.2
// 多语言感知：
//   - javascript/typescript → 子进程沙箱执行隐藏测试（确定性评分）
//   - python → 子进程沙箱执行 assert 测试（解释器可用时；否则回退静态模式）
//   - 其他语言 → 静态模式（代码块提取 + verdict 判断 + 关键模式检查），
//     test_pass 交 AI Judge 复核（judge_required 标记）
// 支持修复题（fix）与正确代码陷阱题（no_bug verdict）
// GPT5.6 P1-3: patch_quality 改为 diff-based 而非长度比
// GPT5.6 P1-4: scope_discipline 改为 diff 分析而非关键词
// ============================================================

import type { Scenario, ScenarioResult, OutputMetadata, ModelResponse, AxisEvidence, RuntimeEvaluation } from '@zxbench/types';
import type { Evaluator } from './index.js';
import { runReplacedCodeTest, runReplacedCodeTestPython, summarizeTestResults, calculateTestScore, getPythonBin } from '../hidden-tests/index.js';
import { runTypeScriptTypeCheck, type TypeCheckCase } from '../execution/tsTypeCheck.js';
import { runGoTestsInContainer, runGoProgramInContainer, type GoFixture } from '../execution/goRunner.js';
import { runJavaTestsInContainer, type JavaFixture } from '../execution/javaRunner.js';
import { runCTestsInContainer, runCppTestsInContainer, runCppTsanInContainer, type CFixture } from '../execution/cRunner.js';
import { runRustTestsInContainer, runRustMiriInContainer, type RustFixture } from '../execution/rustRunner.js';
import { runPhpTestsInContainer, type PhpFixture } from '../execution/phpRunner.js';
import { runCsharpTestsInContainer, type CsharpFixture } from '../execution/csharpRunner.js';
import { runSqlInContainer, type SqlFixture } from '../execution/sqlRunner.js';
import { runBashTestsInContainer, type BashFixture } from '../execution/bashRunner.js';
import { execAsync } from '../execution/execAsync.js';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** 可沙箱执行的语言（python 需解释器可用，运行时判定） */
const EXECUTABLE_LANGS = ['javascript', 'typescript', 'python', 'py'];
const PYTHON_LANGS = ['python', 'py'];

/** 可执行编译/语法检查的语言（轻量验证，不跑测试） */
const COMPILE_CHECK_LANGS = new Set(['python', 'py', 'java', 'go', 'golang', 'rust', 'rs', 'c', 'cpp', 'c++']);

/**
 * 轻量编译/语法检查（verified）：非沙箱语言的真实执行下限
 * 编译器缺失/失败 → 返回 unmeasured（不制造 0 分惩罚）
 */
async function compileCheck(code: string, language: string): Promise<{ score: number | null; evidence: string }> {
  const lang = language.toLowerCase();
  const map: Record<string, { bin: string; args: (file: string) => string[]; ext: string }> = {
    python: { bin: 'python', args: (f) => ['-m', 'py_compile', f], ext: 'py' },
    py: { bin: 'python', args: (f) => ['-m', 'py_compile', f], ext: 'py' },
    java: { bin: 'javac', args: (f) => ['-d', tmpdir(), f], ext: 'java' },
    go: { bin: 'go', args: (f) => ['build', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null', f], ext: 'go' },
    golang: { bin: 'go', args: (f) => ['build', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null', f], ext: 'go' },
    rust: { bin: 'rustc', args: (f) => ['--crate-type', 'lib', '--emit=metadata', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null', f], ext: 'rs' },
    rs: { bin: 'rustc', args: (f) => ['--crate-type', 'lib', '--emit=metadata', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null', f], ext: 'rs' },
    c: { bin: 'cc', args: (f) => ['-fsyntax-only', f], ext: 'c' },
    cpp: { bin: 'c++', args: (f) => ['-fsyntax-only', f], ext: 'cpp' },
    'c++': { bin: 'c++', args: (f) => ['-fsyntax-only', f], ext: 'cpp' },
  };

  const spec = map[lang];
  if (!spec || !COMPILE_CHECK_LANGS.has(lang)) {
    return { score: null, evidence: `Compile check not supported for ${lang}` };
  }

  const dir = mkdtempSync(join(tmpdir(), 'bl-compile-'));
  const file = join(dir, `check.${spec.ext}`);
  try {
    writeFileSync(file, code, 'utf8');
    const res = await execAsync(spec.bin, spec.args(file), { timeout: 15000 });
    if (res.error) {
      // 编译器不存在（如 ENOENT）→ 无法验证
      return { score: null, evidence: `Compiler "${spec.bin}" unavailable — compile check skipped` };
    }
    if (res.status === 0) {
      return { score: 100, evidence: `Compile check passed (${spec.bin})` };
    }
    return { score: 30, evidence: `Compile check failed: ${(res.stderr || res.stdout || '').trim().split('\n')[0] || 'unknown error'}` };
  } catch {
    return { score: null, evidence: 'Compile check crashed — skipped' };
  } finally {
    try { unlinkSync(file); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** 拒绝修复（认为代码正确）的信号词（兜底，弱信号） */
const NO_BUG_SIGNALS = [
  '没有 bug', '没有bug', '无 bug', '无bug', '不存在 bug', '代码正确', '代码是正确的',
  '无需修复', '不需要修复', '不用修复', '没有错误', '没有问题', '正确的代码',
  'no bug', 'no bugs', 'is correct', 'looks correct', 'nothing to fix', 'no fix needed',
  '代码本身正确', '这段代码正确', '是正确的', '代码没问题', '代码没有问题', '代码没毛病',
  '逻辑正确', '实现正确', '写法正确', '功能正确', '结果正确', '没错', '无错', '无问题',
  '无需修改', '不需要修改', '不用改', '无需改动', '无需更正', '不是 bug', '并非 bug', '不算 bug',
  'correct as is', 'already correct', 'is already correct', 'nothing wrong', 'no issue', 'no problem', 'no error', 'works correctly', 'functions correctly',
];

/** 提出修复的信号词（兜底，弱信号） */
const FIX_SIGNALS = [
  '修复', '修改为', '改为', '应该改成', '存在 bug', '有 bug', 'bug 在于', '问题是',
  'fix', 'fixed', 'the bug is', 'change to', 'should be',
  '需要修复', '应该修复', '要修复', '需要修改', '应该修改', '需要改成', '需要改为', '修复成',
  '存在一个 bug', '有个 bug', '出现 bug', '代码有 bug', '这里有 bug', '错误在于', '问题在于', '问题出在',
  'there is a bug', 'has a bug', 'needs fixing', 'needs to be fixed', 'should be fixed', 'should fix', 'should be changed', 'must change',
];

/** 否定式 no_bug 信号（正则，优先）：明确「没有/无/不存在 bug」或「代码正确/无需修复」。
 *  用否定词前缀避免「没有 bug」被「有 bug」子串误伤。 */
const NEGATIVE_NO_BUG_RE = /(?:没有|无|不存在|不是|并非|不算)(?:任何|功能|功能性|逻辑|明显|实质)?\s*(?:bug|错误|问题|毛病|缺陷)|(?:无需|不需要|不用|不必要|不必)\s*(?:修复|修改|改动|更正)|(?:代码|逻辑|实现|写法|功能|结果|这段代码)(?:本身|完全|基本)?\s*(?:是)?\s*(?:正确|没错|无错|没问题|没有问题|没有错误|是对的)|no[_ ]?bug|no[_ ]?bugs|not[_ ]a[_ ]bug|is[_ ]correct|looks[_ ]correct|nothing[_ ]to[_ ]fix|no[_ ]fix[_ ]needed|correct[_ ]as[_ ]is|already[_ ]correct|no[_ ]issue|no[_ ]problem|no[_ ]error|nothing[_ ]wrong|works[_ ]correctly|functions[_ ]correctly/i;

/** 肯定式 fix 信号（正则）：明确「存在/有个/出现 bug」或「需要修复」。
 *  用「存在/有个/出现/这里有/代码有」等前缀 + 负向后行断言避免「不存在/没有/不需要」等否定式子串误伤。 */
const POSITIVE_FIX_RE = /(?<![不没无未非别])(?:存在|出现|有个|这里有|代码有)(?:任何|功能|功能性|逻辑|明显|实质)?\s*(?:bug|错误|问题)|(?<![不没无未非别])(?:bug|错误|问题)\s*(?:在于|是|出在)|(?<![不没无未非别])(?:需要|应该|应当)\s*(?:修复|修改|改成|改为|更正)|(?<![不没无未非别])修复\s*成|(?<![不没无未非别])改成|(?<![不没无未非别])改为|the[_ ]bug[_ ]is|there[_ ]is[_ ]a[_ ]bug|has[_ ]a[_ ]bug|needs[_ ]fixing|needs[_ ]to[_ ]be[_ ]fixed|should[_ ]be[_ ]fixed|should[_ ]fix|should[_ ]be[_ ]changed|change[_ ]to|must[_ ]change/i;

/**
 * 提取最后一个包含 functionName 的有效代码块。
 * 修复"中间代码块污染"：模型思考过程中可能先引用原始代码，
 * 最终修复结果通常是最后一个代码块。
 */
function extractCodeBlocks(output: string): string[] {
  const blocks: string[] = [];
  const re = /```(?:[\w+-]*)\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const code = m[1].trim();
    if (code) blocks.push(code);
  }
  return blocks;
}

function pickBestBlock(blocks: string[], functionName?: string): string | null {
  if (blocks.length === 0) return null;
  if (functionName) {
    const withName = blocks.filter((b) => b.includes(functionName));
    if (withName.length > 0) return withName[withName.length - 1];
  }
  return blocks[blocks.length - 1];
}

/**
 * 当模型未使用 ``` 代码块但输出中包含代码时，尝试启发式提取。
 * 策略（按优先级）：
 * 1. 找到 functionName 对应函数/方法的完整定义
 * 2. 找到任意函数/类/模块定义
 * 3. 找到缩进代码段（连续缩进行）
 * 返回提取的代码，或 null 表示真正没有代码
 */
function heuristicExtractCode(output: string, language: string, functionName?: string): string | null {
  const lines = output.split('\n');

  // 策略1：查找包含 functionName 的代码结构
  if (functionName) {
    const funcPatterns = getLanguageFuncPatterns(language, functionName);
    for (const pattern of funcPatterns) {
      const startIdx = lines.findIndex((l) => pattern.test(l));
      if (startIdx >= 0) {
        const extracted = extractBlockFromLine(lines, startIdx, language);
        if (extracted && extracted.length > 0) return extracted;
      }
    }
  }

  // 策略2：查找任意函数/类/模块定义
  const langDefPatterns = getLanguageDefPatterns(language);
  for (const pattern of langDefPatterns) {
    const startIdx = lines.findIndex((l) => pattern.test(l));
    if (startIdx >= 0) {
      const extracted = extractBlockFromLine(lines, startIdx, language);
      if (extracted && extracted.length > 2) return extracted;
    }
  }

  // 策略3：提取连续缩进代码段（非注释、非纯文本段落）
  const indentedBlocks = extractIndentedCodeBlocks(lines);
  if (indentedBlocks.length > 0) {
    // 选择最长的代码段
    const best = indentedBlocks.reduce((a, b) => (b.length > a.length ? b : a), indentedBlocks[0]);
    if (best.length >= 3) return best;
  }

  return null;
}

/** 根据语言和函数名返回匹配模式 */
function getLanguageFuncPatterns(lang: string, funcName: string): RegExp[] {
  const escaped = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const l = lang.toLowerCase();
  const patterns: RegExp[] = [];

  // 通用：function 关键字
  patterns.push(new RegExp(`function\\s+${escaped}\\s*\\(`));
  patterns.push(new RegExp(`(const|let|var)\\s+${escaped}\\s*=`));
  patterns.push(new RegExp(`${escaped}\\s*=\\s*function`));
  patterns.push(new RegExp(`${escaped}\\s*=\\s*\\(`));

  // Go 特有
  if (l === 'go' || l === 'golang') {
    patterns.push(new RegExp(`func\\s+\\(?\\w*\\s*\\*?\\w*\\)?\\s*${escaped}\\s*\\(`));
    patterns.push(new RegExp(`func\\s+${escaped}\\s*\\(`));
  }

  // Python 特有
  if (l === 'python' || l === 'py') {
    patterns.push(new RegExp(`def\\s+${escaped}\\s*\\(`));
    patterns.push(new RegExp(`class\\s+${escaped}`));
  }

  // Java/C# 特有
  if (l === 'java' || l === 'csharp' || l === 'c#') {
    patterns.push(new RegExp(`(public|private|protected|static)\\s+.*${escaped}\\s*\\(`));
  }

  // Rust 特有
  if (l === 'rust' || l === 'rs') {
    patterns.push(new RegExp(`fn\\s+${escaped}\\s*\\(`));
  }

  return patterns;
}

/** 根据语言返回通用代码定义模式 */
function getLanguageDefPatterns(lang: string): RegExp[] {
  const l = lang.toLowerCase();
  const patterns: RegExp[] = [
    /^function\s+\w+\s*\(/,           // function xxx(
    /^(const|let|var)\s+\w+\s*=\s*(function|async\s+function|\(|class)/,  // const x = function/(
    /^(export\s+)?(default\s+)?function\s+\w/,  // export function
    /^class\s+\w+/,                    // class Xxx
    /^(public|private|protected)\s+(static\s+)?\w+\s+\w+\s*\(/,  // Java method
    /^(\w+)\s*:?\s*=\s*function/,      // obj.method = function
  ];

  if (l === 'go' || l === 'golang') {
    patterns.unshift(/^func\s+\w*\s*\(/);  // func xxx(
    patterns.unshift(/^func\s+\(/);         // func (receiver) method(
  }
  if (l === 'python' || l === 'py') {
    patterns.unshift(/^def\s+\w+\s*\(/);   // def xxx(
    patterns.unshift(/^class\s+\w+/);       // class Xxx
    patterns.unshift(/^import\s+/);         // import xxx
    patterns.unshift(/^from\s+\w+\s+import/); // from xxx import
  }
  if (l === 'rust' || l === 'rs') {
    patterns.unshift(/^fn\s+\w+\s*\(/);     // fn xxx(
    patterns.unshift(/^impl\s+\w+/);         // impl Xxx
    patterns.unshift(/^pub\s+fn\s+/);        // pub fn
  }
  if (l === 'java') {
    patterns.unshift(/^(public|private|protected)\s+/); // Java access modifier
    patterns.unshift(/^@\w+/);                          // Java annotation
  }
  if (l === 'c' || l === 'cpp' || l === 'c++') {
    patterns.unshift(/^(int|void|char|float|double|long|short|bool|auto|size_t|uint\w*_t)\s+\w+\s*\(/);
    patterns.unshift(/^#include\s+[<"]/);
  }
  if (l === 'sql') {
    patterns.unshift(/^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)\s+/i);
  }

  return patterns;
}

/**
 * 从起始行提取代码块（找到匹配的花括号/缩进范围的结束行）
 */
function extractBlockFromLine(lines: string[], startIdx: number, language: string): string | null {
  const l = language.toLowerCase();
  const useBraceMatching = ['javascript', 'typescript', 'js', 'ts', 'go', 'golang', 'java',
    'csharp', 'c#', 'c', 'cpp', 'c++', 'rust', 'rs', 'swift', 'kotlin', 'dart', 'scala'].includes(l);
  const useIndentMatching = ['python', 'py', 'ruby', 'rb', 'yaml', 'yml', 'coffeescript'].includes(l);

  if (useBraceMatching) {
    let braceDepth = 0;
    let started = false;
    const result: string[] = [];

    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      result.push(line);

      // 计数花括号（忽略字符串和注释中的）
      const clean = line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '').replace(/`[^`]*`/g, '');
      for (const ch of clean) {
        if (ch === '{') { braceDepth++; started = true; }
        if (ch === '}') braceDepth--;
      }

      if (started && braceDepth <= 0 && i > startIdx) break;
    }

    return result.join('\n');
  }

  if (useIndentMatching) {
    // Python 风格：按缩进级别匹配
    const startIndent = lines[startIdx].match(/^(\s*)/)?.[1].length ?? 0;
    const result: string[] = [lines[startIdx]];

    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') { result.push(line); continue; }
      const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (indent <= startIndent && line.trim() !== '') break;
      result.push(line);
    }

    return result.join('\n');
  }

  // 默认：取从 startIdx 开始的连续非空行（最多30行）
  const result: string[] = [];
  for (let i = startIdx; i < Math.min(lines.length, startIdx + 30); i++) {
    if (lines[i].trim() === '' && result.length > 3) break;
    result.push(lines[i]);
  }
  return result.join('\n');
}

/** 提取连续缩进代码段 */
function extractIndentedCodeBlocks(lines: string[]): string[] {
  const blocks: string[] = [];
  let currentBlock: string[] = [];
  let inBlock = false;

  for (const line of lines) {
    const startsWithIndent = /^\s{2,}\S/.test(line); // 至少2空格缩进的非空行
    const isEmpty = line.trim() === '';
    const isLikelyCode = /[{}();=<>+\-*/[\]&|!?:]/.test(line) || // 含代码运算符
      /^\s*(if|for|while|switch|case|return|break|continue|try|catch|throw|new|delete|typeof|import|export|require|const|let|var|function|class|async|await|yield|def|elif|else|elif|except|finally|raise|pass|with|from|fn|pub|impl|use|mod|struct|enum|trait|match|loop|where|type|interface|package)/.test(line.trim()); // 关键字开头

    if (startsWithIndent || (isEmpty && inBlock)) {
      if (!inBlock) {
        currentBlock = [];
        inBlock = true;
      }
      currentBlock.push(line);
    } else if (isLikelyCode && !inBlock) {
      // 非缩进但看起来像代码行（如顶级声明）
      currentBlock = [line];
      inBlock = true;
    } else {
      if (inBlock && currentBlock.length >= 3) {
        blocks.push(currentBlock.join('\n'));
      }
      currentBlock = [];
      inBlock = false;
    }
  }

  if (inBlock && currentBlock.length >= 3) {
    blocks.push(currentBlock.join('\n'));
  }

  return blocks;
}

/**
 * 计算 patch 与 source 的 diff 质量（GPT5.6 P1-3）
 * 基于行级差异而非简单长度比
 */
function calculateDiffQuality(sourceCode: string | undefined, patch: string): {
  changedLines: number;
  totalSourceLines: number;
  changeRatio: number;
  score: number;
  evidence: string;
} {
  if (!sourceCode) {
    return {
      changedLines: 0,
      totalSourceLines: 0,
      changeRatio: 0,
      score: 70,
      evidence: 'No source code for diff comparison',
    };
  }

  const sourceLines = sourceCode.split('\n');
  const patchLines = patch.split('\n');
  const totalSourceLines = sourceLines.length;

  // 简单 LCS（最长公共子序列）计算相似度
  // 对于大文件使用行集合交集近似
  const sourceSet = new Set(sourceLines.map((l) => l.trim()).filter((l) => l));
  const patchSet = new Set(patchLines.map((l) => l.trim()).filter((l) => l));

  let commonLines = 0;
  for (const line of sourceSet) {
    if (patchSet.has(line)) commonLines++;
  }

  const totalUniqueLines = sourceSet.size + patchSet.size - commonLines;
  const changedLines = totalUniqueLines - commonLines;
  const changeRatio = totalUniqueLines > 0 ? changedLines / totalUniqueLines : 0;

  // 零改动 = 未修复：不给 patch_quality 高分（否则 buggy 源码基线被软轴抬高、压缩区分度）
  if (changedLines === 0) {
    return { changedLines: 0, totalSourceLines, changeRatio: 0, score: 0, evidence: 'No change: fix not applied' };
  }

  // 评分逻辑：
  // 改动 < 30% → 90（精准修复）
  // 改动 < 50% → 80（合理修复）
  // 改动 < 80% → 60（较大改动）
  // 改动 >= 80% → 40（可能是重写）
  let score: number;
  if (changeRatio < 0.3) {
    score = 90;
  } else if (changeRatio < 0.5) {
    score = 80;
  } else if (changeRatio < 0.8) {
    score = 60;
  } else {
    score = 40;
  }

  return {
    changedLines,
    totalSourceLines,
    changeRatio,
    score,
    evidence: `Diff quality: ${changedLines} lines changed (${(changeRatio * 100).toFixed(0)}% of total)`,
  };
}

/**
 * 基于 diff 分析的范围纪律评分（GPT5.6 P1-4）
 * 不再依赖"最小改动关键词"，而是分析实际改动范围
 */
function calculateScopeDiscipline(sourceCode: string | undefined, patch: string): {
  score: number;
  evidence: string;
} {
  if (!sourceCode) {
    return { score: 70, evidence: 'No source code for scope analysis' };
  }

  const sourceLines = sourceCode.split('\n');
  const patchLines = patch.split('\n');

  // 计算新增行（在 patch 中但不在 source 中的行）
  const sourceSet = new Set(sourceLines.map((l) => l.trim()).filter((l) => l));
  const newLines = patchLines.filter((l) => {
    const trimmed = l.trim();
    return trimmed && !sourceSet.has(trimmed);
  });

  // 计算删除行（在 source 中但不在 patch 中的行）
  const patchSet = new Set(patchLines.map((l) => l.trim()).filter((l) => l));
  const removedLines = sourceLines.filter((l) => {
    const trimmed = l.trim();
    return trimmed && !patchSet.has(trimmed);
  });

  const totalChanges = newLines.length + removedLines.length;
  const sourceLen = sourceLines.filter((l) => l.trim()).length;

  // 如果改动行数占源码比例很小，说明范围纪律好
  const changeRatio = sourceLen > 0 ? totalChanges / sourceLen : 0;

  // 零改动 = 未修复
  if (totalChanges === 0) {
    return { score: 0, evidence: 'No change: fix not applied' };
  }

  let score: number;
  let evidence: string;

  if (changeRatio < 0.2) {
    score = 95;
    evidence = `Scope discipline: excellent (${totalChanges} lines changed, ${(changeRatio * 100).toFixed(0)}% of source)`;
  } else if (changeRatio < 0.4) {
    score = 80;
    evidence = `Scope discipline: good (${totalChanges} lines changed, ${(changeRatio * 100).toFixed(0)}% of source)`;
  } else if (changeRatio < 0.7) {
    score = 60;
    evidence = `Scope discipline: moderate (${totalChanges} lines changed, ${(changeRatio * 100).toFixed(0)}% of source)`;
  } else {
    score = 40;
    evidence = `Scope discipline: poor (${totalChanges} lines changed, possible over-engineering)`;
  }

  return { score, evidence };
}

export const codeRepairEvaluator: Evaluator = {
  name: 'code_repair',
  version: '3.2.0',
  aliases: ['3.1.0', '3.0.0', 'code_repair_v3'],

  async evaluate(
    scenario: Scenario,
    modelOutput: string,
    metadata: OutputMetadata,
    modelResponse: ModelResponse,
  ): Promise<Partial<ScenarioResult>> {
    const axisScores: Record<string, number> = {};
    const axisEvidence: Record<string, AxisEvidence> = {};
    const evidence: string[] = [];
    const lang = (scenario.language || 'javascript').toLowerCase();
    let runtimeEval: RuntimeEvaluation | undefined;
    const reqObj = (scenario.requirements ?? {}) as unknown as Record<string, unknown>;
    // Go/Java 有 fixture 时走容器执行（真实编译 + 测试），不再走静态关键词评分
    const goFixture = (lang === 'go' && reqObj.fixture) ? (reqObj.fixture as GoFixture) : undefined;
    const javaFixture = (lang === 'java' && reqObj.fixture) ? (reqObj.fixture as JavaFixture) : undefined;
    const isCppLang = lang === 'cpp' || lang === 'c++' || lang === 'c/c++';
    const cFixture = ((lang === 'c' || isCppLang) && reqObj.fixture) ? (reqObj.fixture as CFixture) : undefined;
    const rustFixture = (lang === 'rust' && reqObj.fixture) ? (reqObj.fixture as RustFixture) : undefined;
    const phpFixture = (lang === 'php' && reqObj.fixture) ? (reqObj.fixture as PhpFixture) : undefined;
    const csharpFixture = (lang === 'csharp' && reqObj.fixture) ? (reqObj.fixture as CsharpFixture) : undefined;
    const sqlFixture = (lang === 'sql' && reqObj.fixture) ? (reqObj.fixture as SqlFixture) : undefined;
    const bashFixture = (lang === 'bash' && reqObj.fixture) ? (reqObj.fixture as BashFixture) : undefined;
    // Python 沙箱需解释器可用，否则降级静态模式（不制造误判）
    const executable = PYTHON_LANGS.includes(lang)
      ? (await getPythonBin()) != null
      : (EXECUTABLE_LANGS.includes(lang) || goFixture != null || javaFixture != null || cFixture != null || rustFixture != null || phpFixture != null || csharpFixture != null || sqlFixture != null || bashFixture != null || reqObj.tsan === true || reqObj.miri === true);

    // ===== 陷阱题（no_bug verdict）分支 =====
    if (scenario.expectedVerdict === 'no_bug') {
      const lower = modelOutput.toLowerCase();
      const blocks = extractCodeBlocks(modelOutput);

      // 正则优先：否定式（没有/无/不存在 bug 或 代码正确/无需修复）与肯定式（存在/有个/出现 bug 或 需要修复），
      // 避免「没有 bug」被「有 bug」子串误伤（原有 includes 匹配会把否定式误判为 ambiguous）。
      const negativeNoBug = NEGATIVE_NO_BUG_RE.test(lower);
      const positiveFix = POSITIVE_FIX_RE.test(lower);

      if (negativeNoBug && !positiveFix) {
        axisScores.verdict_correct = 100;
        evidence.push('Verdict correct: identified code as correct (no bug)');
      } else if (positiveFix && !negativeNoBug) {
        axisScores.verdict_correct = 0;
        evidence.push('Verdict wrong: proposed a fix for correct code (false positive)');
      } else if (negativeNoBug && positiveFix) {
        axisScores.verdict_correct = 50;
        evidence.push('Ambiguous verdict: mixed signals of no-bug and fix');
      } else {
        // 正则无信号时兜底用关键词数组（弱信号）
        const noBugScore = NO_BUG_SIGNALS.some((s) => lower.includes(s.toLowerCase()));
        const fixScore = FIX_SIGNALS.some((s) => lower.includes(s.toLowerCase()));
        if (noBugScore && !fixScore) {
          axisScores.verdict_correct = 100;
          evidence.push('Verdict correct: identified code as correct (no bug)');
        } else if (noBugScore && fixScore) {
          axisScores.verdict_correct = 50;
          evidence.push('Ambiguous verdict: mixed signals of no-bug and fix');
        } else {
          axisScores.verdict_correct = 0;
          evidence.push('Verdict wrong: proposed a fix for correct code (false positive)');
        }
      }

      // 解释质量：是否提到关键陷阱点（requirements 中的关键词）
      const keywords = (scenario.requirements || []) as string[];
      if (keywords.length > 0) {
        const hit = keywords.filter((k) => modelOutput.includes(k)).length;
        axisScores.explanation = Math.round((hit / keywords.length) * 100);
        evidence.push(`Trap explanation: ${hit}/${keywords.length} key points covered`);
      } else {
        axisScores.explanation = modelOutput.length > 100 ? 70 : 40;
      }

      // 纪律：对正确代码不应输出大段重写（diff-based）
      const scopeResult = calculateScopeDiscipline(scenario.sourceCode, blocks.length > 0 ? blocks[blocks.length - 1] : '');
      axisScores.scope_discipline = scopeResult.score;
      evidence.push(scopeResult.evidence);

      const totalScore = Math.round(
        axisScores.verdict_correct * 0.7 +
        axisScores.explanation * 0.2 +
        axisScores.scope_discipline * 0.1,
      );
      axisEvidence.verdict_correct = 'rule';
      axisEvidence.explanation = 'rule';
      axisEvidence.scope_discipline = 'rule';
      return { axisScores, axisEvidence, totalScore, safetyLevel: 'safe', evidence };
    }

    // ===== 修复题分支 =====
    const blocks = extractCodeBlocks(modelOutput);
    let patch = pickBestBlock(blocks, scenario.functionName);
    let extractionMethod: 'markdown' | 'heuristic' | 'failed' = 'markdown';
    let codeExtractionFailed = false;

    if (!patch) {
      // 尝试启发式提取（模型输出了代码但没用 ``` 包裹）
      const fallbackPatch = heuristicExtractCode(modelOutput, lang, scenario.functionName);
      if (fallbackPatch) {
        patch = fallbackPatch;
        extractionMethod = 'heuristic';
        codeExtractionFailed = true;
        evidence.push(
          `Code extracted via heuristic (model did not use markdown code blocks). ` +
          `Extracted ${fallbackPatch.split('\n').length} lines. ` +
          `This issue should be evaluated by AI Judge for code quality.`
        );
      } else {
        // 真正没有代码
        return {
          axisScores: { patch_extraction: 0, patch_quality: 0, scope_discipline: 0 },
          axisEvidence: { patch_extraction: 'rule', patch_quality: 'unmeasured', scope_discipline: 'unmeasured' },
          totalScore: 0,
          safetyLevel: 'safe',
          evidence: ['No code found in output (neither markdown code blocks nor heuristic extraction succeeded)'],
          codeExtractionFailed: true,
        } as Partial<ScenarioResult>;
      }
    }

    // 标记提取方式
    if (extractionMethod === 'heuristic') {
      axisScores.patch_extraction = 40; // 部分分：有代码但格式不规范
      axisEvidence.patch_extraction = 'rule';
      evidence.push(`⚠️ CODE_EXTRACTION_HEURISTIC: Model output contained code but did not use proper markdown code blocks`);
    } else {
      axisScores.patch_extraction = 100;
      axisEvidence.patch_extraction = 'rule';
      evidence.push(`Patch extracted (${blocks.length} block(s), used last block containing "${scenario.functionName || 'n/a'}")`);
    }

    if (executable) {
      const tests = scenario.hiddenTests && scenario.hiddenTests.length > 0
        ? scenario.hiddenTests
        : scenario.publicTests || [];

      // ===== TypeScript 类型级校验路径（CP-L3-TS-003/004/006/007：修类型定义） =====
      if (lang === 'typescript' && reqObj.typeLevel === true) {
        const typeCases = (reqObj.typeTests as TypeCheckCase[]) || [];
        const typeResult = runTypeScriptTypeCheck(patch, typeCases);
        axisScores.compilation = typeResult.compiled ? 100 : 0;
        axisEvidence.compilation = 'verified';
        evidence.push(typeResult.compiled
          ? 'TypeScript strict type-check: passed'
          : 'TypeScript strict type-check: FAILED — ' + typeResult.compileErrors.slice(0, 3).join(' | '));
        const rtDetails = tests.length > 0 ? await Promise.all(tests.map((tc) => runReplacedCodeTest(patch, tc))) : [];
        const allDetails = [...typeResult.details, ...rtDetails];
        if (reqObj.forbidAs === true) {
          allDetails.push({ testId: 'no_as_assertion', testType: 'static', name: 'no as assertion', passed: !/\bas\b/.test(patch) });
        }
        const tsSuite = summarizeTestResults(allDetails);
        runtimeEval = {
          compilePassed: typeResult.compiled,
          testsPassed: tsSuite.passedTests,
          testsFailed: tsSuite.failedTests,
          testsTotal: tsSuite.totalTests,
          hiddenTestsPassed: tsSuite.passedTests,
          hiddenTestsFailed: tsSuite.failedTests,
          hiddenTestsTotal: tsSuite.totalTests,
          details: allDetails,
        };
        axisScores.test_pass = calculateTestScore(tsSuite);
        axisEvidence.test_pass = 'verified';
        evidence.push('TS type-level + runtime tests: ' + tsSuite.passedTests + '/' + tsSuite.totalTests + ' passed');
      } else if (bashFixture) {
        // ===== Bash 容器执行路径（脚本断言，退出码判定） =====
        const bashRes = await runBashTestsInContainer(patch, tests, bashFixture);
        const bashCompiled = !/syntax error|command not found/.test(bashRes.stderr);
        axisScores.compilation = bashCompiled ? 100 : 0;
        axisEvidence.compilation = 'verified';
        evidence.push(bashCompiled
          ? 'Bash container ran successfully'
          : 'Bash container error: ' + bashRes.stderr.slice(0, 200).replace(/\n/g, ' '));

        if (tests.length > 0) {
          const details = bashRes.tests.map((t) => ({
            testId: t.name,
            testType: 'hidden',
            passed: t.passed,
            stdout: '',
            stderr: t.passed ? '' : 'assertion failed',
            exitCode: t.passed ? 0 : 1,
            duration: 0,
            timedOut: bashRes.timedOut,
          }));
          const suiteResult = summarizeTestResults(details);
          runtimeEval = { compilePassed: bashCompiled, testsPassed: suiteResult.passedTests, testsFailed: suiteResult.failedTests, testsTotal: suiteResult.totalTests, hiddenTestsPassed: suiteResult.passedTests, hiddenTestsFailed: suiteResult.failedTests, hiddenTestsTotal: suiteResult.totalTests, details };
          axisScores.test_pass = calculateTestScore(suiteResult);
          axisEvidence.test_pass = 'verified';
          evidence.push(suiteResult.totalTests > 0
            ? `Bash container tests: ${suiteResult.passedTests}/${suiteResult.totalTests} passed`
            : 'Bash compile failed — tests not run');
        } else {
          axisEvidence.test_pass = 'unmeasured';
          evidence.push('No Bash tests available for verification');
        }
      } else if (sqlFixture) {
        // ===== SQL 容器执行路径（建表 + 插数 + 查询 + 结果集/计划比对） =====
        const sqlRes = await runSqlInContainer(patch, sqlFixture);
        const sqlCompiled = !/SQLITE_ERROR|SyntaxError/.test(sqlRes.stderr);
        axisScores.compilation = sqlCompiled ? 100 : 0;
        axisEvidence.compilation = 'verified';
        evidence.push(sqlCompiled
          ? 'SQL container ran successfully'
          : 'SQL container error: ' + sqlRes.stderr.slice(0, 200).replace(/\n/g, ' '));

        runtimeEval = { compilePassed: sqlCompiled, testsPassed: sqlRes.passed ? 1 : 0, testsFailed: sqlRes.passed ? 0 : 1, testsTotal: 1, hiddenTestsPassed: sqlRes.passed ? 1 : 0, hiddenTestsFailed: sqlRes.passed ? 0 : 1, hiddenTestsTotal: 1, details: [{ testId: 'sql_result', testType: 'hidden', passed: sqlRes.passed, stderr: sqlRes.passed ? '' : 'result mismatch' }] };
        axisScores.test_pass = sqlRes.passed ? 100 : 0;
        axisEvidence.test_pass = 'verified';
        evidence.push(sqlRes.passed
          ? 'SQL result set matches expected'
          : 'SQL result mismatch: actual=' + JSON.stringify(sqlRes.actual).slice(0, 200));
      } else if (phpFixture) {
        // ===== PHP 容器执行路径（真实运行 + assert） =====
        const phpRes = await runPhpTestsInContainer(patch, tests, phpFixture);
        const phpCompiled = !/Parse error|Fatal error:/.test(phpRes.stderr);
        axisScores.compilation = phpCompiled ? 100 : 0;
        axisEvidence.compilation = 'verified';
        evidence.push(phpCompiled
          ? 'PHP container ran successfully'
          : 'PHP container parse/run failed: ' + phpRes.stderr.slice(0, 200).replace(/\n/g, ' '));

        if (tests.length > 0) {
          const details = phpRes.tests.map((t) => ({
            testId: t.name,
            testType: 'hidden',
            passed: t.passed,
            stdout: '',
            stderr: t.passed ? '' : 'test failed (assert)',
            exitCode: t.passed ? 0 : 1,
            duration: 0,
            timedOut: phpRes.timedOut,
          }));
          const suiteResult = summarizeTestResults(details);
          runtimeEval = { compilePassed: phpCompiled, testsPassed: suiteResult.passedTests, testsFailed: suiteResult.failedTests, testsTotal: suiteResult.totalTests, hiddenTestsPassed: suiteResult.passedTests, hiddenTestsFailed: suiteResult.failedTests, hiddenTestsTotal: suiteResult.totalTests, details };
          axisScores.test_pass = calculateTestScore(suiteResult);
          axisEvidence.test_pass = 'verified';
          evidence.push(suiteResult.totalTests > 0
            ? `PHP container tests: ${suiteResult.passedTests}/${suiteResult.totalTests} passed`
            : 'PHP compile failed — tests not run');
        } else {
          axisEvidence.test_pass = 'unmeasured';
          evidence.push('No PHP tests available for verification');
        }
      } else if (csharpFixture) {
        // ===== C# 容器执行路径（真实编译 + 运行） =====
        const csRes = await runCsharpTestsInContainer(patch, tests, csharpFixture);
        const csCompiled = !/error CS\d+/.test(csRes.stderr);
        axisScores.compilation = csCompiled ? 100 : 0;
        axisEvidence.compilation = 'verified';
        evidence.push(csCompiled
          ? 'C# container compiled successfully'
          : 'C# container compile failed: ' + csRes.stderr.slice(0, 200).replace(/\n/g, ' '));

        if (tests.length > 0) {
          const details = csRes.tests.map((t) => ({
            testId: t.name,
            testType: 'hidden',
            passed: t.passed,
            stdout: '',
            stderr: t.passed ? '' : 'test failed (assert)',
            exitCode: t.passed ? 0 : 1,
            duration: 0,
            timedOut: csRes.timedOut,
          }));
          const suiteResult = summarizeTestResults(details);
          runtimeEval = { compilePassed: csCompiled, testsPassed: suiteResult.passedTests, testsFailed: suiteResult.failedTests, testsTotal: suiteResult.totalTests, hiddenTestsPassed: suiteResult.passedTests, hiddenTestsFailed: suiteResult.failedTests, hiddenTestsTotal: suiteResult.totalTests, details };
          axisScores.test_pass = calculateTestScore(suiteResult);
          axisEvidence.test_pass = 'verified';
          evidence.push(suiteResult.totalTests > 0
            ? `C# container tests: ${suiteResult.passedTests}/${suiteResult.totalTests} passed`
            : 'C# compile failed — tests not run');
        } else {
          axisEvidence.test_pass = 'unmeasured';
          evidence.push('No C# tests available for verification');
        }
      } else if (lang === 'rust' && reqObj.miri === true) {
        // ===== Rust Miri 健全性压测路径（CP-L3-RS-003：unsafe 越界 + transmute 生命周期） =====
        const miriRes = await runRustMiriInContainer(patch, 180000);
        axisScores.compilation = miriRes.compiled ? 100 : 0;
        axisEvidence.compilation = 'verified';
        evidence.push(miriRes.compiled
          ? 'Rust Miri test compiled successfully'
          : 'Rust Miri compile failed: ' + miriRes.stderr.slice(0, 200).replace(/\n/g, ' '));
        const details = [
          { testId: 'miri_clean', testType: 'hidden', name: 'Miri 无 Undefined Behavior', passed: miriRes.miriClean, stderr: miriRes.miriClean ? '' : 'Miri 检测到 UB（越界/retag/别名违反）' },
          { testId: 'functional', testType: 'hidden', name: 'split_two 边界 + 越界 panic（4 测试全过）', passed: miriRes.testsPassed === miriRes.testsTotal, stderr: miriRes.testsPassed === miriRes.testsTotal ? '' : miriRes.testsPassed + '/' + miriRes.testsTotal + ' passed' },
        ];
        if (reqObj.forbidTransmute === true) {
          details.push({ testId: 'no_transmute', testType: 'static', name: '删除 reborrow_long 的 transmute 生命周期伪造', passed: !/\btransmute\b/.test(patch), stderr: '' });
        }
        const suiteResult = summarizeTestResults(details);
        runtimeEval = { compilePassed: miriRes.compiled, testsPassed: suiteResult.passedTests, testsFailed: suiteResult.failedTests, testsTotal: suiteResult.totalTests, hiddenTestsPassed: suiteResult.passedTests, hiddenTestsFailed: suiteResult.failedTests, hiddenTestsTotal: suiteResult.totalTests, details };
        axisScores.test_pass = calculateTestScore(suiteResult);
        axisEvidence.test_pass = 'verified';
        evidence.push('Rust Miri: ' + suiteResult.passedTests + '/' + suiteResult.totalTests + ' passed' + (miriRes.miriClean ? '' : ' (UB detected!)'));
      } else if (rustFixture) {
        // ===== Rust 容器执行路径（真实编译 + assert） =====
        const rustRes = await runRustTestsInContainer(patch, tests, rustFixture);
        const rustCompiled = !/error\[?/.test(rustRes.stderr) && !/^error:/.test(rustRes.stderr);
        axisScores.compilation = rustCompiled ? 100 : 0;
        axisEvidence.compilation = 'verified';
        evidence.push(rustCompiled
          ? 'Rust container compiled successfully'
          : 'Rust container compile failed: ' + rustRes.stderr.slice(0, 200).replace(/\n/g, ' '));

        if (tests.length > 0) {
          const details = rustRes.tests.map((t) => ({
            testId: t.name,
            testType: 'hidden',
            passed: t.passed,
            stdout: '',
            stderr: t.passed ? '' : 'test failed (assert)',
            exitCode: t.passed ? 0 : 1,
            duration: 0,
            timedOut: rustRes.timedOut,
          }));
          const suiteResult = summarizeTestResults(details);
          runtimeEval = { compilePassed: rustCompiled, testsPassed: suiteResult.passedTests, testsFailed: suiteResult.failedTests, testsTotal: suiteResult.totalTests, hiddenTestsPassed: suiteResult.passedTests, hiddenTestsFailed: suiteResult.failedTests, hiddenTestsTotal: suiteResult.totalTests, details };
          axisScores.test_pass = calculateTestScore(suiteResult);
          axisEvidence.test_pass = 'verified';
          evidence.push(suiteResult.totalTests > 0
            ? `Rust container tests: ${suiteResult.passedTests}/${suiteResult.totalTests} passed`
            : 'Rust compile failed — tests not run');
        } else {
          axisEvidence.test_pass = 'unmeasured';
          evidence.push('No Rust tests available for verification');
        }
      } else if (isCppLang && reqObj.tsan === true) {
        // ===== C++ TSan 并发压测路径（CP-L3-CC-005：Treiber 无锁栈内存序） =====
        const tsanRes = await runCppTsanInContainer(patch, 120000);
        const cCompiled = !tsanRes.compileError;
        axisScores.compilation = cCompiled ? 100 : 0;
        axisEvidence.compilation = 'verified';
        evidence.push(cCompiled
          ? 'C++ TSan compile passed'
          : 'C++ TSan compile failed: ' + tsanRes.stderr.slice(0, 200).replace(/\n/g, ' '));
        const details = [
          { testId: 'tsan_clean', testType: 'hidden', name: 'TSan zero data race', passed: cCompiled && !tsanRes.raceDetected, stderr: tsanRes.raceDetected ? 'data race detected (memory order not paired)' : '' },
          { testId: 'functional', testType: 'hidden', name: 'LIFO order + empty pop + MPSC stress multiset', passed: tsanRes.passed, stderr: tsanRes.passed ? '' : 'assert failed or race halted run' },
        ];
        if (reqObj.forbidMutex === true) {
          details.push({ testId: 'no_mutex', testType: 'static', name: 'lock-free preserved (no mutex)', passed: !/std::mutex|lock_guard|unique_lock|scoped_lock|pthread_mutex/.test(patch), stderr: '' });
        }
        const suiteResult = summarizeTestResults(details);
        runtimeEval = { compilePassed: cCompiled, testsPassed: suiteResult.passedTests, testsFailed: suiteResult.failedTests, testsTotal: suiteResult.totalTests, hiddenTestsPassed: suiteResult.passedTests, hiddenTestsFailed: suiteResult.failedTests, hiddenTestsTotal: suiteResult.totalTests, details };
        axisScores.test_pass = calculateTestScore(suiteResult);
        axisEvidence.test_pass = 'verified';
        evidence.push('C++ TSan: ' + suiteResult.passedTests + '/' + suiteResult.totalTests + ' passed' + (tsanRes.raceDetected ? ' (data race!)' : ''));
      } else if (cFixture) {
        // ===== C/C++ 容器执行路径（真实编译 + ASan + assert） =====
        const cRes = isCppLang ? await runCppTestsInContainer(patch, tests, cFixture) : await runCTestsInContainer(patch, tests, cFixture);
        const cCompiled = !/error:/.test(cRes.stderr);
        axisScores.compilation = cCompiled ? 100 : 0;
        axisEvidence.compilation = 'verified';
        evidence.push(cCompiled
          ? 'C/C++ container compiled successfully'
          : 'C/C++ container compile failed: ' + cRes.stderr.slice(0, 200).replace(/\n/g, ' '));

        if (tests.length > 0) {
          const details = cRes.tests.map((t) => ({
            testId: t.name,
            testType: 'hidden',
            passed: t.passed,
            stdout: '',
            stderr: t.passed ? '' : 'test failed (assert/ASan)',
            exitCode: t.passed ? 0 : 1,
            duration: 0,
            timedOut: cRes.timedOut,
          }));
          const suiteResult = summarizeTestResults(details);
          runtimeEval = { compilePassed: cCompiled, testsPassed: suiteResult.passedTests, testsFailed: suiteResult.failedTests, testsTotal: suiteResult.totalTests, hiddenTestsPassed: suiteResult.passedTests, hiddenTestsFailed: suiteResult.failedTests, hiddenTestsTotal: suiteResult.totalTests, details };
          axisScores.test_pass = calculateTestScore(suiteResult);
          axisEvidence.test_pass = 'verified';
          evidence.push(suiteResult.totalTests > 0
            ? `C/C++ container tests: ${suiteResult.passedTests}/${suiteResult.totalTests} passed`
            : 'C compile failed — tests not run');
        } else {
          axisEvidence.test_pass = 'unmeasured';
          evidence.push('No C/C++ tests available for verification');
        }
      } else if (javaFixture) {
        // ===== Java 容器执行路径（真实编译 + JUnit） =====
        const javaRes = await runJavaTestsInContainer(patch, tests, javaFixture);
        const javaCompiled = javaRes.tests.length > 0 && !/error:/.test(javaRes.stderr);
        axisScores.compilation = javaCompiled ? 100 : 0;
        axisEvidence.compilation = 'verified';
        evidence.push(javaCompiled
          ? 'Java container compiled successfully'
          : 'Java container compile failed: ' + javaRes.stderr.slice(0, 200).replace(/\n/g, ' '));

        if (tests.length > 0) {
          const details = javaRes.tests.map((t) => ({
            testId: t.name,
            testType: 'hidden',
            passed: t.passed,
            stdout: '',
            stderr: t.passed ? '' : 'test failed',
            exitCode: t.passed ? 0 : 1,
            duration: 0,
            timedOut: javaRes.timedOut,
          }));
          const suiteResult = summarizeTestResults(details);
          runtimeEval = { compilePassed: javaCompiled, testsPassed: suiteResult.passedTests, testsFailed: suiteResult.failedTests, testsTotal: suiteResult.totalTests, hiddenTestsPassed: suiteResult.passedTests, hiddenTestsFailed: suiteResult.failedTests, hiddenTestsTotal: suiteResult.totalTests, details };
          axisScores.test_pass = calculateTestScore(suiteResult);
          axisEvidence.test_pass = 'verified';
          evidence.push(suiteResult.totalTests > 0
            ? `Java container tests: ${suiteResult.passedTests}/${suiteResult.totalTests} passed`
            : 'Java compile failed — tests not run');
        } else {
          axisEvidence.test_pass = 'unmeasured';
          evidence.push('No Java tests available for verification');
        }
      } else if (goFixture) {
        // ===== Go 容器执行路径（真实编译 + go test） =====
        if (goFixture.programMode && goFixture.expectedOutput) {
          const progRes = await runGoProgramInContainer(patch, goFixture.expectedOutput);
          const progCompiled = progRes.exitCode === 0 && !/error/.test(progRes.stderr);
          axisScores.compilation = progCompiled ? 100 : 0;
          axisEvidence.compilation = 'verified';
          runtimeEval = { compilePassed: progCompiled, testsPassed: progRes.passed ? 1 : 0, testsFailed: progRes.passed ? 0 : 1, testsTotal: 1, hiddenTestsPassed: progRes.passed ? 1 : 0, hiddenTestsFailed: progRes.passed ? 0 : 1, hiddenTestsTotal: 1, details: [{ testId: 'program_output', testType: 'hidden', passed: progRes.passed, stderr: progRes.passed ? '' : 'output mismatch' }] };
          axisScores.test_pass = progRes.passed ? 100 : 0;
          axisEvidence.test_pass = 'verified';
          evidence.push(progRes.passed
            ? 'Go program output matches expected'
            : 'Go program output mismatch: ' + JSON.stringify(progRes.stdout).slice(0, 200));
        } else {
        const goRes = await runGoTestsInContainer(patch, tests, goFixture);
        // 只要有 PASS/FAIL 输出即说明编译通过（编译失败不会产生测试结果行）
        const compiled = goRes.tests.length > 0;
        axisScores.compilation = compiled ? 100 : 0;
        axisEvidence.compilation = 'verified';
        evidence.push(compiled
          ? 'Go container compiled successfully'
          : 'Go container compile failed: ' + goRes.stderr.slice(0, 200).replace(/\n/g, ' '));

        if (tests.length > 0) {
          const details = goRes.tests.map((t) => ({
            testId: t.name,
            testType: 'hidden',
            passed: t.passed,
            stdout: '',
            stderr: t.passed ? '' : 'test failed',
            exitCode: t.passed ? 0 : 1,
            duration: 0,
            timedOut: goRes.timedOut,
          }));
          const suiteResult = summarizeTestResults(details);
          runtimeEval = { compilePassed: compiled, testsPassed: suiteResult.passedTests, testsFailed: suiteResult.failedTests, testsTotal: suiteResult.totalTests, hiddenTestsPassed: suiteResult.passedTests, hiddenTestsFailed: suiteResult.failedTests, hiddenTestsTotal: suiteResult.totalTests, details };
          axisScores.test_pass = calculateTestScore(suiteResult);
          axisEvidence.test_pass = 'verified';
          evidence.push(suiteResult.totalTests > 0
            ? `Go container tests: ${suiteResult.passedTests}/${suiteResult.totalTests} passed`
            : 'Go compile failed — tests not run');
        } else {
          axisEvidence.test_pass = 'unmeasured';
          evidence.push('No Go tests available for verification');
        }
        }
      } else {
        // ===== 沙箱执行路径（JS/TS/Python） =====
        axisScores.compilation = scenario.sourceCode ? 100 : 50;
        axisEvidence.compilation = scenario.sourceCode ? 'verified' : 'rule';

        if (tests.length > 0) {
          // 沙箱模式：直接用模型输出的完整修复代码替换源码运行测试
          const runner = PYTHON_LANGS.includes(lang) ? runReplacedCodeTestPython : runReplacedCodeTest;
          const details = await Promise.all(tests.map((tc) => runner(patch, tc)));
          const suiteResult = summarizeTestResults(details);
          runtimeEval = { compilePassed: !!scenario.sourceCode, testsPassed: suiteResult.passedTests, testsFailed: suiteResult.failedTests, testsTotal: suiteResult.totalTests, hiddenTestsPassed: suiteResult.passedTests, hiddenTestsFailed: suiteResult.failedTests, hiddenTestsTotal: suiteResult.totalTests, details };
          axisScores.test_pass = calculateTestScore(suiteResult);
          axisEvidence.test_pass = 'verified';
          evidence.push(suiteResult.totalTests > 0
            ? `Sandbox tests (${lang}): ${suiteResult.passedTests}/${suiteResult.totalTests} passed`
            : `Sandbox tests (${lang}) not run — compile failed`);
        } else {
          axisEvidence.test_pass = 'unmeasured';
          evidence.push('No tests available for verification');
        }
      }
    } else {
      // ===== 静态模式（Python/Java/Go/C/Rust 等）：真实编译/语法检查（verified） =====
      const cc = await compileCheck(patch, lang);
      if (cc.score != null) {
        axisScores.compile_check = cc.score;
        axisEvidence.compile_check = 'verified';
        evidence.push(cc.evidence);
      } else {
        axisEvidence.compile_check = 'unmeasured';
        evidence.push(cc.evidence);
      }

      // 输出完整性（rule）
      axisScores.output_completeness = metadata.incomplete ? 0 : 100;
      axisEvidence.output_completeness = 'rule';

      // 静态信号检查：修复是否包含预期关键特征（弱证据，仅作辅助）
      const keywords = (scenario.requirements || []) as string[];
      if (keywords.length > 0) {
        const hit = keywords.filter((k) => patch.includes(k) || modelOutput.includes(k)).length;
        axisScores.static_signals = Math.round((hit / keywords.length) * 100);
        axisEvidence.static_signals = 'rule';
        evidence.push(`Static signals: ${hit}/${keywords.length} expected patterns found`);
      }
    }

    // Patch 质量：基于 diff 分析（GPT5.6 P1-3）
    const diffQuality = calculateDiffQuality(scenario.sourceCode, patch);
    axisScores.patch_quality = diffQuality.score;
    axisEvidence.patch_quality = 'rule';
    evidence.push(diffQuality.evidence);

    // 范围纪律：基于 diff 分析（GPT5.6 P1-4）
    const scopeResult = calculateScopeDiscipline(scenario.sourceCode, patch);
    axisScores.scope_discipline = scopeResult.score;
    axisEvidence.scope_discipline = 'rule';
    evidence.push(scopeResult.evidence);

    // 总分：仅按已测量轴加权（未测量轴不计入分母，避免 NaN/中性分虚增）
    let totalScore: number;
    if (executable) {
      const axesExec: Array<[number | undefined, number]> = [
        [axisScores.patch_extraction, 0.10],
        [axisScores.compilation, 0.20],
        [axisScores.test_pass, 0.40],
        [axisScores.patch_quality, 0.20],
        [axisScores.scope_discipline, 0.10],
      ];
      const [sum, wsum] = axesExec.reduce<[number, number]>(
        ([s, w], [score, weight]) => (score == null ? [s, w] : [s + score * weight, w + weight]),
        [0, 0],
      );
      totalScore = Math.round(wsum > 0 ? sum / wsum : 0);
    } else {
      // 静态模式：compile_check 未测量时自动重归一，避免中性分虚增
      const axesStatic: Array<[number | undefined, number]> = [
        [axisScores.patch_extraction, 0.15],
        [axisScores.compile_check, 0.25],
        [axisScores.static_signals, 0.20],
        [axisScores.patch_quality, 0.20],
        [axisScores.scope_discipline, 0.10],
        [axisScores.output_completeness, 0.10],
      ];
      const [sum, wsum] = axesStatic.reduce<[number, number]>(
        ([s, w], [score, weight]) => (score == null ? [s, w] : [s + score * weight, w + weight]),
        [0, 0],
      );
      totalScore = Math.round(wsum > 0 ? sum / wsum : 0);
    }

    return {
      axisScores,
      axisEvidence,
      totalScore,
      safetyLevel: 'safe',
      evidence,
      codeExtractionFailed,
      runtimeEvaluation: runtimeEval,
      extractedPatch: patch ?? undefined,
    };
  },
};
