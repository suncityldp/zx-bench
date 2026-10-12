import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { execAsync } from './execAsync.js';

export interface SessionFile { path: string; content: string; executable?: boolean }
export interface SessionOptions {
  /** Must already exist locally. Callers preflight pinned images before model inference. */
  image: string;
  /** Optional pinned Docker image ID; prevents a moved local tag from changing a run. */
  expectedImageId?: string;
  files?: SessionFile[];
  memoryMb?: number;
  cpuLimit?: number;
  pidsLimit?: number;
  workspaceMb?: number;
  network?: 'none';
  timeoutMs?: number;
  maxOutputBytes?: number;
}
export interface SessionCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  durationMs: number;
}

function safeWorkspacePath(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes('\\') || path.includes(':') || path.split('/').includes('..')) {
    throw new Error(`Invalid workspace path: ${path}`);
  }
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Invalid workspace path: ${path}`);
  return full;
}

/** A persistent, one-scenario Docker workspace. Each command sees earlier changes. */
export class DockerSession {
  private closed = false;
  private readonly startedAt = Date.now();
  imageId = '';

  private constructor(
    readonly containerName: string,
    private readonly workspaceRoot: string,
    private readonly options: SessionOptions,
  ) {}

  static async create(options: SessionOptions): Promise<DockerSession> {
    if (!options.image || !/^[\w./:@-]+$/.test(options.image)) throw new Error('Invalid image');
    if (options.workspaceMb !== undefined && (!Number.isInteger(options.workspaceMb)
      || options.workspaceMb < 8 || options.workspaceMb > 1024)) throw new Error('Invalid workspace size');
    const root = mkdtempSync(join(tmpdir(), 'zxbench-session-'));
    const name = `zxbench-session-${randomUUID()}`;
    const session = new DockerSession(name, root, options);
    try {
      chmodSync(root, 0o777);
      for (const file of options.files ?? []) {
        const target = safeWorkspacePath(root, file.path);
        const dirs: string[] = [];
        for (let dir = dirname(target); dir !== root; dir = dirname(dir)) dirs.push(dir);
        for (const dir of dirs.reverse()) { mkdirSync(dir, { recursive: true }); chmodSync(dir, 0o777); }
        writeFileSync(target, file.content, 'utf8');
        chmodSync(target, file.executable ? 0o755 : 0o666);
      }
      const inspect = await execAsync('docker', ['image', 'inspect', options.image], { timeout: 15_000 });
      if (inspect.status !== 0) throw new Error(`Required local image unavailable: ${options.image}`);
      const imageId = (JSON.parse(inspect.stdout) as Array<{ Id?: string }>)[0]?.Id;
      if (!imageId) throw new Error(`Docker image inspect returned no ID: ${options.image}`);
      if (options.expectedImageId && options.expectedImageId !== imageId) {
        throw new Error(`Docker image ID drift: ${options.image}; expected=${options.expectedImageId}; actual=${imageId}. `
          + 'Run pnpm runtime:prepare; check Docker image store mode.');
      }
      session.imageId = imageId;
      const mount = `type=bind,src=${root.replaceAll('\\', '/')},dst=/seed,readonly`;
      const run = await execAsync('docker', [
        'run', '-d', '--name', name, '--network', 'none',
        '--memory', `${options.memoryMb ?? 256}m`, '--cpus', String(options.cpuLimit ?? 1),
        '--pids-limit', String(options.pidsLimit ?? 64), '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--read-only',
        '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=32m',
        '--tmpfs', `/workspace:rw,exec,nosuid,nodev,size=${options.workspaceMb ?? 64}m,mode=1777`,
        '--user', '65534:65534', '--mount', mount, '-w', '/workspace',
        // /workspace tmpfs is owned by root. Scope Git trust to this isolated workspace.
        '-e', 'GIT_CONFIG_COUNT=1', '-e', 'GIT_CONFIG_KEY_0=safe.directory', '-e', 'GIT_CONFIG_VALUE_0=/workspace',
        '--entrypoint', 'sh', imageId, '-lc', 'cp -R /seed/. /workspace/ && sleep 3600',
      ], { timeout: 30_000 });
      if (run.status !== 0) throw new Error(`Docker session start failed: ${run.stderr.slice(0, 500)}`);
      for (const file of options.files ?? []) {
        if (!file.executable) continue;
        safeWorkspacePath(root, file.path);
        const chmod = await execAsync('docker', ['exec', name, 'chmod', '755', `/workspace/${file.path}`], { timeout: 15_000 });
        if (chmod.status !== 0) throw new Error(`Docker session executable setup failed: ${file.path}`);
      }
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  async exec(command: string): Promise<SessionCommandResult> {
    if (this.closed) throw new Error('Docker session is closed');
    const remaining = (this.options.timeoutMs ?? 120_000) - (Date.now() - this.startedAt);
    if (remaining <= 0) { await this.close(); throw new Error('Docker session time budget exhausted'); }
    const started = Date.now();
    const result = await execAsync('docker', ['exec', this.containerName, 'sh', '-lc', command], {
      timeout: Math.min(remaining, 30_000), maxBuffer: this.options.maxOutputBytes ?? 1_048_576,
    });
    const timedOut = result.error?.code === 'ETIMEDOUT';
    const outputLimitExceeded = result.error?.code === 'ENOBUFS';
    if (timedOut || outputLimitExceeded) await this.close();
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status,
      timedOut, outputLimitExceeded, durationMs: Date.now() - started };
  }

  /** Execute a submitted shell script with its declared interpreter, never on the host. */
  async execScript(script: string, policy: 'sh' | 'shebang' = 'shebang'): Promise<SessionCommandResult> {
    const first = script.split(/\r?\n/, 1)[0];
    const match = first.match(/^#!\s*(?:\/usr\/bin\/env\s+)?(?:\/usr\/bin\/|\/bin\/)?(bash|sh)(?:\s|$)/);
    const interpreter = policy === 'sh' ? 'sh' : match?.[1] ?? 'sh';
    if (policy === 'shebang' && first.startsWith('#!') && !match) return { stdout: '', stderr: 'Unsupported shell interpreter',
      exitCode: 126, timedOut: false, outputLimitExceeded: false, durationMs: 0 };
    const payload = Buffer.from(script, 'utf8').toString('base64');
    const path = `/tmp/zxbench-candidate-${randomUUID()}.sh`;
    return this.exec(`printf '%s' '${payload}' | base64 -d > '${path}' && ${interpreter} '${path}'`);
  }

  /** Reads a bounded output from the container tmpfs after checking symlink resolution. */
  readArtifact(path: string): string {
    if (this.closed) throw new Error('Docker session is closed');
    safeWorkspacePath(this.workspaceRoot, path);
    const containerPath = `/workspace/${path}`;
    const resolved = spawnSync('docker', ['exec', this.containerName, 'readlink', '-f', containerPath],
      { timeout: 15_000, windowsHide: true, encoding: 'utf8', maxBuffer: 4096 });
    if (resolved.status !== 0 || !resolved.stdout.trim().startsWith('/workspace/')) {
      throw new Error(`Artifact unavailable or escapes workspace: ${path}`);
    }
    const output = spawnSync('docker', ['exec', this.containerName, 'cat', resolved.stdout.trim()],
      { timeout: 15_000, windowsHide: true, encoding: 'utf8',
        maxBuffer: this.options.maxOutputBytes ?? 1_048_576 });
    if (output.error || output.status !== 0) throw new Error(`Artifact unavailable or too large: ${path}`);
    return output.stdout;
  }

  /** Reports whether a workspace path exists, including a dangling symlink. */
  matchesArtifacts(files: SessionFile[]): boolean[] {
    if (this.closed) throw new Error('Docker session is closed');
    if (!files.length) return [];
    for (const file of files) safeWorkspacePath(this.workspaceRoot, file.path);
    // One process for all hashes; path arguments never become shell source. No
    // filenames in stdout, so embedded newlines cannot corrupt result framing.
    const result = spawnSync('docker', ['exec', this.containerName, 'sh', '-c',
      'for p do r=$(readlink -f "$p") || { echo MISSING; continue; }; case "$r" in /workspace/*) if [ -f "$r" ]; then sha256sum < "$r"; else echo MISSING; fi;; *) echo MISSING;; esac; done',
      'sh', ...files.map(file => `/workspace/${file.path}`)],
    { timeout: 15_000, windowsHide: true, encoding: 'utf8', maxBuffer: 1_048_576 });
    if (result.error || result.status !== 0) throw new Error('Artifact fingerprint collection failed');
    const hashes = result.stdout.trimEnd().split('\n').map(line => line.trim().split(/\s+/)[0]);
    if (hashes.length !== files.length) throw new Error('Incomplete artifact fingerprints');
    return files.map((file, index) => hashes[index] === createHash('sha256').update(file.content, 'utf8').digest('hex'));
  }

  /** Reports whether a workspace path exists, including a dangling symlink. */
  artifactExists(path: string): boolean {
    if (this.closed) throw new Error('Docker session is closed');
    safeWorkspacePath(this.workspaceRoot, path);
    const result = spawnSync('docker', ['exec', this.containerName, 'sh', '-c',
      'test -e "$1" || test -L "$1"', 'sh', `/workspace/${path}`],
    { timeout: 15_000, windowsHide: true, encoding: 'utf8', maxBuffer: 4096 });
    if (result.error || (result.status !== 0 && result.status !== 1)) {
      throw new Error(`Artifact existence check failed: ${path}`);
    }
    return result.status === 0;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await execAsync('docker', ['rm', '-f', this.containerName], { timeout: 15_000 }).catch(() => {});
    const root = resolve(this.workspaceRoot);
    const temp = resolve(tmpdir());
    if (dirname(root) !== temp || !root.split(/[\\/]/).at(-1)?.startsWith('zxbench-session-')) {
      throw new Error('Refusing to remove a workspace outside the session temp directory');
    }
    rmSync(root, { recursive: true, force: true });
  }
}
