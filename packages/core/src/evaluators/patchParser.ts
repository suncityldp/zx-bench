// ============================================================
// 多文件 patch 解析器（纯函数，零运行时依赖）
// 从模型输出提取「文件路径 → 完整内容」映射，供 project_repair 等
// 评分器物化工作区使用。独立成文件便于单元测试与隔离 dockerode 依赖链。
// ============================================================

/** 规范化路径：统一斜杠方向、去掉前导 ./，便于跨写法匹配 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

/** 判断字符串是否像源文件路径。
 *  规则：basename 含点（有扩展名）→ 是；或显式用了 `file:` 标签 → 信任；
 *  或属于已知无扩展名文件名（Makefile 等）。含空格的描述性文本一律拒收。 */
export function looksLikeFilePath(s: string, opts?: { hadFileLabel?: boolean }): boolean {
  if (!s) return false;
  if (/\s/.test(s) && !opts?.hadFileLabel) return false; // 描述性文本含空格
  if (/\.\w{1,12}$/.test(s)) return true;  // basename 以 .扩展名 结尾
  if (opts?.hadFileLabel) return true;    // 显式 file: 标签，信任
  // 已知无扩展名文件名
  if (/^(?:Makefile|Dockerfile|\.gitignore|\.dockerignore|LICENSE|README|Rakefile|Gemfile)$/i.test(s)) return true;
  return false;
}

/** 从标题行文本提取文件路径，兼容模型多种自然写法：
 *  - `### file: src/main.py`          （规范格式）
 *  - `### \`src/main.py\``             （反引号包路径）
 *  - `### 1. \`src/main.py\` —— 说明` （编号 + 反引号 + 描述）
 *  - `#### \`CMakeLists.txt\``         （任意标题层级）
 *  - `### main.py`                     （裸路径）
 *  返回 null 表示该标题不是文件块标记（如普通章节标题、含空格的描述）。 */
export function extractPathFromHeading(heading: string): string | null {
  let h = heading.trim();
  const hadFileLabel = /^(?:file|File|文件)\s*:\s*/i.test(h);
  // 去掉前导列表序号：1. / 2) / (1) 等
  h = h.replace(/^\(?\d+[\.\)]\s*/, '');
  // 去掉前导 'file:' / 'File' / '文件:' 标签（规范格式，大小写不敏感）
  h = h.replace(/^(?:file|File|文件)\s*:\s*/i, '').trim();
  // 优先取反引号包裹的路径（最可靠，覆盖带尾部描述的情况）
  const bt = h.match(/`([^`]+)`/);
  let path: string;
  if (bt) {
    path = bt[1].trim();
  } else {
    // 无反引号：截掉尾部描述（—— / -- / — / ： / : 之后的内容）
    path = h.split(/\s*(?:——|—+|--|：|:)\s*/)[0].trim();
    // 去掉包裹的引号/星号
    path = path.replace(/^["'*]+|["'*]+$/g, '').trim();
  }
  if (!path) return null;
  if (!looksLikeFilePath(path, { hadFileLabel })) return null;
  return path;
}

/** 从模型输出解析多文件替换 → {path: content}。
 *  按标题行（^#{1,6} ...）切块，每块取自身 body 内首个代码块作为该文件内容。
 *  围栏感知：代码块（``` ... ```）内的 `#` 行不当作标题（避免把 shell 注释
 *  `# host per line...` 误判为文件块）。避免跨标题误赋值。 */
export function parseFileBlocks(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!output) return result;
  const lines = output.split('\n');
  const chunks: { heading: string; body: string }[] = [];
  let cur: { heading: string; body: string } | null = null;
  let inFence = false;
  for (const line of lines) {
    // 代码围栏开关（```开头，忽略缩进/语言标记）
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      if (cur) cur.body += (cur.body ? '\n' : '') + line;
      continue;
    }
    // 仅在围栏外识别 markdown 标题
    if (!inFence) {
      const hm = /^(#{1,6})\s+(.+)$/.exec(line);
      if (hm) {
        if (cur) chunks.push(cur);
        cur = { heading: hm[2], body: '' };
        continue;
      }
    }
    if (cur) cur.body += (cur.body ? '\n' : '') + line;
  }
  if (cur) chunks.push(cur);

  for (const ch of chunks) {
    const path = extractPathFromHeading(ch.heading);
    if (!path) continue;
    if (path in result) continue;  // 同一路径只取首次
    // 仅在本块 body 内找代码块，防止跨标题串接
    const fm = ch.body.match(/```[\w+-]*\s*\n([\s\S]*?)```/);
    if (fm) {
      result[path] = fm[1].replace(/\n$/, '');
    }
  }

  // 次级提取：代码块首行为 `# <path.ext>` 注释的（Python/Shell 约定），
  // 整行仅文件名、无其他文字时，按该文件归属。已由标题提取的路径跳过。
  const blockRe = /```[\w+-]*\s*\n([\s\S]*?)```/g;
  let bm: RegExpExecArray | null;
  while ((bm = blockRe.exec(output)) !== null) {
    const content = bm[1];
    const arr = content.split('\n');
    const firstNonEmpty = arr.find((l) => l.trim()) || '';
    // 整行形如 `# scheduler.py`（无 shebang、无附加描述）
    const cm = /^\s*#\s+([\w./\-]+\.\w{1,12})\s*$/.exec(firstNonEmpty);
    if (!cm) continue;
    const fpath = cm[1];
    if (fpath in result) continue;
    if (!looksLikeFilePath(fpath)) continue;
    const idx = arr.indexOf(firstNonEmpty);
    const body = arr.slice(idx + 1).join('\n').replace(/^\n+/, '');
    result[fpath] = body.replace(/\n$/, '');
  }

  return result;
}
