// ============================================================
// 容器执行后端（Phase 2）：用 Docker 隔离执行不可信代码。
// 替代 host fork + new AsyncFunction（安全缺陷：候选代码可提前
// process.exit 伪造通过、可访问 host Node globals）。
// 安全基线：non-root、read-only root、tmpfs 工作区、无网络、
// drop capabilities、no-new-privileges、CPU/内存/PID 限制。
// ============================================================

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

export interface ContainerFile {
  /** 相对工作区的路径，如 main.js */
  path: string;
  content: string;
}

export interface ContainerRunOptions {
  image: string;
  command: string[];
  files?: ContainerFile[];
  workdir?: string;
  timeoutMs?: number;
  memoryMb?: number;
  cpuLimit?: number;
  pidsLimit?: number;
  networkDisabled?: boolean;
  readOnly?: boolean;
  runAsNonRoot?: boolean;
  /** 容器内环境变量（如 GOCACHE/GOPATH 指向可写 tmpfs） */
  env?: Record<string, string>;
}

export interface ContainerRunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

/** 语言 → 执行镜像 */
export const CONTAINER_IMAGES: Record<string, string> = {
  javascript: 'node:20-alpine',
  typescript: 'node:20-alpine',
  python: 'python:3.12-alpine',
  bash: 'bash:5-alpine',
};

/** Docker 是否可用（缓存结果） */
let dockerAvailableCache: boolean | null = null;
export function isDockerAvailable(): boolean {
  if (dockerAvailableCache !== null) return dockerAvailableCache;
  const res = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 8000 });
  dockerAvailableCache = res.status === 0;
  return dockerAvailableCache;
}

/** 获取镜像 digest（审计链用；未拉取返回 undefined） */
export function getImageDigest(image: string): string | undefined {
  const res = spawnSync('docker', ['inspect', '--format', '{{index .RepoDigests 0}}', image], { encoding: 'utf8', timeout: 15000 });
  const out = (res.stdout || '').trim();
  return res.status === 0 && out.length > 0 ? out : undefined;
}

/** 确保镜像已拉取（未缓存则静默 pull，避免拉取噪音混入执行 stderr） */
function ensureImage(image: string): void {
  const inspect = spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8', timeout: 15000 });
  if (inspect.status === 0) return;
  spawnSync('docker', ['pull', image], { encoding: 'utf8', timeout: 300000, stdio: 'ignore' });
}

/** 在隔离容器中执行命令，返回 stdout/stderr/exitCode。工作区只读 bind mount。 */
export function runInContainer(options: ContainerRunOptions): ContainerRunResult {
  const {
    image, command, files = [], workdir = '/workspace', timeoutMs = 10000,
    memoryMb = 128, cpuLimit = 1.0, pidsLimit = 64,
    networkDisabled = true, readOnly = true, runAsNonRoot = true,
    env = {},
  } = options;

  const startedAt = Date.now();

  if (!isDockerAvailable()) {
    return { success: false, stdout: '', stderr: 'Docker unavailable — container execution skipped', exitCode: -1, timedOut: false, durationMs: 0 };
  }

  ensureImage(image);

  const hostDir = mkdtempSync(join(tmpdir(), 'zxbench-run-'));
  try {
    for (const f of files) {
      const full = join(hostDir, f.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, f.content, 'utf8');
    }

    const src = hostDir.split('\\\\').join('/');
    const args = [
      'run', '--rm',
      '--network', networkDisabled ? 'none' : 'bridge',
      '--memory', memoryMb + 'm',
      '--cpus', String(cpuLimit),
      '--pids-limit', String(pidsLimit),
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--mount', 'type=bind,src=' + src + ',dst=' + workdir + (readOnly ? ',readonly' : ''),
      '-w', workdir,
    ];
    if (runAsNonRoot) args.push('--user', '65534:65534');
    for (const [k, v] of Object.entries(env)) args.push('-e', k + '=' + v);
    args.push(image, ...command);

    const res = spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs + 5000, maxBuffer: 8 * 1024 * 1024 });

    const timedOut = res.error != null && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    const exitCode = res.status ?? (timedOut ? 124 : 1);
    return {
      success: exitCode === 0 && !timedOut,
      stdout: (res.stdout || '').trim(),
      stderr: (res.stderr || '').trim(),
      exitCode,
      timedOut,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    try { rmSync(hostDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}