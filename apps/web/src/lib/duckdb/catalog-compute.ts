import {
  buildConceptCountQueries,
  buildConceptRankQuery,
  buildCrossingEstimateQuery,
  buildCrossingQuery,
  buildPatientBoundsQuery,
  buildServiceListQuery,
  buildSizeQuery,
  buildTotalsQuery,
  variableColumn,
  type ConceptFilter,
  type CrossingQueryContext,
  type PatientRange,
} from './catalog-queries'
import { fillCatalogSql, type CatalogFill } from './catalog-sql-fill'
import {
  ageBucketLabels,
  catalogCounts,
  crossingId,
  crossingParamsKey,
  effectiveCrossings,
  OTHER_MODALITY,
  periodRange,
  SEX_MODALITIES,
} from '@/lib/data-catalog/config'
import type {
  CatalogConceptRow,
  CatalogCrossingResult,
  CatalogCrossingRow,
  CatalogGrandTotal,
  CatalogResultCache,
  CatalogVariableId,
  CatalogVariables,
  DataCatalog,
  PeriodGranularity,
} from '@/types'
import type { SchemaMapping } from '@/types/schema-mapping'
import { addKeys } from '@/lib/data-catalog/perturbation'
import { conceptRelations } from '@/lib/schema-classes/relations'

/*
 * The planning below has a Python twin the server runs a catalog with
 * (apps/api services/server_runs/catalog/compute.py): what a unit queries, how
 * its rows add into the run state, the cache a run writes. Change one, change
 * the other and regenerate the twin fixture (catalog-run-spec.twin.test.ts).
 */

export type ComputeStep = 'mounting' | 'building' | 'executing' | 'processing' | 'saving'

export interface ComputeProgress {
  step: ComputeStep
  /** 0–1 fraction within the current step (0 = just started, 1 = done). */
  fraction: number
  /** Human-readable label for the current sub-step. */
  detail?: string
}

/**
 * A query already routed to the right data source, returning every row, and
 * interrupted — not merely skipped — when the signal aborts.
 *
 * The entry points take this rather than a data-source id so the runner owns
 * the routing (and, in tests, can answer without DuckDB at all).
 */
export type CatalogQuery = (sql: string, signal?: AbortSignal) => Promise<Record<string, unknown>[]>

const MISSING_MAPPING = 'Cannot build catalog query: missing schema mapping (patient table, visit table, or concept dictionaries)'

/**
 * Concept modalities per query of a concept-level crossing. The cells are
 * exact whatever the split — every cell carries its concept, and each concept
 * falls in one chunk — so the chunks only bound a query's size.
 */
export const CONCEPT_CHUNK = 2000

/**
 * Event rows per patient slice. Below it the warehouse is counted in one go;
 * above, in slices of about this many rows, so no single query has to hold the
 * groups of billions of rows and a pause loses at most one slice.
 */
export const SLICE_EVENT_ROWS = 250_000_000
export const MAX_SLICES = 64

/** Strings in code-unit order, the same in every locale and on the server. */
const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/** What `orderModalities` needs of the variables. */
export interface CatalogModalityPlan {
  age?: string[]
  sex?: boolean
  period?: { granularity: PeriodGranularity; step: number }
  service?: boolean
  concept?: boolean
}

/**
 * Every query a run may send, as templates (`catalog-queries.ts`), and what
 * planning the units from their results needs of the catalog. The same in both
 * modes: the server's run spec is this, its SQL with the class relations in.
 */
