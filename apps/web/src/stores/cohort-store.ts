import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import { buildCohortQuery } from '@/lib/duckdb/cohort-query'
import * as engine from '@/lib/duckdb/engine'
import type { Cohort, CohortCriteria, CohortLevel, SchemaMapping } from '@/types'

interface CohortState {
  cohorts: Cohort[]
  cohortsLoaded: boolean

  loadCohorts: () => Promise<void>
  getProjectCohorts: (projectUid: string) => Cohort[]

  addCohort: (source: {
    projectUid: string
    name: string
    description: string
    level: CohortLevel
    criteria: CohortCriteria[]
  }) => Promise<string>

  updateCohort: (id: string, changes: Partial<Cohort>) => Promise<void>
  removeCohort: (id: string) => Promise<void>
  executeCohort: (id: string, dataSourceId: string, schemaMapping?: SchemaMapping) => Promise<number>
}

export const useCohortStore = create<CohortState>((set, get) => ({
  cohorts: [],
  cohortsLoaded: false,

  loadCohorts: async () => {
    const all = await getStorage().cohorts.getAll()
    set({ cohorts: all, cohortsLoaded: true })
  },

  getProjectCohorts: (projectUid) =>
    get().cohorts.filter((c) => c.projectUid === projectUid),

  addCohort: async (source) => {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const newCohort: Cohort = {
      id,
      projectUid: source.projectUid,
      name: source.name,
      description: source.description,
      level: source.level,
      criteria: source.criteria,
      createdAt: now,
      updatedAt: now,
    }
    await getStorage().cohorts.create(newCohort)
    set((s) => ({ cohorts: [...s.cohorts, newCohort] }))
    return id
  },

  updateCohort: async (id, changes) => {
    await getStorage().cohorts.update(id, changes)
    set((s) => ({
      cohorts: s.cohorts.map((c) =>
        c.id === id ? { ...c, ...changes, updatedAt: new Date().toISOString() } : c,
      ),
    }))
  },

  removeCohort: async (id) => {
    await getStorage().cohorts.delete(id)
    set((s) => ({ cohorts: s.cohorts.filter((c) => c.id !== id) }))
  },

  executeCohort: async (id, dataSourceId, schemaMapping) => {
    const cohort = get().cohorts.find((c) => c.id === id)
    if (!cohort || !schemaMapping) return 0
    const sql = buildCohortQuery(cohort, schemaMapping)
    if (!sql) return 0
    const results = await engine.queryDataSource(dataSourceId, sql)
    const count = Number(results[0]?.cnt ?? 0)
    await getStorage().cohorts.update(id, { resultCount: count })
    set((s) => ({
      cohorts: s.cohorts.map((c) =>
        c.id === id ? { ...c, resultCount: count } : c,
      ),
    }))
    return count
  },
}))
