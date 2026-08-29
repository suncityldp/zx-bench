// ============================================================
// 容器执行后端（Phase 2）：用 Docker 隔离执行不可信代码。
// 替代 host fork + new AsyncFunction（安全缺陷：候选代码可提前
// process.exit 伪造通过、可访问 host Node globals）。
// 安全基线：non-root、read-only root、tmpfs 工作区、无网络、
// drop capabilities、no-new-privileges、CPU/内存/PID 限制。
// ============================================================

import { execAsync } from './execAsync.js';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { rm as rmAsync } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * 异步清理工作区目录（带重试与超时放弃）。
 *
 * ⚠️ 根因修复（2026-08-30 诊断 run 插桩实锤）：原先在 finally 里同步 rmSync
 * 删除 docker 刚 bind-mount 过的临时目录。容器 --rm 退出瞬间，Docker daemon /
 * WSL2 还残留文件句柄时，rmSync 会在内核调用里永久卡住（不抛异常，catch 拦不住），
 * 把 Node 主线程同步钉死 —— 整个 server 静默冻结、HTTP 全无响应。
 * 这解释了 v3 全部四次冻结：只在 PR 评估（每题多个容器）时发生，与 n_ctx、
 * parallelism、单/双 run 均无关；P4 当时跑通只是竞态没撞上。
 * 因此：绝不在主线程同步等待这类目录删除，改异步 + 重试 + 到点放弃。
 */
let sweepWarned = 0;
async function cleanupHostDir(hostDir: string): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await rmAsync(hostDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
  // 重试仍失败：留下让启动清扫处理，绝不死等。
  if (sweepWarned < 20) {
    sweepWarned++;
    console.warn(`[CT] cleanup abandoned (will be swept on startup): ${hostDir}`);
  }
}

/** 启动时清扫遗留的 zxbench-run-* 临时目录（异步、不阻塞）。 */
export function sweepStaleRunDirs(): void {
  void (async () => {
    try {
      const { readdir } = await import('node:fs/promises');
      const tmp = tmpdir();
      const entries = await readdir(tmp);
      let n = 0;
      for (const e of entries) {
        if (e.startsWith('zxbench-run-')) {
          await cleanupHostDir(join(tmp, e));
          n++;
        }
      }
      if (n > 0) console.log(`[CT] startup sweep: cleaned ${n} stale run dirs`);
    } catch { /* ignore */ }
  })();
}

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
  /** 覆盖 --user（如 'postgres'），优先级高于 runAsNonRoot */
  user?: string;
  /** TSan 需要关闭 ASLR（setarch -R），需 seccomp=unconfined 允许 personality() */
  seccompUnconfined?: boolean;
  /** 容器内环境变量（如 GOCACHE/GOPATH 指向可写 tmpfs） */
  env?: Record<string, string>;
  /** 额外 bind mount（host 路径 → 容器路径），用于挂载依赖 jar 等 */
  mounts?: { src: string; dst: string; readonly?: boolean }[];
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
export async function isDockerAvailable(): Promise<boolean> {
  if (dockerAvailableCache !== null) return dockerAvailableCache;
  const res = await execAsync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 8000 });
  dockerAvailableCache = res.status === 0;
  return dockerAvailableCache;
}

/** 获取镜像 digest（审计链用；未拉取返回 undefined） */
export async function getImageDigest(image: string): Promise<string | undefined> {
  const res = await execAsync('docker', ['inspect', '--format', '{{index .RepoDigests 0}}', image], { timeout: 15000 });
  const out = (res.stdout || '').trim();
  return res.status === 0 && out.length > 0 ? out : undefined;
}

/** 确保镜像已拉取（未缓存则静默 pull，避免拉取噪音混入执行 stderr） */
async function ensureImage(image: string): Promise<void> {
  const inspect = await execAsync('docker', ['image', 'inspect', image], { timeout: 15000 });
  if (inspect.status === 0) return;
  await execAsync('docker', ['pull', image], { timeout: 300000, stdio: 'ignore' });
}

/** 在隔离容器中执行命令，返回 stdout/stderr/exitCode。工作区只读 bind mount。 */
export async function runInContainer(options: ContainerRunOptions): Promise<ContainerRunResult> {
  const {
    image, command, files = [], workdir = '/workspace', timeoutMs = 10000,
    memoryMb = 128, cpuLimit = 1.0, pidsLimit = 64,
    networkDisabled = true, readOnly = true, runAsNonRoot = true, user,
    seccompUnconfined = false, env = {}, mounts = [],
  } = options;

  const startedAt = Date.now();

  const T = !!process.env.ZXB_PR_TRACE;
  if (T) console.log('[CT] 进入 runInContainer image=' + image + ' files=' + files.length + ' timeoutMs=' + timeoutMs);
  if (!(await isDockerAvailable())) {
    if (T) console.log('[CT] Docker 不可用，短路返回');
    return { success: false, stdout: '', stderr: 'Docker unavailable — container execution skipped', exitCode: -1, timedOut: false, durationMs: 0 };
  }

  if (T) console.log('[CT] ensureImage 开始');
  await ensureImage(image);
  if (T) console.log('[CT] ensureImage 完成');

  if (T) console.log('[CT] 物化临时目录开始');
  const hostDir = mkdtempSync(join(tmpdir(), 'zxbench-run-'));
  if (T) console.log('[CT] 临时目录=' + hostDir);
  try {
    for (const f of files) {
      const full = join(hostDir, f.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, f.content, 'utf8');
      if (f.content.startsWith('#!')) {
        chmodSync(full, 0o755);
      }
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
      ...(seccompUnconfined ? ['--security-opt', 'seccomp=unconfined'] : []),
      '--mount', 'type=bind,src=' + src + ',dst=' + workdir + (readOnly ? ',readonly' : ''),
      '-w', workdir,
    ];
    if (user) args.push('--user', user);
    else if (runAsNonRoot) args.push('--user', '65534:65534');
    for (const [k, v] of Object.entries(env)) args.push('-e', k + '=' + v);
    for (const m of mounts) {
      args.push('--mount', 'type=bind,src=' + m.src.split('\\').join('/') + ',dst=' + m.dst + (m.readonly === false ? '' : ',readonly'));
    }
    args.push(image, ...command);
    if (T) console.log('[CT] docker run 开始: ' + args.join(' ').slice(0, 220));

    const res = await execAsync('docker', args, { timeout: timeoutMs + 5000, maxBuffer: 8 * 1024 * 1024 });
    if (T) console.log('[CT] docker run 返回 status=' + res.status + ' err=' + (res.error && res.error.code));

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
    // 关键：异步、不 await 完成（不阻塞返回值路径）。旧实现用同步 rmSync 删
    // docker 刚卸载的目录，会与 Docker/WSL2 句柄释放竞态，把主线程钉死（v3 四次冻结根因）。
    if (T) console.log('[CT] finally 发起异步清理 ' + hostDir);
    void cleanupHostDir(hostDir).catch(() => { /* 启动清扫兜底 */ });
  }
}