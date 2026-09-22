import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import seedHashesPlugin from './vite-plugin-seed-hashes'
import path from 'path'
import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { gzipSync } from 'zlib'

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
function stripCoiInServerMode(serverMode: boolean) {
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

/**
 * Publish what a boot actually downloads, as `boot-size.json`.
 *
 * The boot splash reports how much of the app has arrived and had no total to put
 * it against: the boot discovers its chunks as each importer parses, so nothing
 * knows the sum up front — least of all on the first visit, which is the one that
 * waits. The bundle is fully known here, so the denominator ships with the build
 * instead of being guessed from a previous run.
 *
 * Two things this has to match, or the bar is worse than no bar at all:
 *
 * - **Only what boots.** The entry chunk and its *static* imports, plus the CSS
 *   and fonts the page pulls. The lazy route chunks are most of the bundle and
 *   none of them load before the app renders, so counting them put the bar at 7%
 *   when the download was in fact complete.
 * - **Compressed bytes.** The splash measures `transferSize`, which is what came
 *   over the wire; a host serving this build gzips it. Summing the raw source
 *   compared ~1.2 MB received against a ~17 MB total.
 *
 * Dev emits no bundle (modules are served one by one, unminified) and so no file;
 * the splash falls back to what the browser measured last time, and shows the
 * count alone until then.
 */
function injectBootBytes(): Plugin {
  return {
    name: 'inject-boot-bytes',
    // Published as its own asset rather than substituted into the page: Vite
    // writes index.html after `closeBundle`, the last Rollup hook, so no hook can
    // put a figure in the markup and a deferred write races the process exit.
    generateBundle(_options, bundle) {
      const sizeOf = (name: string): number => {
        const file = bundle[name]
        if (!file) return 0
        const content = file.type === 'chunk' ? file.code : file.source
        const buf = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content ?? '')
        // gzip, because that is what a static host negotiates and therefore what
        // the splash's `transferSize` will report. Level 6 is zlib's default and
        // close enough to what a server does at rest.
        return gzipSync(buf, { level: 6 }).byteLength
      }

      // The boot graph: the entry and everything it imports *statically*
      // (Rollup's `imports`, not `dynamicImports` — those are the lazy routes),
      // plus the CSS those chunks bring in.
      //
      // Only code and styles: `importedAssets` also carries every image reachable
      // from the graph — the doc screenshots alone are several MB — and the
      // browser fetches none of them to paint the first screen. Counting them put
      // the bar at 16% when the download was in fact done.
      const seen = new Set<string>()
      const walk = (name: string) => {
        if (seen.has(name)) return
        seen.add(name)
        const file = bundle[name]
        if (!file || file.type !== 'chunk') return
        for (const imported of file.imports) walk(imported)
        for (const css of file.viteMetadata?.importedCss ?? []) seen.add(css)
      }
      for (const file of Object.values(bundle)) {
        if (file.type === 'chunk' && file.isEntry) walk(file.fileName)
      }

      // Fonts are referenced by `url()` from the CSS, so no chunk imports them and
      // the walk cannot reach them — yet they are ~100 KB of a cold boot.
      //
      // Counting the declarations does not work: @fontsource ships a face per
      // weight per subset and the boot stylesheet declares 95 of them, while a
      // browser downloads only the faces the rendered text actually needs — the
      // four latin weights, here. Match that rather than the @font-face list.
      const bootFonts = /inter-latin-(400|500|600|700)-normal-[^.]+\.woff2$/
      for (const name of Object.keys(bundle)) {
        if (bootFonts.test(name)) seen.add(name)
      }

      let total = 0
      for (const name of seen) total += sizeOf(name)

      this.emitFile({
        type: 'asset',
        fileName: 'boot-size.json',
        source: JSON.stringify({ bytes: total }),
      })
    },
  }
}