export interface CatalogPlan {
  sizeSql: string
  /** Null without a patient relation: the warehouse is then counted in one go. */
  boundsSql: string | null
  sliceRows: number
  maxSlices: number
  conceptChunk: number
  conceptCounts: { dictKey: string; sql: string }[]
  totalsSql: string
  /** The ranking a top-N service grouping keeps its services from, when a crossing uses them. */
  serviceRankSql: string | null
  /** The concept modalities with their patients, when a crossing uses the concept. */
  conceptRankSql: string | null
  /** Every crossing a run computes (`effectiveCrossings`), in order. Null SQL: nothing to query. */
  crossings: { variables: CatalogVariableId[]; sql: string | null }[]
  /** The dictionaries' keys, in the order the concept tokens number them. */
  dictKeys: string[]
  concept: {
    level: 'concept' | 'category' | 'subcategory'
    scope: 'all' | 'top'
    topN: number
    categoryColumn: boolean
    subcategoryColumn: boolean
  } | null
  service: { grouping: 'all' | 'top' | 'manual'; topN: number } | null
  /** The concept list counts visits. */
  visits: boolean
  modalities: CatalogModalityPlan
}

export function modalityPlanOf(variables: CatalogVariables): CatalogModalityPlan {
  return {
    ...(variables.age?.enabled ? { age: ageBucketLabels(variables.age.brackets) } : {}),
    ...(variables.sex?.enabled ? { sex: true } : {}),
    ...(variables.period?.enabled ? { period: { granularity: variables.period.granularity, step: variables.period.step ?? 1 } } : {}),
    ...(variables.service?.enabled ? { service: true } : {}),
    ...(variables.concept?.enabled ? { concept: true } : {}),
  }
}

/**
 * A catalog's plan on a mapping. `tables`: what the database has, so sizing
 * leaves out an event on a missing table.
 */
export function compileCatalogPlan(
  catalog: Pick<DataCatalog, 'variables' | 'crossings' | 'counts' | 'dataSourceId'>,
  mapping: SchemaMapping,
  tables?: readonly string[] | null,
  { sliceRows = SLICE_EVENT_ROWS, conceptChunk = CONCEPT_CHUNK }: { sliceRows?: number; conceptChunk?: number } = {},
): CatalogPlan {
  const variables = catalog.variables
  const cfg = variables.concept
  const counts = catalogCounts(catalog)
  const sizeSql = buildSizeQuery(mapping, tables)
  const conceptCounts = buildConceptCountQueries(mapping, cfg?.categoryColumn, cfg?.subcategoryColumn, counts.visits, catalog.dataSourceId)
  const totalsSql = buildTotalsQuery(mapping, counts, catalog.dataSourceId)
  if (!sizeSql || !conceptCounts || !totalsSql) throw new Error(MISSING_MAPPING)

  const crossings = effectiveCrossings(catalog)
  const used = new Set(crossings.flat())
  const service = variables.service
  const ctx: CrossingQueryContext = { mapping, variables, counts, keySalt: catalog.dataSourceId }
  return {
    sizeSql,
    boundsSql: buildPatientBoundsQuery(mapping),
    sliceRows,
    maxSlices: MAX_SLICES,
    conceptChunk,
    conceptCounts: conceptCounts.map(({ dictKey, sql }) => ({ dictKey, sql })),
    totalsSql,
    serviceRankSql: used.has('service') && service?.grouping === 'top' ? buildServiceListQuery(mapping, service.level) : null,
    conceptRankSql: used.has('concept') && cfg ? buildConceptRankQuery(mapping, cfg) : null,
    crossings: crossings.map((vars) => ({ variables: vars, sql: crossingId(vars) === 'concept' ? null : buildCrossingQuery(ctx, vars) })),
    dictKeys: conceptRelations(mapping).map((d) => d.key ?? ''),
    concept: cfg
      ? { level: cfg.level, scope: cfg.scope, topN: cfg.topN, categoryColumn: !!cfg.categoryColumn, subcategoryColumn: !!cfg.subcategoryColumn }
      : null,
    service: service ? { grouping: service.grouping, topN: service.topN } : null,
    visits: counts.visits,
    modalities: modalityPlanOf(variables),
  }
}

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

/**
 * The steps of a run, in order. Every one but `sizing` is a list of units —
 * one query each — and every unit adds its counts into the run state, so a
 * resume carries on at the next unit with nothing redone.
 */
