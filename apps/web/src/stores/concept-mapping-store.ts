import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import { migrateEntityIds } from '@/lib/slugify-id'
import type { ConceptSet, MappingProject, ConceptMapping, MappingStatus, MappingProjectStats } from '@/types'

interface ConceptMappingState {
  // --- Concept Sets ---
  conceptSets: ConceptSet[]
  conceptSetsLoaded: boolean
  loadConceptSets: () => Promise<void>
  getWorkspaceConceptSets: (workspaceId: string) => ConceptSet[]
  createConceptSet: (cs: ConceptSet) => Promise<void>
  updateConceptSet: (id: string, changes: Partial<ConceptSet>) => Promise<void>
  deleteConceptSet: (id: string) => Promise<void>
  deleteConceptSetsBatch: (ids: string[]) => Promise<void>

  // --- Mapping Projects ---
  mappingProjects: MappingProject[]
  mappingProjectsLoaded: boolean
  loadMappingProjects: () => Promise<void>
  getWorkspaceProjects: (workspaceId: string) => MappingProject[]
  createMappingProject: (project: MappingProject) => Promise<void>
  updateMappingProject: (id: string, changes: Partial<MappingProject>) => Promise<void>
  deleteMappingProject: (id: string) => Promise<void>

  // --- Concept Mappings (scoped to active project) ---
  mappings: ConceptMapping[]
  mappingsLoaded: boolean
  activeProjectId: string | null
  loadProjectMappings: (projectId: string) => Promise<void>
  createMapping: (mapping: ConceptMapping) => Promise<void>
  createMappingsBatch: (mappings: ConceptMapping[]) => Promise<void>
  updateMapping: (id: string, changes: Partial<ConceptMapping>) => Promise<void>
  deleteMapping: (id: string) => Promise<void>
  bulkUpdateStatus: (ids: string[], status: MappingStatus, updatedBy?: string) => Promise<void>
  /** Re-anchor mappings to new file rows after a file update.
   *  Matches by (conceptCode + vocabulary) first, then conceptId.
   *  Returns the number of mappings updated. */
  reconcileMappingsToFile: (projectId: string, newRows: import('@/types').FileSourceData) => Promise<number>

  // --- Stats ---
  recomputeProjectStats: (projectId: string) => Promise<MappingProjectStats>

  // --- Cross-project "mapped elsewhere" ---
  /** Set of `vocabulary:code` keys mapped in other projects. */
  otherProjectsMappedKeys: Set<string>
  /** Load mapped keys from all other projects in the same workspace. */
  loadOtherProjectsMappedKeys: (currentProjectId: string, workspaceId: string) => Promise<void>

  // --- UI State ---
  selectedSourceConceptId: number | null
  setSelectedSourceConcept: (id: number | null) => void
  filterStatus: MappingStatus | 'all'
  filterDomain: string | 'all'
  filterConceptSet: string | 'all'
  searchQuery: string
  setFilterStatus: (status: MappingStatus | 'all') => void
  setFilterDomain: (domain: string | 'all') => void
  setFilterConceptSet: (conceptSetId: string | 'all') => void
  setSearchQuery: (query: string) => void
}

