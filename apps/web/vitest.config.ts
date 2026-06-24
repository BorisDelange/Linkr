import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@default-plugins': path.resolve(__dirname, '../../packages/default-plugins'),
    },
  },
  test: {
    // Pure-logic unit tests only. Run in a Node environment — we deliberately
    // do not test volatile React components here (see docs/conventions.md).
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
  },
})
