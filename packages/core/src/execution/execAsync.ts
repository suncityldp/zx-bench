import { spawn } from 'node:child_process';

export interface AsyncExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
}

export interface AsyncExecOptions {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  stdio?: 'pipe' | 'ignore';
  env?: NodeJS.ProcessEnv;
}

/** 异步版 spawnSync：不阻塞事件循环，返回与 spawnSync 一致的结果形状。 */
export function execAsync(command: string, args: string[], options: AsyncExecOptions = {}): Promise<AsyncExecResult> {
  return new Promise((resolve) => {
    const { cwd, timeout, maxBuffer = 8 * 1024 * 1024, stdio = 'pipe', env } = options;
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: stdio === 'ignore' ? 'ignore' : ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (status: number | null, error?: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ status, stdout, stderr, error });
    };

    const timer = timeout != null
      ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout)
      : null;

    if (stdio !== 'ignore') {
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString('utf8');
        if (stdout.length > maxBuffer) child.kill('SIGKILL');
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
        if (stderr.length > maxBuffer) child.kill('SIGKILL');
      });
    }

    child.on('error', (err) => finish(null, err as NodeJS.ErrnoException));
    child.on('close', (code) => {
      if (timedOut) {
        const e = new Error('ETIMEDOUT') as NodeJS.ErrnoException;
        e.code = 'ETIMEDOUT';
        finish(code, e);
      } else {
        finish(code);
      }
    });
  });
}
