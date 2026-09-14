import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@grassassassin/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      '@grassassassin/design': fileURLToPath(new URL('../../packages/design/src/index.ts', import.meta.url)),
      '@grassassassin/client': fileURLToPath(new URL('../../packages/client/src/index.ts', import.meta.url)),
    },
  },
  test: { include: ['test/**/*.test.ts'] },
})
