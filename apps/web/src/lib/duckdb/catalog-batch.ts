/**
 * The batched catalog computation: the concept and dimension passes, then the
 * period table a page at a time, so a run can be paused and resumed.
 * `catalog-runner.ts` drives these in the app; the MCP server drives them too,
 * which is why this module takes an already-routed query and imports nothing
 * that needs a browser (no DuckDB engine, no storage).
 */
import {
  buildBatchedCatalogQueries,
  buildDateRangeQuery,
  buildServiceLabelsQuery,
  buildPeriodRowQuery,
  generatePeriodIntervals,
  type PeriodInterval,
} from './catalog-queries'
import type { DataCatalog, CatalogResultCache, CatalogConceptRow, CatalogDimensionRow, CatalogGrandTotal, CatalogPeriodRow } from '@/types'
import type { SchemaMapping } from '@/types/schema-mapping'

/**
 * A query that has already been routed to the right data source.
 *
 * The batched entry points take this rather than a data-source id so the runner
 * owns the routing (and, in tests, can answer without DuckDB at all).
 */
export type CatalogQuery = (sql: string) => Promise<Record<string, unknown>[]>

/** Everything the period walk needs, resolved once before the first batch. */
export interface PeriodPlan {
  catalog: DataCatalog
  mapping: SchemaMapping
  intervals: PeriodInterval[]
  ageBrackets: number[]
  serviceLabels: string[]
  conceptCategories: string[]
  threshold: number
}

/**
 * The concept rows, dimension margins and grand total — everything but periods.
 *
 * Returns a cache whose `periods` is still empty: the runner fills it in
 * batches, so this is the part a resume replays rather than the part it skips.
 */
export async function computeCatalogBase(
  catalog: DataCatalog,
  mapping: SchemaMapping,
  query: CatalogQuery,
  signal?: AbortSignal,
): Promise<CatalogResultCache> {
  const queries = buildBatchedCatalogQueries(
    mapping,
    catalog.dimensions,
    undefined,
    catalog.categoryColumn,
    catalog.subcategoryColumn,
  )
  if (!queries) {
    throw new Error('Cannot build catalog query: missing schema mapping (patient table, visit table, or concept dictionaries)')
  }

  const enabledDims = catalog.dimensions.filter((d) => d.enabled)
  const dimKeys = enabledDims.map((d) => `dim_${d.type}`)

  const concepts: CatalogConceptRow[] = []
  const dimensions: CatalogDimensionRow[] = []
  let grandTotal: CatalogGrandTotal = { totalPatients: 0, totalVisits: 0, totalRecords: 0 }

  for (const clq of queries.conceptListQueries) {
    if (signal?.aborted) break
    const idRows = await query(clq.sql)
    const allIds = idRows.map((r) => r.cid as string | number)
    if (allIds.length === 0) continue

    const template = queries.batchTemplates.find((t) => t.dictKey === clq.dictKey)!
    for (const row of await query(template.buildSql(allIds))) {
      concepts.push({
        conceptId: row.concept_id as number | string,
        conceptName: row.concept_name as string,
        dictionaryKey: row.dictionary_key as string | undefined,
        category: catalog.categoryColumn ? (row.concept_category as string | null) ?? null : undefined,
        subcategory: catalog.subcategoryColumn ? (row.concept_subcategory as string | null) ?? null : undefined,
        patientCount: Number(row.patient_count ?? 0),
        recordCount: Number(row.record_count ?? 0),
        visitCount: Number(row.visit_count ?? 0),
      })
    }
  }

  for (const row of await query(queries.globalQuery)) {
    const pCount = Number(row.patient_count ?? 0)
    const rCount = Number(row.record_count ?? 0)
    const vCount = Number(row.visit_count ?? 0)

    const activeDims: { dimIndex: number; value: string | number }[] = []
    for (let i = 0; i < enabledDims.length; i++) {
      if (row[dimKeys[i]] != null) {
        activeDims.push({ dimIndex: i, value: row[dimKeys[i]] as string | number })
      }
    }

    if (activeDims.length === 0) {
      grandTotal = { totalPatients: pCount, totalVisits: vCount, totalRecords: rCount }
    } else if (activeDims.length === 1) {
      const dim = enabledDims[activeDims[0].dimIndex]
      dimensions.push({
        dimensionId: dim.id,
        dimensionType: dim.type,
        value: activeDims[0].value,
        patientCount: pCount,
        recordCount: rCount,
        visitCount: vCount,
      })
    }
  }

  return {
    catalogId: catalog.id,
    computedAt: new Date().toISOString(),
    durationMs: 0,
    concepts,
    dimensions,
    grandTotal,
    totalConcepts: concepts.length,
    totalPatients: grandTotal.totalPatients,
    totalVisits: grandTotal.totalVisits,
  }
}

