// ============================================================
// 工作区沙箱（CLI 实地调查题专用）
// 为 requiresSandbox 题目在临时目录中物化一个真实的工作区
// （文件树 + git 仓库），按题目配置执行探查步骤，生成
// 「真实输出」的探查转录注入 prompt。
// 模型基于真实转录进行推理（端口优先级 / 环境变量覆盖 /
// git 作者去重等），而非凭空猜测。
// ============================================================

import { execAsync } from '../execution/execAsync.js';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import type { RuntimeEvaluation } from '@zxbench/types';

// ===== 工作区规格 =====

export interface WorkspaceFileSpec {
  /** 相对工作区根的路径，如 data/archive/biggest.dat */
  path: string;
  /** 文本内容（与 sizeBytes 互斥，优先 content） */
  content?: string;
  /** 以稀疏文件方式创建指定字节大小的文件（用于 find/du 大小探查） */
  sizeBytes?: number;
}

export interface WorkspaceGitCommitSpec {
  authorName: string;
  authorEmail: string;
  committerName?: string;
  committerEmail?: string;
  message: string;
  /** 提交时间（ISO 或 'YYYY-MM-DD HH:mm:ss'，可选） */
  date?: string;
  /** 该提交时的文件快照 */
  files: WorkspaceFileSpec[];
}

export interface WorkspaceGitRepoSpec {
  /** 相对工作区根的路径，如 repo */
  path: string;
  commits: WorkspaceGitCommitSpec[];
}

export interface WorkspaceSpec {
  files?: WorkspaceFileSpec[];
  gitRepos?: WorkspaceGitRepoSpec[];
}

export type ExploreStep =
  | { type: 'ls_sizes'; path: string; head?: number }
  | { type: 'cat'; path: string }
  | { type: 'git_log_authors'; path: string }
  | { type: 'git_log_committers'; path: string };

export interface PreparedSandbox {
  /** 注入 prompt 的探查转录文本 */
  transcript: string;
  /** 写入结果的运行时评估摘要 */
  runtimeEvaluation: RuntimeEvaluation;
  /** 简短摘要（用于 evidence） */
  summary: string;
}

// ===== 物化 =====

async function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<string> {
  const res = await execAsync('git', args, {
    cwd,
        timeout: 30000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...env },
  });
  if (res.error) return '';
  return (res.stdout || '') + (res.stderr || '');
}

async function initGitRepo(repoPath: string, commits: WorkspaceGitCommitSpec[]): Promise<void> {
  mkdirSync(repoPath, { recursive: true });
  await runGit(['init', '-q', '-b', 'main'], repoPath);

  for (const c of commits) {
    for (const f of c.files) {
      const full = join(repoPath, f.path);
      mkdirSync(join(full, '..'), { recursive: true });
      if (f.content != null) writeFileSync(full, f.content, 'utf8');
      else if (f.sizeBytes != null) { writeFileSync(full, ''); truncateSync(full, f.sizeBytes); }
      else writeFileSync(full, '');
    }
    await runGit(['add', '-A'], repoPath);

    const commitEnv: NodeJS.ProcessEnv = {
      GIT_AUTHOR_NAME: c.authorName,
      GIT_AUTHOR_EMAIL: c.authorEmail,
      GIT_COMMITTER_NAME: c.committerName || c.authorName,
      GIT_COMMITTER_EMAIL: c.committerEmail || c.authorEmail,
    };
    if (c.date) {
      commitEnv.GIT_AUTHOR_DATE = c.date;
      commitEnv.GIT_COMMITTER_DATE = c.date;
    }
    // 无文件变更的提交也保留（--allow-empty），保证历史完整
    await runGit(['-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', c.message], repoPath, commitEnv);
  }
}

/**
 * 物化工作区到指定根目录（workspaceRoot 即 /workspace 的映射）
 */
export async function materializeWorkspace(
  spec: WorkspaceSpec,
  workspaceRoot: string,
): Promise<{ files: number; gitRepos: number }> {
  mkdirSync(workspaceRoot, { recursive: true });
  let files = 0;
  for (const f of spec.files || []) {
    const full = join(workspaceRoot, f.path);
    mkdirSync(join(full, '..'), { recursive: true });
    if (f.content != null) {
      writeFileSync(full, f.content, 'utf8');
    } else if (f.sizeBytes != null) {
      writeFileSync(full, '');
      truncateSync(full, f.sizeBytes); // 稀疏文件：stat.size 即逻辑大小
    } else {
      writeFileSync(full, '');
    }
    files++;
  }
  let gitRepos = 0;
  for (const repo of spec.gitRepos || []) {
    await initGitRepo(join(workspaceRoot, repo.path), repo.commits);
    gitRepos++;
  }
  return { files, gitRepos };
}

// ===== 探查 =====

interface WalkEntry { path: string; size: number }

