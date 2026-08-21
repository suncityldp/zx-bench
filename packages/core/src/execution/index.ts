// ============================================================
// 执行层（Phase 2）统一出口
// ============================================================
export {
  runInContainer,
  isDockerAvailable,
  getImageDigest,
  CONTAINER_IMAGES,
} from './containerRunner.js';
export type { ContainerRunOptions, ContainerRunResult, ContainerFile } from './containerRunner.js';
