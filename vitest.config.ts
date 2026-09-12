import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: {
    '@zxbench/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    '@zxbench/utils': fileURLToPath(new URL('./packages/utils/src/index.ts', import.meta.url)),
  } },
  test: {
    include: ['packages/**/*.test.ts', 'apps/server/src/**/*.test.ts'],
    environment: 'node',
  },
});
