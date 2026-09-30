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
  setActive: (id: string) => void
  setCatalogs: (catalogs: CatalogConfig[], activeId?: string) => void
}

export const useCatalogSourcesStore = create<CatalogSourcesState>((set, get) => ({
  ...loadCatalogSettings(),
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
}))

export function useActiveCatalog(): CatalogConfig | null {
  return useCatalogSourcesStore((s) => s.catalogs.find((c) => c.id === s.activeId) ?? null)
}
