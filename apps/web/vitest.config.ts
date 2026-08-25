import { defineConfig } from 'vitest/config'
import path from 'path'
import { readFileSync } from 'fs'

// Same export-format version the app build injects (vite.config.ts) — read from
// the repo-root VERSION file so tests that touch APP_VERSION (e.g. the project
// export golden) run against the real value.
const appVersion = (() => {
  try {
    return readFileSync(path.resolve(__dirname, '../../VERSION'), 'utf-8').trim()
  } catch {
    return '0.0.0'
  }
})()

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __APP_BUILD_HASH__: JSON.stringify('test'),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@default-plugins': path.resolve(__dirname, '../../packages/default-plugins'),
      '@linkr/format': path.resolve(__dirname, '../../packages/linkr-format/src/index.ts'),
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
