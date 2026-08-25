import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@linkr/format/node/fs-tree': path.resolve(__dirname, '../linkr-format/src/node/fs-tree.ts'),
      '@linkr/format': path.resolve(__dirname, '../linkr-format/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
