import { queryDataSource } from './engine'
import {
  buildBatchedCatalogQueries,
  buildDateRangeQuery,
  buildServiceLabelsQuery,
  buildPeriodRowQuery,
  generatePeriodIntervals,
  type PeriodInterval,
} from './catalog-queries'
import { getStorage } from '@/lib/storage'
import type { DataCatalog, CatalogResultCache, CatalogConceptRow, CatalogDimensionRow, CatalogGrandTotal, CatalogPeriodRow, ServiceMapping } from '@/types'
import type { SchemaMapping } from '@/types/schema-mapping'

export type ComputeStep = 'mounting' | 'building' | 'executing' | 'processing' | 'saving'

export interface ComputeProgress {
  step: ComputeStep
  /** 0–1 fraction within the current step (0 = just started, 1 = done). */
  fraction: number
  /** Human-readable label for the current sub-step. */
  detail?: string
}

/**
 * Compute a catalog using two-table architecture:
 * - Concept table: per-concept aggregates (simple GROUP BY, no dims) — one query per dictionary
 * - Dimension table: per-dimension-value aggregates + grand total (GROUPING SETS)
 */
export async function computeCatalog(
  catalog: DataCatalog,
  dataSourceId: string,
  mapping: SchemaMapping,
  serviceMappings: ServiceMapping[],
  onProgress?: (progress: ComputeProgress) => void,
): Promise<CatalogResultCache> {
  const startTime = performance.now()

  // Step 1: Building queries
  onProgress?.({ step: 'building', fraction: 0 })

  const careSiteDim = catalog.dimensions.find((d) => d.type === 'care_site' && d.enabled)
  const smId = careSiteDim?.careSite?.serviceMappingId
  const smRules = smId
    ? serviceMappings.find((m) => m.id === smId)?.rules
    : undefined

  const queries = buildBatchedCatalogQueries(
    mapping,
    catalog.dimensions,
    smRules,
    catalog.categoryColumn,
    catalog.subcategoryColumn,
  )
  if (!queries) {
    throw new Error('Cannot build catalog query: missing schema mapping (patient table, visit table, or concept dictionaries)')
  }

  onProgress?.({ step: 'building', fraction: 1 })

  // Step 2: Execute one query per dictionary (concept-level aggregates, no dims)
  onProgress?.({ step: 'executing', fraction: 0, detail: 'listing concepts' })

  const totalDicts = queries.conceptListQueries.length
  const totalSteps = totalDicts + 1 // dictionaries + 1 global query

  const enabledDims = catalog.dimensions.filter((d) => d.enabled)
  const dimKeys = enabledDims.map((d) => `dim_${d.type}`)

  const concepts: CatalogConceptRow[] = []
  const dimensions: CatalogDimensionRow[] = []
  let grandTotal: CatalogGrandTotal = { totalPatients: 0, totalVisits: 0, totalRecords: 0 }

  for (let dictIdx = 0; dictIdx < queries.conceptListQueries.length; dictIdx++) {
    const clq = queries.conceptListQueries[dictIdx]

    // Fetch all concept IDs for this dictionary
    const idRows = await queryDataSource(dataSourceId, clq.sql)
    const allIds = idRows.map((r) => r.cid as string | number)

    onProgress?.({
      step: 'executing',
      fraction: (dictIdx + 1) / totalSteps,
      detail: `dictionary ${dictIdx + 1}/${totalDicts}`,
    })

    if (allIds.length === 0) continue

    // Execute one query for all concepts in this dictionary
    const template = queries.batchTemplates.find((t) => t.dictKey === clq.dictKey)!
    const sql = template.buildSql(allIds)
    const rawRows = await queryDataSource(dataSourceId, sql)

    for (const row of rawRows) {
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

  // Execute global query (dim-only margins + grand total)
  onProgress?.({
    step: 'executing',
    fraction: totalDicts / totalSteps,
    detail: 'totals',
  })

  const globalRows = await queryDataSource(dataSourceId, queries.globalQuery)
  for (const row of globalRows) {
    const pCount = Number(row.patient_count ?? 0)
    const rCount = Number(row.record_count ?? 0)
    const vCount = Number(row.visit_count ?? 0)

    // Determine which dim columns are present (non-null)
    const activeDims: { dimIndex: number; value: string | number }[] = []
    for (let i = 0; i < enabledDims.length; i++) {
      if (row[dimKeys[i]] != null) {
        activeDims.push({ dimIndex: i, value: row[dimKeys[i]] as string | number })
      }
    }

    if (activeDims.length === 0) {
      // Grand total row (all dims rolled up)
      grandTotal = { totalPatients: pCount, totalVisits: vCount, totalRecords: rCount }
    } else if (activeDims.length === 1) {
      // Single-dimension margin row
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

  onProgress?.({ step: 'executing', fraction: 1 })

  // Step 3: Compute period table (if configured)
  onProgress?.({ step: 'processing', fraction: 0 })

  let periods: CatalogPeriodRow[] | undefined
  let periodReliabilityScore: number | undefined

  if (catalog.periodConfig) {
    const periodResult = await computePeriodTable(
      catalog,
      dataSourceId,
      mapping,
      serviceMappings,
      (frac) => onProgress?.({ step: 'processing', fraction: frac * 0.9 }),
    )
    periods = periodResult.rows
    periodReliabilityScore = periodResult.reliabilityScore
  }

  onProgress?.({ step: 'processing', fraction: 0.95 })

  const durationMs = Math.round(performance.now() - startTime)

  const cache: CatalogResultCache = {
    catalogId: catalog.id,
    computedAt: new Date().toISOString(),
    durationMs,
    concepts,
    dimensions,
    grandTotal,
    totalConcepts: concepts.length,
    totalPatients: grandTotal.totalPatients,
    totalVisits: grandTotal.totalVisits,
    periods,
    periodReliabilityScore,
  }

  onProgress?.({ step: 'processing', fraction: 1 })

  // Step 4: Saving to IDB
  onProgress?.({ step: 'saving', fraction: 0 })
  await getStorage().catalogResults.save(cache)
  onProgress?.({ step: 'saving', fraction: 1 })

  return cache
}

// ---------------------------------------------------------------------------
// Period table computation
// ---------------------------------------------------------------------------

/**
 * Build the age brackets from the catalog dimensions config.
 * Returns the brackets of the age_group dimension if enabled, else empty.
 */
function getAgeBrackets(catalog: DataCatalog): number[] {
  const ageDim = catalog.dimensions.find((d) => d.type === 'age_group' && d.enabled)
  return ageDim?.ageGroup?.brackets ?? []
}

/**
 * Parse the raw SQL row returned by buildPeriodRowQuery into a CatalogPeriodRow.
 * Applies anonymization threshold: values below threshold → null.
 */
function parsePeriodRow(
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

async function computePeriodTable(
  catalog: DataCatalog,
  dataSourceId: string,
  mapping: SchemaMapping,
  serviceMappings: ServiceMapping[],
  onProgress?: (fraction: number) => void,
): Promise<{ rows: CatalogPeriodRow[]; reliabilityScore: number }> {
  const periodConfig = catalog.periodConfig!
  const threshold = catalog.anonymization.threshold
  const ageBrackets = getAgeBrackets(catalog)

  // 1. Get service mapping rules
  const smId = periodConfig.serviceMappingId
  const smRules = smId ? serviceMappings.find((m) => m.id === smId)?.rules : undefined

  // 2. Get date range
  const dateRangeQuery = buildDateRangeQuery(mapping)
  if (!dateRangeQuery) return { rows: [], reliabilityScore: 0 }

  const dateRows = await queryDataSource(dataSourceId, dateRangeQuery)
  const minDate = dateRows[0]?.min_date as string | null
  const maxDate = dateRows[0]?.max_date as string | null
  if (!minDate || !maxDate) return { rows: [], reliabilityScore: 0 }

  // 3. Generate period intervals (ALL + granularity-based)
  const intervals = generatePeriodIntervals(minDate, maxDate, periodConfig.granularity)

  // 4. Get distinct service labels (filtered if serviceLabels is specified)
  const svcQuery = buildServiceLabelsQuery(mapping, periodConfig.serviceLevel, smRules)
  let serviceLabels: string[] = []
  if (svcQuery) {
    const svcRows = await queryDataSource(dataSourceId, svcQuery)
    serviceLabels = svcRows.map((r) => String(r.svc_label)).filter(Boolean)
    if (periodConfig.serviceLabels && periodConfig.serviceLabels.length > 0) {
      const allowed = new Set(periodConfig.serviceLabels)
      serviceLabels = serviceLabels.filter((l) => allowed.has(l))
    }
  }

  // 5. Resolve concept categories to use
  const conceptCategories = periodConfig.conceptCategories ?? []

  // 6. Execute one query per interval
  const rows: CatalogPeriodRow[] = []
  const total = intervals.length

  for (let i = 0; i < intervals.length; i++) {
    const interval = intervals[i]
    const sql = buildPeriodRowQuery(
      mapping,
      interval,
      periodConfig,
      ageBrackets,
      serviceLabels,
      smRules,
      catalog.categoryColumn,
      conceptCategories,
    )
    if (!sql) continue

    const rawRows = await queryDataSource(dataSourceId, sql)
    if (rawRows.length > 0) {
      rows.push(parsePeriodRow(rawRows[0], interval, ageBrackets, serviceLabels, conceptCategories, threshold))
    }

    onProgress?.(i / total)
  }

  // 7. Compute reliability score: fraction of n_patients values that are null (masked)
  // Exclude the ALL row from the score calculation
  const dataRows = rows.filter((r) => r.period_granularity !== 'all')
  const maskedCount = dataRows.filter((r) => r.n_patients === null).length
  const reliabilityScore = dataRows.length > 0 ? maskedCount / dataRows.length : 0

  onProgress?.(1)

  return { rows, reliabilityScore }
}
