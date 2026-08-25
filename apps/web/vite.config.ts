import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import seedHashesPlugin from './vite-plugin-seed-hashes'
import path from 'path'
import { execSync } from 'child_process'
import { readFileSync } from 'fs'

// Inject git commit hash at build time for version detection
const gitHash = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
  } catch {
    return 'dev'
  }
})()

// The export-format app version — single source of truth is the repo-root
// VERSION file, read here so the frontend and the backend (apps/api/app/
// export_version.py reads the same file) stamp exports with the SAME string. A
// drift would fabricate false git diffs between a front-only and a server export.
const appVersion = (() => {
  try {
    return readFileSync(path.resolve(__dirname, '../../VERSION'), 'utf-8').trim()
  } catch {
    return '0.0.0'
  }
})()

// In server mode the COI service worker is useless (no WASM/webR to enable
// SharedArrayBuffer for) and actively harmful: it intercepts API calls and,
// on its error path, retries a fetch whose body was already consumed —
// breaking uploads (chunk POSTs). Strip its <script> from index.html at build
// time when VITE_API_URL is set.
// Also stripped in dev: the dev server already sends real COOP/COEP headers
// (see server.headers below), and the SW's install-time page reload + module
// interception floods the console with "failed to load module" noise whenever
// the dev server restarts.
function stripCoiInServerMode() {
  const serverMode = !!process.env.VITE_API_URL
  return {
    name: 'strip-coi-in-server-mode',
    transformIndexHtml(html: string, ctx: { server?: unknown }) {
      if (!serverMode && !ctx.server) return html
      // The src may carry the BASE_PATH prefix (Vite rewrites public URLs
      // before/around this hook), so match any path ending in the filename.
      return html
        .replace(/<script>window\.coi[\s\S]*?<\/script>\s*/, '')
        .replace(/<script src="[^"]*coi-serviceworker\.js"><\/script>\s*/, '')
    },
  }
}

// Sub-path deployments (e.g. reverse proxy exposing the app under
// /docker-9250/): BASE_PATH prefixes all asset URLs and, via Vite's BASE_URL,
// the router basename in main.tsx. Normalized to /…/ as Vite requires.
const basePath = (() => {
  const raw = (process.env.BASE_PATH || '/').trim()
  if (raw === '' || raw === '/') return '/'
  return `/${raw.replace(/^\/+|\/+$/g, '')}/`
})()

export default defineConfig({
  base: basePath,
  plugins: [react(), tailwindcss(), seedHashesPlugin(), stripCoiInServerMode()],
  define: {
    __APP_BUILD_HASH__: JSON.stringify(gitHash),
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@default-plugins': path.resolve(__dirname, '../../packages/default-plugins'),
      '@linkr/format': path.resolve(__dirname, '../../packages/linkr-format/src/index.ts'),
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
