import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import { migrateEntityIds } from '@/lib/slugify-id'
import { effectiveMappingStatus, sourceKey } from '@/lib/concept-mapping/mapping-status'
import type { ConceptSet, MappingProject, ConceptMapping, MappingStatus, MappingProjectStats } from '@/types'

/** Summary of a single mapping made in another project (for cross-project tooltips & import). */
export interface ExternalMappingInfo {
  /** Original mapping (from another project). */
  mapping: ConceptMapping
  /** Source project id where this mapping lives. */
  sourceProjectId: string
  /** Source project display name. */
  sourceProjectName: string
}

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
  /** O(1) index over `mappings`. Mutated in place by updateMapping so consumers can
   *  read the latest entry without forcing the whole `mappings` array reference to change. */
  mappingsById: Map<string, ConceptMapping>
  /** Bumped on every mapping mutation (vote, comment, status change…). Memos that
   *  derive per-row content (vote counts, effective status) should depend on this. */
  mappingsVersion: number
  /** Bumped only when the *set* of mappings changes (create / delete / batch import).
   *  Memos that derive aggregations over the full set (filter options, status counts)
   *  should depend on this — voting on a row should NOT invalidate them. */
  mappingsStructureVersion: number
  mappingsLoaded: boolean
  activeProjectId: string | null
  loadProjectMappings: (projectId: string, options?: { force?: boolean }) => Promise<void>
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
  /** Set of `vocabulary:code` keys mapped in other projects. Cheap, used everywhere. */
  otherProjectsMappedKeys: Set<string>
  /** Detailed cross-project mappings keyed by `vocabulary:code`. Heavier, populated on demand. */
  otherProjectsMappings: Map<string, ExternalMappingInfo[]>
  /** Cache markers so we don't redo the same scan twice in the same session. */
  _otherKeysLoadedFor: string | null
  _otherDetailsLoadedFor: string | null
  /** Cheap path: builds only `otherProjectsMappedKeys`. Use from views that just need the badge. */
  loadOtherProjectsMappedKeys: (currentProjectId: string, workspaceId: string) => Promise<void>
  /** Heavy path: also fills `otherProjectsMappings` with the full `ExternalMappingInfo[]`.
   *  Use only from views that render external rows or need per-mapping detail (MappingsTab). */
  loadOtherProjectsDetails: (currentProjectId: string, workspaceId: string) => Promise<void>
  /** Import an external mapping into the active project as a local copy.
   *  Returns the newly-created local mapping, or null if it could not be imported. */
  importExternalMapping: (
    info: ExternalMappingInfo,
    targetProjectId: string,
    options?: { sourceConceptId?: number; createdBy?: string },
  ) => Promise<ConceptMapping | null>

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
    // One-shot cleanup: prune orphan concept_mapping rows whose projectId is no longer
    // a known mapping project. Heals databases that accumulated orphans from earlier
    // failed/cancelled imports. Runs in the background — never blocks UI.
    storage.conceptMappings.deleteOrphans(new Set(all.map((p) => p.id)))
      .then((n) => { if (n > 0) console.warn(`[concept-mapping] Pruned ${n} orphan concept mapping rows from IDB.`) })
      .catch(() => { /* ignore */ })
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
  mappingsById: new Map(),
  mappingsVersion: 0,
  mappingsStructureVersion: 0,
  mappingsLoaded: false,
  activeProjectId: null,

  loadProjectMappings: async (projectId, options) => {
    // Skip if this project's mappings are already loaded (unless force=true).
    if (!options?.force && get().activeProjectId === projectId && get().mappingsLoaded) return
    const raw = await getStorage().conceptMappings.getByProject(projectId)
    // Quick scan: only run the legacy migration if at least one row needs it.
    // Most projects have already been migrated, so we avoid creating 100k+ promises for nothing.
    const needsMigration = raw.some((m) => (m.reviews ?? []).length === 0 && m.status && m.status !== 'unchecked')
    let mappings = raw
    if (needsMigration) {
      const now = new Date().toISOString()
      mappings = await Promise.all(raw.map(async (m) => {
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
    }
    // Build the id index in lockstep with the array, then bump the structure version
    // (the *set* of rows changed) and the content version (each row's content is fresh too).
    const mappingsById = new Map<string, ConceptMapping>()
    for (const m of mappings) mappingsById.set(m.id, m)
    set((s) => ({
      mappings,
      mappingsById,
      mappingsVersion: s.mappingsVersion + 1,
      mappingsStructureVersion: s.mappingsStructureVersion + 1,
      mappingsLoaded: true,
      activeProjectId: projectId,
    }))
  },

  createMapping: async (mapping) => {
    await getStorage().conceptMappings.create(mapping)
    set((s) => {
      // Rebuild the array (reference change is desired — set membership changed).
      // Mutate the id index in place: the Map's identity stays stable and consumers
      // that subscribed to `mappingsById` keep their reference, but the new entry is
      // visible via Map.get().
      s.mappingsById.set(mapping.id, mapping)
      return {
        mappings: [...s.mappings, mapping],
        mappingsVersion: s.mappingsVersion + 1,
        mappingsStructureVersion: s.mappingsStructureVersion + 1,
        _otherKeysLoadedFor: null,
        _otherDetailsLoadedFor: null,
      }
    })
    void get().recomputeProjectStats(mapping.projectId).catch(() => {})
  },

  createMappingsBatch: async (mappings) => {
    if (mappings.length === 0) return
    // Defensive dedup: skip any incoming mapping whose (projectId, sourceVocab, sourceCode, targetId)
    // already exists locally. Protects against rapid double-imports that race the React render
    // before the previous batch has been merged into state.
    const existingKeys = new Set(
      get().mappings.map((m) => `${m.projectId}\0${m.sourceVocabularyId}\0${m.sourceConceptCode}\0${m.targetConceptId}`),
    )
    // Also dedup within the incoming batch itself (same key appearing twice).
    const seenInBatch = new Set<string>()
    const filtered: ConceptMapping[] = []
    for (const m of mappings) {
      const key = `${m.projectId}\0${m.sourceVocabularyId}\0${m.sourceConceptCode}\0${m.targetConceptId}`
      if (existingKeys.has(key) || seenInBatch.has(key)) continue
      seenInBatch.add(key)
      filtered.push(m)
    }
    if (filtered.length === 0) return
    await getStorage().conceptMappings.createBatch(filtered)
    set((s) => {
      for (const m of filtered) s.mappingsById.set(m.id, m)
      return {
        mappings: [...s.mappings, ...filtered],
        mappingsVersion: s.mappingsVersion + 1,
        mappingsStructureVersion: s.mappingsStructureVersion + 1,
        _otherKeysLoadedFor: null,
        _otherDetailsLoadedFor: null,
      }
    })
    // Recompute stats for each affected project (usually one, but bulk imports may span several)
    const affectedProjects = new Set(filtered.map((m) => m.projectId))
    for (const pid of affectedProjects) {
      void get().recomputeProjectStats(pid).catch(() => {})
    }
  },

  updateMapping: async (id, changes) => {
    // Invalidate the cross-project cache only when a field that affects "is mapped
    // elsewhere?" changes — i.e. status (especially `ignored`) or targetConceptId.
    // Pure review/comment updates leave the cache valid.
    const invalidatesXProject =
      Object.prototype.hasOwnProperty.call(changes, 'status') ||
      Object.prototype.hasOwnProperty.call(changes, 'targetConceptId') ||
      Object.prototype.hasOwnProperty.call(changes, 'sourceVocabularyId') ||
      Object.prototype.hasOwnProperty.call(changes, 'sourceConceptCode')

    const existing = get().mappingsById.get(id)
    if (!existing) {
      // Persist the change anyway (caller may know about a row not yet loaded), but
      // skip the in-memory update — there's nothing to surgically patch.
      await getStorage().conceptMappings.update(id, changes)
      return
    }
    const updated: ConceptMapping = { ...existing, ...changes, updatedAt: new Date().toISOString() }
    const affectedProjectId = existing.projectId
    // Hot path fast-skip: if the only fields changing are `reviews` and the bookkeeping
    // ones (reviewedBy / reviewedOn / updatedAt), bump only `mappingsVersion` and let
    // the rendering pick up fresh data via `mappingsById`. Any other field change might
    // be displayed by the table cell directly — bump structureVersion to refresh the
    // memo chain so the cell sees the new value.
    const HOT_FIELDS = new Set(['reviews', 'reviewedBy', 'reviewedOn', 'updatedAt'])
    const onlyHotFields = Object.keys(changes).every((k) => HOT_FIELDS.has(k))

    // Optimistic surgical update: mutate the id index in place, replace the array entry
    // at the correct position so iterators keep working — but DO NOT swap the `mappings`
    // array reference. Memos depending on `mappingsStructureVersion` re-run only if the
    // change touches a field other than the hot-path review/comment fields.
    set((s) => {
      s.mappingsById.set(id, updated)
      const idx = s.mappings.findIndex((m) => m.id === id)
      if (idx >= 0) s.mappings[idx] = updated
      return {
        mappingsVersion: s.mappingsVersion + 1,
        ...(onlyHotFields ? {} : { mappingsStructureVersion: s.mappingsStructureVersion + 1 }),
        ...(invalidatesXProject ? { _otherKeysLoadedFor: null, _otherDetailsLoadedFor: null } : {}),
      }
    })
    await getStorage().conceptMappings.update(id, changes)
    void get().recomputeProjectStats(affectedProjectId).catch(() => {})
  },

  deleteMapping: async (id) => {
    const affectedProjectId = get().mappingsById.get(id)?.projectId
    await getStorage().conceptMappings.delete(id)
    set((s) => {
      s.mappingsById.delete(id)
      return {
        mappings: s.mappings.filter((m) => m.id !== id),
        mappingsVersion: s.mappingsVersion + 1,
        mappingsStructureVersion: s.mappingsStructureVersion + 1,
        _otherKeysLoadedFor: null,
        _otherDetailsLoadedFor: null,
      }
    })
    if (affectedProjectId) {
      void get().recomputeProjectStats(affectedProjectId).catch(() => {})
    }
  },

  bulkUpdateStatus: async (ids, status, updatedBy) => {
    const now = new Date().toISOString()
    const changes: Partial<ConceptMapping> = { status, mappedOn: now }
    if (updatedBy) changes.mappedBy = updatedBy
    const idSet = new Set(ids)
    const affectedProjects = new Set<string>()
    for (const id of ids) {
      await getStorage().conceptMappings.update(id, changes)
    }
    // bulkUpdateStatus changes `m.status` for many rows at once, so it affects both
    // per-row memos (mappingsVersion) AND aggregations like statusCounts that read
    // `m.status` directly (mappingsStructureVersion). Bump both.
    set((s) => {
      for (let i = 0; i < s.mappings.length; i++) {
        const m = s.mappings[i]
        if (!idSet.has(m.id)) continue
        affectedProjects.add(m.projectId)
        const updated = { ...m, ...changes, updatedAt: now }
        s.mappings[i] = updated
        s.mappingsById.set(m.id, updated)
      }
      return {
        mappingsVersion: s.mappingsVersion + 1,
        mappingsStructureVersion: s.mappingsStructureVersion + 1,
        _otherKeysLoadedFor: null,
        _otherDetailsLoadedFor: null,
      }
    })
    for (const pid of affectedProjects) {
      void get().recomputeProjectStats(pid).catch(() => {})
    }
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
      const mappingsById = new Map<string, ConceptMapping>()
      for (const m of refreshed) mappingsById.set(m.id, m)
      set((s) => ({
        mappings: refreshed,
        mappingsById,
        mappingsVersion: s.mappingsVersion + 1,
        mappingsStructureVersion: s.mappingsStructureVersion + 1,
      }))
    }

    return updatedCount
  },

  // --- Stats ---
  recomputeProjectStats: async (projectId) => {
    const mappings = get().activeProjectId === projectId
      ? get().mappings
      : await getStorage().conceptMappings.getByProject(projectId)

    // Dedup by (vocabularyId, conceptCode) — same key as ProgressTab / Mapping Editor / Export.
    // Use effectiveMappingStatus so review-derived status is reflected.
    const ignoredKeys = new Set(
      mappings.filter((m) => effectiveMappingStatus(m) === 'ignored').map(sourceKey),
    )
    const nonIgnored = mappings.filter((m) => effectiveMappingStatus(m) !== 'ignored')
    const mappedKeys = new Set(nonIgnored.map(sourceKey))
    const approvedKeys = new Set(
      nonIgnored.filter((m) => effectiveMappingStatus(m) === 'approved').map(sourceKey),
    )
    const flaggedKeys = new Set(
      nonIgnored.filter((m) => effectiveMappingStatus(m) === 'flagged').map(sourceKey),
    )

    const stats: MappingProjectStats = {
      totalSourceConcepts: 0, // Must be set externally (from DuckDB query)
      mappedCount: mappedKeys.size,
      approvedCount: approvedKeys.size,
      flaggedCount: flaggedKeys.size,
      ignoredCount: ignoredKeys.size,
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
  otherProjectsMappings: new Map(),
  _otherKeysLoadedFor: null,
  _otherDetailsLoadedFor: null,
  loadOtherProjectsMappedKeys: async (currentProjectId, workspaceId) => {
    const cacheKey = `${workspaceId}::${currentProjectId}`
    if (get()._otherKeysLoadedFor === cacheKey) return
    const storage = getStorage()
    const projects = get().mappingProjects.filter((p) => p.workspaceId === workspaceId && p.id !== currentProjectId)
    const keys = new Set<string>()
    for (const p of projects) {
      // Use the project's stats array if available to avoid scanning every mapping. Fallback to a
      // mappings scan that pulls only the columns we need from IDB. Either way, no full record
      // is held in memory beyond what's needed for the Set.
      const mappings = await storage.conceptMappings.getByProject(p.id)
      for (const m of mappings) {
        if (m.status === 'ignored' || m.targetConceptId === 0) continue
        keys.add(`${m.sourceVocabularyId}:${m.sourceConceptCode}`)
      }
    }
    set({ otherProjectsMappedKeys: keys, _otherKeysLoadedFor: cacheKey })
  },
  loadOtherProjectsDetails: async (currentProjectId, workspaceId) => {
    const cacheKey = `${workspaceId}::${currentProjectId}`
    if (get()._otherDetailsLoadedFor === cacheKey) return
    const storage = getStorage()
    const projects = get().mappingProjects.filter((p) => p.workspaceId === workspaceId && p.id !== currentProjectId)
    const keys = new Set<string>()
    const detailMap = new Map<string, ExternalMappingInfo[]>()
    for (const p of projects) {
      const mappings = await storage.conceptMappings.getByProject(p.id)
      for (const m of mappings) {
        if (m.status === 'ignored' || m.targetConceptId === 0) continue
        const key = `${m.sourceVocabularyId}:${m.sourceConceptCode}`
        keys.add(key)
        const list = detailMap.get(key) ?? []
        list.push({ mapping: m, sourceProjectId: p.id, sourceProjectName: p.name })
        detailMap.set(key, list)
      }
    }
    set({
      otherProjectsMappedKeys: keys,
      otherProjectsMappings: detailMap,
      _otherKeysLoadedFor: cacheKey,
      _otherDetailsLoadedFor: cacheKey,
    })
  },

  importExternalMapping: async (info, targetProjectId, options) => {
    const now = new Date().toISOString()
    const { mapping } = info
    // Skip if a mapping with the same (project, source vocab+code, target) already exists.
    // Iterate the array directly — there's no faster index for this composite key.
    const existing = get().mappings.find((m) =>
      m.projectId === targetProjectId &&
      m.sourceVocabularyId === mapping.sourceVocabularyId &&
      m.sourceConceptCode === mapping.sourceConceptCode &&
      m.targetConceptId === mapping.targetConceptId,
    )
    if (existing) {
      // If we have a local source concept id and the existing record is anchored
      // to a foreign one, repair it in-place so the row dot turns green. This
      // happens with file-source projects where row ids are project-local.
      if (
        options?.sourceConceptId != null
        && existing.sourceConceptId !== options.sourceConceptId
      ) {
        const repaired = { ...existing, sourceConceptId: options.sourceConceptId, updatedAt: now }
        await getStorage().conceptMappings.update(existing.id, { sourceConceptId: options.sourceConceptId })
        set((s) => {
          s.mappingsById.set(repaired.id, repaired)
          return {
            mappings: s.mappings.map((m) => (m.id === repaired.id ? repaired : m)),
            mappingsVersion: s.mappingsVersion + 1,
            mappingsStructureVersion: s.mappingsStructureVersion + 1,
          }
        })
        return repaired
      }
      return existing
    }

    // Full preservation: status, reviews, comments, reviewedBy/reviewedOn — everything
    // from the source project is copied as-is. Only identity-bound fields (id, projectId,
    // sourceConceptId mapping to local source CSV) and timestamps are rewritten.
    const local: ConceptMapping = {
      ...mapping,
      id: crypto.randomUUID(),
      projectId: targetProjectId,
      sourceConceptId: options?.sourceConceptId ?? mapping.sourceConceptId,
      createdAt: now,
      updatedAt: now,
    }
    await getStorage().conceptMappings.create(local)
    set((s) => {
      s.mappingsById.set(local.id, local)
      return {
        mappings: [...s.mappings, local],
        mappingsVersion: s.mappingsVersion + 1,
        mappingsStructureVersion: s.mappingsStructureVersion + 1,
        _otherKeysLoadedFor: null,
        _otherDetailsLoadedFor: null,
      }
    })
    return local
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
