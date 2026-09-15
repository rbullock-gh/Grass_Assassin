import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@grassassassin/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    // Integration tests share one database. Running files in parallel would let
    // them truncate each other's fixtures mid-test.
    fileParallelism: false,
    // And only one RUN at a time: two concurrent runs truncate each other's
    // fixtures and report it as a pile of authentication failures.
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ['./test/setup.ts'],
  },
})
