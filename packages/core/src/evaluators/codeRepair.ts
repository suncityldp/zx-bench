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

import type { Scenario, ScenarioResult, OutputMetadata, ModelResponse, AxisEvidence } from '@zxbench/types';
import type { Evaluator } from './index.js';
import { runReplacedCodeTest, runReplacedCodeTestPython, summarizeTestResults, calculateTestScore, getPythonBin } from '../hidden-tests/index.js';
import { runGoTestsInContainer, type GoFixture } from '../execution/goRunner.js';
import { spawnSync } from 'node:child_process';
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
    const res = spawnSync(spec.bin, spec.args(file), { encoding: 'utf8', timeout: 15000 });
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

/** 拒绝修复（认为代码正确）的信号词 */
const NO_BUG_SIGNALS = [
  '没有 bug', '没有bug', '无 bug', '无bug', '不存在 bug', '代码正确', '代码是正确的',
  '无需修复', '不需要修复', '不用修复', '没有错误', '没有问题', '正确的代码',
  'no bug', 'no bugs', 'is correct', 'looks correct', 'nothing to fix', 'no fix needed',
  '代码本身正确', '这段代码正确', '是正确的',
];

/** 提出修复的信号词 */
const FIX_SIGNALS = [
  '修复', '修改为', '改为', '应该改成', '存在 bug', '有 bug', 'bug 在于', '问题是',
  'fix', 'fixed', 'the bug is', 'change to', 'should be',
];

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
    const reqObj = (scenario.requirements ?? {}) as unknown as Record<string, unknown>;
    // Go 有 fixture 时走容器执行（真实编译 + 测试），不再走静态关键词评分
    const goFixture = (lang === 'go' && reqObj.fixture) ? (reqObj.fixture as GoFixture) : undefined;
    // Python 沙箱需解释器可用，否则降级静态模式（不制造误判）
    const executable = PYTHON_LANGS.includes(lang)
      ? getPythonBin() != null
      : (EXECUTABLE_LANGS.includes(lang) || goFixture != null);

    // ===== 陷阱题（no_bug verdict）分支 =====
    if (scenario.expectedVerdict === 'no_bug') {
      const lower = modelOutput.toLowerCase();
      const noBugScore = NO_BUG_SIGNALS.some((s) => lower.includes(s.toLowerCase()));
      const fixScore = FIX_SIGNALS.some((s) => lower.includes(s.toLowerCase()));
      const blocks = extractCodeBlocks(modelOutput);

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

      if (goFixture) {
        // ===== Go 容器执行路径（真实编译 + go test） =====
        const goRes = runGoTestsInContainer(patch, tests, goFixture);
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
          axisScores.test_pass = calculateTestScore(suiteResult);
          axisEvidence.test_pass = 'verified';
          evidence.push(`Go container tests: ${suiteResult.passedTests}/${suiteResult.totalTests} passed`);
        } else {
          axisEvidence.test_pass = 'unmeasured';
          evidence.push('No Go tests available for verification');
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
          axisScores.test_pass = calculateTestScore(suiteResult);
          axisEvidence.test_pass = 'verified';
          evidence.push(`Sandbox tests (${lang}): ${suiteResult.passedTests}/${suiteResult.totalTests} passed`);
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
    };
  },
};
