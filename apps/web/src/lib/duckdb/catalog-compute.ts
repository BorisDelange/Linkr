import {
  buildConceptListQueries,
  buildConceptRankQuery,
  buildCrossingEstimateQuery,
  buildCrossingQuery,
  buildServiceListQuery,
  buildTotalsQuery,
  variableColumn,
  type ConceptFilter,
  type CrossingQueryContext,
} from './catalog-queries'
import {
  ageBucketLabels,
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
 * A query that has already been routed to the right data source.
 *
 * The entry points take this rather than a data-source id so the runner owns
 * the routing (and, in tests, can answer without DuckDB at all).
 */
export type CatalogQuery = (sql: string) => Promise<Record<string, unknown>[]>

const MISSING_MAPPING = 'Cannot build catalog query: missing schema mapping (patient table, visit table, or concept dictionaries)'

/**
 * Concept modalities per query of a concept-level crossing. The cells are
 * exact whatever the split — every cell carries its concept, and each concept
 * falls in one chunk — so the chunks only make a long crossing resumable.
 */
const CONCEPT_CHUNK = 2000

// ---------------------------------------------------------------------------
// Concept list and totals
// ---------------------------------------------------------------------------

/** One row per concept with its exact patient, record and visit counts. */
export async function computeConceptList(
  catalog: DataCatalog,
  mapping: SchemaMapping,
  query: CatalogQuery,
  signal?: AbortSignal,
): Promise<CatalogConceptRow[]> {
  const cfg = catalog.variables.concept
  const queries = buildConceptListQueries(mapping, cfg?.categoryColumn, cfg?.subcategoryColumn)
  if (!queries) throw new Error(MISSING_MAPPING)

  const concepts: CatalogConceptRow[] = []
  for (const clq of queries.conceptListQueries) {
    if (signal?.aborted) break
    const ids = (await query(clq.sql)).map((r) => r.cid as string | number)
    if (ids.length === 0) continue
    const template = queries.batchTemplates.find((t) => t.dictKey === clq.dictKey)!
    for (const row of await query(template.buildSql(ids))) {
      concepts.push({
        conceptId: row.concept_id as number | string,
        conceptName: row.concept_name as string,
        dictionaryKey: row.dictionary_key as string | undefined,
        category: cfg?.categoryColumn ? (row.concept_category as string | null) ?? null : undefined,
        subcategory: cfg?.subcategoryColumn ? (row.concept_subcategory as string | null) ?? null : undefined,
        patientCount: Number(row.patient_count ?? 0),
        recordCount: Number(row.record_count ?? 0),
        visitCount: Number(row.visit_count ?? 0),
      })
    }
  }
  return concepts
}

export async function computeTotals(mapping: SchemaMapping, query: CatalogQuery): Promise<CatalogGrandTotal> {
  const sql = buildTotalsQuery(mapping)
  if (!sql) throw new Error(MISSING_MAPPING)
  const row = (await query(sql))[0] ?? {}
  return {
    totalPatients: Number(row.total_patients ?? 0),
    totalVisits: Number(row.total_visits ?? 0),
    totalRecords: Number(row.total_records ?? 0),
  }
}

// ---------------------------------------------------------------------------
// Crossing plan
// ---------------------------------------------------------------------------

/** One query's worth of a run: a crossing, or one concept chunk of it. */
export interface CrossingUnit {
  crossingId: string
  variables: CatalogVariableId[]
  conceptFilter?: ConceptFilter
  /** The concept 1-way marginal, already known from the plan's ranking query. */
  precomputed?: CatalogCrossingRow[]
  /** For the progress line: 'period-age', 'concept-period (3/7)'. */
  label: string
}

export interface CrossingPlan {
  ctx: CrossingQueryContext
  crossings: CatalogVariableId[][]
  units: CrossingUnit[]
  labels: CatalogResultCache['labels']
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

/**
 * Resolve everything the crossings need before the first one runs: the
 * services a top-N grouping keeps, the concepts in scope (ranked by patients —
 * which is also the concept variable's 1-way marginal), and the unit list.
 */
export async function planCrossings(
  catalog: DataCatalog,
  mapping: SchemaMapping,
  query: CatalogQuery,
  concepts: readonly CatalogConceptRow[] = [],
): Promise<CrossingPlan> {
  const variables = catalog.variables
  const crossings = effectiveCrossings(catalog)
  const used = new Set(crossings.flat())

  let topServices: string[] = []
  const service = variables.service
  if (used.has('service') && service?.grouping === 'top') {
    const sql = buildServiceListQuery(mapping, service.level)
    if (sql) topServices = (await query(sql)).slice(0, Math.max(0, service.topN)).map((r) => String(r.svc))
  }

  let conceptRows: CatalogCrossingRow[] = []
  let conceptFilter: ConceptFilter | null = null
  const concept = variables.concept
  const dictKeys = conceptRelations(mapping).map((d) => d.key ?? '')
  if (used.has('concept') && concept) {
    const sql = buildConceptRankQuery(mapping, concept)
    const ranked = sql ? await query(sql) : []
    const kept = concept.level === 'concept' && concept.scope === 'top' ? ranked.slice(0, Math.max(0, concept.topN)) : ranked
    conceptRows = kept.map((r) => ({ values: [String(r.concept)], patients: Number(r.patients ?? 0), records: Number(r.records ?? 0) }))
    if (concept.level === 'concept' && concept.scope === 'top') conceptFilter = conceptFilterOf(conceptRows.map((r) => r.values[0]), dictKeys)
  }

  const ctx: CrossingQueryContext = { mapping, variables, topServices, conceptFilter }

  const units: CrossingUnit[] = []
  for (const vars of crossings) {
    const id = crossingId(vars)
    if (id === 'concept') {
      units.push({ crossingId: id, variables: vars, precomputed: conceptRows, label: id })
    } else if (vars.includes('concept') && concept?.level === 'concept' && conceptRows.length > CONCEPT_CHUNK) {
      const chunks = Math.ceil(conceptRows.length / CONCEPT_CHUNK)
      for (let i = 0; i < chunks; i++) {
        const slice = conceptRows.slice(i * CONCEPT_CHUNK, (i + 1) * CONCEPT_CHUNK).map((r) => r.values[0])
        units.push({ crossingId: id, variables: vars, conceptFilter: conceptFilterOf(slice, dictKeys), label: `${id} (${i + 1}/${chunks})` })
      }
    } else {
      units.push({ crossingId: id, variables: vars, label: id })
    }
  }

  let labels: CatalogResultCache['labels']
  if (used.has('concept') && concept?.level === 'concept' && concepts.length) {
    const multi = dictKeys.length > 1
    const inScope = new Set(conceptRows.map((r) => r.values[0]))
    const names: Record<string, string> = {}
    for (const c of concepts) {
      const key = multi ? `${c.dictionaryKey}:${c.conceptId}` : String(c.conceptId)
      if (inScope.has(key)) names[key] = c.conceptName
    }
    labels = { concept: names }
  }

  return { ctx, crossings, units, labels }
}

/** The cells of one unit, raw. */
export async function runCrossingUnit(plan: CrossingPlan, unit: CrossingUnit, query: CatalogQuery): Promise<CatalogCrossingRow[]> {
  if (unit.precomputed) return unit.precomputed
  const sql = buildCrossingQuery({ ...plan.ctx, conceptFilter: unit.conceptFilter ?? plan.ctx.conceptFilter }, unit.variables)
  if (!sql) return []
  const withConcept = unit.variables.includes('concept')
  return (await query(sql)).map((r) => ({
    values: unit.variables.map((v) => String(r[variableColumn(v)])),
    patients: Number(r.patients ?? 0),
    ...(withConcept ? { records: Number(r.records ?? 0) } : { stays: Number(r.stays ?? 0) }),
  }))
}

/**
 * Display order of each variable's modalities, read off the 1-way marginals:
 * every period from the first to the last (gaps included, so a quiet month
 * still shows), services and concepts by patients with "Other" last.
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
    out.period = periods.length ? periodRange(periods[0], periods[periods.length - 1], variables.period.granularity) : []
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

/**
 * Primary-suppression yield of each crossing a run would compute: non-empty
 * cells, those reaching the threshold, and the patient mass of each. One
 * aggregate query per crossing, skipped when its key is already cached.
 */
export async function estimateCrossings(
  catalog: DataCatalog,
  mapping: SchemaMapping,
  query: CatalogQuery,
  onEstimate?: (id: string, estimate: CrossingEstimate) => void,
  signal?: AbortSignal,
): Promise<void> {
  const todo = effectiveCrossings(catalog).filter((vars) => !estimates.has(estimateKey(catalog, vars)))
  if (todo.length === 0) return
  const plan = await planCrossings({ ...catalog, crossings: todo }, mapping, query)
  for (const vars of todo) {
    if (signal?.aborted) return
    const sql = buildCrossingEstimateQuery(plan.ctx, vars, catalog.anonymization.threshold)
    if (!sql) continue
    const row = (await query(sql))[0] ?? {}
    const estimate: CrossingEstimate = {
      cells: Number(row.cells ?? 0),
      published: Number(row.published ?? 0),
      mass: Number(row.mass ?? 0),
      publishedMass: Number(row.published_mass ?? 0),
    }
    estimates.set(estimateKey(catalog, vars), estimate)
    onEstimate?.(crossingId(vars), estimate)
  }
}
