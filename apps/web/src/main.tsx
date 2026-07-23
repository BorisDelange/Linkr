import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@/lib/i18n'
import '@/index.css'
import { App } from '@/app/App'
import { AuthGate } from '@/app/AuthGate'
import { AppErrorBoundary } from '@/components/layout/AppErrorBoundary'
import { executePendingReset, purgeStaleLocalDataForServerMode } from '@/lib/version-check'
import { registerDefaultPlugins, registerUserPlugins } from '@/lib/plugins/default-plugins'
import { isServerMode } from '@/lib/api-client'
import { initStorage } from '@/lib/storage'
import { createIDBStorage } from '@/lib/storage/idb-storage'
import { createAPIStorage } from '@/lib/storage/api-storage'

async function boot() {
  // In server mode the COI service worker (SharedArrayBuffer for webR) is not
  // just unused — it intercepts fetches and corrupts API upload POSTs (retries
  // a request whose body was already consumed). New builds don't register it
  // (see vite.config), but a client that visited a front-only build earlier may
  // still have it installed, so unregister it defensively.
  if (isServerMode() && 'serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations().catch(() => [])
    await Promise.all(regs.map((r) => r.unregister().catch(() => false)))
  }

  // Handle a pending front-only data reset BEFORE opening any IDB connection.
  await executePendingReset()
  // In server mode, drop any IndexedDB inherited from a previous front-only run
  // (the client keeps no data there now). Runs once, then flags itself done.
  await purgeStaleLocalDataForServerMode(isServerMode())

  // Initialize storage (API-backed in server mode, IndexedDB in local mode) and plugins
  initStorage(isServerMode() ? createAPIStorage() : createIDBStorage())
  registerDefaultPlugins()
  await registerUserPlugins()

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AppErrorBoundary>
        <BrowserRouter basename={import.meta.env.BASE_URL}>
          <AuthGate>
            <App />
          </AuthGate>
        </BrowserRouter>
      </AppErrorBoundary>
    </StrictMode>,
  )
}

boot()
