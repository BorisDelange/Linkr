import { queryDataSource } from './engine'
import { buildBatchedCatalogQueries } from './catalog-queries'
import { getStorage } from '@/lib/storage'
import type { DataCatalog, CatalogResultCache, CatalogConceptRow, CatalogDimensionRow, CatalogGrandTotal, ServiceMapping } from '@/types'
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

  // Step 3: Build cache
  onProgress?.({ step: 'processing', fraction: 0 })

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
  }

  onProgress?.({ step: 'processing', fraction: 1 })

  // Step 4: Saving to IDB
  onProgress?.({ step: 'saving', fraction: 0 })
  await getStorage().catalogResults.save(cache)
  onProgress?.({ step: 'saving', fraction: 1 })

  return cache
}
