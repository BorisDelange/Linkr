import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@linkr/format': path.resolve(__dirname, '../linkr-format/src/index.ts'),
      '@': path.resolve(__dirname, '../../apps/web/src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
