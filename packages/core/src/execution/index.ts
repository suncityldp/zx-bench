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
export { buildRustHarness, runRustTestsInContainer } from './rustRunner.js';
export { buildPhpHarness, runPhpTestsInContainer } from './phpRunner.js';
export type { PhpFixture, PhpRunResult } from './phpRunner.js';
export { buildCsharpHarness, runCsharpTestsInContainer } from './csharpRunner.js';
export type { CsharpFixture, CsharpRunResult } from './csharpRunner.js';
export type { RustFixture, RustRunResult } from './rustRunner.js';
export type { CFixture, CRunResult } from './cRunner.js';
export type { JavaFixture, JavaRunResult } from './javaRunner.js';
export type { GoFixture, GoRunResult } from './goRunner.js';
