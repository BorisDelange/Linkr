import { create } from 'zustand'
import {
  loadCatalogSettings,
  saveCatalogSettings,
  updateCatalogs,
  type CatalogConfig,
  type CatalogSettings,
} from '@/lib/catalog/settings'

/**
 * The configured catalog repos and the one being browsed, shared by the Catalog page
 * and the import dialog's catalog tab so switching in one is seen by the other.
 */
interface CatalogSourcesState extends CatalogSettings {
  /**
   * A catalog just added or repointed, to download as soon as a page shows it — the
   * user has just said which repo they want, so a "Load catalog" click would only
   * ask the same thing twice. In memory only: a reload falls back to the click.
   */
  autoLoadId: string | null
  setActive: (id: string) => void
  setCatalogs: (catalogs: CatalogConfig[], activeId?: string) => void
  requestLoad: (id: string) => void
  /** True once for the requested catalog, clearing the request. */
  consumeLoadRequest: (id: string) => boolean
}

export const useCatalogSourcesStore = create<CatalogSourcesState>((set, get) => ({
  ...loadCatalogSettings(),
  autoLoadId: null,
  setActive: (activeId) => {
    const { catalogs } = get()
    if (!catalogs.some((c) => c.id === activeId)) return
    saveCatalogSettings({ catalogs, activeId })
    set({ activeId })
  },
  setCatalogs: (catalogs, activeId) => {
    const { catalogs: prevCatalogs, activeId: prevActive } = get()
    set(updateCatalogs({ catalogs: prevCatalogs, activeId: prevActive }, { catalogs, activeId: activeId ?? prevActive }))
  },
  requestLoad: (autoLoadId) => set({ autoLoadId }),
  consumeLoadRequest: (id) => {
    if (get().autoLoadId !== id) return false
    set({ autoLoadId: null })
    return true
  },
}))

export function useActiveCatalog(): CatalogConfig | null {
  return useCatalogSourcesStore((s) => s.catalogs.find((c) => c.id === s.activeId) ?? null)
}
