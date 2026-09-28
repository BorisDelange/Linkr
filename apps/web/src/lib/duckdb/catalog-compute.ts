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
  DataCatalog,
} from '@/types'
import type { SchemaMapping } from '@/types/schema-mapping'
import { addKeys } from '@/lib/data-catalog/perturbation'
import { conceptRelations } from '@/lib/schema-classes/relations'

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
const CONCEPT_CHUNK = 2000

/**
 * Event rows per patient slice. Below it the warehouse is counted in one go;
 * above, in slices of about this many rows, so no single query has to hold the
 * groups of billions of rows and a pause loses at most one slice.
 */
export const SLICE_EVENT_ROWS = 250_000_000
const MAX_SLICES = 64

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

type SerializedRange = { lo?: string | number; hi?: string | number }

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

export function stateFromCache(cache: CatalogResultCache): CatalogRunState {
  const state = emptyRunState()
  state.slices = cache.work?.slices ?? [{}]
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

/**
 * The patient slices a warehouse is counted in: one, the whole warehouse,
 * unless its events run past `SLICE_EVENT_ROWS`.
 */
export async function planSlices(mapping: SchemaMapping, query: CatalogQuery, signal?: AbortSignal): Promise<SerializedRange[]> {
  const sizeSql = buildSizeQuery(mapping)
  if (!sizeSql) throw new Error(MISSING_MAPPING)
  const size = (await query(sizeSql, signal))[0] ?? {}
  const eventRows = Number(size.event_rows ?? 0)
  const wanted = Math.min(MAX_SLICES, Math.ceil(eventRows / SLICE_EVENT_ROWS))
  if (wanted < 2) return [{}]
  const boundsSql = buildPatientBoundsQuery(mapping, wanted)
  const bounds = boundsSql ? (await query(boundsSql, signal)).map((r) => serializeBound(r.b)) : []
  if (bounds.length === 0) return [{}]
  return [...bounds, undefined].map((hi, i) => ({
    ...(i > 0 ? { lo: bounds[i - 1] } : {}),
    ...(hi != null ? { hi } : {}),
  }))
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export interface CatalogRunUnit {
  info: CatalogUnitInfo
  run: (state: CatalogRunState, signal: AbortSignal) => Promise<void>
}

const sliceOf = (slices: readonly SerializedRange[], i: number): [number, number] | undefined =>
  slices.length > 1 ? [i + 1, slices.length] : undefined
const rangeOf = (s: SerializedRange): PatientRange | null => (s.lo == null && s.hi == null ? null : s)

/**
 * The counts that come before the crossings: the concept list, the totals,
 * and the rankings the crossings are planned from (top services, concepts in
 * scope). Step by step, each over every slice.
 */
export function baseUnits(catalog: DataCatalog, mapping: SchemaMapping, query: CatalogQuery, slices: readonly SerializedRange[]): CatalogRunUnit[] {
  const cfg = catalog.variables.concept
  const counts = catalogCounts(catalog)
  const units: CatalogRunUnit[] = []

  slices.forEach((s, i) => {
    const queries = buildConceptCountQueries(mapping, cfg?.categoryColumn, cfg?.subcategoryColumn, rangeOf(s), counts.visits, catalog.dataSourceId)
    if (!queries) throw new Error(MISSING_MAPPING)
    for (const q of queries) {
      units.push({
        info: { step: 'concepts', dictionary: q.dictKey, slice: sliceOf(slices, i) },
        run: async (state, signal) => {
          for (const row of await query(q.sql, signal)) {
            const r: CatalogConceptRow = {
              conceptId: row.concept_id as number | string,
              conceptName: row.concept_name as string,
              dictionaryKey: row.dictionary_key as string | undefined,
              category: cfg?.categoryColumn ? (row.concept_category as string | null) ?? null : undefined,
              subcategory: cfg?.subcategoryColumn ? (row.concept_subcategory as string | null) ?? null : undefined,
              patientCount: Number(row.patient_count ?? 0),
              recordCount: Number(row.record_count ?? 0),
              ...(counts.visits ? { visitCount: Number(row.visit_count ?? 0) } : {}),
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
    const sql = buildTotalsQuery(mapping, rangeOf(s), counts, catalog.dataSourceId)
    if (!sql) throw new Error(MISSING_MAPPING)
    units.push({
      info: { step: 'totals', slice: sliceOf(slices, i) },
      run: async (state, signal) => {
        const row = (await query(sql, signal))[0] ?? {}
        state.totals.totalPatients += Number(row.total_patients ?? 0)
        state.totals.totalVisits += Number(row.total_visits ?? 0)
        state.totals.totalRecords += Number(row.total_records ?? 0)
        if (row.total_unit_stays != null) state.totals.totalUnitStays = (state.totals.totalUnitStays ?? 0) + Number(row.total_unit_stays)
        if (row.total_key != null) state.totals.totalKey = addKeys(state.totals.totalKey, Number(row.total_key))
      },
    })
  })

  const used = new Set(effectiveCrossings(catalog).flat())
  const service = catalog.variables.service
  if (used.has('service') && service?.grouping === 'top') {
    slices.forEach((s, i) => {
      const sql = buildServiceListQuery(mapping, service.level, rangeOf(s))
      if (!sql) return
      units.push({
        info: { step: 'ranking', ranked: 'service', slice: sliceOf(slices, i) },
        run: async (state, signal) => {
          for (const r of await query(sql, signal)) {
            const name = String(r.svc)
            state.serviceRank.set(name, (state.serviceRank.get(name) ?? 0) + Number(r.patients ?? 0))
          }
        },
      })
    })
  }
  if (used.has('concept') && cfg) {
    slices.forEach((s, i) => {
      const sql = buildConceptRankQuery(mapping, cfg, rangeOf(s))
      if (!sql) return
      units.push({
        info: { step: 'ranking', ranked: 'concept', slice: sliceOf(slices, i) },
        run: async (state, signal) => {
          for (const r of await query(sql, signal)) {
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
  entries.sort((a, b) => count(b[1]) - count(a[1]) || a[0].localeCompare(b[0]))

export interface CrossingPlan {
  ctx: CrossingQueryContext
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
export function planCrossings(catalog: DataCatalog, mapping: SchemaMapping, query: CatalogQuery, state: CatalogRunState): CrossingPlan {
  const variables = catalog.variables
  const crossings = effectiveCrossings(catalog)
  const service = variables.service
  const topServices = service?.grouping === 'top'
    ? byCountThenName([...state.serviceRank], (p) => p).slice(0, Math.max(0, service.topN)).map(([name]) => name)
    : []

  const concept = variables.concept
  const dictKeys = conceptRelations(mapping).map((d) => d.key ?? '')
  const ranked = byCountThenName([...state.conceptRank], (v) => v.patients)
  const kept = concept?.level === 'concept' && concept.scope === 'top' ? ranked.slice(0, Math.max(0, concept.topN)) : ranked
  const conceptRows: CatalogCrossingRow[] = kept.map(([key, v]) => ({ values: [key], patients: v.patients, records: v.records }))
  const conceptFilter = concept?.level === 'concept' && concept.scope === 'top' ? conceptFilterOf(conceptRows.map((r) => r.values[0]), dictKeys) : null

  const ctx: CrossingQueryContext = { mapping, variables, topServices, conceptFilter, counts: catalogCounts(catalog), keySalt: catalog.dataSourceId }
  const slices = state.slices
  const units: CatalogRunUnit[] = []
  const queryUnit = (vars: CatalogVariableId[], info: CatalogUnitInfo, unitCtx: CrossingQueryContext): CatalogRunUnit => ({
    info,
    run: async (st, signal) => {
      const rows = await runCrossingQuery(unitCtx, vars, query, signal)
      const id = crossingId(vars)
      const entry = st.crossings.get(id) ?? { variables: vars, cells: new Map() }
      mergeCells(entry.cells, rows)
      st.crossings.set(id, entry)
    },
  })

  for (const vars of crossings) {
    const id = crossingId(vars)
    if (id === 'concept') {
      units.push({
        info: { step: 'crossings', crossing: vars },
        run: async (st) => { st.crossings.set(id, { variables: vars, cells: new Map(conceptRows.map((r) => [r.values.join(SEP), { ...r }])) }) },
      })
      continue
    }
    const chunks: (ConceptFilter | null)[] = vars.includes('concept') && concept?.level === 'concept' && conceptRows.length > CONCEPT_CHUNK
      ? Array.from({ length: Math.ceil(conceptRows.length / CONCEPT_CHUNK) }, (_, i) =>
        conceptFilterOf(conceptRows.slice(i * CONCEPT_CHUNK, (i + 1) * CONCEPT_CHUNK).map((r) => r.values[0]), dictKeys))
      : [null]
    chunks.forEach((chunk, c) => {
      slices.forEach((s, i) => {
        units.push(queryUnit(vars, {
          step: 'crossings',
          crossing: vars,
          chunk: chunks.length > 1 ? [c + 1, chunks.length] : undefined,
          slice: sliceOf(slices, i),
        }, { ...ctx, conceptFilter: chunk ?? conceptFilter, range: rangeOf(s) }))
      })
    })
  }

  let labels: CatalogResultCache['labels']
  if (crossings.some((c) => c.includes('concept')) && concept?.level === 'concept' && state.concepts.size) {
    const multi = dictKeys.length > 1
    const inScope = new Set(conceptRows.map((r) => r.values[0]))
    const names: Record<string, string> = {}
    for (const c of state.concepts.values()) {
      const key = multi ? `${c.dictionaryKey}:${c.conceptId}` : String(c.conceptId)
      if (inScope.has(key)) names[key] = c.conceptName
    }
    labels = { concept: names }
  }

  return { ctx, crossings, units, labels }
}

/** The cells of one crossing query, raw. */
async function runCrossingQuery(ctx: CrossingQueryContext, vars: CatalogVariableId[], query: CatalogQuery, signal?: AbortSignal): Promise<CatalogCrossingRow[]> {
  const sql = buildCrossingQuery(ctx, vars)
  if (!sql) return []
  return (await query(sql, signal)).map((r) => {
    const row: CatalogCrossingRow = { values: vars.map((v) => String(r[variableColumn(v)])), patients: Number(r.patients ?? 0) }
    if (r.records != null) row.records = Number(r.records)
    if (r.stays != null) row.stays = Number(r.stays)
    if (r.unit_stays != null) row.unitStays = Number(r.unit_stays)
    if (r.cell_key != null) row.key = Number(r.cell_key)
    return row
  })
}

/**
 * Display order of each variable's modalities, read off the 1-way marginals:
 * every period from the first to the last (gaps included, so a quiet month
 * still shows), services and concepts by patients with "Other" last. Exact
 * counts, masked cells included: a published output re-ranks them on what it
 * publishes (`publishedVariables`).
 */
export function orderModalities(
  catalog: Pick<DataCatalog, 'variables'>,
  crossings: readonly CatalogCrossingResult[],
): CatalogResultCache['modalities'] {
  const marginal = (v: CatalogVariableId) => crossings.find((c) => c.id === v)?.rows ?? []
  const byPatients = (v: CatalogVariableId) =>
    [...marginal(v)]
      .sort((a, b) => Number(a.values[0] === OTHER_MODALITY) - Number(b.values[0] === OTHER_MODALITY) || b.patients - a.patients || a.values[0].localeCompare(b.values[0]))
      .map((r) => r.values[0])

  const out: CatalogResultCache['modalities'] = {}
  const { variables } = catalog
  if (variables.age?.enabled) out.age = ageBucketLabels(variables.age.brackets)
  if (variables.sex?.enabled) {
    const present = new Set(marginal('sex').map((r) => r.values[0]))
    out.sex = SEX_MODALITIES.filter((s) => s !== 'other' || present.has(s))
  }
  if (variables.period?.enabled) {
    const periods = marginal('period').map((r) => r.values[0]).sort()
    out.period = periods.length ? periodRange(periods[0], periods[periods.length - 1], variables.period.granularity, variables.period.step ?? 1) : []
  }
  if (variables.service?.enabled) out.service = byPatients('service')
  if (variables.concept?.enabled) out.concept = byPatients('concept')
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
 * Primary-suppression yield of each crossing: non-empty cells, those reaching
 * the threshold, and the patient mass of each. One aggregate query per
 * crossing — a whole crossing's worth of work on a large warehouse — so every
 * query is interrupted when `signal` aborts, and an estimate already made for
 * the same parameters is reused.
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
  const todo = effectiveCrossings(catalog).filter((vars) => !estimates.has(estimateKey(catalog, vars)))
  if (todo.length === 0) return
  const scoped = { ...catalog, crossings: todo }
  const state = emptyRunState()
  const ranking = baseUnits(scoped, mapping, query, [{}]).filter((u) => u.info.step === 'ranking')
  const total = ranking.length + todo.length
  let done = 0
  for (const unit of ranking) {
    signal?.throwIfAborted()
    onProgress?.({ done, total, current: 'ranking' })
    await unit.run(state, signal ?? new AbortController().signal)
    done++
  }
  const plan = planCrossings(scoped, mapping, query, state)
  for (const vars of todo) {
    signal?.throwIfAborted()
    onProgress?.({ done, total, current: vars })
    const sql = buildCrossingEstimateQuery(plan.ctx, vars, catalog.anonymization.threshold)
    if (sql) {
      const row = (await query(sql, signal))[0] ?? {}
      const estimate: CrossingEstimate = {
        cells: Number(row.cells ?? 0),
        published: Number(row.published ?? 0),
        mass: Number(row.mass ?? 0),
        publishedMass: Number(row.published_mass ?? 0),
      }
      estimates.set(estimateKey(catalog, vars), estimate)
      onEstimate?.(crossingId(vars), estimate)
    }
    done++
  }
  onProgress?.({ done, total, current: null })
}
