import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import { migrateEntityIds } from '@/lib/slugify-id'
import type { DataCatalog, CatalogResultCache, ServiceMapping } from '@/types'
import type { ComputeProgress } from '@/lib/duckdb/catalog-compute'

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
      for (const c of migrateEntityIds(all, e => e.name)) {
        storage.dataCatalogs.update(c.id, { entityId: c.entityId }).catch(() => {})
      }
      set({ catalogs: all, catalogsLoaded: true })
    } catch {
      // IDB store may not exist yet (upgrade pending); mark loaded so app doesn't block
      set({ catalogsLoaded: true })
    }
  },

  getWorkspaceCatalogs: (workspaceId) =>
    get().catalogs.filter((c) => c.workspaceId === workspaceId),

  createCatalog: async (catalog) => {
    await getStorage().dataCatalogs.create(catalog)
    set((s) => ({ catalogs: [...s.catalogs, catalog] }))
  },

  updateCatalog: async (id, changes) => {
    await getStorage().dataCatalogs.update(id, changes)
    set((s) => ({
      catalogs: s.catalogs.map((c) =>
        c.id === id ? { ...c, ...changes, updatedAt: new Date().toISOString() } : c,
      ),
    }))
  },

  deleteCatalog: async (id) => {
    await getStorage().catalogResults.delete(id)
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

  loadResultCache: async (catalogId) => {
    const cache = await getStorage().catalogResults.get(catalogId)
    set({ activeResultCache: cache ?? null })
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
