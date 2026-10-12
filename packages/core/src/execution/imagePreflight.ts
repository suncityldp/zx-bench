import { DOCKER_NOT_READY } from './dockerReadiness.js';
import { execAsync, type AsyncExecResult } from './execAsync.js';

export interface ScenarioImageContract { image: string; expectedImageId?: string }

/** Explicit task dependencies only; do not inspect candidate code or fixture contents. */
export function scenarioImageContracts(requirements: unknown): ScenarioImageContract[] {
  const req = (requirements ?? {}) as Record<string, any>;
  const rows: ScenarioImageContract[] = [];
  const add = (image: string, expectedImageId?: string) => {
    if (!rows.some(row => row.image === image && row.expectedImageId === expectedImageId)) rows.push({ image, expectedImageId });
  };
  if (req.executionCases?.length) add(req.executionImage ?? 'python:3.12-alpine', req.executionImageId);
  if (req.executionWorld) add(req.executionWorld.image ?? 'python:3.12-alpine', req.executionWorld.expectedImageId);
  if (req.executionShell) add(req.executionShell.image ?? 'python:3.12-alpine', req.executionShell.expectedImageId);
  if (req.agentLoop?.backend === 'docker') add('node:22-alpine', req.agentLoop.expectedImageId);
  if (req.image) add(req.image);
  return rows;
}

/** Recheck before each new candidate; never pull, retag, or accept a different frozen ID. */
export async function assertScenarioImagesReady(contracts: ScenarioImageContract[],
  inspect: (args: string[]) => Promise<AsyncExecResult> = args => execAsync('docker', args, { timeout: 15_000 })) {
  const cache = new Map<string, { Id?: string; Os?: string }>();
  for (const contract of contracts) {
    let image = cache.get(contract.image);
    if (!image) {
      const result = await inspect(['image', 'inspect', contract.image]);
      if (result.error || result.status !== 0) {
        throw new Error(`${DOCKER_NOT_READY}: Required image unavailable: ${contract.image}. Run pnpm runtime:prepare; 尚未请求模型生成答案。`);
      }
      try { image = JSON.parse(result.stdout)?.[0]; } catch { /* handled below */ }
      if (!image?.Id) throw new Error(`${DOCKER_NOT_READY}: Invalid image inspect response: ${contract.image}; 尚未请求模型生成答案。`);
      cache.set(contract.image, image);
    }
    if (image.Os && image.Os !== 'linux') {
      throw new Error(`${DOCKER_NOT_READY}: Linux image required: ${contract.image}; 尚未请求模型生成答案。`);
    }
    if (contract.expectedImageId && contract.expectedImageId !== image.Id) {
      throw new Error(`${DOCKER_NOT_READY}: Image ID mismatch: ${contract.image}; expected=${contract.expectedImageId}; actual=${image.Id}. `
        + 'Run pnpm runtime:prepare; check Docker image store mode. 尚未请求模型生成答案。');
    }
  }
}
