import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import seedHashesPlugin from './vite-plugin-seed-hashes'
import path from 'path'
import { execSync } from 'child_process'

// Inject git commit hash at build time for version detection
const gitHash = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
  } catch {
    return 'dev'
  }
})()

export default defineConfig({
  plugins: [react(), tailwindcss(), seedHashesPlugin()],
  define: {
    __APP_BUILD_HASH__: JSON.stringify(gitHash),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@default-plugins': path.resolve(__dirname, '../../packages/default-plugins'),
    },
  },
  optimizeDeps: {
    exclude: ['pyodide'],
  },
  server: {
    port: 3000,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true,
      },
    },
  },
})