// Sub-path deployments (e.g. reverse proxy exposing the app under
// /docker-9250/): BASE_PATH prefixes all asset URLs and, via Vite's BASE_URL,
// the router basename in main.tsx. Normalized to /…/ as Vite requires.
// Set it only when the proxy does NOT strip the prefix — when it does, the app
// sees "/" and a prefix here would break every asset URL.
function normalizeBasePath(raw: string | undefined) {
  const trimmed = (raw || '/').trim()
  if (trimmed === '' || trimmed === '/') return '/'
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}/`
}

export default defineConfig(({ mode }) => {
  // Dev ports are overridable so several git worktrees can run side by side,
  // each on its own pair (see scripts/new-worktree.mjs). WEB_PORT/API_PORT come
  // from the worktree's .env.local — loadEnv with an empty prefix is required to
  // read non-VITE_ keys — and default to the historical 3000/8000.
  const env = { ...loadEnv(mode, __dirname, ''), ...process.env }
  const webPort = Number(env.WEB_PORT) || 3000
  const apiPort = Number(env.API_PORT) || 8000
  const basePath = normalizeBasePath(env.BASE_PATH)

  // Remote dev (VS Code container, devbox, VM): the browser is not on the host
  // running vite, so the server must listen beyond loopback — WEB_HOST=0.0.0.0.
  const webHost = env.WEB_HOST || undefined

  // Vite refuses requests whose Host header it does not know, which is what a
  // reverse proxy in front of a remote container sends (chu-example.fr, not
  // localhost). List those hostnames in WEB_ALLOWED_HOSTS, comma-separated.
  // "true" disables the check entirely: acceptable on a private network, never
  // on a public one — it reopens the DNS-rebinding hole the check exists to
  // close. Unset keeps Vite's default (localhost only).
  const allowedHostsRaw = (env.WEB_ALLOWED_HOSTS || '').trim()
  const allowedHosts =
    allowedHostsRaw === ''
      ? undefined
      : allowedHostsRaw === 'true'
        ? (true as const)
        : allowedHostsRaw
            .split(',')
            .map((h) => h.trim())
            .filter(Boolean)

  // HMR rides the page's own origin. Behind a TLS-terminating proxy the browser
  // loads over https on 443, so the websocket must too — otherwise it dials
  // ws://<proxy>:<webPort>, which the proxy does not serve, and the client
  // retries forever. WEB_HMR_PROTOCOL/PORT pin it; WEB_HMR_HOST covers a proxy
  // hostname that differs from the page's.
  const hmrHost = env.WEB_HMR_HOST?.trim()
  const hmrProtocol = env.WEB_HMR_PROTOCOL?.trim()
  const hmrPort = Number(env.WEB_HMR_CLIENT_PORT) || undefined
  const hmr =
    hmrHost || hmrProtocol || hmrPort
      ? {
          ...(hmrHost ? { host: hmrHost } : {}),
          ...(hmrProtocol ? { protocol: hmrProtocol } : {}),
          ...(hmrPort ? { clientPort: hmrPort } : {}),
        }
      : undefined

  return {
    base: basePath,
    plugins: [react(), tailwindcss(), seedHashesPlugin(), injectBootBytes(), stripCoiInServerMode(!!env.VITE_API_URL)],
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
      port: webPort,
      ...(webHost ? { host: webHost } : {}),
      ...(allowedHosts ? { allowedHosts } : {}),
      ...(hmr ? { hmr } : {}),
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
      },
      proxy: {
        '/api': {
          target: `http://localhost:${apiPort}`,
          changeOrigin: true,
        },
        '/ws': {
          target: `ws://localhost:${apiPort}`,
          ws: true,
        },
      },
    },
    // `vite preview` serves the production build — same remote-access
    // constraints as the dev server, so it honours the same three knobs.
    preview: {
      port: webPort,
      ...(webHost ? { host: webHost } : {}),
      ...(allowedHosts ? { allowedHosts } : {}),
    },
  }
})
