import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@pm-go/runtime-detector': path.resolve(
        __dirname,
        '../../packages/runtime-detector/src/index.ts',
      ),
    },
  },
  test: {
    environment: 'node',
  },
})
