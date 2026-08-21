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
export { buildGoTestHarness, runGoTestsInContainer } from './goRunner.js';
export { buildJavaHarness, runJavaTestsInContainer } from './javaRunner.js';
export { buildCHarness, runCTestsInContainer } from './cRunner.js';
export type { CFixture, CRunResult } from './cRunner.js';
export type { JavaFixture, JavaRunResult } from './javaRunner.js';
export type { GoFixture, GoRunResult } from './goRunner.js';