export type CatalogRunStep = 'sizing' | 'concepts' | 'totals' | 'ranking' | 'crossings'
export const CATALOG_RUN_STEPS: readonly CatalogRunStep[] = ['sizing', 'concepts', 'totals', 'ranking', 'crossings']

/** What a unit is working on, for the progress line. */
export interface CatalogUnitInfo {
  step: CatalogRunStep
  /** The crossing's variables, a dictionary key, or what is ranked. */
  crossing?: CatalogVariableId[]
  dictionary?: string
  ranked?: 'service' | 'concept'
  /** Concept chunk of a crossing, 1-based. */
  chunk?: [number, number]
  /** Patient slice, 1-based; absent when the warehouse is counted in one go. */
  slice?: [number, number]
}

export type SerializedRange = { lo?: string | number; hi?: string | number }

/** Everything a run has counted so far, merged unit by unit. */
export interface CatalogRunState {
  slices: SerializedRange[]
  concepts: Map<string, CatalogConceptRow>
  totals: CatalogGrandTotal
  serviceRank: Map<string, number>
  conceptRank: Map<string, { patients: number; records: number }>
  crossings: Map<string, { variables: CatalogVariableId[]; cells: Map<string, CatalogCrossingRow> }>
}

export function emptyRunState(): CatalogRunState {
  return {
    slices: [{}],
    concepts: new Map(),
    totals: { totalPatients: 0, totalVisits: 0, totalRecords: 0 },
    serviceRank: new Map(),
    conceptRank: new Map(),
    crossings: new Map(),
  }
}

const SEP = '\u0001'
const conceptKey = (r: Pick<CatalogConceptRow, 'dictionaryKey' | 'conceptId'>) => `${r.dictionaryKey ?? ''}${SEP}${r.conceptId}`

/** Add one query's cells into a crossing: disjoint patients add up, disjoint concept chunks append. */
function mergeCells(into: Map<string, CatalogCrossingRow>, rows: readonly CatalogCrossingRow[]): void {
  for (const row of rows) {
    const key = row.values.join(SEP)
    const prev = into.get(key)
    if (!prev) { into.set(key, { ...row }); continue }
    prev.patients += row.patients
    if (row.stays != null) prev.stays = (prev.stays ?? 0) + row.stays
    if (row.unitStays != null) prev.unitStays = (prev.unitStays ?? 0) + row.unitStays
    if (row.records != null) prev.records = (prev.records ?? 0) + row.records
    prev.key = addKeys(prev.key, row.key)
  }
}

const INVALID_RESUME = 'Cannot resume this catalog: its saved run state is invalid. Reset the results to compute it again.'

/**
 * Anyone with catalog:write can store a run state, and a resume then runs under the
 * resuming user's login: what it hands to the SQL builders is what a run saves, scalars only.
 */
function checkResumeState(cache: CatalogResultCache): void {
  const isBound = (v: unknown) => v == null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))
  const isCount = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
  const { work, completedSteps } = cache
  const valid = (completedSteps == null || (Number.isInteger(completedSteps) && completedSteps >= 0))
    && (work?.slices == null || (Array.isArray(work.slices) && work.slices.every((s) => s != null && typeof s === 'object' && isBound(s.lo) && isBound(s.hi))))
    && (work?.services == null || (Array.isArray(work.services) && work.services.every((r) => Array.isArray(r) && typeof r[0] === 'string' && isCount(r[1]))))
    && (work?.concepts == null || (Array.isArray(work.concepts) && work.concepts.every((r) => Array.isArray(r) && typeof r[0] === 'string' && isCount(r[1]) && isCount(r[2]))))
  if (!valid) throw new Error(INVALID_RESUME)
}