function walkFiles(dir: string, base: string, acc: WalkEntry[]): WalkEntry[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, base, acc);
    } else if (entry.isFile()) {
      try {
        acc.push({ path: relative(base, full), size: statSync(full).size });
      } catch { /* ignore */ }
    }
  }
  return acc;
}

function toPosix(p: string): string {
  return p.split('\\').join('/');
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const res = await execAsync('git', args, { cwd, timeout: 30000 });
  if (res.error || res.status !== 0) return '';
  return (res.stdout || '').trim();
}

/**
 * 执行探查步骤，生成转录文本（输出全部来自真实物化的工作区）
 */
export async function exploreWorkspace(steps: ExploreStep[], workspaceRoot: string): Promise<string> {
  const lines: string[] = [];
  const ws = workspaceRoot;

  for (const step of steps) {
    switch (step.type) {
      case 'ls_sizes': {
        const head = step.head ?? 100;
        lines.push(`$ find /workspace/${step.path} -type f -printf '%s %p\\n' | sort -rn | head -${head}`);
        const entries = walkFiles(join(ws, step.path), ws, [])
          .sort((a, b) => b.size - a.size)
          .slice(0, head);
        if (entries.length === 0) {
          lines.push('(目录不存在或为空)');
        } else {
          for (const e of entries) {
            lines.push(`${e.size} /workspace/${toPosix(e.path)}`);
          }
        }
        lines.push('');
        break;
      }
      case 'cat': {
        const full = join(ws, step.path);
        lines.push(`$ cat /workspace/${step.path}`);
        if (!existsSync(full)) {
          lines.push('cat: 文件不存在');
        } else {
          const size = statSync(full).size;
          if (size > 256 * 1024) {
            lines.push(`(文件过大，共 ${size} 字节，内容省略)`);
          } else {
            lines.push(readFileSync(full, 'utf8').replace(/\s+$/, ''));
          }
        }
        lines.push('');
        break;
      }
      case 'git_log_authors': {
        const repoPath = join(ws, step.path);
        lines.push(`$ git -C /workspace/${step.path} log --format='%h %an <%ae>'`);
        const log = await gitOutput(repoPath, ['log', "--format=%h %an <%ae>"]);
        lines.push(log || '(空历史)');
        lines.push('');
        lines.push(`$ git -C /workspace/${step.path} log --format='%ae' | sort -u`);
        const emails = await gitOutput(repoPath, ['log', "--format=%ae"]);
        if (emails) {
          const unique = [...new Set(emails.split('\n').filter((l) => l.trim()))].sort();
          lines.push(unique.join('\n'));
        } else {
          lines.push('(空历史)');
        }
        lines.push('');
        break;
      }
      case 'git_log_committers': {
        const repoPath = join(ws, step.path);
        lines.push(`$ git -C /workspace/${step.path} log --format='%h %cn <%ce>'`);
        const log = await gitOutput(repoPath, ['log', "--format=%h %cn <%ce>"]);
        lines.push(log || '(空历史)');
        lines.push('');
        break;
      }
    }
  }

  return lines.join('\n').replace(/\s+$/, '');
}

// ===== 一站式准备 =====

const TRANSCRIPT_HEADER = `=== 沙箱工作区探查记录（真实执行） ===
以下内容由评测系统在受控工作区中对题述目录/仓库实地探查生成：
文件大小、配置文件内容、git 历史等均为真实数据，不是模型编造的示例。
请基于这些记录推理并回答题述问题；记录中不存在的文件或数据请勿自行编造。
`;

/**
 * 为 requiresSandbox 题目准备沙箱探查：
 * 物化工作区 → 执行探查 → 生成转录（工作区临时目录随后清理，仅保留转录）
 */
export async function prepareSandboxEvaluation(
  scenarioId: string,
  requirements: Record<string, unknown>,
): Promise<PreparedSandbox> {
  const spec = (requirements.workspace ?? {}) as WorkspaceSpec;
  const steps = (requirements.explore ?? []) as ExploreStep[];

  const base = mkdtempSync(join(tmpdir(), 'zxbench-ws-'));
  const workspaceRoot = join(base, 'workspace');
  try {
    const { files, gitRepos } = await materializeWorkspace(spec, workspaceRoot);
    const body = await exploreWorkspace(steps, workspaceRoot);
    const transcript = TRANSCRIPT_HEADER + '\n' + body;

    const runtimeEvaluation: RuntimeEvaluation = {
      compilePassed: true,
      testsPassed: 0,
      testsFailed: 0,
      testsTotal: 0,
      hiddenTestsPassed: 0,
      hiddenTestsFailed: 0,
      hiddenTestsTotal: 0,
      details: [],
      sandbox: {
        workspaceFiles: files,
        gitRepos,
        exploreSteps: steps.length,
        transcriptChars: transcript.length,
      },
    };

    return {
      transcript,
      runtimeEvaluation,
      summary: `SANDBOX_EXECUTED: ${scenarioId} — workspaceFiles=${files}, gitRepos=${gitRepos}, exploreSteps=${steps.length}`,
    };
  } finally {
    try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
