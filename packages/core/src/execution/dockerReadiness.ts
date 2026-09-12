/** Re-probe on every check; only concurrent checks are shared, never a stale success. */
export function createDockerReadiness(deps: {
  probe: () => Promise<boolean>;
  start: () => Promise<boolean>;
  now?: () => number;
  cooldownMs?: number;
}): () => Promise<boolean> {
  let pending: Promise<boolean> | undefined;
  let retryAfter = 0;
  const now = deps.now ?? Date.now;
  return () => {
    if (pending) return pending;
    pending = (async () => {
      if (await deps.probe()) { retryAfter = 0; return true; }
      if (now() < retryAfter) return false;
      const ready = await deps.start();
      retryAfter = ready ? 0 : now() + (deps.cooldownMs ?? 30_000);
      return ready;
    })().finally(() => { pending = undefined; });
    return pending;
  };
}

export const DOCKER_NOT_READY = 'DOCKER_NOT_READY';

export function dockerNotReadyError(): Error {
  return new Error(`${DOCKER_NOT_READY}: Docker 引擎未就绪；自动启动失败或等待超时。请检查 Docker Desktop 错误窗口，恢复后继续。尚未请求模型生成答案。`);
}

/** Match harness evidence only, never candidate output or arbitrary code errors. */
export function isDockerInfrastructureFailure(evidence: readonly string[]): boolean {
  return evidence.some(e => /DOCKER_NOT_READY:|ENVIRONMENT_ERROR:.*docker daemon (?:unavailable|unreachable)|Docker unavailable\s*[—-]\s*container execution skipped/i.test(e));
}