export function stateFromCache(cache: CatalogResultCache): CatalogRunState {
  checkResumeState(cache)
  const state = emptyRunState()
  state.slices = cache.work?.slices?.map(({ lo, hi }) => ({ ...(lo != null ? { lo } : {}), ...(hi != null ? { hi } : {}) })) ?? [{}]
  for (const r of cache.concepts) state.concepts.set(conceptKey(r), { ...r })
  state.totals = { ...cache.grandTotal }
  for (const [name, patients] of cache.work?.services ?? []) state.serviceRank.set(name, patients)
  for (const [key, patients, records] of cache.work?.concepts ?? []) state.conceptRank.set(key, { patients, records })
  for (const c of cache.crossings ?? []) {
    const cells = new Map<string, CatalogCrossingRow>()
    mergeCells(cells, c.rows)
    state.crossings.set(c.id, { variables: c.variables, cells })
  }
  return state
}

/** The state as a cache, crossings in the plan's order. */
export function cacheFromState(
  base: Pick<CatalogResultCache, 'catalogId' | 'computedAt' | 'durationMs'> & Partial<CatalogResultCache>,
  state: CatalogRunState,
  order: readonly CatalogVariableId[][],
  completedSteps: number,
): CatalogResultCache {
  const concepts = [...state.concepts.values()]
  const crossings: CatalogCrossingResult[] = []
  for (const vars of order) {
    const c = state.crossings.get(crossingId(vars))
    if (c) crossings.push({ id: crossingId(vars), variables: c.variables, rows: [...c.cells.values()] })
  }
  return {
    modalities: {},
    ...base,
    concepts,
    grandTotal: state.totals,
    totalConcepts: concepts.length,
    totalPatients: state.totals.totalPatients,
    totalVisits: state.totals.totalVisits,
    crossings,
    completedSteps,
    work: {
      slices: state.slices,
      services: [...state.serviceRank],
      concepts: [...state.conceptRank].map(([k, v]) => [k, v.patients, v.records] as [string, number, number]),
    },
  }
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

function serializeBound(v: unknown): string | number {
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString()
  if (typeof v === 'number') return v
  return String(v)
}

/** How many slices a warehouse of this size is counted in. */
export function slicesWanted(sizeRows: readonly Record<string, unknown>[], sliceRows: number, maxSlices = MAX_SLICES): number {
  const eventRows = Number(sizeRows[0]?.event_rows ?? 0)
  return Math.min(maxSlices, Math.ceil(eventRows / sliceRows))
}

/** The slices between the bounds the bounds query returned. */
export function slicesFromBounds(boundRows: readonly Record<string, unknown>[]): SerializedRange[] {
  const bounds = boundRows.map((r) => serializeBound(r.b))
  if (bounds.length === 0) return [{}]
  return [...bounds, undefined].map((hi, i) => ({
    ...(i > 0 ? { lo: bounds[i - 1] } : {}),
    ...(hi != null ? { hi } : {}),
  }))
}

/**
 * The patient slices a warehouse is counted in: one, the whole warehouse,
 * unless its events run past `sliceRows`.
 */
export async function planSlices(
  mapping: SchemaMapping,
  query: CatalogQuery,
  signal?: AbortSignal,
  sliceRows = SLICE_EVENT_ROWS,
  tables?: readonly string[] | null,
): Promise<SerializedRange[]> {
  const sizeSql = buildSizeQuery(mapping, tables)
  if (!sizeSql) throw new Error(MISSING_MAPPING)
  return planCatalogSlices({ sizeSql, boundsSql: buildPatientBoundsQuery(mapping), sliceRows, maxSlices: MAX_SLICES }, query, signal)
}

/** The same, from a plan's templates. */
export async function planCatalogSlices(
  plan: Pick<CatalogPlan, 'sizeSql' | 'boundsSql' | 'sliceRows' | 'maxSlices'>,
  query: CatalogQuery,
  signal?: AbortSignal,
): Promise<SerializedRange[]> {
  const wanted = slicesWanted(await query(plan.sizeSql, signal), plan.sliceRows, plan.maxSlices)
  if (wanted < 2 || !plan.boundsSql) return [{}]
  return slicesFromBounds(await query(fillCatalogSql(plan.boundsSql, { slices: wanted }), signal))
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/**
 * One unit as data: its query, and how its rows add into the run state. `sql`
 * is null for a unit that only rearranges counts already made.
 */
export interface CatalogRunUnit {
  info: CatalogUnitInfo
  sql: string | null
  apply: (state: CatalogRunState, rows: readonly Record<string, unknown>[]) => void
}

/** Run one unit through `query` and add its rows in. */
export async function runUnit(unit: CatalogRunUnit, state: CatalogRunState, query: CatalogQuery, signal?: AbortSignal): Promise<void> {
  unit.apply(state, unit.sql ? await query(unit.sql, signal) : [])
}

const sliceOf = (slices: readonly SerializedRange[], i: number): [number, number] | undefined =>
  slices.length > 1 ? [i + 1, slices.length] : undefined
const rangeOf = (s: SerializedRange): PatientRange | null => (s.lo == null && s.hi == null ? null : s)

/**
 * The counts that come before the crossings: the concept list, the totals,
 * and the rankings the crossings are planned from (top services, concepts in
 * scope). Step by step, each over every slice.
 */
export function baseUnits(plan: CatalogPlan, slices: readonly SerializedRange[]): CatalogRunUnit[] {
  const cfg = plan.concept
  const units: CatalogRunUnit[] = []

  slices.forEach((s, i) => {
    for (const q of plan.conceptCounts) {
      units.push({
        info: { step: 'concepts', dictionary: q.dictKey, slice: sliceOf(slices, i) },
        sql: fillCatalogSql(q.sql, { range: rangeOf(s) }),
        apply: (state, rows) => {
          for (const row of rows) {
            const r: CatalogConceptRow = {
              conceptId: row.concept_id as number | string,
              conceptName: row.concept_name as string,
              dictionaryKey: row.dictionary_key as string | undefined,
              category: cfg?.categoryColumn ? (row.concept_category as string | null) ?? null : undefined,
              subcategory: cfg?.subcategoryColumn ? (row.concept_subcategory as string | null) ?? null : undefined,
              patientCount: Number(row.patient_count ?? 0),
              recordCount: Number(row.record_count ?? 0),
              ...(plan.visits ? { visitCount: Number(row.visit_count ?? 0) } : {}),
              ...(row.patient_key != null ? { patientKey: Number(row.patient_key) } : {}),
            }
            const prev = state.concepts.get(conceptKey(r))
            if (!prev) { state.concepts.set(conceptKey(r), r); continue }
            prev.patientCount += r.patientCount
            prev.recordCount += r.recordCount
            if (r.visitCount != null) prev.visitCount = (prev.visitCount ?? 0) + r.visitCount
            prev.patientKey = addKeys(prev.patientKey, r.patientKey)
          }
        },
      })
    }
  })

  slices.forEach((s, i) => {
    units.push({
      info: { step: 'totals', slice: sliceOf(slices, i) },
      sql: fillCatalogSql(plan.totalsSql, { range: rangeOf(s) }),
      apply: (state, rows) => {
        const row = rows[0] ?? {}
        state.totals.totalPatients += Number(row.total_patients ?? 0)
        state.totals.totalVisits += Number(row.total_visits ?? 0)
        state.totals.totalRecords += Number(row.total_records ?? 0)
        if (row.total_unit_stays != null) state.totals.totalUnitStays = (state.totals.totalUnitStays ?? 0) + Number(row.total_unit_stays)
        if (row.total_key != null) state.totals.totalKey = addKeys(state.totals.totalKey, Number(row.total_key))
      },
    })
  })

  const { serviceRankSql, conceptRankSql } = plan
  if (serviceRankSql) {
    slices.forEach((s, i) => {
      units.push({
        info: { step: 'ranking', ranked: 'service', slice: sliceOf(slices, i) },
        sql: fillCatalogSql(serviceRankSql, { range: rangeOf(s) }),
        apply: (state, rows) => {
          for (const r of rows) {
            const name = String(r.svc)
            state.serviceRank.set(name, (state.serviceRank.get(name) ?? 0) + Number(r.patients ?? 0))
          }
        },
      })
    })
  }
  if (conceptRankSql) {
    slices.forEach((s, i) => {
      units.push({
        info: { step: 'ranking', ranked: 'concept', slice: sliceOf(slices, i) },
        sql: fillCatalogSql(conceptRankSql, { range: rangeOf(s) }),
        apply: (state, rows) => {
          for (const r of rows) {
            const key = String(r.concept)
            const prev = state.conceptRank.get(key) ?? { patients: 0, records: 0 }
            state.conceptRank.set(key, { patients: prev.patients + Number(r.patients ?? 0), records: prev.records + Number(r.records ?? 0) })
          }
        },
      })
    })
  }
  return units
}

/** Concept modality → (dictionary, id), the inverse of the SQL's modality expression. */
function conceptFilterOf(modalities: readonly string[], dictKeys: readonly string[]): ConceptFilter {
  const multi = dictKeys.length > 1
  const byDict = new Map<string, string[]>()
  for (const m of modalities) {
    const sep = multi ? m.indexOf(':') : -1
    const dictKey = multi ? m.slice(0, sep) : dictKeys[0]
    const id = multi ? m.slice(sep + 1) : m
    byDict.set(dictKey, [...(byDict.get(dictKey) ?? []), id])
  }
  return [...byDict].map(([dictKey, ids]) => ({ dictKey, ids }))
}

const byCountThenName = <T>(entries: [string, T][], count: (v: T) => number) =>
  entries.sort((a, b) => count(b[1]) - count(a[1]) || byCodeUnits(a[0], b[0]))

export interface CrossingPlan {
  /** The top services and the concept filter the crossings are filled with. */
  fill: CatalogFill
  crossings: CatalogVariableId[][]
  units: CatalogRunUnit[]
  labels: CatalogResultCache['labels']
}

/**
 * The crossing units, planned from the rankings in the state: the services a
 * top-N grouping keeps, the concepts in scope (whose ranking is also the
 * concept variable's 1-way marginal), and for each crossing one query per
 * concept chunk and patient slice.
 */
export function planCrossings(plan: CatalogPlan, state: CatalogRunState): CrossingPlan {
  const service = plan.service
  const topServices = service?.grouping === 'top'
    ? byCountThenName([...state.serviceRank], (p) => p).slice(0, Math.max(0, service.topN)).map(([name]) => name)
    : []

  const concept = plan.concept
  const dictKeys = plan.dictKeys
  const ranked = byCountThenName([...state.conceptRank], (v) => v.patients)
  const keepsTop = concept?.level === 'concept' && concept.scope === 'top'
  const kept = keepsTop ? ranked.slice(0, Math.max(0, concept.topN)) : ranked
  const conceptRows: CatalogCrossingRow[] = kept.map(([key, v]) => ({ values: [key], patients: v.patients, records: v.records }))
  const conceptFilter = keepsTop ? conceptFilterOf(conceptRows.map((r) => r.values[0]), dictKeys) : null

  const fill: CatalogFill = { topServices, conceptFilter, dictKeys }
  const slices = state.slices
  const units: CatalogRunUnit[] = []
  const chunkSize = plan.conceptChunk

  for (const { variables: vars, sql } of plan.crossings) {
    const id = crossingId(vars)
    if (id === 'concept') {
      units.push({
        info: { step: 'crossings', crossing: vars },
        sql: null,
        apply: (st) => { st.crossings.set(id, { variables: vars, cells: new Map(conceptRows.map((r) => [r.values.join(SEP), { ...r }])) }) },
      })
      continue
    }
    const chunks: (ConceptFilter | null)[] = vars.includes('concept') && concept?.level === 'concept' && conceptRows.length > chunkSize
      ? Array.from({ length: Math.ceil(conceptRows.length / chunkSize) }, (_, i) =>
        conceptFilterOf(conceptRows.slice(i * chunkSize, (i + 1) * chunkSize).map((r) => r.values[0]), dictKeys))
      : [null]
    chunks.forEach((chunk, c) => {
      slices.forEach((s, i) => {
        units.push({
          info: {
            step: 'crossings',
            crossing: vars,
            chunk: chunks.length > 1 ? [c + 1, chunks.length] : undefined,
            slice: sliceOf(slices, i),
          },
          sql: sql == null ? null : fillCatalogSql(sql, { ...fill, conceptFilter: chunk ?? conceptFilter, range: rangeOf(s) }),
          apply: (st, rows) => {
            const entry = st.crossings.get(id) ?? { variables: vars, cells: new Map() }
            mergeCells(entry.cells, rows.map((r) => crossingRow(vars, r)))
            st.crossings.set(id, entry)
          },
        })
      })
    })
  }

  let labels: CatalogResultCache['labels']
  if (plan.crossings.some((c) => c.variables.includes('concept')) && concept?.level === 'concept' && state.concepts.size) {
    const multi = dictKeys.length > 1
    const inScope = new Set(conceptRows.map((r) => r.values[0]))
    const names: Record<string, string> = {}
    for (const c of state.concepts.values()) {
      const key = multi ? `${c.dictionaryKey}:${c.conceptId}` : String(c.conceptId)
      if (inScope.has(key)) names[key] = c.conceptName
    }
    labels = { concept: names }
  }

  return { fill, crossings: plan.crossings.map((c) => c.variables), units, labels }
}

/** One cell of a crossing query, raw. */
function crossingRow(vars: CatalogVariableId[], r: Record<string, unknown>): CatalogCrossingRow {
  const row: CatalogCrossingRow = { values: vars.map((v) => String(r[variableColumn(v)])), patients: Number(r.patients ?? 0) }
  if (r.records != null) row.records = Number(r.records)
  if (r.stays != null) row.stays = Number(r.stays)
  if (r.unit_stays != null) row.unitStays = Number(r.unit_stays)
  if (r.cell_key != null) row.key = Number(r.cell_key)
  return row
}

/**
 * Display order of each variable's modalities, read off the 1-way marginals:
 * every period from the first to the last (gaps included, so a quiet month
 * still shows), services and concepts by patients with "Other" last. Exact
 * counts, masked cells included: a published output re-ranks them on what it
 * publishes (`publishedVariables`).
 */
export function orderModalities(
  modalities: CatalogModalityPlan,
  crossings: readonly CatalogCrossingResult[],
): CatalogResultCache['modalities'] {
  const marginal = (v: CatalogVariableId) => crossings.find((c) => c.id === v)?.rows ?? []
  const byPatients = (v: CatalogVariableId) =>
    [...marginal(v)]
      .sort((a, b) => Number(a.values[0] === OTHER_MODALITY) - Number(b.values[0] === OTHER_MODALITY) || b.patients - a.patients || byCodeUnits(a.values[0], b.values[0]))
      .map((r) => r.values[0])

  const out: CatalogResultCache['modalities'] = {}
  if (modalities.age) out.age = [...modalities.age]
  if (modalities.sex) {
    const present = new Set(marginal('sex').map((r) => r.values[0]))
    out.sex = SEX_MODALITIES.filter((s) => s !== 'other' || present.has(s))
  }
  if (modalities.period) {
    const periods = marginal('period').map((r) => r.values[0]).sort()
    out.period = periods.length ? periodRange(periods[0], periods[periods.length - 1], modalities.period.granularity, modalities.period.step) : []
  }
  if (modalities.service) out.service = byPatients('service')
  if (modalities.concept) out.concept = byPatients('concept')
  return out
}

// ---------------------------------------------------------------------------
// Yield estimate
// ---------------------------------------------------------------------------

export interface CrossingEstimate {
  cells: number
  published: number
  mass: number
  publishedMass: number
}

const estimates = new Map<string, CrossingEstimate>()

/**
 * Key of one crossing's estimate: the database, the parameters of the
 * variables it crosses, and the threshold — so changing an unrelated variable
 * keeps it.
 */
export function estimateKey(catalog: Pick<DataCatalog, 'dataSourceId' | 'variables' | 'anonymization'>, vars: readonly CatalogVariableId[]): string {
  return `${catalog.dataSourceId}|${crossingParamsKey(catalog.variables, vars)}|${catalog.anonymization.threshold}`
}

export function getCachedEstimate(key: string): CrossingEstimate | undefined {
  return estimates.get(key)
}

export interface EstimateProgress {
  done: number
  total: number
  /** What the query in flight is for: a ranking, or a crossing's variables. */
  current: CatalogVariableId[] | 'ranking' | null
}

/**
 * The estimates still to make: the rankings to run (over the whole warehouse),
 * then one query per crossing whose estimate is not `known`, its top services
 * and concept filter tokens filled from the rankings (`planCrossings`).
 */
export interface CatalogEstimatePlan {
  plan: CatalogPlan
  estimates: { variables: CatalogVariableId[]; key: string; sql: string }[]
}

/** Null when every crossing's estimate is known. */
export function compileEstimatePlan(
  catalog: DataCatalog,
  mapping: SchemaMapping,
  known: (key: string) => boolean = (key) => estimates.has(key),
): CatalogEstimatePlan | null {
  const todo = effectiveCrossings(catalog).filter((vars) => !known(estimateKey(catalog, vars)))
  if (todo.length === 0) return null
  const plan = compileCatalogPlan({ ...catalog, crossings: todo }, mapping)
  const ctx: CrossingQueryContext = { mapping, variables: catalog.variables, counts: catalogCounts(catalog), keySalt: catalog.dataSourceId }
  return {
    plan,
    estimates: todo.flatMap((vars) => {
      const sql = buildCrossingEstimateQuery(ctx, vars, catalog.anonymization.threshold)
      return sql ? [{ variables: vars, key: estimateKey(catalog, vars), sql }] : []
    }),
  }
}

/** The rankings an estimate runs first: one query each, over the whole warehouse. */
export function estimateRankingUnits(plan: CatalogPlan): CatalogRunUnit[] {
  return baseUnits(plan, [{}]).filter((u) => u.info.step === 'ranking')
}

export function estimateOfRow(rows: readonly Record<string, unknown>[]): CrossingEstimate {
  const row = rows[0] ?? {}
  return {
    cells: Number(row.cells ?? 0),
    published: Number(row.published ?? 0),
    mass: Number(row.mass ?? 0),
    publishedMass: Number(row.published_mass ?? 0),
  }
}

/**
 * Primary-suppression yield of each crossing: non-empty cells, those reaching
 * the threshold, and the patient mass of each. One aggregate query per
 * crossing — a whole crossing's worth of work on a large warehouse — so every
 * query is interrupted when `signal` aborts, and an estimate already made for
 * the same parameters is reused. In server mode the server runs the same plan
 * (services/server_runs/catalog, kind `catalog_estimate`).
 */
export async function estimateCrossings(
  catalog: DataCatalog,
  mapping: SchemaMapping,
  query: CatalogQuery,
  { onEstimate, onProgress, signal }: {
    onEstimate?: (id: string, estimate: CrossingEstimate) => void
    onProgress?: (progress: EstimateProgress) => void
    signal?: AbortSignal
  } = {},
): Promise<void> {
  const compiled = compileEstimatePlan(catalog, mapping)
  if (!compiled) return
  const state = emptyRunState()
  const ranking = estimateRankingUnits(compiled.plan)
  const total = ranking.length + compiled.estimates.length
  let done = 0
  for (const unit of ranking) {
    signal?.throwIfAborted()
    onProgress?.({ done, total, current: 'ranking' })
    await runUnit(unit, state, query, signal)
    done++
  }
  const { fill } = planCrossings(compiled.plan, state)
  for (const { variables, key, sql } of compiled.estimates) {
    signal?.throwIfAborted()
    onProgress?.({ done, total, current: variables })
    const estimate = estimateOfRow(await query(fillCatalogSql(sql, fill), signal))
    estimates.set(key, estimate)
    onEstimate?.(crossingId(variables), estimate)
    done++
  }
  onProgress?.({ done, total, current: null })
}
