import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    // Matches the "@/*" path mapping in tsconfig.json, which vitest does not
    // read on its own.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
})
