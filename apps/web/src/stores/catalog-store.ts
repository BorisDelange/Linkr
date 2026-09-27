import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import { migrateEntityIds } from '@/lib/slugify-id'
import { localized, toLocalized } from '@/lib/localized'
import { PAGES_SITE_OWNER_TYPE } from '@/lib/dcat-ap/pages-deployment'
import { isLegacyCatalog, LEGACY_CATALOG_FIELDS, normalizeCatalog } from '@/lib/data-catalog/config'
import type { DataCatalog, CatalogResultCache, ServiceMapping } from '@/types'
import type { ComputeProgress } from '@/lib/duckdb/catalog-compute'

const resultLoads = new Map<string, Promise<CatalogResultCache | undefined>>()

interface CatalogState {
  // Catalog CRUD
  catalogs: DataCatalog[]
  catalogsLoaded: boolean
  loadCatalogs: () => Promise<void>
  getWorkspaceCatalogs: (workspaceId: string) => DataCatalog[]
  createCatalog: (catalog: DataCatalog) => Promise<void>
  updateCatalog: (id: string, changes: Partial<DataCatalog>) => Promise<void>
  deleteCatalog: (id: string) => Promise<void>

  // Service Mapping CRUD
  serviceMappings: ServiceMapping[]
  serviceMappingsLoaded: boolean
  loadServiceMappings: () => Promise<void>
  getWorkspaceServiceMappings: (workspaceId: string) => ServiceMapping[]
  createServiceMapping: (mapping: ServiceMapping) => Promise<void>
  updateServiceMapping: (id: string, changes: Partial<ServiceMapping>) => Promise<void>
  deleteServiceMapping: (id: string) => Promise<void>

  // Computation state
  computeRunning: boolean
  computeProgress: ComputeProgress | null
  activeResultCache: CatalogResultCache | null
  /** The catalog whose results have been read (found or not); until then they are loading. */
  resultCacheLoadedFor: string | null
  loadResultCache: (catalogId: string) => Promise<void>
  setResultCache: (cache: CatalogResultCache | null) => void
  startCompute: () => void
  setComputeProgress: (progress: ComputeProgress) => void
  finishCompute: (cache: CatalogResultCache) => void
  failCompute: () => void
}