/** The period walk, as a plan + a pageable run + the summary it feeds. */
export const computePeriodBatch = {
  /**
   * Resolve everything the walk needs: the intervals, the labels each row is
   * widened by, and the masking threshold. One round of queries, before any row.
   */
  async plan(
    catalog: DataCatalog,
    mapping: SchemaMapping,
    query: CatalogQuery,
  ): Promise<PeriodPlan | null> {
    const periodConfig = catalog.periodConfig
    if (!periodConfig) return null

    const dateRangeQuery = buildDateRangeQuery(mapping)
    if (!dateRangeQuery) return null
    const dateRows = await query(dateRangeQuery)
    const minDate = dateRows[0]?.min_date as string | null
    const maxDate = dateRows[0]?.max_date as string | null
    if (!minDate || !maxDate) return null

    const svcQuery = buildServiceLabelsQuery(mapping, periodConfig.serviceLevel)
    let serviceLabels: string[] = []
    if (svcQuery) {
      serviceLabels = (await query(svcQuery)).map((r) => String(r.svc_label)).filter(Boolean)
      if (periodConfig.serviceLabels && periodConfig.serviceLabels.length > 0) {
        const allowed = new Set(periodConfig.serviceLabels)
        serviceLabels = serviceLabels.filter((l) => allowed.has(l))
      }
    }

    return {
      catalog,
      mapping,
      intervals: generatePeriodIntervals(minDate, maxDate, periodConfig.granularity),
      ageBrackets: getAgeBrackets(catalog),
      serviceLabels,
      conceptCategories: periodConfig.conceptCategories ?? [],
      threshold: catalog.anonymization.threshold,
    }
  },

  /** One page of period rows, starting at `offset`. */
  async run(
    plan: PeriodPlan,
    offset: number,
    count: number,
    query: CatalogQuery,
    signal?: AbortSignal,
    onProgress?: (done: number, label: string) => void,
  ): Promise<CatalogPeriodRow[]> {
    const rows: CatalogPeriodRow[] = []
    const end = Math.min(offset + count, plan.intervals.length)
    for (let i = offset; i < end; i++) {
      if (signal?.aborted) break
      const interval = plan.intervals[i]
      const sql = buildPeriodRowQuery(
        plan.mapping,
        interval,
        plan.catalog.periodConfig!,
        plan.ageBrackets,
        plan.serviceLabels,
        undefined,
        plan.catalog.categoryColumn,
        plan.conceptCategories,
      )
      // A period with no buildable query still occupies its slot: the offset is
      // an index into `intervals`, so skipping one without a row would shift
      // every later resume by one and silently drop a period.
      rows.push(
        sql
          ? parsePeriodRow(
              (await query(sql))[0] ?? {}, interval, plan.ageBrackets,
              plan.serviceLabels, plan.conceptCategories, plan.threshold,
            )
          : parsePeriodRow({}, interval, plan.ageBrackets, plan.serviceLabels, plan.conceptCategories, plan.threshold),
      )
      onProgress?.(rows.length, interval.label)
    }
    return rows
  },

  /** The reliability score the Data and Publish tabs read off the cache. */
  summarize(periods: CatalogPeriodRow[]): { periodReliabilityScore: number } {
    const dataRows = periods.filter((r) => r.period_granularity !== 'all')
    const masked = dataRows.filter((r) => r.n_patients === null).length
    return { periodReliabilityScore: dataRows.length > 0 ? masked / dataRows.length : 0 }
  },
}

/**
 * Build the age brackets from the catalog dimensions config.
 * Returns the brackets of the age_group dimension if enabled, else empty.
 */
export function getAgeBrackets(catalog: DataCatalog): number[] {
  const ageDim = catalog.dimensions.find((d) => d.type === 'age_group' && d.enabled)
  return ageDim?.ageGroup?.brackets ?? []
}

/**
 * Parse the raw SQL row returned by buildPeriodRowQuery into a CatalogPeriodRow.
 * Applies anonymization threshold: values below threshold → null.
 */
export function parsePeriodRow(
  raw: Record<string, unknown>,
  interval: PeriodInterval,
  ageBrackets: number[],
  serviceLabels: string[],
  conceptCategories: string[],
  threshold: number,
): CatalogPeriodRow {
  const mask = (v: unknown): number | null => {
    const n = v != null ? Number(v) : 0
    return n < threshold ? null : n
  }

  // Age bucket labels (must match the alias generation in buildPeriodRowQuery)
  const bucketLabels: string[] = []
  if (ageBrackets.length > 0) {
    const sorted = [...ageBrackets].sort((a, b) => a - b)
    if (sorted[0] > 0) bucketLabels.push(`[0;${sorted[0]}[`)
    for (let i = 0; i < sorted.length; i++) {
      const lo = sorted[i]
      const hi = i < sorted.length - 1 ? sorted[i + 1] : null
      bucketLabels.push(hi != null ? `[${lo};${hi}[` : `[${lo};+inf[`)
    }
  }

  const age_buckets: Record<string, number | null> = {}
  for (const label of bucketLabels) {
    const alias = `age_${label.replace(/[^a-zA-Z0-9]/g, '_')}`
    age_buckets[label] = mask(raw[alias])
  }

  const services: Record<string, { n_patients: number | null; n_sejours: number | null }> = {}
  for (const svcLabel of serviceLabels) {
    const aliasBase = svcLabel.replace(/[^a-zA-Z0-9]/g, '_')
    services[svcLabel] = {
      n_patients: mask(raw[`svc_${aliasBase}_pat`]),
      n_sejours: mask(raw[`svc_${aliasBase}_sej`]),
    }
  }

  const concept_categories: Record<string, { n_patients: number | null; n_rows: number | null }> = {}
  for (const cat of conceptCategories) {
    const aliasBase = cat.replace(/[^a-zA-Z0-9]/g, '_')
    concept_categories[cat] = {
      n_patients: mask(raw[`cat_${aliasBase}_pat`]),
      n_rows: mask(raw[`cat_${aliasBase}_rows`]),
    }
  }

  return {
    period_granularity: interval.granularity,
    period_start: interval.start,
    period_label: interval.label,
    n_patients: mask(raw.n_patients),
    n_sejours: mask(raw.n_sejours),
    sex_m: mask(raw.sex_m),
    sex_f: mask(raw.sex_f),
    sex_other: mask(raw.sex_other),
    age_buckets,
    services,
    concept_categories,
  }
}
