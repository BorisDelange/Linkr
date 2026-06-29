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
import { executePendingReset } from '@/lib/version-check'
import { registerDefaultPlugins, registerUserPlugins } from '@/lib/plugins/default-plugins'
import { isServerMode } from '@/lib/api-client'
import { initStorage } from '@/lib/storage'
import { createIDBStorage } from '@/lib/storage/idb-storage'
import { createAPIStorage } from '@/lib/storage/api-storage'

async function boot() {
  // Handle pending data reset BEFORE opening any IDB connection
  await executePendingReset()

  // Initialize storage (API-backed in server mode, IndexedDB in local mode) and plugins
  initStorage(isServerMode() ? createAPIStorage() : createIDBStorage())
  registerDefaultPlugins()
  await registerUserPlugins()

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AppErrorBoundary>
        <BrowserRouter>
          <AuthGate>
            <App />
          </AuthGate>
        </BrowserRouter>
      </AppErrorBoundary>
    </StrictMode>,
  )
}

boot()
