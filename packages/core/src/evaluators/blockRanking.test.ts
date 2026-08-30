import { describe, it, expect } from 'vitest';
import { rankBlocks } from './codeRepair.js';

/**
 * I6 回归：候选块排序（修复补丁提取漂移导致的测试全崩）
 *
 * 实测依据：K1↔K2 同题波动 ≥30 分的 15 道题中，12 道是 test_pass 在 0/100 之间整段跳变，
 * 证据形如「4/4 passed ↔ 0/4 passed」。根因是原 pickBestBlock 固定取最后一个含函数名的块，
 * 而模型每次输出块数不同 → 选中对象漂移（选中模型自带的测试示例或中间态片段）。
 */
describe('rankBlocks (I6: patch-extraction drift fix)', () => {
  it('returns empty for no blocks', () => {
    expect(rankBlocks([])).toEqual([]);
  });

  it('returns the single block as-is', () => {
    expect(rankBlocks(['const a = 1;'])).toEqual(['const a = 1;']);
  });

  it('prefers the implementation over a trailing test snippet', () => {
    // 模型先给修复实现、再给「我写的测试」——原逻辑会选中测试块导致 0/N
    const impl = [
      'import fs from "fs";',
      'export function readFirstLine(path) {',
      '  return fs.readFileSync(path, "utf8").split("\\n")[0];',
      '}',
    ].join('\n');
    const testSnippet = [
      'describe("readFirstLine", () => {',
      '  it("reads the first line", () => {',
      '    expect(readFirstLine("a.txt")).toBe("hello");',
      '  });',
      '});',
    ].join('\n');
    const ranked = rankBlocks([impl, testSnippet], 'readFirstLine');
    expect(ranked[0]).toBe(impl);
  });

  it('prefers a complete file (with imports) over a bare fragment', () => {
    const fragment = 'return a + b;';
    const complete = [
      'package main',
      'import "fmt"',
      'func Sum(a, b int) int { return a + b }',
      'func main() { fmt.Println(Sum(1, 2)) }',
    ].join('\n');
    const ranked = rankBlocks([fragment, complete], 'Sum');
    expect(ranked[0]).toBe(complete);
  });

  it('still prefers the block containing the target function name', () => {
    const unrelated = ['import os', 'def helper():', '    return 42'].join('\n');
    const target = ['def compute(x):', '    return x * 2'].join('\n');
    const ranked = rankBlocks([unrelated, target], 'compute');
    expect(ranked[0]).toBe(target);
  });

  it('returns all blocks as candidates (never drops one)', () => {
    const a = 'def f(): pass';
    const b = 'def g(): pass';
    const c = 'def h(): pass';
    const ranked = rankBlocks([a, b, c]);
    expect(ranked).toHaveLength(3);
    expect(new Set(ranked)).toEqual(new Set([a, b, c]));
  });

  it('I6 regression: real-world drift case — 3 blocks with test last', () => {
    // 复刻 CP-L1-JS-001 形态：引用原始代码 → 最终修复 → 自写测试
    const original = ['function sortDesc(arr) {', '  return arr; // TODO', '}'].join('\n');
    const fixed = [
      'function sortDesc(arr) {',
      '  return [...arr].sort((a, b) => b - a);',
      '}',
      'module.exports = { sortDesc };',
    ].join('\n');
    const tests = [
      'const assert = require("assert");',
      'assert.deepEqual(sortDesc([1, 3, 2]), [3, 2, 1]);',
    ].join('\n');
    const ranked = rankBlocks([original, fixed, tests], 'sortDesc');
    expect(ranked[0]).toBe(fixed);
    expect(ranked).toContain(tests);
  });
});
