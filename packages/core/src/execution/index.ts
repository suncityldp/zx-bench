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
export { buildGoTestHarness, runGoTestsInContainer, runGoProgramInContainer } from './goRunner.js';
export { buildJavaHarness, runJavaTestsInContainer, stripMavenEntrypointNoise } from './javaRunner.js';
export { buildCHarness, runCTestsInContainer, runCppTestsInContainer, runCppTsanInContainer } from './cRunner.js';
export { buildRustHarness, runRustTestsInContainer, runRustMiriInContainer } from './rustRunner.js';
export { buildPhpHarness, runPhpTestsInContainer } from './phpRunner.js';
export type { PhpFixture, PhpRunResult } from './phpRunner.js';
export { buildCsharpHarness, runCsharpTestsInContainer } from './csharpRunner.js';
export { buildSqlHarness, runSqlInContainer } from './sqlRunner.js';
export { buildBashHarness, runBashTestsInContainer } from './bashRunner.js';
export type { BashFixture, BashRunResult } from './bashRunner.js';
export type { SqlFixture, SqlRunResult } from './sqlRunner.js';
export type { CsharpFixture, CsharpRunResult } from './csharpRunner.js';
export type { RustFixture, RustRunResult, RustMiriResult } from './rustRunner.js';
export type { CFixture, CRunResult, CTsanResult } from './cRunner.js';
export type { JavaFixture, JavaRunResult } from './javaRunner.js';
export type { GoFixture, GoRunResult } from './goRunner.js';
export { runTypeScriptTypeCheck } from './tsTypeCheck.js';
export type { TypeCheckCase, TypeCheckResult } from './tsTypeCheck.js';