export const useCatalogStore = create<CatalogState>((set, get) => ({
  // --- Catalog CRUD ---
  catalogs: [],
  catalogsLoaded: false,

  loadCatalogs: async () => {
    try {
      const all = await getStorage().dataCatalogs.getAll()
      // Recovery: reset any catalogs stuck in 'computing' (e.g. app was closed mid-compute)
      const storage = getStorage()
      for (const c of all) {
        if (c.status === 'computing') {
          const newStatus = c.lastComputedAt ? 'success' : 'draft'
          c.status = newStatus
          await storage.dataCatalogs.update(c.id, { status: newStatus })
        }
      }
      // Migration: assign entityId to catalogs that don't have one
      for (const c of migrateEntityIds(all, e => localized(e.name, 'en'))) {
        storage.dataCatalogs.update(c.id, { entityId: c.entityId }).catch(() => {})
      }
      // Backfill legacy plain-string name/description into LocalizedString.
      for (const c of all) {
        if (typeof c.name === 'string' || typeof c.description === 'string') {
          c.name = toLocalized(c.name)
          c.description = toLocalized(c.description)
          storage.dataCatalogs.update(c.id, { name: c.name, description: c.description }).catch(() => {})
        }
      }
      // Catalogs from before variables and crossings: converted once, and the
      // old fields cleared so nothing reads them again.
      const catalogs = all.map((c) => {
        if (!isLegacyCatalog(c)) return normalizeCatalog(c)
        const converted = normalizeCatalog(c)
        const cleared = Object.fromEntries(LEGACY_CATALOG_FIELDS.map((k) => [k, k === 'dimensions' ? [] : null]))
        storage.dataCatalogs.update(c.id, { ...cleared, variables: converted.variables, crossings: converted.crossings } as Partial<DataCatalog>).catch(() => {})
        return converted
      })
      set({ catalogs, catalogsLoaded: true })
    } catch {
      // IDB store may not exist yet (upgrade pending); mark loaded so app doesn't block
      set({ catalogsLoaded: true })
    }
  },

  getWorkspaceCatalogs: (workspaceId) =>
    get().catalogs.filter((c) => c.workspaceId === workspaceId),

  createCatalog: async (raw) => {
    const catalog = normalizeCatalog(raw)
    await getStorage().dataCatalogs.create(catalog)
    set((s) => ({ catalogs: [...s.catalogs, catalog] }))
  },

  // Applied before the save so a toggle answers at once rather than after the
  // round trip; a failed save puts back what it overwrote.
  updateCatalog: async (id, changes) => {
    const before = get().catalogs.find((c) => c.id === id)
    set((s) => ({
      catalogs: s.catalogs.map((c) =>
        c.id === id ? { ...c, ...changes, updatedAt: new Date().toISOString() } : c,
      ),
    }))
    try {
      await getStorage().dataCatalogs.update(id, changes)
    } catch (e) {
      if (before) {
        const restore = Object.fromEntries(Object.keys(changes).map((k) => [k, before[k as keyof DataCatalog]]))
        set((s) => ({ catalogs: s.catalogs.map((c) => (c.id === id ? { ...c, ...restore } : c)) }))
      }
      throw e
    }
  },

  deleteCatalog: async (id) => {
    await getStorage().catalogResults.delete(id)
    await getStorage().readmeAttachments.deleteByOwner(PAGES_SITE_OWNER_TYPE, id).catch(() => {})
    await getStorage().dataCatalogs.delete(id)
    set((s) => ({
      catalogs: s.catalogs.filter((c) => c.id !== id),
      activeResultCache: s.activeResultCache?.catalogId === id ? null : s.activeResultCache,
    }))
  },

  // --- Service Mapping CRUD ---
  serviceMappings: [],
  serviceMappingsLoaded: false,

  loadServiceMappings: async () => {
    try {
      const all = await getStorage().serviceMappings.getAll()
      set({ serviceMappings: all, serviceMappingsLoaded: true })
    } catch {
      set({ serviceMappingsLoaded: true })
    }
  },

  getWorkspaceServiceMappings: (workspaceId) =>
    get().serviceMappings.filter((m) => m.workspaceId === workspaceId),

  createServiceMapping: async (mapping) => {
    await getStorage().serviceMappings.create(mapping)
    set((s) => ({ serviceMappings: [...s.serviceMappings, mapping] }))
  },

  updateServiceMapping: async (id, changes) => {
    await getStorage().serviceMappings.update(id, changes)
    set((s) => ({
      serviceMappings: s.serviceMappings.map((m) =>
        m.id === id ? { ...m, ...changes, updatedAt: new Date().toISOString() } : m,
      ),
    }))
  },

  deleteServiceMapping: async (id) => {
    await getStorage().serviceMappings.delete(id)
    set((s) => ({
      serviceMappings: s.serviceMappings.filter((m) => m.id !== id),
    }))
  },

  // --- Computation state ---
  computeRunning: false,
  computeProgress: null,
  activeResultCache: null,
  resultCacheLoadedFor: null,

  loadResultCache: async (catalogId) => {
    if (get().resultCacheLoadedFor !== catalogId) set({ resultCacheLoadedFor: null, activeResultCache: null })
    // One request per catalog at a time: the page mounting twice (StrictMode,
    // a quick back-and-forth) would otherwise download the results twice, in
    // parallel, each one slowing the other.
    let pending = resultLoads.get(catalogId)
    if (!pending) {
      pending = getStorage().catalogResults.get(catalogId).catch(() => undefined).finally(() => resultLoads.delete(catalogId))
      resultLoads.set(catalogId, pending)
    }
    const cache = await pending
    set({ activeResultCache: cache ?? null, resultCacheLoadedFor: catalogId })
  },

  setResultCache: (cache) => {
    set({ activeResultCache: cache })
  },

  startCompute: () => {
    set({ computeRunning: true, computeProgress: { step: 'mounting', fraction: 0 }, activeResultCache: null })
  },

  setComputeProgress: (progress) => {
    set({ computeProgress: progress })
  },

  finishCompute: (cache) => {
    set({ computeRunning: false, computeProgress: null, activeResultCache: cache })
  },

  failCompute: () => {
    set({ computeRunning: false, computeProgress: null })
  },
}))
