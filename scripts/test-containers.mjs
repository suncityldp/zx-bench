import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const runner = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const r = spawnSync(process.execPath, [runner, 'run', 'packages/core/src/execution/crossLanguage.integration.test.ts', '--reporter=verbose', ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', env: { ...process.env, ZXBENCH_CONTAINER_TESTS: '1' },
});
if (r.error) console.error(r.error.message);
process.exitCode = r.status ?? 1;
