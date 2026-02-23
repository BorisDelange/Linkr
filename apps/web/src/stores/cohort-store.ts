import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import { buildCohortCountSql, buildCohortResultsSql, buildAttritionQueries } from '@/lib/duckdb/cohort-query'
import * as engine from '@/lib/duckdb/engine'
import type {
  Cohort,
  CohortLevel,
  CriteriaGroupNode,
  CohortExecutionResult,
  AttritionStep,
  SchemaMapping,
} from '@/types'

// ---------------------------------------------------------------------------
// Migration: v1 flat criteria → v2 criteria tree
// ---------------------------------------------------------------------------

function migrateCohortIfNeeded(raw: Record<string, unknown>): Cohort {
  // Already v2
  if (typeof raw.schemaVersion === 'number' && raw.schemaVersion >= 2) {
    return raw as unknown as Cohort
  }

  // v1 → v2: wrap flat criteria[] in a root AND group
  const oldCriteria = (raw.criteria ?? []) as Array<{
    id: string
    type: string
    config: Record<string, unknown>
    exclude: boolean
  }>

  const children = oldCriteria.map((c) => ({
    kind: 'criterion' as const,
    id: c.id,
    type: c.type as Cohort['criteriaTree']['children'][number] extends { type: infer T } ? T : never,
    config: migrateConfig(c.type, c.config),
    exclude: c.exclude,
    enabled: true,
  }))

  return {
    id: raw.id as string,
    projectUid: raw.projectUid as string,
    name: (raw.name as string) ?? '',
    description: (raw.description as string) ?? '',
    level: (raw.level as CohortLevel) ?? 'patient',
    criteriaTree: {
      kind: 'group',
      id: crypto.randomUUID(),
      operator: 'AND',
      children,
      exclude: false,
      enabled: true,
    },
    customSql: null,
    resultCount: raw.resultCount as number | undefined,
    schemaVersion: 2,
    createdAt: (raw.createdAt as string) ?? new Date().toISOString(),
    updatedAt: (raw.updatedAt as string) ?? new Date().toISOString(),
  }
}

function migrateConfig(type: string, config: Record<string, unknown>): Cohort['criteriaTree']['children'][number] extends { config: infer C } ? C : never {
  if (type === 'age') {
    return {
      ageReference: 'admission' as const,
      min: config.min as number | undefined,
      max: config.max as number | undefined,
    } as never
  }
  // sex, period, duration, concept — configs are structurally compatible
  return config as never
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface CohortState {
  cohorts: Cohort[]
  cohortsLoaded: boolean

  // Transient execution state (not persisted to IDB)
  executionResults: Map<string, CohortExecutionResult>
  executionLoading: Map<string, boolean>

  loadCohorts: () => Promise<void>
  getProjectCohorts: (projectUid: string) => Cohort[]

  addCohort: (source: {
    projectUid: string
    name: string
    description: string
    level: CohortLevel
    criteriaTree?: CriteriaGroupNode
  }) => Promise<string>

  updateCohort: (id: string, changes: Partial<Cohort>) => Promise<void>
  removeCohort: (id: string) => Promise<void>
  setCustomSql: (id: string, sql: string | null) => Promise<void>

  executeCohort: (
    id: string,
    dataSourceId: string,
    schemaMapping?: SchemaMapping,
  ) => Promise<number>
}

function makeEmptyTree(): CriteriaGroupNode {
  return {
    kind: 'group',
    id: crypto.randomUUID(),
    operator: 'AND',
    children: [],
    exclude: false,
    enabled: true,
  }
}

export const useCohortStore = create<CohortState>((set, get) => ({
  cohorts: [],
  cohortsLoaded: false,
  executionResults: new Map(),
  executionLoading: new Map(),

  loadCohorts: async () => {
    const rawAll = await getStorage().cohorts.getAll()
    const migrated: Cohort[] = []
    for (const raw of rawAll) {
      const cohort = migrateCohortIfNeeded(raw as unknown as Record<string, unknown>)
      // Persist migration back to IDB if schema changed
      if (!(raw as Record<string, unknown>).schemaVersion || (raw as Record<string, unknown>).schemaVersion !== 2) {
        await getStorage().cohorts.update(cohort.id, cohort)
      }
      migrated.push(cohort)
    }
    set({ cohorts: migrated, cohortsLoaded: true })
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
      criteriaTree: source.criteriaTree ?? makeEmptyTree(),
      schemaVersion: 2,
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
    set((s) => ({
      cohorts: s.cohorts.filter((c) => c.id !== id),
      executionResults: (() => {
        const m = new Map(s.executionResults)
        m.delete(id)
        return m
      })(),
    }))
  },

  setCustomSql: async (id, sql) => {
    const changes: Partial<Cohort> = { customSql: sql }
    await getStorage().cohorts.update(id, changes)
    set((s) => ({
      cohorts: s.cohorts.map((c) =>
        c.id === id ? { ...c, customSql: sql, updatedAt: new Date().toISOString() } : c,
      ),
    }))
  },

  executeCohort: async (id, dataSourceId, schemaMapping) => {
    const cohort = get().cohorts.find((c) => c.id === id)
    if (!cohort || !schemaMapping) return 0

    // Mark loading
    set((s) => ({
      executionLoading: new Map(s.executionLoading).set(id, true),
    }))

    const startTime = Date.now()

    try {
      // Use custom SQL or auto-generated
      const countSql = cohort.customSql ?? buildCohortCountSql(cohort, schemaMapping)
      if (!countSql) return 0

      // Execute count
      const countResults = await engine.queryDataSource(dataSourceId, countSql)
      const totalCount = Number(countResults[0]?.cnt ?? 0)

      // Execute attrition (only for auto-generated SQL)
      let attrition: AttritionStep[] = []
      if (!cohort.customSql) {
        const attritionQueries = buildAttritionQueries(cohort, schemaMapping)
        let prevCount = 0
        for (const aq of attritionQueries) {
          const res = await engine.queryDataSource(dataSourceId, aq.sql)
          const count = Number(res[0]?.cnt ?? 0)
          attrition.push({
            nodeId: aq.nodeId,
            label: aq.label,
            count,
            excluded: aq.nodeId === '__total__' ? 0 : prevCount - count,
          })
          prevCount = count
        }
      }

      // Execute result rows (first page)
      let rows: Record<string, unknown>[] = []
      if (!cohort.customSql) {
        const resultsSql = buildCohortResultsSql(cohort, schemaMapping, 50, 0)
        if (resultsSql) {
          rows = await engine.queryDataSource(dataSourceId, resultsSql)
        }
      }

      const durationMs = Date.now() - startTime
      const result: CohortExecutionResult = {
        totalCount,
        attrition,
        rows,
        sql: countSql,
        executedAt: new Date().toISOString(),
        durationMs,
      }

      // Persist count + attrition to IDB
      await getStorage().cohorts.update(id, { resultCount: totalCount, attrition })

      set((s) => ({
        cohorts: s.cohorts.map((c) =>
          c.id === id ? { ...c, resultCount: totalCount, attrition } : c,
        ),
        executionResults: new Map(s.executionResults).set(id, result),
        executionLoading: new Map(s.executionLoading).set(id, false),
      }))

      return totalCount
    } catch (err) {
      set((s) => ({
        executionLoading: new Map(s.executionLoading).set(id, false),
      }))
      throw err
    }
  },
}))
