// ============================================================
// 多文件 patch 解析器回归测试
// 背景：原 parseFileBlocks 仅认 `### file: <path>`，模型自然写法
//       （`### \`path\``、`### 1. \`path\` —— 说明`、`#### \`path\``、
//       代码块首行 `# filename.py` 注释）全解析为 0 个替换，导致
//       project_repair 整组在原始错误代码上跑测试 → 必然失败。
//       此测试锁住修复后的多种格式与防误报。
// ============================================================
import { describe, it, expect } from 'vitest';
import { parseFileBlocks, extractPathFromHeading, looksLikeFilePath, normalizePath } from './evaluators/patchParser.js';

describe('parseFileBlocks 多文件提取', () => {
  it('反引号包路径（Qwen 自然写法）', () => {
    const out = '### `extractors/csv_reader.py`\n```python\nimport csv\n```\n\n### `transformers/cleaner.py`\n```python\ndef clean():\n    pass\n```\n';
    const r = parseFileBlocks(out);
    expect(Object.keys(r).sort()).toEqual(['extractors/csv_reader.py', 'transformers/cleaner.py']);
    expect(r['extractors/csv_reader.py']).toContain('import csv');
  });

  it('编号 + 反引号 + 中文描述（Ornith 自然写法）', () => {
    const out = '### 1. `Services/OrderService.cs` —— ReportAsync 改为单条 SQL\n```csharp\nvoid Report() {}\n```\n';
    const r = parseFileBlocks(out);
    expect(Object.keys(r)).toEqual(['Services/OrderService.cs']);
  });

  it('任意标题层级（####）', () => {
    const out = '#### `CMakeLists.txt`\n```cmake\ncmake_minimum_required(VERSION 3.10)\n```\n';
    expect(Object.keys(parseFileBlocks(out))).toEqual(['CMakeLists.txt']);
  });

  it('规范格式 ### file: path 仍兼容', () => {
    const out = '### file: src/main.py\n```python\nprint(1)\n```\n';
    expect(Object.keys(parseFileBlocks(out))).toEqual(['src/main.py']);
  });

  it('裸路径 ### main.py', () => {
    const out = '### main.py\n```python\nx = 1\n```\n';
    expect(Object.keys(parseFileBlocks(out))).toEqual(['main.py']);
  });

  it('代码块首行 # filename.py 注释（Python 约定）', () => {
    const out = '下面是各文件实现：\n\n```python\n# scheduler.py\nimport heapq\n```\n\n```python\n# retry.py\ndef retry(): pass\n```\n';
    const r = parseFileBlocks(out);
    expect(Object.keys(r).sort()).toEqual(['retry.py', 'scheduler.py']);
    expect(r['scheduler.py']).toContain('import heapq');
    expect(r['scheduler.py']).not.toContain('# scheduler.py'); // 注释行被剔除
  });

  it('普通章节标题不误判为文件（防误报）', () => {
    const out = '### 实现思路\n```python\nx = 1\n```\n\n### Step 1: Setup\n```python\ny = 2\n```\n';
    expect(Object.keys(parseFileBlocks(out))).toEqual([]);
  });

  it('代码块内 # 注释不当标题（shell 场景防误报）', () => {
    // bash 代码块内的 # 注释行不应被当作文件块标题
    const out = '```bash\n# host per line, comments / blanks ignored\nserver1\nserver2\n```\n';
    expect(Object.keys(parseFileBlocks(out))).toEqual([]);
  });

  it('反引号包的非文件路径（如 /debug/db 端点）不误判', () => {
    const out = '### 4. `/debug/db` 端点（Monitor.cs）\n```csharp\nvoid Db() {}\n```\n';
    expect(Object.keys(parseFileBlocks(out))).toEqual([]);
  });

  it('跨标题不串接：无代码块的标题不偷下一个标题的代码块', () => {
    const out = '### `a.py`\n没有代码块，只有说明文字。\n\n### `b.py`\n```python\nb = 2\n```\n';
    const r = parseFileBlocks(out);
    expect(Object.keys(r)).toEqual(['b.py']); // a.py 无代码块 → 不应窃取 b.py 的块
    expect(r['b.py']).toContain('b = 2');
  });

  it('同一路径只取首次', () => {
    const out = '### `main.py`\n```python\nv = 1\n```\n\n### `main.py`\n```python\nv = 2\n```\n';
    const r = parseFileBlocks(out);
    expect(Object.keys(r)).toEqual(['main.py']);
    expect(r['main.py']).toContain('v = 1');
  });

  it('空输入返回空', () => {
    expect(parseFileBlocks('')).toEqual({});
    expect(parseFileBlocks('没有任何标题的纯文本')).toEqual({});
  });
});

describe('extractPathFromHeading 单元', () => {
  it.each([
    ['`src/main.py`', 'src/main.py'],
    ['1. `src/main.py` —— 说明', 'src/main.py'],
    ['file: src/main.py', 'src/main.py'],
    ['main.py', 'main.py'],
  ])('提取 %s → %s', (heading, expected) => {
    expect(extractPathFromHeading(heading)).toBe(expected);
  });

  it.each([
    ['实现思路'],
    ['Step 1: Setup'],
    ['host per line, comments ignored'],
  ])('非文件路径 %s → null', (heading) => {
    expect(extractPathFromHeading(heading)).toBeNull();
  });
});

describe('looksLikeFilePath / normalizePath', () => {
  it('looksLikeFilePath', () => {
    expect(looksLikeFilePath('src/main.py')).toBe(true);
    expect(looksLikeFilePath('main.py')).toBe(true);
    expect(looksLikeFilePath('/debug/db')).toBe(false); // 无扩展名
    expect(looksLikeFilePath('host per line, x / y')).toBe(false); // 含空格
    expect(looksLikeFilePath('Makefile')).toBe(true); // 已知无扩展名
    expect(looksLikeFilePath('实现思路')).toBe(false);
  });

  it('normalizePath', () => {
    expect(normalizePath('./src/main.py')).toBe('src/main.py');
    expect(normalizePath('src\\main.py')).toBe('src/main.py');
  });
});
