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

// In server mode the COI service worker is useless (no WASM/webR to enable
// SharedArrayBuffer for) and actively harmful: it intercepts API calls and,
// on its error path, retries a fetch whose body was already consumed —
// breaking uploads (chunk POSTs). Strip its <script> from index.html at build
// time when VITE_API_URL is set.
function stripCoiInServerMode() {
  const serverMode = !!process.env.VITE_API_URL
  return {
    name: 'strip-coi-in-server-mode',
    transformIndexHtml(html: string) {
      if (!serverMode) return html
      return html
        .replace(/<script>window\.coi[\s\S]*?<\/script>\s*/, '')
        .replace(/<script src="\/coi-serviceworker\.js"><\/script>\s*/, '')
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), seedHashesPlugin(), stripCoiInServerMode()],
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