export const useConceptMappingStore = create<ConceptMappingState>((set, get) => ({
  // --- Concept Sets ---
  conceptSets: [],
  conceptSetsLoaded: false,

  loadConceptSets: async () => {
    const all = await getStorage().conceptSets.getAll()
    set({ conceptSets: all, conceptSetsLoaded: true })
  },

  getWorkspaceConceptSets: (workspaceId) =>
    get().conceptSets.filter((cs) => cs.workspaceId === workspaceId),

  createConceptSet: async (cs) => {
    await getStorage().conceptSets.create(cs)
    set((s) => ({ conceptSets: [...s.conceptSets, cs] }))
  },

  updateConceptSet: async (id, changes) => {
    await getStorage().conceptSets.update(id, changes)
    set((s) => ({
      conceptSets: s.conceptSets.map((cs) =>
        cs.id === id ? { ...cs, ...changes, updatedAt: new Date().toISOString() } : cs,
      ),
    }))
  },

  deleteConceptSet: async (id) => {
    await getStorage().conceptSets.delete(id)
    set((s) => ({ conceptSets: s.conceptSets.filter((cs) => cs.id !== id) }))
  },

  deleteConceptSetsBatch: async (ids) => {
    if (ids.length === 0) return
    await getStorage().conceptSets.deleteBatch(ids)
    const idSet = new Set(ids)
    set((s) => ({ conceptSets: s.conceptSets.filter((cs) => !idSet.has(cs.id)) }))
  },

  // --- Mapping Projects ---
  mappingProjects: [],
  mappingProjectsLoaded: false,

  loadMappingProjects: async () => {
    const storage = getStorage()
    const all = await storage.mappingProjects.getAll()
    for (const p of migrateEntityIds(all, e => e.name)) {
      storage.mappingProjects.update(p.id, { entityId: p.entityId }).catch(() => {})
    }
    set({ mappingProjects: all, mappingProjectsLoaded: true })
  },

  getWorkspaceProjects: (workspaceId) =>
    get().mappingProjects.filter((p) => p.workspaceId === workspaceId),

  createMappingProject: async (project) => {
    await getStorage().mappingProjects.create(project)
    set((s) => ({ mappingProjects: [...s.mappingProjects, project] }))
  },

  updateMappingProject: async (id, changes) => {
    await getStorage().mappingProjects.update(id, changes)
    set((s) => ({
      mappingProjects: s.mappingProjects.map((p) =>
        p.id === id ? { ...p, ...changes, updatedAt: new Date().toISOString() } : p,
      ),
    }))
  },

  deleteMappingProject: async (id) => {
    await getStorage().conceptMappings.deleteByProject(id)
    await getStorage().mappingProjects.delete(id)
    set((s) => ({
      mappingProjects: s.mappingProjects.filter((p) => p.id !== id),
      mappings: s.activeProjectId === id ? [] : s.mappings,
      activeProjectId: s.activeProjectId === id ? null : s.activeProjectId,
    }))
  },

  // --- Concept Mappings ---
  mappings: [],
  mappingsLoaded: false,
  activeProjectId: null,

  loadProjectMappings: async (projectId) => {
    const raw = await getStorage().conceptMappings.getByProject(projectId)
    // Migrate: mappings created before the reviews[] system have status set but no reviews entry.
    // Synthesize a review from the original mapper so vote counts are correct.
    const now = new Date().toISOString()
    const mappings = await Promise.all(raw.map(async (m) => {
      if ((m.reviews ?? []).length > 0) return m
      if (!m.status || m.status === 'unchecked') return m
      const reviewer = m.mappedBy ?? m.reviewedBy ?? 'Unknown'
      const review = {
        id: crypto.randomUUID(),
        reviewerId: reviewer,
        status: m.status,
        createdAt: m.reviewedOn ?? m.updatedAt ?? now,
      }
      const migrated = { ...m, reviews: [review] }
      await getStorage().conceptMappings.update(m.id, { reviews: [review] })
      return migrated
    }))
    set({ mappings, mappingsLoaded: true, activeProjectId: projectId })
  },

  createMapping: async (mapping) => {
    await getStorage().conceptMappings.create(mapping)
    set((s) => ({ mappings: [...s.mappings, mapping] }))
  },

  createMappingsBatch: async (mappings) => {
    await getStorage().conceptMappings.createBatch(mappings)
    set((s) => ({ mappings: [...s.mappings, ...mappings] }))
  },

  updateMapping: async (id, changes) => {
    await getStorage().conceptMappings.update(id, changes)
    set((s) => ({
      mappings: s.mappings.map((m) =>
        m.id === id ? { ...m, ...changes, updatedAt: new Date().toISOString() } : m,
      ),
    }))
  },

  deleteMapping: async (id) => {
    await getStorage().conceptMappings.delete(id)
    set((s) => ({ mappings: s.mappings.filter((m) => m.id !== id) }))
  },

  bulkUpdateStatus: async (ids, status, updatedBy) => {
    const now = new Date().toISOString()
    const changes: Partial<ConceptMapping> = { status, mappedOn: now }
    if (updatedBy) changes.mappedBy = updatedBy
    for (const id of ids) {
      await getStorage().conceptMappings.update(id, changes)
    }
    set((s) => ({
      mappings: s.mappings.map((m) =>
        ids.includes(m.id) ? { ...m, ...changes, updatedAt: now } : m,
      ),
    }))
  },

  reconcileMappingsToFile: async (projectId, newFileData) => {
    const { columnMapping, rows } = newFileData
    const now = new Date().toISOString()

    // Build lookup maps from new file rows
    // Key 1: "code::vocabulary" (most stable)
    // Key 2: numeric conceptId from the id column
    const byCodeVocab = new Map<string, number>()
    const byConceptId = new Map<number, number>()

    rows.forEach((row, index) => {
      const newId = columnMapping.conceptIdColumn
        ? Number(row[columnMapping.conceptIdColumn]) || index + 1
        : index + 1
      const code = columnMapping.conceptCodeColumn ? String(row[columnMapping.conceptCodeColumn] ?? '') : ''
      const vocab = columnMapping.terminologyColumn ? String(row[columnMapping.terminologyColumn] ?? '') : ''

      if (code) byCodeVocab.set(`${code}::${vocab}`, newId)
      if (columnMapping.conceptIdColumn && Number(row[columnMapping.conceptIdColumn])) {
        byConceptId.set(Number(row[columnMapping.conceptIdColumn]), newId)
      }
    })

    const existingMappings = await getStorage().conceptMappings.getByProject(projectId)
    let updatedCount = 0

    for (const mapping of existingMappings) {
      const codeKey = `${mapping.sourceConceptCode ?? ''}::${mapping.sourceVocabularyId ?? ''}`
      const newId =
        (mapping.sourceConceptCode ? byCodeVocab.get(codeKey) : undefined) ??
        byConceptId.get(mapping.sourceConceptId)

      if (newId !== undefined && newId !== mapping.sourceConceptId) {
        await getStorage().conceptMappings.update(mapping.id, { sourceConceptId: newId, updatedAt: now })
        updatedCount++
      }
    }

    // Reload mappings if this is the active project
    if (get().activeProjectId === projectId) {
      const refreshed = await getStorage().conceptMappings.getByProject(projectId)
      set({ mappings: refreshed })
    }

    return updatedCount
  },

  // --- Stats ---
  recomputeProjectStats: async (projectId) => {
    const mappings = get().activeProjectId === projectId
      ? get().mappings
      : await getStorage().conceptMappings.getByProject(projectId)

    // Count unique source concepts that have at least one mapping
    const mappedSourceIds = new Set(mappings.map((m) => m.sourceConceptId))
    const approvedIds = new Set(
      mappings.filter((m) => m.status === 'approved').map((m) => m.sourceConceptId),
    )
    const flaggedIds = new Set(
      mappings.filter((m) => m.status === 'flagged').map((m) => m.sourceConceptId),
    )
    const ignoredIds = new Set(
      mappings.filter((m) => m.status === 'ignored').map((m) => m.sourceConceptId),
    )

    const stats: MappingProjectStats = {
      totalSourceConcepts: 0, // Must be set externally (from DuckDB query)
      mappedCount: mappedSourceIds.size,
      approvedCount: approvedIds.size,
      flaggedCount: flaggedIds.size,
      ignoredCount: ignoredIds.size,
      unmappedCount: 0, // totalSourceConcepts - mappedCount
    }

    await getStorage().mappingProjects.update(projectId, { stats })
    set((s) => ({
      mappingProjects: s.mappingProjects.map((p) =>
        p.id === projectId ? { ...p, stats, updatedAt: new Date().toISOString() } : p,
      ),
    }))

    return stats
  },

  // --- Cross-project "mapped elsewhere" ---
  otherProjectsMappedKeys: new Set(),
  loadOtherProjectsMappedKeys: async (currentProjectId, workspaceId) => {
    const storage = getStorage()
    const projects = get().mappingProjects.filter((p) => p.workspaceId === workspaceId && p.id !== currentProjectId)
    const keys = new Set<string>()
    for (const p of projects) {
      const mappings = await storage.conceptMappings.getByProject(p.id)
      for (const m of mappings) {
        if (m.status === 'ignored' || m.targetConceptId === 0) continue
        const key = `${m.sourceVocabularyId}:${m.sourceConceptCode}`
        keys.add(key)
      }
    }
    set({ otherProjectsMappedKeys: keys })
  },

  // --- UI State ---
  selectedSourceConceptId: null,
  setSelectedSourceConcept: (id) => set({ selectedSourceConceptId: id }),

  filterStatus: 'all',
  filterDomain: 'all',
  filterConceptSet: 'all',
  searchQuery: '',
  setFilterStatus: (status) => set({ filterStatus: status }),
  setFilterDomain: (domain) => set({ filterDomain: domain }),
  setFilterConceptSet: (conceptSetId) => set({ filterConceptSet: conceptSetId }),
  setSearchQuery: (query) => set({ searchQuery: query }),
}))
