import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
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

  // --- Stats ---
  recomputeProjectStats: (projectId: string) => Promise<MappingProjectStats>

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
    const all = await getStorage().mappingProjects.getAll()
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
    const mappings = await getStorage().conceptMappings.getByProject(projectId)
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
