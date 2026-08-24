// ============================================================
// CLI 沙箱执行器（参考实现，A1-1）
// 提供在「隔离临时目录」中真实执行模型给出的命令并校验端状态的 runner。
// 这是可选项：仅在编排层显式 registerCLISandboxRunner() 后才启用。
// 生产环境建议替换为基于 Docker（node:20-slim，30s 超时，文件系统 end-state 校验）
// 的强隔离实现；本文件给出可单测的最小可用版本。
// ============================================================

import { exec, type ExecException } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CLISandboxResult, CLISandboxRunner } from './cliCommand.js';

/** 读取临时目录内所有文件内容拼接，用于 end_state 在「产出文件」中的模式匹配 */
function readDirContents(dir: string): string {
  try {
    return readdirSync(dir)
      .map((f) => {
        try {
          return readFileSync(join(dir, f), 'utf8');
        } catch {
          return '';
        }
      })
      .join('\n');
  } catch {
    return '';
  }
}

export interface LocalCLISandboxRunnerOptions {
  /** 复用固定工作区（不传则每次 run 新建临时目录） */
  cwd?: string;
  /** 命令超时（ms），默认 30000 */
  timeoutMs?: number;
  /** 执行后是否清理临时目录，默认 true */
  cleanup?: boolean;
}

export class LocalCLISandboxRunner implements CLISandboxRunner {
  private cwd?: string;
  private timeoutMs: number;
  private cleanup: boolean;

  constructor(opts: LocalCLISandboxRunnerOptions = {}) {
    this.cwd = opts.cwd;
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.cleanup = opts.cleanup ?? true;
  }

  async run(opts: { command: string; workspace?: string; endStatePatterns?: string[] }): Promise<CLISandboxResult> {
    const workdir = this.cwd ?? mkdtempSync(join(tmpdir(), 'zxbench-cli-'));
    const base: CLISandboxResult = {
      ok: false,
      executed: false,
      stdout: '',
      stderr: '',
      exitCode: null,
      endStateMatched: 0,
      endStateTotal: opts.endStatePatterns?.length ?? 0,
    };

    return new Promise<CLISandboxResult>((resolve) => {
      const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
      exec(
        opts.command,
        { cwd: opts.workspace ?? workdir, timeout: this.timeoutMs, shell, encoding: 'utf8' },
        (err: ExecException | null, stdout: string, stderr: string) => {
          try {
            const exitCode = err && typeof err === 'object' && 'code' in err
              ? (err as NodeJS.ErrnoException & { code?: number }).code ?? 1
              : err
                ? 1
                : 0;
            const ok = !err;
            const endStateTotal = opts.endStatePatterns?.length ?? 0;
            let endStateMatched = 0;
            if (endStateTotal > 0) {
              const haystack = `${stdout}\n${readDirContents(workdir)}`;
              endStateMatched = opts.endStatePatterns!.filter((p) => haystack.includes(p)).length;
            }
            resolve({
              ok,
              executed: true,
              stdout,
              stderr: stderr ?? '',
              exitCode,
              endStateMatched,
              endStateTotal,
            });
          } finally {
            if (this.cleanup && !this.cwd) {
              try {
                rmSync(workdir, { recursive: true, force: true });
              } catch {
                /* ignore */
              }
            }
          }
        },
      );
    });
  }
}
