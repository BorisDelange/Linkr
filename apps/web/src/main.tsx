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
import { registerDefaultPlugins, registerUserPlugins } from '@/lib/analysis-plugins/default-plugins'
import { initStorage } from '@/lib/storage'
import { createIDBStorage } from '@/lib/storage/idb-storage'

// Initialize storage and register plugins before rendering
initStorage(createIDBStorage())
registerDefaultPlugins()

async function boot() {
  await registerUserPlugins()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  )
}

boot()
